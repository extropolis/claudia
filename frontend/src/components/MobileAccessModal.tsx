import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Smartphone, Copy, Check, StopCircle, Play, AlertTriangle } from 'lucide-react';
import QRCode from 'qrcode';
import { getApiBaseUrl } from '../config/api-config';
import './MobileAccessModal.css';

interface TunnelStatus {
    active: boolean;
    url: string | null;
    token: string | null;
    startedAt: string | null;
    error: string | null;
    publicIp: string | null;
    /** Reserved ngrok domain the tunnel is pinned to, null = ngrok assigns it. */
    domain?: string | null;
    /** null = not probed. false = the URL did not answer from the host machine. */
    reachable?: boolean | null;
    warning?: string | null;
}

interface MobileAccessModalProps {
    isOpen: boolean;
    onClose: () => void;
    error?: string | null;
    tunnelActive?: boolean;
    tunnelLoading?: boolean;
    onStopTunnel?: () => void;
    onStartTunnel?: () => void;
}

export function MobileAccessModal({ isOpen, onClose, error, tunnelLoading, onStopTunnel, onStartTunnel }: MobileAccessModalProps) {
    const [status, setStatus] = useState<TunnelStatus | null>(null);
    const [copied, setCopied] = useState(false);
    const [domainInput, setDomainInput] = useState('');
    const [domainSaved, setDomainSaved] = useState(false);
    const [domainError, setDomainError] = useState<string | null>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);

    const apiBase = getApiBaseUrl();

    // Fetch current tunnel status
    const fetchStatus = useCallback(async () => {
        try {
            const res = await fetch(`${apiBase}/api/tunnel/status`);
            const data = await res.json();
            setStatus(data);
            return data;
        } catch (err) {
            console.error('[MobileAccess] Failed to fetch status:', err);
            return null;
        }
    }, [apiBase]);

    // Seed the domain field from saved config each time the modal opens.
    useEffect(() => {
        if (!isOpen) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`${apiBase}/api/config`);
                const cfg = await res.json();
                if (!cancelled) setDomainInput(cfg?.ngrokDomain || '');
            } catch (err) {
                console.error('[MobileAccess] Failed to load ngrokDomain:', err);
            }
        })();
        return () => { cancelled = true; };
    }, [isOpen, apiBase]);

    const saveDomain = useCallback(async () => {
        setDomainError(null);
        try {
            const res = await fetch(`${apiBase}/api/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ngrokDomain: domainInput.trim() }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                setDomainError(body?.error || `Save failed (HTTP ${res.status})`);
                return;
            }
            console.log('[MobileAccess] ngrokDomain saved:', domainInput.trim() || '(ngrok-assigned)');
            setDomainSaved(true);
            setTimeout(() => setDomainSaved(false), 2000);
        } catch (err) {
            setDomainError(err instanceof Error ? err.message : String(err));
        }
    }, [apiBase, domainInput]);

    // Poll for tunnel status when modal is open (tunnel may still be starting)
    useEffect(() => {
        if (!isOpen || error) return;

        // Fetch immediately
        fetchStatus();

        // Poll every 2s until we have an active URL
        const interval = setInterval(async () => {
            const data = await fetchStatus();
            if (data?.active && data?.url) {
                clearInterval(interval);
            }
        }, 2000);

        return () => clearInterval(interval);
    }, [isOpen, error, fetchStatus]);

    // Generate QR code when URL changes or modal reopens (canvas is a new DOM element each time)
    useEffect(() => {
        if (!isOpen || !status?.active || !status.url || !status.token || !canvasRef.current) return;

        const mobileUrl = `${status.url}/?token=${status.token}`;
        console.log('[MobileAccess] Generating QR for:', mobileUrl);

        QRCode.toCanvas(canvasRef.current, mobileUrl, {
            width: 200,
            margin: 2,
            color: {
                dark: '#e6edf3',
                light: '#0d1117'
            }
        }).catch((err: Error) => {
            console.error('[MobileAccess] QR generation failed:', err);
        });
    }, [isOpen, status?.active, status?.url, status?.token]);

    // Copy URL to clipboard
    const copyUrl = () => {
        if (!status?.url || !status?.token) return;
        const mobileUrl = `${status.url}/?token=${status.token}`;
        navigator.clipboard.writeText(mobileUrl).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    if (!isOpen) return null;

    const mobileUrl = status?.active && status?.url && status?.token
        ? `${status.url}/?token=${status.token}`
        : '';

    return (
        <div className="mobile-access-overlay" onClick={onClose}>
            <div className="mobile-access-modal" onClick={e => e.stopPropagation()} style={{ position: 'relative' }}>
                <button className="modal-close" onClick={onClose}>
                    <X size={18} />
                </button>

                <h2>
                    <Smartphone size={20} />
                    Mobile Voice Access
                </h2>

                {/* Status */}
                <div className="tunnel-status">
                    <span className={`status-dot ${status?.active ? 'active' : error ? 'error' : tunnelLoading ? 'starting' : 'inactive'}`} />
                    <span>
                        {status?.active
                            ? 'Tunnel active'
                            : error
                                ? 'Connection failed'
                                : tunnelLoading
                                    ? 'Starting tunnel...'
                                    : 'Tunnel not running'}
                    </span>
                    {tunnelLoading && <span className="loading-spinner" />}
                </div>

                {/* Error message */}
                {error && (
                    <div className="tunnel-error">
                        {error}
                    </div>
                )}

                {/* QR Code */}
                <div className="qr-code-area">
                    {status?.active ? (
                        <canvas ref={canvasRef} />
                    ) : error ? (
                        <div className="qr-placeholder error">
                            Failed
                        </div>
                    ) : tunnelLoading ? (
                        <div className="qr-placeholder">
                            Starting...
                        </div>
                    ) : (
                        <div className="qr-placeholder">
                            Not connected
                        </div>
                    )}
                </div>

                {/* URL - always rendered to maintain layout */}
                <div className="tunnel-url-area">
                    <label>Mobile URL</label>
                    <div className="tunnel-url-row">
                        <input type="text" aria-label="Mobile URL" readOnly value={mobileUrl || ''} placeholder="Not connected" />
                        <button onClick={copyUrl} title="Copy URL" disabled={!mobileUrl}>
                            {copied ? <Check size={14} /> : <Copy size={14} />}
                            {copied ? 'Copied!' : 'Copy'}
                        </button>
                    </div>
                </div>

                {/* Unreachable-URL warning. A tunnel can be "active" while its
                    hostname is blocked on the network, in which case phones get
                    a blank page and nothing else in the UI would say so. */}
                {status?.active && status?.reachable === false && (
                    <div className="tunnel-error" role="alert">
                        <AlertTriangle size={14} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />
                        {status.warning || 'The tunnel URL could not be reached from this machine.'}
                    </div>
                )}

                {/* Reserved domain (paid ngrok). Blank = free tier, ngrok picks
                    the URL and it changes between sessions. */}
                <div className="tunnel-url-area">
                    <label>ngrok domain (optional)</label>
                    <div className="tunnel-url-row">
                        <input
                            type="text"
                            aria-label="ngrok domain"
                            value={domainInput}
                            onChange={(e) => setDomainInput(e.target.value)}
                            placeholder="blank = free tier, ngrok assigns the URL"
                            spellCheck={false}
                            autoCapitalize="none"
                            autoCorrect="off"
                        />
                        <button onClick={saveDomain} title="Save reserved domain">
                            {domainSaved ? <Check size={14} /> : null}
                            {domainSaved ? 'Saved' : 'Save'}
                        </button>
                    </div>
                    <small>
                        Pin a domain you have reserved on your own ngrok account (e.g.{' '}
                        <code>your-name.ngrok.app</code>) so the URL never changes. It also gets you off{' '}
                        <code>ngrok-free.dev</code>, which some networks and mobile carriers block outright.
                        Reserve it under <strong>Universal Gateway &rarr; Domains</strong> in the ngrok
                        dashboard &mdash; do <em>not</em> create a Cloud Endpoint for the same name, as that
                        serves the URL itself and blocks the agent from binding it. Applies on the next
                        tunnel start.
                    </small>
                    {domainError && <div className="tunnel-error">{domainError}</div>}
                </div>

                {/* Instructions */}
                <div className="mobile-instructions">
                    <ol>
                        <li>Scan the QR code with your phone's camera</li>
                        <li>Tap the mic button to talk to the AI Supervisor</li>
                        <li>You can also type messages using the text input</li>
                    </ol>
                </div>

                {/* Actions */}
                <div className="mobile-access-actions">
                    {status?.active && onStopTunnel && (
                        <button className="danger" onClick={onStopTunnel}>
                            <StopCircle size={14} />
                            Stop Tunnel
                        </button>
                    )}
                    {!status?.active && !tunnelLoading && onStartTunnel && (
                        <button className="primary" onClick={onStartTunnel}>
                            <Play size={14} />
                            Start Tunnel
                        </button>
                    )}
                    <button onClick={onClose}>Close</button>
                </div>
            </div>
        </div>
    );
}
