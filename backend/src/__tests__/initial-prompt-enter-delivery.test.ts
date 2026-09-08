import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { TaskSpawner } from '../task-spawner.js';

// ---------------------------------------------------------------------------
// sendEnterWithRetry: deciding whether an Enter we wrote to the PTY actually
// submitted the prompt. Drives the private method directly with fake timers
// and a hand-built task so the classification path is exercised without a PTY.
//
// The footer strings mirror what today's Claude Code TUI prints. Note that the
// "bypass permissions / shift+tab" footer is visible BOTH at the idle prompt and
// during an active turn — only "esc to interrupt" distinguishes the two.
// ---------------------------------------------------------------------------

const IDLE_FOOTER = '\n❯ \n⏵⏵ bypass permissions on (shift+tab to cycle)\n';
const ACTIVE_TURN_FOOTER = '\n✻ Thinking…\n⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents\n';
const STARTUP_CHURN = 'MCP servers: 3 ready · Tip: use /help for shortcuts to common tasks\n'.repeat(4);

const ENTER_CHECK_MS = 800;
const RETRY_DELAY_MS = 500;

describe('sendEnterWithRetry (initial-prompt acceptance vs. startup churn)', () => {
    let spawner: InstanceType<typeof TaskSpawner>;
    let tmpDir: string;

    function makeTask(overrides: Record<string, unknown> = {}): any {
        return {
            id: 't-enter',
            prompt: 'p',
            workspaceId: tmpDir,
            process: { write: vi.fn() },
            outputHistory: [] as Buffer[],
            isActive: true,
            initialPromptSent: true,
            pendingPrompt: null,
            sessionId: 's1',
            state: 'starting',
            lastActivity: new Date(),
            createdAt: new Date(),
            totalOutputSize: 0,
            lastOutputLength: 0,
            savedBufferCount: 0,
            hasStartedProcessing: false,
            promptSubmitAttempts: 0,
            ...overrides,
        };
    }

    function emit(task: any, text: string): void {
        const buf = Buffer.from(text, 'utf8');
        task.outputHistory.push(buf);
        task.totalOutputSize += buf.length;
    }

    function register(task: any): void {
        (spawner as any).tasks.set(task.id, task);
    }

    function sendEnter(task: any, retries: number, isInitialPrompt: boolean): void {
        (spawner as any).sendEnterWithRetry(task, retries, { isInitialPrompt });
    }

    beforeEach(() => {
        vi.stubEnv('STATE_POLLING_MS', '3600000');
        vi.stubEnv('IDLE_TASK_REAP_INTERVAL_MS', '3600000');
        vi.useFakeTimers();
        tmpDir = mkdtempSync(join(homedir(), '.claudia-enter-delivery-test-'));
        spawner = new TaskSpawner(join(tmpDir, 'tasks.json'), false);
    });

    afterEach(() => {
        try { spawner.destroy(); } catch { /* ignore */ }
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        vi.unstubAllEnvs();
        vi.useRealTimers();
    });

    it('ROOT CAUSE: startup churn while still at the idle prompt does NOT stop the retry loop', () => {
        const task = makeTask();
        register(task);
        emit(task, IDLE_FOOTER);

        sendEnter(task, 3, true);
        expect(task.process.write).toHaveBeenCalledTimes(1);
        expect(task.process.write).toHaveBeenLastCalledWith('\r');

        // Enter was dropped; the TUI keeps streaming unrelated startup output and
        // repaints the idle footer. Old heuristic: growth > 10 bytes ⇒ "accepted".
        emit(task, STARTUP_CHURN + IDLE_FOOTER);
        vi.advanceTimersByTime(ENTER_CHECK_MS);

        expect(task.state).toBe('starting');
        expect(task.hasStartedProcessing).toBe(false);

        // ...so Enter must be re-sent (and ONLY Enter — the prompt is never re-typed).
        vi.advanceTimersByTime(RETRY_DELAY_MS);
        expect(task.process.write).toHaveBeenCalledTimes(2);
        expect(task.process.write.mock.calls.every((c: unknown[]) => c[0] === '\r')).toBe(true);

        // This time the TUI starts a real turn.
        emit(task, ACTIVE_TURN_FOOTER);
        vi.advanceTimersByTime(ENTER_CHECK_MS);

        expect(task.state).toBe('busy');
        expect(task.hasStartedProcessing).toBe(true);

        // Accepted ⇒ no further Enters (no double-submission).
        vi.advanceTimersByTime(RETRY_DELAY_MS + ENTER_CHECK_MS + RETRY_DELAY_MS);
        expect(task.process.write).toHaveBeenCalledTimes(2);
    });

    it('accepts on the first check when the active-turn marker is present, even alongside the persistent footer', () => {
        const task = makeTask();
        register(task);
        emit(task, IDLE_FOOTER);

        sendEnter(task, 3, true);
        emit(task, ACTIVE_TURN_FOOTER);
        vi.advanceTimersByTime(ENTER_CHECK_MS + RETRY_DELAY_MS);

        expect(task.state).toBe('busy');
        expect(task.process.write).toHaveBeenCalledTimes(1);
    });

    it('follow-up input (guard off): growth that lands back on the idle footer is accepted, not retried', () => {
        // A near-instant follow-up (e.g. /clear) redraws to the idle prompt before
        // the 800ms check. With no startup churn to defend against, growth is
        // trustworthy — a retry here would inject a stray Enter into a live session.
        const task = makeTask({ state: 'idle', hasStartedProcessing: true });
        register(task);
        emit(task, IDLE_FOOTER);

        sendEnter(task, 3, false);
        expect(task.state).toBe('busy'); // follow-ups flip to busy before Enter
        emit(task, 'cleared\n' + IDLE_FOOTER);
        vi.advanceTimersByTime(ENTER_CHECK_MS + RETRY_DELAY_MS + ENTER_CHECK_MS);

        expect(task.process.write).toHaveBeenCalledTimes(1);
    });

    it('follow-up input with no growth at all still retries', () => {
        const task = makeTask({ state: 'idle', hasStartedProcessing: true });
        register(task);
        emit(task, IDLE_FOOTER);

        sendEnter(task, 2, false);
        vi.advanceTimersByTime(ENTER_CHECK_MS + RETRY_DELAY_MS);

        expect(task.process.write).toHaveBeenCalledTimes(2);
    });

    it('safety net: exhausting retries with output growth falls back to busy instead of wedging in starting', () => {
        // hasStartedProcessing is only ever set here, and the poller refuses to
        // move starting → idle. If a real turn started and FINISHED without the
        // marker ever landing in our sample window, the task must not be stuck.
        const task = makeTask();
        register(task);
        emit(task, IDLE_FOOTER);

        sendEnter(task, 1, true);
        emit(task, STARTUP_CHURN + IDLE_FOOTER);
        vi.advanceTimersByTime(ENTER_CHECK_MS); // classify → retry
        vi.advanceTimersByTime(RETRY_DELAY_MS); // retriesLeft = 0 → give up

        expect(task.process.write).toHaveBeenCalledTimes(1);
        expect(task.state).toBe('busy');
        expect(task.hasStartedProcessing).toBe(true);
    });

    it('safety net does not fire when nothing was ever printed after Enter', () => {
        const task = makeTask();
        register(task);
        emit(task, IDLE_FOOTER);

        sendEnter(task, 1, true);
        vi.advanceTimersByTime(ENTER_CHECK_MS + RETRY_DELAY_MS);

        expect(task.state).toBe('starting');
        expect(task.hasStartedProcessing).toBe(false);
    });
});
