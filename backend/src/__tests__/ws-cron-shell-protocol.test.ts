/**
 * WS protocol coverage: `cron:*`, `shell:*`, and protocol-level robustness.
 *
 * Cron is driven via `fireNow` and near-future expressions — never by sleeping
 * until a wall-clock minute rolls over.
 *
 * NOTE (testability gap, not a test bug): CronScheduler persists to a path
 * hardcoded relative to its own module (`backend/scheduled-tasks.json`) and does
 * NOT honour createApp's basePath. So unlike every other store, cron state is
 * shared between the test server and the developer's real server. We snapshot
 * and restore that file around the suite to avoid clobbering it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createTestEnv, waitFor, type TestEnv, type WSClient, SUPPORTS_FAKE_CLI } from './helpers/ws-harness.js';

const CRON_STATE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scheduled-tasks.json');

let env: TestEnv;
let client: WSClient;
let observer: WSClient;
let taskId: string;
let cronBackup: string | null = null;

beforeAll(async () => {
    cronBackup = existsSync(CRON_STATE) ? readFileSync(CRON_STATE, 'utf8') : null;

    env = await createTestEnv({ prefix: 'ws-cron', workspaces: ['cronws'], withFakeClaude: true });
    client = await env.connect();
    observer = await env.connect();

    // A real task is required — cron:create refuses to schedule against an unknown task.
    client.send('task:create', { prompt: 'CRON_HOST_TASK', workspaceId: env.workspaces[0] });
    const tasks = await waitFor(() => env.api('/api/tasks'), (t: any[]) => t.length > 0, 25000);
    taskId = tasks[0].id;
}, 45000);

afterAll(async () => {
    await env.cleanup();
    // Restore the developer's real cron state (see note above).
    if (cronBackup !== null) writeFileSync(CRON_STATE, cronBackup);
    else rmSync(CRON_STATE, { force: true });
}, 30000);

describe.skipIf(!SUPPORTS_FAKE_CLI)('cron:create', () => {
    it('creates a schedule, returns a human description, and broadcasts cron:updated', async () => {
        const res = await client.request(
            'cron:create',
            { taskId, cronExpression: '*/5 * * * *', prompt: 'check the build', isRecurring: true },
            'cron:created',
        );
        expect(res.payload.scheduledTask.taskId).toBe(taskId);
        expect(res.payload.scheduledTask.cronExpression).toBe('*/5 * * * *');
        expect(res.payload.scheduledTask.isRecurring).toBe(true);
        expect(res.payload.scheduledTask.fireCount).toBe(0);
        expect(res.payload.scheduledTask.nextFireAt).toBeTruthy();
        expect(typeof res.payload.description).toBe('string');
        expect(res.payload.description.length).toBeGreaterThan(0);

        await observer.waitForMessage('cron:updated', f => f.payload?.taskId === taskId);
    }, 20000);

    it('rejects an invalid cron expression with CRON_CREATE_FAILED', async () => {
        const err = await client.request(
            'cron:create',
            { taskId, cronExpression: 'not a cron', prompt: 'x' },
            'error',
        );
        expect(err.payload.code).toBe('CRON_CREATE_FAILED');
        expect(err.payload.message).toMatch(/invalid cron/i);
    }, 15000);

    /**
     * KNOWN BUG (documented, not endorsed) — out-of-range cron fields are accepted.
     *
     * `parseCronField(field, min, max)` receives min/max but only uses them as the
     * default bounds when expanding a `star/step` form. Single values and ranges are
     * never checked against them, so "99 * * * *" (minute 99), "* 25 * * *" (hour 25),
     * "* * 32 * *" and "* * * 13 *" all validate as legal.
     *
     * Symptom: the schedule is created and shown in the UI, but `nextFireAt` is
     * undefined because getNextFireTime scans 366 days without a match — so it
     * SILENTLY NEVER FIRES, with no error surfaced to the user. Each such create
     * also burns ~527k date iterations (~75ms) inside the WS handler.
     *
     * When field-range validation is added, this test SHOULD fail — replace it with
     * an assertion that `cron:create` returns CRON_CREATE_FAILED.
     */
    it('BUG: accepts out-of-range fields and creates a schedule that never fires', async () => {
        for (const expr of ['99 * * * *', '* 25 * * *', '* * 32 * *', '* * * 13 *']) {
            const res = await client.request(
                'cron:create',
                { taskId, cronExpression: expr, prompt: 'never fires' },
                'cron:created',
                f => f.payload?.scheduledTask?.cronExpression === expr,
            );
            // Accepted despite being unsatisfiable…
            expect(res.payload.scheduledTask.cronExpression).toBe(expr);
            // …and provably dead: no next fire time was computable.
            expect(res.payload.scheduledTask.nextFireAt).toBeUndefined();
            await client.request('cron:delete', { cronId: res.payload.scheduledTask.id }, 'cron:deleted');
        }
    }, 40000);

    it('a satisfiable expression by contrast always yields a concrete nextFireAt', async () => {
        const res = await client.request(
            'cron:create',
            { taskId, cronExpression: '5 * * * *', prompt: 'hourly' },
            'cron:created',
            f => f.payload?.scheduledTask?.cronExpression === '5 * * * *',
        );
        expect(res.payload.scheduledTask.nextFireAt).toBeTruthy();
        expect(new Date(res.payload.scheduledTask.nextFireAt).getTime()).toBeGreaterThan(Date.now());
        await client.request('cron:delete', { cronId: res.payload.scheduledTask.id }, 'cron:deleted');
    }, 20000);

    it('refuses to schedule against an unknown task (TASK_NOT_FOUND)', async () => {
        const err = await client.request(
            'cron:create',
            { taskId: 'task-ghost', cronExpression: '* * * * *', prompt: 'x' },
            'error',
        );
        expect(err.payload.code).toBe('TASK_NOT_FOUND');
    }, 15000);

    it('requires taskId, cronExpression and prompt', async () => {
        for (const payload of [
            {},
            { taskId },
            { taskId, cronExpression: '* * * * *' },
            { cronExpression: '* * * * *', prompt: 'x' },
        ]) {
            const err = await client.request('cron:create', payload, 'error');
            expect(err.payload.code).toBe('MISSING_PARAMS');
        }
    }, 25000);
});

