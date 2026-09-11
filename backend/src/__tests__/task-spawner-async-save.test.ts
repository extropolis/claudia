/**
 * The async, parallelized background save path (`saveTasksAsync`, reached via
 * `scheduleSave` -> `runDebouncedSave`).
 *
 * `saveTasks` (sync) blocks the single Node event loop for every live task on
 * every debounced save — with ~25-30 concurrent tasks this stalled every
 * task's PTY I/O at once. `saveTasksAsync` is a separate, async/parallel
 * implementation used ONLY by the debounce timer; `saveNow`/shutdown keep
 * calling the original synchronous `saveTasks` unchanged.
 *
 * These tests protect against regressing INTO the thing the user explicitly
 * asked us not to risk: corrupting tasks.json or a task's history file while
 * making the save non-blocking. They mirror the existing sync-path tests
 * (task-spawner-save-guard.test.ts, task-numbers.test.ts) so the async path is
 * held to the same guarantees, plus one test for the new overlap-coalescing
 * logic in `runDebouncedSave`.
 *
 * Temp dirs live under homedir(), not os.tmpdir() — macOS /var is blocklisted
 * by validateWorkspacePath.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, utimesSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { TaskSpawner } from '../task-spawner.js';

interface Ctx {
    base: string;
    tasksFile: string;
    spawner?: TaskSpawner;
}

const active: Ctx[] = [];

function seed(taskIds: string[]): Ctx {
    const base = mkdtempSync(join(homedir(), '.claudia-asyncsave-test-'));
    const tasksFile = join(base, 'tasks.json');
    writeFileSync(tasksFile, JSON.stringify({
        tasks: taskIds.map(id => ({
            id,
            prompt: `task ${id}`,
            workspaceId: base,
            createdAt: new Date().toISOString(),
            lastActivity: new Date().toISOString(),
            lastState: 'idle',
            wasInterrupted: false,
            shouldContinue: false,
            backendType: 'claude-code',
        })),
        archivedTasks: [],
    }));
    const ctx: Ctx = { base, tasksFile };
    active.push(ctx);
    return ctx;
}

function startSpawner(ctx: Ctx): TaskSpawner {
    const s = new TaskSpawner(ctx.tasksFile, false);
    ctx.spawner = s;
    return s;
}

/** Rewrite the file as a "different process" would, with a strictly newer mtime. */
function foreignWrite(path: string, content: string): void {
    writeFileSync(path, content);
    const future = new Date(Date.now() + 5000);
    utimesSync(path, future, future);
}

/** Reach the private async save internals the same way existing tests reach saveTasks(). */
interface AsyncSaveInternals {
    saveTasksAsync(): Promise<void>;
    runDebouncedSave(): Promise<void>;
    saveInFlight: boolean;
    saveAgainRequested: boolean;
    tasks: Map<string, Record<string, unknown>>;
}
function internals(s: TaskSpawner): AsyncSaveInternals {
    return s as unknown as AsyncSaveInternals;
}

