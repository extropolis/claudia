import { useState, useRef, useEffect, useCallback } from 'react';
import { WorkspacePanel } from './components/WorkspacePanel';
import { TerminalView } from './components/TerminalView';
import { TaskSummaryView } from './components/TaskSummaryView';
import { PreviewTab } from './components/PreviewTab';
import { ProjectPicker } from './components/ProjectPicker';
import { SettingsMenu } from './components/SettingsMenu';
import { GlobalVoiceManager } from './components/GlobalVoiceManager';
import { GlobalVoiceToggle } from './components/GlobalVoiceToggle';
import { SystemStats } from './components/SystemStats';
import { MobileAccessModal } from './components/MobileAccessModal';
import { useWebSocket } from './hooks/useWebSocket';
import { useTaskStore } from './stores/taskStore';
import { ChatMessage } from '@claudia/shared';
import { Terminal, Settings, X, RefreshCw, RotateCcw, WifiOff, Activity, AlertTriangle, Smartphone, ArrowLeft, FileText, Globe } from 'lucide-react';
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
const PREVIEW_URLS_KEY = 'claudia-preview-urls'; // JSON map: workspacePath -> url

interface AlertToast {
    taskId: string;
    message: string;
    prompt: string;
    timestamp: number;
}

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
        openClaudeMd,
        setSystemPrompt,
        requestArchivedTasks,
        restoreArchivedTask,
        deleteArchivedTask,
        continueArchivedTask,
        pushToGithub,
        requestRecentWorkspaces,
        clearRecentWorkspace,
        wsRef
    } = useWebSocket();

    const { selectedTaskId, tasks, workspaces, setShowProjectPicker, isConnected, isServerReloading, isOffline, aiCoreConfigured, showSystemStats, errorNotification, clearErrorNotification, summaryMessages } = useTaskStore();
    const selectedTask = selectedTaskId ? tasks.get(selectedTaskId) : null;
    const selectedWorkspace = selectedTask ? workspaces.find(w => w.id === selectedTask.workspaceId) : undefined;

    // On mobile, track whether the user is viewing the terminal (screen 2)
    const [mobileShowTerminal, setMobileShowTerminal] = useState(false);

    // View mode toggle: 'terminal' (xterm.js), 'summary' (conversation view), or 'preview' (iframe browser)
    type ViewMode = 'terminal' | 'summary' | 'preview';
    const [viewMode, setViewMode] = useState<ViewMode>('terminal');

    // Browser preview URLs — per-workspace, persisted to localStorage
    const [previewUrls, setPreviewUrls] = useState<Record<string, string>>(() => {
        try {
            const saved = localStorage.getItem(PREVIEW_URLS_KEY);
            return saved ? JSON.parse(saved) : {};
        } catch {
            return {};
        }
    });

    // Derive current preview URL from selected workspace
    const workspaceKey = selectedWorkspace?.id || '_global';
    const previewUrl = previewUrls[workspaceKey] || '';
    const setPreviewUrl = useCallback((url: string) => {
        setPreviewUrls(prev => ({ ...prev, [workspaceKey]: url }));
    }, [workspaceKey]);

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
    const [isResizing, setIsResizing] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [settingsInitialPanel, setSettingsInitialPanel] = useState<string | undefined>(undefined);
    const [showMobileAccess, setShowMobileAccess] = useState(false);
    const [tunnelActive, setTunnelActive] = useState(false);
    const [tunnelLoading, setTunnelLoading] = useState(false);
    const sidebarRef = useRef<HTMLElement>(null);
    const aiCoreCheckDoneRef = useRef(false);

    // Alert toasts for cross-task summary notifications
    const [alertToasts, setAlertToasts] = useState<AlertToast[]>([]);
    const seenAlertIdsRef = useRef<Set<string>>(new Set());

    const handleMouseDown = () => {
        setIsResizing(true);
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
        };

        const handleMouseUp = () => {
            setIsResizing(false);
        };

        if (isResizing) {
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        }

        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isResizing]);

    useEffect(() => {
        try {
            localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
        } catch {
            // Silently fail
        }
    }, [sidebarWidth]);

    useEffect(() => {
        try {
            localStorage.setItem(PREVIEW_URLS_KEY, JSON.stringify(previewUrls));
        } catch {
            // Silently fail
        }
    }, [previewUrls]);

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

    // Watch for summary alert messages on non-selected tasks to show toasts
    useEffect(() => {
        for (const [taskId, messages] of summaryMessages) {
            if (taskId === selectedTaskId) continue; // Don't toast for the active task
            const lastMsg = messages[messages.length - 1] as ChatMessage | undefined;
            if (lastMsg && lastMsg.isAlert && lastMsg.role === 'assistant' && !seenAlertIdsRef.current.has(lastMsg.id)) {
                seenAlertIdsRef.current.add(lastMsg.id);
                const task = tasks.get(taskId);
                setAlertToasts(prev => [...prev, {
                    taskId,
                    message: lastMsg.content.substring(0, 120),
                    prompt: task?.prompt?.substring(0, 50) || 'Task',
                    timestamp: Date.now()
                }]);
                // Auto-dismiss after 8 seconds
                setTimeout(() => {
                    setAlertToasts(prev => prev.filter(t => t.taskId !== taskId || t.timestamp !== Date.now()));
                    // Simpler: just remove by taskId since we'll get a new one if needed
                    setAlertToasts(prev => prev.filter(t => {
                        const age = Date.now() - t.timestamp;
                        return age < 8000;
                    }));
                }, 8000);
            }
        }
    }, [summaryMessages, selectedTaskId, tasks]);

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

    // Handle clicking an alert toast - switch to that task in summary mode
    const handleAlertToastClick = (taskId: string) => {
        handleSelectTask(taskId);
        setViewMode('summary');
        setAlertToasts(prev => prev.filter(t => t.taskId !== taskId));
    };

    // Determine what to show on mobile
    const mobileShowingTerminal = isMobile && mobileShowTerminal && selectedTask;

    return (
        <div className={`app ${isMobile ? 'is-mobile' : ''}`}>
            <header className="app-header">
                {/* Mobile back button when viewing terminal or preview */}
                {(mobileShowingTerminal || (isMobile && viewMode === 'preview')) && (
                    <button className="mobile-back-button" onClick={() => { handleMobileBack(); if (viewMode === 'preview') setViewMode('terminal'); }} title="Back to tasks">
                        <ArrowLeft size={20} />
                    </button>
                )}
                <div className="logo">
                    <Terminal size={isMobile ? 20 : 24} />
                    <h1>Claudia</h1>
                </div>
                <div className="header-controls">
                    {/* View Mode Toggle */}
                    {(isMobile ? (mobileShowingTerminal || viewMode === 'preview') : true) && (
                        <div className="view-mode-toggle">
                            <button
                                className={`view-mode-btn ${viewMode === 'terminal' ? 'active' : ''}`}
                                onClick={() => setViewMode('terminal')}
                                title="Terminal view"
                            >
                                <Terminal size={16} />
                            </button>
                            <button
                                className={`view-mode-btn ${viewMode === 'summary' ? 'active' : ''}`}
                                onClick={() => setViewMode('summary')}
                                title="Summary view"
                            >
                                <FileText size={16} />
                            </button>
                            <button
                                className={`view-mode-btn ${viewMode === 'preview' ? 'active' : ''}`}
                                onClick={() => setViewMode('preview')}
                                title="Browser preview"
                            >
                                <Globe size={16} />
                            </button>
                        </div>
                    )}
                    {/* Running Process Counter */}
                    <div className="running-tasks-indicator" title={taskTooltip}>
                        <Activity size={18} className={busyCount > 0 ? 'active-pulse' : ''} />
                        <span className="count-busy">{busyCount}</span>
                        <span className="count-separator">/</span>
                        <span className="count-idle">{idleCount}</span>
                    </div>

                    {showSystemStats && <SystemStats />}
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
                    viewMode === 'preview' ? (
                        // Preview mode: full-screen iframe browser
                        <section className="main-panel mobile-full">
                            <PreviewTab url={previewUrl} onUrlChange={setPreviewUrl} />
                        </section>
                    ) : mobileShowingTerminal ? (
                        // Screen 2: Full-screen terminal or summary
                        <section className="main-panel mobile-full">
                            {viewMode === 'summary' ? (
                                <TaskSummaryView
                                    key={`summary-${selectedTask!.id}`}
                                    task={selectedTask!}
                                    wsRef={wsRef}
                                    workspace={selectedWorkspace}
                                    isMobile={true}
                                />
                            ) : (
                                <TerminalView
                                    key={selectedTask!.id}
                                    task={selectedTask!}
                                    wsRef={wsRef}
                                    workspace={selectedWorkspace}
                                    isMobile={true}
                                />
                            )}
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
                                onOpenClaudeMd={openClaudeMd}
                                onPushToGithub={pushToGithub}
                                onSetSystemPrompt={setSystemPrompt}
                                onCreateTask={createTask}
                                onSelectTask={handleSelectTask}
                                onRequestArchivedTasks={requestArchivedTasks}
                                onRestoreArchivedTask={restoreArchivedTask}
                                onDeleteArchivedTask={deleteArchivedTask}
                                onContinueArchivedTask={continueArchivedTask}
                            />
                        </aside>
                    )
                ) : (
                    /* ===== DESKTOP LAYOUT ===== */
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
                                onOpenClaudeMd={openClaudeMd}
                                onPushToGithub={pushToGithub}
                                onSetSystemPrompt={setSystemPrompt}
                                onCreateTask={createTask}
                                onSelectTask={handleSelectTask}
                                onRequestArchivedTasks={requestArchivedTasks}
                                onRestoreArchivedTask={restoreArchivedTask}
                                onDeleteArchivedTask={deleteArchivedTask}
                                onContinueArchivedTask={continueArchivedTask}
                            />
                        </aside>

                        <div
                            className={`resize-handle ${isResizing ? 'resizing' : ''}`}
                            onMouseDown={handleMouseDown}
                        />

                        <section className="main-panel">
                            {viewMode === 'preview' ? (
                                <PreviewTab url={previewUrl} onUrlChange={setPreviewUrl} />
                            ) : selectedTask ? (
                                viewMode === 'summary' ? (
                                    <TaskSummaryView
                                        key={`summary-${selectedTask.id}`}
                                        task={selectedTask}
                                        wsRef={wsRef}
                                        workspace={selectedWorkspace}
                                    />
                                ) : (
                                    <TerminalView
                                        key={selectedTask.id}
                                        task={selectedTask}
                                        wsRef={wsRef}
                                        workspace={selectedWorkspace}
                                    />
                                )
                            ) : (
                                <div className="empty-state-main">
                                    <Terminal size={48} strokeWidth={1} />
                                    <h2>Select a task to view its terminal</h2>
                                    <p>Add a workspace and create a task to get started</p>
                                </div>
                            )}
                        </section>
                    </>
                )}
            </main>

            <ProjectPicker onSelect={handleProjectSelect} wsRef={wsRef} requestRecentWorkspaces={requestRecentWorkspaces} clearRecentWorkspace={clearRecentWorkspace} />
            <SettingsMenu isOpen={showSettings} onClose={handleSettingsClose} initialPanel={settingsInitialPanel} />
            {!isMobile && <MobileAccessModal isOpen={showMobileAccess} onClose={() => setShowMobileAccess(false)} />}
            <GlobalVoiceManager />

            {/* Summary alert toasts for non-selected tasks */}
            {alertToasts.length > 0 && (
                <div className="summary-alert-toasts">
                    {alertToasts.map((toast) => (
                        <div
                            key={`${toast.taskId}-${toast.timestamp}`}
                            className="summary-alert-toast"
                            onClick={() => handleAlertToastClick(toast.taskId)}
                        >
                            <div className="toast-task">{toast.prompt}</div>
                            <div className="toast-message">{toast.message}</div>
                            <div className="toast-cta">Click to view summary</div>
                        </div>
                    ))}
                </div>
            )}

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
