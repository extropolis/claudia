import { useState, useRef, useEffect } from 'react';
import { WorkspacePanel } from './components/WorkspacePanel';
import { TerminalView } from './components/TerminalView';
import { SupervisorChat } from './components/SupervisorChat';
import { ProjectPicker } from './components/ProjectPicker';
import { SettingsMenu } from './components/SettingsMenu';
import { GlobalVoiceManager } from './components/GlobalVoiceManager';
import { GlobalVoiceToggle } from './components/GlobalVoiceToggle';
import { SystemStats } from './components/SystemStats';
import { useWebSocket } from './hooks/useWebSocket';
import { useTaskStore } from './stores/taskStore';
import { Terminal, Settings, MessageCircle, X, RefreshCw, RotateCcw, WifiOff, Activity } from 'lucide-react';
import { getApiBaseUrl } from './config/api-config';

const SIDEBAR_WIDTH_KEY = 'claudia-sidebar-width';
const DEFAULT_SIDEBAR_WIDTH = 640;
const CHAT_PANEL_WIDTH_KEY = 'claudia-chat-panel-width';
const DEFAULT_CHAT_PANEL_WIDTH = 380;

function App() {
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
        wsRef
    } = useWebSocket();

    const { selectedTaskId, tasks, workspaces, setShowProjectPicker, chatMessages, chatTyping, isConnected, isServerReloading, isOffline, supervisorEnabled, aiCoreConfigured, showSystemStats } = useTaskStore();
    const selectedTask = selectedTaskId ? tasks.get(selectedTaskId) : null;
    const selectedWorkspace = selectedTask ? workspaces.find(w => w.id === selectedTask.workspaceId) : undefined;

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

    const handleProjectSelect = (path: string) => {
        createWorkspace(path);
        setShowProjectPicker(false);
    };

    const handleSelectTask = (taskId: string) => {
        // Only update local state - TerminalView will send task:select when it mounts
        useTaskStore.getState().selectTask(taskId);

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

    return (
        <div className="app">
            <header className="app-header">
                <div className="logo">
                    <Terminal size={24} />
                    <h1>Claudia</h1>
                </div>
                <div className="header-controls">
                    {/* Running Process Counter */}
                    <div className="running-tasks-indicator" title={taskTooltip}>
                        <Activity size={18} className={busyCount > 0 ? 'active-pulse' : ''} />
                        <span className="count-busy">{busyCount}</span>
                        <span className="count-separator">/</span>
                        <span className="count-idle">{idleCount}</span>
                    </div>

                    {showSystemStats && <SystemStats />}
                    {supervisorEnabled && (
                        <button
                            className={`chat-toggle-button ${showChatPanel ? 'active' : ''} ${hasUnreadMessages ? 'has-messages' : ''}`}
                            onClick={() => setShowChatPanel(!showChatPanel)}
                            title={showChatPanel ? 'Close Chat' : 'Open Chat'}
                        >
                            <MessageCircle size={18} />
                            <span>Chat</span>
                            {hasUnreadMessages && <span className="message-badge">{chatMessages.length}</span>}
                        </button>
                    )}
                    <GlobalVoiceToggle />
                    <button
                        className="restart-button"
                        onClick={handleRestartServer}
                        title="Restart Server"
                    >
                        <RotateCcw size={20} />
                    </button>
                    <button
                        className="settings-button"
                        onClick={handleSettingsOpen}
                        title="Settings"
                    >
                        <Settings size={20} />
                    </button>
                </div>
            </header>

            <main className="app-main">
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
                            onSetSystemPrompt={setSystemPrompt}
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
            </main>

            <ProjectPicker onSelect={handleProjectSelect} />
            <SettingsMenu isOpen={showSettings} onClose={handleSettingsClose} initialPanel={settingsInitialPanel} />
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

        </div>
    );
}

export default App;
