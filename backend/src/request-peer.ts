/**
 * Who is on the other end of a request — decided from the socket, not headers.
 *
 * Two decisions in the server depend on this, and both were previously made
 * inline with subtly different rules:
 *
 *  - Loopback bootstrap: `GET /api/auth/local` hands out the API token, so it
 *    must be certain the peer is really on this machine.
 *  - The Jira guard, which is localhost-only so a corporate token never leaves
 *    the box.
 *
 * The peer address comes from the kernel and cannot be forged by the client.
 * `req.ip` can: Express honors `X-Forwarded-For` whenever "trust proxy" is on,
 * and that header is a free-text field any client can set. A check that used it
 * would let `curl -H 'X-Forwarded-For: 127.0.0.1' http://box:4001/api/auth/local`
 * exfiltrate the credential from anywhere on the network.
 *
 * Forwarded headers are therefore honored only when `CLAUDIA_TRUSTED_PROXY` is
 * set, which is an operator asserting that a reverse proxy they control is the
 * only thing that can reach the port (#189). Even then they never make a
 * request loopback — a proxy hop means the real client is elsewhere by
 * definition.
 */

/** Env var by which an operator asserts a trusted reverse proxy is in front. */
export const TRUSTED_PROXY_ENV = 'CLAUDIA_TRUSTED_PROXY';

/** Is a reverse proxy in front of us that we are willing to believe? */
export function isTrustedProxyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
    const v = env[TRUSTED_PROXY_ENV];
    return typeof v === 'string' && v.trim() !== '' && v.trim() !== '0' && v.trim().toLowerCase() !== 'false';
}

/**
 * Is this raw socket address the local machine?
 *
 * Handles IPv4-mapped IPv6 (`::ffff:127.0.0.1`), IPv6 loopback, and the whole
 * 127.0.0.0/8 block — `127.0.0.1` is the common case but a client may legally
 * connect from any 127.x address.
 */
export function isLoopbackAddress(address: string | undefined | null): boolean {
    if (!address) return false;
    const norm = address.replace(/^::ffff:/, '').trim();
    if (norm === '::1' || norm === 'localhost') return true;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(norm);
}

/** Minimal shape shared by `express.Request` and a raw `http.IncomingMessage`. */
export interface PeerCarrier {
    socket?: { remoteAddress?: string | undefined } | null;
    headers?: Record<string, string | string[] | undefined>;
}

/**
 * Did this request originate on this machine?
 *
 * TWO conditions, and the second is the one that is easy to miss: the socket
 * peer must be loopback, AND the request must not have been forwarded.
 *
 * A forwarded request is never loopback even when the socket says 127.0.0.1,
 * because the header's presence is proof that the real client is a hop away.
 * This is not hypothetical — it is the normal case here. The ngrok agent runs
 * on this machine, so EVERY request arriving over the public tunnel connects
 * from 127.0.0.1. Treating the socket alone as sufficient would have served
 * `/api/auth/local` — the API token — to the open internet. The same reasoning
 * covers putting nginx or Caddy in front of Claudia.
 *
 * The header disqualifies regardless of `CLAUDIA_TRUSTED_PROXY`. That variable
 * governs whether we BELIEVE the forwarded values (see isSecureRequest); it
 * does not make a forwarded request local, and a client that sets the header
 * on a genuinely local request only ever loses access it would otherwise have.
 */
export function isLoopbackPeer(req: PeerCarrier, env: NodeJS.ProcessEnv = process.env): boolean {
    void env;
    if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
    const h = req.headers;
    if (h?.['x-forwarded-for'] || h?.['x-forwarded-host'] || h?.['forwarded']) return false;
    return true;
}

/**
 * Was this request delivered over TLS?
 *
 * Used only to decide whether to mark the auth cookie `Secure`. Marking it
 * Secure unconditionally means a browser silently discards it on a plain-http
 * LAN address — the exact deployment this change exists to protect — so the
 * flag follows the actual scheme.
 */
export function isSecureRequest(
    req: PeerCarrier & { secure?: boolean; protocol?: string },
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    if (req.protocol === 'https' || req.secure === true) return true;
    if (!isTrustedProxyConfigured(env)) return false;
    const proto = req.headers?.['x-forwarded-proto'];
    const first = Array.isArray(proto) ? proto[0] : proto;
    return typeof first === 'string' && first.split(',')[0].trim().toLowerCase() === 'https';
}
