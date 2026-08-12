import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionEvent } from '../session-events.js';

// Mock both generation paths so these tests are deterministic and never hit the
// network or spawn the real `claude` CLI. summarizeEvents() tries the proxy first,
// then falls back to the CLI, so a test that only stubs the proxy would silently
// shell out and take seconds.
const mockGenerate = vi.fn();
vi.mock('../llm-service.js', () => ({
    generateLLMResponse: (...args: unknown[]) => mockGenerate(...args),
}));

/** Simulates the spawned `claude --print` process. */
const mockCli = { code: 1, stdout: '', stderr: 'not available' };
vi.mock('child_process', () => ({
    spawn: () => {
        const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
        const proc = {
            stdout: { on: (ev: string, cb: (d: string) => void) => { if (ev === 'data' && mockCli.stdout) cb(mockCli.stdout); } },
            stderr: { on: (ev: string, cb: (d: string) => void) => { if (ev === 'data' && mockCli.stderr) cb(mockCli.stderr); } },
            stdin: { end: () => {} },
            kill: () => {},
            on: (ev: string, cb: (...a: unknown[]) => void) => {
                (handlers[ev] ||= []).push(cb);
                if (ev === 'close') setTimeout(() => cb(mockCli.code), 0);
                return proc;
            },
        };
        return proc;
    },
}));

const { SessionSummarizer, summarizeEvents, buildFallbackSummary } = await import('../session-summarizer.js');

const text = (id: string, role: 'user' | 'assistant', t: string): SessionEvent =>
    ({ type: 'text', id, role, text: t, timestamp: '' });

const tool = (id: string, name: string, input: Record<string, unknown>, result?: string, isError?: boolean): SessionEvent =>
    ({ type: 'tool', id, name, input, result, isError, timestamp: '' });

beforeEach(() => {
    mockGenerate.mockReset();
    // Default: CLI unavailable, so "LLM throws" tests exercise the real fallback.
    mockCli.code = 1;
    mockCli.stdout = '';
    mockCli.stderr = 'not available';
});

describe('buildFallbackSummary', () => {
    it('groups repeated tools and notes failures', () => {
        const s = buildFallbackSummary([
            tool('1', 'Read', { file_path: 'a.ts' }, 'ok'),
            tool('2', 'Read', { file_path: 'b.ts' }, 'ok'),
            tool('3', 'Bash', { command: 'npm test' }, 'boom', true),
        ]);
        expect(s).toContain('Read (2×)');
        expect(s).toContain('Bash');
        expect(s).toContain('1 failed');
    });

    it('falls back to assistant prose when there are no tools', () => {
        const s = buildFallbackSummary([text('a', 'assistant', 'I will refactor the client. Then run tests.')]);
        expect(s).toContain('I will refactor the client.');
    });

    it('never returns an empty string', () => {
        expect(buildFallbackSummary([])).toBe('Working…');
    });
});

describe('summarizeEvents', () => {
    it('returns LLM prose when the call succeeds', async () => {
        mockGenerate.mockResolvedValue('Claude is adding retry logic and re-running the tests.');
        const res = await summarizeEvents([tool('1', 'Edit', { file_path: 'client.ts' }, 'done')]);
        expect(res.text).toBe('Claude is adding retry logic and re-running the tests.');
        expect(res.isFallback).toBe(false);
    });

    it('strips markdown and code the model may return anyway', async () => {
        mockGenerate.mockResolvedValue('**Claude** ran `npm test`:\n```js\nfoo()\n```\nIt failed.');
        const res = await summarizeEvents([tool('1', 'Bash', { command: 'npm test' }, 'fail', true)]);
        expect(res.text).not.toContain('```');
        expect(res.text).not.toContain('**');
        expect(res.text).not.toContain('`');
        expect(res.text).toContain('Claude ran npm test');
    });

    it('falls back deterministically when the LLM throws', async () => {
        mockGenerate.mockRejectedValue(new Error('no api key'));
        const res = await summarizeEvents([tool('1', 'Bash', { command: 'ls' }, 'ok')]);
        expect(res.isFallback).toBe(true);
        expect(res.text).toContain('Bash');
    });

    it('falls back to the claude CLI when the proxy is unavailable', async () => {
        // The /v1/messages proxy route does not exist on a stock install, so this
        // path is the one that actually runs in practice.
        mockGenerate.mockRejectedValue(new Error('Cannot POST /v1/messages'));
        mockCli.code = 0;
        mockCli.stdout = 'Claude is pulling the latest changes.';

        const res = await summarizeEvents([tool('1', 'Bash', { command: 'git pull' }, 'ok')]);
        expect(res.text).toBe('Claude is pulling the latest changes.');
        expect(res.isFallback).toBe(false);
    });

    it('does not send raw code or file contents to the model', async () => {
        mockGenerate.mockResolvedValue('Claude read a file.');
        await summarizeEvents([
            text('a', 'assistant', 'Here:\n```ts\nconst secret = 1;\n```\nDone.'),
            tool('1', 'Read', { file_path: 'x.ts' }, 'x'.repeat(5000)),
        ]);
        const userMessage = mockGenerate.mock.calls[0][1] as string;
        expect(userMessage).not.toContain('```');
        expect(userMessage).not.toContain('const secret');
        // Long tool output must be truncated, not passed through wholesale.
        expect(userMessage.length).toBeLessThan(2000);
    });
});

