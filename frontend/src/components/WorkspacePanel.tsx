import { useState, useRef, useEffect, useCallback } from 'react';
import { useTaskStore } from '../stores/taskStore';
import { Task, Workspace, WorkspacePrInfo } from '@claudia/shared';
import {
    Loader2, Circle, ChevronRight, ChevronDown, ChevronLeft,
    Trash2, FolderOpen, Plus, Briefcase, Send, AlertCircle, StopCircle, Undo2, GripVertical, Archive, RotateCcw, Play, MoreVertical, Terminal, Search, GitBranch, ImagePlus, X, FileText, GripHorizontal, Copy, Pencil, Link2, Check, CheckCircle, FolderPlus, Clipboard, Columns2, Clock, Settings, ArrowDownAZ, ArrowDownUp
} from 'lucide-react';
import { getApiBaseUrl } from '../config/api-config';
import { PrBadge } from './PrBadge';
import { SystemPromptModal } from './SystemPromptModal';
import { ConfirmModal } from './ConfirmModal';
import { BulkDeleteModal } from './BulkDeleteModal';
import { ScheduledTasksModal } from './ScheduledTasksModal';
import { WorkspaceManager } from './WorkspaceManager';
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
                <CheckCircle
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
    onRenameTask?: (taskId: string, displayName: string) => void;
    onOpenScheduledTasks?: (taskId: string) => void;
    isSelected: boolean;
    isLastSelected: boolean; // Was last selected in this workspace (but not globally active)
    hasActiveQuestion: boolean;
    hasUnreadActivity: boolean; // Has completion/input event user hasn't seen
    // Drag and drop
    isDragging: boolean;
    dragIndex: number | null;
    dragOverIndex: number | null;
    onDragStart: (index: number) => void;
    onDragEnter: (index: number) => void;
    onDragEnd: () => void;
    // When this task is the sole task in a worktree, show an inline worktree
    // badge (branch in tooltip) + PR badge instead of a separate group section.
    worktreeInfo?: { branch: string; prInfo?: WorkspacePrInfo | null };
}

/** Format a time-ago string from a Date/string, e.g. "5s", "2m", "1h", "3d" */
function formatTimeAgo(date: Date | string): string {
    const now = Date.now();
    const then = typeof date === 'string' ? new Date(date).getTime() : date.getTime();
    const diffMs = now - then;
    if (diffMs < 0) return '';
    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
}

