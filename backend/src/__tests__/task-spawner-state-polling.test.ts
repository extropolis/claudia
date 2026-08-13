/**
 * State polling against a real PTY: idle vs busy vs waiting_input.
 *
 * task-state-detection.test.ts already covers the pure detectors on fixed
 * strings. What is untested — and where misclassification actually bites the
 * user — is the polling loop that turns a live stream of terminal bytes into a
 * task state: a task stuck on "busy" never shows as needing attention, and one
 * that flaps to "idle" mid-turn gets a queued follow-up delivered too early.
 *
 * The fake CLI drives each transition explicitly (EMIT_BUSY streams output for
 * several seconds; EMIT_PROMPT renders a choice dialog and then stays silent),
 * so these assert the real state machine rather than a hand-fed string.
 *
 * POSIX-only — see the fake-CLI note in task-spawner-sleep-wake.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { startHarness, waitFor, SUPPORTS_FAKE_CLI, type Harness } from './helpers/server-harness.js';

const SID = 'state000-1111-2222-3333-444455556666';

let workspace: string;
const harnesses: Harness[] = [];

async function boot(): Promise<Harness> {
    const h = await startHarness({
        prefix: '.claudia-statepoll-test-',
        fakeClaude: true,
        workspaces: [{ id: workspace, name: 'ws' }],
        env: { CLAUDIA_FAKE_SID: SID, STATE_POLLING_MS: '500' },
    });
    harnesses.push(h);
    return h;
}

beforeAll(() => {
    if (!SUPPORTS_FAKE_CLI) return;
    workspace = mkdtempSync(join(homedir(), '.claudia-statepoll-ws-'));
});

afterEach(async () => {
    for (const h of harnesses.splice(0)) {
        try { await h.stop(); } catch { /* best effort */ }
    }
});

afterAll(() => {
    if (!SUPPORTS_FAKE_CLI) return;
    try { rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* best effort */ }
}, 20000);

describe.skipIf(!SUPPORTS_FAKE_CLI)('state polling classifies a live task', () => {
    it('settles to idle once the CLI stops producing output', async () => {
        const h = await boot();
        const spawner = h.server.taskSpawner;

        const task = await spawner.createTask('IDLE_SETTLE_PROMPT', workspace);
        const state = await waitFor(() => spawner.getTaskState(task.id), s => s === 'idle', 30000);
        expect(state).toBe('idle');
    }, 60000);

    it('reports busy while output is streaming, then returns to idle', async () => {
        const h = await boot();
        const spawner = h.server.taskSpawner;

        const task = await spawner.createTask('BUSY_PROMPT', workspace);
        await waitFor(() => spawner.getTaskState(task.id), s => s === 'idle', 30000);

        spawner.writeToTask(task.id, 'EMIT_BUSY\r', 'test');

        // Sustained output must move it OFF idle...
        await waitFor(() => spawner.getTaskState(task.id), s => s === 'busy', 30000);
        // ...and it must not get stuck there once the stream stops.
        const after = await waitFor(() => spawner.getTaskState(task.id), s => s === 'idle', 40000);
        expect(after).toBe('idle');
    }, 120000);

    it('classifies a choice dialog as waiting_input, not idle or busy', async () => {
        const h = await boot();
        const spawner = h.server.taskSpawner;

        const task = await spawner.createTask('PROMPT_TASK', workspace);
        await waitFor(() => spawner.getTaskState(task.id), s => s === 'idle', 30000);

        spawner.writeToTask(task.id, 'EMIT_PROMPT\r', 'test');

        const state = await waitFor(() => spawner.getTaskState(task.id), s => s === 'waiting_input', 30000);
        expect(state).toBe('waiting_input');
    }, 90000);

    it('returns null for a task that does not exist', async () => {
        const h = await boot();
        expect(h.server.taskSpawner.getTaskState('task-does-not-exist')).toBeNull();
    }, 30000);

    it('stopTask reports "nothing to interrupt" for an idle task', async () => {
        const h = await boot();
        const spawner = h.server.taskSpawner;

        const task = await spawner.createTask('IDLE_STOP_PROMPT', workspace);
        await waitFor(() => spawner.getTaskState(task.id), s => s === 'idle', 30000);

        // stopTask interrupts an in-flight turn; it is NOT a kill, and an idle
        // task has nothing to interrupt.
        expect(spawner.stopTask(task.id)).toBe(false);
        expect(spawner.getTaskState(task.id)).toBe('idle');
    }, 60000);

    it('stopTask interrupts a busy task and it leaves the busy state', async () => {
        const h = await boot();
        const spawner = h.server.taskSpawner;

        const task = await spawner.createTask('BUSY_STOP_PROMPT', workspace);
        await waitFor(() => spawner.getTaskState(task.id), s => s === 'idle', 30000);

        spawner.writeToTask(task.id, 'EMIT_BUSY\r', 'test');
        await waitFor(() => spawner.getTaskState(task.id), s => s === 'busy', 30000);

        expect(spawner.stopTask(task.id)).toBe(true);
        const after = await waitFor(() => spawner.getTaskState(task.id), s => s !== 'busy', 40000);
        expect(after).not.toBe('busy');
    }, 120000);

    it('stopTask returns false for a task that does not exist at all', async () => {
        const h = await boot();
        expect(h.server.taskSpawner.stopTask('task-does-not-exist')).toBe(false);
    }, 30000);

    it('destroyTask kills the PTY and drops the task entirely', async () => {
        const h = await boot();
        const spawner = h.server.taskSpawner;

        const task = await spawner.createTask('DYING_PROMPT', workspace);
        await waitFor(() => spawner.getTaskState(task.id), s => s === 'idle', 30000);
        expect(existsSync(join(h.fakeDir, 'alive'))).toBe(true);

        spawner.destroyTask(task.id);

        await waitFor(() => existsSync(join(h.fakeDir, 'alive')), alive => !alive, 30000);
        expect(spawner.getTask(task.id)).toBeUndefined();
        expect(spawner.getTaskState(task.id)).toBeNull();
    }, 60000);
});
