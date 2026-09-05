/**
 * Child → parent completion notifications.
 *
 * A task spawned via claudia_create_task records its parent, and when the
 * child settles (idle / waiting_input / exited) the parent gets a
 * [CLAUDIA TASK UPDATE] line injected — immediately if it is idle, queued and
 * delivered on its next idle otherwise. This is what frees an orchestrating
 * session from polling claudia_get_task_status in a loop.
 *
 * Grey-box: the queue/flush pair is exercised directly on a spawner with
 * synthetic task-map entries, with writeToTask spied. No PTY is spawned.
 *
 * Temp dirs live under homedir(), not os.tmpdir() — macOS /var is blocklisted
 * by validateWorkspacePath.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { TaskSpawner } from '../task-spawner.js';

interface Ctx { base: string; spawner?: TaskSpawner }
const active: Ctx[] = [];

/** Minimal shape both queueParentNotification and flushParentNotifications read.
 * lastActivity is backdated: the flush's quiet check refuses to deliver into a
 * terminal that produced output in the last 800ms (another injector may have
 * just typed a prompt), and a just-created Date would trip it in every test. */
function fakeTask(id: string, state: string, extra: object = {}) {
    return {
        id,
        state,
        prompt: `task ${id}`,
        workspaceId: join(homedir(), 'ws'),
        createdAt: new Date(),
        lastActivity: new Date(Date.now() - 10_000),
        initialPromptSent: true,
        pendingPrompt: null,
        hasStartedProcessing: true,
        outputHistory: [],
        ...extra,
    };
}

/** Spawner over an empty tasks file, with fake tasks injected into its map. */
function makeSpawner(tasks: ReturnType<typeof fakeTask>[]) {
    const base = mkdtempSync(join(homedir(), '.claudia-parentnotif-test-'));
    writeFileSync(join(base, 'tasks.json'), JSON.stringify({ tasks: [], archivedTasks: [] }));
    const s = new TaskSpawner(join(base, 'tasks.json'), false);
    active.push({ base, spawner: s });
    const map = (s as unknown as { tasks: Map<string, unknown> }).tasks;
    for (const t of tasks) map.set(t.id, t);
    return s;
}

type Internals = {
    queueParentNotification(child: unknown, state: string): void;
    flushParentNotifications(parentId: string): void;
    retractParentNotificationsFor(childId: string): void;
    pendingParentNotifications: Map<string, { childId: string; text: string }[]>;
    writeToTask(taskId: string, data: string, source?: string, internal?: boolean): void;
};

