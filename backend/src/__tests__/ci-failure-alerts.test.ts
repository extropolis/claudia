/**
 * CI failure alerts.
 *
 * When the PR belonging to a task goes red, the task is told to fix it without
 * the user having to notice the badge and ask. The notice rides the same queue
 * as child-completion notices, so it only ever lands on a live, idle session.
 *
 * Grey-box: notePrCiState is driven directly on a spawner with synthetic
 * task-map entries and writeToTask spied. No PTY, no `gh`, no network.
 *
 * Temp dirs live under homedir(), not os.tmpdir() — macOS /var is blocklisted
 * by validateWorkspacePath.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { TaskSpawner, chooseParentLink } from '../task-spawner.js';
import type { WorkspacePrInfo } from '@claudia/shared';

interface Ctx { base: string; spawner?: TaskSpawner }
const active: Ctx[] = [];

/** lastActivity is backdated past the flush's 800ms quiet check. */
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

function makeSpawner(tasks: ReturnType<typeof fakeTask>[]) {
    const base = mkdtempSync(join(homedir(), '.claudia-cialert-test-'));
    writeFileSync(join(base, 'tasks.json'), JSON.stringify({ tasks: [], archivedTasks: [] }));
    const s = new TaskSpawner(join(base, 'tasks.json'), false);
    active.push({ base, spawner: s });
    const map = (s as unknown as { tasks: Map<string, unknown> }).tasks;
    for (const t of tasks) map.set(t.id, t);
    return s;
}

function pr(overrides: Partial<WorkspacePrInfo> = {}): WorkspacePrInfo {
    return {
        number: 42,
        title: 'Add the thing',
        state: 'open',
        url: 'https://github.com/acme/repo/pull/42',
        ci: 'failed',
        ...overrides,
    } as WorkspacePrInfo;
}

type Internals = {
    notePrCiState(taskId: string, branch: string | undefined, prInfo?: WorkspacePrInfo | null): boolean;
    setWorkStatus(taskId: string, status: unknown): boolean;
    resolveTaskRef(ref: string): string | null;
    pendingParentNotifications: Map<string, { childId: string; text: string }[]>;
    writeToTask(taskId: string, data: string, source?: string, internal?: boolean): void;
};

const workStatus = (over: Record<string, unknown> = {}) => ({
    branch: 'claudia/task-abc',
    dirtyFiles: 0,
    outstandingCommits: 2,
    landedCommits: 0,
    baseRef: 'origin/main',
    checkedAt: new Date().toISOString(),
    ...over,
});

