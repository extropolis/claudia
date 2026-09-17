// Log-safety helpers. Kept in their own module so both usage-service.ts and
// usage-credentials.ts can use them without an import cycle.

/**
 * Scrub a string that this module did not author before it reaches a log line.
 *
 * `err.message` on the fetch path is upstream-controlled text. Several HTTP
 * stacks (and every proxy that wraps one) include the outbound request headers
 * in their error text, which would turn a routine
 * `logger.warn('fetch failed', { error: err.message })` into a disclosure of a
 * live Anthropic OAuth credential in the server log — a file that gets pasted
 * into bug reports.
 *
 * Two layers, because either alone is insufficient: the exact token is scrubbed
 * when we know it, and an `sk-ant-…` / `Bearer …` shaped blob is scrubbed even
 * when we do not (e.g. a nested error carrying a *different* credential).
 */
export function redactSecrets(text: string, token?: string): string {
    let out = text;
    if (token && token.length >= 8) out = out.split(token).join('[redacted]');
    out = out.replace(/sk-ant-[A-Za-z0-9._~+/-]{8,}=*/g, '[redacted]');
    out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1[redacted]');
    return out;
}

/** `err` → a log-safe message. Never returns raw upstream text. */
export function safeErrorMessage(err: unknown, token?: string): string {
    return redactSecrets(err instanceof Error ? err.message : String(err), token);
}
