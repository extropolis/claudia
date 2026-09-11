/**
 * HTTP surface for import + handoff (P0 task 11, spec §11.2/§11.3), and the
 * single-writer guard, exercised through a real server.
 *
 * NOTE ON TEMP DIRECTORIES: fixtures live under `os.homedir()`, never
 * `os.tmpdir()` — on macOS `/tmp` resolves under `/var`, which
 * `validateWorkspacePath` blocklists as a system path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import { startHarness, type Harness } from './helpers/server-harness.js';
import { writeHandoffMark, readHandoffMark } from '../export-import/handoff.js';

describe('import + handoff HTTP routes', () => {
    let harness: Harness;
    let sandbox: string;
    let exportDir: string;
    let target: string;

    /** A minimal valid export tree pointing at one workspace. */
    function seedExport(workspaceId: string): void {
        mkdirSync(join(exportDir, 'state'), { recursive: true });
        writeFileSync(
            join(exportDir, 'state', 'workspace-config.json'),
            JSON.stringify({ schemaVersion: 1, data: { workspaces: [{ id: workspaceId, name: 'ws' }], activeWorkspaceId: workspaceId, recentWorkspaces: [] } }),
            'utf-8'
        );
        writeFileSync(
            join(exportDir, 'state', 'tasks.json'),
            JSON.stringify({ tasks: [{ id: 't1', prompt: 'p', workspaceId, lastState: 'idle' }] }),
            'utf-8'
        );
        writeFileSync(
            join(exportDir, 'manifest.json'),
            JSON.stringify({
                formatVersion: 1,
                exportId: 'e1',
                exportedAt: '2026-01-01T00:00:00.000Z',
                claudiaVersion: '0.4.0',
                source: { platform: 'linux', hostname: 'src', instanceId: null, dataDir: '/srv/d', homeDir: '/home/src' },
                tiers: { secrets: false, histories: false, agentSessions: false },
                schemaVersions: { 'workspace-config.json': 1, 'tasks.json': null },
                workspaces: [{ id: workspaceId, name: 'ws' }],
            }),
            'utf-8'
        );
    }

    beforeEach(async () => {
        sandbox = mkdtempSync(join(homedir(), '.claudia-handoff-routes-'));
        exportDir = join(sandbox, 'export');
        target = join(sandbox, 'target-data');
        mkdirSync(exportDir, { recursive: true });
        mkdirSync(target, { recursive: true });
        harness = await startHarness({ prefix: '.claudia-handoff-http-' });
    });

    afterEach(async () => {
        await harness.stop();
        // Retries: on Windows a just-killed PTY can hold its cwd briefly.
        rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });

    // -----------------------------------------------------------------------
    // POST /api/import
    // -----------------------------------------------------------------------
    it('rejects a request with no exportDir', async () => {
        const { status, body } = await harness.send('POST', '/api/import', {});
        expect(status).toBe(400);
        expect(body.error).toMatch(/exportDir is required/);
    });

    it('rejects a malformed mapping rather than silently ignoring it', async () => {
        seedExport(sandbox);
        const { status, body } = await harness.send('POST', '/api/import', {
            exportDir,
            map: [['only-one-side']],
        });
        expect(status).toBe(400);
        expect(body.error).toMatch(/expected \[from, to\] strings/);
    });

    it('rejects a map that is not an array', async () => {
        seedExport(sandbox);
        const { status, body } = await harness.send('POST', '/api/import', { exportDir, map: 'a=b' });
        expect(status).toBe(400);
        expect(body.error).toMatch(/map must be an array/);
    });

    it('refuses to import into the data directory the running server holds', async () => {
        // The harness server is live and its lock names its own pid, which is
        // exactly the situation importState must refuse.
        seedExport(sandbox);
        writeFileSync(join(harness.base, 'instance.json'), JSON.stringify({ pid: process.pid }), 'utf-8');

        const { status, body } = await harness.send('POST', '/api/import', { exportDir });
        expect(status).toBe(500);
        expect(body.error).toMatch(/live Claudia backend/);
    });

    it('surfaces an unknown formatVersion as an error, not a partial import', async () => {
        seedExport(sandbox);
        const manifestPath = join(exportDir, 'manifest.json');
        const m = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        writeFileSync(manifestPath, JSON.stringify({ ...m, formatVersion: 42 }), 'utf-8');

        // `force` so the request gets past the "target already has tasks.json"
        // refusal — §11.2 orders the destination checks BEFORE the manifest
        // check, and the harness's data dir is a populated install.
        const { status, body } = await harness.send('POST', '/api/import', { exportDir, force: true });
        expect(status).toBe(500);
        expect(body.error).toMatch(/unsupported formatVersion 42/);
    });

    it('runs a dry run through HTTP and reports the remap table', async () => {
        const oldWs = '/machine-a/projects/ws';
        seedExport(oldWs);

        const { status, body } = await harness.send('POST', '/api/import', {
            exportDir,
            map: [[oldWs, sandbox]],
            dryRun: true,
        });

        expect(status).toBe(200);
        expect(body.report.dryRun).toBe(true);
        expect(body.report.filesWritten).toEqual([]);
        expect(body.report.remapTable).toContainEqual([oldWs, sandbox]);
        expect(body.report.workspaces[0].newId).toBe(sandbox);
        expect(body.report.workspaces[0].exists).toBe(true);
    });

    // -----------------------------------------------------------------------
    // GET /api/handoff, POST /api/handoff/reclaim
    // -----------------------------------------------------------------------
    it('reports a free instance as not handed off', async () => {
        const { status, body } = await harness.req('/api/handoff');
        expect(status).toBe(200);
        expect(body.handedOff).toBe(false);
        expect(body.mark).toBeNull();
    });

    it('reports, then clears, a handoff mark', async () => {
        writeHandoffMark(harness.base, { handedOffAt: '2026-01-01T00:00:00.000Z', exportId: 'e-9', exportDir: '/tmp/x' });

        const before = await harness.req('/api/handoff');
        expect(before.body.handedOff).toBe(true);
        expect(before.body.mark.exportId).toBe('e-9');

        const reclaim = await harness.send('POST', '/api/handoff/reclaim');
        expect(reclaim.status).toBe(200);
        expect(reclaim.body.reclaimed).toBe(true);

        const after = await harness.req('/api/handoff');
        expect(after.body.handedOff).toBe(false);
        expect(readHandoffMark(harness.base)).toBeNull();
    });

    it('reclaiming a free instance succeeds and says so, rather than erroring', async () => {
        const { status, body } = await harness.send('POST', '/api/handoff/reclaim');
        expect(status).toBe(200);
        expect(body.reclaimed).toBe(false);
        expect(body.message).toMatch(/already free/);
    });

    it('preserves unrelated instance.json keys when marking and reclaiming', async () => {
        writeFileSync(join(harness.base, 'instance.json'), JSON.stringify({ instanceId: 'keep-me', pid: 1 }), 'utf-8');
        writeHandoffMark(harness.base, { handedOffAt: '2026-01-01T00:00:00.000Z', exportId: 'e-1' });

        let lock = JSON.parse(readFileSync(join(harness.base, 'instance.json'), 'utf-8'));
        expect(lock.instanceId).toBe('keep-me');
        expect(lock.pid).toBe(1);
        expect(lock.handedOffAt).toBe('2026-01-01T00:00:00.000Z');

        await harness.send('POST', '/api/handoff/reclaim');
        lock = JSON.parse(readFileSync(join(harness.base, 'instance.json'), 'utf-8'));
        expect(lock.instanceId).toBe('keep-me');
        expect(lock.handedOffAt).toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // The single-writer guard
    // -----------------------------------------------------------------------
    it('refuses to create a task while the instance is handed off, and allows it after reclaim', async () => {
        const workspace = join(sandbox, 'ws');
        mkdirSync(workspace, { recursive: true });
        writeHandoffMark(harness.base, { handedOffAt: '2026-01-01T00:00:00.000Z', exportId: 'e-2' });

        // Driven through the spawner rather than a route: the guard's whole
        // point is that it sits at the spawn door, so no single route has to
        // remember to check. createApp returns the spawner, so this is the real
        // object the WebSocket, MCP and cron paths all share.
        const spawner = (harness.server as any).taskSpawner;
        expect(spawner, 'harness must expose the real TaskSpawner').toBeTruthy();

        await expect(spawner.createTask('hello', workspace)).rejects.toThrow(/handed off/);
        await expect(spawner.createTask('hello', workspace)).rejects.toThrow(/reclaim/);

        // Reconnect is guarded too — it is the more dangerous door, because it
        // reattaches to an EXISTING agent session.
        expect(() => spawner.reconnectTask('t-nonexistent')).toThrow(/handed off/);

        // After a reclaim the guard is gone. The spawn may still fail for
        // unrelated reasons in a sandbox with no real `claude` binary, so the
        // assertion is specifically that the handoff is no longer the reason.
        await harness.send('POST', '/api/handoff/reclaim');
        let reclaimedError: unknown = null;
        try {
            const created = await spawner.createTask('hello', workspace);
            // If a process did spawn, kill it now: on Windows a live PTY whose
            // cwd is `workspace` holds the directory open, and the afterEach
            // cleanup of the sandbox fails with EBUSY.
            if (created?.id) spawner.destroyTask(created.id);
        } catch (error) {
            reclaimedError = error;
        }
        if (reclaimedError) {
            expect(String((reclaimedError as Error).message)).not.toMatch(/handed off/);
        }
        // Reconnect no longer hits the guard either: an unknown task id is a
        // null return, not an exception.
        expect(() => spawner.reconnectTask('t-nonexistent')).not.toThrow();
    });
});
