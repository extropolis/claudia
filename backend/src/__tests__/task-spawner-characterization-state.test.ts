/**
 * CHARACTERIZATION — the Claude Code state machine, sleep/wake detection and
 * child→parent notification gating.
 *
 * Phase 1a of the pluggable-agents epic (#62): `checkTaskStates` +
 * `transitionTaskState` are the heart of the "rich task path" the engine
 * extraction is meant to preserve, and today they exist in two drifted copies
 * (task-spawner.ts vs backends/claude-code-backend.ts). These tests pin the
 * ONE that production actually runs.
 *
 * Grey-box: `checkTaskStates` is driven tick-by-tick over synthetic tasks with
 * a fake PTY, so "two consecutive polls" means exactly two calls, not a
 * timing race against a real process. Same assertions on all three CI legs.
 *
 * Behaviour is pinned AS IT IS. Anything that looks wrong is called out in the
 * Phase 1a report rather than fixed here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import { makeFakePty, fakePtySpawn, resetFakePtys, type FakePty } from './helpers/fake-pty.js';

vi.mock('node-pty', () => ({
    spawn: (file: string, args: string[], opts: Record<string, unknown>) => fakePtySpawn(file, args, opts),
}));

import { TaskSpawner } from '../task-spawner.js';

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

interface Internals {
    tasks: Map<string, InternalLike>;
    disconnectedTasks: Map<string, unknown>;
    pendingParentNotifications: Map<string, Array<{ childId: string; text: string }>>;
    configStore: unknown;
    lastPollTime: number;
    checkTaskStates(): void;
    transitionTaskState(task: InternalLike, state: string, wit: unknown, reason: string): void;
    queueParentNotification(child: InternalLike, state: string): void;
    setupProcessHandlers(task: InternalLike): void;
    reconnectAfterSleep(): Promise<void>;
    captureTokenUsage(taskId: string): Promise<void>;
    captureGitStateAfterTask(taskId: string): Promise<void>;
    isPermissionPrompt(s: string): boolean;
}

let base: string;
let workspace: string;
let spawner: TaskSpawner;
let internals: Internals;

/**
 * A real Claude Code tool-permission dialog: a numbered menu whose options are
 * worded "Yes, Allow" / "No, Deny", plus the Esc/Tab chrome.
 *
 * NOTE (pinned as-is): `detectWaitingForInput` tests the numbered-menu pattern
 * BEFORE the Allow/Deny pattern, so this reports waitingInputType 'question',
 * not 'permission'. `isPermissionPrompt` — a different function, with the
 * checks in the opposite order — still calls it a permission prompt, so
 * skip-permissions auto-accepts it. The two classifiers disagree by design of
 * their ordering, not by intent. See the Phase 1a report.
 */
const PERMISSION_DIALOG = 'Do you want to proceed?\n ❯ 1. Yes, Allow\n   2. No, Deny\nEsc to cancel · Tab to amend';
/** A permission dialog with no numbered menu — this one IS typed 'permission'. */
const ALLOW_DENY_ONLY = 'Claude wants to run `rm -rf`.  Allow   Deny';
/** Output `detectWaitingForInput` calls a question but `isPermissionPrompt` refuses to auto-accept. */
const ASK_USER_QUESTION = 'Which library?\n ❯ 1. axios\n   2. fetch\nEnter to select · ↑/↓ to navigate';

function makeTask(overrides: Partial<InternalLike> = {}): InternalLike {
    const t: InternalLike = {
        id: 'task-state-1',
        prompt: 'p',
        workspaceId: workspace,
        process: makeFakePty(),
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
        lastActivity: new Date(Date.now() - 10_000),
        createdAt: new Date(),
        ...overrides,
    };
    internals.tasks.set(t.id, t);
    return t;
}

/** Replace the task's visible tail AND keep totalOutputSize consistent with it. */
function setOutput(task: InternalLike, text: string): void {
    const buf = Buffer.from(text, 'utf8');
    task.outputHistory = [buf];
    task.totalOutputSize = buf.length;
    task.lastOutputLength = buf.length; // "stable" — no growth since the last poll
}

