/**
 * Clicking a disconnected task in setTaskActive() used to do a fully
 * synchronous, UNBOUNDED readFileSync of its entire on-disk history file
 * (archived/disconnected histories run up to the 10MB on-disk cap), then a
 * full base64 decode of that -- both blocking the single event loop, and
 * with it every other task's WebSocket traffic (including keystrokes to a
 * completely unrelated, already-open task), for however long that took.
 *
 * These tests protect the fix: the read is now bounded to a 2MB tail (same
 * cap every other history-display path already uses) AND done via
 * fs/promises so it can't stall the loop while in flight, without losing
 * access to earlier content -- the frontend's existing scroll-up chunk
 * loader (readTaskHistoryRange) picks up from wherever this tail ends.
 *
 * Temp dirs live under homedir(), not os.tmpdir() -- macOS /var is
 * blocklisted by validateWorkspacePath.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { TaskSpawner } from '../task-spawner.js';

// PersistedTask isn't exported from task-spawner.ts; a minimal structural
// shape is enough for these tests, which only touch a handful of fields.
type PersistedTask = Record<string, unknown>;

interface Ctx {
    base: string;
    historyDir: string;
    spawner?: TaskSpawner;
}

const active: Ctx[] = [];

function seed(): Ctx {
    const base = mkdtempSync(join(homedir(), '.claudia-disconnected-history-test-'));
    writeFileSync(join(base, 'tasks.json'), JSON.stringify({ tasks: [], archivedTasks: [] }));
    const historyDir = join(base, 'task-histories');
    mkdirSync(historyDir, { recursive: true });
    const ctx: Ctx = { base, historyDir };
    active.push(ctx);
    return ctx;
}

function startSpawner(ctx: Ctx): TaskSpawner {
    const s = new TaskSpawner(join(ctx.base, 'tasks.json'), false);
    ctx.spawner = s;
    return s;
}

/** Reach the private internals the same way task-spawner-async-save.test.ts does. */
interface SpawnerInternals {
    disconnectedTasks: Map<string, PersistedTask>;
    setTaskActive(taskId: string, active: boolean): void;
    on(event: 'taskRestore', listener: (taskId: string, history: string) => void): unknown;
}
function internals(s: TaskSpawner): SpawnerInternals {
    return s as unknown as SpawnerInternals;
}

function seedDisconnectedTask(ctx: Ctx, taskId: string): void {
    internals(ctx.spawner!).disconnectedTasks.set(taskId, {
        id: taskId,
        prompt: 'disconnected task',
        workspaceId: ctx.base,
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        lastState: 'idle',
        wasInterrupted: true,
        shouldContinue: false,
        backendType: 'claude-code',
    } as unknown as PersistedTask);
}

function waitForRestore(s: TaskSpawner, taskId: string): Promise<string> {
    return new Promise((resolve) => {
        internals(s).on('taskRestore', (id, history) => {
            if (id === taskId) resolve(history);
        });
    });
}

afterEach(() => {
    for (const ctx of active.splice(0)) {
        try { ctx.spawner?.destroy(); } catch { /* best effort */ }
        try { rmSync(ctx.base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
    }
});

describe('setTaskActive — disconnected task history on click', () => {
    it('sends the full history for a small (<=2MB) file', async () => {
        const ctx = seed();
        const s = startSpawner(ctx);
        const taskId = 'task-small';
        const content = 'hello from a small history file\r\nsecond line\r\n';
        writeFileSync(join(ctx.historyDir, `${taskId}.txt`), content);
        seedDisconnectedTask(ctx, taskId);

        const restorePromise = waitForRestore(s, taskId);
        internals(s).setTaskActive(taskId, true);
        const history = await restorePromise;

        expect(history).toBe(content);
    });

    it('sends only a bounded 2MB tail for a large history file, not the whole thing', async () => {
        const ctx = seed();
        const s = startSpawner(ctx);
        const taskId = 'task-large';
        // 6MB of raw terminal-like text (contains a space, so the raw-text
        // heuristic classifies it correctly) -- well past the 2MB cap.
        const marker = 'END-OF-FILE-MARKER';
        const filler = 'x '.repeat(3 * 1024 * 1024); // 6MB
        const content = filler + marker;
        writeFileSync(join(ctx.historyDir, `${taskId}.txt`), content);
        seedDisconnectedTask(ctx, taskId);

        const restorePromise = waitForRestore(s, taskId);
        internals(s).setTaskActive(taskId, true);
        const history = await restorePromise;

        const MAX_CLICK_HISTORY = 2 * 1024 * 1024;
        expect(history.length).toBe(MAX_CLICK_HISTORY);
        // The tail (most recent content) must be what's preserved, not the head.
        expect(history.endsWith(marker)).toBe(true);
    });

    it('resolves the restore asynchronously, never within the synchronous setTaskActive call itself', async () => {
        const ctx = seed();
        const s = startSpawner(ctx);
        const taskId = 'task-large-async';
        writeFileSync(join(ctx.historyDir, `${taskId}.txt`), 'y '.repeat(4 * 1024 * 1024));
        seedDisconnectedTask(ctx, taskId);

        let resolved = false;
        const restorePromise = waitForRestore(s, taskId).then((h) => { resolved = true; return h; });

        // The old, buggy implementation read + decoded the whole file
        // synchronously and emitted 'taskRestore' before setTaskActive ever
        // returned. The fix defers the read past the current synchronous
        // call -- so immediately after calling it, the restore must NOT have
        // resolved yet, regardless of how fast the disk happens to be.
        internals(s).setTaskActive(taskId, true);
        expect(resolved).toBe(false);

        await restorePromise;
        expect(resolved).toBe(true);
    });

    it('emits an empty restore (not a hang) when a disconnected task has no history file', async () => {
        const ctx = seed();
        const s = startSpawner(ctx);
        const taskId = 'task-no-history';
        seedDisconnectedTask(ctx, taskId);

        const restorePromise = waitForRestore(s, taskId);
        internals(s).setTaskActive(taskId, true);
        const history = await restorePromise;

        expect(history).toBe('');
    });
});
