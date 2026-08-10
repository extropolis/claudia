/**
 * ClaudeCodeBackend: the shared CodeBackend contract + Claude-specific
 * behaviour (argv construction at the real process boundary, CLI switch
 * mapping, resume fallback, auth-warning filtering, history lazy-loading and
 * the TUI output heuristics).
 *
 * Everything that can be driven through a real process is: the fake CLI
 * (fixtures/fake-agent.sh) is put on PATH and spawned through node-pty, and
 * assertions read the argv/stdin/env it logged to disk.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import type { WaitingInputType, TaskGitState } from '@claudia/shared';
import { ClaudeCodeBackend } from '../backends/claude-code-backend.js';
import type { ConfigStore, ClaudeCodeSwitches } from '../config-store.js';
import { DEFAULT_CLAUDE_CODE_SWITCHES } from '../config-store.js';
import { setupFakeCli, claudeProjectsDir, type FakeCliEnv } from './backend-test-env.js';
import {
    runCodeBackendContract, waitFor, readIf, argLines, containsSubsequence, isWin,
    type BackendHarness, type SpawnCtx,
} from './backend-contract.js';

const uuid = () =>
    `${randomBytes(4).toString('hex')}-${randomBytes(2).toString('hex')}-${randomBytes(2).toString('hex')}-${randomBytes(2).toString('hex')}-${randomBytes(6).toString('hex')}`;

/** White-box access to the pure TUI heuristics (no public surface for them). */
interface ClaudePrivates {
    detectWaitingForInput(s: string): WaitingInputType | null;
    isReadyForInitialInput(s: string): boolean;
    stripAnsi(s: string): string;
    filterAuthConflictWarning(s: string): string;
    getClaudeProjectsDir(p: string): string;
    extractSessionId(s: string): string | null;
}
const priv = (b: ClaudeCodeBackend): ClaudePrivates => b as unknown as ClaudePrivates;

function fakeConfigStore(switches: Partial<ClaudeCodeSwitches>, skipPermissions = false): ConfigStore {
    return {
        getClaudeCodeSwitches: () => ({ ...DEFAULT_CLAUDE_CODE_SWITCHES, ...switches }),
        getSkipPermissions: () => skipPermissions,
    } as unknown as ConfigStore;
}

// =====================================================================
// 1. The shared contract
// =====================================================================
runCodeBackendContract('claude-code', (): BackendHarness => {
    const cli = setupFakeCli('claude');
    // No ConfigStore: keeps the contract's argv assertions free of switch noise.
    const backend = new ClaudeCodeBackend(undefined, cli.historyDir);

    return {
        backend,
        workspace: cli.workspace,
        emptyBinDir: cli.emptyBinDir,
        newSpawn(label, extra = {}): SpawnCtx {
            const dir = cli.fakeDir(label);
            // A unique session id per spawn: Claude captures sessions by
            // spotting a NEW *.jsonl in the projects dir, so reusing an id
            // across spawns would make the second capture unobservable.
            const sessionId = uuid();
            return { fakeDir: dir, sessionId, env: cli.env(dir, { CLAUDIA_FAKE_SID: sessionId, ...extra }) };
        },
        ensureResumableSession(sessionId) {
            const dir = claudeProjectsDir(cli.base, cli.workspace);
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, `${sessionId}.jsonl`), `{"type":"user","sessionId":"${sessionId}"}\n`);
        },
        resumeArgs: (sessionId) => ['--resume', sessionId],
        cleanup: () => cli.restore(),
    };
});

