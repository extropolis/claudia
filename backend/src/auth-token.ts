/**
 * The Claudia API credential.
 *
 * Until this module existed, `/api/*` was authenticated only when the request's
 * `Host` header looked like a tunnel — a substring match on `.loca.lt`,
 * `ngrok`, and friends. Every other reachable name fell through to zero auth:
 * a LAN IP, a Tailscale MagicDNS name, a custom domain, a `*.fly.dev` host.
 * Since the listener binds all interfaces, that meant anything on the same
 * network could POST a task and get arbitrary code execution as the user. The
 * hostname was never a security boundary; it was a guess about one.
 *
 * So there is now exactly one credential, required on every API route and every
 * WebSocket upgrade, with no branch on hostname anywhere in the decision.
 *
 * Shape and storage deliberately mirror `mcp-auth.ts`, which already got this
 * right for the MCP endpoint:
 *
 *  - 32 random bytes, hex — 256 bits, not guessable, safe in a URL and a QR code.
 *  - Persisted at `<dataDir>/auth-token`, mode 0600, gitignored.
 *  - PERSISTENT across restarts. Backend restarts are routine here (tsx watch
 *    reloads on every source edit); a per-boot token would log every phone and
 *    every attached desktop out several times an hour.
 *  - Compared with `timingSafeEqual`, so a caller cannot walk the token out of
 *    the server one byte at a time by measuring response latency.
 *  - Tolerant of a read-only data directory: a container without a volume still
 *    serves, it just mints a fresh token per boot instead of failing to start.
 *
 * Unlike `mcp-auth.ts` this is parameterized by data directory rather than
 * reading `resolveDataDir()` itself. `createApp(basePath)` is called with an
 * explicit directory by Electron and by every integration test, and a token
 * keyed to the process-wide environment instead of that directory would have
 * every test in the suite sharing one token written into the source tree.
 */
import { randomBytes, timingSafeEqual } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { dataPath } from './paths.js';

/** Name of the token file inside the data directory. */
export const AUTH_TOKEN_FILENAME = 'auth-token';

/** A token is 32 random bytes rendered as hex. Anything else on disk is junk. */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Cache keyed by resolved token-file path, not a single module-level string.
 *
 * Two servers in one process is not hypothetical — the WS harness's `restart()`
 * boots a second `createApp` against the same state dir, and the HTTP suites run
 * several harnesses per file, each with its own temp directory. A single cached
 * token would leak the first one into all of them.
 */
const cache = new Map<string, string>();

/** Absolute path of the token file for a given data directory. */
export function authTokenPath(dataDir: string | undefined): string {
    return dataPath(dataDir, AUTH_TOKEN_FILENAME);
}

/**
 * The API token for `dataDir`: read from disk if present, otherwise minted and
 * stored 0600.
 *
 * @param dataDir Resolved data directory, or `undefined` for the legacy location.
 */
export function getAuthToken(dataDir: string | undefined): string {
    const file = authTokenPath(dataDir);
    const cached = cache.get(file);
    if (cached) return cached;

    try {
        const stored = readFileSync(file, 'utf-8').trim();
        if (TOKEN_PATTERN.test(stored)) {
            cache.set(file, stored);
            return stored;
        }
        // Fall through: a corrupt or truncated file is replaced, not trusted.
        // Trusting a short file would be worse than useless — a one-byte
        // "token" is a credential an attacker can guess in 16 tries.
    } catch {
        // Missing or unreadable — mint a fresh one below.
    }

    const minted = randomBytes(32).toString('hex');
    try {
        writeFileSync(file, minted, { encoding: 'utf-8', mode: 0o600 });
    } catch {
        // In-memory only for this process. Auth still works; it just won't
        // survive a restart, so clients re-bootstrap. Better than refusing
        // to serve because the volume is read-only.
    }
    cache.set(file, minted);
    return minted;
}

/**
 * Constant-time check of a presented credential against the stored token.
 *
 * Returns false — never throws — for `undefined`, empty, or a wrong-length
 * string. `timingSafeEqual` throws on a length mismatch, and a route that threw
 * on a short token would turn every probe into a 500 with a stack trace.
 *
 * Comparing lengths first does leak the token's length. That is not a secret:
 * it is documented right here as 64 hex characters.
 */
export function validateAuthToken(dataDir: string | undefined, presented: string | undefined | null): boolean {
    if (!presented) return false;
    const expected = Buffer.from(getAuthToken(dataDir), 'utf8');
    const actual = Buffer.from(presented, 'utf8');
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
}

/**
 * Constant-time equality for two secrets of unknown length.
 *
 * Exported because `tunnel-manager.ts` needs the same guarantee for the tunnel
 * token and had been using `===`, which short-circuits on the first differing
 * byte.
 */
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
    if (!a || !b) return false;
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
}

/** Drop cached tokens. Tests only — lets a suite prove the on-disk path. */
export function __resetAuthTokenCacheForTests(): void {
    cache.clear();
}
