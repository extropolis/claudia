/**
 * The tasks.json "modified by another process — REFUSING TO SAVE" guard.
 *
 * Two server instances against one state dir (the classic tsx-watch double
 * start) would otherwise let the older instance's in-memory task map clobber
 * the newer instance's file, losing every task created in between.
 *
 * The point of these tests is that the guard actually PREVENTS the write —
 * asserting only that it logs would pass even if the overwrite still happened.
 *
 * No CLI spawn here, so this runs on the Windows CI leg too. Temp dirs live
 * under homedir(), not os.tmpdir() (macOS /var is blocklisted by
 * validateWorkspacePath).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, utimesSync, statSync } from 'fs';
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

/** Rewrite the file as a "different process" would, with a strictly newer mtime. */
function foreignWrite(path: string, content: string): void {
    writeFileSync(path, content);
    const future = new Date(Date.now() + 5000);
    utimesSync(path, future, future);
}

afterEach(() => {
    for (const ctx of active.splice(0)) {
        try { ctx.spawner?.destroy(); } catch { /* best effort */ }
        try { rmSync(ctx.base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
    }
});

describe('tasks.json concurrent-modification guard', () => {
    it('REFUSES to overwrite a file another process modified after we loaded it', () => {
        const ctx = seed(['task-original-1']);
        const s = startSpawner(ctx);

        // Another instance writes tasks we have never seen.
        const foreign = JSON.stringify({
            tasks: [{ id: 'task-from-other-process', prompt: 'do not lose me' }],
            archivedTasks: [],
        });
        foreignWrite(ctx.tasksFile, foreign);

        s.saveNow();

        // The guard must PREVENT the write, not merely complain about it.
        expect(readFileSync(ctx.tasksFile, 'utf8')).toBe(foreign);
        expect(readFileSync(ctx.tasksFile, 'utf8')).toContain('task-from-other-process');
        expect(readFileSync(ctx.tasksFile, 'utf8')).not.toContain('task-original-1');
    });

    it('still refuses on a later save attempt (the guard is not one-shot)', () => {
        const ctx = seed(['task-original-1']);
        const s = startSpawner(ctx);

        const foreign = JSON.stringify({ tasks: [{ id: 'task-from-other-process' }], archivedTasks: [] });
        foreignWrite(ctx.tasksFile, foreign);

        s.saveNow();
        s.saveNow();
        s.saveNow();

        expect(readFileSync(ctx.tasksFile, 'utf8')).toBe(foreign);
    });

    it('does not leave a partial or backup write behind when it refuses', () => {
        const ctx = seed(['task-original-1']);
        const s = startSpawner(ctx);

        const foreign = JSON.stringify({ tasks: [], archivedTasks: [] });
        foreignWrite(ctx.tasksFile, foreign);
        const sizeBefore = statSync(ctx.tasksFile).size;

        s.saveNow();

        expect(statSync(ctx.tasksFile).size).toBe(sizeBefore);
        expect(readFileSync(ctx.tasksFile, 'utf8')).toBe(foreign);
    });

    // Positive control: without the guard tripping, saving MUST work — otherwise
    // the tests above would pass against a spawner that simply never saves.
    it('saves normally when the file has not been touched by anyone else', () => {
        const ctx = seed(['task-original-1']);
        const s = startSpawner(ctx);

        s.saveNow();

        const written = readFileSync(ctx.tasksFile, 'utf8');
        expect(written).toContain('task-original-1');
        const parsed = JSON.parse(written);
        const tasks = parsed.data?.tasks ?? parsed.tasks;
        expect(tasks.map((t: { id: string }) => t.id)).toContain('task-original-1');
    });

    it('keeps saving across repeated saves once it has adopted its own mtime', () => {
        const ctx = seed(['task-original-1']);
        const s = startSpawner(ctx);

        // The first save rewrites the file and must re-record the new mtime;
        // if it did not, the spawner would refuse to save its OWN writes.
        s.saveNow();
        writeFileSync(join(ctx.base, 'marker'), 'x');
        s.saveNow();

        expect(readFileSync(ctx.tasksFile, 'utf8')).toContain('task-original-1');
    });
});
