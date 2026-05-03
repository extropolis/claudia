import { useState, useEffect, useCallback } from 'react';
import { DollarSign, Zap, Clock, Database, Trash2, RefreshCw } from 'lucide-react';
import { UsageSummary } from '@claudia/shared';
import './UsageDashboard.css';

interface UsageDashboardProps {
    wsRef: React.RefObject<WebSocket | null>;
}

type Period = 'today' | '7d' | '30d' | 'all';

export function UsageDashboard({ wsRef }: UsageDashboardProps) {
    const [summary, setSummary] = useState<UsageSummary | null>(null);
    const [period, setPeriod] = useState<Period>('all');
    const [loading, setLoading] = useState(false);

    const fetchUsage = useCallback((p: Period) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
        setLoading(true);
        wsRef.current.send(JSON.stringify({ type: 'usage:get', payload: { period: p } }));
    }, [wsRef]);

    useEffect(() => {
        fetchUsage(period);
    }, [period, fetchUsage]);

    useEffect(() => {
        const ws = wsRef.current;
        if (!ws) return;

        const handler = (event: MessageEvent) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'usage:summary') {
                    setSummary(msg.payload as UsageSummary);
                    setLoading(false);
                }
            } catch { /* ignore */ }
        };

        ws.addEventListener('message', handler);
        return () => ws.removeEventListener('message', handler);
    }, [wsRef]);

    const handleClear = useCallback(() => {
        if (!confirm('Clear all usage data? This cannot be undone.')) return;
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
        wsRef.current.send(JSON.stringify({ type: 'usage:clear', payload: {} }));
    }, [wsRef]);

    const formatCost = (cost: number) => {
        if (cost < 0.01) return `$${cost.toFixed(4)}`;
        if (cost < 1) return `$${cost.toFixed(3)}`;
        return `$${cost.toFixed(2)}`;
    };

    const formatTokens = (tokens: number) => {
        if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
        if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
        return tokens.toString();
    };

    return (
        <div className="usage-dashboard">
            <div className="usage-header">
                <h3><DollarSign size={16} /> Usage & Cost</h3>
                <div className="usage-actions">
                    <button className="usage-refresh-btn" onClick={() => fetchUsage(period)} title="Refresh">
                        <RefreshCw size={14} className={loading ? 'spinning' : ''} />
                    </button>
                    <button className="usage-clear-btn" onClick={handleClear} title="Clear all data">
                        <Trash2 size={14} />
                    </button>
                </div>
            </div>

            <div className="usage-period-selector">
                {(['today', '7d', '30d', 'all'] as Period[]).map(p => (
                    <button
                        key={p}
                        className={`usage-period-btn ${period === p ? 'active' : ''}`}
                        onClick={() => setPeriod(p)}
                    >
                        {p === 'today' ? 'Today' : p === '7d' ? '7 Days' : p === '30d' ? '30 Days' : 'All Time'}
                    </button>
                ))}
            </div>

            {summary && period !== 'all' && summary.entryCount === summary.totalEntryCount && (
                <div className="usage-period-note">All usage data is within this time period</div>
            )}

            {!summary ? (
                <div className="usage-empty">No usage data yet</div>
            ) : (
                <>
                    <div className="usage-stats-grid">
                        <div className="usage-stat-card usage-stat-cost">
                            <DollarSign size={18} />
                            <div className="usage-stat-value">{formatCost(summary.totalCost)}</div>
                            <div className="usage-stat-label">Total Cost</div>
                        </div>
                        <div className="usage-stat-card">
                            <Zap size={18} />
                            <div className="usage-stat-value">{formatTokens(summary.totalInputTokens + summary.totalOutputTokens)}</div>
                            <div className="usage-stat-label">Total Tokens</div>
                        </div>
                        <div className="usage-stat-card">
                            <Clock size={18} />
                            <div className="usage-stat-value">{summary.entryCount}</div>
                            <div className="usage-stat-label">API Calls</div>
                        </div>
                        <div className="usage-stat-card">
                            <Database size={18} />
                            <div className="usage-stat-value">{formatTokens(summary.totalCacheReadTokens)}</div>
                            <div className="usage-stat-label">Cache Hits</div>
                        </div>
                    </div>

                    <div className="usage-breakdown">
                        <h4>Token Breakdown</h4>
                        <div className="usage-token-bars">
                            <TokenBar label="Input" tokens={summary.totalInputTokens} total={summary.totalInputTokens + summary.totalOutputTokens + summary.totalCacheCreationTokens + summary.totalCacheReadTokens} color="var(--usage-input)" />
                            <TokenBar label="Output" tokens={summary.totalOutputTokens} total={summary.totalInputTokens + summary.totalOutputTokens + summary.totalCacheCreationTokens + summary.totalCacheReadTokens} color="var(--usage-output)" />
                            <TokenBar label="Cache Write" tokens={summary.totalCacheCreationTokens} total={summary.totalInputTokens + summary.totalOutputTokens + summary.totalCacheCreationTokens + summary.totalCacheReadTokens} color="var(--usage-cache-write)" />
                            <TokenBar label="Cache Read" tokens={summary.totalCacheReadTokens} total={summary.totalInputTokens + summary.totalOutputTokens + summary.totalCacheCreationTokens + summary.totalCacheReadTokens} color="var(--usage-cache-read)" />
                        </div>
                    </div>

                    {Object.keys(summary.byModel).length > 0 && (
                        <div className="usage-breakdown">
                            <h4>By Model</h4>
                            <div className="usage-model-list">
                                {Object.entries(summary.byModel)
                                    .sort(([, a], [, b]) => b.cost - a.cost)
                                    .map(([model, data]) => (
                                        <div key={model} className="usage-model-row">
                                            <span className="usage-model-name">{model}</span>
                                            <span className="usage-model-tokens">{formatTokens(data.inputTokens + data.outputTokens)} tokens</span>
                                            <span className="usage-model-cost">{formatCost(data.cost)}</span>
                                        </div>
                                    ))}
                            </div>
                        </div>
                    )}

                    {Object.keys(summary.byTask).length > 0 && (
                        <div className="usage-breakdown">
                            <h4>By Task (Top 10)</h4>
                            <div className="usage-task-list">
                                {Object.entries(summary.byTask)
                                    .sort(([, a], [, b]) => b.cost - a.cost)
                                    .slice(0, 10)
                                    .map(([taskId, data]) => (
                                        <div key={taskId} className="usage-task-row">
                                            <span className="usage-task-id" title={taskId}>{taskId.slice(0, 12)}...</span>
                                            <span className="usage-task-tokens">{formatTokens(data.totalTokens)}</span>
                                            <span className="usage-task-cost">{formatCost(data.cost)}</span>
                                        </div>
                                    ))}
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

function TokenBar({ label, tokens, total, color }: { label: string; tokens: number; total: number; color: string }) {
    const pct = total > 0 ? (tokens / total) * 100 : 0;
    const formatTokens = (t: number) => {
        if (t >= 1_000_000) return `${(t / 1_000_000).toFixed(1)}M`;
        if (t >= 1_000) return `${(t / 1_000).toFixed(1)}k`;
        return t.toString();
    };

    return (
        <div className="usage-token-bar-row">
            <span className="usage-token-bar-label">{label}</span>
            <div className="usage-token-bar-track">
                <div className="usage-token-bar-fill" style={{ width: `${Math.max(pct, 1)}%`, backgroundColor: color }} />
            </div>
            <span className="usage-token-bar-value">{formatTokens(tokens)}</span>
        </div>
    );
}