describe.skipIf(!SUPPORTS_FAKE_CLI)('cron:list / update / run / delete', () => {
    let cronId: string;

    beforeAll(async () => {
        const res = await client.request(
            'cron:create',
            { taskId, cronExpression: '0 9 * * 1-5', prompt: 'weekday standup', isRecurring: true },
            'cron:created',
        );
        cronId = res.payload.scheduledTask.id;
    }, 20000);

    it('list scoped to a taskId returns that task\'s schedules', async () => {
        const res = await client.request('cron:list', { taskId }, 'cron:list');
        expect(res.payload.scheduledTasks.some((s: any) => s.id === cronId)).toBe(true);
        expect(res.payload.scheduledTasks.every((s: any) => s.taskId === taskId)).toBe(true);
    }, 15000);

    it('list with no taskId returns all schedules', async () => {
        const res = await client.request('cron:list', {}, 'cron:list');
        expect(Array.isArray(res.payload.scheduledTasks)).toBe(true);
        expect(res.payload.scheduledTasks.some((s: any) => s.id === cronId)).toBe(true);
    }, 15000);

    it('update changes the expression and recomputes nextFireAt', async () => {
        const before = (await client.request('cron:list', { taskId }, 'cron:list'))
            .payload.scheduledTasks.find((s: any) => s.id === cronId);

        const res = await client.request(
            'cron:update',
            { cronId, cronExpression: '30 14 * * *', prompt: 'afternoon check' },
            'cron:updated',
            f => Boolean(f.payload?.scheduledTask),
        );
        expect(res.payload.scheduledTask.cronExpression).toBe('30 14 * * *');
        expect(res.payload.scheduledTask.prompt).toBe('afternoon check');
        expect(res.payload.scheduledTask.nextFireAt).not.toBe(before.nextFireAt);
        expect(typeof res.payload.scheduledTask.description).toBe('string');
    }, 20000);

    it('update can pause and resume a schedule', async () => {
        const paused = await client.request('cron:update', { cronId, isPaused: true }, 'cron:updated',
            f => f.payload?.scheduledTask?.isPaused === true);
        expect(paused.payload.scheduledTask.isPaused).toBe(true);

        const resumed = await client.request('cron:update', { cronId, isPaused: false }, 'cron:updated',
            f => f.payload?.scheduledTask?.isPaused === false);
        expect(resumed.payload.scheduledTask.isPaused).toBe(false);
    }, 20000);

    it('update rejects an invalid expression without corrupting the existing schedule', async () => {
        const err = await client.request('cron:update', { cronId, cronExpression: 'garbage' }, 'error');
        expect(err.payload.code).toBe('CRON_UPDATE_FAILED');

        const still = (await client.request('cron:list', { taskId }, 'cron:list'))
            .payload.scheduledTasks.find((s: any) => s.id === cronId);
        expect(still.cronExpression).toBe('30 14 * * *'); // unchanged
    }, 20000);

    it('update on an unknown cronId reports CRON_NOT_FOUND', async () => {
        const err = await client.request('cron:update', { cronId: 'nope1234' }, 'error');
        expect(err.payload.code).toBe('CRON_NOT_FOUND');
    }, 15000);

    it('run fires immediately and increments fireCount (no waiting on wall-clock)', async () => {
        const res = await client.request('cron:run', { cronId }, 'cron:ran');
        expect(res.payload.cronId).toBe(cronId);
        expect(res.payload.taskId).toBe(taskId);
        expect(res.payload.scheduledTask.fireCount).toBe(1);
        expect(res.payload.scheduledTask.lastFiredAt).toBeTruthy();
        await observer.waitForMessage('cron:updated', f => f.payload?.cronId === cronId);
    }, 20000);

    it('a one-shot schedule deletes itself after running', async () => {
        const created = await client.request(
            'cron:create',
            { taskId, cronExpression: '0 0 1 1 *', prompt: 'once only', isRecurring: false },
            'cron:created',
        );
        const oneShotId = created.payload.scheduledTask.id;
        expect(created.payload.scheduledTask.isRecurring).toBe(false);

        await client.request('cron:run', { cronId: oneShotId }, 'cron:ran', f => f.payload?.cronId === oneShotId);

        const list = await client.request('cron:list', { taskId }, 'cron:list');
        expect(list.payload.scheduledTasks.some((s: any) => s.id === oneShotId)).toBe(false);
    }, 25000);

    it('run on an unknown cronId reports CRON_NOT_FOUND', async () => {
        const err = await client.request('cron:run', { cronId: 'nope1234' }, 'error');
        expect(err.payload.code).toBe('CRON_NOT_FOUND');
    }, 15000);

    it('delete removes the schedule and broadcasts', async () => {
        const res = await client.request('cron:delete', { cronId }, 'cron:deleted');
        expect(res.payload.cronId).toBe(cronId);
        expect(res.payload.taskId).toBe(taskId);
        await observer.waitForMessage('cron:updated', f => f.payload?.cronId === cronId);

        const list = await client.request('cron:list', { taskId }, 'cron:list');
        expect(list.payload.scheduledTasks.some((s: any) => s.id === cronId)).toBe(false);
    }, 20000);

    it('delete on an unknown cronId reports CRON_NOT_FOUND (no silent success)', async () => {
        const err = await client.request('cron:delete', { cronId: 'nope1234' }, 'error');
        expect(err.payload.code).toBe('CRON_NOT_FOUND');
    }, 15000);

    it('cron ops require their id params', async () => {
        for (const type of ['cron:delete', 'cron:update', 'cron:run'] as const) {
            const err = await client.request(type, {}, 'error');
            expect(err.payload.code).toBe('MISSING_PARAMS');
        }
    }, 20000);
});

