import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import WebSocket from 'ws';
import { request } from 'node:http';
import { startHarness, type Harness } from './helpers/server-harness.js';

// Serve's TCP proxy preserves Host and overwrites these forwarding headers on
// both HTTP and WS. Source: tailscale/ipn/ipnlocal/serve.go,
// reverseProxy.ServeHTTP and addProxyForwardedHeaders (reviewed 2026-09-14).
const serveHeaders = {
    Host: 'pc.tail.ts.net',
    Origin: 'https://pc.tail.ts.net',
    'X-Forwarded-Host': 'pc.tail.ts.net',
    'X-Forwarded-Proto': 'https',
    'X-Forwarded-For': '100.101.102.103',
};
let h: Harness;
beforeAll(async () => {
    h = await startHarness({ prefix: '.claudia-tailscale-', authenticate: false, env: { CLAUDIA_TRUSTED_PROXY: '1' } });
}, 60000);
afterAll(async () => { await h?.stop(); });

// Node fetch rewrites Host; use raw HTTP to reproduce the proxy authority.
function raw(path: string, init: RequestInit = {}): Promise<Response> {
    return new Promise((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port: h.port, path, method: init.method || 'GET', headers: Object.fromEntries(new Headers(init.headers)) }, res => {
            const chunks: Buffer[] = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const headers = new Headers();
                for (const [key, value] of Object.entries(res.headers)) {
                    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
                }
                resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers }));
            });
        });
        req.on('error', reject);
        req.end(init.body as string | undefined);
    });
}

function upgrade(headers: Record<string, string>, query = ''): Promise<number> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${h.port}/${query}`, { headers });
        const timer = setTimeout(() => { ws.terminate(); reject(new Error('upgrade timeout')); }, 5000);
        ws.on('open', () => { clearTimeout(timer); ws.close(); resolve(101); });
        ws.on('unexpected-response', (_req, res) => { clearTimeout(timer); res.resume(); ws.terminate(); resolve(res.statusCode!); });
        ws.on('error', () => {});
    });
}

describe('Tailscale Serve ingress', () => {
    it('requires Claudia auth behind Serve, regardless of Tailscale identity', async () => {
        const headers = { ...serveHeaders, 'Tailscale-User-Login': 'owner@example.test' };
        expect((await raw('/api/tasks', { headers })).status).toBe(401);
        expect(await upgrade(headers)).toBe(401);
        expect(await upgrade(headers, '?token=wrong')).toBe(401);
        expect(await upgrade(headers, `?token=${h.token}`)).toBe(101);
        // Native URLSession clients can avoid a token in the URL entirely.
        expect(await upgrade({ ...headers, Authorization: `Bearer ${h.token}` })).toBe(101);
    });
    it('mints a secure browser cookie only after a successful credential check', async () => {
        const res = await raw('/api/auth/check', { headers: { ...serveHeaders, Authorization: `Bearer ${h.token}` } });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ authenticated: true });
        expect(res.headers.get('set-cookie')).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    });
    it.each([
        serveHeaders,
        { Host: 'pc.tail.ts.net' }, // forwarding headers absent
        { Host: 'localhost', 'X-Forwarded-Proto': 'https' },
        { Host: 'localhost', 'X-Forwarded-For': '127.0.0.1' },
        { Host: 'localhost', 'Tailscale-User-Login': 'owner@example.test' },
    ])('never grants local privileges to proxy shape %j', async shape => {
        const headers = shape as Record<string, string>;
        expect((await raw('/api/auth/local', { headers })).status).toBe(403);
        const info = await (await raw('/api/server-info', { headers })).json();
        expect(info).not.toHaveProperty('dataDir');
        expect((await raw('/api/jira/config', { headers: { ...headers, Authorization: `Bearer ${h.token}` } })).status).toBe(403);
    });
    it('preserves genuine local bootstrap', async () => {
        expect((await raw('/api/auth/local')).status).toBe(200);
    });
    it('rejects a cross-origin browser socket even with a valid token', async () => {
        expect(await upgrade({ ...serveHeaders, Origin: 'https://evil.example' }, `?token=${h.token}`)).toBe(403);
    });
    it('supports a configured Serve origin when Host is rewritten', async () => {
        const saved = await raw('/api/config', {
            method: 'PUT', headers: { Authorization: `Bearer ${h.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ tailscaleUrl: 'https://pc.tail.ts.net' }),
        });
        expect(saved.status).toBe(200);
        expect(await upgrade({ ...serveHeaders, Host: `127.0.0.1:${h.port}` }, `?token=${h.token}`)).toBe(101);
    });
    it('removes old tunnel APIs and no longer accepts the tunnel cookie', async () => {
        for (const path of ['/api/tunnel/start', '/api/tunnel/stop', '/api/tunnel/status']) {
            expect((await raw(path, { method: path.endsWith('status') ? 'GET' : 'POST', headers: { Authorization: `Bearer ${h.token}` } })).status).toBe(404);
        }
        expect((await raw('/api/tasks', { headers: { Cookie: `claudia_tunnel_token=${h.token}` } })).status).toBe(401);
    });
    it('clears the browser cookie on logout', async () => {
        const res = await raw('/api/auth/logout', { method: 'POST', headers: { ...serveHeaders, Authorization: `Bearer ${h.token}` } });
        expect(res.status).toBe(200);
        expect(res.headers.get('set-cookie')).toMatch(/claudia_token=;/);
        expect(res.headers.get('set-cookie')).toMatch(/Expires=/);
    });
});