describe('SessionSummarizer batching', () => {
    it('does not emit until the batch fills or ages out', async () => {
        mockGenerate.mockResolvedValue('summary');
        const s = new SessionSummarizer();
        s.add('t1', [tool('1', 'Read', {}, 'ok')], 0);

        expect((await s.drain(1000)).size).toBe(0);      // too few, too recent
        expect((await s.drain(30000)).size).toBe(1);     // aged out
    });

    it('emits once the batch size is reached', async () => {
        mockGenerate.mockResolvedValue('summary');
        const s = new SessionSummarizer();
        s.add('t1', Array.from({ length: 12 }, (_, i) => tool(String(i), 'Read', {}, 'ok')), 0);

        const out = await s.drain(1);
        expect(out.get('t1')).toHaveLength(1);
        expect(out.get('t1')![0].eventCount).toBe(12);
    });

    it('accumulates summaries and returns only the new one per drain', async () => {
        mockGenerate.mockResolvedValue('summary');
        const s = new SessionSummarizer();

        s.add('t1', [tool('1', 'Read', {}, 'ok')], 0);
        await s.drain(30000);
        s.add('t1', [tool('2', 'Bash', {}, 'ok')], 30000);
        const second = await s.drain(60000);

        expect(second.get('t1')).toHaveLength(1);       // delta only
        expect(s.getSummaries('t1')).toHaveLength(2);   // full history retained
    });

    it('keeps tasks isolated from each other', async () => {
        mockGenerate.mockResolvedValue('summary');
        const s = new SessionSummarizer();
        s.add('t1', [tool('1', 'Read', {}, 'ok')], 0);
        s.add('t2', [tool('2', 'Bash', {}, 'ok')], 0);

        const out = await s.drain(30000);
        expect(out.has('t1')).toBe(true);
        expect(out.has('t2')).toBe(true);
        expect(s.getSummaries('t1')).toHaveLength(1);
        expect(s.getSummaries('t2')).toHaveLength(1);
    });

    it('does not re-summarize the same events twice', async () => {
        mockGenerate.mockResolvedValue('summary');
        const s = new SessionSummarizer();
        s.add('t1', [tool('1', 'Read', {}, 'ok')], 0);

        await s.drain(30000);
        await s.drain(60000);   // nothing new pending
        expect(mockGenerate).toHaveBeenCalledTimes(1);
    });

    it('clear() drops all state for a task', async () => {
        mockGenerate.mockResolvedValue('summary');
        const s = new SessionSummarizer();
        s.add('t1', [tool('1', 'Read', {}, 'ok')], 0);
        await s.drain(30000);

        s.clear('t1');
        expect(s.getSummaries('t1')).toHaveLength(0);
    });

    it('survives an LLM failure without losing the batch', async () => {
        mockGenerate.mockRejectedValue(new Error('down'));
        const s = new SessionSummarizer();
        s.add('t1', [tool('1', 'Bash', { command: 'ls' }, 'ok')], 0);

        const out = await s.drain(30000);
        expect(out.get('t1')).toHaveLength(1);
        expect(out.get('t1')![0].isFallback).toBe(true);
    });
});
