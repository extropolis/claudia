import { describe, it, expect } from 'vitest';
import { mapUsageResponse } from '../usage-mapper.js';

const raw = {
    five_hour: { utilization: 31, resets_at: '2026-07-02T04:00:00Z' },
    seven_day: { utilization: 28, resets_at: '2026-07-08T15:00:00Z' },
    seven_day_opus: { utilization: 12, resets_at: '2026-07-08T14:59:00Z' },
    seven_day_sonnet: null,
    seven_day_haiku: { utilization: 9, resets_at: '2026-07-08T14:59:00Z' },
    // Real non-model buckets that share the prefix; must not become models.
    seven_day_oauth_apps: { utilization: 77, resets_at: '2026-07-08T14:59:00Z' },
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
};

describe('mapUsageResponse', () => {
    it('maps windows, allowlisted per-model keys, and drops nulls', () => {
        const u = mapUsageResponse(raw, 'Max', '2026-07-02T01:00:00Z');
        expect(u.fiveHour).toEqual({ utilization: 31, resetsAt: '2026-07-02T04:00:00Z' });
        expect(u.sevenDay.utilization).toBe(28);
        expect(u.sevenDay.resetsAt).toBe('2026-07-08T15:00:00Z');
        expect(u.sevenDayByModel.map((m) => m.model).sort()).toEqual(['haiku', 'opus']);
        expect(u.sevenDayByModel.find((m) => m.model === 'haiku')?.utilization).toBe(9);
        expect(u.sevenDayByModel.find((m) => m.model === 'opus')?.resetsAt).toBe(
            '2026-07-08T14:59:00Z'
        );
        expect(u.extraUsage?.isEnabled).toBe(false);
        expect(u.planLabel).toBe('Max');
        expect(u.fetchedAt).toBe('2026-07-02T01:00:00Z');
    });

    it('omits per-model windows whose value is null', () => {
        const u = mapUsageResponse(raw, 'Pro', '2026-07-02T01:00:00Z');
        expect(u.sevenDayByModel.find((m) => m.model === 'sonnet')).toBeUndefined();
    });

    it('surfaces a new model through limits[] without code changes', () => {
        // Post-Fable the top-level per-model fields are null; new models only
        // ever appear in limits[], which stays fully generic.
        const withFuture = {
            five_hour: { utilization: 5, resets_at: 'x' },
            seven_day: { utilization: 5, resets_at: 'x' },
            limits: [
                { kind: 'weekly_scoped', percent: 3, resets_at: 'y', is_active: true,
                  scope: { model: { id: null, display_name: 'Some Future Model' } } },
            ],
        };
        const u = mapUsageResponse(withFuture, 'Max', 'now');
        expect(u.sevenDayByModel).toEqual([
            { model: 'some future model', utilization: 3, resetsAt: 'y' },
        ]);
    });

    it('carries extra_usage details when enabled', () => {
        const withExtra = {
            five_hour: { utilization: 0, resets_at: 'x' },
            seven_day: { utilization: 0, resets_at: 'x' },
            // Amounts arrive in minor units (cents) and are normalized to
            // currency units by the mapper.
            extra_usage: { is_enabled: true, monthly_limit: 10000, used_credits: 4200, utilization: 42 },
        };
        const u = mapUsageResponse(withExtra, 'Max', 'now');
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
        const u = mapUsageResponse(outOfRange, 'Max', 'now');
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

    // Real-world payload shape observed 2026-07-02: per-model weekly data does
    // NOT arrive as `seven_day_<model>` keys (those are null); it arrives in a
    // `limits[]` array as `kind:"weekly_scoped"` with `scope.model.display_name`.
    it('derives per-model weekly windows from the limits[] array', () => {
        const realish = {
            five_hour: { utilization: 45, resets_at: '2026-07-02T20:30:00Z' },
            seven_day: { utilization: 31, resets_at: '2026-07-08T15:00:00Z' },
            seven_day_opus: null,
            seven_day_sonnet: null,
            seven_day_cowork: null,
            tangelo: null,
            iguana_necktie: null,
            limits: [
                { kind: 'session', percent: 45, resets_at: '2026-07-02T20:30:00Z', scope: null },
                { kind: 'weekly_all', percent: 31, resets_at: '2026-07-08T15:00:00Z', scope: null },
                {
                    kind: 'weekly_scoped',
                    percent: 41,
                    resets_at: '2026-07-08T15:00:00Z',
                    scope: { model: { id: null, display_name: 'Fable' } },
                },
            ],
        };
        const u = mapUsageResponse(realish, 'Max', 'now');
        expect(u.sevenDayByModel).toEqual([
            { model: 'fable', utilization: 41, resetsAt: '2026-07-08T15:00:00Z' },
        ]);
    });

    it('prefers a non-null seven_day_<model> key over a duplicate limits[] entry', () => {
        const both = {
            five_hour: { utilization: 0, resets_at: 'x' },
            seven_day: { utilization: 0, resets_at: 'x' },
            seven_day_opus: { utilization: 20, resets_at: 'a' },
            limits: [
                {
                    kind: 'weekly_scoped',
                    percent: 99,
                    resets_at: 'b',
                    scope: { model: { display_name: 'Opus' } },
                },
            ],
        };
        const u = mapUsageResponse(both, 'Max', 'now');
        const opus = u.sevenDayByModel.filter((m) => m.model === 'opus');
        expect(opus).toEqual([{ model: 'opus', utilization: 20, resetsAt: 'a' }]);
    });
});

// -------------------------------------------------------------------------
// Regressions from an audit against real captured `/api/oauth/usage` payloads
// (July + Sept 2026) and Claude Code's own `Utilization` type.
// -------------------------------------------------------------------------

describe('mapUsageResponse — real-payload edge cases', () => {
    it('does not surface non-model seven_day_* buckets as models', () => {
        // All three of these are real keys in the live payload and none is a
        // model: oauth_apps = third-party OAuth apps, cowork = Daily Routines,
        // omelette = Claude Design.
        const u = mapUsageResponse({
            five_hour: { utilization: 10, resets_at: 'a' },
            seven_day: { utilization: 20, resets_at: 'b' },
            seven_day_oauth_apps: { utilization: 90, resets_at: 'c' },
            seven_day_cowork: { utilization: 80, resets_at: 'c' },
            seven_day_omelette: { utilization: 70, resets_at: 'c' },
            seven_day_opus: { utilization: 12, resets_at: 'd' },
            seven_day_sonnet: { utilization: 34, resets_at: 'e' },
        }, 'Max', 'now');

        expect(u.sevenDayByModel.map((m) => m.model).sort()).toEqual(['opus', 'sonnet']);
    });

    it('does not echo an arbitrary upstream key name back into the payload', () => {
        // The seven_day_<x> prefix used to be matched generically, which made
        // the served payload a mirror of whatever keys upstream sent.
        const u = mapUsageResponse({
            five_hour: { utilization: 1, resets_at: 'a' },
            'seven_day_totally-made-up-key': { utilization: 99, resets_at: 'z' },
        }, 'Max', 'now');
        expect(JSON.stringify(u)).not.toContain('totally-made-up-key');
    });

    it('drops inactive weekly_scoped placeholder rows', () => {
        // Real capture: an entry exists for every model the account *could*
        // have a scoped limit for, flagged is_active:false with percent 0 and
        // a null reset. Rendering those produced phantom "0%" model bars.
        const u = mapUsageResponse({
            five_hour: { utilization: 5, resets_at: 'a' },
            limits: [
                { kind: 'weekly_scoped', group: 'weekly', percent: 0, resets_at: null,
                  is_active: false, scope: { model: { id: null, display_name: 'Fable' } } },
                { kind: 'weekly_scoped', group: 'weekly', percent: 41, resets_at: '2026-07-08T15:00:00Z',
                  is_active: true, scope: { model: { id: null, display_name: 'Claude Opus 4' } } },
            ],
        }, 'Max', 'now');

        expect(u.sevenDayByModel).toEqual([
            { model: 'claude opus 4', utilization: 41, resetsAt: '2026-07-08T15:00:00Z' },
        ]);
    });

    it('drops a 0%-with-no-reset row even when is_active is absent', () => {
        const u = mapUsageResponse({
            five_hour: { utilization: 5, resets_at: 'a' },
            limits: [
                { kind: 'weekly_scoped', percent: 0, resets_at: null,
                  scope: { model: { display_name: 'Fable' } } },
            ],
        }, 'Max', 'now');
        expect(u.sevenDayByModel).toEqual([]);
    });

    it('ignores non-weekly_scoped limit kinds', () => {
        const u = mapUsageResponse({
            five_hour: { utilization: 5, resets_at: 'a' },
            limits: [
                { kind: 'session', group: 'session', percent: 50, resets_at: 'x', is_active: true },
                { kind: 'weekly_all', group: 'weekly', percent: 60, resets_at: 'y', is_active: true },
            ],
        }, 'Max', 'now');
        expect(u.sevenDayByModel).toEqual([]);
    });

    it('rejects an implausibly long model display_name rather than republishing it', () => {
        const u = mapUsageResponse({
            five_hour: { utilization: 5, resets_at: 'a' },
            limits: [
                { kind: 'weekly_scoped', percent: 10, resets_at: 'x', is_active: true,
                  scope: { model: { display_name: 'M'.repeat(500) } } },
            ],
        }, 'Max', 'now');
        expect(u.sevenDayByModel).toEqual([]);
    });

    it('converts extra_usage minor units (cents) into currency units', () => {
        // Claude Code divides used_credits and monthly_limit by 100 before
        // display; reporting them raw showed "$4000 / $10000" for $40 / $100.
        const u = mapUsageResponse({
            five_hour: { utilization: 5, resets_at: 'a' },
            extra_usage: { is_enabled: true, monthly_limit: 10000, used_credits: 4050, utilization: 40.5 },
        }, 'Max', 'now');
        expect(u.extraUsage).toEqual({
            isEnabled: true, monthlyLimit: 100, usedCredits: 40.5, utilization: 40.5,
        });
    });

    it('keeps null extra_usage amounts null (monthly_limit null = unlimited)', () => {
        const u = mapUsageResponse({
            five_hour: { utilization: 5, resets_at: 'a' },
            extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
        }, 'Max', 'now');
        expect(u.extraUsage).toEqual({
            isEnabled: false, monthlyLimit: null, usedCredits: null, utilization: null,
        });
    });

    it('reports no_data instead of a fake 0% meter when every window is null', () => {
        // Enterprise accounts get null for every bucket. A flat 0% bar there is
        // not "0% used", it is "this does not apply to you".
        const u = mapUsageResponse({
            five_hour: null, seven_day: null,
            seven_day_opus: null, seven_day_sonnet: null,
            limits: [], extra_usage: null,
        }, 'Enterprise', 'now');
        expect(u.unavailable).toBe(true);
        expect(u.reason).toBe('no_data');
    });

    it('does NOT report no_data when only the per-model limits are populated', () => {
        const u = mapUsageResponse({
            five_hour: null, seven_day: null,
            limits: [
                { kind: 'weekly_scoped', percent: 41, resets_at: 'z', is_active: true,
                  scope: { model: { display_name: 'Claude Opus 4' } } },
            ],
        }, 'Max', 'now');
        expect(u.unavailable).toBeUndefined();
        expect(u.sevenDayByModel).toHaveLength(1);
    });

    it('survives a completely empty / garbage response without throwing', () => {
        for (const raw of [null, undefined, {}, [], 'nope', 42, { limits: 'not-an-array' }]) {
            const u = mapUsageResponse(raw, 'Pro', 'now');
            expect(u.fiveHour).toEqual({ utilization: 0, resetsAt: '' });
            expect(u.sevenDayByModel).toEqual([]);
            expect(u.planLabel).toBe('Pro');
        }
    });
});
