import { useState, useEffect } from 'react';
import { X, Smartphone } from 'lucide-react';
import { getApiBaseUrl } from '../config/api-config';
import { logout } from '../config/auth-client';
import './MobileAccessModal.css';

/** Tailscale is operator-managed: this panel never starts a public tunnel. */
export function MobileAccessModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
    const [address, setAddress] = useState('');
    const [saved, setSaved] = useState('');
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);
    const [instanceId, setInstanceId] = useState('');
    useEffect(() => {
        if (!isOpen) return;
        let cancelled = false;
        setMessage('');
        void Promise.all([
            fetch(`${getApiBaseUrl()}/api/config`).then(r => { if (!r.ok) throw new Error(); return r.json(); }),
            fetch(`${getApiBaseUrl()}/api/server-info`).then(r => r.json()),
        ]).then(([config, info]) => {
            if (!cancelled) {
                setAddress(config.tailscaleUrl || '');
                setSaved(config.tailscaleUrl || '');
                setInstanceId(info.instanceId || '');
            }
        }).catch(() => { if (!cancelled) setMessage('Could not load host settings. Reopen Devices to retry.'); });
        return () => { cancelled = true; };
    }, [isOpen]);
    if (!isOpen) return null;

    const save = async () => {
        setBusy(true);
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/config`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tailscaleUrl: address.trim() }),
            });
            const body = await res.json();
            if (!res.ok) throw new Error(body.error || 'Could not save address.');
            const normalized = address.trim() ? new URL(address.trim()).origin : '';
            setSaved(normalized); setAddress(normalized);
            setMessage(normalized ? 'Address saved. Check the connection from each device.' : 'Address cleared. Tailscale Serve remains managed on your host.');
        } catch (err) { setMessage(err instanceof Error ? err.message : 'Could not save address.'); }
        finally { setBusy(false); }
    };
    const check = async () => {
        setBusy(true);
        try {
            // Identity is public. Never send the instance credential to an unverified address.
            const res = await fetch(`${saved}/api/server-info`, { credentials: 'omit', signal: AbortSignal.timeout(8000) });
            if (!res.ok) throw new Error();
            const info = await res.json();
            if (!instanceId || info.instanceId !== instanceId) {
                setMessage('This address points to a different host. Check the Serve address.');
            } else setMessage('This Claudia host is reachable from this device. Other devices must check their own connection.');
        } catch { setMessage('Could not verify this address. Check Tailscale, Serve, and that your host is awake. Try opening the address on the other device.'); }
        finally { setBusy(false); }
    };
    return (
        <div className="mobile-access-overlay" onClick={onClose}>
            <section className="mobile-access-modal" role="dialog" aria-modal="true" aria-label="Connect devices" onClick={e => e.stopPropagation()}>
                <button className="modal-close" aria-label="Close" onClick={onClose}><X size={18} /></button>
                <h2><Smartphone size={20} /> Connect devices</h2>
                <p>Use Tailscale to control this host from your phone or another computer. Tasks and files stay on the host; keep it awake.</p>
                <ol>
                    <li>Install Tailscale on the host and each device, and sign into the same tailnet.</li>
                    <li>Follow the <a href="https://github.com/extropolis/claudia/blob/main/docs/tailscale.md" target="_blank" rel="noreferrer">host setup guide</a>, then copy the HTTPS address from <code>tailscale serve status</code>.</li>
                    <li>Open that address on your device and paste the Claudia token obtained locally from your host.</li>
                </ol>
                <label htmlFor="tailscale-address">Tailscale HTTPS address</label>
                <input id="tailscale-address" type="url" placeholder="https://my-pc.tailnet.ts.net" value={address} onChange={e => setAddress(e.target.value)} />
                <div className="device-actions">
                    <button onClick={save} disabled={busy}>Save address</button>
                    <button disabled={busy || !saved || saved !== address} onClick={() => {
                        void navigator.clipboard.writeText(saved).then(() => setMessage('Address copied. It contains no token.')).catch(() => setMessage('Could not copy. Select the address and copy it manually.'));
                    }}>Copy address</button>
                    <button disabled={busy || !saved || saved !== address} onClick={check}>{busy ? 'Working…' : 'Check connection'}</button>
                </div>
                {message && <p role="status">{message}</p>}
                <p className="device-note">The token grants full control of this host. It is kept for this browser tab. Tailscale access is managed separately in your tailnet.</p>
                <button onClick={() => { void logout().catch(() => {}); }}>Log out of this browser</button>
            </section>
        </div>
    );
}
