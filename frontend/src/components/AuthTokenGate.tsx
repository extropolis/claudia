import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { setAuthToken, fetchLocalToken, validateAuthToken } from '../config/auth-client';
import './AuthTokenGate.css';

/** Connect only after the host accepts the supplied credential. */
export function AuthTokenGate({ onAuthenticated }: { onAuthenticated: () => void }) {
    const [value, setValue] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [retrying, setRetrying] = useState(false);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        const trimmed = value.trim();
        if (!trimmed) {
            setError('Paste the token from the URL Claudia printed at startup.');
            return;
        }
        setRetrying(true);
        const result = await validateAuthToken(trimmed);
        setRetrying(false);
        if (result !== 'ok') {
            setError(result === 'rejected' ? 'Token rejected. Copy the current token from your host.' : 'Host unavailable. Check that your host is awake and both devices are connected to Tailscale, then retry.');
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
                 'on the same machine — from another device, paste the token ' +
                 'from your host.');
    };

    return (
        <div className="auth-gate">
            <form className="auth-gate-card" onSubmit={submit}>
                <div className="auth-gate-title">
                    <KeyRound size={20} />
                    <h2>Claudia needs a token</h2>
                </div>
                <p className="auth-gate-body">
                    Connect to your host with Tailscale, then paste its Claudia token.
                    Obtain the token locally on the host from its startup URL or auth-token file.
                    Your tasks and files stay on that host.
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
                    <button type="submit" className="auth-gate-primary" disabled={retrying}>{retrying ? 'Connecting…' : 'Connect'}</button>
                </div>
            </form>
        </div>
    );
}
