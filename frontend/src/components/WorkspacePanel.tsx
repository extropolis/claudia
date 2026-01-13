import { useState } from 'react';
import { useTaskStore } from '../stores/taskStore';
import { Task, Workspace } from '@claudia/shared';
import {
    Loader2, CheckCircle, XCircle, Circle, ChevronRight, ChevronDown,
    Copy, Check, Trash2, FolderOpen, Plus, Briefcase, StopCircle, Square
} from 'lucide-react';
import { TaskCreateModal } from './TaskCreateModal';
import './WorkspacePanel.css';

function getStatusIcon(status: Task['status']) {
    switch (status) {
        case 'running':
            return <Loader2 className="status-icon spinning" size={14} />;
        case 'complete':
            return <CheckCircle className="status-icon complete" size={14} />;
        case 'error':
            return <XCircle className="status-icon error" size={14} />;
        case 'stopped':
            return <StopCircle className="status-icon stopped" size={14} />;
        case 'pending':
        default:
            return <Circle className="status-icon pending" size={14} />;
    }
}

interface TaskItemProps {
    task: Task;
    depth?: number;
    onDeleteTask: (taskId: string) => void;
    onStopTask: (taskId: string) => void;
}

function TaskItem({ task, depth = 0, onDeleteTask, onStopTask }: TaskItemProps) {
    const { selectedTaskId, selectTask, tasks } = useTaskStore();
    const [copied, setCopied] = useState(false);
    const isSelected = selectedTaskId === task.id;

    // Find child tasks
    const children = Array.from(tasks.values()).filter(t => t.parentId === task.id);

    const copyTaskOutput = async (e: React.MouseEvent) => {
        e.stopPropagation();
        const output = [
            `Task: ${task.name}`,
            `Status: ${task.status}`,
            `Description: ${task.description}`,
            '',
            '--- Output ---',
            '',
            ...task.output
        ].join('\n');

        try {
            await navigator.clipboard.writeText(output);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    const handleDelete = (e: React.MouseEvent) => {
        e.stopPropagation();
        onDeleteTask(task.id);
    };

    const handleStop = (e: React.MouseEvent) => {
        e.stopPropagation();
        onStopTask(task.id);
    };

    return (
        <div className="task-item-container">
            <div
                className={`task-item ${isSelected ? 'selected' : ''} ${task.status}`}
                style={{ paddingLeft: `${8 + depth * 12}px` }}
                onClick={() => selectTask(task.id)}
            >
                {getStatusIcon(task.status)}
                <span className="task-name">{task.name}</span>
                {task.status === 'running' && (
                    <button
                        className="task-action-button stop"
                        onClick={handleStop}
                        title="Stop task"
                    >
                        <Square size={10} />
                    </button>
                )}
                <button
                    className={`task-action-button ${copied ? 'copied' : ''}`}
                    onClick={copyTaskOutput}
                    title="Copy task output"
                >
                    {copied ? <Check size={10} /> : <Copy size={10} />}
                </button>
                <button
                    className="task-action-button delete"
                    onClick={handleDelete}
                    title="Delete task"
                >
                    <Trash2 size={10} />
                </button>
            </div>
            {children.map(child => (
                <TaskItem key={child.id} task={child} depth={depth + 1} onDeleteTask={onDeleteTask} onStopTask={onStopTask} />
            ))}
        </div>
    );
}

interface WorkspaceSectionProps {
    workspace: Workspace;
    tasks: Map<string, Task>;
    onDeleteTask: (taskId: string) => void;
    onStopTask: (taskId: string) => void;
    onDeleteWorkspace: () => void;
    onAddTask: (workspaceId: string) => void;
}

function WorkspaceSection({
    workspace,
    tasks,
    onDeleteTask,
    onStopTask,
    onDeleteWorkspace,
    onAddTask
}: WorkspaceSectionProps) {
    const { expandedWorkspaces, toggleWorkspaceExpanded } = useTaskStore();
    const isExpanded = expandedWorkspaces.has(workspace.id);

    // Get tasks for this workspace (matching projectPath to workspace path)
    const workspaceTasks = Array.from(tasks.values()).filter(t =>
        !t.parentId && t.projectPath === workspace.id
    );

    return (
        <div className="workspace-section">
            <div className="workspace-header">
                <div className="workspace-header-left" onClick={() => toggleWorkspaceExpanded(workspace.id)}>
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <Briefcase size={16} className="workspace-icon" />
                    <span className="workspace-name" title={workspace.id}>{workspace.name}</span>
                    {workspaceTasks.length > 0 && (
                        <span className="workspace-task-count">{workspaceTasks.length}</span>
                    )}
                </div>
                <div className="workspace-header-actions">
                    <button
                        className="workspace-action-button delete"
                        onClick={(e) => { e.stopPropagation(); onDeleteWorkspace(); }}
                        title="Remove workspace"
                    >
                        <Trash2 size={16} />
                    </button>
                    <button
                        className="workspace-action-button add"
                        onClick={(e) => { e.stopPropagation(); onAddTask(workspace.id); }}
                        title="Add task to this workspace"
                    >
                        <Plus size={16} />
                    </button>
                </div>
            </div>
            {isExpanded && (
                <div className="workspace-content">
                    {workspaceTasks.length === 0 ? (
                        <div className="empty-tasks">No tasks yet</div>
                    ) : (
                        workspaceTasks.map(task => (
                            <TaskItem key={task.id} task={task} onDeleteTask={onDeleteTask} onStopTask={onStopTask} />
                        ))
                    )}
                </div>
            )}
        </div>
    );
}

interface WorkspacePanelProps {
    onDeleteTask: (taskId: string) => void;
    onClearTasks: () => void;
    onCreateWorkspace: (path: string) => void;
    onDeleteWorkspace: (workspaceId: string) => void;
    onStopTask: (taskId: string) => void;
    onCreateTask: (name: string, description: string, workspaceId: string) => void;
}

export function WorkspacePanel({
    onDeleteTask,
    // onClearTasks,
    // onCreateWorkspace,
    onDeleteWorkspace,
    onStopTask,
    onCreateTask
}: WorkspacePanelProps) {
    const {
        tasks,
        workspaces,
        setShowProjectPicker,
        showTaskCreateModal,
        taskCreateWorkspaceId,
        setShowTaskCreateModal
    } = useTaskStore();

    const handleAddWorkspace = () => {
        setShowProjectPicker(true);
    };

    const handleAddTask = (workspaceId: string) => {
        setShowTaskCreateModal(true, workspaceId);
    };

    const handleCloseTaskModal = () => {
        setShowTaskCreateModal(false);
    };

    const selectedWorkspace = workspaces.find(w => w.id === taskCreateWorkspaceId);

    return (
        <div className="workspace-panel">
            <div className="workspace-panel-header">
                <h2>📁 Workspaces</h2>
                <button
                    className="add-workspace-button"
                    onClick={handleAddWorkspace}
                    title="Add workspace"
                >
                    <Plus size={14} />
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
                            tasks={tasks}
                            onDeleteTask={onDeleteTask}
                            onStopTask={onStopTask}
                            onDeleteWorkspace={() => onDeleteWorkspace(workspace.id)}
                            onAddTask={handleAddTask}
                        />
                    ))
                )}
            </div>
            {showTaskCreateModal && selectedWorkspace && (
                <TaskCreateModal
                    workspaceId={selectedWorkspace.id}
                    workspaceName={selectedWorkspace.name}
                    onClose={handleCloseTaskModal}
                    onCreateTask={onCreateTask}
                />
            )}
        </div>
    );
}
