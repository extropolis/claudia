/**
 * Backend-scoped browser credentials. Local launchers may supply a query token;
 * remote clients paste one. Validate before mounting the app, remove credentials
 * from navigation URLs, and return to login when an API request is rejected.
 */
import { getApiBaseUrl } from './api-config';

/** Header the backend reads. Also accepts Authorization: Bearer and ?token=. */
export const TOKEN_HEADER = 'x-claudia-token';

const storageKey = () => `claudia.authToken:${getApiBaseUrl()}`;
export const AUTH_REQUIRED_EVENT = 'claudia:authRequired';
let tokenOrigin: string | null = null;
let consumedUrl = false;

let token: string | null = null;

/** Read the token from the page URL, if the launcher put one there. */
function tokenFromUrl(): string | null {
    try {
        if (consumedUrl) return null;
        consumedUrl = true;
        const params = new URLSearchParams(window.location.search);
        const fromQuery = params.get('token');
        if (params.has('token')) {
            params.delete('token');
            const query = params.toString();
            window.history.replaceState(null, '', `${window.location.pathname || '/'}${query ? '?' + query : ''}${window.location.hash || ''}`);
        }
        return fromQuery && fromQuery.trim() ? fromQuery.trim() : null;
    } catch {
        return null;
    }
}

function readStored(): string | null {
    try {
        const v = window.sessionStorage.getItem(storageKey());
        return v && v.trim() ? v : null;
    } catch {
        // Private mode / storage disabled — the in-memory copy still works for
        // the life of this page.
        return null;
    }
}

function writeStored(value: string): void {
    try {
        window.sessionStorage.setItem(storageKey(), value);
    } catch {
        // Non-fatal: see readStored().
    }
}

/** The token this page will present, or null if it has none yet. */
export function getAuthToken(): string | null {
    const origin = getApiBaseUrl();
    if (tokenOrigin !== origin) { token = null; tokenOrigin = origin; }
    if (token) return token;
    token = tokenFromUrl() ?? readStored();
    if (token) writeStored(token);
    return token;
}

/** Adopt a token (from the bootstrap, or from a user-supplied prompt). */
export function setAuthToken(value: string): void {
    tokenOrigin = getApiBaseUrl();
    token = value.trim();
    writeStored(token);
}

/** Forget the token — used when the backend rejects it, so the UI can re-prompt. */
export function clearAuthToken(): void {
    token = null;
    try { window.sessionStorage.removeItem(storageKey()); } catch { /* see readStored() */ }
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
        const res = await fetchImpl(`${getApiBaseUrl()}/api/auth/local`, { signal: AbortSignal.timeout(8000) });
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
    if (getAuthToken()) return (await validateAuthToken(getAuthToken()!, fetchImpl)) === 'ok';
    const local = await fetchLocalToken(fetchImpl);
    if (local) {
        setAuthToken(local);
        return true;
    }
    return false;
}

/** Validate without fetching workspace data or opening a socket. */
export async function validateAuthToken(value: string, fetchImpl: typeof fetch = fetch): Promise<'ok' | 'rejected' | 'offline'> {
    try {
        const res = await fetchImpl(`${getApiBaseUrl()}/api/auth/check`, {
            headers: { [TOKEN_HEADER]: value }, signal: AbortSignal.timeout(8000),
        });
        if (res.status === 401) { clearAuthToken(); return 'rejected'; }
        if (!res.ok) return 'offline';
        const body = await res.json();
        return body.authenticated === true ? 'ok' : 'offline';
    } catch { return 'offline'; }
}

export async function logout(): Promise<void> {
    try { await fetch(`${getApiBaseUrl()}/api/auth/logout`, { method: 'POST', signal: AbortSignal.timeout(3000) }); }
    finally { clearAuthToken(); window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT)); }
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
        return original(input as RequestInfo, { ...init, headers }).then(res => {
            if (res.status === 401 && getAuthToken() === value) {
                clearAuthToken();
                window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
            }
            return res;
        });
    }) as typeof window.fetch;
}

/** Undo installAuthFetch. Tests only. */
export function __resetAuthFetchForTests(original?: typeof fetch): void {
    installed = false;
    token = null;
    tokenOrigin = null;
    consumedUrl = false;
    if (original) window.fetch = original;
}
