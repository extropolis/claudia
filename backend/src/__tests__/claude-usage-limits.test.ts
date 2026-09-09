/**
 * Unit tests for the plan-usage-limits reader.
 *
 * Hermetic: $HOME points at a temp dir under homedir() (NOT os.tmpdir() — see
 * CLAUDE.md), and global.fetch is stubbed, so nothing here reads the
 * developer's real credentials or reaches Anthropic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
    getUsageLimits,
    clearUsageLimitsCache,
    loadStoredCredentials,
    normalizeUsageResponse,
    formatPlanLabel,
    CACHE_TTL_MS,
} from '../claude-usage-limits.js';

let tempHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalEnvToken: string | undefined;

/** Trimmed but faithful copy of a real /api/oauth/usage response. */
const REAL_RESPONSE = {
    five_hour: { utilization: 11.0, resets_at: '2026-09-02T20:19:59.521628+00:00' },
    seven_day: { utilization: 3.0, resets_at: '2026-09-09T14:59:59.521652+00:00' },
    limits: [
        { kind: 'session', group: 'session', percent: 11, severity: 'normal', resets_at: '2026-09-02T20:19:59.521628+00:00', scope: null, is_active: true },
        { kind: 'weekly_scoped', group: 'weekly', percent: 2, severity: 'normal', resets_at: '2026-09-09T14:59:59.521893+00:00', scope: { model: { id: null, display_name: 'Fable' } }, is_active: false },
        { kind: 'weekly_all', group: 'weekly', percent: 3, severity: 'normal', resets_at: '2026-09-09T14:59:59.521652+00:00', scope: null, is_active: false },
    ],
    spend: {
        used: { amount_minor: 0, currency: 'USD', exponent: 2 },
        limit: null,
        balance: { amount_minor: 2000, currency: 'USD', exponent: 2 },
        percent: 0,
        enabled: false,
        auto_reload: false,
    },
    extra_usage: { is_enabled: false, monthly_limit: null },
};

const CREDS = {
    claudeAiOauth: {
        accessToken: 'sk-ant-oat01-test-token',
        refreshToken: 'sk-ant-ort01-test',
        expiresAt: Date.now() + 3_600_000,
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
    },
};

function writeCredentials(creds: unknown): void {
    mkdirSync(join(tempHome, '.claude'), { recursive: true });
    writeFileSync(join(tempHome, '.claude', '.credentials.json'), JSON.stringify(creds));
}

function mockFetchOk(body: unknown) {
    const fn = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
    });
    vi.stubGlobal('fetch', fn);
    return fn;
}

