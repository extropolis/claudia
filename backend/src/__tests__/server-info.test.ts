/**
 * GET /api/server-info against the REAL server booted by the integration
 * harness on an ephemeral port.
 *
 * This route is what lets any launcher — start.sh, the Electron app, a second
 * `npm run dev` — ask a running backend "who are you, and which data directory
 * do you hold?" before deciding whether to start another instance. That makes
 * two properties load-bearing, and both are asserted here:
 *
 *  1. It must answer WITHOUT authentication: the question is asked before any
 *     credential exists.
 *  2. It must leak nothing. The response body is compared key-for-key against
 *     the allowed set, so a future field carrying a token, tunnel URL or task
 *     data fails this test rather than shipping.
 *  3. `dataDir` is a filesystem path, so only a caller on this machine gets it.
 *     The harness connects over loopback; a forwarded request (the ngrok agent
 *     and any reverse proxy connect from 127.0.0.1 but add X-Forwarded-*) is
 *     never local, and must get every field except `dataDir`.
 *
 * No CLI spawn, so this runs on the Windows CI leg too.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { startHarness, type Harness } from './helpers/server-harness.js';
import { SERVER_INFO_PROTOCOL_VERSION } from '../server.js';
import { acquireInstanceLock, INSTANCE_LOCK_FILE } from '../instance-lock.js';

let h: Harness;

beforeAll(async () => {
    h = await startHarness({ prefix: '.claudia-server-info-test-' });
});

afterAll(async () => {
    await h?.stop();
});

describe('GET /api/server-info', () => {
    it('answers 200 with the instance identity, unauthenticated', async () => {
        const { status, body } = await h.req('/api/server-info');

        expect(status).toBe(200);
        expect(typeof body.instanceId).toBe('string');
        expect(body.instanceId.length).toBeGreaterThan(8);
        expect(body.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
        expect(body.protocolVersion).toBe(SERVER_INFO_PROTOCOL_VERSION);
        expect(body.dataDir).toBe(h.base);
        expect(body.authRequired).toBe(true);
        expect(Number.isNaN(Date.parse(body.startedAt))).toBe(false);
    });

    it('answers without any credential at all', async () => {
        // h.req/h.fetch attach the API token; a launcher probing before it has
        // one must still get the identity back, not a 401.
        const res = await fetch(`${h.baseUrl}/api/server-info`);
        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(typeof body.instanceId).toBe('string');
        expect(body.authRequired).toBe(true);
    });

    it('exposes exactly the identity fields and nothing else', async () => {
        const { body } = await h.req('/api/server-info');
        expect(Object.keys(body).sort()).toEqual(
            ['authRequired', 'dataDir', 'instanceId', 'protocolVersion', 'startedAt', 'version'].sort(),
        );
    });

    describe('dataDir is loopback-only', () => {
        const FORWARDED_SHAPES: Array<[string, Record<string, string>]> = [
            ['X-Forwarded-For', { 'X-Forwarded-For': '203.0.113.7' }],
            ['X-Forwarded-Host', { 'X-Forwarded-Host': 'abc.ngrok-free.app' }],
            ['Forwarded', { Forwarded: 'for=203.0.113.7;proto=https' }],
        ];

        it.each(FORWARDED_SHAPES)('omits dataDir for a non-loopback (%s) caller', async (_label, headers) => {
            // No token either: this is exactly what a remote probe looks like.
            const res = await fetch(`${h.baseUrl}/api/server-info`, { headers });
            expect(res.status).toBe(200);
            const body = await res.json() as Record<string, unknown>;
            expect(body).not.toHaveProperty('dataDir');
            expect(Object.keys(body).sort()).toEqual(
                ['authRequired', 'instanceId', 'protocolVersion', 'startedAt', 'version'].sort(),
            );
            // Everything else is still there, so the probe can still identify it.
            const local = await h.req('/api/server-info');
            expect(body.instanceId).toBe(local.body.instanceId);
        });

        it('includes dataDir for a loopback caller, with or without a token', async () => {
            const withToken = await h.req('/api/server-info');
            expect(withToken.body.dataDir).toBe(h.base);
            const bare = await (await fetch(`${h.baseUrl}/api/server-info`)).json() as Record<string, unknown>;
            expect(bare.dataDir).toBe(h.base);
        });
    });

    it('reports a stable identity across calls within one boot', async () => {
        const a = await h.req('/api/server-info');
        const b = await h.req('/api/server-info');
        expect(a.body.instanceId).toBe(b.body.instanceId);
        expect(a.body.startedAt).toBe(b.body.startedAt);
    });

    it('sends no Set-Cookie or auth-bearing headers', async () => {
        const res = await h.fetch('/api/server-info');
        expect(res.headers.get('set-cookie')).toBeNull();
        expect(res.headers.get('authorization')).toBeNull();
    });

    // The lock file and the route are two views of the same fact, and a
    // launcher may consult either. They must agree on the data directory.
    it('describes the same data directory the instance lock claims', async () => {
        const { body } = await h.req('/api/server-info');
        const { release } = acquireInstanceLock(h.base, 4599, '1.2.3', {
            isPidAlive: () => false,
            probeHealth: () => false,
        });
        try {
            const lockFile = join(h.base, INSTANCE_LOCK_FILE);
            expect(existsSync(lockFile)).toBe(true);
            expect(JSON.parse(readFileSync(lockFile, 'utf8')).pid).toBe(process.pid);
            expect(body.dataDir).toBe(h.base);
        } finally {
            release();
        }
    });
});
