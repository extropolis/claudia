import type { PlanUsage, UsageWindow, UsageModelWindow } from '@claudia/shared';
import { redactSecrets } from './redact.js';

/**
 * Top-level `seven_day_<x>` keys that are genuinely MODELS.
 *
 * The live response carries several keys with that prefix which are *not*
 * models but per-product buckets — confirmed against captured payloads and
 * Claude Code's own `Utilization` type:
 *
 *   seven_day_oauth_apps  third-party OAuth apps
 *   seven_day_cowork      Daily Routines (a.k.a. seven_day_routines)
 *   seven_day_omelette    Claude Design
 *
 * Matching the prefix generically rendered those as models named "oauth_apps",
 * "cowork" and "omelette" in the dashboard. Worse, it made the model list a
 * mirror of arbitrary upstream key names: any `seven_day_<anything>` key was
 * copied verbatim into a payload we serve over REST and the tunnel.
 *
 * An allowlist is safe rather than limiting, because since the Fable launch the
 * top-level per-model fields are null anyway — new models arrive through the
 * `limits[]` array below, which stays fully generic.
 */
const MODEL_KEYS = new Set(['opus', 'sonnet', 'haiku']);

/** Longest plausible model display name; anything longer is not a model. */
const MAX_MODEL_NAME = 48;

/** Clamp a utilization value defensively into [0, 100].
 *  The JSON body reports percentages (0–100), unlike the `anthropic-ratelimit-*`
 *  response headers elsewhere in the API, which report a 0–1 fraction. */
function clampUtilization(value: unknown): number {
    const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
    return Math.max(0, Math.min(100, n));
}

/** Longest plausible reset timestamp; an ISO-8601 instant is ~24 chars. */
const MAX_RESET_LEN = 64;

/**
 * Sanitize an upstream-authored string before it is copied into the payload we
 * serve over REST, the `usage:updated` WS frame (including to tunnel clients)
 * and render in the UI.
 *
 * `resets_at` is upstream-controlled text exactly like `scope.model.display_name`
 * is, and until now it was the only one of the two copied through unbounded and
 * unscrubbed: a hostile or broken upstream reflecting the Authorization header
 * into `five_hour.resets_at` got it republished verbatim, and a megabyte-long
 * value got broadcast to every connected client. Bound it and refuse anything
 * credential-shaped, the same way display_name is treated.
 */
function readUpstreamString(value: unknown, maxLen: number): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLen) return '';
    return redactSecrets(value) === value ? value : '';
}

/** Read a raw `{ utilization, resets_at }` window into a UsageWindow. */
function readWindow(value: unknown): UsageWindow {
    const obj = (value ?? {}) as Record<string, unknown>;
    return {
        utilization: clampUtilization(obj.utilization),
        resetsAt: readUpstreamString(obj.resets_at, MAX_RESET_LEN),
    };
}

/** True when a raw window object actually carries a reading. */
function isPresent(value: unknown): boolean {
    return !!value && typeof value === 'object';
}

/**
 * Map the raw JSON returned by Anthropic's `GET /api/oauth/usage` endpoint into
 * our normalized {@link PlanUsage} shape.
 *
 * Pure: no I/O, no clock — `fetchedAt` and `planLabel` are passed through.
 */
export function mapUsageResponse(
    raw: unknown,
    planLabel: string,
    fetchedAt: string
): PlanUsage {
    const src = (raw ?? {}) as Record<string, unknown>;

    // Per-model weekly windows come from two sources:
    //  1. `seven_day_<model>` top-level keys — allowlisted (see MODEL_KEYS);
    //     null for scoped models since the Fable launch.
    //  2. A `limits[]` array with `kind:"weekly_scoped"` and
    //     `scope.model.display_name` — the source actually populated today.
    //     Kept generic so a new model needs no code change.
    const byModel = new Map<string, UsageModelWindow>();
    for (const [key, value] of Object.entries(src)) {
        const match = /^seven_day_(.+)$/.exec(key);
        if (!match) continue;
        if (!isPresent(value)) continue;
        const model = match[1].toLowerCase();
        if (!MODEL_KEYS.has(model)) continue;
        byModel.set(model, { model, ...readWindow(value) });
    }

    const limits = Array.isArray(src.limits) ? src.limits : [];
    for (const entry of limits) {
        if (!entry || typeof entry !== 'object') continue;
        const lim = entry as Record<string, unknown>;
        if (lim.kind !== 'weekly_scoped') continue;

        // Placeholder rows: the API emits an inactive entry per model that the
        // account has no scoped limit for. `is_active:false`, or 0% with no
        // reset time, means "this window does not apply" — not "0% used".
        // Rendering them produced phantom 0% bars for models never used.
        if (lim.is_active === false) continue;
        const resetsAt = readUpstreamString(lim.resets_at, MAX_RESET_LEN);
        const percent = clampUtilization(lim.percent);
        if (percent === 0 && !resetsAt) continue;

        const scope = lim.scope as Record<string, unknown> | null | undefined;
        const modelInfo = scope?.model as Record<string, unknown> | undefined;
        // `scope.model.id` is null in every observed payload; display_name is
        // the usable field.
        const displayName =
            (typeof modelInfo?.display_name === 'string' && modelInfo.display_name) ||
            (typeof modelInfo?.id === 'string' && modelInfo.id) ||
            '';
        // Upstream-controlled string that we serve back over REST/WS (including
        // to tunnel clients) and render in the UI. Bound it, and refuse
        // anything credential-shaped — the same treatment readUpstreamString()
        // gives `resets_at`. Skipping the row entirely (rather than blanking
        // the name) is right here: a model window with no usable name is not
        // worth rendering.
        if (!displayName || displayName.length > MAX_MODEL_NAME) continue;
        if (redactSecrets(displayName) !== displayName) continue;

        const model = displayName.toLowerCase();
        if (byModel.has(model)) continue; // prefer the seven_day_<model> key
        byModel.set(model, { model, utilization: percent, resetsAt });
    }

    const sevenDayByModel: UsageModelWindow[] = Array.from(byModel.values());

    const usage: PlanUsage = {
        fiveHour: readWindow(src.five_hour),
        sevenDay: readWindow(src.seven_day),
        sevenDayByModel,
        planLabel,
        fetchedAt,
    };

    const extra = src.extra_usage as Record<string, unknown> | undefined;
    if (extra && typeof extra === 'object') {
        // `monthly_limit` and `used_credits` arrive in MINOR units (cents);
        // Claude Code divides both by 100 before display. Normalize here so
        // every consumer gets currency units and nobody has to remember.
        const minorToMajor = (v: unknown) =>
            typeof v === 'number' && Number.isFinite(v) ? v / 100 : null;
        usage.extraUsage = {
            isEnabled: extra.is_enabled === true,
            monthlyLimit: minorToMajor(extra.monthly_limit),
            usedCredits: minorToMajor(extra.used_credits),
            // Number.isFinite, matching minorToMajor above: Infinity/NaN would
            // otherwise reach JSON.stringify and serialize as a bare `null`
            // that the shared type does not admit for a "present" reading.
            utilization:
                typeof extra.utilization === 'number' && Number.isFinite(extra.utilization)
                    ? extra.utilization
                    : null,
        };
    }

    // Enterprise (and any account with no consumer rate-limit windows) gets
    // null for every bucket. Reporting that as a flat 0% meter is a lie; say
    // "no data" so the UI degrades to its unavailable state instead.
    if (!isPresent(src.five_hour) && !isPresent(src.seven_day) && sevenDayByModel.length === 0) {
        usage.unavailable = true;
        usage.reason = 'no_data';
    }

    return usage;
}
