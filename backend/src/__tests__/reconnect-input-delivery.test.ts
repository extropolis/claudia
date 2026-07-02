import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    planReconnectDelivery,
    isContextDestroyingInput,
    evaluateDestructiveInputThrottle,
    DESTRUCTIVE_INPUT_WINDOW_MS,
    DESTRUCTIVE_INPUT_MAX_PER_WINDOW,
    TaskSpawner,
} from '../task-spawner.js';

// Keep the polling/reaper intervals from firing during these tests.
process.env.STATE_POLLING_MS = '3600000';
process.env.IDLE_TASK_REAP_INTERVAL_MS = '3600000';

// ---------------------------------------------------------------------------
// Major 1 — an interrupted (shouldContinue) task that also has a typed message
// must deliver BOTH: 'continue' first, then re-deliver the user's message.
// ---------------------------------------------------------------------------
describe('planReconnectDelivery (reconnect first-input delivery)', () => {
    it('delivers ONLY the user message when the task was not mid-turn', () => {
        const plan = planReconnectDelivery({ shouldContinue: false, pendingInput: 'hello there\r' });
        expect(plan.deliverOnReady).toBe('hello there');
        expect(plan.followupInputs).toEqual([]);
        expect(plan.needsDelivery).toBe(true);
    });

    it('delivers nothing on a plain background reconnect (no input, not mid-turn)', () => {
        const plan = planReconnectDelivery({ shouldContinue: false });
        expect(plan.deliverOnReady).toBeNull();
        expect(plan.followupInputs).toEqual([]);
        expect(plan.needsDelivery).toBe(false);
    });

    it('delivers ONLY a continuation when mid-turn with no typed message', () => {
        const plan = planReconnectDelivery({ shouldContinue: true });
        expect(plan.deliverOnReady).toBe('continue');
        expect(plan.followupInputs).toEqual([]);
        expect(plan.needsDelivery).toBe(true);
    });

    it('MAJOR 1: mid-turn + typed message delivers continue FIRST, then the user message', () => {
        const plan = planReconnectDelivery({ shouldContinue: true, pendingInput: 'fix the bug\r' });
        // Regression guard: the buggy code produced deliverOnReady='continue' and
        // silently DROPPED the user's message. Both must survive now.
        expect(plan.deliverOnReady).toBe('continue');
        expect(plan.followupInputs).toEqual(['fix the bug']);
        expect(plan.needsDelivery).toBe(true);
    });

    it('strips the trailing newline from the queued input (Enter is re-appended on delivery)', () => {
        expect(planReconnectDelivery({ shouldContinue: false, pendingInput: 'a\n' }).deliverOnReady).toBe('a');
        expect(planReconnectDelivery({ shouldContinue: true, pendingInput: 'b\r\n' }).followupInputs).toEqual(['b']);
    });
});

