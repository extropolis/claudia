import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { parseCredentialsBlob, planLabelFromSubscription, keychainServiceName } from '../usage-credentials.js';

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

describe('the Keychain service name matches Claude Code 2.1.263 exactly', () => {
    const saved = {
        cfg: process.env.CLAUDE_CONFIG_DIR,
        secure: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
    };
    afterEach(() => {
        if (saved.cfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = saved.cfg;
        if (saved.secure === undefined) delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
        else process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = saved.secure;
    });

    /** Claude Code's Sx("-credentials"), transcribed from the shipped binary. */
    function claudeCodeServiceName(): string {
        const e = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
        const t = e !== undefined ? !e : !process.env.CLAUDE_CONFIG_DIR;
        const r = e !== undefined
            ? e.normalize('NFC')
            : (process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')).normalize('NFC');
        const c = t ? '' : `-${createHash('sha256').update(r).digest('hex').slice(0, 8)}`;
        return `Claude Code-credentials${c}`;
    }

    it.each([
        ['unset', undefined],
        ['a plain path', '/tmp/some-other-claude'],
        // NFD: what macOS hands you for an accented path. Claude Code
        // NFC-normalizes before hashing; not doing so yields a different
        // service name and therefore a silent "no token".
        ['an NFD path', '/tmp/Cafe\u0301/.claude'],
        // Claude Code does NOT trim. A stray trailing space is part of the
        // hashed string, so trimming it also produces the wrong name.
        ['a path with a trailing space', '/tmp/relocated/.claude '],
        ['a path with a leading space', ' /tmp/relocated/.claude'],
    ])('agrees with Claude Code for %s', (_label, value) => {
        delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
        if (value === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = value;
        expect(keychainServiceName()).toBe(claudeCodeServiceName());
    });

    it('CLAUDE_SECURESTORAGE_CONFIG_DIR takes precedence over CLAUDE_CONFIG_DIR', () => {
        process.env.CLAUDE_CONFIG_DIR = '/tmp/one';
        process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = '/tmp/two';
        expect(keychainServiceName()).toBe(claudeCodeServiceName());
        expect(keychainServiceName()).not.toBe('Claude Code-credentials');
    });

    it('an empty CLAUDE_SECURESTORAGE_CONFIG_DIR means the default, not a suffix', () => {
        process.env.CLAUDE_CONFIG_DIR = '/tmp/one';
        process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = '';
        expect(keychainServiceName()).toBe('Claude Code-credentials');
        expect(keychainServiceName()).toBe(claudeCodeServiceName());
    });

    it('still yields the plain name on an unrelocated install', () => {
        delete process.env.CLAUDE_CONFIG_DIR;
        delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
        // Verified against the real login keychain: svce="Claude Code-credentials".
        expect(keychainServiceName()).toBe('Claude Code-credentials');
    });
});
