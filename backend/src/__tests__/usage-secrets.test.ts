/**
 * Adversarial leak audit for the plan-usage feature.
 *
 * The OAuth access token is the crown jewel here: it is a live Anthropic
 * credential read out of the user's Keychain, and this feature is the only
 * thing in the codebase that puts it on the wire. Every path that could carry
 * it outward is exercised here and asserted clean:
 *
 *   - every console line the service writes, on every branch
 *     (200 / 401 / 429 / 500 / fetch-throws / json-throws)
 *   - the PlanUsage object handed to /api/usage and to the `usage:updated`
 *     WebSocket frame, JSON-serialized exactly as the server serializes it
 *   - the specific case where an *untrusted* upstream string (an error message
 *     or a response body) echoes the Authorization header back at us
 *
 * That last case is the one that actually bites: `logger.warn(..., { error:
 * err.message })` logs a string the service did not author. Any HTTP layer
 * that includes request headers in its error text turns a debug log into a
 * credential disclosure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UsageService, type UsageFetch } from '../usage-service.js';

const TOKEN = 'sk-ant-oat01-SUPERSECRET-abcdefghijklmnop';
const creds = async () => ({ accessToken: TOKEN, subscriptionType: 'max' });
const version = async () => 'claude-code/2.1.198';

let spies: Array<ReturnType<typeof vi.spyOn>> = [];
let lines: string[] = [];

beforeEach(() => {
    lines = [];
    process.env.DEBUG = '1'; // force the logger's debug branch on too
    spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
            lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
        })
    );
});

afterEach(() => {
    delete process.env.DEBUG;
    spies.forEach((s) => s.mockRestore());
});

function fetchWith(impl: UsageFetch) {
    return new UsageService({ fetchImpl: impl, readCreds: creds, detectVersion: version, now: () => 1_000_000 });
}

/** Everything the service logged, as one blob. */
const logged = () => lines.join('\n');

describe('the OAuth access token never leaves the process', () => {
    it('is absent from every log line on the happy path', async () => {
        const svc = fetchWith(async () => ({
            status: 200,
            json: async () => ({ five_hour: { utilization: 10, resets_at: 'x' } }),
        }));
        await svc.getUsage();
        expect(lines.length).toBeGreaterThan(0); // the logger really did run
        expect(logged()).not.toContain(TOKEN);
    });

    it.each([401, 429, 500, 503])('is absent from every log line on HTTP %i', async (status) => {
        const svc = fetchWith(async () => ({ status, json: async () => ({}) }));
        await svc.getUsage();
        expect(logged()).not.toContain(TOKEN);
    });

    it('is scrubbed when the transport error message echoes the Authorization header', async () => {
        // Exactly what a header-echoing HTTP client produces. The service must
        // not relay this verbatim into a log line.
        const svc = fetchWith(async () => {
            throw new Error(
                `request to https://api.anthropic.com/api/oauth/usage failed, ` +
                `headers={"authorization":"Bearer ${TOKEN}"}`
            );
        });
        const u = await svc.getUsage();
        expect(u.unavailable).toBe(true);
        expect(logged()).not.toContain(TOKEN);
        expect(logged()).toMatch(/redacted/i); // and it says so, rather than dropping the line
    });

    it('is scrubbed when response.json() rejects with a message carrying the token', async () => {
        const svc = fetchWith(async () => ({
            status: 200,
            json: async () => {
                throw new Error(`bad gateway body for Bearer ${TOKEN}`);
            },
        }));
        await svc.getUsage();
        expect(logged()).not.toContain(TOKEN);
    });

    it('is absent from the PlanUsage payload even when the upstream body echoes it', async () => {
        // A hostile / broken upstream reflecting the credential back into the
        // body must not get it re-published on /api/usage or over the WS frame.
        const svc = fetchWith(async () => ({
            status: 200,
            json: async () => ({
                five_hour: { utilization: 5, resets_at: 'x' },
                echoed_authorization: `Bearer ${TOKEN}`,
                [`seven_day_${TOKEN}`]: { utilization: 9, resets_at: 'y' },
                limits: [
                    {
                        kind: 'weekly_scoped',
                        percent: 3,
                        resets_at: 'z',
                        scope: { model: { display_name: TOKEN } },
                    },
                ],
            }),
        }));
        const usage = await svc.getUsage();
        // Serialized exactly as server.ts serializes it for REST and WS.
        // Case-insensitive: the mapper lowercases model names, and a
        // lowercased token is still a token.
        expect(JSON.stringify(usage).toLowerCase()).not.toContain(TOKEN.toLowerCase());
        expect(logged().toLowerCase()).not.toContain(TOKEN.toLowerCase());
    });

    it('is absent from the payload when the upstream echoes it into resets_at', async () => {
        // The sibling case above only covered `scope.model.display_name`.
        // `resets_at` is upstream-authored text too, on three separate paths,
        // and it used to be copied through verbatim: a reflected Authorization
        // header reached /api/usage, the WS frame and the rendered UI.
        const svc = fetchWith(async () => ({
            status: 200,
            json: async () => ({
                five_hour: { utilization: 5, resets_at: `Bearer ${TOKEN}` },
                seven_day: { utilization: 7, resets_at: TOKEN },
                limits: [
                    {
                        kind: 'weekly_scoped',
                        percent: 3,
                        resets_at: `Bearer ${TOKEN}`,
                        scope: { model: { display_name: 'Opus' } },
                    },
                ],
            }),
        }));
        const usage = await svc.getUsage();
        expect(JSON.stringify(usage).toLowerCase()).not.toContain(TOKEN.toLowerCase());
        expect(logged().toLowerCase()).not.toContain(TOKEN.toLowerCase());
    });

    it('does not rebroadcast an unbounded upstream resets_at', async () => {
        // Not a secret leak but the same root cause: whatever the upstream puts
        // in this field is fanned out to every connected WebSocket client.
        const svc = fetchWith(async () => ({
            status: 200,
            json: async () => ({
                five_hour: { utilization: 5, resets_at: 'x'.repeat(100_000) },
            }),
        }));
        const usage = await svc.getUsage();
        expect(usage.fiveHour.resetsAt).toBe('');
        expect(JSON.stringify(usage).length).toBeLessThan(1_000);
    });
});
