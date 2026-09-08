// Shared helpers for the plan-usage meter and dashboard. Kept DRY so the
// utilization→color mapping and reset-time formatting are identical everywhere.

/**
 * Utilization "severity" bucket. Follows the app's status tokens rather than an
 * injected palette so it stays theme-consistent in light and dark:
 *   calm  < 75%   → --accent-green
 *   warm  75–90%  → --accent-yellow
 *   hot   > 90%   → --accent-red
 * Color is never the only channel — the percentage text always accompanies it.
 */
export type UsageSeverity = 'calm' | 'warm' | 'hot';

export function usageSeverity(utilization: number): UsageSeverity {
    if (utilization > 90) return 'hot';
    if (utilization >= 75) return 'warm';
    return 'calm';
}

/** CSS custom-property (app theme token) for a utilization level. */
export function usageColorVar(utilization: number): string {
    switch (usageSeverity(utilization)) {
        case 'hot':
            return 'var(--accent-red)';
        case 'warm':
            return 'var(--accent-yellow)';
        default:
            return 'var(--accent-green)';
    }
}

/** Clamp a utilization number into [0, 100] and round for display. */
export function clampPct(utilization: number): number {
    if (!Number.isFinite(utilization)) return 0;
    return Math.max(0, Math.min(100, Math.round(utilization)));
}

/**
 * Countdown to a reset time as a compact "2h 17m" / "43m" / "<1m" string.
 * Returns null when the timestamp is missing/invalid or already elapsed.
 */
export function formatCountdown(resetsAt: string | undefined, nowMs: number = Date.now()): string | null {
    if (!resetsAt) return null;
    const target = new Date(resetsAt).getTime();
    if (Number.isNaN(target)) return null;
    const diffMs = target - nowMs;
    if (diffMs <= 0) return null;
    const totalMin = Math.floor(diffMs / 60000);
    const days = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    const mins = totalMin % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    if (mins > 0) return `${mins}m`;
    return '<1m';
}

/** Absolute local reset time like "Wed 3:00 PM" for the dashboard rows. */
export function formatResetLocal(resetsAt: string | undefined): string {
    if (!resetsAt) return 'unknown';
    const target = new Date(resetsAt);
    if (Number.isNaN(target.getTime())) return 'unknown';
    const weekday = target.toLocaleDateString(undefined, { weekday: 'short' });
    const time = target.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `${weekday} ${time}`;
}

/** Capitalize a model name for display ("fable" → "Fable"). */
export function capitalizeModel(model: string): string {
    if (!model) return model;
    return model.charAt(0).toUpperCase() + model.slice(1);
}

/**
 * Render an extra-usage credit amount.
 *
 * The API reports these in MINOR units (cents); the backend mapper divides by
 * 100, so what reaches the UI is already in currency units. Printing the raw
 * value showed "4050 / 10000 credits" for $40.50 of a $100 cap. No currency
 * symbol is invented — the response's `currency` field is null in practice.
 */
export function formatCredits(amount: number | null | undefined): string {
    if (amount == null || !Number.isFinite(amount)) return 'Unlimited';
    return amount.toFixed(2);
}
