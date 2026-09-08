import { describe, it, expect } from 'vitest';
import { compareTasksForDisplay, sortTasksForDisplay, createTopLevelResolver, newestSortable, type TaskSortable } from '../taskSort';
import type { Task } from '@claudia/shared';

const mk = (id: string, created: number, activity: number, order?: number): Task => ({
    id, prompt: id, state: 'idle', workspaceId: '/ws',
    createdAt: new Date(created), lastActivity: new Date(activity),
    ...(order !== undefined ? { order } : {}),
});

describe('compareTasksForDisplay', () => {
    it('orders by explicit order first (ascending)', () => {
        const a = mk('a', 1000, 1000, 2);
        const b = mk('b', 2000, 2000, 0);
        const c = mk('c', 3000, 3000, 1);
        expect(sortTasksForDisplay([a, b, c], 'date-created').map(t => t.id)).toEqual(['b', 'c', 'a']);
        // taskSortBy is irrelevant once order is present.
        expect(sortTasksForDisplay([a, b, c], 'last-modified').map(t => t.id)).toEqual(['b', 'c', 'a']);
    });

    it('tasks with order sort before tasks without', () => {
        const withOrder = mk('x', 1000, 1000, 5);
        const noOrder = mk('y', 9999, 9999);
        expect(compareTasksForDisplay(withOrder, noOrder, 'date-created')).toBeLessThan(0);
        expect(compareTasksForDisplay(noOrder, withOrder, 'date-created')).toBeGreaterThan(0);
    });

    it('date-created: newest createdAt first when no order', () => {
        const older = mk('old', 1000, 5000);
        const newer = mk('new', 3000, 1000);
        expect(sortTasksForDisplay([older, newer], 'date-created').map(t => t.id)).toEqual(['new', 'old']);
    });

    it('last-modified: newest lastActivity first when no order', () => {
        // Reversed relative to createdAt to prove the tie-break actually switches.
        const olderCreatedRecentActivity = mk('a', 1000, 9000);
        const newerCreatedStaleActivity = mk('b', 3000, 1000);
        expect(sortTasksForDisplay([newerCreatedStaleActivity, olderCreatedRecentActivity], 'last-modified').map(t => t.id))
            .toEqual(['a', 'b']);
    });

    it('works on minimal sortable shapes (e.g. worktree-group representatives)', () => {
        const group: TaskSortable = { createdAt: new Date(5000), lastActivity: new Date(5000) };
        const task: TaskSortable = { createdAt: new Date(1000), lastActivity: new Date(9000) };
        // date-created: group (newer createdAt) first.
        expect(compareTasksForDisplay(group, task, 'date-created')).toBeLessThan(0);
        // last-modified: task (newer activity) first.
        expect(compareTasksForDisplay(group, task, 'last-modified')).toBeGreaterThan(0);
    });

    it('accepts ISO strings as well as Date objects (WS payloads are JSON-parsed)', () => {
        const a: TaskSortable = { createdAt: '2026-01-01T00:00:00.000Z', lastActivity: '2026-01-03T00:00:00.000Z' };
        const b: TaskSortable = { createdAt: new Date('2026-01-02T00:00:00.000Z'), lastActivity: new Date('2026-01-01T00:00:00.000Z') };
        expect(compareTasksForDisplay(a, b, 'date-created')).toBeGreaterThan(0); // b created later
        expect(compareTasksForDisplay(a, b, 'last-modified')).toBeLessThan(0);   // a active later
    });

    it('falls back to createdAt when lastActivity is missing', () => {
        const noActivity: TaskSortable = { createdAt: new Date(9000) };
        const withActivity: TaskSortable = { createdAt: new Date(1000), lastActivity: new Date(5000) };
        expect(compareTasksForDisplay(noActivity, withActivity, 'last-modified')).toBeLessThan(0);
    });

    it('is stable for equal timestamps (input order preserved)', () => {
        const a = mk('a', 1000, 1000);
        const b = mk('b', 1000, 1000);
        const c = mk('c', 1000, 1000);
        expect(sortTasksForDisplay([b, a, c], 'date-created').map(t => t.id)).toEqual(['b', 'a', 'c']);
        expect(sortTasksForDisplay([c, b, a], 'last-modified').map(t => t.id)).toEqual(['c', 'b', 'a']);
    });
});

