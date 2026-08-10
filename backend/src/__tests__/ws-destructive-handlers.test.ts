/**
 * WS protocol coverage: the two handlers that destroy state wholesale.
 *
 * `task:destroy` and `task:clear` are isolated in their own file with their own
 * server because they wipe the task store — running them alongside the other WS
 * suites would make those suites order-dependent.
 *
 * Regression target for task:destroy: it must delete the task's on-disk history
 * file. Earlier versions leaked these (118 orphaned files, ~3 GB in production),
 * and nothing at the WS layer asserted the cleanup.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { createTestEnv, waitFor, type TestEnv, type WSClient, SUPPORTS_FAKE_CLI } from './helpers/ws-harness.js';

let env: TestEnv;
let client: WSClient;

/** History files live at <base>/task-histories/<taskId>.txt (see getHistoryDir). */
function historyFilesFor(base: string, taskId: string): string[] {
    const dir = join(base, 'task-histories');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(f => f.includes(taskId));
}

beforeAll(async () => {
    env = await createTestEnv({ prefix: 'ws-destroy', workspaces: ['dws'], withFakeClaude: true });
    client = await env.connect();
}, 40000);

afterAll(async () => {
    await env.cleanup();
}, 30000);

describe.skipIf(!SUPPORTS_FAKE_CLI)('task:destroy', () => {
    it('kills the process, removes the task, and deletes its history file', async () => {
        client.send('task:create', { prompt: 'DESTROY_ME', workspaceId: env.workspaces[0] });
        const tasks = await waitFor(() => env.api('/api/tasks'), (t: any[]) => t.length > 0, 25000);
        const taskId = tasks[0].id;

        // Generate output so a history file actually lands on disk — the whole
        // point of this test is that destroy cleans that file up.
        client.send('task:input', { taskId, input: 'echo HISTORY_SEED\r' });
        await waitFor(() => historyFilesFor(env.base, taskId), f => f.length > 0, 20000);
        expect(historyFilesFor(env.base, taskId)).toHaveLength(1);

        client.send('task:destroy', { taskId });
        const after = await waitFor(() => env.api('/api/tasks'), (t: any[]) => !t.some(x => x.id === taskId), 20000);
        expect(after.some((t: any) => t.id === taskId)).toBe(false);

        // The history file must be gone — orphans here leaked ~3 GB in production.
        await waitFor(() => historyFilesFor(env.base, taskId), f => f.length === 0, 15000);
        expect(historyFilesFor(env.base, taskId)).toHaveLength(0);
    }, 60000);

    it('destroying an unknown task is a no-op that keeps the socket alive', async () => {
        await client.sendAndProveAlive('task:destroy', { taskId: 'task-ghost' });
        await client.sendAndProveAlive('task:destroy', {});
        expect(client.isClosed).toBe(false);
    }, 20000);
});

describe.skipIf(!SUPPORTS_FAKE_CLI)('task:clear', () => {
    it('removes every task and leaves the server serving normally', async () => {
        // Seed a couple of tasks first so the clear is observable.
        client.send('task:create', { prompt: 'CLEAR_ME_1', workspaceId: env.workspaces[0] });
        await waitFor(() => env.api('/api/tasks'), (t: any[]) => t.length >= 1, 25000);

        client.send('task:clear', {});
        const after = await waitFor(() => env.api('/api/tasks'), (t: any[]) => t.length === 0, 20000);
        expect(after).toHaveLength(0);

        // Archived list is wiped too…
        const archived = await client.request('task:archived:list', {}, 'task:archived:list');
        expect(archived.payload.tasks).toHaveLength(0);

        // …and the server is still healthy and accepting new work.
        const health = await fetch(`http://127.0.0.1:${env.port}/api/health`).then(r => r.json());
        expect(health.status).toBe('ok');

        client.send('task:create', { prompt: 'AFTER_CLEAR', workspaceId: env.workspaces[0] });
        const revived = await waitFor(() => env.api('/api/tasks'), (t: any[]) => t.length === 1, 25000);
        expect(revived[0].prompt).toContain('AFTER_CLEAR');
    }, 90000);
});
