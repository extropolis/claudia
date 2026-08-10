/**
 * SupervisorChat — deterministic-logic tests.
 *
 * Covers prompt assembly, chat-history trimming/filtering, tool dispatch,
 * rate limiting, the auto-analysis concurrency queue and response parsing.
 * The claude CLI is never spawned: a fake ClaudeRunner is injected through the
 * constructor seam, and history is written to a throwaway dir under homedir().
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { join, delimiter } from 'path';
import { SUPPORTS_FAKE_CLI } from './helpers/server-harness.js';

// getConversationHistory reads real JSONL session files off disk; stub it so the
// formatting/branching around it is testable.
const getConversationHistoryMock = vi.hoisted(() => vi.fn());
vi.mock('../conversation-parser.js', () => ({
    getConversationHistory: getConversationHistoryMock,
}));

import {
    SupervisorChat,
    ClaudeTimeoutError,
    defaultClaudeRunner,
    type ClaudeRunner,
    type ClaudeRunResult,
} from '../supervisor-chat.js';
import type { TaskSpawner } from '../task-spawner.js';
import type { ConfigStore } from '../config-store.js';
import type { ChatMessage, Task } from '@claudia/shared';

// Temp dirs MUST live under homedir(): /var (os.tmpdir on macOS) is blocklisted
// by validateWorkspacePath elsewhere in the codebase.
const BASE = mkdtempSync(join(homedir(), '.claudia-test-supchat-'));
afterAll(() => rmSync(BASE, { recursive: true, force: true }));

let historyCounter = 0;
const nextHistoryFile = () => join(BASE, `history-${historyCounter++}.json`);

function makeTask(over: Partial<Task> = {}): Task {
    return {
        id: 'task-1',
        prompt: 'do the thing',
        state: 'idle',
        workspaceId: '/ws/a',
        createdAt: new Date('2024-01-01T00:00:00Z'),
        lastActivity: new Date('2024-01-01T00:00:00Z'),
        ...over,
    } as Task;
}

class FakeSpawner extends EventEmitter {
    tasks: Task[] = [];
    internal = new Map<string, { sessionId?: string; workspaceId: string }>();
    created: Array<{ prompt: string; workspaceId: string }> = [];
    destroyed: string[] = [];
    writes: Array<{ id: string; data: string }> = [];
    reconnected: string[] = [];
    createShouldThrow = false;

    getAllTasks(): Task[] { return this.tasks; }
    getTask(id: string) { return this.internal.get(id); }
    async createTask(prompt: string, workspaceId: string) {
        if (this.createShouldThrow) throw new Error('boom');
        this.created.push({ prompt, workspaceId });
        const t = makeTask({ id: `created-${this.created.length}`, prompt, workspaceId });
        this.tasks.push(t);
        return t;
    }
    destroyTask(id: string) { this.destroyed.push(id); }
    writeToTask(id: string, data: string) { this.writes.push({ id, data }); }
    reconnectTask(id: string) { this.reconnected.push(id); }
}

interface Harness {
    chat: SupervisorChat;
    spawner: FakeSpawner;
    runs: Array<{ args: string[]; opts: { cwd: string; timeoutMs: number } }>;
    historyFile: string;
    setSupervisorEnabled(v: boolean): void;
}

function build(opts: {
    workspaces?: { id: string; name: string }[];
    runner?: ClaudeRunner;
    historyFile?: string;
    systemPrompt?: string;
    supervisorEnabled?: boolean;
} = {}): Harness {
    const spawner = new FakeSpawner();
    const runs: Array<{ args: string[]; opts: { cwd: string; timeoutMs: number } }> = [];
    let enabled = opts.supervisorEnabled ?? false;

    const defaultRunner: ClaudeRunner = async () => ({ code: 0, stdout: '{"response":"ok"}', stderr: '' });
    const runner: ClaudeRunner = async (args, runOpts) => {
        runs.push({ args, opts: runOpts });
        return (opts.runner ?? defaultRunner)(args, runOpts);
    };

    const configStore = {
        isSupervisorEnabled: () => enabled,
        getSupervisorSystemPrompt: () => opts.systemPrompt ?? 'SYSTEM PROMPT',
    } as unknown as ConfigStore;

    const historyFile = opts.historyFile ?? nextHistoryFile();
    const chat = new SupervisorChat(
        spawner as unknown as TaskSpawner,
        { getWorkspaces: () => opts.workspaces ?? [{ id: '/ws/a', name: 'Alpha' }] },
        configStore,
        { historyFile, runClaude: runner }
    );

    return { chat, spawner, runs, historyFile, setSupervisorEnabled: (v) => { enabled = v; } };
}

/** Cancel the 500 ms debounced disk save so it cannot fire after the temp dir is gone. */
function stopDebounce(chat: SupervisorChat): void {
    const priv = chat as unknown as { saveDebounceTimer: NodeJS.Timeout | null };
    if (priv.saveDebounceTimer) {
        clearTimeout(priv.saveDebounceTimer);
        priv.saveDebounceTimer = null;
    }
}

/** Typed view onto the private methods under test. */
type Internals = {
    buildSystemPrompt(context: string, workspaceId?: string): string;
    buildContext(focusTaskId?: string, workspaceId?: string): Promise<string>;
    formatChatHistory(workspaceId?: string): string;
    formatConversationForAnalysis(messages: Array<{ role: string; content: string }>): string;
    parseClaudeResponse(response: string): { response?: string; tool_calls?: unknown[] };
    canSpawnProcess(): boolean;
    recordSpawn(): void;
    addMessage(m: ChatMessage): void;
    executeToolCalls(calls: Array<{ tool: string; parameters: Record<string, unknown> }>): Promise<Array<{ tool: string; result: string }>>;
    findTaskById(id: string): Task | null;
    callClaudeSimple(prompt: string, workspaceId: string): Promise<string>;
    getFollowUpResponse(msg: string, toolResults: string, ctx: string): Promise<string>;
    chatHistory: ChatMessage[];
    spawnTimestamps: number[];
};
const priv = (c: SupervisorChat) => c as unknown as Internals;

function msg(over: Partial<ChatMessage> = {}): ChatMessage {
    return {
        id: `m-${Math.random()}`,
        role: 'user',
        content: 'hi',
        timestamp: '2024-01-01T00:00:00.000Z',
        ...over,
    };
}

let harnesses: SupervisorChat[] = [];
beforeEach(() => { getConversationHistoryMock.mockReset(); getConversationHistoryMock.mockResolvedValue(null); harnesses = []; });
afterEach(() => { harnesses.forEach(stopDebounce); vi.useRealTimers(); });
const track = (h: Harness) => { harnesses.push(h.chat); return h; };

