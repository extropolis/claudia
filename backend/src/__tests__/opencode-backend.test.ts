/**
 * OpenCodeBackend: the shared CodeBackend contract + OpenCode-specific
 * behaviour (model selection precedence, --session resume, session-id
 * extraction from TUI output, history assembly, TUI heuristics).
 *
 * Despite its "HTTP API" reputation, the shipped backend is PTY-based — it
 * spawns the interactive `opencode` CLI exactly like Claude Code does — so the
 * same real-process fixture drives it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import type { WaitingInputType, TaskGitState } from '@claudia/shared';
import { OpenCodeBackend } from '../backends/opencode-backend.js';
import { setupFakeCli, type FakeCliEnv } from './backend-test-env.js';
import {
    runCodeBackendContract, waitFor, readIf, argLines, containsSubsequence, isWin,
    type BackendHarness, type SpawnCtx,
} from './backend-contract.js';

/** OpenCode session ids look like ses_<26+ alphanumerics>. */
const sesId = () => `ses_${randomBytes(13).toString('hex')}`;

interface OpenCodePrivates {
    detectWaitingForInput(s: string): WaitingInputType | null;
    isReadyForInitialInput(s: string): boolean;
    stripAnsi(s: string): string;
    extractSessionId(s: string): string | null;
}
const priv = (b: OpenCodeBackend): OpenCodePrivates => b as unknown as OpenCodePrivates;

// =====================================================================
// 1. The shared contract — same expectations as ClaudeCodeBackend
// =====================================================================
runCodeBackendContract('opencode', (): BackendHarness => {
    const cli = setupFakeCli('opencode');
    const backend = new OpenCodeBackend(undefined, cli.historyDir);

    return {
        backend,
        workspace: cli.workspace,
        emptyBinDir: cli.emptyBinDir,
        newSpawn(label, extra = {}): SpawnCtx {
            const dir = cli.fakeDir(label);
            const sessionId = sesId();
            // OpenCode captures the session id by regex over TUI output.
            return { fakeDir: dir, sessionId, env: cli.env(dir, { CLAUDIA_FAKE_STDOUT_SID: sessionId, ...extra }) };
        },
        // OpenCode does not verify that a session exists before resuming.
        ensureResumableSession: () => { /* no-op */ },
        resumeArgs: (sessionId) => ['--session', sessionId],
        cleanup: () => cli.restore(),
    };
});

