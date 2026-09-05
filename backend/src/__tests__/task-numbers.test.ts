/**
 * Short task identifiers (#48) and short-ref resolution.
 *
 * Tasks are referenced constantly — by orchestrating agents in claudia_* tool
 * calls and by the developer in conversation — and the long ids
 * ("task-1787…-a3f2") are unreadable and untypeable. Each task gets a
 * sequential number, persisted so it survives restarts and is NEVER reused:
 * "#48" must stay unambiguous even after task 48 is deleted.
 *
 * Regression targets:
 *  - pre-existing (unnumbered) tasks get numbers on load, oldest first
 *  - the counter persists and never reuses a number after deletion
 *  - resolveTaskRef accepts full id, "#48", and "48", and never guesses
 *
 * Temp dirs live under homedir(), not os.tmpdir() — macOS /var is blocklisted
 * by validateWorkspacePath.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { TaskSpawner } from '../task-spawner.js';

interface Ctx {
    base: string;
    tasksFile: string;
    spawner?: TaskSpawner;
}

const active: Ctx[] = [];

function seed(tasks: object[], extra: object = {}): Ctx {
    const base = mkdtempSync(join(homedir(), '.claudia-tasknum-test-'));
    const tasksFile = join(base, 'tasks.json');
    writeFileSync(tasksFile, JSON.stringify({ tasks, archivedTasks: [], ...extra }));
    const ctx: Ctx = { base, tasksFile };
    active.push(ctx);
    return ctx;
}

function persisted(id: string, createdAt: string, extra: object = {}): object {
    return {
        id,
        prompt: `task ${id}`,
        workspaceId: join(homedir(), 'nonexistent-ws'),
        createdAt,
        lastActivity: createdAt,
        lastState: 'idle',
        sessionId: null,
        wasInterrupted: false,
        shouldContinue: false,
        backendType: 'claude-code',
        ...extra,
    };
}

function start(ctx: Ctx): TaskSpawner {
    const s = new TaskSpawner(ctx.tasksFile, false);
    ctx.spawner = s;
    return s;
}

afterEach(() => {
    for (const ctx of active.splice(0)) {
        try { ctx.spawner?.destroy(); } catch { /* best effort */ }
        try { rmSync(ctx.base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
    }
});

describe('task number migration', () => {
    it('numbers pre-existing tasks oldest-first on load', () => {
        const ctx = seed([
            persisted('task-newer', '2026-08-18T12:00:00.000Z'),
            persisted('task-oldest', '2026-08-01T12:00:00.000Z'),
            persisted('task-middle', '2026-08-10T12:00:00.000Z'),
        ]);
        const s = start(ctx);

        const byId = new Map(s.getAllTasks().map(t => [t.id, t.taskNumber]));
        expect(byId.get('task-oldest')).toBe(1);
        expect(byId.get('task-middle')).toBe(2);
        expect(byId.get('task-newer')).toBe(3);
    });

    it('keeps already-assigned numbers and only fills gaps above them', () => {
        const ctx = seed([
            persisted('task-a', '2026-08-01T12:00:00.000Z', { taskNumber: 7 }),
            persisted('task-b', '2026-08-02T12:00:00.000Z'),
        ]);
        const s = start(ctx);

        const byId = new Map(s.getAllTasks().map(t => [t.id, t.taskNumber]));
        expect(byId.get('task-a')).toBe(7);
        // The unnumbered task must land ABOVE the highest existing number —
        // reusing 1..6 would collide with numbers that may live in archived
        // tasks or the user's memory of past tasks.
        expect(byId.get('task-b')).toBe(8);
    });

    it('respects a persisted counter even when it exceeds every stored number', () => {
        const ctx = seed(
            [persisted('task-a', '2026-08-01T12:00:00.000Z', { taskNumber: 3 })],
            { nextTaskNumber: 50 }
        );
        const s = start(ctx);
        // Force a save and confirm the counter did not regress to 4.
        (s as unknown as { saveTasks(): void }).saveTasks();
        const onDisk = JSON.parse(readFileSync(ctx.tasksFile, 'utf-8')) as { nextTaskNumber?: number };
        expect(onDisk.nextTaskNumber).toBe(50);
    });

    it('persists assigned numbers and the advanced counter', async () => {
        const ctx = seed([
            persisted('task-a', '2026-08-01T12:00:00.000Z'),
            persisted('task-b', '2026-08-02T12:00:00.000Z'),
        ]);
        const s = start(ctx);
        (s as unknown as { saveTasks(): void }).saveTasks();

        const onDisk = JSON.parse(readFileSync(ctx.tasksFile, 'utf-8')) as {
            tasks: { id: string; taskNumber?: number }[];
            nextTaskNumber?: number;
        };
        const nums = new Map(onDisk.tasks.map(t => [t.id, t.taskNumber]));
        expect(nums.get('task-a')).toBe(1);
        expect(nums.get('task-b')).toBe(2);
        expect(onDisk.nextTaskNumber).toBe(3);

        // A second spawner over the same file must see identical numbers —
        // the migration is one-time, not a renumbering on every boot.
        s.destroy();
        const s2 = start(ctx);
        const byId = new Map(s2.getAllTasks().map(t => [t.id, t.taskNumber]));
        expect(byId.get('task-a')).toBe(1);
        expect(byId.get('task-b')).toBe(2);
    });

    it('never reuses a number after the task holding it is deleted', () => {
        const ctx = seed([
            persisted('task-a', '2026-08-01T12:00:00.000Z'),
            persisted('task-b', '2026-08-02T12:00:00.000Z'),
        ]);
        const s = start(ctx);
        s.destroyTask('task-b'); // frees #2 — which must stay retired
        (s as unknown as { saveTasks(): void }).saveTasks();

        const onDisk = JSON.parse(readFileSync(ctx.tasksFile, 'utf-8')) as { nextTaskNumber?: number };
        expect(onDisk.nextTaskNumber).toBe(3);
    });
});

