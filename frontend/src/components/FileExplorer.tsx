import { useState, useEffect, useCallback, useRef } from 'react';
import {
    ChevronRight, ChevronDown, File, Folder, FolderOpen,
    PanelRightClose, PanelRightOpen, RefreshCw
} from 'lucide-react';
import { getApiBaseUrl } from '../config/api-config';
import './FileExplorer.css';

interface FileItem {
    name: string;
    type: 'file' | 'directory';
    path: string;
    size?: number;
    childCount?: number;
}

interface FileExplorerProps {
    workspacePath: string | undefined;
    workspaceName: string | undefined;
}

// Map file extensions to display colors
function getFileColor(name: string): string {
    const ext = name.split('.').pop()?.toLowerCase() || '';
    const colorMap: Record<string, string> = {
        ts: '#3178c6',
        tsx: '#3178c6',
        js: '#f7df1e',
        jsx: '#f7df1e',
        json: '#6d8086',
        css: '#264de4',
        scss: '#cc6699',
        html: '#e34c26',
        md: '#519aba',
        py: '#3572a5',
        rs: '#dea584',
        go: '#00add8',
        java: '#b07219',
        rb: '#701516',
        php: '#4f5d95',
        yml: '#cb171e',
        yaml: '#cb171e',
        toml: '#9c4221',
        sh: '#89e051',
        bash: '#89e051',
        ps1: '#012456',
        sql: '#e38c00',
        svg: '#ffb13b',
        png: '#a074c4',
        jpg: '#a074c4',
        jpeg: '#a074c4',
        gif: '#a074c4',
        env: '#ecd53f',
        lock: '#6e7681',
        gitignore: '#f05032',
    };
    return colorMap[ext] || '#8b949e';
}

// Format file size
function formatSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Get file icon based on extension
function getFileIcon(name: string): string {
    const ext = name.split('.').pop()?.toLowerCase() || '';
    const iconMap: Record<string, string> = {
        ts: 'TS', tsx: 'TX', js: 'JS', jsx: 'JX',
        json: '{}', css: '#', scss: '#', html: '<>',
        md: 'MD', py: 'PY', rs: 'RS', go: 'GO',
        java: 'JA', rb: 'RB', php: 'PH',
        yml: 'YM', yaml: 'YM', toml: 'TM',
        sh: '$', bash: '$', ps1: 'PS',
        sql: 'SQ', svg: 'SV',
        png: 'IM', jpg: 'IM', jpeg: 'IM', gif: 'IM',
        env: 'EV', lock: 'LK', gitignore: 'GI',
    };
    return iconMap[ext] || '';
}

function DirectoryNode({
    item,
    workspacePath,
    depth = 0,
}: {
    item: FileItem;
    workspacePath: string;
    depth?: number;
}) {
    const [expanded, setExpanded] = useState(false);
    const [children, setChildren] = useState<FileItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [loaded, setLoaded] = useState(false);

    const toggleExpand = useCallback(async () => {
        if (!expanded && !loaded) {
            setLoading(true);
            try {
                const params = new URLSearchParams({
                    workspace: workspacePath,
                    path: item.path,
                });
                const res = await fetch(`${getApiBaseUrl()}/api/workspaces/files?${params}`);
                if (res.ok) {
                    const data = await res.json();
                    setChildren(data.items || []);
                    setLoaded(true);
                }
            } catch (err) {
                console.error('[FileExplorer] Failed to load directory:', err);
            } finally {
                setLoading(false);
            }
        }
        setExpanded(!expanded);
    }, [expanded, loaded, workspacePath, item.path]);

    return (
        <div className="file-tree-node">
            <div
                className="file-tree-item directory"
                style={{ paddingLeft: `${depth * 16 + 8}px` }}
                onClick={toggleExpand}
                title={item.path}
            >
                <span className="file-tree-chevron">
                    {loading ? (
                        <RefreshCw size={12} className="spinning" />
                    ) : expanded ? (
                        <ChevronDown size={14} />
                    ) : (
                        <ChevronRight size={14} />
                    )}
                </span>
                <span className="file-tree-icon directory-icon">
                    {expanded ? <FolderOpen size={15} /> : <Folder size={15} />}
                </span>
                <span className="file-tree-name">{item.name}</span>
                {item.childCount !== undefined && item.childCount > 0 && !expanded && (
                    <span className="file-tree-badge">{item.childCount}</span>
                )}
            </div>
            {expanded && (
                <div className="file-tree-children">
                    {children.length === 0 && loaded && (
                        <div
                            className="file-tree-empty"
                            style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
                        >
                            Empty directory
                        </div>
                    )}
                    {children.map((child) =>
                        child.type === 'directory' ? (
                            <DirectoryNode
                                key={child.path}
                                item={child}
                                workspacePath={workspacePath}
                                depth={depth + 1}
                            />
                        ) : (
                            <FileNode
                                key={child.path}
                                item={child}
                                depth={depth + 1}
                            />
                        )
                    )}
                </div>
            )}
        </div>
    );
}

