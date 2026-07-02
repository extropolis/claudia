import { describe, it, expect, vi } from 'vitest';
import {
    createTunnelAuthMiddleware,
    extractRequestToken,
    isTunnelHost,
    TUNNEL_PROTECTED_API_PREFIXES,
    type TunnelAuthRequest,
    type TunnelAuthResponse,
} from '../tunnel-auth.js';

function makeReq(overrides: Partial<TunnelAuthRequest> & { host?: string } = {}): TunnelAuthRequest {
    const { host, ...rest } = overrides;
    return {
        headers: { host: host ?? 'abc123.ngrok-free.app', ...(rest.headers ?? {}) },
        path: rest.path ?? '/api/mobile/chat',
        query: rest.query ?? {},
    };
}

function makeRes(): TunnelAuthResponse & { statusCode?: number; body?: unknown } {
    const res: TunnelAuthResponse & { statusCode?: number; body?: unknown } = {
        status(code: number) {
            res.statusCode = code;
            return res;
        },
        json(payload: unknown) {
            res.body = payload;
            return payload;
        },
    };
    return res;
}

const VALID = 'good-token';
// Middleware wired as it is in production while a public tunnel IS active:
// every protected-prefix request must carry a valid token, whatever Host it
// claims. The gate keys on isTunnelActive(), never on the Host header.
const middleware = createTunnelAuthMiddleware({
    validateToken: (t) => t === VALID,
    isTunnelActive: () => true,
});
// Middleware while NO tunnel is active: everything passes through (the server
// is only reachable over loopback, so there is nothing to protect).
const middlewareNoTunnel = createTunnelAuthMiddleware({
    validateToken: (t) => t === VALID,
    isTunnelActive: () => false,
});

describe('isTunnelHost', () => {
    it('matches ngrok and localtunnel hosts', () => {
        expect(isTunnelHost('abc.ngrok-free.app')).toBe(true);
        expect(isTunnelHost('foo.ngrok.io')).toBe(true);
        expect(isTunnelHost('bar.loca.lt')).toBe(true);
    });

    it('matches mixed/upper-case tunnel hosts (case-insensitive)', () => {
        expect(isTunnelHost('ABC.NGROK.IO')).toBe(true);
        expect(isTunnelHost('Foo.Ngrok-Free.App')).toBe(true);
        expect(isTunnelHost('BAR.LOCA.LT')).toBe(true);
    });

    it('does not match local hosts', () => {
        expect(isTunnelHost('localhost:4001')).toBe(false);
        expect(isTunnelHost('127.0.0.1:4001')).toBe(false);
        expect(isTunnelHost('')).toBe(false);
    });
});

describe('extractRequestToken', () => {
    it('reads the token query param', () => {
        expect(extractRequestToken(makeReq({ query: { token: 'q-tok' } }))).toBe('q-tok');
    });

    it('reads the X-Claudia-Token header', () => {
        expect(
            extractRequestToken(makeReq({ headers: { 'x-claudia-token': 'h-tok' } })),
        ).toBe('h-tok');
    });

    it('reads Authorization: Bearer', () => {
        expect(
            extractRequestToken(makeReq({ headers: { authorization: 'Bearer b-tok' } })),
        ).toBe('b-tok');
    });

    it('returns undefined when no token is present', () => {
        expect(extractRequestToken(makeReq())).toBeUndefined();
    });
});

