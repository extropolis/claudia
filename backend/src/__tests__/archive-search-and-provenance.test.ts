/**
 * Archive provenance (`source`) and archived-task deep search.
 *
 * Regression targets:
 *  - archiveTask records who triggered the archive (user/mcp/workspace-reset/unknown)
 *  - ensureFallbackTitle never overwrites an existing or user-locked title
 *  - searchArchivedTasks matches metadata by default, and only scans (base64)
 *    history when `deep` is requested
 *
 * Temp dirs live under homedir(), not os.tmpdir() — macOS /var is blocklisted
 * by validateWorkspacePath.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { TaskSpawner } from '../task-spawner.js';

interface Ctx {
    base: string;
    tasksFile: string;
    spawner?: TaskSpawner;
}

const active: Ctx[] = [];

function seed(tasks: object[]): Ctx {
    const base = mkdtempSync(join(homedir(), '.claudia-archive-test-'));
    const tasksFile = join(base, 'tasks.json');
    writeFileSync(tasksFile, JSON.stringify({ tasks, archivedTasks: [] }));
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

describe('archiveTask provenance', () => {
    it('logs the given source without throwing when omitted', () => {
        const ctx = seed([persisted('task-a', '2026-08-01T12:00:00.000Z')]);
        const s = start(ctx);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        s.archiveTask('task-a', 'mcp');

        expect(logSpy.mock.calls.some(args => String(args[0]).includes('source: mcp'))).toBe(true);
        logSpy.mockRestore();

        const archived = s.getArchivedTasks();
        expect(archived.map(t => t.id)).toContain('task-a');
    });

    it('defaults to "unknown" when no source is passed', () => {
        const ctx = seed([persisted('task-b', '2026-08-01T12:00:00.000Z')]);
        const s = start(ctx);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        s.archiveTask('task-b');

        expect(logSpy.mock.calls.some(args => String(args[0]).includes('source: unknown'))).toBe(true);
        logSpy.mockRestore();
    });
});

describe('ensureFallbackTitle', () => {
    it('derives a title from the prompt when none is set', () => {
        const ctx = seed([persisted('task-c', '2026-08-01T12:00:00.000Z', {
            prompt: 'investigate the websocket reconnection bug in prod',
        })]);
        const s = start(ctx);

        s.ensureFallbackTitle('task-c');

        const task = s.getAllTasks().find(t => t.id === 'task-c');
        expect(task?.displayName).toBe('investigate the websocket reconnection bug in prod');
        expect(task?.displayNameEditedByUser).toBeFalsy();
    });

    it('does not overwrite a user-set title', () => {
        const ctx = seed([persisted('task-d', '2026-08-01T12:00:00.000Z', {
            prompt: 'investigate the websocket reconnection bug in prod',
            displayName: 'My custom title',
            displayNameEditedByUser: true,
        })]);
        const s = start(ctx);

        s.ensureFallbackTitle('task-d');

        const task = s.getAllTasks().find(t => t.id === 'task-d');
        expect(task?.displayName).toBe('My custom title');
    });

    it('skips a generic candidate and leaves the task untitled', () => {
        const ctx = seed([persisted('task-e', '2026-08-01T12:00:00.000Z', { prompt: 'checkout head of main.' })]);
        const s = start(ctx);

        s.ensureFallbackTitle('task-e');

        const task = s.getAllTasks().find(t => t.id === 'task-e');
        expect(task?.displayName).toBeUndefined();
    });
});

describe('searchArchivedTasks', () => {
    it('matches on metadata without needing `deep`', () => {
        const ctx = seed([persisted('task-f', '2026-08-01T12:00:00.000Z', {
            prompt: 'triage the CWE-184 sandbox bypass',
        })]);
        const s = start(ctx);
        s.archiveTask('task-f', 'user');

        const results = s.searchArchivedTasks('cwe-184');
        expect(results).toHaveLength(1);
        expect(results[0].matchedIn).toContain('prompt');
    });

    it('only finds a history-only hit when deep is requested', () => {
        const ctx = seed([persisted('task-g', '2026-08-01T12:00:00.000Z', { prompt: 'generic task' })]);
        const s = start(ctx);
        s.archiveTask('task-g', 'user');

        // Write archived history directly, simulating terminal output that never
        // appeared in the prompt/title — the only case deep search exists for.
        const historyDir = join(ctx.base, 'archived-histories');
        mkdirSync(historyDir, { recursive: true });
        const plain = 'agent output mentioning SWSPLAT-42455 in the logs';
        writeFileSync(join(historyDir, 'task-g.txt'), Buffer.from(plain, 'utf-8').toString('base64'));

        const shallow = s.searchArchivedTasks('swsplat-42455');
        expect(shallow).toHaveLength(0);

        const deep = s.searchArchivedTasks('swsplat-42455', { deep: true });
        expect(deep).toHaveLength(1);
        expect(deep[0].matchedIn).toContain('history');
        expect(deep[0].snippet?.toLowerCase()).toContain('swsplat-42455');
    });

    it('returns nothing for an empty query', () => {
        const ctx = seed([]);
        const s = start(ctx);
        expect(s.searchArchivedTasks('')).toEqual([]);
    });
});
