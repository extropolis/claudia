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
 * SECURITY — why the gate is keyed on "is a tunnel active", NOT on the Host
 * header:
 *
 * ngrok/localtunnel forward the CLIENT-SUPPLIED Host header to the local
 * server verbatim. An attacker hitting the public tunnel URL can therefore
 * send ANY Host header they like (`Host: localhost`, `Host: evil.com`,
 * `Host: ABC.NGROK.IO`, or none at all). So the Host header is fully
 * attacker-controlled and CANNOT be used to decide whether to enforce auth —
 * a Host-based gate fails OPEN for every value it doesn't recognise.
 *
 * Instead we gate on server-side state the attacker cannot influence: whether
 * a public tunnel is currently ACTIVE.
 *   • No tunnel active  → the server is only reachable over loopback, so the
 *     protected endpoints cannot be hit remotely at all. Passing through
 *     unauthenticated is safe (and keeps the local desktop UI working).
 *   • Tunnel active      → the endpoints ARE remotely reachable, so we require
 *     a valid session token for EVERY request to a protected prefix,
 *     regardless of Host. Spoofing `Host: localhost` no longer helps — the
 *     token check still runs and an attacker without the token gets a 401.
 *     This is fail-closed.
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

/**
 * Hosts that indicate the request arrived via the public tunnel.
 *
 * NOTE: this is NOT used to gate auth (the Host header is attacker-controlled
 * over the tunnel — see the module header). It is only used for non-security
 * routing decisions (e.g. whether to reverse-proxy the frontend). Lowercased
 * before matching so `ABC.NGROK.IO` is still recognised (defense in depth).
 */
export function isTunnelHost(host: string): boolean {
    const h = host.toLowerCase();
    return h.includes('.loca.lt') || h.includes('localtunnel') ||
           h.includes('.ngrok-free.app') || h.includes('.ngrok.io') || h.includes('ngrok');
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
    /**
     * Returns true when a public tunnel is currently active, i.e. the server
     * is remotely reachable. Wire to `() => tunnelManager.getStatus().active`.
     * This is server-side state the requester cannot forge — unlike the Host
     * header — which is why the gate keys on it.
     */
    isTunnelActive: () => boolean;
    /** Path prefixes to protect. Defaults to TUNNEL_PROTECTED_API_PREFIXES. */
    protectedPrefixes?: string[];
}

/**
 * Express middleware factory. Mirrors the WS-upgrade validation: while a
 * public tunnel is active, every request to a protected API prefix must carry
 * a token that `validateToken` accepts — regardless of the request's Host
 * header — otherwise it gets a 401. When no tunnel is active the server is
 * only reachable over loopback, so requests pass through untouched.
 */
export function createTunnelAuthMiddleware(options: TunnelAuthOptions) {
    const prefixes = options.protectedPrefixes ?? TUNNEL_PROTECTED_API_PREFIXES;

    return (req: TunnelAuthRequest, res: TunnelAuthResponse, next: () => void): void => {
        // Enforce whenever the server may be remotely reachable. The primary
        // signal is the non-spoofable server-side tunnel state. We ALSO enforce
        // when the Host looks like a tunnel domain — belt-and-suspenders for a
        // tunnel the app did NOT create (e.g. an operator running
        // `ngrok http 4001` after startup), which isTunnelActive() would miss.
        // Adding the Host check can only ADD enforcement, never remove it, so it
        // introduces no bypass: a spoofed non-tunnel Host still faces the
        // isTunnelActive() gate, and while a tunnel is active every protected
        // request is gated regardless of Host.
        const host = typeof req.headers.host === 'string' ? req.headers.host : '';
        if (!options.isTunnelActive() && !isTunnelHost(host)) {
            // Not remotely reachable → only reachable locally → nothing to protect.
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

        // Tunnel is active AND this is a protected prefix: require a valid
        // token for ALL callers, whatever Host they claim. Fail-closed.
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
