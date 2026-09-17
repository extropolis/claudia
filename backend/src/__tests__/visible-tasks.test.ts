/**
 * Split-screen visible-task set.
 *
 * Before split screen, `setTaskActive(id, true)` was an EXCLUSIVE switch: it
 * flipped `isActive = false` on every other task, and the PTY data handler
 * drops output for any task with `isActive === false`. Showing four terminals
 * at once therefore left three of them permanently frozen — the single blocker
 * that made multi-pane viewing impossible.
 *
 * The set is now the source of truth and `isActive` is a mirror of membership.
 *
 * Regression targets:
 *  - selecting a task does NOT silence the others (the original bug)
 *  - the set is capped, evicting least-recently-shown first, so a mobile client
 *    that only ever sends task:select cannot grow it without bound
 *  - an authoritative setVisibleTasks() prunes panes closed while offline
 *  - isActive stays consistent with membership, including after cap eviction
 *
 * Temp dirs live under homedir(), not os.tmpdir() — macOS /var is blocklisted
 * by validateWorkspacePath.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { TaskSpawner, MAX_VISIBLE_TASKS } from '../task-spawner.js';

interface Ctx { base: string; spawner?: TaskSpawner }
const active: Ctx[] = [];

function start(): TaskSpawner {
    const base = mkdtempSync(join(homedir(), '.claudia-visible-test-'));
    const tasksFile = join(base, 'tasks.json');
    writeFileSync(tasksFile, JSON.stringify({ tasks: [], archivedTasks: [] }));
    const ctx: Ctx = { base };
    active.push(ctx);
    const s = new TaskSpawner(tasksFile, false);
    ctx.spawner = s;
    return s;
}

/**
 * Register a minimal in-memory task. `setVisibleTasks` only touches the set and
 * the isActive mirror, so a bare record is enough to observe both without
 * spawning a real PTY.
 */
function addTask(s: TaskSpawner, id: string): { id: string; isActive: boolean } {
    const task = {
        id,
        workspaceId: join(homedir(), 'ws'),
        prompt: id,
        state: 'idle',
        isActive: false,
        outputHistory: [] as string[],
        previousHistory: undefined,
        lastActivity: new Date(),
        createdAt: new Date(),
    };
    (s as unknown as { tasks: Map<string, unknown> }).tasks.set(id, task);
    return task as { id: string; isActive: boolean };
}

