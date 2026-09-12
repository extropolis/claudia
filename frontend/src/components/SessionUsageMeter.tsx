import { useEffect, useState } from 'react';
import { useTaskStore } from '../stores/taskStore';
import { clampPct, usageColorVar, usageSeverity, formatCountdown, usageTooltip } from '../utils/usageFormat';
import { PlanUsageDashboard } from './PlanUsageDashboard';
import './SessionUsageMeter.css';

/**
 * Always-visible, compact 5-hour session usage meter. A slim horizontal bar
 * colored by utilization severity, with a "31% · resets in 2h 17m" label whose
 * countdown ticks each minute. Clicking opens the full usage dashboard.
 */
export function SessionUsageMeter() {
    const planUsage = useTaskStore((s) => s.planUsage);
    const [dashboardOpen, setDashboardOpen] = useState(false);
    // A minute ticker so the countdown stays fresh without re-fetching.
    const [nowMs, setNowMs] = useState(() => Date.now());

    useEffect(() => {
        const id = setInterval(() => setNowMs(Date.now()), 60_000);
        return () => clearInterval(id);
    }, []);

    // Nothing known yet: render nothing to avoid a flash of empty chrome.
    if (!planUsage) return null;

    if (planUsage.unavailable) {
        const reason = planUsage.reason ?? 'unknown';
        return (
            // The dashboard is a SIBLING of the trigger, never a child of it.
            // Nested, every click inside the modal — the close button, the
            // backdrop — bubbled back into the trigger's onClick and reopened
            // it, so the modal could not be dismissed.
            <div className="session-usage-meter-wrap">
                <button
                    type="button"
                    className="session-usage-meter session-usage-meter--unavailable"
                    title={`Plan usage unavailable (${reason}). Run \`claude\` once to refresh authentication.`}
                    onClick={() => setDashboardOpen(true)}
                >
                    <span className="session-usage-meter__label session-usage-meter__label--muted">
                        usage unavailable
                    </span>
                </button>
                {dashboardOpen && <PlanUsageDashboard onClose={() => setDashboardOpen(false)} />}
            </div>
        );
    }

    const pct = clampPct(planUsage.fiveHour.utilization);
    const severity = usageSeverity(pct);
    const countdown = formatCountdown(planUsage.fiveHour.resetsAt, nowMs);
    const label = countdown ? `${pct}% · resets in ${countdown}` : `${pct}%`;

    return (
        <div className="session-usage-meter-wrap">
            <button
                type="button"
                className={`session-usage-meter session-usage-meter--${severity}`}
                onClick={() => setDashboardOpen(true)}
                title={usageTooltip(planUsage)}
            >
                <div
                    className="session-usage-meter__track"
                    role="progressbar"
                    aria-valuenow={pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`Session usage: ${label}`}
                >
                    <div
                        className="session-usage-meter__fill"
                        style={{ width: `${pct}%`, backgroundColor: usageColorVar(pct) }}
                    />
                </div>
                <span className="session-usage-meter__label">
                    {label}
                    {planUsage.stale && (
                        <span className="session-usage-meter__stale-dot" title="Showing cached data" />
                    )}
                </span>
            </button>
            {dashboardOpen && <PlanUsageDashboard onClose={() => setDashboardOpen(false)} />}
        </div>
    );
}
