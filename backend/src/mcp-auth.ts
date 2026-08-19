/**
 * Auth token for the shared in-process Claudia MCP endpoint.
 *
 * The endpoint can create, stop and delete tasks. As a stdio child process it
 * was reachable only by its own parent session; as an HTTP endpoint it is
 * reachable by anything that can open a socket to the backend. Binding checks
 * alone are too weak — every process on the machine shares loopback — so each
 * generated MCP config carries a bearer token that the endpoint requires.
 *
 * The token PERSISTS across restarts. It used to be regenerated on every boot,
 * on the reasoning that it only had to outlive the sessions whose configs were
 * written from it. That holds for Claudia-spawned tasks, which are respawned
 * with a freshly written config — but not for a Claude session a user launched
 * themselves in a workspace. That session read the token out of the workspace's
 * `.mcp.json` at startup and holds it for its whole life, so the next backend
 * restart silently turned every one of its claudia_* calls into a 401 with no
 * path to recovery. Backend restarts are routine (tsx watch reloads on every
 * source edit), so in practice a hand-started session lost its Claudia tools
 * within minutes.
 *
 * Persisting also makes each workspace's `.mcp.json` content stable across
 * restarts, which is what lets the config sync skip rewrites entirely instead
 * of churning every file on every boot.
 *
 * The file lives in the data directory alongside the other secrets-adjacent
 * state, is written 0600, and is gitignored — as is every `.mcp.json` it is
 * copied into. If it is lost, a new token is minted and the startup config sync
 * rewrites the workspace configs from it.
 */
import { randomBytes, timingSafeEqual } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { dataPath, resolveDataDir } from './paths.js';

let token: string | null = null;

/** Name of the token file inside the data directory. */
export const MCP_TOKEN_FILENAME = 'mcp-token';

/** A token is 32 random bytes rendered as hex. Anything else on disk is junk. */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

function tokenFilePath(): string {
    return dataPath(resolveDataDir(), MCP_TOKEN_FILENAME);
}

/**
 * The shared-MCP token: read from disk if present, otherwise minted and stored.
 *
 * A token that cannot be persisted (read-only data dir, container without a
 * volume) still works for this process — it just reverts to the old per-boot
 * behavior rather than failing to serve MCP at all.
 */
export function getSharedMcpToken(): string {
    if (token) return token;

    const file = tokenFilePath();
    try {
        const stored = readFileSync(file, 'utf-8').trim();
        if (TOKEN_PATTERN.test(stored)) {
            token = stored;
            return token;
        }
        // Fall through: a corrupt or truncated file is replaced, not trusted.
    } catch {
        // Missing or unreadable — mint a fresh one below.
    }

    token = randomBytes(32).toString('hex');
    try {
        writeFileSync(file, token, { encoding: 'utf-8', mode: 0o600 });
    } catch {
        // In-memory only for this process; MCP still works, it just won't
        // survive a restart for hand-started sessions.
    }
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
