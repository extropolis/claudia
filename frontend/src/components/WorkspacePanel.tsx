import { useState, useRef, useEffect } from 'react';
import { useTaskStore } from '../stores/taskStore';
import { Task, Workspace } from '@claudia/shared';
import {
    Loader2, Square, Circle, ChevronRight, ChevronDown,
    Trash2, FolderOpen, Plus, Briefcase, Send, AlertCircle, StopCircle, Undo2
} from 'lucide-react';
import { VoiceInput, VoiceInputHandle } from './VoiceInput';
import './WorkspacePanel.css';

// Simple notification sound using Web Audio API
function playNotificationSound() {
    try {
        const audioContext = new (window.AudioContext || (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);

        oscillator.frequency.value = 800;
        oscillator.type = 'sine';
        gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);

        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + 0.3);
    } catch (e) {
        console.warn('Could not play notification sound:', e);
    }
}

interface StateIconProps {
    task: Task;
    hasActiveQuestion: boolean;
    onArchive?: () => void;
}

function StateIcon({ task, hasActiveQuestion, onArchive }: StateIconProps) {
    if (task.state === 'busy') {
        return <Loader2 className="status-icon spinning" size={14} />;
    }

    if (task.state === 'interrupted') {
        return <AlertCircle className="status-icon interrupted" size={14} />;
    }

    // Show "!" if waiting for input OR if there's an active question from backend
    if (task.state === 'waiting_input' || hasActiveQuestion) {
        return <span className="status-icon question-icon">!</span>;
    }

    if (task.state === 'idle') {
        // Task is idle and not asking questions - show checkbox to archive
        return (
            <button
                className="archive-checkbox-btn"
                onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    onArchive?.();
                }}
                title="Archive task"
            >
                <Square
                    className="status-icon idle archive-checkbox"
                    size={14}
                />
            </button>
        );
    }

    return <Circle className="status-icon" size={14} />;
}

interface TaskItemProps {
    task: Task;
    onDeleteTask: (taskId: string) => void;
    onInterruptTask: (taskId: string) => void;
    onArchiveTask: (taskId: string) => void;
    onRevertTask: (taskId: string) => void;
    onSelectTask: (taskId: string) => void;
    isSelected: boolean;
    hasActiveQuestion: boolean;
}

function TaskItem({ task, onDeleteTask, onInterruptTask, onArchiveTask, onRevertTask, onSelectTask, isSelected, hasActiveQuestion }: TaskItemProps) {
    const [stopClicked, setStopClicked] = useState(false);

    // Reset stopClicked when task state changes from busy
    useEffect(() => {
        if (task.state !== 'busy') {
            setStopClicked(false);
        }
    }, [task.state]);

    // Split prompt by ⏺ dots and get the last segment for display
    const segments = task.prompt.split('⏺').map(s => s.trim()).filter(Boolean);
    const lastSegment = segments.length > 0 ? segments[segments.length - 1] : task.prompt;

    // CSS handles visual truncation with line-clamp
    const displayPrompt = lastSegment;

    const canInterrupt = task.state === 'busy' && !stopClicked;

    return (
        <div
            className={`task-item ${isSelected ? 'selected' : ''} ${task.state} ${hasActiveQuestion ? 'has-question' : ''}`}
            onClick={() => onSelectTask(task.id)}
        >
            <StateIcon task={task} hasActiveQuestion={hasActiveQuestion} onArchive={() => onArchiveTask(task.id)} />
            <span className="task-prompt" title={task.prompt}>{displayPrompt}</span>
            <div className="task-actions">
                {canInterrupt && (
                    <button
                        className="task-action-button stop"
                        onClick={(e) => {
                            e.stopPropagation();
                            setStopClicked(true);
                            onInterruptTask(task.id);
                        }}
                        title="Stop task"
                    >
                        <StopCircle size={12} />
                    </button>
                )}
                {task.gitState?.canRevert && (
                    <button
                        className="task-action-button revert"
                        onClick={(e) => {
                            e.stopPropagation();
                            onRevertTask(task.id);
                        }}
                        title={`Revert changes (${task.gitState.filesModified.length} files)`}
                    >
                        <Undo2 size={12} />
                    </button>
                )}
                <button
                    className="task-action-button delete"
                    onClick={(e) => { e.stopPropagation(); onDeleteTask(task.id); }}
                    title="Delete task"
                >
                    <Trash2 size={12} />
                </button>
            </div>
        </div>
    );
}

