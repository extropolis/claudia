import { useState, useRef, useEffect, useCallback } from 'react';
import { WorkspacePanel } from './components/WorkspacePanel';
import { TerminalView } from './components/TerminalView';
import { SupervisorChat } from './components/SupervisorChat';
import { ProjectPicker } from './components/ProjectPicker';
import { SettingsMenu } from './components/SettingsMenu';
import { GlobalVoiceManager } from './components/GlobalVoiceManager';
import { ThinkingSoundManager } from './components/ThinkingSoundManager';
import { TaskCompletionVoiceManager } from './components/TaskCompletionVoiceManager';
import { TaskProgressVoiceManager } from './components/TaskProgressVoiceManager';
import { GlobalVoiceToggle } from './components/GlobalVoiceToggle';
import { SystemStats } from './components/SystemStats';
import { MobileAccessModal } from './components/MobileAccessModal';
import { FileExplorer } from './components/FileExplorer';
import { ShellTerminalView } from './components/ShellTerminalView';
import { ActivityPanel } from './components/ActivityPanel';
import { useTheme } from './hooks/useTheme';
import { useWebSocket } from './hooks/useWebSocket';
import { useTaskStore } from './stores/taskStore';
import { Terminal, Settings, MessageCircle, X, RefreshCw, RotateCcw, WifiOff, Activity, AlertTriangle, Smartphone, ArrowLeft, Minimize2, Mic, Bell, BellOff, BarChart3, ChevronRight } from 'lucide-react';
import { UsageDashboard } from './components/UsageDashboard';
import { getApiBaseUrl } from './config/api-config';
import { isSoundEnabled, setSoundEnabled } from './utils/browserCapabilities';

// Hook: returns true when viewport is ≤768px wide
function useIsMobile(breakpoint = 768) {
    const [isMobile, setIsMobile] = useState(() => window.innerWidth <= breakpoint);
    useEffect(() => {
        const mql = window.matchMedia(`(max-width: ${breakpoint}px)`);
        const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
        mql.addEventListener('change', onChange);
        return () => mql.removeEventListener('change', onChange);
    }, [breakpoint]);
    return isMobile;
}

const SIDEBAR_WIDTH_KEY = 'claudia-sidebar-width';
const SIDEBAR_COLLAPSED_KEY = 'claudia-sidebar-collapsed';
const DEFAULT_SIDEBAR_WIDTH = 640;
const CHAT_PANEL_WIDTH_KEY = 'claudia-chat-panel-width';
const DEFAULT_CHAT_PANEL_WIDTH = 380;

