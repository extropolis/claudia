/**
 * Behaviour tests for App.tsx — the shell that wires every panel together.
 *
 * App owns very little rendering of its own; what it owns is *routing and
 * wiring*: which panel is visible, which banner is up, which websocket action
 * a header button dispatches, and when the terminal is force-remounted. So
 * every heavy child is replaced at the module boundary with a tiny stub that
 * exposes the props App passes it. What is left executing is App's own logic,
 * which is exactly what these tests assert.
 *
 * Conventions:
 *  - Queries go through role / label / text. Never CSS classes.
 *    (Icon-only buttons get their accessible name from `title`.)
 *  - Anything time-based uses fake timers; nothing sleeps.
 *  - The Zustand store and localStorage are reset before every test.
 *  - RTL's auto-cleanup runs AFTER our afterEach, so we call cleanup()
 *    ourselves first — otherwise a late unmount fires callbacks on the
 *    next test's timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Task, Workspace } from '@claudia/shared';

import { useTaskStore } from '../stores/taskStore';

// ---------------------------------------------------------------------------
// Mock boundary. vi.mock factories are hoisted above the imports, so anything
// they close over has to come from vi.hoisted().
// ---------------------------------------------------------------------------

const H = vi.hoisted(() => {
    const ACTION_NAMES = [
        'createTask', 'selectTaskOnServer', 'sendTaskInput', 'resizeTask', 'destroyTask',
        'interruptTask', 'restoreTask', 'reconnectTask', 'archiveTask', 'revertTask',
        'createWorkspace', 'deleteWorkspace', 'reorderWorkspaces', 'setWorkspaceOrder',
        'reorderTasks', 'openFolder', 'openTerminal', 'setSystemPrompt',
        'requestRecentWorkspaces', 'clearRecentWorkspace', 'executeSupervisorAction',
        'requestTaskAnalysis', 'sendChatMessage', 'requestChatHistory', 'clearChatHistory',
        'requestArchivedTasks', 'restoreArchivedTask', 'deleteArchivedTask',
        'continueArchivedTask', 'pushToGithub', 'resetWorkspace', 'renameTask',
        'renameWorkspace', 'toggleReference', 'addCustomReference', 'removeReference',
        'createScheduledTask', 'deleteScheduledTask', 'updateScheduledTask',
        'pauseScheduledTask', 'rejectDeleteRequest',
    ] as const;

    const actions: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const name of ACTION_NAMES) actions[name] = vi.fn();

    return {
        actions,
        wsRef: { current: null } as { current: WebSocket | null },
        /** Every TerminalView mount, in order. A repeat id === a forced remount. */
        terminalMounts: [] as string[],
        /** Props last handed to the stubbed children, for wiring assertions. */
        lastProps: {} as Record<string, Record<string, unknown>>,
    };
});

vi.mock('../hooks/useWebSocket', () => ({
    useWebSocket: () => ({ ...H.actions, wsRef: H.wsRef }),
    sendWsMessage: vi.fn(),
}));

vi.mock('../components/TerminalView', async () => {
    const { useEffect } = await import('react');
    return {
        TerminalView: ({ task, isMobile }: { task: Task; isMobile?: boolean }) => {
            useEffect(() => {
                H.terminalMounts.push(task.id);
            }, []);
            return (
                <div data-testid="terminal-view">
                    Terminal for {task.id}
                    {isMobile ? ' (mobile)' : ''}
                </div>
            );
        },
    };
});

vi.mock('../components/ShellTerminalView', () => ({
    ShellTerminalView: ({ workspaceId, workspaceName, onClose }: {
        workspaceId: string; workspaceName: string; onClose: () => void;
    }) => (
        <div data-testid="shell-terminal">
            <span>Shell: {workspaceName} ({workspaceId})</span>
            <button onClick={onClose}>close-shell</button>
        </div>
    ),
}));

vi.mock('../components/WorkspacePanel', () => ({
    WorkspacePanel: (props: Record<string, (...a: never[]) => void>) => {
        H.lastProps.WorkspacePanel = props;
        return (
            <div data-testid="workspace-panel">
                <button onClick={() => props.onSelectTask('task-1' as never)}>stub-select-task</button>
                <button onClick={() => props.onOpenShell('/ws/alpha' as never)}>stub-open-shell</button>
                <button onClick={() => props.onCreateWorkspace('/ws/new' as never)}>stub-create-workspace</button>
                {props.onCollapse && <button onClick={props.onCollapse}>stub-collapse</button>}
            </div>
        );
    },
}));

