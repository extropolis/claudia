import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useTaskStore } from '../stores/taskStore';
import { Task, Workspace } from '@claudia/shared';
import {
    Loader2, Square, Circle, ChevronRight, ChevronDown,
    Trash2, FolderOpen, Plus, Briefcase, Send, AlertCircle, StopCircle, Undo2, GripVertical, Archive, RotateCcw, Play, MoreVertical, Terminal, Search, GitBranch, ImagePlus, X, FileText, GripHorizontal
} from 'lucide-react';
import { getApiBaseUrl } from '../config/api-config';
import { SystemPromptModal } from './SystemPromptModal';
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
    // Show play icon for tasks that haven't actually started yet
    // This indicates the user may need to press Enter manually
    if (task.state === 'starting') {
        return (
            <span title="Waiting to start - may need Enter key">
                <Play className="status-icon starting" size={14} />
            </span>
        );
    }

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
    index: number;
    onDeleteTask: (taskId: string) => void;
    onInterruptTask: (taskId: string) => void;
    onArchiveTask: (taskId: string) => void;
    onRevertTask: (taskId: string) => void;
    onSelectTask: (taskId: string) => void;
    isSelected: boolean;
    hasActiveQuestion: boolean;
    // Drag and drop
    isDragging: boolean;
    dragIndex: number | null;
    dragOverIndex: number | null;
    onDragStart: (index: number) => void;
    onDragEnter: (index: number) => void;
    onDragEnd: () => void;
}