// ---------------------------------------------------------------------------
// history persistence + trimming
// ---------------------------------------------------------------------------
describe('chat history persistence', () => {
    it('starts empty when no history file exists', () => {
        const h = track(build());
        expect(h.chat.getHistory()).toEqual([]);
    });

    it('loads a previously persisted history file', () => {
        const file = nextHistoryFile();
        writeFileSync(file, JSON.stringify([msg({ id: 'a' }), msg({ id: 'b' })]));
        const h = track(build({ historyFile: file }));
        expect(h.chat.getHistory().map(m => m.id)).toEqual(['a', 'b']);
    });

    it('recovers from a corrupt history file instead of crashing', () => {
        const file = nextHistoryFile();
        writeFileSync(file, '{not json at all');
        const h = track(build({ historyFile: file }));
        expect(h.chat.getHistory()).toEqual([]);
    });

    it('ignores a history file whose JSON is not an array', () => {
        const file = nextHistoryFile();
        writeFileSync(file, JSON.stringify({ messages: [] }));
        const h = track(build({ historyFile: file }));
        expect(h.chat.getHistory()).toEqual([]);
    });

    it('getHistory returns a copy — callers cannot mutate internal state', () => {
        const h = track(build());
        priv(h.chat).addMessage(msg({ id: 'x' }));
        const copy = h.chat.getHistory();
        copy.push(msg({ id: 'injected' }));
        expect(h.chat.getHistory().map(m => m.id)).toEqual(['x']);
    });

    it('debounces the disk write and flushes it 500 ms later', async () => {
        vi.useFakeTimers();
        const h = build();               // deliberately untracked: we want the timer to fire
        priv(h.chat).addMessage(msg({ id: 'd1' }));
        priv(h.chat).addMessage(msg({ id: 'd2' }));
        expect(existsSync(h.historyFile)).toBe(false);
        await vi.advanceTimersByTimeAsync(500);
        expect(JSON.parse(readFileSync(h.historyFile, 'utf-8')).map((m: ChatMessage) => m.id)).toEqual(['d1', 'd2']);
    });

    it('swallows disk-write failures instead of throwing', () => {
        const h = track(build({ historyFile: join(BASE, 'no-such-dir', 'history.json') }));
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => h.chat.saveChatHistoryNow()).not.toThrow();
        expect(err).toHaveBeenCalledWith('[SupervisorChat] Failed to save chat history:', expect.anything());
        err.mockRestore();
    });

    it('saveChatHistoryNow writes the messages to the configured file', () => {
        const h = track(build());
        priv(h.chat).addMessage(msg({ id: 'persisted' }));
        h.chat.saveChatHistoryNow();
        expect(existsSync(h.historyFile)).toBe(true);
        expect(JSON.parse(readFileSync(h.historyFile, 'utf-8'))[0].id).toBe('persisted');
    });
});

describe('history trimming at MAX_HISTORY_MESSAGES (200)', () => {
    it('keeps everything at exactly the limit (no off-by-one drop)', () => {
        const h = track(build());
        for (let i = 0; i < 200; i++) priv(h.chat).addMessage(msg({ id: `m${i}` }));
        expect(h.chat.getHistory()).toHaveLength(200);
        expect(h.chat.getHistory()[0].id).toBe('m0');
    });

    it('drops the oldest message when one over the limit', () => {
        const h = track(build());
        for (let i = 0; i < 201; i++) priv(h.chat).addMessage(msg({ id: `m${i}` }));
        const ids = h.chat.getHistory().map(m => m.id);
        expect(ids).toHaveLength(200);
        expect(ids[0]).toBe('m1');
        expect(ids[199]).toBe('m200');
    });

    it('stays capped when way over the limit', () => {
        const h = track(build());
        for (let i = 0; i < 500; i++) priv(h.chat).addMessage(msg({ id: `m${i}` }));
        expect(h.chat.getHistory()).toHaveLength(200);
        expect(h.chat.getHistory()[0].id).toBe('m300');
    });

    it('saveChatHistoryNow also trims a history loaded oversized from disk', () => {
        const file = nextHistoryFile();
        writeFileSync(file, JSON.stringify(Array.from({ length: 250 }, (_, i) => msg({ id: `d${i}` }))));
        const h = track(build({ historyFile: file }));
        expect(h.chat.getHistory()).toHaveLength(250); // load does not trim
        h.chat.saveChatHistoryNow();
        expect(h.chat.getHistory()).toHaveLength(200);
        expect(h.chat.getHistory()[0].id).toBe('d50');
    });

    it('emits "message" for every added message', () => {
        const h = track(build());
        const seen: string[] = [];
        h.chat.on('message', (m: ChatMessage) => seen.push(m.id));
        priv(h.chat).addMessage(msg({ id: 'e1' }));
        priv(h.chat).addMessage(msg({ id: 'e2' }));
        expect(seen).toEqual(['e1', 'e2']);
    });
});

describe('history views', () => {
    const seed = (h: Harness) => {
        priv(h.chat).addMessage(msg({ id: '1', workspaceId: '/ws/a', taskId: 't1' }));
        priv(h.chat).addMessage(msg({ id: '2', workspaceId: '/ws/b', taskId: 't2' }));
        priv(h.chat).addMessage(msg({ id: '3', workspaceId: '/ws/a', taskId: 't1' }));
        priv(h.chat).addMessage(msg({ id: '4', workspaceId: '/ws/a' }));
    };

    it('getWorkspaceHistory filters by workspace', () => {
        const h = track(build()); seed(h);
        expect(h.chat.getWorkspaceHistory('/ws/a').map(m => m.id)).toEqual(['1', '3', '4']);
        expect(h.chat.getWorkspaceHistory('/ws/none')).toEqual([]);
    });

    it('getTaskHistory filters by task', () => {
        const h = track(build()); seed(h);
        expect(h.chat.getTaskHistory('t1').map(m => m.id)).toEqual(['1', '3']);
    });

    it('getThreads groups by taskId and skips messages with no task', () => {
        const h = track(build()); seed(h);
        const threads = h.chat.getThreads();
        expect([...threads.keys()].sort()).toEqual(['t1', 't2']);
        expect(threads.get('t1')!.map(m => m.id)).toEqual(['1', '3']);
    });

    it('clearHistory empties everything and emits historyCleared', () => {
        const h = track(build()); seed(h);
        const spy = vi.fn();
        h.chat.on('historyCleared', spy);
        h.chat.clearHistory();
        expect(h.chat.getHistory()).toEqual([]);
        expect(spy).toHaveBeenCalledOnce();
    });

    it('clearTaskHistory removes only that thread and emits taskHistoryCleared', () => {
        const h = track(build()); seed(h);
        const spy = vi.fn();
        h.chat.on('taskHistoryCleared', spy);
        h.chat.clearTaskHistory('t1');
        expect(h.chat.getHistory().map(m => m.id)).toEqual(['2', '4']);
        expect(spy).toHaveBeenCalledWith('t1');
    });
});

