/**
 * Wiring test for the plan-usage surface on the real server:
 *   - GET /api/usage
 *   - `usage:updated` pushed to every new WebSocket client after `init`
 *   - `usage:get` request/reply
 *
 * Under vitest the UsageService is inert (see server.ts): it must never read
 * the OS keychain or call the live endpoint from a test. So the payload here
 * is always the `unavailable / disabled` shape — which is exactly what the
 * frontend's degrade-gracefully path consumes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from './helpers/server-harness.js';
import { WSClient } from './helpers/ws-harness.js';
import { request as httpRequest } from 'node:http';

/** GET with a caller-controlled Host header, which `fetch` will not send. */
function rawGet(port: number, path: string, host: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET', headers: { Host: host } }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

let h: Harness;

beforeAll(async () => {
    h = await startHarness({ prefix: '.claudia-usage-test-' });
}, 60000);

afterAll(async () => {
    await h?.stop();
});

const DISABLED = {
    unavailable: true,
    reason: 'disabled',
    planLabel: 'Unknown',
    sevenDayByModel: [],
};

describe('GET /api/usage', () => {
    it('always answers 200 with a PlanUsage-shaped body, never throws', async () => {
        const res = await fetch(`${h.baseUrl}/api/usage`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject(DISABLED);
        expect(body.fiveHour).toEqual({ utilization: 0, resetsAt: '' });
        expect(body.sevenDay).toEqual({ utilization: 0, resetsAt: '' });
        expect(typeof body.fetchedAt).toBe('string');
    });
});

describe('WebSocket plan usage', () => {
    it('pushes usage:updated to a fresh client without being asked', async () => {
        const c = await WSClient.connect(h.port);
        try {
            await c.waitForMessage('init');
            const frame = await c.waitForMessage('usage:updated');
            expect(frame.payload).toMatchObject(DISABLED);
        } finally {
            c.close();
        }
    });

    it('answers usage:get with usage:updated on the requesting socket only', async () => {
        const a = await WSClient.connect(h.port);
        const b = await WSClient.connect(h.port);
        try {
            await a.waitForMessage('usage:updated');
            await b.waitForMessage('usage:updated');
            const seenByB = b.frames.filter(f => f.type === 'usage:updated').length;

            a.send('usage:get');
            await a.waitForMessage('usage:updated', () =>
                a.frames.filter(f => f.type === 'usage:updated').length >= 2);
            // Give a stray broadcast a chance to land before asserting isolation.
            await new Promise(r => setTimeout(r, 150));
            expect(b.frames.filter(f => f.type === 'usage:updated').length).toBe(seenByB);
        } finally {
            a.close();
            b.close();
        }
    });
});

describe('/api/usage over a tunnel', () => {
    it('is refused without a tunnel token, like every other /api/ route', async () => {
        // /api/usage is reachable from the phone/tunnel surface. It must sit
        // behind the same blanket token guard as the rest of /api/*, not be an
        // unauthenticated hole that reveals plan state to anyone who guesses
        // the ngrok URL.
        // `fetch` silently drops a caller-set Host header (it is a forbidden
        // header name in undici), so a raw request is the only way to actually
        // present a tunnel hostname to the server.
        const res = await rawGet(h.port, '/api/usage', 'claudia-test.ngrok.app');
        expect(res.status).toBe(401);
        expect(JSON.parse(res.body).error).toMatch(/token/i);
    });
});

describe('the /api/usage payload carries no account identity', () => {
    it('exposes only limit percentages, reset times and a plan label', async () => {
        const body = await (await fetch(`${h.baseUrl}/api/usage`)).json();
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
