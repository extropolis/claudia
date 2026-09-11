/**
 * tasks.json / archived-tasks.json schema envelope.
 *
 * Every other JSON store writes `{ schemaVersion, data }` via
 * utils/schema-version.ts; these two were the holdouts. The invariants:
 *
 *  - a legacy (unversioned) file loads unchanged — its shape IS v1 data
 *  - a fresh save writes the envelope
 *  - the `.bak` recovery path works for both legacy and versioned backups
 *  - a file from a future version is not silently swallowed as empty
 *
 * No CLI spawn here (autoReconnect=false), so this runs on every CI leg.
 * Temp dirs live under homedir(), not os.tmpdir() (macOS /var is blocklisted
 * by validateWorkspacePath).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { TaskSpawner } from '../task-spawner.js';

interface Ctx {
    base: string;
    tasksFile: string;
    archivedFile: string;
    spawner?: TaskSpawner;
}

const active: Ctx[] = [];

function makeCtx(): Ctx {
    const base = mkdtempSync(join(homedir(), '.claudia-envelope-test-'));
    const ctx: Ctx = {
        base,
        tasksFile: join(base, 'tasks.json'),
        archivedFile: join(base, 'archived-tasks.json'),
    };
    active.push(ctx);
    return ctx;
}

function task(id: string, base: string, taskNumber?: number) {
    return {
        id,
        prompt: `prompt for ${id}`,
        workspaceId: base,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActivity: '2026-01-01T00:01:00.000Z',
        lastState: 'idle',
        wasInterrupted: false,
        shouldContinue: false,
        backendType: 'claude-code',
        ...(taskNumber !== undefined ? { taskNumber } : {}),
    };
}

function archived(id: string, base: string) {
    return {
        id,
        prompt: `archived ${id}`,
        workspaceId: base,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActivity: '2026-01-01T00:01:00.000Z',
        sessionId: null,
        historySize: 0,
    };
}

function legacyTasksJson(base: string, ids: string[], extra: Record<string, unknown> = {}) {
    return JSON.stringify({
        tasks: ids.map((id, i) => task(id, base, i + 1)),
        archivedTasks: [],
        nextTaskNumber: ids.length + 1,
        ...extra,
    });
}

function start(ctx: Ctx): TaskSpawner {
    const s = new TaskSpawner(ctx.tasksFile, false);
    ctx.spawner = s;
    return s;
}

function readJson(path: string): any {
    return JSON.parse(readFileSync(path, 'utf8'));
}

function taskIds(s: TaskSpawner): string[] {
    return s.getAllTasks().map(t => t.id).sort();
}

function archivedIds(s: TaskSpawner): string[] {
    return s.getArchivedTasks().map(t => t.id).sort();
}

afterEach(() => {
    vi.restoreAllMocks();
    for (const ctx of active.splice(0)) {
        try { ctx.spawner?.destroy(); } catch { /* best effort */ }
        try { rmSync(ctx.base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
    }
});

