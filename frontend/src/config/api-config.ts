/**
 * API Configuration - Centralized URL management for backend API
 * Supports both web (development/production) and Electron environments.
 * When accessed via a localtunnel (e.g. mobile over the internet), the
 * backend reverse-proxies the frontend on the same origin, so we use
 * same-origin URLs instead of pointing at a separate port.
 */
import { PORTS } from '@claudia/shared';

/** True when the page was loaded through a tunnel proxy (ngrok, localtunnel, etc.) */
export function isTunnelAccess(): boolean {
    const host = window.location.hostname;
    return host.includes('.loca.lt') || host.includes('localtunnel') ||
           host.includes('.ngrok-free.app') || host.includes('.ngrok.io') || host.includes('ngrok');
}

/**
 * Get the mobile auth token from the URL query string (set by tunnel redirect)
 */
export function getMobileToken(): string | null {
    const params = new URLSearchParams(window.location.search);
    return params.get('token');
}

/**
 * Get the base URL for HTTP API requests
 * @returns Base URL (e.g., "http://localhost:3001")
 */
export function getApiBaseUrl(): string {
    // Check if running in Electron
    if (window.electronAPI) {
        return window.electronAPI.getBackendUrl();
    }

    // Tunnel access — backend is on the same origin (it proxies the frontend)
    if (isTunnelAccess()) {
        return window.location.origin;
    }

    // Web environment - use hostname with configured port
    return `http://${window.location.hostname}:${PORTS.BACKEND}`;
}

/**
 * Get the WebSocket URL
 * @returns WebSocket URL (e.g., "ws://localhost:3001")
 */
export function getWebSocketUrl(): string {
    // Check if running in Electron
    if (window.electronAPI) {
        const httpUrl = window.electronAPI.getBackendUrl();
        return httpUrl.replace('http://', 'ws://');
    }

    // Tunnel access — use same host, upgrade protocol
    if (isTunnelAccess()) {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const token = getMobileToken();
        const base = `${proto}//${window.location.host}`;
        // Append mobile token so the backend accepts the WebSocket connection
        return token ? `${base}?token=${token}&mobile=1` : base;
    }

    // Web environment - use hostname with configured port
    return `ws://${window.location.hostname}:${PORTS.BACKEND}`;
}

/**
 * Resolve the WebSocket URL, attaching an auth token when the backend requires
 * one.
 *
 * The local desktop UI connects tokenless — UNLESS a public tunnel is active.
 * Once a tunnel is up the backend is remotely reachable and requires a valid
 * session token on EVERY WebSocket (see decideWebSocketAuth in the backend), so
 * a plain tokenless local connection would be rejected. We fetch the real token
 * from /api/tunnel/status (served only to local requests) and append it.
 *
 * Tunnel-origin pages already carry their token in the page URL, so
 * getWebSocketUrl() has already embedded it there and we leave those untouched.
 *
 * Because this runs on every (re)connect attempt, a local connection that drops
 * and reconnects while a tunnel is active automatically picks up the token.
 */
export async function getAuthenticatedWebSocketUrl(): Promise<string> {
    const base = getWebSocketUrl();

    // Tunnel-origin pages: token (if any) is already in the URL via getWebSocketUrl().
    if (isTunnelAccess()) return base;
    // Already tokenized (shouldn't happen for local, but be safe).
    if (base.includes('token=')) return base;

    // Local/Electron: only need a token when a tunnel is currently active.
    try {
        const res = await fetch(`${getApiBaseUrl()}/api/tunnel/status`);
        if (!res.ok) return base;
        const data = (await res.json()) as { active?: boolean; token?: string | null };
        if (data.active && data.token) {
            const sep = base.includes('?') ? '&' : '?';
            return `${base}${sep}token=${encodeURIComponent(data.token)}`;
        }
    } catch {
        // No tunnel / status unreachable → tokenless is correct for local use.
    }
    return base;
}

/**
 * Check if running in Electron
 * @returns true if in Electron, false otherwise
 */
export function isElectron(): boolean {
    return typeof window.electronAPI !== 'undefined';
}
