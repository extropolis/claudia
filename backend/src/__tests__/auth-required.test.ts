/**
 * Every /api route requires a credential — enumerated from the route table.
 *
 * THE BUG THIS EXISTS FOR. `/api/*` was authenticated only when the request's
 * Host header contained one of five tunnel substrings (`.loca.lt`,
 * `localtunnel`, `.ngrok-free.app`, `.ngrok.io`, `ngrok`). Since
 * `server.listen(PORT)` binds every interface, a request to the backend by LAN
 * IP, Tailscale name, custom domain or *.fly.dev host matched none of them and
 * was served with NO authentication at all — including `POST /api/tasks`,
 * which spawns a Claude Code process. That is remote code execution for
 * anything on the same network.
 *
 * WHY THE TEST IS GENERATED. A hand-written list of routes to check is a list
 * that goes stale the first time someone adds a route. This walks Express's own
 * router stack after createApp() and asserts on every `/api` route that exists,
 * so a new unauthenticated endpoint fails this suite the day it is written
 * rather than the day it is exploited.
 *
 * Requests here come from 127.0.0.1 — the most trusted possible peer. Loopback
 * is deliberately NOT an exemption (every process on the machine shares it), so
 * proving 401 from loopback proves 401 from anywhere.
 *
 * Temp dirs live under homedir(), not os.tmpdir(): on macOS tmpdir resolves
 * under /var, which validateWorkspacePath blocklists as a system path.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { networkInterfaces } from 'os';
import { startHarness, Harness } from './helpers/server-harness.js';
import { getAuthToken } from '../auth-token.js';

/**
 * Routes deliberately reachable with no credential.
 *
 * `/api/health` is a container liveness probe. `/api/server-info` tells a
 * client with no token what it reached and that a token is needed, so it can
 * prompt rather than fail silently. Neither says anything about tasks,
 * workspaces or the filesystem.
 */
const UNAUTHENTICATED = new Set(['/api/health', '/api/server-info']);

/** Not open — gated on the socket peer being loopback, so it 403s, not 401s. */
const LOOPBACK_ONLY = '/api/auth/local';

interface DiscoveredRoute {
    method: string;
    path: string;
}

/**
 * Walk Express's router stack for every registered `/api` route.
 *
 * Express 4 keeps them on `app._router.stack`; each layer with a `.route` is a
 * concrete path, and nested routers appear as layers with a `.handle.stack`.
 */