// ---------------------------------------------------------------------------
// Major 2 — the context-destroying-input throttle must count a command once,
// and must NOT block a legitimate internal re-delivery of that same command.
// ---------------------------------------------------------------------------
describe('context-destroying-input guard helpers', () => {
    it('recognizes /clear, /compact, /reset (with trailing CR/LF and args)', () => {
        expect(isContextDestroyingInput('/clear\r')).toBe(true);
        expect(isContextDestroyingInput('/compact\n')).toBe(true);
        expect(isContextDestroyingInput('/reset')).toBe(true);
        expect(isContextDestroyingInput('/CLEAR\r')).toBe(true);
    });

    it('does not flag ordinary input', () => {
        expect(isContextDestroyingInput('hello\r')).toBe(false);
        expect(isContextDestroyingInput('/clearly not a command\r')).toBe(false);
        expect(isContextDestroyingInput('please /clear later\r')).toBe(false);
    });

    it('allows the first command and blocks a rapid repeat within the window', () => {
        const t0 = 1_000_000;
        const first = evaluateDestructiveInputThrottle([], t0);
        expect(first.blocked).toBe(false);
        expect(first.timestamps).toEqual([t0]);

        const second = evaluateDestructiveInputThrottle(first.timestamps, t0 + 1_000);
        expect(second.blocked).toBe(true); // 2nd within 30s → runaway
    });

    it('allows a repeat once the window has elapsed', () => {
        const t0 = 1_000_000;
        const first = evaluateDestructiveInputThrottle([], t0);
        const later = evaluateDestructiveInputThrottle(first.timestamps, t0 + DESTRUCTIVE_INPUT_WINDOW_MS + 1);
        expect(later.blocked).toBe(false);
        expect(later.timestamps).toEqual([t0 + DESTRUCTIVE_INPUT_WINDOW_MS + 1]);
        expect(DESTRUCTIVE_INPUT_MAX_PER_WINDOW).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Integration — writeToTask / transitionTaskState behavior on real TaskSpawner
// instances (with mocked PTY processes and a stubbed reconnectTask).
// ---------------------------------------------------------------------------
describe('TaskSpawner input routing (integration)', () => {
    let spawner: InstanceType<typeof TaskSpawner>;
    let tmpDir: string;

    function makeTask(overrides: Record<string, unknown> = {}): any {
        return {
            id: 't1',
            prompt: 'p',
            workspaceId: '/tmp',
            process: { write: vi.fn() },
            outputHistory: [],
            isActive: true,
            initialPromptSent: true,
            pendingPrompt: null,
            sessionId: 's1',
            state: 'idle',
            lastActivity: new Date(),
            createdAt: new Date(),
            totalOutputSize: 0,
            lastOutputLength: 0,
            savedBufferCount: 0,
            hasStartedProcessing: true,
            ...overrides,
        };
    }

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'claudia-reconnect-test-'));
        spawner = new TaskSpawner(join(tmpDir, 'tasks.json'), false);
    });

    afterEach(() => {
        try {
            spawner.destroy();
        } catch { /* ignore */ }
        try {
            rmSync(tmpDir, { recursive: true, force: true });
        } catch { /* ignore */ }
        vi.useRealTimers();
    });

    it('MAJOR 2: /clear to an exited task reaches delivery (routed to reconnectTask, not blocked)', () => {
        const taskId = 't1';
        (spawner as any).tasks.set(taskId, makeTask({ id: taskId, state: 'exited' }));

        const reconnectSpy = vi
            .spyOn(spawner as any, 'reconnectTask')
            .mockImplementation((...args: any[]) => ({ id: args[0] }));

        // A legitimate external /clear on an exited task. The buggy path reconnected,
        // then recursively re-delivered via writeToTask — which re-entered the guard
        // and got blocked as a "2nd hit in 30s", so the command never landed.
        spawner.writeToTask(taskId, '/clear\r', 'client');

        // The command must be handed to reconnectTask verbatim for ready-path delivery.
        expect(reconnectSpy).toHaveBeenCalledTimes(1);
        expect(reconnectSpy).toHaveBeenCalledWith(taskId, '/clear\r');
    });

    it('blocks a genuine runaway: a 2nd external /clear to a live task within the window', () => {
        const taskId = 't1';
        const task = makeTask({ id: taskId, state: 'idle' });
        (spawner as any).tasks.set(taskId, task);

        spawner.writeToTask(taskId, '/clear\r', 'client'); // 1st — allowed, written
        const writesAfterFirst = task.process.write.mock.calls.length;
        expect(writesAfterFirst).toBeGreaterThan(0);

        spawner.writeToTask(taskId, '/clear\r', 'client'); // 2nd — runaway, blocked
        expect(task.process.write.mock.calls.length).toBe(writesAfterFirst); // no new write
    });

    it('MAJOR 1: a queued follow-up is delivered when the task returns to idle', () => {
        vi.useFakeTimers();
        const taskId = 't1';
        const task = makeTask({
            id: taskId,
            state: 'busy', // continuation is being processed
            initialPromptSent: true,
            pendingPrompt: null,
            pendingFollowupInputs: ['fix the bug'],
        });
        (spawner as any).tasks.set(taskId, task);

        const writeSpy = vi.spyOn(spawner, 'writeToTask');

        // Continuation finished → task settles to idle.
        (spawner as any).transitionTaskState(task, 'idle', undefined, 'test: continuation done');

        // The queued user message is flushed (after a short settle delay), with Enter
        // re-appended and marked as an internal re-delivery (bypasses the guard).
        vi.advanceTimersByTime(500);
        expect(writeSpy).toHaveBeenCalledWith(taskId, 'fix the bug\r', 'internal-followup', true);
        expect(task.pendingFollowupInputs).toBeUndefined();
    });

    it('does NOT flush a follow-up while the initial prompt is still pending', () => {
        vi.useFakeTimers();
        const taskId = 't1';
        const task = makeTask({
            id: taskId,
            state: 'busy',
            initialPromptSent: false, // initial prompt/continuation not delivered yet
            pendingPrompt: 'continue',
            pendingFollowupInputs: ['fix the bug'],
        });
        (spawner as any).tasks.set(taskId, task);

        const writeSpy = vi.spyOn(spawner, 'writeToTask');
        (spawner as any).transitionTaskState(task, 'idle', undefined, 'test: premature idle');
        vi.advanceTimersByTime(500);

        expect(writeSpy).not.toHaveBeenCalled();
        expect(task.pendingFollowupInputs).toEqual(['fix the bug']); // still queued
    });

    it('queues a second message that arrives while a reconnect is still delivering', () => {
        const taskId = 't1';
        const task = makeTask({
            id: taskId,
            state: 'starting',
            initialPromptSent: false,
            pendingPrompt: 'continue',
        });
        (spawner as any).tasks.set(taskId, task);

        spawner.writeToTask(taskId, 'second message\r', 'client');

        // Not written raw (would race ahead of the pending prompt) — queued in order.
        expect((task.process.write as any).mock.calls.length).toBe(0);
        expect(task.pendingFollowupInputs).toEqual(['second message\r']);
    });
});
