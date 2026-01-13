import { useState, useEffect } from 'react';
import { FileCode, FilePlus, FileEdit, FileX, Code2 } from 'lucide-react';
import { CodeFile } from '@claudia/shared';
import { getApiBaseUrl } from '../config/api-config';

interface CodeViewerProps {
    taskId: string;
}

export function CodeViewer({ taskId }: CodeViewerProps) {
    const [files, setFiles] = useState<CodeFile[]>([]);
    const [selectedFileIdx, setSelectedFileIdx] = useState<number>(0);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchFiles();
        // Poll for updates while task might still be running
        const interval = setInterval(fetchFiles, 3000);
        return () => clearInterval(interval);
    }, [taskId]);

    const fetchFiles = async () => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/tasks/${taskId}/files`);
            const data = await response.json();
            setFiles(data);
            setLoading(false);
        } catch (err) {
            console.error('Failed to fetch files:', err);
            setLoading(false);
        }
    };

    if (loading) {
        return (
            <div className="code-viewer empty">
                <Code2 size={48} className="spinning" />
                <p>Parsing code output...</p>
            </div>
        );
    }

    if (files.length === 0) {
        return (
            <div className="code-viewer empty">
                <FileCode size={48} />
                <p>No code files detected yet</p>
                <span className="hint">Code will appear here as Claudia writes files</span>
            </div>
        );
    }

    const selectedFile = files[selectedFileIdx];

    const getOperationIcon = (operation: string) => {
        switch (operation) {
            case 'created': return <FilePlus size={14} />;
            case 'modified': return <FileEdit size={14} />;
            case 'deleted': return <FileX size={14} />;
            default: return <FileCode size={14} />;
        }
    };

    const getOperationClass = (operation: string) => {
        return `operation-${operation}`;
    };

    return (
        <div className="code-viewer">
            <div className="file-list">
                <div className="file-list-header">
                    <FileCode size={16} />
                    <span>Files ({files.length})</span>
                </div>
                <div className="file-list-items">
                    {files.map((file, idx) => (
                        <button
                            key={idx}
                            className={`file-item ${idx === selectedFileIdx ? 'selected' : ''} ${getOperationClass(file.operation)}`}
                            onClick={() => setSelectedFileIdx(idx)}
                        >
                            {getOperationIcon(file.operation)}
                            <span className="filename">{file.filename}</span>
                            <span className="language-badge">{file.language}</span>
                        </button>
                    ))}
                </div>
            </div>
            <div className="code-content">
                <div className="code-header">
                    <span className="code-filename">{selectedFile.filename}</span>
                    <span className={`operation-badge ${getOperationClass(selectedFile.operation)}`}>
                        {getOperationIcon(selectedFile.operation)}
                        {selectedFile.operation}
                    </span>
                </div>
                <pre className="code-block">
                    <code className={`language-${selectedFile.language}`}>
                        {selectedFile.content}
                    </code>
                </pre>
            </div>
        </div>
    );
}
