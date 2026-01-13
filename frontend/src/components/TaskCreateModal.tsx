import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import './TaskCreateModal.css';

interface TaskCreateModalProps {
    workspaceId: string;
    workspaceName: string;
    onClose: () => void;
    onCreateTask: (name: string, description: string, workspaceId: string) => void;
}

export function TaskCreateModal({ workspaceId, workspaceName, onClose, onCreateTask }: TaskCreateModalProps) {
    const [task, setTask] = useState('');

    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            }
        };
        window.addEventListener('keydown', handleEscape);
        return () => window.removeEventListener('keydown', handleEscape);
    }, [onClose]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (task.trim()) {
            onCreateTask(task.trim(), task.trim(), workspaceId);
            onClose();
        }
    };

    const handleBackdropClick = (e: React.MouseEvent) => {
        if (e.target === e.currentTarget) {
            onClose();
        }
    };

    return (
        <div className="modal-backdrop" onClick={handleBackdropClick}>
            <div className="task-create-modal">
                <div className="modal-header">
                    <h2>Create Task</h2>
                    <button className="close-button" onClick={onClose} title="Close">
                        <X size={18} />
                    </button>
                </div>
                <div className="modal-body">
                    <div className="workspace-info">
                        Workspace: <strong>{workspaceName}</strong>
                    </div>
                    <form onSubmit={handleSubmit}>
                        <div className="form-group">
                            <label htmlFor="task-input">Task *</label>
                            <textarea
                                id="task-input"
                                value={task}
                                onChange={(e) => setTask(e.target.value)}
                                placeholder="e.g., Fix login bug"
                                rows={4}
                                autoFocus
                                required
                            />
                        </div>
                        <div className="modal-footer">
                            <button type="button" className="cancel-button" onClick={onClose}>
                                Cancel
                            </button>
                            <button type="submit" className="create-button" disabled={!task.trim()}>
                                Create Task
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
}
