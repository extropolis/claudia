import { useState, useEffect, useCallback } from 'react';
import { Clock, Plus, Trash2, X, RefreshCw, Pencil, Copy, Check, Pause, Play } from 'lucide-react';
import { useTaskStore } from '../stores/taskStore';
import { useWebSocket } from '../hooks/useWebSocket';
import { ScheduledTask } from '@claudia/shared';
import { getApiBaseUrl } from '../config/api-config';
import './ScheduledTasksModal.css';

const API_URL = getApiBaseUrl();

interface ScheduledTasksModalProps {
    taskId: string;
    taskName: string;
    initialPrompt?: string;
    onClose: () => void;
}

/** Common cron presets for quick selection */
const CRON_PRESETS = [
    { label: 'Every 1 min', expression: '* * * * *' },
    { label: 'Every 5 min', expression: '*/5 * * * *' },
    { label: 'Every 10 min', expression: '*/10 * * * *' },
    { label: 'Every 30 min', expression: '*/30 * * * *' },
    { label: 'Every hour', expression: '0 * * * *' },
    { label: 'Daily 9am', expression: '0 9 * * *' },
    { label: 'Weekdays 9am', expression: '0 9 * * 1-5' },
];

function formatNextFire(iso: string | undefined): string {
    if (!iso) return 'N/A';
    const date = new Date(iso);
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();

    if (diffMs < 0) return 'overdue';
    if (diffMs < 60000) return 'less than 1m';
    if (diffMs < 3600000) return `in ${Math.round(diffMs / 60000)}m`;
    if (diffMs < 86400000) return `in ${Math.round(diffMs / 3600000)}h`;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatExpiry(iso: string): string {
    const date = new Date(iso);
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    if (diffMs < 0) return 'expired';
    const days = Math.floor(diffMs / 86400000);
    const hours = Math.floor((diffMs % 86400000) / 3600000);
    if (days > 0) return `${days}d ${hours}h remaining`;
    return `${hours}h remaining`;
}

export function ScheduledTasksModal({ taskId, taskName, initialPrompt, onClose }: ScheduledTasksModalProps) {
    const { createScheduledTask, deleteScheduledTask, updateScheduledTask, pauseScheduledTask } = useWebSocket();
    const scheduledTasks = useTaskStore(state =>
        Array.from(state.scheduledTasks.values()).filter(s => s.taskId === taskId)
    );

    // Auto-open create form with initial prompt if provided
    const hasInitialPrompt = !!initialPrompt;

    // Form state (shared between create and edit modes)
    const [formMode, setFormMode] = useState<'hidden' | 'create' | 'edit'>(hasInitialPrompt ? 'create' : 'hidden');
    const [editingId, setEditingId] = useState<string | null>(null);
    const [cronExpression, setCronExpression] = useState('*/10 * * * *');
    const [prompt, setPrompt] = useState(initialPrompt || '');
    const [isRecurring, setIsRecurring] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [copiedId, setCopiedId] = useState<string | null>(null);

    // Refresh scheduled tasks from backend
    const refreshTasks = useCallback(() => {
        fetch(`${API_URL}/api/cron`)
            .then(r => r.json())
            .then(tasks => useTaskStore.getState().setScheduledTasks(tasks))
            .catch(err => console.error('Failed to refresh scheduled tasks:', err));
    }, []);

    // Refresh on mount
    useEffect(() => {
        refreshTasks();
    }, [refreshTasks]);

    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            if (formMode !== 'hidden') {
                resetForm();
            } else {
                onClose();
            }
        }
    }, [onClose, formMode]);

    useEffect(() => {
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [handleKeyDown]);

    const resetForm = () => {
        setFormMode('hidden');
        setEditingId(null);
        setPrompt('');
        setCronExpression('*/10 * * * *');
        setIsRecurring(true);
    };

    const handleStartCreate = () => {
        resetForm();
        setFormMode('create');
    };

    const handleStartEdit = (st: ScheduledTask) => {
        setCronExpression(st.cronExpression);
        setPrompt(st.prompt);
        setIsRecurring(st.isRecurring);
        setEditingId(st.id);
        setFormMode('edit');
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!cronExpression.trim() || !prompt.trim()) return;
        setSubmitting(true);

        if (formMode === 'edit' && editingId) {
            updateScheduledTask(editingId, {
                cronExpression: cronExpression.trim(),
                prompt: prompt.trim(),
                isRecurring,
            });
        } else {
            createScheduledTask(taskId, cronExpression.trim(), prompt.trim(), isRecurring);
        }

        setTimeout(() => {
            refreshTasks();
            setSubmitting(false);
            resetForm();
        }, 500);
    };

    const handleDelete = (cronId: string) => {
        deleteScheduledTask(cronId);
        if (editingId === cronId) resetForm();
        setTimeout(refreshTasks, 300);
    };

    const handleCopyPrompt = async (cronId: string, promptText: string) => {
        try {
            await navigator.clipboard.writeText(promptText);
            setCopiedId(cronId);
            setTimeout(() => setCopiedId(null), 1500);
        } catch (err) {
            console.error('Failed to copy prompt:', err);
        }
    };

    const handleTogglePause = (cronId: string, currentlyPaused: boolean) => {
        pauseScheduledTask(cronId, !currentlyPaused);
        setTimeout(refreshTasks, 300);
    };

    return (
        <div className="modal-overlay scheduled-tasks-overlay" onClick={onClose}>
            <div className="modal-content scheduled-tasks-modal" onClick={e => e.stopPropagation()}>
                <div className="scheduled-tasks-header">
                    <div className="scheduled-tasks-title">
                        <Clock size={18} />
                        <h2>Scheduled Tasks</h2>
                    </div>
                    <button className="scheduled-tasks-close" onClick={onClose}>
                        <X size={18} />
                    </button>
                </div>
                <p className="scheduled-tasks-description">
                    Manage scheduled prompts for <strong>{taskName}</strong>.
                    Prompts are sent to the task at scheduled times when it is idle.
                </p>

                {/* Scheduled tasks list */}
                <div className="scheduled-tasks-list">
                    {scheduledTasks.length === 0 && formMode === 'hidden' && (
                        <div className="scheduled-tasks-empty">
                            <Clock size={24} />
                            <p>No scheduled tasks</p>
                            <span>Create one to run prompts on a schedule</span>
                        </div>
                    )}

                    {scheduledTasks.map((st: ScheduledTask) => (
                        <div key={st.id} className={`scheduled-task-item ${editingId === st.id ? 'editing' : ''} ${st.isPaused ? 'paused' : ''}`}>
                            <div className="scheduled-task-info">
                                <div className="scheduled-task-top">
                                    {st.isPaused && (
                                        <span className="scheduled-task-badge paused">paused</span>
                                    )}
                                    <span className={`scheduled-task-badge ${st.isRecurring ? 'recurring' : 'one-shot'}`}>
                                        {st.isRecurring ? 'recurring' : 'one-shot'}
                                    </span>
                                    <code className="scheduled-task-cron">{st.cronExpression}</code>
                                    <span className="scheduled-task-id">#{st.id}</span>
                                </div>
                                <div className="scheduled-task-prompt">{st.prompt}</div>
                                <div className="scheduled-task-meta">
                                    <span title={st.nextFireAt || ''}>{st.isPaused ? 'Paused' : `Next: ${formatNextFire(st.nextFireAt)}`}</span>
                                    <span>Fired: {st.fireCount}x</span>
                                    <span title={st.expiresAt}>{formatExpiry(st.expiresAt)}</span>
                                </div>
                            </div>
                            <div className="scheduled-task-actions">
                                <button
                                    className={`scheduled-task-pause ${st.isPaused ? 'is-paused' : ''}`}
                                    onClick={() => handleTogglePause(st.id, !!st.isPaused)}
                                    title={st.isPaused ? 'Resume scheduled task' : 'Pause scheduled task'}
                                >
                                    {st.isPaused ? <Play size={14} /> : <Pause size={14} />}
                                </button>
                                <button
                                    className="scheduled-task-copy"
                                    onClick={() => handleCopyPrompt(st.id, st.prompt)}
                                    title="Copy prompt"
                                >
                                    {copiedId === st.id ? <Check size={14} /> : <Copy size={14} />}
                                </button>
                                <button
                                    className="scheduled-task-edit"
                                    onClick={() => handleStartEdit(st)}
                                    title="Edit scheduled task"
                                >
                                    <Pencil size={14} />
                                </button>
                                <button
                                    className="scheduled-task-delete"
                                    onClick={() => handleDelete(st.id)}
                                    title="Delete scheduled task"
                                >
                                    <Trash2 size={14} />
                                </button>
                            </div>
                        </div>
                    ))}
                </div>

                {/* Create/Edit form */}
                {formMode !== 'hidden' ? (
                    <form className="scheduled-task-form" onSubmit={handleSubmit}>
                        <div className="scheduled-task-form-title">
                            {formMode === 'edit' ? `Edit #${editingId}` : 'New Schedule'}
                        </div>
                        <div className="form-group">
                            <label>Cron Expression</label>
                            <div className="cron-input-row">
                                <input
                                    type="text"
                                    value={cronExpression}
                                    onChange={e => setCronExpression(e.target.value)}
                                    placeholder="*/5 * * * *"
                                    autoFocus
                                />
                            </div>
                            <div className="cron-presets">
                                {CRON_PRESETS.map(p => (
                                    <button
                                        key={p.expression}
                                        type="button"
                                        className={`cron-preset-btn ${cronExpression === p.expression ? 'active' : ''}`}
                                        onClick={() => setCronExpression(p.expression)}
                                    >
                                        {p.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="form-group">
                            <label>Prompt</label>
                            <textarea
                                value={prompt}
                                onChange={e => setPrompt(e.target.value)}
                                placeholder="Enter the prompt to send at each scheduled time..."
                                rows={3}
                            />
                        </div>
                        <div className="form-group form-group-inline">
                            <label className="checkbox-label">
                                <input
                                    type="checkbox"
                                    checked={isRecurring}
                                    onChange={e => setIsRecurring(e.target.checked)}
                                />
                                Recurring
                            </label>
                            <span className="help-text">
                                {isRecurring ? 'Repeats until expired (3 days)' : 'Fires once then deletes itself'}
                            </span>
                        </div>
                        <div className="scheduled-task-form-actions">
                            <button type="button" className="btn-secondary" onClick={resetForm}>
                                Cancel
                            </button>
                            <button
                                type="submit"
                                className="btn-primary"
                                disabled={!cronExpression.trim() || !prompt.trim() || submitting}
                            >
                                {submitting ? (formMode === 'edit' ? 'Saving...' : 'Creating...') : (formMode === 'edit' ? 'Save' : 'Create')}
                            </button>
                        </div>
                    </form>
                ) : (
                    <div className="scheduled-tasks-footer">
                        <button className="btn-primary scheduled-tasks-add" onClick={handleStartCreate}>
                            <Plus size={14} />
                            Add Schedule
                        </button>
                        <button className="btn-secondary scheduled-tasks-refresh" onClick={refreshTasks} title="Refresh">
                            <RefreshCw size={14} />
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
