/**
 * VoiceSupervisor — deterministic-logic tests.
 *
 * Covers the no-LLM fast paths (interrupt detection, canned status answers),
 * task-context prompt assembly, markdown→speech cleanup and the streaming
 * orchestration. No network: the Anthropic client is injected as a fake through
 * the constructor seam, and SupervisorChat/TaskSpawner are stubs.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { VoiceSupervisor, type VoiceResponse } from '../voice-supervisor.js';
import type { SupervisorChat } from '../supervisor-chat.js';
import type { TaskSpawner } from '../task-spawner.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { Task, ChatMessage } from '@claudia/shared';

function makeTask(over: Partial<Task> = {}): Task {
    return {
        id: 'task-1',
        prompt: 'do the thing',
        state: 'busy',
        workspaceId: '/ws/a',
        createdAt: new Date('2024-01-01T00:00:00Z'),
        lastActivity: new Date('2024-01-01T00:00:00Z'),
        ...over,
    } as Task;
}

class FakeSpawner {
    tasks: Task[] = [];
    destroyed: string[] = [];
    getAllTasks(): Task[] { return this.tasks; }
    destroyTask(id: string): void { this.destroyed.push(id); }
}

/** Minimal stand-in for the Anthropic streaming client. */
function fakeAnthropic(chunks: string[], opts: { throwOnStream?: Error } = {}) {
    const calls: Array<Record<string, unknown>> = [];
    const client = {
        messages: {
            stream: async (params: Record<string, unknown>) => {
                calls.push(params);
                if (opts.throwOnStream) throw opts.throwOnStream;
                const emitter = new EventEmitter() as EventEmitter & { finalMessage(): Promise<unknown> };
                emitter.finalMessage = async () => {
                    for (const c of chunks) emitter.emit('text', c);
                    return { content: [] };
                };
                return emitter;
            },
        },
    };
    return { client: client as unknown as Anthropic, calls };
}

function build(opts: {
    tasks?: Task[];
    anthropic?: Anthropic | null;
    sendMessageWithContext?: (content: string, ctx: string, taskId?: string, wsId?: string) => Promise<ChatMessage | null>;
} = {}) {
    const spawner = new FakeSpawner();
    spawner.tasks = opts.tasks ?? [];
    const sent: Array<{ content: string; ctx: string; taskId?: string; wsId?: string }> = [];
    const chat = {
        sendMessageWithContext: async (content: string, ctx: string, taskId?: string, wsId?: string) => {
            sent.push({ content, ctx, taskId, wsId });
            return opts.sendMessageWithContext
                ? opts.sendMessageWithContext(content, ctx, taskId, wsId)
                : ({ id: 'm1', role: 'assistant', content: 'plain reply', timestamp: '', taskId } as ChatMessage);
        },
    };
    const vs = new VoiceSupervisor(
        chat as unknown as SupervisorChat,
        spawner as unknown as TaskSpawner,
        { anthropic: opts.anthropic ?? null }
    );
    return { vs, spawner, sent };
}

type Internals = {
    buildTaskContext(workspaceId?: string): string;
    trySimpleResponse(t: string, workspaceId?: string): VoiceResponse | null;
    isInterruptCommand(t: string): boolean;
    handleInterrupt(t: string): Promise<VoiceResponse>;
    optimizeForVoice(t: string): string;
    anthropic: Anthropic | null;
};
const priv = (v: VoiceSupervisor) => v as unknown as Internals;