vi.mock('../components/FileExplorer', () => ({
    FileExplorer: ({ workspacePath, workspaceName }: { workspacePath?: string; workspaceName?: string }) => (
        <div data-testid="file-explorer">{workspaceName ?? 'no-workspace'}|{workspacePath ?? 'no-path'}</div>
    ),
}));

vi.mock('../components/SettingsMenu', () => ({
    SettingsMenu: ({ isOpen, onClose, initialPanel }: {
        isOpen: boolean; onClose: () => void; initialPanel?: string;
    }) => isOpen ? (
        <div data-testid="settings-menu">
            <span>panel:{initialPanel ?? 'none'}</span>
            <button onClick={onClose}>close-settings</button>
        </div>
    ) : null,
}));

vi.mock('../components/UsageDashboard', () => ({
    UsageDashboard: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) => isOpen ? (
        <div data-testid="usage-dashboard">
            <button onClick={onClose}>close-usage</button>
        </div>
    ) : null,
}));

vi.mock('../components/MobileAccessModal', () => ({
    MobileAccessModal: (props: {
        isOpen: boolean; onClose: () => void; error?: string | null;
        tunnelActive?: boolean; tunnelLoading?: boolean;
        onStopTunnel?: () => void; onStartTunnel?: () => void;
    }) => {
        H.lastProps.MobileAccessModal = props as unknown as Record<string, unknown>;
        return props.isOpen ? (
            <div data-testid="mobile-access-modal">
                <span>active:{String(props.tunnelActive)}</span>
                <span>loading:{String(props.tunnelLoading)}</span>
                {props.error && <span>error:{props.error}</span>}
                <button onClick={props.onStartTunnel}>stub-start-tunnel</button>
                <button onClick={props.onStopTunnel}>stub-stop-tunnel</button>
                <button onClick={props.onClose}>close-mobile</button>
            </div>
        ) : null;
    },
}));

vi.mock('../components/ActivityPanel', () => ({
    ActivityPanel: ({ onClose, onSelectTask }: {
        onClose: () => void; onSelectTask: (id: string) => void;
    }) => (
        <div data-testid="activity-panel">
            <button onClick={() => onSelectTask('task-1')}>stub-activity-select</button>
            <button onClick={onClose}>close-activity</button>
        </div>
    ),
}));

vi.mock('../components/SupervisorChat', () => ({
    SupervisorChat: ({ messages }: { messages: unknown[] }) => (
        <div data-testid="supervisor-chat">messages:{messages.length}</div>
    ),
}));

vi.mock('../components/ProjectPicker', () => ({
    ProjectPicker: (props: Record<string, unknown>) => {
        H.lastProps.ProjectPicker = props;
        return <div data-testid="project-picker" />;
    },
}));

vi.mock('../components/SystemStats', () => ({
    SystemStats: () => <div data-testid="system-stats" />,
}));
vi.mock('../components/GlobalVoiceToggle', () => ({
    GlobalVoiceToggle: () => <div data-testid="global-voice-toggle" />,
}));
vi.mock('../components/GlobalVoiceManager', () => ({ GlobalVoiceManager: () => null }));
vi.mock('../components/ThinkingSoundManager', () => ({ ThinkingSoundManager: () => null }));
vi.mock('../components/TaskCompletionVoiceManager', () => ({ TaskCompletionVoiceManager: () => null }));
vi.mock('../components/TaskProgressVoiceManager', () => ({ TaskProgressVoiceManager: () => null }));

import App from '../App';
import { NotificationProvider } from '../components/NotificationContainer';

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

// App calls useNotification(), which throws outside a NotificationProvider.
// main.tsx mounts <App /> inside the provider, so every render here has to do
// the same. The provider is real (not stubbed) — it is a thin context holder
// and renders nothing unless a notification is actually pushed.
function renderApp() {
    return render(<App />, { wrapper: NotificationProvider });
}

