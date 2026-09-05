/**
 * Parent linkage on task creation.
 *
 * A task spawned through claudia_create_task must record its spawner, or the
 * sidebar shows a flat list instead of a fleet. The spawner's own id normally
 * arrives in the MCP scope (the X-Claudia-Task-Id header on the per-task
 * config), but a session that resolved the claudia server from the workspace
 * .mcp.json instead — a resumed session, or one started by hand in the
 * workspace — has no identity at all, and every task it spawned used to land
 * silently at the top level. So the tools also take an explicit parentTaskId.
 *
 * The backend here is a stub WebSocket server that records the task:create
 * payload and answers with a synthetic task:created. That keeps the assertion
 * on the wire payload — the thing that actually carries the linkage — without
 * spawning a real Claude Code PTY per case.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocketServer, type WebSocket as WS } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const WORKSPACE = '/repos/alpha';
const SELF_TASK = 'task-self-1';

let wss: WebSocketServer;
let port: number;
/** Every task:create payload the stub backend received, in order. */
let created: Record<string, any>[] = [];

/** An MCP client wired to a server with the given session scope. */
async function makeClient(taskId: string): Promise<Client> {
    const mod = await import('../claudia-mcp-server.js');
    const server = mod.createClaudiaMcpServer({
        workspaceId: WORKSPACE,
        taskId,
        modelTieringEnabled: false,
        todoEnabled: false,
        backendUrl: `http://127.0.0.1:${port}`,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'linkage-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
    const res: any = await client.callTool({ name, arguments: args });
    const text = res.content?.[0]?.text ?? '';
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* plain-text response */ }
    return { text, json };
}

beforeAll(async () => {
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>(resolve => wss.on('listening', () => resolve()));
    port = (wss.address() as { port: number }).port;

    let nextNumber = 100;
    wss.on('connection', (ws: WS) => {
        ws.on('message', (data: Buffer) => {
            const msg = JSON.parse(data.toString());
            if (msg.type !== 'task:create') return;
            created.push(msg.payload);
            const n = nextNumber++;
            // Mirrors createTask: a ref that resolves to no known task is not
            // stored as a parent, so the reply reports the linkage as it IS.
            const requested: string | undefined = msg.payload.parentTaskId;
            const stored = requested && /^task-[a-z0-9-]+$/i.test(requested) ? requested : undefined;
            ws.send(JSON.stringify({
                type: 'task:created',
                payload: {
                    source: 'mcp',
                    task: {
                        id: `task-new-${n}`, taskNumber: n, state: 'starting',
                        prompt: msg.payload.prompt, parentTaskId: stored,
                    },
                },
            }));
        });
    });
});

afterAll(async () => {
    await new Promise<void>(resolve => wss.close(() => resolve()));
});

describe('claudia_create_task parent linkage', () => {
    it('records the session\'s own task as the parent when the scope knows it', async () => {
        created = [];
        const client = await makeClient(SELF_TASK);
        const { json } = await callTool(client, 'claudia_create_task', { prompt: 'do a thing' });

        expect(created).toHaveLength(1);
        expect(created[0].parentTaskId).toBe(SELF_TASK);
        expect(json.parentTaskId).toBe(SELF_TASK);
        expect(json.warning).toBeUndefined();
        await client.close();
    });

    it('accepts an explicit parentTaskId when the session has no identity', async () => {
        created = [];
        const client = await makeClient('');
        const { json } = await callTool(client, 'claudia_create_task', {
            prompt: 'do a thing',
            parentTaskId: 'task-orchestrator',
        });

        expect(created[0].parentTaskId).toBe('task-orchestrator');
        expect(json.parentTaskId).toBe('task-orchestrator');
        expect(json.warning).toBeUndefined();
        await client.close();
    });

    it('lets an explicit parentTaskId override the scope, for a grandchild fan-out', async () => {
        created = [];
        const client = await makeClient(SELF_TASK);
        await callTool(client, 'claudia_create_task', { prompt: 'x', parentTaskId: 'task-other' });

        expect(created[0].parentTaskId).toBe('task-other');
        await client.close();
    });

    it('says so loudly when the task lands at the top level with no parent at all', async () => {
        created = [];
        const client = await makeClient('');
        const { json } = await callTool(client, 'claudia_create_task', { prompt: 'orphan' });

        expect(created[0].parentTaskId).toBeUndefined();
        expect(json.parentTaskId).toBeNull();
        expect(json.warning).toMatch(/TOP LEVEL/);
        expect(json.warning).toMatch(/parentTaskId/);
        await client.close();
    });

    it('treats a blank parentTaskId as absent rather than as a parent id', async () => {
        created = [];
        const client = await makeClient(SELF_TASK);
        await callTool(client, 'claudia_create_task', { prompt: 'x', parentTaskId: '   ' });

        expect(created[0].parentTaskId).toBe(SELF_TASK);
        await client.close();
    });

    it('applies one parent to every child of a batch fan-out', async () => {
        created = [];
        const client = await makeClient('');
        const { json } = await callTool(client, 'claudia_create_tasks', {
            tasks: [{ prompt: 'one' }, { prompt: 'two' }],
            parentTaskId: 'task-orchestrator',
        });

        expect(json.created).toBe(2);
        expect(created).toHaveLength(2);
        expect(created.map(c => c.parentTaskId)).toEqual(['task-orchestrator', 'task-orchestrator']);
        await client.close();
    });

    it('falls back to the session scope for a batch with no explicit parent', async () => {
        created = [];
        const client = await makeClient(SELF_TASK);
        await callTool(client, 'claudia_create_tasks', { tasks: [{ prompt: 'one' }, { prompt: 'two' }] });

        expect(created.map(c => c.parentTaskId)).toEqual([SELF_TASK, SELF_TASK]);
        await client.close();
    });

    it('advertises parentTaskId on both creation tools', async () => {
        const client = await makeClient(SELF_TASK);
        const { tools } = await client.listTools();
        for (const name of ['claudia_create_task', 'claudia_create_tasks']) {
            const tool = tools.find(t => t.name === name);
            expect(tool, name).toBeDefined();
            expect(Object.keys((tool!.inputSchema as any).properties), name).toContain('parentTaskId');
        }
        await client.close();
    });

    it('reports the parent the backend actually stored, not the one requested', async () => {
        created = [];
        const client = await makeClient(SELF_TASK);
        // A stale short ref resolves to nothing: the child really is top-level,
        // and saying otherwise recreates the exact bug this param exists to fix.
        const { json } = await callTool(client, 'claudia_create_task', { prompt: 'x', parentTaskId: '#9999' });

        expect(created[0].parentTaskId).toBe('#9999');
        expect(json.parentTaskId).toBeNull();
        expect(json.warning).toMatch(/did not resolve/);
        await client.close();
    });
});
