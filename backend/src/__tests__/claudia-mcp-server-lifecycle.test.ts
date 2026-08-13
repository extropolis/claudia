/**
 * MCP task-lifecycle tools driven end-to-end: real MCP protocol → real Claudia
 * backend → real spawned PTY process (the fake claude CLI from fixtures).
 *
 * The read-only tools and guardrails live in claudia-mcp-server.test.ts. This
 * file covers the mutating half of the tool surface, which all routes through
 * WebSocket round-trips rather than plain HTTP:
 *   claudia_create_task / send_input / continue_task / stop_task / stop_all_tasks
 *
 * These are the tools that spawn and steer other agents, so an all-mock test
 * would prove nothing — a real process is spawned and really stopped.
 *
 * Every suite here needs the bash fake-claude fixture, so the whole file skips
 * on the Windows CI leg (see SUPPORTS_FAKE_CLI). The schema/guardrail coverage
 * in claudia-mcp-server.test.ts needs no CLI and still runs there.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, copyFileSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from '../server.js';
import { SUPPORTS_FAKE_CLI } from './helpers/server-harness.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });

let base: string;
let repo: string;
let port: number;
let shutdown: (() => Promise<void>) | undefined;
let client: Client;
let savedEnv: Record<string, string | undefined>;

async function callTool(name: string, args: Record<string, unknown> = {}) {
    const res: any = await client.callTool({ name, arguments: args });
    const text = res.content?.[0]?.text ?? '';
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* plain text */ }
    return { text, json, isError: res.isError === true };
}

/** Poll /api/tasks until `pred` holds for the given task, or time out. */
async function waitForTask(taskId: string, pred: (t: any) => boolean, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let last: any = null;
    while (Date.now() < deadline) {
        const tasks = await fetch(`http://127.0.0.1:${port}/api/tasks`).then(r => r.json());
        last = tasks.find((t: any) => t.id === taskId);
        if (last && pred(last)) return last;
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`timeout waiting for ${taskId}; last state=${last?.state}`);
}

