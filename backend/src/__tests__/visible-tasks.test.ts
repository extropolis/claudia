/**
 * The VISIBLE SET: multiple tasks on screen at once (split-screen panes).
 *
 * The backend used to hard-assume exactly one visible task — `setTaskActive`
 * cleared `isActive` on every other task, and PTY output for an inactive task
 * is dropped on the floor. With 4 panes open, 3 of them went silent. That is
 * the regression the first test here exists to prevent.
 *
 * `isActive` is now DERIVED from `visibleTaskIds` (see `syncActiveFlags`), so
 * these tests drive the real gate in `setupProcessHandlers` rather than
 * asserting on the flag alone: a flag that is true while output is still
 * dropped would be a passing test and a broken feature.
 *
 * The PTY is faked (an object that hands us its onData callback), so the whole
 * spawner half runs on the Windows CI leg too. The WS half only opens a socket
 * — it never spawns a CLI — so it runs everywhere as well.
 *
 * Temp dirs live under homedir(), NOT os.tmpdir(): on macOS tmpdir resolves
 * under /var, which validateWorkspacePath blocklists as a system path.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { TaskSpawner } from '../task-spawner.js';
import { createTestEnv, type TestEnv, type WSClient } from './helpers/ws-harness.js';

// Keep the polling/reaper intervals from firing under fake timers.
process.env.STATE_POLLING_MS = '3600000';
process.env.IDLE_TASK_REAP_INTERVAL_MS = '3600000';

// ---------------------------------------------------------------------------
// TaskSpawner: the visible set itself
// ---------------------------------------------------------------------------
describe('TaskSpawner visible set', () => {
    let spawner: InstanceType<typeof TaskSpawner>;
    let base: string;
    /** taskId -> the onData callback setupProcessHandlers registered on the fake PTY. */
    let emitPty: Map<string, (data: string) => void>;
    /** Every ('taskOutput', taskId, data) the spawner emitted. */
    let emitted: Array<{ taskId: string; data: string }>;

    /** A live task with a fake PTY, wired through the REAL setupProcessHandlers. */
    function addTask(id: string, overrides: Record<string, unknown> = {}): any {
        const task: any = {
            id,
            prompt: `prompt ${id}`,
            workspaceId: base,
            process: {
                pid: 4242,
                write: vi.fn(),
                kill: vi.fn(),
                resize: vi.fn(),
                onData: (cb: (d: string) => void) => { emitPty.set(id, cb); },
                onExit: (_cb: unknown) => { /* not exercised here */ },
            },
            outputHistory: [],
            totalOutputSize: 0,
            lastOutputLength: 0,
            savedBufferCount: 0,
            isActive: false,
            initialPromptSent: true,
            pendingPrompt: null,
            sessionId: `sess-${id}`,
            state: 'idle',
            hasStartedProcessing: true,
            lastActivity: new Date(),
            createdAt: new Date(),
            ...overrides,
        };
        (spawner as any).tasks.set(id, task);
        (spawner as any).setupProcessHandlers(task);
        return task;
    }

    /** Push a chunk of PTY output for a task and report whether it reached clients. */
    function pty(id: string, data: string): boolean {
        const before = emitted.length;
        emitPty.get(id)!(data);
        return emitted.slice(before).some(e => e.taskId === id);
    }

    beforeEach(() => {
        base = mkdtempSync(join(homedir(), '.claudia-visible-test-'));
        spawner = new TaskSpawner(join(base, 'tasks.json'), false);
        emitPty = new Map();
        emitted = [];
        spawner.on('taskOutput', (taskId: string, data: string) => emitted.push({ taskId, data }));
        // taskRestore fires on select; swallow it so EventEmitter has a listener.
        spawner.on('taskRestore', () => { /* ignore */ });
    });

    afterEach(() => {
        vi.useRealTimers();
        try { spawner.destroy(); } catch { /* best effort */ }
        try { rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
    });

    it('CORE: two visible tasks BOTH stream output (the split-screen regression)', () => {
        const a = addTask('task-a');
        const b = addTask('task-b');

        spawner.setTaskActive('task-a', true);
        spawner.setTaskActive('task-b', true);

        // The old code deactivated 'a' the moment 'b' was selected.
        expect(a.isActive).toBe(true);
        expect(b.isActive).toBe(true);
        expect(spawner.getVisibleTaskIds()).toEqual(['task-a', 'task-b']);

        expect(pty('task-a', 'OUT_FROM_A')).toBe(true);
        expect(pty('task-b', 'OUT_FROM_B')).toBe(true);
        expect(emitted.map(e => e.data)).toEqual(['OUT_FROM_A', 'OUT_FROM_B']);
    });

    it('selecting a task is additive — it never deactivates the others', () => {
        const tasks = ['t1', 't2', 't3'].map(id => addTask(id));
        for (const t of tasks) spawner.setTaskActive(t.id, true);

        expect(tasks.every(t => t.isActive)).toBe(true);
        for (const t of tasks) expect(pty(t.id, `data-${t.id}`)).toBe(true);
    });

    it('setVisibleTasks([a]) after [a,b] drops b: isActive false AND output dropped', () => {
        const a = addTask('task-a');
        const b = addTask('task-b');
        spawner.setVisibleTasks(['task-a', 'task-b']);
        expect(pty('task-b', 'B_WHILE_VISIBLE')).toBe(true);

        spawner.setVisibleTasks(['task-a']);

        expect(a.isActive).toBe(true);
        expect(b.isActive).toBe(false);
        expect(spawner.getVisibleTaskIds()).toEqual(['task-a']);
        expect(pty('task-a', 'A_STILL_FLOWS')).toBe(true);
        expect(pty('task-b', 'B_MUST_BE_DROPPED')).toBe(false);
        expect(emitted.some(e => e.data === 'B_MUST_BE_DROPPED')).toBe(false);
    });

    it('setVisibleTasks does NOT restore history (restore stays driven by task:select)', () => {
        addTask('task-a');
        const restores: string[] = [];
        spawner.on('taskRestore', (taskId: string) => restores.push(taskId));

        spawner.setVisibleTasks(['task-a']);
        expect(restores).toEqual([]);

        spawner.setTaskActive('task-a', true);
        expect(restores).toEqual(['task-a']);
    });

    it('deselect removes exactly one task and leaves the others visible', () => {
        const a = addTask('task-a');
        const b = addTask('task-b');
        const c = addTask('task-c');
        spawner.setVisibleTasks(['task-a', 'task-b', 'task-c']);

        spawner.setTaskActive('task-b', false);

        expect(spawner.getVisibleTaskIds()).toEqual(['task-a', 'task-c']);
        expect(a.isActive).toBe(true);
        expect(b.isActive).toBe(false);
        expect(c.isActive).toBe(true);
        expect(pty('task-a', 'A_OK')).toBe(true);
        expect(pty('task-c', 'C_OK')).toBe(true);
        expect(pty('task-b', 'B_GONE')).toBe(false);
    });

    it('deselecting an unknown / already-hidden task is a harmless no-op', () => {
        addTask('task-a');
        spawner.setTaskActive('task-a', true);

        spawner.setTaskActive('task-nope', false);
        spawner.setTaskActive('task-a', false);
        spawner.setTaskActive('task-a', false);

        expect(spawner.getVisibleTaskIds()).toEqual([]);
    });

    it('caps the visible set at 8, evicting the least-recently-added', () => {
        const ids = Array.from({ length: 12 }, (_, i) => `task-${i}`);
        for (const id of ids) addTask(id);

        for (const id of ids) spawner.setTaskActive(id, true);

        const visible = spawner.getVisibleTaskIds();
        expect(visible.length).toBe(8);
        // The 4 oldest were evicted; the 8 newest survive, oldest-first.
        expect(visible).toEqual(ids.slice(4));
        expect((spawner as any).tasks.get('task-0').isActive).toBe(false);
        expect((spawner as any).tasks.get('task-11').isActive).toBe(true);
        expect(pty('task-0', 'EVICTED_OUTPUT')).toBe(false);
        expect(pty('task-11', 'LIVE_OUTPUT')).toBe(true);
    });

    it('re-selecting a visible task refreshes its recency so it survives eviction', () => {
        const ids = Array.from({ length: 8 }, (_, i) => `task-${i}`);
        for (const id of ids) addTask(id);
        for (const id of ids) spawner.setTaskActive(id, true);

        // task-0 is the eviction candidate — touch it, then add a 9th.
        spawner.setTaskActive('task-0', true);
        addTask('task-new');
        spawner.setTaskActive('task-new', true);

        const visible = spawner.getVisibleTaskIds();
        expect(visible.length).toBe(8);
        expect(visible).toContain('task-0');
        expect(visible).not.toContain('task-1'); // task-1 became the oldest
        expect(visible[visible.length - 1]).toBe('task-new');
    });

    it('setVisibleTasks itself is capped, de-duped, and ignores non-string entries', () => {
        const ids = Array.from({ length: 20 }, (_, i) => `task-${i}`);
        for (const id of ids) addTask(id);

        spawner.setVisibleTasks(ids);
        expect(spawner.getVisibleTaskIds()).toEqual(ids.slice(12)); // last 8

        spawner.setVisibleTasks(['task-1', 'task-1', '', null as any, 7 as any, 'task-2']);
        expect(spawner.getVisibleTaskIds()).toEqual(['task-1', 'task-2']);

        spawner.setVisibleTasks([]);
        expect(spawner.getVisibleTaskIds()).toEqual([]);
    });

    it('setVisibleTasks ignores a non-array payload instead of throwing', () => {
        addTask('task-a');
        spawner.setVisibleTasks(['task-a']);

        expect(() => spawner.setVisibleTasks('task-a' as any)).not.toThrow();
        expect(() => spawner.setVisibleTasks(null as any)).not.toThrow();
        expect(spawner.getVisibleTaskIds()).toEqual(['task-a']);
    });

    it('destroying / archiving a task frees its pane slot', () => {
        addTask('task-a');
        addTask('task-b');
        spawner.setVisibleTasks(['task-a', 'task-b']);

        spawner.destroyTask('task-a');
        expect(spawner.getVisibleTaskIds()).toEqual(['task-b']);

        spawner.archiveTask('task-b');
        expect(spawner.getVisibleTaskIds()).toEqual([]);
    });

    it('the 30s history sweep spares visible tasks and frees hidden ones', () => {
        vi.useFakeTimers();
        const stale = new Date(Date.now() - 120_000); // older than the 60s "recently active" grace

        const a = addTask('task-a', { previousHistory: Buffer.from('HISTORY_A'), lastActivity: stale });
        const b = addTask('task-b', { previousHistory: Buffer.from('HISTORY_B'), lastActivity: stale });

        spawner.setVisibleTasks(['task-a']);
        // The sweep is armed by an activating setTaskActive call.
        spawner.setTaskActive('task-a', true);

        vi.advanceTimersByTime(31_000);

        // 'a' is visible → isActive → its scrollback must survive.
        expect(a.previousHistory).toBeDefined();
        expect(a.previousHistory.toString()).toBe('HISTORY_A');
        // 'b' is hidden and stale → freed.
        expect(b.previousHistory).toBeUndefined();
        expect(b.lazyHistoryBase64).toBeUndefined();
    });

    it('a second visible task added later is also spared by the sweep', () => {
        vi.useFakeTimers();
        const stale = new Date(Date.now() - 120_000);
        const a = addTask('task-a', { previousHistory: Buffer.from('HISTORY_A'), lastActivity: stale });
        const b = addTask('task-b', { previousHistory: Buffer.from('HISTORY_B'), lastActivity: stale });

        spawner.setTaskActive('task-a', true); // arms the sweep
        spawner.setTaskActive('task-b', true); // second pane, added after the sweep was armed

        vi.advanceTimersByTime(31_000);

        expect(a.previousHistory?.toString()).toBe('HISTORY_A');
        expect(b.previousHistory?.toString()).toBe('HISTORY_B');
    });
});

