import { useState } from 'react';
import './PathInputModal.css';

interface PathInputModalProps {
    onSubmit: (path: string) => void;
    onCancel: () => void;
}

export function PathInputModal({ onSubmit, onCancel }: PathInputModalProps) {
    const [path, setPath] = useState('');

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (path.trim()) {
            onSubmit(path.trim());
        }
    };

    return (
        <div className="modal-overlay" onClick={onCancel}>
            <div className="modal-content path-input-modal" onClick={(e) => e.stopPropagation()}>
                <h2>Add Workspace</h2>
                <p className="modal-description">
                    Browser mode detected. Please enter the full absolute path to the folder you want to add as a workspace.
                </p>
                <form onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label htmlFor="path-input">Folder Path:</label>
                        <input
                            id="path-input"
                            type="text"
                            value={path}
                            onChange={(e) => setPath(e.target.value)}
                            placeholder="/Users/username/projects/my-project"
                            autoFocus
                            className="path-input"
                        />
                        <small className="help-text">
                            Example: /Users/I850333/projects/experiments/Minecraft
                        </small>
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
    );
}