beforeEach(() => {
    tempHome = mkdtempSync(join(homedir(), 'claudia-limits-test-'));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalEnvToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    clearUsageLimitsCache();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalUserProfile;
    if (originalEnvToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalEnvToken;
    try { rmSync(tempHome, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('formatPlanLabel', () => {
    it('renders the multiplier the way claude.ai does', () => {
        expect(formatPlanLabel('max', 'default_claude_max_20x')).toBe('Max (20x)');
        expect(formatPlanLabel('max', 'default_claude_max_5x')).toBe('Max (5x)');
    });

    it('handles plans without a multiplier', () => {
        expect(formatPlanLabel('pro', 'default_claude_pro')).toBe('Pro');
    });

    it('falls back to the subscription type when the tier is unknown', () => {
        expect(formatPlanLabel('scholar', 'weird_tier')).toBe('Scholar');
        expect(formatPlanLabel(null, null)).toBeNull();
    });
});

describe('normalizeUsageResponse', () => {
    const creds = { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' };

    it('extracts the session bar and both weekly bars', () => {
        const result = normalizeUsageResponse(REAL_RESPONSE, creds);
        expect(result.ok).toBe(true);
        expect(result.planLabel).toBe('Max (20x)');
        expect(result.session?.percent).toBe(11);
        expect(result.session?.label).toBe('Current session');
        expect(result.weekly).toHaveLength(2);
    });

    it('puts the all-models bar before any scoped bar, regardless of API order', () => {
        const result = normalizeUsageResponse(REAL_RESPONSE, creds);
        expect(result.weekly[0].label).toBe('All models');
        expect(result.weekly[1].label).toBe('Fable');
        expect(result.weekly[1].scopeLabel).toBe('Fable');
    });

    it('escalates severity past what the API reports, never below it', () => {
        const body = {
            limits: [
                { kind: 'session', group: 'session', percent: 85, severity: 'normal', resets_at: null, scope: null },
            ],
        };
        // API says 'normal' at 85% — the user needs a red bar, not a green one.
        expect(normalizeUsageResponse(body, creds).session?.severity).toBe('critical');

        const escalated = {
            limits: [
                { kind: 'session', group: 'session', percent: 10, severity: 'exhausted', resets_at: null, scope: null },
            ],
        };
        // ...and a harsher API severity is never softened by our thresholds.
        expect(normalizeUsageResponse(escalated, creds).session?.severity).toBe('exhausted');
    });

    it('derives severity bands from the percentage', () => {
        const at = (percent: number) => normalizeUsageResponse(
            { limits: [{ kind: 'session', group: 'session', percent, resets_at: null, scope: null }] },
            creds
        ).session?.severity;
        expect(at(10)).toBe('normal');
        expect(at(50)).toBe('warning');
        expect(at(80)).toBe('critical');
        expect(at(100)).toBe('exhausted');
    });

    it('falls back to the legacy five_hour/seven_day fields when limits is absent', () => {
        const legacy = { five_hour: REAL_RESPONSE.five_hour, seven_day: REAL_RESPONSE.seven_day };
        const result = normalizeUsageResponse(legacy, creds);
        expect(result.session?.percent).toBe(11);
        expect(result.weekly).toHaveLength(1);
        expect(result.weekly[0].label).toBe('All models');
    });

    it('clamps nonsense percentages into 0-100', () => {
        const body = {
            limits: [
                { kind: 'session', group: 'session', percent: 260, resets_at: null, scope: null },
                { kind: 'weekly_all', group: 'weekly', percent: -5, resets_at: null, scope: null },
            ],
        };
        const result = normalizeUsageResponse(body, creds);
        expect(result.session?.percent).toBe(100);
        expect(result.weekly[0].percent).toBe(0);
    });

    it('maps the usage-credits card', () => {
        const result = normalizeUsageResponse(REAL_RESPONSE, creds);
        expect(result.credits).toMatchObject({
            enabled: false,
            usedMinor: 0,
            balanceMinor: 2000,
            currency: 'USD',
            autoReload: false,
        });
    });

    it('survives a payload with no limits at all', () => {
        const result = normalizeUsageResponse({}, creds);
        expect(result.session).toBeNull();
        expect(result.weekly).toEqual([]);
    });
});

describe('loadStoredCredentials', () => {
    it('reads the token from ~/.claude/.credentials.json', async () => {
        writeCredentials(CREDS);
        const creds = await loadStoredCredentials();
        expect(creds?.accessToken).toBe('sk-ant-oat01-test-token');
        expect(creds?.rateLimitTier).toBe('default_claude_max_20x');
    });

    it('prefers an explicit CLAUDE_CODE_OAUTH_TOKEN', async () => {
        writeCredentials(CREDS);
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-env-token';
        const creds = await loadStoredCredentials();
        expect(creds?.accessToken).toBe('sk-ant-env-token');
    });

    it('returns null when there is no credentials file', async () => {
        expect(await loadStoredCredentials()).toBeNull();
    });

    it('returns null for a corrupt credentials file', async () => {
        mkdirSync(join(tempHome, '.claude'), { recursive: true });
        writeFileSync(join(tempHome, '.claude', '.credentials.json'), '{ not json');
        expect(await loadStoredCredentials()).toBeNull();
    });

    it('returns null when the file has no access token', async () => {
        writeCredentials({ claudeAiOauth: { refreshToken: 'x' } });
        expect(await loadStoredCredentials()).toBeNull();
    });
});

describe('getUsageLimits', () => {
    it('reports no-credentials instead of throwing when nobody is logged in', async () => {
        const result = await getUsageLimits();
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('no-credentials');
    });

    it('reports expired without calling the API', async () => {
        writeCredentials({ claudeAiOauth: { ...CREDS.claudeAiOauth, expiresAt: Date.now() - 1000 } });
        const fetchMock = mockFetchOk(REAL_RESPONSE);
        const result = await getUsageLimits();
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('expired');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sends the bearer token and the oauth beta header', async () => {
        writeCredentials(CREDS);
        const fetchMock = mockFetchOk(REAL_RESPONSE);
        const result = await getUsageLimits();
        expect(result.ok).toBe(true);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
        expect(init.headers.Authorization).toBe('Bearer sk-ant-oat01-test-token');
        expect(init.headers['anthropic-beta']).toBe('oauth-2025-04-20');
    });

    it('serves the second call from cache and marks it as cached', async () => {
        writeCredentials(CREDS);
        const fetchMock = mockFetchOk(REAL_RESPONSE);
        const first = await getUsageLimits();
        const second = await getUsageLimits();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(first.ok && first.cached).toBe(false);
        expect(second.ok && second.cached).toBe(true);
    });

    it('refetches when the caller forces a refresh', async () => {
        writeCredentials(CREDS);
        const fetchMock = mockFetchOk(REAL_RESPONSE);
        await getUsageLimits();
        await getUsageLimits(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('refetches once the cache TTL has elapsed', async () => {
        writeCredentials(CREDS);
        const fetchMock = mockFetchOk(REAL_RESPONSE);
        await getUsageLimits();
        const realNow = Date.now;
        try {
            const later = realNow() + CACHE_TTL_MS + 1;
            Date.now = () => later;
            await getUsageLimits();
        } finally {
            Date.now = realNow;
        }
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('de-dupes concurrent callers into a single upstream request', async () => {
        writeCredentials(CREDS);
        const fetchMock = mockFetchOk(REAL_RESPONSE);
        const [a, b, c] = await Promise.all([getUsageLimits(), getUsageLimits(), getUsageLimits()]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(a.ok && b.ok && c.ok).toBe(true);
    });

    it('maps 401 to unauthorized', async () => {
        writeCredentials(CREDS);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false, status: 401, text: async () => 'nope', json: async () => ({}),
        }));
        const result = await getUsageLimits();
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('unauthorized');
    });

    it('maps a 500 to api-error', async () => {
        writeCredentials(CREDS);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false, status: 500, text: async () => 'boom', json: async () => ({}),
        }));
        const result = await getUsageLimits();
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('api-error');
    });

    it('maps a thrown fetch to network', async () => {
        writeCredentials(CREDS);
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
        const result = await getUsageLimits();
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('network');
    });

    it('never leaks the access token into the returned payload', async () => {
        writeCredentials(CREDS);
        mockFetchOk(REAL_RESPONSE);
        const result = await getUsageLimits();
        expect(JSON.stringify(result)).not.toContain('sk-ant');
    });
});