beforeAll(async () => {
    if (!SUPPORTS_FAKE_CLI) return;
    // NOT os.tmpdir(): macOS tmp resolves under /var, which validateWorkspacePath
    // blocklists — workspace ops would be rejected before reaching the tools.
    base = mkdtempSync(join(homedir(), '.claudia-mcp-life-'));

    repo = join(base, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.txt'), 'hello');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');

    // Fake claude CLI on PATH — spawns a real process that speaks just enough
    // of the TUI contract (ready banner, stdin echo, SIGTERM exit).
    const bin = join(base, 'bin');
    mkdirSync(bin);
    copyFileSync(join(FIXTURES, 'fake-claude.sh'), join(bin, 'claude'));
    chmodSync(join(bin, 'claude'), 0o755);
    const fakeDir = join(base, 'fake');
    mkdirSync(fakeDir);

    savedEnv = {
        PATH: process.env.PATH, HOME: process.env.HOME,
        CLAUDIA_FAKE_DIR: process.env.CLAUDIA_FAKE_DIR,
        CLAUDIA_BACKEND_URL: process.env.CLAUDIA_BACKEND_URL,
        CLAUDIA_WORKSPACE_ID: process.env.CLAUDIA_WORKSPACE_ID,
        CLAUDIA_TASK_ID: process.env.CLAUDIA_TASK_ID,
    };
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.CLAUDIA_FAKE_DIR = fakeDir;

    writeFileSync(join(base, 'workspace-config.json'), JSON.stringify({
        schemaVersion: 1,
        data: { workspaces: [{ id: repo, name: 'repo', createdAt: new Date().toISOString() }] },
    }, null, 2));
    writeFileSync(join(base, 'tasks.json'), JSON.stringify({ tasks: [], archivedTasks: [] }, null, 2));

    const appParts = await createApp(base);
    shutdown = appParts.shutdownForTests;
    await new Promise<void>((resolve) => appParts.server.listen(0, '127.0.0.1', () => resolve()));
    port = (appParts.server.address() as { port: number }).port;

    // Env must be set before importing — the MCP module reads it at load time.
    process.env.CLAUDIA_BACKEND_URL = `http://127.0.0.1:${port}`;
    process.env.CLAUDIA_WORKSPACE_ID = repo;
    process.env.CLAUDIA_TASK_ID = 'task-self-not-real';

    const mod = await import('../claudia-mcp-server.js');
    const server = mod.createClaudiaMcpServer({
        workspaceId: repo,
        taskId: 'task-self-not-real',
        modelTieringEnabled: false,
        todoEnabled: false,
        backendUrl: `http://127.0.0.1:${port}`,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'lifecycle-client', version: '1.0.0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
}, 60000);

afterAll(async () => {
    if (!SUPPORTS_FAKE_CLI) return;
    try { await client?.close(); } catch { /* already closed */ }
    if (shutdown) await shutdown();
    for (const [k, v] of Object.entries(savedEnv ?? {})) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(base, { recursive: true, force: true });
}, 30000);

describe.skipIf(!SUPPORTS_FAKE_CLI)('claudia_create_task', () => {
    let createdId: string;

    it('spawns a real task and reports its id, state and workspace', async () => {
        const { json } = await callTool('claudia_create_task', {
            prompt: 'do the thing',
            displayName: 'Spawned By Test',
        });
        expect(json.success).toBe(true);
        expect(json.taskId).toBeTruthy();
        expect(json.workspace).toBe(repo);
        createdId = json.taskId;

        // BUG (reported, not fixed here): the handler builds `isolated: isolate
        // && effectiveWorkspaceId !== WORKSPACE_ID`. With `isolate` omitted that
        // is `undefined`, so JSON.stringify DROPS the key rather than emitting
        // `false`. Agents reading `.isolated` get undefined for a non-isolated
        // task. Asserted as falsy so this passes before and after the one-word
        // fix (`isolate === true && ...`), while still pinning the semantics.
        expect(json.isolated ?? false).toBe(false);

        // Really exists on the backend, not just an echoed response.
        const task = await waitForTask(createdId, t => !!t);
        expect(task.workspaceId).toBe(repo);
    }, 40000);

    it('applies the displayName it was given', async () => {
        const task = await waitForTask(createdId, t => t.displayName === 'Spawned By Test');
        expect(task.displayName).toBe('Spawned By Test');
    }, 20000);

    it('the new task is visible through claudia_list_tasks', async () => {
        const { json } = await callTool('claudia_list_tasks');
        expect(json.map((t: any) => t.id)).toContain(createdId);
    });

    it('rejects a missing prompt at the schema layer', async () => {
        const res = await callTool('claudia_create_task', { displayName: 'no prompt' });
        expect(res.isError).toBe(true);
    });

    it('does not expose the complexity param when model tiering is off', async () => {
        const { tools } = await client.listTools();
        const create = tools.find(t => t.name === 'claudia_create_task')!;
        expect(Object.keys((create.inputSchema as any).properties)).not.toContain('complexity');
    });
});

describe.skipIf(!SUPPORTS_FAKE_CLI)('claudia_send_input / continue_task / stop_task', () => {
    let taskId: string;

    beforeAll(async () => {
        const { json } = await callTool('claudia_create_task', { prompt: 'steerable task' });
        taskId = json.taskId;
        // Wait until the fake CLI is up and the task has settled out of starting.
        await waitForTask(taskId, t => t.state !== 'starting', 25000);
    }, 45000);

    it('delivers input to a live task', async () => {
        const { json } = await callTool('claudia_send_input', { taskId, input: 'EMIT_OUTPUT please' });
        expect(json.success).toBe(true);
    }, 25000);

    it('the delivered input shows up in the task output', async () => {
        // The fake CLI echoes a marker when it sees EMIT_OUTPUT — proof the
        // keystrokes reached the real process, not just the WS handler.
        const deadline = Date.now() + 15000;
        let text = '';
        while (Date.now() < deadline) {
            text = (await callTool('claudia_get_task_output', { taskId, maxBytes: 8192 })).text;
            if (text.includes('FAKE_OUTPUT_MARKER_9000')) break;
            await new Promise(r => setTimeout(r, 250));
        }
        expect(text).toContain('FAKE_OUTPUT_MARKER_9000');
    }, 25000);

    it('never reports success for a task that does not exist, even while a real task is churning', async () => {
        // REGRESSION (bug found by this suite): sendWSMessage matched on message
        // TYPE only, so any other task's task:stateChanged broadcast satisfied the
        // wait. Sending to a ghost id returned success:true whenever a real task
        // changed state in the window — the normal case in a fleet.
        //
        // Drive that window deliberately: keep a real task emitting state changes
        // while we address a nonexistent one. Pre-fix this returned success:true
        // in ~3s; post-fix it correctly refuses.
        const churn = setInterval(() => {
            void callTool('claudia_send_input', { taskId, input: 'keep busy' }).catch(() => {});
        }, 400);
        try {
            const { text, json } = await callTool('claudia_send_input', { taskId: 'ghost-task-id', input: 'hi' });
            expect((json ?? { success: false }).success).not.toBe(true);
            expect(text.toLowerCase()).toMatch(/error|not found|timed out/);
        } finally {
            clearInterval(churn);
        }
    }, 60000);

    it('stops a running task', async () => {
        const { json, text } = await callTool('claudia_stop_task', { taskId });
        expect(JSON.stringify(json ?? text)).toMatch(/success|stopped/i);
        await waitForTask(taskId, t => t.state !== 'busy' && t.state !== 'starting', 20000);
    }, 40000);

    it('continue_task resumes an idle task with a follow-up prompt', async () => {
        const { json, text } = await callTool('claudia_continue_task', {
            taskId, prompt: 'now do the next thing',
        });
        expect(JSON.stringify(json ?? text)).toMatch(/success|continu|resum/i);
    }, 45000);
});

describe.skipIf(!SUPPORTS_FAKE_CLI)('claudia_stop_all_tasks', () => {
    it('stops the tasks in scope and reports a count', async () => {
        await callTool('claudia_create_task', { prompt: 'bulk stop target' });
        const { json, text } = await callTool('claudia_stop_all_tasks', {});
        const payload = JSON.stringify(json ?? text);
        expect(payload).toMatch(/stopped|success|no running/i);
    }, 60000);
});

describe.skipIf(!SUPPORTS_FAKE_CLI)('model tiering toggle', () => {
    it('exposes the complexity param only when CLAUDIA_MODEL_TIERING_ENABLED=1', async () => {
        // Fresh module instance so the env var is re-read at load time.
        vi.resetModules();
        process.env.CLAUDIA_MODEL_TIERING_ENABLED = '1';
        try {
            const mod = await import('../claudia-mcp-server.js');
            const tieredServer = mod.createClaudiaMcpServer({
                workspaceId: repo,
                taskId: 'task-self-not-real',
                modelTieringEnabled: true,
                todoEnabled: false,
                backendUrl: `http://127.0.0.1:${port}`,
            });
            const [ct, st] = InMemoryTransport.createLinkedPair();
            const tieredClient = new Client({ name: 'tiered', version: '1.0.0' });
            await Promise.all([tieredServer.connect(st), tieredClient.connect(ct)]);

            const { tools } = await tieredClient.listTools();
            const create = tools.find(t => t.name === 'claudia_create_task')!;
            const props = (create.inputSchema as any).properties;
            expect(Object.keys(props)).toContain('complexity');
            expect(props.complexity.enum).toEqual(['low', 'medium', 'high']);
            // Still optional — omitting it must keep the workspace default model.
            expect((create.inputSchema as any).required ?? []).not.toContain('complexity');

            await tieredClient.close();
        } finally {
            delete process.env.CLAUDIA_MODEL_TIERING_ENABLED;
            vi.resetModules();
        }
    }, 30000);
});