function makeTask(over: Partial<Task> = {}): Task {
    return {
        id: 'task-1',
        prompt: 'do the thing',
        state: 'idle',
        workspaceId: '/ws/alpha',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        lastActivity: new Date('2026-01-01T00:00:00Z'),
        ...over,
    };
}

function makeWorkspace(over: Partial<Workspace> = {}): Workspace {
    return {
        id: '/ws/alpha',
        name: 'alpha',
        createdAt: '2026-01-01T00:00:00Z',
        ...over,
    };
}

/** Only the slice of store state App actually reads. */
function resetStore(over: Record<string, unknown> = {}) {
    useTaskStore.setState({
        tasks: new Map(),
        workspaces: [],
        selectedTaskId: null,
        showProjectPicker: false,
        chatMessages: [],
        chatTyping: false,
        isConnected: true,
        isServerReloading: false,
        isOffline: false,
        supervisorEnabled: false,
        aiCoreConfigured: true,
        showSystemStats: false,
        errorNotification: null,
        unreadTaskIds: new Set<string>(),
        themePreference: 'dark',
        ...over,
    } as never);
}

/** fetch stub that answers by URL; anything unmatched resolves to `{}`. */
function stubFetch(routes: Record<string, unknown> = {}) {
    const fn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        const key = Object.keys(routes).find(k => url.includes(k));
        const body = key ? routes[key] : {};
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => body,
            text: async () => JSON.stringify(body),
        };
    });
    global.fetch = fn as unknown as typeof fetch;
    return fn;
}

const originalInnerWidth = window.innerWidth;

function setViewportWidth(width: number) {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
}

beforeEach(() => {
    localStorage.clear();
    resetStore();
    H.terminalMounts.length = 0;
    H.lastProps = {};
    for (const fn of Object.values(H.actions)) fn.mockClear();
    vi.stubGlobal('__APP_VERSION__', '9.9.9-test');
    vi.stubGlobal('open', vi.fn());
    vi.stubGlobal('alert', vi.fn());
    setViewportWidth(1280);
    stubFetch();
});

afterEach(() => {
    // Must unmount BEFORE globals are restored — see file header.
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    setViewportWidth(originalInnerWidth);
});

// ===========================================================================

describe('App — layout routing', () => {
    it('shows the empty state when no task is selected', () => {
        renderApp();

        expect(screen.getByRole('heading', { name: 'Select a task to view its terminal' })).toBeInTheDocument();
        expect(screen.queryByTestId('terminal-view')).not.toBeInTheDocument();
        expect(screen.getByTestId('workspace-panel')).toBeInTheDocument();
    });

    it('renders the terminal for the selected task instead of the empty state', () => {
        resetStore({
            tasks: new Map([['task-1', makeTask()]]),
            workspaces: [makeWorkspace()],
            selectedTaskId: 'task-1',
        });

        renderApp();

        expect(screen.getByTestId('terminal-view')).toHaveTextContent('Terminal for task-1');
        expect(screen.queryByRole('heading', { name: 'Select a task to view its terminal' })).not.toBeInTheDocument();
    });

    it('hands the selected task\'s workspace to the file explorer', () => {
        resetStore({
            tasks: new Map([['task-1', makeTask()]]),
            workspaces: [makeWorkspace({ displayName: 'Alpha Project' })],
            selectedTaskId: 'task-1',
        });

        renderApp();

        expect(screen.getByTestId('file-explorer')).toHaveTextContent('Alpha Project|/ws/alpha');
    });

    it('renders the app version from the build-time constant', () => {
        renderApp();
        expect(screen.getByText('v9.9.9-test')).toBeInTheDocument();
    });

    it('collapses and re-expands the sidebar, persisting the choice', async () => {
        const user = userEvent.setup();
        renderApp();

        await user.click(screen.getByRole('button', { name: 'stub-collapse' }));

        expect(screen.queryByTestId('workspace-panel')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Workspaces' })).toBeInTheDocument();
        expect(localStorage.getItem('claudia-sidebar-collapsed')).toBe('true');

        await user.click(screen.getByRole('button', { name: 'Workspaces' }));

        expect(screen.getByTestId('workspace-panel')).toBeInTheDocument();
        expect(localStorage.getItem('claudia-sidebar-collapsed')).toBe('false');
    });

    it('starts collapsed when localStorage says so', () => {
        localStorage.setItem('claudia-sidebar-collapsed', 'true');
        renderApp();
        expect(screen.queryByTestId('workspace-panel')).not.toBeInTheDocument();
    });

    it('restores a persisted sidebar width and keeps writing it back', () => {
        localStorage.setItem('claudia-sidebar-width', '512');
        renderApp();
        expect(localStorage.getItem('claudia-sidebar-width')).toBe('512');
    });
});

describe('App — mobile layout', () => {
    it('shows the workspace list first and swaps to a full-screen terminal on select', () => {
        setViewportWidth(500);
        resetStore({
            tasks: new Map([['task-1', makeTask()]]),
            workspaces: [makeWorkspace()],
        });
        vi.useFakeTimers();

        renderApp();

        // Screen 1 — the list, no terminal, no file explorer.
        expect(screen.getByTestId('workspace-panel')).toBeInTheDocument();
        expect(screen.queryByTestId('file-explorer')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'stub-select-task' }));
        act(() => { vi.advanceTimersByTime(700); });

        // Screen 2 — full-screen terminal plus a back button.
        expect(screen.getByTestId('terminal-view')).toHaveTextContent('(mobile)');
        const back = screen.getByRole('button', { name: 'Back to tasks' });

        fireEvent.click(back);
        expect(screen.getByTestId('workspace-panel')).toBeInTheDocument();
        expect(screen.queryByTestId('terminal-view')).not.toBeInTheDocument();
    });

    it('hides the desktop-only header buttons on mobile', () => {
        setViewportWidth(500);
        renderApp();

        expect(screen.queryByRole('button', { name: 'Voice Agent' })).not.toBeInTheDocument();
        expect(screen.queryByTitle(/Mobile Tunnel/)).not.toBeInTheDocument();
        // Settings is still reachable.
        expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    });
});