// ---------------------------------------------------------------------------
// WS protocol: task:setVisible / task:deselect
//
// No CLI is spawned here, so this runs on every CI leg. The contract under test
// is robustness: a malformed frame must be answered with an error, never with a
// dead socket (matching ws-cron-shell-protocol.test.ts).
// ---------------------------------------------------------------------------
describe('WS task:setVisible / task:deselect', () => {
    let env: TestEnv;
    let client: WSClient;

    beforeEach(async () => {
        env = await createTestEnv({ prefix: 'ws-visible', workspaces: ['vis-a'] });
        client = await env.connect();
    }, 30000);

    afterEach(async () => {
        await env.cleanup();
    }, 30000);

    it('accepts a well-formed visible set without error', async () => {
        await client.sendAndProveAlive('task:setVisible', { taskIds: ['task-1', 'task-2'] });
        expect(client.isClosed).toBe(false);
    }, 20000);

    it('accepts task:deselect for an unknown task without killing the connection', async () => {
        await client.sendAndProveAlive('task:deselect', { taskId: 'task-does-not-exist' });
        expect(client.isClosed).toBe(false);
    }, 20000);

    it('rejects task:deselect with no taskId via an error frame, not a close', async () => {
        const err = await client.request('task:deselect', {}, 'error');
        expect(err.payload.code).toBe('MISSING_PARAMS');
        expect(client.isClosed).toBe(false);
    }, 20000);

    it('rejects a non-array taskIds with INVALID_PARAMS', async () => {
        const err = await client.request('task:setVisible', { taskIds: 'task-1' }, 'error');
        expect(err.payload.code).toBe('INVALID_PARAMS');
        expect(client.isClosed).toBe(false);
    }, 20000);

    it('survives numbers, nulls, objects, a huge array and a missing payload', async () => {
        client.sendRaw(JSON.stringify({ type: 'task:setVisible', payload: { taskIds: [1, 2, 3] } }));
        client.sendRaw(JSON.stringify({ type: 'task:setVisible', payload: { taskIds: [null, {}, [], 'ok'] } }));
        client.sendRaw(JSON.stringify({
            type: 'task:setVisible',
            payload: { taskIds: Array.from({ length: 5000 }, (_, i) => `task-${i}`) },
        }));
        client.sendRaw(JSON.stringify({ type: 'task:setVisible', payload: {} }));
        client.sendRaw(JSON.stringify({ type: 'task:setVisible', payload: null }));
        client.sendRaw(JSON.stringify({ type: 'task:setVisible' }));
        client.sendRaw(JSON.stringify({ type: 'task:deselect', payload: { taskId: 42 } }));

        await client.ping();
        expect(client.isClosed).toBe(false);

        const health = await fetch(`http://127.0.0.1:${env.port}/api/health`).then(r => r.json());
        expect(health.status).toBe('ok');
    }, 30000);
});

afterAll(() => {
    delete process.env.STATE_POLLING_MS;
    delete process.env.IDLE_TASK_REAP_INTERVAL_MS;
});