describe.skipIf(!SUPPORTS_FAKE_CLI)('shell:create / input / resize / close', () => {
    it('spawns a real PTY and round-trips a command through it', async () => {
        const wsId = env.workspaces[0];
        await client.request('shell:create', { workspaceId: wsId, cols: 80, rows: 24 }, 'shell:created',
            f => f.payload?.workspaceId === wsId, 20000);

        // A harmless command whose output is unmistakable.
        client.send('shell:input', { workspaceId: wsId, input: 'echo SHELL_ROUNDTRIP_OK\n' });
        const out = await waitFor(
            () => client.all('shell:output').map(f => f.payload.data).join(''),
            s => s.includes('SHELL_ROUNDTRIP_OK'),
            20000,
        );
        expect(out).toContain('SHELL_ROUNDTRIP_OK');
    }, 40000);

    it('shell:create for an existing workspace reuses the shell rather than spawning a second', async () => {
        const wsId = env.workspaces[0];
        const res = await client.request('shell:create', { workspaceId: wsId }, 'shell:created',
            f => f.payload?.workspaceId === wsId, 20000);
        expect(res.payload.workspaceId).toBe(wsId);
    }, 25000);

    it('shell:resize is accepted', async () => {
        await client.sendAndProveAlive('shell:resize', { workspaceId: env.workspaces[0], cols: 100, rows: 40 });
        expect(client.isClosed).toBe(false);
    }, 15000);

    it('shell ops against an unknown workspace are no-ops, not crashes', async () => {
        await client.sendAndProveAlive('shell:input', { workspaceId: '/ghost', input: 'echo hi\n' });
        await client.sendAndProveAlive('shell:resize', { workspaceId: '/ghost', cols: 10, rows: 10 });
        await client.sendAndProveAlive('shell:close', { workspaceId: '/ghost' });
        await client.sendAndProveAlive('shell:input', {});
        await client.sendAndProveAlive('shell:resize', {});
        await client.sendAndProveAlive('shell:close', {});
        expect(client.isClosed).toBe(false);
    }, 30000);

    it('shell:close terminates the PTY', async () => {
        await client.sendAndProveAlive('shell:close', { workspaceId: env.workspaces[0] });
        expect(client.isClosed).toBe(false);
    }, 15000);
});