describe('App — task selection wiring', () => {
    it('selects the task in the store and dispatches the scroll/focus events', () => {
        resetStore({
            tasks: new Map([['task-1', makeTask()]]),
            workspaces: [makeWorkspace()],
        });
        vi.useFakeTimers();

        const scrollEvents: string[] = [];
        const focusEvents: string[] = [];
        const onScroll = (e: Event) => scrollEvents.push((e as CustomEvent).detail.taskId);
        const onFocus = (e: Event) => focusEvents.push((e as CustomEvent).detail.taskId);
        window.addEventListener('terminal:scrollToBottom', onScroll);
        window.addEventListener('taskInput:focus', onFocus);

        try {
            renderApp();
            fireEvent.click(screen.getByRole('button', { name: 'stub-select-task' }));

            expect(useTaskStore.getState().selectedTaskId).toBe('task-1');

            act(() => { vi.advanceTimersByTime(700); });

            // Three fallback scrolls (100/300/600ms) and one rAF focus.
            expect(scrollEvents).toEqual(['task-1', 'task-1', 'task-1']);
            expect(focusEvents).toEqual(['task-1']);
        } finally {
            window.removeEventListener('terminal:scrollToBottom', onScroll);
            window.removeEventListener('taskInput:focus', onFocus);
        }
    });
});

describe('App — embedded shell', () => {
    it('opens the shell, offers a switch-back banner, and closes it', async () => {
        resetStore({
            tasks: new Map([['task-1', makeTask()]]),
            workspaces: [makeWorkspace({ displayName: 'Alpha Project' })],
            selectedTaskId: 'task-1',
        });
        const user = userEvent.setup();
        renderApp();

        await user.click(screen.getByRole('button', { name: 'stub-open-shell' }));

        expect(screen.getByTestId('shell-terminal')).toHaveTextContent('Shell: Alpha Project (/ws/alpha)');
        // Task terminal is swapped out while the shell is showing.
        expect(screen.queryByTestId('terminal-view')).not.toBeInTheDocument();

        // Clicking the same workspace's shell again hides it but keeps the PTY.
        await user.click(screen.getByRole('button', { name: 'stub-open-shell' }));
        expect(screen.getByTestId('terminal-view')).toBeInTheDocument();
        const banner = screen.getByRole('button', { name: /Shell running — Alpha Project/ });

        await user.click(banner);
        expect(screen.queryByTestId('terminal-view')).not.toBeInTheDocument();

        // Explicit close kills the PTY: the banner is gone for good.
        await user.click(screen.getByRole('button', { name: 'close-shell' }));
        expect(screen.queryByTestId('shell-terminal')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Shell running/ })).not.toBeInTheDocument();
    });
});