// =====================================================================
// 2. Argv construction at the true process boundary
// =====================================================================
describe.skipIf(isWin)('ClaudeCodeBackend: argv at the process boundary', () => {
    let cli: FakeCliEnv;

    beforeAll(() => { cli = setupFakeCli('claude'); });
    afterAll(() => { cli.restore(); });

    async function spawnAndReadArgs(
        backend: ClaudeCodeBackend,
        label: string,
        config: { prompt: string; workspaceId: string; systemPrompt?: string; skipPermissions?: boolean; model?: string }
    ): Promise<{ args: string[]; env: string; taskId: string; dir: string }> {
        const dir = cli.fakeDir(label);
        const task = await backend.createTask(config, cli.env(dir));
        await waitFor(() => argLines(dir).length > 0 || existsSync(join(dir, 'cwd.log')), v => v, 15000);
        await waitFor(() => readIf(join(dir, 'env.log')), s => s.length > 0, 15000);
        return { args: argLines(dir), env: readIf(join(dir, 'env.log')), taskId: task.id, dir };
    }

    it('passes --dangerously-skip-permissions, --system-prompt and --model in that order', async () => {
        const backend = new ClaudeCodeBackend(undefined, cli.historyDir);
        try {
            const { args, taskId } = await spawnAndReadArgs(backend, 'argv-basic', {
                prompt: 'p',
                workspaceId: cli.workspace,
                skipPermissions: true,
                systemPrompt: '  You are a test harness  ',
                model: 'claude-sonnet-4-5',
            });
            expect(args).toContain('--dangerously-skip-permissions');
            // The system prompt is trimmed before it reaches argv.
            expect(containsSubsequence(args, ['--system-prompt', 'You are a test harness'])).toBe(true);
            expect(containsSubsequence(args, ['--model', 'claude-sonnet-4-5'])).toBe(true);
            backend.destroyTask(taskId);
        } finally {
            await backend.shutdown();
        }
    }, 30000);

    it('omits every optional flag when the config is bare', async () => {
        const backend = new ClaudeCodeBackend(undefined, cli.historyDir);
        try {
            const { args, taskId } = await spawnAndReadArgs(backend, 'argv-bare', {
                prompt: 'p',
                workspaceId: cli.workspace,
            });
            expect(args).not.toContain('--dangerously-skip-permissions');
            expect(args).not.toContain('--system-prompt');
            expect(args).not.toContain('--model');
            backend.destroyTask(taskId);
        } finally {
            await backend.shutdown();
        }
    }, 30000);

    it('ignores a whitespace-only system prompt', async () => {
        const backend = new ClaudeCodeBackend(undefined, cli.historyDir);
        try {
            const { args, taskId } = await spawnAndReadArgs(backend, 'argv-blank-sysprompt', {
                prompt: 'p',
                workspaceId: cli.workspace,
                systemPrompt: '   ',
            });
            expect(args).not.toContain('--system-prompt');
            expect(backend.getTask(taskId)!.systemPrompt).toBeUndefined();
            backend.destroyTask(taskId);
        } finally {
            await backend.shutdown();
        }
    }, 30000);

    it('expands CC_CLAUDE_ARGS ahead of the generated flags', async () => {
        process.env.CC_CLAUDE_ARGS = '--debug --foo bar';
        const backend = new ClaudeCodeBackend(undefined, cli.historyDir);
        try {
            const { args, taskId } = await spawnAndReadArgs(backend, 'argv-ccargs', {
                prompt: 'p',
                workspaceId: cli.workspace,
                model: 'zzz',
            });
            expect(args.slice(0, 3)).toEqual(['--debug', '--foo', 'bar']);
            expect(args.indexOf('--model')).toBeGreaterThan(2);
            backend.destroyTask(taskId);
        } finally {
            delete process.env.CC_CLAUDE_ARGS;
            await backend.shutdown();
        }
    }, 30000);

    it('renders every ClaudeCodeSwitches field and exports the effort level as an env var', async () => {
        const backend = new ClaudeCodeBackend(
            fakeConfigStore({
                verbose: true,
                maxTurns: 7,
                maxBudgetUsd: 12.5,
                permissionMode: 'safe',
                allowedTools: '  Bash,Read  ',
                disallowedTools: ' WebFetch ',
                appendSystemPrompt: ' extra rules ',
                effortLevel: 'medium',
            }),
            cli.historyDir
        );
        try {
            const { args, env, taskId } = await spawnAndReadArgs(backend, 'argv-switches', {
                prompt: 'p',
                workspaceId: cli.workspace,
            });
            expect(args).toContain('--verbose');
            expect(containsSubsequence(args, ['--max-turns', '7'])).toBe(true);
            expect(containsSubsequence(args, ['--max-budget-usd', '12.5'])).toBe(true);
            // Legacy UI value "safe" maps onto the real CLI value.
            expect(containsSubsequence(args, ['--permission-mode', 'acceptEdits'])).toBe(true);
            expect(containsSubsequence(args, ['--allowedTools', 'Bash,Read'])).toBe(true);
            expect(containsSubsequence(args, ['--disallowedTools', 'WebFetch'])).toBe(true);
            expect(containsSubsequence(args, ['--append-system-prompt', 'extra rules'])).toBe(true);
            expect(env).toContain('CLAUDE_CODE_EFFORT_LEVEL=medium');
            backend.destroyTask(taskId);
        } finally {
            await backend.shutdown();
        }
    }, 30000);

    it('drops switches that are disabled/empty rather than emitting empty flags', async () => {
        const backend = new ClaudeCodeBackend(
            fakeConfigStore({
                verbose: false,
                maxTurns: 0,
                maxBudgetUsd: null,
                permissionMode: null,
                allowedTools: '   ',
                disallowedTools: '',
                appendSystemPrompt: '  ',
                effortLevel: '',
            }),
            cli.historyDir
        );
        try {
            const { args, taskId } = await spawnAndReadArgs(backend, 'argv-switches-off', {
                prompt: 'p',
                workspaceId: cli.workspace,
            });
            expect(args).toEqual([]);
            backend.destroyTask(taskId);
        } finally {
            await backend.shutdown();
        }
    }, 30000);

    it.each([
        ['dangerous', 'bypassPermissions'],
        ['auto', 'dontAsk'],
        ['plan', 'plan'],
        ['acceptEdits', 'acceptEdits'],
        ['someFutureMode', 'someFutureMode'],
    ])('maps permission mode %s → %s', async (input, expected) => {
        const backend = new ClaudeCodeBackend(fakeConfigStore({ permissionMode: input, effortLevel: '' }), cli.historyDir);
        try {
            const { args, taskId } = await spawnAndReadArgs(backend, `argv-mode-${input}`, {
                prompt: 'p',
                workspaceId: cli.workspace,
            });
            expect(containsSubsequence(args, ['--permission-mode', expected])).toBe(true);
            backend.destroyTask(taskId);
        } finally {
            await backend.shutdown();
        }
    }, 30000);
});

