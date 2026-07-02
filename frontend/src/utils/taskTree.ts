import type { Task } from '@claudia/shared';

export interface TaskTree {
    roots: Task[];
    childrenByParent: Map<string, Task[]>;
}

// Derives a tree from the flat task list. A task whose parent is absent
// from the input (deleted, archived, filtered out) is promoted to root.
export function buildTaskTree(tasks: Task[]): TaskTree {
    const ids = new Set(tasks.map(t => t.id));
    const roots: Task[] = [];
    const childrenByParent = new Map<string, Task[]>();
    for (const t of tasks) {
        if (t.parentTaskId && ids.has(t.parentTaskId)) {
            const list = childrenByParent.get(t.parentTaskId) ?? [];
            list.push(t);
            childrenByParent.set(t.parentTaskId, list);
        } else {
            roots.push(t);
        }
    }
    return { roots, childrenByParent };
}