describe('App — connection banners', () => {
    it('shows the offline overlay and suppresses the reconnect banner', () => {
        resetStore({ isOffline: true, isConnected: false, isServerReloading: true });
        renderApp();

        expect(screen.getByText('No internet connection')).toBeInTheDocument();
        expect(screen.queryByText('Backend is restarting...')).not.toBeInTheDocument();
        expect(screen.queryByText('Reconnecting to backend...')).not.toBeInTheDocument();
    });

    it('shows "Backend is restarting..." while the server reloads', () => {
        resetStore({ isServerReloading: true });
        renderApp();
        expect(screen.getByText('Backend is restarting...')).toBeInTheDocument();
    });

    it('shows "Reconnecting to backend..." when merely disconnected', () => {
        resetStore({ isConnected: false });
        renderApp();
        expect(screen.getByText('Reconnecting to backend...')).toBeInTheDocument();
    });

    it('shows no banner at all when connected and online', () => {
        renderApp();
        expect(screen.queryByText('Backend is restarting...')).not.toBeInTheDocument();
        expect(screen.queryByText('Reconnecting to backend...')).not.toBeInTheDocument();
        expect(screen.queryByText('No internet connection')).not.toBeInTheDocument();
    });
});

describe('App — terminal remounting', () => {
    it('remounts the terminal when a server reload finishes', () => {
        resetStore({
            tasks: new Map([['task-1', makeTask()]]),
            workspaces: [makeWorkspace()],
            selectedTaskId: 'task-1',
            isServerReloading: true,
        });
        renderApp();
        expect(H.terminalMounts).toEqual(['task-1']);

        act(() => { useTaskStore.setState({ isServerReloading: false }); });

        expect(H.terminalMounts).toEqual(['task-1', 'task-1']);
    });

    it('remounts the terminal on a websocket RE-connect but not the first connect', () => {
        resetStore({
            tasks: new Map([['task-1', makeTask()]]),
            workspaces: [makeWorkspace()],
            selectedTaskId: 'task-1',
            isConnected: false,
        });
        renderApp();
        expect(H.terminalMounts).toEqual(['task-1']);

        // First ever connect — no remount.
        act(() => { useTaskStore.setState({ isConnected: true }); });
        expect(H.terminalMounts).toEqual(['task-1']);

        // Drop and reconnect — this one remounts.
        act(() => { useTaskStore.setState({ isConnected: false }); });
        act(() => { useTaskStore.setState({ isConnected: true }); });
        expect(H.terminalMounts).toEqual(['task-1', 'task-1']);
    });
});