// =====================================================================
// 3. Reconnect / resume specifics
// =====================================================================
describe.skipIf(isWin)('ClaudeCodeBackend: resume behaviour', () => {
    let cli: FakeCliEnv;

    beforeAll(() => { cli = setupFakeCli('claude'); });
    afterAll(() => { cli.restore(); });

    it('falls back to a fresh start when the session JSONL is missing', async () => {
        const backend = new ClaudeCodeBackend(undefined, cli.historyDir);
        try {
            const dir = cli.fakeDir('resume-missing');
            const missing = uuid();
            const task = await backend.reconnectTask(
                { taskId: 'task-resume-missing', sessionId: missing, workspaceId: cli.workspace },
                cli.env(dir)
            );
            // The session id is dropped, not blindly forwarded to --resume.
            expect(task.sessionId).toBeNull();
            expect(backend.getTaskHistory('task-resume-missing')).toContain('Session reconnected');
            await waitFor(() => readIf(join(dir, 'cwd.log')), s => s.length > 0, 15000);
            expect(argLines(dir)).not.toContain('--resume');
            backend.destroyTask('task-resume-missing');
        } finally {
            await backend.shutdown();
        }
    }, 30000);

    it('adds --dangerously-skip-permissions on reconnect when the setting is on', async () => {
        const backend = new ClaudeCodeBackend(fakeConfigStore({ effortLevel: 'high' }, true), cli.historyDir);
        try {
            const dir = cli.fakeDir('resume-skipperms');
            const sid = uuid();
            const projects = claudeProjectsDir(cli.base, cli.workspace);
            mkdirSync(projects, { recursive: true });
            writeFileSync(join(projects, `${sid}.jsonl`), '{}\n');

            await backend.reconnectTask(
                { taskId: 'task-resume-skipperms', sessionId: sid, workspaceId: cli.workspace },
                cli.env(dir)
            );
            const args = await waitFor(() => argLines(dir), a => a.length > 0, 15000);
            expect(args).toContain('--dangerously-skip-permissions');
            expect(containsSubsequence(args, ['--resume', sid])).toBe(true);
            const env = await waitFor(() => readIf(join(dir, 'env.log')), s => s.length > 0, 15000);
            expect(env).toContain('CLAUDE_CODE_EFFORT_LEVEL=high');
            backend.destroyTask('task-resume-skipperms');
        } finally {
            await backend.shutdown();
        }
    }, 30000);

    it('ignores shouldContinue when there is no resumable session', async () => {
        const backend = new ClaudeCodeBackend(undefined, cli.historyDir);
        try {
            const dir = cli.fakeDir('resume-continue-nosession');
            const task = await backend.reconnectTask(
                { taskId: 'task-continue-nosession', sessionId: null, workspaceId: cli.workspace, shouldContinue: true },
                cli.env(dir)
            );
            // No session → nothing to continue → the task must land idle.
            expect(task.state).toBe('idle');
            backend.destroyTask('task-continue-nosession');
        } finally {
            await backend.shutdown();
        }
    }, 30000);
});

