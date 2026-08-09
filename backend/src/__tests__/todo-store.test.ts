import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { TodoStore } from '../todo-store.js';

describe('TodoStore', () => {
    let testBaseDir: string;
    let store: TodoStore;

    beforeEach(() => {
        const uniqueId = Date.now() + '-' + Math.random().toString(36).substring(7);
        testBaseDir = join(homedir(), '.claudia-todo-test-' + uniqueId);
        mkdirSync(testBaseDir, { recursive: true });
        store = new TodoStore(testBaseDir);
    });

    afterEach(() => {
        try {
            rmSync(testBaseDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {
            // Ignore cleanup errors
        }
    });

    describe('create', () => {
        it('creates an item with sensible defaults', () => {
            const todo = store.create('task-1', 'Do the thing');
            expect(todo.taskId).toBe('task-1');
            expect(todo.title).toBe('Do the thing');
            expect(todo.completed).toBe(false);
            expect(todo.status).toBe('pending');
            expect(todo.priority).toBe('normal');
            expect(todo.source).toBe('user');
            expect(todo.kind).toBe('manual');
            expect(todo.order).toBe(0);
            expect(todo.completedAt).toBeUndefined();
        });

        it('trims the title and rejects blank ones', () => {
            expect(store.create('task-1', '  spaced  ').title).toBe('spaced');
            expect(() => store.create('task-1', '   ')).toThrow(/title is required/);
            expect(() => store.create('', 'x')).toThrow(/taskId is required/);
        });

        it('rejects an invalid status or priority', () => {
            expect(() => store.create('task-1', 'x', { status: 'bogus' as never })).toThrow(/status must be one of/);
            expect(() => store.create('task-1', 'x', { priority: 'urgent' as never })).toThrow(/priority must be one of/);
        });

        it('appends each new item to the end of the task plan', () => {
            expect(store.create('task-1', 'first').order).toBe(0);
            expect(store.create('task-1', 'second').order).toBe(1);
            // Order is per task, not global.
            expect(store.create('task-2', 'other').order).toBe(0);
        });

        it('marks an item created as completed with a completedAt', () => {
            const todo = store.create('task-1', 'done already', { status: 'completed' });
            expect(todo.completed).toBe(true);
            expect(todo.completedAt).toBeDefined();
        });

        it('flattens a would-be grandchild onto its grandparent', () => {
            const parent = store.create('task-1', 'parent');
            const child = store.create('task-1', 'child', { parentId: parent.id });
            const grandchild = store.create('task-1', 'grandchild', { parentId: child.id });
            expect(child.parentId).toBe(parent.id);
            expect(grandchild.parentId).toBe(parent.id);
        });

        it('rejects a missing or cross-task parent', () => {
            const other = store.create('task-2', 'elsewhere');
            expect(() => store.create('task-1', 'x', { parentId: 'nope' })).toThrow(/parent TODO not found/);
            expect(() => store.create('task-1', 'x', { parentId: other.id })).toThrow(/different task/);
        });
    });

    describe('listForTask', () => {
        it('returns parents in order, each followed by its subtasks', () => {
            const a = store.create('task-1', 'A');
            const b = store.create('task-1', 'B');
            store.create('task-1', 'A2', { parentId: a.id });
            store.create('task-1', 'A1', { parentId: a.id, order: -1 });
            store.create('task-2', 'unrelated');

            expect(store.listForTask('task-1').map(t => t.title)).toEqual(['A', 'A1', 'A2', 'B']);
            expect(b.parentId).toBeUndefined();
        });

        it('still surfaces orphans left by a dangling parentId on disk', () => {
            // delete() cascades, so an orphan can only come from a hand-edited or
            // corrupted todos.json. It must not silently vanish from the API.
            const kept = store.create('task-1', 'kept');
            writeFileSync(join(testBaseDir, 'todos.json'), JSON.stringify({
                schemaVersion: 1,
                data: {
                    version: 1,
                    todos: [
                        { ...kept },
                        {
                            id: 'orphan-1', taskId: 'task-1', title: 'orphan', completed: false,
                            status: 'pending', order: 5, parentId: 'gone', createdAt: new Date().toISOString(),
                        },
                    ],
                },
            }));

            const reloaded = new TodoStore(testBaseDir);
            expect(reloaded.listForTask('task-1').map(t => t.title)).toEqual(['kept', 'orphan']);
        });

        it('is scoped to one task', () => {
            store.create('task-1', 'mine');
            store.create('task-2', 'theirs');
            expect(store.listForTask('task-1').map(t => t.title)).toEqual(['mine']);
        });
    });

    describe('summaryForTask', () => {
        it('reports zero progress with no items and never divides by zero', () => {
            expect(store.summaryForTask('empty')).toEqual({
                taskId: 'empty', total: 0, completed: 0, percent: 0, active: null, next: null,
            });
        });

        it('rolls up progress and identifies the active and next items', () => {
            store.create('task-1', 'done', { status: 'completed' });
            const working = store.create('task-1', 'working', { status: 'active' });
            const later = store.create('task-1', 'later');

            const summary = store.summaryForTask('task-1');
            expect(summary.total).toBe(3);
            expect(summary.completed).toBe(1);
            expect(summary.percent).toBe(33);
            expect(summary.active?.id).toBe(working.id);
            expect(summary.next?.id).toBe(later.id);
        });
    });

    describe('update', () => {
        it('returns null for an unknown id', () => {
            expect(store.update('nope', { title: 'x' })).toBeNull();
        });

        it('keeps completed and status in agreement from either direction', () => {
            const todo = store.create('task-1', 'x');

            const viaBool = store.update(todo.id, { completed: true })!;
            expect(viaBool.status).toBe('completed');
            expect(viaBool.completedAt).toBeDefined();

            const viaStatus = store.update(todo.id, { status: 'active' })!;
            expect(viaStatus.completed).toBe(false);
            expect(viaStatus.completedAt).toBeUndefined();
        });

        it('returns an unchecked item to pending, not active', () => {
            const todo = store.create('task-1', 'x', { status: 'completed' });
            expect(store.update(todo.id, { completed: false })!.status).toBe('pending');
        });

        it('preserves the original completedAt when already completed', () => {
            const todo = store.create('task-1', 'x');
            const first = store.update(todo.id, { completed: true })!.completedAt;
            const second = store.update(todo.id, { completed: true, title: 'renamed' })!;
            expect(second.completedAt).toBe(first);
            expect(second.title).toBe('renamed');
        });

        it('validates title, status and priority', () => {
            const todo = store.create('task-1', 'x');
            expect(() => store.update(todo.id, { title: '  ' })).toThrow(/title cannot be empty/);
            expect(() => store.update(todo.id, { status: 'bogus' as never })).toThrow(/status must be one of/);
            expect(() => store.update(todo.id, { priority: 'urgent' as never })).toThrow(/priority must be one of/);
        });

        it('detaches a subtask when parentId is cleared', () => {
            const parent = store.create('task-1', 'parent');
            const child = store.create('task-1', 'child', { parentId: parent.id });
            expect(store.update(child.id, { parentId: null })!.parentId).toBeUndefined();
        });

        it('refuses to make an item its own parent', () => {
            const todo = store.create('task-1', 'x');
            expect(() => store.update(todo.id, { parentId: todo.id })).toThrow(/its own parent/);
        });
    });

    describe('reorder', () => {
        it('applies an explicit order and pushes unlisted items after it', () => {
            const a = store.create('task-1', 'A');
            const b = store.create('task-1', 'B');
            const c = store.create('task-1', 'C');

            const result = store.reorder('task-1', [c.id, a.id]);
            expect(result.map(t => t.title)).toEqual(['C', 'A', 'B']);
            expect(store.get(b.id)!.order).toBe(2);
        });

        it('ignores ids belonging to another task', () => {
            const mine = store.create('task-1', 'mine');
            const theirs = store.create('task-2', 'theirs');
            store.reorder('task-1', [theirs.id, mine.id]);
            expect(store.get(theirs.id)!.order).toBe(0); // untouched
        });
    });

    describe('delete', () => {
        it('returns null for an unknown id', () => {
            expect(store.delete('nope')).toBeNull();
        });

        it('removes a parent together with its subtasks', () => {
            const parent = store.create('task-1', 'parent');
            store.create('task-1', 'child', { parentId: parent.id });
            const keep = store.create('task-1', 'sibling');

            expect(store.delete(parent.id)!.title).toBe('parent');
            expect(store.listForTask('task-1').map(t => t.id)).toEqual([keep.id]);
        });

        it('deleteForTask clears only that task and reports the count', () => {
            store.create('task-1', 'a');
            store.create('task-1', 'b');
            store.create('task-2', 'c');

            expect(store.deleteForTask('task-1')).toBe(2);
            expect(store.listForTask('task-1')).toHaveLength(0);
            expect(store.listForTask('task-2')).toHaveLength(1);
            expect(store.deleteForTask('task-1')).toBe(0);
        });
    });

    describe('persistence', () => {
        it('survives a reload', () => {
            const parent = store.create('task-1', 'parent');
            store.create('task-1', 'child', { parentId: parent.id, priority: 'high' });

            const reloaded = new TodoStore(testBaseDir);
            const todos = reloaded.listForTask('task-1');
            expect(todos.map(t => t.title)).toEqual(['parent', 'child']);
            expect(todos[1].priority).toBe('high');
            expect(reloaded.list()).toHaveLength(2);
        });
    });
});
