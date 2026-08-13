/**
 * Auto-reconnect parallelism regression suite.
 *
 * The startup path used to reconnect eligible tasks STRICTLY SERIALLY with a
 * hardcoded 5s sleep between each (8s at every 2-task batch boundary). With a
 * real working set of ~29 interrupted tasks that is ~182s of dead wall-clock
 * before the UI receives any state, because the WebSocket init handler blocks
 * on waitForReconnect().
 *
 * reconnectTask() is synchronous — the sleeps were never about the reconnect
 * itself, only about staggering CLI+MCP process startup so 29 claude processes
 * don't spawn at once. A bounded concurrency pool gives the same protection
 * without the serial wall-clock.
 *
 * Regression targets:
 *  - every eligible task still reconnects (no silent dropping)
 *  - wall-clock is a small multiple of the settle delay, NOT N * 5s
 *  - no more than RECONNECT_CONCURRENCY processes spawn per wave (the
 *    thundering-herd protection the sleeps originally bought)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ---- node-pty mock: record WHEN each spawn happened ----
const spawnTimes: number[] = [];
vi.mock('node-pty', () => ({
    spawn: () => {
        spawnTimes.push(Date.now());
        return {
            pid: 4242,
            cols: 120,
            rows: 40,
            onData: () => ({ dispose: () => {} }),
            onExit: () => ({ dispose: () => {} }),
            write: () => {},
            resize: () => {},
            kill: () => {},
        };
    },
}));

import { TaskSpawner } from '../task-spawner.js';

let base: string;
let workspace: string;
let claudeDir: string;

const encodeWorkspace = (p: string) => p.replace(/[^a-zA-Z0-9-]/g, '-');
const sidFor = (i: number) => `aaaaaaaa-bbbb-cccc-dddd-${String(i).padStart(12, '0')}`;

/** Seed N tasks that all satisfy the auto-reconnect eligibility filter:
 *  wasInterrupted && sessionId && lastActivity within the 2h window. */
function seedInterruptedTasks(count: number) {
    const now = new Date().toISOString();
    const tasks = Array.from({ length: count }, (_, i) => {
        // A session transcript must exist or reconnect takes the recovery path.
        writeFileSync(join(claudeDir, `${sidFor(i)}.jsonl`), '{"type":"user"}\n');
        return {
            id: `task-${1000 + i}-par`,
            prompt: `task ${i}`,
            workspaceId: workspace,
            createdAt: now,
            lastActivity: now,
            lastState: 'idle',
            wasInterrupted: true,
            shouldContinue: false,
            backendType: 'claude-code',
            sessionId: sidFor(i),
        };
    });
    writeFileSync(join(base, 'tasks.json'), JSON.stringify({ tasks, archivedTasks: [] }, null, 2));
}

/** Group spawn timestamps into waves separated by >= gapMs of quiet. */
function waveSizes(times: number[], gapMs: number): number[] {
    if (times.length === 0) return [];
    const waves: number[] = [1];
    for (let i = 1; i < times.length; i++) {
        if (times[i] - times[i - 1] >= gapMs) waves.push(1);
        else waves[waves.length - 1]++;
    }
    return waves;
}

beforeEach(() => {
    spawnTimes.length = 0;
    base = mkdtempSync(join(homedir(), '.claudia-reconnect-par-'));
    workspace = join(base, 'ws');
    mkdirSync(workspace, { recursive: true });
    vi.stubEnv('HOME', base);
    claudeDir = join(base, '.claude', 'projects', encodeWorkspace(workspace));
    mkdirSync(claudeDir, { recursive: true });
});

afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
});

describe('auto-reconnect parallelism', () => {
    it('reconnects all eligible tasks in bounded parallel waves, not serially', async () => {
        vi.stubEnv('RECONNECT_CONCURRENCY', '4');
        vi.stubEnv('RECONNECT_SETTLE_MS', '60');
        seedInterruptedTasks(12);

        const started = Date.now();
        const spawner = new TaskSpawner(join(base, 'tasks.json'), true);
        await spawner.waitForReconnect();
        const elapsed = Date.now() - started;

        // Every eligible task must reconnect — parallelism must not drop any.
        expect(spawnTimes).toHaveLength(12);

        // 12 tasks / 4 per wave = 3 waves. Serial would be 11 sleeps ~= 61s.
        // Allow generous slack for CI, but far below the serial floor.
        expect(elapsed).toBeLessThan(5_000);

        spawner.destroy();
    });

    it('never spawns more than RECONNECT_CONCURRENCY processes per wave', async () => {
        vi.stubEnv('RECONNECT_CONCURRENCY', '3');
        vi.stubEnv('RECONNECT_SETTLE_MS', '80');
        seedInterruptedTasks(9);

        const spawner = new TaskSpawner(join(base, 'tasks.json'), true);
        await spawner.waitForReconnect();

        expect(spawnTimes).toHaveLength(9);
        // Waves are separated by the settle delay; use half of it as the split
        // threshold so intra-wave jitter never splits a wave.
        for (const size of waveSizes(spawnTimes, 40)) {
            expect(size).toBeLessThanOrEqual(3);
        }

        spawner.destroy();
    });

    it('emits reconnectComplete with an accurate total', async () => {
        vi.stubEnv('RECONNECT_CONCURRENCY', '4');
        vi.stubEnv('RECONNECT_SETTLE_MS', '10');
        seedInterruptedTasks(6);

        const spawner = new TaskSpawner(join(base, 'tasks.json'), true);
        const complete = new Promise<{ total: number; failed: number }>(resolve =>
            spawner.once('reconnectComplete', resolve)
        );
        await spawner.waitForReconnect();
        const result = await complete;

        expect(result.total).toBe(6);
        expect(result.failed).toBe(0);

        spawner.destroy();
    });
});
