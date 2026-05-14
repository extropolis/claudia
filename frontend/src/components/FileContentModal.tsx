import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, File, GitBranch, Loader2, Download, Copy, Check, Edit3, Save, Eye, Code } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getApiBaseUrl } from '../config/api-config';
import './FileContentModal.css';

interface FileContentModalProps {
    workspacePath: string;
    filePath: string;
    isDiff?: boolean;
    staged?: boolean;
    onClose: () => void;
}

export function FileContentModal({ workspacePath, filePath, isDiff = false, staged = false, onClose }: FileContentModalProps) {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [content, setContent] = useState('');
    const [isImage, setIsImage] = useState(false);
    const [editedContent, setEditedContent] = useState('');
    const [isEditing, setIsEditing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [copied, setCopied] = useState(false);
    const [saved, setSaved] = useState(false);

    // Detect markdown files by extension
    const isMarkdownFile = /\.(md|mdx|markdown)$/i.test(filePath);
    const [showRendered, setShowRendered] = useState(isMarkdownFile);

    // Sync showRendered when filePath changes (in case modal is reused with different files)
    useEffect(() => {
        setShowRendered(/\.(md|mdx|markdown)$/i.test(filePath));
    }, [filePath]);

    useEffect(() => {
        loadContent();
    }, [workspacePath, filePath, isDiff, staged]);

    const loadContent = async () => {
        setLoading(true);
        setError(null);
        setIsImage(false);
        try {
            const params = new URLSearchParams({ workspace: workspacePath, file: filePath });
            if (isDiff) {
                params.append('staged', staged.toString());
            }
            const endpoint = isDiff ? '/api/workspaces/git-diff' : '/api/workspaces/read-file';
            const res = await fetch(`${getApiBaseUrl()}${endpoint}?${params}`);

            if (res.ok) {
                const data = await res.json();
                setContent(isDiff ? data.diff : data.content);
                setIsImage(data.isImage === true);
            } else {
                const errData = await res.json().catch(() => ({ error: 'Failed to load content' }));
                setError(errData.error || 'Failed to load content');
            }
        } catch (err) {
            console.error('[FileContentModal] Failed to load content:', err);
            setError('Failed to connect to server');
        } finally {
            setLoading(false);
        }
    };

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(isEditing ? editedContent : content);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy to clipboard:', err);
        }
    };

    const handleDownload = () => {
        const blob = new Blob([isEditing ? editedContent : content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filePath.split('/').pop() || 'file.txt';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const handleEdit = () => {
        setEditedContent(content);
        setIsEditing(true);
    };

    const handleCancelEdit = () => {
        setIsEditing(false);
        setEditedContent('');
    };

    const handleSave = async () => {
        setSaving(true);
        setError(null);
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/workspaces/save-file`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workspace: workspacePath,
                    file: filePath,
                    content: editedContent
                })
            });

            if (res.ok) {
                setContent(editedContent);
                setIsEditing(false);
                setSaved(true);
                setTimeout(() => setSaved(false), 2000);
            } else {
                const errData = await res.json().catch(() => ({ error: 'Failed to save file' }));
                setError(errData.error || 'Failed to save file');
            }
        } catch (err) {
            console.error('[FileContentModal] Failed to save file:', err);
            setError('Failed to connect to server');
        } finally {
            setSaving(false);
        }
    };

    const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget) {
            onClose();
        }
    };

    // Format diff content with syntax highlighting
    const formatDiffLine = (line: string, index: number) => {
        if (line.startsWith('+++') || line.startsWith('---')) {
            return <div key={index} className="diff-line diff-header">{line}</div>;
        } else if (line.startsWith('@@')) {
            return <div key={index} className="diff-line diff-hunk">{line}</div>;
        } else if (line.startsWith('+')) {
            return <div key={index} className="diff-line diff-add">{line}</div>;
        } else if (line.startsWith('-')) {
            return <div key={index} className="diff-line diff-remove">{line}</div>;
        }
        return <div key={index} className="diff-line diff-context">{line}</div>;
    };

    // Use createPortal to render at document.body level so the modal
    // escapes the FileExplorer's stacking context (z-index: 5) and
    // floats above everything including the WorkspacePanel.
    return createPortal(
        <div className="file-content-modal-backdrop" onClick={handleBackdropClick}>
            <div className="file-content-modal">
                {/* Header */}
                <div className="file-content-modal-header">
                    <div className="file-content-modal-title">
                        {isDiff ? <GitBranch size={16} /> : <File size={16} />}
                        <span className="file-content-modal-path">{filePath}</span>
                        {isDiff && staged && <span className="file-content-badge staged">Staged</span>}
                        {isDiff && !staged && <span className="file-content-badge">Changes</span>}
                        {isEditing && <span className="file-content-badge editing">Editing</span>}
                        {saved && <span className="file-content-badge saved">Saved!</span>}
                    </div>
                    <div className="file-content-modal-actions">
                        {isMarkdownFile && !isDiff && !isEditing && (
                            <button
                                className={`file-content-action-btn md-toggle-btn ${showRendered ? 'active' : ''}`}
                                onClick={() => setShowRendered(!showRendered)}
                                title={showRendered ? 'Show raw markdown' : 'Show rendered markdown'}
                                disabled={loading || !!error}
                            >
                                {showRendered ? <Code size={14} /> : <Eye size={14} />}
                            </button>
                        )}
                        {!isDiff && !isEditing && !isImage && (
                            <button
                                className="file-content-action-btn"
                                onClick={handleEdit}
                                title="Edit file"
                                disabled={loading || !!error}
                            >
                                <Edit3 size={14} />
                            </button>
                        )}
                        {isEditing && (
                            <>
                                <button
                                    className="file-content-action-btn save-btn"
                                    onClick={handleSave}
                                    title="Save file"
                                    disabled={saving || editedContent === content}
                                >
                                    {saving ? <Loader2 size={14} className="spinning" /> : <Save size={14} />}
                                </button>
                                <button
                                    className="file-content-action-btn cancel-btn"
                                    onClick={handleCancelEdit}
                                    title="Cancel editing"
                                    disabled={saving}
                                >
                                    <X size={14} />
                                </button>
                            </>
                        )}
                        {!isImage && (
                            <button
                                className="file-content-action-btn"
                                onClick={handleCopy}
                                title="Copy to clipboard"
                                disabled={loading || !!error}
                            >
                                {copied ? <Check size={14} /> : <Copy size={14} />}
                            </button>
                        )}
                        <button
                            className="file-content-action-btn"
                            onClick={handleDownload}
                            title="Download file"
                            disabled={loading || !!error}
                        >
                            <Download size={14} />
                        </button>
                        <button className="file-content-close-btn" onClick={onClose} title="Close">
                            <X size={16} />
                        </button>
                    </div>
                </div>

                {/* Content */}
                <div className="file-content-modal-body">
                    {loading && (
                        <div className="file-content-loading">
                            <Loader2 size={20} className="spinning" />
                            <span>Loading...</span>
                        </div>
                    )}
                    {error && <div className="file-content-error">{error}</div>}
                    {!loading && !error && isEditing && (
                        <textarea
                            className="file-content-editor"
                            value={editedContent}
                            onChange={(e) => setEditedContent(e.target.value)}
                            spellCheck={false}
                            autoFocus
                        />
                    )}
                    {!loading && !error && !isEditing && content && isImage && (
                        <div className="file-content-image-container">
                            <img src={content} alt={filePath.split('/').pop()} className="file-content-image" />
                        </div>
                    )}
                    {!loading && !error && !isEditing && content && !isImage && isMarkdownFile && showRendered && !isDiff && (
                        <div className="file-content-markdown-rendered">
                            <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
                        </div>
                    )}
                    {!loading && !error && !isEditing && content && !isImage && !(isMarkdownFile && showRendered && !isDiff) && (
                        <pre className={`file-content-pre ${isDiff ? 'diff-view' : ''}`}>
                            {isDiff ? (
                                <code className="file-content-code">
                                    {content.split('\n').map(formatDiffLine)}
                                </code>
                            ) : (
                                <code className="file-content-code">{content}</code>
                            )}
                        </pre>
                    )}
                    {!loading && !error && !isEditing && !content && (
                        <div className="file-content-empty">
                            {isDiff ? 'No changes' : 'Empty file'}
                        </div>
                    )}
                </div>
            </div>
        </div>,
        document.body
    );
}
