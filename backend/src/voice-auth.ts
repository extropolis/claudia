/**
 * Token acceptance for the server-rendered /voice page.
 *
 * Extracted from the route handler so the decision can be tested directly.
 * Testing it through HTTP is not reliable: for a tunnel host the middleware
 * chain first proxies to the Vite dev server, so whether the request ever
 * reaches the /voice route depends on whether Vite happens to be running —
 * true on a developer's machine, false in CI and in production. The security
 * decision itself has no such ambiguity, so it lives here as a pure function.
 */

/**
 * Does this Host header indicate the request arrived over a public tunnel?
 *
 * Host is attacker-controllable in principle. It is used here to *withdraw*
 * trust, never to grant it: a request claiming a tunnel host gets the stricter
 * path. Lying about the header only moves an attacker into the branch that
 * requires a real token.
 */
export function isTunnelHostname(host: string): boolean {
    return host.includes('.loca.lt') || host.includes('localtunnel') ||
           host.includes('.ngrok-free.app') || host.includes('.ngrok.io') || host.includes('ngrok');
}

/**
 * Decide whether `token` may be served the /voice page.
 *
 * A `local-` prefix is NOT a credential. The frontend mints it entirely
 * client-side as `'local-' + Math.random().toString(36).substring(2, 15)`
 * (App.tsx), and nothing ever registers or checks the suffix — so
 * `startsWith('local-')` accepts any string an attacker cares to type.
 *
 * The page embeds the Deepgram API key, so honoring that prefix on a tunnel
 * host is an unauthenticated secret disclosure to the public internet:
 *
 *     GET https://<tunnel-host>/voice?token=local-x  ->  200 + Deepgram key
 *
 * The prefix therefore only means anything for requests that did not arrive
 * over a tunnel, keeping local and desktop use working unchanged. Anything on
 * a tunnel host must present a token the tunnel manager actually issued.
 *
 * @param token Caller-supplied token.
 * @param host Request Host header.
 * @param validateTunnelToken Checks a token against the active tunnel.
 */
export function isVoiceTokenAcceptable(
    token: string,
    host: string,
    validateTunnelToken: (token: string) => boolean,
): boolean {
    if (!token) return false;
    const acceptsLocalPrefix = token.startsWith('local-') && !isTunnelHostname(host);
    return acceptsLocalPrefix || validateTunnelToken(token);
}