describe('App — error notification banner', () => {
    it('renders the message and clears it on dismiss', async () => {
        const user = userEvent.setup();
        renderApp();

        act(() => {
            useTaskStore.setState({
                errorNotification: { message: 'spawn failed: ENOENT', timestamp: new Date() },
            });
        });

        expect(screen.getByText('spawn failed: ENOENT')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Dismiss' }));

        expect(useTaskStore.getState().errorNotification).toBeNull();
        expect(screen.queryByText('spawn failed: ENOENT')).not.toBeInTheDocument();
    });

    it('auto-dismisses after 15 seconds', () => {
        vi.useFakeTimers();
        renderApp();

        act(() => {
            useTaskStore.setState({
                errorNotification: { message: 'transient blip', timestamp: new Date() },
            });
        });
        expect(screen.getByText('transient blip')).toBeInTheDocument();

        act(() => { vi.advanceTimersByTime(14_999); });
        expect(screen.getByText('transient blip')).toBeInTheDocument();

        act(() => { vi.advanceTimersByTime(2); });
        expect(screen.queryByText('transient blip')).not.toBeInTheDocument();
    });
});

describe('App — modal wiring', () => {
    it('opens settings with no preset panel and closes it', async () => {
        const user = userEvent.setup();
        renderApp();

        expect(screen.queryByTestId('settings-menu')).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Settings' }));

        expect(screen.getByTestId('settings-menu')).toHaveTextContent('panel:none');
        await user.click(screen.getByRole('button', { name: 'close-settings' }));
        expect(screen.queryByTestId('settings-menu')).not.toBeInTheDocument();
    });

    it('force-opens settings on the AI Core panel when credentials are missing', async () => {
        resetStore({ aiCoreConfigured: false });
        renderApp();

        await waitFor(() => expect(screen.getByTestId('settings-menu')).toHaveTextContent('panel:aicore'));
    });

    it('does NOT force-open settings when tasks already exist', () => {
        resetStore({
            aiCoreConfigured: false,
            tasks: new Map([['task-1', makeTask()]]),
            workspaces: [makeWorkspace()],
        });
        renderApp();

        expect(screen.queryByTestId('settings-menu')).not.toBeInTheDocument();
    });

    it('opens and closes the usage dashboard', async () => {
        const user = userEvent.setup();
        renderApp();

        await user.click(screen.getByRole('button', { name: 'Token Usage' }));
        expect(screen.getByTestId('usage-dashboard')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'close-usage' }));
        expect(screen.queryByTestId('usage-dashboard')).not.toBeInTheDocument();
    });

    it('toggles the activity panel and selects a task from it', async () => {
        resetStore({
            tasks: new Map([['task-1', makeTask()]]),
            workspaces: [makeWorkspace()],
        });
        vi.useFakeTimers();
        renderApp();

        fireEvent.click(screen.getByTitle(/IDLE TASKS/));
        expect(screen.getByTestId('activity-panel')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'stub-activity-select' }));
        expect(useTaskStore.getState().selectedTaskId).toBe('task-1');

        act(() => { vi.advanceTimersByTime(700); });
    });
});

describe('App — chat panel', () => {
    it('is not offered at all when the supervisor is disabled', () => {
        renderApp();
        expect(screen.queryByTitle(/Chat/)).not.toBeInTheDocument();
    });

    it('opens the supervisor chat and closes it again', async () => {
        resetStore({
            supervisorEnabled: true,
            chatMessages: [
                { id: 'm1', role: 'user', content: 'hi', timestamp: new Date().toISOString() },
            ],
        });
        const user = userEvent.setup();
        renderApp();

        await user.click(screen.getByTitle('Open Chat'));
        expect(screen.getByTestId('supervisor-chat')).toHaveTextContent('messages:1');

        await user.click(screen.getByTitle('Close chat'));
        expect(screen.queryByTestId('supervisor-chat')).not.toBeInTheDocument();
    });

    it('force-closes an open chat panel when the supervisor gets disabled', async () => {
        resetStore({ supervisorEnabled: true });
        const user = userEvent.setup();
        renderApp();

        await user.click(screen.getByTitle('Open Chat'));
        expect(screen.getByTestId('supervisor-chat')).toBeInTheDocument();

        act(() => { useTaskStore.setState({ supervisorEnabled: false }); });
        expect(screen.queryByTestId('supervisor-chat')).not.toBeInTheDocument();
    });
});

describe('App — task counters', () => {
    it('counts busy vs idle tasks and ignores archived/disconnected ones', () => {
        resetStore({
            tasks: new Map<string, Task>([
                ['a', makeTask({ id: 'a', state: 'busy' })],
                ['b', makeTask({ id: 'b', state: 'busy' })],
                ['c', makeTask({ id: 'c', state: 'idle' })],
                ['d', makeTask({ id: 'd', state: 'archived' })],
                ['e', makeTask({ id: 'e', state: 'disconnected' })],
                ['f', makeTask({ id: 'f', state: 'interrupted' })],
            ]),
            workspaces: [makeWorkspace()],
            unreadTaskIds: new Set(['a', 'c']),
        });
        renderApp();

        const activityButton = screen.getByTitle(/BUSY TASKS/);
        // 2 busy / 1 idle, plus the unread badge for the two unread task ids.
        expect(activityButton).toHaveTextContent('2/12');
        expect(activityButton.getAttribute('title')).toContain('BUSY TASKS');
        expect(activityButton.getAttribute('title')).toContain('IDLE TASKS');
    });

    it('labels the activity button "No running tasks" when there are none', () => {
        renderApp();
        expect(screen.getByTitle('No running tasks')).toBeInTheDocument();
    });
});

