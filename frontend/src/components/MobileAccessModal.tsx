import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Smartphone, Copy, Check, StopCircle, Play } from 'lucide-react';
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
    tunnelActive?: boolean;
    tunnelLoading?: boolean;
    onStopTunnel?: () => void;
    onStartTunnel?: () => void;
}

export function MobileAccessModal({ isOpen, onClose, error, tunnelLoading, onStopTunnel, onStartTunnel }: MobileAccessModalProps) {
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
                        <input type="text" readOnly value={mobileUrl || ''} placeholder="Not connected" />
                        <button onClick={copyUrl} title="Copy URL" disabled={!mobileUrl}>
                            {copied ? <Check size={14} /> : <Copy size={14} />}
                            {copied ? 'Copied!' : 'Copy'}
                        </button>
                    </div>
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
