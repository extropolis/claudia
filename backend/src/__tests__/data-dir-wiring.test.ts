import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CronScheduler } from '../cron-scheduler.js';
import { LEGACY_DATA_DIR } from '../paths.js';

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
});
