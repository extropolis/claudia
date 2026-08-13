/**
 * Integration harness for the Claudia MCP server — the stdio MCP server injected
 * into every Claude Code session. It was at 0% coverage despite every agent in
 * the product depending on it.
 *
 * This does NOT mock the MCP layer. It connects a real MCP `Client` to the real
 * `server` over an in-memory transport, so tool listing and tool dispatch go
 * through the genuine protocol (schema serialization included). The backend the
 * tools talk to is also real: `createApp(tmpDir)` on an ephemeral port, seeded
 * with a real git repo + worktree and real task/workspace records.
 *
 * Coverage targets:
 *  - tool schema integrity (a malformed inputSchema silently breaks tool calling
 *    for every agent, and nothing else in the suite would catch it)
 *  - tool dispatch: happy path shapes + clean errors on bad/missing args
 *  - the cross-worktree listing contract (commit 3037416): a session running
 *    INSIDE a worktree must see its siblings and its parent, not just itself
 *  - guardrails: delete requires user approval; rename is refused once the user
 *    has hand-edited the title; a session cannot delete itself
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from '../server.js';

const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });

let base: string;
let repo: string;
let worktree: string;
let port: number;
let shutdown: (() => Promise<void>) | undefined;
let client: Client;

/** The task id the MCP server believes is "itself" (CLAUDIA_TASK_ID). */
const SELF_TASK = 'task-wt-self';

/** Call a tool and return its single text content block, parsed if it is JSON. */
async function callTool(name: string, args: Record<string, unknown> = {}) {
    const res: any = await client.callTool({ name, arguments: args });
    const text = res.content?.[0]?.text ?? '';
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* plain-text response */ }
    return { text, json, isError: res.isError === true };
}

beforeAll(async () => {
    // NOT os.tmpdir(): macOS tmp lives under /var, which validateWorkspacePath
    // blocklists as a system path — workspace ops on temp repos would be
    // rejected before reaching the code under test.
    base = mkdtempSync(join(homedir(), '.claudia-mcp-test-'));

    repo = join(base, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.txt'), 'hello');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');

    worktree = join(repo, '.claudia-worktrees', 'claudia-task-wt');
    mkdirSync(join(repo, '.claudia-worktrees'), { recursive: true });
    git(repo, 'worktree', 'add', '-b', 'claudia/task-wt', worktree);

    // A second, unrelated workspace — nothing scoped to `repo` may ever see it.
    const other = join(base, 'other');
    mkdirSync(other);

    writeFileSync(join(base, 'workspace-config.json'), JSON.stringify({
        schemaVersion: 1,
        data: {
            workspaces: [
                { id: repo, name: 'repo', createdAt: new Date().toISOString() },
                {
                    id: worktree, name: 'claudia-task-wt', createdAt: new Date().toISOString(),
                    worktreeParentId: repo, worktreeBranch: 'claudia/task-wt',
                },
                { id: other, name: 'other', createdAt: new Date().toISOString() },
            ],
        },
    }, null, 2));

    // Disconnected + not interrupted → loaded into the lazy set, never respawned.
    const mkTask = (id: string, workspaceId: string, extra: Record<string, unknown> = {}) => ({
        id, prompt: `prompt for ${id}`, workspaceId,
        createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(),
        lastState: 'idle', wasInterrupted: false, shouldContinue: false, backendType: 'claude-code',
        ...extra,
    });
    writeFileSync(join(base, 'tasks.json'), JSON.stringify({
        tasks: [
            mkTask('task-root-1', repo),
            mkTask('task-wt-1', worktree),
            mkTask(SELF_TASK, worktree),
            // Title hand-edited by the user — agents must not be able to rename it.
            mkTask('task-locked', repo, { displayName: 'User Chosen Name', displayNameEditedByUser: true }),
            mkTask('task-other-1', other),
        ],
        archivedTasks: [],
    }, null, 2));

    const appParts = await createApp(base);
    shutdown = appParts.shutdownForTests;
    await new Promise<void>((resolve) => {
        appParts.server.listen(0, '127.0.0.1', () => resolve());
    });
    port = (appParts.server.address() as { port: number }).port;

    // BACKEND_URL is still read from env at module load, so it must be set
    // before the dynamic import. The rest of the session's scope is passed
    // explicitly to createClaudiaMcpServer — the server stopped being a
    // module-level singleton when it moved in-process (one McpServer per
    // session instead of one OS process per session).
    process.env.CLAUDIA_BACKEND_URL = `http://127.0.0.1:${port}`;

    const mod = await import('../claudia-mcp-server.js');

    // Scope the session to the WORKTREE — that is the case the cross-worktree
    // listing contract is about.
    const server = mod.createClaudiaMcpServer({
        workspaceId: worktree,
        taskId: SELF_TASK,
        modelTieringEnabled: false,
        todoEnabled: false,
        backendUrl: `http://127.0.0.1:${port}`,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
    ]);
}, 60000);

