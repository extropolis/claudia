/**
 * Behaviour tests for the plan-usage indicator (header pill) and the
 * "Plan usage limits" dashboard panel.
 *
 * Conventions match the rest of the suite: fetch is stubbed, timers are fake
 * wherever polling is involved, and queries go through role/text rather than
 * CSS classes — except for the two colour-band assertions, where the class IS
 * the observable behaviour being tested.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import type { ClaudeUsageLimitsResult } from '@claudia/shared';

import { UsageLimitPill, formatCountdown, formatResetClock } from '../UsageLimitPill';
import { PlanLimitsPanel, formatMinor, formatResetLabel } from '../PlanLimitsPanel';
import { useTaskStore } from '../../stores/taskStore';

/** A fixed "now" so countdown assertions are deterministic. */
const NOW = new Date('2026-09-02T17:44:00.000Z').getTime();
const IN_2H36M = new Date(NOW + (2 * 60 + 36) * 60_000).toISOString();
const IN_7_DAYS = new Date(NOW + 7 * 24 * 60 * 60_000).toISOString();

const OK_PAYLOAD: ClaudeUsageLimitsResult = {
    ok: true,
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
    planLabel: 'Max (20x)',
    session: {
        kind: 'session', group: 'session', label: 'Current session',
        percent: 11, severity: 'normal', resetsAt: IN_2H36M, scopeLabel: null,
    },
    weekly: [
        { kind: 'weekly_all', group: 'weekly', label: 'All models', percent: 3, severity: 'normal', resetsAt: IN_7_DAYS, scopeLabel: null },
        { kind: 'weekly_scoped', group: 'weekly', label: 'Fable', percent: 2, severity: 'normal', resetsAt: IN_7_DAYS, scopeLabel: 'Fable' },
    ],
    credits: {
        enabled: false, usedMinor: 0, limitMinor: null, balanceMinor: 2000,
        currency: 'USD', percent: 0, resetsAt: null, autoReload: false,
    },
    fetchedAt: new Date(NOW).toISOString(),
    cached: false,
};

function stubFetch(payload: unknown, ok = true) {
    const fn = vi.fn(async (..._args: unknown[]) => ({
        ok,
        status: ok ? 200 : 500,
        json: async () => payload,
    } as Response));
    global.fetch = fn as unknown as typeof fetch;
    return fn;
}

