/**
 * Regression suite for three fixes ported from `fix/busy-task-input-missed`:
 *
 *  1. Busy-task input delivery — input written to a task that is mid-turn must go
 *     to the PTY RAW, not wrapped in bracketed paste. The Claude TUI re-renders
 *     rapidly while working and mishandles a bracketed-paste sequence that lands
 *     in that window, silently dropping the message. The idle path still wraps
 *     (it needs to, to avoid front-truncating large pastes) — both halves are
 *     pinned here because the two paths are one `if/else` apart.
 *
 *  2. `--session-id` pre-assignment — Claudia generates the session uuid and hands
 *     it to Claude at spawn, instead of polling ~/.claude/projects to discover the
 *     id after the fact. Claude flushes that file lazily, so a restart before the
 *     flush used to persist `sessionId: null` and lose the conversation on resume.
 *
 *  3. Non-destructive resume — a missing session file must skip `--resume` for the
 *     launch WITHOUT nulling the persisted id, and findSessionFile must locate a
 *     transcript that ended up under a different project folder (moved workspace,
 *     recreated worktree).
 *
 * node-pty is mocked so create/reconnect run for real without spawning claude.
 * Temp dirs live under homedir(), not os.tmpdir() (see CLAUDE.md gotcha).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const spawnCalls: Array<{ file: string; args: string[]; opts: Record<string, unknown> }> = [];
vi.mock('node-pty', () => ({
    spawn: (file: string, args: string[], opts: Record<string, unknown>) => {
        spawnCalls.push({ file, args, opts });
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

// Keep background intervals from firing mid-assertion.
process.env.STATE_POLLING_MS = '3600000';
process.env.IDLE_TASK_REAP_INTERVAL_MS = '3600000';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0001';
const encodeWorkspace = (p: string) => p.replace(/[^a-zA-Z0-9-]/g, '-');

let base: string;
let workspace: string;
let claudeDir: string;
const spawners: TaskSpawner[] = [];
/** Temp dirs whose removal lost a race with a still-exiting child process. */
const undeleted: string[] = [];

function tryRemove(dir: string): boolean {
    try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        return true;
    } catch {
        return false;
    }
}

function newSpawner(): TaskSpawner {
    // autoReconnect=false: these tests drive reconnectTask explicitly.
    const s = new TaskSpawner(join(base, 'tasks.json'), false);
    spawners.push(s);
    return s;
}

function seedTasks(sessionId: string | null) {
    writeFileSync(join(base, 'tasks.json'), JSON.stringify({
        tasks: [{
            id: 'task-100-abc', prompt: 'do things', workspaceId: workspace,
            createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(),
            lastState: 'idle', wasInterrupted: false, shouldContinue: false,
            backendType: 'claude-code', sessionId,
        }],
        archivedTasks: [],
    }, null, 2));
}

function readPersisted(taskId = 'task-100-abc') {
    const parsed = JSON.parse(readFileSync(join(base, 'tasks.json'), 'utf8'));
    return parsed.tasks.find((t: { id: string }) => t.id === taskId);
}

function makeLiveTask(overrides: Record<string, unknown> = {}) {
    return {
        id: 'task-100-abc',
        prompt: 'p',
        workspaceId: workspace,
        process: { write: vi.fn(), kill: vi.fn() },
        outputHistory: [],
        isActive: false,
        initialPromptSent: true,
        pendingPrompt: null,
        sessionId: null,
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
    spawnCalls.length = 0;
    base = mkdtempSync(join(homedir(), '.claudia-busyinput-test-'));
    workspace = join(base, 'ws');
    mkdirSync(workspace, { recursive: true });
    vi.stubEnv('HOME', base);
    vi.stubEnv('USERPROFILE', base);
    claudeDir = join(base, '.claude', 'projects', encodeWorkspace(workspace));
    mkdirSync(claudeDir, { recursive: true });
});

