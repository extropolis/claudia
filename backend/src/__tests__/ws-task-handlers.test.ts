/**
 * WS protocol coverage: the `task:*` handler family.
 *
 * These drive the REAL server against the FAKE claude CLI, and assert on the
 * frames OTHER clients receive — not merely that the sender saw no error. A
 * handler that mutates state but forgets to broadcast is invisible to a
 * request/response-only test, and that is precisely the bug class the UI
 * suffers from (sidebar silently stale until reload).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestEnv, waitFor, type TestEnv, type WSClient, SUPPORTS_FAKE_CLI } from './helpers/ws-harness.js';

let env: TestEnv;
let client: WSClient;   // the "actor" — sends commands
let observer: WSClient; // a second client — proves broadcasts fan out

beforeAll(async () => {
    env = await createTestEnv({
        prefix: 'ws-task',
        workspaces: ['ws-a', 'ws-b'],
        withFakeClaude: true,
    });
    client = await env.connect();
    observer = await env.connect();
}, 40000);

afterAll(async () => {
    await env.cleanup();
}, 30000);

describe.skipIf(!SUPPORTS_FAKE_CLI)('task:create', () => {
    it('spawns the CLI, broadcasts task:created to ALL clients, and echoes `source`', async () => {
        client.send('task:create', { prompt: 'CREATE_ME run it', workspaceId: env.workspaces[0], source: 'test-suite' });

        // The OBSERVER (not the sender) must see the broadcast — this is the fan-out contract.
        const created = await observer.waitForMessage('task:created', f => f.payload?.task?.prompt?.includes('CREATE_ME'), 25000);
        expect(created.payload.source).toBe('test-suite');
        expect(created.payload.task.workspaceId).toBe(env.workspaces[0]);

        // …and the process really started: the fake logs its argv.
        await waitFor(() => env.readFake('args.log'), s => s.length > 0, 20000);
    }, 40000);

    it('rejects a missing prompt/workspaceId with MISSING_PARAMS', async () => {
        const err = await client.request('task:create', { workspaceId: env.workspaces[0] }, 'error');
        expect(err.payload.code).toBe('MISSING_PARAMS');
    });

    it('rejects an invalid complexity value', async () => {
        const err = await client.request(
            'task:create',
            { prompt: 'x', workspaceId: env.workspaces[0], complexity: 'extreme' },
            'error',
        );
        expect(err.payload.code).toBe('INVALID_COMPLEXITY');
    });

    it('rejects a traversal workspace path before spawning anything', async () => {
        const err = await client.request(
            'task:create',
            { prompt: 'x', workspaceId: `${env.workspaces[0]}/../../../etc` },
            'error',
        );
        expect(err.payload.code).toBe('INVALID_WORKSPACE');
    });
});

describe.skipIf(!SUPPORTS_FAKE_CLI)('task:select / task:input / task:resize', () => {
    let taskId: string;

    beforeAll(async () => {
        const tasks = await waitFor(() => env.api('/api/tasks'), (t: any[]) => t.length > 0, 20000);
        taskId = tasks[0].id;
    }, 25000);

    it('task:select activates a task without error', async () => {
        await client.sendAndProveAlive('task:select', { taskId });
    });

    it('task:select on an unknown taskId does not kill the connection', async () => {
        await client.sendAndProveAlive('task:select', { taskId: 'task-does-not-exist' });
        expect(client.isClosed).toBe(false);
    });

    it('task:input delivers keystrokes to the live PTY', async () => {
        client.send('task:input', { taskId, input: 'WS_INPUT_MARKER\r' });
        const log = await waitFor(() => env.readFake('input.log'), s => s.includes('WS_INPUT_MARKER'), 20000);
        expect(log).toContain('WS_INPUT_MARKER');
    }, 25000);

    it('task:input strips terminal focus escape sequences (they confuse the TUI)', async () => {
        // ESC[I / ESC[O must never reach the PTY.
        client.send('task:input', { taskId, input: '\x1b[IFOCUS_STRIPPED\x1b[O\r' });
        const log = await waitFor(() => env.readFake('input.log'), s => s.includes('FOCUS_STRIPPED'), 20000);
        const line = log.split('\n').find(l => l.includes('FOCUS_STRIPPED')) || '';
        expect(line).not.toContain('\x1b[I');
        expect(line).not.toContain('\x1b[O');
    }, 25000);

    it('task:resize with valid dims is accepted; garbage dims are ignored, not fatal', async () => {
        await client.sendAndProveAlive('task:resize', { taskId, cols: 100, rows: 30 });
        await client.sendAndProveAlive('task:resize', { taskId, cols: 'wide', rows: null });
        await client.sendAndProveAlive('task:resize', {});
        expect(client.isClosed).toBe(false);
    });
});

describe.skipIf(!SUPPORTS_FAKE_CLI)('task:stop / task:stopAll / task:interrupt', () => {
    it('task:stop replies task:stopped with a boolean result', async () => {
        const tasks = await env.api('/api/tasks');
        const id = tasks[0].id;
        const res = await client.request('task:stop', { taskId: id }, 'task:stopped');
        expect(res.payload.taskId).toBe(id);
        expect(typeof res.payload.stopped).toBe('boolean');
    }, 20000);

    it('task:stop on an unknown id still replies (stopped: false) rather than hanging', async () => {
        const res = await client.request('task:stop', { taskId: 'task-nope' }, 'task:stopped');
        expect(res.payload.stopped).toBe(false);
    });

    it('task:stopAll reports a count and honours excludeTaskId', async () => {
        const tasks = await env.api('/api/tasks');
        const id = tasks[0]?.id;
        const res = await client.request(
            'task:stopAll',
            { workspaceId: env.workspaces[0], excludeTaskId: id },
            'task:stopAll:result',
        );
        expect(res.payload.workspaceId).toBe(env.workspaces[0]);
        expect(typeof res.payload.stoppedCount).toBe('number');
        // The excluded task must never appear in the stopped set.
        expect(res.payload.stoppedIds).not.toContain(id);
    }, 20000);

    it('task:interrupt on a bogus id is a no-op, not a crash', async () => {
        await client.sendAndProveAlive('task:interrupt', { taskId: 'task-nope' });
        expect(client.isClosed).toBe(false);
    });
});

describe.skipIf(!SUPPORTS_FAKE_CLI)('task:rename + task:reorder persist across a server restart', () => {
    it('rename broadcasts tasks:updated and survives a fresh createApp on the same state dir', async () => {
        const tasks = await env.api('/api/tasks');
        const id = tasks[0].id;

        const updated = await client.request(
            'task:rename',
            { taskId: id, displayName: 'Renamed By Test', source: 'user' },
            'tasks:updated',
            f => f.payload.tasks.some((t: any) => t.id === id && t.displayName === 'Renamed By Test'),
        );
        expect(updated.payload.tasks.find((t: any) => t.id === id).displayName).toBe('Renamed By Test');

        // tasks.json writes are debounced (500ms) — wait for the rename to actually
        // reach disk before restarting, otherwise we'd be asserting on the debounce
        // timer rather than on persistence.
        await waitFor(
            () => JSON.parse(readFileSync(join(env.base, 'tasks.json'), 'utf8')),
            (j: any) => j.tasks.some((t: any) => t.id === id && t.displayName === 'Renamed By Test'),
            10000,
        );

        // Persistence is the real contract: boot a SECOND server on the same dir.
        const second = await env.restart();
        const persisted = await waitFor(
            () => fetch(`http://127.0.0.1:${second.port}/api/tasks`).then(r => r.json()),
            (ts: any[]) => ts.some(t => t.id === id),
            15000,
        );
        expect(persisted.find((t: any) => t.id === id).displayName).toBe('Renamed By Test');
        await second.shutdown();
    }, 40000);

    it('task:reorder broadcasts tasks:reordered', async () => {
        const tasks = await env.api('/api/tasks');
        const orders = tasks.map((t: any, i: number) => ({ taskId: t.id, order: tasks.length - i }));
        const res = await client.request('task:reorder', { taskOrders: orders }, 'tasks:reordered');
        expect(Array.isArray(res.payload.tasks)).toBe(true);
    }, 20000);

    it('task:reorder with a non-array payload is ignored, not fatal', async () => {
        await client.sendAndProveAlive('task:reorder', { taskOrders: 'not-an-array' });
        await client.sendAndProveAlive('task:reorder', {});
        expect(client.isClosed).toBe(false);
    });
});

describe.skipIf(!SUPPORTS_FAKE_CLI)('task:revert guardrails at the WS layer', () => {
    it('refuses to revert a task with no recorded git state', async () => {
        const tasks = await env.api('/api/tasks');
        const res = await client.request('task:revert', { taskId: tasks[0].id }, 'task:revertResult');
        expect(res.payload.success).toBe(false);
        expect(res.payload.error).toMatch(/no git state/i);
        expect(res.payload.filesReverted).toEqual([]);
    }, 20000);

    it('refuses to revert an unknown task rather than throwing', async () => {
        const res = await client.request('task:revert', { taskId: 'task-ghost' }, 'task:revertResult');
        expect(res.payload.success).toBe(false);
    }, 20000);
});

describe.skipIf(!SUPPORTS_FAKE_CLI)('task:restore', () => {
    it('replies with terminal history for a task that has output', async () => {
        const tasks = await env.api('/api/tasks');
        const id = tasks[0].id;
        client.send('task:restore', { taskId: id });
        const res = await client.waitForMessage('task:restore', f => f.payload?.taskId === id, 15000);
        expect(typeof res.payload.history).toBe('string');
    }, 20000);

    it('stays silent (no crash) for an unknown task', async () => {
        await client.sendAndProveAlive('task:restore', { taskId: 'task-ghost' });
        expect(client.isClosed).toBe(false);
    });
});

describe.skipIf(!SUPPORTS_FAKE_CLI)('task:deleteRequest / task:deleteRejected broadcast to the waiting MCP client', () => {
    it('deleteRequest reaches OTHER clients (the MCP agent waits on this)', async () => {
        client.send('task:deleteRequest', { taskId: 'task-x', requestId: 'req-1', taskName: 'Some Task' });
        const f = await observer.waitForMessage('task:deleteRequest', m => m.payload?.requestId === 'req-1');
        expect(f.payload.taskId).toBe('task-x');
        expect(f.payload.taskName).toBe('Some Task');
    }, 15000);

    it('deleteRejected reaches OTHER clients', async () => {
        client.send('task:deleteRejected', { taskId: 'task-x', requestId: 'req-1' });
        const f = await observer.waitForMessage('task:deleteRejected', m => m.payload?.requestId === 'req-1');
        expect(f.payload.taskId).toBe('task-x');
    }, 15000);

    it('drops delete frames missing requestId instead of broadcasting a half-formed dialog', async () => {
        const before = observer.all('task:deleteRequest').length;
        await client.sendAndProveAlive('task:deleteRequest', { taskId: 'task-y' });
        expect(observer.all('task:deleteRequest').length).toBe(before);
    });
});

describe.skipIf(!SUPPORTS_FAKE_CLI)('archive → list → restore → continue → delete round trip', () => {
    let archivedId: string;

    it('task:archive removes the task from the active list', async () => {
        const tasks = await env.api('/api/tasks');
        archivedId = tasks[0].id;
        client.send('task:archive', { taskId: archivedId });
        const remaining = await waitFor(
            () => env.api('/api/tasks'),
            (ts: any[]) => !ts.some(t => t.id === archivedId),
            20000,
        );
        expect(remaining.find((t: any) => t.id === archivedId)).toBeUndefined();
    }, 25000);

    it('task:archived:list includes the archived task', async () => {
        const res = await client.request('task:archived:list', {}, 'task:archived:list',
            f => f.payload.tasks.some((t: any) => t.id === archivedId));
        expect(res.payload.tasks.some((t: any) => t.id === archivedId)).toBe(true);
    }, 20000);

    it('task:archived:restore brings it back and broadcasts tasks:updated', async () => {
        const res = await client.request('task:archived:restore', { taskId: archivedId }, 'task:archived:restored');
        expect(res.payload.task.id).toBe(archivedId);
        await observer.waitForMessage('tasks:updated', f => f.payload.tasks.some((t: any) => t.id === archivedId));
    }, 20000);

    it('restoring an unknown archived id yields a restoreError, not a crash', async () => {
        const res = await client.request('task:archived:restore', { taskId: 'task-ghost' }, 'task:archived:restoreError');
        expect(res.payload.error).toMatch(/not found/i);
    }, 15000);

    it('continuing an unknown archived id yields a continueError', async () => {
        const res = await client.request('task:archived:continue', { taskId: 'task-ghost' }, 'task:archived:continueError');
        expect(res.payload.error).toMatch(/not found/i);
    }, 15000);

    it('task:archived:delete reports success:false for an unknown id (no silent true)', async () => {
        const res = await client.request('task:archived:delete', { taskId: 'task-ghost' }, 'task:archived:deleted');
        expect(res.payload.success).toBe(false);
    }, 15000);

    it('archive → continue actually re-activates the task', async () => {
        client.send('task:archive', { taskId: archivedId });
        await waitFor(() => env.api('/api/tasks'), (ts: any[]) => !ts.some(t => t.id === archivedId), 20000);
        const res = await client.request('task:archived:continue', { taskId: archivedId }, 'task:archived:continued');
        expect(res.payload.task.id).toBe(archivedId);
    }, 30000);

    it('task:archived:delete permanently removes it', async () => {
        client.send('task:archive', { taskId: archivedId });
        await waitFor(() => env.api('/api/tasks'), (ts: any[]) => !ts.some(t => t.id === archivedId), 20000);
        const res = await client.request('task:archived:delete', { taskId: archivedId }, 'task:archived:deleted',
            f => f.payload.taskId === archivedId && f.payload.success === true);
        expect(res.payload.success).toBe(true);

        const list = await client.request('task:archived:list', {}, 'task:archived:list');
        expect(list.payload.tasks.some((t: any) => t.id === archivedId)).toBe(false);
    }, 30000);
});

describe.skipIf(!SUPPORTS_FAKE_CLI)('task:disconnect / task:reconnect', () => {
    it('reconnecting an unknown task reports an error instead of throwing', async () => {
        await client.sendAndProveAlive('task:reconnect', { taskId: 'task-ghost' });
        expect(client.isClosed).toBe(false);
    }, 15000);

    it('disconnect on a bogus id is a no-op', async () => {
        await client.sendAndProveAlive('task:disconnect', { taskId: 'task-ghost' });
        expect(client.isClosed).toBe(false);
    });
});
