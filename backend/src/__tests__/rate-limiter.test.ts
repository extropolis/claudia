import { describe, it, expect, vi } from 'vitest';
import {
    createRateLimiter,
    MAX_TRACKED_KEYS,
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
        const req: RateLimitRequest = { ip: '1.2.3.4' };
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
        const req: RateLimitRequest = { ip: '1.2.3.4' };
        expect(run(limiter, req).passed).toBe(true);
        expect(run(limiter, req).statusCode).toBe(429);
        t += 10_000; // window elapsed
        expect(run(limiter, req).passed).toBe(true);
    });

    it('tracks distinct IPs independently', () => {
        const limiter = createRateLimiter({ windowMs: 60_000, max: 1, now: () => 1000 });
        expect(run(limiter, { ip: '1.2.3.4' }).passed).toBe(true);
        expect(run(limiter, { ip: '5.6.7.8' }).passed).toBe(true);
        expect(run(limiter, { ip: '1.2.3.4' }).statusCode).toBe(429);
    });

    it('does NOT key on attacker-controlled deviceId: rotating deviceIds from one IP is still limited', () => {
        // Security regression: a client rotating a random deviceId per request
        // used to get a fresh bucket each time (unlimited spend). Now the key
        // is the IP, so 100 distinct deviceIds from one IP share one bucket.
        const limiter = createRateLimiter({ windowMs: 60_000, max: 5, now: () => 1000 });
        let allowed = 0;
        for (let i = 0; i < 100; i++) {
            const r = run(limiter, { ip: '9.9.9.9', body: { deviceId: `rand-${i}` } });
            if (r.passed) allowed++;
        }
        expect(allowed).toBe(5); // only `max` got through, regardless of deviceId churn
    });

    it('keeps the tracking map bounded under a flood of distinct fresh IPs', () => {
        // A flood of distinct, unexpired keys must not grow the map without
        // bound (memory DoS). The hard cap is MAX_TRACKED_KEYS; the limiter
        // evicts oldest entries once over the cap.
        const limiter = createRateLimiter({ windowMs: 60_000, max: 1, now: () => 1000 });
        for (let i = 0; i < 10_000; i++) {
            run(limiter, { ip: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}` });
        }
        // Bounded near the cap (prune runs before each insert, so the count
        // can transiently sit at MAX_TRACKED_KEYS + 1), NOT growing to 10k.
        expect(limiter.trackedKeyCount()).toBeLessThanOrEqual(MAX_TRACKED_KEYS + 1);
        // Still functional after the flood.
        expect(run(limiter, { ip: 'fresh-after-flood' }).passed).toBe(true);
    });
});
