/**
 * Minimal in-memory fixed-window rate limiter for Express routes.
 *
 * No external dependencies. Used to keep the mobile companion's LLM- and
 * push-backed endpoints (/api/mobile/chat, test-push, simulate-summary,
 * chat/summarize-task) from being hammered — each of those either spends
 * tokens or fans out push notifications.
 *
 * Keying: prefers the caller-supplied deviceId (request body) so multiple
 * phones behind one NAT don't share a bucket, falling back to the client IP.
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
    /** Key extractor override. Defaults to body.deviceId → req.ip → socket address. */
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

const MAX_TRACKED_KEYS = 2000;

function defaultKey(req: RateLimitRequest): string {
    const body = req.body as Record<string, unknown> | undefined;
    const deviceId = body && typeof body.deviceId === 'string' ? body.deviceId : '';
    if (deviceId) return `device:${deviceId}`;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    return `ip:${ip}`;
}

export function createRateLimiter(options: RateLimiterOptions) {
    const { windowMs, max } = options;
    const now = options.now ?? Date.now;
    const keyFn = options.keyFn ?? defaultKey;
    const name = options.name ?? 'rate-limit';
    const windows = new Map<string, WindowState>();

    function prune(ts: number): void {
        if (windows.size <= MAX_TRACKED_KEYS) return;
        for (const [key, w] of windows) {
            if (ts - w.start >= windowMs) windows.delete(key);
        }
    }

    return (req: RateLimitRequest, res: RateLimitResponse, next: () => void): void => {
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
    };
}
