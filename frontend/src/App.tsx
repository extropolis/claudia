import { useState, useRef, useEffect } from 'react';
import { WorkspacePanel } from './components/WorkspacePanel';
import { TerminalView } from './components/TerminalView';
import { SupervisorChat } from './components/SupervisorChat';
import { ProjectPicker } from './components/ProjectPicker';
import { SettingsMenu } from './components/SettingsMenu';
import { useWebSocket } from './hooks/useWebSocket';
import { useTaskStore } from './stores/taskStore';
import { Terminal, Settings, MessageCircle, X, RefreshCw } from 'lucide-react';

const SIDEBAR_WIDTH_KEY = 'claudia-sidebar-width';
const DEFAULT_SIDEBAR_WIDTH = 640;
const CHAT_PANEL_WIDTH_KEY = 'claudia-chat-panel-width';
const DEFAULT_CHAT_PANEL_WIDTH = 380;

function App() {
    const {
        createTask,
        destroyTask,
        interruptTask,
        archiveTask,
        createWorkspace,
        deleteWorkspace,
        sendChatMessage,
        clearChatHistory,
        wsRef
    } = useWebSocket();

    const { selectedTaskId, tasks, setShowProjectPicker, chatMessages, chatTyping, isConnected, isServerReloading, supervisorEnabled } = useTaskStore();
    const selectedTask = selectedTaskId ? tasks.get(selectedTaskId) : null;

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
    const [showChatPanel, setShowChatPanel] = useState(false);
    const sidebarRef = useRef<HTMLElement>(null);

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

        // Dispatch scroll-to-bottom event for the task's terminal
        // Use setTimeout to ensure the terminal has time to mount/update
        setTimeout(() => {
            window.dispatchEvent(new CustomEvent('terminal:scrollToBottom', {
                detail: { taskId }
            }));
        }, 100);
    };

    // Count unread messages indicator
    const hasUnreadMessages = chatMessages.length > 0 && !showChatPanel;

    // Close chat panel if supervisor is disabled
    useEffect(() => {
        if (!supervisorEnabled && showChatPanel) {
            setShowChatPanel(false);
        }
    }, [supervisorEnabled, showChatPanel]);

    return (
        <div className="app">
            <header className="app-header">
                <div className="logo">
                    <Terminal size={24} />
                    <h1>Claudia</h1>
                </div>
                <div className="header-controls">
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
                    <button
                        className="settings-button"
                        onClick={() => setShowSettings(true)}
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
                        onDeleteTask={destroyTask}
                        onInterruptTask={interruptTask}
                        onArchiveTask={archiveTask}
                        onCreateWorkspace={createWorkspace}
                        onDeleteWorkspace={deleteWorkspace}
                        onCreateTask={createTask}
                        onSelectTask={handleSelectTask}
                    />
                </aside>

                <div
                    className={`resize-handle ${isResizing ? 'resizing' : ''}`}
                    onMouseDown={handleMouseDown}
                />

                <section className="main-panel">
                    {selectedTask ? (
                        <TerminalView key={selectedTask.id} task={selectedTask} wsRef={wsRef} />
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
            <SettingsMenu isOpen={showSettings} onClose={() => setShowSettings(false)} />

            {/* Server reloading overlay */}
            {(isServerReloading || !isConnected) && (
                <div className="server-reload-overlay">
                    <div className="server-reload-content">
                        <RefreshCw className="spinning" size={32} />
                        <span>
                            {isServerReloading
                                ? 'Backend is restarting...'
                                : 'Reconnecting to backend...'}
                        </span>
                    </div>
                </div>
            )}
        </div>
    );
}

export default App;
