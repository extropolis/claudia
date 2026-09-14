/** Require the persistent Claudia credential before serving the voice page. */
export function isVoiceTokenAcceptable(
    token: string,
    isAcceptedToken: (token: string) => boolean,
): boolean {
    if (!token) return false;
    return isAcceptedToken(token);
}
