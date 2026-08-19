/**
 * Workspace .mcp.json sync.
 *
 * Two regressions live here.
 *
 * 1. Claudia's own project root was EXCLUDED from the sync, on the theory that
 *    writing .mcp.json there would trigger a tsx watch restart loop. The dev
 *    script watches `--watch-path=src`, so a file at the repo root was never in
 *    the watch set to begin with — and the exclusion left Claudia's own
 *    workspace pinned to whatever stale .mcp.json was on disk. In practice that
 *    was the old stdio form, which starts the MCP server unscoped
 *    ("Workspace: (not scoped)"), so sessions in the Claudia repo silently got
 *    a different, worse config than every other workspace. No workspace is
 *    exempt now, and a stale stdio entry must be replaced by the HTTP one.
 *
 * 2. The sync rewrote every workspace config unconditionally, touching mtime on
 *    each boot. That churn is what made writing into a watched tree look
 *    dangerous. Now that the bearer token survives restarts, identical content
 *    must not be rewritten.
 *
 * Temp dirs live under homedir(), not os.tmpdir() — macOS /var is blocklisted
 * by validateWorkspacePath.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, utimesSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

vi.mock('node-pty', () => ({
    spawn: () => ({
        pid: 4242,
        cols: 120,
        rows: 40,
        onData: () => ({ dispose: () => { } }),
        onExit: () => ({ dispose: () => { } }),
        write: () => { },
        resize: () => { },
        kill: () => { },
    }),
}));

import { TaskSpawner } from '../task-spawner.js';
import { ConfigStore } from '../config-store.js';

let base: string;
let workspace: string;
let dataDir: string;
let spawner: TaskSpawner;

const mcpFile = () => join(workspace, '.mcp.json');
const readMcp = () => JSON.parse(readFileSync(mcpFile(), 'utf-8'));

beforeEach(() => {
    base = mkdtempSync(join(homedir(), '.claudia-mcpsync-'));
    workspace = join(base, 'ws');
    dataDir = join(base, 'data');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    // Keep the persisted MCP token out of the real backend/ directory.
    vi.stubEnv('CLAUDIA_DATA_DIR', dataDir);

    const configStore = new ConfigStore(dataDir);
    configStore.updateConfig({ claudiaMcpServerEnabled: true, mcpServers: [] });
    spawner = new TaskSpawner(join(base, 'tasks.json'), false, configStore);
});

afterEach(() => {
    spawner?.destroy();
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
});

describe('workspace .mcp.json sync', () => {
    it('writes the claudia entry as a scoped HTTP endpoint', () => {
        spawner.syncWorkspaceMcpConfigs([workspace]);

        const claudia = readMcp().mcpServers.claudia;
        expect(claudia.type).toBe('http');
        expect(claudia.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
        expect(claudia.headers.Authorization).toMatch(/^Bearer [0-9a-f]{64}$/);
        // The scope header is the whole reason the stdio form was wrong.
        expect(claudia.headers['X-Claudia-Workspace-Id']).toBe(workspace);
    });

    it('replaces a stale stdio claudia entry with the HTTP form', () => {
        // Exactly what sat in Claudia's own repo while it was exempt from sync.
        writeFileSync(mcpFile(), JSON.stringify({
            mcpServers: {
                claudia: {
                    command: 'npx',
                    args: ['tsx', 'backend/src/claudia-mcp-server.ts'],
                },
            },
        }, null, 2));

        spawner.syncWorkspaceMcpConfigs([workspace]);

        const claudia = readMcp().mcpServers.claudia;
        expect(claudia.command).toBeUndefined();
        expect(claudia.type).toBe('http');
        expect(claudia.headers['X-Claudia-Workspace-Id']).toBe(workspace);
    });

    it('does not rewrite the file when the content is unchanged', () => {
        spawner.syncWorkspaceMcpConfigs([workspace]);

        // Backdate so any rewrite is unambiguous even at coarse mtime resolution.
        const past = new Date(Date.now() - 60_000);
        utimesSync(mcpFile(), past, past);
        const before = statSync(mcpFile()).mtimeMs;

        spawner.syncWorkspaceMcpConfigs([workspace]);

        expect(statSync(mcpFile()).mtimeMs).toBe(before);
    });

    it('rewrites when the content actually changed', () => {
        spawner.syncWorkspaceMcpConfigs([workspace]);
        writeFileSync(mcpFile(), JSON.stringify({ mcpServers: {} }, null, 2));

        spawner.syncWorkspaceMcpConfigs([workspace]);

        expect(readMcp().mcpServers.claudia).toBeDefined();
    });

    it('skips workspaces that no longer exist without throwing', () => {
        const gone = join(base, 'deleted-workspace');

        expect(() => spawner.syncWorkspaceMcpConfigs([gone, workspace])).not.toThrow();
        expect(readMcp().mcpServers.claudia).toBeDefined();
    });
});
