/**
 * Behaviour tests for the small presentational components.
 *
 * One `describe` per component. These are all tiny, so the bar is high
 * coverage of their real branching: conditional rendering, callbacks firing
 * (and NOT firing), keyboard handling, and derived-display formatting.
 *
 * Conventions:
 *  - Queries go through role / label / text. Never CSS classes.
 *  - Anything time-based uses fake timers; nothing sleeps.
 *  - The Zustand store and localStorage are reset before every test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ConfirmModal } from '../ConfirmModal';
import { ContextMenu, ContextMenuItem } from '../ContextMenu';
import { Notification } from '../Notification';
import { NotificationProvider, useNotification } from '../NotificationContainer';
import { PrBadge } from '../PrBadge';
import { PathInputModal } from '../PathInputModal';
import { SystemPromptModal } from '../SystemPromptModal';
import { TaskCreateModal } from '../TaskCreateModal';
import { SystemStats } from '../SystemStats';
import {
    TaskTokenStats,
    formatTokenCount,
    formatModelName,
    formatCost,
} from '../TaskTokenStats';
import { TaskSummaryPanel } from '../TaskSummaryPanel';
import { DARK_TERMINAL_THEME, LIGHT_TERMINAL_THEME } from '../../types/theme';
import { useTaskStore } from '../../stores/taskStore';
import type { WorkspacePrInfo, TaskSummary, Task } from '@claudia/shared';

// TaskSummaryPanel talks to the websocket layer; stub the whole hook so the
// panel's own logic is what is under test.
const executeSupervisorAction = vi.fn();
const requestTaskAnalysis = vi.fn();
vi.mock('../../hooks/useWebSocket', () => ({
    useWebSocket: () => ({ executeSupervisorAction, requestTaskAnalysis }),
}));

/** Snapshot of the store fields these components read, restored per test. */
function resetStore() {
    useTaskStore.setState({
        tasks: new Map(),
        taskSummaries: new Map(),
        isConnected: false,
        tokenCostEnabled: false,
    });
}

beforeEach(() => {
    localStorage.clear();
    resetStore();
    vi.clearAllMocks();
});

