/**
 * End-to-end proof for the tunnel blank-screen bug: the request that used to
 * answer 500 must now answer 200, and a genuinely cross-origin request must
 * answer a clean 403 rather than Express's default 500 + stack trace (which
 * leaked absolute filesystem paths to whoever made the request).
 *
 * Raw http.request instead of fetch(): `Host` and `Origin` are forbidden
 * header names for fetch, and this test's whole point is controlling both.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request as httpRequest } from 'http';
import { startHarness, type Harness } from './helpers/server-harness.js';

let h: Harness;

beforeAll(async () => {
    h = await startHarness({ prefix: '.claudia-cors-test-' });
}, 60000);

afterAll(async () => {
    await h?.stop();
});

function raw(path: string, headers: Record<string, string>): Promise<{ status: number; body: string; acao?: string }> {
    return new Promise((resolve, reject) => {
        const req = httpRequest(
            { hostname: '127.0.0.1', port: h.port, path, method: 'GET', headers },
            (res) => {
                let body = '';
                res.on('data', (c) => { body += c; });
                res.on('end', () => resolve({
                    status: res.statusCode || 0,
                    body,
                    acao: res.headers['access-control-allow-origin'] as string | undefined,
                }));
            },
        );
        req.on('error', reject);
        req.end();
    });
}

describe('CORS origin policy over HTTP', () => {
    it('serves a same-origin request that carries an Origin header', async () => {
        // Exactly the shape a <script type="module"> fetch takes from the
        // tunnel page. Before the fix this was a 500.
        const res = await raw('/api/tunnel/status', {
            host: 'yasmin-untrammelled-doug.ngrok-free.dev',
            origin: 'https://yasmin-untrammelled-doug.ngrok-free.dev',
        });
        // 401 = reached the tunnel token guard, i.e. CORS let it through.
        // 200 = no tunnel active in this harness. Either way: not 500.
        expect([200, 401]).toContain(res.status);
        expect(res.body).not.toContain('CORS');
    });

    it('serves loopback origins', async () => {
        const res = await raw('/api/tunnel/status', {
            host: `127.0.0.1:${h.port}`,
            origin: 'http://localhost:5173',
        });
        expect(res.status).toBe(200);
        expect(res.acao).toBe('http://localhost:5173');
    });

    it('rejects a cross-origin request with 403 and no stack trace', async () => {
        const res = await raw('/api/tunnel/status', {
            host: `127.0.0.1:${h.port}`,
            origin: 'https://evil.example',
        });
        expect(res.status).toBe(403);
        expect(JSON.parse(res.body)).toEqual({ error: 'Origin not allowed' });
        // The old behaviour rendered the Error's stack, absolute paths and all.
        expect(res.body).not.toMatch(/at .*server\.ts/);
    });

    it('still serves originless requests (curl, native clients)', async () => {
        const res = await raw('/api/tunnel/status', { host: `127.0.0.1:${h.port}` });
        expect(res.status).toBe(200);
    });
});
