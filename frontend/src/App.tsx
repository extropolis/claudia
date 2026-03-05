import { useState, useRef, useEffect, useCallback } from 'react';
import { WorkspacePanel } from './components/WorkspacePanel';
import { TerminalView } from './components/TerminalView';
import { SupervisorChat } from './components/SupervisorChat';
import { ProjectPicker } from './components/ProjectPicker';
import { SettingsMenu } from './components/SettingsMenu';
import { GlobalVoiceManager } from './components/GlobalVoiceManager';
import { GlobalVoiceToggle } from './components/GlobalVoiceToggle';
import { SystemStats } from './components/SystemStats';
import { MobileAccessModal } from './components/MobileAccessModal';
import { useWebSocket } from './hooks/useWebSocket';
import { useTaskStore } from './stores/taskStore';
import { Terminal, Settings, MessageCircle, X, RefreshCw, RotateCcw, WifiOff, Activity, AlertTriangle, Smartphone, ArrowLeft, Minimize2 } from 'lucide-react';
import { getApiBaseUrl } from './config/api-config';

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
const DEFAULT_SIDEBAR_WIDTH = 640;
const CHAT_PANEL_WIDTH_KEY = 'claudia-chat-panel-width';
const DEFAULT_CHAT_PANEL_WIDTH = 380;

function App() {
    const isMobile = useIsMobile();
    const {
        createTask,
        interruptTask,
        archiveTask,
        revertTask,
        createWorkspace,
        deleteWorkspace,
        reorderWorkspaces,
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
        renameTask,
        renameWorkspace,
        requestRecentWorkspaces,
        clearRecentWorkspace,
        wsRef
    } = useWebSocket();

    const { selectedTaskId, tasks, workspaces, setShowProjectPicker, chatMessages, chatTyping, isConnected, isServerReloading, isOffline, supervisorEnabled, aiCoreConfigured, showSystemStats, errorNotification, clearErrorNotification } = useTaskStore();
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
    const [isResizing, setIsResizing] = useState(false);
    const [isResizingChat, setIsResizingChat] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [settingsInitialPanel, setSettingsInitialPanel] = useState<string | undefined>(undefined);
    const [showChatPanel, setShowChatPanel] = useState(false);
    const [showMobileAccess, setShowMobileAccess] = useState(false);
    const [tunnelActive, setTunnelActive] = useState(false);
    const [tunnelLoading, setTunnelLoading] = useState(false);
    const sidebarRef = useRef<HTMLElement>(null);
    const aiCoreCheckDoneRef = useRef(false);

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
                const maxWidth = 800;
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

    const handleSelectTask = (taskId: string) => {
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

        // Focus the task input bar after a short delay to allow the component to mount
        setTimeout(() => {
            window.dispatchEvent(new CustomEvent('taskInput:focus', {
                detail: { taskId }
            }));
        }, 150);
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
    useEffect(() => {
        if (aiCoreConfigured === false && !aiCoreCheckDoneRef.current) {
            aiCoreCheckDoneRef.current = true;
            setSettingsInitialPanel('aicore');
            setShowSettings(true);
        }
    }, [aiCoreConfigured]);

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

    // Toggle tunnel: start + show modal, or stop tunnel
    const handleMobileToggle = useCallback(async () => {
        if (tunnelActive) {
            try {
                await fetch(`${getApiBaseUrl()}/api/tunnel/stop`, { method: 'POST' });
            } catch {
                // ignore
            }
            setTunnelActive(false);
            setShowMobileAccess(false);
        } else {
            setShowMobileAccess(true);
            setTunnelLoading(true);
            try {
                const res = await fetch(`${getApiBaseUrl()}/api/tunnel/start`, { method: 'POST' });
                const data = await res.json();
                if (data.error) {
                    console.error('[Tunnel] Failed to start:', data.error);
                    setTunnelActive(false);
                } else {
                    setTunnelActive(true);
                }
            } catch (err) {
                console.error('[Tunnel] Failed to start:', err);
                setTunnelActive(false);
            } finally {
                setTunnelLoading(false);
            }
        }
    }, [tunnelActive]);

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
                    {/* Running Process Counter */}
                    <div className="running-tasks-indicator" title={taskTooltip}>
                        <Activity size={18} className={busyCount > 0 ? 'active-pulse' : ''} />
                        <span className="count-busy">{busyCount}</span>
                        <span className="count-separator">/</span>
                        <span className="count-idle">{idleCount}</span>
                    </div>

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
                            className={`chat-toggle-button ${tunnelActive ? 'active' : ''} ${tunnelLoading ? 'loading' : ''}`}
                            onClick={handleMobileToggle}
                            title={tunnelActive ? 'Stop Tunnel' : 'Start Mobile Tunnel'}
                            disabled={tunnelLoading}
                        >
                            <Smartphone size={18} />
                            <span className="btn-label">{tunnelLoading ? 'Connecting...' : 'Mobile'}</span>
                        </button>
                    )}
                    <GlobalVoiceToggle />
                    <button
                        className="restart-button"
                        onClick={handleRestartServer}
                        title="Restart Server"
                    >
                        <RotateCcw size={isMobile ? 18 : 20} />
                    </button>
                    <button
                        className="settings-button"
                        onClick={handleSettingsOpen}
                        title="Settings"
                    >
                        <Settings size={isMobile ? 18 : 20} />
                    </button>
                </div>
            </header>

            <main className="app-main">
                {/* ===== MOBILE LAYOUT ===== */}
                {isMobile ? (
                    mobileShowingTerminal ? (
                        // Screen 2: Full-screen terminal
                        <section className="main-panel mobile-full">
                            <TerminalView
                                key={selectedTask!.id}
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
                                onOpenFolder={openFolder}
                                onOpenTerminal={openTerminal}
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
                            />
                        </aside>
                    )
                ) : (
                    /* ===== DESKTOP LAYOUT (unchanged) ===== */
                    <>
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
                                onOpenFolder={openFolder}
                                onOpenTerminal={openTerminal}
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
                            />
                        </aside>

                        <div
                            className={`resize-handle ${isResizing ? 'resizing' : ''}`}
                            onMouseDown={handleMouseDown}
                        />

                        <section className="main-panel">
                            {selectedTask ? (
                                <TerminalView
                                    key={selectedTask.id}
                                    task={selectedTask}
                                    wsRef={wsRef}
                                    workspace={selectedWorkspace}
                                />
                            ) : (
                                <div className="empty-state-main">
                                    <Terminal size={48} strokeWidth={1} />
                                    <h2>Select a task to view its terminal</h2>
                                    <p>Add a workspace and create a task to get started</p>
                                </div>
                            )}
                        </section>

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
            {!isMobile && <MobileAccessModal isOpen={showMobileAccess} onClose={() => setShowMobileAccess(false)} />}
            <GlobalVoiceManager />

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
