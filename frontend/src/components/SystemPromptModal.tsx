import { useState, useEffect } from 'react';
import { FileText } from 'lucide-react';
import './SystemPromptModal.css';

interface SystemPromptModalProps {
    workspaceId: string;
    workspaceName: string;
    initialPrompt: string;
    onSave: (prompt: string) => void;
    onClose: () => void;
}

export function SystemPromptModal({
    workspaceName,
    initialPrompt,
    onSave,
    onClose
}: SystemPromptModalProps) {
    const [prompt, setPrompt] = useState(initialPrompt);

    useEffect(() => {
        setPrompt(initialPrompt);
    }, [initialPrompt]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSave(prompt);
        onClose();
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            onClose();
        }
    };

    return (
        <div className="modal-overlay" onClick={onClose} onKeyDown={handleKeyDown}>
            <div className="modal-content system-prompt-modal" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <FileText size={20} />
                    <h2>System Prompt</h2>
                </div>
                <p className="modal-description">
                    Set a custom system prompt for <strong>{workspaceName}</strong>.
                    This prompt will be included when creating new tasks in this workspace.
                </p>
                <form onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label htmlFor="system-prompt">System Prompt</label>
                        <textarea
                            id="system-prompt"
                            className="system-prompt-input"
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                            placeholder="Enter custom instructions for AI tasks in this workspace..."
                            rows={10}
                            autoFocus
                        />
                        <span className="help-text">
                            Leave empty to use the default system prompt.
                        </span>
                    </div>
                    <div className="modal-actions">
                        <button type="button" className="btn-secondary" onClick={onClose}>
                            Cancel
                        </button>
                        <button type="submit" className="btn-primary">
                            Save
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
