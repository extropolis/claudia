/**
 * Multi-client viewer model, end to end against the REAL server.
 *
 * One backend serves many clients at once. A PTY has exactly one size, so
 * before per-task ownership every `task:resize` was applied unconditionally and
 * the last client to send a width won — three viewers with three window widths
 * fought over the PTY continuously.
 *
 * The assertions here deliberately read the LIVE PTY dimensions off the real
 * TaskSpawner (`env.taskSpawner.getTaskDimensions`) rather than trusting the
 * `task:viewers` broadcast. The broadcast is emitted by the same handler under
 * test, so believing it would let a handler that skips the resize but still
 * announces the size pass. "Did not change" has to be observed at the process.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestEnv, waitFor, type TestEnv, type WSClient, SUPPORTS_FAKE_CLI } from './helpers/ws-harness.js';

let env: TestEnv;
let a: WSClient;
let b: WSClient;
let taskId: string;

/** The clientId the server assigned each socket, handed back in `init`. */
async function idOf(c: WSClient): Promise<string> {
    const init = await c.waitForMessage('init');
    return init.payload.clientId as string;
}

const dims = () => env.taskSpawner.getTaskDimensions(taskId);

/** Send a resize and give the handler a turn of the event loop to run. */
async function resize(c: WSClient, cols: number, rows: number): Promise<void> {
    c.send('task:resize', { taskId, cols, rows });
    await c.ping(); // round-trips a real request, so the resize has been handled
}

/**
 * Focus and WAIT until the server has confirmed the new owner.
 *
 * Frames from two different sockets have no ordering guarantee relative to each
 * other, so a test that focuses on socket X and then resizes on socket Y must
 * synchronise on the broadcast, not on send order. `observer` watches for the
 * new frame; `waitForMessage` replays buffered frames, hence the index floor.
 */
async function focus(c: WSClient, ownerId: string, observer: WSClient): Promise<void> {
    const seen = observer.frames.length;
    c.send('task:focus', { taskId });
    await observer.waitForMessage(
        'task:viewers',
        f => observer.frames.indexOf(f) >= seen
            && f.payload.taskId === taskId
            && f.payload.ownerClientId === ownerId,
        15000,
    );
}

beforeAll(async () => {
    env = await createTestEnv({
        prefix: 'ws-viewers',
        workspaces: ['ws-a'],
        withFakeClaude: true,
    });
    a = await env.connect();
    b = await env.connect();

    a.send('task:create', { prompt: 'VIEWER_MODEL_TASK', workspaceId: env.workspaces[0] });
    const created = await a.waitForMessage(
        'task:created',
        f => f.payload?.task?.prompt?.includes('VIEWER_MODEL_TASK'),
        30000,
    );
    taskId = created.payload.task.id;
    // The PTY must be live before size assertions mean anything.
    await waitFor(() => env.taskSpawner.getTaskDimensions(taskId), d => d !== undefined, 20000);
}, 60000);

afterAll(async () => {
    await env.cleanup();
}, 30000);

