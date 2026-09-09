import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, AlertCircle } from 'lucide-react';
import type { ClaudeUsageLimitsResult, UsageLimitBar } from '@claudia/shared';
import { getApiBaseUrl } from '../config/api-config';
import { formatCountdown, isLimitsPayload } from './UsageLimitPill';
import './PlanLimitsPanel.css';

/** 'Resets Wed 8:00 AM' — the absolute label claude.ai shows under each bar. */
export function formatResetLabel(resetsAt: string | null): string {
    if (!resetsAt) return '';
    const at = new Date(resetsAt);
    if (Number.isNaN(at.getTime())) return '';
    const countdown = formatCountdown(resetsAt);
    const clock = at.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    return countdown ? `Resets in ${countdown} · ${clock}` : `Resets ${clock}`;
}

/** '$12.34' from minor units. */
export function formatMinor(minor: number | null, currency = 'USD'): string {
    if (minor === null) return '—';
    const symbol = currency === 'USD' ? '$' : '';
    return `${symbol}${(minor / 100).toFixed(2)}`;
}

function LimitRow({ bar }: { bar: UsageLimitBar }) {
    const percent = Math.round(bar.percent);
    return (
        <div className="plan-limit-row">
            <div className="plan-limit-meta">
                <span className="plan-limit-name">{bar.label}</span>
                <span className="plan-limit-reset">{formatResetLabel(bar.resetsAt)}</span>
            </div>
            <div className={`plan-limit-track plan-limit-${bar.severity}`}>
                <div className="plan-limit-fill" style={{ width: `${Math.max(percent, 1)}%` }} />
            </div>
            <span className="plan-limit-percent">{percent}% used</span>
        </div>
    );
}

/**
 * Replica of claude.ai → Settings → Usage: the 5-hour session bar, the weekly
 * bars (all models plus any per-model scoped bar), and the usage-credits card.
 *
 * Rendered at the top of the token usage dashboard so one button reaches both
 * the plan limits and the local cost breakdown.
 */
export function PlanLimitsPanel({ isOpen }: { isOpen: boolean }) {
    const [data, setData] = useState<ClaudeUsageLimitsResult | null>(null);
    const [loading, setLoading] = useState(false);

    const fetchLimits = useCallback(async (force: boolean) => {
        setLoading(true);
        try {
            const url = `${getApiBaseUrl()}/api/usage/limits${force ? '?refresh=1' : ''}`;
            const response = await fetch(url);
            if (!response.ok) {
                console.warn('[PlanLimitsPanel] request failed', response.status);
                setData({
                    ok: false,
                    reason: 'api-error',
                    message: `Server returned ${response.status}.`,
                    fetchedAt: new Date().toISOString(),
                });
                return;
            }
            const raw: unknown = await response.json();
            if (!isLimitsPayload(raw)) {
                console.warn('[PlanLimitsPanel] unrecognised limits payload');
                setData({
                    ok: false,
                    reason: 'api-error',
                    message: 'The server returned an unexpected response.',
                    fetchedAt: new Date().toISOString(),
                });
                return;
            }
            setData(raw);
        } catch (error) {
            console.warn('[PlanLimitsPanel] request errored', error);
            setData({
                ok: false,
                reason: 'network',
                message: 'Could not reach the Claudia server.',
                fetchedAt: new Date().toISOString(),
            });
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isOpen) fetchLimits(false);
    }, [isOpen, fetchLimits]);

    if (!data && !loading) return null;

    return (
        <section className="plan-limits-panel">
            <div className="plan-limits-header">
                <h3>
                    Plan usage limits
                    {data?.ok && data.planLabel && <span className="plan-limits-plan">{data.planLabel}</span>}
                </h3>
                <button
                    className="plan-limits-refresh"
                    onClick={() => fetchLimits(true)}
                    disabled={loading}
                    title="Refresh plan limits"
                >
                    <RefreshCw size={14} className={loading ? 'spinning' : ''} />
                </button>
            </div>

            {data && !data.ok && (
                <div className="plan-limits-unavailable">
                    <AlertCircle size={16} />
                    <span>{data.message}</span>
                </div>
            )}

            {data?.ok && (
                <>
                    {data.session && <LimitRow bar={data.session} />}

                    {data.weekly.length > 0 && (
                        <>
                            <h4 className="plan-limits-subhead">Weekly limits</h4>
                            {data.weekly.map(bar => (
                                <LimitRow key={`${bar.kind}-${bar.scopeLabel ?? 'all'}`} bar={bar} />
                            ))}
                        </>
                    )}

                    {data.credits && (
                        <>
                            <h4 className="plan-limits-subhead">Usage credits</h4>
                            <div className="plan-limits-credits">
                                {data.credits.enabled ? (
                                    <>
                                        <div className="plan-limit-row">
                                            <div className="plan-limit-meta">
                                                <span className="plan-limit-name">
                                                    {formatMinor(data.credits.usedMinor, data.credits.currency)} spent
                                                </span>
                                                {data.credits.limitMinor !== null && (
                                                    <span className="plan-limit-reset">
                                                        of {formatMinor(data.credits.limitMinor, data.credits.currency)} monthly limit
                                                    </span>
                                                )}
                                            </div>
                                            <div className="plan-limit-track plan-limit-normal">
                                                <div
                                                    className="plan-limit-fill"
                                                    style={{ width: `${Math.max(Math.round(data.credits.percent), 1)}%` }}
                                                />
                                            </div>
                                            <span className="plan-limit-percent">{Math.round(data.credits.percent)}% used</span>
                                        </div>
                                        {data.credits.balanceMinor !== null && (
                                            <p className="plan-limits-note">
                                                Balance {formatMinor(data.credits.balanceMinor, data.credits.currency)}
                                                {data.credits.autoReload !== null && ` · auto-reload ${data.credits.autoReload ? 'on' : 'off'}`}
                                            </p>
                                        )}
                                    </>
                                ) : (
                                    <p className="plan-limits-note">
                                        Usage credits are off — Claude stops at the plan limit instead of billing extra.
                                    </p>
                                )}
                            </div>
                        </>
                    )}

                    <p className="plan-limits-updated">
                        Last updated {new Date(data.fetchedAt).toLocaleTimeString()}
                        {data.cached && ' (cached)'}
                    </p>
                </>
            )}
        </section>
    );
}