afterEach(() => {
    while (spawners.length) {
        try { spawners.pop()!.destroy(); } catch { /* ignore */ }
    }
    vi.unstubAllEnvs();
    vi.useRealTimers();
    // createTask fires captureGitStateBefore, which execSyncs git with cwd=workspace.
    // On Windows that child can still hold the directory when afterEach runs, so an
    // immediate rmdir raises EBUSY. Never fail the suite over a teardown race - defer
    // the stragglers to afterAll, by which point those children have exited.
    if (!tryRemove(base)) undeleted.push(base);
});

afterAll(() => {
    for (const dir of undeleted) tryRemove(dir);
    undeleted.length = 0;
});

// ---------------------------------------------------------------------------
// 1. Busy-task input must be written RAW.
// ---------------------------------------------------------------------------
describe('busy-task input delivery', () => {
    it('writes a message to a BUSY task raw — no bracketed paste wrapper', () => {
        const spawner = newSpawner();
        const task = makeLiveTask({ id: 't1', state: 'busy', sessionId: 's1' });
        (spawner as any).tasks.set('t1', task);

        spawner.writeToTask('t1', 'please also update the README\r', 'client');

        const writes = (task.process.write as any).mock.calls.map((c: unknown[]) => c[0] as string);
        expect(writes).toEqual(['please also update the README\r']);
        // The regression: any ESC[200~ / ESC[201~ here is silently swallowed by the
        // mid-turn TUI and the user's message never arrives.
        expect(writes.join('')).not.toContain('\x1b[200~');
        expect(writes.join('')).not.toContain('\x1b[201~');
    });

    it('still wraps a message to an IDLE task in bracketed paste (large-paste truncation guard)', () => {
        vi.useFakeTimers();
        const spawner = newSpawner();
        const task = makeLiveTask({ id: 't1', state: 'idle', sessionId: 's1' });
        (spawner as any).tasks.set('t1', task);

        spawner.writeToTask('t1', 'hello world\r', 'client');

        const first = (task.process.write as any).mock.calls[0][0] as string;
        expect(first).toBe('\x1b[200~hello world\x1b[201~');
    });

    it('writes a single keypress to a busy task raw', () => {
        const spawner = newSpawner();
        const task = makeLiveTask({ id: 't1', state: 'busy', sessionId: 's1' });
        (spawner as any).tasks.set('t1', task);

        spawner.writeToTask('t1', '\x1b', 'client'); // ESC / interrupt

        expect((task.process.write as any).mock.calls.map((c: unknown[]) => c[0])).toEqual(['\x1b']);
    });
});

// ---------------------------------------------------------------------------
// 2. --session-id pre-assignment on the create path.
// ---------------------------------------------------------------------------
describe('session id pre-assignment', () => {
    it('passes --session-id <uuid> at spawn and adopts it as the task sessionId', async () => {
        const spawner = newSpawner();
        const task = await spawner.createTask('build the thing', workspace);

        expect(spawnCalls).toHaveLength(1);
        const args = spawnCalls[0].args;
        expect(args).toContain('--session-id');
        const passed = args[args.indexOf('--session-id') + 1];
        expect(passed).toMatch(UUID_RE);
        // The task must own exactly the id we handed Claude — that identity is the
        // whole point: no filesystem poll, nothing to lose on an abrupt restart.
        expect(task.sessionId).toBe(passed);
    });

    it('never passes --resume alongside --session-id on the create path', async () => {
        const spawner = newSpawner();
        await spawner.createTask('build the thing', workspace);
        expect(spawnCalls[0].args).not.toContain('--resume');
    });

    it('persists the session id synchronously, so an abrupt restart cannot lose it', async () => {
        const spawner = newSpawner();
        const task = await spawner.createTask('build the thing', workspace);

        // Read tasks.json with NO timer advance and no destroy(): the save must have
        // already happened (saveTasks, not the debounced scheduleSave). On Windows a
        // tsx-watch restart TerminateProcess-es the backend, skipping every exit
        // handler, so a debounced write here is a lost session.
        const persisted = readPersisted(task.id);
        expect(persisted).toBeDefined();
        expect(persisted.sessionId).toBe(task.sessionId);
    });

    it('gives two tasks distinct session ids', async () => {
        const spawner = newSpawner();
        const a = await spawner.createTask('one', workspace);
        const b = await spawner.createTask('two', workspace);
        expect(a.sessionId).not.toBe(b.sessionId);
    });
});

