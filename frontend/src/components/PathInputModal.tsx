import { useState } from 'react';
import { RecentWorkspace } from '@claudia/shared';
import './PathInputModal.css';

interface PathInputModalProps {
    onSubmit: (path: string) => void;
    onCancel: () => void;
    recentWorkspaces?: RecentWorkspace[];
    onRemoveRecent?: (workspaceId: string) => void;
    onBrowse?: () => void;
    isBrowsing?: boolean;
}

export function PathInputModal({ onSubmit, onCancel, recentWorkspaces = [], onRemoveRecent, onBrowse, isBrowsing = false }: PathInputModalProps) {
    const [path, setPath] = useState('');

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (path.trim()) {
            onSubmit(path.trim());
        }
    };

    const handleRecentClick = (workspace: RecentWorkspace) => {
        onSubmit(workspace.id);
    };

    const handleRemoveRecent = (e: React.MouseEvent, workspaceId: string) => {
        e.stopPropagation();
        if (onRemoveRecent) {
            onRemoveRecent(workspaceId);
        }
    };

    const formatRelativeTime = (dateStr: string): string => {
        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays === 0) return 'Today';
        if (diffDays === 1) return 'Yesterday';
        if (diffDays < 7) return `${diffDays} days ago`;
        if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
        return `${Math.floor(diffDays / 30)} months ago`;
    };

    return (
        <div className="modal-overlay" onClick={onCancel}>
            <div className="modal-content path-input-modal" onClick={(e) => e.stopPropagation()}>
                <h2>Add Workspace</h2>

                {recentWorkspaces.length > 0 && (
                    <div className="recent-workspaces-section">
                        <h3 className="recent-workspaces-title">Recent Workspaces</h3>
                        <ul className="recent-workspaces-list">
                            {recentWorkspaces.map((workspace) => (
                                <li
                                    key={workspace.id}
                                    className="recent-workspace-item"
                                    onClick={() => handleRecentClick(workspace)}
                                >
                                    <div className="recent-workspace-info">
                                        <span className="recent-workspace-name">{workspace.name}</span>
                                        <span className="recent-workspace-path">{workspace.id}</span>
                                    </div>
                                    <div className="recent-workspace-actions">
                                        <span className="recent-workspace-time">
                                            {formatRelativeTime(workspace.removedAt)}
                                        </span>
                                        <button
                                            className="recent-workspace-remove"
                                            onClick={(e) => handleRemoveRecent(e, workspace.id)}
                                            title="Remove from history"
                                        >
                                            ×
                                        </button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                <div className="path-input-section">
                    <form onSubmit={handleSubmit}>
                        <div className="form-group">
                            <label htmlFor="path-input">
                                {recentWorkspaces.length > 0 ? 'Or add a new folder:' : 'Folder path'}
                            </label>
                            <div className="path-input-row">
                                <input
                                    id="path-input"
                                    type="text"
                                    value={path}
                                    onChange={(e) => setPath(e.target.value)}
                                    placeholder="/path/to/your/project"
                                    autoFocus
                                    className="path-input"
                                />
                                {onBrowse && (
                                    <button
                                        type="button"
                                        onClick={onBrowse}
                                        disabled={isBrowsing}
                                        className="btn-browse"
                                        title="Browse for folder"
                                    >
                                        {isBrowsing ? '...' : 'Browse'}
                                    </button>
                                )}
                            </div>
                        </div>
                        <div className="modal-actions">
                            <button type="button" onClick={onCancel} className="btn-secondary">
                                Cancel
                            </button>
                            <button type="submit" disabled={!path.trim()} className="btn-primary">
                                Add Workspace
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
}
