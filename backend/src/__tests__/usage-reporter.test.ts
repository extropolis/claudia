import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setUserId, getUserId, reportUsage } from '../usage-reporter.js';

// Note: USAGE_DASHBOARD_URL is read at module-load time. In the test environment
// it is unset, so reportUsage is always a no-op (it never reaches fetch). These
// tests verify that contract: user-id state management plus the safe no-op path.

describe('usage-reporter', () => {
    let fetchSpy: any;

    beforeEach(() => {
        // Spy on fetch so we can assert it is never called when reporting is disabled.
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ ok: true, event_id: 1 }), { status: 200 }),
        );
    });

    afterEach(() => {
        fetchSpy.mockRestore();
    });

    describe('user id management', () => {
        it('starts null until a user id is set in this test ordering', () => {
            // getUserId reflects module-level state; we set it then read it back.
            setUserId('user-123');
            expect(getUserId()).toBe('user-123');
        });

        it('overwrites a previously set user id', () => {
            setUserId('first');
            expect(getUserId()).toBe('first');
            setUserId('second');
            expect(getUserId()).toBe('second');
        });
    });

    describe('reportUsage (dashboard disabled)', () => {
        it('resolves without throwing when no user id is set', async () => {
            // We cannot truly clear the id (no setter to null via public API in a
            // clean way), but with no dashboard URL it is a no-op regardless.
            await expect(
                reportUsage({ tokensInput: 100, tokensOutput: 50, model: 'sonnet' }),
            ).resolves.toBeUndefined();
        });

        it('does not call fetch when the dashboard URL is not configured', async () => {
            setUserId('user-xyz');
            await reportUsage({ tokensInput: 1000, tokensOutput: 200, model: 'opus' });
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it('handles zero usage without throwing', async () => {
            setUserId('user-zero');
            await expect(
                reportUsage({ tokensInput: 0, tokensOutput: 0, model: 'haiku' }),
            ).resolves.toBeUndefined();
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it('handles large token counts without throwing', async () => {
            setUserId('user-big');
            await expect(
                reportUsage({ tokensInput: 9_999_999, tokensOutput: 5_000_000, model: 'opus' }),
            ).resolves.toBeUndefined();
        });

        it('is safe to fire-and-forget multiple times', async () => {
            setUserId('user-multi');
            await Promise.all([
                reportUsage({ tokensInput: 1, tokensOutput: 1, model: 'a' }),
                reportUsage({ tokensInput: 2, tokensOutput: 2, model: 'b' }),
                reportUsage({ tokensInput: 3, tokensOutput: 3, model: 'c' }),
            ]);
            expect(fetchSpy).not.toHaveBeenCalled();
        });
    });
});