// =====================================================================
// 3b. State-dependent input/stop paths
// =====================================================================
describe.skipIf(isWin)('ClaudeCodeBackend: state-dependent input and stop paths', () => {
    let cli: FakeCliEnv;
    let backend: ClaudeCodeBackend;

    beforeAll(async () => {
        cli = setupFakeCli('claude');
        backend = new ClaudeCodeBackend(undefined, cli.historyDir);
        await backend.initialize();
    });
    afterAll(async () => {
        await backend.shutdown();
        cli.restore();
    });

    it('writes raw keystrokes straight through while the task is busy', async () => {
        const dir = cli.fakeDir('raw-keystrokes');
        const task = await backend.createTask({ prompt: 'RAWKEYS', workspaceId: cli.workspace }, cli.env(dir));
        await waitFor(() => readIf(join(dir, 'input.log')), s => s.includes('RAWKEYS'), 25000);
        await waitFor(() => backend.getTaskState(task.id), s => s === 'idle', 25000);

        backend.setTaskActive(task.id, true);
        backend.sendInput(task.id, 'STAY_BUSY hold\r');
        await waitFor(() => backend.getTaskState(task.id), s => s === 'busy', 20000);

        // Busy → the "single character / control key" branch: written verbatim,
        // no echo-then-Enter dance.
        backend.sendInput(task.id, 'RAW_CHARS_WHILE_BUSY\r');
        const input = await waitFor(
            () => readIf(join(dir, 'input.log')),
            s => s.includes('RAW_CHARS_WHILE_BUSY'),
            25000
        );
        expect(input).toContain('RAW_CHARS_WHILE_BUSY');
        backend.destroyTask(task.id);
    }, 60000);

    it('types the prompt character-by-character and echoes it to active viewers', async () => {
        const dir = cli.fakeDir('typed-input');
        const task = await backend.createTask({ prompt: 'TYPEDSEED', workspaceId: cli.workspace }, cli.env(dir));
        await waitFor(() => readIf(join(dir, 'input.log')), s => s.includes('TYPEDSEED'), 25000);

        const seen: string[] = [];
        backend.setTaskActive(task.id, true);
        backend.on('task:output', (id, d) => { if (id === task.id) seen.push(d); });
        backend.sendInput(task.id, 'CHAR_BY_CHAR\r', { typeCharByChar: true });
        // The whole string is echoed to the UI up front…
        expect(seen.join('')).toContain('CHAR_BY_CHAR');
        // …and still lands on the process stdin as one line.
        const input = await waitFor(
            () => readIf(join(dir, 'input.log')),
            s => s.includes('CHAR_BY_CHAR'),
            25000
        );
        expect(input).toContain('CHAR_BY_CHAR');
        backend.removeAllListeners('task:output');
        backend.destroyTask(task.id);
    }, 60000);

    it('refuses to stop or interrupt a task whose process has exited', async () => {
        const dir = cli.fakeDir('exited-stop');
        const task = await backend.createTask(
            { prompt: 'EXITME', workspaceId: cli.workspace },
            cli.env(dir, { CLAUDIA_FAKE_EXIT_CODE: '0', CLAUDIA_FAKE_EXIT_DELAY: '0.1' })
        );
        await waitFor(() => backend.getTaskState(task.id), s => s === 'exited', 20000);
        expect(backend.stopTask(task.id)).toBe(false);
        expect(backend.interruptTask(task.id)).toBe(false);
        // destroy on an already-exited task is still safe.
        expect(() => backend.destroyTask(task.id)).not.toThrow();
        expect(backend.getTask(task.id)).toBeUndefined();
    }, 30000);

    it('applies CC_CLAUDE_ARGS and CLI switches on reconnect too', async () => {
        process.env.CC_CLAUDE_ARGS = '--reconnect-flag';
        const withSwitches = new ClaudeCodeBackend(fakeConfigStore({ verbose: true, maxTurns: 2 }), cli.historyDir);
        try {
            const dir = cli.fakeDir('reconnect-switches');
            await withSwitches.reconnectTask(
                { taskId: 'task-reconnect-switches', sessionId: null, workspaceId: cli.workspace },
                cli.env(dir)
            );
            const args = await waitFor(() => argLines(dir), a => a.length > 0, 15000);
            expect(args[0]).toBe('--reconnect-flag');
            expect(args).toContain('--verbose');
            expect(containsSubsequence(args, ['--max-turns', '2'])).toBe(true);
            withSwitches.destroyTask('task-reconnect-switches');
        } finally {
            delete process.env.CC_CLAUDE_ARGS;
            await withSwitches.shutdown();
        }
    }, 30000);
});