interface WorkspaceSectionProps {
    workspace: Workspace;
    tasks: Task[];
    waitingInputTaskIds: Set<string>;
    selectedTaskId: string | null;
    isExpanded: boolean;
    onToggleExpand: () => void;
    onDeleteTask: (taskId: string) => void;
    onInterruptTask: (taskId: string) => void;
    onArchiveTask: (taskId: string) => void;
    onRevertTask: (taskId: string) => void;
    onSelectTask: (taskId: string) => void;
    onDeleteWorkspace: () => void;
    onCreateTask: (prompt: string) => void;
}

function WorkspaceSection({
    workspace,
    tasks,
    waitingInputTaskIds,
    selectedTaskId,
    isExpanded,
    onToggleExpand,
    onDeleteTask,
    onInterruptTask,
    onArchiveTask,
    onRevertTask,
    onSelectTask,
    onDeleteWorkspace,
    onCreateTask
}: WorkspaceSectionProps) {
    const [inputValue, setInputValue] = useState('');
    const [interimTranscript, setInterimTranscript] = useState('');
    const voiceInputRef = useRef<VoiceInputHandle>(null);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        // Stop voice recording when submitting
        voiceInputRef.current?.stopListening();
        if (inputValue.trim()) {
            onCreateTask(inputValue.trim());
            setInputValue('');
            setInterimTranscript('');
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit(e);
        }
    };

    const handleVoiceTranscript = (text: string, isFinal: boolean) => {
        if (isFinal) {
            setInputValue(prev => (prev ? prev + ' ' : '') + text);
            setInterimTranscript('');
        } else {
            setInterimTranscript(text);
        }
    };

    return (
        <div className="workspace-section">
            <div className="workspace-header">
                <div className="workspace-header-left" onClick={onToggleExpand}>
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <Briefcase size={16} className="workspace-icon" />
                    <span className="workspace-name" title={workspace.id}>{workspace.name}</span>
                    {tasks.length > 0 && (
                        <span className="workspace-task-count">{tasks.length}</span>
                    )}
                </div>
                <button
                    className="workspace-action-button delete"
                    onClick={(e) => { e.stopPropagation(); onDeleteWorkspace(); }}
                    title="Remove workspace"
                >
                    <Trash2 size={14} />
                </button>
            </div>
            {isExpanded && (
                <div className="workspace-content">
                    {tasks.length === 0 ? (
                        <div className="empty-tasks">No tasks yet</div>
                    ) : (
                        <div className="task-list">
                            {tasks.map(task => (
                                <TaskItem
                                    key={task.id}
                                    task={task}
                                    isSelected={selectedTaskId === task.id}
                                    hasActiveQuestion={waitingInputTaskIds.has(task.id)}
                                    onDeleteTask={onDeleteTask}
                                    onInterruptTask={onInterruptTask}
                                    onArchiveTask={onArchiveTask}
                                    onRevertTask={onRevertTask}
                                    onSelectTask={onSelectTask}
                                />
                            ))}
                        </div>
                    )}
                    <form className="task-input-form" onSubmit={handleSubmit}>
                        <div className="task-input-row">
                            <div className="task-input-wrapper">
                                <textarea
                                    className="task-input"
                                    placeholder="Type or speak a task..."
                                    value={inputValue + (interimTranscript ? (inputValue ? ' ' : '') + interimTranscript : '')}
                                    onChange={(e) => {
                                        setInputValue(e.target.value);
                                        setInterimTranscript('');
                                    }}
                                    onKeyDown={handleKeyDown}
                                    rows={2}
                                />
                                {interimTranscript && (
                                    <span className="interim-indicator">listening...</span>
                                )}
                            </div>
                            <VoiceInput
                                ref={voiceInputRef}
                                onTranscript={handleVoiceTranscript}
                                className="task-voice-button"
                                continuous={true}
                            />
                            <button
                                type="submit"
                                className="task-submit-button"
                                disabled={!inputValue.trim() && !interimTranscript.trim()}
                            >
                                <Send size={16} />
                            </button>
                        </div>
                    </form>
                </div>
            )}
        </div>
    );
}

