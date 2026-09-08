import type { Task } from '@claudia/shared';

export type TaskSortBy = 'date-created' | 'last-modified';

/** Minimal shape needed to order an item within a workspace's task list. */
export interface TaskSortable {
    order?: number;
    createdAt: Date | string;
    lastActivity?: Date | string;
}

/**
 * Canonical comparator for ordering tasks within a workspace's list.
 *
 * IMPORTANT: this MUST be the single source of truth for task ordering.
 * Manual drag-and-drop reorder derives a task's index from this ordering and
 * then splices at that index. If any consumer (the display sort, the
 * render-item interleave that mixes tasks with worktree groups, or the store's
 * `reorderTasks` action) uses a different tie-break, the dragged index maps to
 * a different task than the one the user sees, and reorder silently misbehaves
 * (moves the wrong task / drops it in the wrong place). Historically the
 * display sort respected `taskSortBy` while the render interleave and the store
 * hardcoded `createdAt`, which broke reorder in "Recent" (last-modified) mode.
 */
export function compareTasksForDisplay(
    a: TaskSortable,
    b: TaskSortable,
    taskSortBy: TaskSortBy,
): number {
    // Explicit manual order always wins (lower = higher in the list).
    if (a.order !== undefined && b.order !== undefined) return a.order - b.order;
    if (a.order !== undefined) return -1;
    if (b.order !== undefined) return 1;

    if (taskSortBy === 'last-modified') {
        const ta = new Date(a.lastActivity ?? a.createdAt).getTime();
        const tb = new Date(b.lastActivity ?? b.createdAt).getTime();
        return tb - ta;
    }
    // date-created (default): newest first.
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

/** Convenience: return a new array sorted by {@link compareTasksForDisplay}. */
export function sortTasksForDisplay(taskList: Task[], taskSortBy: TaskSortBy): Task[] {
    return [...taskList].sort((a, b) => compareTasksForDisplay(a, b, taskSortBy));
}

/** Minimal shape needed to decide whether a task renders top-level or nested. */
export interface TaskTreeNode {
    id: string;
    parentTaskId?: string;
}

/**
 * Build a predicate telling whether a task renders as a TOP-LEVEL sidebar row
 * (as opposed to nested under its parent as a subtask), given the full set of
 * tasks in one workspace.
 *
 * Nesting is ONE level: a task nests only under a parent that itself renders
 * top-level. Anything deeper (a grandchild whose parent is already a subtask),
 * a task whose parent is not in this workspace, or a cyclic parent chain all
 * render top-level/flat.
 *
 * IMPORTANT: drag-and-drop indexes are assigned over top-level rows only, so
 * the store's `reorderTasks` MUST use this same predicate to build its index
 * space. If the sidebar hides a subtask under its parent but the store still
 * counts it, the dragged index maps to a different task than the user grabbed.
 */
export function createTopLevelResolver<T extends TaskTreeNode>(tasks: T[]): (task: T) => boolean {
    const byId = new Map(tasks.map(t => [t.id, t]));
    const cache = new Map<string, boolean>();
    const isTopLevel = (t: T, seen: Set<string> = new Set()): boolean => {
        const cached = cache.get(t.id);
        if (cached !== undefined) return cached;
        if (seen.has(t.id)) { cache.set(t.id, true); return true; } // cyclic parent links: render flat
        seen.add(t.id);
        const parent = t.parentTaskId ? byId.get(t.parentTaskId) : undefined;
        const result = !(parent && isTopLevel(parent, seen));
        cache.set(t.id, result);
        return result;
    };
    return (task: T) => isTopLevel(task);
}
