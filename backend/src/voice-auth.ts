/**
 * Token acceptance for the server-rendered /voice page.
 *
 * Extracted from the route handler so the decision can be tested directly.
 * Testing it through HTTP is not reliable: for a tunnel host the middleware
 * chain first proxies to the Vite dev server, so whether the request ever
 * reaches the /voice route depends on whether Vite happens to be running —
 * true on a developer's machine, false in CI and in production. The security
 * decision itself has no such ambiguity, so it lives here as a pure function.
 *
 * HISTORY. This module used to export `isTunnelHostname()`, a substring match
 * on `.loca.lt` / `ngrok` / friends, and honored a `local-` prefixed token for
 * any host that did not match it. Two things were wrong with that:
 *
 *  1. A `local-` prefix is NOT a credential. The frontend minted it entirely
 *     client-side as `'local-' + Math.random().toString(36).substring(2, 15)`,
 *     and nothing ever registered or checked the suffix — so `startsWith('local-')`
 *     accepted any string an attacker cared to type. The page embeds the
 *     Deepgram API key, so on any host the substring match did not recognize —
 *     a LAN IP, a Tailscale name, a custom domain — that was an unauthenticated
 *     secret disclosure to everyone who could reach the port.
 *  2. The hostname predicate was one of four drifting copies of the same list,
 *     and hostname is not a security boundary in the first place.
 *
 * Both are gone. /voice now requires a real credential, checked by the caller
 * against the same tokens every other route accepts.
 */

/**
 * Decide whether `token` may be served the /voice page.
 *
 * @param token Caller-supplied token.
 * @param isAcceptedToken Checks a token against the credentials this server
 *   issues — the persistent API token and the live tunnel token.
 */
export function isVoiceTokenAcceptable(
    token: string,
    isAcceptedToken: (token: string) => boolean,
): boolean {
    if (!token) return false;
    return isAcceptedToken(token);
}
