/**
 * Todo Store - Per-task work-plan items.
 *
 * Claude seeds and continuously manages a task's TODO list; the user can also
 * add, complete, reorder and nest items from the UI. Items support one level of
 * hierarchy (a parent and its subtasks) and carry an explicit execution `order`
 * so the plan reads top-to-bottom.
 */

import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TodoItem, TodoStatus, TodoPriority, TodoSource, TodoKind } from '@claudia/shared';
import { loadVersioned, saveVersioned } from './utils/schema-version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Schema version for todos.json. Bump when TodosData shape changes. */
const TODOS_SCHEMA_VERSION = 1;

interface TodosData {
    todos: TodoItem[];
    version: number;
}

/** Fields accepted when creating an item. `title` and `taskId` are passed separately. */
export interface CreateTodoOptions {
    description?: string;
    status?: TodoStatus;
    priority?: TodoPriority;
    source?: TodoSource;
    kind?: TodoKind;
    url?: string;
    externalRef?: string;
    parentId?: string;
    order?: number;
}

/** Fields accepted by update(). Any omitted field is left untouched. */
export interface UpdateTodoOptions {
    title?: string;
    description?: string;
    completed?: boolean;
    status?: TodoStatus;
    priority?: TodoPriority;
    order?: number;
    parentId?: string | null;
}

/** Progress rollup plus what the task is on now and what comes next. */
export interface TodoSummary {
    taskId: string;
    total: number;
    completed: number;
    /** 0-100, rounded. 0 when there are no items (avoids NaN in the UI). */
    percent: number;
    active: TodoItem | null;
    next: TodoItem | null;
}

const VALID_STATUSES: TodoStatus[] = ['pending', 'active', 'completed'];
const VALID_PRIORITIES: TodoPriority[] = ['high', 'normal', 'low'];

export class TodoStore {
    private data: TodosData;
    private storagePath: string;

    constructor(basePath?: string) {
        this.storagePath = basePath
            ? join(basePath, 'todos.json')
            : join(__dirname, '..', 'todos.json');

        this.data = this.loadData();
        console.log(`[TodoStore] Loaded ${this.data.todos.length} todos`);
    }

    private loadData(): TodosData {
        try {
            return loadVersioned<TodosData>(this.storagePath, {
                currentVersion: TODOS_SCHEMA_VERSION,
                defaultData: { todos: [], version: 1 },
                legacyLoader: (raw) => (raw as TodosData) ?? { todos: [], version: 1 },
            });
        } catch (error) {
            console.error('[TodoStore] Failed to load data:', error);
            return { todos: [], version: 1 };
        }
    }

    private saveData(): void {
        try {
            const dir = dirname(this.storagePath);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
            saveVersioned(this.storagePath, this.data, TODOS_SCHEMA_VERSION);
        } catch (error) {
            console.error('[TodoStore] Failed to save data:', error);
        }
    }

    /**
     * `completed` and `status` are two views of the same fact, and the API lets a
     * caller set either one. Reconcile them so they can never disagree: an explicit
     * status wins, otherwise the boolean drives it.
     */
    private reconcile(completed: boolean | undefined, status: TodoStatus | undefined, prev: TodoItem | null): { completed: boolean; status: TodoStatus } {
        if (status !== undefined) {
            return { completed: status === 'completed', status };
        }
        if (completed !== undefined) {
            // Leaving 'completed' returns the item to 'pending' rather than 'active' —
            // unchecking means "not done", not "working on it right now".
            return { completed, status: completed ? 'completed' : 'pending' };
        }
        return {
            completed: prev?.completed ?? false,
            status: prev?.status ?? (prev?.completed ? 'completed' : 'pending'),
        };
    }

    /** Next free order value within a task (items are appended to the end of the plan). */
    private nextOrder(taskId: string): number {
        const orders = this.data.todos
            .filter(t => t.taskId === taskId)
            .map(t => t.order ?? 0);
        return orders.length > 0 ? Math.max(...orders) + 1 : 0;
    }

    create(taskId: string, title: string, options: CreateTodoOptions = {}): TodoItem {
        if (!taskId) {
            throw new Error('taskId is required');
        }
        if (!title || !title.trim()) {
            throw new Error('title is required');
        }
        if (options.status !== undefined && !VALID_STATUSES.includes(options.status)) {
            throw new Error(`status must be one of: ${VALID_STATUSES.join(', ')}`);
        }
        if (options.priority !== undefined && !VALID_PRIORITIES.includes(options.priority)) {
            throw new Error(`priority must be one of: ${VALID_PRIORITIES.join(', ')}`);
        }

        // Only one level of nesting: pointing at a child would create a grandchild,
        // which the UI cannot render — re-parent to the child's own parent instead.
        let parentId = options.parentId;
        if (parentId) {
            const parent = this.data.todos.find(t => t.id === parentId);
            if (!parent) {
                throw new Error(`parent TODO not found: ${parentId}`);
            }
            if (parent.taskId !== taskId) {
                throw new Error('parent TODO belongs to a different task');
            }
            parentId = parent.parentId ?? parent.id;
        }

        const { completed, status } = this.reconcile(undefined, options.status, null);

        const todo: TodoItem = {
            id: `todo-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`,
            taskId,
            title: title.trim(),
            completed,
            status,
            createdAt: new Date().toISOString(),
            order: options.order ?? this.nextOrder(taskId),
            priority: options.priority ?? 'normal',
            source: options.source ?? 'user',
            kind: options.kind ?? 'manual',
        };
        if (options.description) todo.description = options.description;
        if (options.url) todo.url = options.url;
        if (options.externalRef) todo.externalRef = options.externalRef;
        if (parentId) todo.parentId = parentId;
        if (completed) todo.completedAt = todo.createdAt;

        this.data.todos.push(todo);
        this.saveData();
        return todo;
    }