beforeEach(() => {
    // One fake-timer install per test: the components poll on intervals, and
    // a fixed clock keeps the countdown assertions deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    useTaskStore.setState({ isConnected: true });
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Pure formatters
// ---------------------------------------------------------------------------
describe('formatCountdown', () => {
    it('renders minutes under an hour', () => {
        expect(formatCountdown(new Date(NOW + 42 * 60_000).toISOString(), NOW)).toBe('42m');
    });

    it('renders hours and minutes under a day', () => {
        expect(formatCountdown(IN_2H36M, NOW)).toBe('2h 36m');
    });

    it('renders days and hours beyond a day', () => {
        expect(formatCountdown(new Date(NOW + 50 * 60 * 60_000).toISOString(), NOW)).toBe('2d 2h');
    });

    it('says "resetting" once the window has elapsed', () => {
        expect(formatCountdown(new Date(NOW - 1000).toISOString(), NOW)).toBe('resetting');
    });

    it('returns an empty string for a missing or unparseable timestamp', () => {
        expect(formatCountdown(null, NOW)).toBe('');
        expect(formatCountdown('not-a-date', NOW)).toBe('');
    });
});

describe('formatResetClock', () => {
    it('degrades to "unknown" rather than throwing', () => {
        expect(formatResetClock(null)).toBe('unknown');
        expect(formatResetClock('garbage')).toBe('unknown');
    });

    it('renders a weekday and clock time', () => {
        expect(formatResetClock(IN_2H36M)).toMatch(/\d/);
    });
});

describe('formatMinor', () => {
    it('renders minor units as dollars', () => {
        expect(formatMinor(1234)).toBe('$12.34');
        expect(formatMinor(0)).toBe('$0.00');
    });

    it('renders an em dash when there is no value', () => {
        expect(formatMinor(null)).toBe('—');
    });
});

describe('formatResetLabel', () => {
    it('includes both the countdown and the absolute time', () => {
        expect(formatResetLabel(IN_2H36M)).toContain('Resets in 2h 36m');
    });

    it('is empty when there is no reset time', () => {
        expect(formatResetLabel(null)).toBe('');
    });
});

// ---------------------------------------------------------------------------
// UsageLimitPill
// ---------------------------------------------------------------------------
describe('UsageLimitPill', () => {
    it('renders nothing while the socket is disconnected', () => {
        const fetchSpy = stubFetch(OK_PAYLOAD);
        useTaskStore.setState({ isConnected: false });
        const { container } = render(<UsageLimitPill />);
        expect(container).toBeEmptyDOMElement();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('renders the session percentage and countdown once connected', async () => {
        stubFetch(OK_PAYLOAD);
        render(<UsageLimitPill />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });

        expect(screen.getByText('11%')).toBeInTheDocument();
        expect(screen.getByText('2h 36m')).toBeInTheDocument();
    });

    it('puts the weekly bars in the tooltip so the header stays compact', async () => {
        stubFetch(OK_PAYLOAD);
        render(<UsageLimitPill />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });

        const tooltip = screen.getByRole('button').getAttribute('title') ?? '';
        expect(tooltip).toContain('Max (20x)');
        expect(tooltip).toContain('All models: 3% used');
        expect(tooltip).toContain('Fable: 2% used');
    });

    it('colours the pill by severity', async () => {
        const critical = {
            ...OK_PAYLOAD,
            session: { ...OK_PAYLOAD.session!, percent: 92, severity: 'critical' as const },
        };
        stubFetch(critical);
        render(<UsageLimitPill />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });

        // The class is the behaviour here: it drives the red + pulse styling.
        expect(screen.getByRole('button').className).toContain('usage-pill-critical');
        expect(screen.getByText('92%')).toBeInTheDocument();
    });

    it('opens the dashboard on click and on Enter', async () => {
        stubFetch(OK_PAYLOAD);
        const onOpen = vi.fn();
        render(<UsageLimitPill onOpenDashboard={onOpen} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });

        fireEvent.click(screen.getByRole('button'));
        expect(onOpen).toHaveBeenCalledTimes(1);

        fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' });
        expect(onOpen).toHaveBeenCalledTimes(2);
    });

    it('degrades to a muted dash when the limits are unavailable', async () => {
        stubFetch({
            ok: false,
            reason: 'no-credentials',
            message: 'No Claude login found.',
            fetchedAt: new Date(NOW).toISOString(),
        });
        render(<UsageLimitPill />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });

        expect(screen.getByText('—')).toBeInTheDocument();
        expect(screen.getByRole('button').getAttribute('title')).toContain('No Claude login found.');
    });

    it('renders nothing when the API reports no session bar', async () => {
        stubFetch({ ...OK_PAYLOAD, session: null });
        const { container } = render(<UsageLimitPill />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(container).toBeEmptyDOMElement();
    });

    it('stays silent when the request itself fails', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        stubFetch({}, false);
        const { container } = render(<UsageLimitPill />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(container).toBeEmptyDOMElement();
    });

    it('polls once a minute rather than hammering the API', async () => {
        const fetchSpy = stubFetch(OK_PAYLOAD);
        render(<UsageLimitPill />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
});

// ---------------------------------------------------------------------------
// PlanLimitsPanel
// ---------------------------------------------------------------------------
describe('PlanLimitsPanel', () => {
    it('fetches nothing while the dashboard is closed', () => {
        const fetchSpy = stubFetch(OK_PAYLOAD);
        const { container } = render(<PlanLimitsPanel isOpen={false} />);
        expect(container).toBeEmptyDOMElement();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('renders the session bar, both weekly bars and the plan label', async () => {
        stubFetch(OK_PAYLOAD);
        render(<PlanLimitsPanel isOpen />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });

        expect(screen.getByText('Max (20x)')).toBeInTheDocument();
        expect(screen.getByText('Current session')).toBeInTheDocument();
        expect(screen.getByText('All models')).toBeInTheDocument();
        expect(screen.getByText('Fable')).toBeInTheDocument();
        expect(screen.getByText('11% used')).toBeInTheDocument();
        expect(screen.getByText('Weekly limits')).toBeInTheDocument();
    });

    it('explains that usage credits are off rather than showing an empty card', async () => {
        stubFetch(OK_PAYLOAD);
        render(<PlanLimitsPanel isOpen />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });

        expect(screen.getByText(/Usage credits are off/)).toBeInTheDocument();
    });

    it('shows spend against the monthly limit when credits are on', async () => {
        stubFetch({
            ...OK_PAYLOAD,
            credits: {
                enabled: true, usedMinor: 1500, limitMinor: 20000, balanceMinor: 2000,
                currency: 'USD', percent: 7.5, resetsAt: null, autoReload: true,
            },
        });
        render(<PlanLimitsPanel isOpen />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });

        expect(screen.getByText('$15.00 spent')).toBeInTheDocument();
        expect(screen.getByText('of $200.00 monthly limit')).toBeInTheDocument();
        expect(screen.getByText(/auto-reload on/)).toBeInTheDocument();
    });

    it('surfaces the reason when limits are unavailable', async () => {
        stubFetch({
            ok: false,
            reason: 'expired',
            message: 'Claude login expired. Run Claude Code to refresh it.',
            fetchedAt: new Date(NOW).toISOString(),
        });
        render(<PlanLimitsPanel isOpen />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });

        expect(screen.getByText(/Claude login expired/)).toBeInTheDocument();
    });

    it('reports a server error instead of rendering a blank panel', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        stubFetch({}, false);
        render(<PlanLimitsPanel isOpen />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });

        expect(screen.getByText(/Server returned 500/)).toBeInTheDocument();
    });

    it('bypasses the server cache when refresh is clicked', async () => {
        const fetchSpy = stubFetch(OK_PAYLOAD);
        render(<PlanLimitsPanel isOpen />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });

        fireEvent.click(screen.getByTitle('Refresh plan limits'));
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });

        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(String(fetchSpy.mock.calls[0][0])).not.toContain('refresh=1');
        expect(String(fetchSpy.mock.calls[1][0])).toContain('refresh=1');
    });
});

// ---------------------------------------------------------------------------
// Payload hardening: a proxy, a dev stub, or an older server can answer this
// route with something that is not a limits payload. Neither component may
// render a misleading indicator in that case.
// ---------------------------------------------------------------------------
describe('unrecognised payloads', () => {
    it('the pill renders nothing when the response is not a limits payload', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        stubFetch({});
        const { container } = render(<UsageLimitPill />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(container).toBeEmptyDOMElement();
    });

    it('the panel says so instead of rendering empty bars', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        stubFetch({ something: 'else' });
        render(<PlanLimitsPanel isOpen />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(screen.getByText(/unexpected response/)).toBeInTheDocument();
    });
});