// =====================================================================
// 2. Argv at the true process boundary
// =====================================================================
describe.skipIf(isWin)('OpenCodeBackend: argv at the process boundary', () => {
    let cli: FakeCliEnv;

    beforeAll(() => { cli = setupFakeCli('opencode'); });
    afterAll(() => { cli.restore(); });

    async function spawnArgs(
        backend: OpenCodeBackend,
        label: string,
        config: { prompt: string; workspaceId: string; systemPrompt?: string; skipPermissions?: boolean; model?: string }
    ): Promise<{ args: string[]; taskId: string; dir: string }> {
        const dir = cli.fakeDir(label);
        const task = await backend.createTask(config, cli.env(dir));
        await waitFor(() => existsSync(join(dir, 'cwd.log')), v => v, 15000);
        return { args: argLines(dir), taskId: task.id, dir };
    }

    it('passes the configured model with -m', async () => {
        const backend = new OpenCodeBackend(undefined, cli.historyDir);
        try {
            const { args, taskId } = await spawnArgs(backend, 'argv-model', {
                prompt: 'p',
                workspaceId: cli.workspace,
                model: 'anthropic/claude-sonnet-4-5',
            });
            expect(containsSubsequence(args, ['-m', 'anthropic/claude-sonnet-4-5'])).toBe(true);
            backend.destroyTask(taskId);
        } finally {
            await backend.shutdown();
        }
    }, 30000);

    it('falls back to $OPENCODE_MODEL when the config has no model', async () => {
        process.env.OPENCODE_MODEL = 'env/model-from-environment';
        const backend = new OpenCodeBackend(undefined, cli.historyDir);
        try {
            const { args, taskId } = await spawnArgs(backend, 'argv-model-env', {
                prompt: 'p',
                workspaceId: cli.workspace,
            });
            expect(containsSubsequence(args, ['-m', 'env/model-from-environment'])).toBe(true);
            backend.destroyTask(taskId);
        } finally {
            delete process.env.OPENCODE_MODEL;
            await backend.shutdown();
        }
    }, 30000);

    it('falls back to openai/gpt-4o when nothing selects a model', async () => {
        const backend = new OpenCodeBackend(undefined, cli.historyDir);
        try {
            const { args, taskId } = await spawnArgs(backend, 'argv-model-default', {
                prompt: 'p',
                workspaceId: cli.workspace,
            });
            expect(containsSubsequence(args, ['-m', 'openai/gpt-4o'])).toBe(true);
            expect(args).toHaveLength(2);
            backend.destroyTask(taskId);
        } finally {
            await backend.shutdown();
        }
    }, 30000);

    it('KNOWN GAP: systemPrompt and skipPermissions never reach the CLI', async () => {
        // ClaudeCodeBackend forwards both (--system-prompt / --dangerously-skip-permissions).
        // OpenCodeBackend silently drops them: the system prompt is only stored
        // on the task object, and skipPermissions is ignored outright. This test
        // pins the CURRENT behaviour so a future fix is a deliberate change.
        const backend = new OpenCodeBackend(undefined, cli.historyDir);
        try {
            const { args, taskId } = await spawnArgs(backend, 'argv-gap', {
                prompt: 'p',
                workspaceId: cli.workspace,
                systemPrompt: '  be terse  ',
                skipPermissions: true,
            });
            expect(args).toEqual(['-m', 'openai/gpt-4o']);
            // …but it IS retained on the task, which is what the UI shows.
            expect(backend.getTask(taskId)!.systemPrompt).toBe('be terse');
            backend.destroyTask(taskId);
        } finally {
            await backend.shutdown();
        }
    }, 30000);

    it('resumes with --session and does not check that the session exists', async () => {
        const backend = new OpenCodeBackend(undefined, cli.historyDir);
        try {
            const dir = cli.fakeDir('argv-resume');
            const sid = sesId();
            const task = await backend.reconnectTask(
                { taskId: 'task-oc-resume', sessionId: sid, workspaceId: cli.workspace },
                cli.env(dir)
            );
            expect(task.sessionId).toBe(sid);
            const args = await waitFor(() => argLines(dir), a => a.length > 0, 15000);
            expect(args).toEqual(['--session', sid]);
            // No model flag on reconnect — the resumed session carries its own.
            expect(args).not.toContain('-m');
            backend.destroyTask('task-oc-resume');
        } finally {
            await backend.shutdown();
        }
    }, 30000);

    it('ignores shouldContinue when there is no session id', async () => {
        const backend = new OpenCodeBackend(undefined, cli.historyDir);
        try {
            const task = await backend.reconnectTask(
                { taskId: 'task-oc-nocontinue', sessionId: null, workspaceId: cli.workspace, shouldContinue: true },
                cli.env(cli.fakeDir('argv-nocontinue'))
            );
            expect(task.state).toBe('idle');
            backend.destroyTask('task-oc-nocontinue');
        } finally {
            await backend.shutdown();
        }
    }, 30000);
});