afterEach(() => {
    vi.useRealTimers();
    for (const ctx of active.splice(0)) {
        try { ctx.spawner?.destroy(); } catch { /* best effort */ }
        try { rmSync(ctx.base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
    }
});

describe('parent notifications', () => {
    it('delivers immediately when the parent is idle, referencing the child by short ref', () => {
        vi.useFakeTimers();
        const parent = fakeTask('task-parent', 'idle');
        const child = fakeTask('task-child', 'idle', { parentTaskId: 'task-parent', taskNumber: 49, displayName: 'voice-trim' });
        const s = makeSpawner([parent, child]) as unknown as Internals;
        const write = vi.spyOn(s, 'writeToTask').mockImplementation(() => {});

        s.queueParentNotification(child, 'idle');
        vi.advanceTimersByTime(400);

        expect(write).toHaveBeenCalledTimes(1);
        const [target, message, source, internal] = write.mock.calls[0];
        expect(target).toBe('task-parent');
        expect(message).toContain('#49');
        expect(message).toContain('voice-trim');
        expect(message).toContain('CLAUDIA TASK UPDATE');
        expect(source).toBe('internal-followup');
        expect(internal).toBe(true);
    });

    it('queues while the parent is busy and flushes when it goes idle', () => {
        vi.useFakeTimers();
        const parent = fakeTask('task-parent', 'busy');
        const child = fakeTask('task-child', 'idle', { parentTaskId: 'task-parent', taskNumber: 50 });
        const s = makeSpawner([parent, child]) as unknown as Internals;
        const write = vi.spyOn(s, 'writeToTask').mockImplementation(() => {});

        s.queueParentNotification(child, 'idle');
        vi.advanceTimersByTime(400);
        expect(write).not.toHaveBeenCalled();
        expect(s.pendingParentNotifications.get('task-parent')).toHaveLength(1);

        // Parent settles — the queue drains once.
        (parent as { state: string }).state = 'idle';
        s.flushParentNotifications('task-parent');
        vi.advanceTimersByTime(400);
        expect(write).toHaveBeenCalledTimes(1);
        expect(write.mock.calls[0][1]).toContain('#50');
        expect(s.pendingParentNotifications.has('task-parent')).toBe(false);
    });

    it('coalesces several settled children into one injection', () => {
        vi.useFakeTimers();
        const parent = fakeTask('task-parent', 'busy');
        const s = makeSpawner([parent]) as unknown as Internals;
        const write = vi.spyOn(s, 'writeToTask').mockImplementation(() => {});

        for (let i = 1; i <= 3; i++) {
            s.queueParentNotification(
                fakeTask(`task-c${i}`, 'idle', { parentTaskId: 'task-parent', taskNumber: i }),
                'idle'
            );
        }
        (parent as { state: string }).state = 'idle';
        s.flushParentNotifications('task-parent');
        vi.advanceTimersByTime(400);

        expect(write).toHaveBeenCalledTimes(1);
        const message = write.mock.calls[0][1];
        expect(message).toContain('#1');
        expect(message).toContain('#2');
        expect(message).toContain('#3');
    });

    it('a waiting_input child says so — the parent must answer, not just read output', () => {
        vi.useFakeTimers();
        const parent = fakeTask('task-parent', 'idle');
        const child = fakeTask('task-child', 'waiting_input', { parentTaskId: 'task-parent', taskNumber: 7 });
        const s = makeSpawner([parent, child]) as unknown as Internals;
        const write = vi.spyOn(s, 'writeToTask').mockImplementation(() => {});

        s.queueParentNotification(child, 'waiting_input');
        vi.advanceTimersByTime(400);

        expect(write.mock.calls[0][1]).toContain('WAITING FOR INPUT');
    });

    it('keeps notices queued for a parent that is not live (disconnected)', () => {
        vi.useFakeTimers();
        const child = fakeTask('task-child', 'idle', { parentTaskId: 'task-gone', taskNumber: 9 });
        const s = makeSpawner([child]) as unknown as Internals;
        const write = vi.spyOn(s, 'writeToTask').mockImplementation(() => {});

        s.queueParentNotification(child, 'idle');
        vi.advanceTimersByTime(400);

        expect(write).not.toHaveBeenCalled();
        expect(s.pendingParentNotifications.get('task-gone')).toHaveLength(1);
    });

    it('never notifies a task about itself (cyclic parent link)', () => {
        vi.useFakeTimers();
        const task = fakeTask('task-self', 'idle', { parentTaskId: 'task-self', taskNumber: 3 });
        const s = makeSpawner([task]) as unknown as Internals;
        const write = vi.spyOn(s, 'writeToTask').mockImplementation(() => {});

        s.queueParentNotification(task, 'idle');
        vi.advanceTimersByTime(400);

        expect(write).not.toHaveBeenCalled();
        expect(s.pendingParentNotifications.size).toBe(0);
    });

    it('re-checks the parent at fire time — a prompt submitted inside the 300ms window keeps the notices queued', () => {
        // The old flush deleted the queue up front and delivered blindly: the
        // injected text could be typed into a now-busy session, answer a
        // permission prompt, or trigger a full reconnect — and a failed
        // delivery lost the notices forever.
        vi.useFakeTimers();
        const parent = fakeTask('task-parent', 'idle');
        const child = fakeTask('task-child', 'idle', { parentTaskId: 'task-parent', taskNumber: 12 });
        const s = makeSpawner([parent, child]) as unknown as Internals;
        const write = vi.spyOn(s, 'writeToTask').mockImplementation(() => {});

        s.queueParentNotification(child, 'idle');
        // User submits a prompt before the delivery timer fires.
        (parent as { state: string }).state = 'busy';
        vi.advanceTimersByTime(400);

        expect(write).not.toHaveBeenCalled();
        expect(s.pendingParentNotifications.get('task-parent')).toHaveLength(1);

        // Next idle delivers it.
        (parent as { state: string }).state = 'idle';
        s.flushParentNotifications('task-parent');
        vi.advanceTimersByTime(400);
        expect(write).toHaveBeenCalledTimes(1);
    });

    it('retracts undelivered notices when the child comes back to life (sleep/wake)', () => {
        vi.useFakeTimers();
        const parent = fakeTask('task-parent', 'busy');
        const child = fakeTask('task-child', 'exited', { parentTaskId: 'task-parent', taskNumber: 13 });
        const s = makeSpawner([parent, child]) as unknown as Internals;
        const write = vi.spyOn(s, 'writeToTask').mockImplementation(() => {});

        s.queueParentNotification(child, 'exited');
        expect(s.pendingParentNotifications.get('task-parent')).toHaveLength(1);

        // reconnectAfterSleep resurrects the child via reconnectTask, which retracts.
        s.retractParentNotificationsFor('task-child');
        (parent as { state: string }).state = 'idle';
        s.flushParentNotifications('task-parent');
        vi.advanceTimersByTime(400);

        expect(write).not.toHaveBeenCalled();
        expect(s.pendingParentNotifications.has('task-parent')).toBe(false);
    });

    it('notifies once per run — settle-then-exit does not double-notify', () => {
        vi.useFakeTimers();
        const parent = fakeTask('task-parent', 'busy');
        const child = fakeTask('task-child', 'idle', { parentTaskId: 'task-parent', taskNumber: 14 });
        const s = makeSpawner([parent, child]) as unknown as Internals;
        vi.spyOn(s, 'writeToTask').mockImplementation(() => {});

        s.queueParentNotification(child, 'idle');
        // The same run's process dies later — must not add a second notice.
        s.queueParentNotification(child, 'exited');
        expect(s.pendingParentNotifications.get('task-parent')).toHaveLength(1);

        // A NEW run (busy transition clears the flag) may notify again.
        (child as { parentNotifiedThisRun?: boolean }).parentNotifiedThisRun = false;
        s.queueParentNotification(child, 'exited');
        const queue = s.pendingParentNotifications.get('task-parent')!;
        // Replaced, not appended: the parent cares about the latest state only.
        expect(queue).toHaveLength(1);
        expect(queue[0].text).toContain('has exited');
    });

    it('defers delivery while the terminal has fresh output, then retries once it quiets', () => {
        // Several injectors fire on the same idle transition (cron prompts,
        // context updates). Fresh output at fire time means someone else just
        // typed — the notice must wait, then land once the terminal is quiet.
        vi.useFakeTimers();
        const parent = fakeTask('task-parent', 'idle', { lastActivity: new Date() });
        const child = fakeTask('task-child', 'idle', { parentTaskId: 'task-parent', taskNumber: 21 });
        const s = makeSpawner([parent, child]) as unknown as Internals;
        const write = vi.spyOn(s, 'writeToTask').mockImplementation(() => {});

        s.queueParentNotification(child, 'idle');
        vi.advanceTimersByTime(400);
        expect(write).not.toHaveBeenCalled();
        expect(s.pendingParentNotifications.get('task-parent')).toHaveLength(1);

        // Quiet window elapses (fake clock advances with the timers) — the
        // bounded retry delivers.
        vi.advanceTimersByTime(1100);
        expect(write).toHaveBeenCalledTimes(1);
    });

    it('undelivered notices survive a backend restart', () => {
        // tsx-watch reloads are routine; a completion queued but not yet
        // delivered must not be eaten by one — the parent was promised it
        // does not need to poll.
        const parent = fakeTask('task-parent', 'busy');
        const child = fakeTask('task-child', 'idle', { parentTaskId: 'task-parent', taskNumber: 31 });
        const s = makeSpawner([parent, child]) as unknown as Internals & { saveTasks(): void };
        vi.spyOn(s, 'writeToTask').mockImplementation(() => {});

        s.queueParentNotification(child, 'idle');
        s.saveTasks();

        const ctx = active[active.length - 1];
        (s as unknown as TaskSpawner).destroy();
        const s2 = new TaskSpawner(join(ctx.base, 'tasks.json'), false) as unknown as Internals;
        active.push({ base: ctx.base, spawner: s2 as unknown as TaskSpawner });

        const queue = s2.pendingParentNotifications.get('task-parent');
        expect(queue).toHaveLength(1);
        expect(queue![0].childId).toBe('task-child');
        expect(queue![0].text).toContain('#31');
    });

    it('caps the queue for a long-busy parent at a bounded digest', () => {
        vi.useFakeTimers();
        const parent = fakeTask('task-parent', 'busy');
        const s = makeSpawner([parent]) as unknown as Internals;
        vi.spyOn(s, 'writeToTask').mockImplementation(() => {});

        for (let i = 1; i <= 15; i++) {
            s.queueParentNotification(
                fakeTask(`task-c${i}`, 'idle', { parentTaskId: 'task-parent', taskNumber: i }),
                'idle'
            );
        }
        expect(s.pendingParentNotifications.get('task-parent')!.length).toBeLessThanOrEqual(10);
    });
});
