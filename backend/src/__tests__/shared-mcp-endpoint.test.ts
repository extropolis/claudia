/**
 * Shared Claudia MCP endpoint integration suite.
 *
 * Every Claude Code session used to spawn its OWN claudia MCP server child
 * process. Because the config launched it through the tsx CLI, tsx forked and
 * each session actually cost TWO processes (~26MB + ~30MB). Measured on a real
 * working set: 31 sessions -> 62 processes -> 1.68GB, every one of them doing
 * nothing but relaying HTTP calls to the backend that was already running.
 *
 * The tools are stateless proxies over the backend's own REST API, so they are
 * now served in-process from a single shared endpoint, with per-session scope
 * arriving in request headers instead of per-process env vars.
 *
 * Regression targets:
 *  - the endpoint speaks MCP (initialize + tools/list) over streamable HTTP
 *  - per-session scope comes from headers, so two sessions hitting ONE process
 *    still get their own workspace/task identity (the whole risk of sharing)
 *  - the endpoint is localhost-only — it can spawn and stop tasks
 *  - generated task configs point at the shared URL, never at a spawned child
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createApp } from '../server.js';
import { getSharedMcpToken } from '../mcp-auth.js';

let base: string;
let workspace: string;
let port: number;
let shutdown: (() => Promise<void>) | undefined;

const MCP_ACCEPT = 'application/json, text/event-stream';

/** Post a single JSON-RPC message to the shared endpoint. */
async function mcpPost(body: unknown, headers: Record<string, string> = {}) {
    return fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: MCP_ACCEPT,
            Authorization: `Bearer ${getSharedMcpToken()}`,
            ...headers,
        },
        body: JSON.stringify(body),
    });
}

/** Streamable HTTP replies may be SSE-framed; pull the JSON payload out. */
async function readRpc(res: Response): Promise<any> {
    const text = await res.text();
    if (text.startsWith('event:') || text.includes('\ndata: ')) {
        const line = text.split('\n').find(l => l.startsWith('data: '));
        return line ? JSON.parse(line.slice(6)) : null;
    }
    return JSON.parse(text);
}

const INITIALIZE = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
    },
};

beforeAll(async () => {
    // NOT os.tmpdir(): macOS tmp lives under /var, which validateWorkspacePath
    // blocklists as a system path.
    base = mkdtempSync(join(homedir(), '.claudia-mcp-shared-'));
    workspace = join(base, 'ws');
    mkdirSync(workspace, { recursive: true });

    writeFileSync(join(base, 'workspace-config.json'), JSON.stringify({
        schemaVersion: 1,
        data: { workspaces: [{ id: workspace, name: 'ws', createdAt: new Date().toISOString() }] },
    }, null, 2));
    // Seed a task so a real tools/call has something distinctive to return.
    // Disconnected + not interrupted → loaded lazily, never respawned.
    writeFileSync(join(base, 'tasks.json'), JSON.stringify({
        tasks: [{
            id: 'task-scoped-9001',
            prompt: 'UNIQUE-MARKER-only-on-the-test-server',
            workspaceId: workspace,
            createdAt: new Date().toISOString(),
            lastActivity: new Date().toISOString(),
            lastState: 'idle',
            wasInterrupted: false,
            shouldContinue: false,
            backendType: 'claude-code',
        }],
        archivedTasks: [],
    }, null, 2));

    const appParts = await createApp(base);
    shutdown = appParts.shutdownForTests;
    await new Promise<void>((resolve) => {
        appParts.server.listen(0, '127.0.0.1', () => resolve());
    });
    port = (appParts.server.address() as { port: number }).port;
}, 30000);

afterAll(async () => {
    if (shutdown) await shutdown();
    rmSync(base, { recursive: true, force: true });
}, 20000);

