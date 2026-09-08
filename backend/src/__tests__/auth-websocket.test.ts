/**
 * Every WebSocket upgrade requires a credential.
 *
 * THE BUG THIS EXISTS FOR. The upgrade handler checked a token only when the
 * Host header matched a tunnel substring, and even then a connection that said
 * `mobile=1` skipped the check entirely — the token was validated later, in the
 * `connection` handler, and only for `mobile=1`. So two shapes reached the live
 * client set unauthenticated:
 *
 *   1. Any non-tunnel host (a LAN IP, a Tailscale name) — never checked at all.
 *   2. A tunnel connection with `?token=anything&mobile=1`... no, worse: a
 *      tunnel connection with `?token=anything` and NO `mobile=1` passed the
 *      upgrade gate on the mere PRESENCE of a token and was never validated.
 *
 * The WS carries the same authority as the REST API — `task:input` writes
 * straight into a live PTY — so it is now gated by the same credential on every
 * upgrade, with no `mobile=1` case left.
 *
 * Temp dirs live under homedir(), not os.tmpdir(): on macOS tmpdir resolves
 * under /var, which validateWorkspacePath blocklists as a system path.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { startHarness, type Harness } from './helpers/server-harness.js';
import { getAuthToken } from '../auth-token.js';

let h: Harness;

beforeAll(async () => {
    h = await startHarness({ prefix: '.claudia-ws-auth-test-', authenticate: false });
}, 60000);

afterAll(async () => {
    await h?.stop();
});

/** Attempt an upgrade; resolve 'open' or the HTTP status the server refused with. */
function tryUpgrade(query: string): Promise<'open' | number> {
    return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${h.port}${query}`);
        const done = (v: 'open' | number) => {
            try { ws.close(); } catch { /* already gone */ }
            resolve(v);
        };
        ws.on('open', () => done('open'));
        // `ws` surfaces a rejected upgrade as "Unexpected server response: <code>".
        ws.on('unexpected-response', (_req, res) => done(res.statusCode || 0));
        ws.on('error', (err: Error) => {
            const m = /Unexpected server response: (\d+)/.exec(err.message);
            done(m ? Number(m[1]) : 0);
        });
    });
}

describe('WebSocket upgrade authentication', () => {
    it('rejects an upgrade with no token', async () => {
        expect(await tryUpgrade('')).toBe(401);
    });

    it('rejects an upgrade with a wrong token', async () => {
        expect(await tryUpgrade(`?token=${'f'.repeat(64)}`)).toBe(401);
        expect(await tryUpgrade('?token=nonsense')).toBe(401);
    });

    it('accepts an upgrade with the real token', async () => {
        expect(await tryUpgrade(`?token=${getAuthToken(h.base)}`)).toBe('open');
    });

    it('gives mobile=1 NO special treatment — it is a label, not a credential', async () => {
        // This is the exact shape that used to bypass the check.
        expect(await tryUpgrade('?mobile=1')).toBe(401);
        expect(await tryUpgrade('?token=anything&mobile=1')).toBe(401);
        expect(await tryUpgrade(`?token=${getAuthToken(h.base)}&mobile=1`)).toBe('open');
    });

    it('does not accept a token merely because one is PRESENT', async () => {
        // The old tunnel branch gated on `searchParams.has('token')`.
        expect(await tryUpgrade('?token=')).toBe(401);
        expect(await tryUpgrade('?token=x')).toBe(401);
    });

    it('rejects an unauthenticated Vite HMR socket rather than admitting it', async () => {
        const status = await new Promise<'open' | number>((resolve) => {
            const ws = new WebSocket(`ws://127.0.0.1:${h.port}`, 'vite-hmr');
            const done = (v: 'open' | number) => {
                try { ws.close(); } catch { /* already gone */ }
                resolve(v);
            };
            ws.on('open', () => done('open'));
            ws.on('unexpected-response', (_req, res) => done(res.statusCode || 0));
            ws.on('error', (err: Error) => {
                const m = /Unexpected server response: (\d+)/.exec(err.message);
                done(m ? Number(m[1]) : 0);
            });
        });
        // 400: recognized as HMR and turned away. Never 'open'.
        expect(status).toBe(400);
    });
});
