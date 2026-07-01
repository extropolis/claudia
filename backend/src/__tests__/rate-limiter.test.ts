import { describe, it, expect, vi } from 'vitest';
import {
    createRateLimiter,
    type RateLimitRequest,
    type RateLimitResponse,
} from '../rate-limiter.js';

function makeRes(): RateLimitResponse & { statusCode?: number; body?: unknown; headers: Record<string, string> } {
    const res: RateLimitResponse & { statusCode?: number; body?: unknown; headers: Record<string, string> } = {
        headers: {},
        status(code: number) {
            res.statusCode = code;
            return res;
        },
        json(payload: unknown) {
            res.body = payload;
            return payload;
        },
        setHeader(name: string, value: string) {
            res.headers[name] = value;
        },
    };
    return res;
}

function run(
    limiter: ReturnType<typeof createRateLimiter>,
    req: RateLimitRequest,
): { passed: boolean; statusCode?: number; retryAfter?: string } {
    const res = makeRes();
    const next = vi.fn();
    limiter(req, res, next);
    return {
        passed: next.mock.calls.length === 1,
        statusCode: res.statusCode,
        retryAfter: res.headers['Retry-After'],
    };
}

describe('createRateLimiter', () => {
    it('allows up to max requests per window, then returns 429', () => {
        const limiter = createRateLimiter({ windowMs: 60_000, max: 3, now: () => 1000 });
        const req: RateLimitRequest = { body: { deviceId: 'phone-1' } };
        expect(run(limiter, req).passed).toBe(true);
        expect(run(limiter, req).passed).toBe(true);
        expect(run(limiter, req).passed).toBe(true);
        const fourth = run(limiter, req);
        expect(fourth.passed).toBe(false);
        expect(fourth.statusCode).toBe(429);
        expect(fourth.retryAfter).toBeDefined();
    });

    it('resets the window after windowMs elapses', () => {
        let t = 1000;
        const limiter = createRateLimiter({ windowMs: 10_000, max: 1, now: () => t });
        const req: RateLimitRequest = { body: { deviceId: 'phone-1' } };
        expect(run(limiter, req).passed).toBe(true);
        expect(run(limiter, req).statusCode).toBe(429);
        t += 10_000; // window elapsed
        expect(run(limiter, req).passed).toBe(true);
    });

    it('tracks distinct deviceIds independently', () => {
        const limiter = createRateLimiter({ windowMs: 60_000, max: 1, now: () => 1000 });
        expect(run(limiter, { body: { deviceId: 'a' } }).passed).toBe(true);
        expect(run(limiter, { body: { deviceId: 'b' } }).passed).toBe(true);
        expect(run(limiter, { body: { deviceId: 'a' } }).statusCode).toBe(429);
    });

    it('falls back to IP when no deviceId is present', () => {
        const limiter = createRateLimiter({ windowMs: 60_000, max: 1, now: () => 1000 });
        expect(run(limiter, { ip: '1.2.3.4' }).passed).toBe(true);
        expect(run(limiter, { ip: '1.2.3.4' }).statusCode).toBe(429);
        expect(run(limiter, { ip: '5.6.7.8' }).passed).toBe(true);
    });

    it('keys deviceId and bare-IP requests separately', () => {
        const limiter = createRateLimiter({ windowMs: 60_000, max: 1, now: () => 1000 });
        expect(run(limiter, { body: { deviceId: 'a' }, ip: '1.2.3.4' }).passed).toBe(true);
        // Same IP but no deviceId → separate bucket
        expect(run(limiter, { ip: '1.2.3.4' }).passed).toBe(true);
    });
});
