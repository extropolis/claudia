/**
 * CHARACTERIZATION — Claude Code input delivery and TUI-ready detection.
 *
 * Phase 1a of the pluggable-agents epic (#62). The engine extraction is about
 * to move `createTaskWithClaudeCode` + reconnect into a shared task engine with
 * per-agent adapters. An argv-level parity gate (task-spawner-args.test.ts,
 * session-lifecycle.test.ts) proves the process is STARTED the same way; it
 * proves nothing about how bytes are fed to it afterwards — which is where all
 * the fragile, hard-won behaviour lives.
 *
 * These tests pin the CURRENT behaviour at the process boundary: the exact
 * strings written to the PTY, in order, at the exact millisecond offsets. They
 * are deliberately tight. If the extraction changes any of them, that is a
 * behaviour change that needs a conscious decision, not a silent diff.
 *
 * NOT a statement that the current behaviour is correct — bugs found while
 * writing these are documented in the Phase 1a report, and pinned here as-is.
 *
 * Cross-platform by construction: node-pty is mocked (no real PTY, no bash
 * fixture) and every delay is driven with vitest fake timers, so the Windows,
 * Linux and macOS legs all execute the same assertions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import { makeFakePty, fakePtySpawn, ptys, resetFakePtys, paste, type FakePty } from './helpers/fake-pty.js';

vi.mock('node-pty', () => ({
    spawn: (file: string, args: string[], opts: Record<string, unknown>) => fakePtySpawn(file, args, opts),
}));

import { TaskSpawner } from '../task-spawner.js';

// ---------------------------------------------------------------------------
// scaffolding
// ---------------------------------------------------------------------------

/** The private surface these tests drive. Grey-box on purpose: the public API
 *  cannot reach the retry/queue machinery without a real Claude process. */
interface Internals {
    tasks: Map<string, InternalLike>;
    sendPromptWithRetry(task: InternalLike, prompt: string, maxRetries?: number): void;
    sendEnterWithRetry(task: InternalLike, retriesLeft: number, opts?: Record<string, unknown>): void;
    setupProcessHandlers(task: InternalLike): void;
    startReadyFallbackTimer(task: InternalLike): void;
    isReadyForInitialInput(s: string): boolean;
    transitionTaskState(task: InternalLike, state: string, wit: unknown, reason: string): void;
    writeToTask(id: string, data: string, source?: string, internal?: boolean): void;
}

interface InternalLike {
    id: string;
    process: FakePty;
    state: string;
    outputHistory: Buffer[];
    totalOutputSize: number;
    lastOutputLength: number;
    savedBufferCount: number;
    initialPromptSent: boolean;
    pendingPrompt: string | null;
    pendingFollowupInputs?: string[];
    hasStartedProcessing: boolean;
    isActive: boolean;
    sessionId: string | null;
    lastActivity: Date;
    createdAt: Date;
    workspaceId: string;
    prompt: string;
    [k: string]: unknown;
}

let base: string;
let workspace: string;
let spawner: TaskSpawner;
let internals: Internals;

function makeTask(overrides: Partial<InternalLike> = {}): InternalLike {
    const pty = makeFakePty();
    const t: InternalLike = {
        id: 'task-char-1',
        prompt: 'p',
        workspaceId: workspace,
        process: pty,
        state: 'idle',
        outputHistory: [],
        totalOutputSize: 0,
        lastOutputLength: 0,
        savedBufferCount: 0,
        initialPromptSent: true,
        pendingPrompt: null,
        hasStartedProcessing: true,
        isActive: false,
        sessionId: 'sid-1',
        lastActivity: new Date(),
        createdAt: new Date(),
        ...overrides,
    };
    internals.tasks.set(t.id, t);
    return t;
}

