import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { CronScheduler } from '../cron-scheduler.js';
import { SharedMcpManager } from '../shared-mcp-manager.js';
import { LEGACY_DATA_DIR, DATA_DIR_ENV } from '../paths.js';
import { createApp } from '../server.js';
import { WSClient } from './helpers/ws-harness.js';
import { getAuthToken } from '../auth-token.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Guards the stores that gained a data-directory parameter in #188.
 *
 * ConfigStore, WorkspaceStore, and LearningsStore already had a `basePath`
 * seam (added for Electron) and are covered by their own suites. CronScheduler
 * and SupervisorChat wrote to module-level `join(__dirname, '..')` constants
 * with no override at all — a container would have written their state inside
 * the image layer, losing every schedule on redeploy. These tests exist so that
 * regression is caught rather than discovered after a deploy.
 */
describe('data directory wiring', () => {
    const created: string[] = [];

    // CronScheduler debounces saves by 1s; drive that deterministically
    // instead of sleeping in four separate tests.
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        for (const dir of created.splice(0)) {
            try {
                rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            } catch {
                // Ignore cleanup errors
            }
        }
    });

    function tempDir(): string {
        const dir = mkdtempSync(join(tmpdir(), 'claudia-wiring-'));
        created.push(dir);
        return dir;
    }

    const noopFire = () => { /* not exercised */ };
    const alwaysIdle = () => 'idle' as const;

    /** Advance past the debounce window so the save actually lands. */
    const flushSave = () => vi.advanceTimersByTime(1_100);

    describe('CronScheduler', () => {
        it('persists schedules under the configured data directory', () => {
            const dataDir = tempDir();
            const scheduler = new CronScheduler(noopFire, alwaysIdle, dataDir);

            scheduler.create('task-1', 'ws-1', '*/5 * * * *', 'ping');
            flushSave();

            const file = join(dataDir, 'scheduled-tasks.json');
            expect(existsSync(file)).toBe(true);
            expect(readFileSync(file, 'utf-8')).toContain('ping');
        });

        it('does not write to the legacy location when a data directory is set', () => {
            const dataDir = tempDir();
            const legacyFile = join(LEGACY_DATA_DIR, 'scheduled-tasks.json');
            const legacyBefore = existsSync(legacyFile)
                ? readFileSync(legacyFile, 'utf-8')
                : null;

            const scheduler = new CronScheduler(noopFire, alwaysIdle, dataDir);
            scheduler.create('task-2', 'ws-1', '0 * * * *', 'should-not-leak');
            flushSave();

            const legacyAfter = existsSync(legacyFile)
                ? readFileSync(legacyFile, 'utf-8')
                : null;
            expect(legacyAfter).toBe(legacyBefore);
            if (legacyAfter !== null) {
                expect(legacyAfter).not.toContain('should-not-leak');
            }
        });

        it('reloads persisted schedules from the same data directory', () => {
            const dataDir = tempDir();

            const first = new CronScheduler(noopFire, alwaysIdle, dataDir);
            const createdTask = first.create('task-3', 'ws-1', '*/10 * * * *', 'survives-restart');
            flushSave();

            // A second instance stands in for a process restart — the point of a
            // persistent volume is that state outlives the container.
            const second = new CronScheduler(noopFire, alwaysIdle, dataDir);
            const reloaded = second.getForTask('task-3');

            expect(reloaded.map(t => t.id)).toContain(createdTask.id);
            expect(reloaded[0].prompt).toBe('survives-restart');
        });

        it('isolates two schedulers pointed at different data directories', () => {
            const dirA = tempDir();
            const dirB = tempDir();

            new CronScheduler(noopFire, alwaysIdle, dirA)
                .create('task-a', 'ws-1', '*/5 * * * *', 'only-in-a');
            flushSave();

            const b = new CronScheduler(noopFire, alwaysIdle, dirB);
            expect(b.getForTask('task-a')).toHaveLength(0);
        });
    });

    /**
     * The call site, not the store.
     *
     * TodoStore and CheckpointStore both HAVE a working `basePath` seam and are
     * covered by their own suites — yet the server still wrote
     * `backend/todos.json` and `backend/checkpoints.json` into the source tree
     * for every non-Electron instance. The bug was in `createApp`: it handed
     * CheckpointStore `basePath` (Electron's userData — `undefined` under
     * CLAUDIA_DATA_DIR) and TodoStore nothing at all, so both fell back to
     * `join(__dirname, '..')`, outside the configured data directory and on top
     * of a developer's live instance.
     *
     * The behavioural tests further down prove today's two stores land in the
     * data dir. These structural guards catch the NEXT store someone wires up
     * the same wrong way: once `dataDir` has been resolved from it, `basePath`
     * must never be read again, and no store may be built with no argument.
     */
    describe('createApp wiring', () => {
        it('uses basePath only to resolve dataDir, never to construct a store', () => {
            const source = readFileSync(join(HERE, '..', 'server.ts'), 'utf-8');
            const start = source.indexOf('export async function createApp(');
            expect(start, 'createApp not found in server.ts').toBeGreaterThan(-1);

            const uses = source
                .slice(start)
                .split('\n')
                .filter((line) => /\bbasePath\b/.test(line))
                // Comments explain the rule; they are not uses of the value.
                .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
                // The parameter declaration and the one legitimate read.
                .filter((line) => !/export async function createApp\(/.test(line))
                .filter((line) => !/ensureDataDir\(basePath\)/.test(line))
                .map((line) => line.trim());

            expect(
                uses,
                'basePath is undefined unless Electron supplies it — stores must take dataDir',
            ).toEqual([]);
        });

        it('constructs no state-writing store with an empty argument list', () => {
            const source = readFileSync(join(HERE, '..', 'server.ts'), 'utf-8');
            const start = source.indexOf('export async function createApp(');
            const body = source.slice(start);

            // `new FooStore()` with no argument silently selects the legacy
            // in-source-tree path in every store that has a `basePath?` seam.
            const argless = [...body.matchAll(/new\s+(\w*Store)\s*\(\s*\)/g)].map((m) => m[1]);

            expect(argless, 'a store constructed with no data directory writes to backend/').toEqual([]);
        });
    });

    describe('SharedMcpManager', () => {
        it('puts the pid and log files under the configured data directory', () => {
            const dataDir = tempDir();
            const m = new SharedMcpManager(4999, { dataDir });

            expect(m.pidFile.startsWith(dataDir)).toBe(true);
            expect(m.logFile.startsWith(dataDir)).toBe(true);
            expect(m.pidFile).toBe(join(dataDir, '.shared-playwright-mcp-4999.pid'));
        });

        it('falls back to the legacy backend/ location without a data directory', () => {
            const m = new SharedMcpManager(4999);
            expect(m.pidFile).toBe(join(LEGACY_DATA_DIR, '.shared-playwright-mcp-4999.pid'));
            expect(m.logFile).toBe(join(LEGACY_DATA_DIR, '.shared-playwright-mcp-4999.log'));
        });
    });
});

