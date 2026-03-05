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
    error?: string | null;
}

export function MobileAccessModal({ isOpen, onClose, error }: MobileAccessModalProps) {
    const [status, setStatus] = useState<TunnelStatus | null>(null);
    const [copied, setCopied] = useState(false);
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
                    <span className={`status-dot ${status?.active ? 'active' : error ? 'error' : 'starting'}`} />
                    <span>
                        {status?.active
                            ? 'Tunnel active'
                            : error
                                ? 'Connection failed'
                                : 'Starting tunnel...'}
                    </span>
                    {!status?.active && !error && <span className="loading-spinner" />}
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
                    ) : (
                        <div className="qr-placeholder">
                            Starting...
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

                {/* Tunnel password hint - only shown for random ngrok URLs that have an interstitial */}
                {status?.active && status?.publicIp && status?.url && !status.url.includes('ngrok-free.app') && (
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
                        {status?.url && !status.url.includes('ngrok-free.app') && (
                            <li>Enter the tunnel password shown above when prompted</li>
                        )}
                        <li>Tap the mic button to talk to the AI Supervisor</li>
                        <li>You can also type messages using the text input</li>
                    </ol>
                </div>

                {/* Actions */}
                <div className="mobile-access-actions">
                    <button onClick={onClose}>Close</button>
                </div>
            </div>
        </div>
    );
}