/** Simulate `bytes` of new PTY output arriving since the previous poll. */
function grow(task: InternalLike, bytes = 100): void {
    task.totalOutputSize += bytes;
}

beforeEach(() => {
    resetFakePtys();
    base = mkdtempSync(join(homedir(), '.claudia-char-state-'));
    workspace = join(base, 'ws');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(base, 'tasks.json'), JSON.stringify({ tasks: [], archivedTasks: [] }));

    vi.stubEnv('HOME', base);
    vi.stubEnv('USERPROFILE', base);
    vi.stubEnv('STATE_POLLING_MS', '3600000');
    vi.stubEnv('IDLE_TASK_REAP_INTERVAL_MS', '3600000');
    vi.stubEnv('CLAUDIA_MEMORY_BUDGET_PCT', '0');

    vi.useFakeTimers();
    spawner = new TaskSpawner(join(base, 'tasks.json'), false);
    internals = spawner as unknown as Internals;

    // Both are fire-and-forget side effects of the busy→idle edge (token
    // parsing off disk, `git status` in the workspace). Neither is what these
    // tests are about, and the real ones touch the filesystem/subprocesses.
    vi.spyOn(internals, 'captureTokenUsage').mockResolvedValue(undefined);
    vi.spyOn(internals, 'captureGitStateAfterTask').mockResolvedValue(undefined);
});

