import type { PlanUsage, UsageWindow, UsageModelWindow } from '@claudia/shared';

/** Clamp a utilization value defensively into [0, 100]. */
function clampUtilization(value: unknown): number {
    const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
    return Math.max(0, Math.min(100, n));
}

/** Read a raw `{ utilization, resets_at }` window into a UsageWindow. */
function readWindow(value: unknown): UsageWindow {
    const obj = (value ?? {}) as Record<string, unknown>;
    return {
        utilization: clampUtilization(obj.utilization),
        resetsAt: typeof obj.resets_at === 'string' ? obj.resets_at : '',
    };
}

/**
 * Map the raw JSON returned by Anthropic's `GET /api/oauth/usage` endpoint into
 * our normalized {@link PlanUsage} shape.
 *
 * Per-model weekly windows are matched generically via `seven_day_<model>`, so a
 * future key such as `seven_day_fable` is surfaced with no code change. Null
 * per-model values are dropped. Utilization is clamped to [0, 100] defensively.
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
    //  1. `seven_day_<model>` top-level keys (documented; often null in practice).
    //  2. A `limits[]` array with `kind:"weekly_scoped"` and
    //     `scope.model.display_name` — the source actually populated by the live
    //     API (observed 2026-07-02). We merge both, keyed by lowercase model name,
    //     preferring the explicit `seven_day_<model>` key when both are present.
    const byModel = new Map<string, UsageModelWindow>();
    for (const [key, value] of Object.entries(src)) {
        const match = /^seven_day_(.+)$/.exec(key);
        if (!match) continue;
        if (value === null || value === undefined) continue;
        const model = match[1].toLowerCase();
        byModel.set(model, { model, ...readWindow(value) });
    }

    const limits = Array.isArray(src.limits) ? src.limits : [];
    for (const entry of limits) {
        if (!entry || typeof entry !== 'object') continue;
        const lim = entry as Record<string, unknown>;
        if (lim.kind !== 'weekly_scoped') continue;
        const scope = lim.scope as Record<string, unknown> | null | undefined;
        const modelInfo = scope?.model as Record<string, unknown> | undefined;
        const displayName =
            (typeof modelInfo?.display_name === 'string' && modelInfo.display_name) ||
            (typeof modelInfo?.id === 'string' && modelInfo.id) ||
            '';
        if (!displayName) continue;
        const model = displayName.toLowerCase();
        if (byModel.has(model)) continue; // prefer the seven_day_<model> key
        byModel.set(model, {
            model,
            utilization: clampUtilization(lim.percent),
            resetsAt: typeof lim.resets_at === 'string' ? lim.resets_at : '',
        });
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
        usage.extraUsage = {
            isEnabled: extra.is_enabled === true,
            monthlyLimit: typeof extra.monthly_limit === 'number' ? extra.monthly_limit : null,
            usedCredits: typeof extra.used_credits === 'number' ? extra.used_credits : null,
            utilization: typeof extra.utilization === 'number' ? extra.utilization : null,
        };
    }

    return usage;
}
