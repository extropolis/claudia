import { useEffect, useCallback } from 'react';
import { X, Gauge } from 'lucide-react';
import { useTaskStore } from '../stores/taskStore';
import {
    clampPct,
    usageColorVar,
    formatCountdown,
    formatResetLocal,
    capitalizeModel,
    formatCredits,
} from '../utils/usageFormat';
import type { UsageWindow } from '@claudia/shared';
import './PlanUsageDashboard.css';

interface PlanUsageDashboardProps {
    onClose: () => void;
}

/** One labeled utilization bar. Shares the meter's utilization→color helper. */
function UsageBar({
    label,
    reset,
    window: win,
}: {
    label: string;
    reset: string;
    window: UsageWindow;
}) {
    const pct = clampPct(win.utilization);
    return (
        <div className="plan-usage-bar">
            <div className="plan-usage-bar__head">
                <span className="plan-usage-bar__label">{label}</span>
                <span className="plan-usage-bar__pct">{pct}%</span>
            </div>
            <div
                className="plan-usage-bar__track"
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${label}: ${pct}%`}
            >
                <div
                    className="plan-usage-bar__fill"
                    style={{ width: `${pct}%`, backgroundColor: usageColorVar(pct) }}
                />
            </div>
            <span className="plan-usage-bar__reset">{reset}</span>
        </div>
    );
}

/**
 * Full plan-usage dashboard modal. Mirrors claude.ai/settings/usage: a current
 * session section, weekly all-models + per-model limits, and (when enabled) an
 * extra-usage section. Closes on backdrop click or Esc.
 *
 * Distinct from the token-cost `UsageDashboard.tsx` (which reports $ spend); this
 * one surfaces the Anthropic plan rate-limit windows.
 */
export function PlanUsageDashboard({ onClose }: PlanUsageDashboardProps) {
    const planUsage = useTaskStore((s) => s.planUsage);

    const handleKeyDown = useCallback(
        (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        },
        [onClose]
    );

    useEffect(() => {
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [handleKeyDown]);

    const title = planUsage && !planUsage.unavailable ? planUsage.planLabel : 'Plan Usage';

    const renderBody = () => {
        if (!planUsage || planUsage.unavailable) {
            const reason = planUsage?.reason;
            return (
                <div className="plan-usage-empty">
                    <p>Plan usage is currently unavailable{reason ? ` (${reason})` : ''}.</p>
                    <p className="plan-usage-empty__hint">
                        Run <code>claude</code> once in a terminal to refresh authentication, then
                        reconnect.
                    </p>
                </div>
            );
        }

        const sessionCountdown = formatCountdown(planUsage.fiveHour.resetsAt);
        return (
            <>
                {planUsage.stale && (
                    <div className="plan-usage-stale-banner">
                        Showing cached data — a fresh refresh has not yet succeeded.
                    </div>
                )}

                <section className="plan-usage-section">
                    <h3>Current session</h3>
                    <UsageBar
                        label="5-hour window"
                        reset={sessionCountdown ? `Resets in ${sessionCountdown}` : 'Reset time unknown'}
                        window={planUsage.fiveHour}
                    />
                </section>

                <section className="plan-usage-section">
                    <h3>Weekly limits</h3>
                    <UsageBar
                        label="All models"
                        reset={`Resets ${formatResetLocal(planUsage.sevenDay.resetsAt)}`}
                        window={planUsage.sevenDay}
                    />
                    {planUsage.sevenDayByModel.map((m) => (
                        <UsageBar
                            key={m.model}
                            label={capitalizeModel(m.model)}
                            reset={`Resets ${formatResetLocal(m.resetsAt)}`}
                            window={m}
                        />
                    ))}
                    {planUsage.sevenDayByModel.length === 0 && (
                        <p className="plan-usage-note">No per-model limits reported.</p>
                    )}
                </section>

                {planUsage.extraUsage?.isEnabled && (
                    <section className="plan-usage-section">
                        <h3>Extra usage</h3>
                        <div className="plan-usage-extra">
                            <span>
                                {formatCredits(planUsage.extraUsage.usedCredits ?? 0)} /{' '}
                                {formatCredits(planUsage.extraUsage.monthlyLimit)} credits
                            </span>
                            {planUsage.extraUsage.utilization != null && (
                                <span className="plan-usage-extra__pct">
                                    {clampPct(planUsage.extraUsage.utilization)}%
                                </span>
                            )}
                        </div>
                    </section>
                )}
            </>
        );
    };

    return (
        <div className="modal-overlay plan-usage-overlay" onClick={onClose}>
            <div
                className="modal-content plan-usage-dashboard"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label={`${title} usage`}
            >
                <div className="plan-usage-header">
                    <div className="plan-usage-header__title">
                        <Gauge size={18} />
                        <h2>{title}</h2>
                    </div>
                    <button className="plan-usage-close" onClick={onClose} title="Close">
                        <X size={18} />
                    </button>
                </div>
                <div className="plan-usage-body">{renderBody()}</div>
            </div>
        </div>
    );
}
