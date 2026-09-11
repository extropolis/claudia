/**
 * The gate shown when a page has no API token.
 *
 * Without it, a browser that failed to acquire a credential renders the normal
 * app with an empty task list and a WebSocket that never opens — no error, no
 * explanation. This is not a second way to ISSUE a token (the mobile QR/link
 * flow remains that); it explains the failure and takes a paste.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthTokenGate } from '../AuthTokenGate';
import { getAuthToken, clearAuthToken } from '../../config/auth-client';

const REAL_FETCH = window.fetch;

beforeEach(() => {
    clearAuthToken();
    window.sessionStorage.clear();
});

afterEach(() => {
    cleanup();
    clearAuthToken();
    window.fetch = REAL_FETCH;
});

describe('AuthTokenGate', () => {
    it('explains what is missing rather than showing an empty app', () => {
        render(<AuthTokenGate onAuthenticated={vi.fn()} />);
        expect(screen.getByRole('heading', { name: /token/i })).toBeInTheDocument();
        expect(screen.getByLabelText('API token')).toBeInTheDocument();
    });

    it('adopts a pasted token and reports success', async () => {
        const onAuthenticated = vi.fn();
        const user = userEvent.setup();
        render(<AuthTokenGate onAuthenticated={onAuthenticated} />);

        await user.type(screen.getByLabelText('API token'), 'pasted-token');
        await user.click(screen.getByRole('button', { name: 'Connect' }));

        expect(getAuthToken()).toBe('pasted-token');
        expect(onAuthenticated).toHaveBeenCalled();
    });

    it('refuses an empty submission and says why', async () => {
        const onAuthenticated = vi.fn();
        const user = userEvent.setup();
        render(<AuthTokenGate onAuthenticated={onAuthenticated} />);

        await user.click(screen.getByRole('button', { name: 'Connect' }));

        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(onAuthenticated).not.toHaveBeenCalled();
        expect(getAuthToken()).toBeNull();
    });

    it('retries the loopback bootstrap on request', async () => {
        window.fetch = vi.fn().mockResolvedValue({
            ok: true, json: async () => ({ token: 'tok-local' }),
        }) as unknown as typeof fetch;
        const onAuthenticated = vi.fn();
        const user = userEvent.setup();
        render(<AuthTokenGate onAuthenticated={onAuthenticated} />);

        await user.click(screen.getByRole('button', { name: 'Try this machine again' }));

        await waitFor(() => expect(onAuthenticated).toHaveBeenCalled());
        expect(getAuthToken()).toBe('tok-local');
    });

    it('explains the 403 a phone gets, instead of failing silently', async () => {
        window.fetch = vi.fn().mockResolvedValue({
            ok: false, status: 403, json: async () => ({}),
        }) as unknown as typeof fetch;
        const onAuthenticated = vi.fn();
        const user = userEvent.setup();
        render(<AuthTokenGate onAuthenticated={onAuthenticated} />);

        await user.click(screen.getByRole('button', { name: 'Try this machine again' }));

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/same machine/i));
        expect(onAuthenticated).not.toHaveBeenCalled();
    });
});