describe.skipIf(!SUPPORTS_FAKE_CLI)('per-task terminal ownership', () => {
    it('hands each client its own id in init so it can tell if it owns a terminal', async () => {
        const [idA, idB] = [await idOf(a), await idOf(b)];
        expect(idA).toBeTruthy();
        expect(idB).toBeTruthy();
        expect(idA).not.toBe(idB);
    });

    it('applies a resize from the client that focused the task', async () => {
        a.send('task:focus', { taskId });
        await a.waitForMessage('task:viewers', f => f.payload.taskId === taskId);

        await resize(a, 111, 31);

        expect(dims()).toEqual({ cols: 111, rows: 31 });
    }, 20000);

    it('broadcasts task:viewers on focus, to every client, naming the new owner', async () => {
        const idB = await idOf(b);
        const seen = b.frames.length;

        b.send('task:focus', { taskId });

        // The OTHER client must see it too: viewer state is fan-out, not a reply.
        const onA = await a.waitForMessage(
            'task:viewers',
            f => f.payload.taskId === taskId && f.payload.ownerClientId === idB,
        );
        expect(onA.payload.ownerClientId).toBe(idB);

        const onB = await b.waitForMessage(
            'task:viewers',
            f => b.frames.indexOf(f) >= seen && f.payload.taskId === taskId,
        );
        expect(onB.payload.ownerClientId).toBe(idB);
    }, 20000);

    it('DROPS a resize from a client that does not own the task', async () => {
        // A owns it (focused above, then B focused — re-establish A deliberately).
        a.send('task:focus', { taskId });
        await a.waitForMessage('task:viewers', f => f.payload.taskId === taskId);
        await resize(a, 120, 40);
        expect(dims()).toEqual({ cols: 120, rows: 40 });

        // B is connected and watching, but is NOT the owner. Its resize must be
        // silently ignored — a background tab reflowing is not a fault.
        await resize(b, 60, 20);

        expect(dims()).toEqual({ cols: 120, rows: 40 });
        expect(b.isClosed).toBe(false);
        // Silently: no error frame was sent back.
        expect(b.all('error').filter(f => f.payload?.originalType === 'task:resize')).toEqual([]);
    }, 25000);

    it('lets B take ownership by focusing, after which B\'s resize applies', async () => {
        a.send('task:focus', { taskId });
        await resize(a, 120, 40);
        await resize(b, 61, 21);
        expect(dims()).toEqual({ cols: 120, rows: 40 }); // still A's

        const idB = await idOf(b);
        b.send('task:focus', { taskId });
        await a.waitForMessage(
            'task:viewers',
            f => f.payload.taskId === taskId && f.payload.ownerClientId === idB,
        );

        await resize(b, 95, 28);
        expect(dims()).toEqual({ cols: 95, rows: 28 });

        // …and now it is A's resizes that are dropped. Ownership is exclusive.
        await resize(a, 70, 22);
        expect(dims()).toEqual({ cols: 95, rows: 28 });
    }, 30000);

    it('reports the owner dimensions in task:viewers so non-owners can render at them', async () => {
        b.send('task:focus', { taskId });
        await resize(b, 132, 43);

        const frame = await b.waitForMessage(
            'task:viewers',
            f => f.payload.taskId === taskId && f.payload.cols === 132,
        );
        expect(frame.payload.rows).toBe(43);
    }, 20000);

    it('counts the clients focused on the task', async () => {
        a.send('task:focus', { taskId });
        b.send('task:focus', { taskId });
        const frame = await b.waitForMessage(
            'task:viewers',
            f => f.payload.taskId === taskId && f.payload.count === 2,
            15000,
        );
        expect(frame.payload.count).toBe(2);
    }, 20000);

    it('releases ownership when the owner disconnects, so the survivor can resize', async () => {
        // Fresh sockets: this test destroys one of them.
        const owner = await env.connect();
        const survivor = await env.connect();
        const ownerId = await idOf(owner);

        // Both watch the task; `owner` focuses LAST so it holds the terminal.
        // Each step is awaited: cross-socket frames have no ordering guarantee.
        await focus(survivor, await idOf(survivor), survivor);
        await focus(owner, ownerId, survivor);

        owner.send('task:resize', { taskId, cols: 128, rows: 44 });
        await owner.ping();
        expect(dims()).toEqual({ cols: 128, rows: 44 });

        // The survivor cannot resize while the owner holds the terminal.
        survivor.send('task:resize', { taskId, cols: 64, rows: 24 });
        await survivor.ping();
        expect(dims()).toEqual({ cols: 128, rows: 44 });

        // Owner goes away (closed lid, closed tab). Ownership must not stay
        // pinned to a dead client, or the terminal freezes at its last width.
        const seen = survivor.frames.length;
        owner.close();
        const released = await survivor.waitForMessage(
            'task:viewers',
            f => survivor.frames.indexOf(f) >= seen
                && f.payload.taskId === taskId
                && f.payload.ownerClientId === null,
            15000,
        );
        expect(released.payload.ownerClientId).toBeNull();

        // The next resize from the survivor claims the now-unowned terminal.
        survivor.send('task:resize', { taskId, cols: 64, rows: 24 });
        await survivor.ping();
        expect(dims()).toEqual({ cols: 64, rows: 24 });

        survivor.close();
    }, 40000);

    it('lets a client that never focuses claim an unowned task by resizing', async () => {
        // A brand new task nobody has focused: the first resize wins it, so an
        // older frontend that only knows task:resize still gets a sized terminal.
        const solo = await env.connect();
        solo.send('task:create', { prompt: 'UNFOCUSED_TASK', workspaceId: env.workspaces[0] });
        const created = await solo.waitForMessage(
            'task:created',
            f => f.payload?.task?.prompt?.includes('UNFOCUSED_TASK'),
            30000,
        );
        const soloTaskId = created.payload.task.id as string;
        await waitFor(() => env.taskSpawner.getTaskDimensions(soloTaskId), d => d !== undefined, 20000);

        solo.send('task:resize', { taskId: soloTaskId, cols: 101, rows: 33 });
        await solo.ping();
        expect(env.taskSpawner.getTaskDimensions(soloTaskId)).toEqual({ cols: 101, rows: 33 });

        // …and a second client is now locked out of that terminal.
        b.send('task:resize', { taskId: soloTaskId, cols: 55, rows: 15 });
        await b.ping();
        expect(env.taskSpawner.getTaskDimensions(soloTaskId)).toEqual({ cols: 101, rows: 33 });

        solo.send('task:destroy', { taskId: soloTaskId });
        solo.close();
    }, 60000);

    it('survives a task:focus with no taskId without killing the connection', async () => {
        await a.sendAndProveAlive('task:focus', {});
        expect(a.isClosed).toBe(false);
    });
});