afterEach(() => {
    try { spawner.destroy(); } catch { /* best effort */ }
    vi.useRealTimers();
    vi.unstubAllEnvs();
    try { rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
});

// ===========================================================================
// idle/waiting_input -> busy requires CONSECUTIVE_CHANGES_FOR_BUSY (2) polls
// ===========================================================================

describe('CHARACTERIZATION: output growth -> busy', () => {
    it('needs TWO consecutive polls with growth to move an idle task to busy', () => {
        const task = makeTask({ state: 'idle' });

        grow(task);
        internals.checkTaskStates();
        expect(task.state).toBe('idle');   // one redraw is not work

        grow(task);
        internals.checkTaskStates();
        expect(task.state).toBe('busy');
    });

    it('resets the counter on a quiet poll, so growth must be CONSECUTIVE', () => {
        const task = makeTask({ state: 'idle' });

        grow(task);
        internals.checkTaskStates();      // 1
        internals.checkTaskStates();      // quiet — counter back to 0
        grow(task);
        internals.checkTaskStates();      // 1 again, not 2
        expect(task.state).toBe('idle');

        grow(task);
        internals.checkTaskStates();
        expect(task.state).toBe('busy');
    });

    it('applies the same two-poll debounce from waiting_input', () => {
        const task = makeTask({ state: 'waiting_input', waitingInputType: 'permission' });

        grow(task);
        internals.checkTaskStates();
        expect(task.state).toBe('waiting_input');
        grow(task);
        internals.checkTaskStates();
        expect(task.state).toBe('busy');
        expect(task.waitingInputType).toBeUndefined();
    });

    it('keeps a "starting" task in starting while it is only painting its TUI', () => {
        const task = makeTask({ state: 'starting', hasStartedProcessing: false });

        for (let i = 0; i < 5; i++) { grow(task); internals.checkTaskStates(); }

        expect(task.state).toBe('starting');
    });

    it('moves starting -> busy on the FIRST growth once the prompt has been accepted', () => {
        const task = makeTask({ state: 'starting', hasStartedProcessing: true });

        grow(task);
        internals.checkTaskStates();

        expect(task.state).toBe('busy'); // no two-poll debounce on this edge
    });

    it('moves any other live state to busy on a single growth (no debounce)', () => {
        const task = makeTask({ state: 'disconnected' });

        grow(task);
        internals.checkTaskStates();

        expect(task.state).toBe('busy');
    });

    it('leaves a busy task busy while output keeps growing', () => {
        const task = makeTask({ state: 'busy' });
        const seen: string[] = [];
        spawner.on('taskStateChanged', (t: { state: string }) => seen.push(t.state));

        for (let i = 0; i < 4; i++) { grow(task); internals.checkTaskStates(); }

        expect(task.state).toBe('busy');
        expect(seen).toEqual([]); // and emits nothing — no state churn
    });
});

// ===========================================================================
// stable output: busy -> waiting_input / idle
// ===========================================================================

describe('CHARACTERIZATION: stable output -> waiting_input or idle', () => {
    it('classifies a stable permission dialog as waiting_input and announces it', () => {
        const task = makeTask({ state: 'busy' });
        setOutput(task, PERMISSION_DIALOG);
        const waiting: Array<[string, string]> = [];
        spawner.on('taskWaitingInput', (id: string, type: string) => waiting.push([id, type]));

        internals.checkTaskStates();

        expect(task.state).toBe('waiting_input');
        // 'question', NOT 'permission' — the numbered-menu branch matches first.
        expect(task.waitingInputType).toBe('question');
        expect(waiting).toEqual([[task.id, 'question']]);
    });

    it('types a bare Allow/Deny dialog (no numbered menu) as permission', () => {
        const task = makeTask({ state: 'busy' });
        setOutput(task, ALLOW_DENY_ONLY);

        internals.checkTaskStates();

        expect(task.state).toBe('waiting_input');
        expect(task.waitingInputType).toBe('permission');
    });

    it('settles a stable busy task with no prompt to idle (after token capture resolves)', async () => {
        const task = makeTask({ state: 'busy' });
        setOutput(task, 'All done. Wrote 3 files.\n');

        internals.checkTaskStates();
        // The idle transition is deliberately deferred until captureTokenUsage
        // settles, so the persisted record carries the run's cost.
        expect(task.state).toBe('busy');
        await vi.advanceTimersByTimeAsync(0);
        expect(task.state).toBe('idle');
        expect(internals.captureTokenUsage).toHaveBeenCalledWith(task.id);
        expect(internals.captureGitStateAfterTask).toHaveBeenCalledWith(task.id);
    });

    it('abandons the deferred idle transition if a new turn started meanwhile', async () => {
        const task = makeTask({ state: 'busy' });
        setOutput(task, 'done\n');

        internals.checkTaskStates();
        task.state = 'waiting_input'; // the user's next turn beat the token capture
        await vi.advanceTimersByTimeAsync(0);

        expect(task.state).toBe('waiting_input');
    });

    it('never moves a stable "starting" task to idle — it waits for Enter to be accepted', async () => {
        const task = makeTask({ state: 'starting', hasStartedProcessing: false });
        setOutput(task, '? for shortcuts');

        internals.checkTaskStates();
        await vi.advanceTimersByTimeAsync(0);

        expect(task.state).toBe('starting');
    });

    it('leaves an idle task idle when nothing changes', () => {
        const task = makeTask({ state: 'idle' });
        setOutput(task, 'nothing new');
        internals.checkTaskStates();
        expect(task.state).toBe('idle');
    });
});

// ===========================================================================
// skip-permissions auto-accept short circuit
// ===========================================================================

describe('CHARACTERIZATION: skip-permissions auto-accept', () => {
    function enableSkipPermissions(value = true) {
        internals.configStore = { getSkipPermissions: () => value } as unknown;
    }

    it('writes a bare \\r to the PTY and does NOT change state', () => {
        enableSkipPermissions();
        const task = makeTask({ state: 'busy' });
        setOutput(task, PERMISSION_DIALOG);
        const seen: string[] = [];
        spawner.on('taskStateChanged', (t: { state: string }) => seen.push(t.state));

        internals.checkTaskStates();

        expect(task.process.writes).toEqual(['\r']);
        expect(task.state).toBe('busy');   // short-circuits the transition entirely
        expect(seen).toEqual([]);
    });

    it('re-accepts on every poll while the dialog is still on screen', () => {
        enableSkipPermissions();
        const task = makeTask({ state: 'busy' });
        setOutput(task, PERMISSION_DIALOG);

        internals.checkTaskStates();
        internals.checkTaskStates();
        internals.checkTaskStates();

        expect(task.process.writes).toEqual(['\r', '\r', '\r']);
    });

    it('auto-accepts a bare Allow/Deny dialog too', () => {
        enableSkipPermissions();
        const task = makeTask({ state: 'busy' });
        setOutput(task, ALLOW_DENY_ONLY);

        internals.checkTaskStates();

        expect(task.process.writes).toEqual(['\r']);
        expect(task.state).toBe('busy');
    });

    it('BUG (pinned): a dialog Enter does not dismiss is hammered once per poll, forever', () => {
        // `\r` does not grow totalOutputSize, so the next poll sees "stable
        // output + busy + input detected" again and writes another Enter. If
        // the TUI needs a different key (or has already gone), this is an
        // unbounded Enter stream at STATE_POLLING_MS (3s in production).
        enableSkipPermissions();
        const task = makeTask({ state: 'busy' });
        setOutput(task, 'This command cannot be statically analyzed\n ❯ 1. Yes\n   2. No');

        for (let i = 0; i < 20; i++) internals.checkTaskStates();

        expect(task.process.writes).toHaveLength(20);
        expect(task.state).toBe('busy'); // never surfaces to the user either
    });

    it('does NOT auto-accept a genuine AskUserQuestion prompt', () => {
        enableSkipPermissions();
        const task = makeTask({ state: 'busy' });
        setOutput(task, ASK_USER_QUESTION);

        internals.checkTaskStates();

        expect(task.process.writes).toEqual([]);
        expect(task.state).toBe('waiting_input');
        expect(task.waitingInputType).toBe('question');
    });

    it('pauses for the user when skip-permissions is off', () => {
        enableSkipPermissions(false);
        const task = makeTask({ state: 'busy' });
        setOutput(task, PERMISSION_DIALOG);

        internals.checkTaskStates();

        expect(task.process.writes).toEqual([]);
        expect(task.state).toBe('waiting_input');
    });
});

describe('CHARACTERIZATION: isPermissionPrompt (what auto-accept will answer for you)', () => {
    const YES: Array<[string, string]> = [
        ['an Allow/Deny dialog', 'Allow this tool? Allow / Deny'],
        ['a numbered Yes/No menu', '❯ 1. Yes\n  2. No'],
        ['a static-analysis warning', 'This command cannot be statically analyzed'],
        ['shell-syntax chrome', 'contains shell syntax we cannot verify'],
        ['tool-use chrome', 'Esc to cancel · Tab to amend'],
    ];
    for (const [label, s] of YES) {
        it(`auto-accepts ${label}`, () => expect(internals.isPermissionPrompt(s)).toBe(true));
    }

    const NO: Array<[string, string]> = [
        ['an AskUserQuestion menu', 'Enter to select · ↑/↓ to navigate'],
        // The AskUserQuestion guard wins even when Allow/Deny chrome is present.
        ['an AskUserQuestion menu that also mentions Allow and Deny', 'Allow / Deny — Enter to select · ↑/↓ to navigate'],
        ['ordinary prose', 'I finished the refactor.'],
    ];
    for (const [label, s] of NO) {
        it(`does NOT auto-accept ${label}`, () => expect(internals.isPermissionPrompt(s)).toBe(false));
    }
});

// ===========================================================================
// transition lock, and the exited bypass
// ===========================================================================

describe('CHARACTERIZATION: state-transition lock', () => {
    it('skips a locked task entirely during polling', () => {
        const task = makeTask({ state: 'idle', stateTransitionLock: true });

        grow(task);
        internals.checkTaskStates();
        grow(task);
        internals.checkTaskStates();

        expect(task.state).toBe('idle');
        // The lock also short-circuits the lastOutputLength bookkeeping.
        expect(task.lastOutputLength).toBe(0);
    });

    it('drops a transition requested while the lock is held', () => {
        const task = makeTask({ state: 'idle', stateTransitionLock: true });
        internals.transitionTaskState(task, 'busy', undefined, 'test');
        expect(task.state).toBe('idle');
    });

    it('releases the lock after a successful transition', () => {
        const task = makeTask({ state: 'idle' });
        internals.transitionTaskState(task, 'busy', undefined, 'test');
        expect(task.state).toBe('busy');
        expect(task.stateTransitionLock).toBe(false);
    });

    it('emits nothing for a no-op transition', () => {
        const task = makeTask({ state: 'idle' });
        const seen: string[] = [];
        spawner.on('taskStateChanged', (t: { state: string }) => seen.push(t.state));
        internals.transitionTaskState(task, 'idle', undefined, 'test');
        expect(seen).toEqual([]);
    });

    it('resets processStartedAt when entering busy from a non-active state', () => {
        const task = makeTask({ state: 'idle', processStartedAt: new Date(0), parentNotifiedThisRun: true });
        internals.transitionTaskState(task, 'busy', undefined, 'test');
        expect((task.processStartedAt as Date).getTime()).toBeGreaterThan(0);
        expect(task.parentNotifiedThisRun).toBe(false); // a new run may notify again
    });

    it('EXIT bypasses the lock: onExit sets state directly even while locked', () => {
        const task = makeTask({ state: 'busy', stateTransitionLock: true });
        internals.setupProcessHandlers(task);
        const seen: string[] = [];
        spawner.on('taskStateChanged', (t: { state: string }) => seen.push(t.state));

        task.process.emitExit(1);

        expect(task.state).toBe('exited');
        expect(seen).toEqual(['exited']);
    });

    it('polling ignores an exited task completely', () => {
        const task = makeTask({ state: 'exited' });
        grow(task);
        internals.checkTaskStates();
        grow(task);
        internals.checkTaskStates();
        expect(task.state).toBe('exited');
    });
});

// ===========================================================================
// sleep / wake
// ===========================================================================

describe('CHARACTERIZATION: sleep/wake detection', () => {
    it('schedules reconnectAfterSleep 3s after a poll gap over 30s', async () => {
        const reconnect = vi.spyOn(internals, 'reconnectAfterSleep').mockResolvedValue(undefined);
        makeTask({ state: 'idle' });

        internals.lastPollTime = Date.now() - 30_001;
        internals.checkTaskStates();

        expect(reconnect).not.toHaveBeenCalled(); // PTYs get a moment to report their exits
        await vi.advanceTimersByTimeAsync(2_999);
        expect(reconnect).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(reconnect).toHaveBeenCalledTimes(1);
    });

    it('treats a gap of EXACTLY 30s as normal scheduling jitter', async () => {
        const reconnect = vi.spyOn(internals, 'reconnectAfterSleep').mockResolvedValue(undefined);
        internals.lastPollTime = Date.now() - 30_000;
        internals.checkTaskStates();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(reconnect).not.toHaveBeenCalled();
    });

    it('records the poll time on every tick so the gap is measured between TICKS', () => {
        internals.lastPollTime = Date.now() - 60_000;
        internals.checkTaskStates();
        expect(internals.lastPollTime).toBe(Date.now());
    });

    it('wake handling is independent of whether any task is live', async () => {
        const reconnect = vi.spyOn(internals, 'reconnectAfterSleep').mockResolvedValue(undefined);
        internals.lastPollTime = Date.now() - 120_000;
        internals.checkTaskStates();     // no tasks at all
        await vi.advanceTimersByTimeAsync(3_000);
        expect(reconnect).toHaveBeenCalledTimes(1);
    });

    it('reconnectAfterSleep only adopts exited tasks that have a session to resume', async () => {
        const withSession = makeTask({ id: 'task-with-sid', state: 'exited', sessionId: 'sid-a' });
        const withoutSession = makeTask({ id: 'task-no-sid', state: 'exited', sessionId: null });
        const disconnect = vi.spyOn(spawner, 'disconnectTask').mockReturnValue(true);
        vi.spyOn(spawner, 'reconnectTask').mockReturnValue(null);

        await internals.reconnectAfterSleep();

        expect(disconnect).toHaveBeenCalledWith(withSession.id);
        expect(disconnect).not.toHaveBeenCalledWith(withoutSession.id);
    });

    it('reconnectAfterSleep is a no-op when nothing died', async () => {
        makeTask({ state: 'idle' });
        const disconnect = vi.spyOn(spawner, 'disconnectTask');
        await internals.reconnectAfterSleep();
        expect(disconnect).not.toHaveBeenCalled();
    });
});

// ===========================================================================
// child -> parent notification gating
// ===========================================================================

describe('CHARACTERIZATION: parent notification gating on transition', () => {
    function child(overrides: Partial<InternalLike> = {}) {
        return makeTask({
            id: 'task-child',
            parentTaskId: 'task-parent',
            taskNumber: 7,
            hasStartedProcessing: true,
            ...overrides,
        });
    }

    it('notifies the parent when a child leaves busy for idle', () => {
        const c = child({ state: 'busy' });
        const queue = vi.spyOn(internals, 'queueParentNotification');
        internals.transitionTaskState(c, 'idle', undefined, 'test');
        expect(queue).toHaveBeenCalledWith(c, 'idle');
    });

    it('notifies when a child stops at a prompt (waiting_input)', () => {
        const c = child({ state: 'busy' });
        const queue = vi.spyOn(internals, 'queueParentNotification');
        internals.transitionTaskState(c, 'waiting_input', 'permission', 'test');
        expect(queue).toHaveBeenCalledWith(c, 'waiting_input');
    });

    it('does NOT notify for a child that never started processing', () => {
        const c = child({ state: 'starting', hasStartedProcessing: false });
        const queue = vi.spyOn(internals, 'queueParentNotification');
        internals.transitionTaskState(c, 'idle', undefined, 'test');
        expect(queue).not.toHaveBeenCalled();
    });

    it('does NOT notify on an edge that is not a completion (idle -> busy)', () => {
        const c = child({ state: 'idle' });
        const queue = vi.spyOn(internals, 'queueParentNotification');
        internals.transitionTaskState(c, 'busy', undefined, 'test');
        expect(queue).not.toHaveBeenCalled();
    });

    it('does NOT notify a task with no parent', () => {
        const orphan = makeTask({ id: 'task-orphan', state: 'busy', parentTaskId: undefined });
        const queue = vi.spyOn(internals, 'queueParentNotification');
        internals.transitionTaskState(orphan, 'idle', undefined, 'test');
        expect(queue).not.toHaveBeenCalled();
    });

    it('EXIT notifies the parent directly, bypassing transitionTaskState AND the hasStartedProcessing gate', () => {
        const c = child({ state: 'starting', hasStartedProcessing: false });
        internals.setupProcessHandlers(c);

        c.process.emitExit(127); // died before it ever produced a turn

        const queued = internals.pendingParentNotifications.get('task-parent');
        expect(queued).toHaveLength(1);
        expect(queued![0].text).toContain('#7');
        expect(queued![0].text).toContain('has exited');
    });

    it('only delivers to a parent that is idle with nothing of its own outstanding', () => {
        const parent = makeTask({ id: 'task-parent', state: 'busy' });
        const c = child({ state: 'busy' });
        const write = vi.spyOn(spawner, 'writeToTask').mockImplementation(() => {});

        internals.transitionTaskState(c, 'idle', undefined, 'test');
        vi.advanceTimersByTime(2_000);
        expect(write).not.toHaveBeenCalled();
        expect(internals.pendingParentNotifications.get('task-parent')).toHaveLength(1);

        // The parent's own next settle releases it.
        parent.state = 'busy';
        internals.transitionTaskState(parent, 'idle', undefined, 'test');
        vi.advanceTimersByTime(2_000);
        expect(write).toHaveBeenCalledTimes(1);
        expect(write.mock.calls[0][1]).toContain('[CLAUDIA TASK UPDATE');
        expect(write.mock.calls[0][2]).toBe('internal-followup');
    });

    it('a queued follow-up input wins the same idle tick — notices wait for the next one', () => {
        const parent = makeTask({ id: 'task-parent', state: 'busy', pendingFollowupInputs: ['type this\r'] });
        internals.pendingParentNotifications.set('task-parent', [{ childId: 'task-child', text: '[CLAUDIA TASK UPDATE: ...]' }]);
        const write = vi.spyOn(spawner, 'writeToTask').mockImplementation(() => {});

        internals.transitionTaskState(parent, 'idle', undefined, 'test');
        vi.advanceTimersByTime(2_000);

        expect(write).toHaveBeenCalledTimes(1);
        expect(write.mock.calls[0][1]).toBe('type this\r');
        expect(internals.pendingParentNotifications.get('task-parent')).toHaveLength(1); // still queued
    });
});
