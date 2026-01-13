import { useState, useRef, useEffect } from 'react';
import { WorkspacePanel } from './components/WorkspacePanel';
import { ChatPanel } from './components/ChatPanel';
import { TerminalPanel } from './components/TerminalPanel';
import { ConversationPicker } from './components/ConversationPicker';
import { ProjectPicker } from './components/ProjectPicker';
import { ConfigPanel } from './components/ConfigPanel';
import { VoiceSettings } from './components/VoiceSettings';
import { NotificationProvider } from './components/NotificationContainer';
import { useWebSocket } from './hooks/useWebSocket';
import { useTaskStore } from './stores/taskStore';
import { Sparkles, Settings, ToggleLeft, ToggleRight, ClipboardList, Zap, Mic } from 'lucide-react';

const SIDEBAR_WIDTH_KEY = 'claudia-sidebar-width';
const DEFAULT_SIDEBAR_WIDTH = 300;

function App() {
    const {
        sendChatMessage,
        selectConversation,
        sendDeleteTask,
        sendClearTasks,
        sendClearChat,
        approvePlan,
        rejectPlan,
        sendAutoApproveUpdate,
        createWorkspace,
        deleteWorkspace,
        setActiveWorkspace,
        sendTaskInput,
        sendStopTask,
        createTask
    } = useWebSocket();
    const { selectedTaskId, autoApproveEnabled, toggleAutoApprove, setShowProjectPicker, voiceEnabled } = useTaskStore();
    const [configOpen, setConfigOpen] = useState(false);
    const [voiceSettingsOpen, setVoiceSettingsOpen] = useState(false);
    const [sidebarWidth, setSidebarWidth] = useState(() => {
        try {
            const savedWidth = localStorage.getItem(SIDEBAR_WIDTH_KEY);
            return savedWidth ? parseInt(savedWidth, 10) : DEFAULT_SIDEBAR_WIDTH;
        } catch {
            return DEFAULT_SIDEBAR_WIDTH;
        }
    });
    const [isResizing, setIsResizing] = useState(false);
    const sidebarRef = useRef<HTMLElement>(null);

    const handleMouseDown = () => {
        setIsResizing(true);
    };

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isResizing) return;

            const newWidth = e.clientX;
            const minWidth = 200;
            const maxWidth = 600;

            if (newWidth >= minWidth && newWidth <= maxWidth) {
                setSidebarWidth(newWidth);
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
            // Silently fail if localStorage is not available
        }
    }, [sidebarWidth]);

    // Handle project selection - creates a workspace from the folder path
    const handleProjectSelect = (path: string) => {
        createWorkspace(path);
        setShowProjectPicker(false);
    };

    return (
        <NotificationProvider>
            <div className="app">
                <header className="app-header">
                    <div className="logo">
                        <Sparkles size={24} />
                        <h1>Claudia</h1>
                    </div>
                    <div className="header-controls">
                        <div
                            className={`mode-toggle ${!autoApproveEnabled ? 'plan-mode' : 'normal-mode'}`}
                            onClick={() => {
                                toggleAutoApprove();
                                sendAutoApproveUpdate(!autoApproveEnabled);
                            }}
                            title={!autoApproveEnabled ? 'Plan Mode: Review before execution' : 'Normal Mode: Execute immediately'}
                        >
                            {!autoApproveEnabled ? <ClipboardList size={16} /> : <Zap size={16} />}
                            <span>{!autoApproveEnabled ? 'Plan Mode' : 'Normal Mode'}</span>
                            {!autoApproveEnabled ? <ToggleRight size={20} /> : <ToggleLeft size={20} />}
                        </div>
                        <button
                            className={`voice-settings-button ${voiceEnabled ? 'active' : ''}`}
                            onClick={() => setVoiceSettingsOpen(true)}
                            title="Voice Settings"
                        >
                            <Mic size={20} />
                        </button>
                        <button
                            className="settings-button"
                            onClick={() => setConfigOpen(true)}
                            title="Orchestrator Settings"
                        >
                            <Settings size={20} />
                        </button>
                    </div>
                </header>

                <main className="app-main">
                    <aside className="sidebar" ref={sidebarRef} style={{ width: `${sidebarWidth}px`, minWidth: `${sidebarWidth}px` }}>
                        <WorkspacePanel
                            onDeleteTask={sendDeleteTask}
                            onClearTasks={sendClearTasks}
                            onCreateWorkspace={createWorkspace}
                            onDeleteWorkspace={deleteWorkspace}
                            onStopTask={sendStopTask}
                            onCreateTask={createTask}
                        />
                    </aside>

                    <div
                        className={`resize-handle ${isResizing ? 'resizing' : ''}`}
                        onMouseDown={handleMouseDown}
                    />

                    <section className="main-panel">
                        {selectedTaskId ? (
                            <TerminalPanel
                                onSendInput={sendTaskInput}
                                onStopTask={sendStopTask}
                            />
                        ) : (
                            <ChatPanel
                                onSendMessage={sendChatMessage}
                                onClearChat={sendClearChat}
                                onApprovePlan={approvePlan}
                                onRejectPlan={rejectPlan}
                                onSetActiveWorkspace={setActiveWorkspace}
                            />
                        )}
                    </section>
                </main>

                {/* Conversation selection modal */}
                <ConversationPicker onSelect={selectConversation} />

                {/* Project picker modal - used for adding workspaces */}
                <ProjectPicker onSelect={handleProjectSelect} />

                {/* Config panel modal */}
                <ConfigPanel isOpen={configOpen} onClose={() => setConfigOpen(false)} />

                {/* Voice settings modal */}
                {voiceSettingsOpen && <VoiceSettings onClose={() => setVoiceSettingsOpen(false)} />}
            </div>
        </NotificationProvider>
    );
}

export default App;
