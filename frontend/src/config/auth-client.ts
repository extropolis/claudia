/**
 * The SPA's half of mandatory API authentication.
 *
 * Every `/api` route and every WebSocket upgrade on the backend now requires a
 * token (see backend/src/auth-token.ts). Before this, `/api/*` was authenticated
 * only when the request's Host header matched a tunnel substring, so the SPA
 * never had to think about credentials on localhost or on a LAN address — and
 * neither did anyone else who could reach the port.
 *
 * Three ways the SPA gets a token, in the order they are tried:
 *
 *  1. `?token=` in the page URL. This is what the mobile QR flow already hands
 *     out and what Electron appends when it launches the window, so both keep
 *     working unchanged.
 *  2. `sessionStorage`, so a reload inside one tab does not re-bootstrap.
 *  3. `GET /api/auth/local` — the loopback bootstrap. The backend serves the
 *     token only to a caller whose SOCKET is loopback, so this succeeds for a
 *     browser on the same machine and fails for everyone else. That is what
 *     keeps `./start.sh` + open-a-browser working with no copy-paste.
 *
 * If all three fail the SPA has no credential and every request will 401; the
 * app surfaces that through the existing mobile-access/token UI rather than a
 * second, parallel prompt.
 *
 * WHY sessionStorage AND NOT localStorage: the token is a full-authority
 * credential. Scoping it to the tab means closing the tab drops it, and a
 * shared/kiosk browser does not leave it behind for the next person.
 */
import { getApiBaseUrl } from './api-config';

/** Header the backend reads. Also accepts Authorization: Bearer and ?token=. */
export const TOKEN_HEADER = 'x-claudia-token';

const STORAGE_KEY = 'claudia.authToken';

let token: string | null = null;

/** Read the token from the page URL, if the launcher put one there. */
function tokenFromUrl(): string | null {
    try {
        const fromQuery = new URLSearchParams(window.location.search).get('token');
        return fromQuery && fromQuery.trim() ? fromQuery.trim() : null;
    } catch {
        return null;
    }
}

function readStored(): string | null {
    try {
        const v = window.sessionStorage.getItem(STORAGE_KEY);
        return v && v.trim() ? v : null;
    } catch {
        // Private mode / storage disabled — the in-memory copy still works for
        // the life of this page.
        return null;
    }
}

function writeStored(value: string): void {
    try {
        window.sessionStorage.setItem(STORAGE_KEY, value);
    } catch {
        // Non-fatal: see readStored().
    }
}

/** The token this page will present, or null if it has none yet. */
export function getAuthToken(): string | null {
    if (token) return token;
    token = tokenFromUrl() ?? readStored();
    if (token) writeStored(token);
    return token;
}

/** Adopt a token (from the bootstrap, or from a user-supplied prompt). */
export function setAuthToken(value: string): void {
    token = value.trim();
    writeStored(token);
}

/** Forget the token — used when the backend rejects it, so the UI can re-prompt. */
export function clearAuthToken(): void {
    token = null;
    try { window.sessionStorage.removeItem(STORAGE_KEY); } catch { /* see readStored() */ }
}

/**
 * Ask the backend for the token, which it grants only to a loopback caller.
 *
 * Returns the token on success and null on refusal (403) or any error. A
 * refusal is the expected, correct answer when the SPA is loaded from a phone
 * or another machine — that client must have been given a token another way.
 */
export async function fetchLocalToken(fetchImpl: typeof fetch = fetch): Promise<string | null> {
    try {
        const res = await fetchImpl(`${getApiBaseUrl()}/api/auth/local`);
        if (!res.ok) return null;
        const body = await res.json() as { token?: string };
        return body?.token?.trim() || null;
    } catch {
        return null;
    }
}

/**
 * Establish a credential before the app makes its first request.
 *
 * Resolves to true when the page holds a token afterwards. It does not throw:
 * a SPA with no token still renders, and the app shows the token prompt.
 */
export async function bootstrapAuth(fetchImpl: typeof fetch = fetch): Promise<boolean> {
    if (getAuthToken()) return true;
    const local = await fetchLocalToken(fetchImpl);
    if (local) {
        setAuthToken(local);
        return true;
    }
    return false;
}

/** Does this URL address the Claudia backend (and therefore need the token)? */
export function targetsBackend(input: string): boolean {
    try {
        const target = new URL(input, window.location.href);
        // Same-origin relative paths ("/api/tasks") resolve to the page origin,
        // which IS the backend when it proxies the SPA (tunnel, production).
        if (target.origin === window.location.origin) return true;
        return target.origin === new URL(getApiBaseUrl()).origin;
    } catch {
        return false;
    }
}

/**
 * Attach the token to every backend request the app makes.
 *
 * This is deliberately one wrapper rather than a change at ~100 `fetch()` call
 * sites: those call sites are spread across every component, and a per-site
 * change would silently miss the next one somebody writes. Requests to
 * anywhere else (Deepgram, ElevenLabs, an update feed) are passed through
 * untouched so the credential never leaves the backend's origin.
 *
 * Idempotent — calling it twice does not double-wrap.
 */
let installed = false;

export function installAuthFetch(): void {
    if (installed) return;
    installed = true;

    const original = window.fetch.bind(window);

    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const value = getAuthToken();
        if (!value) return original(input as RequestInfo, init);

        const url = typeof input === 'string' ? input
            : input instanceof URL ? input.toString()
            : input.url;
        if (!targetsBackend(url)) return original(input as RequestInfo, init);

        const headers = new Headers(
            init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined),
        );
        if (!headers.has(TOKEN_HEADER)) headers.set(TOKEN_HEADER, value);
        return original(input as RequestInfo, { ...init, headers });
    }) as typeof window.fetch;
}

/** Undo installAuthFetch. Tests only. */
export function __resetAuthFetchForTests(original?: typeof fetch): void {
    installed = false;
    token = null;
    if (original) window.fetch = original;
}
