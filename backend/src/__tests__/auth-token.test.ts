/**
 * Unit coverage for the API credential and the peer classifier.
 *
 * These are the two primitives every other auth decision is built on, so they
 * are tested directly rather than only through HTTP: an HTTP test cannot easily
 * produce a length-mismatched token or a read-only data directory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
    getAuthToken,
    validateAuthToken,
    safeEqual,
    authTokenPath,
    AUTH_TOKEN_FILENAME,
    __resetAuthTokenCacheForTests,
} from '../auth-token.js';
import {
    isLoopbackAddress,
    isLoopbackPeer,
    isTrustedProxyConfigured,
    isSecureRequest,
    TRUSTED_PROXY_ENV,
} from '../request-peer.js';

// Under homedir(), never os.tmpdir(): on macOS tmpdir resolves under /var,
// which validateWorkspacePath blocklists as a system path.
let dir: string;

beforeEach(() => {
    __resetAuthTokenCacheForTests();
    dir = mkdtempSync(join(homedir(), '.claudia-authtoken-test-'));
});

afterEach(() => {
    __resetAuthTokenCacheForTests();
    rmSync(dir, { recursive: true, force: true });
});

describe('getAuthToken', () => {
    it('mints 32 random bytes as hex and persists them 0600', () => {
        const token = getAuthToken(dir);
        expect(token).toMatch(/^[0-9a-f]{64}$/);

        const onDisk = readFileSync(join(dir, AUTH_TOKEN_FILENAME), 'utf-8');
        expect(onDisk).toBe(token);

        if (process.platform !== 'win32') {
            expect(statSync(join(dir, AUTH_TOKEN_FILENAME)).mode & 0o777).toBe(0o600);
        }
    });

    it('is stable across calls and across a cache reset (reads back from disk)', () => {
        const first = getAuthToken(dir);
        expect(getAuthToken(dir)).toBe(first);

        __resetAuthTokenCacheForTests();
        expect(getAuthToken(dir)).toBe(first);
    });

    it('mints a different token per data directory', () => {
        const other = mkdtempSync(join(homedir(), '.claudia-authtoken-test-'));
        try {
            expect(getAuthToken(dir)).not.toBe(getAuthToken(other));
        } finally {
            rmSync(other, { recursive: true, force: true });
        }
    });

    it('replaces a corrupt or truncated token file rather than trusting it', () => {
        writeFileSync(join(dir, AUTH_TOKEN_FILENAME), 'a');
        const token = getAuthToken(dir);
        expect(token).toMatch(/^[0-9a-f]{64}$/);
        expect(token).not.toBe('a');
        expect(readFileSync(join(dir, AUTH_TOKEN_FILENAME), 'utf-8')).toBe(token);
    });

    it('still serves a token when the file cannot be written', () => {
        // A directory that does not exist stands in for a read-only volume:
        // the write throws, and the token must still be returned in-memory.
        const missing = join(dir, 'no', 'such', 'dir');
        const token = getAuthToken(missing);
        expect(token).toMatch(/^[0-9a-f]{64}$/);
        expect(getAuthToken(missing)).toBe(token);
    });

    it('names the file inside the data directory', () => {
        expect(authTokenPath(dir)).toBe(join(dir, AUTH_TOKEN_FILENAME));
    });
});

describe('validateAuthToken', () => {
    it('accepts the real token', () => {
        expect(validateAuthToken(dir, getAuthToken(dir))).toBe(true);
    });

    it('rejects a wrong token of the same length without throwing', () => {
        getAuthToken(dir);
        expect(validateAuthToken(dir, 'f'.repeat(64))).toBe(false);
    });

    it('rejects a length mismatch without throwing (timingSafeEqual would)', () => {
        getAuthToken(dir);
        expect(() => validateAuthToken(dir, 'short')).not.toThrow();
        expect(validateAuthToken(dir, 'short')).toBe(false);
        expect(validateAuthToken(dir, 'x'.repeat(500))).toBe(false);
    });

    it('rejects empty, undefined and null', () => {
        getAuthToken(dir);
        expect(validateAuthToken(dir, '')).toBe(false);
        expect(validateAuthToken(dir, undefined)).toBe(false);
        expect(validateAuthToken(dir, null)).toBe(false);
    });
});

describe('safeEqual', () => {
    it('is true only for identical strings', () => {
        expect(safeEqual('abc', 'abc')).toBe(true);
        expect(safeEqual('abc', 'abd')).toBe(false);
    });

    it('handles a length mismatch without throwing', () => {
        expect(() => safeEqual('a', 'abcdef')).not.toThrow();
        expect(safeEqual('a', 'abcdef')).toBe(false);
    });

    it('is false when either side is missing', () => {
        expect(safeEqual(undefined, 'a')).toBe(false);
        expect(safeEqual('a', undefined)).toBe(false);
        expect(safeEqual('', '')).toBe(false);
        expect(safeEqual(null, null)).toBe(false);
    });
});

describe('isLoopbackAddress', () => {
    it('accepts every form of localhost the kernel hands us', () => {
        for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.1.2.3', 'localhost']) {
            expect(isLoopbackAddress(a), a).toBe(true);
        }
    });

    it('rejects LAN, Tailscale and public addresses', () => {
        for (const a of ['192.168.1.20', '10.0.0.5', '100.101.102.103', '203.0.113.9', '::ffff:10.0.0.5', '1270.0.0.1', '']) {
            expect(isLoopbackAddress(a), a).toBe(false);
        }
    });

    it('rejects undefined', () => {
        expect(isLoopbackAddress(undefined)).toBe(false);
    });
});

describe('isLoopbackPeer', () => {
    const env = (v?: string) => (v === undefined ? {} : { [TRUSTED_PROXY_ENV]: v });

    it('is decided by the socket, not by a header', () => {
        const spoofed = {
            socket: { remoteAddress: '192.168.1.50' },
            headers: { 'x-forwarded-for': '127.0.0.1' },
        };
        expect(isLoopbackPeer(spoofed, env())).toBe(false);
        expect(isLoopbackPeer(spoofed, env('1'))).toBe(false);
    });

    it('accepts a genuine loopback socket', () => {
        expect(isLoopbackPeer({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: {} }, env())).toBe(true);
    });

    it('refuses a forwarded request even when the socket really is loopback', () => {
        // THE CASE THIS EXISTS FOR: the ngrok agent runs on this machine, so
        // every request arriving over the public tunnel connects from
        // 127.0.0.1. Trusting the socket alone would serve /api/auth/local —
        // the API token — to the open internet.
        const forwarded = {
            socket: { remoteAddress: '127.0.0.1' },
            headers: { 'x-forwarded-for': '203.0.113.4' },
        };
        expect(isLoopbackPeer(forwarded, env('nginx'))).toBe(false);
        // And regardless of whether an operator declared a trusted proxy —
        // that setting governs whether we believe forwarded VALUES, not
        // whether a forwarded request is local.
        expect(isLoopbackPeer(forwarded, env())).toBe(false);
    });

    it('refuses the other forwarding headers too', () => {
        const base = { socket: { remoteAddress: '127.0.0.1' } };
        expect(isLoopbackPeer({ ...base, headers: { 'x-forwarded-host': 'x.ngrok.app' } }, env())).toBe(false);
        expect(isLoopbackPeer({ ...base, headers: { forwarded: 'for=203.0.113.4' } }, env())).toBe(false);
        expect(isLoopbackPeer({ ...base, headers: {} }, env())).toBe(true);
    });

    it('handles a request with no socket at all', () => {
        expect(isLoopbackPeer({}, env())).toBe(false);
    });
});

describe('isTrustedProxyConfigured', () => {
    it('is off by default and for falsy-looking values', () => {
        expect(isTrustedProxyConfigured({})).toBe(false);
        expect(isTrustedProxyConfigured({ [TRUSTED_PROXY_ENV]: '' })).toBe(false);
        expect(isTrustedProxyConfigured({ [TRUSTED_PROXY_ENV]: '  ' })).toBe(false);
        expect(isTrustedProxyConfigured({ [TRUSTED_PROXY_ENV]: '0' })).toBe(false);
        expect(isTrustedProxyConfigured({ [TRUSTED_PROXY_ENV]: 'false' })).toBe(false);
    });

    it('is on when an operator sets it', () => {
        expect(isTrustedProxyConfigured({ [TRUSTED_PROXY_ENV]: '1' })).toBe(true);
        expect(isTrustedProxyConfigured({ [TRUSTED_PROXY_ENV]: 'nginx' })).toBe(true);
    });
});

describe('isSecureRequest', () => {
    it('trusts the real protocol', () => {
        expect(isSecureRequest({ protocol: 'https', headers: {} }, {})).toBe(true);
        expect(isSecureRequest({ secure: true, headers: {} }, {})).toBe(true);
        expect(isSecureRequest({ protocol: 'http', headers: {} }, {})).toBe(false);
    });

    it('ignores X-Forwarded-Proto unless a trusted proxy is declared', () => {
        const req = { protocol: 'http', headers: { 'x-forwarded-proto': 'https' } };
        expect(isSecureRequest(req, {})).toBe(false);
        expect(isSecureRequest(req, { [TRUSTED_PROXY_ENV]: '1' })).toBe(true);
    });

    it('reads only the first hop of a multi-value X-Forwarded-Proto', () => {
        const trusted = { [TRUSTED_PROXY_ENV]: '1' };
        expect(isSecureRequest({ headers: { 'x-forwarded-proto': 'https,http' } }, trusted)).toBe(true);
        expect(isSecureRequest({ headers: { 'x-forwarded-proto': 'http,https' } }, trusted)).toBe(false);
        expect(isSecureRequest({ headers: { 'x-forwarded-proto': ['https'] } }, trusted)).toBe(true);
    });
});
