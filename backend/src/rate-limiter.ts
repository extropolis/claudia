/**
 * Minimal in-memory fixed-window rate limiter for Express routes.
 *
 * No external dependencies. Used to keep the mobile companion's LLM- and
 * push-backed endpoints (/api/mobile/chat, test-push, simulate-summary,
 * chat/summarize-task) from being hammered — each of those either spends
 * tokens or fans out push notifications.
 *
 * Keying: keyed on the client IP. We deliberately do NOT key on the
 * caller-supplied `body.deviceId` — that is attacker-controlled, so rotating a
 * random deviceId per request would bypass the limit entirely and let a flood
 * of distinct ids grow the tracking map without bound (memory DoS).
 *
 * NOTE: `req.ip` collapses all tunnel clients to the tunnel/proxy address
 * unless Express `trust proxy` is configured. That is acceptable here — the
 * limiter is a coarse abuse throttle, not per-user fairness, and over-grouping
 * only makes it stricter.
 */

export interface RateLimiterOptions {
    /** Window length in milliseconds. */
    windowMs: number;
    /** Max requests allowed per key per window. */
    max: number;
    /** Label used in the 429 payload / logs. */
    name?: string;
    /** Clock override for tests. Defaults to Date.now. */
    now?: () => number;
    /** Key extractor override. Defaults to the client IP (req.ip → socket address). */
    keyFn?: (req: RateLimitRequest) => string;
}

export interface RateLimitRequest {
    body?: unknown;
    ip?: string;
    socket?: { remoteAddress?: string };
}

export interface RateLimitResponse {
    status(code: number): RateLimitResponse;
    json(body: unknown): unknown;
    setHeader?(name: string, value: string): unknown;
}

interface WindowState {
    start: number;
    count: number;
}

export const MAX_TRACKED_KEYS = 2000;

/** Middleware plus a test hook to inspect the tracked-key count. */
export type RateLimiterMiddleware = ((
    req: RateLimitRequest,
    res: RateLimitResponse,
    next: () => void,
) => void) & { trackedKeyCount(): number };

function defaultKey(req: RateLimitRequest): string {
    // Key on the client IP only. deviceId is attacker-controlled and must
    // never be the discriminator (see module header).
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    return `ip:${ip}`;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiterMiddleware {
    const { windowMs, max } = options;
    const now = options.now ?? Date.now;
    const keyFn = options.keyFn ?? defaultKey;
    const name = options.name ?? 'rate-limit';
    const windows = new Map<string, WindowState>();

    function prune(ts: number): void {
        if (windows.size <= MAX_TRACKED_KEYS) return;
        // First pass: drop expired windows.
        for (const [key, w] of windows) {
            if (ts - w.start >= windowMs) windows.delete(key);
        }
        // Hard cap: if still over the limit (a flood of fresh, unexpired keys),
        // evict oldest-inserted entries until we're back under MAX. Map
        // iteration order is insertion order, so the first keys are the oldest.
        if (windows.size > MAX_TRACKED_KEYS) {
            const excess = windows.size - MAX_TRACKED_KEYS;
            let removed = 0;
            for (const key of windows.keys()) {
                if (removed >= excess) break;
                windows.delete(key);
                removed++;
            }
        }
    }

    const middleware = ((req: RateLimitRequest, res: RateLimitResponse, next: () => void): void => {
        const ts = now();
        prune(ts);
        const key = keyFn(req);
        let w = windows.get(key);
        if (!w || ts - w.start >= windowMs) {
            w = { start: ts, count: 0 };
            windows.set(key, w);
        }
        w.count++;
        if (w.count > max) {
            const retryAfterSec = Math.max(1, Math.ceil((w.start + windowMs - ts) / 1000));
            res.setHeader?.('Retry-After', String(retryAfterSec));
            res.status(429).json({
                error: `Too many requests (${name}). Retry in ${retryAfterSec}s.`,
            });
            return;
        }
        next();
    }) as RateLimiterMiddleware;

    middleware.trackedKeyCount = () => windows.size;
    return middleware;
}
