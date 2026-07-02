import { describe, it, expect } from 'vitest';
import { mapUsageResponse } from '../usage-mapper';

const raw = {
    five_hour: { utilization: 31, resets_at: '2026-07-02T04:00:00Z' },
    seven_day: { utilization: 28, resets_at: '2026-07-08T15:00:00Z' },
    seven_day_opus: { utilization: 12, resets_at: '2026-07-08T14:59:00Z' },
    seven_day_sonnet: null,
    seven_day_fable: { utilization: 9, resets_at: '2026-07-08T14:59:00Z' },
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
};

describe('mapUsageResponse', () => {
    it('maps windows, generic per-model keys, and drops nulls', () => {
        const u = mapUsageResponse(raw, 'Max (20x)', '2026-07-02T01:00:00Z');
        expect(u.fiveHour).toEqual({ utilization: 31, resetsAt: '2026-07-02T04:00:00Z' });
        expect(u.sevenDay.utilization).toBe(28);
        expect(u.sevenDay.resetsAt).toBe('2026-07-08T15:00:00Z');
        expect(u.sevenDayByModel.map((m) => m.model).sort()).toEqual(['fable', 'opus']);
        expect(u.sevenDayByModel.find((m) => m.model === 'fable')?.utilization).toBe(9);
        expect(u.sevenDayByModel.find((m) => m.model === 'opus')?.resetsAt).toBe(
            '2026-07-08T14:59:00Z'
        );
        expect(u.extraUsage?.isEnabled).toBe(false);
        expect(u.planLabel).toBe('Max (20x)');
        expect(u.fetchedAt).toBe('2026-07-02T01:00:00Z');
    });

    it('omits per-model windows whose value is null', () => {
        const u = mapUsageResponse(raw, 'Pro', '2026-07-02T01:00:00Z');
        expect(u.sevenDayByModel.find((m) => m.model === 'sonnet')).toBeUndefined();
    });

    it('includes an unknown future per-model key without code changes', () => {
        const withFuture = {
            five_hour: { utilization: 5, resets_at: 'x' },
            seven_day: { utilization: 5, resets_at: 'x' },
            seven_day_haiku: { utilization: 3, resets_at: 'y' },
        };
        const u = mapUsageResponse(withFuture, 'Max (20x)', 'now');
        expect(u.sevenDayByModel).toEqual([{ model: 'haiku', utilization: 3, resetsAt: 'y' }]);
    });

    it('carries extra_usage details when enabled', () => {
        const withExtra = {
            five_hour: { utilization: 0, resets_at: 'x' },
            seven_day: { utilization: 0, resets_at: 'x' },
            extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 42, utilization: 42 },
        };
        const u = mapUsageResponse(withExtra, 'Max (20x)', 'now');
        expect(u.extraUsage).toEqual({
            isEnabled: true,
            monthlyLimit: 100,
            usedCredits: 42,
            utilization: 42,
        });
    });

    it('clamps utilization defensively into [0, 100]', () => {
        const outOfRange = {
            five_hour: { utilization: 140, resets_at: 'x' },
            seven_day: { utilization: -5, resets_at: 'x' },
        };
        const u = mapUsageResponse(outOfRange, 'Max (20x)', 'now');
        expect(u.fiveHour.utilization).toBe(100);
        expect(u.sevenDay.utilization).toBe(0);
    });

    it('defaults missing windows to zero utilization rather than throwing', () => {
        const u = mapUsageResponse({}, 'Unknown', 'now');
        expect(u.fiveHour.utilization).toBe(0);
        expect(u.sevenDay.utilization).toBe(0);
        expect(u.sevenDayByModel).toEqual([]);
        expect(u.extraUsage).toBeUndefined();
    });
});
