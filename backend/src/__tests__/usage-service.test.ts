import { describe, it, expect, vi } from 'vitest';
import { UsageService, type UsageFetch } from '../usage-service.js';

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
        expect(first.planLabel).toBe('Max');
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        const second = await svc.getUsage();
        expect(second).toBe(first); // same reference, no refetch
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('coalesces concurrent callers in the same tick onto a single fetch', async () => {
        const { now } = makeClock();
        const fetchImpl = scriptedFetch([{ status: 200, body: OK_BODY }]);
        // readCreds yields (awaits a resolved promise) to widen the async gap,
        // mimicking the macOS keychain shell-out that exposed the coalescing bug.
        const yieldingCreds = async () => {
            await Promise.resolve();
            return { accessToken: 'tok', subscriptionType: 'max' };
        };
        const svc = new UsageService({
            fetchImpl,
            readCreds: yieldingCreds,
            detectVersion: version,
            now,
        });

        // Both calls start in the same tick, before either awaits creds/fetch.
        const [a, b] = await Promise.all([svc.getUsage(), svc.getUsage()]);

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(a).toBe(b);
        expect(a.fiveHour.utilization).toBe(45);
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
    // ---------------------------------------------------------------------
    // Rate-limit discipline. This service holds a live Anthropic credential
    // and talks to an endpoint with no published quota; a tight loop here is
    // the kind of bug that gets an account limited. Each rule gets a test.
    // ---------------------------------------------------------------------

    it('escalates the 429 backoff 5 → 10 → 20 → 30 min and then caps, never tight-looping', async () => {
        const { now, advanceSeconds } = makeClock();
        const fetchImpl = scriptedFetch([{ status: 429 }]); // 429s forever
        const svc = new UsageService({ fetchImpl, readCreds: creds, detectVersion: version, now });

        // Each entry: minutes to wait before the next fetch is allowed.
        const expectedWindowsMin = [5, 10, 20, 30, 30, 30];
        let calls = 0;

        for (const windowMin of expectedWindowsMin) {
            await svc.getUsage();
            calls++;
            expect(fetchImpl).toHaveBeenCalledTimes(calls);

            // One second before the window closes: still gated, no fetch.
            advanceSeconds(windowMin * 60 - 1);
            await svc.getUsage();
            expect(fetchImpl).toHaveBeenCalledTimes(calls);

            // Hammering inside the window must never reach the network either.
            for (let i = 0; i < 50; i++) await svc.getUsage();
            expect(fetchImpl).toHaveBeenCalledTimes(calls);

            advanceSeconds(1); // window closes
        }

        // 6 attempts across 5+10+20+30+30+30 = 125 minutes of 429s.
        expect(fetchImpl).toHaveBeenCalledTimes(6);
    });

    it('clears the backoff after a success, so a later 429 restarts at 5 min', async () => {
        const { now, advanceSeconds } = makeClock();
        const fetchImpl = scriptedFetch([
            { status: 429 },
            { status: 429 },
            { status: 200, body: OK_BODY },
            { status: 429 },
        ]);
        const svc = new UsageService({ fetchImpl, readCreds: creds, detectVersion: version, now });

        await svc.getUsage();               // 429 → 5 min
        advanceSeconds(300);
        await svc.getUsage();               // 429 → 10 min
        advanceSeconds(600);
        await svc.getUsage();               // 200 → backoff cleared, 3 min min-poll
        expect(fetchImpl).toHaveBeenCalledTimes(3);

        advanceSeconds(400);                // past TTL and min-poll
        await svc.getUsage();               // 429 again
        expect(fetchImpl).toHaveBeenCalledTimes(4);

        // Restarted at the FIRST step (5 min), not the third.
        advanceSeconds(299);
        await svc.getUsage();
        expect(fetchImpl).toHaveBeenCalledTimes(4);
        advanceSeconds(1);
        await svc.getUsage();
        expect(fetchImpl).toHaveBeenCalledTimes(5);
    });

    it.each([500, 502, 503])('does not hammer on HTTP %i — one fetch per min-poll window', async (status) => {
        const { now, advanceSeconds } = makeClock();
        const fetchImpl = scriptedFetch([{ status }]);
        const svc = new UsageService({ fetchImpl, readCreds: creds, detectVersion: version, now });

        const u = await svc.getUsage();
        expect(u.unavailable).toBe(true);
        expect(u.reason).toBe('network');

        for (let i = 0; i < 100; i++) await svc.getUsage();
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        advanceSeconds(179);
        await svc.getUsage();
        expect(fetchImpl).toHaveBeenCalledTimes(1); // min-poll floor is 3 min
        advanceSeconds(1);
        await svc.getUsage();
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('does not hammer when the transport itself throws', async () => {
        const { now, advanceSeconds } = makeClock();
        const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
        const svc = new UsageService({
            fetchImpl: fetchImpl as unknown as UsageFetch,
            readCreds: creds, detectVersion: version, now,
        });
        const u = await svc.getUsage();
        expect(u.reason).toBe('network');
        for (let i = 0; i < 100; i++) await svc.getUsage();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        advanceSeconds(180);
        await svc.getUsage();
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('coalesces callers that arrive across separate ticks while a fetch is in flight', async () => {
        const { now } = makeClock();
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const fetchImpl = vi.fn(async () => {
            await gate;
            return { status: 200, json: async () => OK_BODY };
        });
        const svc = new UsageService({
            fetchImpl: fetchImpl as unknown as UsageFetch,
            readCreds: creds, detectVersion: version, now,
        });

        const a = svc.getUsage();
        await Promise.resolve(); await Promise.resolve(); // let the fetch start
        const b = svc.getUsage();                          // a later tick
        release();
        const [ra, rb] = await Promise.all([a, b]);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(ra).toBe(rb);
    });

    // ---------------------------------------------------------------------
    // Disabled mode (CLAUDIA_PLAN_USAGE=off, and implicitly under vitest).
    // The promise is total inertness: not just "no network" but no keychain
    // shell-out either, since that prompts on some macOS configurations.
    // ---------------------------------------------------------------------

    it('with disabled:true never fetches, never reads credentials, never polls', async () => {
        vi.useFakeTimers();
        try {
            const fetchImpl = scriptedFetch([{ status: 200, body: OK_BODY }]);
            const readCreds = vi.fn(creds);
            const detectVersion = vi.fn(version);
            const svc = new UsageService({ fetchImpl, readCreds, detectVersion, disabled: true });

            const u = await svc.getUsage();
            expect(u.unavailable).toBe(true);
            expect(u.reason).toBe('disabled');
            expect(u.planLabel).toBe('Unknown');
            expect(u.sevenDayByModel).toEqual([]);

            // forceRefresh must not punch through the disable either.
            await svc.getUsage(true);

            const onUpdate = vi.fn();
            svc.startPolling(() => true, onUpdate);
            await vi.advanceTimersByTimeAsync(3_600_000); // an hour of ticks

            expect(fetchImpl).not.toHaveBeenCalled();
            expect(readCreds).not.toHaveBeenCalled();
            expect(detectVersion).not.toHaveBeenCalled();
            expect(onUpdate).not.toHaveBeenCalled();
            svc.stopPolling();
        } finally {
            vi.useRealTimers();
        }
    });

    it('stopPolling clears the interval so nothing fires afterwards', async () => {
        vi.useFakeTimers();
        try {
            const { now } = makeClock();
            const fetchImpl = scriptedFetch([{ status: 200, body: OK_BODY }]);
            const svc = new UsageService({ fetchImpl, readCreds: creds, detectVersion: version, now });
            svc.startPolling(() => true);
            await vi.advanceTimersByTimeAsync(300_000);
            const afterFirstTick = fetchImpl.mock.calls.length;
            expect(afterFirstTick).toBeGreaterThan(0);

            svc.stopPolling();
            expect(vi.getTimerCount()).toBe(0); // no dangling timer to hang shutdown
            await vi.advanceTimersByTimeAsync(3_600_000);
            expect(fetchImpl).toHaveBeenCalledTimes(afterFirstTick);

            svc.stopPolling(); // idempotent
        } finally {
            vi.useRealTimers();
        }
    });

    it('startPolling is idempotent — a second call does not create a second timer', () => {
        vi.useFakeTimers();
        try {
            const { now } = makeClock();
            const svc = new UsageService({
                fetchImpl: scriptedFetch([{ status: 200, body: OK_BODY }]),
                readCreds: creds, detectVersion: version, now,
            });
            svc.startPolling(() => true);
            svc.startPolling(() => true);
            expect(vi.getTimerCount()).toBe(1);
            svc.stopPolling();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
});
