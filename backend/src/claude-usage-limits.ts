/**
 * Reads the account's Claude plan usage limits (the same numbers the
 * claude.ai Settings → Usage page and `/usage` in Claude Code show).
 *
 * Source of truth is Anthropic's OAuth usage endpoint, called with the
 * access token Claude Code already stores locally. We never mint, refresh
 * or persist tokens ourselves — if the stored token is expired the user
 * just needs to run Claude Code (or re-login), and we say so.
 *
 * Everything here is best-effort: any failure resolves to a typed error
 * object so the header indicator can render a muted hint instead of
 * breaking the UI.
 */
import { readFile } from 'fs/promises';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type {
    ClaudeUsageLimits,
    ClaudeUsageLimitsError,
    ClaudeUsageLimitsResult,
    UsageCreditsInfo,
    UsageLimitBar,
    UsageLimitSeverity,
    UsageLimitsErrorReason,
} from '@claudia/shared';
import { createLogger } from './logger.js';

const logger = createLogger('[UsageLimits]');
const execFileAsync = promisify(execFile);

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
/** How long a successful snapshot is reused before we call upstream again. */
export const CACHE_TTL_MS = 60_000;
/** Failures are cached far more briefly so a fixed login is picked up fast. */
export const ERROR_CACHE_TTL_MS = 15_000;
const FETCH_TIMEOUT_MS = 10_000;

interface StoredCredentials {
    accessToken: string;
    expiresAt: number | null;
    subscriptionType: string | null;
    rateLimitTier: string | null;
}

interface CacheEntry {
    result: ClaudeUsageLimitsResult;
    expiresAtMs: number;
}

let cache: CacheEntry | null = null;
/** De-dupes concurrent callers (header pill + dashboard + other tabs). */
let inFlight: Promise<ClaudeUsageLimitsResult> | null = null;

/** Test seam — drops any cached snapshot. */
export function clearUsageLimitsCache(): void {
    cache = null;
    inFlight = null;
}

function homeDir(): string {
    return process.env.HOME || process.env.USERPROFILE || '';
}

function errorResult(reason: UsageLimitsErrorReason, message: string): ClaudeUsageLimitsError {
    return { ok: false, reason, message, fetchedAt: new Date().toISOString() };
}

/**
 * Loads the OAuth credentials Claude Code stores locally.
 * Windows/Linux keep them in ~/.claude/.credentials.json; macOS keeps them
 * in the login Keychain. An explicit CLAUDE_CODE_OAUTH_TOKEN wins over both.
 */
export async function loadStoredCredentials(): Promise<StoredCredentials | null> {
    const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (envToken) {
        logger.debug('Using CLAUDE_CODE_OAUTH_TOKEN from the environment');
        return { accessToken: envToken, expiresAt: null, subscriptionType: null, rateLimitTier: null };
    }

    let raw: string | null = null;
    const credPath = join(homeDir(), '.claude', '.credentials.json');
    try {
        raw = await readFile(credPath, 'utf-8');
        logger.debug('Loaded credentials from disk', { path: credPath });
    } catch {
        // Not on disk. On macOS the same blob lives in the Keychain.
        if (process.platform === 'darwin') {
            try {
                const { stdout } = await execFileAsync(
                    'security',
                    ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
                    { timeout: 5000 }
                );
                raw = stdout.trim();
                logger.debug('Loaded credentials from the macOS Keychain');
            } catch {
                logger.debug('No credentials in the macOS Keychain');
            }
        } else {
            logger.debug('No credentials file', { path: credPath });
        }
    }

    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> };
        const oauth = parsed.claudeAiOauth;
        const token = oauth && typeof oauth.accessToken === 'string' ? oauth.accessToken : null;
        if (!token) return null;
        return {
            accessToken: token,
            expiresAt: typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : null,
            subscriptionType: typeof oauth?.subscriptionType === 'string' ? oauth.subscriptionType : null,
            rateLimitTier: typeof oauth?.rateLimitTier === 'string' ? oauth.rateLimitTier : null,
        };
    } catch (error) {
        logger.warn('Credentials file is not valid JSON', { error: String(error) });
        return null;
    }
}

/** 'default_claude_max_20x' → 'Max (20x)'. Falls back to the raw tier. */
export function formatPlanLabel(subscriptionType: string | null, rateLimitTier: string | null): string | null {
    const tier = rateLimitTier || '';
    const multiplier = tier.match(/_(\d+)x$/);
    const base = /max/i.test(tier) || /max/i.test(subscriptionType || '')
        ? 'Max'
        : /pro/i.test(tier) || /pro/i.test(subscriptionType || '')
            ? 'Pro'
            : /team/i.test(tier) ? 'Team'
                : /enterprise/i.test(tier) ? 'Enterprise' : null;
    if (!base) return subscriptionType ? subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1) : null;
    return multiplier ? `${base} (${multiplier[1]}x)` : base;
}

