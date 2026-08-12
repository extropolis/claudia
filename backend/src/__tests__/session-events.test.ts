import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseSessionEvents, getSessionFilePath, ToolCallEvent, TextEvent } from '../session-events.js';

/**
 * These tests build a real ~/.claude/projects tree in a temp HOME so we exercise the
 * actual path-slugging and file IO rather than mocking fs.
 */

const SESSION_ID = 'test-session-0001';
const WORKSPACE = '/Users/tester/work/my-project';

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

function writeSession(lines: unknown[]): string {
    const file = getSessionFilePath(WORKSPACE, SESSION_ID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return file;
}

function appendSession(lines: unknown[]): void {
    const file = getSessionFilePath(WORKSPACE, SESSION_ID);
    fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

const assistantText = (uuid: string, text: string) => ({
    type: 'assistant',
    uuid,
    timestamp: '2026-08-11T10:00:00Z',
    sessionId: SESSION_ID,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
});

beforeEach(() => {
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudia-session-test-'));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('getSessionFilePath', () => {
    it('slugifies the workspace path the way Claude Code does', () => {
        const p = getSessionFilePath('/Users/tester/work/my-project', 'abc');
        expect(p).toBe(path.join(tmpHome, '.claude', 'projects', '-Users-tester-work-my-project', 'abc.jsonl'));
    });
});

describe('parseSessionEvents', () => {
    it('returns null when the session file does not exist', async () => {
        expect(await parseSessionEvents(WORKSPACE, 'nope')).toBeNull();
    });

    it('extracts user and assistant text in order', async () => {
        writeSession([
            { type: 'user', uuid: 'u1', timestamp: 't1', sessionId: SESSION_ID, message: { role: 'user', content: 'hello there' } },
            assistantText('a1', 'hi, how can I help?'),
        ]);

        const res = await parseSessionEvents(WORKSPACE, SESSION_ID);
        expect(res).not.toBeNull();
        expect(res!.events).toHaveLength(2);
        expect(res!.events[0]).toMatchObject({ type: 'text', role: 'user', text: 'hello there' });
        expect(res!.events[1]).toMatchObject({ type: 'text', role: 'assistant', text: 'hi, how can I help?' });
    });

    it('pairs a tool_use with its tool_result', async () => {
        writeSession([
            {
                type: 'assistant',
                uuid: 'a1',
                sessionId: SESSION_ID,
                message: {
                    role: 'assistant',
                    content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/x.ts' } }],
                },
            },
            {
                type: 'user',
                uuid: 'u2',
                sessionId: SESSION_ID,
                message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents' }] },
            },
        ]);

        const res = await parseSessionEvents(WORKSPACE, SESSION_ID);
        expect(res!.events).toHaveLength(1);
        const tool = res!.events[0] as ToolCallEvent;
        expect(tool).toMatchObject({
            type: 'tool',
            name: 'Read',
            input: { file_path: '/tmp/x.ts' },
            result: 'file contents',
            isError: false,
        });
    });

    it('flattens array-shaped tool results, including tool_reference blocks', async () => {
        writeSession([
            {
                type: 'assistant',
                uuid: 'a1',
                sessionId: SESSION_ID,
                message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'ToolSearch', input: {} }] },
            },
            {
                type: 'user',
                uuid: 'u2',
                sessionId: SESSION_ID,
                message: {
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: 'toolu_1',
                            content: [
                                { type: 'text', text: 'line one' },
                                { type: 'tool_reference', tool_name: 'mcp__foo__bar' },
                            ],
                        },
                    ],
                },
            },
        ]);

        const tool = (await parseSessionEvents(WORKSPACE, SESSION_ID))!.events[0] as ToolCallEvent;
        expect(tool.result).toBe('line one\n[tool_reference: mcp__foo__bar]');
    });

    it('marks errored tool results', async () => {
        writeSession([
            {
                type: 'assistant',
                uuid: 'a1',
                sessionId: SESSION_ID,
                message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'false' } }] },
            },
            {
                type: 'user',
                uuid: 'u2',
                sessionId: SESSION_ID,
                message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }] },
            },
        ]);

        const tool = (await parseSessionEvents(WORKSPACE, SESSION_ID))!.events[0] as ToolCallEvent;
        expect(tool.isError).toBe(true);
        expect(tool.result).toBe('boom');
    });

    it('captures thinking blocks', async () => {
        writeSession([
            {
                type: 'assistant',
                uuid: 'a1',
                sessionId: SESSION_ID,
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'thinking', thinking: 'let me consider' },
                        { type: 'text', text: 'here is the answer' },
                    ],
                },
            },
        ]);

        const res = await parseSessionEvents(WORKSPACE, SESSION_ID);
        expect(res!.events.map((e) => e.type)).toEqual(['thinking', 'text']);
    });

    it('ignores sidechain, meta, and non-message bookkeeping entries', async () => {
        writeSession([
            { type: 'queue-operation', operation: 'enqueue', sessionId: SESSION_ID },
            { type: 'ai-title', aiTitle: 'Some title', sessionId: SESSION_ID },
            { type: 'attachment', sessionId: SESSION_ID },
            { type: 'mode', mode: 'default', sessionId: SESSION_ID },
            { type: 'system', subtype: 'hook', sessionId: SESSION_ID },
            { type: 'assistant', uuid: 's1', isSidechain: true, sessionId: SESSION_ID, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent noise' }] } },
            { type: 'user', uuid: 'm1', isMeta: true, sessionId: SESSION_ID, message: { role: 'user', content: '[CONTEXT UPDATE: ...]' } },
            assistantText('a1', 'real content'),
        ]);

        const res = await parseSessionEvents(WORKSPACE, SESSION_ID);
        expect(res!.events).toHaveLength(1);
        expect((res!.events[0] as TextEvent).text).toBe('real content');
    });

    it('strips Claudia [CONTEXT UPDATE: ...] injections from user messages', async () => {
        // These are NOT flagged isMeta in real transcripts, so they must be matched
        // on content — see the fieldmap session that exposed this.
        writeSession([
            {
                type: 'user', uuid: 'u1', sessionId: SESSION_ID,
                message: { role: 'user', content: '[CONTEXT UPDATE: MCP server configuration has changed. Currently enabled: foo] acknowledge this update briefly' },
            },
            {
                type: 'user', uuid: 'u2', sessionId: SESSION_ID,
                message: { role: 'user', content: '[CONTEXT UPDATE: workspace references changed]' },
            },
            { type: 'user', uuid: 'u3', sessionId: SESSION_ID, message: { role: 'user', content: 'a normal message' } },
        ]);

        const res = await parseSessionEvents(WORKSPACE, SESSION_ID);
        const texts = res!.events.map((e) => (e as TextEvent).text);
        // The prefix is removed but the user's own trailing text is kept.
        expect(texts).toEqual(['acknowledge this update briefly', 'a normal message']);
        expect(texts.join(' ')).not.toContain('CONTEXT UPDATE');
    });

    it('does not strip bracketed text from assistant messages', async () => {
        writeSession([assistantText('a1', 'The literal string [CONTEXT UPDATE: x] appears in the docs.')]);
        const res = await parseSessionEvents(WORKSPACE, SESSION_ID);
        expect((res!.events[0] as TextEvent).text).toContain('[CONTEXT UPDATE: x]');
    });

    it('deduplicates the partial/final pair written under one assistant uuid', async () => {
        writeSession([assistantText('a1', 'answer'), assistantText('a1', 'answer')]);
        const res = await parseSessionEvents(WORKSPACE, SESSION_ID);
        expect(res!.events).toHaveLength(1);
    });

    it('skips malformed lines without failing the parse', async () => {
        const file = getSessionFilePath(WORKSPACE, SESSION_ID);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `{not json\n${JSON.stringify(assistantText('a1', 'survived'))}\n`);

        const res = await parseSessionEvents(WORKSPACE, SESSION_ID);
        expect(res!.events).toHaveLength(1);
        expect((res!.events[0] as TextEvent).text).toBe('survived');
    });

    it('reads incrementally from an offset, returning only appended events', async () => {
        writeSession([assistantText('a1', 'first')]);
        const first = await parseSessionEvents(WORKSPACE, SESSION_ID);
        expect(first!.events).toHaveLength(1);

        appendSession([assistantText('a2', 'second')]);
        const second = await parseSessionEvents(WORKSPACE, SESSION_ID, first!.offset);
        expect(second!.events).toHaveLength(1);
        expect((second!.events[0] as TextEvent).text).toBe('second');
        expect(second!.offset).toBeGreaterThan(first!.offset);
    });

    it('returns no events when nothing was appended since the offset', async () => {
        writeSession([assistantText('a1', 'only')]);
        const first = await parseSessionEvents(WORKSPACE, SESSION_ID);
        const second = await parseSessionEvents(WORKSPACE, SESSION_ID, first!.offset);
        expect(second!.events).toHaveLength(0);
        expect(second!.offset).toBe(first!.offset);
    });

    it('re-reads from the start when the file shrinks', async () => {
        writeSession([assistantText('a1', 'one'), assistantText('a2', 'two')]);
        const first = await parseSessionEvents(WORKSPACE, SESSION_ID);
        expect(first!.events).toHaveLength(2);

        writeSession([assistantText('b1', 'rewritten')]);
        const second = await parseSessionEvents(WORKSPACE, SESSION_ID, first!.offset);
        expect(second!.events).toHaveLength(1);
        expect((second!.events[0] as TextEvent).text).toBe('rewritten');
    });

    it('does not lose a line that was only partially flushed at read time', async () => {
        const file = getSessionFilePath(WORKSPACE, SESSION_ID);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // A complete line, then a torn one with no trailing newline.
        fs.writeFileSync(file, `${JSON.stringify(assistantText('a1', 'complete'))}\n{"type":"assist`);

        const first = await parseSessionEvents(WORKSPACE, SESSION_ID);
        expect(first!.events).toHaveLength(1);

        // Claude Code finishes writing that line.
        fs.writeFileSync(file, `${JSON.stringify(assistantText('a1', 'complete'))}\n${JSON.stringify(assistantText('a2', 'torn then completed'))}\n`);

        const second = await parseSessionEvents(WORKSPACE, SESSION_ID, first!.offset);
        const texts = second!.events.map((e) => (e as TextEvent).text);
        expect(texts).toContain('torn then completed');
    });

    it('emits a result-only stub when the tool_use came before the offset', async () => {
        writeSession([
            {
                type: 'assistant',
                uuid: 'a1',
                sessionId: SESSION_ID,
                message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'ls' } }] },
            },
        ]);
        const first = await parseSessionEvents(WORKSPACE, SESSION_ID);
        expect((first!.events[0] as ToolCallEvent).result).toBeUndefined();

        appendSession([
            {
                type: 'user',
                uuid: 'u2',
                sessionId: SESSION_ID,
                message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'done' }] },
            },
        ]);

        const second = await parseSessionEvents(WORKSPACE, SESSION_ID, first!.offset);
        expect(second!.events).toHaveLength(1);
        expect(second!.events[0]).toMatchObject({ type: 'tool', id: 'toolu_9', result: 'done' });
    });

    it('truncates oversized tool results', async () => {
        writeSession([
            {
                type: 'assistant',
                uuid: 'a1',
                sessionId: SESSION_ID,
                message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
            },
            {
                type: 'user',
                uuid: 'u2',
                sessionId: SESSION_ID,
                message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(50000) }] },
            },
        ]);

        const tool = (await parseSessionEvents(WORKSPACE, SESSION_ID))!.events[0] as ToolCallEvent;
        expect(tool.result!.length).toBeLessThan(21000);
        expect(tool.result).toContain('truncated');
    });
});
