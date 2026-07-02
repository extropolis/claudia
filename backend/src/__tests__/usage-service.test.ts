import { describe, it, expect, vi } from 'vitest';
import { UsageService, type UsageFetch } from '../usage-service';

const OK_BODY = {
    five_hour: { utilization: 45, resets_at: '2026-07-02T20:30:00Z' },
    seven_day: { utilization: 31, resets_at: '2026-07-08T15:00:00Z' },
};

function makeClock(startMs = 1_000_000) {
    const clock = { ms: startMs };
    return { now: () => clock.ms, advanceSeconds: (s: number) => (clock.ms += s * 1000), clock };
}

function scriptedFetch(responses: Array<{ status: number; body?: unknown }>) {
    let i = 0;
    const impl: UsageFetch = async () => {
        const r = responses[Math.min(i, responses.length - 1)];
        i++;
        return { status: r.status, json: async () => r.body ?? {} };
    };
    return vi.fn(impl);
}

const creds = async () => ({ accessToken: 'tok', subscriptionType: 'max' });
const version = async () => 'claude-code/2.1.198';

describe('UsageService', () => {
    it('fetches on cold call, then serves the same cached object within TTL', async () => {
        const { now } = makeClock();
        const fetchImpl = scriptedFetch([{ status: 200, body: OK_BODY }]);
        const svc = new UsageService({ fetchImpl, readCreds: creds, detectVersion: version, now });

        const first = await svc.getUsage();
        expect(first.unavailable).toBeUndefined();
        expect(first.stale).toBeFalsy();
        expect(first.fiveHour.utilization).toBe(45);
        expect(first.planLabel).toBe('Max (20x)');
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        const second = await svc.getUsage();
        expect(second).toBe(first); // same reference, no refetch
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('sends the required headers on the fetch', async () => {
        const { now } = makeClock();
        const fetchImpl = scriptedFetch([{ status: 200, body: OK_BODY }]);
        const svc = new UsageService({ fetchImpl, readCreds: creds, detectVersion: version, now });
        await svc.getUsage();
        const init = fetchImpl.mock.calls[0][1];
        const headers = init.headers;
        expect(headers['Authorization']).toBe('Bearer tok');
        expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
        expect(headers['User-Agent']).toBe('claude-code/2.1.198');
        expect(headers['Content-Type']).toBe('application/json');
    });

    it('on 429 with prior cache serves last-good stale and does not refetch during backoff', async () => {
        const { now, advanceSeconds } = makeClock();
        const fetchImpl = scriptedFetch([
            { status: 200, body: OK_BODY },
            { status: 429 },
        ]);
        const svc = new UsageService({ fetchImpl, readCreds: creds, detectVersion: version, now });

        const good = await svc.getUsage();
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        // advance past TTL so a refresh is attempted; it 429s
        advanceSeconds(400);
        const stale = await svc.getUsage();
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(stale.stale).toBe(true);
        expect(stale.fiveHour.utilization).toBe(good.fiveHour.utilization);

        // within the backoff window (300s) no further fetch happens
        advanceSeconds(100);
        await svc.getUsage();
        expect(fetchImpl).toHaveBeenCalledTimes(2);

        // after backoff elapses a fetch is allowed again
        advanceSeconds(300);
        await svc.getUsage();
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it('on 429 with no prior cache reports unavailable rate_limited', async () => {
        const { now } = makeClock();
        const fetchImpl = scriptedFetch([{ status: 429 }]);
        const svc = new UsageService({ fetchImpl, readCreds: creds, detectVersion: version, now });
        const u = await svc.getUsage();
        expect(u.unavailable).toBe(true);
        expect(u.reason).toBe('rate_limited');
        // subsequent immediate call must not refetch during backoff
        await svc.getUsage();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('reports no_token and never fetches when credentials are missing', async () => {
        const { now } = makeClock();
        const fetchImpl = scriptedFetch([{ status: 200, body: OK_BODY }]);
        const svc = new UsageService({
            fetchImpl,
            readCreds: async () => null,
            detectVersion: version,
            now,
        });
        const u = await svc.getUsage();
        expect(u.unavailable).toBe(true);
        expect(u.reason).toBe('no_token');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('reports auth on 401', async () => {
        const { now } = makeClock();
        const fetchImpl = scriptedFetch([{ status: 401 }]);
        const svc = new UsageService({ fetchImpl, readCreds: creds, detectVersion: version, now });
        const u = await svc.getUsage();
        expect(u.unavailable).toBe(true);
        expect(u.reason).toBe('auth');
    });

    it('forceRefresh bypasses the TTL cache', async () => {
        const { now } = makeClock();
        const fetchImpl = scriptedFetch([
            { status: 200, body: OK_BODY },
            { status: 200, body: { ...OK_BODY, five_hour: { utilization: 60, resets_at: 'x' } } },
        ]);
        const svc = new UsageService({ fetchImpl, readCreds: creds, detectVersion: version, now });
        await svc.getUsage();
        const refreshed = await svc.getUsage(true);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(refreshed.fiveHour.utilization).toBe(60);
    });

    it('startPolling skips fetching while there are no clients', async () => {
        vi.useFakeTimers();
        try {
            const { now } = makeClock();
            const fetchImpl = scriptedFetch([{ status: 200, body: OK_BODY }]);
            const svc = new UsageService({ fetchImpl, readCreds: creds, detectVersion: version, now });
            svc.startPolling(() => false);
            await vi.advanceTimersByTimeAsync(700_000);
            expect(fetchImpl).not.toHaveBeenCalled();
            svc.stopPolling();
        } finally {
            vi.useRealTimers();
        }
    });
});
