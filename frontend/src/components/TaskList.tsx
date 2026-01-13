import { useState } from 'react';
import { useTaskStore } from '../stores/taskStore';
import { Task } from '@claudia/shared';
import { Loader2, CheckCircle, XCircle, Circle, ChevronRight, ChevronDown, Copy, Check, Trash2, Folder, StopCircle, Square } from 'lucide-react';

function getStatusIcon(status: Task['status']) {
    switch (status) {
        case 'running':
            return <Loader2 className="status-icon spinning" size={16} />;
        case 'complete':
            return <CheckCircle className="status-icon complete" size={16} />;
        case 'error':
            return <XCircle className="status-icon error" size={16} />;
        case 'stopped':
            return <StopCircle className="status-icon stopped" size={16} />;
        case 'pending':
        default:
            return <Circle className="status-icon pending" size={16} />;
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
        e.stopPropagation(); // Prevent task selection
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
        e.stopPropagation(); // Prevent task selection
        onDeleteTask(task.id);
    };

    const handleStop = (e: React.MouseEvent) => {
        e.stopPropagation(); // Prevent task selection
        onStopTask(task.id);
    };

    return (
        <div className="task-item-container">
            <div
                className={`task-item ${isSelected ? 'selected' : ''} ${task.status}`}
                style={{ paddingLeft: `${12 + depth * 16}px` }}
                onClick={() => selectTask(task.id)}
            >
                {children.length > 0 && (
                    <ChevronRight className="expand-icon" size={14} />
                )}
                {getStatusIcon(task.status)}
                <span className="task-name">{task.name}</span>
                {task.status === 'running' && (
                    <button
                        className="task-stop-button"
                        onClick={handleStop}
                        title="Stop task"
                    >
                        <Square size={12} />
                    </button>
                )}
                <button
                    className={`task-copy-button ${copied ? 'copied' : ''}`}
                    onClick={copyTaskOutput}
                    title="Copy task output"
                >
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                </button>
                <button
                    className="task-delete-button"
                    onClick={handleDelete}
                    title="Delete task"
                >
                    <Trash2 size={12} />
                </button>
            </div>
            {children.map(child => (
                <TaskItem key={child.id} task={child} depth={depth + 1} onDeleteTask={onDeleteTask} onStopTask={onStopTask} />
            ))}
        </div>
    );
}

interface TaskListProps {
    onDeleteTask: (taskId: string) => void;
    onClearTasks: () => void;
    onStopTask: (taskId: string) => void;
}

export function TaskList({ onDeleteTask, onClearTasks, onStopTask }: TaskListProps) {
    const { tasks } = useTaskStore();
    const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set(['__no_project__']));

    // Get root-level tasks (no parent)
    const rootTasks = Array.from(tasks.values()).filter(t => !t.parentId);

    // Group tasks by project
    const tasksByProject = rootTasks.reduce((acc, task) => {
        const projectKey = task.projectPath || '__no_project__';
        if (!acc[projectKey]) {
            acc[projectKey] = [];
        }
        acc[projectKey].push(task);
        return acc;
    }, {} as Record<string, Task[]>);

    const toggleProject = (projectKey: string) => {
        const newExpanded = new Set(expandedProjects);
        if (newExpanded.has(projectKey)) {
            newExpanded.delete(projectKey);
        } else {
            newExpanded.add(projectKey);
        }
        setExpandedProjects(newExpanded);
    };

    const projectEntries = Object.entries(tasksByProject);

    return (
        <div className="task-list">
            <div className="task-list-header">
                <h2>📋 Tasks</h2>
                {rootTasks.length > 0 && (
                    <button
                        className="clear-tasks-button"
                        onClick={onClearTasks}
                        title="Clear all tasks"
                    >
                        <Trash2 size={14} />
                        Clear
                    </button>
                )}
            </div>
            <div className="task-list-content">
                {rootTasks.length === 0 ? (
                    <div className="empty-state">
                        No tasks yet. Send a message to get started.
                    </div>
                ) : (
                    projectEntries.map(([projectKey, projectTasks]) => {
                        const isExpanded = expandedProjects.has(projectKey);
                        const projectName = projectKey === '__no_project__'
                            ? 'No Project'
                            : projectTasks[0]?.projectName || projectKey.split('/').pop() || projectKey;

                        return (
                            <div key={projectKey} className="project-group">
                                <div
                                    className="project-header"
                                    onClick={() => toggleProject(projectKey)}
                                >
                                    {isExpanded ? (
                                        <ChevronDown size={14} className="project-icon" />
                                    ) : (
                                        <ChevronRight size={14} className="project-icon" />
                                    )}
                                    <Folder size={14} className="project-icon" />
                                    <span className="project-name">{projectName}</span>
                                    <span className="project-count">{projectTasks.length}</span>
                                </div>
                                {isExpanded && (
                                    <div className="project-tasks">
                                        {projectTasks.map(task => (
                                            <TaskItem key={task.id} task={task} onDeleteTask={onDeleteTask} onStopTask={onStopTask} />
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}
