import { describe, it, expect } from 'vitest';
import { parseCredentialsBlob, planLabelFromSubscription } from '../usage-credentials.js';

describe('parseCredentialsBlob', () => {
    it('parses the nested claudeAiOauth shape', () => {
        const blob = JSON.stringify({
            claudeAiOauth: {
                accessToken: 'tok-123',
                refreshToken: 'ref',
                expiresAt: 123,
                scopes: ['user'],
                subscriptionType: 'max',
                rateLimitTier: 'default',
            },
        });
        expect(parseCredentialsBlob(blob)).toEqual({
            accessToken: 'tok-123',
            subscriptionType: 'max',
        });
    });

    it('parses a bare shape (no claudeAiOauth wrapper)', () => {
        const blob = JSON.stringify({ accessToken: 'tok-abc', subscriptionType: 'pro' });
        expect(parseCredentialsBlob(blob)).toEqual({
            accessToken: 'tok-abc',
            subscriptionType: 'pro',
        });
    });

    it('returns null when accessToken is missing', () => {
        const blob = JSON.stringify({ claudeAiOauth: { subscriptionType: 'max' } });
        expect(parseCredentialsBlob(blob)).toBeNull();
    });

    it('returns null on malformed JSON', () => {
        expect(parseCredentialsBlob('not json {')).toBeNull();
    });

    it('returns null on empty input', () => {
        expect(parseCredentialsBlob('')).toBeNull();
    });

    it('omits subscriptionType when absent', () => {
        const blob = JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } });
        expect(parseCredentialsBlob(blob)).toEqual({ accessToken: 'tok' });
    });
});

describe('planLabelFromSubscription', () => {
    it('maps max to "Max"', () => {
        expect(planLabelFromSubscription('max')).toBe('Max');
    });

    it('maps pro to "Pro"', () => {
        expect(planLabelFromSubscription('pro')).toBe('Pro');
    });

    it('is case-insensitive', () => {
        expect(planLabelFromSubscription('MAX')).toBe('Max');
    });

    it('labels the team and enterprise plans instead of calling them Unknown', () => {
        // organization_type maps to max | pro | team | enterprise | null.
        expect(planLabelFromSubscription('team')).toBe('Team');
        expect(planLabelFromSubscription('enterprise')).toBe('Enterprise');
    });

    it('returns "Unknown" for unrecognized or missing values', () => {
        expect(planLabelFromSubscription('nonsense')).toBe('Unknown');
        expect(planLabelFromSubscription('')).toBe('Unknown');
        expect(planLabelFromSubscription(undefined)).toBe('Unknown');
    });
});
