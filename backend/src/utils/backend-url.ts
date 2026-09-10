/**
 * Derive the HTTP base URL for REST calls from a backend WebSocket URL.
 *
 * `ws://` → `http://`, `wss://` → `https://`. The host and port are preserved
 * exactly as given — the CLI's `--url` flag must reach the same host for HTTP
 * as it does for WebSocket, so nothing here forces a default port. A trailing
 * slash is stripped so callers can append `/api/...` paths directly.
 */
export function httpBaseFromWsUrl(wsUrl: string): string {
    return wsUrl
        .trim()
        .replace(/^ws:\/\//i, 'http://')
        .replace(/^wss:\/\//i, 'https://')
        .replace(/\/+$/, '');
}
