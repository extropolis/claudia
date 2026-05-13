import { useState, useEffect } from 'react';
import { RecentWorkspace } from '@claudia/shared';
import './PathInputModal.css';

interface PathInputModalProps {
    onSubmit: (path: string) => void;
    onCancel: () => void;
    recentWorkspaces?: RecentWorkspace[];
    onRemoveRecent?: (workspaceId: string) => void;
    onBrowse?: () => void;
    isBrowsing?: boolean;
    showBrowseButton?: boolean; // Only show browse button when it will work
    defaultBaseDirectory?: string; // Default base directory for relative paths
}

export function PathInputModal({ onSubmit, onCancel, recentWorkspaces = [], onRemoveRecent, onBrowse, isBrowsing = false, showBrowseButton = true, defaultBaseDirectory }: PathInputModalProps) {
    const [path, setPath] = useState('');

    // Close on Escape key
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onCancel();
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [onCancel]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (path.trim()) {
            let finalPath = path.trim();
            // If defaultBaseDirectory is set and the path doesn't start with / or ~, prepend the base directory
            if (defaultBaseDirectory && !finalPath.startsWith('/') && !finalPath.startsWith('~')) {
                finalPath = `${defaultBaseDirectory}/${finalPath}`;
            }
            onSubmit(finalPath);
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
                            {defaultBaseDirectory && (
                                <div style={{ fontSize: '0.85em', color: '#888', marginBottom: '0.5em' }}>
                                    Base directory: {defaultBaseDirectory}
                                </div>
                            )}
                            <div className="path-input-row">
                                <input
                                    id="path-input"
                                    type="text"
                                    value={path}
                                    onChange={(e) => setPath(e.target.value)}
                                    placeholder={defaultBaseDirectory ? "project-name or /full/path" : "/path/to/your/project"}
                                    autoFocus
                                    className="path-input"
                                />
                                {showBrowseButton && onBrowse && (
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