describe('createTunnelAuthMiddleware', () => {
    it('rejects tunnel requests to /api/mobile/* without a token (401)', () => {
        const res = makeRes();
        const next = vi.fn();
        middleware(makeReq({ path: '/api/mobile/chat' }), res, next);
        expect(res.statusCode).toBe(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('rejects tunnel requests with an invalid token (401)', () => {
        const res = makeRes();
        const next = vi.fn();
        middleware(makeReq({ query: { token: 'wrong' } }), res, next);
        expect(res.statusCode).toBe(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('allows tunnel requests with a valid token (query param)', () => {
        const res = makeRes();
        const next = vi.fn();
        middleware(makeReq({ query: { token: VALID } }), res, next);
        expect(res.statusCode).toBeUndefined();
        expect(next).toHaveBeenCalledOnce();
    });

    it('allows tunnel requests with a valid token (X-Claudia-Token header)', () => {
        const res = makeRes();
        const next = vi.fn();
        middleware(makeReq({ headers: { 'x-claudia-token': VALID } }), res, next);
        expect(next).toHaveBeenCalledOnce();
    });

    it('allows tunnel requests with a valid token (Authorization: Bearer)', () => {
        const res = makeRes();
        const next = vi.fn();
        middleware(makeReq({ headers: { authorization: `Bearer ${VALID}` } }), res, next);
        expect(next).toHaveBeenCalledOnce();
    });

    it('protects /api/voice/* over the tunnel', () => {
        const res = makeRes();
        const next = vi.fn();
        middleware(makeReq({ path: '/api/voice/deepgram-token' }), res, next);
        expect(res.statusCode).toBe(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('does not gate unprotected API paths over the tunnel', () => {
        const res = makeRes();
        const next = vi.fn();
        middleware(makeReq({ path: '/api/health' }), res, next);
        expect(next).toHaveBeenCalledOnce();
    });

    it('gates /api/voice-agent/* over the tunnel (persisted system prompt)', () => {
        for (const path of ['/api/voice-agent/system-prompt', '/api/voice-agent/tools']) {
            const res = makeRes();
            const next = vi.fn();
            middleware(makeReq({ path }), res, next);
            expect(res.statusCode, path).toBe(401);
            expect(next, path).not.toHaveBeenCalled();
        }
    });

    it('still allows /api/voice-agent/* with a valid token', () => {
        const res = makeRes();
        const next = vi.fn();
        middleware(makeReq({ path: '/api/voice-agent/system-prompt', query: { token: VALID } }), res, next);
        expect(res.statusCode).toBeUndefined();
        expect(next).toHaveBeenCalledOnce();
    });

    it('does not confuse /api/voice/ with /api/voice-agent/ boundaries', () => {
        // Both are protected, but via distinct prefixes; a path that is neither
        // (e.g. /api/voiceless) must still pass through.
        const res = makeRes();
        const next = vi.fn();
        middleware(makeReq({ path: '/api/voiceless/ping' }), res, next);
        expect(next).toHaveBeenCalledOnce();
    });

    it('gates mixed-CASE protected paths (case-insensitive routing bypass)', () => {
        // Express matches routes case-insensitively, so these reach the real
        // handler. A case-sensitive prefix check would wrongly let them
        // through unauthenticated. Every variant must be gated (401, no next()).
        const bypassPaths = [
            '/API/MOBILE/chat',
            '/Api/Mobile/Chat',
            '/api/voice/DEEPGRAM-TOKEN',
            '/API/VOICE/deepgram-token',
            '/API/VOICE-AGENT/system-prompt',
        ];
        for (const path of bypassPaths) {
            const res = makeRes();
            const next = vi.fn();
            middleware(makeReq({ path }), res, next);
            expect(res.statusCode, path).toBe(401);
            expect(next, path).not.toHaveBeenCalled();
        }
    });

    it('covers exactly the mobile, voice, and voice-agent API prefixes (all lowercase)', () => {
        expect(TUNNEL_PROTECTED_API_PREFIXES).toEqual([
            '/api/mobile/',
            '/api/voice/',
            '/api/voice-agent/',
        ]);
        for (const p of TUNNEL_PROTECTED_API_PREFIXES) {
            expect(p, p).toBe(p.toLowerCase());
        }
    });

    // ===== Host-spoofing regression =====
    // ngrok/localtunnel forward the client-supplied Host header verbatim, so an
    // attacker hitting the public URL can claim ANY Host. While the tunnel is
    // active, NONE of these may skip the token check on a protected prefix.
    describe('does not let a spoofed Host bypass the gate while the tunnel is active', () => {
        const spoofedHosts: Array<string | undefined> = [
            'ABC.NGROK.IO',        // uppercased real tunnel host
            'localhost',           // pretend to be local
            'localhost:4001',
            '127.0.0.1',
            'evil.com',            // arbitrary attacker host
            '',                    // empty Host
            undefined,             // missing Host header
        ];

        for (const host of spoofedHosts) {
            const label = host === undefined ? '(missing Host)' : host === '' ? '(empty Host)' : host;

            it(`401s ${label} with no token`, () => {
                const res = makeRes();
                const next = vi.fn();
                const headers: Record<string, string> = {};
                if (host !== undefined) headers.host = host;
                middleware({ headers, path: '/api/mobile/chat', query: {} }, res, next);
                expect(res.statusCode, label).toBe(401);
                expect(next, label).not.toHaveBeenCalled();
            });

            it(`401s ${label} with an invalid token`, () => {
                const res = makeRes();
                const next = vi.fn();
                const headers: Record<string, string> = {};
                if (host !== undefined) headers.host = host;
                middleware({ headers, path: '/api/mobile/chat', query: { token: 'wrong' } }, res, next);
                expect(res.statusCode, label).toBe(401);
                expect(next, label).not.toHaveBeenCalled();
            });

            it(`allows ${label} once it presents a VALID token`, () => {
                const res = makeRes();
                const next = vi.fn();
                const headers: Record<string, string> = {};
                if (host !== undefined) headers.host = host;
                middleware({ headers, path: '/api/mobile/chat', query: { token: VALID } }, res, next);
                expect(res.statusCode, label).toBeUndefined();
                expect(next, label).toHaveBeenCalledOnce();
            });
        }
    });

    // ===== No tunnel active =====
    // With no public tunnel the server is only reachable over loopback, so the
    // protected endpoints pass through untouched regardless of Host or token —
    // this is what keeps the local desktop UI working.
    describe('passes local (non-tunnel-Host) requests through when no tunnel is active', () => {
        // With no tunnel active AND a non-tunnel Host, the server is only
        // reachable over loopback, so there is nothing to protect.
        const hosts = ['localhost:4001', '127.0.0.1', 'evil.com', ''];
        for (const host of hosts) {
            it(`allows /api/mobile/chat with no token (host: ${host || '(empty)'})`, () => {
                const res = makeRes();
                const next = vi.fn();
                middlewareNoTunnel({ headers: { host }, path: '/api/mobile/chat', query: {} }, res, next);
                expect(res.statusCode, host).toBeUndefined();
                expect(next, host).toHaveBeenCalledOnce();
            });
        }
    });

    describe('gates a tunnel-looking Host even when isTunnelActive() is false (externally-started tunnel)', () => {
        // Belt-and-suspenders: if an operator exposes the server via a tunnel the
        // app did not create, getStatus().active is false, but the recognized
        // tunnel Host must still trip the gate rather than fail open.
        const tunnelHosts = ['abc.ngrok.io', 'ABC.NGROK.IO', 'foo.ngrok-free.app', 'bar.loca.lt'];
        for (const host of tunnelHosts) {
            it(`401s /api/mobile/chat with no token (host: ${host})`, () => {
                const res = makeRes();
                const next = vi.fn();
                middlewareNoTunnel({ headers: { host }, path: '/api/mobile/chat', query: {} }, res, next);
                expect(res.statusCode, host).toBe(401);
                expect(next, host).not.toHaveBeenCalled();
            });
            it(`allows /api/mobile/chat with a valid token (host: ${host})`, () => {
                const res = makeRes();
                const next = vi.fn();
                middlewareNoTunnel({ headers: { host }, path: '/api/mobile/chat', query: { token: VALID } }, res, next);
                expect(res.statusCode, host).toBeUndefined();
                expect(next, host).toHaveBeenCalledOnce();
            });
        }
    });

    // ===== Local desktop / mobile app happy paths (tunnel active) =====
    // The local desktop voice page and the mobile app both attach the real
    // tunnel token (query param, X-Claudia-Token, or Authorization: Bearer),
    // so they keep working while the tunnel is active — regardless of Host.
    describe('legitimate tunnel-token flows still pass while the tunnel is active', () => {
        it('mobile app POST with token query param', () => {
            const res = makeRes();
            const next = vi.fn();
            middleware(makeReq({ host: 'abc.ngrok-free.app', path: '/api/mobile/chat', query: { token: VALID } }), res, next);
            expect(next).toHaveBeenCalledOnce();
        });

        it('desktop voice page GET with X-Claudia-Token header and localhost Host', () => {
            const res = makeRes();
            const next = vi.fn();
            middleware({ headers: { host: 'localhost:4001', 'x-claudia-token': VALID }, path: '/api/voice/deepgram-token', query: {} }, res, next);
            expect(res.statusCode).toBeUndefined();
            expect(next).toHaveBeenCalledOnce();
        });

        it('Authorization: Bearer with an arbitrary Host', () => {
            const res = makeRes();
            const next = vi.fn();
            middleware({ headers: { host: 'whatever.example', authorization: `Bearer ${VALID}` }, path: '/api/voice-agent/system-prompt', query: {} }, res, next);
            expect(next).toHaveBeenCalledOnce();
        });
    });
});