// ---------------------------------------------------------------------------
// construction
// ---------------------------------------------------------------------------
describe('construction', () => {
    it('disables voice features when ANTHROPIC_API_KEY is unset', () => {
        const original = process.env.ANTHROPIC_API_KEY;
        delete process.env.ANTHROPIC_API_KEY;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const vs = new VoiceSupervisor({} as SupervisorChat, new FakeSpawner() as unknown as TaskSpawner);
            expect(priv(vs).anthropic).toBeNull();
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('ANTHROPIC_API_KEY not set'));
        } finally {
            warn.mockRestore();
            if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
        }
    });

    it('builds a client from ANTHROPIC_API_KEY when present (no request is made)', () => {
        const original = process.env.ANTHROPIC_API_KEY;
        process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';
        try {
            const vs = new VoiceSupervisor({} as SupervisorChat, new FakeSpawner() as unknown as TaskSpawner);
            expect(priv(vs).anthropic).not.toBeNull();
        } finally {
            if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
            else process.env.ANTHROPIC_API_KEY = original;
        }
    });

    it('ships a default system prompt that constrains response length', () => {
        const { vs } = build();
        expect(vs.getSystemPrompt()).toContain('ULTRA SHORT');
        expect(vs.getSystemPrompt()).toContain('under 20 words');
    });

    it('setSystemPrompt replaces it', () => {
        const { vs } = build();
        vs.setSystemPrompt('be a pirate');
        expect(vs.getSystemPrompt()).toBe('be a pirate');
    });

    it('advertises the five SupervisorChat tools', () => {
        const { vs } = build();
        expect(vs.getAvailableTools().map(t => t.name)).toEqual([
            'create_task', 'delete_task', 'get_task_conversation', 'send_message_to_task', 'list_tasks',
        ]);
        expect(vs.getAvailableTools().every(t => t.description.length > 0)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// interrupt detection
// ---------------------------------------------------------------------------
describe('isInterruptCommand', () => {
    it.each(['stop', 'Cancel', 'PAUSE', 'halt', 'abort', 'never mind', 'stop that', '  stop  '])
        ('treats %j as an interrupt', (t) => {
            expect(priv(build().vs).isInterruptCommand(t)).toBe(true);
        });

    it.each(['what is running', 'create a task', 'hello', 'how is it going'])
        ('does not treat %j as an interrupt', (t) => {
            expect(priv(build().vs).isInterruptCommand(t)).toBe(false);
        });

    it('BUG: substring matching fires on phrases that ask NOT to stop', () => {
        // Documents current behaviour. `lower.includes(cmd)` means any transcript
        // containing "stop"/"cancel"/"abort"/"halt" as a substring kills every
        // running task — including negations and unrelated words.
        const v = priv(build().vs);
        expect(v.isInterruptCommand("don't stop the deploy")).toBe(true);
        expect(v.isInterruptCommand('do not cancel anything')).toBe(true);
        expect(v.isInterruptCommand('it has been running nonstop')).toBe(true); // "stop" inside "nonstop"
    });
});

describe('handleInterrupt', () => {
    it('reports nothing running when no task is busy', async () => {
        const { vs, spawner } = build({ tasks: [makeTask({ state: 'idle' })] });
        expect(await priv(vs).handleInterrupt('stop')).toEqual({ text: "Nothing's running right now.", action: 'none' });
        expect(spawner.destroyed).toEqual([]);
    });

    it('destroys every busy task and reports the count', async () => {
        const { vs, spawner } = build({
            tasks: [makeTask({ id: 'a', state: 'busy' }), makeTask({ id: 'b', state: 'busy' }), makeTask({ id: 'c', state: 'idle' })],
        });
        expect(await priv(vs).handleInterrupt('stop')).toEqual({ text: 'Stopped 2 tasks.', action: 'stopped' });
        expect(spawner.destroyed).toEqual(['a', 'b']);
    });

    it('uses the singular for a single task', async () => {
        const { vs } = build({ tasks: [makeTask({ state: 'busy' })] });
        expect((await priv(vs).handleInterrupt('stop')).text).toBe('Stopped 1 task.');
    });

    it('BUG: ignores the workspace scope and stops tasks everywhere', async () => {
        // processVoiceMessage passes workspaceId, but handleInterrupt never receives it,
        // so a workspace-scoped voice session can kill tasks in other workspaces.
        const { vs, spawner } = build({
            tasks: [makeTask({ id: 'here', workspaceId: '/ws/a', state: 'busy' }), makeTask({ id: 'elsewhere', workspaceId: '/ws/b', state: 'busy' })],
        });
        await vs.processVoiceMessage('stop', '/ws/a');
        expect(spawner.destroyed).toEqual(['here', 'elsewhere']);
    });
});

// ---------------------------------------------------------------------------
// canned (no-LLM) responses
// ---------------------------------------------------------------------------
describe('trySimpleResponse', () => {
    const ask = (t: string, tasks: Task[] = [], ws?: string) => priv(build({ tasks }).vs).trySimpleResponse(t, ws);

    it('returns null for anything it does not recognise', () => {
        expect(ask('write me a haiku about yaml')).toBeNull();
    });

    it.each(['what is running', 'status', "what's it doing", 'how is it going'])
        ('answers the status query %j', (t) => {
            expect(ask(t)).toEqual({ text: "Nothing's running right now.", action: 'response' });
        });

    it('counts busy tasks', () => {
        expect(ask('status', [makeTask({ state: 'busy' })])!.text).toBe('You have 1 task running.');
        expect(ask('status', [makeTask({ id: 'a', state: 'busy' }), makeTask({ id: 'b', state: 'busy' })])!.text)
            .toBe('You have 2 tasks running.');
    });

    it('falls through to idle tasks when nothing is busy', () => {
        expect(ask('status', [makeTask({ state: 'idle' })])!.text).toBe('1 task waiting for input.');
        expect(ask('status', [makeTask({ id: 'a', state: 'idle' }), makeTask({ id: 'b', state: 'idle' })])!.text)
            .toBe('2 tasks waiting for input.');
    });

    it('prefers the busy count when both busy and idle tasks exist', () => {
        expect(ask('status', [makeTask({ id: 'a', state: 'busy' }), makeTask({ id: 'b', state: 'idle' })])!.text)
            .toBe('You have 1 task running.');
    });

    it('scopes the count to the requested workspace', () => {
        const tasks = [makeTask({ id: 'a', workspaceId: '/ws/a', state: 'busy' }), makeTask({ id: 'b', workspaceId: '/ws/b', state: 'busy' })];
        expect(ask('status', tasks, '/ws/a')!.text).toBe('You have 1 task running.');
        expect(ask('status', tasks)!.text).toBe('You have 2 tasks running.');
    });

    it('BUG: waiting_input tasks are counted as neither running nor waiting', () => {
        // Only 'busy' and 'idle' are inspected, so a task in the 'waiting_input'
        // state is reported as "nothing running" even though it needs the user.
        expect(ask('status', [makeTask({ state: 'waiting_input' })])!.text).toBe("Nothing's running right now.");
    });

    it.each(['hi', 'hello', 'Hey', 'good morning', 'good afternoon'])('greets on %j', (t) => {
        expect(ask(t)).toEqual({ text: 'Hey! What can I help you with?', action: 'response' });
    });

    it('only greets on a bare greeting, not a greeting plus request', () => {
        expect(ask('hello, create a task')).toBeNull();
    });

    it('answers help queries', () => {
        expect(ask('help')!.text).toContain('I can create tasks');
        expect(ask('what can you do')!.text).toContain('I can create tasks');
    });

    it('checks status before help so "what can you do" style status wins', () => {
        // "how is it going" matches the status regex first
        expect(ask('how is it going')!.text).toBe("Nothing's running right now.");
    });
});

// ---------------------------------------------------------------------------
// task context (prompt construction)
// ---------------------------------------------------------------------------
describe('buildTaskContext', () => {
    it('returns empty string when there are no tasks', () => {
        expect(priv(build().vs).buildTaskContext()).toBe('');
    });

    it('groups tasks by state with counts', () => {
        const { vs } = build({
            tasks: [
                makeTask({ id: 'b1', state: 'busy', prompt: 'building' }),
                makeTask({ id: 'i1', state: 'idle', prompt: 'idling' }),
                makeTask({ id: 'e1', state: 'exited', prompt: 'exited one' }),
            ],
        });
        const ctx = priv(vs).buildTaskContext();
        expect(ctx).toContain('Running tasks (1):');
        expect(ctx).toContain('- Task b1: "building"');
        expect(ctx).toContain('Tasks waiting for input (1):');
        expect(ctx).toContain('- Task i1: "idling"');
        expect(ctx).toContain('Completed tasks (1):');
        expect(ctx).toContain('- Task e1: "exited one"');
    });

    it('omits sections with no tasks', () => {
        const { vs } = build({ tasks: [makeTask({ state: 'busy' })] });
        const ctx = priv(vs).buildTaskContext();
        expect(ctx).not.toContain('waiting for input');
        expect(ctx).not.toContain('Completed tasks');
    });

    it('truncates prompts at 50 chars with an ellipsis', () => {
        const { vs } = build({ tasks: [makeTask({ id: 't', state: 'busy', prompt: 'p'.repeat(60) })] });
        expect(priv(vs).buildTaskContext()).toContain(`- Task t: "${'p'.repeat(50)}..."`);
    });

    it('does not add an ellipsis at exactly 50 chars', () => {
        const { vs } = build({ tasks: [makeTask({ id: 't', state: 'busy', prompt: 'p'.repeat(50) })] });
        expect(priv(vs).buildTaskContext()).toContain(`- Task t: "${'p'.repeat(50)}"`);
    });

    it('filters by workspace', () => {
        const { vs } = build({
            tasks: [makeTask({ id: 'in', workspaceId: '/ws/a', state: 'busy' }), makeTask({ id: 'out', workspaceId: '/ws/b', state: 'busy' })],
        });
        const ctx = priv(vs).buildTaskContext('/ws/a');
        expect(ctx).toContain('Task in');
        expect(ctx).not.toContain('Task out');
    });

    it('BUG: tasks in states other than busy/idle/exited vanish from the context', () => {
        // A workspace with only waiting_input / starting / disconnected tasks produces
        // an empty context, so the model is told nothing is happening.
        const { vs } = build({ tasks: [makeTask({ state: 'waiting_input' }), makeTask({ id: 'x', state: 'starting' })] });
        expect(priv(vs).buildTaskContext()).toBe('');
    });
});

// ---------------------------------------------------------------------------
// markdown → speech
// ---------------------------------------------------------------------------
describe('optimizeForVoice', () => {
    const clean = (s: string) => priv(build().vs).optimizeForVoice(s);

    it('strips headers', () => {
        expect(clean('# Title\n## Sub\nbody')).toBe('Title\nSub\nbody');
    });

    it('unwraps bold and italics', () => {
        expect(clean('**bold** and *italic* and __b2__')).toBe('bold and italic and b2');
    });

    it('removes fenced code blocks entirely', () => {
        expect(clean('before\n```js\nconst x = 1;\n```\nafter')).toBe('before\n\nafter');
    });

    it('unwraps inline code', () => {
        expect(clean('run `npm test` now')).toBe('run npm test now');
    });

    it('strips bullet and numbered list markers', () => {
        expect(clean('- one\n* two\n+ three\n1. four')).toBe('one\ntwo\nthree\nfour');
    });

    it('keeps link text and drops the URL', () => {
        expect(clean('see [the docs](https://example.com/x) please')).toBe('see the docs please');
    });

    it('collapses runs of blank lines', () => {
        expect(clean('a\n\n\n\n\nb')).toBe('a\n\nb');
    });

    it('trims surrounding whitespace', () => {
        expect(clean('   hi   ')).toBe('hi');
    });

    it('does not truncate long responses', () => {
        const long = 'w'.repeat(5000);
        expect(clean(long)).toHaveLength(5000);
    });

    it('leaves plain prose untouched', () => {
        expect(clean('Everything worked. Want me to push it?')).toBe('Everything worked. Want me to push it?');
    });

    it('BUG: underscore-italic stripping mangles snake_case identifiers', () => {
        // `_(.+?)_` has no word-boundary guard, so identifiers read aloud wrong
        // and any code the model mentions inline is corrupted.
        expect(clean('call get_task_conversation now')).toBe('call gettaskconversation now');
    });
});

// ---------------------------------------------------------------------------
// non-streaming path
// ---------------------------------------------------------------------------
describe('processVoiceMessage', () => {
    it('short-circuits on interrupts without touching the chat backend', async () => {
        const { vs, sent } = build({ tasks: [makeTask({ state: 'busy' })] });
        expect(await vs.processVoiceMessage('stop')).toEqual({ text: 'Stopped 1 task.', action: 'stopped' });
        expect(sent).toEqual([]);
    });

    it('short-circuits on canned answers without touching the chat backend', async () => {
        const { vs, sent } = build();
        expect((await vs.processVoiceMessage('hello')).text).toBe('Hey! What can I help you with?');
        expect(sent).toEqual([]);
    });

    it('forwards the transcript plus task context to SupervisorChat', async () => {
        const { vs, sent } = build({ tasks: [makeTask({ id: 'b1', state: 'busy', prompt: 'compiling' })] });
        const res = await vs.processVoiceMessage('write a limerick', '/ws/a');
        expect(sent).toHaveLength(1);
        expect(sent[0].content).toBe('write a limerick');
        expect(sent[0].ctx).toContain('Running tasks (1):');
        expect(sent[0].wsId).toBe('/ws/a');
        expect(res.action).toBe('response');
    });

    it('voice-optimises the reply and carries the task id through', async () => {
        const { vs } = build({
            sendMessageWithContext: async () => ({ id: 'm', role: 'assistant', content: '## Done\n- **all good**', timestamp: '', taskId: 't9' } as ChatMessage),
        });
        expect(await vs.processVoiceMessage('go')).toEqual({ text: 'Done\nall good', action: 'response', taskId: 't9' });
    });

    it('returns an error response when the chat backend returns null (busy)', async () => {
        const { vs } = build({ sendMessageWithContext: async () => null });
        expect(await vs.processVoiceMessage('go')).toEqual({ text: "Sorry, I couldn't process that. Can you try again?", action: 'error' });
    });
});

// ---------------------------------------------------------------------------
// streaming path
// ---------------------------------------------------------------------------
describe('processVoiceMessageStreaming', () => {
    it('reports the interrupt through both callbacks without calling the model', async () => {
        const { client, calls } = fakeAnthropic(['unused']);
        const { vs } = build({ tasks: [makeTask({ state: 'busy' })], anthropic: client });
        const onTextChunk = vi.fn();
        const onComplete = vi.fn();
        await vs.processVoiceMessageStreaming('stop', undefined, undefined, { onTextChunk, onComplete });
        expect(onTextChunk).toHaveBeenCalledWith('Stopped 1 task.');
        expect(onComplete).toHaveBeenCalledWith({ text: 'Stopped 1 task.', action: 'stopped' });
        expect(calls).toHaveLength(0);
    });

    it('reports canned answers without calling the model', async () => {
        const { client, calls } = fakeAnthropic(['unused']);
        const { vs } = build({ anthropic: client });
        const onComplete = vi.fn();
        await vs.processVoiceMessageStreaming('hello', undefined, undefined, { onComplete });
        expect(onComplete).toHaveBeenCalledWith({ text: 'Hey! What can I help you with?', action: 'response' });
        expect(calls).toHaveLength(0);
    });

    it('sends the system prompt with the task-status section and short max_tokens', async () => {
        const { client, calls } = fakeAnthropic(['hi']);
        const { vs } = build({ tasks: [makeTask({ id: 'b1', state: 'busy', prompt: 'compiling' })], anthropic: client });
        vs.setSystemPrompt('CUSTOM PROMPT');
        await vs.processVoiceMessageStreaming('tell me a joke', '/ws/a');

        expect(calls).toHaveLength(1);
        const params = calls[0] as { system: string; max_tokens: number; messages: Array<{ role: string; content: string }> };
        expect(params.max_tokens).toBe(150);
        expect(params.messages).toEqual([{ role: 'user', content: 'tell me a joke' }]);
        expect(params.system).toContain('CUSTOM PROMPT');
        expect(params.system).toContain('## Current Task Status');
        expect(params.system).toContain('- Task b1: "compiling"');
    });

    it('omits the task-status section when there are no tasks', async () => {
        const { client, calls } = fakeAnthropic(['hi']);
        const { vs } = build({ anthropic: client });
        await vs.processVoiceMessageStreaming('anything');
        expect((calls[0] as { system: string }).system).not.toContain('## Current Task Status');
    });

    it('streams raw chunks live and voice-optimises only the final text', async () => {
        const { client } = fakeAnthropic(['## Head', 'ing\n- **item**']);
        const { vs } = build({ anthropic: client });
        const chunks: string[] = [];
        const onComplete = vi.fn();
        await vs.processVoiceMessageStreaming('go', undefined, undefined, { onTextChunk: c => chunks.push(c), onComplete });
        expect(chunks).toEqual(['## Head', 'ing\n- **item**']);
        expect(onComplete).toHaveBeenCalledWith({ text: 'Heading\nitem', action: 'response' });
    });

    it('reports unavailability when no API key was configured', async () => {
        const { vs } = build({ anthropic: null });
        const onError = vi.fn();
        const onComplete = vi.fn();
        await vs.processVoiceMessageStreaming('go', undefined, undefined, { onError, onComplete });
        expect(onError.mock.calls[0][0].message).toContain('ANTHROPIC_API_KEY not configured');
        expect(onComplete).not.toHaveBeenCalled();
    });

    it('routes a streaming failure to onError plus a spoken apology', async () => {
        const { client } = fakeAnthropic([], { throwOnStream: new Error('upstream 500') });
        const { vs } = build({ anthropic: client });
        const onError = vi.fn();
        const onTextChunk = vi.fn();
        const onComplete = vi.fn();
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await vs.processVoiceMessageStreaming('go', undefined, undefined, { onError, onTextChunk, onComplete });
        errSpy.mockRestore();
        expect(onError.mock.calls[0][0].message).toBe('upstream 500');
        expect(onTextChunk).toHaveBeenCalledWith("Sorry, I couldn't process that. Can you try again?");
        expect(onComplete).toHaveBeenCalledWith({ text: "Sorry, I couldn't process that. Can you try again?", action: 'error' });
    });

    it('tolerates being called with no callbacks at all', async () => {
        const { client } = fakeAnthropic(['hi']);
        const { vs } = build({ anthropic: client });
        await expect(vs.processVoiceMessageStreaming('go')).resolves.toBeUndefined();
    });
});