const SEVERITIES: UsageLimitSeverity[] = ['normal', 'warning', 'critical', 'exhausted'];

/** Severity implied by the percentage alone. Matches the pill's colour bands. */
function severityFromPercent(percent: number): UsageLimitSeverity {
    if (percent >= 100) return 'exhausted';
    if (percent >= 80) return 'critical';
    if (percent >= 50) return 'warning';
    return 'normal';
}

/**
 * The API reports its own severity, but it stays 'normal' well past the point
 * where a user wants a warning colour (it reads 'warning' only at ~90%). Take
 * whichever of the two is more severe so the indicator never under-reports.
 */
function normalizeSeverity(value: unknown, percent: number): UsageLimitSeverity {
    const derived = severityFromPercent(percent);
    if (typeof value === 'string' && (SEVERITIES as string[]).includes(value)) {
        const fromApi = value as UsageLimitSeverity;
        return SEVERITIES.indexOf(fromApi) > SEVERITIES.indexOf(derived) ? fromApi : derived;
    }
    return derived;
}

function clampPercent(value: unknown): number {
    const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
    return Math.max(0, Math.min(100, n));
}

/** Human label for a bar, e.g. 'Current session' / 'All models' / 'Fable'. */
function labelForBar(kind: string, scopeLabel: string | null): string {
    if (scopeLabel) return scopeLabel;
    switch (kind) {
        case 'session': return 'Current session';
        case 'weekly_all': return 'All models';
        case 'weekly_scoped': return 'Scoped model';
        case 'weekly_opus': return 'Opus';
        case 'weekly_sonnet': return 'Sonnet';
        default: return kind.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
}

interface RawLimit {
    kind?: unknown;
    group?: unknown;
    percent?: unknown;
    severity?: unknown;
    resets_at?: unknown;
    scope?: { model?: { display_name?: unknown } | null } | null;
}

function toBar(raw: RawLimit): UsageLimitBar | null {
    const kind = typeof raw.kind === 'string' ? raw.kind : null;
    if (!kind) return null;
    const scopeLabel = typeof raw.scope?.model?.display_name === 'string'
        ? raw.scope.model.display_name
        : null;
    const percent = clampPercent(raw.percent);
    return {
        kind,
        group: typeof raw.group === 'string' ? raw.group : kind,
        label: labelForBar(kind, scopeLabel),
        percent,
        severity: normalizeSeverity(raw.severity, percent),
        resetsAt: typeof raw.resets_at === 'string' ? raw.resets_at : null,
        scopeLabel,
    };
}

interface RawSpend {
    used?: { amount_minor?: unknown; currency?: unknown } | null;
    limit?: { amount_minor?: unknown } | null;
    balance?: { amount_minor?: unknown } | null;
    percent?: unknown;
    enabled?: unknown;
    auto_reload?: unknown;
}

function toCredits(
    spend: RawSpend | null | undefined,
    extra: { is_enabled?: unknown } | null | undefined
): UsageCreditsInfo | null {
    if (!spend && !extra) return null;
    const usedMinor = typeof spend?.used?.amount_minor === 'number' ? spend.used.amount_minor : 0;
    const limitMinor = typeof spend?.limit?.amount_minor === 'number' ? spend.limit.amount_minor : null;
    const balanceMinor = typeof spend?.balance?.amount_minor === 'number' ? spend.balance.amount_minor : null;
    return {
        enabled: Boolean(spend?.enabled ?? extra?.is_enabled ?? false),
        usedMinor,
        limitMinor,
        balanceMinor,
        currency: typeof spend?.used?.currency === 'string' ? spend.used.currency : 'USD',
        percent: clampPercent(spend?.percent),
        // The usage API does not currently report a credit-cycle reset date;
        // the field stays null until it does rather than being guessed at.
        resetsAt: null,
        autoReload: typeof spend?.auto_reload === 'boolean' ? spend.auto_reload : null,
    };
}

interface RawUsageResponse {
    limits?: RawLimit[];
    five_hour?: { utilization?: unknown; resets_at?: unknown } | null;
    seven_day?: { utilization?: unknown; resets_at?: unknown } | null;
    spend?: RawSpend | null;
    extra_usage?: { is_enabled?: unknown; monthly_limit?: unknown } | null;
}

/**
 * Turns the raw API payload into our normalised shape.
 * Exported so the parsing is unit-testable without any network.
 */
export function normalizeUsageResponse(
    body: RawUsageResponse,
    creds: { subscriptionType: string | null; rateLimitTier: string | null }
): ClaudeUsageLimits {
    const bars = Array.isArray(body.limits)
        ? body.limits.map(toBar).filter((b): b is UsageLimitBar => b !== null)
        : [];

    let session = bars.find(b => b.group === 'session' || b.kind === 'session') || null;

    // Fall back to the legacy top-level fields when `limits` is absent.
    if (!session && body.five_hour && typeof body.five_hour.utilization === 'number') {
        const percent = clampPercent(body.five_hour.utilization);
        session = {
            kind: 'session',
            group: 'session',
            label: 'Current session',
            percent,
            severity: normalizeSeverity(undefined, percent),
            resetsAt: typeof body.five_hour.resets_at === 'string' ? body.five_hour.resets_at : null,
            scopeLabel: null,
        };
    }

    let weekly = bars.filter(b => b !== session && (b.group === 'weekly' || b.kind.startsWith('weekly')));
    if (weekly.length === 0 && body.seven_day && typeof body.seven_day.utilization === 'number') {
        const percent = clampPercent(body.seven_day.utilization);
        weekly = [{
            kind: 'weekly_all',
            group: 'weekly',
            label: 'All models',
            percent,
            severity: normalizeSeverity(undefined, percent),
            resetsAt: typeof body.seven_day.resets_at === 'string' ? body.seven_day.resets_at : null,
            scopeLabel: null,
        }];
    }
    // All-models bar first, then scoped bars — matches the claude.ai ordering.
    weekly.sort((a, b) => (a.scopeLabel ? 1 : 0) - (b.scopeLabel ? 1 : 0));

    return {
        ok: true,
        subscriptionType: creds.subscriptionType,
        rateLimitTier: creds.rateLimitTier,
        planLabel: formatPlanLabel(creds.subscriptionType, creds.rateLimitTier),
        session,
        weekly,
        credits: toCredits(body.spend, body.extra_usage),
        fetchedAt: new Date().toISOString(),
        cached: false,
    };
}

async function fetchUsageLimits(): Promise<ClaudeUsageLimitsResult> {
    const creds = await loadStoredCredentials();
    if (!creds) {
        return errorResult(
            'no-credentials',
            'No Claude login found. Run Claude Code and sign in to see plan limits.'
        );
    }
    if (creds.expiresAt !== null && creds.expiresAt <= Date.now()) {
        return errorResult('expired', 'Claude login expired. Run Claude Code to refresh it.');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const started = Date.now();
        const response = await fetch(USAGE_URL, {
            headers: {
                Authorization: `Bearer ${creds.accessToken}`,
                'anthropic-beta': OAUTH_BETA,
                'Content-Type': 'application/json',
            },
            signal: controller.signal,
        });

        if (response.status === 401 || response.status === 403) {
            logger.warn('Usage API rejected the stored token', { status: response.status });
            return errorResult('unauthorized', 'Claude rejected the stored login. Re-run Claude Code to sign in.');
        }
        if (!response.ok) {
            const text = (await response.text().catch(() => '')).slice(0, 200);
            logger.warn('Usage API returned an error', { status: response.status, body: text });
            return errorResult('api-error', `Usage API returned ${response.status}.`);
        }

        const body = await response.json() as RawUsageResponse;
        const normalized = normalizeUsageResponse(body, creds);
        logger.info('Fetched plan usage limits', {
            ms: Date.now() - started,
            session: normalized.session ? `${normalized.session.percent}%` : 'n/a',
            weeklyBars: normalized.weekly.length,
            plan: normalized.planLabel,
        });
        return normalized;
    } catch (error) {
        const aborted = (error as Error)?.name === 'AbortError';
        logger.warn('Usage API request failed', { error: String(error), aborted });
        return errorResult('network', aborted ? 'Usage API timed out.' : 'Could not reach the usage API.');
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Returns the current plan limits, served from a short-lived cache so the
 * header pill, the dashboard and every open tab share one upstream call.
 *
 * @param forceRefresh bypasses the cache (the dashboard's refresh button).
 */
export async function getUsageLimits(forceRefresh = false): Promise<ClaudeUsageLimitsResult> {
    const now = Date.now();
    if (!forceRefresh && cache && cache.expiresAtMs > now) {
        return cache.result.ok ? { ...cache.result, cached: true } : cache.result;
    }
    if (inFlight) return inFlight;

    inFlight = (async () => {
        try {
            const result = await fetchUsageLimits();
            cache = {
                result,
                expiresAtMs: Date.now() + (result.ok ? CACHE_TTL_MS : ERROR_CACHE_TTL_MS),
            };
            return result;
        } finally {
            inFlight = null;
        }
    })();

    return inFlight;
}