// =====================================================================
// 3c. Known defect, pinned so a fix is a deliberate change
// =====================================================================
describe.skipIf(isWin)('ClaudeCodeBackend: known defects', () => {
    let cli: FakeCliEnv;

    beforeAll(() => { cli = setupFakeCli('claude'); });
    afterAll(() => { cli.restore(); });

    it('BUG: shutdown() leaks the session-capture poller', async () => {
        // shutdown() iterates `sessionCaptureIntervals` to clear capture timers,
        // but startSessionCapture() stores its interval in a DIFFERENT map,
        // `pendingSessionCapture`. `sessionCaptureIntervals` is never written to,
        // so the cleanup loop is dead code and the 500ms filesystem poller keeps
        // running after shutdown (until its own 30s timeout).
        // Pinned here so that fixing it shows up as an intentional change.
        const backend = new ClaudeCodeBackend(undefined, cli.historyDir);
        await backend.initialize();
        try {
            // No CLAUDIA_FAKE_SID → no session file appears → capture stays pending.
            const task = await backend.createTask(
                { prompt: 'LEAKY', workspaceId: cli.workspace },
                cli.env(cli.fakeDir('leaky-capture'))
            );
            const internals = backend as unknown as {
                pendingSessionCapture: Map<string, { interval?: NodeJS.Timeout }>;
                sessionCaptureIntervals: Map<string, NodeJS.Timeout>;
            };
            expect(internals.pendingSessionCapture.has(task.id)).toBe(true);
            expect(internals.sessionCaptureIntervals.size).toBe(0);

            await backend.shutdown();

            // Should be false once the leak is fixed.
            expect(internals.pendingSessionCapture.has(task.id)).toBe(true);

            // Don't leave a live timer behind for the rest of the run.
            const leaked = internals.pendingSessionCapture.get(task.id)?.interval;
            if (leaked) clearInterval(leaked);
            internals.pendingSessionCapture.clear();
        } finally {
            await backend.shutdown();
        }
    }, 30000);

    it('destroyTask() DOES clear the capture timer (the path that works)', async () => {
        const backend = new ClaudeCodeBackend(undefined, cli.historyDir);
        await backend.initialize();
        try {
            const task = await backend.createTask(
                { prompt: 'CLEANCAPTURE', workspaceId: cli.workspace },
                cli.env(cli.fakeDir('clean-capture'))
            );
            const internals = backend as unknown as { pendingSessionCapture: Map<string, unknown> };
            expect(internals.pendingSessionCapture.has(task.id)).toBe(true);
            backend.destroyTask(task.id);
            expect(internals.pendingSessionCapture.has(task.id)).toBe(false);
        } finally {
            await backend.shutdown();
        }
    }, 30000);
});

