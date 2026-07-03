import { describe, it, expect } from 'vitest';
import { compareTasksForDisplay, sortTasksForDisplay, type TaskSortable } from '../taskSort';
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
});
