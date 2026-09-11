/**
 * tasks.json persistence.
 *
 * This file used to test a "modified by another process — REFUSING TO SAVE"
 * guard: saveTasks() compared tasks.json's mtime against the value recorded at
 * load and skipped the write when it had moved. That guard is gone, and these
 * tests now pin the opposite behaviour on purpose.
 *
 * Why it went: it only ever detected the damage AFTER two backends were already
 * running, protected exactly one file out of the dozen in the data directory,
 * and its remedy — stop persisting, forever, silently — lost more state than
 * the overwrite it was preventing. It also tripped on legitimate external edits
 * to tasks.json. Mutual exclusion moved to instance-lock.ts, which refuses to
 * BOOT a second backend against the same data directory (see
 * instance-lock.test.ts), so by the time a spawner exists it is the only one.
 *
 * No CLI spawn here, so this runs on the Windows CI leg too. Temp dirs live
 * under homedir(), not os.tmpdir() (macOS /var is blocklisted by
 * validateWorkspacePath).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'fs';
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
    const base = mkdtempSync(join(homedir(), '.claudia-saveguard-test-'));
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

/** Rewrite the file the way an outside editor would, with a strictly newer mtime. */
function foreignWrite(path: string, content: string): void {
    writeFileSync(path, content);
    const future = new Date(Date.now() + 5000);
    utimesSync(path, future, future);
}

/** The task ids the spawner actually persisted, across both file layouts. */
function persistedIds(path: string): string[] {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const tasks = parsed.data?.tasks ?? parsed.tasks ?? [];
    return tasks.map((t: { id: string }) => t.id);
}

afterEach(() => {
    for (const ctx of active.splice(0)) {
        try { ctx.spawner?.destroy(); } catch { /* best effort */ }
        try { rmSync(ctx.base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
    }
});

describe('TaskSpawner.saveNow', () => {
    it('writes the in-memory tasks to disk', () => {
        const ctx = seed(['task-original-1']);
        const s = startSpawner(ctx);

        s.saveNow();

        expect(persistedIds(ctx.tasksFile)).toContain('task-original-1');
    });

    it('keeps saving across repeated saves', () => {
        const ctx = seed(['task-original-1']);
        const s = startSpawner(ctx);

        s.saveNow();
        s.saveNow();
        s.saveNow();

        expect(persistedIds(ctx.tasksFile)).toContain('task-original-1');
    });

    it('no longer wedges when tasks.json is touched behind its back', () => {
        // The old mtime guard would refuse this write and every later one. A
        // single owner of the data directory is now guaranteed at startup, so
        // an mtime that moved means an external edit — not a rival instance —
        // and the running backend's own state is the authority.
        const ctx = seed(['task-original-1']);
        const s = startSpawner(ctx);

        foreignWrite(ctx.tasksFile, JSON.stringify({ tasks: [{ id: 'task-edited-by-hand' }], archivedTasks: [] }));

        s.saveNow();

        expect(persistedIds(ctx.tasksFile)).toContain('task-original-1');
    });
});