describe('tasks.json schema envelope', () => {
    it('loads a legacy unversioned tasks.json with identical tasks', () => {
        const ctx = makeCtx();
        writeFileSync(ctx.tasksFile, legacyTasksJson(ctx.base, ['t-1', 't-2', 't-3'], {
            pendingParentNotifications: { 't-1': [{ childId: 't-2', text: 'done' }] },
        }));

        const s = start(ctx);

        expect(taskIds(s)).toEqual(['t-1', 't-2', 't-3']);
        const t2 = s.getAllTasks().find(t => t.id === 't-2')!;
        expect(t2.prompt).toBe('prompt for t-2');
        expect(t2.taskNumber).toBe(2);
        // nextTaskNumber from the legacy file must survive (next task is #4).
        expect((s as any).nextTaskNumber).toBe(4);
        // Undelivered child→parent notices survive too.
        expect((s as any).pendingParentNotifications.get('t-1')).toEqual([{ childId: 't-2', text: 'done' }]);
    });

    it('writes the { schemaVersion: 1, data } envelope on save', () => {
        const ctx = makeCtx();
        writeFileSync(ctx.tasksFile, legacyTasksJson(ctx.base, ['t-1', 't-2']));
        const s = start(ctx);

        s.saveNow();

        const onDisk = readJson(ctx.tasksFile);
        expect(onDisk.schemaVersion).toBe(1);
        expect(onDisk.data.tasks.map((t: any) => t.id).sort()).toEqual(['t-1', 't-2']);
        expect(onDisk.data.nextTaskNumber).toBe(3);
        // The legacy top-level keys are gone — the file is unambiguously versioned.
        expect(onDisk.tasks).toBeUndefined();
    });

    it('round-trips: a versioned tasks.json loads identically in a fresh spawner', () => {
        const ctx = makeCtx();
        writeFileSync(ctx.tasksFile, legacyTasksJson(ctx.base, ['t-1', 't-2']));
        const first = start(ctx);
        first.saveNow();
        first.destroy();

        const second = new TaskSpawner(ctx.tasksFile, false);
        ctx.spawner = second;
        expect(taskIds(second)).toEqual(['t-1', 't-2']);
        expect((second as any).nextTaskNumber).toBe(3);
    });

    it('does not trip the concurrent-modification guard when a legacy file is rewritten on load', () => {
        const ctx = makeCtx();
        writeFileSync(ctx.tasksFile, legacyTasksJson(ctx.base, ['t-1']));
        const s = start(ctx);
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

        s.saveNow();

        expect(errors.mock.calls.flat().join('\n')).not.toContain('REFUSING TO SAVE');
        expect(readJson(ctx.tasksFile).data.tasks.map((t: any) => t.id)).toEqual(['t-1']);
    });
});

describe('archived-tasks.json schema envelope', () => {
    it('loads a legacy unversioned archived-tasks.json', () => {
        const ctx = makeCtx();
        writeFileSync(ctx.tasksFile, legacyTasksJson(ctx.base, ['t-1']));
        writeFileSync(ctx.archivedFile, JSON.stringify({
            archivedTasks: [archived('a-1', ctx.base), archived('a-2', ctx.base)],
        }));

        const s = start(ctx);

        expect(archivedIds(s)).toEqual(['a-1', 'a-2']);
        expect(s.getArchivedTasks().find(t => t.id === 'a-2')!.prompt).toBe('archived a-2');
        expect(taskIds(s)).toEqual(['t-1']);
    });

    it('writes the { schemaVersion: 1, data } envelope on save', () => {
        const ctx = makeCtx();
        writeFileSync(ctx.tasksFile, legacyTasksJson(ctx.base, ['t-1', 't-2']));
        writeFileSync(ctx.archivedFile, JSON.stringify({ archivedTasks: [archived('a-1', ctx.base)] }));
        const s = start(ctx);

        s.archiveTask('t-1', 'user');
        s.saveNow();

        const onDisk = readJson(ctx.archivedFile);
        expect(onDisk.schemaVersion).toBe(1);
        expect(onDisk.data.archivedTasks.map((t: any) => t.id).sort()).toEqual(['a-1', 't-1']);
        expect(onDisk.archivedTasks).toBeUndefined();
        // And tasks.json no longer carries it as an active task.
        expect(readJson(ctx.tasksFile).data.tasks.map((t: any) => t.id)).toEqual(['t-2']);
    });

    it('round-trips: a versioned archived-tasks.json loads identically', () => {
        const ctx = makeCtx();
        writeFileSync(ctx.tasksFile, legacyTasksJson(ctx.base, ['t-1']));
        writeFileSync(ctx.archivedFile, JSON.stringify({ archivedTasks: [archived('a-1', ctx.base)] }));
        const first = start(ctx);
        first.archiveTask('t-1', 'user');
        first.saveNow();
        first.destroy();

        const second = new TaskSpawner(ctx.tasksFile, false);
        ctx.spawner = second;
        expect(archivedIds(second)).toEqual(['a-1', 't-1']);
        expect(taskIds(second)).toEqual([]);
    });

    it('never replaces a populated versioned archive with an empty one', () => {
        const ctx = makeCtx();
        writeFileSync(ctx.tasksFile, legacyTasksJson(ctx.base, ['t-1']));
        writeFileSync(ctx.archivedFile, JSON.stringify({
            schemaVersion: 1,
            data: { archivedTasks: [archived('a-1', ctx.base)] },
        }));
        const s = start(ctx);
        // Simulate the bug class the guard exists for: in-memory archive lost.
        (s as any).archivedTasks.clear();
        (s as any).archivedDirty = true;
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

        s.saveNow();

        expect(errors.mock.calls.flat().join('\n')).toContain('REFUSING to save archived tasks');
        expect(readJson(ctx.archivedFile).data.archivedTasks.map((t: any) => t.id)).toEqual(['a-1']);
    });
});

