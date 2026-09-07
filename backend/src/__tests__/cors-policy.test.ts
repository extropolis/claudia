/**
 * The regression this locks down: a tunnel-served page could not load its own
 * assets. Browsers attach an `Origin` header to module scripts and fetches
 * even when the target is the page's own origin, and the old localhost-only
 * allowlist answered those with `next(new Error(...))` — Express's default
 * handler turned that into a 500, so `/@vite/client`, `/src/main.tsx` and
 * every `/api/*` call from the ngrok page failed and the app rendered blank.
 *
 * Verified against the live tunnel before the fix: the identical request
 * without an `Origin` header returned 200, with it returned 500.
 */
import { describe, it, expect } from 'vitest';
import { evaluateCorsOrigin, CORS_REJECTED } from '../cors-policy.js';

const TUNNEL = 'https://yasmin-untrammelled-doug.ngrok-free.dev';
const TUNNEL_HOST = 'yasmin-untrammelled-doug.ngrok-free.dev';

describe('evaluateCorsOrigin', () => {
    it('allows requests with no Origin (curl, Electron, native, navigations)', () => {
        expect(evaluateCorsOrigin(undefined, 'localhost:4001')).toEqual({
            allowed: true, reason: 'no-origin',
        });
    });

    it.each([
        'http://localhost:5173',
        'http://127.0.0.1:4001',
        'http://[::1]:4001',
        'http://127.0.0.2:4001',
    ])('allows loopback origin %s', (origin) => {
        expect(evaluateCorsOrigin(origin, 'localhost:4001').allowed).toBe(true);
    });

    // The prefix test `hostname.startsWith('127.')` treated these as loopback.
    // "127" is a legal DNS label, so anyone who owns a domain can serve a page
    // from one of these, and the middleware answers allowed origins with
    // credentials:true - which would have made GET /api/config (API keys and
    // workspace paths) readable cross-origin, and PUT /api/config callable.
    it.each([
        'http://127.attacker.com',
        'https://127.0.0.1.attacker.com',
        'http://127.evil.test:8080',
        'http://127x0x0x1',
        'http://notlocalhost.com',
    ])('rejects lookalike loopback origin %s', (origin) => {
        expect(evaluateCorsOrigin(origin, 'localhost:4001')).toEqual({
            allowed: false, reason: 'cross-origin',
        });
    });

    it('rejects an origin the URL parser itself will not accept', () => {
        // 1270.0.0.1 is neither a valid IPv4 literal nor a valid host.
        expect(evaluateCorsOrigin('http://1270.0.0.1', 'localhost:4001')).toEqual({
            allowed: false, reason: 'malformed',
        });
    });

    it.each([
        'http://127.0.0.1:4001',
        'http://127.0.0.2:4001',
        'http://127.255.255.254:4001',
        'http://app.localhost:5173',
        // Trailing-dot FQDN form: the URL parser normalizes it to 127.0.0.1.
        'http://127.0.0.1.:4001',
    ])('still allows genuine loopback origin %s', (origin) => {
        expect(evaluateCorsOrigin(origin, 'localhost:4001')).toEqual({
            allowed: true, reason: 'loopback',
        });
    });

    it('allows the tunnel page requesting its own assets (Origin === Host)', () => {
        const d = evaluateCorsOrigin(TUNNEL, TUNNEL_HOST);
        expect(d).toEqual({ allowed: true, reason: 'same-origin' });
    });

    it('is case-insensitive when matching Origin against Host', () => {
        expect(evaluateCorsOrigin(TUNNEL, TUNNEL_HOST.toUpperCase()).allowed).toBe(true);
    });

    it('allows the active tunnel origin even if Host was rewritten en route', () => {
        const d = evaluateCorsOrigin(TUNNEL, 'localhost:4001', TUNNEL);
        expect(d).toEqual({ allowed: true, reason: 'tunnel-origin' });
    });

    it('rejects a different ngrok domain — a tunnel host is not a free pass', () => {
        const d = evaluateCorsOrigin('https://attacker.ngrok-free.dev', TUNNEL_HOST, TUNNEL);
        expect(d).toEqual({ allowed: false, reason: 'cross-origin' });
    });

    it('rejects an http:// origin on the tunnel host — ngrok serves https only', () => {
        // The tunnel-origin branch used to compare bare hosts, so a downgraded
        // or MITM-injected plaintext page on the very same hostname matched and
        // was handed the credentialed CORS headers meant for the real tunnel.
        const d = evaluateCorsOrigin(`http://${TUNNEL_HOST}`, 'localhost:4001', TUNNEL);
        expect(d).toEqual({ allowed: false, reason: 'cross-origin' });
    });

    it('rejects an unrelated cross-origin site', () => {
        expect(evaluateCorsOrigin('https://evil.example', 'localhost:4001').allowed).toBe(false);
    });

    it('rejects a malformed Origin instead of throwing', () => {
        expect(evaluateCorsOrigin('not a url', 'localhost:4001')).toEqual({
            allowed: false, reason: 'malformed',
        });
    });

    it('ignores a malformed tunnel URL rather than throwing', () => {
        expect(evaluateCorsOrigin('https://evil.example', 'localhost:4001', '::::').allowed).toBe(false);
    });

    it('handles a null tunnel URL (tunnel not started)', () => {
        expect(evaluateCorsOrigin('https://evil.example', 'localhost:4001', null).allowed).toBe(false);
    });

    it('treats a missing Host header as non-matching rather than allowing', () => {
        expect(evaluateCorsOrigin(TUNNEL, undefined).allowed).toBe(false);
    });

    it('exports the marker the error middleware keys on', () => {
        expect(CORS_REJECTED).toBe('CORS: origin not allowed');
    });
});
