/**
 * Tunnel auth middleware for sensitive REST endpoints.
 *
 * When the backend is exposed through the public tunnel (ngrok/localtunnel),
 * the mobile/voice REST API must require the same per-session token that the
 * WebSocket upgrade path already enforces (see the `isMobile` check in
 * server.ts). Without this, anyone who learns the public tunnel URL could
 * POST /api/mobile/chat (which can spawn arbitrary tasks → RCE), send input
 * to or stop any task, read chat transcripts, or fetch the Deepgram key.
 *
 * Local (non-tunnel) requests are unaffected: the middleware only activates
 * when the request's Host header matches a known tunnel domain.
 */

// Minimal structural types so this module is trivially unit-testable without
// pulling in Express's full Request/Response types.
export interface TunnelAuthRequest {
    headers: Record<string, string | string[] | undefined>;
    path?: string;
    query?: Record<string, unknown>;
}

export interface TunnelAuthResponse {
    status(code: number): TunnelAuthResponse;
    json(body: unknown): unknown;
}

/** Hosts that indicate the request arrived via the public tunnel. */
export function isTunnelHost(host: string): boolean {
    return host.includes('.loca.lt') || host.includes('localtunnel') ||
           host.includes('.ngrok-free.app') || host.includes('.ngrok.io') || host.includes('ngrok');
}

/**
 * Route prefixes that require a valid tunnel token when accessed via the
 * tunnel. All entries MUST be lowercase — the middleware lowercases the
 * request path before matching (Express routes case-insensitively, so a
 * mixed-case path like /API/MOBILE/chat still reaches the real handler and
 * would otherwise slip past a case-sensitive prefix check).
 *
 * '/api/voice/' has a trailing slash so it does NOT match '/api/voice-agent/'
 * — the latter is listed separately so its (persisted, security-sensitive)
 * system-prompt/tools routes are also gated over the tunnel.
 */
export const TUNNEL_PROTECTED_API_PREFIXES = [
    '/api/mobile/',
    '/api/voice/',
    '/api/voice-agent/',
];

/**
 * Pull the auth token off a request. Accepted (in priority order):
 *   1. `?token=...` query param — same convention as the WS upgrade path.
 *   2. `X-Claudia-Token` header.
 *   3. `Authorization: Bearer <token>` header.
 */
export function extractRequestToken(req: TunnelAuthRequest): string | undefined {
    const queryToken = req.query?.token;
    if (typeof queryToken === 'string' && queryToken) return queryToken;

    const headerToken = req.headers['x-claudia-token'];
    if (typeof headerToken === 'string' && headerToken) return headerToken;

    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
        const bearer = auth.slice(7).trim();
        if (bearer) return bearer;
    }
    return undefined;
}

export interface TunnelAuthOptions {
    /** Validates a candidate token — wire to tunnelManager.validateToken(). */
    validateToken: (token: string) => boolean;
    /** Overridable for tests. Defaults to isTunnelHost(). */
    isTunnelHost?: (host: string) => boolean;
    /** Path prefixes to protect. Defaults to TUNNEL_PROTECTED_API_PREFIXES. */
    protectedPrefixes?: string[];
}

/**
 * Express middleware factory. Mirrors the WS-upgrade validation: requests
 * arriving via the tunnel to a protected API prefix must carry a token that
 * `validateToken` accepts, otherwise they get a 401. Everything else passes
 * through untouched.
 */
export function createTunnelAuthMiddleware(options: TunnelAuthOptions) {
    const hostCheck = options.isTunnelHost ?? isTunnelHost;
    const prefixes = options.protectedPrefixes ?? TUNNEL_PROTECTED_API_PREFIXES;

    return (req: TunnelAuthRequest, res: TunnelAuthResponse, next: () => void): void => {
        const host = typeof req.headers.host === 'string' ? req.headers.host : '';
        if (!hostCheck(host)) {
            // Local request — keep working unchanged.
            next();
            return;
        }

        // Lowercase before matching: Express routing is case-insensitive by
        // default, so /API/MOBILE/chat reaches the real handler. A
        // case-sensitive startsWith would return false here and let that
        // request through with NO token check. `prefixes` are all lowercase.
        const path = (req.path ?? '').toLowerCase();
        if (!prefixes.some((p) => path.startsWith(p))) {
            next();
            return;
        }

        const token = extractRequestToken(req);
        if (!token || !options.validateToken(token)) {
            res.status(401).json({
                error: 'Access denied: missing or invalid tunnel token',
            });
            return;
        }
        next();
    };
}