describe('App — header actions', () => {
    it('POSTs a restart request', async () => {
        const fetchMock = stubFetch();
        const user = userEvent.setup();
        renderApp();

        await user.click(screen.getByRole('button', { name: 'Restart Server' }));

        await waitFor(() => {
            const call = fetchMock.mock.calls.find(c => String(c[0]).includes('/api/server/restart'));
            expect(call).toBeTruthy();
            expect((call![1] as RequestInit).method).toBe('POST');
        });
    });

    it('opens the voice agent with the tunnel token', async () => {
        stubFetch({ '/api/tunnel/status': { active: true, token: 'tok-123' } });
        const user = userEvent.setup();
        renderApp();

        await user.click(screen.getByRole('button', { name: 'Voice Agent' }));

        await waitFor(() => {
            expect(window.open).toHaveBeenCalledWith(expect.stringContaining('/voice?token=tok-123'), '_blank');
        });
    });

    it('falls back to a generated local token when the tunnel has none', async () => {
        stubFetch({ '/api/tunnel/status': { active: false } });
        const user = userEvent.setup();
        renderApp();

        await user.click(screen.getByRole('button', { name: 'Voice Agent' }));

        await waitFor(() => {
            expect(window.open).toHaveBeenCalledWith(expect.stringContaining('/voice?token=local-'), '_blank');
        });
    });

    it('toggles the notification mute state', async () => {
        const user = userEvent.setup();
        renderApp();

        await user.click(screen.getByRole('button', { name: 'Mute Notifications' }));
        expect(screen.getByRole('button', { name: 'Unmute Notifications' })).toBeInTheDocument();
        expect(localStorage.getItem('claudia-completion-sound')).toBe('false');

        await user.click(screen.getByRole('button', { name: 'Unmute Notifications' }));
        expect(screen.getByRole('button', { name: 'Mute Notifications' })).toBeInTheDocument();
    });

    it('registers a usage-tracking user id with the backend on mount', async () => {
        const fetchMock = stubFetch();
        renderApp();

        await waitFor(() => {
            const call = fetchMock.mock.calls.find(c => String(c[0]).includes('/api/user-id'));
            expect(call).toBeTruthy();
        });
        expect(localStorage.getItem('claudia_user_id')).toBeTruthy();
    });

    it('shows system stats only when the store enables them', () => {
        renderApp();
        expect(screen.queryByTestId('system-stats')).not.toBeInTheDocument();

        act(() => { useTaskStore.setState({ showSystemStats: true }); });
        expect(screen.getByTestId('system-stats')).toBeInTheDocument();
    });
});

