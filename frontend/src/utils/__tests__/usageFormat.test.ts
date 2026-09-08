import { describe, it, expect } from 'vitest';
import {
    usageSeverity,
    usageColorVar,
    clampPct,
    formatCountdown,
    formatResetLocal,
    capitalizeModel,
    formatCredits,
} from '../usageFormat';

describe('usageFormat', () => {
    describe('usageSeverity / usageColorVar', () => {
        it('buckets utilization into calm / warm / hot', () => {
            expect(usageSeverity(0)).toBe('calm');
            expect(usageSeverity(74.9)).toBe('calm');
            expect(usageSeverity(75)).toBe('warm');
            expect(usageSeverity(90)).toBe('warm');
            expect(usageSeverity(90.1)).toBe('hot');
            expect(usageSeverity(100)).toBe('hot');
        });

        it('maps severity to the app theme tokens', () => {
            expect(usageColorVar(10)).toBe('var(--accent-green)');
            expect(usageColorVar(80)).toBe('var(--accent-yellow)');
            expect(usageColorVar(95)).toBe('var(--accent-red)');
        });
    });

    describe('clampPct', () => {
        it('rounds and clamps into [0, 100]', () => {
            expect(clampPct(45.4)).toBe(45);
            expect(clampPct(45.6)).toBe(46);
            expect(clampPct(-3)).toBe(0);
            expect(clampPct(140)).toBe(100);
        });

        it('treats non-finite input as 0', () => {
            expect(clampPct(NaN)).toBe(0);
            expect(clampPct(Infinity)).toBe(0);
        });
    });

    describe('formatCountdown', () => {
        const now = Date.parse('2026-07-02T12:00:00Z');

        it('returns null for missing, invalid, or elapsed timestamps', () => {
            expect(formatCountdown(undefined, now)).toBeNull();
            expect(formatCountdown('', now)).toBeNull();
            expect(formatCountdown('not-a-date', now)).toBeNull();
            expect(formatCountdown('2026-07-02T11:59:00Z', now)).toBeNull();
            expect(formatCountdown('2026-07-02T12:00:00Z', now)).toBeNull();
        });

        it('formats days / hours / minutes / sub-minute', () => {
            expect(formatCountdown('2026-07-04T15:00:00Z', now)).toBe('2d 3h');
            expect(formatCountdown('2026-07-02T14:17:00Z', now)).toBe('2h 17m');
            expect(formatCountdown('2026-07-02T12:43:00Z', now)).toBe('43m');
            expect(formatCountdown('2026-07-02T12:00:30Z', now)).toBe('<1m');
        });

        it('defaults to the current clock when nowMs is omitted', () => {
            const future = new Date(Date.now() + 2 * 3_600_000 + 60_000).toISOString();
            expect(formatCountdown(future)).toMatch(/^2h \d+m$/);
        });
    });

    describe('formatResetLocal', () => {
        it('returns "unknown" for missing or invalid input', () => {
            expect(formatResetLocal(undefined)).toBe('unknown');
            expect(formatResetLocal('')).toBe('unknown');
            expect(formatResetLocal('garbage')).toBe('unknown');
        });

        it('renders a short weekday plus a local time', () => {
            const out = formatResetLocal('2026-07-08T15:00:00Z');
            // Locale-dependent, so assert the shape rather than exact text.
            expect(out).toMatch(/^[A-Za-z]{3}\s+\d{1,2}:\d{2}/);
        });
    });

    describe('capitalizeModel', () => {
        it('capitalizes the first letter only', () => {
            expect(capitalizeModel('fable')).toBe('Fable');
            expect(capitalizeModel('Opus')).toBe('Opus');
        });

        it('passes through empty strings', () => {
            expect(capitalizeModel('')).toBe('');
        });
    });
});

describe('formatCredits', () => {
    it('renders a normalized currency amount to two places', () => {
        // The mapper has already divided the API's minor units by 100.
        expect(formatCredits(40.5)).toBe('40.50');
        expect(formatCredits(0)).toBe('0.00');
        expect(formatCredits(100)).toBe('100.00');
    });

    it('renders a null/absent monthly limit as Unlimited', () => {
        expect(formatCredits(null)).toBe('Unlimited');
        expect(formatCredits(undefined)).toBe('Unlimited');
        expect(formatCredits(NaN)).toBe('Unlimited');
    });
});