describe('resolveTaskRef', () => {
    it('resolves full ids, "#n", and bare "n"', () => {
        const ctx = seed([persisted('task-a', '2026-08-01T12:00:00.000Z')]);
        const s = start(ctx);

        expect(s.resolveTaskRef('task-a')).toBe('task-a');
        expect(s.resolveTaskRef('#1')).toBe('task-a');
        expect(s.resolveTaskRef('1')).toBe('task-a');
        expect(s.resolveTaskRef(' #1 ')).toBe('task-a');
    });

    it('returns null rather than guessing', () => {
        const ctx = seed([persisted('task-a', '2026-08-01T12:00:00.000Z')]);
        const s = start(ctx);

        expect(s.resolveTaskRef('#999')).toBeNull();
        expect(s.resolveTaskRef('task-nonexistent')).toBeNull();
        expect(s.resolveTaskRef('')).toBeNull();
        expect(s.resolveTaskRef('#')).toBeNull();
        expect(s.resolveTaskRef('abc')).toBeNull();
    });
});

describe('archive round-trip', () => {
    // Archived tasks are never referenced, so they carry no number. Archiving
    // retires the task's number forever; restoring assigns a fresh one. What
    // survives the round-trip is the HIERARCHY link, not the number.
    it('archiving drops the number (retired), restore assigns a fresh one, parent link survives', () => {
        const ctx = seed([
            persisted('task-a', '2026-08-01T12:00:00.000Z', { taskNumber: 48, parentTaskId: 'task-p' }),
        ], { nextTaskNumber: 49 });
        const s = start(ctx);

        s.archiveTask('task-a');
        const archived = s.getArchivedTasks().find(t => t.id === 'task-a')!;
        expect(archived.taskNumber).toBeUndefined();
        expect(archived.parentTaskId).toBe('task-p');

        const restored = s.restoreArchivedTask('task-a')!;
        // Fresh number from the counter — never 48 again.
        expect(restored.taskNumber).toBe(49);
        expect(restored.parentTaskId).toBe('task-p');
        expect(s.resolveTaskRef('#49')).toBe('task-a');
        expect(s.resolveTaskRef('#48')).toBeNull();
    });

    it('REPAIR: strips numbers off archived tasks and renumbers actives compactly from 1', () => {
        // The first cut numbered the archive too, so a long-lived install's
        // live tasks started in the hundreds. Loading a file in that state
        // must strip the archived numbers and renumber actives from 1 — the
        // one deliberate exception to number stability.
        const base = mkdtempSync(join(homedir(), '.claudia-tasknum-test-'));
        const tasksFile = join(base, 'tasks.json');
        writeFileSync(tasksFile, JSON.stringify({
            tasks: [
                persisted('task-live-1', '2026-08-10T12:00:00.000Z', { taskNumber: 402 }),
                persisted('task-live-2', '2026-08-11T12:00:00.000Z', { taskNumber: 403 }),
            ],
            archivedTasks: [
                { id: 'task-old', prompt: 'old', workspaceId: join(homedir(), 'nonexistent-ws'),
                  createdAt: '2026-01-01T12:00:00.000Z', lastActivity: '2026-01-01T12:00:00.000Z',
                  sessionId: null, taskNumber: 1 },
            ],
            nextTaskNumber: 404,
        }));
        const ctx: Ctx = { base, tasksFile };
        active.push(ctx);
        const s = start(ctx);

        const byId = new Map(s.getAllTasks().map(t => [t.id, t.taskNumber]));
        expect(byId.get('task-live-1')).toBe(1);
        expect(byId.get('task-live-2')).toBe(2);
        expect(s.getArchivedTasks().find(t => t.id === 'task-old')!.taskNumber).toBeUndefined();

        // Repair is one-time: a reload keeps the compact numbering.
        (s as unknown as { saveTasks(): void }).saveTasks();
        s.destroy();
        const s2 = start(ctx);
        const byId2 = new Map(s2.getAllTasks().map(t => [t.id, t.taskNumber]));
        expect(byId2.get('task-live-1')).toBe(1);
        expect(byId2.get('task-live-2')).toBe(2);
    });
});