function enumerateApiRoutes(app: any): DiscoveredRoute[] {
    const found: DiscoveredRoute[] = [];
    const seen = new Set<string>();

    const visit = (stack: any[], prefix: string) => {
        for (const layer of stack ?? []) {
            if (layer.route) {
                const path = prefix + layer.route.path;
                if (typeof path !== 'string' || !path.startsWith('/api')) continue;
                for (const [method, on] of Object.entries(layer.route.methods ?? {})) {
                    if (!on || method === '_all') continue;
                    const key = `${method.toUpperCase()} ${path}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    found.push({ method: method.toUpperCase(), path });
                }
            } else if (layer.name === 'router' && layer.handle?.stack) {
                visit(layer.handle.stack, prefix);
            }
        }
    };

    visit(app._router?.stack ?? app.router?.stack, '');
    return found;
}

/** Substitute something harmless for `:params` so the URL is requestable. */
function concretize(path: string): string {
    return path
        .replace(/:[A-Za-z0-9_]+\*?/g, 'auth-probe-nonexistent')
        .replace(/\(\.\*\)|\*/g, 'auth-probe-nonexistent');
}

/** A non-loopback IPv4 address of this machine, if it has one. */
function nonLoopbackAddress(): string | undefined {
    for (const addrs of Object.values(networkInterfaces())) {
        for (const a of addrs ?? []) {
            if (a.family === 'IPv4' && !a.internal) return a.address;
        }
    }
    return undefined;
}

let h: Harness;
let routes: DiscoveredRoute[];

beforeAll(async () => {
    // authenticate:false — this suite is ABOUT the credential, so the harness
    // must not attach one behind our back.
    h = await startHarness({ prefix: '.claudia-auth-required-test-', authenticate: false });
    routes = enumerateApiRoutes(h.server.app);
}, 60000);

afterAll(async () => {
    await h?.stop();
});

describe('API route table', () => {
    it('discovers a meaningful number of /api routes (the walk itself works)', () => {
        // If the enumeration silently found nothing, every assertion below would
        // vacuously pass — which is exactly how this class of test rots.
        expect(routes.length).toBeGreaterThan(50);
    });

    it('exposes exactly the intended unauthenticated surface', () => {
        const open = routes
            .map(r => r.path)
            .filter(p => UNAUTHENTICATED.has(p) || p === LOOPBACK_ONLY);
        expect(new Set(open)).toEqual(new Set(['/api/health', '/api/server-info', LOOPBACK_ONLY]));
    });
});

describe('every /api route rejects an unauthenticated request', () => {
    it('answers 401 with no token', async () => {
        const offenders: string[] = [];

        for (const route of routes) {
            if (UNAUTHENTICATED.has(route.path) || route.path === LOOPBACK_ONLY) continue;
            const res = await h.fetch(concretize(route.path), { method: route.method });
            if (res.status !== 401) offenders.push(`${route.method} ${route.path} -> ${res.status}`);
        }

        expect(offenders, `unauthenticated routes:\n${offenders.join('\n')}`).toEqual([]);
    }, 120000);

    it('answers 401 for an invalid token, in every place a token may be presented', async () => {
        const wrong = 'f'.repeat(64);
        const presentations: Array<[string, string, RequestInit]> = [
            ['query', `/api/tasks?token=${wrong}`, {}],
            ['x-claudia-token', '/api/tasks', { headers: { 'x-claudia-token': wrong } }],
            ['bearer', '/api/tasks', { headers: { authorization: `Bearer ${wrong}` } }],
            ['cookie', '/api/tasks', { headers: { cookie: `claudia_token=${wrong}` } }],
            ['short token', '/api/tasks', { headers: { 'x-claudia-token': 'x' } }],
        ];

        for (const [label, path, init] of presentations) {
            const res = await h.fetch(path, init);
            expect(res.status, label).toBe(401);
        }
    });

    it('leaves the unauthenticated allowlist reachable', async () => {
        expect((await h.fetch('/api/health')).status).toBe(200);
        const info = await h.req<{ name: string; authRequired: boolean }>('/api/server-info');
        expect(info.status).toBe(200);
        expect(info.body.authRequired).toBe(true);
    });
});

describe('a valid token is accepted everywhere it may be presented', () => {
    it('accepts the token as query, header, bearer and cookie', async () => {
        const token = getAuthToken(h.base);
        const ok: Array<[string, string, RequestInit]> = [
            ['query', `/api/tasks?token=${token}`, {}],
            ['x-claudia-token', '/api/tasks', { headers: { 'x-claudia-token': token } }],
            ['bearer', '/api/tasks', { headers: { authorization: `Bearer ${token}` } }],
            ['cookie', '/api/tasks', { headers: { cookie: `claudia_token=${token}` } }],
            ['legacy cookie', '/api/tasks', { headers: { cookie: `claudia_tunnel_token=${token}` } }],
        ];

        for (const [label, path, init] of ok) {
            const res = await h.fetch(path, init);
            expect(res.status, label).toBe(200);
        }
    });

    it('mints a cookie on first successful presentation so the SPA stays authenticated', async () => {
        const token = getAuthToken(h.base);
        const res = await h.fetch('/api/tasks', { headers: { 'x-claudia-token': token } });
        const cookie = res.headers.get('set-cookie') || '';
        expect(cookie).toContain('claudia_token=');
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('SameSite=Strict');
        // Not Secure over plain http, or the browser discards it — which is the
        // LAN deployment this whole change exists to protect.
        expect(cookie).not.toContain('Secure');
    });
});

describe('loopback bootstrap', () => {
    it('serves the token to a caller on 127.0.0.1', async () => {
        const res = await h.req<{ token: string }>(LOOPBACK_ONLY);
        expect(res.status).toBe(200);
        expect(res.body.token).toBe(getAuthToken(h.base));
        expect(res.body.token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('refuses a FORWARDED request even though the socket is loopback', async () => {
        // Not a theoretical case. The ngrok agent runs on this machine, so a
        // request that arrived over the public tunnel reaches the server from
        // 127.0.0.1 and looks local at the socket. If the socket alone decided
        // this, `/api/auth/local` would hand the API token to anyone on the
        // internet who opened the tunnel URL. Any X-Forwarded-* header means
        // the real client is a hop away, so it is refused.
        for (const headers of [
            { 'x-forwarded-for': '127.0.0.1' },
            { 'x-forwarded-for': '203.0.113.4' },
            { 'x-forwarded-host': 'somewhere.ngrok-free.app' },
            { forwarded: 'for=203.0.113.4' },
        ]) {
            const res = await h.req<{ error: string }>(LOOPBACK_ONLY, { headers });
            expect(res.status, JSON.stringify(headers)).toBe(403);
        }
    });

    it('refuses a real non-loopback peer, even one claiming X-Forwarded-For: 127.0.0.1', async () => {
        const lan = nonLoopbackAddress();
        if (!lan) {
            // A CI box with only a loopback interface cannot exercise this;
            // request-peer.test coverage of isLoopbackPeer carries it there.
            return;
        }

        // The harness binds 127.0.0.1 only, so reach the same process through a
        // second listener bound to all interfaces.
        const { createApp } = await import('../server.js');
        const parts = await createApp(h.base);
        try {
            await new Promise<void>(r => parts.server.listen(0, '0.0.0.0', () => r()));
            const port = (parts.server.address() as { port: number }).port;

            const res = await fetch(`http://${lan}:${port}${LOOPBACK_ONLY}`, {
                headers: { 'x-forwarded-for': '127.0.0.1' },
            });
            expect(res.status).toBe(403);

            // And the ordinary API surface is 401 for that same peer.
            const api = await fetch(`http://${lan}:${port}/api/tasks`);
            expect(api.status).toBe(401);
        } finally {
            await parts.shutdownForTests().catch(() => { /* already down */ });
        }
    }, 60000);
});