afterAll(async () => {
    try { await client?.close(); } catch { /* already closed */ }
    if (shutdown) await shutdown();
    // Detach the worktree before deleting, so no stale admin dir is left behind.
    try { git(repo, 'worktree', 'remove', '--force', worktree); } catch { /* best effort */ }
    // maxRetries: on Windows the just-removed worktree's handles can still be
    // open when rmdir runs, and an EBUSY here fails the whole suite even though
    // every test passed. Matches the retry guard the other suites use.
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    delete process.env.CLAUDIA_BACKEND_URL;
    delete process.env.CLAUDIA_WORKSPACE_ID;
    delete process.env.CLAUDIA_TASK_ID;
}, 30000);

// ============================================================================
// Tool schema integrity
// ============================================================================
describe('tool schema integrity', () => {
    const EXPECTED_TOOLS = [
        'claudia_list_tasks', 'claudia_get_task_status', 'claudia_get_task_output',
        'claudia_create_task', 'claudia_send_input', 'claudia_continue_task',
        'claudia_stop_task', 'claudia_stop_all_tasks', 'claudia_rename_task',
        'claudia_delete_task', 'claudia_cron_create', 'claudia_cron_list',
        'claudia_cron_delete', 'claudia_cron_pause',
        // The Jira surface is registered unconditionally by the same server; the
        // backend's /api/jira/* routes are what enforce the enabled/configured
        // check. They ship over the same stdio transport, so the schema
        // invariants below apply to them identically.
        'jira_get_ticket', 'jira_search', 'jira_list_attachments',
        'jira_download_attachment', 'jira_open_ticket', 'jira_add_comment',
        'jira_transition_ticket', 'jira_get_transitions',
    ];

    it('registers exactly the documented tool set', async () => {
        const { tools } = await client.listTools();
        expect(tools.map(t => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    });

    it('every tool has a non-trivial description and a valid object inputSchema', async () => {
        const { tools } = await client.listTools();
        for (const tool of tools) {
            expect(tool.name, 'tool must have a name').toBeTruthy();
            // Agents pick tools off the description alone; a stub description is a bug.
            expect(tool.description?.length ?? 0, `${tool.name} description too short`).toBeGreaterThan(40);
            expect(tool.inputSchema, `${tool.name} inputSchema`).toBeTruthy();
            expect(tool.inputSchema.type, `${tool.name} inputSchema.type`).toBe('object');
        }
    });

    it('every declared property is well-formed and every non-optional property is marked required', async () => {
        const { tools } = await client.listTools();
        // Ground truth: the params each tool cannot function without.
        const REQUIRED: Record<string, string[]> = {
            claudia_list_tasks: [],
            claudia_get_task_status: ['taskId'],
            claudia_get_task_output: ['taskId'],
            claudia_create_task: ['prompt'],
            claudia_send_input: ['taskId', 'input'],
            claudia_continue_task: ['taskId', 'prompt'],
            claudia_stop_task: ['taskId'],
            claudia_stop_all_tasks: [],
            claudia_rename_task: ['taskId', 'displayName'],
            claudia_delete_task: ['taskId'],
            claudia_cron_create: ['taskId', 'prompt', 'cronExpression'],
            claudia_cron_list: [],
            claudia_cron_delete: ['cronId'],
            claudia_cron_pause: ['cronId', 'paused'],
            jira_get_ticket: ['key'],
            jira_search: ['jql'],
            jira_list_attachments: ['key'],
            jira_download_attachment: ['attachmentId'],
            jira_open_ticket: ['key'],
            jira_add_comment: ['key', 'comment'],
            jira_transition_ticket: ['key', 'transitionId'],
            jira_get_transitions: ['key'],
        };

        for (const tool of tools) {
            const schema: any = tool.inputSchema;
            const required: string[] = schema.required ?? [];
            const props = schema.properties ?? {};

            // A tool registered without an entry here is a coverage hole, not a
            // pass — fail loudly rather than skipping it.
            expect(REQUIRED[tool.name], `${tool.name} has no ground-truth required set`).toBeTruthy();
            expect(required.slice().sort(), `${tool.name} required set`).toEqual(REQUIRED[tool.name].slice().sort());

            // Anything marked required must actually be declared as a property,
            // otherwise the tool advertises a param it can never receive.
            for (const req of required) {
                expect(props[req], `${tool.name}.${req} required but not declared`).toBeTruthy();
            }

            for (const [propName, prop] of Object.entries<any>(props)) {
                expect(prop.type ?? prop.enum ?? prop.anyOf, `${tool.name}.${propName} has no type`).toBeTruthy();
                // Descriptions are how the agent learns what to pass.
                expect(prop.description, `${tool.name}.${propName} missing description`).toBeTruthy();
            }
        }
    });

    it('tool schemas survive JSON round-tripping (what actually goes over stdio)', async () => {
        const { tools } = await client.listTools();
        for (const tool of tools) {
            const round = JSON.parse(JSON.stringify(tool.inputSchema));
            expect(round, `${tool.name} schema not JSON-stable`).toEqual(tool.inputSchema);
        }
    });
});

// ============================================================================
// The cross-worktree listing contract (commit 3037416)
// ============================================================================
describe('claudia_list_tasks cross-worktree scope', () => {
    it('a session inside a worktree sees the parent workspace and its siblings', async () => {
        const { json } = await callTool('claudia_list_tasks');
        expect(Array.isArray(json)).toBe(true);
        const ids = json.map((t: any) => t.id).sort();

        // The regression this guards: scoping to just the current worktree made
        // list_tasks return only this session's own task.
        expect(ids).toContain('task-root-1');   // parent workspace
        expect(ids).toContain('task-wt-1');     // sibling in the same worktree
        expect(ids).toContain(SELF_TASK);       // itself
    });

    it('does not leak tasks from unrelated workspaces', async () => {
        const { json } = await callTool('claudia_list_tasks');
        expect(json.map((t: any) => t.id)).not.toContain('task-other-1');
    });

    it('annotates worktree-resident tasks with their branch', async () => {
        const { json } = await callTool('claudia_list_tasks');
        const wtTask = json.find((t: any) => t.id === 'task-wt-1');
        const rootTask = json.find((t: any) => t.id === 'task-root-1');
        // Coordinators use this to tell which worktree each fleet member is in.
        expect(wtTask.worktree).toBe('claudia/task-wt');
        // Root-workspace tasks carry no worktree annotation at all.
        expect(rootTask).not.toHaveProperty('worktree');
    });

    it('reports resumability and prefers displayName over raw prompt', async () => {
        const { json } = await callTool('claudia_list_tasks');
        const locked = json.find((t: any) => t.id === 'task-locked');
        expect(locked.prompt).toBe('User Chosen Name');
        expect(locked.canResume).toBe(true); // idle → resumable
    });
});

// ============================================================================
// Dispatch: happy paths and clean error handling
// ============================================================================
describe('claudia_get_task_status', () => {
    it('returns full status for a real task', async () => {
        const { json } = await callTool('claudia_get_task_status', { taskId: 'task-root-1' });
        expect(json.id).toBe('task-root-1');
        expect(json.state).toBeTruthy();
        expect(json).toHaveProperty('canResume');
        expect(json).toHaveProperty('recentOutput');
    });

    it('returns a clean error for an unknown task rather than throwing', async () => {
        const { text, json } = await callTool('claudia_get_task_status', { taskId: 'does-not-exist' });
        expect(json).toBeNull();
        expect(text).toContain('not found');
    });

    it('rejects a missing required arg as a tool error, not a crash', async () => {
        const res = await callTool('claudia_get_task_status', {});
        expect(res.isError).toBe(true);
        // The server must still be usable afterwards.
        const after = await callTool('claudia_get_task_status', { taskId: 'task-root-1' });
        expect(after.json.id).toBe('task-root-1');
    });

    it('rejects a wrong-typed arg as a tool error', async () => {
        const res = await callTool('claudia_get_task_status', { taskId: 12345 });
        expect(res.isError).toBe(true);
    });
});

describe('claudia_get_task_output', () => {
    it('returns a clean error for an unknown task', async () => {
        const { text } = await callTool('claudia_get_task_output', { taskId: 'nope' });
        expect(text).toContain('not found');
    });

    it('accepts the optional maxBytes arg', async () => {
        const res = await callTool('claudia_get_task_output', { taskId: 'task-root-1', maxBytes: 1024 });
        expect(res.isError).toBe(false);
    });

    it('rejects a wrong-typed optional arg', async () => {
        const res = await callTool('claudia_get_task_output', { taskId: 'task-root-1', maxBytes: 'lots' });
        expect(res.isError).toBe(true);
    });
});

// ============================================================================
// Guardrails
// ============================================================================
describe('claudia_rename_task guardrail', () => {
    it('refuses to rename a task whose title the user hand-edited', async () => {
        const { json } = await callTool('claudia_rename_task', {
            taskId: 'task-locked', displayName: 'Agent Chosen Name',
        });
        expect(json.success).toBe(false);
        expect(json.displayNameEditedByUser).toBe(true);
        // The refusal must tell the agent not to retry, or it will loop.
        expect(json.message).toMatch(/Do not retry/i);
    });

    it('leaves the user-chosen title intact after a refused rename', async () => {
        const { json } = await callTool('claudia_list_tasks');
        const locked = json.find((t: any) => t.id === 'task-locked');
        expect(locked.prompt).toBe('User Chosen Name');
    });

    it('allows renaming a task the user has not touched', async () => {
        const { json } = await callTool('claudia_rename_task', {
            taskId: 'task-root-1', displayName: 'Agent Named This',
        });
        expect(json.success).toBe(true);

        const list = await callTool('claudia_list_tasks');
        expect(list.json.find((t: any) => t.id === 'task-root-1').prompt).toBe('Agent Named This');
    }, 20000);
});

describe('claudia_delete_task guardrail', () => {
    it('refuses to delete the session that is making the call', async () => {
        const { json } = await callTool('claudia_delete_task', { taskId: SELF_TASK });
        expect(json.success).toBe(false);
        expect(json.message).toMatch(/currently running session/i);
    });

    it('reports a clean failure for an unknown task', async () => {
        const { json } = await callTool('claudia_delete_task', { taskId: 'ghost-task' });
        expect(json.success).toBe(false);
        expect(json.message).toMatch(/not found/i);
    });

    it('does NOT delete without user approval — a rejection leaves the task alive', async () => {
        // Stand in for the frontend: wait for the confirmation broadcast, then deny it.
        const frontend = new WebSocket(`ws://127.0.0.1:${port}`);
        await new Promise<void>((res, rej) => {
            frontend.on('open', () => res());
            frontend.on('error', rej);
        });
        frontend.on('message', (data: Buffer) => {
            let msg: any;
            try { msg = JSON.parse(data.toString()); } catch { return; }
            if (msg.type === 'task:deleteRequest') {
                frontend.send(JSON.stringify({
                    type: 'task:deleteRejected',
                    payload: { taskId: msg.payload.taskId, requestId: msg.payload.requestId },
                }));
            }
        });

        const { json } = await callTool('claudia_delete_task', { taskId: 'task-wt-1' });
        frontend.close();

        expect(json.success).toBe(false);
        expect(json.message).toMatch(/rejected/i);

        // The critical assertion: the task actually survived.
        const list = await callTool('claudia_list_tasks');
        expect(list.json.map((t: any) => t.id)).toContain('task-wt-1');
    }, 30000);
});

// ============================================================================
// Cron tools
// ============================================================================
describe('cron tools', () => {
    it('rejects a malformed cron expression instead of scheduling it', async () => {
        const { text, json } = await callTool('claudia_cron_create', {
            taskId: 'task-root-1', prompt: 'ping', cronExpression: 'not a cron expression',
        });
        // Reaches the backend and is refused there — not a schema rejection.
        expect(json?.success).not.toBe(true);
        expect(text).toMatch(/error|invalid|cron/i);
    });

    it('creates a valid schedule and lists it back', async () => {
        const created = await callTool('claudia_cron_create', {
            taskId: 'task-root-1', cronExpression: '*/5 * * * *', prompt: 'ping', isRecurring: true,
        });
        expect(created.json?.success).toBe(true);
        const cronId = created.json.scheduledTaskId;
        expect(cronId).toBeTruthy();

        const listed = await callTool('claudia_cron_list', { taskId: 'task-root-1' });
        expect(listed.text).toContain(cronId);

        // Pause it, then delete it — exercises the rest of the cron surface.
        const paused = await callTool('claudia_cron_pause', { cronId, paused: true });
        expect(paused.isError).toBe(false);

        const deleted = await callTool('claudia_cron_delete', { cronId });
        expect(deleted.isError).toBe(false);
    }, 20000);

    it('lists schedules without requiring any argument', async () => {
        const res = await callTool('claudia_cron_list', {});
        expect(res.isError).toBe(false);
    });

    it('reports a clean failure when deleting a schedule that does not exist', async () => {
        const { text, json } = await callTool('claudia_cron_delete', { cronId: 'no-such-schedule' });
        expect((json ?? { message: text }).success).not.toBe(true);
    });

    it('requires the paused flag on claudia_cron_pause', async () => {
        const res = await callTool('claudia_cron_pause', { cronId: 'x' });
        expect(res.isError).toBe(true);
    });
});

// ============================================================================
// Pure helpers
// ============================================================================
describe('pure helpers', () => {
    it('formatDuration renders seconds, minutes and hours', async () => {
        const { formatDuration } = await import('../claudia-mcp-server.js');
        expect(formatDuration(5_000)).toBe('5s');
        expect(formatDuration(59_000)).toBe('59s');
        expect(formatDuration(90_000)).toBe('1m 30s');
        expect(formatDuration(3_600_000)).toBe('1h 0m');
        expect(formatDuration(3_930_000)).toBe('1h 5m');
        expect(formatDuration(0)).toBe('0s');
    });

    it('resolveWorktreeRoot walks nested parents up to the root', async () => {
        const { resolveWorktreeRoot } = await import('../claudia-mcp-server.js');
        const map = new Map<string, any>([
            ['root', { id: 'root' }],
            ['child', { id: 'child', worktreeParentId: 'root' }],
            ['grandchild', { id: 'grandchild', worktreeParentId: 'child' }],
        ]);
        expect(resolveWorktreeRoot(map, 'grandchild')).toBe('root');
        expect(resolveWorktreeRoot(map, 'child')).toBe('root');
        expect(resolveWorktreeRoot(map, 'root')).toBe('root');
    });

    it('resolveWorktreeRoot terminates on a cyclic parent chain', async () => {
        const { resolveWorktreeRoot } = await import('../claudia-mcp-server.js');
        // Cyclic worktreeParentId values have occurred in practice; an unguarded
        // walk would hang the MCP server for every tool call that resolves scope.
        const map = new Map<string, any>([
            ['a', { id: 'a', worktreeParentId: 'b' }],
            ['b', { id: 'b', worktreeParentId: 'a' }],
        ]);
        expect(() => resolveWorktreeRoot(map, 'a')).not.toThrow();
    });

    it('resolveWorktreeRoot handles an unknown start id', async () => {
        const { resolveWorktreeRoot } = await import('../claudia-mcp-server.js');
        expect(resolveWorktreeRoot(new Map(), 'missing')).toBe('missing');
    });
});

// ============================================================================
// Scope resolution against the real backend
// ============================================================================
describe('workspace scope resolution', () => {
    it('read scope spans the whole worktree tree', async () => {
        const { getWorkspaceScopeFor } = await import('../claudia-mcp-server.js');
        const { ids } = await getWorkspaceScopeFor(worktree, `http://127.0.0.1:${port}`);
        expect(ids.has(repo)).toBe(true);
        expect(ids.has(worktree)).toBe(true);
    });

    it('stop scope stays narrow — a worktree session cannot reach its parent', async () => {
        const { getStopScopeFor } = await import('../claudia-mcp-server.js');
        const ids = await getStopScopeFor(worktree, `http://127.0.0.1:${port}`);
        // Stopping is destructive: widening this to the whole workspace once let a
        // worktree session's cleanup kill the coordinator and every sibling.
        expect(ids.has(worktree)).toBe(true);
        expect(ids.has(repo)).toBe(false);
    });
});

// ============================================================================
// The flag-gated TODO surface
//
// claudia_todo_* is registered only when CLAUDIA_TODO_ENABLED=1 (task-spawner
// sets it per task). The default-set assertion above pins the flag-OFF surface;
// this pins the flag-ON one. Kept last in the file: it calls vi.resetModules()
// so a fresh module instance re-reads the env var at load time.
// ============================================================================
describe('TODO tools (CLAUDIA_TODO_ENABLED)', () => {
    it('registers exactly the four todo tools when enabled, and none when not', async () => {
        const off = await client.listTools();
        expect(off.tools.map(t => t.name).filter(n => n.startsWith('claudia_todo_'))).toEqual([]);

        vi.resetModules();
        process.env.CLAUDIA_TODO_ENABLED = '1';
        try {
            const mod = await import('../claudia-mcp-server.js');
            const todoServer = mod.createClaudiaMcpServer({
                workspaceId: worktree,
                taskId: SELF_TASK,
                modelTieringEnabled: false,
                todoEnabled: true,
                backendUrl: `http://127.0.0.1:${port}`,
            });
            const [ct, st] = InMemoryTransport.createLinkedPair();
            const todoClient = new Client({ name: 'todo', version: '1.0.0' });
            await Promise.all([todoServer.connect(st), todoClient.connect(ct)]);

            const { tools } = await todoClient.listTools();
            const todoTools = tools.map(t => t.name).filter(n => n.startsWith('claudia_todo_')).sort();
            expect(todoTools).toEqual([
                'claudia_todo_create', 'claudia_todo_list',
                'claudia_todo_reorder', 'claudia_todo_update',
            ]);

            // Same schema invariants the rest of the surface is held to.
            const REQUIRED: Record<string, string[]> = {
                claudia_todo_create: ['title'],
                claudia_todo_list: [],
                claudia_todo_update: ['todoId'],
                claudia_todo_reorder: ['orderedIds'],
            };
            for (const name of todoTools) {
                const tool = tools.find(t => t.name === name)!;
                const schema: any = tool.inputSchema;
                expect(schema.type, `${name} inputSchema.type`).toBe('object');
                expect(tool.description?.length ?? 0, `${name} description too short`).toBeGreaterThan(40);
                expect((schema.required ?? []).slice().sort(), `${name} required set`).toEqual(REQUIRED[name].slice().sort());
                for (const [propName, prop] of Object.entries<any>(schema.properties ?? {})) {
                    expect(prop.type ?? prop.enum ?? prop.anyOf, `${name}.${propName} has no type`).toBeTruthy();
                    expect(prop.description, `${name}.${propName} missing description`).toBeTruthy();
                }
            }

            // Drive one real round-trip through the backend so the handlers —
            // not just the registrations — are exercised.
            const call = async (n: string, a: Record<string, unknown>) => {
                const res: any = await todoClient.callTool({ name: n, arguments: a });
                const text = res.content?.[0]?.text ?? '';
                try { return { text, json: JSON.parse(text) }; } catch { return { text, json: null }; }
            };

            // Note the asymmetry: create takes no taskId — it always writes to
            // CLAUDIA_TASK_ID — while list/update/reorder accept one. So the item
            // lands on SELF_TASK, and that is where we read it back from.
            const created = await call('claudia_todo_create', { title: 'first step' });
            expect(created.json?.success, `create failed: ${created.text}`).toBe(true);
            const todoId = created.json.todoId;
            expect(todoId, `create returned no todoId: ${created.text}`).toBeTruthy();

            const listed = await call('claudia_todo_list', { taskId: SELF_TASK });
            expect(listed.text).toContain('first step');

            const updated = await call('claudia_todo_update', { todoId, status: 'completed' });
            expect(updated.text.toLowerCase()).not.toContain('error');

            // The completed status must actually have been persisted.
            const relisted = await call('claudia_todo_list', { taskId: SELF_TASK });
            expect(relisted.text).toMatch(/completed/i);

            const reordered = await call('claudia_todo_reorder', { taskId: SELF_TASK, orderedIds: [todoId] });
            expect(reordered.text.toLowerCase()).not.toContain('error');

            await todoClient.close();
        } finally {
            delete process.env.CLAUDIA_TODO_ENABLED;
            vi.resetModules();
        }
    }, 30000);
});
