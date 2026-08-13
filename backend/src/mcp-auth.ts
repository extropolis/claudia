/**
 * Auth token for the shared in-process Claudia MCP endpoint.
 *
 * The endpoint can create, stop and delete tasks. As a stdio child process it
 * was reachable only by its own parent session; as an HTTP endpoint it is
 * reachable by anything that can open a socket to the backend. Binding checks
 * alone are too weak — every process on the machine shares loopback — so each
 * generated MCP config carries a per-boot bearer token that the endpoint
 * requires.
 *
 * Regenerated on every start: the token only has to outlive the sessions whose
 * configs were written from it, and those configs are rewritten on reconnect.
 */
import { randomBytes } from 'crypto';
import { timingSafeEqual } from 'crypto';

let token: string | null = null;

/** The current process's shared-MCP token, generated on first use. */
export function getSharedMcpToken(): string {
    if (!token) token = randomBytes(32).toString('hex');
    return token;
}

/** Constant-time comparison so a caller can't probe the token byte by byte. */
export function isValidSharedMcpToken(candidate: string | undefined): boolean {
    if (!candidate) return false;
    const expected = Buffer.from(getSharedMcpToken(), 'utf8');
    const actual = Buffer.from(candidate, 'utf8');
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
}