// =====================================================================
// 4. Output handling: auth-warning filtering + streaming
// =====================================================================
describe.skipIf(isWin)('ClaudeCodeBackend: output filtering', () => {
    let cli: FakeCliEnv;

    beforeAll(() => { cli = setupFakeCli('claude'); });
    afterAll(() => { cli.restore(); });

    it('strips the auth-conflict warning from real PTY output but keeps the rest', async () => {
        const backend = new ClaudeCodeBackend(undefined, cli.historyDir);
        try {
            const dir = cli.fakeDir('auth-warn');
            const task = await backend.createTask(
                { prompt: 'AUTHWARN', workspaceId: cli.workspace },
                cli.env(dir, { CLAUDIA_FAKE_AUTH_WARN: '1' })
            );
            const hist = await waitFor(
                () => backend.getTaskHistory(task.id),
                s => Boolean(s && s.includes('AUTH_WARN_SENTINEL_KEEP')),
                20000
            );
            expect(hist).not.toContain('Auth conflict');
            expect(hist).not.toContain('This may lead to unexpected behavior');
            backend.destroyTask(task.id);
        } finally {
            await backend.shutdown();
        }
    }, 30000);
});

// =====================================================================
// 5. History assembly / lazy loading (no process needed)
// =====================================================================
describe.skipIf(isWin)('ClaudeCodeBackend: history assembly', () => {
    let cli: FakeCliEnv;
    let backend: ClaudeCodeBackend;
    const spawned: string[] = [];

    beforeAll(() => {
        cli = setupFakeCli('claude');
        backend = new ClaudeCodeBackend(undefined, cli.historyDir);
    });
    afterAll(async () => {
        for (const id of spawned) backend.destroyTask(id);
        await backend.shutdown();
        cli.restore();
    });

    /** Reconnect gives us a deterministic task id to hang history off. */
    async function seed(taskId: string): Promise<void> {
        spawned.push(taskId);
        await backend.reconnectTask(
            { taskId, sessionId: null, workspaceId: cli.workspace },
            cli.env(cli.fakeDir(`history-${taskId}`))
        );
    }

    it('prepends the archived history file (base64 on disk) to live output', async () => {
        const id = 'task-hist-small';
        writeFileSync(join(cli.historyDir, `${id}.txt`), Buffer.from('ARCHIVED_HISTORY_CONTENT').toString('base64'));
        await seed(id);
        const hist = backend.getTaskHistory(id);
        expect(hist).toContain('ARCHIVED_HISTORY_CONTENT');
        expect(hist).toContain('Session reconnected');
        expect(hist!.indexOf('ARCHIVED_HISTORY_CONTENT')).toBeLessThan(hist!.indexOf('Session reconnected'));
    }, 30000);

    it('tail-truncates an oversized history file and says so', async () => {
        const id = 'task-hist-big';
        const big = 'X'.repeat(4096) + 'TAIL_MARKER';
        writeFileSync(join(cli.historyDir, `${id}.txt`), Buffer.from(big).toString('base64'));
        await seed(id);
        const hist = backend.getTaskHistory(id, 512);
        expect(hist).toContain('History truncated');
    }, 30000);

    it('decodes lazyHistoryBase64 on demand and clears it afterwards', async () => {
        const id = 'task-hist-lazy';
        await seed(id);
        const internal = backend.getInternalTask(id)!;
        internal.lazyHistoryBase64 = Buffer.from('LAZY_BASE64_CONTENT').toString('base64');
        const hist = backend.getTaskHistory(id);
        expect(hist).toContain('LAZY_BASE64_CONTENT');
        expect(internal.lazyHistoryBase64).toBeUndefined();
        expect(internal.previousHistory).toBeDefined();
    }, 30000);

    it('truncates oversized lazyHistoryBase64 to the requested tail', async () => {
        const id = 'task-hist-lazy-big';
        await seed(id);
        const internal = backend.getInternalTask(id)!;
        internal.lazyHistoryBase64 = Buffer.from('Y'.repeat(4096) + 'LAZY_TAIL').toString('base64');
        const hist = backend.getTaskHistory(id, 256);
        expect(hist).toContain('History truncated');
        expect(hist).toContain('LAZY_TAIL');
    }, 30000);

    it('frees decoded history for the tasks that are no longer active', async () => {
        const a = 'task-hist-active-a';
        const b = 'task-hist-active-b';
        await seed(a);
        await seed(b);
        backend.getInternalTask(a)!.lazyHistoryBase64 = Buffer.from('AAA').toString('base64');
        backend.getTaskHistory(a);
        expect(backend.getInternalTask(a)!.previousHistory).toBeDefined();

        backend.setTaskActive(b, true);
        expect(backend.getInternalTask(a)!.previousHistory).toBeUndefined();
        expect(backend.getInternalTask(b)!.isActive).toBe(true);
        expect(backend.getInternalTask(a)!.isActive).toBe(false);
    }, 30000);

    it('exposes git state through the public helpers and re-emits stateChanged', async () => {
        const id = 'task-hist-git';
        await seed(id);
        const before: Partial<TaskGitState> = { commitBefore: 'abc123', uncommittedBefore: false };
        backend.setGitStateBefore(id, before);
        expect(backend.getGitStateBefore(id)).toEqual(before);

        const events: string[] = [];
        backend.on('task:stateChanged', t => events.push(t.id));
        const after: TaskGitState = {
            commitBefore: 'abc123', commitAfter: 'def456',
            uncommittedBefore: false, filesModified: ['a.ts'], canRevert: true,
        };
        backend.updateGitState(id, after);
        backend.removeAllListeners('task:stateChanged');

        expect(backend.getTask(id)!.gitState).toEqual(after);
        expect(events).toContain(id);

        // Unknown ids are inert.
        expect(backend.getGitStateBefore('nope')).toBeUndefined();
        expect(() => backend.setGitStateBefore('nope', before)).not.toThrow();
        expect(() => backend.updateGitState('nope', after)).not.toThrow();
        expect(backend.getInternalTask('nope')).toBeUndefined();
    }, 30000);
});

