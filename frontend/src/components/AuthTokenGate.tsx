import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { setAuthToken, fetchLocalToken } from '../config/auth-client';
import './AuthTokenGate.css';

/**
 * Shown when this page has no API token.
 *
 * Every `/api` route and every WebSocket upgrade requires a credential now
 * (backend/src/auth-token.ts), so a page without one can do nothing at all —
 * it would render an empty task list and a socket that never opens, with no
 * explanation. This says what is missing and offers the two ways to fix it.
 *
 * It is deliberately NOT a second way to hand out tokens. The existing mobile
 * flow is the way: the backend prints a URL carrying the token, and
 * MobileAccessModal renders that same URL as a QR code. This gate points at
 * those and accepts a paste, nothing more.
 */
export function AuthTokenGate({ onAuthenticated }: { onAuthenticated: () => void }) {
    const [value, setValue] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [retrying, setRetrying] = useState(false);

    const submit = (e: React.FormEvent) => {
        e.preventDefault();
        const trimmed = value.trim();
        if (!trimmed) {
            setError('Paste the token from the URL Claudia printed at startup.');
            return;
        }
        setAuthToken(trimmed);
        onAuthenticated();
    };

    // A second chance at the loopback bootstrap: the backend may simply not
    // have been up yet when the page booted.
    const retryLocal = async () => {
        setRetrying(true);
        setError(null);
        const token = await fetchLocalToken();
        setRetrying(false);
        if (token) {
            setAuthToken(token);
            onAuthenticated();
            return;
        }
        setError('The backend did not grant a token. It only does that for a browser ' +
                 'on the same machine — from another device, use the link or QR code ' +
                 'from Mobile Access.');
    };

    return (
        <div className="auth-gate">
            <form className="auth-gate-card" onSubmit={submit}>
                <div className="auth-gate-title">
                    <KeyRound size={20} />
                    <h2>Claudia needs a token</h2>
                </div>
                <p className="auth-gate-body">
                    Every API request and WebSocket connection is authenticated. On this
                    machine <code>./start.sh</code> prints a URL that already carries the
                    token; from a phone or another device, open the link or scan the QR
                    code in Mobile Access.
                </p>
                <input
                    className="auth-gate-input"
                    type="password"
                    autoFocus
                    placeholder="Paste token"
                    aria-label="API token"
                    value={value}
                    onChange={(e) => { setValue(e.target.value); setError(null); }}
                />
                {error && <p className="auth-gate-error" role="alert">{error}</p>}
                <div className="auth-gate-actions">
                    <button type="button" className="auth-gate-secondary" onClick={retryLocal} disabled={retrying}>
                        {retrying ? 'Asking…' : 'Try this machine again'}
                    </button>
                    <button type="submit" className="auth-gate-primary">Connect</button>
                </div>
            </form>
        </div>
    );
}