// =====================================================================
// 2b. State-dependent input/stop paths
// =====================================================================
describe.skipIf(isWin)('OpenCodeBackend: state-dependent input and stop paths', () => {
    let cli: FakeCliEnv;
    let backend: OpenCodeBackend;

    beforeAll(async () => {
        cli = setupFakeCli('opencode');
        backend = new OpenCodeBackend(undefined, cli.historyDir);
        await backend.initialize();
    });
    afterAll(async () => {
        await backend.shutdown();
        cli.restore();
    });

    it('writes raw keystrokes straight through while the task is busy', async () => {
        const dir = cli.fakeDir('raw-keystrokes');
        const task = await backend.createTask({ prompt: 'OC_RAWKEYS', workspaceId: cli.workspace }, cli.env(dir));
        await waitFor(() => readIf(join(dir, 'input.log')), s => s.includes('OC_RAWKEYS'), 25000);
        await waitFor(() => backend.getTaskState(task.id), s => s === 'idle', 25000);

        backend.setTaskActive(task.id, true);
        backend.sendInput(task.id, 'STAY_BUSY hold\r');
        await waitFor(() => backend.getTaskState(task.id), s => s === 'busy', 20000);

        backend.sendInput(task.id, 'OC_RAW_WHILE_BUSY\r');
        const input = await waitFor(
            () => readIf(join(dir, 'input.log')),
            s => s.includes('OC_RAW_WHILE_BUSY'),
            25000
        );
        expect(input).toContain('OC_RAW_WHILE_BUSY');
        backend.destroyTask(task.id);
    }, 60000);

    it('types input character-by-character and echoes it to active viewers', async () => {
        const dir = cli.fakeDir('typed-input');
        const task = await backend.createTask({ prompt: 'OC_TYPESEED', workspaceId: cli.workspace }, cli.env(dir));
        await waitFor(() => readIf(join(dir, 'input.log')), s => s.includes('OC_TYPESEED'), 25000);

        const seen: string[] = [];
        backend.setTaskActive(task.id, true);
        backend.on('task:output', (id, d) => { if (id === task.id) seen.push(d); });
        backend.sendInput(task.id, 'OC_CHAR_BY_CHAR\r', { typeCharByChar: true });
        expect(seen.join('')).toContain('OC_CHAR_BY_CHAR');
        const input = await waitFor(
            () => readIf(join(dir, 'input.log')),
            s => s.includes('OC_CHAR_BY_CHAR'),
            25000
        );
        expect(input).toContain('OC_CHAR_BY_CHAR');
        backend.removeAllListeners('task:output');
        backend.destroyTask(task.id);
    }, 60000);

    it('refuses to stop or interrupt a task whose process has exited', async () => {
        const dir = cli.fakeDir('exited-stop');
        const task = await backend.createTask(
            { prompt: 'OC_EXITME', workspaceId: cli.workspace },
            cli.env(dir, { CLAUDIA_FAKE_EXIT_CODE: '0', CLAUDIA_FAKE_EXIT_DELAY: '0.1' })
        );
        await waitFor(() => backend.getTaskState(task.id), s => s === 'exited', 20000);
        expect(backend.stopTask(task.id)).toBe(false);
        expect(backend.interruptTask(task.id)).toBe(false);
        expect(() => backend.destroyTask(task.id)).not.toThrow();
        expect(backend.getTask(task.id)).toBeUndefined();
    }, 30000);

    it('KNOWN GAP: no session is ever captured when the TUI does not print one', async () => {
        // OpenCodeBackend only learns a session id by regex-matching TUI output.
        // Unlike ClaudeCodeBackend it never watches the on-disk session store,
        // so a silent TUI leaves sessionId null and reconnects start fresh.
        const dir = cli.fakeDir('no-session');
        const captured: string[] = [];
        backend.on('task:sessionCaptured', (id: string) => captured.push(id));
        const task = await backend.createTask(
            { prompt: 'OC_NOSESSION', workspaceId: cli.workspace },
            cli.env(dir) // no CLAUDIA_FAKE_STDOUT_SID
        );
        await waitFor(() => readIf(join(dir, 'input.log')), s => s.includes('OC_NOSESSION'), 25000);
        expect(captured).not.toContain(task.id);
        expect(backend.getTask(task.id)!.sessionId).toBeNull();
        backend.removeAllListeners('task:sessionCaptured');
        backend.destroyTask(task.id);
    }, 40000);
});

