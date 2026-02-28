import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Smartphone, Copy, Check } from 'lucide-react';
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
}

interface MobileAccessModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export function MobileAccessModal({ isOpen, onClose }: MobileAccessModalProps) {
    const [status, setStatus] = useState<TunnelStatus | null>(null);
    const [loading, setLoading] = useState(false);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const startedRef = useRef(false);

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

    // Start tunnel
    const startTunnel = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`${apiBase}/api/tunnel/start`, { method: 'POST' });
            const data = await res.json();
            if (data.error) {
                setError(data.error);
            } else {
                setStatus(data);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to start tunnel');
        } finally {
            setLoading(false);
        }
    }, [apiBase]);

    // Stop tunnel
    const stopTunnel = useCallback(async () => {
        try {
            await fetch(`${apiBase}/api/tunnel/stop`, { method: 'POST' });
            setStatus({ active: false, url: null, token: null, startedAt: null, error: null });
        } catch (err) {
            console.error('[MobileAccess] Failed to stop tunnel:', err);
        }
    }, [apiBase]);

    // Auto-start tunnel when modal opens
    useEffect(() => {
        if (!isOpen) {
            startedRef.current = false;
            return;
        }

        if (startedRef.current) return;
        startedRef.current = true;

        (async () => {
            const currentStatus = await fetchStatus();
            if (!currentStatus?.active) {
                await startTunnel();
            }
        })();
    }, [isOpen, fetchStatus, startTunnel]);

    // Generate QR code when URL changes
    useEffect(() => {
        if (!status?.active || !status.url || !status.token || !canvasRef.current) return;

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
    }, [status?.active, status?.url, status?.token]);

    // Copy URL to clipboard
    const copyUrl = () => {
        if (!status?.url || !status?.token) return;
        const mobileUrl = `${status.url}/?token=${status.token}`;
        navigator.clipboard.writeText(mobileUrl).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    // Handle close - stop tunnel
    const handleClose = async () => {
        if (status?.active) {
            await stopTunnel();
        }
        onClose();
    };

    if (!isOpen) return null;

    const mobileUrl = status?.active && status?.url && status?.token
        ? `${status.url}/?token=${status.token}`
        : '';

    return (
        <div className="mobile-access-overlay" onClick={handleClose}>
            <div className="mobile-access-modal" onClick={e => e.stopPropagation()} style={{ position: 'relative' }}>
                <button className="modal-close" onClick={handleClose}>
                    <X size={18} />
                </button>

                <h2>
                    <Smartphone size={20} />
                    Mobile Voice Access
                </h2>

                {/* Status */}
                <div className="tunnel-status">
                    <span className={`status-dot ${loading ? 'starting' : status?.active ? 'active' : error ? 'error' : 'inactive'}`} />
                    <span>
                        {loading
                            ? 'Starting tunnel...'
                            : status?.active
                                ? 'Tunnel active'
                                : error
                                    ? `Error: ${error}`
                                    : 'Tunnel inactive'}
                    </span>
                    {loading && <span className="loading-spinner" />}
                </div>

                {/* QR Code */}
                <div className="qr-code-area">
                    {status?.active ? (
                        <canvas ref={canvasRef} />
                    ) : (
                        <div className="qr-placeholder">
                            {loading ? 'Starting...' : 'No tunnel active'}
                        </div>
                    )}
                </div>

                {/* URL */}
                {status?.active && mobileUrl && (
                    <div className="tunnel-url-area">
                        <label>Mobile URL</label>
                        <div className="tunnel-url-row">
                            <input type="text" readOnly value={mobileUrl} />
                            <button onClick={copyUrl} title="Copy URL">
                                {copied ? <Check size={14} /> : <Copy size={14} />}
                                {copied ? 'Copied!' : 'Copy'}
                            </button>
                        </div>
                    </div>
                )}

                {/* Tunnel password hint */}
                {status?.active && status?.publicIp && (
                    <div className="tunnel-password-hint">
                        <label>Tunnel Password</label>
                        <div className="tunnel-password-value">{status.publicIp}</div>
                        <span className="tunnel-password-note">
                            Enter this when the tunnel page asks for a password
                        </span>
                    </div>
                )}

                {/* Instructions */}
                <div className="mobile-instructions">
                    <ol>
                        <li>Scan the QR code with your phone's camera</li>
                        <li>Enter the tunnel password shown above when prompted</li>
                        <li>Tap the mic button to talk to the AI Supervisor</li>
                        <li>You can also type messages using the text input</li>
                    </ol>
                </div>

                {/* Actions */}
                <div className="mobile-access-actions">
                    {status?.active ? (
                        <button className="danger" onClick={stopTunnel}>
                            Stop Tunnel
                        </button>
                    ) : !loading ? (
                        <button className="primary" onClick={startTunnel}>
                            Start Tunnel
                        </button>
                    ) : null}
                    <button onClick={handleClose}>Close</button>
                </div>
            </div>
        </div>
    );
}