function TaskItem({ task, index, onDeleteTask, onInterruptTask, onArchiveTask, onRevertTask, onSelectTask, onRenameTask, onOpenScheduledTasks, isSelected, isLastSelected, hasActiveQuestion, hasUnreadActivity, isDragging, dragIndex, dragOverIndex, onDragStart, onDragEnter, onDragEnd, worktreeInfo }: TaskItemProps) {
    const [stopClicked, setStopClicked] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [editValue, setEditValue] = useState('');
    const editInputRef = useRef<HTMLInputElement>(null);
    const [, setTick] = useState(0);
    const scheduledTasks = useTaskStore(state =>
        Array.from(state.scheduledTasks.values()).filter(s => s.taskId === task.id)
    );
    const scheduledTaskCount = scheduledTasks.length;
    const allScheduledPaused = scheduledTaskCount > 0 && scheduledTasks.every(s => s.isPaused);

    // Reset stopClicked when task state changes from busy
    useEffect(() => {
        if (task.state !== 'busy') {
            setStopClicked(false);
        }
    }, [task.state]);

    // Tick to keep the time indicator up to date
    // Every 1s for live elapsed timer (both processing and idle)
    const isBusy = task.state === 'busy' || task.state === 'starting';
    const isActiveState = isBusy || task.state === 'idle' || task.state === 'waiting_input';
    useEffect(() => {
        const interval = setInterval(() => setTick(t => t + 1), isActiveState ? 1000 : 30000);
        return () => clearInterval(interval);
    }, [isActiveState]);

    // Split prompt by ⏺ dots and get the last segment for display
    const segments = task.prompt.split('⏺').map(s => s.trim()).filter(Boolean);
    const lastSegment = segments.length > 0 ? segments[segments.length - 1] : task.prompt;

    // Use displayName if set, otherwise fall back to last segment of prompt
    const displayPrompt = task.displayName || lastSegment;

    const canInterrupt = task.state === 'busy' && !stopClicked;
    const isBeingDragged = dragIndex === index;
    const isDropTarget = dragOverIndex === index && isDragging && !isBeingDragged;

    const taskItemRef = useRef<HTMLDivElement>(null);

    // Focus input when editing starts
    useEffect(() => {
        if (isEditing && editInputRef.current) {
            editInputRef.current.focus();
            editInputRef.current.select();
        }
    }, [isEditing]);

    const handleStartEdit = (e: React.MouseEvent) => {
        e.stopPropagation();
        setEditValue(task.displayName || lastSegment);
        setIsEditing(true);
    };

    const handleSaveEdit = () => {
        const trimmed = editValue.trim();
        if (onRenameTask && trimmed !== (task.displayName || lastSegment)) {
            if (trimmed === '' || trimmed === lastSegment) {
                onRenameTask(task.id, '');
            } else {
                onRenameTask(task.id, trimmed);
            }
        }
        setIsEditing(false);
    };

    const handleCancelEdit = () => {
        setIsEditing(false);
    };

    const handleEditKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleSaveEdit();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            handleCancelEdit();
        }
    };

    return (
        <div
            ref={taskItemRef}
            className={`task-item ${isSelected ? 'selected' : ''} ${isLastSelected && !isSelected ? 'last-selected' : ''} ${task.state} ${hasActiveQuestion ? 'has-question' : ''} ${hasUnreadActivity && !isSelected ? 'unread' : ''} ${isBeingDragged ? 'dragging' : ''} ${isDropTarget ? 'drop-target' : ''}`}
            draggable={!isEditing && !worktreeInfo}
            onClick={() => !isEditing && onSelectTask(task.id)}
            onDragStart={(e) => {
                if (isEditing) { e.preventDefault(); return; }
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
            {isEditing ? (
                <input
                    ref={editInputRef}
                    className="task-name-input"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={handleSaveEdit}
                    onKeyDown={handleEditKeyDown}
                    onClick={(e) => e.stopPropagation()}
                />
            ) : (
                <span
                    className="task-prompt"
                    title={task.prompt}
                >
                    {displayPrompt}
                </span>
            )}
            {scheduledTaskCount > 0 && (
                <button
                    className={`task-cron-badge${allScheduledPaused ? ' paused' : ''}`}
                    title={`${scheduledTaskCount} scheduled task${scheduledTaskCount > 1 ? 's' : ''}${allScheduledPaused ? ' (paused)' : ''} - click to manage`}
                    onClick={(e) => { e.stopPropagation(); onOpenScheduledTasks?.(task.id); }}
                >
                    <Clock size={10} />
                    <span className="task-cron-count">{scheduledTaskCount}</span>
                </button>
            )}
            {worktreeInfo && (
                <span className="task-worktree-badge" title={`Worktree: ${worktreeInfo.branch}`}>
                    <GitBranch size={10} />
                </span>
            )}
            {worktreeInfo?.prInfo && <PrBadge prInfo={worktreeInfo.prInfo} />}
            <div className="task-actions">
                {task.lastActivity && (
                    <span
                        className={`task-time-ago ${isBusy ? 'busy' : ''}`}
                        title={isBusy
                            ? `Processing since ${new Date(task.processStartedAt || task.createdAt).toLocaleString()}`
                            : `Idle since ${new Date(task.lastActivity).toLocaleString()}`
                        }
                    >
                        {isBusy
                            ? formatTimeAgo(task.processStartedAt || task.createdAt)
                            : formatTimeAgo(task.lastActivity)
                        }
                    </span>
                )}
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
                {onRenameTask && !isEditing && (
                    <button
                        className="task-action-button rename"
                        onClick={handleStartEdit}
                        title="Rename task"
                    >
                        <Pencil size={12} />
                    </button>
                )}
                {onOpenScheduledTasks && (
                    <button
                        className="task-action-button schedule"
                        onClick={(e) => { e.stopPropagation(); onOpenScheduledTasks(task.id); }}
                        title="Scheduled tasks"
                    >
                        <Clock size={12} />
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

// ── Worktree Components ───────────────────────────────────────────────────────

interface WorktreeCreateModalProps {
    workspace: Workspace;
    onClose: () => void;
    onCreated: () => void;
    onCreateWorktree: (workspaceId: string, branch: string, baseBranch?: string, createBranch?: boolean) => Promise<void>;
}

function WorktreeCreateModal({ workspace, onClose, onCreated, onCreateWorktree }: WorktreeCreateModalProps) {
    const [branchName, setBranchName] = useState('');
    const [baseBranch, setBaseBranch] = useState('');
    const [createNew, setCreateNew] = useState(true);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleCreate = async () => {
        if (!branchName.trim()) { setError('Branch name is required'); return; }
        setError(null);
        setLoading(true);
        try {
            await onCreateWorktree(workspace.id, branchName.trim(), baseBranch.trim() || undefined, createNew);
            onCreated();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="worktree-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="worktree-modal">
                <div className="worktree-modal-header">
                    <h3><GitBranch size={16} /> New Worktree</h3>
                    <button className="worktree-modal-close" onClick={onClose}><X size={16} /></button>
                </div>
                <div className="worktree-modal-body">
                    <p className="worktree-modal-subtitle">
                        Creates an isolated git working directory for <strong>{workspace.displayName || workspace.name}</strong>.
                    </p>
                    <div className="worktree-modal-field">
                        <label>
                            <input type="radio" checked={createNew} onChange={() => setCreateNew(true)} />
                            {' '}Create new branch
                        </label>
                        <label>
                            <input type="radio" checked={!createNew} onChange={() => setCreateNew(false)} />
                            {' '}Checkout existing branch
                        </label>
                    </div>
                    <div className="worktree-modal-field">
                        <label htmlFor="wt-branch">Branch name</label>
                        <input
                            id="wt-branch"
                            className="worktree-modal-input"
                            type="text"
                            value={branchName}
                            onChange={(e) => setBranchName(e.target.value)}
                            placeholder={createNew ? 'feature/my-feature' : 'existing-branch-name'}
                            autoFocus
                            onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') onClose(); }}
                        />
                    </div>
                    {createNew && (
                        <div className="worktree-modal-field">
                            <label htmlFor="wt-base">Base branch <span className="optional">(optional, defaults to HEAD)</span></label>
                            <input
                                id="wt-base"
                                className="worktree-modal-input"
                                type="text"
                                value={baseBranch}
                                onChange={(e) => setBaseBranch(e.target.value)}
                                placeholder="main"
                            />
                        </div>
                    )}
                    {error && <div className="worktree-modal-error"><AlertCircle size={13} /> {error}</div>}
                </div>
                <div className="worktree-modal-footer">
                    <button className="worktree-modal-btn secondary" onClick={onClose} disabled={loading}>Cancel</button>
                    <button className="worktree-modal-btn primary" onClick={handleCreate} disabled={loading || !branchName.trim()}>
                        {loading ? <><Loader2 size={13} className="spinning" /> Creating…</> : 'Create Worktree'}
                    </button>
                </div>
            </div>
        </div>
    );
}

interface WorktreeManagerPanelProps {
    workspace: Workspace;
    allWorkspaces: Workspace[];
    onClose: () => void;
    onRemoveWorktree?: (workspaceId: string, force?: boolean) => Promise<void>;
    onSelectWorkspace?: (workspaceId: string) => void;
    onCreateWorktree: () => void;
}

function WorktreeManagerPanel({ workspace, allWorkspaces, onClose, onRemoveWorktree, onSelectWorkspace, onCreateWorktree }: WorktreeManagerPanelProps) {
    const [worktrees, setWorktrees] = useState<Array<{ path: string; branch: string; isMain: boolean; prunable: boolean; taskCount?: number }>>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [pruning, setPruning] = useState(false);

    const apiBase = getApiBaseUrl();
    const parentId = workspace.worktreeParentId ?? workspace.id;

    const loadWorktrees = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams({ workspace: parentId });
            const res = await fetch(`${apiBase}/api/worktrees?${params}`);
            if (res.ok) {
                const data = await res.json();
                setWorktrees(data.worktrees || []);
            } else {
                const d = await res.json().catch(() => ({}));
                setError(d.error || 'Failed to load worktrees');
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [parentId, apiBase]);

    useEffect(() => { loadWorktrees(); }, [loadWorktrees]);

    const handlePruneAll = async () => {
        setPruning(true);
        try {
            const params = new URLSearchParams({ workspace: parentId });
            await fetch(`${apiBase}/api/worktrees/prune?${params}`, { method: 'POST' });
            await loadWorktrees();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setPruning(false);
        }
    };

    const staleCount = worktrees.filter(wt => wt.prunable && !wt.isMain).length;
    const linkedWorktrees = worktrees.filter(wt => !wt.isMain);

    return (
        <div className="worktree-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="worktree-modal worktree-manager">
                <div className="worktree-modal-header">
                    <h3><GitBranch size={16} /> Worktrees — {workspace.displayName || workspace.name}</h3>
                    <button className="worktree-modal-close" onClick={onClose}><X size={16} /></button>
                </div>
                <div className="worktree-modal-body">
                    {loading && <div className="worktree-loading"><Loader2 size={16} className="spinning" /> Loading…</div>}
                    {error && <div className="worktree-modal-error"><AlertCircle size={13} /> {error}</div>}
                    {!loading && worktrees.map(wt => {
                        const shortBranch = wt.branch.replace('refs/heads/', '');
                        const claudiaWs = allWorkspaces.find(w => w.id === wt.path);
                        return (
                            <div key={wt.path} className={`worktree-row${wt.prunable ? ' stale' : ''}`}>
                                <div className="worktree-row-info">
                                    <span className={`worktree-row-badge${wt.isMain ? ' main' : ''}`}>
                                        {wt.isMain ? 'main' : <GitBranch size={11} />}
                                    </span>
                                    <span className="worktree-row-branch">{shortBranch}</span>
                                    {wt.prunable && <span className="worktree-row-stale">stale</span>}
                                    {(wt.taskCount ?? 0) > 0 && (
                                        <span className="worktree-row-tasks">{wt.taskCount} task{wt.taskCount !== 1 ? 's' : ''}</span>
                                    )}
                                </div>
                                <div className="worktree-row-actions">
                                    {!wt.isMain && claudiaWs && onSelectWorkspace && (
                                        <button className="worktree-row-btn" onClick={() => { onSelectWorkspace(wt.path); onClose(); }} title="Open this worktree">
                                            Open
                                        </button>
                                    )}
                                    {!wt.isMain && onRemoveWorktree && (
                                        <button
                                            className="worktree-row-btn danger"
                                            disabled={(wt.taskCount ?? 0) > 0}
                                            title={(wt.taskCount ?? 0) > 0 ? 'Archive tasks first' : 'Remove worktree'}
                                            onClick={async () => {
                                                if (window.confirm(`Remove worktree "${shortBranch}"? The directory and branch will be deleted.`)) {
                                                    try {
                                                        await onRemoveWorktree(wt.path, false);
                                                        await loadWorktrees();
                                                    } catch (err) {
                                                        setError(err instanceof Error ? err.message : String(err));
                                                    }
                                                }
                                            }}
                                        >
                                            Remove
                                        </button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                    {!loading && linkedWorktrees.length === 0 && (
                        <p className="worktree-empty">No worktrees yet. Create one to start isolated development.</p>
                    )}
                    {staleCount > 0 && (
                        <div className="worktree-stale-warning">
                            <AlertCircle size={13} /> {staleCount} stale worktree reference{staleCount !== 1 ? 's' : ''} (directory deleted)
                            <button className="worktree-row-btn" onClick={handlePruneAll} disabled={pruning}>
                                {pruning ? 'Pruning…' : 'Prune All'}
                            </button>
                        </div>
                    )}
                </div>
                <div className="worktree-modal-footer">
                    <button className="worktree-modal-btn secondary" onClick={onClose}>Close</button>
                    <button className="worktree-modal-btn primary" onClick={onCreateWorktree}>
                        <FolderPlus size={13} /> New Worktree
                    </button>
                </div>
            </div>
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────────────────

interface WorktreeGroup {
    workspace: Workspace;
    branch: string; // short branch name
    tasks: Task[];
}

interface WorktreeGroupSectionProps {
    group: WorktreeGroup;
    selectedTaskId: string | null;
    lastSelectedTaskId: string | null;
    waitingInputTaskIds: Set<string>;
    unreadTaskIds: Set<string>;
    onDeleteTask: (taskId: string) => void;
    onInterruptTask: (taskId: string) => void;
    onArchiveTask: (taskId: string) => void;
    onRevertTask: (taskId: string) => void;
    onSelectTask: (taskId: string) => void;
    onRenameTask?: (taskId: string, displayName: string) => void;
    onOpenScheduledTasks?: (taskId: string) => void;
    onRemoveWorktree?: (workspaceId: string, force?: boolean) => Promise<void>;
}

function WorktreeGroupSection({ group, selectedTaskId, lastSelectedTaskId, waitingInputTaskIds, unreadTaskIds, onDeleteTask, onInterruptTask, onArchiveTask, onRevertTask, onSelectTask, onRenameTask, onOpenScheduledTasks, onRemoveWorktree }: WorktreeGroupSectionProps) {
    // Collapsed state is persisted in the store (keyed by group id) so it survives
    // reconnect/reload instead of snapping back to expanded.
    const collapsed = useTaskStore((s) => s.collapsedWorktreeGroups.has(group.workspace.id));
    const toggleWorktreeGroupCollapsed = useTaskStore((s) => s.toggleWorktreeGroupCollapsed);
    const [removing, setRemoving] = useState(false);

    const hasActive = group.tasks.some(t => t.state === 'busy' || t.state === 'starting' || t.state === 'waiting_input');

    const handleRemove = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!onRemoveWorktree) return;
        if (!window.confirm(`Remove worktree branch "${group.branch}"? The directory and branch will be deleted.`)) return;
        setRemoving(true);
        try {
            await onRemoveWorktree(group.workspace.id, false);
        } catch (err) {
            console.error('[WorktreeGroupSection] remove failed:', err);
        } finally {
            setRemoving(false);
        }
    };

    return (
        <div className={`worktree-group${collapsed ? ' collapsed' : ''}`}>
            <div className="worktree-group-header" onClick={() => toggleWorktreeGroupCollapsed(group.workspace.id)}>
                {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                <GitBranch size={12} />
                <span className="worktree-group-branch" title={group.workspace.worktreeBranch || group.branch}>{group.branch}</span>
                {group.workspace.prInfo && <PrBadge prInfo={group.workspace.prInfo} />}
                {hasActive && <span className="worktree-group-active-dot" title="Has active tasks" />}
                {!collapsed && onRemoveWorktree && (
                    <button
                        className="worktree-group-remove"
                        title={hasActive ? 'Archive tasks first' : 'Remove worktree'}
                        disabled={removing || hasActive}
                        onClick={handleRemove}
                    >
                        <Trash2 size={10} />
                    </button>
                )}
            </div>
            {!collapsed && (
                <div className="worktree-group-tasks">
                    {group.tasks.map((task, idx) => (
                        <TaskItem
                            key={task.id}
                            task={task}
                            index={idx}
                            isSelected={selectedTaskId === task.id}
                            isLastSelected={lastSelectedTaskId === task.id}
                            hasActiveQuestion={waitingInputTaskIds.has(task.id)}
                            hasUnreadActivity={unreadTaskIds.has(task.id)}
                            onDeleteTask={onDeleteTask}
                            onInterruptTask={onInterruptTask}
                            onArchiveTask={onArchiveTask}
                            onRevertTask={onRevertTask}
                            onSelectTask={onSelectTask}
                            onRenameTask={onRenameTask}
                            onOpenScheduledTasks={onOpenScheduledTasks}
                            isDragging={false}
                            dragIndex={null}
                            dragOverIndex={null}
                            onDragStart={() => {}}
                            onDragEnter={() => {}}
                            onDragEnd={() => {}}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

interface WorkspaceSectionProps {
    workspace: Workspace;
    tasks: Task[];
    worktreeGroups?: WorktreeGroup[]; // Inline worktree sub-sections
    waitingInputTaskIds: Set<string>;
    unreadTaskIds: Set<string>;
    selectedTaskId: string | null;
    lastSelectedTaskId: string | null; // Last selected task in this workspace
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
    onOpenShell: () => void;
    onPushToGithub: () => void;
    onSystemPrompt: () => void;
    onToggleMenu: () => void;
    onCreateTask: (prompt: string, initialCols?: number, initialRows?: number, isolate?: boolean) => void;
    // Workspace drag handlers
    onDragStart: (index: number) => void;
    onDragEnter: (index: number) => void;
    onDragEnd: () => void;
    // Task reordering
    onReorderTasks: (fromIndex: number, toIndex: number) => void;
    // Rename handlers
    onRenameTask?: (taskId: string, displayName: string) => void;
    onRenameWorkspace?: (workspaceId: string, displayName: string) => void;
    // Reference handlers
    allWorkspaces: Workspace[];
    onToggleReference?: (workspaceId: string, referencePath: string) => void;
    onAddCustomReference?: (workspaceId: string, path: string, description?: string) => void;
    onRemoveReference?: (workspaceId: string, referenceId: string) => void;
    // Reset workspace handler
    onResetWorkspace?: () => void;
    // Scheduled tasks
    onOpenScheduledTasks?: (taskId: string) => void;
    // Worktree handlers
    worktreeCount?: number;    // Number of linked worktrees for this parent workspace
    onCreateWorktree?: (workspaceId: string, branch: string, baseBranch?: string, createBranch?: boolean) => Promise<void>;
    onRemoveWorktree?: (workspaceId: string, force?: boolean) => Promise<void>;
    onToggleAutoWorktree?: (workspaceId: string, enabled: boolean) => void;
    onSelectWorkspace?: (workspaceId: string) => void; // navigate to a different workspace
}

function WorkspaceSection({
    workspace,
    tasks,
    worktreeGroups = [],
    waitingInputTaskIds,
    unreadTaskIds,
    selectedTaskId,
    lastSelectedTaskId,
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
    onOpenShell,
    onPushToGithub,
    onSystemPrompt,
    onToggleMenu,
    onCreateTask,
    onDragStart,
    onDragEnter,
    onDragEnd,
    onReorderTasks,
    onRenameTask,
    onRenameWorkspace,
    allWorkspaces,
    onToggleReference,
    onAddCustomReference,
    onRemoveReference,
    onResetWorkspace,
    onOpenScheduledTasks,
    worktreeCount = 0,
    onCreateWorktree,
    onRemoveWorktree,
    onToggleAutoWorktree,
    onSelectWorkspace,
}: WorkspaceSectionProps) {
    const isConnected = useTaskStore(s => s.isConnected);
    const [inputValue, setInputValue] = useState('');
    const [isolate, setIsolate] = useState(!!workspace.autoWorktree);
    const [isEditingWorkspaceName, setIsEditingWorkspaceName] = useState(false);
    const [showReferencesSubmenu, setShowReferencesSubmenu] = useState(false);
    const [submenuPosition, setSubmenuPosition] = useState<{ top: number; left: number } | null>(null);
    const [workspaceEditValue, setWorkspaceEditValue] = useState('');
    const workspaceEditRef = useRef<HTMLInputElement>(null);
    const referencesMenuItemRef = useRef<HTMLDivElement>(null);
    const submenuCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const [showResetConfirm, setShowResetConfirm] = useState(false);
    const [branchName, setBranchName] = useState<string | null>(null);
    const [showWorktreeModal, setShowWorktreeModal] = useState(false);
    const [showWorktreeManager, setShowWorktreeManager] = useState(false);
    const [worktreeError, setWorktreeError] = useState<string | null>(null);
    const isWorktree = !!workspace.worktreeParentId;

    // Reset submenu state when parent menu closes, and cleanup timeout on unmount
    useEffect(() => {
        if (!isMenuOpen) {
            setShowReferencesSubmenu(false);
            if (submenuCloseTimeoutRef.current) {
                clearTimeout(submenuCloseTimeoutRef.current);
                submenuCloseTimeoutRef.current = null;
            }
        }
        return () => {
            if (submenuCloseTimeoutRef.current) {
                clearTimeout(submenuCloseTimeoutRef.current);
            }
        };
    }, [isMenuOpen]);

    // Fetch current git branch for this workspace.
    // Only POLL (every 60s) for the workspace that has the selected task — other workspaces
    // fetch once when mounted/expanded. This prevents a storm of git processes on enterprise
    // machines with slow auth (Okta/GCM) where 7 workspaces × 4 git commands = 28 processes
    // every polling interval.
    const isActiveWorkspace = selectedTaskId != null && tasks.some(t => t.id === selectedTaskId);
    useEffect(() => {
        if (!isConnected) return;
        const fetchBranch = async () => {
            try {
                const params = new URLSearchParams({ workspace: workspace.id });
                const res = await fetch(`${getApiBaseUrl()}/api/workspaces/git-status?${params}`);
                if (res.ok) {
                    const data = await res.json();
                    setBranchName(data.branch || null);
                }
            } catch {
                // silently ignore - not a git repo or network error
            }
        };
        fetchBranch();
        if (isActiveWorkspace) {
            const interval = setInterval(fetchBranch, 60_000);
            return () => clearInterval(interval);
        }
    }, [workspace.id, isConnected, isActiveWorkspace]);

    const [images, setImages] = useState<UploadedImage[]>([]);
    const [isImageDragging, setIsImageDragging] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const imagesRef = useRef<UploadedImage[]>(images);

    // Task list resize state — height is persisted in the store so it survives
    // reconnect/reload; isResizing is transient (only true during an active drag).
    const taskListHeight = useTaskStore((s) => s.taskListHeight);
    const setTaskListHeight = useTaskStore((s) => s.setTaskListHeight);
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
        clearVoiceTranscript,
        taskSortBy,
        setTaskSortBy
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

    // Handle clipboard paste - intercept pasted images (e.g. from Print Screen, Snipping Tool)
    const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        const clipboardItems = e.clipboardData?.items;
        if (!clipboardItems) return;

        const imageItems: DataTransferItem[] = [];
        for (let i = 0; i < clipboardItems.length; i++) {
            const item = clipboardItems[i];
            if (item.type.startsWith('image/')) {
                imageItems.push(item);
            }
        }

        // If no images in clipboard, let the default paste behavior handle text
        if (imageItems.length === 0) return;

        // Prevent the default paste behavior so image data doesn't get inserted as text
        e.preventDefault();

        console.log(`[WorkspacePanel] Pasting ${imageItems.length} image(s) from clipboard`);
        setIsUploading(true);

        for (const item of imageItems) {
            const file = item.getAsFile();
            if (!file) {
                console.warn('[WorkspacePanel] Failed to get file from clipboard item');
                continue;
            }

            // Give pasted images a meaningful name with timestamp
            const extension = file.type.split('/')[1] || 'png';
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const namedFile = new File([file], `clipboard-${timestamp}.${extension}`, {
                type: file.type
            });

            console.log(`[WorkspacePanel] Uploading pasted image: ${namedFile.name} (${namedFile.size} bytes, ${namedFile.type})`);
            const uploaded = await uploadImage(namedFile);
            if (uploaded) {
                setImages(prev => [...prev, uploaded]);
                console.log(`[WorkspacePanel] Successfully uploaded pasted image: ${uploaded.filename}`);
            }
        }

        setIsUploading(false);
    };

    // Keep ref in sync so the unmount cleanup can access the latest images
    useEffect(() => { imagesRef.current = images; }, [images]);

    // Cleanup preview URLs on unmount
    useEffect(() => {
        return () => {
            imagesRef.current.forEach(img => URL.revokeObjectURL(img.previewUrl));
        };
    }, []);

    // Append voice transcript to input when this input is focused
    // We use a ref to track processed transcripts to prevent duplicate appending
    const lastProcessedTranscriptRef = useRef<string>('');
    useEffect(() => {
        if (isFocused && voiceTranscript && voiceTranscript !== lastProcessedTranscriptRef.current) {
            lastProcessedTranscriptRef.current = voiceTranscript;
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
            // Estimate terminal size from the actual main panel container width
            // rather than guessing sidebar offset. Falls back to window-based estimate.
            const mainPanel = document.querySelector('.main-panel');
            const panelWidth = mainPanel?.clientWidth || (window.innerWidth - 640);
            const panelHeight = mainPanel?.clientHeight || (window.innerHeight - 100);
            const cols = Math.max(80, Math.floor(panelWidth / 9)); // ~9px per char
            const rows = Math.max(24, Math.floor(panelHeight / 18)); // ~18px per line
            onCreateTask(fullMessage.trim(), cols, rows, isolate);
            setInputValue('');
            // Reset isolate to workspace default after sending
            setIsolate(!!workspace.autoWorktree);
            // Clear images after sending
            images.forEach(img => URL.revokeObjectURL(img.previewUrl));
            setImages([]);
        }
    }, [inputValue, images, isolate, workspace.autoWorktree, globalVoiceEnabled, clearVoiceTranscript, onCreateTask]);

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

    // Workspace name display
    const workspaceDisplayName = workspace.displayName || workspace.name;

    // Focus workspace name input when editing starts
    useEffect(() => {
        if (isEditingWorkspaceName && workspaceEditRef.current) {
            workspaceEditRef.current.focus();
            workspaceEditRef.current.select();
        }
    }, [isEditingWorkspaceName]);

    // Cleanup submenu close timeout on unmount
    useEffect(() => {
        return () => {
            if (submenuCloseTimeoutRef.current) {
                clearTimeout(submenuCloseTimeoutRef.current);
            }
        };
    }, []);

    const handleStartWorkspaceEdit = (e?: React.MouseEvent) => {
        if (e) e.stopPropagation();
        setWorkspaceEditValue(workspace.displayName || workspace.name);
        setIsEditingWorkspaceName(true);
    };

    const handleSaveWorkspaceEdit = () => {
        const trimmed = workspaceEditValue.trim();
        if (onRenameWorkspace && trimmed !== workspaceDisplayName) {
            if (trimmed === '' || trimmed === workspace.name) {
                onRenameWorkspace(workspace.id, '');
            } else {
                onRenameWorkspace(workspace.id, trimmed);
            }
        }
        setIsEditingWorkspaceName(false);
    };

    const handleCancelWorkspaceEdit = () => {
        setIsEditingWorkspaceName(false);
    };

    const handleWorkspaceEditKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleSaveWorkspaceEdit();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            handleCancelWorkspaceEdit();
        }
    };

    return (
        <div
            className={`workspace-section ${isExpanded ? 'expanded' : ''} ${isDragging ? 'dragging' : ''} ${isDropTarget ? 'drop-target' : ''} ${isMenuOpen ? 'menu-open' : ''}`}
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
                <div className="workspace-header-left" onClick={() => !isEditingWorkspaceName && onToggleExpand()}>
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    {isWorktree
                        ? <span aria-label="Git worktree"><GitBranch size={16} className="workspace-icon worktree-icon" /></span>
                        : <Briefcase size={16} className="workspace-icon" />
                    }
                    {isEditingWorkspaceName ? (
                        <input
                            ref={workspaceEditRef}
                            className="workspace-name-input"
                            value={workspaceEditValue}
                            onChange={(e) => setWorkspaceEditValue(e.target.value)}
                            onBlur={handleSaveWorkspaceEdit}
                            onKeyDown={handleWorkspaceEditKeyDown}
                            onClick={(e) => e.stopPropagation()}
                        />
                    ) : (
                        <>
                            <span
                                className="workspace-name"
                                title={workspace.id}
                            >
                                {workspaceDisplayName}
                            </span>
                            {onRenameWorkspace && (
                                <button
                                    className="workspace-rename-button"
                                    onClick={handleStartWorkspaceEdit}
                                    title="Rename workspace"
                                >
                                    <Pencil size={12} />
                                </button>
                            )}
                        </>
                    )}
                    {branchName && (
                        <span
                            className="workspace-branch-label"
                            title={`Click to copy: ${branchName}`}
                            onClick={(e) => {
                                e.stopPropagation();
                                navigator.clipboard.writeText(branchName);
                                const el = e.currentTarget;
                                el.classList.add('copied');
                                setTimeout(() => el.classList.remove('copied'), 1000);
                            }}
                        >
                            <GitBranch size={11} />
                            <span className="branch-name">{branchName}</span>
                        </span>
                    )}
                    {workspace.prInfo && <PrBadge prInfo={workspace.prInfo} />}
                    {tasks.length > 0 && (
                        <>
                            <span className="workspace-task-count">{tasks.length}</span>
                        </>
                    )}
                    {!isWorktree && worktreeCount > 0 && (
                        <span
                            className="workspace-worktree-count"
                            title={`${worktreeCount} worktree${worktreeCount !== 1 ? 's' : ''} — click to manage`}
                            onClick={(e) => {
                                e.stopPropagation();
                                setShowWorktreeManager(true);
                            }}
                        >
                            <GitBranch size={11} />
                            <span>{worktreeCount}</span>
                        </span>
                    )}
                    {workspace.autoWorktree && !isWorktree && (
                        <span className="workspace-auto-worktree-badge" title="New tasks auto-create isolated worktrees">
                            auto-isolate
                        </span>
                    )}
                    {workspace.references && workspace.references.length > 0 && (
                        <span
                            className="workspace-ref-indicator"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <Link2 size={11} />
                            <span className="ref-count">{workspace.references.length}</span>
                            <span className="ref-tooltip">
                                <strong>References:</strong>
                                {workspace.references.map(r => (
                                    <span key={r.id} className="ref-tooltip-item">{r.name}</span>
                                ))}
                            </span>
                        </span>
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
                        <div className="workspace-dropdown-menu" ref={(el) => {
                            if (el) {
                                // Position using the trigger button's viewport coords
                                // (the menu is position:fixed to escape overflow clipping).
                                const btn = el.parentElement?.querySelector('.workspace-action-button.menu');
                                const btnRect = btn?.getBoundingClientRect();
                                if (btnRect) {
                                    const menuH = el.offsetHeight;
                                    const spaceBelow = window.innerHeight - btnRect.bottom - 8;
                                    if (spaceBelow >= menuH) {
                                        el.style.top = `${btnRect.bottom + 4}px`;
                                        el.style.bottom = 'auto';
                                    } else {
                                        el.style.top = 'auto';
                                        el.style.bottom = `${window.innerHeight - btnRect.top + 4}px`;
                                    }
                                    el.style.right = `${window.innerWidth - btnRect.right}px`;
                                }
                            }
                        }}
                        onMouseOver={(e) => {
                            // Close the references submenu when the user hovers over a sibling menu item.
                            // mouseover bubbles (unlike mouseenter), so we get all hover transitions on this single handler.
                            // We deliberately do NOT use a mouseleave timer on the submenu/References item itself —
                            // that scheme is fragile because diagonal mouse motion creates "dead zones" geographically
                            // outside both the References item bbox and the submenu bbox, where the timer can fire
                            // while the user is still trying to interact with the submenu (e.g. clicking a reference).
                            const target = e.target as HTMLElement;
                            if (
                                showReferencesSubmenu &&
                                !target.closest('.has-submenu') &&
                                !target.closest('.workspace-submenu')
                            ) {
                                if (submenuCloseTimeoutRef.current) {
                                    clearTimeout(submenuCloseTimeoutRef.current);
                                    submenuCloseTimeoutRef.current = null;
                                }
                                setShowReferencesSubmenu(false);
                            }
                        }}>
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
                                    onOpenShell();
                                    onToggleMenu();
                                }}
                            >
                                <Terminal size={14} />
                                <span>Open Shell</span>
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
                                <span>Open External Terminal</span>
                            </button>
                            <button
                                className="workspace-dropdown-item"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    navigator.clipboard.writeText(workspace.id).catch(err => console.error('Failed to copy path:', err));
                                    onToggleMenu();
                                }}
                            >
                                <Copy size={14} />
                                <span>Copy Path</span>
                            </button>
                            <button
                                className="workspace-dropdown-item"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onToggleMenu();
                                    handleStartWorkspaceEdit();
                                }}
                            >
                                <Pencil size={14} />
                                <span>Rename</span>
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
                            <div
                                ref={referencesMenuItemRef}
                                className="workspace-dropdown-item has-submenu"
                                onMouseEnter={() => {
                                    if (submenuCloseTimeoutRef.current) {
                                        clearTimeout(submenuCloseTimeoutRef.current);
                                        submenuCloseTimeoutRef.current = null;
                                    }
                                    setShowReferencesSubmenu(true);
                                    if (referencesMenuItemRef.current) {
                                        const rect = referencesMenuItemRef.current.getBoundingClientRect();
                                        // Position submenu to overlap slightly with parent to avoid gaps
                                        setSubmenuPosition({ top: rect.top, left: rect.right - 8 });
                                    }
                                }}
                                onClick={(e) => e.stopPropagation()}
                            >
                                <Link2 size={14} />
                                <span>References</span>
                                <ChevronRight size={12} className="submenu-arrow" />
                                {showReferencesSubmenu && submenuPosition && (
                                    <div
                                        className="workspace-submenu"
                                        style={{ position: 'fixed', top: submenuPosition.top, left: submenuPosition.left }}
                                        ref={(el) => {
                                            if (el) {
                                                const rect = el.getBoundingClientRect();
                                                if (rect.bottom > window.innerHeight - 8) {
                                                    el.style.top = `${submenuPosition.top - (rect.bottom - window.innerHeight) - 8}px`;
                                                }
                                                if (rect.right > window.innerWidth - 8) {
                                                    el.style.left = `${submenuPosition.left - rect.width - (referencesMenuItemRef.current?.getBoundingClientRect().width || 0) + 8}px`;
                                                }
                                            }
                                        }}
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        {allWorkspaces.filter(w => w.id !== workspace.id && !w.worktreeParentId).length > 0 && (
                                            <>
                                                {allWorkspaces.filter(w => w.id !== workspace.id && !w.worktreeParentId).map(w => {
                                                    const isReferenced = workspace.references?.some(r => r.path === w.id) || false;
                                                    return (
                                                        <button
                                                            key={w.id}
                                                            className={`workspace-dropdown-item reference-item ${isReferenced ? 'active' : ''}`}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                onToggleReference?.(workspace.id, w.id);
                                                            }}
                                                        >
                                                            <span className="reference-checkbox">
                                                                {isReferenced ? <Check size={12} /> : <span className="checkbox-empty" />}
                                                            </span>
                                                            <span className="reference-name">{w.displayName || w.name}</span>
                                                        </button>
                                                    );
                                                })}
                                            </>
                                        )}
                                        {/* Custom (non-workspace) references */}
                                        {workspace.references?.filter(r => !allWorkspaces.some(w => w.id === r.path)).map(ref => (
                                            <div key={ref.id} className="workspace-dropdown-item reference-item custom-ref">
                                                <FolderOpen size={12} />
                                                <span className="reference-name" title={ref.path}>{ref.name}</span>
                                                <button
                                                    className="reference-remove-btn"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        onRemoveReference?.(workspace.id, ref.id);
                                                    }}
                                                    title="Remove reference"
                                                >
                                                    <X size={10} />
                                                </button>
                                            </div>
                                        ))}
                                        {(allWorkspaces.filter(w => w.id !== workspace.id && !w.worktreeParentId).length > 0 ||
                                          workspace.references?.filter(r => !allWorkspaces.some(w => w.id === r.path)).length) && (
                                            <div className="workspace-dropdown-divider" />
                                        )}
                                        <button
                                            className="workspace-dropdown-item"
                                            onClick={async (e) => {
                                                e.stopPropagation();
                                                try {
                                                    const resp = await fetch(`${getApiBaseUrl()}/api/browse-folder`, { method: 'POST' });
                                                    const data = await resp.json();
                                                    if (data.success && data.path) {
                                                        onAddCustomReference?.(workspace.id, data.path);
                                                    }
                                                } catch (err) {
                                                    console.error('Failed to open folder picker:', err);
                                                }
                                            }}
                                        >
                                            <FolderPlus size={14} />
                                            <span>Add Custom Folder...</span>
                                        </button>
                                        {allWorkspaces.filter(w => w.id !== workspace.id && !w.worktreeParentId).length === 0 &&
                                         !workspace.references?.length && (
                                            <div className="workspace-dropdown-item disabled">
                                                <span className="reference-empty-hint">No other workspaces available</span>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
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
                            {tasks.length > 1 && (
                                <>
                                    <div className="workspace-dropdown-divider" />
                                    <div className="workspace-dropdown-item sort-row" onClick={(e) => e.stopPropagation()}>
                                        <ArrowDownUp size={14} />
                                        <span>Sort by</span>
                                        <div className="sort-toggle">
                                            <button
                                                className={`sort-toggle-btn${taskSortBy === 'date-created' ? ' active' : ''}`}
                                                onClick={(e) => { e.stopPropagation(); setTaskSortBy('date-created'); }}
                                            >Newest</button>
                                            <button
                                                className={`sort-toggle-btn${taskSortBy === 'last-modified' ? ' active' : ''}`}
                                                onClick={(e) => { e.stopPropagation(); setTaskSortBy('last-modified'); }}
                                            >Recent</button>
                                        </div>
                                    </div>
                                </>
                            )}
                            {/* Worktree actions for parent workspaces */}
                            {!isWorktree && onCreateWorktree && (
                                <>
                                    <div className="workspace-dropdown-divider" />
                                    <button
                                        className="workspace-dropdown-item"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setShowWorktreeModal(true);
                                            onToggleMenu();
                                        }}
                                    >
                                        <FolderPlus size={14} />
                                        <span>New Worktree…</span>
                                    </button>
                                    {worktreeCount > 0 && (
                                        <button
                                            className="workspace-dropdown-item"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setShowWorktreeManager(true);
                                                onToggleMenu();
                                            }}
                                        >
                                            <GitBranch size={14} />
                                            <span>Manage Worktrees ({worktreeCount})</span>
                                        </button>
                                    )}
                                    <button
                                        className={`workspace-dropdown-item${workspace.autoWorktree ? ' active' : ''}`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onToggleAutoWorktree?.(workspace.id, !workspace.autoWorktree);
                                            onToggleMenu();
                                        }}
                                        title="When enabled, each new task automatically gets its own isolated git worktree"
                                    >
                                        <Columns2 size={14} />
                                        <span>Auto-isolate tasks {workspace.autoWorktree ? '✓' : ''}</span>
                                    </button>
                                </>
                            )}
                            {/* Worktree-specific actions — shown when this workspace IS a worktree */}
                            {isWorktree && (
                                <>
                                    <div className="workspace-dropdown-divider" />
                                    {workspace.worktreeParentId && onSelectWorkspace && (
                                        <button
                                            className="workspace-dropdown-item"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onSelectWorkspace(workspace.worktreeParentId!);
                                                onToggleMenu();
                                            }}
                                        >
                                            <ChevronLeft size={14} />
                                            <span>Go to Parent Workspace</span>
                                        </button>
                                    )}
                                    {onRemoveWorktree && (
                                        <button
                                            className="workspace-dropdown-item delete"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                const hasTasks = tasks.length > 0;
                                                const confirmMsg = hasTasks
                                                    ? `Remove worktree "${workspace.displayName || workspace.name}"? It has ${tasks.length} task(s). Archive them first, or force-remove.`
                                                    : `Remove worktree "${workspace.displayName || workspace.name}"? The branch and worktree directory will be deleted.`;
                                                if (window.confirm(confirmMsg)) {
                                                    onRemoveWorktree(workspace.id, false).catch(err => {
                                                        setWorktreeError(err instanceof Error ? err.message : String(err));
                                                    });
                                                }
                                                onToggleMenu();
                                            }}
                                        >
                                            <Trash2 size={14} />
                                            <span>Remove Worktree</span>
                                        </button>
                                    )}
                                </>
                            )}
                            <div className="workspace-dropdown-divider" />
                            {!isWorktree && (
                                <button
                                    className="workspace-dropdown-item reset"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setShowResetConfirm(true);
                                        onToggleMenu();
                                    }}
                                >
                                    <RotateCcw size={14} />
                                    <span>Reset Workspace</span>
                                </button>
                            )}
                            <button
                                className="workspace-dropdown-item delete"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    if (isWorktree) {
                                        // For worktrees, removal is handled by "Remove Worktree" above
                                        if (window.confirm(`Unlink worktree workspace "${workspace.displayName || workspace.name}" from Claudia? The worktree directory on disk will NOT be deleted.`)) {
                                            onDeleteWorkspace();
                                        }
                                    } else if (window.confirm(`Remove workspace "${workspace.name}"? Tasks will not be deleted.`)) {
                                        onDeleteWorkspace();
                                    }
                                    onToggleMenu();
                                }}
                            >
                                <Trash2 size={14} />
                                <span>{isWorktree ? 'Unlink Workspace' : 'Remove Workspace'}</span>
                            </button>
                        </div>
                    )}
                </div>
            </div>
            {isExpanded && (
                <div className="workspace-content">
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

                        {/* Upload status messages */}
                        {isUploading && (
                            <div className="new-task-uploading">
                                <Clipboard size={12} />
                                <span>Uploading pasted image...</span>
                            </div>
                        )}
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
                                    placeholder="Type or speak a task... (Ctrl+V to paste screenshots)"
                                    value={inputValue}
                                    onChange={(e) => setInputValue(e.target.value)}
                                    onKeyDown={handleKeyDown}
                                    onPaste={handlePaste}
                                    onFocus={handleFocus}
                                    onBlur={handleBlur}
                                    rows={1}
                                    data-input-type="new-task-input"
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
                            {!isWorktree && (
                                <button
                                    type="button"
                                    className={`task-isolate-button${isolate ? ' active' : ''}`}
                                    title={isolate ? 'Isolate in worktree: ON — click to disable' : 'Isolate in worktree: OFF — click to enable'}
                                    onClick={() => setIsolate(v => !v)}
                                >
                                    <GitBranch size={14} />
                                </button>
                            )}
                            <button
                                type="submit"
                                className="task-submit-button"
                                disabled={!inputValue.trim() && images.length === 0}
                            >
                                <Send size={16} />
                            </button>
                        </div>
                    </form>
                    {tasks.length === 0 && worktreeGroups.length === 0 ? (
                        <div className="empty-tasks">No tasks yet</div>
                    ) : (
                        <div className="task-list-container">
                            <div
                                ref={taskListRef}
                                className={`task-list ${isResizing ? 'resizing' : ''}`}
                                style={taskListHeight ? { maxHeight: `${taskListHeight}px` } : undefined}
                            >
                                {(() => {
                                    // Build a unified list of render items (tasks + worktree groups)
                                    // sorted together so new worktree tasks appear at their natural
                                    // position (e.g. top) instead of always at the bottom.
                                    type RenderItem =
                                        | { type: 'task'; task: Task; idx: number }
                                        | { type: 'worktree-single'; group: WorktreeGroup }
                                        | { type: 'worktree-multi'; group: WorktreeGroup };

                                    const items: RenderItem[] = [];

                                    // Add regular tasks
                                    tasks.forEach((task, idx) => {
                                        items.push({ type: 'task', task, idx });
                                    });

                                    // Add worktree groups
                                    for (const group of worktreeGroups) {
                                        if (group.tasks.length === 1) {
                                            items.push({ type: 'worktree-single', group });
                                        } else {
                                            items.push({ type: 'worktree-multi', group });
                                        }
                                    }

                                    // Sort: items with explicit order first, then by creation time (newest first).
                                    // For worktree groups, use the newest task's creation time.
                                    items.sort((a, b) => {
                                        const orderA = a.type === 'task' ? a.task.order : undefined;
                                        const orderB = b.type === 'task' ? b.task.order : undefined;
                                        if (orderA !== undefined && orderB !== undefined) return orderA - orderB;
                                        if (orderA !== undefined) return -1;
                                        if (orderB !== undefined) return 1;

                                        const timeA = a.type === 'task'
                                            ? new Date(a.task.createdAt).getTime()
                                            : Math.max(...a.group.tasks.map(t => new Date(t.createdAt).getTime()));
                                        const timeB = b.type === 'task'
                                            ? new Date(b.task.createdAt).getTime()
                                            : Math.max(...b.group.tasks.map(t => new Date(t.createdAt).getTime()));
                                        return timeB - timeA;
                                    });

                                    return items.map((item) => {
                                        if (item.type === 'task') {
                                            return (
                                                <TaskItem
                                                    key={item.task.id}
                                                    task={item.task}
                                                    index={item.idx}
                                                    isSelected={selectedTaskId === item.task.id}
                                                    isLastSelected={lastSelectedTaskId === item.task.id}
                                                    hasActiveQuestion={waitingInputTaskIds.has(item.task.id)}
                                                    hasUnreadActivity={unreadTaskIds.has(item.task.id)}
                                                    onDeleteTask={onDeleteTask}
                                                    onInterruptTask={onInterruptTask}
                                                    onArchiveTask={onArchiveTask}
                                                    onRevertTask={onRevertTask}
                                                    onSelectTask={onSelectTask}
                                                    onRenameTask={onRenameTask}
                                                    onOpenScheduledTasks={onOpenScheduledTasks}
                                                    isDragging={taskDragIndex !== null}
                                                    dragIndex={taskDragIndex}
                                                    dragOverIndex={taskDragOverIndex}
                                                    onDragStart={handleTaskDragStart}
                                                    onDragEnter={handleTaskDragEnter}
                                                    onDragEnd={handleTaskDragEnd}
                                                    worktreeInfo={item.task.sessionWorktreeBranch
                                                        ? { branch: item.task.sessionWorktreeBranch, prInfo: item.task.sessionWorktreePrInfo }
                                                        : undefined}
                                                />
                                            );
                                        } else if (item.type === 'worktree-single') {
                                            const t = item.group.tasks[0];
                                            return (
                                                <TaskItem
                                                    key={item.group.workspace.id}
                                                    task={t}
                                                    index={0}
                                                    isSelected={selectedTaskId === t.id}
                                                    isLastSelected={lastSelectedTaskId === t.id}
                                                    hasActiveQuestion={waitingInputTaskIds.has(t.id)}
                                                    hasUnreadActivity={unreadTaskIds.has(t.id)}
                                                    onDeleteTask={onDeleteTask}
                                                    onInterruptTask={onInterruptTask}
                                                    onArchiveTask={onArchiveTask}
                                                    onRevertTask={onRevertTask}
                                                    onSelectTask={onSelectTask}
                                                    onRenameTask={onRenameTask}
                                                    onOpenScheduledTasks={onOpenScheduledTasks}
                                                    isDragging={false}
                                                    dragIndex={null}
                                                    dragOverIndex={null}
                                                    onDragStart={() => {}}
                                                    onDragEnter={() => {}}
                                                    onDragEnd={() => {}}
                                                    worktreeInfo={{
                                                        branch: item.group.workspace.worktreeBranch || item.group.branch,
                                                        prInfo: item.group.workspace.prInfo,
                                                    }}
                                                />
                                            );
                                        } else {
                                            return (
                                                <WorktreeGroupSection
                                                    key={item.group.workspace.id}
                                                    group={item.group}
                                                    selectedTaskId={selectedTaskId}
                                                    lastSelectedTaskId={lastSelectedTaskId}
                                                    waitingInputTaskIds={waitingInputTaskIds}
                                                    unreadTaskIds={unreadTaskIds}
                                                    onDeleteTask={onDeleteTask}
                                                    onInterruptTask={onInterruptTask}
                                                    onArchiveTask={onArchiveTask}
                                                    onRevertTask={onRevertTask}
                                                    onSelectTask={onSelectTask}
                                                    onRenameTask={onRenameTask}
                                                    onOpenScheduledTasks={onOpenScheduledTasks}
                                                    onRemoveWorktree={onRemoveWorktree}
                                                />
                                            );
                                        }
                                    });
                                })()}
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
                </div>
            )}

            {/* Worktree Create Modal */}
            {showWorktreeModal && onCreateWorktree && (
                <WorktreeCreateModal
                    workspace={workspace}
                    onClose={() => { setShowWorktreeModal(false); setWorktreeError(null); }}
                    onCreated={() => { setShowWorktreeModal(false); setWorktreeError(null); }}
                    onCreateWorktree={onCreateWorktree}
                />
            )}

            {/* Worktree Manager Panel */}
            {showWorktreeManager && (
                <WorktreeManagerPanel
                    workspace={workspace}
                    allWorkspaces={allWorkspaces}
                    onClose={() => setShowWorktreeManager(false)}
                    onRemoveWorktree={onRemoveWorktree}
                    onSelectWorkspace={onSelectWorkspace}
                    onCreateWorktree={() => { setShowWorktreeManager(false); setShowWorktreeModal(true); }}
                />
            )}

            {/* Worktree error toast */}
            {worktreeError && (
                <div className="worktree-error-toast" onClick={() => setWorktreeError(null)}>
                    <AlertCircle size={14} />
                    <span>{worktreeError}</span>
                    <X size={12} />
                </div>
            )}

            {showResetConfirm && (
                <ConfirmModal
                    title="Reset Workspace"
                    variant="warning"
                    confirmLabel="Reset"
                    cancelLabel="Cancel"
                    onConfirm={() => {
                        onResetWorkspace?.();
                        setShowResetConfirm(false);
                        // Refresh branch name after reset (slight delay for git checkout to complete)
                        setTimeout(async () => {
                            try {
                                const params = new URLSearchParams({ workspace: workspace.id });
                                const res = await fetch(`${getApiBaseUrl()}/api/workspaces/git-status?${params}`);
                                if (res.ok) {
                                    const data = await res.json();
                                    setBranchName(data.branch || null);
                                }
                            } catch { /* ignore */ }
                        }, 1500);
                    }}
                    onCancel={() => setShowResetConfirm(false)}
                >
                    <p>
                        This will reset <strong>{workspace.displayName || workspace.name}</strong> to a clean state:
                    </p>
                    <ul>
                        <li>Archive all {tasks.length} task{tasks.length !== 1 ? 's' : ''} in this workspace</li>
                        <li>Switch to the default branch (main/master)</li>
                    </ul>
                    <div className="confirm-note">
                        Archived tasks can be recovered from the archive section at any time.
                    </div>
                </ConfirmModal>
            )}
        </div>
    );
}

