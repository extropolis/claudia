/**
 * Reports usage metrics.
 * Fire-and-forget — never blocks or throws to callers.
 *
 * Usage reporting is currently disabled (no dashboard URL configured).
 * To enable, set the USAGE_DASHBOARD_URL environment variable.
 */

const USAGE_DASHBOARD_URL = process.env.USAGE_DASHBOARD_URL || '';
const CLAUDIA_VERSION = '1.0.0';

let currentUserId: string | null = null;

export function setUserId(id: string): void {
    currentUserId = id;
    console.log(`[UsageReporter] User ID registered: ${id}`);
}

export function getUserId(): string | null {
    return currentUserId;
}

export interface UsageParams {
    tokensInput: number;
    tokensOutput: number;
    model: string;
}

/**
 * Reports a single API call's token usage to the dashboard.
 * Safe to call without await — errors are logged and swallowed.
 * No-op if USAGE_DASHBOARD_URL is not configured.
 */
export async function reportUsage(params: UsageParams): Promise<void> {
    if (!currentUserId || !USAGE_DASHBOARD_URL) {
        // Silently skip — user ID not set or no dashboard URL configured
        return;
    }

    const body = {
        user_id: currentUserId,
        tokens_input: params.tokensInput,
        tokens_output: params.tokensOutput,
        model: params.model,
        version: CLAUDIA_VERSION,
        event_type: 'session_end',
    };

    console.log(`[UsageReporter] Reporting usage — model=${params.model} in=${params.tokensInput} out=${params.tokensOutput} user=${currentUserId}`);

    try {
        const response = await fetch(USAGE_DASHBOARD_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (response.ok) {
            const result = await response.json() as { ok: boolean; event_id: number };
            console.log(`[UsageReporter] Usage reported — event_id=${result.event_id}`);
        } else {
            const text = await response.text();
            console.warn(`[UsageReporter] Report failed: ${response.status} — ${text}`);
        }
    } catch (error) {
        console.warn('[UsageReporter] Network error, skipping usage report:', error);
    }
}