afterEach(() => {
    for (const ctx of active.splice(0)) {
        try { ctx.spawner?.destroy(); } catch { /* best effort */ }
        try { rmSync(ctx.base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
    }
});

describe('visible task set', () => {
    it('keeps every pane visible instead of silencing all but the last', () => {
        const s = start();
        const a = addTask(s, 'task-a');
        const b = addTask(s, 'task-b');
        const c = addTask(s, 'task-c');

        // Three panes mount; each TerminalView sends task:select as it appears.
        s.setTaskActive('task-a', true, 'c1');
        s.setTaskActive('task-b', true, 'c1');
        s.setTaskActive('task-c', true, 'c1');

        // The original bug: only task-c would survive here.
        expect(s.getVisibleTaskIds().sort()).toEqual(['task-a', 'task-b', 'task-c']);
        expect([a.isActive, b.isActive, c.isActive]).toEqual([true, true, true]);
    });

    it('deselecting one pane leaves the others streaming', () => {
        const s = start();
        const a = addTask(s, 'task-a');
        const b = addTask(s, 'task-b');
        s.setTaskActive('task-a', true, 'c1');
        s.setTaskActive('task-b', true, 'c1');

        s.setTaskActive('task-a', false, 'c1');

        expect(s.getVisibleTaskIds()).toEqual(['task-b']);
        expect(a.isActive).toBe(false);
        expect(b.isActive).toBe(true);
    });

    it('setVisibleTasks prunes ids that are no longer mounted', () => {
        const s = start();
        addTask(s, 'task-a');
        const b = addTask(s, 'task-b');
        s.setVisibleTasks('c1', ['task-a', 'task-b']);

        // Client reconnects reporting only one surviving pane.
        s.setVisibleTasks('c1', ['task-b']);

        expect(s.getVisibleTaskIds()).toEqual(['task-b']);
        expect(b.isActive).toBe(true);
    });

    it('dedupes and ignores non-string / empty ids', () => {
        const s = start();
        const ids = ['task-a', 'task-a', '', null, undefined, 42, 'task-b'] as unknown as string[];
        expect(s.setVisibleTasks('c1', ids)).toEqual(['task-a', 'task-b']);
    });

    it('an unchanged set does not reshuffle LRU order', () => {
        const s = start();
        s.setVisibleTasks('c1', ['task-a', 'task-b', 'task-c']);
        // Re-sent verbatim on an unrelated layout change (divider drag, re-render).
        s.setVisibleTasks('c1', ['task-c', 'task-a', 'task-b']);
        expect(s.getVisibleTaskIds()).toEqual(['task-a', 'task-b', 'task-c']);
    });

    it('caps the set, evicting the least-recently-shown task first', () => {
        const s = start();
        const tasks = Array.from({ length: MAX_VISIBLE_TASKS + 2 }, (_, i) => {
            const id = `task-${i}`;
            addTask(s, id);
            s.setTaskActive(id, true, 'c1');
            return id;
        });

        const visible = s.getVisibleTaskIds();
        expect(visible).toHaveLength(MAX_VISIBLE_TASKS);
        // The two oldest are gone; the newest survive.
        expect(visible).not.toContain(tasks[0]);
        expect(visible).not.toContain(tasks[1]);
        expect(visible).toContain(tasks[tasks.length - 1]);
    });

    it('re-selecting a visible task refreshes its LRU position', () => {
        const s = start();
        s.setVisibleTasks('c1', ['task-a', 'task-b']);
        s.setTaskActive('task-a', true, 'c1'); // touch the older entry
        s.setTaskActive('task-c', true, 'c1');

        // task-b is now the oldest, so it is the one that ages out first.
        expect(s.getVisibleTaskIds()).toEqual(['task-b', 'task-a', 'task-c']);
    });

    it('never flags a task active once the cap has evicted it', () => {
        const s = start();
        const all = Array.from({ length: MAX_VISIBLE_TASKS + 1 }, (_, i) => {
            const id = `task-${i}`;
            return { id, task: addTask(s, id) };
        });
        for (const { id } of all) s.setTaskActive(id, true, 'c1');

        const evicted = all[0];
        expect(s.getVisibleTaskIds()).not.toContain(evicted.id);
        // The isActive mirror must agree, or the PTY handler would stream output
        // for a task the client is no longer showing.
        expect(evicted.task.isActive).toBe(false);
    });
});

/**
 * A SERVER-SIDE disconnect (memory-budget shedding, the idle reaper) is not the
 * user closing a pane: the pane is still mounted and the client's declaration is
 * still correct.
 *
 * THE BUG this guards: disconnectTask used to strip the id from every client's
 * declaration. Nothing on the client changed, so nothing ever re-declared it -
 * and reconnectTask re-entered the task with `isActive: false` without consulting
 * the set, so the next syncIsActiveFlag() left it false forever. The user would
 * be typing into a pane whose PTY output was being dropped, with no error
 * anywhere. The WebSocket never drops on these paths, so nothing self-heals.
 */
describe('server-side disconnect keeps the pane declared', () => {
    it('does not erase a client declaration when the server sheds the PTY', () => {
        const s = start();
        addTask(s, 'task-a');
        s.setVisibleTasks('desktop', ['task-a']);

        // Simulate the shed: the task leaves `tasks`, the client is never told.
        (s as unknown as { tasks: Map<string, unknown> }).tasks.delete('task-a');
        (s as unknown as { recomputeVisible: () => void }).recomputeVisible();

        expect(s.getVisibleTaskIds()).toContain('task-a');
    });

    it('a reconnected task streams again without the client re-declaring', () => {
        const s = start();
        addTask(s, 'task-a');
        s.setVisibleTasks('desktop', ['task-a']);
        (s as unknown as { tasks: Map<string, unknown> }).tasks.delete('task-a');

        // Reconnect re-enters the task with isActive:false, as reconnectTask does.
        const revived = addTask(s, 'task-a');
        expect(revived.isActive).toBe(false);

        // Any recompute must re-derive it from the surviving declaration.
        (s as unknown as { recomputeVisible: () => void }).recomputeVisible();
        expect(revived.isActive).toBe(true);
    });
});

/**
 * The ack tells a client what IT is showing. Echoing the union back would report
 * other clients' tasks as this client's own, and would hide the one thing the ack
 * is useful for: spotting that the cap dropped a pane you asked for.
 */
describe('setVisibleTasks ack', () => {
    it('returns only the requesting client set, not the union', () => {
        const s = start();
        s.setVisibleTasks('desktop', ['task-d1', 'task-d2']);
        const ack = s.setVisibleTasks('phone', ['task-m1']);

        expect(ack).toEqual(['task-m1']);
        expect(s.getVisibleTaskIds()).toEqual(['task-d1', 'task-d2', 'task-m1']);
    });

    it('reports the truncated set when a client asks for more than the cap', () => {
        const s = start();
        const many = Array.from({ length: MAX_VISIBLE_TASKS + 3 }, (_, i) => `task-${i}`);
        const ack = s.setVisibleTasks('greedy', many);

        expect(ack).toHaveLength(MAX_VISIBLE_TASKS);
        // Diffing the request against the ack is how a client detects the drop.
        expect(many.filter(id => !ack.includes(id))).toHaveLength(3);
    });
});

/**
 * Deselect is scoped to the caller. Cross-client removal would let one client
 * collapsing a pane silence every other client's pane on the same task.
 */
describe('deselect is per client', () => {
    it('one client dropping a task leaves another client still showing it', () => {
        const s = start();
        const shared = addTask(s, 'task-shared');
        s.setVisibleTasks('desktop', ['task-shared']);
        s.setVisibleTasks('phone', ['task-shared']);

        s.setTaskActive('task-shared', false, 'phone');

        expect(s.getVisibleTaskIds()).toEqual(['task-shared']);
        expect(shared.isActive).toBe(true);
    });
});

/**
 * The visible set spans MULTIPLE CONNECTED CLIENTS, and they disagree about
 * what is on screen: a desktop with 6 split panes and a phone showing 1 task
 * are both right about themselves.
 *
 * THE BUG this guards: with one shared global set, `setVisible` is
 * authoritative and last-writer-wins. A phone connecting and declaring its
 * single task would prune all 6 desktop panes out of the set, freezing every
 * terminal on the big monitor. The effective set must be the UNION of each
 * client's declaration, and a client's share must be released when it
 * disconnects (or a closed tab would pin its tasks forever).
 */
describe('visible set across multiple clients', () => {
    it("a phone declaring one task does not silence a desktop’s panes", () => {
        const s = start();
        const desktopTasks = ['task-d1', 'task-d2', 'task-d3'];
        for (const id of desktopTasks) addTask(s, id);
        addTask(s, 'task-m1');

        s.setVisibleTasks('desktop', desktopTasks);
        s.setVisibleTasks('phone', ['task-m1']);

        const visible = s.getVisibleTaskIds();
        for (const id of desktopTasks) expect(visible).toContain(id);
        expect(visible).toContain('task-m1');
    });

    it('one client updating its set leaves the other client alone', () => {
        const s = start();
        s.setVisibleTasks('desktop', ['task-d1', 'task-d2']);
        s.setVisibleTasks('phone', ['task-m1']);

        // The phone switches tasks; the desktop must be untouched.
        s.setVisibleTasks('phone', ['task-m2']);

        const visible = s.getVisibleTaskIds();
        expect(visible).toContain('task-d1');
        expect(visible).toContain('task-d2');
        expect(visible).toContain('task-m2');
        expect(visible).not.toContain('task-m1');
    });

    it("releases a client’s tasks when it disconnects", () => {
        const s = start();
        s.setVisibleTasks('desktop', ['task-d1']);
        s.setVisibleTasks('phone', ['task-m1']);

        s.releaseClient('phone');

        expect(s.getVisibleTaskIds()).toEqual(['task-d1']);
    });

    it('keeps a task visible while ANY client still shows it', () => {
        const s = start();
        s.setVisibleTasks('desktop', ['task-shared']);
        s.setVisibleTasks('phone', ['task-shared']);

        // Only one of the two stops showing it.
        s.setVisibleTasks('phone', []);

        expect(s.getVisibleTaskIds()).toEqual(['task-shared']);
    });

    it('releasing an unknown client is a no-op', () => {
        const s = start();
        s.setVisibleTasks('desktop', ['task-d1']);
        s.releaseClient('never-connected');
        expect(s.getVisibleTaskIds()).toEqual(['task-d1']);
    });
});

/**
 * The visible set is shared by desktop split-screen AND the mobile page, but
 * they want opposite things from it. Desktop wants N panes streaming at once;
 * mobile shows exactly one task in an accordion.
 *
 * Because `task:select` now ADDS to the set instead of replacing it, a mobile
 * user tapping through tasks would silently accumulate streams — up to the cap
 * — and a phone on a tunnel would keep paying for PTY output it cannot show.
 * The fix is that the mobile page follows every select with an authoritative
 * `task:setVisible` naming just that one task.
 */
describe('mobile page keeps the visible set to one task', () => {
    it('sends task:setVisible alongside every task:select', async () => {
        const { getMobilePageHtml } = await import('../mobile-page.js');
        const html = getMobilePageHtml('ws://localhost:4001', 'tok');

        const selects = html.match(/type: 'task:select'/g) ?? [];
        const setVisible = html.match(/type: 'task:setVisible'/g) ?? [];

        expect(selects.length).toBeGreaterThan(0);
        // One setVisible per select, plus the collapse case (nothing on screen).
        expect(setVisible.length).toBe(selects.length + 1);
    });

    it('clears the set when the accordion collapses', async () => {
        const { getMobilePageHtml } = await import('../mobile-page.js');
        const html = getMobilePageHtml('ws://localhost:4001', 'tok');
        expect(html).toContain("payload: { taskIds: [] }");
    });
});
