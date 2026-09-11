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
        expect(Number.isNaN(Date.parse(body.startedAt))).toBe(false);
    });

    it('exposes exactly the identity fields and nothing else', async () => {
        const { body } = await h.req('/api/server-info');
        expect(Object.keys(body).sort()).toEqual(
            ['dataDir', 'instanceId', 'protocolVersion', 'startedAt', 'version'].sort(),
        );
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
