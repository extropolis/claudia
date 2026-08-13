/**
 * Token acceptance contract for GET /voice.
 *
 * THE BUG (unauthenticated secret disclosure):
 *   The route accepted any token beginning with `local-`:
 *
 *       const isLocalToken = token.startsWith('local-');
 *       if (!isLocalToken && !tunnelManager.validateToken(token)) { 401 }
 *
 *   That prefix is not a credential. The frontend mints it client-side as
 *   `'local-' + Math.random().toString(36).substring(2, 15)` (App.tsx); nothing
 *   registers or checks the suffix, so the condition accepts any string an
 *   attacker types. The handler then embeds `deepgramApiKey` from config into
 *   the page it returns. With a tunnel active:
 *
 *       GET https://<tunnel-host>/voice?token=local-x  ->  200 + Deepgram key
 *
 *   Reachable in production specifically: for a tunnel host the middleware
 *   first proxies to the Vite dev server, and only falls through to this route
 *   on ECONNREFUSED — i.e. when Vite is not running, which is every deployed
 *   install. That is also why this is a unit test and not an HTTP test: through
 *   the stack the result depends on whether Vite happens to be up, which is
 *   true on a developer machine and false in CI.
 *
 * THE FIX:
 *   The `local-` prefix is honored only for non-tunnel requests.
 */
import { describe, it, expect } from 'vitest';
import { isVoiceTokenAcceptable, isTunnelHostname } from '../voice-auth.js';

/** Hosts that must be treated as public tunnel traffic. */
const TUNNEL_HOSTS = [
    'abc-def.loca.lt',
    'my-app.localtunnel.me',
    'somewhere.ngrok-free.app',
    'tenant.ngrok.io',
    'foo.ngrok.example',
];

/** Ordinary local access. */
const LOCAL_HOSTS = [
    'localhost:4001',
    '127.0.0.1:4001',
    'localhost',
    '[::1]:4001',
    'my-desktop.lan:4001',
];

/** Stands in for a tunnel manager with no active tunnel. */
const noTunnel = () => false;

/** Stands in for an active tunnel that issued exactly `issued`. */
const tunnelIssuing = (issued: string) => (t: string) => t === issued;

describe('isTunnelHostname', () => {
    it('recognizes tunnel hosts', () => {
        for (const h of TUNNEL_HOSTS) {
            expect(isTunnelHostname(h), `${h} should be a tunnel host`).toBe(true);
        }
    });

    it('does not misclassify local hosts', () => {
        for (const h of LOCAL_HOSTS) {
            expect(isTunnelHostname(h), `${h} should not be a tunnel host`).toBe(false);
        }
    });
});

describe('isVoiceTokenAcceptable', () => {
    it('accepts a local- token on a non-tunnel host (local use unchanged)', () => {
        for (const h of LOCAL_HOSTS) {
            expect(isVoiceTokenAcceptable('local-abc123', h, noTunnel), h).toBe(true);
        }
    });

    it('REJECTS a self-minted local- token over a tunnel host', () => {
        for (const h of TUNNEL_HOSTS) {
            expect(isVoiceTokenAcceptable('local-forged', h, noTunnel), h).toBe(false);
        }
    });

    it('rejects every attacker-chosen local- payload over a tunnel', () => {
        const payloads = [
            'local-',
            'local-anything-at-all',
            'local-' + 'x'.repeat(500),
            'local-../../etc/passwd',
            "local-';alert(1);//",
        ];
        for (const token of payloads) {
            expect(
                isVoiceTokenAcceptable(token, 'abc-def.loca.lt', noTunnel),
                `token ${token} must be rejected over a tunnel`,
            ).toBe(false);
        }
    });

    it('rejects an unissued non-local token everywhere', () => {
        for (const h of [...LOCAL_HOSTS, ...TUNNEL_HOSTS]) {
            expect(isVoiceTokenAcceptable('not-a-real-token', h, noTunnel), h).toBe(false);
        }
    });

    it('accepts the genuinely issued tunnel token over a tunnel', () => {
        const validate = tunnelIssuing('real-tunnel-token');
        for (const h of TUNNEL_HOSTS) {
            expect(isVoiceTokenAcceptable('real-tunnel-token', h, validate), h).toBe(true);
        }
    });

    it('still rejects a forged token when a tunnel is active', () => {
        const validate = tunnelIssuing('real-tunnel-token');
        expect(isVoiceTokenAcceptable('local-forged', 'abc-def.loca.lt', validate)).toBe(false);
        expect(isVoiceTokenAcceptable('wrong-token', 'abc-def.loca.lt', validate)).toBe(false);
    });

    it('rejects an empty or missing token', () => {
        expect(isVoiceTokenAcceptable('', 'localhost:4001', noTunnel)).toBe(false);
        expect(isVoiceTokenAcceptable('', 'abc-def.loca.lt', noTunnel)).toBe(false);
    });

    it('claiming a tunnel host cannot grant access it would not otherwise have', () => {
        // Host is used only to WITHDRAW trust. Lying about it moves the caller
        // into the stricter branch, never a more permissive one.
        expect(isVoiceTokenAcceptable('local-x', 'attacker-controlled.ngrok.io', noTunnel)).toBe(false);
    });
});