afterEach(() => {
    for (const ctx of active.splice(0)) {
        try { ctx.spawner?.destroy(); } catch { /* best effort */ }
        try { rmSync(ctx.base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
    }
});

describe('saveTasksAsync — parity with the synchronous save path', () => {
    it('writes the same tasks it was seeded with', async () => {
        const ctx = seed(['task-a', 'task-b']);
        const s = startSpawner(ctx);

        await internals(s).saveTasksAsync();

        const onDisk = JSON.parse(readFileSync(ctx.tasksFile, 'utf-8')) as { tasks: { id: string }[] };
        expect(onDisk.tasks.map(t => t.id).sort()).toEqual(['task-a', 'task-b']);
    });

    it('REFUSES to overwrite a file another process modified after we loaded it', async () => {
        const ctx = seed(['task-original-1']);
        const s = startSpawner(ctx);

        const foreign = JSON.stringify({
            tasks: [{ id: 'task-from-other-process', prompt: 'do not lose me' }],
            archivedTasks: [],
        });
        foreignWrite(ctx.tasksFile, foreign);

        await internals(s).saveTasksAsync();

        // Same guard as saveTasks(): must PREVENT the write, not merely log.
        expect(readFileSync(ctx.tasksFile, 'utf8')).toBe(foreign);
        expect(readFileSync(ctx.tasksFile, 'utf8')).toContain('task-from-other-process');
        expect(readFileSync(ctx.tasksFile, 'utf8')).not.toContain('task-original-1');
    });

    it('does not leave a partial or backup write behind when it refuses', async () => {
        const ctx = seed(['task-original-1']);
        const s = startSpawner(ctx);

        const foreign = JSON.stringify({ tasks: [], archivedTasks: [] });
        foreignWrite(ctx.tasksFile, foreign);
        const sizeBefore = statSync(ctx.tasksFile).size;

        await internals(s).saveTasksAsync();

        expect(statSync(ctx.tasksFile).size).toBe(sizeBefore);
        expect(readFileSync(ctx.tasksFile, 'utf8')).toBe(foreign);
    });

    it('refuses to overwrite a non-empty file with an empty save', async () => {
        const ctx = seed(['task-original-1']);
        const s = startSpawner(ctx);
        // Prime fileModTimeOnLoad against the real on-disk file, then clear the
        // in-memory disconnected tasks to simulate the bug this guard exists for.
        await internals(s).saveTasksAsync();
        (s as unknown as { disconnectedTasks: Map<string, unknown> }).disconnectedTasks.clear();

        await internals(s).saveTasksAsync();

        const onDisk = JSON.parse(readFileSync(ctx.tasksFile, 'utf-8')) as { tasks: unknown[] };
        expect(onDisk.tasks.length).toBeGreaterThan(0);
    });
});

describe('saveTasksAsync — live task history writes', () => {
    it('writes a new live task\'s output to its history file', async () => {
        const ctx = seed([]);
        const s = startSpawner(ctx);

        internals(s).tasks.set('task-live-1', {
            id: 'task-live-1',
            prompt: 'live task',
            workspaceId: ctx.base,
            state: 'idle',
            createdAt: new Date(),
            lastActivity: new Date(),
            sessionId: null,
            outputHistory: [Buffer.from('hello from the agent\n')],
            savedBufferCount: 0,
        });

        await internals(s).saveTasksAsync();

        const historyPath = join(ctx.base, 'task-histories', 'task-live-1.txt');
        expect(existsSync(historyPath)).toBe(true);
        expect(readFileSync(historyPath, 'utf-8')).toBe('hello from the agent\n');
    });

    it('incrementally appends only new buffers on a later save', async () => {
        const ctx = seed([]);
        const s = startSpawner(ctx);

        const task = {
            id: 'task-live-2',
            prompt: 'live task',
            workspaceId: ctx.base,
            state: 'idle',
            createdAt: new Date(),
            lastActivity: new Date(),
            sessionId: null,
            outputHistory: [Buffer.from('line one\n')],
            savedBufferCount: 0,
        };
        internals(s).tasks.set('task-live-2', task);
        await internals(s).saveTasksAsync();

        task.outputHistory.push(Buffer.from('line two\n'));
        await internals(s).saveTasksAsync();

        const historyPath = join(ctx.base, 'task-histories', 'task-live-2.txt');
        expect(readFileSync(historyPath, 'utf-8')).toBe('line one\nline two\n');
    });

    it('parallelizes independent tasks without cross-writing each other\'s history', async () => {
        const ctx = seed([]);
        const s = startSpawner(ctx);

        const ids = Array.from({ length: 8 }, (_, i) => `task-parallel-${i}`);
        for (const id of ids) {
            internals(s).tasks.set(id, {
                id,
                prompt: id,
                workspaceId: ctx.base,
                state: 'idle',
                createdAt: new Date(),
                lastActivity: new Date(),
                sessionId: null,
                outputHistory: [Buffer.from(`output for ${id}\n`)],
                savedBufferCount: 0,
            });
        }

        await internals(s).saveTasksAsync();

        for (const id of ids) {
            const historyPath = join(ctx.base, 'task-histories', `${id}.txt`);
            expect(readFileSync(historyPath, 'utf-8')).toBe(`output for ${id}\n`);
        }
    });
});

describe('runDebouncedSave — overlap coalescing', () => {
    it('does not start a second concurrent save while one is in flight', async () => {
        const ctx = seed(['task-a']);
        const s = startSpawner(ctx);
        const inner = internals(s);

        // Simulate: a save from a previous debounce tick is still running.
        inner.saveInFlight = true;
        const p = inner.runDebouncedSave();

        // Must have coalesced into "run again after", not started a second save.
        expect(inner.saveAgainRequested).toBe(true);
        inner.saveInFlight = false; // let the (already-returned) call's finally logic be moot
        await p;
    });

    it('schedules exactly one follow-up save after a real overlapping trigger, never a concurrent second one', async () => {
        const ctx = seed(['task-a']);
        const s = startSpawner(ctx);
        const inner = internals(s);
        const spy = vi.spyOn(inner, 'saveTasksAsync');

        // Real overlap: start the first save, then — before it resolves — trigger
        // a second debounce tick. Both are driven by the actual implementation,
        // not simulated flags.
        const p1 = inner.runDebouncedSave();
        expect(inner.saveInFlight).toBe(true); // set synchronously before the first await
        const p2 = inner.runDebouncedSave();
        await Promise.all([p1, p2]);

        // The second trigger must NOT have caused a concurrent second
        // saveTasksAsync call — only the first save actually ran here.
        expect(spy).toHaveBeenCalledTimes(1);
        expect(inner.saveInFlight).toBe(false);
        // Its "run again" request was consumed by queuing one more debounced
        // round (scheduleSave), not by re-entering saveTasksAsync synchronously.
        expect(inner.saveAgainRequested).toBe(false);
        expect((s as unknown as { saveDebounceTimer: unknown }).saveDebounceTimer).not.toBeNull();

        const onDisk = JSON.parse(readFileSync(ctx.tasksFile, 'utf-8')) as { tasks: { id: string }[] };
        expect(onDisk.tasks.map(t => t.id)).toContain('task-a');
    });
});