function App() {
    const isMobile = useIsMobile();
    useTheme();
    const {
        createTask,
        interruptTask,
        archiveTask,
        revertTask,
        createWorkspace,
        deleteWorkspace,
        reorderWorkspaces,
        setWorkspaceOrder,
        reorderTasks: reorderTasksOnServer,
        openFolder,
        openTerminal,
        setSystemPrompt,
        sendChatMessage,
        clearChatHistory,
        requestArchivedTasks,
        restoreArchivedTask,
        deleteArchivedTask,
        continueArchivedTask,
        pushToGithub,
        resetWorkspace,
        renameTask,
        renameWorkspace,
        toggleReference,
        addCustomReference,
        removeReference,
        requestRecentWorkspaces,
        clearRecentWorkspace,
        resolveDeleteRequest,
        wsRef
    } = useWebSocket();

    const { selectedTaskId, tasks, workspaces, setShowProjectPicker, chatMessages, chatTyping, isConnected, isServerReloading, isOffline, supervisorEnabled, aiCoreConfigured, showSystemStats, errorNotification, clearErrorNotification, unreadTaskIds } = useTaskStore();
    const selectedTask = selectedTaskId ? tasks.get(selectedTaskId) : null;
    const selectedWorkspace = selectedTask ? workspaces.find(w => w.id === selectedTask.workspaceId) : undefined;

    // Track fullscreen state (Electron only)
    const [isFullscreen, setIsFullscreen] = useState(false);
    useEffect(() => {
        const api = window.electronAPI;
        if (!api?.onFullscreenChanged) return;
        return api.onFullscreenChanged(setIsFullscreen);
    }, []);

    // On mobile, track whether the user is viewing the terminal (screen 2)
    const [mobileShowTerminal, setMobileShowTerminal] = useState(false);

    // Embedded shell terminal state
    // activeShellWorkspaceId = which workspace has a shell PTY running (null = none)
    // showingShell = whether we're currently displaying the shell (vs a task)
    const [activeShellWorkspaceId, setActiveShellWorkspaceId] = useState<string | null>(null);
    const [showingShell, setShowingShell] = useState(false);
    const activeShellWorkspace = activeShellWorkspaceId ? workspaces.find(w => w.id === activeShellWorkspaceId) : undefined;

    // Count tasks that have running processes (not disconnected or archived)
    const activeTasks = Array.from(tasks.values()).filter(t =>
        t.state !== 'disconnected' &&
        t.state !== 'archived' &&
        t.state !== 'interrupted'
    );

    const busyTasks = activeTasks.filter(t => t.state === 'busy');
    const idleTasks = activeTasks.filter(t => t.state !== 'busy');
    const busyCount = busyTasks.length;
    const idleCount = idleTasks.length;

    const taskTooltip = [
        busyTasks.length > 0 ? '⚡ BUSY TASKS:' : null,
        ...busyTasks.map(t => `• ${t.prompt || 'No description'}`),
        (busyTasks.length > 0 && idleTasks.length > 0) ? '' : null,
        idleTasks.length > 0 ? '💤 IDLE TASKS:' : null,
        ...idleTasks.map(t => `• ${t.prompt || 'No description'}`)
    ].filter(item => item !== null).join('\n') || 'No running tasks';

    const [sidebarWidth, setSidebarWidth] = useState(() => {
        try {
            const savedWidth = localStorage.getItem(SIDEBAR_WIDTH_KEY);
            return savedWidth ? parseInt(savedWidth, 10) : DEFAULT_SIDEBAR_WIDTH;
        } catch {
            return DEFAULT_SIDEBAR_WIDTH;
        }
    });
    const [chatPanelWidth, setChatPanelWidth] = useState(() => {
        try {
            const savedWidth = localStorage.getItem(CHAT_PANEL_WIDTH_KEY);
            return savedWidth ? parseInt(savedWidth, 10) : DEFAULT_CHAT_PANEL_WIDTH;
        } catch {
            return DEFAULT_CHAT_PANEL_WIDTH;
        }
    });
    const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
        try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'; } catch { return false; }
    });
    const toggleSidebar = () => setSidebarCollapsed(c => {
        const next = !c;
        try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next)); } catch {}
        return next;
    });
    const [isResizing, setIsResizing] = useState(false);
    const [isResizingChat, setIsResizingChat] = useState(false);
    const [terminalRefreshCounter, setTerminalRefreshCounter] = useState(0);
    const [showSettings, setShowSettings] = useState(false);
    const [showUsageDashboard, setShowUsageDashboard] = useState(false);
    const [settingsInitialPanel, setSettingsInitialPanel] = useState<string | undefined>(undefined);
    const [showChatPanel, setShowChatPanel] = useState(false);
    const [showMobileAccess, setShowMobileAccess] = useState(false);
    const [showActivityPanel, setShowActivityPanel] = useState(false);
    const [soundMuted, setSoundMuted] = useState(() => !isSoundEnabled());
    const [tunnelActive, setTunnelActive] = useState(false);
    const [tunnelLoading, setTunnelLoading] = useState(false);
    const [tunnelError, setTunnelError] = useState<string | null>(null);
    const sidebarRef = useRef<HTMLElement>(null);
    const aiCoreCheckDoneRef = useRef(false);

    // After a genuine server reload (tsx watch restart), the TerminalView's WS
    // listener is on the old connection. Force remount only when isServerReloading
    // transitions from true→false (server finished restarting), not on every
    // reconnection — that would cause unwanted refreshes on tab switches.
    const prevReloadingRef = useRef(isServerReloading);
    useEffect(() => {
        if (!isServerReloading && prevReloadingRef.current) {
            setTerminalRefreshCounter(c => c + 1);
        }
        prevReloadingRef.current = isServerReloading;
    }, [isServerReloading]);

    // Force TerminalView remount on ANY WebSocket reconnection, not just server reloads.
    // When the browser tab is inactive, the WS heartbeat times out after 90s and the
    // connection drops. On reconnect, TerminalView's message listener is still on the
    // dead WebSocket, so no output/history is received → blank terminal.
    // On Windows, tsx watch kills with TerminateProcess (no SIGTERM), so the
    // server:reloading message is never sent and the isServerReloading path above
    // never fires. This effect catches ALL reconnect scenarios.
    const hasConnectedOnceRef = useRef(false);
    const prevConnectedRef = useRef(isConnected);
    useEffect(() => {
        if (isConnected && !prevConnectedRef.current) {
            if (hasConnectedOnceRef.current) {
                console.log('[App] WS reconnected — forcing TerminalView remount');
                setTerminalRefreshCounter(c => c + 1);
            }
            hasConnectedOnceRef.current = true;
        }
        prevConnectedRef.current = isConnected;
    }, [isConnected]);

    const handleMouseDown = () => {
        setIsResizing(true);
    };

    const handleChatResizeMouseDown = () => {
        setIsResizingChat(true);
    };

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (isResizing) {
                const newWidth = e.clientX;
                const minWidth = 250;
                // Allow sidebar to expand up to 70% of viewport for multi-column workspace layout
                const maxWidth = Math.max(800, Math.floor(window.innerWidth * 0.7));
                if (newWidth >= minWidth && newWidth <= maxWidth) {
                    setSidebarWidth(newWidth);
                }
            }
            if (isResizingChat) {
                const newWidth = window.innerWidth - e.clientX;
                const minWidth = 300;
                const maxWidth = 600;
                if (newWidth >= minWidth && newWidth <= maxWidth) {
                    setChatPanelWidth(newWidth);
                }
            }
        };

        const handleMouseUp = () => {
            setIsResizing(false);
            setIsResizingChat(false);
        };

        if (isResizing || isResizingChat) {
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        }

        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isResizing, isResizingChat]);

    useEffect(() => {
        try {
            localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
        } catch {
            // Silently fail
        }
    }, [sidebarWidth]);

    useEffect(() => {
        try {
            localStorage.setItem(CHAT_PANEL_WIDTH_KEY, chatPanelWidth.toString());
        } catch {
            // Silently fail
        }
    }, [chatPanelWidth]);

    // Generate or retrieve a unique user ID for usage tracking and send to backend
    useEffect(() => {
        try {
            let userId = localStorage.getItem('claudia_user_id');
            if (!userId) {
                userId = crypto.randomUUID();
                localStorage.setItem('claudia_user_id', userId);
                console.log('[App] Generated new usage tracking ID:', userId);
            }
            // Register with backend so the proxy can tag API calls
            fetch(`${getApiBaseUrl()}/api/user-id`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId }),
            }).catch(() => { }); // fire-and-forget
        } catch {
            // Silently fail — tracking is non-critical
        }
    }, []);

    const handleProjectSelect = (path: string) => {
        createWorkspace(path);
        setShowProjectPicker(false);
    };

    const handleOpenShell = useCallback((workspaceId: string) => {
        if (activeShellWorkspaceId === workspaceId && showingShell) {
            // Already viewing this shell - hide it (but keep PTY alive)
            setShowingShell(false);
        } else {
            setActiveShellWorkspaceId(workspaceId);
            setShowingShell(true);
        }
    }, [activeShellWorkspaceId, showingShell]);

    const handleCloseShell = useCallback(() => {
        // Kill the PTY and hide
        setActiveShellWorkspaceId(null);
        setShowingShell(false);
    }, []);

    const handleShowShell = useCallback(() => {
        setShowingShell(true);
    }, []);

    const handleSelectTask = (taskId: string) => {
        // Hide shell view (but keep PTY alive) when selecting a task
        setShowingShell(false);
        // NOTE: We intentionally do NOT remount on same-task click — that causes
        // a black flash and loses the first character typed. The terminal garbling
        // issues are addressed by the double-rAF fit + pending resize fixes.
        // Only update local state - TerminalView will send task:select when it mounts
        useTaskStore.getState().selectTask(taskId);

        // On mobile, switch to terminal screen
        if (isMobile) {
            setMobileShowTerminal(true);
        }

        // Dispatch scroll-to-bottom events with increasing delays to catch both
        // fast (cached) and slow (network) history loads
        // The TerminalView also scrolls after receiving task:restore, but these
        // serve as fallbacks for edge cases
        const delays = [100, 300, 600];
        delays.forEach(delay => {
            setTimeout(() => {
                window.dispatchEvent(new CustomEvent('terminal:scrollToBottom', {
                    detail: { taskId }
                }));
            }, delay);
        });

        // Focus the task input bar immediately after mount (requestAnimationFrame
        // ensures the component has rendered before we dispatch the event).
        requestAnimationFrame(() => {
            window.dispatchEvent(new CustomEvent('taskInput:focus', {
                detail: { taskId }
            }));
        });
    };

    // Mobile back button: return to workspace list
    const handleMobileBack = useCallback(() => {
        setMobileShowTerminal(false);
    }, []);

    // Count unread messages indicator
    const hasUnreadMessages = chatMessages.length > 0 && !showChatPanel;

    // Close chat panel if supervisor is disabled
    useEffect(() => {
        if (!supervisorEnabled && showChatPanel) {
            setShowChatPanel(false);
        }
    }, [supervisorEnabled, showChatPanel]);

    // Open settings to AI Core panel if credentials are not configured (only once on startup)
    // Skip if tasks already exist (workspace was reloaded, so API key is already set)
    useEffect(() => {
        if (aiCoreConfigured === false && !aiCoreCheckDoneRef.current && tasks.size === 0) {
            aiCoreCheckDoneRef.current = true;
            setSettingsInitialPanel('aicore');
            setShowSettings(true);
        }
    }, [aiCoreConfigured, tasks.size]);

    // Auto-dismiss error notification after 15 seconds
    useEffect(() => {
        if (errorNotification) {
            const timer = setTimeout(() => clearErrorNotification(), 15000);
            return () => clearTimeout(timer);
        }
    }, [errorNotification, clearErrorNotification]);

    // Clear initial panel when settings is closed
    const handleSettingsClose = () => {
        setShowSettings(false);
        setSettingsInitialPanel(undefined);
    };

    // Open settings normally (without a specific panel)
    const handleSettingsOpen = () => {
        setSettingsInitialPanel(undefined);
        setShowSettings(true);
    };

    // Restart the backend server
    const handleRestartServer = async () => {
        try {
            await fetch(`${getApiBaseUrl()}/api/server/restart`, { method: 'POST' });
        } catch (error) {
            // Expected - server will disconnect
            console.log('Server restart triggered');
        }
    };

    // Open voice agent in new tab
    const handleOpenVoiceAgent = useCallback(async () => {
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/tunnel/status`);
            const data = await res.json();
            let token = data.token;

            // If no tunnel token, generate a temporary local token
            if (!token) {
                token = 'local-' + Math.random().toString(36).substring(2, 15);
            }

            const voiceUrl = `${getApiBaseUrl()}/voice?token=${token}`;
            window.open(voiceUrl, '_blank');
        } catch (error) {
            console.error('Failed to open voice agent:', error);
            alert('Failed to open voice agent. Please try again.');
        }
    }, []);

    // Check tunnel status on mount
    useEffect(() => {
        (async () => {
            try {
                const res = await fetch(`${getApiBaseUrl()}/api/tunnel/status`);
                const data = await res.json();
                setTunnelActive(data.active === true);
            } catch {
                // ignore
            }
        })();
    }, []);

    // Keep tunnel active state in sync with server-pushed tunnel:status WS messages.
    // This handles tsx watch reloads where the backend adopts the existing ngrok process
    // and re-emits tunnel:ready — without this the button would stay grey.
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent<{ active: boolean; error?: string | null }>).detail;
            setTunnelActive(detail.active === true);
            if (!detail.active && detail.error) {
                setTunnelError(detail.error);
            } else if (detail.active) {
                setTunnelError(null);
            }
        };
        window.addEventListener('claudia:tunnelStatus', handler);
        return () => window.removeEventListener('claudia:tunnelStatus', handler);
    }, []);

    // Start tunnel (used by both the header button and the modal's Start button)
    const startTunnel = useCallback(async () => {
        setTunnelLoading(true);
        setTunnelError(null);
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/tunnel/start`, { method: 'POST' });
            const data = await res.json();
            if (data.error) {
                console.error('[Tunnel] Failed to start:', data.error);
                setTunnelActive(false);
                setTunnelError(data.error);
            } else {
                setTunnelActive(true);
            }
        } catch (err) {
            console.error('[Tunnel] Failed to start:', err);
            setTunnelActive(false);
            setTunnelError(err instanceof Error ? err.message : 'Failed to connect');
        } finally {
            setTunnelLoading(false);
        }
    }, []);

    // Mobile button: just open the modal — user starts tunnel explicitly from inside
    const handleMobileToggle = useCallback(() => {
        setShowMobileAccess(true);
    }, []);

    // Explicitly stop tunnel (called from modal) — keep modal open so user can restart
    const handleStopTunnel = useCallback(async () => {
        try {
            await fetch(`${getApiBaseUrl()}/api/tunnel/stop`, { method: 'POST' });
        } catch {
            // ignore
        }
        setTunnelActive(false);
        setTunnelLoading(false);
        setTunnelError(null);
    }, []);

    // Determine what to show on mobile
    const mobileShowingTerminal = isMobile && mobileShowTerminal && selectedTask;

    return (
        <div className={`app ${isMobile ? 'is-mobile' : ''}`}>
            <header className="app-header">
                {/* Mobile back button when viewing terminal */}
                {mobileShowingTerminal && (
                    <button className="mobile-back-button" onClick={handleMobileBack} title="Back to tasks">
                        <ArrowLeft size={20} />
                    </button>
                )}
                <div className="logo">
                    <Terminal size={isMobile ? 20 : 24} />
                    <h1>Claudia</h1>
                    <span className="app-version">v{__APP_VERSION__}</span>
                </div>
                <div className="header-controls">
                    {isFullscreen && (
                        <button
                            className="exit-fullscreen-button"
                            onClick={() => window.electronAPI?.exitFullscreen()}
                            title="Exit Fullscreen (F11)"
                        >
                            <Minimize2 size={16} />
                            <span className="btn-label">Exit Fullscreen</span>
                        </button>
                    )}
                    {/* Activity: task counts + activity panel toggle */}
                    <button
                        className={`activity-button ${showActivityPanel ? 'active' : ''} ${busyCount > 0 ? 'has-busy' : ''}`}
                        onClick={() => setShowActivityPanel(!showActivityPanel)}
                        title={taskTooltip}
                    >
                        <Activity size={18} className={busyCount > 0 ? 'active-pulse' : ''} />
                        <span className="count-busy">{busyCount}</span>
                        <span className="count-separator">/</span>
                        <span className="count-idle">{idleCount}</span>
                        {unreadTaskIds.size > 0 && (
                            <span className="activity-badge">{unreadTaskIds.size}</span>
                        )}
                    </button>

                    {showSystemStats && <SystemStats />}
                    {!isMobile && supervisorEnabled && (
                        <button
                            className={`chat-toggle-button ${showChatPanel ? 'active' : ''} ${hasUnreadMessages ? 'has-messages' : ''}`}
                            onClick={() => setShowChatPanel(!showChatPanel)}
                            title={showChatPanel ? 'Close Chat' : 'Open Chat'}
                        >
                            <MessageCircle size={18} />
                            <span className="btn-label">Chat</span>
                            {hasUnreadMessages && <span className="message-badge">{chatMessages.length}</span>}
                        </button>
                    )}
                    {!isMobile && (
                        <button
                            className={`chat-toggle-button mobile-tunnel-btn ${tunnelActive ? 'tunnel-active' : ''} ${tunnelLoading ? 'loading' : ''}`}
                            onClick={handleMobileToggle}
                            title={tunnelActive ? 'View Mobile Tunnel' : 'Start Mobile Tunnel'}
                            disabled={tunnelLoading}
                        >
                            <Smartphone size={18} />
                            <span className="btn-label">{tunnelLoading ? 'Connecting...' : 'Mobile'}</span>
                            {tunnelActive && <span className="tunnel-active-dot" />}
                        </button>
                    )}
                    {!isMobile && (
                        <button
                            className="chat-toggle-button voice-agent-button"
                            onClick={handleOpenVoiceAgent}
                            title="Open Voice Agent"
                        >
                            <Mic size={18} />
                            <span className="btn-label">Voice Agent</span>
                        </button>
                    )}
                    <GlobalVoiceToggle />
                    <button
                        className={`notification-toggle-button ${soundMuted ? 'muted' : ''}`}
                        onClick={() => {
                            const newMuted = !soundMuted;
                            setSoundMuted(newMuted);
                            setSoundEnabled(!newMuted);
                        }}
                        title={soundMuted ? 'Unmute Notifications' : 'Mute Notifications'}
                    >
                        {soundMuted ? <BellOff size={isMobile ? 18 : 20} /> : <Bell size={isMobile ? 18 : 20} />}
                    </button>
                    <button
                        className="restart-button"
                        onClick={handleRestartServer}
                        title="Restart Server"
                    >
                        <RotateCcw size={isMobile ? 18 : 20} />
                    </button>
                    <button
                        className="settings-button"
                        onClick={() => setShowUsageDashboard(true)}
                        title="Token Usage"
                    >
                        <BarChart3 size={isMobile ? 18 : 20} />
                    </button>
                    <button
                        className="settings-button"
                        onClick={handleSettingsOpen}
                        title="Settings"
                    >
                        <Settings size={isMobile ? 18 : 20} />
                    </button>
                </div>
                {showActivityPanel && (
                    <ActivityPanel
                        onClose={() => setShowActivityPanel(false)}
                        onSelectTask={handleSelectTask}
                    />
                )}
            </header>

            <main className="app-main">
                {/* ===== MOBILE LAYOUT ===== */}
                {isMobile ? (
                    mobileShowingTerminal ? (
                        // Screen 2: Full-screen terminal
                        <section className="main-panel mobile-full">
                            <TerminalView
                                key={`${selectedTask!.id}-${terminalRefreshCounter}`}
                                task={selectedTask!}
                                wsRef={wsRef}
                                workspace={selectedWorkspace}
                                isMobile={true}
                            />
                        </section>
                    ) : (
                        // Screen 1: Full-screen workspace list
                        <aside className="sidebar mobile-full">
                            <WorkspacePanel
                                onDeleteTask={archiveTask}
                                onInterruptTask={interruptTask}
                                onArchiveTask={archiveTask}
                                onRevertTask={revertTask}
                                onCreateWorkspace={createWorkspace}
                                onDeleteWorkspace={deleteWorkspace}
                                onReorderWorkspaces={reorderWorkspaces}
                                onSetWorkspaceOrder={setWorkspaceOrder}
                                onReorderTasksOnServer={reorderTasksOnServer}
                                onOpenFolder={openFolder}
                                onOpenTerminal={openTerminal}
                                onOpenShell={handleOpenShell}
                                onPushToGithub={pushToGithub}
                                onSetSystemPrompt={setSystemPrompt}
                                onCreateTask={createTask}
                                onSelectTask={handleSelectTask}
                                onRequestArchivedTasks={requestArchivedTasks}
                                onRestoreArchivedTask={restoreArchivedTask}
                                onDeleteArchivedTask={deleteArchivedTask}
                                onContinueArchivedTask={continueArchivedTask}
                                onRenameTask={renameTask}
                                onRenameWorkspace={renameWorkspace}
                                onToggleReference={toggleReference}
                                onAddCustomReference={addCustomReference}
                                onRemoveReference={removeReference}
                                onResetWorkspace={resetWorkspace}
                                onResolveDeleteRequest={resolveDeleteRequest}
                            />
                        </aside>
                    )
                ) : (
                    /* ===== DESKTOP LAYOUT (unchanged) ===== */
                    <>
                        {sidebarCollapsed ? (
                            <aside className="sidebar collapsed">
                                <button
                                    className="sidebar-expand-btn"
                                    onClick={toggleSidebar}
                                    title="Show workspaces"
                                >
                                    <ChevronRight size={14} />
                                    <span className="sidebar-expand-label">Workspaces</span>
                                </button>
                            </aside>
                        ) : (
                        <aside
                            className="sidebar"
                            ref={sidebarRef}
                            style={{ width: `${sidebarWidth}px`, minWidth: `${sidebarWidth}px` }}
                        >
                            <WorkspacePanel
                                onDeleteTask={archiveTask}
                                onInterruptTask={interruptTask}
                                onArchiveTask={archiveTask}
                                onRevertTask={revertTask}
                                onCreateWorkspace={createWorkspace}
                                onDeleteWorkspace={deleteWorkspace}
                                onReorderWorkspaces={reorderWorkspaces}
                                onSetWorkspaceOrder={setWorkspaceOrder}
                                onReorderTasksOnServer={reorderTasksOnServer}
                                onOpenFolder={openFolder}
                                onOpenTerminal={openTerminal}
                                onOpenShell={handleOpenShell}
                                onPushToGithub={pushToGithub}
                                onSetSystemPrompt={setSystemPrompt}
                                onCreateTask={createTask}
                                onSelectTask={handleSelectTask}
                                onRequestArchivedTasks={requestArchivedTasks}
                                onRestoreArchivedTask={restoreArchivedTask}
                                onDeleteArchivedTask={deleteArchivedTask}
                                onContinueArchivedTask={continueArchivedTask}
                                onRenameTask={renameTask}
                                onRenameWorkspace={renameWorkspace}
                                onToggleReference={toggleReference}
                                onAddCustomReference={addCustomReference}
                                onRemoveReference={removeReference}
                                onResetWorkspace={resetWorkspace}
                                onResolveDeleteRequest={resolveDeleteRequest}
                                onCollapse={toggleSidebar}
                            />
                        </aside>
                        )}

                        {!sidebarCollapsed && (
                            <div
                                className={`resize-handle ${isResizing ? 'resizing' : ''}`}
                                onMouseDown={handleMouseDown}
                            />
                        )}

                        <section className="main-panel">
                            {/* Shell terminal - always mounted when active, hidden via CSS to preserve xterm state */}
                            {activeShellWorkspaceId && activeShellWorkspace && (
                                <div className="shell-terminal-wrapper" style={{ display: showingShell ? 'flex' : 'none' }}>
                                    <ShellTerminalView
                                        key={`shell-${activeShellWorkspaceId}`}
                                        workspaceId={activeShellWorkspaceId}
                                        workspaceName={activeShellWorkspace.displayName || activeShellWorkspace.name}
                                        wsRef={wsRef}
                                        onClose={handleCloseShell}
                                        visible={showingShell}
                                    />
                                </div>
                            )}
                            {/* Task terminal or empty state - shown when shell is hidden */}
                            {!showingShell && (
                                selectedTask ? (
                                    <>
                                        {activeShellWorkspaceId && activeShellWorkspace && (
                                            <button
                                                className="shell-switch-banner"
                                                onClick={handleShowShell}
                                                title="Switch back to the running shell"
                                            >
                                                <Terminal size={14} />
                                                <span>Shell running — {activeShellWorkspace.displayName || activeShellWorkspace.name}</span>
                                            </button>
                                        )}
                                        <TerminalView
                                            key={`${selectedTask.id}-${terminalRefreshCounter}`}
                                            task={selectedTask}
                                            wsRef={wsRef}
                                            workspace={selectedWorkspace}
                                        />
                                    </>
                                ) : (
                                    <div className="empty-state-main">
                                        <Terminal size={48} strokeWidth={1} />
                                        <h2>Select a task to view its terminal</h2>
                                        <p>Add a workspace and create a task to get started</p>
                                    </div>
                                )
                            )}
                        </section>

                        <FileExplorer
                            workspacePath={selectedWorkspace?.id}
                            workspaceName={selectedWorkspace?.displayName || selectedWorkspace?.name}
                        />

                        {showChatPanel && (
                            <>
                                <div
                                    className={`resize-handle chat-resize ${isResizingChat ? 'resizing' : ''}`}
                                    onMouseDown={handleChatResizeMouseDown}
                                />
                                <aside
                                    className="chat-panel-sidebar"
                                    style={{ width: `${chatPanelWidth}px`, minWidth: `${chatPanelWidth}px` }}
                                >
                                    <div className="chat-panel-header">
                                        <span>AI Supervisor</span>
                                        <button
                                            className="chat-close-button"
                                            onClick={() => setShowChatPanel(false)}
                                            title="Close chat"
                                        >
                                            <X size={18} />
                                        </button>
                                    </div>
                                    <SupervisorChat
                                        messages={chatMessages}
                                        isTyping={chatTyping}
                                        selectedTaskId={selectedTaskId}
                                        onSendMessage={sendChatMessage}
                                        onClearHistory={clearChatHistory}
                                    />
                                </aside>
                            </>
                        )}
                    </>
                )}
            </main>

            <ProjectPicker onSelect={handleProjectSelect} wsRef={wsRef} requestRecentWorkspaces={requestRecentWorkspaces} clearRecentWorkspace={clearRecentWorkspace} />
            <SettingsMenu isOpen={showSettings} onClose={handleSettingsClose} initialPanel={settingsInitialPanel} />
            <UsageDashboard isOpen={showUsageDashboard} onClose={() => setShowUsageDashboard(false)} />
            {!isMobile && <MobileAccessModal isOpen={showMobileAccess} onClose={() => setShowMobileAccess(false)} error={tunnelError} tunnelActive={tunnelActive} tunnelLoading={tunnelLoading} onStopTunnel={handleStopTunnel} onStartTunnel={startTunnel} />}
            <GlobalVoiceManager />
            <ThinkingSoundManager />
            <TaskCompletionVoiceManager />
            <TaskProgressVoiceManager />

            {/* Offline warning overlay */}
            {isOffline && (
                <div className="server-reload-overlay offline-warning">
                    <div className="server-reload-content">
                        <WifiOff size={32} />
                        <span>No internet connection</span>
                        <p className="offline-hint">Please check your network connection and try again</p>
                    </div>
                </div>
            )}

            {/* Server reloading banner (non-blocking) */}
            {!isOffline && (isServerReloading || !isConnected) && (
                <div className="server-reload-banner">
                    <RefreshCw className="spinning" size={18} />
                    <span>
                        {isServerReloading
                            ? 'Backend is restarting...'
                            : 'Reconnecting to backend...'}
                    </span>
                </div>
            )}

            {/* Error notification banner */}
            {errorNotification && (
                <div className="error-notification-banner">
                    <AlertTriangle size={20} />
                    <span className="error-notification-message">{errorNotification.message}</span>
                    <button
                        className="error-notification-close"
                        onClick={clearErrorNotification}
                        title="Dismiss"
                    >
                        <X size={16} />
                    </button>
                </div>
            )}

        </div>
    );
}

export default App;