afterEach(() => {
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// ConfirmModal
// ---------------------------------------------------------------------------
describe('ConfirmModal', () => {
    const setup = (props: Partial<React.ComponentProps<typeof ConfirmModal>> = {}) => {
        const onConfirm = vi.fn();
        const onCancel = vi.fn();
        const utils = render(
            <ConfirmModal title="Delete task" onConfirm={onConfirm} onCancel={onCancel} {...props}>
                <p>This cannot be undone.</p>
            </ConfirmModal>
        );
        return { onConfirm, onCancel, ...utils };
    };

    it('renders the title, body and default button labels', () => {
        setup();
        expect(screen.getByRole('heading', { name: 'Delete task' })).toBeInTheDocument();
        expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });

    it('honours custom confirm/cancel labels', () => {
        setup({ confirmLabel: 'Delete forever', cancelLabel: 'Keep it' });
        expect(screen.getByRole('button', { name: 'Delete forever' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Keep it' })).toBeInTheDocument();
    });

    it('renders a custom icon in place of the default warning icon', () => {
        setup({ icon: <span>custom-icon</span> });
        expect(screen.getByText('custom-icon')).toBeInTheDocument();
    });

    it('confirm fires onConfirm and not onCancel', async () => {
        const user = userEvent.setup();
        const { onConfirm, onCancel } = setup();
        await user.click(screen.getByRole('button', { name: 'Confirm' }));
        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(onCancel).not.toHaveBeenCalled();
    });

    it('cancel fires onCancel and not onConfirm', async () => {
        const user = userEvent.setup();
        const { onConfirm, onCancel } = setup();
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('Escape anywhere in the document cancels', () => {
        const { onCancel } = setup();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('ignores non-Escape keys', () => {
        const { onCancel } = setup();
        fireEvent.keyDown(document, { key: 'Enter' });
        expect(onCancel).not.toHaveBeenCalled();
    });

    it('stops listening for Escape once unmounted', () => {
        const { onCancel, unmount } = setup();
        unmount();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onCancel).not.toHaveBeenCalled();
    });

    it('clicking the backdrop cancels, clicking the dialog body does not', async () => {
        const user = userEvent.setup();
        const { onCancel, container } = setup();
        const overlay = container.firstElementChild as HTMLElement;

        await user.click(screen.getByText('This cannot be undone.'));
        expect(onCancel).not.toHaveBeenCalled();

        await user.click(overlay);
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('renders each variant without changing behaviour', async () => {
        const user = userEvent.setup();
        for (const variant of ['danger', 'warning', 'default'] as const) {
            const { onConfirm, unmount } = setup({ variant });
            await user.click(screen.getByRole('button', { name: 'Confirm' }));
            expect(onConfirm).toHaveBeenCalledTimes(1);
            unmount();
        }
    });
});

// ---------------------------------------------------------------------------
// ContextMenu
// ---------------------------------------------------------------------------
describe('ContextMenu', () => {
    const makeItems = (): { items: ContextMenuItem[]; open: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; locked: ReturnType<typeof vi.fn> } => {
        const open = vi.fn();
        const remove = vi.fn();
        const locked = vi.fn();
        return {
            open,
            remove,
            locked,
            items: [
                { label: 'Open', icon: null, onClick: open },
                { label: 'Locked', icon: null, onClick: locked, disabled: true },
                { label: '', icon: null, onClick: () => {}, divider: true },
                { label: 'Delete', icon: null, onClick: remove, danger: true },
            ],
        };
    };

    const setup = () => {
        const onClose = vi.fn();
        const { items, open, remove, locked } = makeItems();
        const utils = render(<ContextMenu x={10} y={20} items={items} onClose={onClose} />);
        return { onClose, open, remove, locked, ...utils };
    };

    it('renders a button per non-divider item', () => {
        setup();
        expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Locked' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
        // 3 items + 1 divider (dividers are not buttons)
        expect(screen.getAllByRole('button')).toHaveLength(3);
    });

    it('clicking an item runs its handler then closes', async () => {
        const user = userEvent.setup();
        const { open, onClose } = setup();
        await user.click(screen.getByRole('button', { name: 'Open' }));
        expect(open).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('a disabled item is not clickable and does not close the menu', async () => {
        const user = userEvent.setup();
        const { locked, onClose } = setup();
        const button = screen.getByRole('button', { name: 'Locked' });
        expect(button).toBeDisabled();
        await user.click(button);
        expect(locked).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it('mousedown outside closes; mousedown inside does not', () => {
        const { onClose } = setup();
        fireEvent.mouseDown(screen.getByRole('button', { name: 'Open' }));
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.mouseDown(document.body);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('Escape closes, other keys do not', () => {
        const { onClose } = setup();
        fireEvent.keyDown(document, { key: 'a' });
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('detaches its document listeners on unmount', () => {
        const { onClose, unmount } = setup();
        unmount();
        fireEvent.keyDown(document, { key: 'Escape' });
        fireEvent.mouseDown(document.body);
        expect(onClose).not.toHaveBeenCalled();
    });

    it('renders each item icon alongside its label', () => {
        const onClose = vi.fn();
        render(
            <ContextMenu
                x={0}
                y={0}
                items={[{ label: 'Rename', icon: <span>pencil-icon</span>, onClick: vi.fn() }]}
                onClose={onClose}
            />
        );
        const button = screen.getByRole('button', { name: /Rename/ });
        expect(within(button).getByText('pencil-icon')).toBeInTheDocument();
    });

    it('positions itself at the requested coordinates', () => {
        const onClose = vi.fn();
        const { container } = render(
            <ContextMenu x={42} y={99} items={[{ label: 'Only', icon: null, onClick: vi.fn() }]} onClose={onClose} />
        );
        const menu = container.firstElementChild as HTMLElement;
        expect(menu.style.left).toBe('42px');
        expect(menu.style.top).toBe('99px');
    });
});

// ---------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------
describe('Notification', () => {
    it('renders title and optional message inside an alert', () => {
        render(<Notification type="info" title="Heads up" message="Something happened" onClose={vi.fn()} />);
        const alert = screen.getByRole('alert');
        expect(within(alert).getByText('Heads up')).toBeInTheDocument();
        expect(within(alert).getByText('Something happened')).toBeInTheDocument();
    });

    it('omits the message block when no message is given', () => {
        render(<Notification type="info" title="Title only" onClose={vi.fn()} />);
        expect(screen.getByText('Title only')).toBeInTheDocument();
        expect(screen.getByRole('alert').textContent).toContain('Title only');
    });

    it.each(['success', 'error', 'warning', 'info'] as const)('renders the %s variant', (type) => {
        render(<Notification type={type} title={`a ${type}`} onClose={vi.fn()} />);
        expect(screen.getByText(`a ${type}`)).toBeInTheDocument();
    });

    it('auto-closes once the duration elapses', () => {
        vi.useFakeTimers();
        const onClose = vi.fn();
        render(<Notification type="info" title="Bye" duration={5000} onClose={onClose} />);

        act(() => { vi.advanceTimersByTime(4999); });
        expect(onClose).not.toHaveBeenCalled();

        act(() => { vi.advanceTimersByTime(1); });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('never auto-closes when duration is 0', () => {
        vi.useFakeTimers();
        const onClose = vi.fn();
        render(<Notification type="info" title="Sticky" duration={0} onClose={onClose} />);
        act(() => { vi.advanceTimersByTime(60_000); });
        expect(onClose).not.toHaveBeenCalled();
    });

    it('cancels its auto-close timer on unmount', () => {
        vi.useFakeTimers();
        const onClose = vi.fn();
        const { unmount } = render(<Notification type="info" title="Gone" duration={1000} onClose={onClose} />);
        unmount();
        act(() => { vi.advanceTimersByTime(5000); });
        expect(onClose).not.toHaveBeenCalled();
    });

    it('the close button closes without invoking onClick', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        const onClick = vi.fn();
        render(<Notification type="info" title="X" duration={0} onClick={onClick} onClose={onClose} />);

        await user.click(screen.getByRole('button', { name: 'Close notification' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onClick).not.toHaveBeenCalled();
    });

    it('clicking the body runs onClick then closes, when clickable', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        const onClick = vi.fn();
        render(<Notification type="success" title="Click me" duration={0} onClick={onClick} onClose={onClose} />);

        await user.click(screen.getByText('Click me'));
        expect(onClick).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('body clicks do nothing when no onClick was supplied', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        render(<Notification type="success" title="Inert" duration={0} onClose={onClose} />);
        await user.click(screen.getByText('Inert'));
        expect(onClose).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// NotificationContainer
// ---------------------------------------------------------------------------
describe('NotificationContainer', () => {
    /** Test harness exposing every helper on the context as a button. */
    function Harness() {
        const { showNotification, showSuccess, showError, showWarning, showInfo } = useNotification();
        return (
            <div>
                <button onClick={() => showSuccess('Saved', 'All good')}>fire success</button>
                <button onClick={() => showError('Boom', 'It broke')}>fire error</button>
                <button onClick={() => showWarning('Careful')}>fire warning</button>
                <button onClick={() => showInfo('FYI')}>fire info</button>
                <button onClick={() => showNotification('info', 'Custom', 'msg', 1000)}>fire custom</button>
            </div>
        );
    }

    const renderHarness = () =>
        render(
            <NotificationProvider>
                <Harness />
            </NotificationProvider>
        );

    it('throws when useNotification is used outside the provider', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => render(<Harness />)).toThrow(/must be used within NotificationProvider/);
        spy.mockRestore();
    });

    it('renders the provider children', () => {
        renderHarness();
        expect(screen.getByRole('button', { name: 'fire success' })).toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it.each([
        ['fire success', 'Saved'],
        ['fire error', 'Boom'],
        ['fire warning', 'Careful'],
        ['fire info', 'FYI'],
    ])('%s shows a notification titled %s', async (button, title) => {
        const user = userEvent.setup();
        renderHarness();
        await user.click(screen.getByRole('button', { name: button }));
        expect(within(screen.getByRole('alert')).getByText(title)).toBeInTheDocument();
    });

    it('stacks multiple notifications', async () => {
        const user = userEvent.setup();
        renderHarness();
        await user.click(screen.getByRole('button', { name: 'fire success' }));
        await user.click(screen.getByRole('button', { name: 'fire warning' }));
        expect(screen.getAllByRole('alert')).toHaveLength(2);
    });

    // These drive the auto-dismiss timers, so they use fireEvent rather than
    // userEvent: userEvent's internal scheduling deadlocks against vitest's fake
    // clock even with advanceTimers wired up.
    it('auto-dismisses a default notification after 5s', () => {
        vi.useFakeTimers();
        renderHarness();

        fireEvent.click(screen.getByRole('button', { name: 'fire warning' }));
        expect(screen.getByText('Careful')).toBeInTheDocument();

        act(() => { vi.advanceTimersByTime(4999); });
        expect(screen.getByRole('alert')).toBeInTheDocument();

        act(() => { vi.advanceTimersByTime(1); });
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('keeps an error notification up for 7s, past the 5s default', () => {
        vi.useFakeTimers();
        renderHarness();

        fireEvent.click(screen.getByRole('button', { name: 'fire error' }));

        act(() => { vi.advanceTimersByTime(5000); });
        expect(screen.getByText('Boom')).toBeInTheDocument();

        act(() => { vi.advanceTimersByTime(2000); });
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('honours an explicit duration passed to showNotification', () => {
        vi.useFakeTimers();
        renderHarness();

        fireEvent.click(screen.getByRole('button', { name: 'fire custom' }));
        expect(screen.getByText('Custom')).toBeInTheDocument();

        act(() => { vi.advanceTimersByTime(1000); });
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('dismisses only the clicked notification', async () => {
        const user = userEvent.setup();
        renderHarness();
        await user.click(screen.getByRole('button', { name: 'fire success' }));
        await user.click(screen.getByRole('button', { name: 'fire warning' }));

        const first = screen.getAllByRole('alert')[0];
        await user.click(within(first).getByRole('button', { name: 'Close notification' }));

        const remaining = screen.getAllByRole('alert');
        expect(remaining).toHaveLength(1);
        expect(within(remaining[0]).getByText('Careful')).toBeInTheDocument();
    });
});

// ---------------------------------------------------------------------------
// PrBadge
// ---------------------------------------------------------------------------
describe('PrBadge', () => {
    const pr = (over: Partial<WorkspacePrInfo> = {}): WorkspacePrInfo => ({
        number: 1234,
        title: 'Add widget',
        state: 'open',
        url: 'https://github.com/acme/repo/pull/1234',
        ...over,
    });

    it('renders the PR number as an external link', () => {
        render(<PrBadge prInfo={pr()} />);
        const link = screen.getByRole('link', { name: /#1234/ });
        expect(link).toHaveAttribute('href', 'https://github.com/acme/repo/pull/1234');
        expect(link).toHaveAttribute('target', '_blank');
        expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it.each([
        ['open', '#1234 Add widget — open'],
        ['draft', '#1234 Add widget — draft'],
        ['merged', '#1234 Add widget — merged'],
        ['closed', '#1234 Add widget — closed'],
    ] as const)('derives the tooltip for a %s PR', (state, expected) => {
        render(<PrBadge prInfo={pr({ state })} />);
        expect(screen.getByRole('link', { name: /#1234/ })).toHaveAttribute('title', expected);
    });

    it.each([
        ['passed', '#7 Fix — open · CI passed'],
        ['failed', '#7 Fix — open · CI failed'],
        ['running', '#7 Fix — open · CI running'],
    ] as const)('appends CI %s to the tooltip', (ci, expected) => {
        render(<PrBadge prInfo={pr({ number: 7, title: 'Fix', ci })} />);
        expect(screen.getByRole('link', { name: /#7/ })).toHaveAttribute('title', expected);
    });

    it('omits the CI suffix when CI is "none" or absent', () => {
        const { rerender } = render(<PrBadge prInfo={pr({ ci: 'none' })} />);
        expect(screen.getByRole('link', { name: /#1234/ })).toHaveAttribute('title', '#1234 Add widget — open');

        rerender(<PrBadge prInfo={pr({ ci: undefined })} />);
        expect(screen.getByRole('link', { name: /#1234/ })).toHaveAttribute('title', '#1234 Add widget — open');
    });

    it('omits the title segment when the PR has no title', () => {
        render(<PrBadge prInfo={pr({ title: '' })} />);
        expect(screen.getByRole('link', { name: /#1234/ })).toHaveAttribute('title', '#1234 — open');
    });

    it('does not bubble clicks to an enclosing row handler', async () => {
        const user = userEvent.setup();
        const onRowClick = vi.fn();
        render(
            <div onClick={onRowClick}>
                <PrBadge prInfo={pr()} />
            </div>
        );
        await user.click(screen.getByRole('link', { name: /#1234/ }));
        expect(onRowClick).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// PathInputModal
// ---------------------------------------------------------------------------
describe('PathInputModal', () => {
    const setup = (props: Partial<React.ComponentProps<typeof PathInputModal>> = {}) => {
        const onSubmit = vi.fn();
        const onCancel = vi.fn();
        const utils = render(<PathInputModal onSubmit={onSubmit} onCancel={onCancel} {...props} />);
        return { onSubmit, onCancel, ...utils };
    };

    it('renders the folder-path form with the submit button disabled', () => {
        setup();
        expect(screen.getByRole('heading', { name: 'Add Workspace' })).toBeInTheDocument();
        expect(screen.getByLabelText('Folder path')).toHaveValue('');
        expect(screen.getByRole('button', { name: 'Add Workspace' })).toBeDisabled();
    });

    it('enables submit once a path is typed and submits the trimmed value', async () => {
        const user = userEvent.setup();
        const { onSubmit } = setup();
        await user.type(screen.getByLabelText('Folder path'), '  /srv/app  ');

        const submit = screen.getByRole('button', { name: 'Add Workspace' });
        expect(submit).toBeEnabled();
        await user.click(submit);
        expect(onSubmit).toHaveBeenCalledWith('/srv/app');
    });

    it('keeps submit disabled for whitespace-only input', async () => {
        const user = userEvent.setup();
        setup();
        await user.type(screen.getByLabelText('Folder path'), '   ');
        expect(screen.getByRole('button', { name: 'Add Workspace' })).toBeDisabled();
    });

    it('prepends the base directory to a bare folder name', async () => {
        const user = userEvent.setup();
        const { onSubmit } = setup({ defaultBaseDirectory: '/Users/me/Work' });
        expect(screen.getByText('Base directory: /Users/me/Work')).toBeInTheDocument();

        await user.type(screen.getByLabelText('Folder path'), 'my-project');
        await user.click(screen.getByRole('button', { name: 'Add Workspace' }));
        expect(onSubmit).toHaveBeenCalledWith('/Users/me/Work/my-project');
    });

    it.each(['/absolute/path', '~/home/path'])('leaves %s untouched despite a base directory', async (path) => {
        const user = userEvent.setup();
        const { onSubmit } = setup({ defaultBaseDirectory: '/Users/me/Work' });
        await user.type(screen.getByLabelText('Folder path'), path);
        await user.click(screen.getByRole('button', { name: 'Add Workspace' }));
        expect(onSubmit).toHaveBeenCalledWith(path);
    });

    it('renders recent workspaces with relative timestamps and re-labels the input', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-08T12:00:00Z'));

        setup({
            recentWorkspaces: [
                { id: '/a', name: 'today-ws', removedAt: '2026-08-08T01:00:00Z' },
                { id: '/b', name: 'yesterday-ws', removedAt: '2026-08-07T01:00:00Z' },
                { id: '/c', name: 'days-ws', removedAt: '2026-08-04T01:00:00Z' },
                { id: '/d', name: 'weeks-ws', removedAt: '2026-07-20T01:00:00Z' },
                { id: '/e', name: 'months-ws', removedAt: '2026-05-01T01:00:00Z' },
            ],
        });

        expect(screen.getByText('Recent Workspaces')).toBeInTheDocument();
        expect(screen.getByText('Today')).toBeInTheDocument();
        expect(screen.getByText('Yesterday')).toBeInTheDocument();
        expect(screen.getByText('4 days ago')).toBeInTheDocument();
        expect(screen.getByText('2 weeks ago')).toBeInTheDocument();
        expect(screen.getByText('3 months ago')).toBeInTheDocument();
        // The input label changes when recents are present.
        expect(screen.getByLabelText('Or add a new folder:')).toBeInTheDocument();
    });

    it('clicking a recent workspace submits its id', async () => {
        const user = userEvent.setup();
        const { onSubmit } = setup({
            recentWorkspaces: [{ id: '/repos/alpha', name: 'alpha', removedAt: new Date().toISOString() }],
        });
        await user.click(screen.getByText('alpha'));
        expect(onSubmit).toHaveBeenCalledWith('/repos/alpha');
    });

    it('removing a recent workspace does not also submit it', async () => {
        const user = userEvent.setup();
        const onRemoveRecent = vi.fn();
        const { onSubmit } = setup({
            recentWorkspaces: [{ id: '/repos/alpha', name: 'alpha', removedAt: new Date().toISOString() }],
            onRemoveRecent,
        });

        await user.click(screen.getByTitle('Remove from history'));
        expect(onRemoveRecent).toHaveBeenCalledWith('/repos/alpha');
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('tolerates a missing onRemoveRecent handler', async () => {
        const user = userEvent.setup();
        const { onSubmit } = setup({
            recentWorkspaces: [{ id: '/repos/alpha', name: 'alpha', removedAt: new Date().toISOString() }],
        });
        await user.click(screen.getByTitle('Remove from history'));
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('shows Browse only when enabled and a handler exists', async () => {
        const user = userEvent.setup();
        const onBrowse = vi.fn();

        const { unmount } = setup({ showBrowseButton: false, onBrowse });
        expect(screen.queryByTitle('Browse for folder')).not.toBeInTheDocument();
        unmount();

        setup({ showBrowseButton: true, onBrowse });
        await user.click(screen.getByTitle('Browse for folder'));
        expect(onBrowse).toHaveBeenCalledTimes(1);
    });

    it('disables Browse while browsing', () => {
        setup({ onBrowse: vi.fn(), isBrowsing: true });
        const browse = screen.getByTitle('Browse for folder');
        expect(browse).toBeDisabled();
        expect(browse).toHaveTextContent('...');
    });

    it('cancel and backdrop click both cancel', async () => {
        const user = userEvent.setup();
        const { onCancel, container } = setup();

        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onCancel).toHaveBeenCalledTimes(1);

        await user.click(container.firstElementChild as HTMLElement);
        expect(onCancel).toHaveBeenCalledTimes(2);
    });

    it('clicking inside the dialog does not cancel', async () => {
        const user = userEvent.setup();
        const { onCancel } = setup();
        await user.click(screen.getByRole('heading', { name: 'Add Workspace' }));
        expect(onCancel).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// SystemPromptModal
// ---------------------------------------------------------------------------
describe('SystemPromptModal', () => {
    const setup = (props: Partial<React.ComponentProps<typeof SystemPromptModal>> = {}) => {
        const onSave = vi.fn();
        const onClose = vi.fn();
        const utils = render(
            <SystemPromptModal
                workspaceId="ws-1"
                workspaceName="claudia"
                initialPrompt="be concise"
                onSave={onSave}
                onClose={onClose}
                {...props}
            />
        );
        return { onSave, onClose, ...utils };
    };

    it('shows the workspace name and seeds the textarea from initialPrompt', () => {
        setup();
        expect(screen.getByRole('heading', { name: 'System Prompt' })).toBeInTheDocument();
        expect(screen.getByText('claudia')).toBeInTheDocument();
        expect(screen.getByLabelText('System Prompt')).toHaveValue('be concise');
    });

    it('saves the edited prompt and then closes', async () => {
        const user = userEvent.setup();
        const { onSave, onClose } = setup({ initialPrompt: '' });

        await user.type(screen.getByLabelText('System Prompt'), 'always write tests');
        await user.click(screen.getByRole('button', { name: 'Save' }));

        expect(onSave).toHaveBeenCalledWith('always write tests');
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('saves an empty prompt (documented "use the default" path)', async () => {
        const user = userEvent.setup();
        const { onSave } = setup({ initialPrompt: 'old' });

        await user.clear(screen.getByLabelText('System Prompt'));
        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(onSave).toHaveBeenCalledWith('');
    });

    it('cancel closes without saving', async () => {
        const user = userEvent.setup();
        const { onSave, onClose } = setup();
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onSave).not.toHaveBeenCalled();
    });

    it('Escape inside the dialog closes without saving', () => {
        const { onSave, onClose } = setup();
        fireEvent.keyDown(screen.getByLabelText('System Prompt'), { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onSave).not.toHaveBeenCalled();
    });

    it('other keys do not close', () => {
        const { onClose } = setup();
        fireEvent.keyDown(screen.getByLabelText('System Prompt'), { key: 'a' });
        expect(onClose).not.toHaveBeenCalled();
    });

    it('backdrop click closes; clicks inside the dialog do not', async () => {
        const user = userEvent.setup();
        const { onClose, container } = setup();

        await user.click(screen.getByRole('heading', { name: 'System Prompt' }));
        expect(onClose).not.toHaveBeenCalled();

        await user.click(container.firstElementChild as HTMLElement);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('resyncs the textarea when initialPrompt changes', () => {
        const { rerender } = setup({ initialPrompt: 'first' });
        expect(screen.getByLabelText('System Prompt')).toHaveValue('first');

        rerender(
            <SystemPromptModal
                workspaceId="ws-1"
                workspaceName="claudia"
                initialPrompt="second"
                onSave={vi.fn()}
                onClose={vi.fn()}
            />
        );
        expect(screen.getByLabelText('System Prompt')).toHaveValue('second');
    });
});

// ---------------------------------------------------------------------------
// TaskCreateModal
// ---------------------------------------------------------------------------
describe('TaskCreateModal', () => {
    const setup = () => {
        const onClose = vi.fn();
        const onCreateTask = vi.fn();
        const utils = render(
            <TaskCreateModal
                workspaceId="ws-42"
                workspaceName="claudia"
                onClose={onClose}
                onCreateTask={onCreateTask}
            />
        );
        return { onClose, onCreateTask, ...utils };
    };

    it('renders the form with the create button disabled', () => {
        setup();
        expect(screen.getByRole('heading', { name: 'Create Task' })).toBeInTheDocument();
        expect(screen.getByText('claudia')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Create Task' })).toBeDisabled();
    });

    it('creates the task with the trimmed prompt used as both name and description', async () => {
        const user = userEvent.setup();
        const { onCreateTask, onClose } = setup();

        await user.type(screen.getByLabelText('Task *'), '  Fix login bug  ');
        await user.click(screen.getByRole('button', { name: 'Create Task' }));

        expect(onCreateTask).toHaveBeenCalledWith('Fix login bug', 'Fix login bug', 'ws-42');
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('stays disabled for whitespace-only input', async () => {
        const user = userEvent.setup();
        const { onCreateTask } = setup();
        await user.type(screen.getByLabelText('Task *'), '    ');
        expect(screen.getByRole('button', { name: 'Create Task' })).toBeDisabled();
        expect(onCreateTask).not.toHaveBeenCalled();
    });

    it('the close button closes without creating', async () => {
        const user = userEvent.setup();
        const { onClose, onCreateTask } = setup();
        await user.click(screen.getByRole('button', { name: 'Close' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onCreateTask).not.toHaveBeenCalled();
    });

    it('cancel closes without creating', async () => {
        const user = userEvent.setup();
        const { onClose, onCreateTask } = setup();
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onCreateTask).not.toHaveBeenCalled();
    });

    it('Escape closes, and the listener is removed on unmount', () => {
        const { onClose, unmount } = setup();
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);

        unmount();
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('backdrop click closes but clicks inside the dialog do not', async () => {
        const user = userEvent.setup();
        const { onClose, container } = setup();

        await user.click(screen.getByRole('heading', { name: 'Create Task' }));
        expect(onClose).not.toHaveBeenCalled();

        await user.click(container.firstElementChild as HTMLElement);
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// SystemStats
// ---------------------------------------------------------------------------
describe('SystemStats', () => {
    const gb = (n: number) => n * 1024 * 1024 * 1024;

    /** Replace fetch with a queue-backed stub returning /api/system/stats payloads. */
    function stubStats(...responses: Array<{ ok?: boolean; body?: unknown }>) {
        let i = 0;
        const fn = vi.fn(async () => {
            const r = responses[Math.min(i, responses.length - 1)];
            i += 1;
            return {
                ok: r.ok !== false,
                status: r.ok === false ? 500 : 200,
                json: async () => r.body ?? {},
            } as Response;
        });
        global.fetch = fn as unknown as typeof fetch;
        return fn;
    }

    it('renders nothing while the socket is disconnected', () => {
        const fetchSpy = stubStats({ body: { cpu: 10, memory: { used: gb(1), total: gb(16), percent: 6 } } });
        useTaskStore.setState({ isConnected: false });
        const { container } = render(<SystemStats />);
        expect(container).toBeEmptyDOMElement();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('fetches and renders CPU percentage and memory in GB once connected', async () => {
        vi.useFakeTimers();
        stubStats({ body: { cpu: 42, memory: { used: gb(8), total: gb(16), percent: 50 } } });
        useTaskStore.setState({ isConnected: true });

        render(<SystemStats />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });

        expect(screen.getByText('42%')).toBeInTheDocument();
        expect(screen.getByText('8.0G')).toBeInTheDocument();
        expect(screen.getByText('CPU')).toBeInTheDocument();
        expect(screen.getByText('MEM')).toBeInTheDocument();
    });

    it('polls every 2 seconds and re-renders fresh numbers', async () => {
        vi.useFakeTimers();
        const fetchSpy = stubStats(
            { body: { cpu: 10, memory: { used: gb(2), total: gb(16), percent: 12 } } },
            { body: { cpu: 90, memory: { used: gb(15), total: gb(16), percent: 94 } } },
        );
        useTaskStore.setState({ isConnected: true });

        render(<SystemStats />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(screen.getByText('10%')).toBeInTheDocument();
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(screen.getByText('90%')).toBeInTheDocument();
        expect(screen.getByText('15.0G')).toBeInTheDocument();
    });

    it('stops polling after unmount', async () => {
        vi.useFakeTimers();
        const fetchSpy = stubStats({ body: { cpu: 1, memory: { used: gb(1), total: gb(16), percent: 6 } } });
        useTaskStore.setState({ isConnected: true });

        const { unmount } = render(<SystemStats />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        const callsAtUnmount = fetchSpy.mock.calls.length;

        unmount();
        await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
        expect(fetchSpy).toHaveBeenCalledTimes(callsAtUnmount);
    });

    it('renders nothing when the stats endpoint errors', async () => {
        vi.useFakeTimers();
        stubStats({ ok: false });
        useTaskStore.setState({ isConnected: true });

        const { container } = render(<SystemStats />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing when the fetch itself throws', async () => {
        vi.useFakeTimers();
        global.fetch = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
        useTaskStore.setState({ isConnected: true });

        const { container } = render(<SystemStats />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(container).toBeEmptyDOMElement();
    });
});

// ---------------------------------------------------------------------------
// TaskTokenStats — derived display logic
// ---------------------------------------------------------------------------
describe('TaskTokenStats', () => {
    describe('formatTokenCount', () => {
        it.each([
            [0, '0'],
            [1, '1'],
            [999, '999'],
            [1000, '1k'],
            [1234, '1.2k'],
            [45_100, '45.1k'],
            [99_949, '99.9k'],
            [100_000, '100k'],
            [999_999, '1000k'],
            [1_000_000, '1M'],
            [1_234_567, '1.2M'],
            [100_000_000, '100M'],
        ])('formats %i as %s', (input, expected) => {
            expect(formatTokenCount(input)).toBe(expected);
        });
    });

    describe('formatModelName', () => {
        it.each([
            ['', 'Unknown'],
            ['subagent', 'Subagent'],
            ['claude-sonnet-4-6', 'Sonnet 4.6'],
            ['claude-opus-4-8', 'Opus 4.8'],
            ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
            ['claude-3-5-sonnet', 'Sonnet 3.5'],
            ['gpt-4o', 'gpt-4o'],
        ])('formats %s as %s', (input, expected) => {
            expect(formatModelName(input)).toBe(expected);
        });
    });

    describe('formatCost', () => {
        it.each([
            [0, '$0.00'],
            [0.0001, '$0.0001'],
            [0.009, '$0.0090'],
            [0.01, '$0.01'],
            [12.3456, '$12.35'],
        ])('formats %s as %s', (input, expected) => {
            expect(formatCost(input)).toBe(expected);
        });
    });

    const putTask = (tokenUsage: unknown) => {
        useTaskStore.setState({
            tasks: new Map([['t1', { id: 't1', tokenUsage } as unknown as Task]]),
        });
    };

    it('renders nothing for a task with no token usage', () => {
        putTask(undefined);
        const { container } = render(<TaskTokenStats taskId="t1" />);
        expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing for an unknown task id', () => {
        const { container } = render(<TaskTokenStats taskId="nope" />);
        expect(container).toBeEmptyDOMElement();
    });

    it('shows input/output and hides zero cache counters', () => {
        putTask({
            inputTokens: 1234,
            outputTokens: 500,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalCostUsd: 0,
            modelBreakdown: {},
        });
        render(<TaskTokenStats taskId="t1" />);

        expect(screen.getByText('1.2k in')).toBeInTheDocument();
        expect(screen.getByText('500 out')).toBeInTheDocument();
        expect(screen.queryByText(/cache write/)).not.toBeInTheDocument();
        expect(screen.queryByText(/cache read/)).not.toBeInTheDocument();
    });

    it('shows cache counters when non-zero', () => {
        putTask({
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 2_000_000,
            cacheReadTokens: 45_100,
            totalCostUsd: 0,
            modelBreakdown: {},
        });
        render(<TaskTokenStats taskId="t1" />);

        expect(screen.getByText('0 in')).toBeInTheDocument();
        expect(screen.getByText('2M cache write')).toBeInTheDocument();
        expect(screen.getByText('45.1k cache read')).toBeInTheDocument();
    });

    it('hides cost unless the cost toggle is on and the cost is above zero', () => {
        putTask({
            inputTokens: 10,
            outputTokens: 10,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalCostUsd: 1.5,
            modelBreakdown: {},
        });

        const { rerender } = render(<TaskTokenStats taskId="t1" />);
        expect(screen.queryByText(/Cost:/)).not.toBeInTheDocument();

        act(() => { useTaskStore.setState({ tokenCostEnabled: true }); });
        rerender(<TaskTokenStats taskId="t1" />);
        expect(screen.getByText('Cost: $1.50')).toBeInTheDocument();
    });

    it('hides cost when enabled but the cost is exactly zero', () => {
        useTaskStore.setState({ tokenCostEnabled: true });
        putTask({
            inputTokens: 10,
            outputTokens: 10,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalCostUsd: 0,
            modelBreakdown: {},
        });
        render(<TaskTokenStats taskId="t1" />);
        expect(screen.queryByText(/Cost:/)).not.toBeInTheDocument();
    });

    it('labels the model with the largest input+output total as primary', () => {
        putTask({
            inputTokens: 100,
            outputTokens: 100,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalCostUsd: 0,
            modelBreakdown: {
                'claude-haiku-4-5-20251001': { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0 },
                'claude-opus-4-8': { inputTokens: 900, outputTokens: 900, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0 },
                'claude-sonnet-4-6': { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0 },
            },
        });
        render(<TaskTokenStats taskId="t1" />);

        expect(screen.getByText('Opus 4.8')).toBeInTheDocument();
        expect(screen.queryByText('Sonnet 4.6')).not.toBeInTheDocument();
    });

    it('omits the model label when the breakdown is missing', () => {
        putTask({
            inputTokens: 5,
            outputTokens: 5,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalCostUsd: 0,
            modelBreakdown: undefined,
        });
        render(<TaskTokenStats taskId="t1" />);
        expect(screen.getByText('5 in')).toBeInTheDocument();
        expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
    });
});

// ---------------------------------------------------------------------------
// TaskSummaryPanel
// ---------------------------------------------------------------------------
describe('TaskSummaryPanel', () => {
    const summary = (over: Partial<TaskSummary> = {}): TaskSummary => ({
        taskId: 't1',
        status: 'needs_input',
        summary: 'Claude is waiting for a decision.',
        lastAction: 'Ran the test suite',
        suggestedActions: [
            { id: 'a1', label: 'Approve', description: 'Let it proceed', type: 'approve', value: 'yes' },
            { id: 'a2', label: 'Reject', description: 'Stop it', type: 'reject', value: 'no' },
        ],
        timestamp: new Date('2026-08-08T00:00:00Z'),
        ...over,
    });

    const putSummary = (s: TaskSummary) => {
        useTaskStore.setState({ taskSummaries: new Map([[s.taskId, s]]) });
    };

    it('renders nothing when there is no summary for the task', () => {
        const { container } = render(<TaskSummaryPanel taskId="t1" />);
        expect(container).toBeEmptyDOMElement();
    });

    it('renders the summary, last action and suggested actions', () => {
        putSummary(summary());
        render(<TaskSummaryPanel taskId="t1" />);

        expect(screen.getByText('Task Update')).toBeInTheDocument();
        expect(screen.getByText('Claude is waiting for a decision.')).toBeInTheDocument();
        expect(screen.getByText('Ran the test suite')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    });

    it('omits the last-action line when absent', () => {
        putSummary(summary({ lastAction: undefined }));
        render(<TaskSummaryPanel taskId="t1" />);
        expect(screen.queryByText(/Last action:/)).not.toBeInTheDocument();
    });

    it('omits the actions row when there are no suggested actions', () => {
        putSummary(summary({ suggestedActions: [] }));
        render(<TaskSummaryPanel taskId="t1" />);
        expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
        // Refresh + dismiss remain.
        expect(screen.getAllByRole('button')).toHaveLength(2);
    });

    it.each(['completed', 'error', 'waiting_permission', 'needs_input', 'asking_question'] as const)(
        'renders the %s status without crashing',
        (status) => {
            putSummary(summary({ status }));
            render(<TaskSummaryPanel taskId="t1" />);
            expect(screen.getByText('Task Update')).toBeInTheDocument();
        }
    );

    it('running a suggested action dispatches it and clears the summary', async () => {
        const user = userEvent.setup();
        const action = summary().suggestedActions[0];
        putSummary(summary());
        render(<TaskSummaryPanel taskId="t1" />);

        await user.click(screen.getByRole('button', { name: 'Approve' }));

        expect(executeSupervisorAction).toHaveBeenCalledWith('t1', action);
        expect(useTaskStore.getState().taskSummaries.has('t1')).toBe(false);
    });

    it('an empty-valued custom action only clears the summary', async () => {
        const user = userEvent.setup();
        putSummary(
            summary({
                suggestedActions: [
                    { id: 'c1', label: 'Type my own', description: 'free text', type: 'custom', value: '' },
                ],
            })
        );
        render(<TaskSummaryPanel taskId="t1" />);

        await user.click(screen.getByRole('button', { name: 'Type my own' }));

        expect(executeSupervisorAction).not.toHaveBeenCalled();
        expect(useTaskStore.getState().taskSummaries.has('t1')).toBe(false);
    });

    it('a custom action with a value is still dispatched', async () => {
        const user = userEvent.setup();
        putSummary(
            summary({
                suggestedActions: [
                    { id: 'c2', label: 'Retry', description: 'try again', type: 'custom', value: 'retry' },
                ],
            })
        );
        render(<TaskSummaryPanel taskId="t1" />);

        await user.click(screen.getByRole('button', { name: 'Retry' }));
        expect(executeSupervisorAction).toHaveBeenCalledTimes(1);
    });

    it('refresh requests a new analysis without clearing the summary', async () => {
        const user = userEvent.setup();
        putSummary(summary());
        render(<TaskSummaryPanel taskId="t1" />);

        await user.click(screen.getByTitle('Refresh analysis'));

        expect(requestTaskAnalysis).toHaveBeenCalledWith('t1');
        expect(useTaskStore.getState().taskSummaries.has('t1')).toBe(true);
    });

    it('dismiss clears the summary without dispatching anything', async () => {
        const user = userEvent.setup();
        putSummary(summary());
        render(<TaskSummaryPanel taskId="t1" />);

        await user.click(screen.getByTitle('Dismiss'));

        expect(executeSupervisorAction).not.toHaveBeenCalled();
        expect(useTaskStore.getState().taskSummaries.has('t1')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// types/theme
// ---------------------------------------------------------------------------
describe('theme definitions', () => {
    const XTERM_KEYS = [
        'background', 'foreground', 'cursor', 'selectionBackground',
        'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
        'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
        'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
    ];

    it.each([
        ['DARK_TERMINAL_THEME', DARK_TERMINAL_THEME],
        ['LIGHT_TERMINAL_THEME', LIGHT_TERMINAL_THEME],
    ])('%s defines every xterm colour slot', (_name, theme) => {
        expect(Object.keys(theme).sort()).toEqual([...XTERM_KEYS].sort());
    });

    it.each([
        ['DARK_TERMINAL_THEME', DARK_TERMINAL_THEME],
        ['LIGHT_TERMINAL_THEME', LIGHT_TERMINAL_THEME],
    ])('%s uses only 6-digit hex colours', (_name, theme) => {
        for (const [key, value] of Object.entries(theme)) {
            expect(value, `${key} should be a hex colour`).toMatch(/^#[0-9a-f]{6}$/);
        }
    });

    it('dark and light themes invert background against foreground', () => {
        expect(DARK_TERMINAL_THEME.background).toBe('#0a0a0a');
        expect(LIGHT_TERMINAL_THEME.background).toBe('#ffffff');
        expect(DARK_TERMINAL_THEME.background).not.toBe(LIGHT_TERMINAL_THEME.background);
        expect(DARK_TERMINAL_THEME.foreground).not.toBe(LIGHT_TERMINAL_THEME.foreground);
    });

    it('keeps the cursor colour matched to the foreground in both themes', () => {
        expect(DARK_TERMINAL_THEME.cursor).toBe(DARK_TERMINAL_THEME.foreground);
        expect(LIGHT_TERMINAL_THEME.cursor).toBe(LIGHT_TERMINAL_THEME.foreground);
    });
});
