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
