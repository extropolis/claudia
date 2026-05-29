import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
    TaskPersistenceManager,
    PersistedTask,
    ArchivedTaskMetadata,
} from '../task-persistence.js';

const TASKS_SCHEMA_VERSION = 1;

function makeTask(overrides: Partial<PersistedTask> = {}): PersistedTask {
    return {
        id: 'task-1',
        prompt: 'do something',
        workspaceId: 'ws-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActivity: '2026-01-01T00:01:00.000Z',
        lastState: 'idle' as PersistedTask['lastState'],
        sessionId: 'sess-1',
        ...overrides,
    };
}

function makeArchived(overrides: Partial<ArchivedTaskMetadata> = {}): ArchivedTaskMetadata {
    return {
        id: 'arch-1',
        prompt: 'archived prompt',
        workspaceId: 'ws-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActivity: '2026-01-01T00:01:00.000Z',
        sessionId: null,
        ...overrides,
    };
}

describe('TaskPersistenceManager', () => {
    let testBaseDir: string;
    let persistencePath: string;
    let manager: TaskPersistenceManager;

    beforeEach(() => {
        const uniqueId = Date.now() + '-' + Math.random().toString(36).substring(7);
        testBaseDir = join(homedir(), '.claudia-task-persist-test-' + uniqueId);
        mkdirSync(testBaseDir, { recursive: true });
        persistencePath = join(testBaseDir, 'tasks.json');
        manager = new TaskPersistenceManager(persistencePath);
    });

    afterEach(() => {
        try {
            rmSync(testBaseDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {
            // Ignore cleanup errors
        }
    });

    describe('path helpers', () => {
        it('derives history dirs relative to the persistence path', () => {
            expect(manager.getHistoryDir()).toBe(join(testBaseDir, 'task-histories'));
            expect(manager.getArchivedHistoryDir()).toBe(join(testBaseDir, 'archived-histories'));
        });

        it('builds per-task history file paths', () => {
            expect(manager.getTaskHistoryPath('abc')).toBe(join(testBaseDir, 'task-histories', 'abc.txt'));
            expect(manager.getArchivedHistoryPath('xyz')).toBe(join(testBaseDir, 'archived-histories', 'xyz.txt'));
        });

        it('ensureHistoryDir creates the directory', () => {
            expect(existsSync(manager.getHistoryDir())).toBe(false);
            manager.ensureHistoryDir();
            expect(existsSync(manager.getHistoryDir())).toBe(true);
        });

        it('ensureArchivedHistoryDir creates the directory', () => {
            expect(existsSync(manager.getArchivedHistoryDir())).toBe(false);
            manager.ensureArchivedHistoryDir();
            expect(existsSync(manager.getArchivedHistoryDir())).toBe(true);
        });
    });

    describe('saveTasks / loadPersistedTasks round-trip', () => {
        it('round-trips active and archived tasks', () => {
            const tasks = [makeTask({ id: 't1' }), makeTask({ id: 't2', prompt: 'second' })];
            const archived = [makeArchived({ id: 'a1', historySize: 123 })];

            manager.saveTasks(tasks, archived);
            const loaded = manager.loadPersistedTasks();

            expect(loaded.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
            expect(loaded.tasks[1].prompt).toBe('second');
            expect(loaded.archivedTasks).toHaveLength(1);
            expect(loaded.archivedTasks[0].id).toBe('a1');
            expect(loaded.archivedTasks[0].historySize).toBe(123);
            expect(loaded.migratedCount).toBe(0);
        });

        it('writes a versioned envelope to disk', () => {
            manager.saveTasks([makeTask()], []);
            const raw = JSON.parse(readFileSync(persistencePath, 'utf-8'));
            expect(raw.schemaVersion).toBe(TASKS_SCHEMA_VERSION);
            expect(raw.data.tasks).toHaveLength(1);
            expect(raw.data.archivedTasks).toEqual([]);
        });

        it('creates the persistence parent directory if missing', () => {
            const nestedPath = join(testBaseDir, 'sub', 'dir', 'tasks.json');
            const m = new TaskPersistenceManager(nestedPath);
            m.saveTasks([makeTask()], []);
            expect(existsSync(nestedPath)).toBe(true);
        });
    });

    describe('loadPersistedTasks edge cases', () => {
        it('returns empty result when file is missing', () => {
            const loaded = manager.loadPersistedTasks();
            expect(loaded.tasks).toEqual([]);
            expect(loaded.archivedTasks).toEqual([]);
            expect(loaded.migratedCount).toBe(0);
        });

        it('falls back to defaults on corrupted JSON', () => {
            writeFileSync(persistencePath, 'not valid json {{{');
            const loaded = manager.loadPersistedTasks();
            expect(loaded.tasks).toEqual([]);
            expect(loaded.archivedTasks).toEqual([]);
        });

        it('reads a legacy unversioned file via the legacy loader', () => {
            // Legacy format = raw TaskPersistence object with no schemaVersion.
            const legacy = {
                tasks: [makeTask({ id: 'legacy-1' })],
                archivedTasks: [makeArchived({ id: 'legacy-arch' })],
            };
            writeFileSync(persistencePath, JSON.stringify(legacy));

            const loaded = manager.loadPersistedTasks();
            expect(loaded.tasks.map((t) => t.id)).toEqual(['legacy-1']);
            expect(loaded.archivedTasks.map((t) => t.id)).toEqual(['legacy-arch']);

            // Loading a legacy file upgrades it to the versioned envelope on disk.
            const raw = JSON.parse(readFileSync(persistencePath, 'utf-8'));
            expect(raw.schemaVersion).toBe(TASKS_SCHEMA_VERSION);
        });

        it('handles a versioned file that omits archivedTasks', () => {
            const m = new TaskPersistenceManager(persistencePath);
            // Save with empty archived, then hand-write a file without the key.
            writeFileSync(
                persistencePath,
                JSON.stringify({ schemaVersion: TASKS_SCHEMA_VERSION, data: { tasks: [makeTask({ id: 'only' })] } })
            );
            const loaded = m.loadPersistedTasks();
            expect(loaded.tasks.map((t) => t.id)).toEqual(['only']);
            expect(loaded.archivedTasks).toEqual([]);
        });
    });

    describe('outputHistory migration', () => {
        it('migrates an embedded active-task outputHistory to a file and strips it', () => {
            const legacy = {
                tasks: [makeTask({ id: 'mig-1', outputHistory: 'embedded history content' })],
                archivedTasks: [],
            };
            writeFileSync(persistencePath, JSON.stringify(legacy));

            const loaded = manager.loadPersistedTasks();
            // outputHistory removed from the in-memory task.
            expect(loaded.tasks[0].outputHistory).toBeUndefined();
            // History written to the per-task file (raw, not base64 — this is the
            // migration path which writes the string directly).
            const histPath = manager.getTaskHistoryPath('mig-1');
            expect(existsSync(histPath)).toBe(true);
            expect(readFileSync(histPath, 'utf-8')).toBe('embedded history content');
        });

        it('migrates an embedded archived outputHistory and counts it', () => {
            const legacy = {
                tasks: [],
                archivedTasks: [{ ...makeArchived({ id: 'amig-1' }), outputHistory: 'YQ==' }],
            };
            writeFileSync(persistencePath, JSON.stringify(legacy));

            const loaded = manager.loadPersistedTasks();
            expect(loaded.migratedCount).toBe(1);
            const archPath = manager.getArchivedHistoryPath('amig-1');
            expect(existsSync(archPath)).toBe(true);
            expect(readFileSync(archPath, 'utf-8')).toBe('YQ==');

            // historySize derived from embedded length * 0.75.
            const expectedSize = Math.floor('YQ=='.length * 0.75);
            expect(loaded.archivedTasks[0].historySize).toBe(expectedSize);
        });

        it('keeps existing historySize when no embedded archived history', () => {
            manager.saveTasks([], [makeArchived({ id: 'a', historySize: 999 })]);
            const loaded = manager.loadPersistedTasks();
            expect(loaded.migratedCount).toBe(0);
            expect(loaded.archivedTasks[0].historySize).toBe(999);
        });
    });

    describe('task history files (base64)', () => {
        it('saves and loads a task history round-trip', () => {
            const data = Buffer.from('terminal output \x1b[0m bytes');
            manager.saveTaskHistory('h1', [data]);

            expect(manager.hasHistoryFile('h1')).toBe(true);
            const loaded = manager.loadTaskHistory('h1');
            expect(loaded.truncated).toBe(false);
            expect(loaded.buffer).not.toBeNull();
            expect(Buffer.compare(loaded.buffer!, data)).toBe(0);
        });

        it('persists history as base64 on disk', () => {
            const data = Buffer.from('hello');
            manager.saveTaskHistory('h2', [data]);
            const onDisk = readFileSync(manager.getTaskHistoryPath('h2'), 'utf-8');
            expect(onDisk).toBe(data.toString('base64'));
        });

        it('concatenates previousHistory ahead of new buffers', () => {
            const prev = Buffer.from('AAA');
            const next = Buffer.from('BBB');
            manager.saveTaskHistory('h3', [next], prev);
            const loaded = manager.loadTaskHistory('h3');
            expect(loaded.buffer!.toString()).toBe('AAABBB');
        });

        it('returns null buffer for a missing history file', () => {
            const loaded = manager.loadTaskHistory('does-not-exist');
            expect(loaded.buffer).toBeNull();
            expect(loaded.truncated).toBe(false);
            expect(manager.hasHistoryFile('does-not-exist')).toBe(false);
        });

        it('loads only the tail and marks truncated when over maxSize', () => {
            // Build a base64 payload large enough to exceed our maxSize cap.
            const raw = Buffer.alloc(4096, 0x41); // 4KB of 'A'
            manager.saveTaskHistory('h4', [raw]);

            const maxSize = 128; // bytes of the base64 file to read from the tail
            const loaded = manager.loadTaskHistory('h4', maxSize);
            expect(loaded.truncated).toBe(true);
            expect(loaded.buffer).not.toBeNull();
            // Tail of a base64 string of repeated 'A' decodes to repeated 'A' bytes.
            expect(loaded.buffer!.every((b) => b === 0x41)).toBe(true);
        });

        it('reads the whole file when under maxSize (not truncated)', () => {
            const data = Buffer.from('small');
            manager.saveTaskHistory('h5', [data]);
            const loaded = manager.loadTaskHistory('h5', 10_000);
            expect(loaded.truncated).toBe(false);
            expect(Buffer.compare(loaded.buffer!, data)).toBe(0);
        });

        it('writes an empty history file when no buffers and file absent', () => {
            manager.saveTaskHistory('h6', []);
            expect(manager.hasHistoryFile('h6')).toBe(true);
            const loaded = manager.loadTaskHistory('h6');
            expect(loaded.buffer!.length).toBe(0);
        });
    });

    describe('archived history files', () => {
        it('saves, loads, and deletes archived history', () => {
            manager.saveArchivedHistory('arch-x', 'base64orwhatever');
            expect(manager.loadArchivedHistory('arch-x')).toBe('base64orwhatever');

            const deleted = manager.deleteArchivedHistory('arch-x');
            expect(deleted).toBe(true);
            expect(manager.loadArchivedHistory('arch-x')).toBeNull();
        });

        it('returns null when loading a missing archived history', () => {
            expect(manager.loadArchivedHistory('nope')).toBeNull();
        });

        it('returns false when deleting a missing archived history', () => {
            expect(manager.deleteArchivedHistory('nope')).toBe(false);
        });
    });

    describe('debounced save', () => {
        it('invokes the callback after the debounce window', async () => {
            let calls = 0;
            manager.scheduleSave(() => {
                calls++;
            });
            await new Promise((r) => setTimeout(r, 700));
            expect(calls).toBe(1);
        });

        it('coalesces rapid scheduleSave calls into one', async () => {
            let calls = 0;
            const cb = () => {
                calls++;
            };
            manager.scheduleSave(cb);
            manager.scheduleSave(cb);
            manager.scheduleSave(cb);
            await new Promise((r) => setTimeout(r, 700));
            expect(calls).toBe(1);
        });

        it('clearDebounceTimer cancels a pending save', async () => {
            let calls = 0;
            manager.scheduleSave(() => {
                calls++;
            });
            manager.clearDebounceTimer();
            await new Promise((r) => setTimeout(r, 700));
            expect(calls).toBe(0);
        });
    });

    describe('persistence survives a fresh manager instance', () => {
        it('a new manager reads what the previous one saved', () => {
            manager.saveTasks([makeTask({ id: 'persist-1' })], [makeArchived({ id: 'persist-arch' })]);
            const fresh = new TaskPersistenceManager(persistencePath);
            const loaded = fresh.loadPersistedTasks();
            expect(loaded.tasks.map((t) => t.id)).toEqual(['persist-1']);
            expect(loaded.archivedTasks.map((t) => t.id)).toEqual(['persist-arch']);
        });
    });
});
