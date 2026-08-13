import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { setUserId, getUserId, reportUsage } from '../usage-reporter.js';

// Note: USAGE_DASHBOARD_URL is read at module-load time. In the test environment
// it is unset, so reportUsage is always a no-op (it never reaches fetch). These
// tests verify that contract: user-id state management plus the safe no-op path.

describe('usage-reporter', () => {
    let fetchSpy: any;

    beforeEach(() => {
        // Spy on fetch so we can assert it is never called when reporting is disabled.
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ ok: true, event_id: 1 }), { status: 200 }),
        );
    });

    afterEach(() => {
        fetchSpy.mockRestore();
    });

    describe('user id management', () => {
        it('starts null until a user id is set in this test ordering', () => {
            // getUserId reflects module-level state; we set it then read it back.
            setUserId('user-123');
            expect(getUserId()).toBe('user-123');
        });

        it('overwrites a previously set user id', () => {
            setUserId('first');
            expect(getUserId()).toBe('first');
            setUserId('second');
            expect(getUserId()).toBe('second');
        });
    });

    describe('reportUsage (dashboard disabled)', () => {
        it('resolves without throwing when no user id is set', async () => {
            // We cannot truly clear the id (no setter to null via public API in a
            // clean way), but with no dashboard URL it is a no-op regardless.
            await expect(
                reportUsage({ tokensInput: 100, tokensOutput: 50, model: 'sonnet' }),
            ).resolves.toBeUndefined();
        });

        it('does not call fetch when the dashboard URL is not configured', async () => {
            setUserId('user-xyz');
            await reportUsage({ tokensInput: 1000, tokensOutput: 200, model: 'opus' });
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it('handles zero usage without throwing', async () => {
            setUserId('user-zero');
            await expect(
                reportUsage({ tokensInput: 0, tokensOutput: 0, model: 'haiku' }),
            ).resolves.toBeUndefined();
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it('handles large token counts without throwing', async () => {
            setUserId('user-big');
            await expect(
                reportUsage({ tokensInput: 9_999_999, tokensOutput: 5_000_000, model: 'opus' }),
            ).resolves.toBeUndefined();
        });

        it('is safe to fire-and-forget multiple times', async () => {
            setUserId('user-multi');
            await Promise.all([
                reportUsage({ tokensInput: 1, tokensOutput: 1, model: 'a' }),
                reportUsage({ tokensInput: 2, tokensOutput: 2, model: 'b' }),
                reportUsage({ tokensInput: 3, tokensOutput: 3, model: 'c' }),
            ]);
            expect(fetchSpy).not.toHaveBeenCalled();
        });
    });
});

/**
 * The enabled path. USAGE_DASHBOARD_URL is captured at module-load time, so we
 * set it and re-import the module with vi.resetModules() to get a fresh copy
 * whose constant is bound to a REAL local http server on an EPHEMERAL port
 * (never 4001/5173). This exercises real fetch + real request construction.
 */
describe('usage-reporter (dashboard enabled)', () => {
    interface Captured { method: string; url: string; headers: Record<string, any>; body: any; rawBody: string }

    let server: Server;
    let dashboardUrl: string;
    let captured: Captured[] = [];
    let handler: (req: IncomingMessage, res: ServerResponse) => void;

    const okHandler = (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, event_id: 4242 }));
    };

    beforeAll(async () => {
        server = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (c) => chunks.push(c as Buffer));
            req.on('end', () => {
                const rawBody = Buffer.concat(chunks).toString('utf-8');
                let parsed: any;
                try { parsed = JSON.parse(rawBody); } catch { parsed = undefined; }
                captured.push({ method: req.method!, url: req.url!, headers: req.headers, body: parsed, rawBody });
                handler(req, res);
            });
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        dashboardUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ingest`;
    });

    afterAll(async () => {
        await new Promise<void>((r) => server.close(() => r()));
    });

    let originalUrl: string | undefined;
    let mod: typeof import('../usage-reporter.js');

    beforeEach(async () => {
        originalUrl = process.env.USAGE_DASHBOARD_URL;
        process.env.USAGE_DASHBOARD_URL = dashboardUrl;
        captured = [];
        handler = okHandler;
        vi.resetModules();
        mod = await import('../usage-reporter.js');
        vi.spyOn(console, 'log').mockImplementation(() => { });
        vi.spyOn(console, 'warn').mockImplementation(() => { });
    });

    afterEach(() => {
        if (originalUrl === undefined) delete process.env.USAGE_DASHBOARD_URL;
        else process.env.USAGE_DASHBOARD_URL = originalUrl;
        vi.restoreAllMocks();
    });

    describe('gating', () => {
        it('does not POST when no user id has been registered', async () => {
            await mod.reportUsage({ tokensInput: 5, tokensOutput: 5, model: 'sonnet' });
            expect(captured).toHaveLength(0);
        });

        it('starts with a null user id in a freshly loaded module', () => {
            expect(mod.getUserId()).toBeNull();
        });

        it('POSTs once a user id is registered', async () => {
            mod.setUserId('u-1');
            await mod.reportUsage({ tokensInput: 5, tokensOutput: 5, model: 'sonnet' });
            expect(captured).toHaveLength(1);
        });

        it('does not POST when the user id is set to the empty string (falsy)', async () => {
            mod.setUserId('');
            await mod.reportUsage({ tokensInput: 5, tokensOutput: 5, model: 'sonnet' });
            expect(captured).toHaveLength(0);
        });
    });

    describe('request construction', () => {
        it('POSTs JSON to the configured dashboard URL', async () => {
            mod.setUserId('u-2');
            await mod.reportUsage({ tokensInput: 10, tokensOutput: 20, model: 'opus' });
            expect(captured[0].method).toBe('POST');
            expect(captured[0].url).toBe('/ingest');
            expect(captured[0].headers['content-type']).toBe('application/json');
        });

        it('sends the full documented event body', async () => {
            mod.setUserId('u-3');
            await mod.reportUsage({ tokensInput: 111, tokensOutput: 222, model: 'claude-sonnet-4-5' });
            expect(captured[0].body).toEqual({
                user_id: 'u-3',
                tokens_input: 111,
                tokens_output: 222,
                model: 'claude-sonnet-4-5',
                version: '1.0.0',
                event_type: 'session_end',
            });
        });

        it('uses the most recently registered user id', async () => {
            mod.setUserId('first');
            mod.setUserId('second');
            await mod.reportUsage({ tokensInput: 1, tokensOutput: 1, model: 'm' });
            expect(captured[0].body.user_id).toBe('second');
        });

        it('emits one independent event per call (no batching or rollup)', async () => {
            mod.setUserId('u-4');
            await mod.reportUsage({ tokensInput: 1, tokensOutput: 2, model: 'a' });
            await mod.reportUsage({ tokensInput: 3, tokensOutput: 4, model: 'b' });
            expect(captured).toHaveLength(2);
            expect(captured.map((c) => [c.body.tokens_input, c.body.tokens_output, c.body.model]))
                .toEqual([[1, 2, 'a'], [3, 4, 'b']]);
        });

        it('reports concurrent fire-and-forget calls without dropping any', async () => {
            mod.setUserId('u-5');
            await Promise.all([1, 2, 3, 4, 5].map((n) =>
                mod.reportUsage({ tokensInput: n, tokensOutput: n * 10, model: `m${n}` })));
            expect(captured).toHaveLength(5);
            expect(captured.map((c) => c.body.tokens_input).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
        });
    });

    describe('boundary and malformed inputs', () => {
        it('reports a zero-token event rather than skipping it', async () => {
            mod.setUserId('u-zero');
            await mod.reportUsage({ tokensInput: 0, tokensOutput: 0, model: 'haiku' });
            expect(captured).toHaveLength(1);
            expect(captured[0].body.tokens_input).toBe(0);
        });

        it('passes negative counts through unvalidated', async () => {
            // Documents the absence of input validation at this layer.
            mod.setUserId('u-neg');
            await mod.reportUsage({ tokensInput: -1, tokensOutput: -2, model: 'm' });
            expect(captured[0].body).toMatchObject({ tokens_input: -1, tokens_output: -2 });
        });

        it('handles very large counts without loss below MAX_SAFE_INTEGER', async () => {
            mod.setUserId('u-big');
            await mod.reportUsage({ tokensInput: 9_007_199_254_740_991, tokensOutput: 1, model: 'm' });
            expect(captured[0].body.tokens_input).toBe(9_007_199_254_740_991);
        });

        it('serializes NaN and Infinity as null (JSON.stringify semantics)', async () => {
            mod.setUserId('u-nan');
            await mod.reportUsage({ tokensInput: NaN, tokensOutput: Infinity, model: 'm' });
            expect(captured[0].body.tokens_input).toBeNull();
            expect(captured[0].body.tokens_output).toBeNull();
        });

        it('handles fractional token counts', async () => {
            mod.setUserId('u-frac');
            await mod.reportUsage({ tokensInput: 1.5, tokensOutput: 2.25, model: 'm' });
            expect(captured[0].body).toMatchObject({ tokens_input: 1.5, tokens_output: 2.25 });
        });

        it('handles an empty model string', async () => {
            mod.setUserId('u-empty-model');
            await mod.reportUsage({ tokensInput: 1, tokensOutput: 1, model: '' });
            expect(captured[0].body.model).toBe('');
        });

        it('escapes user ids and model names containing JSON-hostile characters', async () => {
            mod.setUserId('user "quoted"\n\\slash');
            await mod.reportUsage({ tokensInput: 1, tokensOutput: 1, model: 'model\t<tab>' });
            expect(captured[0].body.user_id).toBe('user "quoted"\n\\slash');
            expect(captured[0].body.model).toBe('model\t<tab>');
        });

        it('handles unicode in the model name', async () => {
            mod.setUserId('u-uni');
            await mod.reportUsage({ tokensInput: 1, tokensOutput: 1, model: 'модель-🚀' });
            expect(captured[0].body.model).toBe('модель-🚀');
        });
    });

    describe('response handling — never throws to the caller', () => {
        it('logs the returned event_id on success', async () => {
            mod.setUserId('u-ok');
            await expect(mod.reportUsage({ tokensInput: 1, tokensOutput: 1, model: 'm' })).resolves.toBeUndefined();
            expect(console.log).toHaveBeenCalledWith('[UsageReporter] Usage reported — event_id=4242');
        });

        it('swallows a 4xx and warns', async () => {
            handler = (_req, res) => { res.writeHead(400); res.end('bad payload'); };
            mod.setUserId('u-400');
            await expect(mod.reportUsage({ tokensInput: 1, tokensOutput: 1, model: 'm' })).resolves.toBeUndefined();
            expect(console.warn).toHaveBeenCalledWith('[UsageReporter] Report failed: 400 — bad payload');
        });

        it('swallows a 5xx and warns', async () => {
            handler = (_req, res) => { res.writeHead(503); res.end('unavailable'); };
            mod.setUserId('u-503');
            await expect(mod.reportUsage({ tokensInput: 1, tokensOutput: 1, model: 'm' })).resolves.toBeUndefined();
            expect(console.warn).toHaveBeenCalledWith('[UsageReporter] Report failed: 503 — unavailable');
        });

        it('swallows a 200 whose body is not JSON', async () => {
            handler = (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('<html>'); };
            mod.setUserId('u-badjson');
            await expect(mod.reportUsage({ tokensInput: 1, tokensOutput: 1, model: 'm' })).resolves.toBeUndefined();
            expect(console.warn).toHaveBeenCalled();
        });

        it('tolerates a 200 JSON body missing event_id', async () => {
            handler = (_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            };
            mod.setUserId('u-noid');
            await expect(mod.reportUsage({ tokensInput: 1, tokensOutput: 1, model: 'm' })).resolves.toBeUndefined();
            expect(console.log).toHaveBeenCalledWith('[UsageReporter] Usage reported — event_id=undefined');
        });

        it('swallows a network failure (connection refused) and warns', async () => {
            const probe = createServer();
            await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
            const deadPort = (probe.address() as AddressInfo).port;
            await new Promise<void>((r) => probe.close(() => r()));

            process.env.USAGE_DASHBOARD_URL = `http://127.0.0.1:${deadPort}/ingest`;
            vi.resetModules();
            const dead = await import('../usage-reporter.js');
            dead.setUserId('u-dead');

            await expect(dead.reportUsage({ tokensInput: 1, tokensOutput: 1, model: 'm' })).resolves.toBeUndefined();
            expect(console.warn).toHaveBeenCalledWith(
                '[UsageReporter] Network error, skipping usage report:',
                expect.anything(),
            );
        });

        it('does not retry a failed report', async () => {
            handler = (_req, res) => { res.writeHead(500); res.end('boom'); };
            mod.setUserId('u-noretry');
            await mod.reportUsage({ tokensInput: 1, tokensOutput: 1, model: 'm' });
            expect(captured).toHaveLength(1);
        });
    });
});