function TaskItem({ task, index, onDeleteTask, onInterruptTask, onArchiveTask, onRevertTask, onSelectTask, isSelected, hasActiveQuestion, isDragging, dragIndex, dragOverIndex, onDragStart, onDragEnter, onDragEnd }: TaskItemProps) {
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
    const isBeingDragged = dragIndex === index;
    const isDropTarget = dragOverIndex === index && isDragging && !isBeingDragged;

    const taskItemRef = useRef<HTMLDivElement>(null);

    return (
        <div
            ref={taskItemRef}
            className={`task-item ${isSelected ? 'selected' : ''} ${task.state} ${hasActiveQuestion ? 'has-question' : ''} ${isBeingDragged ? 'dragging' : ''} ${isDropTarget ? 'drop-target' : ''}`}
            draggable
            onClick={() => onSelectTask(task.id)}
            onDragStart={(e) => {
                // Set the drag image to be the entire task item
                if (taskItemRef.current) {
                    e.dataTransfer.setDragImage(taskItemRef.current, 10, 10);
                }
                e.dataTransfer.effectAllowed = 'move';
                onDragStart(index);
            }}
            onDragEnd={onDragEnd}
            onDragOver={(e) => e.preventDefault()}
            onDragEnter={() => onDragEnter(index)}
        >
            <div className="task-drag-handle">
                <GripVertical size={12} />
            </div>
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
                            const fileCount = task.gitState?.filesModified.length || 0;
                            if (window.confirm(`Are you sure you want to revert ${fileCount} file${fileCount !== 1 ? 's' : ''}? This cannot be undone.`)) {
                                onRevertTask(task.id);
                            }
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

interface UploadedImage {
    filename: string;
    filePath: string;
    originalName: string;
    previewUrl: string;
}

interface WorkspaceSectionProps {
    workspace: Workspace;
    tasks: Task[];
    waitingInputTaskIds: Set<string>;
    selectedTaskId: string | null;
    isExpanded: boolean;
    index: number;
    // Workspace drag state
    isDragging: boolean;
    dragOverIndex: number | null;
    isMenuOpen: boolean;
    onToggleExpand: () => void;
    onDeleteTask: (taskId: string) => void;
    onInterruptTask: (taskId: string) => void;
    onArchiveTask: (taskId: string) => void;
    onRevertTask: (taskId: string) => void;
    onSelectTask: (taskId: string) => void;
    onDeleteWorkspace: () => void;
    onOpenFolder: () => void;
    onOpenTerminal: () => void;
    onPushToGithub: () => void;
    onSystemPrompt: () => void;
    onToggleMenu: () => void;
    onCreateTask: (prompt: string) => void;
    // Workspace drag handlers
    onDragStart: (index: number) => void;
    onDragEnter: (index: number) => void;
    onDragEnd: () => void;
    // Task reordering
    onReorderTasks: (fromIndex: number, toIndex: number) => void;
}

function WorkspaceSection({
    workspace,
    tasks,
    waitingInputTaskIds,
    selectedTaskId,
    isExpanded,
    index,
    isDragging,
    dragOverIndex,
    isMenuOpen,
    onToggleExpand,
    onDeleteTask,
    onInterruptTask,
    onArchiveTask,
    onRevertTask,
    onSelectTask,
    onDeleteWorkspace,
    onOpenFolder,
    onOpenTerminal,
    onPushToGithub,
    onSystemPrompt,
    onToggleMenu,
    onCreateTask,
    onDragStart,
    onDragEnter,
    onDragEnd,
    onReorderTasks
}: WorkspaceSectionProps) {
    const [inputValue, setInputValue] = useState('');
    const [images, setImages] = useState<UploadedImage[]>([]);
    const [isImageDragging, setIsImageDragging] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Task list resize state
    const [taskListHeight, setTaskListHeight] = useState<number | null>(null);
    const [isResizing, setIsResizing] = useState(false);
    const taskListRef = useRef<HTMLDivElement>(null);

    // Task drag state (separate from workspace drag)
    const [taskDragIndex, setTaskDragIndex] = useState<number | null>(null);
    const [taskDragOverIndex, setTaskDragOverIndex] = useState<number | null>(null);

    const handleTaskDragStart = useCallback((idx: number) => {
        setTaskDragIndex(idx);
        setTaskDragOverIndex(idx);
    }, []);

    const handleTaskDragEnter = useCallback((idx: number) => {
        if (taskDragIndex !== null) {
            setTaskDragOverIndex(idx);
        }
    }, [taskDragIndex]);

    const handleTaskDragEnd = useCallback(() => {
        if (taskDragIndex !== null && taskDragOverIndex !== null && taskDragIndex !== taskDragOverIndex) {
            onReorderTasks(taskDragIndex, taskDragOverIndex);
        }
        setTaskDragIndex(null);
        setTaskDragOverIndex(null);
    }, [taskDragIndex, taskDragOverIndex, onReorderTasks]);

    // Task list resize handlers
    const handleResizeStart = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        setIsResizing(true);

        const startY = e.clientY;
        const startHeight = taskListRef.current?.offsetHeight || 160;

        const handleMouseMove = (moveEvent: MouseEvent) => {
            const delta = moveEvent.clientY - startY;
            const newHeight = Math.max(64, Math.min(400, startHeight + delta)); // Min 64px (~2 tasks), Max 400px
            setTaskListHeight(newHeight);
        };

        const handleMouseUp = () => {
            setIsResizing(false);
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    }, []);

    const {
        globalVoiceEnabled,
        focusedInputId,
        voiceTranscript,
        voiceInterimTranscript,
        setFocusedInputId,
        consumeVoiceTranscript,
        clearVoiceTranscript
    } = useTaskStore();

    const inputId = `new-task-${workspace.id}`;
    const isFocused = focusedInputId === inputId;

    // Upload image to server
    const uploadImage = async (file: File): Promise<UploadedImage | null> => {
        const formData = new FormData();
        formData.append('image', file);

        try {
            const response = await fetch(`${getApiBaseUrl()}/api/upload/image`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Upload failed');
            }

            const result = await response.json();
            return {
                filename: result.filename,
                filePath: result.filePath,
                originalName: result.originalName,
                previewUrl: URL.createObjectURL(file)
            };
        } catch (error) {
            console.error('Image upload failed:', error);
            setUploadError(error instanceof Error ? error.message : 'Upload failed');
            setTimeout(() => setUploadError(null), 3000);
            return null;
        }
    };

    // Delete image from server
    const deleteImage = async (image: UploadedImage) => {
        try {
            await fetch(`${getApiBaseUrl()}/api/upload/image/${image.filename}`, {
                method: 'DELETE'
            });
        } catch (error) {
            console.error('Failed to delete image:', error);
        }
        URL.revokeObjectURL(image.previewUrl);
        setImages(prev => prev.filter(img => img.filename !== image.filename));
    };

    // Handle file selection
    const handleFileSelect = async (files: FileList | null) => {
        if (!files) return;

        const imageFiles = Array.from(files).filter(file =>
            file.type.startsWith('image/')
        );

        for (const file of imageFiles) {
            const uploaded = await uploadImage(file);
            if (uploaded) {
                setImages(prev => [...prev, uploaded]);
            }
        }
    };

    // Image drag and drop handlers
    const handleImageDragEnter = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer.types.includes('Files')) {
            setIsImageDragging(true);
        }
    };

    const handleImageDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setIsImageDragging(false);
        }
    };

    const handleImageDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const handleImageDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsImageDragging(false);

        const files = e.dataTransfer.files;
        await handleFileSelect(files);
    };

    // Cleanup preview URLs on unmount
    useEffect(() => {
        return () => {
            images.forEach(img => URL.revokeObjectURL(img.previewUrl));
        };
    }, []);

    // Append voice transcript to input when this input is focused
    useEffect(() => {
        if (isFocused && voiceTranscript) {
            setInputValue(prev => (prev ? prev + ' ' : '') + voiceTranscript);
            consumeVoiceTranscript();
        }
    }, [isFocused, voiceTranscript, consumeVoiceTranscript]);

    const handleSubmit = useCallback((e?: React.FormEvent) => {
        e?.preventDefault();
        if (globalVoiceEnabled) {
            clearVoiceTranscript();
        }
        if (inputValue.trim() || images.length > 0) {
            // Build the message with image paths
            let fullMessage = inputValue;
            if (images.length > 0) {
                const imagePaths = images.map(img => img.filePath).join('\n');
                const imageText = images.length === 1
                    ? `\n\n[Attached image: ${imagePaths}]`
                    : `\n\n[Attached images:\n${imagePaths}]`;
                fullMessage = inputValue + imageText;
            }
            onCreateTask(fullMessage.trim());
            setInputValue('');
            // Clear images after sending
            images.forEach(img => URL.revokeObjectURL(img.previewUrl));
            setImages([]);
        }
    }, [inputValue, images, globalVoiceEnabled, clearVoiceTranscript, onCreateTask]);

    // Listen for auto-send event
    useEffect(() => {
        const handleAutoSend = (e: CustomEvent<{ inputId: string }>) => {
            if (e.detail.inputId === inputId && inputValue.trim()) {
                handleSubmit();
            }
        };

        window.addEventListener('voice:autoSend', handleAutoSend as EventListener);
        return () => {
            window.removeEventListener('voice:autoSend', handleAutoSend as EventListener);
        };
    }, [inputId, inputValue, handleSubmit]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    const handleFocus = () => {
        setFocusedInputId(inputId);
    };

    const handleBlur = () => {
        setTimeout(() => {
            const currentFocused = useTaskStore.getState().focusedInputId;
            if (currentFocused === inputId) {
                setFocusedInputId(null);
            }
        }, 100);
    };

    // Show interim transcript when focused and listening
    const showInterim = globalVoiceEnabled && isFocused && voiceInterimTranscript;

    const isDropTarget = dragOverIndex === index && isDragging;

    return (
        <div
            className={`workspace-section ${isDragging ? 'dragging' : ''} ${isDropTarget ? 'drop-target' : ''}`}
            onDragOver={(e) => e.preventDefault()}
            onDragEnter={() => onDragEnter(index)}
        >
            <div className="workspace-header">
                <div
                    className="workspace-drag-handle"
                    draggable
                    onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = 'move';
                        onDragStart(index);
                    }}
                    onDragEnd={onDragEnd}
                >
                    <GripVertical size={14} />
                </div>
                <div className="workspace-header-left" onClick={onToggleExpand}>
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <Briefcase size={16} className="workspace-icon" />
                    <span className="workspace-name" title={workspace.id}>{workspace.name}</span>
                    {tasks.length > 0 && (
                        <span className="workspace-task-count">{tasks.length}</span>
                    )}
                </div>
                <div className="workspace-menu-container">
                    <button
                        className={`workspace-action-button menu ${isMenuOpen ? 'active' : ''}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            onToggleMenu();
                        }}
                        title="Workspace settings"
                    >
                        <MoreVertical size={14} />
                    </button>
                    {isMenuOpen && (
                        <div className="workspace-dropdown-menu">
                            <button
                                className="workspace-dropdown-item"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onOpenFolder();
                                    onToggleMenu();
                                }}
                            >
                                <FolderOpen size={14} />
                                <span>Open in Finder</span>
                            </button>
                            <button
                                className="workspace-dropdown-item"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onOpenTerminal();
                                    onToggleMenu();
                                }}
                            >
                                <Terminal size={14} />
                                <span>Open in Terminal</span>
                            </button>
                            <button
                                className="workspace-dropdown-item"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onPushToGithub();
                                    onToggleMenu();
                                }}
                            >
                                <GitBranch size={14} />
                                <span>Push to GitHub</span>
                            </button>
                            <div className="workspace-dropdown-divider" />
                            <button
                                className="workspace-dropdown-item"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onSystemPrompt();
                                    onToggleMenu();
                                }}
                            >
                                <FileText size={14} />
                                <span>System Prompt</span>
                            </button>
                            <button
                                className="workspace-dropdown-item"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onCreateTask('Do a code review of this project. Analyze the codebase structure, identify potential issues, suggest improvements, and provide actionable feedback.');
                                    onToggleMenu();
                                }}
                            >
                                <Search size={14} />
                                <span>Code Review</span>
                            </button>
                            <div className="workspace-dropdown-divider" />
                            <button
                                className="workspace-dropdown-item delete"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    if (window.confirm(`Remove workspace "${workspace.name}"? Tasks will not be deleted.`)) {
                                        onDeleteWorkspace();
                                    }
                                    onToggleMenu();
                                }}
                            >
                                <Trash2 size={14} />
                                <span>Remove Workspace</span>
                            </button>
                        </div>
                    )}
                </div>
            </div>
            {isExpanded && (
                <div className="workspace-content">
                    {tasks.length === 0 ? (
                        <div className="empty-tasks">No tasks yet</div>
                    ) : (
                        <div className="task-list-container">
                            <div
                                ref={taskListRef}
                                className={`task-list ${isResizing ? 'resizing' : ''}`}
                                style={taskListHeight ? { maxHeight: `${taskListHeight}px` } : undefined}
                            >
                                {tasks.map((task, idx) => (
                                    <TaskItem
                                        key={task.id}
                                        task={task}
                                        index={idx}
                                        isSelected={selectedTaskId === task.id}
                                        hasActiveQuestion={waitingInputTaskIds.has(task.id)}
                                        onDeleteTask={onDeleteTask}
                                        onInterruptTask={onInterruptTask}
                                        onArchiveTask={onArchiveTask}
                                        onRevertTask={onRevertTask}
                                        onSelectTask={onSelectTask}
                                        isDragging={taskDragIndex !== null}
                                        dragIndex={taskDragIndex}
                                        dragOverIndex={taskDragOverIndex}
                                        onDragStart={handleTaskDragStart}
                                        onDragEnter={handleTaskDragEnter}
                                        onDragEnd={handleTaskDragEnd}
                                    />
                                ))}
                            </div>
                            <div
                                className="task-list-resize-handle"
                                onMouseDown={handleResizeStart}
                                title="Drag to resize task list"
                            >
                                <GripHorizontal size={12} />
                            </div>
                        </div>
                    )}
                    <form
                        className={`task-input-form ${isImageDragging ? 'dragging' : ''}`}
                        onSubmit={handleSubmit}
                        onDragEnter={handleImageDragEnter}
                        onDragLeave={handleImageDragLeave}
                        onDragOver={handleImageDragOver}
                        onDrop={handleImageDrop}
                    >
                        {/* Image previews */}
                        {images.length > 0 && (
                            <div className="new-task-images">
                                {images.map(img => (
                                    <div key={img.filename} className="new-task-image-preview">
                                        <img src={img.previewUrl} alt={img.originalName} />
                                        <button
                                            type="button"
                                            className="new-task-image-remove"
                                            onClick={() => deleteImage(img)}
                                            title="Remove image"
                                        >
                                            <X size={12} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Upload error message */}
                        {uploadError && (
                            <div className="new-task-upload-error">{uploadError}</div>
                        )}

                        {/* Drop zone overlay */}
                        {isImageDragging && (
                            <div className="new-task-dropzone">
                                <ImagePlus size={24} />
                                <span>Drop images here</span>
                            </div>
                        )}

                        <div className="task-input-row">
                            <div className={`task-input-wrapper ${isFocused && globalVoiceEnabled ? 'voice-active' : ''}`}>
                                <textarea
                                    className="task-input"
                                    placeholder="Type or speak a task..."
                                    value={inputValue}
                                    onChange={(e) => setInputValue(e.target.value)}
                                    onKeyDown={handleKeyDown}
                                    onFocus={handleFocus}
                                    onBlur={handleBlur}
                                    rows={2}
                                />
                                {showInterim && (
                                    <span className="interim-indicator">{voiceInterimTranscript}</span>
                                )}
                            </div>
                            {/* Image upload button */}
                            <button
                                type="button"
                                onClick={() => fileInputRef.current?.click()}
                                className="task-image-button"
                                title="Attach image"
                            >
                                <ImagePlus size={16} />
                            </button>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/*"
                                multiple
                                onChange={(e) => handleFileSelect(e.target.files)}
                                style={{ display: 'none' }}
                            />
                            <button
                                type="submit"
                                className="task-submit-button"
                                disabled={!inputValue.trim() && images.length === 0}
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

interface ArchivedTaskItemProps {
    task: Task;
    onContinue: (taskId: string) => void;
    onRestore: (taskId: string) => void;
    onDelete: (taskId: string) => void;
}

function ArchivedTaskItem({ task, onContinue, onRestore, onDelete }: ArchivedTaskItemProps) {
    // Split prompt by ⏺ dots and get the last segment for display
    const segments = task.prompt.split('⏺').map(s => s.trim()).filter(Boolean);
    const lastSegment = segments.length > 0 ? segments[segments.length - 1] : task.prompt;

    // Format date
    const archivedDate = new Date(task.lastActivity).toLocaleDateString();

    const handleClick = (e: React.MouseEvent) => {
        // Don't trigger if clicking on action buttons
        if ((e.target as HTMLElement).closest('.archived-task-actions')) {
            return;
        }
        onContinue(task.id);
    };

    return (
        <div className="archived-task-item" onClick={handleClick}>
            <div className="archived-task-info">
                <span className="archived-task-prompt" title={task.prompt}>{lastSegment}</span>
                <span className="archived-task-date">{archivedDate}</span>
            </div>
            <div className="archived-task-actions">
                <button
                    className="task-action-button restore"
                    onClick={() => onRestore(task.id)}
                    title="Restore to task list (without opening)"
                >
                    <RotateCcw size={12} />
                </button>
                <button
                    className="task-action-button delete"
                    onClick={() => {
                        if (window.confirm('Permanently delete this archived task? This cannot be undone.')) {
                            onDelete(task.id);
                        }
                    }}
                    title="Delete permanently"
                >
                    <Trash2 size={12} />
                </button>
            </div>
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
    onReorderWorkspaces: (fromIndex: number, toIndex: number) => void;
    onOpenFolder: (workspaceId: string) => void;
    onOpenTerminal: (workspaceId: string) => void;
    onPushToGithub: (workspaceId: string) => void;
    onSetSystemPrompt: (workspaceId: string, systemPrompt: string) => void;
    onCreateTask: (prompt: string, workspaceId: string) => void;
    onSelectTask: (taskId: string) => void;
    onRequestArchivedTasks?: () => void;
    onRestoreArchivedTask?: (taskId: string) => void;
    onDeleteArchivedTask?: (taskId: string) => void;
    onContinueArchivedTask?: (taskId: string) => void;
}

export function WorkspacePanel({
    onDeleteTask,
    onInterruptTask,
    onArchiveTask,
    onRevertTask,
    onDeleteWorkspace,
    onReorderWorkspaces,
    onOpenFolder,
    onOpenTerminal,
    onPushToGithub,
    onSetSystemPrompt,
    onCreateTask,
    onSelectTask,
    onRequestArchivedTasks,
    onRestoreArchivedTask,
    onDeleteArchivedTask,
    onContinueArchivedTask
}: WorkspacePanelProps) {
    const {
        tasks,
        workspaces,
        selectedTaskId,
        expandedWorkspaces,
        toggleWorkspaceExpanded,
        setShowProjectPicker,
        waitingInputNotifications,
        archivedTasks,
        showArchivedTasks,
        setShowArchivedTasks,
        reorderTasks
    } = useTaskStore();

    // Drag and drop state
    const [dragIndex, setDragIndex] = useState<number | null>(null);
    const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

    // Menu state - which workspace menu is open
    const [openMenuId, setOpenMenuId] = useState<string | null>(null);

    // System prompt modal state
    const [systemPromptWorkspace, setSystemPromptWorkspace] = useState<Workspace | null>(null);

    // Close menu when clicking outside
    useEffect(() => {
        if (!openMenuId) return;

        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (!target.closest('.workspace-menu-container')) {
                setOpenMenuId(null);
            }
        };

        document.addEventListener('click', handleClickOutside);
        return () => document.removeEventListener('click', handleClickOutside);
    }, [openMenuId]);

    const handleDragStart = useCallback((index: number) => {
        setDragIndex(index);
        setDragOverIndex(index);
    }, []);

    const handleDragEnter = useCallback((index: number) => {
        if (dragIndex !== null) {
            setDragOverIndex(index);
        }
    }, [dragIndex]);

    const handleDragEnd = useCallback(() => {
        if (dragIndex !== null && dragOverIndex !== null && dragIndex !== dragOverIndex) {
            // Send to backend - it will broadcast back to update local state
            onReorderWorkspaces(dragIndex, dragOverIndex);
        }
        setDragIndex(null);
        setDragOverIndex(null);
    }, [dragIndex, dragOverIndex, onReorderWorkspaces]);

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

    const handleToggleArchivedTasks = () => {
        const newShow = !showArchivedTasks;
        setShowArchivedTasks(newShow);
        if (newShow && onRequestArchivedTasks) {
            onRequestArchivedTasks();
        }
    };

    // Get task IDs that have active questions
    const waitingInputTaskIds = new Set(waitingInputNotifications.keys());

    // Group tasks by workspace, sorted by order (if set) then by creation time (newest first)
    const getTasksForWorkspace = (workspaceId: string): Task[] => {
        return Array.from(tasks.values())
            .filter(t => t.workspaceId === workspaceId)
            .sort((a, b) => {
                // If both have order, sort by order (ascending)
                if (a.order !== undefined && b.order !== undefined) {
                    return a.order - b.order;
                }
                // If only one has order, it comes first
                if (a.order !== undefined) return -1;
                if (b.order !== undefined) return 1;
                // Neither has order, sort by creation time (newest first)
                return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
            });
    };

    return (
        <div className="workspace-panel">
            <div className="workspace-panel-header">
                <h2>Workspaces</h2>
                <div className="workspace-panel-header-actions">
                    <button
                        className={`archived-toggle-button ${showArchivedTasks ? 'active' : ''}`}
                        onClick={handleToggleArchivedTasks}
                        title={showArchivedTasks ? 'Hide archived tasks' : 'Show archived tasks'}
                    >
                        <Archive size={16} />
                    </button>
                    <button
                        className="add-workspace-button"
                        onClick={handleAddWorkspace}
                        title="Add workspace"
                    >
                        <Plus size={16} />
                    </button>
                </div>
            </div>

            {showArchivedTasks && (
                <div className="archived-tasks-section">
                    <div className="archived-tasks-header">
                        <Archive size={14} />
                        <span>Archived Tasks</span>
                        <span className="archived-tasks-count">{archivedTasks.length}</span>
                    </div>
                    {archivedTasks.length === 0 ? (
                        <div className="empty-archived">No archived tasks</div>
                    ) : (
                        <div className="archived-task-list">
                            {archivedTasks.map(task => (
                                <ArchivedTaskItem
                                    key={task.id}
                                    task={task}
                                    onContinue={onContinueArchivedTask || (() => {})}
                                    onRestore={onRestoreArchivedTask || (() => {})}
                                    onDelete={onDeleteArchivedTask || (() => {})}
                                />
                            ))}
                        </div>
                    )}
                </div>
            )}

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
                    workspaces.map((workspace, index) => (
                        <WorkspaceSection
                            key={workspace.id}
                            workspace={workspace}
                            tasks={getTasksForWorkspace(workspace.id)}
                            waitingInputTaskIds={waitingInputTaskIds}
                            selectedTaskId={selectedTaskId}
                            isExpanded={expandedWorkspaces.has(workspace.id)}
                            index={index}
                            isDragging={dragIndex !== null}
                            dragOverIndex={dragOverIndex}
                            isMenuOpen={openMenuId === workspace.id}
                            onToggleExpand={() => toggleWorkspaceExpanded(workspace.id)}
                            onDeleteTask={onDeleteTask}
                            onInterruptTask={onInterruptTask}
                            onArchiveTask={onArchiveTask}
                            onRevertTask={onRevertTask}
                            onSelectTask={onSelectTask}
                            onDeleteWorkspace={() => onDeleteWorkspace(workspace.id)}
                            onOpenFolder={() => onOpenFolder(workspace.id)}
                            onOpenTerminal={() => onOpenTerminal(workspace.id)}
                            onPushToGithub={() => onPushToGithub(workspace.id)}
                            onSystemPrompt={() => setSystemPromptWorkspace(workspace)}
                            onToggleMenu={() => setOpenMenuId(openMenuId === workspace.id ? null : workspace.id)}
                            onCreateTask={(prompt) => onCreateTask(prompt, workspace.id)}
                            onDragStart={handleDragStart}
                            onDragEnter={handleDragEnter}
                            onDragEnd={handleDragEnd}
                            onReorderTasks={(fromIndex, toIndex) => reorderTasks(workspace.id, fromIndex, toIndex)}
                        />
                    ))
                )}
            </div>

            {systemPromptWorkspace && (
                <SystemPromptModal
                    workspaceId={systemPromptWorkspace.id}
                    workspaceName={systemPromptWorkspace.name}
                    initialPrompt={systemPromptWorkspace.systemPrompt || ''}
                    onSave={(prompt) => onSetSystemPrompt(systemPromptWorkspace.id, prompt)}
                    onClose={() => setSystemPromptWorkspace(null)}
                />
            )}
        </div>
    );
}
