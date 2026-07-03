import { describe, it, expect } from 'vitest';
import { decideWebSocketAuth, type WebSocketAuthDeps } from '../ws-auth.js';
import { isTunnelHost } from '../tunnel-auth.js';

const VALID = 'good-token';

const deps: WebSocketAuthDeps = {
    validateToken: (t) => t === VALID,
    isTunnelHost,
};

function decide(
    opts: { token?: string; host?: string; isTunnelActive: boolean },
) {
    return decideWebSocketAuth(
        {
            token: opts.token,
            host: opts.host ?? 'abc123.ngrok-free.app',
            isTunnelActive: opts.isTunnelActive,
        },
        deps,
    );
}

describe('decideWebSocketAuth', () => {
    // ===== Tunnel active: token required for EVERYONE (desktop AND mobile) =====
    describe('tunnel active — requires a valid token regardless of the mobile flag', () => {
        // The historical hole: a non-mobile connection with any token string was
        // treated as a full desktop client with NO validation. Now every
        // connection is validated the same way.
        const hosts: Array<string | undefined> = [
            'abc123.ngrok-free.app', // real tunnel host
            'localhost',             // spoofed local Host
            'localhost:4001',
            '127.0.0.1',
            'evil.com',
            '',
            undefined,
        ];

        for (const host of hosts) {
            const label = host === undefined ? '(missing Host)' : host === '' ? '(empty Host)' : host;

            it(`rejects a NON-mobile connection with no token — ${label}`, () => {
                const d = decideWebSocketAuth(
                    { token: undefined, host: host ?? '', isTunnelActive: true },
                    deps,
                );
                expect(d.allowed, label).toBe(false);
            });

            it(`rejects a connection with an INVALID token — ${label}`, () => {
                const d = decideWebSocketAuth(
                    { token: 'wrong', host: host ?? '', isTunnelActive: true },
                    deps,
                );
                expect(d.allowed, label).toBe(false);
            });

            it(`accepts a connection with a VALID token — ${label}`, () => {
                const d = decideWebSocketAuth(
                    { token: VALID, host: host ?? '', isTunnelActive: true },
                    deps,
                );
                expect(d.allowed, label).toBe(true);
            });
        }
    });

    // Explicit mobile-flag coverage: the flag no longer changes the decision.
    it('rejects a mobile connection (mobile=1 semantics) with no token when tunnel active', () => {
        // mobile=1 is irrelevant to the decision; absence of a token is what matters.
        expect(decide({ token: undefined, isTunnelActive: true }).allowed).toBe(false);
    });

    it('accepts a mobile connection with a valid token when tunnel active', () => {
        expect(decide({ token: VALID, isTunnelActive: true }).allowed).toBe(true);
    });

    // ===== No tunnel active: tokenless local connections allowed =====
    describe('no tunnel active — tokenless local connections are allowed', () => {
        const localHosts = ['localhost:4001', '127.0.0.1', 'evil.com', ''];
        for (const host of localHosts) {
            it(`accepts a tokenless connection (host: ${host || '(empty)'})`, () => {
                const d = decideWebSocketAuth(
                    { token: undefined, host, isTunnelActive: false },
                    deps,
                );
                expect(d.allowed, host).toBe(true);
            });
        }
    });

    // ===== Belt-and-suspenders: tunnel-looking Host trips the gate even if =====
    // isTunnelActive() is false (an externally-started tunnel the app didn't create).
    describe('no tunnel active but tunnel-looking Host — still requires a token', () => {
        const tunnelHosts = ['abc.ngrok.io', 'ABC.NGROK.IO', 'foo.ngrok-free.app', 'bar.loca.lt'];
        for (const host of tunnelHosts) {
            it(`rejects a tokenless connection (host: ${host})`, () => {
                const d = decideWebSocketAuth(
                    { token: undefined, host, isTunnelActive: false },
                    deps,
                );
                expect(d.allowed, host).toBe(false);
            });
            it(`accepts a valid-token connection (host: ${host})`, () => {
                const d = decideWebSocketAuth(
                    { token: VALID, host, isTunnelActive: false },
                    deps,
                );
                expect(d.allowed, host).toBe(true);
            });
        }
    });
});