// ---------------------------------------------------------------------------
// prompt construction
// ---------------------------------------------------------------------------
describe('formatChatHistory (context-window management)', () => {
    it('returns empty string when there is no history', () => {
        const h = track(build());
        expect(priv(h.chat).formatChatHistory()).toBe('');
    });

    it('returns empty string when the workspace filter matches nothing', () => {
        const h = track(build());
        priv(h.chat).addMessage(msg({ workspaceId: '/ws/a' }));
        expect(priv(h.chat).formatChatHistory('/ws/other')).toBe('');
    });

    it('includes all messages when under the 10-message window', () => {
        const h = track(build());
        priv(h.chat).addMessage(msg({ role: 'user', content: 'q' }));
        priv(h.chat).addMessage(msg({ role: 'assistant', content: 'a' }));
        expect(priv(h.chat).formatChatHistory()).toBe('## Previous Chat History\nUser: q\n\nSupervisor: a\n');
    });

    it('keeps exactly the last 10 at the boundary', () => {
        const h = track(build());
        for (let i = 0; i < 10; i++) priv(h.chat).addMessage(msg({ content: `c${i}` }));
        const out = priv(h.chat).formatChatHistory();
        expect(out).toContain('User: c0');
        expect(out).toContain('User: c9');
    });

    it('drops the 11th-from-last message', () => {
        const h = track(build());
        for (let i = 0; i < 11; i++) priv(h.chat).addMessage(msg({ content: `c${i}` }));
        const out = priv(h.chat).formatChatHistory();
        expect(out).not.toContain('User: c0');
        expect(out).toContain('User: c1');
        expect(out).toContain('User: c10');
    });

    it('applies the workspace filter BEFORE the last-10 slice', () => {
        const h = track(build());
        // 20 messages in another workspace would push /ws/a out of a naive slice-then-filter
        priv(h.chat).addMessage(msg({ content: 'keep-me', workspaceId: '/ws/a' }));
        for (let i = 0; i < 20; i++) priv(h.chat).addMessage(msg({ content: `noise${i}`, workspaceId: '/ws/b' }));
        const out = priv(h.chat).formatChatHistory('/ws/a');
        expect(out).toContain('keep-me');
        expect(out).not.toContain('noise');
    });
});

describe('buildContext', () => {
    it('reports no active tasks when the spawner is empty', async () => {
        const h = track(build());
        const ctx = await priv(h.chat).buildContext();
        expect(ctx).toContain('## Current Tasks\nNo active tasks.');
    });

    it('says "Workspace Tasks" and names the workspace when scoped', async () => {
        const h = track(build({ workspaces: [{ id: '/ws/a', name: 'Alpha' }] }));
        const ctx = await priv(h.chat).buildContext(undefined, '/ws/a');
        expect(ctx).toContain('## Active Workspace: Alpha (/ws/a)');
        expect(ctx).toContain('## Workspace Tasks');
    });

    it('lists tasks with state and marks the focused one', async () => {
        const h = track(build());
        h.spawner.tasks = [
            makeTask({ id: 't1', prompt: 'first', state: 'busy' }),
            makeTask({ id: 't2', prompt: 'second', state: 'idle' }),
        ];
        const ctx = await priv(h.chat).buildContext('t2');
        expect(ctx).toContain('- Task t1: "first" (busy)');
        expect(ctx).toContain('- Task t2 [FOCUSED]: "second" (idle)');
    });

    it('truncates task prompts to 100 chars in the task list', async () => {
        const h = track(build());
        h.spawner.tasks = [makeTask({ id: 't1', prompt: 'x'.repeat(250) })];
        const ctx = await priv(h.chat).buildContext();
        expect(ctx).toContain(`- Task t1: "${'x'.repeat(100)}" (idle)`);
        expect(ctx).not.toContain('x'.repeat(101));
    });

    it('filters tasks to the given workspace', async () => {
        const h = track(build());
        h.spawner.tasks = [
            makeTask({ id: 'in', workspaceId: '/ws/a' }),
            makeTask({ id: 'out', workspaceId: '/ws/b' }),
        ];
        const ctx = await priv(h.chat).buildContext(undefined, '/ws/a');
        expect(ctx).toContain('Task in');
        expect(ctx).not.toContain('Task out');
    });

    it('marks the active workspace in the workspace list', async () => {
        const h = track(build({ workspaces: [{ id: '/ws/a', name: 'Alpha' }, { id: '/ws/b', name: '' }] }));
        const ctx = await priv(h.chat).buildContext(undefined, '/ws/b');
        expect(ctx).toContain('- /ws/a (Alpha)');
        expect(ctx).toContain('- /ws/b (unnamed) [ACTIVE]');
    });

    it('appends the last 5 conversation messages for a focused task, truncated to 300 chars', async () => {
        const h = track(build());
        h.spawner.tasks = [makeTask({ id: 't1' })];
        h.spawner.internal.set('t1', { sessionId: 'sess-1', workspaceId: '/ws/a' });
        getConversationHistoryMock.mockResolvedValue({
            messages: Array.from({ length: 7 }, (_, i) => ({
                role: i % 2 === 0 ? 'user' : 'assistant',
                content: i === 6 ? 'y'.repeat(400) : `line${i}`,
            })),
        });
        const ctx = await priv(h.chat).buildContext('t1');
        expect(getConversationHistoryMock).toHaveBeenCalledWith('/ws/a', 'sess-1');
        expect(ctx).toContain('## Recent Task Conversation');
        expect(ctx).not.toContain('line1');   // outside the last 5
        expect(ctx).toContain('**Assistant:** line3');
        expect(ctx).toContain(`**User:** ${'y'.repeat(300)}...`);
    });

    it('skips the conversation section when the focused task has no session', async () => {
        const h = track(build());
        h.spawner.internal.set('t1', { workspaceId: '/ws/a' });
        const ctx = await priv(h.chat).buildContext('t1');
        expect(ctx).not.toContain('## Recent Task Conversation');
        expect(getConversationHistoryMock).not.toHaveBeenCalled();
    });
});

describe('buildSystemPrompt', () => {
    it('embeds the tool catalogue, the context and the JSON contract', () => {
        const h = track(build());
        const out = priv(h.chat).buildSystemPrompt('CTX-MARKER');
        expect(out).toContain('CTX-MARKER');
        for (const tool of ['create_task', 'delete_task', 'get_task_conversation', 'send_message_to_task', 'list_tasks']) {
            expect(out).toContain(`"name": "${tool}"`);
        }
        expect(out).toContain('IMPORTANT: Always respond with valid JSON.');
        // the tool block must be valid JSON so the model can copy the shape
        const toolsJson = out.split('Tools:\n')[1].split('\n\n## Context')[0];
        expect(JSON.parse(toolsJson)).toHaveLength(5);
    });

    it('splices in workspace-scoped chat history', () => {
        const h = track(build());
        priv(h.chat).addMessage(msg({ content: 'mine', workspaceId: '/ws/a' }));
        priv(h.chat).addMessage(msg({ content: 'theirs', workspaceId: '/ws/b' }));
        const out = priv(h.chat).buildSystemPrompt('ctx', '/ws/a');
        expect(out).toContain('## Previous Chat History');
        expect(out).toContain('User: mine');
        expect(out).not.toContain('theirs');
    });

    it('omits the history section entirely when there is none', () => {
        const h = track(build());
        expect(priv(h.chat).buildSystemPrompt('ctx')).not.toContain('## Previous Chat History');
    });
});

