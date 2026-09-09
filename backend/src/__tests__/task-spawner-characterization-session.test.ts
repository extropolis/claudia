/**
 * CHARACTERIZATION — Claude session capture, recovery and reconnect delivery.
 *
 * Phase 1a of the pluggable-agents epic (#62). Session identity is the one
 * piece of Claudia state whose loss is unrecoverable: get it wrong and a task
 * silently resumes a DIFFERENT conversation (or none), and the user's history
 * is gone. `AgentAdapter.sessionStore` is meant to own this per agent, so the
 * current Claude Code semantics need pinning before they move.
 *
 * Everything here runs against a fake `~/.claude/projects/<encoded>/` tree
 * under a temp HOME with node-pty mocked, so it behaves identically on the
 * Windows, Linux and macOS CI legs.
 *
 * session-lifecycle.test.ts already covers the happy `--resume` path and the
 * ambiguity refusal through reconnect; this file pins the polling loop, the
 * timeouts, the *silence* of the capture, and the persistence side effects
 * that suite does not look at.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import { fakePtySpawn, ptys, resetFakePtys, makeFakePty, type FakePty } from './helpers/fake-pty.js';

vi.mock('node-pty', () => ({
    spawn: (file: string, args: string[], opts: Record<string, unknown>) => fakePtySpawn(file, args, opts),
}));

import { TaskSpawner } from '../task-spawner.js';

const TASK_ID = 'task-500-sess';
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0001';

/**
 * Mirrors SESSION_CAPTURE_TIMEOUT_MS in task-spawner.ts, which is module-private
 * (not exported) so it cannot be imported here. #240 raised it from 30s to 10
 * minutes: Claude Code flushes its session .jsonl lazily and can take well over
 * 30s on a slow first turn, so the old window expired before the file existed and
 * the task's history became unrecoverable on the next resume.
 */
const SESSION_CAPTURE_TIMEOUT_MS = 10 * 60 * 1000;

interface Internals {
    tasks: Map<string, Record<string, unknown>>;
    disconnectedTasks: Map<string, Record<string, unknown>>;
    sessionToTaskId: Map<string, string>;
    pendingSessionCapture: Map<string, unknown>;
    sessionCaptureIntervals: Map<string, unknown>;
    startSessionCapture(taskId: string, workspaceId: string): void;
    findSessionForTask(taskId: string, claudeDir: string): string | null;
    workspaceToClaudeFolder(p: string): string;
    getClaudeProjectsDir(p: string): string;
}

let base: string;
let workspace: string;
let claudeDir: string;
let spawner: TaskSpawner;
let internals: Internals;

const encode = (p: string) => p.replace(/[^a-zA-Z0-9-]/g, '-');

/** Seed tasks.json so the spawner boots with one DISCONNECTED task. */
function seedTasks(extra: Record<string, unknown> = {}) {
    writeFileSync(join(base, 'tasks.json'), JSON.stringify({
        tasks: [{
            id: TASK_ID,
            prompt: 'do things',
            workspaceId: workspace,
            createdAt: new Date().toISOString(),
            lastActivity: new Date().toISOString(),
            lastState: 'idle',
            wasInterrupted: false,
            shouldContinue: false,
            backendType: 'claude-code',
            sessionId: SID,
            ...extra,
        }],
        archivedTasks: [],
    }, null, 2));
}

function boot(): void {
    spawner = new TaskSpawner(join(base, 'tasks.json'), false);
    internals = spawner as unknown as Internals;
}

function liveTask(overrides: Record<string, unknown> = {}): Record<string, unknown> & { process: FakePty } {
    const t = {
        id: TASK_ID,
        prompt: 'p',
        workspaceId: workspace,
        process: makeFakePty(),
        state: 'starting',
        outputHistory: [],
        totalOutputSize: 0,
        lastOutputLength: 0,
        savedBufferCount: 0,
        initialPromptSent: false,
        pendingPrompt: 'go',
        hasStartedProcessing: false,
        isActive: false,
        sessionId: null,
        lastActivity: new Date(),
        createdAt: new Date(),
        ...overrides,
    };
    internals.tasks.set(t.id as string, t);
    return t as Record<string, unknown> & { process: FakePty };
}