afterEach(() => {
    vi.useRealTimers();
    for (const ctx of active.splice(0)) {
        try { ctx.spawner?.destroy(); } catch { /* best effort */ }
        try { rmSync(ctx.base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
    }
});

describe('CI failure alerts', () => {
    it('tells an idle task to fix its red PR, naming the PR and the branch', () => {
        vi.useFakeTimers();
        const task = fakeTask('task-a', 'idle');
        const s = makeSpawner([task]) as unknown as Internals;
        const write = vi.spyOn(s, 'writeToTask').mockImplementation(() => {});

        s.notePrCiState('task-a', 'claudia/task-abc', pr());
        vi.advanceTimersByTime(400);

        expect(write).toHaveBeenCalledTimes(1);
        const [target, message, source, internal] = write.mock.calls[0];
        expect(target).toBe('task-a');
        expect(message).toContain('CLAUDIA CI ALERT');
        expect(message).toContain('#42');
        expect(message).toContain('claudia/task-abc');
        expect(message).toContain('https://github.com/acme/repo/pull/42');
        expect(source).toBe('internal-followup');
        expect(internal).toBe(true);
    });

    it('alerts once per failing run, however often the poller reports it red', () => {
        vi.useFakeTimers();
        const s = makeSpawner([fakeTask('task-a', 'idle')]) as unknown as Internals;
        const write = vi.spyOn(s, 'writeToTask').mockImplementation(() => {});

        for (let i = 0; i < 4; i++) {
            s.notePrCiState('task-a', 'feature', pr());
            vi.advanceTimersByTime(400);
        }

        expect(write).toHaveBeenCalledTimes(1);
    });

    it('re-arms once a new run starts, so the failure after a fix is new news', () => {
        vi.useFakeTimers();
        const s = makeSpawner([fakeTask('task-a', 'idle')]) as unknown as Internals;
        const write = vi.spyOn(s, 'writeToTask').mockImplementation(() => {});

        s.notePrCiState('task-a', 'feature', pr());               // red
        vi.advanceTimersByTime(400);
        s.notePrCiState('task-a', 'feature', pr({ ci: 'running' })); // pushed a fix
        vi.advanceTimersByTime(400);
        s.notePrCiState('task-a', 'feature', pr());               // red again
        vi.advanceTimersByTime(400);

        expect(write).toHaveBeenCalledTimes(2);
    });

    it('stays quiet for green, still-running, missing and terminal PRs', () => {
        vi.useFakeTimers();
        const s = makeSpawner([fakeTask('task-a', 'idle')]) as unknown as Internals;
        const write = vi.spyOn(s, 'writeToTask').mockImplementation(() => {});

        s.notePrCiState('task-a', 'feature', pr({ ci: 'passed' }));
        s.notePrCiState('task-a', 'feature', pr({ ci: 'running' }));
        s.notePrCiState('task-a', 'feature', pr({ ci: 'none' }));
        s.notePrCiState('task-a', 'feature', null);
        s.notePrCiState('task-a', 'feature', pr({ state: 'merged' }));
        s.notePrCiState('task-a', 'feature', pr({ state: 'closed' }));
        vi.advanceTimersByTime(400);

        expect(write).not.toHaveBeenCalled();
    });

    it('a merged PR re-arms the alert rather than swallowing the next failure', () => {
        vi.useFakeTimers();
        const s = makeSpawner([fakeTask('task-a', 'idle')]) as unknown as Internals;
        const write = vi.spyOn(s, 'writeToTask').mockImplementation(() => {});

        s.notePrCiState('task-a', 'feature', pr());
        vi.advanceTimersByTime(400);
        s.notePrCiState('task-a', 'feature', pr({ state: 'merged', ci: 'failed' }));
        s.notePrCiState('task-a', 'feature', pr());
        vi.advanceTimersByTime(400);

        expect(write).toHaveBeenCalledTimes(2);
    });

    it('treats a failed PR lookup as unknown, not as "the PR went away"', () => {
        vi.useFakeTimers();
        const s = makeSpawner([fakeTask('task-a', 'idle')]) as unknown as Internals;
        const write = vi.spyOn(s, 'writeToTask').mockImplementation(() => {});

        s.notePrCiState('task-a', 'feature', pr());   // red
        vi.advanceTimersByTime(400);
        s.notePrCiState('task-a', 'feature', null);   // gh rate-limited / offline
        s.notePrCiState('task-a', 'feature', pr());   // same red run, still failing
        vi.advanceTimersByTime(400);

        expect(write).toHaveBeenCalledTimes(1);
    });

    it('queues for a busy task instead of typing into a running session', () => {
        vi.useFakeTimers();
        const task = fakeTask('task-a', 'busy');
        const s = makeSpawner([task]) as unknown as Internals;
        const write = vi.spyOn(s, 'writeToTask').mockImplementation(() => {});

        s.notePrCiState('task-a', 'feature', pr());
        vi.advanceTimersByTime(400);
        expect(write).not.toHaveBeenCalled();
        expect(s.pendingParentNotifications.get('task-a')).toHaveLength(1);
    });

    it('collapses repeated alerts for a task that never goes idle into one notice', () => {
        vi.useFakeTimers();
        const task = fakeTask('task-a', 'busy');
        const s = makeSpawner([task]) as unknown as Internals;
        vi.spyOn(s, 'writeToTask').mockImplementation(() => {});

        // Red, a new run, then red again — all while the task stays busy.
        s.notePrCiState('task-a', 'feature', pr());
        s.notePrCiState('task-a', 'feature', pr({ ci: 'running' }));
        s.notePrCiState('task-a', 'feature', pr());
        vi.advanceTimersByTime(400);

        expect(s.pendingParentNotifications.get('task-a')).toHaveLength(1);
    });

    it('ignores tasks that are no longer live, and says so to the caller', () => {
        vi.useFakeTimers();
        const s = makeSpawner([]) as unknown as Internals;
        const write = vi.spyOn(s, 'writeToTask').mockImplementation(() => {});

        // false lets the caller move on to the next candidate rather than
        // dropping the alert on a task that can never receive it.
        expect(s.notePrCiState('task-gone', 'feature', pr())).toBe(false);
        vi.advanceTimersByTime(400);

        expect(write).not.toHaveBeenCalled();
        expect(s.pendingParentNotifications.has('task-gone')).toBe(false);
    });

    it('reports handled for a live task in every branch of the decision', () => {
        vi.useFakeTimers();
        const s = makeSpawner([fakeTask('task-a', 'idle')]) as unknown as Internals;
        vi.spyOn(s, 'writeToTask').mockImplementation(() => {});

        expect(s.notePrCiState('task-a', 'feature', pr())).toBe(true);                        // queued
        expect(s.notePrCiState('task-a', 'feature', pr())).toBe(true);                        // deduped
        expect(s.notePrCiState('task-a', 'feature', pr({ ci: 'passed' }))).toBe(true);        // re-armed
        expect(s.notePrCiState('task-a', 'feature', pr({ state: 'merged' }))).toBe(true);     // terminal
        expect(s.notePrCiState('task-a', 'feature', null)).toBe(true);                        // unknown
    });

    it('drops persisted CI alerts on restart instead of injecting a stale one', () => {
        // The queue is persisted but the once-per-run dedupe is in memory, so a
        // CI alert restored days later could land long after the run was fixed.
        // Child-completion notices are facts and must still survive.
        const base = mkdtempSync(join(homedir(), '.claudia-cialert-restore-'));
        writeFileSync(join(base, 'tasks.json'), JSON.stringify({
            tasks: [], archivedTasks: [],
            pendingParentNotifications: {
                'task-a': [
                    { childId: 'ci-pr-42', text: '[CLAUDIA CI ALERT: stale]' },
                    { childId: 'task-child', text: '[CLAUDIA TASK UPDATE: real]' },
                ],
                'task-b': [{ childId: 'ci-pr-7', text: '[CLAUDIA CI ALERT: stale]' }],
            },
        }));
        const s = new TaskSpawner(join(base, 'tasks.json'), false);
        active.push({ base, spawner: s });
        const queues = (s as unknown as Internals).pendingParentNotifications;

        expect(queues.get('task-a')?.map(n => n.childId)).toEqual(['task-child']);
        expect(queues.has('task-b')).toBe(false);
    });
});

describe('work status change detection', () => {
    it('does not report a change when only the check timestamp moved', () => {
        const s = makeSpawner([fakeTask('task-a', 'idle')]) as unknown as Internals;

        expect(s.setWorkStatus('task-a', workStatus({ checkedAt: '2026-01-01T00:00:00.000Z' }))).toBe(true);
        // Same verdict, fresh stamp: every poll re-stamps checkedAt, and a plain
        // deep-equal here meant a broadcast per worktree task every 45s.
        expect(s.setWorkStatus('task-a', workStatus({ checkedAt: '2026-01-01T00:00:45.000Z' }))).toBe(false);
        expect(s.setWorkStatus('task-a', workStatus({ checkedAt: '2026-01-01T00:01:30.000Z' }))).toBe(false);
    });

    it('reports a change when the verdict actually moves', () => {
        const s = makeSpawner([fakeTask('task-a', 'idle')]) as unknown as Internals;
        s.setWorkStatus('task-a', workStatus());

        expect(s.setWorkStatus('task-a', workStatus({ dirtyFiles: 1 }))).toBe(true);
        expect(s.setWorkStatus('task-a', workStatus({ dirtyFiles: 1, outstandingCommits: 0, landedCommits: 2 }))).toBe(true);
        expect(s.setWorkStatus('task-a', null)).toBe(true);
        expect(s.setWorkStatus('task-a', null)).toBe(false);
    });
});

describe('chooseParentLink', () => {
    const known = (ref: string) => (ref === '#48' || ref === 'task-known' ? 'task-known' : null);

    it('uses the canonical id a short ref resolves to', () => {
        expect(chooseParentLink('#48', known)).toEqual({ parentTaskId: 'task-known', resolved: true });
    });

    it('keeps an unknown but canonical-looking id, so an archived parent can come back', () => {
        expect(chooseParentLink('task-1787094145880-7c70daa5cc', known))
            .toEqual({ parentTaskId: 'task-1787094145880-7c70daa5cc', resolved: false });
    });

    it('drops a ref that can never become valid rather than faking a link', () => {
        // Storing these verbatim reported success while the child rendered flat.
        for (const ref of ['#9999', '9999', 'not-a-task', '', '   ']) {
            expect(chooseParentLink(ref, known), ref).toEqual({ parentTaskId: null, resolved: false });
        }
    });

    it('trims before deciding', () => {
        expect(chooseParentLink('  task-known  ', known)).toEqual({ parentTaskId: 'task-known', resolved: true });
    });
});
