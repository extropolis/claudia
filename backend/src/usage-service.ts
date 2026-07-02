import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PlanUsage } from '@claudia/shared';
import { mapUsageResponse } from './usage-mapper';
import {
    readOAuthCredentials,
    planLabelFromSubscription,
    type OAuthCredentials,
} from './usage-credentials';

const execFileAsync = promisify(execFile);

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const FALLBACK_UA = 'claude-code/2.1.198';

// Rate-limit discipline (see plan Global Constraints). Times in ms.
const TTL_MS = 300_000; // 5 min: hard cache TTL
const MIN_POLL_MS = 180_000; // never fetch more often than every 3 min
const BACKOFF_STEPS_MS = [300_000, 600_000, 1_200_000, 1_800_000]; // 5,10,20,30 min (cap)
const POLL_INTERVAL_MS = TTL_MS; // background poll cadence; getUsage() gates real fetches

/** Minimal fetch surface so tests can inject a stub. */
export type UsageFetch = (
    url: string,
    init: { headers: Record<string, string> }
) => Promise<{ status: number; json: () => Promise<unknown> }>;

export interface UsageServiceDeps {
    fetchImpl?: UsageFetch;
    readCreds?: () => Promise<OAuthCredentials | null>;
    detectVersion?: () => Promise<string>;
    now?: () => number;
}

/** Detect the local Claude Code version and return a `claude-code/<x.y.z>` UA. */
async function defaultDetectVersion(): Promise<string> {
    try {
        const { stdout } = await execFileAsync('claude', ['--version'], { timeout: 5000 });
        const m = /(\d+\.\d+\.\d+)/.exec(stdout);
        return m ? `claude-code/${m[1]}` : FALLBACK_UA;
    } catch {
        return FALLBACK_UA;
    }
}

const defaultFetch: UsageFetch = async (url, init) => {
    const res = await fetch(url, init);
    return { status: res.status, json: () => res.json() };
};

export class UsageService {
    private readonly fetchImpl: UsageFetch;
    private readonly readCreds: () => Promise<OAuthCredentials | null>;
    private readonly detectVersion: () => Promise<string>;
    private readonly now: () => number;

    private lastGood: PlanUsage | null = null;
    private lastGoodAtMs = 0;
    private nextAllowedFetchAt = 0;
    private backoffStep = 0;
    private cachedUA: string | null = null;
    private inFlight: Promise<PlanUsage> | null = null;
    private pollTimer: ReturnType<typeof setInterval> | null = null;

    constructor(deps: UsageServiceDeps = {}) {
        this.fetchImpl = deps.fetchImpl ?? defaultFetch;
        this.readCreds = deps.readCreds ?? readOAuthCredentials;
        this.detectVersion = deps.detectVersion ?? defaultDetectVersion;
        this.now = deps.now ?? Date.now;
    }

    private unavailable(reason: PlanUsage['reason']): PlanUsage {
        return {
            fiveHour: { utilization: 0, resetsAt: '' },
            sevenDay: { utilization: 0, resetsAt: '' },
            sevenDayByModel: [],
            planLabel: 'Unknown',
            fetchedAt: new Date(this.now()).toISOString(),
            unavailable: true,
            reason,
        };
    }

    private staleCopy(): PlanUsage | null {
        return this.lastGood ? { ...this.lastGood, stale: true } : null;
    }

    private applyBackoff(nowMs: number): void {
        const step = Math.min(this.backoffStep, BACKOFF_STEPS_MS.length - 1);
        this.nextAllowedFetchAt = nowMs + BACKOFF_STEPS_MS[step];
        this.backoffStep++;
    }

    private async getUA(): Promise<string> {
        if (this.cachedUA === null) {
            this.cachedUA = await this.detectVersion();
        }
        return this.cachedUA;
    }

    /**
     * Return plan usage. Serves the cached value within the TTL or during a 429
     * backoff window; otherwise performs a single guarded fetch. Never throws —
     * failures are encoded in `unavailable`/`stale`/`reason`.
     */
    async getUsage(forceRefresh = false): Promise<PlanUsage> {
        // Coalesce concurrent callers onto a single in-flight fetch.
        if (this.inFlight) return this.inFlight;

        const creds = await this.readCreds();
        if (!creds) return this.unavailable('no_token');

        const nowMs = this.now();
        if (!forceRefresh) {
            if (this.lastGood && nowMs - this.lastGoodAtMs < TTL_MS) {
                return this.lastGood;
            }
            if (nowMs < this.nextAllowedFetchAt) {
                return this.staleCopy() ?? this.unavailable('rate_limited');
            }
        }

        this.inFlight = this.performFetch(creds, nowMs);
        try {
            return await this.inFlight;
        } finally {
            this.inFlight = null;
        }
    }

    private async performFetch(creds: OAuthCredentials, nowMs: number): Promise<PlanUsage> {
        try {
            const ua = await this.getUA();
            const res = await this.fetchImpl(USAGE_URL, {
                headers: {
                    Authorization: `Bearer ${creds.accessToken}`,
                    'anthropic-beta': 'oauth-2025-04-20',
                    'User-Agent': ua,
                    'Content-Type': 'application/json',
                },
            });

            if (res.status === 200) {
                const raw = await res.json();
                const planLabel = planLabelFromSubscription(creds.subscriptionType);
                const usage = mapUsageResponse(raw, planLabel, new Date(nowMs).toISOString());
                this.lastGood = usage;
                this.lastGoodAtMs = nowMs;
                this.backoffStep = 0;
                // Enforce a minimum spacing between real fetches.
                this.nextAllowedFetchAt = nowMs + MIN_POLL_MS;
                return usage;
            }

            if (res.status === 429) {
                this.applyBackoff(nowMs);
                return this.staleCopy() ?? this.unavailable('rate_limited');
            }

            if (res.status === 401) {
                // Auth problem: avoid hammering, but don't compound backoff.
                this.nextAllowedFetchAt = nowMs + MIN_POLL_MS;
                return this.staleCopy() ?? this.unavailable('auth');
            }

            // Other/5xx: transient network-ish failure.
            this.nextAllowedFetchAt = nowMs + MIN_POLL_MS;
            return this.staleCopy() ?? this.unavailable('network');
        } catch {
            this.nextAllowedFetchAt = nowMs + MIN_POLL_MS;
            return this.staleCopy() ?? this.unavailable('network');
        }
    }

    /**
     * Begin background polling. Only fetches while `hasClients()` is true and
     * always honors the TTL/backoff gating inside {@link getUsage}. When the
     * refreshed usage differs from the previous value, `onUpdate` is invoked.
     */
    startPolling(hasClients: () => boolean, onUpdate?: (u: PlanUsage) => void): void {
        if (this.pollTimer) return;
        this.pollTimer = setInterval(() => {
            if (!hasClients()) return;
            const prev = this.lastGood ? JSON.stringify(this.lastGood) : null;
            void this.getUsage().then((u) => {
                if (onUpdate && JSON.stringify(u) !== prev) onUpdate(u);
            });
        }, POLL_INTERVAL_MS);
        // Do not keep the process alive solely for polling.
        if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref();
    }

    stopPolling(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }
}
