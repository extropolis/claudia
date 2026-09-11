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

    it('the anchor stays pinned to the FIRST Enter even when nothing had been printed yet', () => {
        // Empty history at the first Enter ⇒ a legitimately `undefined` anchor.
        // It must remain undefined across retries (the whole history is post-Enter
        // output), not silently re-pin to the newest buffer on every attempt.
        const task = makeTask();
        register(task);

        sendEnter(task, 3, true);
        expect(task.process.write).toHaveBeenCalledTimes(1);

        // Dropped Enter; the TUI finally paints its idle prompt.
        emit(task, IDLE_FOOTER);
        vi.advanceTimersByTime(ENTER_CHECK_MS);
        expect(task.state).toBe('starting');
        vi.advanceTimersByTime(RETRY_DELAY_MS);
        expect(task.process.write).toHaveBeenCalledTimes(2);

        // Marker painted after the SECOND Enter is still inside the window whether
        // or not the anchor moved; the point is the window never shrinks below it.
        const since = (spawner as any).getOutputSinceAnchor(task, undefined);
        expect(since.text).toContain('bypass permissions');
        expect(since.bytes).toBe(Buffer.byteLength(IDLE_FOOTER, 'utf8'));
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

// ---------------------------------------------------------------------------
// Regression guards found by adversarial review of the classifier (PR #249).
//
// Both cases below are ACCEPTED submissions that the marker-only classifier
// reads as "dropped", so it re-sends Enter into a live TUI. Evidence from 40
// real task histories under backend/task-histories: 27/27 dialog frames have
// NO "esc to interrupt" anywhere in the trailing 4096 raw bytes, because the
// footer that carries the marker is repainted only a handful of times per task
// (245 footer paints across 40 tasks, 110 of them carrying the marker).
// ---------------------------------------------------------------------------

const QUESTION_DIALOG = [
    'Which approach do you want?',
    '❯ 1. Sidebar filter',
    '  2. Command palette',
    '  3. Both',
    '  4. Type something',
    '  5. Chat about this',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
    '',
].join('\n');

const PERMISSION_DIALOG = [
    'Bash command',
    '  rm -rf build/',
    'Do you want to proceed?',
    '❯ 1. Yes',
    "  2. Yes, and don't ask again",
    '  3. No, and tell Claude what to do differently (esc)',
    '',
].join('\n');

describe('sendEnterWithRetry: never re-sends Enter into a choice/permission dialog', () => {
    let spawner: InstanceType<typeof TaskSpawner>;
    let tmpDir: string;

    function makeTask(overrides: Record<string, unknown> = {}): any {
        return {
            id: 't-dialog', prompt: 'p', workspaceId: tmpDir,
            process: { write: vi.fn() }, outputHistory: [] as Buffer[], isActive: true,
            initialPromptSent: true, pendingPrompt: null, sessionId: 's1', state: 'starting',
            lastActivity: new Date(), createdAt: new Date(), totalOutputSize: 0,
            lastOutputLength: 0, savedBufferCount: 0, hasStartedProcessing: false,
            promptSubmitAttempts: 0, ...overrides,
        };
    }
    function emit(task: any, text: string): void {
        const buf = Buffer.from(text, 'utf8');
        task.outputHistory.push(buf);
        task.totalOutputSize += buf.length;
    }

    beforeEach(() => {
        vi.stubEnv('STATE_POLLING_MS', '3600000');
        vi.stubEnv('IDLE_TASK_REAP_INTERVAL_MS', '3600000');
        vi.useFakeTimers();
        tmpDir = mkdtempSync(join(homedir(), '.claudia-enter-dialog-test-'));
        spawner = new TaskSpawner(join(tmpDir, 'tasks.json'), false);
    });
    afterEach(() => {
        try { spawner.destroy(); } catch { /* ignore */ }
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        vi.unstubAllEnvs();
        vi.useRealTimers();
    });

    it('a question dialog on screen means the prompt WAS submitted — no extra Enter', () => {
        const task = makeTask();
        (spawner as any).tasks.set(task.id, task);
        emit(task, IDLE_FOOTER);

        (spawner as any).sendEnterWithRetry(task, 5, { isInitialPrompt: true });
        expect(task.process.write).toHaveBeenCalledTimes(1);

        // Turn started and already reached an AskUserQuestion dialog. The footer
        // now reads without "esc to interrupt" (the turn is parked on the user).
        emit(task, QUESTION_DIALOG + IDLE_FOOTER);
        vi.advanceTimersByTime(ENTER_CHECK_MS + RETRY_DELAY_MS + ENTER_CHECK_MS + RETRY_DELAY_MS);

        // An extra '\r' here would SELECT the highlighted option on the user's behalf.
        expect(task.process.write).toHaveBeenCalledTimes(1);
        expect(task.state).toBe('busy');
        expect(task.hasStartedProcessing).toBe(true);
    });

    it('a permission dialog on screen means the prompt WAS submitted — no extra Enter', () => {
        const task = makeTask();
        (spawner as any).tasks.set(task.id, task);
        emit(task, IDLE_FOOTER);

        (spawner as any).sendEnterWithRetry(task, 5, { isInitialPrompt: true });
        emit(task, PERMISSION_DIALOG + IDLE_FOOTER);
        vi.advanceTimersByTime(ENTER_CHECK_MS + RETRY_DELAY_MS + ENTER_CHECK_MS + RETRY_DELAY_MS);

        // Enter on "❯ 1. Yes" would auto-approve a tool call. skipPermissions
        // defaults to false (config-store.ts), so this dialog is reachable.
        expect(task.process.write).toHaveBeenCalledTimes(1);
        expect(task.state).toBe('busy');
    });

    it('dialog chrome echoed inside the TYPED PROMPT is not acceptance evidence', () => {
        // Symmetric to the "esc to interrupt" echo case below. The TUI echoes the
        // prompt into the input box BEFORE Enter, so a prompt that merely quotes
        // dialog chrome would make a DROPPED Enter look accepted and strand the
        // prompt unsubmitted — the exact bug this PR exists to fix. A real dialog
        // is painted by the turn, so it is always in the POST-Enter output.
        const task = makeTask();
        (spawner as any).tasks.set(task.id, task);
        emit(task, IDLE_FOOTER +
            '❯ the TUI asks "Do you want to proceed?" with "❯ 1. Yes" — handle it\n' + IDLE_FOOTER);

        (spawner as any).sendEnterWithRetry(task, 3, { isInitialPrompt: true });
        // Enter dropped; only startup churn follows, still parked at the input.
        emit(task, STARTUP_CHURN + IDLE_FOOTER);
        vi.advanceTimersByTime(ENTER_CHECK_MS);

        expect(task.state).toBe('starting');
        expect(task.hasStartedProcessing).toBe(false);
        vi.advanceTimersByTime(RETRY_DELAY_MS);
        expect(task.process.write).toHaveBeenCalledTimes(2);
    });

    it('a dialog that paints AFTER classification cancels the already-scheduled retry Enter', () => {
        // The classification runs at t+800ms but the retry Enter is written at
        // t+1300ms. The TUI moves in that 500ms gap: a turn that was accepted all
        // along can park on a permission dialog right after we decided "dropped".
        // Without a re-check immediately before the write, that Enter lands on
        // "❯ 1. Yes" — which is precisely what hasChoiceDialog exists to prevent.
        const task = makeTask();
        (spawner as any).tasks.set(task.id, task);
        emit(task, IDLE_FOOTER);

        (spawner as any).sendEnterWithRetry(task, 5, { isInitialPrompt: true });
        expect(task.process.write).toHaveBeenCalledTimes(1);

        // t+800: only churn on screen so far → classified "dropped", retry queued.
        emit(task, STARTUP_CHURN + IDLE_FOOTER);
        vi.advanceTimersByTime(ENTER_CHECK_MS);
        expect(task.state).toBe('starting');

        // t+800..t+1300: the turn had in fact started; it now parks on a dialog.
        emit(task, PERMISSION_DIALOG);
        vi.advanceTimersByTime(RETRY_DELAY_MS);

        expect(task.process.write).toHaveBeenCalledTimes(1);
        expect(task.state).toBe('busy');
        expect(task.hasStartedProcessing).toBe(true);

        // And it stays stood down for the rest of the budget.
        vi.advanceTimersByTime((ENTER_CHECK_MS + RETRY_DELAY_MS) * 4);
        expect(task.process.write).toHaveBeenCalledTimes(1);
    });

    it('an active turn that only becomes visible in the retry gap also cancels the retry Enter', () => {
        const task = makeTask();
        (spawner as any).tasks.set(task.id, task);
        emit(task, IDLE_FOOTER);

        (spawner as any).sendEnterWithRetry(task, 5, { isInitialPrompt: true });
        emit(task, STARTUP_CHURN + IDLE_FOOTER);
        vi.advanceTimersByTime(ENTER_CHECK_MS);
        expect(task.state).toBe('starting');

        // The marker is a rare one-shot paint; it can land after we sampled.
        emit(task, ACTIVE_TURN_FOOTER);
        vi.advanceTimersByTime(RETRY_DELAY_MS);

        expect(task.process.write).toHaveBeenCalledTimes(1);
        expect(task.state).toBe('busy');
    });
});

describe('sendEnterWithRetry: marker evidence must post-date the Enter we sent', () => {
    let spawner: InstanceType<typeof TaskSpawner>;
    let tmpDir: string;

    function makeTask(): any {
        return {
            id: 't-echo', prompt: 'p', workspaceId: tmpDir,
            process: { write: vi.fn() }, outputHistory: [] as Buffer[], isActive: true,
            initialPromptSent: true, pendingPrompt: null, sessionId: 's1', state: 'starting',
            lastActivity: new Date(), createdAt: new Date(), totalOutputSize: 0,
            lastOutputLength: 0, savedBufferCount: 0, hasStartedProcessing: false,
            promptSubmitAttempts: 0,
        };
    }
    function emit(task: any, text: string): void {
        const buf = Buffer.from(text, 'utf8');
        task.outputHistory.push(buf);
        task.totalOutputSize += buf.length;
    }

    beforeEach(() => {
        vi.stubEnv('STATE_POLLING_MS', '3600000');
        vi.stubEnv('IDLE_TASK_REAP_INTERVAL_MS', '3600000');
        vi.useFakeTimers();
        tmpDir = mkdtempSync(join(homedir(), '.claudia-enter-echo-test-'));
        spawner = new TaskSpawner(join(tmpDir, 'tasks.json'), false);
    });
    afterEach(() => {
        try { spawner.destroy(); } catch { /* ignore */ }
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        vi.unstubAllEnvs();
        vi.useRealTimers();
    });

    it('the marker echoed inside the typed prompt is NOT acceptance evidence', () => {
        // Real case: this repo's own prompts quote the marker ("regex /esc to
        // interrupt/i"). The TUI echoes the prompt into the input box BEFORE Enter,
        // so a fixed trailing-window scan finds the marker and accepts a dropped
        // Enter — reintroducing the exact bug this PR fixes.
        const task = makeTask();
        (spawner as any).tasks.set(task.id, task);
        emit(task, IDLE_FOOTER + '❯ add a regex for "esc to interrupt" to the classifier\n' + IDLE_FOOTER);

        (spawner as any).sendEnterWithRetry(task, 3, { isInitialPrompt: true });
        // Enter dropped; only startup churn follows, still parked at the input.
        emit(task, STARTUP_CHURN + IDLE_FOOTER);
        vi.advanceTimersByTime(ENTER_CHECK_MS);

        expect(task.state).toBe('starting');
        vi.advanceTimersByTime(RETRY_DELAY_MS);
        expect(task.process.write).toHaveBeenCalledTimes(2);
    });

    it('accepts when the marker was painted after Enter but has since scrolled past the tail window', () => {
        // The marker-carrying footer paints ~2-3 times per task, then thousands of
        // bytes of turn output push it out of a fixed 4096-byte tail. Scanning only
        // that tail classifies a live turn as "dropped" and sprays Enter at it.
        const task = makeTask();
        (spawner as any).tasks.set(task.id, task);
        emit(task, IDLE_FOOTER);

        (spawner as any).sendEnterWithRetry(task, 3, { isInitialPrompt: true });
        emit(task, ACTIVE_TURN_FOOTER);
        // ≫ 4096 bytes of turn output, ending on the persistent mode footer that
        // the TUI keeps on screen during a turn (so the idle-veto still matches).
        emit(task, 'streaming tool output line\n'.repeat(400) + IDLE_FOOTER);
        vi.advanceTimersByTime(ENTER_CHECK_MS + RETRY_DELAY_MS);

        expect(task.process.write).toHaveBeenCalledTimes(1);
        expect(task.state).toBe('busy');
    });
});

describe('sendEnterWithRetry: output-length deltas survive the 2MB history trim', () => {
    let spawner: InstanceType<typeof TaskSpawner>;
    let tmpDir: string;

    function makeTask(overrides: Record<string, unknown> = {}): any {
        return {
            id: 't-trim', prompt: 'p', workspaceId: tmpDir,
            process: { write: vi.fn() }, outputHistory: [] as Buffer[], isActive: true,
            initialPromptSent: true, pendingPrompt: null, sessionId: 's1', state: 'idle',
            lastActivity: new Date(), createdAt: new Date(), totalOutputSize: 0,
            lastOutputLength: 0, savedBufferCount: 0, hasStartedProcessing: true,
            promptSubmitAttempts: 0, ...overrides,
        };
    }

    // Mirrors the PTY onData handler in task-spawner: push, then trim the oldest
    // buffers while over the 2MB cap — DECREMENTING totalOutputSize as it goes.
    // That is why totalOutputSize is a ring-buffer size, not a monotonic counter:
    // on a long-running task a post-Enter delta computed from it reads ~0.
    const MAX_HISTORY_SIZE = 2 * 1024 * 1024;
    function emit(task: any, text: string | Buffer): void {
        const buf = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
        task.outputHistory.push(buf);
        task.totalOutputSize += buf.length;
        while (task.totalOutputSize > MAX_HISTORY_SIZE && task.outputHistory.length > 0) {
            const removed = task.outputHistory.shift();
            if (removed) task.totalOutputSize -= removed.length;
        }
    }

    beforeEach(() => {
        vi.stubEnv('STATE_POLLING_MS', '3600000');
        vi.stubEnv('IDLE_TASK_REAP_INTERVAL_MS', '3600000');
        vi.useFakeTimers();
        tmpDir = mkdtempSync(join(homedir(), '.claudia-enter-trim-test-'));
        spawner = new TaskSpawner(join(tmpDir, 'tasks.json'), false);
    });
    afterEach(() => {
        try { spawner.destroy(); } catch { /* ignore */ }
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        vi.unstubAllEnvs();
        vi.useRealTimers();
    });

    it('a follow-up on a task already at the history cap is not misread as a dropped Enter', () => {
        const task = makeTask();
        (spawner as any).tasks.set(task.id, task);
        // Fill to the cap so every further chunk evicts an equal-sized old one.
        emit(task, Buffer.alloc(MAX_HISTORY_SIZE - 1024, 0x2e));
        emit(task, IDLE_FOOTER);

        (spawner as any).sendEnterWithRetry(task, 3, { isInitialPrompt: false });
        expect(task.process.write).toHaveBeenCalledTimes(1);

        // A real turn starts. Net totalOutputSize change is ~0 because the ring
        // buffer evicts as much as it appends — but a turn is plainly underway.
        emit(task, ACTIVE_TURN_FOOTER + 'x'.repeat(4096));
        vi.advanceTimersByTime(ENTER_CHECK_MS + RETRY_DELAY_MS + ENTER_CHECK_MS);

        expect(task.process.write).toHaveBeenCalledTimes(1);
    });

    it('a trim that evicts buffers BEFORE the anchor leaves the delta and window intact', () => {
        const task = makeTask();
        (spawner as any).tasks.set(task.id, task);
        emit(task, 'PRE-ENTER ECHO: esc to interrupt\n');
        emit(task, Buffer.alloc(MAX_HISTORY_SIZE - 8192, 0x2e));
        emit(task, 'ANCHOR\n');
        const anchor = task.outputHistory[task.outputHistory.length - 1];

        emit(task, 'turn output A\n');
        // Push over the cap. FIFO eviction drops the echo and then the big filler,
        // which alone puts us back under — so the anchor survives the trim.
        emit(task, Buffer.alloc(16384, 0x2e));
        emit(task, 'turn output B\n');

        expect(task.outputHistory.includes(anchor)).toBe(true);
        const since = (spawner as any).getOutputSinceAnchor(task, anchor);
        // Exactly the post-anchor bytes — not the ring-buffer size, which the trim
        // decrements and which would read ~0 on a task sitting at the cap.
        expect(since.bytes).toBe(14 + 16384 + 14);
        expect(since.text).toContain('turn output A');
        expect(since.text).toContain('turn output B');
        // The pre-Enter echo must never leak into the evidence window.
        expect(since.text).not.toContain('esc to interrupt');
    });

    it('a trim that evicts the ANCHOR ITSELF still yields a post-Enter-only window', () => {
        // FIFO eviction means: if the anchor is gone, everything still held was
        // appended after it. The window must degrade to "all of it", never to
        // "the whole history including the pre-Enter prompt echo".
        const task = makeTask();
        (spawner as any).tasks.set(task.id, task);
        emit(task, 'PRE-ENTER ECHO: esc to interrupt\n');
        emit(task, Buffer.alloc(1024, 0x2e));
        const anchor = task.outputHistory[task.outputHistory.length - 1];

        // More than a full cap of turn output ⇒ the anchor is evicted too.
        for (let i = 0; i < 9; i++) emit(task, Buffer.alloc(256 * 1024, 0x79));
        emit(task, 'tail of the turn\n');

        expect(task.outputHistory.includes(anchor)).toBe(false);
        const since = (spawner as any).getOutputSinceAnchor(task, anchor);
        expect(since.bytes).toBeGreaterThan(0);
        expect(since.truncated).toBe(true);
        // Byte-exact cap, and no pre-Enter content survives to be misread.
        expect(Buffer.byteLength(since.text, 'utf8')).toBeLessThanOrEqual(65536);
        expect(since.text).not.toContain('esc to interrupt');
        expect(since.text).toContain('tail of the turn');
    });
});