describe('App — tunnel', () => {
    it('reflects the tunnel status fetched on mount', async () => {
        stubFetch({ '/api/tunnel/status': { active: true } });
        renderApp();

        await waitFor(() => {
            expect(screen.getByTitle('View Mobile Tunnel')).toBeInTheDocument();
        });
    });

    it('reacts to the claudia:tunnelStatus DOM event', async () => {
        renderApp();
        await waitFor(() => expect(screen.getByTitle('Start Mobile Tunnel')).toBeInTheDocument());

        act(() => {
            window.dispatchEvent(new CustomEvent('claudia:tunnelStatus', { detail: { active: true } }));
        });
        expect(screen.getByTitle('View Mobile Tunnel')).toBeInTheDocument();

        act(() => {
            window.dispatchEvent(new CustomEvent('claudia:tunnelStatus', {
                detail: { active: false, error: 'ngrok died' },
            }));
        });
        expect(screen.getByTitle('Start Mobile Tunnel')).toBeInTheDocument();
    });

    it('surfaces a tunnelStatus error through the mobile modal', async () => {
        const user = userEvent.setup();
        renderApp();

        act(() => {
            window.dispatchEvent(new CustomEvent('claudia:tunnelStatus', {
                detail: { active: false, error: 'ngrok died' },
            }));
        });
        await user.click(screen.getByTitle('Start Mobile Tunnel'));

        expect(screen.getByTestId('mobile-access-modal')).toHaveTextContent('error:ngrok died');
    });

    it('starts the tunnel from the modal and marks it active', async () => {
        stubFetch({ '/api/tunnel/start': { url: 'https://x.ngrok.app' } });
        const user = userEvent.setup();
        renderApp();

        await user.click(screen.getByTitle('Start Mobile Tunnel'));
        await user.click(screen.getByRole('button', { name: 'stub-start-tunnel' }));

        await waitFor(() => {
            expect(screen.getByTestId('mobile-access-modal')).toHaveTextContent('active:true');
        });
        expect(screen.getByTestId('mobile-access-modal')).toHaveTextContent('loading:false');
    });

    it('surfaces a start failure returned by the backend', async () => {
        stubFetch({ '/api/tunnel/start': { error: 'ngrok not installed' } });
        const user = userEvent.setup();
        renderApp();

        await user.click(screen.getByTitle('Start Mobile Tunnel'));
        await user.click(screen.getByRole('button', { name: 'stub-start-tunnel' }));

        await waitFor(() => {
            expect(screen.getByTestId('mobile-access-modal')).toHaveTextContent('error:ngrok not installed');
        });
        expect(screen.getByTestId('mobile-access-modal')).toHaveTextContent('active:false');
    });

    it('stops the tunnel and keeps the modal open', async () => {
        const fetchMock = stubFetch({ '/api/tunnel/status': { active: true } });
        const user = userEvent.setup();
        renderApp();

        await waitFor(() => expect(screen.getByTitle('View Mobile Tunnel')).toBeInTheDocument());
        await user.click(screen.getByTitle('View Mobile Tunnel'));
        await user.click(screen.getByRole('button', { name: 'stub-stop-tunnel' }));

        await waitFor(() => {
            expect(fetchMock.mock.calls.some(c => String(c[0]).includes('/api/tunnel/stop'))).toBe(true);
        });
        expect(screen.getByTestId('mobile-access-modal')).toHaveTextContent('active:false');
    });

    it('closes the mobile modal', async () => {
        const user = userEvent.setup();
        renderApp();

        await user.click(screen.getByTitle('Start Mobile Tunnel'));
        expect(screen.getByTestId('mobile-access-modal')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'close-mobile' }));
        expect(screen.queryByTestId('mobile-access-modal')).not.toBeInTheDocument();
    });
});

describe('App — project picker wiring', () => {
    it('creates the workspace and closes the picker when a path is chosen', () => {
        useTaskStore.setState({ showProjectPicker: true });
        renderApp();

        const onSelect = H.lastProps.ProjectPicker.onSelect as (p: string) => void;
        act(() => { onSelect('/ws/chosen'); });

        expect(H.actions.createWorkspace).toHaveBeenCalledWith('/ws/chosen');
        expect(useTaskStore.getState().showProjectPicker).toBe(false);
    });
});

describe('App — websocket action wiring', () => {
    it('passes the websocket actions down to the workspace panel', async () => {
        const user = userEvent.setup();
        renderApp();

        await user.click(screen.getByRole('button', { name: 'stub-create-workspace' }));
        expect(H.actions.createWorkspace).toHaveBeenCalledWith('/ws/new');

        // Delete and archive intentionally share one handler: archiving IS the delete.
        expect(H.lastProps.WorkspacePanel.onDeleteTask).toBe(H.actions.archiveTask);
        expect(H.lastProps.WorkspacePanel.onArchiveTask).toBe(H.actions.archiveTask);
        expect(H.lastProps.WorkspacePanel.onReorderTasksOnServer).toBe(H.actions.reorderTasks);
    });
});

describe('App — sidebar resizing', () => {
    it('tracks a drag on the resize handle and persists the new width', () => {
        const { container } = renderApp();

        const handle = container.querySelector('.resize-handle') as HTMLElement;
        expect(handle).toBeTruthy();

        // Each step needs its own act(): the document-level mousemove listener
        // is only attached by the effect that runs after mousedown commits.
        act(() => { fireEvent.mouseDown(handle); });
        act(() => { fireEvent.mouseMove(document, { clientX: 420 }); });
        act(() => { fireEvent.mouseUp(document); });

        expect(localStorage.getItem('claudia-sidebar-width')).toBe('420');

        // Out-of-range drags are ignored.
        act(() => { fireEvent.mouseDown(handle); });
        act(() => { fireEvent.mouseMove(document, { clientX: 10 }); });
        act(() => { fireEvent.mouseUp(document); });
        expect(localStorage.getItem('claudia-sidebar-width')).toBe('420');
    });
});
