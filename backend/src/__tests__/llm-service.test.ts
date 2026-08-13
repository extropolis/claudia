import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import {
    initializeLLMService,
    generateLLMResponse,
    generatePlanResponse,
    generateConversationalResponse,
    generateTaskCreatedResponse,
} from '../llm-service.js';

/**
 * Tests for src/llm-service.ts
 *
 * These exercise the REAL fetch path against a real http server bound to an
 * EPHEMERAL port (never 4001/5173). The service is pointed at it via the
 * CLAUDIA_LLM_API_URL test seam (see llm-service.ts) — production behaviour is
 * unchanged when that variable is unset.
 */

interface Captured {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
    body: any;
}

let server: Server;
let baseUrl: string;
let captured: Captured[] = [];
let handler: (req: IncomingMessage, res: ServerResponse, body: string) => void;

/** Default handler: a well-formed Anthropic-shaped success response. */
function okHandler(_req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: '  hello world  ' }], stop_reason: 'end_turn' }));
}

beforeAll(async () => {
    server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c as Buffer));
        req.on('end', () => {
            const rawBody = Buffer.concat(chunks).toString('utf-8');
            let parsed: any;
            try { parsed = JSON.parse(rawBody); } catch { parsed = undefined; }
            captured.push({
                method: req.method || '',
                url: req.url || '',
                headers: req.headers as Record<string, string | string[] | undefined>,
                rawBody,
                body: parsed,
            });
            handler(req, res, rawBody);
        });
    });
    // Port 0 => OS-assigned ephemeral port. Loopback only.
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/v1/messages`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

let envBackup: Record<string, string | undefined>;

beforeEach(() => {
    envBackup = {
        CLAUDIA_LLM_API_URL: process.env.CLAUDIA_LLM_API_URL,
        LLM_MODEL: process.env.LLM_MODEL,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    };
    process.env.CLAUDIA_LLM_API_URL = baseUrl;
    delete process.env.LLM_MODEL;
    captured = [];
    handler = okHandler;
    vi.spyOn(console, 'log').mockImplementation(() => { });
    vi.spyOn(console, 'error').mockImplementation(() => { });
});

afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    vi.restoreAllMocks();
});

describe('llm-service', () => {
    describe('initializeLLMService', () => {
        it('accepts a config store and logs initialization', () => {
            const fakeStore = { getApiMode: () => 'anthropic' } as any;
            expect(() => initializeLLMService(fakeStore)).not.toThrow();
            expect(console.log).toHaveBeenCalledWith('[LLM] Service initialized with config store');
        });
    });

    describe('request construction', () => {
        it('POSTs JSON to the configured endpoint exactly once', async () => {
            await generateLLMResponse('sys', 'user msg');
            expect(captured).toHaveLength(1);
            expect(captured[0].method).toBe('POST');
            expect(captured[0].url).toBe('/v1/messages');
            expect(captured[0].headers['content-type']).toBe('application/json');
        });

        it('sends the anthropic-version header', async () => {
            await generateLLMResponse('sys', 'user msg');
            expect(captured[0].headers['anthropic-version']).toBe('2023-06-01');
        });

        it('sends the documented body shape', async () => {
            await generateLLMResponse('SYSTEM PROMPT', 'USER MESSAGE', { maxTokens: 321 });
            expect(captured[0].body).toEqual({
                model: 'claude-sonnet-4-5-20250929',
                system: 'SYSTEM PROMPT',
                messages: [{ role: 'user', content: 'USER MESSAGE' }],
                max_tokens: 321,
            });
        });

        it('defaults max_tokens to 200', async () => {
            await generateLLMResponse('sys', 'user');
            expect(captured[0].body.max_tokens).toBe(200);
        });

        it('does NOT send temperature even when the caller supplies it', async () => {
            // Intentional in the implementation: temperature is not always
            // supported by the proxy, so it is deliberately omitted.
            await generateLLMResponse('sys', 'user', { temperature: 0.1 });
            expect(captured[0].body).not.toHaveProperty('temperature');
        });

        it('sends exactly one user message and no assistant turns', async () => {
            await generateLLMResponse('sys', 'only turn');
            expect(captured[0].body.messages).toHaveLength(1);
            expect(captured[0].body.messages[0].role).toBe('user');
        });

        it('preserves unicode and newlines in the payload', async () => {
            const msg = 'line1\nline2 — émoji 🚀 "quoted"';
            await generateLLMResponse('sys', msg);
            expect(captured[0].body.messages[0].content).toBe(msg);
        });
    });

    describe('model selection', () => {
        it('uses the default model when LLM_MODEL is unset', async () => {
            await generateLLMResponse('s', 'u');
            expect(captured[0].body.model).toBe('claude-sonnet-4-5-20250929');
        });

        it('honours the LLM_MODEL environment override', async () => {
            process.env.LLM_MODEL = 'claude-opus-4-1-20250805';
            await generateLLMResponse('s', 'u');
            expect(captured[0].body.model).toBe('claude-opus-4-1-20250805');
        });

        it('falls back to the default when LLM_MODEL is empty', async () => {
            process.env.LLM_MODEL = '';
            await generateLLMResponse('s', 'u');
            expect(captured[0].body.model).toBe('claude-sonnet-4-5-20250929');
        });
    });

    describe('success path', () => {
        it('returns the trimmed text of the first text block', async () => {
            await expect(generateLLMResponse('s', 'u')).resolves.toBe('hello world');
        });

        it('skips non-text content blocks and returns the first text block', async () => {
            handler = (_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    content: [
                        { type: 'thinking', text: 'internal' },
                        { type: 'tool_use', id: 't1' },
                        { type: 'text', text: 'visible answer' },
                    ],
                }));
            };
            await expect(generateLLMResponse('s', 'u')).resolves.toBe('visible answer');
        });
    });

    describe('malformed responses', () => {
        it('throws when there is no text block', async () => {
            handler = (_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ content: [{ type: 'tool_use', id: 'x' }] }));
            };
            await expect(generateLLMResponse('s', 'u')).rejects.toThrow('No text content in LLM response');
        });

        it('throws when content is absent entirely', async () => {
            handler = (_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ stop_reason: 'end_turn' }));
            };
            await expect(generateLLMResponse('s', 'u')).rejects.toThrow('No text content in LLM response');
        });

        it('throws when the text block has an empty string body', async () => {
            handler = (_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ content: [{ type: 'text', text: '' }] }));
            };
            await expect(generateLLMResponse('s', 'u')).rejects.toThrow('No text content in LLM response');
        });

        it('throws a JSON parse error when the 200 body is not JSON', async () => {
            handler = (_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('<html>not json</html>');
            };
            await expect(generateLLMResponse('s', 'u')).rejects.toThrow();
        });
    });

    describe('error mapping', () => {
        it('maps a 4xx to "LLM API error: <status> - <body>"', async () => {
            handler = (_req, res) => {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end('{"error":"bad_request"}');
            };
            await expect(generateLLMResponse('s', 'u')).rejects.toThrow(
                'LLM API error: 400 - {"error":"bad_request"}',
            );
        });

        it('maps a 401 the same way (no special auth handling)', async () => {
            handler = (_req, res) => { res.writeHead(401); res.end('unauthorized'); };
            await expect(generateLLMResponse('s', 'u')).rejects.toThrow('LLM API error: 401 - unauthorized');
        });

        it('maps a 429 the same way (no backoff, no retry)', async () => {
            handler = (_req, res) => { res.writeHead(429); res.end('rate limited'); };
            await expect(generateLLMResponse('s', 'u')).rejects.toThrow('LLM API error: 429 - rate limited');
            expect(captured).toHaveLength(1);
        });

        it('maps a 5xx to the same error shape', async () => {
            handler = (_req, res) => { res.writeHead(503); res.end('upstream down'); };
            await expect(generateLLMResponse('s', 'u')).rejects.toThrow('LLM API error: 503 - upstream down');
        });

        it('includes an empty body without crashing', async () => {
            handler = (_req, res) => { res.writeHead(500); res.end(); };
            await expect(generateLLMResponse('s', 'u')).rejects.toThrow('LLM API error: 500 - ');
        });

        it('rejects on a network failure (connection refused)', async () => {
            // Bind then immediately release a port so nothing is listening on it.
            const probe = createServer();
            await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
            const deadPort = (probe.address() as AddressInfo).port;
            await new Promise<void>((r) => probe.close(() => r()));

            process.env.CLAUDIA_LLM_API_URL = `http://127.0.0.1:${deadPort}/v1/messages`;
            await expect(generateLLMResponse('s', 'u')).rejects.toThrow();
            expect(captured).toHaveLength(0);
        });

        it('aborts and rejects when the request exceeds timeoutMs', async () => {
            handler = (_req, res) => {
                // Never respond within the timeout window.
                setTimeout(() => { try { res.end('late'); } catch { /* socket gone */ } }, 2000).unref();
            };
            // 60ms was too tight: on a loaded machine the request had not yet
            // reached the server when the abort fired, so `captured` was empty
            // here AND the late arrival landed in the NEXT test's freshly-reset
            // `captured`, failing two tests at once. 750ms still aborts well
            // before the handler's 2000ms reply, but reliably gets the request
            // on the wire first.
            const err = await generateLLMResponse('s', 'u', { timeoutMs: 750 }).catch((e) => e);
            expect(err.name).toBe('AbortError');
            // The service branches on `error instanceof Error` to pick the
            // timeout-specific log line. Under vitest's vmThreads pool the
            // fetch rejection is a host-realm DOMException, so that instanceof
            // is realm-dependent here (it is true in plain Node). We therefore
            // assert only that the failure was logged under the [LLM] prefix.
            const stderr = (console.error as any).mock.calls
                .map((c: unknown[]) => String(c[0])).join('\n');
            expect(stderr).toContain('[LLM]');

            // Drain: make sure the server has fully booked the request before
            // this test ends, so it cannot leak into the next test's `captured`.
            const deadline = Date.now() + 5000;
            while (captured.length === 0 && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 20));
            }
            expect(captured).toHaveLength(1);
        });
    });

    describe('retry behaviour', () => {
        it('does NOT retry on 500 — exactly one request is issued', async () => {
            // Documents current behaviour: the service has no retry/backoff.
            handler = (_req, res) => { res.writeHead(500); res.end('boom'); };
            await expect(generateLLMResponse('s', 'u')).rejects.toThrow();
            expect(captured).toHaveLength(1);
        });

        it('does NOT retry on a malformed 200 body', async () => {
            handler = (_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ content: [] }));
            };
            await expect(generateLLMResponse('s', 'u')).rejects.toThrow();
            expect(captured).toHaveLength(1);
        });

        it('issues one request per call, with no request coalescing', async () => {
            await Promise.all([
                generateLLMResponse('s', 'a'),
                generateLLMResponse('s', 'b'),
                generateLLMResponse('s', 'c'),
            ]);
            expect(captured).toHaveLength(3);
        });
    });

    describe('secret hygiene', () => {
        const SENTINEL = 'sk-ant-api03-TEST-SENTINEL-NOT-A-REAL-KEY';

        it('never attaches an API key to the outbound request', async () => {
            process.env.ANTHROPIC_API_KEY = SENTINEL;
            await generateLLMResponse('sys', 'user');
            const h = captured[0].headers;
            expect(h['x-api-key']).toBeUndefined();
            expect(h['authorization']).toBeUndefined();
            expect(JSON.stringify(h)).not.toContain(SENTINEL);
            expect(captured[0].rawBody).not.toContain(SENTINEL);
        });

        it('never writes an API key to stdout/stderr on the success path', async () => {
            process.env.ANTHROPIC_API_KEY = SENTINEL;
            await generateLLMResponse('sys', 'user');
            const written = [
                ...(console.log as any).mock.calls,
                ...(console.error as any).mock.calls,
            ].map((c: unknown[]) => c.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')).join('\n');
            expect(written).not.toContain(SENTINEL);
        });

        it('never writes an API key to stdout/stderr on the error path', async () => {
            process.env.ANTHROPIC_API_KEY = SENTINEL;
            handler = (_req, res) => { res.writeHead(500); res.end('upstream failure'); };
            await expect(generateLLMResponse('sys', 'user')).rejects.toThrow();
            const written = [
                ...(console.log as any).mock.calls,
                ...(console.error as any).mock.calls,
            ].map((c: unknown[]) => c.map((a) => (typeof a === 'string' ? a : String(a))).join(' ')).join('\n');
            expect(written).not.toContain(SENTINEL);
        });

        it('never puts an API key into the thrown error or its serialization', async () => {
            process.env.ANTHROPIC_API_KEY = SENTINEL;
            handler = (_req, res) => { res.writeHead(403); res.end('forbidden'); };
            const err: Error = await generateLLMResponse('sys', 'user').then(
                () => { throw new Error('expected rejection'); },
                (e) => e as Error,
            );
            expect(err).toBeInstanceOf(Error);
            expect(err.message).not.toContain(SENTINEL);
            expect(String(err.stack)).not.toContain(SENTINEL);
        });
    });

    describe('prompt wrappers', () => {
        it('generatePlanResponse caps at 100 tokens and uses the orchestrator system prompt', async () => {
            await expect(generatePlanResponse('build a todo app')).resolves.toBe('hello world');
            expect(captured[0].body.max_tokens).toBe(100);
            expect(captured[0].body.system).toContain('AI orchestrator that manages coding tasks');
            expect(captured[0].body.messages[0].content).toBe('build a todo app');
        });

        it('generateConversationalResponse embeds the intent in the system prompt', async () => {
            await generateConversationalResponse('hi there', 'question');
            expect(captured[0].body.system).toContain('Their intent is: question');
            expect(captured[0].body.max_tokens).toBe(100);
            expect(captured[0].body.messages[0].content).toBe('hi there');
        });

        it.each(['question', 'conversation', 'clarification'] as const)(
            'generateConversationalResponse threads through intent "%s"',
            async (intent) => {
                await generateConversationalResponse('msg', intent);
                expect(captured[0].body.system).toContain(`Their intent is: ${intent}`);
            },
        );

        it('generateTaskCreatedResponse caps at 50 tokens and formats name + description', async () => {
            await generateTaskCreatedResponse('My Task', 'Does a thing');
            expect(captured[0].body.max_tokens).toBe(50);
            expect(captured[0].body.messages[0].content).toBe('Task: "My Task"\nDescription: Does a thing');
        });

        it('propagates failures out of the wrapper helpers', async () => {
            handler = (_req, res) => { res.writeHead(500); res.end('nope'); };
            await expect(generatePlanResponse('x')).rejects.toThrow('LLM API error: 500 - nope');
            await expect(generateConversationalResponse('x', 'question')).rejects.toThrow();
            await expect(generateTaskCreatedResponse('n', 'd')).rejects.toThrow();
        });
    });
});
