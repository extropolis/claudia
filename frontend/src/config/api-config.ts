/**
 * API Configuration - Centralized URL management for backend API
 * Supports both web (development/production) and Electron environments.
 * When accessed via a localtunnel (e.g. mobile over the internet), the
 * backend reverse-proxies the frontend on the same origin, so we use
 * same-origin URLs instead of pointing at a separate port.
 */
import { PORTS } from '@claudia/shared';
import { getAuthToken } from './auth-client';

/**
 * True when the page was loaded through a tunnel proxy (ngrok, localtunnel, etc.)
 *
 * ROUTING ONLY. This decides whether the API lives on the page's own origin
 * (the backend reverse-proxies the SPA through the tunnel) or on a separate
 * port. It MUST NOT be consulted for authentication: this was one of four
 * copies of the same hostname substring list, and the backend used its copy to
 * decide whether `/api/*` needed a token at all — so a LAN IP, a Tailscale
 * name or a custom domain got no auth. Authentication is now unconditional and
 * lives in auth-client.ts, which never looks at the hostname.
 */
export function isTunnelAccess(): boolean {
    const host = window.location.hostname;
    return host.includes('.loca.lt') || host.includes('localtunnel') ||
           host.includes('.ngrok-free.app') || host.includes('.ngrok.io') || host.includes('ngrok');
}

/**
 * Get the auth token from the URL query string.
 *
 * Set by the tunnel redirect, by the mobile QR link, and by Electron when it
 * launches the window. Named "mobile" for historical reasons; it is the one
 * API credential, not a mobile-specific one.
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
        return withWsToken(httpUrl.replace('http://', 'ws://'));
    }

    // Tunnel access — use same host, upgrade protocol
    if (isTunnelAccess()) {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const base = `${proto}//${window.location.host}`;
        // `mobile=1` is a label for server-side logging and client attribution.
        // It is NOT what authenticates the socket — the token is. It used to be
        // the other way round: an upgrade saying mobile=1 skipped the token
        // check entirely.
        return withWsToken(`${base}?mobile=1`);
    }

    // Web environment - use hostname with configured port
    return withWsToken(`ws://${window.location.hostname}:${PORTS.BACKEND}`);
}

/**
 * Append the API token to a WebSocket URL.
 *
 * Every upgrade is authenticated now, including on localhost — a browser
 * cannot set headers on a WebSocket handshake, so the query string is the only
 * place the credential can ride. Call this at CONNECT time, never at module
 * load: the token may only arrive after the loopback bootstrap resolves.
 */
function withWsToken(url: string): string {
    const token = getAuthToken();
    if (!token) return url;
    return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

/**
 * Check if running in Electron
 * @returns true if in Electron, false otherwise
 */
export function isElectron(): boolean {
    return typeof window.electronAPI !== 'undefined';
}
