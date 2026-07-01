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
const middleware = createTunnelAuthMiddleware({
    validateToken: (t) => t === VALID,
});

describe('isTunnelHost', () => {
    it('matches ngrok and localtunnel hosts', () => {
        expect(isTunnelHost('abc.ngrok-free.app')).toBe(true);
        expect(isTunnelHost('foo.ngrok.io')).toBe(true);
        expect(isTunnelHost('bar.loca.lt')).toBe(true);
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

    it('leaves local (non-tunnel) requests unchanged, even without a token', () => {
        const res = makeRes();
        const next = vi.fn();
        middleware(makeReq({ host: 'localhost:4001', path: '/api/mobile/chat' }), res, next);
        expect(res.statusCode).toBeUndefined();
        expect(next).toHaveBeenCalledOnce();
    });

    it('does not gate unprotected API paths over the tunnel', () => {
        const res = makeRes();
        const next = vi.fn();
        middleware(makeReq({ path: '/api/health' }), res, next);
        expect(next).toHaveBeenCalledOnce();
    });

    it('does not accidentally match /api/voice-agent/* (own token handling)', () => {
        const res = makeRes();
        const next = vi.fn();
        middleware(makeReq({ path: '/api/voice-agent/tools' }), res, next);
        expect(next).toHaveBeenCalledOnce();
    });

    it('covers exactly the mobile and voice API prefixes', () => {
        expect(TUNNEL_PROTECTED_API_PREFIXES).toEqual(['/api/mobile/', '/api/voice/']);
    });
});