interface WorkspacePanelProps {
    onDeleteTask: (taskId: string) => void;
    onInterruptTask: (taskId: string) => void;
    onArchiveTask: (taskId: string) => void;
    onRevertTask: (taskId: string) => void;
    onCreateWorkspace: (path: string) => void;
    onDeleteWorkspace: (workspaceId: string) => void;
    onCreateTask: (prompt: string, workspaceId: string) => void;
    onSelectTask: (taskId: string) => void;
}

export function WorkspacePanel({
    onDeleteTask,
    onInterruptTask,
    onArchiveTask,
    onRevertTask,
    onDeleteWorkspace,
    onCreateTask,
    onSelectTask
}: WorkspacePanelProps) {
    const {
        tasks,
        workspaces,
        selectedTaskId,
        expandedWorkspaces,
        toggleWorkspaceExpanded,
        setShowProjectPicker,
        waitingInputNotifications
    } = useTaskStore();

    const prevWaitingRef = useRef<Set<string>>(new Set());

    // Play sound when a new task starts waiting for input
    useEffect(() => {
        const currentWaiting = new Set(waitingInputNotifications.keys());
        const prevWaiting = prevWaitingRef.current;

        // Check for newly added waiting tasks
        for (const taskId of currentWaiting) {
            if (!prevWaiting.has(taskId)) {
                // New task waiting for input - play sound
                playNotificationSound();
                break; // Only play once even if multiple new
            }
        }

        prevWaitingRef.current = currentWaiting;
    }, [waitingInputNotifications]);

    const handleAddWorkspace = () => {
        setShowProjectPicker(true);
    };

    // Get task IDs that have active questions
    const waitingInputTaskIds = new Set(waitingInputNotifications.keys());

    // Group tasks by workspace, sorted by creation time (newest first)
    const getTasksForWorkspace = (workspaceId: string): Task[] => {
        return Array.from(tasks.values())
            .filter(t => t.workspaceId === workspaceId)
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    };

    return (
        <div className="workspace-panel">
            <div className="workspace-panel-header">
                <h2>Workspaces</h2>
                <button
                    className="add-workspace-button"
                    onClick={handleAddWorkspace}
                    title="Add workspace"
                >
                    <Plus size={16} />
                </button>
            </div>

            <div className="workspace-panel-content">
                {workspaces.length === 0 ? (
                    <div className="empty-state">
                        <p>No workspaces yet.</p>
                        <button
                            className="create-first-workspace-btn"
                            onClick={handleAddWorkspace}
                        >
                            <FolderOpen size={14} /> Add Workspace
                        </button>
                    </div>
                ) : (
                    workspaces.map(workspace => (
                        <WorkspaceSection
                            key={workspace.id}
                            workspace={workspace}
                            tasks={getTasksForWorkspace(workspace.id)}
                            waitingInputTaskIds={waitingInputTaskIds}
                            selectedTaskId={selectedTaskId}
                            isExpanded={expandedWorkspaces.has(workspace.id)}
                            onToggleExpand={() => toggleWorkspaceExpanded(workspace.id)}
                            onDeleteTask={onDeleteTask}
                            onInterruptTask={onInterruptTask}
                            onArchiveTask={onArchiveTask}
                            onRevertTask={onRevertTask}
                            onSelectTask={onSelectTask}
                            onDeleteWorkspace={() => onDeleteWorkspace(workspace.id)}
                            onCreateTask={(prompt) => onCreateTask(prompt, workspace.id)}
                        />
                    ))
                )}
            </div>
        </div>
    );
}