function FileNode({ item, depth = 0 }: { item: FileItem; depth?: number }) {
    const color = getFileColor(item.name);
    const badge = getFileIcon(item.name);

    return (
        <div
            className="file-tree-item file"
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
            title={`${item.path}${item.size ? ` (${formatSize(item.size)})` : ''}`}
        >
            <span className="file-tree-chevron" />
            <span className="file-tree-icon file-icon" style={{ color }}>
                {badge ? (
                    <span className="file-type-badge" style={{ color }}>{badge}</span>
                ) : (
                    <File size={14} />
                )}
            </span>
            <span className="file-tree-name">{item.name}</span>
            {item.size !== undefined && item.size > 0 && (
                <span className="file-tree-size">{formatSize(item.size)}</span>
            )}
        </div>
    );
}

export function FileExplorer({ workspacePath, workspaceName }: FileExplorerProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    const [rootItems, setRootItems] = useState<FileItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [hasLoaded, setHasLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const prevWorkspaceRef = useRef<string | undefined>(undefined);

    const loadRootFiles = useCallback(async () => {
        if (!workspacePath) return;

        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams({ workspace: workspacePath });
            const res = await fetch(`${getApiBaseUrl()}/api/workspaces/files?${params}`);
            if (res.ok) {
                const data = await res.json();
                setRootItems(data.items || []);
            } else {
                const errData = await res.json().catch(() => ({ error: 'Unknown error' }));
                setError(errData.error || 'Failed to load files');
            }
        } catch (err) {
            console.error('[FileExplorer] Failed to load root files:', err);
            setError('Failed to connect to server');
        } finally {
            setLoading(false);
            setHasLoaded(true);
        }
    }, [workspacePath]);

    // Load root files when workspace changes
    useEffect(() => {
        if (workspacePath && workspacePath !== prevWorkspaceRef.current) {
            prevWorkspaceRef.current = workspacePath;
            setRootItems([]);
            setHasLoaded(false);
            if (isExpanded) {
                loadRootFiles();
            }
        }
    }, [workspacePath, isExpanded, loadRootFiles]);

    // Load files when panel is first expanded
    useEffect(() => {
        if (isExpanded && !hasLoaded && workspacePath && !loading) {
            loadRootFiles();
        }
    }, [isExpanded, hasLoaded, workspacePath, loading, loadRootFiles]);

    const handleToggle = () => {
        setIsExpanded(!isExpanded);
    };

    const handleRefresh = (e: React.MouseEvent) => {
        e.stopPropagation();
        loadRootFiles();
    };

    if (!workspacePath) {
        return null;
    }

    // Count totals
    const dirCount = rootItems.filter(i => i.type === 'directory').length;
    const fileCount = rootItems.filter(i => i.type === 'file').length;

    return (
        <div className={`file-explorer ${isExpanded ? 'expanded' : 'collapsed'}`} ref={panelRef}>
            {/* Toggle tab - always visible */}
            <button
                className="file-explorer-toggle"
                onClick={handleToggle}
                title={isExpanded ? 'Collapse file explorer' : 'Expand file explorer'}
            >
                {isExpanded ? (
                    <PanelRightClose size={16} />
                ) : (
                    <PanelRightOpen size={16} />
                )}
                <span className="file-explorer-toggle-label">Files</span>
            </button>

            {/* Expanded panel */}
            {isExpanded && (
                <div className="file-explorer-panel">
                    <div className="file-explorer-header">
                        <div className="file-explorer-title">
                            <Folder size={14} />
                            <span>{workspaceName || 'Project'}</span>
                        </div>
                        <div className="file-explorer-actions">
                            <button
                                className="file-explorer-refresh"
                                onClick={handleRefresh}
                                disabled={loading}
                                title="Refresh file list"
                            >
                                <RefreshCw size={13} className={loading ? 'spinning' : ''} />
                            </button>
                            <button
                                className="file-explorer-collapse"
                                onClick={handleToggle}
                                title="Collapse"
                            >
                                <PanelRightClose size={14} />
                            </button>
                        </div>
                    </div>

                    {/* Stats bar */}
                    {rootItems.length > 0 && (
                        <div className="file-explorer-stats">
                            <span>{dirCount} folders</span>
                            <span className="stats-sep">&bull;</span>
                            <span>{fileCount} files</span>
                        </div>
                    )}

                    {/* File tree */}
                    <div className="file-explorer-tree">
                        {loading && rootItems.length === 0 && (
                            <div className="file-explorer-loading">
                                <RefreshCw size={16} className="spinning" />
                                <span>Loading files...</span>
                            </div>
                        )}

                        {error && (
                            <div className="file-explorer-error">
                                <span>{error}</span>
                            </div>
                        )}

                        {!loading && !error && hasLoaded && rootItems.length === 0 && (
                            <div className="file-explorer-empty">
                                <span>No files found</span>
                            </div>
                        )}

                        {rootItems.map((item) =>
                            item.type === 'directory' ? (
                                <DirectoryNode
                                    key={item.path}
                                    item={item}
                                    workspacePath={workspacePath}
                                    depth={0}
                                />
                            ) : (
                                <FileNode key={item.path} item={item} depth={0} />
                            )
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