// The debounced background save (saveTasksAsync / saveArchivedTasksAsync) is the
// path that runs most. It was added separately from the sync path, and without
// these tests it kept writing bare JSON and reading the on-disk file raw, which
// silently disabled the never-overwrite-with-empty guard against any file the
// sync path had already wrapped in the envelope.
describe('async (debounced) save path', () => {
    it('writes the tasks.json envelope, same as the sync path', async () => {
        const ctx = makeCtx();
        writeFileSync(ctx.tasksFile, legacyTasksJson(ctx.base, ['t-1', 't-2']));
        const s = start(ctx);

        await (s as any).saveTasksAsync();

        const onDisk = readJson(ctx.tasksFile);
        expect(onDisk.schemaVersion).toBe(1);
        expect(onDisk.data.tasks.map((t: any) => t.id).sort()).toEqual(['t-1', 't-2']);
        expect(onDisk.tasks).toBeUndefined();
    });

    it('never replaces a populated VERSIONED tasks.json with empty state', async () => {
        const ctx = makeCtx();
        writeFileSync(ctx.tasksFile, legacyTasksJson(ctx.base, ['t-1', 't-2']));
        const s = start(ctx);
        s.saveNow(); // the sync path wraps the file in the envelope
        expect(readJson(ctx.tasksFile).schemaVersion).toBe(1);
        // The bug class the guard exists for: in-memory state lost.
        (s as any).tasks.clear();
        (s as any).disconnectedTasks.clear();
        (s as any).archivedTasks.clear();
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

        await (s as any).saveTasksAsync();

        expect(errors.mock.calls.flat().join('\n')).toContain('REFUSING to save');
        expect(readJson(ctx.tasksFile).data.tasks.map((t: any) => t.id).sort()).toEqual(['t-1', 't-2']);
    });

    it('writes the archived-tasks.json envelope, same as the sync path', async () => {
        const ctx = makeCtx();
        writeFileSync(ctx.tasksFile, legacyTasksJson(ctx.base, ['t-1']));
        const s = start(ctx);

        await (s as any).saveArchivedTasksAsync([archived('a-1', ctx.base)]);

        const onDisk = readJson(ctx.archivedFile);
        expect(onDisk.schemaVersion).toBe(1);
        expect(onDisk.data.archivedTasks.map((t: any) => t.id)).toEqual(['a-1']);
        expect(onDisk.archivedTasks).toBeUndefined();
    });

    it('never replaces a populated VERSIONED archive with an empty one', async () => {
        const ctx = makeCtx();
        writeFileSync(ctx.tasksFile, legacyTasksJson(ctx.base, ['t-1']));
        writeFileSync(ctx.archivedFile, JSON.stringify({
            schemaVersion: 1,
            data: { archivedTasks: [archived('a-1', ctx.base)] },
        }));
        const s = start(ctx);
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

        await (s as any).saveArchivedTasksAsync([]);

        expect(errors.mock.calls.flat().join('\n')).toContain('REFUSING to save archived tasks');
        expect(readJson(ctx.archivedFile).data.archivedTasks.map((t: any) => t.id)).toEqual(['a-1']);
    });
});