interface ArchivedTaskItemProps {
    task: Task;
    workspaceName?: string;
    onContinue: (taskId: string) => void;
    onRestore: (taskId: string) => void;
    onDelete: (taskId: string) => void;
}

function ArchivedTaskItem({ task, workspaceName, onContinue, onRestore, onDelete }: ArchivedTaskItemProps) {
    // Use displayName if set, otherwise fall back to prompt parsing
    const segments = task.prompt.split('⏺').map(s => s.trim()).filter(Boolean);
    const lastSegment = task.displayName || (segments.length > 0 ? segments[segments.length - 1] : task.prompt);

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
                <div className="archived-task-meta">
                    {workspaceName && <span className="archived-task-workspace" title={task.workspaceId}>{workspaceName}</span>}
                    {workspaceName && <span className="archived-task-meta-separator">·</span>}
                    <span className="archived-task-date">{archivedDate}</span>
                </div>
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
    onSetWorkspaceOrder: (orderedIds: string[]) => void;
    onReorderTasksOnServer: (taskOrders: { taskId: string; order: number }[]) => void;
    onOpenFolder: (workspaceId: string) => void;
    onOpenTerminal: (workspaceId: string) => void;
    onOpenShell: (workspaceId: string) => void;
    onPushToGithub: (workspaceId: string) => void;
    onSetSystemPrompt: (workspaceId: string, systemPrompt: string) => void;
    onCreateTask: (prompt: string, workspaceId: string, initialCols?: number, initialRows?: number, isolate?: boolean) => void;
    onSelectTask: (taskId: string) => void;
    onRequestArchivedTasks?: () => void;
    onRestoreArchivedTask?: (taskId: string) => void;
    onDeleteArchivedTask?: (taskId: string) => void;
    onContinueArchivedTask?: (taskId: string) => void;
    onRenameTask?: (taskId: string, displayName: string) => void;
    onRenameWorkspace?: (workspaceId: string, displayName: string) => void;
    onToggleReference?: (workspaceId: string, referencePath: string) => void;
    onAddCustomReference?: (workspaceId: string, path: string, description?: string) => void;
    onRemoveReference?: (workspaceId: string, referenceId: string) => void;
    onResetWorkspace?: (workspaceId: string) => void;
    onResolveDeleteRequest?: (requestId: string, approvedIds: string[], rejectedIds: string[]) => void;
    onCollapse?: () => void;
}

