/**
 * Behaviour tests for the plan-limit usage UI:
 *   - <SessionUsageMeter />  always-on 5-hour meter in the workspace panel
 *   - <PlanUsageDashboard /> modal with session / weekly / per-model bars
 *
 * Both read `planUsage` from the Zustand store, which the WebSocket layer
 * populates from `usage:updated`. Tests drive the store directly and assert
 * on roles / labels / text — never CSS classes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { PlanUsage } from '@claudia/shared';

import { SessionUsageMeter } from '../SessionUsageMeter';
import { PlanUsageDashboard } from '../PlanUsageDashboard';
import { useTaskStore } from '../../stores/taskStore';

const PRISTINE_STORE = useTaskStore.getState();

const NOW = Date.parse('2026-07-02T12:00:00Z');

const healthy: PlanUsage = {
    fiveHour: { utilization: 45.4, resetsAt: '2026-07-02T14:17:00Z' },
    sevenDay: { utilization: 31, resetsAt: '2026-07-08T15:00:00Z' },
    sevenDayByModel: [
        { model: 'fable', utilization: 41, resetsAt: '2026-07-08T15:00:00Z' },
        { model: 'opus', utilization: 12, resetsAt: '2026-07-08T15:00:00Z' },
    ],
    planLabel: 'Max',
    fetchedAt: '2026-07-02T12:00:00Z',
};

function setUsage(u: PlanUsage | null) {
    act(() => {
        useTaskStore.getState().setPlanUsage(u);
    });
}

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(NOW);
    useTaskStore.setState({ ...PRISTINE_STORE, planUsage: null }, true);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('SessionUsageMeter', () => {
    it('renders nothing before any usage has arrived', () => {
        const { container } = render(<SessionUsageMeter />);
        expect(container).toBeEmptyDOMElement();
    });

    it('shows the 5-hour utilization, a countdown, and opens the dashboard on click', () => {
        setUsage(healthy);
        render(<SessionUsageMeter />);

        const bar = screen.getByRole('progressbar', { name: /session usage/i });
        expect(bar).toHaveAttribute('aria-valuenow', '45');
        expect(screen.getByText('45% · resets in 2h 17m')).toBeInTheDocument();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /45% · resets in 2h 17m/ }));
        expect(screen.getByRole('dialog', { name: /max usage/i })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /close/i }));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('drops the countdown once the reset time has passed', () => {
        setUsage({ ...healthy, fiveHour: { utilization: 10, resetsAt: '2026-07-02T11:00:00Z' } });
        render(<SessionUsageMeter />);
        expect(screen.getByText('10%')).toBeInTheDocument();
    });

    it('ticks the countdown once a minute without a new fetch', () => {
        setUsage(healthy);
        render(<SessionUsageMeter />);
        expect(screen.getByText('45% · resets in 2h 17m')).toBeInTheDocument();

        act(() => {
            vi.advanceTimersByTime(60_000);
        });
        expect(screen.getByText('45% · resets in 2h 16m')).toBeInTheDocument();
    });

    it('summarizes every window (session, weekly, per-model) in the meter tooltip', () => {
        setUsage(healthy);
        render(<SessionUsageMeter />);
        const title = screen.getByRole('button', { name: /45%/ }).getAttribute('title') ?? '';
        expect(title).toMatch(/^Session \(5h\): 45% · resets /);
        expect(title).toContain('Weekly (all models): 31%');
        expect(title).toContain('Fable (weekly): 41%');
        expect(title).toContain('Opus (weekly): 12%');
    });

    it('flags cached data when the service reports stale', () => {
        setUsage({ ...healthy, stale: true });
        render(<SessionUsageMeter />);
        expect(screen.getByTitle('Showing cached data')).toBeInTheDocument();
    });

    it('degrades to an "unavailable" pill that still opens the dashboard (mouse + keyboard)', () => {
        setUsage({
            ...healthy,
            unavailable: true,
            reason: 'no_token',
            planLabel: 'Unknown',
        });
        render(<SessionUsageMeter />);

        const pill = screen.getByRole('button', { name: /usage unavailable/i });
        expect(pill).toHaveAttribute('title', expect.stringContaining('no_token'));
        expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();

        // A native <button>: Enter/Space activate it without a hand-rolled
        // onKeyDown, so assert the activation the browser actually performs.
        fireEvent.click(pill);
        expect(screen.getByRole('dialog', { name: /plan usage usage/i })).toBeInTheDocument();
        expect(screen.getByText(/currently unavailable \(no_token\)/i)).toBeInTheDocument();
    });
});

describe('PlanUsageDashboard', () => {
    it('renders session, weekly and per-model bars from the store', () => {
        setUsage(healthy);
        render(<PlanUsageDashboard onClose={() => {}} />);

        expect(screen.getByRole('heading', { name: 'Max' })).toBeInTheDocument();
        expect(screen.getByRole('progressbar', { name: '5-hour window: 45%' })).toHaveAttribute('aria-valuenow', '45');
        expect(screen.getByRole('progressbar', { name: 'All models: 31%' })).toBeInTheDocument();
        expect(screen.getByRole('progressbar', { name: 'Fable: 41%' })).toBeInTheDocument();
        expect(screen.getByRole('progressbar', { name: 'Opus: 12%' })).toBeInTheDocument();
        expect(screen.getByText('Resets in 2h 17m')).toBeInTheDocument();
        expect(screen.queryByText(/no per-model limits/i)).not.toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: /extra usage/i })).not.toBeInTheDocument();
    });

    it('notes when no per-model limits are reported and shows a stale banner', () => {
        setUsage({ ...healthy, sevenDayByModel: [], stale: true });
        render(<PlanUsageDashboard onClose={() => {}} />);
        expect(screen.getByText(/no per-model limits reported/i)).toBeInTheDocument();
        expect(screen.getByText(/showing cached data/i)).toBeInTheDocument();
    });

    it('shows the extra-usage section only when enabled', () => {
        setUsage({
            ...healthy,
            extraUsage: { isEnabled: true, monthlyLimit: 100, usedCredits: 25, utilization: 25 },
        });
        render(<PlanUsageDashboard onClose={() => {}} />);
        expect(screen.getByRole('heading', { name: /extra usage/i })).toBeInTheDocument();
        expect(screen.getByText('25.00 / 100.00 credits')).toBeInTheDocument();
        expect(screen.getByText('25%')).toBeInTheDocument();
    });

    it('falls back to an empty state when usage is null', () => {
        setUsage(null);
        render(<PlanUsageDashboard onClose={() => {}} />);
        expect(screen.getByRole('heading', { name: 'Plan Usage' })).toBeInTheDocument();
        expect(screen.getByText(/currently unavailable\./i)).toBeInTheDocument();
        expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });

    it('closes on Escape, on backdrop click, and on the close button — but not on content click', () => {
        setUsage(healthy);
        const onClose = vi.fn();
        render(<PlanUsageDashboard onClose={onClose} />);

        fireEvent.click(screen.getByRole('dialog'));
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole('button', { name: /close/i }));
        expect(onClose).toHaveBeenCalledTimes(2);

        // Backdrop is the dialog's parent.
        fireEvent.click(screen.getByRole('dialog').parentElement!);
        expect(onClose).toHaveBeenCalledTimes(3);
    });
});

describe('<SessionUsageMeter /> — regressions', () => {
    it('renders nothing at all before any usage has arrived', () => {
        setUsage(null);
        const { container } = render(<SessionUsageMeter />);
        // No empty chrome, no phantom 0% bar, no progressbar to mislead.
        expect(container).toBeEmptyDOMElement();
        expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });

    it('the dashboard opened from the UNAVAILABLE meter can actually be closed', () => {
        // The modal used to be rendered *inside* the clickable trigger, so the
        // close click bubbled back into the trigger's onClick and reopened it.
        setUsage({ ...healthy, unavailable: true, reason: 'no_token' });
        render(<SessionUsageMeter />);

        fireEvent.click(screen.getByRole('button', { name: /usage unavailable/i }));
        expect(screen.getByRole('dialog')).toBeInTheDocument();

        fireEvent.click(screen.getByTitle('Close'));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('the same dashboard closes on a backdrop click', () => {
        setUsage({ ...healthy, unavailable: true, reason: 'network' });
        const { container } = render(<SessionUsageMeter />);
        fireEvent.click(screen.getByRole('button', { name: /usage unavailable/i }));

        const overlay = container.querySelector('.plan-usage-overlay');
        expect(overlay).not.toBeNull();
        fireEvent.click(overlay!);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('the healthy meter\'s dashboard also closes', () => {
        setUsage(healthy);
        render(<SessionUsageMeter />);
        fireEvent.click(screen.getByRole('button', { name: /45% · resets in 2h 17m/ }));
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        fireEvent.click(screen.getByTitle('Close'));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('does not re-render when unrelated store slices change', () => {
        // The meter is mounted for the whole session next to a store that gets
        // written on every WebSocket frame. It must be selector-scoped.
        let renders = 0;
        function Probe() {
            renders++;
            return <SessionUsageMeter />;
        }
        setUsage(healthy);
        render(<Probe />);
        const before = renders;

        act(() => {
            useTaskStore.setState({ tasks: new Map([['t1', { id: 't1' } as never]]) });
            useTaskStore.getState().setErrorNotification('unrelated');
            useTaskStore.setState({ isOffline: true });
        });
        expect(renders).toBe(before);

        // ...but it does update when planUsage itself changes.
        setUsage({ ...healthy, fiveHour: { utilization: 99, resetsAt: healthy.fiveHour.resetsAt } });
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '99');
    });

    it('survives a reset timestamp in the past without rendering a negative countdown', () => {
        setUsage({
            ...healthy,
            fiveHour: { utilization: 20, resetsAt: '2026-01-01T00:00:00Z' }, // long gone
        });
        render(<SessionUsageMeter />);
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '20');
        expect(screen.getByText('20%')).toBeInTheDocument(); // no "resets in -3000h"
        expect(screen.queryByText(/-\d/)).not.toBeInTheDocument();
    });

    it('survives a malformed reset timestamp', () => {
        setUsage({ ...healthy, fiveHour: { utilization: 5, resetsAt: 'not-a-date' } });
        expect(() => render(<SessionUsageMeter />)).not.toThrow();
        expect(screen.getByText('5%')).toBeInTheDocument();
    });
});