describe('createTopLevelResolver', () => {
    const node = (id: string, parentTaskId?: string) => ({ id, ...(parentTaskId ? { parentTaskId } : {}) });

    it('nests a child under a top-level parent, one level only', () => {
        const p = node('p'), child = node('c', 'p'), grandchild = node('g', 'c');
        const isTop = createTopLevelResolver([p, child, grandchild]);
        expect(isTop(p)).toBe(true);
        expect(isTop(child)).toBe(false);
        // Grandchild's parent is itself a subtask → renders flat.
        expect(isTop(grandchild)).toBe(true);
    });

    it('treats a task whose parent is outside this workspace as top-level', () => {
        const orphan = node('o', 'not-here');
        expect(createTopLevelResolver([orphan])(orphan)).toBe(true);
    });

    // The invariant that keeps every task on screen: the sidebar only reads
    // subtaskMap for TOP-LEVEL rows, so a task may resolve to "nested" only if
    // its own parent resolved to "top-level". Otherwise it is filed under a row
    // that is never drawn and disappears from the UI entirely.
    const expectEveryTaskReachable = (nodes: { id: string; parentTaskId?: string }[]) => {
        const isTop = createTopLevelResolver(nodes);
        const byId = new Map(nodes.map(n => [n.id, n]));
        for (const n of nodes) {
            if (isTop(n)) continue;
            const parent = byId.get(n.parentTaskId!);
            expect(parent, `${n.id} is nested but its parent is missing`).toBeDefined();
            expect(isTop(parent!), `${n.id} nests under ${parent!.id}, which is itself nested → ${n.id} never renders`).toBe(true);
        }
    };

    it('terminates on cyclic parent chains and keeps every task reachable', () => {
        expectEveryTaskReachable([node('a', 'b'), node('b', 'a')]);
    });

    it('keeps every task reachable through a 3-cycle', () => {
        // Regression: the guard used to cache a provisional `true` for the entry
        // node and then overwrite it with `false` on unwind, so a child that had
        // already committed to nesting under it was filed under a row that never
        // rendered — the task vanished from the sidebar.
        expectEveryTaskReachable([node('a', 'b'), node('b', 'c'), node('c', 'a')]);
    });

    it('keeps a self-parented task on screen', () => {
        const a = node('a', 'a');
        expect(createTopLevelResolver([a])(a)).toBe(true);
        expectEveryTaskReachable([a, node('b')]);
    });

    it('keeps every task reachable when a cycle has a tail hanging off it', () => {
        // tail -> a -> b -> c -> a
        expectEveryTaskReachable([
            node('tail', 'a'), node('a', 'b'), node('b', 'c'), node('c', 'a'), node('loose'),
        ]);
    });

    it('holds the invariant whichever cycle member is resolved first', () => {
        // The panel walks `tasks` in array order, so the entry point into the
        // cycle varies with the store's insertion order. Every rotation must
        // still leave at least one member top-level and the rest reachable.
        const ring = [node('a', 'b'), node('b', 'c'), node('c', 'a')];
        for (let i = 0; i < ring.length; i++) {
            const rotated = [...ring.slice(i), ...ring.slice(0, i)];
            expectEveryTaskReachable(rotated);
            const isTop = createTopLevelResolver(rotated);
            expect(rotated.some(n => isTop(n)), 'a cycle with no top-level member renders nothing').toBe(true);
        }
    });
});

describe('newestSortable', () => {
    it('represents a set by its newest createdAt and newest lastActivity independently', () => {
        const rep = newestSortable([
            { createdAt: new Date(1000), lastActivity: new Date(9000) },
            { createdAt: new Date(5000), lastActivity: new Date(2000) },
            { createdAt: '1970-01-01T00:00:03.000Z' }, // no lastActivity → falls back to createdAt
        ]);
        expect(new Date(rep.createdAt).getTime()).toBe(5000);
        expect(new Date(rep.lastActivity!).getTime()).toBe(9000);
    });

    it('never yields an Invalid Date for an empty set (would make the comparator NaN)', () => {
        const rep = newestSortable([]);
        expect(new Date(rep.createdAt).getTime()).toBe(0);
        expect(new Date(rep.lastActivity!).getTime()).toBe(0);
        // A comparator using it stays numeric, so sort remains consistent.
        const task: TaskSortable = { createdAt: new Date(1000), lastActivity: new Date(1000) };
        expect(Number.isNaN(compareTasksForDisplay(rep, task, 'date-created'))).toBe(false);
        expect(compareTasksForDisplay(rep, task, 'date-created')).toBeGreaterThan(0); // empty group sinks
    });

    it('keeps the sort transitive when an empty group is interleaved', () => {
        const a = mk('a', 1000, 1000), b = mk('b', 2000, 2000), c = mk('c', 3000, 3000);
        const G = { id: 'G', ...newestSortable([]) };
        const sorted = [a, G, b, c].sort((x, y) => compareTasksForDisplay(x, y, 'date-created'));
        expect(sorted.map(t => t.id)).toEqual(['c', 'b', 'a', 'G']);
    });
});