// =====================================================================
// 3. History assembly + task bookkeeping (deterministic task ids)
// =====================================================================
describe.skipIf(isWin)('OpenCodeBackend: history assembly and task bookkeeping', () => {
    let cli: FakeCliEnv;
    let backend: OpenCodeBackend;
    const spawned: string[] = [];

    beforeAll(() => {
        cli = setupFakeCli('opencode');
        backend = new OpenCodeBackend(undefined, cli.historyDir);
    });
    afterAll(async () => {
        for (const id of spawned) backend.destroyTask(id);
        await backend.shutdown();
        cli.restore();
    });

    async function seed(taskId: string): Promise<void> {
        spawned.push(taskId);
        await backend.reconnectTask(
            { taskId, sessionId: null, workspaceId: cli.workspace },
            cli.env(cli.fakeDir(`history-${taskId}`))
        );
    }

    it('prepends the archived history file to live output', async () => {
        const id = 'task-oc-hist-small';
        writeFileSync(join(cli.historyDir, `${id}.txt`), Buffer.from('OC_ARCHIVED_CONTENT').toString('base64'));
        await seed(id);
        const hist = backend.getTaskHistory(id);
        expect(hist).toContain('OC_ARCHIVED_CONTENT');
        expect(hist).toContain('Session reconnected');
    }, 30000);

    it('tail-truncates an oversized history file and says so', async () => {
        const id = 'task-oc-hist-big';
        writeFileSync(
            join(cli.historyDir, `${id}.txt`),
            Buffer.from('X'.repeat(4096) + 'OC_TAIL').toString('base64')
        );
        await seed(id);
        expect(backend.getTaskHistory(id, 512)).toContain('History truncated');
    }, 30000);

    it('decodes lazyHistoryBase64 on demand and truncates it when oversized', async () => {
        const small = 'task-oc-lazy-small';
        await seed(small);
        backend.getInternalTask(small)!.lazyHistoryBase64 = Buffer.from('OC_LAZY').toString('base64');
        expect(backend.getTaskHistory(small)).toContain('OC_LAZY');
        expect(backend.getInternalTask(small)!.lazyHistoryBase64).toBeUndefined();

        const big = 'task-oc-lazy-big';
        await seed(big);
        backend.getInternalTask(big)!.lazyHistoryBase64 =
            Buffer.from('Y'.repeat(4096) + 'OC_LAZY_TAIL').toString('base64');
        const hist = backend.getTaskHistory(big, 256);
        expect(hist).toContain('History truncated');
        expect(hist).toContain('OC_LAZY_TAIL');
    }, 40000);

    it('setTaskActive frees decoded history for the tasks that are no longer active', async () => {
        const a = 'task-oc-active-a';
        const b = 'task-oc-active-b';
        await seed(a);
        await seed(b);
        backend.getInternalTask(a)!.lazyHistoryBase64 = Buffer.from('AAA').toString('base64');
        backend.getTaskHistory(a);
        expect(backend.getInternalTask(a)!.previousHistory).toBeDefined();

        backend.setTaskActive(b, true);
        expect(backend.getInternalTask(a)!.previousHistory).toBeUndefined();
        expect(backend.getInternalTask(a)!.isActive).toBe(false);
        expect(backend.getInternalTask(b)!.isActive).toBe(true);
    }, 40000);

    it('exposes git state through the public helpers and re-emits stateChanged', async () => {
        const id = 'task-oc-git';
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
        expect(backend.getGitStateBefore('nope')).toBeUndefined();
        expect(() => backend.updateGitState('nope', after)).not.toThrow();
        expect(() => backend.setGitStateBefore('nope', before)).not.toThrow();
        expect(backend.getInternalTask('nope')).toBeUndefined();
    }, 30000);
});