describe('future schema versions', () => {
    it('does not silently swallow a tasks.json from a newer version as empty', () => {
        const ctx = makeCtx();
        writeFileSync(ctx.tasksFile, JSON.stringify({
            schemaVersion: 999,
            data: { tasks: [task('t-future', ctx.base, 1)], archivedTasks: [], nextTaskNumber: 2 },
        }));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const s = start(ctx);

        // loadVersioned passes newer data through untouched; it must be loud about it.
        expect(taskIds(s)).toEqual(['t-future']);
        expect(warn.mock.calls.flat().join('\n')).toMatch(/schemaVersion 999|v999/);
    });

    it('does not silently swallow an archived-tasks.json from a newer version', () => {
        const ctx = makeCtx();
        writeFileSync(ctx.tasksFile, legacyTasksJson(ctx.base, []));
        writeFileSync(ctx.archivedFile, JSON.stringify({
            schemaVersion: 999,
            data: { archivedTasks: [archived('a-future', ctx.base)] },
        }));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const s = start(ctx);

        expect(archivedIds(s)).toEqual(['a-future']);
        expect(warn.mock.calls.flat().join('\n')).toMatch(/schemaVersion 999|v999/);
    });
});

describe('.bak recovery', () => {
    it('recovers from a corrupt main file using a legacy (unversioned) .bak', () => {
        const ctx = makeCtx();
        writeFileSync(ctx.tasksFile, '{"tasks": [{"id": "t-1", "pro');
        writeFileSync(ctx.tasksFile + '.bak', legacyTasksJson(ctx.base, ['t-1', 't-2']));

        const s = start(ctx);

        expect(taskIds(s)).toEqual(['t-1', 't-2']);
    });

    it('recovers from a corrupt main file using a versioned .bak', () => {
        const ctx = makeCtx();
        writeFileSync(ctx.tasksFile, 'not json at all');
        writeFileSync(ctx.tasksFile + '.bak', JSON.stringify({
            schemaVersion: 1,
            data: { tasks: [task('t-1', ctx.base, 1), task('t-2', ctx.base, 2)], archivedTasks: [], nextTaskNumber: 3 },
        }));

        const s = start(ctx);

        expect(taskIds(s)).toEqual(['t-1', 't-2']);
        expect((s as any).nextTaskNumber).toBe(3);
    });

    it('recovers from an EMPTY versioned main file when the .bak has tasks', () => {
        const ctx = makeCtx();
        writeFileSync(ctx.tasksFile, JSON.stringify({ schemaVersion: 1, data: { tasks: [], archivedTasks: [] } }));
        writeFileSync(ctx.tasksFile + '.bak', JSON.stringify({
            schemaVersion: 1,
            data: { tasks: [task('t-1', ctx.base, 1)], archivedTasks: [] },
        }));

        const s = start(ctx);

        expect(taskIds(s)).toEqual(['t-1']);
    });

    it('prefers a populated versioned main file over a legacy .bak', () => {
        const ctx = makeCtx();
        writeFileSync(ctx.tasksFile, JSON.stringify({
            schemaVersion: 1,
            data: { tasks: [task('t-new', ctx.base, 1)], archivedTasks: [] },
        }));
        writeFileSync(ctx.tasksFile + '.bak', legacyTasksJson(ctx.base, ['t-old']));

        const s = start(ctx);

        expect(taskIds(s)).toEqual(['t-new']);
        expect(existsSync(ctx.tasksFile + '.bak')).toBe(true);
    });
});