beforeEach(() => {
    resetFakePtys();
    base = mkdtempSync(join(homedir(), '.claudia-char-sess-'));
    workspace = join(base, 'ws');
    mkdirSync(workspace, { recursive: true });
    claudeDir = join(base, '.claude', 'projects', encode(workspace));
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(base, 'tasks.json'), JSON.stringify({ tasks: [], archivedTasks: [] }));

    vi.stubEnv('HOME', base);
    vi.stubEnv('USERPROFILE', base);
    vi.stubEnv('STATE_POLLING_MS', '3600000');
    vi.stubEnv('IDLE_TASK_REAP_INTERVAL_MS', '3600000');
    vi.stubEnv('CLAUDIA_MEMORY_BUDGET_PCT', '0');
    vi.stubEnv('CC_CLAUDE_ARGS', '');

    vi.useFakeTimers();
});

afterEach(() => {
    try { spawner?.destroy(); } catch { /* best effort */ }
    vi.useRealTimers();
    vi.unstubAllEnvs();
    try { rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
});

// ===========================================================================
// workspace path -> Claude projects folder
// ===========================================================================

describe('CHARACTERIZATION: workspaceToClaudeFolder', () => {
    beforeEach(boot);

    it('replaces every non-alphanumeric character with its OWN dash (no collapsing)', () => {
        expect(internals.workspaceToClaudeFolder('/Users/kb/my_proj.v2')).toBe('-Users-kb-my-proj-v2');
    });

    it('keeps dashes and digits, and dashes a Windows drive colon and backslashes', () => {
        expect(internals.workspaceToClaudeFolder('C:\\Work\\a-b\\c1')).toBe('C--Work-a-b-c1');
    });

    it('is NOT injective — different paths can share a folder', () => {
        // Pinned as-is: '_' and '.' and '/' all map to '-', so two distinct
        // workspaces can land in one Claude projects dir and see each other's
        // transcripts during recovery.
        expect(internals.workspaceToClaudeFolder('/a/b_c')).toBe(internals.workspaceToClaudeFolder('/a/b.c'));
    });

    it('roots the projects dir at HOME/.claude/projects', () => {
        expect(internals.getClaudeProjectsDir(workspace)).toBe(join(base, '.claude', 'projects', encode(workspace)));
    });
});

// ===========================================================================
// startSessionCapture — the 500ms polling loop
// ===========================================================================

describe('CHARACTERIZATION: startSessionCapture', () => {
    beforeEach(boot);

    it('adopts the FIRST .jsonl that appears after capture started, ignoring pre-existing ones', () => {
        writeFileSync(join(claudeDir, 'pre-existing-session.jsonl'), '{}\n');
        const task = liveTask();

        internals.startSessionCapture(TASK_ID, workspace);
        vi.advanceTimersByTime(500);
        expect(task.sessionId).toBeNull(); // the pre-existing file is not ours

        writeFileSync(join(claudeDir, `${SID}.jsonl`), '{"type":"user"}\n');
        vi.advanceTimersByTime(500);

        expect(task.sessionId).toBe(SID);
        expect(internals.sessionToTaskId.get(SID)).toBe(TASK_ID);
    });

    it('saves tasks.json IMMEDIATELY (not debounced) — session ids must survive a hard kill', () => {
        liveTask();
        internals.startSessionCapture(TASK_ID, workspace);
        writeFileSync(join(claudeDir, `${SID}.jsonl`), '{}\n');

        vi.advanceTimersByTime(500);

        const onDisk = JSON.parse(readFileSync(join(base, 'tasks.json'), 'utf8'));
        expect(onDisk.tasks.find((t: { id: string }) => t.id === TASK_ID)?.sessionId).toBe(SID);
    });

    it('stops polling as soon as it adopts a session', () => {
        liveTask();
        internals.startSessionCapture(TASK_ID, workspace);
        writeFileSync(join(claudeDir, `${SID}.jsonl`), '{}\n');
        vi.advanceTimersByTime(500);

        expect(internals.sessionCaptureIntervals.has(TASK_ID)).toBe(false);
        expect(internals.pendingSessionCapture.has(TASK_ID)).toBe(false);
    });

    it('is SILENT — no event is emitted for the private Claude path', () => {
        // The `task:sessionCaptured` event exists only on the CodeBackend
        // (OpenCode) path (task-spawner.ts:696). The Claude path mutates the
        // task and saves; anything downstream learns about it by polling the
        // task list. Pinned so the extraction does not accidentally "fix" this
        // and change the WS surface without a decision.
        liveTask();
        const emit = vi.spyOn(spawner, 'emit');
        internals.startSessionCapture(TASK_ID, workspace);
        writeFileSync(join(claudeDir, `${SID}.jsonl`), '{}\n');

        vi.advanceTimersByTime(500);

        expect(emit).not.toHaveBeenCalled();
    });

    it('does NOT overwrite a LIVE session the task already has, but still stops polling', () => {
        // "Live" means the id still resolves to a .jsonl on disk. Since #240 every
        // fresh task carries a pre-assigned session id, so this guard is what stops
        // the fallback loop from stealing a file that belongs to another task.
        const mine = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0002';
        writeFileSync(join(claudeDir, `${mine}.jsonl`), '{}\n');
        const task = liveTask({ sessionId: mine });

        internals.startSessionCapture(TASK_ID, workspace);
        writeFileSync(join(claudeDir, `${SID}.jsonl`), '{}\n');

        vi.advanceTimersByTime(500);

        expect(task.sessionId).toBe(mine);
        expect(internals.sessionCaptureIntervals.has(TASK_ID)).toBe(false);
    });

    it('DOES adopt the new session when the id it holds is STALE (its .jsonl is gone)', () => {
        // #240 made reconnect non-destructive: skipping --resume no longer nulls the
        // session pointer, so a task whose file vanished keeps a DEAD id while Claude
        // starts a brand-new session. Without this branch the task would stay pinned
        // to the dead id forever and its real conversation would be orphaned.
        const dead = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0003';
        const task = liveTask({ sessionId: dead });
        internals.sessionToTaskId.set(dead, TASK_ID);

        internals.startSessionCapture(TASK_ID, workspace);
        writeFileSync(join(claudeDir, `${SID}.jsonl`), '{}\n');

        vi.advanceTimersByTime(500);

        expect(task.sessionId).toBe(SID);
        expect(internals.sessionToTaskId.get(SID)).toBe(TASK_ID);
        // The dead pointer is retired, not left aliasing the task.
        expect(internals.sessionToTaskId.has(dead)).toBe(false);
    });

    it('polls for the FULL capture window (10 minutes, not 30s) before giving up', () => {
        liveTask();
        internals.startSessionCapture(TASK_ID, workspace);

        // Still armed right up to the boundary — the 30s this test used to assert
        // is nowhere near the give-up point since #240. The guard is a strict `>`,
        // so the tick landing exactly ON the timeout does not fire it.
        vi.advanceTimersByTime(SESSION_CAPTURE_TIMEOUT_MS);
        expect(internals.pendingSessionCapture.has(TASK_ID)).toBe(true);
        expect(internals.sessionCaptureIntervals.has(TASK_ID)).toBe(true);

        vi.advanceTimersByTime(500); // the first tick to cross the timeout
        expect(internals.pendingSessionCapture.has(TASK_ID)).toBe(false);
        expect(internals.sessionCaptureIntervals.has(TASK_ID)).toBe(false);
    });

    it('keeps waiting when the projects dir does not exist yet', () => {
        const otherWs = join(base, 'ws-with-no-claude-dir');
        mkdirSync(otherWs, { recursive: true });
        liveTask({ workspaceId: otherWs });

        internals.startSessionCapture(TASK_ID, otherWs);
        vi.advanceTimersByTime(5_000);

        // Still armed — a missing dir is "not yet", not "never".
        expect(internals.sessionCaptureIntervals.has(TASK_ID)).toBe(true);
    });

    it('BUG (pinned): two tasks in one workspace both adopt the SAME session file', () => {
        // The loop adopts any .jsonl that is new to IT — there is no ownership
        // check tying the file to the task that spawned it. Two tasks started
        // in the same workspace run two independent 500ms loops over the same
        // directory, so the single session file Claude Code created for ONE of
        // them is claimed by BOTH. `sessionToTaskId` then points at whichever
        // ticked last, and a later `--resume` puts two tasks into one
        // conversation. Documented, not fixed, in Phase 1a.
        const a = liveTask({ id: 'task-A', sessionId: null });
        const b = liveTask({ id: 'task-B', sessionId: null });

        internals.startSessionCapture('task-A', workspace);
        internals.startSessionCapture('task-B', workspace);

        writeFileSync(join(claudeDir, `${SID}.jsonl`), '{}\n');
        vi.advanceTimersByTime(500);

        expect(a.sessionId).toBe(SID);
        expect(b.sessionId).toBe(SID);           // <-- the bug
        expect(internals.sessionToTaskId.get(SID)).toBe('task-B'); // last writer wins
    });

    it('starting capture twice replaces the first loop rather than doubling it', () => {
        liveTask();
        internals.startSessionCapture(TASK_ID, workspace);
        const first = internals.sessionCaptureIntervals.get(TASK_ID);
        internals.startSessionCapture(TASK_ID, workspace);
        expect(internals.sessionCaptureIntervals.get(TASK_ID)).not.toBe(first);
        expect(internals.sessionCaptureIntervals.size).toBe(1);
    });
});

// ===========================================================================
// findSessionForTask — recovery only on an UNAMBIGUOUS match
// ===========================================================================

describe('CHARACTERIZATION: findSessionForTask', () => {
    beforeEach(boot);

    it('adopts the session when exactly one transcript mentions the task id', () => {
        writeFileSync(join(claudeDir, 'sess-a.jsonl'), 'unrelated\n');
        writeFileSync(join(claudeDir, 'sess-b.jsonl'), `context ${TASK_ID} marker\n`);

        expect(internals.findSessionForTask(TASK_ID, claudeDir)).toBe('sess-b');
    });

    it('DECLINES when two transcripts mention it — a coordinator listing is not ownership', () => {
        writeFileSync(join(claudeDir, 'sess-a.jsonl'), `${TASK_ID}\n`);
        writeFileSync(join(claudeDir, 'sess-b.jsonl'), `listed tasks: ${TASK_ID}\n`);

        expect(internals.findSessionForTask(TASK_ID, claudeDir)).toBeNull();
    });

    it('returns null when nothing mentions it', () => {
        writeFileSync(join(claudeDir, 'sess-a.jsonl'), 'nothing here\n');
        expect(internals.findSessionForTask(TASK_ID, claudeDir)).toBeNull();
    });

    it('returns null (does not throw) for a directory that does not exist', () => {
        expect(internals.findSessionForTask(TASK_ID, join(base, 'nope'))).toBeNull();
    });

    it('only considers .jsonl files', () => {
        writeFileSync(join(claudeDir, 'notes.txt'), `${TASK_ID}\n`);
        expect(internals.findSessionForTask(TASK_ID, claudeDir)).toBeNull();
    });

    it('matches a bare substring anywhere in the transcript', () => {
        // Pinned as-is: this is a plain `content.includes(taskId)`, so a task id
        // quoted inside a tool RESULT counts as a mention. Ambiguity is the only
        // guard against adopting the wrong conversation.
        writeFileSync(join(claudeDir, 'sess-a.jsonl'), `{"tool_result":"deleted ${TASK_ID}"}\n`);
        expect(internals.findSessionForTask(TASK_ID, claudeDir)).toBe('sess-a');
    });
});

// ===========================================================================
// the --resume existence gate on reconnect
// ===========================================================================

describe('CHARACTERIZATION: resume existence gate', () => {
    const argvOf = (i = 0) => ptys[i].args;

    it('resumes when the session file is on disk', () => {
        writeFileSync(join(claudeDir, `${SID}.jsonl`), '{}\n');
        seedTasks();
        boot();

        expect(spawner.reconnectTask(TASK_ID)).not.toBeNull();
        const args = argvOf();
        expect(args).toContain('--resume');
        expect(args[args.indexOf('--resume') + 1]).toBe(SID);
    });

    it('REFUSES --resume when the jsonl is missing and nothing can be recovered', () => {
        seedTasks(); // pointer to a file that does not exist
        boot();

        expect(spawner.reconnectTask(TASK_ID)).not.toBeNull();
        expect(argvOf()).not.toContain('--resume');
    });

    it('PRESERVES the dead session pointer even though it skips --resume', () => {
        // #240 made this non-destructive. Nulling the pointer used to be permanent:
        // a single transient miss (worktree briefly unmounted, FS hiccup, .jsonl not
        // yet flushed) threw the session away for good and made recovery impossible
        // even after the file reappeared. Keeping the id lets a later reconnect
        // resume it; if Claude starts a genuinely new session instead, the capture
        // loop notices the id is stale and swaps in the new one (see above).
        seedTasks();
        boot();
        spawner.reconnectTask(TASK_ID);

        expect(internals.tasks.get(TASK_ID)?.sessionId).toBe(SID);
        // ...but --resume is still skipped for THIS launch, since the file is gone.
        expect(argvOf()).not.toContain('--resume');
    });

    it('substitutes the recovered session when exactly one transcript owns the task', () => {
        const realSid = 'ffffffff-1111-2222-3333-444455556666';
        writeFileSync(join(claudeDir, `${realSid}.jsonl`), `marker ${TASK_ID}\n`);
        seedTasks();
        boot();

        spawner.reconnectTask(TASK_ID);
        const args = argvOf();
        expect(args[args.indexOf('--resume') + 1]).toBe(realSid);
    });

    it('spawns into the task workspace, not the server cwd', () => {
        writeFileSync(join(claudeDir, `${SID}.jsonl`), '{}\n');
        seedTasks();
        boot();
        spawner.reconnectTask(TASK_ID);
        expect(ptys[0].opts.cwd).toBe(workspace);
    });

    it('refuses to reconnect into a workspace directory that has been removed', () => {
        writeFileSync(join(claudeDir, `${SID}.jsonl`), '{}\n');
        seedTasks();
        boot();
        rmSync(workspace, { recursive: true, force: true });

        expect(spawner.reconnectTask(TASK_ID)).toBeNull();
        expect(ptys).toHaveLength(0);
    });
});

// ===========================================================================
// fresh-spawn wiring (createTask -> InternalTask + the two armed timers)
// ===========================================================================

describe('CHARACTERIZATION: fresh task wiring', () => {
    beforeEach(boot);

    it('spawns into the workspace and holds the prompt for the TUI-ready signal', async () => {
        const task = await spawner.createTask('build the thing', workspace);
        const t = internals.tasks.get(task.id)!;

        expect(ptys).toHaveLength(1);
        expect(ptys[0].opts.cwd).toBe(workspace);
        expect(ptys[0].writes).toEqual([]);            // nothing typed before ready

        expect(t.state).toBe('starting');
        expect(t.initialPromptSent).toBe(false);
        expect(t.pendingPrompt).toBe('build the thing');
        expect(t.hasStartedProcessing).toBe(false);
        expect(t.isActive).toBe(false);

        // #240: the session id is PRE-ASSIGNED via --session-id rather than
        // discovered by watching the filesystem, so it is known the moment the PTY
        // spawns. The old capture race lost history whenever Claude had not flushed
        // its .jsonl yet (it flushes lazily, sometimes only on clean exit) — a
        // restart before that left sessionId null and the conversation orphaned.
        const sessionId = t.sessionId as string;
        expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        const args = ptys[0].args;
        expect(args[args.indexOf('--session-id') + 1]).toBe(sessionId);
        // Registered immediately so output routing works from the first byte.
        expect(internals.sessionToTaskId.get(sessionId)).toBe(task.id);
    });

    it('arms BOTH the 15s ready fallback and the 500ms session-capture loop', async () => {
        const task = await spawner.createTask('go', workspace);

        expect(internals.tasks.get(task.id)!.readyFallbackTimer).toBeDefined();
        expect(internals.sessionCaptureIntervals.has(task.id)).toBe(true);
        expect(internals.pendingSessionCapture.has(task.id)).toBe(true);
    });

    it('a fresh task never gets --resume', async () => {
        await spawner.createTask('go', workspace);
        expect(ptys[0].args).not.toContain('--resume');
    });

    it('records the task under claude-code and gives it a short number', async () => {
        const task = await spawner.createTask('go', workspace);
        expect(task.backendType).toBe('claude-code');
        expect(typeof task.taskNumber).toBe('number');
    });

    it('end-to-end: ready signal -> prompt typed -> Enter, with nothing written before ready', async () => {
        const task = await spawner.createTask('hi', workspace);
        const pty = ptys[0];

        vi.advanceTimersByTime(3_000);
        expect(pty.writes).toEqual([]);

        pty.emitData('╭───────────╮\n│ ? for shortcuts │\n');
        vi.advanceTimersByTime(1_200);   // ready settle
        expect(pty.writes).toEqual(['h']);
        vi.advanceTimersByTime(10);      // char cadence
        expect(pty.writes).toEqual(['h', 'i']);
        vi.advanceTimersByTime(10 + 500); // end-of-typing settle
        expect(pty.writes).toEqual(['h', 'i', '\r']);

        expect(internals.tasks.get(task.id)!.pendingPrompt).toBeNull();
    });
});

// ===========================================================================
// reconnect delivery wiring (planReconnectDelivery -> InternalTask)
// ===========================================================================

describe('CHARACTERIZATION: reconnect delivery wiring', () => {
    beforeEach(() => {
        writeFileSync(join(claudeDir, `${SID}.jsonl`), '{}\n');
    });

    it('a background reconnect starts IDLE with nothing pending and no ready-fallback armed', () => {
        seedTasks();
        boot();
        spawner.reconnectTask(TASK_ID);

        const t = internals.tasks.get(TASK_ID)!;
        expect(t.state).toBe('idle');
        expect(t.initialPromptSent).toBe(true);
        expect(t.pendingPrompt).toBeNull();
        expect(t.hasStartedProcessing).toBe(true);
        expect(t.readyFallbackTimer).toBeUndefined();
        expect(t.isActive).toBe(false);
    });

    it('a user-typed message reconnects into STARTING with the message held as pendingPrompt', () => {
        seedTasks();
        boot();
        spawner.reconnectTask(TASK_ID, 'fix the bug\r');

        const t = internals.tasks.get(TASK_ID)!;
        expect(t.state).toBe('starting');
        expect(t.initialPromptSent).toBe(false);
        expect(t.pendingPrompt).toBe('fix the bug'); // trailing Enter stripped — delivery re-adds it
        expect(t.pendingFollowupInputs).toBeUndefined();
        expect(t.readyFallbackTimer).toBeDefined();
        expect(t.isActive).toBe(true); // stream it back: the user is watching
    });

    it('a MID-TURN task delivers "continue" first and queues the typed message behind it', () => {
        seedTasks({ shouldContinue: true, lastState: 'busy' });
        boot();
        spawner.reconnectTask(TASK_ID, 'fix the bug\r');

        const t = internals.tasks.get(TASK_ID)!;
        expect(t.pendingPrompt).toBe('continue');
        expect(t.pendingFollowupInputs).toEqual(['fix the bug']);
        expect(t.shouldContinue).toBe(true);
    });

    it('a mid-turn task with no typed message delivers only the continuation', () => {
        seedTasks({ shouldContinue: true, lastState: 'busy' });
        boot();
        spawner.reconnectTask(TASK_ID);

        const t = internals.tasks.get(TASK_ID)!;
        expect(t.pendingPrompt).toBe('continue');
        expect(t.pendingFollowupInputs).toBeUndefined();
        expect(t.state).toBe('starting');
    });

    it('shouldContinue is ignored without a session to continue', () => {
        rmSync(join(claudeDir, `${SID}.jsonl`), { force: true });
        seedTasks({ shouldContinue: true, sessionId: null, lastState: 'busy' });
        boot();
        spawner.reconnectTask(TASK_ID);

        const t = internals.tasks.get(TASK_ID)!;
        expect(t.shouldContinue).toBe(false);
        expect(t.pendingPrompt).toBeNull();
        expect(t.state).toBe('idle');
    });

    it('writing to a DISCONNECTED task routes the input through reconnect, not a raw PTY write', () => {
        seedTasks();
        boot();

        spawner.writeToTask(TASK_ID, 'hello there\r', 'client');

        // One spawn, and the message is queued for ready-detection rather than
        // written into a PTY that has not painted its TUI yet.
        expect(ptys).toHaveLength(1);
        expect(ptys[0].writes).toEqual([]);
        expect(internals.tasks.get(TASK_ID)?.pendingPrompt).toBe('hello there');
    });

    it('reconnect emits the resume separator into the live stream but not into persisted history', () => {
        seedTasks();
        boot();
        spawner.reconnectTask(TASK_ID);

        const t = internals.tasks.get(TASK_ID)!;
        expect(t.resumeSeparator).toContain(`Resuming session ${SID}`);
        expect(t.outputHistory).toEqual([]);
    });

    it('re-registers the task under its ORIGINAL id and clears the disconnected entry', () => {
        seedTasks();
        boot();
        expect(internals.disconnectedTasks.has(TASK_ID)).toBe(true);

        spawner.reconnectTask(TASK_ID);

        expect(internals.disconnectedTasks.has(TASK_ID)).toBe(false);
        expect(internals.tasks.has(TASK_ID)).toBe(true);
    });
});
