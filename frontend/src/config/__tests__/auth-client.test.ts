/**
 * The SPA's half of mandatory API authentication.
 *
 * THE BUG THIS EXISTS FOR. The backend used to require a token on /api/* only
 * when the Host header matched a tunnel substring, so the SPA never needed a
 * credential on localhost or on a LAN address — and neither did anyone else who
 * could reach the port. Now every /api route and every WebSocket upgrade needs
 * one, which means the SPA has to acquire it and attach it to every request.
 *
 * The wrapper is the load-bearing part: there are ~100 fetch() call sites
 * across the components, and per-site changes would silently miss the next one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    getAuthToken,
    setAuthToken,
    clearAuthToken,
    fetchLocalToken,
    bootstrapAuth,
    targetsBackend,
    installAuthFetch,
    __resetAuthFetchForTests,
    TOKEN_HEADER,
} from '../auth-client';

const REAL_FETCH = window.fetch;

function setLocation(partial: Record<string, unknown>) {
    Object.defineProperty(window, 'location', {
        value: {
            hostname: 'localhost',
            host: 'localhost:5173',
            origin: 'http://localhost:5173',
            href: 'http://localhost:5173/',
            protocol: 'http:',
            search: '',
            ...partial,
        },
        configurable: true,
        writable: true,
    });
}

beforeEach(() => {
    __resetAuthFetchForTests(REAL_FETCH);
    window.sessionStorage.clear();
    delete (window as any).electronAPI;
    setLocation({});
});

afterEach(() => {
    __resetAuthFetchForTests(REAL_FETCH);
    window.sessionStorage.clear();
});

describe('getAuthToken', () => {
    it('has no token by default', () => {
        expect(getAuthToken()).toBeNull();
    });

    it('picks the token out of the page URL (Electron, the mobile QR link)', () => {
        setLocation({ search: '?token=abc123' });
        expect(getAuthToken()).toBe('abc123');
    });

    it('persists a URL token to sessionStorage so a reload keeps it', () => {
        setLocation({ search: '?token=abc123' });
        getAuthToken();
        __resetAuthFetchForTests();
        setLocation({ search: '' });
        expect(getAuthToken()).toBe('abc123');
    });

    it('ignores an empty ?token=', () => {
        setLocation({ search: '?token=' });
        expect(getAuthToken()).toBeNull();
    });

    it('is cleared on demand, in memory and in storage', () => {
        setAuthToken('abc123');
        expect(getAuthToken()).toBe('abc123');
        clearAuthToken();
        expect(getAuthToken()).toBeNull();
        expect(window.sessionStorage.getItem('claudia.authToken')).toBeNull();
    });

    it('trims what it is given', () => {
        setAuthToken('  spaced  ');
        expect(getAuthToken()).toBe('spaced');
    });
});

describe('fetchLocalToken', () => {
    it('returns the token the loopback bootstrap grants', async () => {
        const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ token: 'tok-local' }) });
        expect(await fetchLocalToken(f as unknown as typeof fetch)).toBe('tok-local');
        expect(String(f.mock.calls[0][0])).toContain('/api/auth/local');
    });

    it('returns null on a 403 — the expected answer from another device', async () => {
        const f = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
        expect(await fetchLocalToken(f as unknown as typeof fetch)).toBeNull();
    });

    it('returns null rather than throwing when the backend is unreachable', async () => {
        const f = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
        await expect(fetchLocalToken(f as unknown as typeof fetch)).resolves.toBeNull();
    });
});

describe('bootstrapAuth', () => {
    it('keeps a token it already has and does not call the backend', async () => {
        setAuthToken('already-have-one');
        const f = vi.fn();
        expect(await bootstrapAuth(f as unknown as typeof fetch)).toBe(true);
        expect(f).not.toHaveBeenCalled();
    });

    it('adopts the token from the loopback bootstrap', async () => {
        const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ token: 'tok-local' }) });
        expect(await bootstrapAuth(f as unknown as typeof fetch)).toBe(true);
        expect(getAuthToken()).toBe('tok-local');
    });

    it('reports failure without throwing when the bootstrap refuses', async () => {
        const f = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
        expect(await bootstrapAuth(f as unknown as typeof fetch)).toBe(false);
        expect(getAuthToken()).toBeNull();
    });
});

describe('targetsBackend', () => {
    it('claims same-origin paths (the backend proxies the SPA through a tunnel)', () => {
        expect(targetsBackend('/api/tasks')).toBe(true);
        expect(targetsBackend('http://localhost:5173/api/tasks')).toBe(true);
    });

    it('claims the configured backend port', () => {
        expect(targetsBackend('http://localhost:4001/api/tasks')).toBe(true);
    });

    it('does NOT claim third-party origins — the token must not leak', () => {
        expect(targetsBackend('https://api.deepgram.com/v1/listen')).toBe(false);
        expect(targetsBackend('https://api.elevenlabs.io/v1/tts')).toBe(false);
        expect(targetsBackend('https://evil.example/collect')).toBe(false);
    });
});

describe('installAuthFetch', () => {
    it('attaches the token to backend requests', async () => {
        const spy = vi.fn().mockResolvedValue(new Response('{}'));
        window.fetch = spy as unknown as typeof fetch;
        setAuthToken('tok-abc');
        installAuthFetch();

        await window.fetch('/api/tasks');

        const init = spy.mock.calls[0][1] as RequestInit;
        expect(new Headers(init.headers).get(TOKEN_HEADER)).toBe('tok-abc');
    });

    it('does NOT attach the token to a third-party request', async () => {
        const spy = vi.fn().mockResolvedValue(new Response('{}'));
        window.fetch = spy as unknown as typeof fetch;
        setAuthToken('tok-abc');
        installAuthFetch();

        await window.fetch('https://api.deepgram.com/v1/listen');

        const init = spy.mock.calls[0][1] as RequestInit | undefined;
        expect(init?.headers && new Headers(init.headers).get(TOKEN_HEADER)).toBeFalsy();
    });

    it('preserves headers and options the caller set', async () => {
        const spy = vi.fn().mockResolvedValue(new Response('{}'));
        window.fetch = spy as unknown as typeof fetch;
        setAuthToken('tok-abc');
        installAuthFetch();

        await window.fetch('/api/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{"a":1}',
        });

        const init = spy.mock.calls[0][1] as RequestInit;
        const headers = new Headers(init.headers);
        expect(init.method).toBe('POST');
        expect(init.body).toBe('{"a":1}');
        expect(headers.get('Content-Type')).toBe('application/json');
        expect(headers.get(TOKEN_HEADER)).toBe('tok-abc');
    });

    it('does not override a token the caller supplied explicitly', async () => {
        const spy = vi.fn().mockResolvedValue(new Response('{}'));
        window.fetch = spy as unknown as typeof fetch;
        setAuthToken('tok-abc');
        installAuthFetch();

        await window.fetch('/api/tasks', { headers: { [TOKEN_HEADER]: 'caller-token' } });

        const init = spy.mock.calls[0][1] as RequestInit;
        expect(new Headers(init.headers).get(TOKEN_HEADER)).toBe('caller-token');
    });

    it('passes requests straight through when there is no token', async () => {
        const spy = vi.fn().mockResolvedValue(new Response('{}'));
        window.fetch = spy as unknown as typeof fetch;
        installAuthFetch();

        await window.fetch('/api/tasks');

        expect(spy.mock.calls[0][1]).toBeUndefined();
    });

    it('is idempotent — a second install does not double-wrap', async () => {
        const spy = vi.fn().mockResolvedValue(new Response('{}'));
        window.fetch = spy as unknown as typeof fetch;
        setAuthToken('tok-abc');
        installAuthFetch();
        const afterFirst = window.fetch;
        installAuthFetch();
        expect(window.fetch).toBe(afterFirst);
    });
});