describe('shared MCP endpoint', () => {
    it('completes an MCP initialize handshake over HTTP', async () => {
        const res = await mcpPost(INITIALIZE, { 'X-Claudia-Workspace-Id': workspace });
        expect(res.status).toBe(200);
        const rpc = await readRpc(res);
        expect(rpc.result.serverInfo.name).toBe('claudia');
        expect(rpc.result.capabilities.tools).toBeDefined();
    });

    it('serves the claudia tool set without spawning a child process', async () => {
        const res = await mcpPost(
            { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
            { 'X-Claudia-Workspace-Id': workspace },
        );
        expect(res.status).toBe(200);
        const rpc = await readRpc(res);
        const names: string[] = (rpc.result?.tools || []).map((t: any) => t.name);
        // Core task-orchestration surface must survive the stdio -> HTTP move.
        expect(names).toContain('claudia_list_tasks');
        expect(names).toContain('claudia_create_task');
        expect(names).toContain('claudia_rename_task');
    });

    it('scopes each session from its own headers, not shared process state', async () => {
        // The core risk of sharing one process: session A seeing session B's
        // identity. Scope is baked into tool descriptions, so it is observable.
        const describeFor = async (taskId: string) => {
            const res = await mcpPost(
                { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
                { 'X-Claudia-Workspace-Id': workspace, 'X-Claudia-Task-Id': taskId },
            );
            const rpc = await readRpc(res);
            const rename = (rpc.result?.tools || []).find((t: any) => t.name === 'claudia_rename_task');
            return rename?.description || '';
        };

        const [a, b] = await Promise.all([describeFor('task-aaa-1'), describeFor('task-bbb-2')]);

        expect(a).toContain('task-aaa-1');
        expect(a).not.toContain('task-bbb-2');
        expect(b).toContain('task-bbb-2');
        expect(b).not.toContain('task-aaa-1');
    });

    it('generates task configs that point at the shared endpoint, not a child process', async () => {
        // .mcp.json is synced to every workspace root on startup; it is the
        // exact shape handed to Claude Code sessions.
        const generated = JSON.parse(readFileSync(join(workspace, '.mcp.json'), 'utf-8'));
        const claudia = (generated.mcpServers || generated).claudia;

        expect(claudia.type).toBe('http');
        expect(claudia.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
        // No spawned child: no command, no args, no tsx launcher.
        expect(claudia.command).toBeUndefined();
        expect(claudia.args).toBeUndefined();
        expect(JSON.stringify(claudia)).not.toContain('tsx');
        // And it carries the bearer token the endpoint requires.
        expect(claudia.headers.Authorization).toMatch(/^Bearer [0-9a-f]{64}$/);
    });

    it('addresses ITS OWN backend, not the default port', async () => {
        // The tools reach the backend over HTTP. Mounted in-process, that means
        // this server — which is on an ephemeral port here. If the base URL fell
        // back to a hardcoded :4001, this call would silently read a DIFFERENT
        // server's task list (in dev, the developer's real running instance).
        const res = await mcpPost(
            {
                jsonrpc: '2.0',
                id: 4,
                method: 'tools/call',
                params: { name: 'claudia_list_tasks', arguments: {} },
            },
            { 'X-Claudia-Workspace-Id': workspace },
        );
        expect(res.status).toBe(200);
        const rpc = await readRpc(res);
        const text = (rpc.result?.content || []).map((c: any) => c.text).join('\n');
        expect(text).toContain('UNIQUE-MARKER-only-on-the-test-server');
    });

    it('rejects requests without a valid bearer token', async () => {
        // The endpoint can create, stop and delete tasks, and loopback is shared
        // by every process on the machine — an unauthenticated /mcp would be a
        // local privilege-escalation surface.
        const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: MCP_ACCEPT },
            body: JSON.stringify(INITIALIZE),
        });
        expect(res.status).toBe(401);

        const wrong = await fetch(`http://127.0.0.1:${port}/mcp`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: MCP_ACCEPT,
                Authorization: 'Bearer ' + 'a'.repeat(64),
            },
            body: JSON.stringify(INITIALIZE),
        });
        expect(wrong.status).toBe(401);
    });

    it('rejects GET/DELETE (stateless transport has no session to resume)', async () => {
        const get = await fetch(`http://127.0.0.1:${port}/mcp`, { headers: { Accept: MCP_ACCEPT } });
        expect(get.status).toBe(405);
        const del = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'DELETE' });
        expect(del.status).toBe(405);
    });
});