beforeEach(() => {
    resetFakePtys();
    base = mkdtempSync(join(homedir(), '.claudia-char-input-'));
    workspace = join(base, 'ws');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(base, 'tasks.json'), JSON.stringify({ tasks: [], archivedTasks: [] }));

    // Keep every background interval far outside the windows these tests
    // advance through, so nothing but the code under test moves the clock.
    vi.stubEnv('HOME', base);
    vi.stubEnv('USERPROFILE', base);
    vi.stubEnv('STATE_POLLING_MS', '3600000');
    vi.stubEnv('IDLE_TASK_REAP_INTERVAL_MS', '3600000');
    vi.stubEnv('CLAUDIA_MEMORY_BUDGET_PCT', '0');

    vi.useFakeTimers();
    spawner = new TaskSpawner(join(base, 'tasks.json'), false);
    internals = spawner as unknown as Internals;
});

afterEach(() => {
    try { spawner.destroy(); } catch { /* best effort */ }
    vi.useRealTimers();
    vi.unstubAllEnvs();
    try { rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
});

// ===========================================================================
// 1. Initial-prompt delivery: char-by-char vs bracketed paste
// ===========================================================================

describe('CHARACTERIZATION: sendPromptWithRetry framing', () => {
    it('types a SHORT prompt (<=20 chars) one character at a time, 10ms apart', () => {
        const task = makeTask({ state: 'starting' });

        internals.sendPromptWithRetry(task, 'hi');

        // The first character lands synchronously, the rest on the 10ms tick.
        expect(task.process.writes).toEqual(['h']);
        vi.advanceTimersByTime(10);
        expect(task.process.writes).toEqual(['h', 'i']);

        // No bracketed paste anywhere on this path.
        expect(task.process.written()).not.toContain('\x1b[200~');
    });

    it('uses a 5ms per-character cadence for a 21..200 char prompt', () => {
        const task = makeTask({ state: 'starting' });
        const prompt = 'a'.repeat(30);

        internals.sendPromptWithRetry(task, prompt);
        expect(task.process.writes).toHaveLength(1);

        // 5ms apart, not 10: 29 remaining chars land within 145ms.
        vi.advanceTimersByTime(5 * 29);
        expect(task.process.writes).toHaveLength(30);
        expect(task.process.written()).toBe(prompt);
    });

    it('sends Enter 500ms after the last character of a typed prompt', () => {
        const task = makeTask({ state: 'starting' });

        internals.sendPromptWithRetry(task, 'hi');
        vi.advanceTimersByTime(10);        // 'i'
        vi.advanceTimersByTime(10);        // loop sees charIndex === length, arms the 500ms settle
        expect(task.process.writes).toEqual(['h', 'i']);

        vi.advanceTimersByTime(499);
        expect(task.process.writes).toEqual(['h', 'i']);
        vi.advanceTimersByTime(1);
        expect(task.process.writes).toEqual(['h', 'i', '\r']);
    });

    it('stops typing mid-prompt if the PTY dies', () => {
        const task = makeTask({ state: 'starting' });

        internals.sendPromptWithRetry(task, 'abcdef');
        vi.advanceTimersByTime(10);
        expect(task.process.writes).toEqual(['a', 'b']);

        task.state = 'exited';
        vi.advanceTimersByTime(1000);

        // Nothing more is written into a dead native handle.
        expect(task.process.writes).toEqual(['a', 'b']);
    });

    it('pastes a LONG prompt (>200 chars) as ONE bracketed-paste write', () => {
        const task = makeTask({ state: 'starting' });
        const prompt = 'x'.repeat(201);

        internals.sendPromptWithRetry(task, prompt);

        expect(task.process.writes).toEqual([paste(prompt)]);
    });

    it('scales the Enter delay with prompt length: 500ms + 50ms per 100 chars', () => {
        const task = makeTask({ state: 'starting' });
        const prompt = 'x'.repeat(300); // 500 + floor(300/100)*50 = 650ms

        internals.sendPromptWithRetry(task, prompt);
        vi.advanceTimersByTime(649);
        expect(task.process.writes).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(task.process.writes).toEqual([paste(prompt), '\r']);
    });

    it('caps the Enter delay at 2500ms for very long prompts', () => {
        const task = makeTask({ state: 'starting' });
        const prompt = 'x'.repeat(20_000); // uncapped would be 500 + 200*50 = 10500ms

        internals.sendPromptWithRetry(task, prompt);
        vi.advanceTimersByTime(2499);
        expect(task.process.writes).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(task.process.writes[1]).toBe('\r');
    });

    it('strips a stray paste END marker so a prompt cannot close its own paste early', () => {
        const task = makeTask({ state: 'starting' });
        const body = `${'x'.repeat(150)}\x1b[201~${'y'.repeat(100)}`;

        internals.sendPromptWithRetry(task, body);

        const written = task.process.writes[0];
        expect(written.startsWith('\x1b[200~')).toBe(true);
        expect(written.endsWith('\x1b[201~')).toBe(true);
        // Exactly ONE end marker survives — the framing one.
        expect(written.split('\x1b[201~')).toHaveLength(2);
    });

    it('NEVER re-pastes a long prompt on retry — only Enter is retried', () => {
        const task = makeTask({ state: 'starting' });
        const prompt = 'x'.repeat(300);

        internals.sendPromptWithRetry(task, prompt);
        vi.advanceTimersByTime(60_000);

        const pastes = task.process.writes.filter(w => w.includes('\x1b[200~'));
        expect(pastes).toHaveLength(1);
    });

    it('refuses to write at all once the task has left the live map', () => {
        const task = makeTask({ state: 'starting' });
        internals.tasks.delete(task.id);

        internals.sendPromptWithRetry(task, 'hello');
        vi.advanceTimersByTime(5000);

        expect(task.process.writes).toEqual([]);
    });

    it('BUG (pinned): the per-character loop keeps typing into a DESTROYED task', () => {
        // The entry guard checks `state === 'exited' || !tasks.has(id)`, but the
        // per-char continuation only checks `state === 'exited'`. destroyTask()
        // deletes the task from the map and kills the PTY WITHOUT setting
        // state='exited' (task-spawner.ts:4785-4791), so an in-flight typing
        // loop keeps writing to a dead native handle — the exact thing the
        // guards exist to prevent. Documented, not fixed, in Phase 1a.
        const task = makeTask({ state: 'starting' });

        internals.sendPromptWithRetry(task, 'abcdef');
        vi.advanceTimersByTime(10);
        expect(task.process.writes).toEqual(['a', 'b']);

        internals.tasks.delete(task.id);   // what destroyTask does...
        task.process.kill();               // ...and state is left as 'starting'
        vi.advanceTimersByTime(1000);

        expect(task.process.killed).toBe(true);
        expect(task.process.writes).toEqual(['a', 'b', 'c', 'd', 'e', 'f']); // still typing
    });
});

// ===========================================================================
// 2. Enter-retry: the 800ms processing check and the 5-attempt ceiling
// ===========================================================================

describe('CHARACTERIZATION: sendEnterWithRetry (800ms processing check)', () => {
    it('re-sends Enter 1300ms later when no output growth follows it', () => {
        const task = makeTask({ state: 'idle' });

        internals.sendEnterWithRetry(task, 5, { isInitialPrompt: true });
        expect(task.process.writes).toEqual(['\r']);

        // The growth check happens 800ms after Enter; the retry is armed 500ms
        // after that. Nothing in between.
        vi.advanceTimersByTime(1299);
        expect(task.process.writes).toEqual(['\r']);
        vi.advanceTimersByTime(1);
        expect(task.process.writes).toEqual(['\r', '\r']);
    });

    it('stops retrying as soon as output grows by MORE than 10 bytes', () => {
        const task = makeTask({ state: 'idle' });

        internals.sendEnterWithRetry(task, 5, { isInitialPrompt: true });
        task.totalOutputSize = 11; // strictly greater than 0 + 10

        vi.advanceTimersByTime(60_000);
        expect(task.process.writes).toEqual(['\r']);
    });

    it('treats growth of EXACTLY 10 bytes as "not processing" and retries', () => {
        const task = makeTask({ state: 'idle' });

        internals.sendEnterWithRetry(task, 5, { isInitialPrompt: true });
        task.totalOutputSize = 10; // `> before + 10` is false

        vi.advanceTimersByTime(1300);
        expect(task.process.writes).toEqual(['\r', '\r']);
    });

    it('accepts a processing INDICATOR in the output instead of growth', () => {
        const task = makeTask({ state: 'idle' });
        task.outputHistory.push(Buffer.from('✳ Thinking…', 'utf8'));
        task.totalOutputSize = 0; // no growth accounted — the pattern is what saves it

        internals.sendEnterWithRetry(task, 5, { isInitialPrompt: true });
        vi.advanceTimersByTime(60_000);

        expect(task.process.writes).toEqual(['\r']);
    });

    it('gives up after exactly 5 Enters', () => {
        const task = makeTask({ state: 'idle' });

        internals.sendEnterWithRetry(task, 5, { isInitialPrompt: true });
        vi.advanceTimersByTime(120_000);

        expect(task.process.writes.filter(w => w === '\r')).toHaveLength(5);
    });

    it('flips starting -> busy on the initial prompt once processing is detected', () => {
        const task = makeTask({ state: 'starting', hasStartedProcessing: false });
        const states: string[] = [];
        spawner.on('taskStateChanged', (t: { state: string }) => states.push(t.state));

        internals.sendEnterWithRetry(task, 5, { isInitialPrompt: true });
        task.totalOutputSize = 500;
        vi.advanceTimersByTime(800);

        expect(task.state).toBe('busy');
        expect(task.hasStartedProcessing).toBe(true);
        expect(states).toContain('busy');
    });

    it('flips idle -> busy BEFORE writing Enter for follow-up input (not for the initial prompt)', () => {
        const followup = makeTask({ id: 'task-followup', state: 'idle' });
        internals.sendEnterWithRetry(followup, 5, { isInitialPrompt: false });
        expect(followup.state).toBe('busy');

        const initial = makeTask({ id: 'task-initial', state: 'starting' });
        internals.sendEnterWithRetry(initial, 5, { isInitialPrompt: true });
        expect(initial.state).toBe('starting');
    });

    it('honours a custom Enter key (the last char of the user\'s input)', () => {
        const task = makeTask({ state: 'idle' });
        internals.sendEnterWithRetry(task, 5, { isInitialPrompt: false, enterKey: '\n' });
        expect(task.process.writes[0]).toBe('\n');
    });
});

// ===========================================================================
// 3. writeToTask framing
// ===========================================================================

describe('CHARACTERIZATION: writeToTask framing', () => {
    it('splits an idle task\'s message into paste-then-Enter, 500ms apart', () => {
        const task = makeTask({ state: 'idle' });

        internals.writeToTask(task.id, 'hello\r', 'client');

        // Paste lands immediately, WITHOUT the Enter.
        expect(task.process.writes).toEqual([paste('hello')]);
        vi.advanceTimersByTime(499);
        expect(task.process.writes).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(task.process.writes).toEqual([paste('hello'), '\r']);
    });

    it('scales the idle-path Enter delay the same way as the initial prompt', () => {
        const task = makeTask({ state: 'idle' });
        const body = 'z'.repeat(250); // 500 + floor(250/100)*50 = 600ms

        internals.writeToTask(task.id, `${body}\r`, 'client');
        vi.advanceTimersByTime(599);
        expect(task.process.writes).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(task.process.writes[1]).toBe('\r');
    });

    it('does NOT type character-by-character on the writeToTask path, however short', () => {
        // The <=200-char char-by-char cadence is exclusive to the INITIAL prompt.
        const task = makeTask({ state: 'idle' });
        internals.writeToTask(task.id, 'ok\r', 'client');
        expect(task.process.writes).toEqual([paste('ok')]);
    });

    it('writes a BUSY task message RAW and whole — no paste framing, no split Enter', () => {
        const task = makeTask({ state: 'busy' });

        internals.writeToTask(task.id, 'hello\r', 'client');

        // One atomic write of EXACTLY what arrived: message and Enter together,
        // with no bracketed-paste framing.
        //
        // #69 wrapped this path in bracketed paste to stop front-truncation of
        // large pastes; #240 took that back out. While Claude is mid-turn its TUI
        // re-renders constantly, and a paste sequence landing in that window gets
        // mishandled, so the queued message was silently DROPPED. Raw passthrough
        // makes the input look exactly like local typing — which is why the plain
        // `claude` CLI never had this bug: nothing wraps its stdin. The idle path
        // above keeps the paste framing, where it is correct and needed.
        expect(task.process.writes).toEqual(['hello\r']);
        // No delayed Enter and no Enter-retry loop on this path either.
        vi.advanceTimersByTime(60_000);
        expect(task.process.writes).toHaveLength(1);
    });

    it('writes a lone keypress raw, with no framing', () => {
        const task = makeTask({ state: 'idle' });
        internals.writeToTask(task.id, 'a', 'client');
        expect(task.process.writes).toEqual(['a']);
    });

    it('writes a multi-char escape sequence raw when it does not end in Enter', () => {
        const task = makeTask({ state: 'idle' });
        internals.writeToTask(task.id, '\x1b[A', 'client'); // arrow up
        expect(task.process.writes).toEqual(['\x1b[A']);
    });

    it('treats a bare Enter as a keypress, not as a message', () => {
        const task = makeTask({ state: 'idle' });
        internals.writeToTask(task.id, '\r', 'client');
        expect(task.process.writes).toEqual(['\r']);
    });

    it('accepts \\n as a submit key on the message path', () => {
        const task = makeTask({ state: 'idle' });
        internals.writeToTask(task.id, 'hello\n', 'client');
        expect(task.process.writes).toEqual([paste('hello')]);
        vi.advanceTimersByTime(500);
        expect(task.process.writes[1]).toBe('\n');
    });

    it('treats waiting_input like idle: the split paste-then-Enter path, not the busy one', () => {
        const task = makeTask({ state: 'waiting_input' });
        internals.writeToTask(task.id, 'yes\r', 'client');
        expect(task.process.writes).toEqual([paste('yes')]);
    });

    it('strips a stray paste END marker on the idle path ONLY — busy input goes through verbatim', () => {
        // Idle path: the body is wrapped in bracketed paste, so an embedded ESC[201~
        // would close that paste early and split the message in two. It is scrubbed
        // out before the wrap.
        const idle = makeTask({ id: 'task-idle', state: 'idle' });
        internals.writeToTask(idle.id, `a\x1b[201~b\r`, 'client');
        expect(idle.process.writes[0]).toBe(paste('ab'));

        // Busy path: since #240 there is no paste framing here at all, so there is
        // nothing for a stray END marker to terminate — and nothing strips it. The
        // bytes reach the TUI exactly as the client sent them, unmatched marker
        // included. Pinned as the real contract of "write raw, exactly as received".
        const busy = makeTask({ id: 'task-busy', state: 'busy' });
        internals.writeToTask(busy.id, `a\x1b[201~b\r`, 'client');
        expect(busy.process.writes[0]).toBe(`a\x1b[201~b\r`);
    });

    it('silently drops a write to an unknown task', () => {
        expect(() => internals.writeToTask('task-nope', 'hi\r', 'client')).not.toThrow();
        expect(ptys).toHaveLength(0);
    });
});

// ===========================================================================
// 4. pendingPrompt / pendingFollowupInputs queue
// ===========================================================================

describe('CHARACTERIZATION: input queueing while an earlier input is still in flight', () => {
    it('queues a message that arrives before the initial prompt has been delivered', () => {
        const task = makeTask({ state: 'starting', initialPromptSent: false, pendingPrompt: 'the first prompt' });

        internals.writeToTask(task.id, 'second\r', 'client');

        expect(task.process.writes).toEqual([]);
        expect(task.pendingFollowupInputs).toEqual(['second\r']);
    });

    it('preserves FIFO order across several queued messages', () => {
        const task = makeTask({ state: 'starting', initialPromptSent: false, pendingPrompt: 'first' });

        internals.writeToTask(task.id, 'A\r', 'client');
        internals.writeToTask(task.id, 'B\r', 'client');
        internals.writeToTask(task.id, 'C\r', 'client');

        expect(task.pendingFollowupInputs).toEqual(['A\r', 'B\r', 'C\r']);
        expect(task.process.writes).toEqual([]);
    });

    it('keeps queueing once a follow-up is outstanding, even after the initial prompt landed', () => {
        // Ordering inversion guard: initialPromptSent is true and the task is
        // busy, but an EARLIER message is still waiting to flush.
        const task = makeTask({ state: 'busy', initialPromptSent: true, pendingPrompt: null, pendingFollowupInputs: ['A\r'] });

        internals.writeToTask(task.id, 'B\r', 'client');

        expect(task.pendingFollowupInputs).toEqual(['A\r', 'B\r']);
        expect(task.process.writes).toEqual([]);
    });

    it('flushes ONE queued message per settle, 300ms after the transition, in order', () => {
        const task = makeTask({ state: 'busy', pendingFollowupInputs: ['A\r', 'B\r'] });
        const writes = vi.spyOn(spawner, 'writeToTask');

        internals.transitionTaskState(task, 'idle', undefined, 'test');
        vi.advanceTimersByTime(299);
        expect(writes).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(writes).toHaveBeenCalledTimes(1);
        expect(writes).toHaveBeenCalledWith(task.id, 'A\r', 'internal-followup', true);
        expect(task.pendingFollowupInputs).toEqual(['B\r']);

        // The delivered message makes the task busy again; the NEXT settle
        // releases the next one.
        writes.mockClear();
        task.state = 'busy';
        internals.transitionTaskState(task, 'idle', undefined, 'test');
        vi.advanceTimersByTime(300);
        expect(writes).toHaveBeenCalledWith(task.id, 'B\r', 'internal-followup', true);
        expect(task.pendingFollowupInputs).toBeUndefined();
    });

    it('flushes the queue on waiting_input too, not just idle', () => {
        // A continuation that ends at a permission prompt used to trap the
        // queue forever, wedging every later message behind it.
        const task = makeTask({ state: 'busy', pendingFollowupInputs: ['answer\r'] });
        const writes = vi.spyOn(spawner, 'writeToTask');

        internals.transitionTaskState(task, 'waiting_input', 'permission', 'test');
        vi.advanceTimersByTime(300);

        expect(writes).toHaveBeenCalledWith(task.id, 'answer\r', 'internal-followup', true);
    });

    it('appends Enter to a queued entry that has none (the reconnect "continue" follow-up)', () => {
        const task = makeTask({ state: 'busy', pendingFollowupInputs: ['fix the bug'] });
        const writes = vi.spyOn(spawner, 'writeToTask');

        internals.transitionTaskState(task, 'idle', undefined, 'test');
        vi.advanceTimersByTime(300);

        expect(writes).toHaveBeenCalledWith(task.id, 'fix the bug\r', 'internal-followup', true);
    });

    it('will not flush while the initial prompt is still pending', () => {
        const task = makeTask({
            state: 'busy',
            initialPromptSent: false,
            pendingPrompt: 'continue',
            pendingFollowupInputs: ['later\r'],
        });
        const writes = vi.spyOn(spawner, 'writeToTask');

        internals.transitionTaskState(task, 'idle', undefined, 'test');
        vi.advanceTimersByTime(1000);

        expect(writes).not.toHaveBeenCalled();
        expect(task.pendingFollowupInputs).toEqual(['later\r']);
    });

    it('does NOT queue an internal re-delivery — that is what flushes the queue', () => {
        const task = makeTask({ state: 'idle', pendingFollowupInputs: ['A\r'] });

        internals.writeToTask(task.id, 'A\r', 'internal-followup', true);

        expect(task.process.writes).toEqual([paste('A')]);
        expect(task.pendingFollowupInputs).toEqual(['A\r']); // untouched by the write itself
    });

    it('does NOT queue a bare keypress behind a pending prompt (only messages queue)', () => {
        const task = makeTask({ state: 'starting', initialPromptSent: false, pendingPrompt: 'first' });

        internals.writeToTask(task.id, '\x1b', 'client'); // ESC

        expect(task.process.writes).toEqual(['\x1b']);
        expect(task.pendingFollowupInputs).toBeUndefined();
    });
});

// ===========================================================================
// 5. Destructive-input throttle at the PTY boundary
// ===========================================================================

describe('CHARACTERIZATION: destructive-input throttle at the write boundary', () => {
    it('lets the first /clear through and blocks the second within the window', () => {
        const task = makeTask({ state: 'idle' });

        internals.writeToTask(task.id, '/clear\r', 'client');
        expect(task.process.writes).toEqual([paste('/clear')]);

        internals.writeToTask(task.id, '/clear\r', 'client');
        expect(task.process.writes).toEqual([paste('/clear')]); // no second paste
    });

    it('allows a repeat once the 30s window has elapsed', () => {
        const task = makeTask({ state: 'idle' });

        internals.writeToTask(task.id, '/compact\r', 'client');
        vi.advanceTimersByTime(30_001);
        internals.writeToTask(task.id, '/compact\r', 'client');

        expect(task.process.writes.filter(w => w.includes('/compact'))).toHaveLength(2);
    });

    it('an INTERNAL re-delivery bypasses the throttle entirely', () => {
        const task = makeTask({ state: 'idle' });

        internals.writeToTask(task.id, '/clear\r', 'internal-followup', true);
        internals.writeToTask(task.id, '/clear\r', 'internal-followup', true);
        internals.writeToTask(task.id, '/clear\r', 'internal-followup', true);

        expect(task.process.writes.filter(w => w.includes('/clear'))).toHaveLength(3);
    });

    it('throttles per task, not globally', () => {
        const a = makeTask({ id: 'task-a', state: 'idle' });
        const b = makeTask({ id: 'task-b', state: 'idle' });

        internals.writeToTask(a.id, '/reset\r', 'client');
        internals.writeToTask(b.id, '/reset\r', 'client');

        expect(a.process.writes).toHaveLength(1);
        expect(b.process.writes).toHaveLength(1);
    });

    it('does not throttle ordinary input that merely mentions a slash command', () => {
        const task = makeTask({ state: 'busy' });

        internals.writeToTask(task.id, 'please /clear later\r', 'client');
        internals.writeToTask(task.id, 'please /clear later\r', 'client');

        expect(task.process.writes).toHaveLength(2);
    });
});

// ===========================================================================
// 6. TUI-ready detection and the 15s fallback
// ===========================================================================

describe('CHARACTERIZATION: isReadyForInitialInput', () => {
    const READY = [
        ['the "Try ..." hint', 'Try "explain this codebase"'],
        ['the shortcuts footer', '  ? for shortcuts'],
        ['the bypass-permissions banner', 'bypass permissions on'],
        ['the mode-cycle hint', 'shift+tab to cycle'],
        ['a box rule together with the prompt caret', '─────────\n❯ '],
    ] as const;

    for (const [label, sample] of READY) {
        it(`treats ${label} as ready`, () => {
            expect(internals.isReadyForInitialInput(sample)).toBe(true);
        });
    }

    const NOT_READY = [
        ['plain startup noise', 'Loading Claude Code...'],
        ['a box rule with no caret', '──────────────────'],
        ['a caret with no box rule', '❯ '],
        ['empty output', ''],
    ] as const;

    for (const [label, sample] of NOT_READY) {
        it(`does NOT treat ${label} as ready`, () => {
            expect(internals.isReadyForInitialInput(sample)).toBe(false);
        });
    }
});

describe('CHARACTERIZATION: initial-prompt delivery on ready', () => {
    function armed(prompt = 'do the thing') {
        const task = makeTask({ state: 'starting', initialPromptSent: false, pendingPrompt: prompt, hasStartedProcessing: false });
        internals.setupProcessHandlers(task);
        internals.startReadyFallbackTimer(task);
        return task;
    }

    it('holds the prompt until the TUI signals ready, then sends it 1200ms later', () => {
        const task = armed('hi');

        vi.advanceTimersByTime(5_000);
        expect(task.process.writes).toEqual([]);
        expect(task.pendingPrompt).toBe('hi');

        task.process.emitData('? for shortcuts');
        // The flags flip synchronously in the onData handler...
        expect(task.initialPromptSent).toBe(true);
        expect(task.pendingPrompt).toBeNull();
        // ...but the write is deferred 1200ms to let the TUI settle.
        vi.advanceTimersByTime(1199);
        expect(task.process.writes).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(task.process.writes).toEqual(['h']);
    });

    it('reassembles a ready signal that was split across two PTY chunks', () => {
        const task = armed('hi');

        task.process.emitData('? for ');
        expect(task.initialPromptSent).toBe(false);
        task.process.emitData('shortcuts');

        // Neither chunk alone matches; the accumulated-output check does.
        expect(task.initialPromptSent).toBe(true);
    });

    it('detects the ready signal through ANSI colour codes', () => {
        const task = armed('hi');
        task.process.emitData('\x1b[2m\x1b[38;5;244m? for shortcuts\x1b[0m');
        expect(task.initialPromptSent).toBe(true);
    });

    it('clears the fallback timer once ready is detected, so the prompt is sent ONCE', () => {
        const task = armed('hi');

        task.process.emitData('? for shortcuts');
        vi.advanceTimersByTime(60_000);

        // 'h','i' then Enters — but exactly one 'h' and one 'i'.
        expect(task.process.writes.filter(w => w === 'h')).toHaveLength(1);
        expect(task.process.writes.filter(w => w === 'i')).toHaveLength(1);
        expect(task.readyFallbackTimer).toBeUndefined();
    });

    it('FALLBACK: sends the prompt anyway 15s after spawn when ready is never seen', () => {
        const task = armed('hi');

        task.process.emitData('some banner that does not match any ready pattern\n');
        vi.advanceTimersByTime(14_999);
        expect(task.initialPromptSent).toBe(false);
        expect(task.process.writes).toEqual([]);

        vi.advanceTimersByTime(1);
        expect(task.initialPromptSent).toBe(true);
        expect(task.pendingPrompt).toBeNull();

        // Same 500ms settle as the ready path's post-detection delay.
        vi.advanceTimersByTime(499);
        expect(task.process.writes).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(task.process.writes).toEqual(['h']);
    });

    it('FALLBACK is a no-op when there is nothing left to deliver', () => {
        const task = makeTask({ state: 'idle', initialPromptSent: true, pendingPrompt: null });
        internals.startReadyFallbackTimer(task);

        vi.advanceTimersByTime(20_000);

        expect(task.process.writes).toEqual([]);
        expect(task.readyFallbackTimer).toBeUndefined();
    });

    it('extracts a session id from PTY output before any session file appears', () => {
        const task = armed('hi');
        task.sessionId = null; // nothing captured yet
        task.process.emitData('resuming session: aaaaaaaa-bbbb-cccc-dddd-eeeeffff0001\n');
        expect(task.sessionId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeffff0001');
    });
});
