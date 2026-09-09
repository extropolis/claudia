import { useState, useEffect, useCallback, useRef } from 'react';
import type { ClaudeUsageLimitsResult, UsageLimitBar } from '@claudia/shared';
import { getApiBaseUrl } from '../config/api-config';
import { useTaskStore } from '../stores/taskStore';
import './UsageLimitPill.css';

/** How often the header re-reads the limits. The server caches for ~60s. */
const POLL_INTERVAL_MS = 60_000;

interface UsageLimitPillProps {
    /** Opens the full dashboard, which renders the same data in detail. */
    onOpenDashboard?: () => void;
}

/** 'in 2h 36m' — the countdown shown next to the bar. */
export function formatCountdown(resetsAt: string | null, now = Date.now()): string {
    if (!resetsAt) return '';
    const at = new Date(resetsAt).getTime();
    if (Number.isNaN(at)) return '';
    const delta = at - now;
    if (delta <= 0) return 'resetting';
    const mins = Math.floor(delta / 60_000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ${mins % 60}m`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Absolute reset time for tooltips, e.g. 'Wed 8:00 AM'. */
export function formatResetClock(resetsAt: string | null): string {
    if (!resetsAt) return 'unknown';
    const at = new Date(resetsAt);
    if (Number.isNaN(at.getTime())) return 'unknown';
    return at.toLocaleString(undefined, {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
    });
}

/**
 * True only for a response that actually came from /api/usage/limits.
 * A dev proxy, an older server, or a test stub can answer this URL with
 * something else; those must not be rendered as a usage indicator.
 */
export function isLimitsPayload(value: unknown): value is ClaudeUsageLimitsResult {
    return typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean';
}

function barLine(bar: UsageLimitBar): string {
    return `${bar.label}: ${Math.round(bar.percent)}% used — resets ${formatResetClock(bar.resetsAt)}`;
}

/**
 * Always-visible plan-usage indicator for the app header.
 *
 * Shows the 5-hour session bar (the limit people actually hit mid-session),
 * colour-coded by severity, with the weekly numbers in the tooltip. Clicking
 * it opens the full dashboard. Any failure degrades to a muted dash rather
 * than removing the element, so the header layout never jumps.
 */
export function UsageLimitPill({ onOpenDashboard }: UsageLimitPillProps) {
    const isConnected = useTaskStore(s => s.isConnected);
    const [data, setData] = useState<ClaudeUsageLimitsResult | null>(null);
    // Ticks forward between polls so the countdown stays honest without
    // re-fetching; the value itself is what the countdown is measured against.
    const [nowMs, setNowMs] = useState(() => Date.now());
    const inFlight = useRef(false);

    const fetchLimits = useCallback(async (force = false) => {
        if (inFlight.current) return;
        inFlight.current = true;
        try {
            const url = `${getApiBaseUrl()}/api/usage/limits${force ? '?refresh=1' : ''}`;
            const response = await fetch(url);
            if (!response.ok) {
                console.warn('[UsageLimitPill] limits request failed', response.status);
                return;
            }
            const raw: unknown = await response.json();
            if (!isLimitsPayload(raw)) {
                // Not a limits payload (a proxy or a stub answered). Stay silent
                // rather than rendering a misleading "unavailable" indicator.
                console.warn('[UsageLimitPill] unrecognised limits payload, ignoring');
                return;
            }
            setData(raw);
            if (!raw.ok) {
                console.warn('[UsageLimitPill] limits unavailable:', raw.reason, raw.message);
            }
        } catch (error) {
            console.warn('[UsageLimitPill] limits request errored', error);
        } finally {
            inFlight.current = false;
        }
    }, []);

    // Poll while connected; refetch immediately when the tab regains focus so
    // a machine coming back from sleep doesn't show a stale percentage.
    useEffect(() => {
        if (!isConnected) return;
        fetchLimits();
        const interval = setInterval(() => fetchLimits(), POLL_INTERVAL_MS);
        const onFocus = () => fetchLimits();
        window.addEventListener('focus', onFocus);
        return () => {
            clearInterval(interval);
            window.removeEventListener('focus', onFocus);
        };
    }, [isConnected, fetchLimits]);

    // Re-render every 30s so the countdown stays honest between polls.
    useEffect(() => {
        const timer = setInterval(() => setNowMs(Date.now()), 30_000);
        return () => clearInterval(timer);
    }, []);

    if (!data) return null;

    if (!data.ok) {
        return (
            <div
                className="usage-pill usage-pill-unavailable"
                title={`Plan limits unavailable — ${data.message}`}
                onClick={onOpenDashboard}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') onOpenDashboard?.(); }}
            >
                <span className="usage-pill-label">LIMIT</span>
                <span className="usage-pill-value">—</span>
            </div>
        );
    }

    const session = data.session;
    if (!session) return null;

    const percent = Math.round(session.percent);
    const countdown = formatCountdown(session.resetsAt, nowMs);
    const tooltip = [
        data.planLabel ? `Plan usage limits — ${data.planLabel}` : 'Plan usage limits',
        '',
        barLine(session),
        ...data.weekly.map(barLine),
        '',
        'Click for the full usage dashboard',
    ].join('\n');

    return (
        <div
            className={`usage-pill usage-pill-${session.severity}`}
            title={tooltip}
            onClick={onOpenDashboard}
            role="button"
            tabIndex={0}
            aria-label={`Session usage ${percent} percent used`}
            onKeyDown={(e) => { if (e.key === 'Enter') onOpenDashboard?.(); }}
        >
            <div className="usage-pill-track" aria-hidden="true">
                <div className="usage-pill-fill" style={{ width: `${Math.max(percent, 2)}%` }} />
            </div>
            <span className="usage-pill-value">{percent}%</span>
            {countdown && <span className="usage-pill-reset">{countdown}</span>}
        </div>
    );
}