    get(todoId: string): TodoItem | null {
        return this.data.todos.find(t => t.id === todoId) ?? null;
    }

    /** All todos, newest task activity first is not implied — insertion order is preserved. */
    list(): TodoItem[] {
        return [...this.data.todos];
    }

    /** A task's todos in plan order: parents by `order`, each followed by its subtasks. */
    listForTask(taskId: string): TodoItem[] {
        const mine = this.data.todos.filter(t => t.taskId === taskId);
        const byOrder = (a: TodoItem, b: TodoItem) => (a.order ?? 0) - (b.order ?? 0);

        const parents = mine.filter(t => !t.parentId).sort(byOrder);
        const childrenOf = (id: string) => mine.filter(t => t.parentId === id).sort(byOrder);

        const ordered: TodoItem[] = [];
        for (const parent of parents) {
            ordered.push(parent);
            ordered.push(...childrenOf(parent.id));
        }
        // Orphans (parent deleted out from under them) would otherwise vanish from the
        // API entirely; surface them at the end rather than silently dropping them.
        const seen = new Set(ordered.map(t => t.id));
        ordered.push(...mine.filter(t => !seen.has(t.id)).sort(byOrder));
        return ordered;
    }

    summaryForTask(taskId: string): TodoSummary {
        const todos = this.listForTask(taskId);
        const completed = todos.filter(t => t.completed).length;
        const active = todos.find(t => t.status === 'active' && !t.completed) ?? null;
        const next = todos.find(t => !t.completed && t.status !== 'active') ?? null;

        return {
            taskId,
            total: todos.length,
            completed,
            percent: todos.length > 0 ? Math.round((completed / todos.length) * 100) : 0,
            active,
            next,
        };
    }

    update(todoId: string, updates: UpdateTodoOptions): TodoItem | null {
        const todo = this.data.todos.find(t => t.id === todoId);
        if (!todo) return null;

        if (updates.title !== undefined) {
            if (!updates.title.trim()) {
                throw new Error('title cannot be empty');
            }
            todo.title = updates.title.trim();
        }
        if (updates.description !== undefined) {
            todo.description = updates.description || undefined;
        }
        if (updates.status !== undefined && !VALID_STATUSES.includes(updates.status)) {
            throw new Error(`status must be one of: ${VALID_STATUSES.join(', ')}`);
        }
        if (updates.priority !== undefined) {
            if (!VALID_PRIORITIES.includes(updates.priority)) {
                throw new Error(`priority must be one of: ${VALID_PRIORITIES.join(', ')}`);
            }
            todo.priority = updates.priority;
        }
        if (updates.order !== undefined) {
            todo.order = updates.order;
        }
        if (updates.parentId !== undefined) {
            if (updates.parentId === null || updates.parentId === '') {
                delete todo.parentId;
            } else {
                const parent = this.data.todos.find(t => t.id === updates.parentId);
                if (!parent) {
                    throw new Error(`parent TODO not found: ${updates.parentId}`);
                }
                if (parent.id === todo.id) {
                    throw new Error('a TODO cannot be its own parent');
                }
                if (parent.taskId !== todo.taskId) {
                    throw new Error('parent TODO belongs to a different task');
                }
                todo.parentId = parent.parentId ?? parent.id;
            }
        }

        if (updates.completed !== undefined || updates.status !== undefined) {
            const wasCompleted = todo.completed;
            const { completed, status } = this.reconcile(updates.completed, updates.status, todo);
            todo.completed = completed;
            todo.status = status;
            if (completed && !wasCompleted) {
                todo.completedAt = new Date().toISOString();
            } else if (!completed) {
                delete todo.completedAt;
            }
        }

        this.saveData();
        return todo;
    }

    /**
     * Apply an explicit execution order from an ordered id list. Ids not in the list
     * keep their relative position after the ones that are. Returns the task's todos
     * in the new plan order.
     */
    reorder(taskId: string, orderedIds: string[]): TodoItem[] {
        orderedIds.forEach((id, index) => {
            const todo = this.data.todos.find(t => t.id === id && t.taskId === taskId);
            if (todo) todo.order = index;
        });

        // Push anything the client didn't mention past the explicitly ordered block,
        // so a partial reorder can't collide with the new indices.
        const tail = this.data.todos.filter(t => t.taskId === taskId && !orderedIds.includes(t.id));
        tail.forEach((todo, index) => {
            todo.order = orderedIds.length + index;
        });

        this.saveData();
        return this.listForTask(taskId);
    }

    /** Deletes the item and, when it's a parent, its subtasks along with it. */
    delete(todoId: string): TodoItem | null {
        const index = this.data.todos.findIndex(t => t.id === todoId);
        if (index === -1) return null;

        const [removed] = this.data.todos.splice(index, 1);
        this.data.todos = this.data.todos.filter(t => t.parentId !== removed.id);
        this.saveData();
        return removed;
    }

    /** Removes every todo belonging to a task (called when the task itself is deleted). */
    deleteForTask(taskId: string): number {
        const before = this.data.todos.length;
        this.data.todos = this.data.todos.filter(t => t.taskId !== taskId);
        const removed = before - this.data.todos.length;
        if (removed > 0) this.saveData();
        return removed;
    }
}