// =====================================================================
// 4. Pure TUI heuristics (no process, no filesystem)
// =====================================================================
describe('OpenCodeBackend: TUI heuristics', () => {
    const backend = new OpenCodeBackend();
    const p = priv(backend);

    it('stripAnsi removes SGR, CSI, OSC and control bytes', () => {
        expect(p.stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
        expect(p.stripAnsi('\x1b[2Jclear')).toBe('clear');
        expect(p.stripAnsi('\x1b]0;title\x07keep')).toBe('keep');
        expect(p.stripAnsi('a\rb')).toBe('ab');
    });

    it.each([
        ['opencode v1.2.3'],
        ['Enter message'],
        ['Type your message'],
        ['ask anything'],
        ['❯'],
        ['> '],
    ])('isReadyForInitialInput accepts %j', (s) => {
        expect(p.isReadyForInitialInput(s)).toBe(true);
    });

    it('isReadyForInitialInput rejects output with no prompt affordance', () => {
        expect(p.isReadyForInitialInput('booting')).toBe(false);
        expect(p.isReadyForInitialInput('')).toBe(false);
    });

    it('extracts an OpenCode session id from TUI output', () => {
        const sid = 'ses_4186bf4b8ffeBrRCHWt7nDkIrP';
        expect(p.extractSessionId(`created ${sid} ok`)).toBe(sid);
        expect(p.extractSessionId(`session: ${sid}`)).toBe(sid);
    });

    it('falls back to a generic long session token when there is no ses_ prefix', () => {
        expect(p.extractSessionId('session: abcdefghijklmnopqrstuvwxyz')).toBe('abcdefghijklmnopqrstuvwxyz');
    });

    it('returns null when no session id is present', () => {
        expect(p.extractSessionId('nothing to see here')).toBeNull();
        // Too short to be a session id.
        expect(p.extractSessionId('ses_short')).toBeNull();
    });

    it.each<[string, string, WaitingInputType]>([
        ['multiple choice', 'Enter to select  ↑/↓ to navigate', 'question'],
        ['numbered menu', '❯ 1. First option\n  2. Second option', 'question'],
        ['permission dialog', 'Allow / Deny this edit', 'permission'],
        ['yes-no', 'Proceed? (y/n)', 'confirmation'],
        ['bracketed yes-no', 'Overwrite [Y/n]', 'confirmation'],
        ['open question', 'Which option do you want to pick?', 'question'],
        ['trailing question mark', 'Ready for the next step, then?', 'question'],
    ])('detectWaitingForInput classifies %s', (_label, input, expected) => {
        expect(p.detectWaitingForInput(input)).toBe(expected);
    });

    it('detectWaitingForInput returns null for plain output', () => {
        expect(p.detectWaitingForInput('Done writing files.')).toBeNull();
        expect(p.detectWaitingForInput('❯ ')).toBeNull();
        expect(p.detectWaitingForInput('')).toBeNull();
    });

    it.each([
        'Thinking hard',
        'Working on it',
        'Reading file',
        'Writing file',
        'Running command',
        'Searching repo',
        '⠙ spinner',
        '✻ sparkle',
        '▸ arrow',
        'loading...',
    ])('hasProcessingIndicators recognises %j', (chunk) => {
        const b = new OpenCodeBackend();
        (b as unknown as { tasks: Map<string, unknown> }).tasks.set('t', { outputHistory: [Buffer.from(chunk)] });
        expect(b.hasProcessingIndicators('t')).toBe(true);
    });

    it('hasProcessingIndicators is false for quiescent output', () => {
        const b = new OpenCodeBackend();
        (b as unknown as { tasks: Map<string, unknown> }).tasks.set('t', { outputHistory: [Buffer.from('all done')] });
        expect(b.hasProcessingIndicators('t')).toBe(false);
    });

    it('honours STATE_POLLING_MS only when it is at least 500ms', () => {
        const saved = process.env.STATE_POLLING_MS;
        try {
            process.env.STATE_POLLING_MS = '900';
            expect((new OpenCodeBackend() as unknown as { statePollingMs: number }).statePollingMs).toBe(900);
            process.env.STATE_POLLING_MS = '100';
            expect((new OpenCodeBackend() as unknown as { statePollingMs: number }).statePollingMs).toBe(3000);
            delete process.env.STATE_POLLING_MS;
            expect((new OpenCodeBackend() as unknown as { statePollingMs: number }).statePollingMs).toBe(3000);
        } finally {
            if (saved === undefined) delete process.env.STATE_POLLING_MS;
            else process.env.STATE_POLLING_MS = saved;
        }
    });
});