export function WorkspacePanel({
    onDeleteTask,
    onInterruptTask,
    onArchiveTask,
    onRevertTask,
    onCreateWorkspace,
    onDeleteWorkspace,
    onReorderWorkspaces,
    onSetWorkspaceOrder,
    onReorderTasksOnServer,
    onOpenFolder,
    onOpenTerminal,
    onOpenShell,
    onPushToGithub,
    onSetSystemPrompt,
    onCreateTask,
    onSelectTask,
    onRequestArchivedTasks,
    onRestoreArchivedTask,
    onDeleteArchivedTask,
    onContinueArchivedTask,
    onRenameTask,
    onRenameWorkspace,
    onToggleReference,
    onAddCustomReference,
    onRemoveReference,
    onResetWorkspace,
    onResolveDeleteRequest,
    onCollapse
}: WorkspacePanelProps) {
    const {
        tasks,
        workspaces,
        selectedTaskId,
        expandedWorkspaces,
        toggleWorkspaceExpanded,
        waitingInputNotifications,
        unreadTaskIds,
        archivedTasks,
        showArchivedTasks,
        setShowArchivedTasks,
        reorderTasks,
        workspaceColumns,
        setWorkspaceColumns,
        workspaceSortBy,
        setWorkspaceSortBy,
        taskSortBy,
        lastSelectedTaskByWorkspace,
        pendingDeleteRequest,
        setPendingDeleteRequest
    } = useTaskStore();

    // Drag and drop state
    const [dragIndex, setDragIndex] = useState<number | null>(null);
    const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

    // Menu state - which workspace menu is open
    const [openMenuId, setOpenMenuId] = useState<string | null>(null);

    // System prompt modal state
    const [systemPromptWorkspace, setSystemPromptWorkspace] = useState<Workspace | null>(null);

    // Scheduled tasks modal state
    const [scheduledTasksForTaskId, setScheduledTasksForTaskId] = useState<string | null>(null);
    const scheduledTasksTask = scheduledTasksForTaskId ? tasks.get(scheduledTasksForTaskId) : null;

    // Workspace manager modal state
    const [showWorkspaceManager, setShowWorkspaceManager] = useState(false);

    // Close menu when clicking outside (capture phase so stopPropagation on child elements doesn't block it)
    // or when the panel scrolls (menu is position:fixed and would detach from its trigger).
    useEffect(() => {
        if (!openMenuId) return;

        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (!target.closest('.workspace-menu-container')) {
                setOpenMenuId(null);
            }
        };
        const handleScroll = () => setOpenMenuId(null);

        document.addEventListener('mousedown', handleClickOutside, true);
        const scrollContainer = document.querySelector('.workspace-panel-content');
        scrollContainer?.addEventListener('scroll', handleScroll);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside, true);
            scrollContainer?.removeEventListener('scroll', handleScroll);
        };
    }, [openMenuId]);

    // Get last modified time for a workspace (most recent task activity).
    // Defined here (above drag handlers) because handleDragEnd needs sortedWorkspaces.
    const getWorkspaceLastModified = (workspaceId: string): Date => {
        const workspaceTasks = Array.from(tasks.values()).filter(t => t.workspaceId === workspaceId);
        if (workspaceTasks.length === 0) {
            const workspace = workspaces.find(w => w.id === workspaceId);
            return workspace ? new Date(workspace.createdAt) : new Date(0);
        }
        const mostRecent = workspaceTasks.reduce((latest, task) => {
            const taskTime = new Date(task.lastActivity || task.createdAt).getTime();
            return taskTime > latest ? taskTime : latest;
        }, 0);
        return new Date(mostRecent);
    };

    // Sort workspaces based on user preference. 'manual' preserves the
    // backend-persisted order — drag-drop only has visible effect in this mode.
    // Worktree child workspaces are excluded from the top-level list and rendered
    // inline within their parent WorkspaceSection instead.
    const sortedWorkspaces = (() => {
        const parentWorkspaces = workspaces.filter(w => !w.worktreeParentId);
        if (workspaceSortBy === 'manual') return parentWorkspaces;
        return [...parentWorkspaces].sort((a, b) => {
            switch (workspaceSortBy) {
                case 'alphabetical': {
                    const nameA = (a.displayName || a.name).toLowerCase();
                    const nameB = (b.displayName || b.name).toLowerCase();
                    return nameA.localeCompare(nameB);
                }
                case 'last-modified': {
                    const timeA = getWorkspaceLastModified(a.id).getTime();
                    const timeB = getWorkspaceLastModified(b.id).getTime();
                    return timeB - timeA;
                }
                case 'date-created':
                default:
                    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
            }
        });
    })();

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
            if (workspaceSortBy === 'manual') {
                // Indices line up with the underlying stored array — use the cheap reorder.
                onReorderWorkspaces(dragIndex, dragOverIndex);
            } else {
                // Indices are positions in the rendered (sorted) list, not the stored
                // array. Send the rendered order verbatim so the backend adopts it,
                // then auto-switch to manual so the user actually sees the result —
                // otherwise the broadcast gets re-sorted away.
                const reordered = [...sortedWorkspaces];
                const [moved] = reordered.splice(dragIndex, 1);
                reordered.splice(dragOverIndex, 0, moved);
                onSetWorkspaceOrder(reordered.map(w => w.id));
                setWorkspaceSortBy('manual');
            }
        }
        setDragIndex(null);
        setDragOverIndex(null);
    }, [dragIndex, dragOverIndex, onReorderWorkspaces, onSetWorkspaceOrder, workspaceSortBy, sortedWorkspaces, setWorkspaceSortBy]);

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
        setShowWorkspaceManager(true);
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

    // Sort tasks by user preference
    const sortTasks = (taskList: Task[]): Task[] => {
        return taskList.sort((a, b) => {
            if (a.order !== undefined && b.order !== undefined) return a.order - b.order;
            if (a.order !== undefined) return -1;
            if (b.order !== undefined) return 1;
            switch (taskSortBy) {
                case 'last-modified': {
                    const timeA = new Date(a.lastActivity || a.createdAt).getTime();
                    const timeB = new Date(b.lastActivity || b.createdAt).getTime();
                    return timeB - timeA;
                }
                case 'date-created':
                default:
                    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
            }
        });
    };

    // Direct tasks for a workspace (excludes tasks in child worktrees)
    const getTasksForWorkspace = (workspaceId: string): Task[] => {
        return sortTasks(Array.from(tasks.values()).filter(t => t.workspaceId === workspaceId));
    };

    // Build inline worktree groups for a parent workspace
    const getWorktreeGroupsForWorkspace = (parentId: string): WorktreeGroup[] => {
        const childWorkspaces = workspaces.filter(w => w.worktreeParentId === parentId);
        return childWorkspaces.map(ws => ({
            workspace: ws,
            // Show human-readable name if task has been named, otherwise fall back to branch
            branch: ws.displayName || ws.worktreeBranch || ws.name,
            tasks: sortTasks(Array.from(tasks.values()).filter(t => t.workspaceId === ws.id)),
        })).filter(g => g.tasks.length > 0); // only show groups that have tasks
    };


    // Worktree handlers
    const apiBase = getApiBaseUrl();

    const handleCreateWorktree = useCallback(async (workspaceId: string, branch: string, baseBranch?: string, createBranch = true) => {
        const params = new URLSearchParams({ workspace: workspaceId });
        const res = await fetch(`${apiBase}/api/worktrees?${params}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ branch, baseBranch, createBranch }),
        });
        if (!res.ok) {
            const d = await res.json().catch(() => ({}));
            throw new Error(d.error || 'Failed to create worktree');
        }
    }, [apiBase]);

    const handleRemoveWorktree = useCallback(async (worktreePath: string, force = false) => {
        // Find the parent workspace for this worktree
        const worktreeWs = workspaces.find(w => w.id === worktreePath);
        const parentId = worktreeWs?.worktreeParentId ?? '';
        const params = new URLSearchParams({ workspace: parentId, worktreePath, force: String(force) });
        const res = await fetch(`${apiBase}/api/worktrees?${params}`, { method: 'DELETE' });
        if (!res.ok) {
            const d = await res.json().catch(() => ({}));
            throw new Error(d.error || 'Failed to remove worktree');
        }
    }, [apiBase, workspaces]);

    const handleToggleAutoWorktree = useCallback((workspaceId: string, enabled: boolean) => {
        const params = new URLSearchParams({ workspace: workspaceId });
        fetch(`${apiBase}/api/worktrees/auto?${params}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled }),
        }).catch(err => console.error('[WorkspacePanel] autoWorktree toggle failed:', err));
    }, [apiBase]);

    const handleSelectWorkspace = useCallback((workspaceId: string) => {
        // Expand the target workspace and select its last task (or just expand it)
        toggleWorkspaceExpanded(workspaceId);
        const lastTask = lastSelectedTaskByWorkspace.get(workspaceId);
        if (lastTask) onSelectTask(lastTask);
    }, [toggleWorkspaceExpanded, lastSelectedTaskByWorkspace, onSelectTask]);

    // External drag-and-drop (from OS file explorer) to add workspaces.
    // Only activates when dataTransfer contains files — internal workspace
    // reordering drags don't have files so they pass through unaffected.
    const [isDragOver, setIsDragOver] = useState(false);
    const isExternalDrag = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');
    const handleDragOver = (e: React.DragEvent) => {
        if (!isExternalDrag(e)) return; // let internal drags pass through
        e.preventDefault();
        setIsDragOver(true);
    };
    const handleDragLeave = (e: React.DragEvent) => {
        if (!isExternalDrag(e)) return;
        setIsDragOver(false);
    };
    const handleDrop = (e: React.DragEvent) => {
        if (!isExternalDrag(e)) return; // let internal drops pass through
        e.preventDefault();
        setIsDragOver(false);
        // Electron gives full paths via file.path
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            const file = files[0] as any;
            const fullPath = file.path; // Electron only
            if (fullPath) {
                onCreateWorkspace(fullPath);
                return;
            }
        }
        // Browser fallback: open the path input modal
        handleAddWorkspace();
    };

    return (
        <div
            className={`workspace-panel${isDragOver ? ' drag-over' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            {isDragOver && (
                <div className="workspace-drop-overlay">
                    <FolderPlus size={32} />
                    <span>Drop folder to add workspace</span>
                </div>
            )}
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
                    <div className="column-selector" title="Sort workspaces by">
                        <ArrowDownAZ size={14} className="column-selector-icon" />
                        <select
                            className="column-selector-select"
                            value={workspaceSortBy}
                            onChange={(e) => setWorkspaceSortBy(e.target.value as 'date-created' | 'last-modified' | 'alphabetical' | 'manual')}
                        >
                            <option value="date-created">Date Created</option>
                            <option value="last-modified">Last Modified</option>
                            <option value="alphabetical">Alphabetical</option>
                            <option value="manual">Manual (drag to reorder)</option>
                        </select>
                    </div>
                    <div className="column-selector" title="Workspace columns">
                        <Columns2 size={14} className="column-selector-icon" />
                        <select
                            className="column-selector-select"
                            value={workspaceColumns}
                            onChange={(e) => setWorkspaceColumns(Number(e.target.value))}
                        >
                            <option value={0}>Auto</option>
                            <option value={1}>1 col</option>
                            <option value={2}>2 col</option>
                            <option value={3}>3 col</option>
                            <option value={4}>4 col</option>
                        </select>
                    </div>
                    <button
                        className="workspace-manager-button"
                        onClick={() => setShowWorkspaceManager(true)}
                        title="Manage workspaces"
                    >
                        <Settings size={16} />
                    </button>
                    <button
                        className="add-workspace-button"
                        onClick={handleAddWorkspace}
                        title="Add workspace"
                    >
                        <Plus size={16} />
                    </button>
                    {onCollapse && (
                        <button
                            className="archived-toggle-button"
                            onClick={onCollapse}
                            title="Hide workspaces"
                        >
                            <ChevronLeft size={16} />
                        </button>
                    )}
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
                            {[...archivedTasks].sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()).map(task => {
                                const ws = workspaces.find(w => w.id === task.workspaceId);
                                // Use display name, workspace name, or fall back to last path segment
                                const wsName = ws?.displayName || ws?.name || (task.workspaceId ? task.workspaceId.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : undefined);
                                return (
                                    <ArchivedTaskItem
                                        key={task.id}
                                        task={task}
                                        workspaceName={wsName}
                                        onContinue={onContinueArchivedTask || (() => { })}
                                        onRestore={onRestoreArchivedTask || (() => { })}
                                        onDelete={onDeleteArchivedTask || (() => { })}
                                    />
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            <div
                className="workspace-panel-content"
                style={workspaceColumns > 0 ? { gridTemplateColumns: `repeat(${workspaceColumns}, 1fr)` } : undefined}
            >
                {sortedWorkspaces.length === 0 ? (
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
                    sortedWorkspaces.map((workspace, index) => (
                        <WorkspaceSection
                            key={workspace.id}
                            workspace={workspace}
                            tasks={getTasksForWorkspace(workspace.id)}
                            worktreeGroups={getWorktreeGroupsForWorkspace(workspace.id)}
                            waitingInputTaskIds={waitingInputTaskIds}
                            unreadTaskIds={unreadTaskIds}
                            selectedTaskId={selectedTaskId}
                            lastSelectedTaskId={lastSelectedTaskByWorkspace.get(workspace.id) || null}
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
                            onOpenShell={() => onOpenShell(workspace.id)}
                            onPushToGithub={() => onPushToGithub(workspace.id)}
                            onSystemPrompt={() => setSystemPromptWorkspace(workspace)}
                            onToggleMenu={() => setOpenMenuId(openMenuId === workspace.id ? null : workspace.id)}
                            onCreateTask={(prompt, cols, rows, isolate) => onCreateTask(prompt, workspace.id, cols, rows, isolate)}
                            onDragStart={handleDragStart}
                            onDragEnter={handleDragEnter}
                            onDragEnd={handleDragEnd}
                            onReorderTasks={(fromIndex, toIndex) => {
                                reorderTasks(workspace.id, fromIndex, toIndex);
                                // After local reorder, get updated tasks and send order to backend
                                const updatedTasks = useTaskStore.getState().tasks;
                                const taskOrders = Array.from(updatedTasks.values())
                                    .filter(t => t.workspaceId === workspace.id && t.order !== undefined)
                                    .map(t => ({ taskId: t.id, order: t.order! }));
                                if (taskOrders.length > 0) {
                                    onReorderTasksOnServer(taskOrders);
                                }
                            }}
                            onRenameTask={onRenameTask}
                            onRenameWorkspace={onRenameWorkspace}
                            allWorkspaces={workspaces}
                            onToggleReference={onToggleReference}
                            onAddCustomReference={onAddCustomReference}
                            onRemoveReference={onRemoveReference}
                            onResetWorkspace={() => onResetWorkspace?.(workspace.id)}
                            onOpenScheduledTasks={(taskId) => setScheduledTasksForTaskId(taskId)}
                            worktreeCount={workspaces.filter(w => w.worktreeParentId === workspace.id).length}
                            onCreateWorktree={handleCreateWorktree}
                            onRemoveWorktree={handleRemoveWorktree}
                            onToggleAutoWorktree={handleToggleAutoWorktree}
                            onSelectWorkspace={handleSelectWorkspace}
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

            {scheduledTasksForTaskId && scheduledTasksTask && (
                <ScheduledTasksModal
                    taskId={scheduledTasksForTaskId}
                    taskName={scheduledTasksTask.displayName || scheduledTasksTask.prompt?.substring(0, 60) || scheduledTasksForTaskId}
                    onClose={() => setScheduledTasksForTaskId(null)}
                />
            )}

            {showWorkspaceManager && (
                <WorkspaceManager
                    workspaces={workspaces}
                    onClose={() => setShowWorkspaceManager(false)}
                    onCreateWorkspace={onCreateWorkspace}
                    onDeleteWorkspace={onDeleteWorkspace}
                    onReorderWorkspaces={onReorderWorkspaces}
                />
            )}

            {pendingDeleteRequest && (
                <BulkDeleteModal
                    request={pendingDeleteRequest}
                    onResolve={(approvedIds, rejectedIds) => {
                        onResolveDeleteRequest?.(pendingDeleteRequest.requestId, approvedIds, rejectedIds);
                        setPendingDeleteRequest(null);
                    }}
                />
            )}
        </div>
    );
}
