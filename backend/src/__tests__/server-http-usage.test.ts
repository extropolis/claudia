/**
 * Wiring test for the plan-usage surface on the real server:
 *   - GET /api/usage
 *   - `usage:updated` pushed to every new loopback WebSocket client after `init`
 *   - `usage:get` request/reply
 *
 * Auth (#261) is mandatory on every /api route and every WebSocket upgrade, so
 * /api/usage sits behind the token middleware; on top of that, plan usage is
 * scoped to LOOPBACK clients the same way Jira broadcasts are.
 *
 * A non-loopback client is simulated the way the ngrok agent actually presents
 * one: it connects from 127.0.0.1 but carries `X-Forwarded-For` (which
 * `isLoopbackPeer` refuses), or it is the phone client (`mobile=1`).
 *
 * Under vitest the UsageService is inert (see server.ts): it must never read
 * the OS keychain or call the live endpoint from a test. So the payload here
 * is always the `unavailable / disabled` shape — which is exactly what the
 * frontend's degrade-gracefully path consumes.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { startHarness, type Harness } from './helpers/server-harness.js';
import { TunnelManager } from '../tunnel-manager.js';
import { WSClient } from './helpers/ws-harness.js';

/** What a request relayed by the ngrok agent (or any reverse proxy) carries. */
const FORWARDED = { 'X-Forwarded-For': '203.0.113.7' };

let h: Harness;

beforeAll(async () => {
    h = await startHarness({ prefix: '.claudia-usage-test-' });
}, 60000);

afterAll(async () => {
    await h?.stop();
});

afterEach(() => {
    vi.restoreAllMocks();
});

const DISABLED = {
    unavailable: true,
    reason: 'disabled',
    planLabel: 'Unknown',
    sevenDayByModel: [],
};

/**
 * No ngrok runs under test, so no tunnel token ever validates. Accept any
 * tunnel token so a phone-style client gets PAST the auth gate and actually
 * reaches the plan-usage code — that is the path being tested.
 */
function acceptAnyTunnelToken(): void {
    vi.spyOn(TunnelManager.prototype, 'validateToken').mockReturnValue(true);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('GET /api/usage', () => {
    it('answers 200 with a PlanUsage-shaped body to an authenticated loopback client', async () => {
        const res = await h.fetch('/api/usage');
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject(DISABLED);
        expect(body.fiveHour).toEqual({ utilization: 0, resetsAt: '' });
        expect(body.sevenDay).toEqual({ utilization: 0, resetsAt: '' });
        expect(typeof body.fetchedAt).toBe('string');
    });

    it('answers 401 to an untokened request, even from loopback', async () => {
        // /api/usage is not on the unauthenticated-path list: it sits behind
        // the same token middleware as every other /api route.
        const res = await fetch(`${h.baseUrl}/api/usage`);
        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.error).toMatch(/token/i);
        expect(JSON.stringify(body)).not.toContain('fiveHour');
    });

    it('answers 401 to a wrong token', async () => {
        const res = await fetch(`${h.baseUrl}/api/usage`, { headers: { 'x-claudia-token': 'f'.repeat(64) } });
        expect(res.status).toBe(401);
    });
});

describe('WebSocket plan usage (authenticated loopback clients)', () => {
    it('refuses an untokened WebSocket upgrade outright', async () => {
        await expect(WSClient.connect(h.port)).rejects.toThrow(/401/);
    });

    it('pushes usage:updated to a fresh client without being asked', async () => {
        const c = await WSClient.connect(h.port, h.token);
        try {
            await c.waitForMessage('init');
            const frame = await c.waitForMessage('usage:updated');
            expect(frame.payload).toMatchObject(DISABLED);
        } finally {
            c.close();
        }
    });

    it('answers usage:get with usage:updated on the requesting socket only', async () => {
        const a = await WSClient.connect(h.port, h.token);
        const b = await WSClient.connect(h.port, h.token);
        try {
            await a.waitForMessage('usage:updated');
            await b.waitForMessage('usage:updated');
            const seenByB = b.frames.filter(f => f.type === 'usage:updated').length;

            a.send('usage:get');
            await a.waitForMessage('usage:updated', () =>
                a.frames.filter(f => f.type === 'usage:updated').length >= 2);
            // Give a stray broadcast a chance to land before asserting isolation.
            await sleep(150);
            expect(b.frames.filter(f => f.type === 'usage:updated').length).toBe(seenByB);
        } finally {
            a.close();
            b.close();
        }
    });
});

describe('plan usage is loopback-only on top of auth (scoped like Jira broadcasts)', () => {
    it('GET /api/usage answers 403 to an authenticated but forwarded (tunnel/proxy) request', async () => {
        const res = await h.fetch('/api/usage', { headers: FORWARDED });
        expect(res.status).toBe(403);
        expect(await res.text()).not.toContain('fiveHour');
    });

    it('GET /api/usage answers 403 to a phone presenting a valid TUNNEL token', async () => {
        acceptAnyTunnelToken();
        const res = await fetch(`${h.baseUrl}/api/usage`, {
            headers: { 'x-claudia-token': 'tunnel-token', ...FORWARDED },
        });
        expect(res.status).toBe(403);
    });

    it('does not push usage:updated to a mobile (tunnel-token) WebSocket client', async () => {
        acceptAnyTunnelToken();
        const mobile = await WSClient.connect(h.port, 'tunnel-token', { query: 'mobile=1', headers: FORWARDED });
        const local = await WSClient.connect(h.port, h.token);
        try {
            await mobile.waitForMessage('init');
            // The loopback client getting its push proves the push path ran.
            await local.waitForMessage('usage:updated');
            await sleep(200);
            expect(mobile.frames.some(f => f.type === 'usage:updated')).toBe(false);
        } finally {
            mobile.close();
            local.close();
        }
    });

    it('does not push usage:updated to an API-token socket that arrived forwarded', async () => {
        const remote = await WSClient.connect(h.port, h.token, { headers: FORWARDED });
        try {
            await remote.waitForMessage('init');
            await sleep(250);
            expect(remote.frames.some(f => f.type === 'usage:updated')).toBe(false);
        } finally {
            remote.close();
        }
    });

    it('ignores usage:get from a non-loopback client', async () => {
        acceptAnyTunnelToken();
        const mobile = await WSClient.connect(h.port, 'tunnel-token', { query: 'mobile=1', headers: FORWARDED });
        try {
            await mobile.waitForMessage('init');
            mobile.send('usage:get');
            await sleep(300);
            expect(mobile.frames.some(f => f.type === 'usage:updated')).toBe(false);
            expect(mobile.isClosed).toBe(false);
        } finally {
            mobile.close();
        }
    });
});

describe('the /api/usage payload carries no account identity', () => {
    it('exposes only limit percentages, reset times and a plan label', async () => {
        const body = await (await h.fetch('/api/usage')).json();
        // Whitelist the entire serialized surface: anything new that lands in
        // PlanUsage has to be added here deliberately, which is the point.
        expect(Object.keys(body).sort()).toEqual([
            'fetchedAt', 'fiveHour', 'planLabel', 'reason', 'sevenDay',
            'sevenDayByModel', 'unavailable',
        ]);
        // No email, org, account id, token or raw upstream blob, ever.
        const blob = JSON.stringify(body).toLowerCase();
        for (const forbidden of [
            'email', 'organization', 'org_', 'account', 'uuid',
            'token', 'bearer', 'authorization', 'sk-ant', 'refresh',
        ]) {
            expect(blob).not.toContain(forbidden);
        }
    });
});
