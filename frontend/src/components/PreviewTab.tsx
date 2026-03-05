import { useState, useRef, useCallback, useEffect } from 'react';
import { Globe, RefreshCw, ArrowRight, Loader2 } from 'lucide-react';
import { isTunnelAccess, getApiBaseUrl } from '../config/api-config';
import './PreviewTab.css';

interface PreviewTabProps {
  url: string;
  onUrlChange: (url: string) => void;
}

function normalizeUrl(input: string): string {
  let trimmed = input.trim();
  if (!trimmed) return '';
  // If it looks like a bare hostname:port or localhost, prepend http://
  if (/^localhost(:\d+)?/.test(trimmed) || /^[\w.-]+:\d+/.test(trimmed)) {
    trimmed = `http://${trimmed}`;
  }
  // If no protocol at all, prepend https://
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }
  return trimmed;
}

/**
 * Extract the port from a localhost URL, or null if not localhost.
 */
function getLocalhostPort(rawUrl: string): number | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      return parseInt(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'), 10);
    }
  } catch { /* not a valid URL */ }
  return null;
}

/**
 * Request an ngrok tunnel for a given port via the backend API.
 * Returns the tunnel URL (e.g. https://abc1-1-2-3-4.ngrok-free.app).
 */
async function requestPreviewTunnel(port: number): Promise<string> {
  const resp = await fetch(`${getApiBaseUrl()}/api/preview-tunnel/${port}`, { method: 'POST' });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  const data = await resp.json();
  return data.url;
}

export function PreviewTab({ url, onUrlChange }: PreviewTabProps) {
  const [inputValue, setInputValue] = useState(url || '');
  const [iframeKey, setIframeKey] = useState(0);
  const [iframeSrc, setIframeSrc] = useState('');
  const [tunnelLoading, setTunnelLoading] = useState(false);
  const [tunnelError, setTunnelError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // Cache tunnel URLs per port so we don't re-request on refresh
  const tunnelCache = useRef<Map<number, string>>(new Map());

  // Sync input when url prop changes externally
  useEffect(() => {
    setInputValue(url || '');
  }, [url]);

  // Resolve the iframe src whenever the url changes
  useEffect(() => {
    if (!url) {
      setIframeSrc('');
      return;
    }

    const port = getLocalhostPort(url);

    // Not on tunnel, or not a localhost URL → use proxy for localhost or direct URL
    if (!isTunnelAccess()) {
      if (port !== null) {
        // Local access to localhost port → use proxy
        const parsed = new URL(url);
        const path = parsed.pathname + parsed.search;
        setIframeSrc(`${getApiBaseUrl()}/api/preview-proxy/${port}${path}`);
        setTunnelError('');
      } else {
        // External URL → use directly
        setIframeSrc(url);
        setTunnelError('');
      }
      return;
    }

    // On tunnel access - need a tunnel for localhost URLs
    if (port === null) {
      // External URL on tunnel access → use directly
      setIframeSrc(url);
      setTunnelError('');
      return;
    }

    // Check cache first, but verify it's still valid
    const cached = tunnelCache.current.get(port);
    if (cached) {
      const parsed = new URL(url);
      setIframeSrc(cached + parsed.pathname + parsed.search);
      setTunnelError('');
      return;
    }

    // Request a tunnel from the backend
    setTunnelLoading(true);
    setTunnelError('');
    requestPreviewTunnel(port)
      .then(tunnelUrl => {
        console.log('[PreviewTab] Got tunnel URL for port', port, tunnelUrl);
        tunnelCache.current.set(port, tunnelUrl);
        const parsed = new URL(url);
        setIframeSrc(tunnelUrl + parsed.pathname + parsed.search);
      })
      .catch(err => {
        console.error('[PreviewTab] Tunnel failed, falling back to proxy', err);
        setTunnelError(err.message);
        // Fallback: use the rewriting proxy
        const parsed = new URL(url);
        const path = parsed.pathname + parsed.search;
        setIframeSrc(`${getApiBaseUrl()}/api/preview-proxy/${port}${path}`);
      })
      .finally(() => setTunnelLoading(false));
  }, [url]);

  const handleNavigate = useCallback(() => {
    const normalized = normalizeUrl(inputValue);
    if (normalized) {
      console.log('[PreviewTab] Navigating to:', normalized);
      onUrlChange(normalized);
      setIframeKey(k => k + 1);
    }
  }, [inputValue, onUrlChange]);

  const handleRefresh = useCallback(() => {
    console.log('[PreviewTab] Refreshing iframe');
    setIframeKey(k => k + 1);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleNavigate();
    }
  }, [handleNavigate]);

  return (
    <div className="preview-tab">
      <div className="preview-address-bar">
        <input
          ref={inputRef}
          className="preview-url-input"
          type="text"
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter URL (e.g. localhost:3000)"
          spellCheck={false}
          autoComplete="off"
        />
        <button
          className="preview-address-bar-btn"
          onClick={handleNavigate}
          title="Go"
        >
          <ArrowRight size={16} />
        </button>
        <button
          className="preview-address-bar-btn"
          onClick={handleRefresh}
          title="Refresh"
          disabled={!url}
        >
          <RefreshCw size={16} />
        </button>
      </div>

      {tunnelLoading ? (
        <div className="preview-empty-state">
          <Loader2 size={48} strokeWidth={1} className="preview-spinner" />
          <p>Starting tunnel to localhost...</p>
        </div>
      ) : iframeSrc ? (
        <div className="preview-iframe-container">
          <iframe
            key={iframeKey}
            className="preview-iframe"
            src={iframeSrc}
            title="Browser Preview"
            sandbox="allow-same-origin allow-scripts allow-popups allow-forms allow-modals"
          />
          {tunnelError && (
            <div className="preview-tunnel-fallback">
              Using proxy fallback (tunnel failed: {tunnelError})
            </div>
          )}
        </div>
      ) : (
        <div className="preview-empty-state">
          <Globe size={48} strokeWidth={1} />
          <p>Enter a URL above to preview your web app</p>
        </div>
      )}
    </div>
  );
}