/**
 * Server-level wiring. The stores below already accepted a base path; the bug
 * was that createApp() either never passed one (TodoStore) or passed the raw
 * `basePath` argument instead of the resolved data dir (CheckpointStore), so
 * setting CLAUDIA_DATA_DIR alone — the container / home-server case, where
 * `basePath` is undefined — silently kept writing into backend/.
 *
 * createApp() is booted with NO explicit basePath on purpose: that is the
 * only configuration that reproduces the bug.
 */
describe('createApp data directory wiring', () => {
    let dataDir: string;
    let homeDir: string;
    let parts: Awaited<ReturnType<typeof createApp>>;
    let port: number;
    const saved: Record<string, string | undefined> = {};

    const setEnv = (k: string, v: string | undefined) => {
        if (!(k in saved)) saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    };

    beforeAll(async () => {
        // Under homedir(), never os.tmpdir(): on macOS /tmp lives under /var,
        // which validateWorkspacePath blocklists.
        homeDir = mkdtempSync(join(homedir(), '.claudia-datadir-test-'));
        dataDir = join(homeDir, 'state');
        setEnv('HOME', homeDir);
        setEnv('USERPROFILE', homeDir);
        setEnv(DATA_DIR_ENV, dataDir);
        setEnv('CLAUDIA_SHARED_MCP', '0');

        parts = await createApp();
        await new Promise<void>(resolve => parts.server.listen(0, '127.0.0.1', () => resolve()));
        port = (parts.server.address() as { port: number }).port;
    });

    afterAll(async () => {
        try { await parts?.shutdownForTests(); } catch { /* best effort */ }
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        try {
            rmSync(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {
            // Ignore cleanup errors
        }
    });

    const snapshot = (file: string) => existsSync(file) ? readFileSync(file, 'utf-8') : null;

    it('writes todos.json under CLAUDIA_DATA_DIR, not backend/', async () => {
        const legacyFile = join(LEGACY_DATA_DIR, 'todos.json');
        const legacyBefore = snapshot(legacyFile);
        const marker = `todo-wiring-${Date.now()}`;

        const res = await fetch(`http://127.0.0.1:${port}/api/tasks/task-wiring/todos`, {
            method: 'POST',
            // Every /api route requires the token (#261); mint it from the same
            // data dir the server under test is using.
            headers: { 'Content-Type': 'application/json', 'x-claudia-token': getAuthToken(dataDir) },
            body: JSON.stringify({ title: marker }),
        });
        expect(res.status).toBe(200);

        const file = join(dataDir, 'todos.json');
        expect(existsSync(file)).toBe(true);
        expect(readFileSync(file, 'utf-8')).toContain(marker);

        expect(snapshot(legacyFile)).toBe(legacyBefore);
    });

    it('writes checkpoints.json under CLAUDIA_DATA_DIR, not backend/', async () => {
        const legacyFile = join(LEGACY_DATA_DIR, 'checkpoints.json');
        const legacyBefore = snapshot(legacyFile);
        const marker = `checkpoint-wiring-${Date.now()}`;

        // Any directory works as a checkpoint target — a non-git dir just
        // records no ref. Keep it under the sandboxed home.
        const wsDir = join(homeDir, 'ws');
        mkdirSync(wsDir, { recursive: true });

        const client = await WSClient.connect(port, getAuthToken(dataDir));
        try {
            const frame = await client.request(
                'checkpoint:create',
                { taskId: 'task-wiring', workspaceId: wsDir, name: marker },
                'checkpoint:created',
            );
            expect(frame.payload.name).toBe(marker);
        } finally {
            client.close();
        }

        const file = join(dataDir, 'checkpoints.json');
        expect(existsSync(file)).toBe(true);
        expect(readFileSync(file, 'utf-8')).toContain(marker);

        expect(snapshot(legacyFile)).toBe(legacyBefore);
    });
});