describe('formatConversationForAnalysis', () => {
    it('uppercases roles and joins with blank lines', () => {
        const h = track(build());
        const out = priv(h.chat).formatConversationForAnalysis([
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'world' },
        ]);
        expect(out).toBe('[USER]: hello\n\n[ASSISTANT]: world');
    });

    it('truncates messages longer than 500 chars', () => {
        const h = track(build());
        const out = priv(h.chat).formatConversationForAnalysis([{ role: 'user', content: 'z'.repeat(600) }]);
        expect(out).toBe(`[USER]: ${'z'.repeat(500)}...[truncated]`);
    });

    it('leaves a message of exactly 500 chars untouched', () => {
        const h = track(build());
        const out = priv(h.chat).formatConversationForAnalysis([{ role: 'user', content: 'z'.repeat(500) }]);
        expect(out).not.toContain('[truncated]');
    });

    it('returns empty string for no messages', () => {
        const h = track(build());
        expect(priv(h.chat).formatConversationForAnalysis([])).toBe('');
    });
});

// ---------------------------------------------------------------------------
// response parsing
// ---------------------------------------------------------------------------
describe('parseClaudeResponse', () => {
    const p = (s: string) => priv(track(build()).chat).parseClaudeResponse(s);

    it('parses a fenced ```json block', () => {
        expect(p('chatter\n```json\n{"response":"hi"}\n```\nmore')).toEqual({ response: 'hi' });
    });

    it('parses an unlabelled fenced block', () => {
        expect(p('```\n{"response":"hi"}\n```')).toEqual({ response: 'hi' });
    });

    it('parses a bare JSON object', () => {
        expect(p('  {"response":"hi","tool_calls":[]}  ')).toEqual({ response: 'hi', tool_calls: [] });
    });

    it('passes plain prose through as the response', () => {
        expect(p('just talking')).toEqual({ response: 'just talking' });
    });

    it('preserves tool_calls with their parameters', () => {
        expect(p('{"response":"x","tool_calls":[{"tool":"list_tasks","parameters":{}}]}').tool_calls)
            .toEqual([{ tool: 'list_tasks', parameters: {} }]);
    });

    it('throws on a fenced block containing invalid JSON (callers fall back to raw text)', () => {
        expect(() => p('```json\n{oops}\n```')).toThrow();
    });

    it('throws on a bare-brace string that is not valid JSON', () => {
        expect(() => p('{definitely not json')).toThrow();
    });
});