// ---------------------------------------------------------------------------
// 3. Non-destructive resume + cross-folder session lookup.
// ---------------------------------------------------------------------------
describe('non-destructive resume', () => {
    it('keeps the persisted sessionId when the session file is missing', () => {
        seedTasks(SID); // pointer to a file that does not exist
        const spawner = newSpawner();
        spawner.reconnectTask('task-100-abc');

        // No --resume this launch (there is nothing to resume)...
        expect(spawnCalls[0].args).not.toContain('--resume');
        // ...but the id survives. Nulling it used to make a transient miss (worktree
        // briefly unmounted, file not yet flushed) permanently unrecoverable.
        expect(readPersisted().sessionId).toBe(SID);
    });

    it('resumes a session whose transcript lives under a DIFFERENT project folder', () => {
        // Workspace moved / worktree recreated: the .jsonl is real, just filed
        // under the old path's folder. A bare existsSync on the expected path
        // misses it and the conversation looks gone.
        const otherFolder = join(base, '.claude', 'projects', 'some-other-encoded-path');
        mkdirSync(otherFolder, { recursive: true });
        writeFileSync(join(otherFolder, `${SID}.jsonl`), '{"type":"user"}\n');

        seedTasks(SID);
        const spawner = newSpawner();
        spawner.reconnectTask('task-100-abc');

        const args = spawnCalls[0].args;
        expect(args).toContain('--resume');
        expect(args[args.indexOf('--resume') + 1]).toBe(SID);
    });

    it('still prefers the expected project folder when the file is there', () => {
        writeFileSync(join(claudeDir, `${SID}.jsonl`), '{"type":"user"}\n');
        seedTasks(SID);
        const spawner = newSpawner();
        spawner.reconnectTask('task-100-abc');

        const args = spawnCalls[0].args;
        expect(args[args.indexOf('--resume') + 1]).toBe(SID);
    });
});

// ---------------------------------------------------------------------------
// 4. Last-chance session capture at disconnect.
// ---------------------------------------------------------------------------
describe('disconnect-time session recovery', () => {
    it('adopts the one transcript that unambiguously names the task', () => {
        const realSid = 'ffffffff-1111-2222-3333-444455556666';
        writeFileSync(join(claudeDir, `${realSid}.jsonl`), 'context task-100-abc marker\n');

        seedTasks(SID);
        const spawner = newSpawner();
        (spawner as any).tasks.set('task-100-abc', makeLiveTask());

        expect(spawner.disconnectTask('task-100-abc')).toBe(true);
        expect((spawner as any).disconnectedTasks.get('task-100-abc').sessionId).toBe(realSid);
        // ...and it is flushed synchronously, not left on the debounce timer where an
        // abrupt restart would discard the very thing we just recovered.
        expect(readPersisted().sessionId).toBe(realSid);
    });

    it('declines an AMBIGUOUS match rather than adopting the wrong conversation', () => {
        // Two transcripts mention the id (a coordinator that listed it, plus the real
        // one). Guessing here relinks the task into someone else's conversation and
        // that mistake is persisted and resumed forever — worse than no session.
        writeFileSync(join(claudeDir, 'ffffffff-1111-2222-3333-444455550001.jsonl'), 'task-100-abc\n');
        writeFileSync(join(claudeDir, 'ffffffff-1111-2222-3333-444455550002.jsonl'), 'listed: task-100-abc\n');

        seedTasks(SID);
        const spawner = newSpawner();
        (spawner as any).tasks.set('task-100-abc', makeLiveTask());

        expect(spawner.disconnectTask('task-100-abc')).toBe(true);
        expect((spawner as any).disconnectedTasks.get('task-100-abc').sessionId).toBeNull();
    });
});
