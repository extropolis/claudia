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
 * True when the frontend is served by the backend (same origin).
 * This is the case for Docker, devVM, or any production deployment where
 * the built frontend is served via CLAUDIA_FRONTEND_DIR.
 * In dev mode, Vite serves on a separate port (5173).
 */
function isSameOriginServing(): boolean {
    const pagePort = parseInt(window.location.port, 10) || (window.location.protocol === 'https:' ? 443 : 80);
    return pagePort !== PORTS.FRONTEND;
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

    // Tunnel access or same-origin serving (Docker, devVM) — backend is on the same origin
    if (isTunnelAccess() || isSameOriginServing()) {
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

    // Tunnel access or same-origin serving (Docker, devVM) — use same host, upgrade protocol
    if (isTunnelAccess() || isSameOriginServing()) {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const token = getMobileToken();
        const base = `${proto}//${window.location.host}`;
        return token ? `${base}?token=${token}&mobile=1` : base;
    }

    // Web environment - use hostname with configured port
    return `ws://${window.location.hostname}:${PORTS.BACKEND}`;
}

/**
 * Check if running in Electron
 * @returns true if in Electron, false otherwise
 */
export function isElectron(): boolean {
    return typeof window.electronAPI !== 'undefined';
}
