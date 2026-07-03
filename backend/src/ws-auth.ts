/**
 * WebSocket connection auth decision — the exact mirror of the REST tunnel-auth
 * gate (see tunnel-auth.ts), factored into a pure function so it is unit-testable
 * without a live socket.
 *
 * THE HOLE THIS CLOSES:
 * Previously the WS upgrade path only ran token validation when the client set
 * `mobile=1`. A client that connected to `/ws?token=<anything>` WITHOUT
 * `mobile=1` passed the upgrade gate (it merely checked a token was *present*)
 * and was then handled as a FULL DESKTOP CLIENT with NO validation. Over the
 * public tunnel that means an unauthenticated attacker with the tunnel URL got
 * full desktop control — spawn tasks (RCE), send input, stop tasks, read output.
 *
 * SECURITY MODEL (identical to createTunnelAuthMiddleware):
 *   • The gate keys on server-side state the requester cannot forge — whether a
 *     public tunnel is ACTIVE — NOT on the Host header (ngrok/localtunnel forward
 *     the client-supplied Host verbatim, so it is attacker-controlled and fails
 *     open for every value it doesn't recognise).
 *   • No tunnel active  → server only reachable over loopback → tokenless local
 *     connections are allowed (this keeps the local desktop UI working).
 *   • Tunnel active      → server is remotely reachable → require a VALID token
 *     for EVERY connection, regardless of the `mobile` flag or the Host claimed.
 *   • Belt-and-suspenders: also require a token when the Host *looks* like a
 *     tunnel domain, to cover a tunnel the app did not create (e.g. an operator
 *     running `ngrok http 4001` after startup) that isTunnelActive() would miss.
 *     Adding the Host check can only ADD enforcement, never remove it.
 */

export interface WebSocketAuthInput {
    /** Token from the `?token=` query param, or undefined if absent. */
    token: string | undefined;
    /** The request Host header (may be attacker-controlled over a tunnel). */
    host: string;
    /** Whether a public tunnel is currently active — non-spoofable server state. */
    isTunnelActive: boolean;
}

export interface WebSocketAuthDeps {
    /** Validates a candidate token — wire to tunnelManager.validateToken(). */
    validateToken: (token: string) => boolean;
    /** Returns true when a host string looks like a public tunnel domain. */
    isTunnelHost: (host: string) => boolean;
}

export interface WebSocketAuthDecision {
    allowed: boolean;
    /** Human-readable reason, for logging. */
    reason: string;
}

/**
 * Decide whether a WebSocket connection may be accepted.
 *
 * Returns `{ allowed: true }` for tokenless local connections when no tunnel is
 * active, and requires a valid token whenever the server is (or looks) remotely
 * reachable. Fail-closed: an unknown/spoofed Host while a tunnel is active still
 * faces the token check.
 */
export function decideWebSocketAuth(
    input: WebSocketAuthInput,
    deps: WebSocketAuthDeps,
): WebSocketAuthDecision {
    const reachableRemotely = input.isTunnelActive || deps.isTunnelHost(input.host);

    if (!reachableRemotely) {
        // Only reachable over loopback → nothing to protect. Allow tokenless so
        // the local desktop UI (which connects without a token) keeps working.
        return { allowed: true, reason: 'local-only: no tunnel active and non-tunnel Host' };
    }

    const token = input.token;
    if (!token || !deps.validateToken(token)) {
        return { allowed: false, reason: 'remotely reachable: missing or invalid token' };
    }

    return { allowed: true, reason: 'remotely reachable: valid token' };
}