// =====================================================================
// 6. Pure TUI heuristics (no process, no filesystem)
// =====================================================================
describe('ClaudeCodeBackend: TUI heuristics', () => {
    const backend = new ClaudeCodeBackend();
    const p = priv(backend);

    it('stripAnsi removes SGR, CSI, OSC and control bytes', () => {
        expect(p.stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
        expect(p.stripAnsi('\x1b[2Jclear')).toBe('clear');
        expect(p.stripAnsi('\x1b]0;title\x07keep')).toBe('keep');
        expect(p.stripAnsi('\x1b[?25lhidden')).toBe('hidden');
        expect(p.stripAnsi('a\rb')).toBe('ab');
        expect(p.stripAnsi('keep\nnewline')).toBe('keep\nnewline');
    });

    it.each([
        ['Claude Code v1'],
        ['Enter message'],
        ['Type your message'],
        ['ask anything'],
        ['? for shortcuts'],
        ['Try "fix the bug"'],
        ['───────\n❯'],
    ])('isReadyForInitialInput accepts %j', (s) => {
        expect(p.isReadyForInitialInput(s)).toBe(true);
    });

    it('isReadyForInitialInput rejects output with no prompt affordance', () => {
        expect(p.isReadyForInitialInput('loading...')).toBe(false);
        expect(p.isReadyForInitialInput('')).toBe(false);
    });

    it.each<[string, string, WaitingInputType]>([
        ['multiple choice', 'Pick one\nEnter to select  ↑/↓ to navigate', 'question'],
        ['numbered menu', '❯ 1. First option\n  2. Second option', 'question'],
        ['permission dialog', 'Allow this tool call?\nAllow / Deny', 'permission'],
        ['yes-no lowercase', 'Continue? (y/n)', 'confirmation'],
        ['yes-no bracketed', 'Overwrite the file [y/N]', 'confirmation'],
        ['open question', 'Which approach would you prefer for the refactor?', 'question'],
        ['trailing question mark', 'Ready for the next step, then?', 'question'],
    ])('detectWaitingForInput classifies %s', (_label, input, expected) => {
        expect(p.detectWaitingForInput(input)).toBe(expected);
    });

    it('detectWaitingForInput ignores the idle TUI chrome', () => {
        expect(p.detectWaitingForInput('❯ \n? for shortcuts')).toBeNull();
        expect(p.detectWaitingForInput('⏺ Done. Files written.')).toBeNull();
        expect(p.detectWaitingForInput('Try "fix the bug" · /model to try shift+tab to cycle')).toBeNull();
        expect(p.detectWaitingForInput('')).toBeNull();
    });

    it('encodes the workspace path the same way Claude Code names its projects dir', () => {
        const dir = p.getClaudeProjectsDir('/Users/me/Work/my_repo.git');
        expect(dir.endsWith(join('.claude', 'projects', '-Users-me-Work-my-repo-git'))).toBe(true);
    });

    it('extractSessionId is a deliberate no-op: capture happens via the session file', () => {
        // Documents current behaviour — the PTY output never carries the id,
        // so ClaudeCodeBackend relies entirely on watching ~/.claude/projects.
        expect(p.extractSessionId('session: 11111111-2222-3333-4444-555566667777')).toBeNull();
    });

    it.each([
        'Thinking about it',
        'Working on the change',
        'Concocting a plan',
        'Analyzing the code',
        'Reading files',
        'Writing output',
        '⠋ spinner',
        '✻ sparkle',
        '─── Claude ───',
    ])('hasProcessingIndicators recognises %j', async (chunk) => {
        const b = new ClaudeCodeBackend();
        const internal = { outputHistory: [Buffer.from(chunk)] };
        (b as unknown as { tasks: Map<string, unknown> }).tasks.set('t', internal);
        expect(b.hasProcessingIndicators('t')).toBe(true);
    });

    it('hasProcessingIndicators is false for quiescent output', () => {
        const b = new ClaudeCodeBackend();
        (b as unknown as { tasks: Map<string, unknown> }).tasks.set('t', { outputHistory: [Buffer.from('all done.')] });
        expect(b.hasProcessingIndicators('t')).toBe(false);
    });

    it('filterAuthConflictWarning drops only the warning lines', () => {
        const raw = 'Auth conflict: something\r\nThis may lead to unexpected behavior\r\nreal output\r\n';
        const filtered = p.filterAuthConflictWarning(raw);
        expect(filtered).not.toContain('Auth conflict');
        expect(filtered).toContain('real output');
    });

    it('filterAuthConflictWarning passes unrelated output through unchanged', () => {
        expect(p.filterAuthConflictWarning('hello world')).toBe('hello world');
    });

    it('honours STATE_POLLING_MS only when it is at least 500ms', () => {
        const saved = process.env.STATE_POLLING_MS;
        try {
            process.env.STATE_POLLING_MS = '1500';
            expect((new ClaudeCodeBackend() as unknown as { statePollingMs: number }).statePollingMs).toBe(1500);
            process.env.STATE_POLLING_MS = '10';
            expect((new ClaudeCodeBackend() as unknown as { statePollingMs: number }).statePollingMs).toBe(3000);
            process.env.STATE_POLLING_MS = 'nonsense';
            expect((new ClaudeCodeBackend() as unknown as { statePollingMs: number }).statePollingMs).toBe(3000);
        } finally {
            if (saved === undefined) delete process.env.STATE_POLLING_MS;
            else process.env.STATE_POLLING_MS = saved;
        }
    });
});