// ---------------------------------------------------------------------------
// rate limiting
// ---------------------------------------------------------------------------
describe('spawn rate limiting', () => {
    it('allows up to 10 spawns inside the window and blocks the 11th', () => {
        const h = track(build());
        for (let i = 0; i < 10; i++) {
            expect(priv(h.chat).canSpawnProcess()).toBe(true);
            priv(h.chat).recordSpawn();
        }
        expect(priv(h.chat).canSpawnProcess()).toBe(false);
    });

    it('evicts timestamps older than the 60 s window', () => {
        const h = track(build());
        const old = Date.now() - 61_000;
        priv(h.chat).spawnTimestamps = Array.from({ length: 10 }, () => old);
        expect(priv(h.chat).canSpawnProcess()).toBe(true);
        expect(priv(h.chat).spawnTimestamps).toHaveLength(0);
    });

    it('keeps timestamps that are still inside the window', () => {
        const h = track(build());
        priv(h.chat).spawnTimestamps = Array.from({ length: 10 }, () => Date.now() - 100);
        expect(priv(h.chat).canSpawnProcess()).toBe(false);
    });

    it('callClaudeSimple refuses to spawn once rate limited', async () => {
        const h = track(build());
        priv(h.chat).spawnTimestamps = Array.from({ length: 10 }, () => Date.now());
        await expect(priv(h.chat).callClaudeSimple('p', '/ws/a')).rejects.toThrow(/Rate limit exceeded/);
        expect(h.runs).toHaveLength(0);
    });

    it('getFollowUpResponse degrades to returning tool results when rate limited', async () => {
        const h = track(build());
        priv(h.chat).spawnTimestamps = Array.from({ length: 10 }, () => Date.now());
        const out = await priv(h.chat).getFollowUpResponse('m', 'RESULTS', 'ctx');
        expect(out).toBe('Action completed:\nRESULTS');
        expect(h.runs).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// claude invocation argv / error handling (through the injected runner)
// ---------------------------------------------------------------------------
describe('claude invocation', () => {
    it('callClaudeSimple builds --print argv, uses the workspace as cwd and a 30 s timeout', async () => {
        const h = track(build({ runner: async () => ({ code: 0, stdout: '  analysis text \n', stderr: '' }) }));
        const out = await priv(h.chat).callClaudeSimple('THE PROMPT', '/ws/a');
        expect(out).toBe('analysis text');
        expect(h.runs[0].args).toEqual(['--print', '--output-format', 'text', '-p', 'THE PROMPT']);
        expect(h.runs[0].opts).toEqual({ cwd: '/ws/a', timeoutMs: 30000 });
    });

    it('callClaudeSimple surfaces stderr on a non-zero exit', async () => {
        const h = track(build({ runner: async () => ({ code: 2, stdout: '', stderr: 'kaboom' }) }));
        await expect(priv(h.chat).callClaudeSimple('p', '/ws/a')).rejects.toThrow('Claude Code failed: kaboom');
    });

    it('getFollowUpResponse uses a 60 s timeout and returns the trimmed text', async () => {
        const h = track(build({ runner: async () => ({ code: 0, stdout: ' done!\n', stderr: '' }) }));
        expect(await priv(h.chat).getFollowUpResponse('msg', 'RES', 'ctx')).toBe('done!');
        expect(h.runs[0].opts.timeoutMs).toBe(60000);
        expect(h.runs[0].args[4]).toContain('You previously received this user message: "msg"');
        expect(h.runs[0].args[4]).toContain('RES');
    });

    it('getFollowUpResponse falls back to tool results on a non-zero exit', async () => {
        const h = track(build({ runner: async () => ({ code: 1, stdout: '', stderr: 'nope' }) }));
        expect(await priv(h.chat).getFollowUpResponse('m', 'RES', 'c')).toBe('Action completed:\nRES');
    });

    it('getFollowUpResponse falls back to tool results on a spawn error', async () => {
        const h = track(build({ runner: async () => { throw new Error('ENOENT'); } }));
        expect(await priv(h.chat).getFollowUpResponse('m', 'RES', 'c')).toBe('Action completed:\nRES');
    });

    it('getFollowUpResponse propagates a timeout (it is not a soft failure)', async () => {
        const h = track(build({ runner: async () => { throw new ClaudeTimeoutError(); } }));
        await expect(priv(h.chat).getFollowUpResponse('m', 'RES', 'c')).rejects.toThrow('Claude Code timeout');
    });

    it('runs claude in the first workspace when one is configured', async () => {
        const h = track(build({ workspaces: [{ id: '/ws/first', name: 'F' }, { id: '/ws/second', name: 'S' }] }));
        await priv(h.chat).getFollowUpResponse('m', 'RES', 'c');
        expect(h.runs[0].opts.cwd).toBe('/ws/first');
    });

    it('falls back to process.cwd() when there are no workspaces', async () => {
        const h = track(build({ workspaces: [] }));
        await priv(h.chat).getFollowUpResponse('m', 'RES', 'c');
        expect(h.runs[0].opts.cwd).toBe(process.cwd());
    });
});

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------
describe('tool dispatch', () => {
    it('create_task requires a prompt', async () => {
        const h = track(build());
        const [r] = await priv(h.chat).executeToolCalls([{ tool: 'create_task', parameters: {} }]);
        expect(r.result).toBe('Error: prompt is required');
    });

    it('create_task defaults to the first workspace', async () => {
        const h = track(build({ workspaces: [{ id: '/ws/default', name: 'D' }] }));
        const [r] = await priv(h.chat).executeToolCalls([{ tool: 'create_task', parameters: { prompt: 'build it' } }]);
        expect(h.spawner.created).toEqual([{ prompt: 'build it', workspaceId: '/ws/default' }]);
        expect(r.result).toContain('Task created successfully!');
        expect(r.result).toContain('Workspace: /ws/default');
    });

    it('create_task honours an explicit workspace_id', async () => {
        const h = track(build());
        await priv(h.chat).executeToolCalls([{ tool: 'create_task', parameters: { prompt: 'p', workspace_id: '/ws/x' } }]);
        expect(h.spawner.created[0].workspaceId).toBe('/ws/x');
    });

    it('create_task reports when no workspace exists', async () => {
        const h = track(build({ workspaces: [] }));
        const [r] = await priv(h.chat).executeToolCalls([{ tool: 'create_task', parameters: { prompt: 'p' } }]);
        expect(r.result).toContain('No workspaces available');
    });

    it('create_task reports spawner failures as text, not exceptions', async () => {
        const h = track(build());
        h.spawner.createShouldThrow = true;
        const [r] = await priv(h.chat).executeToolCalls([{ tool: 'create_task', parameters: { prompt: 'p' } }]);
        expect(r.result).toContain('Error creating task:');
    });

    it('delete_task requires an id and reports unknown ids', async () => {
        const h = track(build());
        const [missing] = await priv(h.chat).executeToolCalls([{ tool: 'delete_task', parameters: {} }]);
        expect(missing.result).toBe('Error: task_id is required');
        const [unknown] = await priv(h.chat).executeToolCalls([{ tool: 'delete_task', parameters: { task_id: 'nope' } }]);
        expect(unknown.result).toContain('Task not found with ID: nope');
    });

    it('delete_task destroys the resolved task', async () => {
        const h = track(build());
        h.spawner.tasks = [makeTask({ id: 'task-abc123' })];
        const [r] = await priv(h.chat).executeToolCalls([{ tool: 'delete_task', parameters: { task_id: 'abc123' } }]);
        expect(h.spawner.destroyed).toEqual(['task-abc123']);
        expect(r.result).toContain('deleted successfully');
    });

    it('send_message_to_task validates both parameters', async () => {
        const h = track(build());
        const [noId] = await priv(h.chat).executeToolCalls([{ tool: 'send_message_to_task', parameters: { message: 'x' } }]);
        expect(noId.result).toBe('Error: task_id is required');
        const [noMsg] = await priv(h.chat).executeToolCalls([{ tool: 'send_message_to_task', parameters: { task_id: 't' } }]);
        expect(noMsg.result).toBe('Error: message is required');
    });

    it('send_message_to_task writes the message with a trailing newline', async () => {
        const h = track(build());
        h.spawner.tasks = [makeTask({ id: 't1' })];
        const [r] = await priv(h.chat).executeToolCalls([{ tool: 'send_message_to_task', parameters: { task_id: 't1', message: 'hello' } }]);
        expect(h.spawner.writes).toEqual([{ id: 't1', data: 'hello\n' }]);
        expect(r.result).toContain('Message sent to task t1');
    });

    it('list_tasks reports emptiness', async () => {
        const h = track(build());
        const [r] = await priv(h.chat).executeToolCalls([{ tool: 'list_tasks', parameters: {} }]);
        expect(r.result).toBe('No tasks currently active.');
    });

    it('list_tasks renders id, state and an 80-char-truncated prompt', async () => {
        const h = track(build());
        h.spawner.tasks = [makeTask({ id: 't1', state: 'busy', prompt: 'q'.repeat(100) })];
        const [r] = await priv(h.chat).executeToolCalls([{ tool: 'list_tasks', parameters: {} }]);
        expect(r.result).toContain('Current tasks (1):');
        expect(r.result).toContain(`- **t1** (busy): "${'q'.repeat(80)}..."`);
    });

    it('get_task_conversation handles missing task, missing session and missing workspace', async () => {
        const h = track(build());
        const [noId] = await priv(h.chat).executeToolCalls([{ tool: 'get_task_conversation', parameters: {} }]);
        expect(noId.result).toBe('Error: task_id is required');

        h.spawner.tasks = [makeTask({ id: 't1' })];
        h.spawner.internal.set('t1', { workspaceId: '/ws/a' });
        const [noSession] = await priv(h.chat).executeToolCalls([{ tool: 'get_task_conversation', parameters: { task_id: 't1' } }]);
        expect(noSession.result).toContain('has no conversation history yet');

        h.spawner.internal.set('t1', { sessionId: 's', workspaceId: '/ws/gone' });
        const [noWs] = await priv(h.chat).executeToolCalls([{ tool: 'get_task_conversation', parameters: { task_id: 't1' } }]);
        expect(noWs.result).toBe('Error: Workspace not found for this task.');
    });

    it('get_task_conversation formats the full transcript', async () => {
        const h = track(build());
        h.spawner.tasks = [makeTask({ id: 't1' })];
        h.spawner.internal.set('t1', { sessionId: 's1', workspaceId: '/ws/a' });
        getConversationHistoryMock.mockResolvedValue({
            messages: [{ role: 'user', content: 'ask' }, { role: 'assistant', content: 'answer' }],
        });
        const [r] = await priv(h.chat).executeToolCalls([{ tool: 'get_task_conversation', parameters: { task_id: 't1' } }]);
        expect(r.result).toContain('**User:** ask');
        expect(r.result).toContain('**Assistant:** answer');
    });

    it('get_task_conversation reports an empty transcript', async () => {
        const h = track(build());
        h.spawner.tasks = [makeTask({ id: 't1' })];
        h.spawner.internal.set('t1', { sessionId: 's1', workspaceId: '/ws/a' });
        getConversationHistoryMock.mockResolvedValue({ messages: [] });
        const [r] = await priv(h.chat).executeToolCalls([{ tool: 'get_task_conversation', parameters: { task_id: 't1' } }]);
        expect(r.result).toContain('No conversation history found');
    });

    it('delete_task reports a destroy failure as text', async () => {
        const h = track(build());
        h.spawner.tasks = [makeTask({ id: 't1' })];
        h.spawner.destroyTask = () => { throw new Error('pty gone'); };
        const [r] = await priv(h.chat).executeToolCalls([{ tool: 'delete_task', parameters: { task_id: 't1' } }]);
        expect(r.result).toContain('Error deleting task:');
    });

    it('send_message_to_task reports an unknown id and a write failure as text', async () => {
        const h = track(build());
        const [missing] = await priv(h.chat).executeToolCalls([{ tool: 'send_message_to_task', parameters: { task_id: 'ghost', message: 'hi' } }]);
        expect(missing.result).toBe('Error: Task not found with ID: ghost');

        h.spawner.tasks = [makeTask({ id: 't1' })];
        h.spawner.writeToTask = () => { throw new Error('closed'); };
        const [failed] = await priv(h.chat).executeToolCalls([{ tool: 'send_message_to_task', parameters: { task_id: 't1', message: 'hi' } }]);
        expect(failed.result).toContain('Error sending message:');
    });

    it('get_task_conversation reports an unknown id and a parser failure as text', async () => {
        const h = track(build());
        const [missing] = await priv(h.chat).executeToolCalls([{ tool: 'get_task_conversation', parameters: { task_id: 'ghost' } }]);
        expect(missing.result).toBe('Error: Task not found with ID: ghost');

        h.spawner.tasks = [makeTask({ id: 't1' })];
        h.spawner.internal.set('t1', { sessionId: 's1', workspaceId: '/ws/a' });
        getConversationHistoryMock.mockRejectedValue(new Error('bad jsonl'));
        const [failed] = await priv(h.chat).executeToolCalls([{ tool: 'get_task_conversation', parameters: { task_id: 't1' } }]);
        expect(failed.result).toContain('Error getting conversation:');
    });

    it('captures an exception thrown by a tool rather than aborting the batch', async () => {
        const h = track(build());
        h.spawner.getAllTasks = () => { throw new Error('spawner exploded'); };
        const out = await priv(h.chat).executeToolCalls([
            { tool: 'list_tasks', parameters: {} },
            { tool: 'create_task', parameters: { prompt: 'still runs' } },
        ]);
        expect(out[0].result).toContain('Error: Error: spawner exploded');
        expect(out[1].result).toContain('Task created successfully!');
    });

    it('reports unknown tools instead of throwing', async () => {
        const h = track(build());
        const [r] = await priv(h.chat).executeToolCalls([{ tool: 'rm_rf', parameters: {} }]);
        expect(r).toEqual({ tool: 'rm_rf', result: 'Unknown tool: rm_rf' });
    });

    it('executes several calls in order', async () => {
        const h = track(build());
        const out = await priv(h.chat).executeToolCalls([
            { tool: 'list_tasks', parameters: {} },
            { tool: 'delete_task', parameters: {} },
        ]);
        expect(out.map(r => r.tool)).toEqual(['list_tasks', 'delete_task']);
    });
});

describe('findTaskById', () => {
    it('prefers an exact match over a partial one', () => {
        const h = track(build());
        h.spawner.tasks = [makeTask({ id: 'abc-longer' }), makeTask({ id: 'abc' })];
        expect(priv(h.chat).findTaskById('abc')!.id).toBe('abc');
    });

    it('falls back to a substring match', () => {
        const h = track(build());
        h.spawner.tasks = [makeTask({ id: 'task-1786-deadbeef' })];
        expect(priv(h.chat).findTaskById('deadbeef')!.id).toBe('task-1786-deadbeef');
    });

    it('returns null when nothing matches', () => {
        const h = track(build());
        h.spawner.tasks = [makeTask({ id: 'a' })];
        expect(priv(h.chat).findTaskById('zzz')).toBeNull();
    });
});

describe('executeAction', () => {
    it('routes the __reconnect__ sentinel to reconnectTask', () => {
        const h = track(build());
        h.chat.executeAction('t1', { id: 'a', label: 'Reconnect', description: 'reconnect the task', type: 'custom', value: '__reconnect__' });
        expect(h.spawner.reconnected).toEqual(['t1']);
        expect(h.spawner.writes).toEqual([]);
    });

    it('writes any other action value with a carriage return', () => {
        const h = track(build());
        h.chat.executeAction('t1', { id: 'a', label: 'Yes', description: 'pick option 2', type: 'input', value: '2' });
        expect(h.spawner.writes).toEqual([{ id: 't1', data: '2\r' }]);
    });
});

// ---------------------------------------------------------------------------
// sendMessageWithContext orchestration
// ---------------------------------------------------------------------------
describe('sendMessageWithContext', () => {
    it('stores the user message, then the assistant reply, and emits typing on/off', async () => {
        const h = track(build({ runner: async () => ({ code: 0, stdout: '{"response":"sure"}', stderr: '' }) }));
        const typing: boolean[] = [];
        h.chat.on('typing', (t: boolean) => typing.push(t));

        const reply = await h.chat.sendMessage('hello there', 't1', '/ws/a');
        expect(reply!.content).toBe('sure');
        expect(reply!.role).toBe('assistant');
        expect(h.chat.getHistory().map(m => [m.role, m.content])).toEqual([
            ['user', 'hello there'],
            ['assistant', 'sure'],
        ]);
        expect(typing).toEqual([true, false]);
    });

    it('prepends the caller-supplied context ahead of the built context', async () => {
        const h = track(build());
        await h.chat.sendMessageWithContext('hi', 'VOICE-CONTEXT', undefined, '/ws/a');
        const prompt = h.runs[0].args[4];
        expect(prompt).toContain('VOICE-CONTEXT');
        expect(prompt.indexOf('VOICE-CONTEXT')).toBeLessThan(prompt.indexOf('## Active Workspace'));
        expect(prompt).toContain('User message: "hi"');
    });

    it('omits the extra blank context block when no additional context is given', async () => {
        const h = track(build());
        await h.chat.sendMessage('hi');
        expect(h.runs[0].args[4]).toContain('## Context\n## Current Tasks');
    });

    it('refuses concurrent messages while one is in flight', async () => {
        let release!: (r: ClaudeRunResult) => void;
        const h = track(build({ runner: () => new Promise<ClaudeRunResult>(res => { release = res; }) }));
        const first = h.chat.sendMessage('one');
        expect(await h.chat.sendMessage('two')).toBeNull();
        release({ code: 0, stdout: '{"response":"done"}', stderr: '' });
        expect((await first)!.content).toBe('done');
        // the rejected second message must not be recorded
        expect(h.chat.getHistory().filter(m => m.content === 'two')).toHaveLength(0);
    });

    it('clears the in-flight flag after a failure so the next message works', async () => {
        let calls = 0;
        const h = track(build({
            runner: async () => {
                calls++;
                if (calls === 1) throw new Error('spawn failed');
                return { code: 0, stdout: '{"response":"recovered"}', stderr: '' };
            },
        }));
        const errored = await h.chat.sendMessage('one');
        expect(errored!.content).toBe('Sorry, I encountered an error processing your message. Please try again.');
        expect((await h.chat.sendMessage('two'))!.content).toBe('recovered');
    });

    it('runs tool calls and replaces the reply with the follow-up response', async () => {
        let call = 0;
        const h = track(build({
            runner: async () => {
                call++;
                return call === 1
                    ? { code: 0, stdout: '{"response":"one sec","tool_calls":[{"tool":"list_tasks","parameters":{}}]}', stderr: '' }
                    : { code: 0, stdout: 'Nothing running, boss.', stderr: '' };
            },
        }));
        const reply = await h.chat.sendMessage('what is running?');
        expect(reply!.content).toBe('Nothing running, boss.');
        // the follow-up prompt must carry the tool output
        expect(h.runs[1].args[4]).toContain('Tool: list_tasks');
        expect(h.runs[1].args[4]).toContain('No tasks currently active.');
    });

    it('keeps the plain response when the model asked for no tools', async () => {
        const h = track(build({ runner: async () => ({ code: 0, stdout: '{"response":"just chatting","tool_calls":[]}', stderr: '' }) }));
        expect((await h.chat.sendMessage('hi'))!.content).toBe('just chatting');
        expect(h.runs).toHaveLength(1);
    });

    it('treats unparseable output as a plain-text reply', async () => {
        const h = track(build({ runner: async () => ({ code: 0, stdout: '```json\n{broken\n```', stderr: '' }) }));
        expect((await h.chat.sendMessage('hi'))!.content).toContain('{broken');
    });

    it('reports an error message when claude exits non-zero', async () => {
        const h = track(build({ runner: async () => ({ code: 3, stdout: '', stderr: 'auth expired' }) }));
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect((await h.chat.sendMessage('hi'))!.content)
            .toBe('Sorry, I encountered an error processing your message. Please try again.');
        err.mockRestore();
    });

    it('reports an error message when the spawn budget is exhausted', async () => {
        const h = track(build());
        priv(h.chat).spawnTimestamps = Array.from({ length: 10 }, () => Date.now());
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect((await h.chat.sendMessage('hi'))!.content)
            .toBe('Sorry, I encountered an error processing your message. Please try again.');
        expect(h.runs).toHaveLength(0);
        err.mockRestore();
    });

    it('tags both messages with the task and workspace ids', async () => {
        const h = track(build());
        await h.chat.sendMessage('hi', 'task-9', '/ws/a');
        for (const m of h.chat.getHistory()) {
            expect(m.taskId).toBe('task-9');
            expect(m.workspaceId).toBe('/ws/a');
        }
    });
});

// ---------------------------------------------------------------------------
// task listeners / auto-analysis
// ---------------------------------------------------------------------------
describe('task listeners', () => {
    it('ignores taskCreated while the supervisor is disabled', () => {
        const h = track(build({ supervisorEnabled: false }));
        h.spawner.emit('taskCreated', makeTask());
        expect(h.chat.getHistory()).toEqual([]);
    });

    it('opens a thread message when a task is created', () => {
        const h = track(build({ supervisorEnabled: true }));
        h.spawner.emit('taskCreated', makeTask({ id: 't7', prompt: 'ship it', workspaceId: '/ws/a' }));
        const [m] = h.chat.getHistory();
        expect(m.content).toBe('**Task started**\n\nship it');
        expect(m.taskId).toBe('t7');
        expect(m.workspaceId).toBe('/ws/a');
    });

    it('does not auto-analyse while the supervisor is disabled', async () => {
        const h = track(build({ supervisorEnabled: false }));
        h.spawner.emit('taskStateChanged', makeTask({ state: 'exited' }));
        await new Promise(r => setImmediate(r));
        expect(h.runs).toHaveLength(0);
    });

    it.each(['busy', 'starting', 'disconnected'] as const)('does not analyse the %s state', async (state) => {
        const h = track(build({ supervisorEnabled: true }));
        h.spawner.emit('taskStateChanged', makeTask({ state }));
        await new Promise(r => setImmediate(r));
        expect(h.runs).toHaveLength(0);
    });

    it.each(['idle', 'waiting_input', 'exited'] as const)('analyses the %s state', async (state) => {
        const h = track(build({ supervisorEnabled: true }));
        await h.chat.autoAnalyzeTask(makeTask({ state }));
        expect(h.runs).toHaveLength(1);
        expect(h.runs[0].args[4]).toContain(`- Current State: ${state}`);
    });

    it('drives auto-analysis straight off the taskStateChanged event', async () => {
        const h = track(build({ supervisorEnabled: true, runner: async () => ({ code: 0, stdout: 'looks done', stderr: '' }) }));
        h.spawner.emit('taskStateChanged', makeTask({ id: 'evt', state: 'exited' }));
        await vi.waitFor(() => expect(h.chat.getHistory()).toHaveLength(1));
        expect(h.runs).toHaveLength(1);
        expect(h.chat.getHistory()[0].content).toBe('looks done');
    });
});

describe('autoAnalyzeTask', () => {
    it('assembles the analysis prompt from the configured system prompt and task facts', async () => {
        const h = track(build({ supervisorEnabled: true, systemPrompt: 'BE BRIEF', runner: async () => ({ code: 0, stdout: 'all good', stderr: '' }) }));
        await h.chat.autoAnalyzeTask(makeTask({ id: 't1', prompt: 'refactor', state: 'idle', workspaceId: '/ws/a' }));
        const prompt = h.runs[0].args[4];
        expect(prompt.startsWith('BE BRIEF')).toBe(true);
        expect(prompt).toContain('- Task ID: t1');
        expect(prompt).toContain('- Original Prompt: "refactor"');
        expect(prompt).toContain('No conversation history available.');
        expect(h.runs[0].opts.cwd).toBe('/ws/a');
        expect(h.chat.getHistory().at(-1)!.content).toBe('all good');
    });

    it('embeds the last 10 conversation messages when a session exists', async () => {
        const h = track(build({ supervisorEnabled: true }));
        h.spawner.internal.set('t1', { sessionId: 'sess', workspaceId: '/ws/a' });
        getConversationHistoryMock.mockResolvedValue({
            messages: Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: `m${i}` })),
        });
        await h.chat.autoAnalyzeTask(makeTask({ id: 't1' }));
        const prompt = h.runs[0].args[4];
        expect(prompt).not.toContain('[USER]: m1\n');
        expect(prompt).toContain('[USER]: m2');
        expect(prompt).toContain('[USER]: m11');
    });

    it('posts a fallback message when the analysis call fails', async () => {
        const h = track(build({ supervisorEnabled: true, runner: async () => { throw new Error('nope'); } }));
        await h.chat.autoAnalyzeTask(makeTask({ id: 't1', prompt: 'x'.repeat(80), state: 'exited' }));
        expect(h.chat.getHistory().at(-1)!.content).toBe(`Task "${'x'.repeat(50)}..." is now exited.`);
    });

    it('does not truncate a short prompt in the fallback message', async () => {
        const h = track(build({ supervisorEnabled: true, runner: async () => { throw new Error('nope'); } }));
        await h.chat.autoAnalyzeTask(makeTask({ prompt: 'short', state: 'idle' }));
        expect(h.chat.getHistory().at(-1)!.content).toBe('Task "short" is now idle.');
    });

    it('skips a task that is already being analysed', async () => {
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        const h = track(build({
            supervisorEnabled: true,
            runner: async () => { await gate; return { code: 0, stdout: 'ok', stderr: '' }; },
        }));
        const first = h.chat.autoAnalyzeTask(makeTask({ id: 'dup' }));
        await h.chat.autoAnalyzeTask(makeTask({ id: 'dup' })); // returns immediately
        expect(h.runs).toHaveLength(1);
        release();
        await first;
    });

    it('re-analyses the same task once the previous run finished', async () => {
        const h = track(build({ supervisorEnabled: true, runner: async () => ({ code: 0, stdout: 'ok', stderr: '' }) }));
        await h.chat.autoAnalyzeTask(makeTask({ id: 'again' }));
        await h.chat.autoAnalyzeTask(makeTask({ id: 'again' }));
        expect(h.runs).toHaveLength(2);
    });

    it('caps concurrent analyses at 2 and drains the queue afterwards', async () => {
        let active = 0;
        let peak = 0;
        const releases: Array<() => void> = [];
        const h = track(build({
            supervisorEnabled: true,
            runner: async () => {
                active++;
                peak = Math.max(peak, active);
                await new Promise<void>(r => releases.push(r));
                active--;
                return { code: 0, stdout: 'ok', stderr: '' };
            },
        }));

        const pending = [1, 2, 3, 4].map(i => h.chat.autoAnalyzeTask(makeTask({ id: `q${i}` })));
        await new Promise(r => setImmediate(r));
        expect(peak).toBe(2);

        // drain: release runners as they appear until every analysis settles
        for (let guard = 0; guard < 20 && releases.length; guard++) {
            releases.splice(0).forEach(fn => fn());
            await new Promise(r => setImmediate(r));
        }
        await Promise.all(pending);
        expect(h.runs).toHaveLength(4);
        expect(peak).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// the production runner, at the real process boundary
//
// Everything above injects a fake ClaudeRunner, which leaves the one piece the
// refactor actually moved — the spawn wrapper — unexercised. These tests put a
// `claude` shim on PATH and drive the real thing, so argv passthrough, cwd,
// stdin EOF and kill-on-timeout are all covered. Bash shim => POSIX only.
// ---------------------------------------------------------------------------
describe.skipIf(!SUPPORTS_FAKE_CLI)('defaultClaudeRunner (real spawn)', () => {
    const bin = join(BASE, 'bin');
    const work = join(BASE, 'work');
    const out = join(BASE, 'shim-out');
    let savedPath: string | undefined;

    const shim = `#!/bin/bash
printf '%s\\n' "$@" > "$SHIM_OUT/args.log"
pwd > "$SHIM_OUT/cwd.log"
if [ -n "$SHIM_READ_STDIN" ]; then cat > "$SHIM_OUT/stdin.log"; fi
if [ -n "$SHIM_SLEEP" ]; then echo $$ > "$SHIM_OUT/pid"; sleep "$SHIM_SLEEP"; fi
[ -n "$SHIM_STDERR" ] && printf '%s' "$SHIM_STDERR" >&2
printf '%s' "$SHIM_STDOUT"
exit "\${SHIM_EXIT:-0}"
`;

    beforeAll(() => {
        for (const d of [bin, work, out]) mkdirSync(d, { recursive: true });
        const exe = join(bin, 'claude');
        writeFileSync(exe, shim);
        chmodSync(exe, 0o755);
        savedPath = process.env.PATH;
        process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
        process.env.SHIM_OUT = out;
    });

    afterAll(() => {
        if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
        for (const k of ['SHIM_OUT', 'SHIM_STDOUT', 'SHIM_STDERR', 'SHIM_EXIT', 'SHIM_SLEEP', 'SHIM_READ_STDIN']) {
            delete process.env[k];
        }
    });

    beforeEach(() => {
        for (const k of ['SHIM_STDOUT', 'SHIM_STDERR', 'SHIM_EXIT', 'SHIM_SLEEP', 'SHIM_READ_STDIN']) {
            delete process.env[k];
        }
        rmSync(out, { recursive: true, force: true });
        mkdirSync(out, { recursive: true });
    });

    const shimArgs = () => readFileSync(join(out, 'args.log'), 'utf-8').trimEnd().split('\n');

    it('passes argv through verbatim and runs in the requested cwd', async () => {
        process.env.SHIM_STDOUT = 'hello from claude\n';
        const res = await defaultClaudeRunner(
            ['--print', '--output-format', 'text', '-p', 'a prompt with spaces'],
            { cwd: work, timeoutMs: 5000 }
        );
        expect(res).toEqual({ code: 0, stdout: 'hello from claude\n', stderr: '' });
        expect(shimArgs()).toEqual(['--print', '--output-format', 'text', '-p', 'a prompt with spaces']);
        expect(readFileSync(join(out, 'cwd.log'), 'utf-8').trim()).toBe(realpathSync(work));
    });

    it('reports a non-zero exit code and stderr instead of rejecting', async () => {
        process.env.SHIM_EXIT = '3';
        process.env.SHIM_STDERR = 'credit balance too low';
        const res = await defaultClaudeRunner(['-p', 'x'], { cwd: work, timeoutMs: 5000 });
        expect(res.code).toBe(3);
        expect(res.stderr).toBe('credit balance too low');
    });

    it('closes stdin so a CLI that reads it sees EOF instead of hanging', async () => {
        process.env.SHIM_READ_STDIN = '1';
        const res = await defaultClaudeRunner(['-p', 'x'], { cwd: work, timeoutMs: 5000 });
        expect(res.code).toBe(0);
        expect(readFileSync(join(out, 'stdin.log'), 'utf-8')).toBe('');
    });

    it('rejects with ClaudeTimeoutError and kills the child process', async () => {
        process.env.SHIM_SLEEP = '2';
        const started = defaultClaudeRunner(['-p', 'x'], { cwd: work, timeoutMs: 150 });
        await expect(started).rejects.toBeInstanceOf(ClaudeTimeoutError);
        await expect(started).rejects.toThrow('Claude Code timeout');

        const pid = Number(readFileSync(join(out, 'pid'), 'utf-8').trim());
        expect(pid).toBeGreaterThan(0);
        // the kill() must have landed — otherwise timed-out claude processes leak
        let alive = true;
        for (let i = 0; i < 40 && alive; i++) {
            try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 25)); }
            catch { alive = false; }
        }
        expect(alive).toBe(false);
    });

    it('rejects when the executable cannot be spawned at all', async () => {
        const empty = join(BASE, 'empty-bin');
        mkdirSync(empty, { recursive: true });
        const restore = process.env.PATH;
        process.env.PATH = empty;
        try {
            await expect(defaultClaudeRunner(['-p', 'x'], { cwd: work, timeoutMs: 5000 }))
                .rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            process.env.PATH = restore;
        }
    });

    it('SupervisorChat defaults to the real runner when none is injected', async () => {
        process.env.SHIM_STDOUT = '  the analysis  \n';
        const chat = new SupervisorChat(
            new FakeSpawner() as unknown as TaskSpawner,
            { getWorkspaces: () => [{ id: work, name: 'W' }] },
            { isSupervisorEnabled: () => true, getSupervisorSystemPrompt: () => 'SP' } as unknown as ConfigStore,
            { historyFile: nextHistoryFile() }   // runClaude deliberately omitted
        );
        harnesses.push(chat);
        expect(await priv(chat).callClaudeSimple('REAL PROMPT', work)).toBe('the analysis');
        expect(shimArgs()).toEqual(['--print', '--output-format', 'text', '-p', 'REAL PROMPT']);
    });
});
