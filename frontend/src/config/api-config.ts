/// <reference types="vite/client" />
/** One backend origin for browsers and native desktop clients. */
import { PORTS } from '@claudia/shared';
import { getAuthToken } from './auth-client';

export function getMobileToken(): string | null {
    return getAuthToken();
}

export function getApiBaseUrl(): string {
    if (window.electronAPI) return new URL(window.electronAPI.getBackendUrl()).origin;
    // Only the local Vite development page uses a separate API port.
    const page = new URL(window.location.origin);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(page.hostname);
    if (import.meta.env.DEV && local && page.port === String(PORTS.FRONTEND)) {
        page.port = String(PORTS.BACKEND);
    }
    return page.origin;
}

export function getWebSocketUrl(): string {
    const url = new URL(getApiBaseUrl());
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = getAuthToken();
    if (token) url.searchParams.set('token', token);
    return url.toString();
}

export function isElectron(): boolean {
    return typeof window.electronAPI !== 'undefined';
}
