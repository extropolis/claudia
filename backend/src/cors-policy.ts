/**
 * Origin policy for the backend's CORS middleware.
 *
 * Claudia is local-first, so cross-origin browser traffic is rejected. The
 * subtlety that broke tunnel access (#tunnel-500): a *same-origin* request is
 * not always originless. A browser sends an `Origin` header for module
 * scripts (`<script type="module">`), `fetch()`, and preflights even when the
 * target is the very page's own origin. Over the tunnel that origin is
 * `https://<something>.ngrok-free.dev`, which the localhost-only allowlist
 * rejected — so every `/@vite/client`, `/src/main.tsx` and `/api/*` request
 * from the tunnel page died with a 500 and the app rendered a blank screen.
 *
 * The fix is to treat "Origin host equals the Host header" as same-origin and
 * allow it. That grants nothing to an attacker: browsers set `Origin`
 * themselves and a page on `https://evil.example` cannot forge the defender's
 * host into it. Non-browser callers (curl, native apps) send no Origin at all
 * and keep working as before.
 */

/**
 * Marker message on the Error handed to the `cors` callback, so the error
 * middleware can distinguish a policy rejection from a genuine server fault.
 */
export const CORS_REJECTED = 'CORS: origin not allowed';

export interface CorsOriginDecision {
    allowed: boolean;
    /** Why the decision went the way it did — logged on rejection. */
    reason: 'no-origin' | 'loopback' | 'same-origin' | 'tunnel-origin' | 'malformed' | 'cross-origin';
}

/** 127.0.0.0/8 — the whole IPv4 loopback block, and ONLY dotted-quad forms. */
const IPV4_LOOPBACK = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function hostnameIsLoopback(hostname: string): boolean {
    // URL parsing yields IPv6 hosts wrapped in brackets: [::1]
    const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    // NOT startsWith('127.'): "127" is a legal DNS label, so `127.attacker.com`
    // is a hostname anyone can register under a domain they own. With that
    // prefix test it was accepted as loopback, and since the middleware answers
    // allowed origins with credentials:true, a page there could read
    // /api/config — API keys and all — straight out of the browser.
    return bare === 'localhost'
        || bare.endsWith('.localhost')   // RFC 6761 reserves the whole zone for loopback
        || bare === '::1'
        || IPV4_LOOPBACK.test(bare);
}

/**
 * Decide whether a browser Origin may talk to this server.
 *
 * @param origin      The request's `Origin` header (undefined when absent).
 * @param host        The request's `Host` header — what the browser asked for.
 * @param tunnelUrl   The active tunnel's public URL, if any. Matching against
 *                    it covers the case where a proxy rewrote `Host` before the
 *                    request reached us, so `Origin === Host` no longer holds.
 */
export function evaluateCorsOrigin(
    origin: string | undefined,
    host: string | undefined,
    tunnelUrl?: string | null,
): CorsOriginDecision {
    // No Origin: same-origin navigation, curl, Electron, native clients.
    if (!origin) return { allowed: true, reason: 'no-origin' };

    let originUrl: URL;
    try {
        originUrl = new URL(origin);
    } catch {
        return { allowed: false, reason: 'malformed' };
    }

    if (hostnameIsLoopback(originUrl.hostname)) {
        return { allowed: true, reason: 'loopback' };
    }

    // Same-origin: the page is asking its own server for a subresource.
    if (host && originUrl.host.toLowerCase() === host.toLowerCase()) {
        return { allowed: true, reason: 'same-origin' };
    }

    // The active tunnel's own origin, even if Host was rewritten en route.
    // Compared as full origins (scheme included), not bare hosts: ngrok serves
    // the tunnel over https, so an `http://<same-host>` Origin is a downgraded
    // or MITM-injected page rather than the real tunnel, and a host-only match
    // would have waved it through.
    if (tunnelUrl) {
        try {
            if (new URL(tunnelUrl).origin.toLowerCase() === originUrl.origin.toLowerCase()) {
                return { allowed: true, reason: 'tunnel-origin' };
            }
        } catch { /* malformed tunnel URL — fall through to reject */ }
    }

    return { allowed: false, reason: 'cross-origin' };
}