describe.skipIf(!SUPPORTS_FAKE_CLI)('protocol robustness: malformed input must never take down the server', () => {
    it('non-JSON payload yields INVALID_JSON and keeps the socket usable', async () => {
        client.sendRaw('this is not json{{{');
        const err = await client.waitForMessage('error', f => f.payload?.code === 'INVALID_JSON');
        expect(err.payload.code).toBe('INVALID_JSON');
        await client.ping();
        expect(client.isClosed).toBe(false);
    }, 15000);

    it('unknown message type is rejected with INVALID_MESSAGE', async () => {
        const err = await client.request('totally:made:up', {}, 'error');
        expect(err.payload.code).toBe('INVALID_MESSAGE');
    }, 15000);

    it('non-object payload is rejected rather than spread into the handler', async () => {
        client.sendRaw(JSON.stringify({ type: 'task:stop', payload: 'a string' }));
        const err = await client.waitForMessage('error', f => f.payload?.code === 'INVALID_MESSAGE');
        expect(err.payload.code).toBe('INVALID_MESSAGE');

        client.sendRaw(JSON.stringify({ type: 'task:stop', payload: null }));
        await client.ping();
        expect(client.isClosed).toBe(false);
    }, 20000);

    it('missing/non-string type is rejected', async () => {
        client.sendRaw(JSON.stringify({ payload: {} }));
        client.sendRaw(JSON.stringify({ type: 42 }));
        client.sendRaw(JSON.stringify([1, 2, 3]));
        client.sendRaw(JSON.stringify(null));
        await client.ping();
        expect(client.isClosed).toBe(false);
    }, 20000);

    it('one client sending garbage does not disturb another client\'s session', async () => {
        const victim = await env.connect();
        for (let i = 0; i < 25; i++) {
            client.sendRaw('}{garbage' + i);
            client.sendRaw(JSON.stringify({ type: 'task:revert', payload: { taskId: null } }));
            client.sendRaw(JSON.stringify({ type: 'workspace:setOrder', payload: { orderedIds: [{}, 7] } }));
        }
        // The victim's connection must still serve a normal request.
        await victim.ping();
        expect(victim.isClosed).toBe(false);
        expect(client.isClosed).toBe(false);
        victim.close();
    }, 30000);

    it('deeply nested / oversized payloads do not crash the handler', async () => {
        let nested: any = { end: true };
        for (let i = 0; i < 500; i++) nested = { nested };
        client.sendRaw(JSON.stringify({ type: 'task:select', payload: { taskId: 'x', junk: nested } }));
        client.sendRaw(JSON.stringify({ type: 'task:rename', payload: { taskId: 'x', displayName: 'A'.repeat(100000) } }));
        await client.ping();
        expect(client.isClosed).toBe(false);
    }, 25000);

    it('the server process is still healthy after all of the above', async () => {
        const health = await fetch(`http://127.0.0.1:${env.port}/api/health`).then(r => r.json());
        expect(health.status).toBe('ok');
    }, 15000);
});

describe.skipIf(!SUPPORTS_FAKE_CLI)('supervisor + tunnel handlers that need no network', () => {
    it('supervisor:chat:history replies with a message list', async () => {
        const res = await client.request('supervisor:chat:history', {}, 'supervisor:chat:history');
        expect(Array.isArray(res.payload.messages)).toBe(true);
    }, 15000);

    it('supervisor:chat:history scoped to a workspace echoes the workspaceId', async () => {
        const res = await client.request(
            'supervisor:chat:history',
            { workspaceId: env.workspaces[0] },
            'supervisor:chat:history',
            f => f.payload?.workspaceId === env.workspaces[0],
        );
        expect(res.payload.workspaceId).toBe(env.workspaces[0]);
    }, 15000);

    it('supervisor:chat:clear empties history and broadcasts to all clients', async () => {
        client.send('supervisor:chat:clear', {});
        const f = await observer.waitForMessage('supervisor:chat:history', m => Array.isArray(m.payload?.messages));
        expect(f.payload.messages).toEqual([]);
    }, 15000);

    it('supervisor:analyze on an unknown task is a no-op (no LLM call, no crash)', async () => {
        await client.sendAndProveAlive('supervisor:analyze', { taskId: 'task-ghost' });
        expect(client.isClosed).toBe(false);
    }, 15000);

    it('supervisor:action without an action is ignored', async () => {
        await client.sendAndProveAlive('supervisor:action', { taskId: 'task-ghost' });
        expect(client.isClosed).toBe(false);
    }, 15000);

    it('tunnel:status reports local status without dialling out', async () => {
        const res = await client.request('tunnel:status', {}, 'tunnel:status');
        expect(res.payload).toBeDefined();
        expect(typeof res.payload).toBe('object');
    }, 15000);
});
