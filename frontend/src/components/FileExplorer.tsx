import { useState, useEffect, useCallback, useRef } from 'react';
import {
    ChevronRight, ChevronDown, ChevronLeft, File, Folder, FolderOpen,
    RefreshCw,
    GitBranch, CircleDot, Plus, Trash2, Pencil, FileQuestion,
    CheckCircle2, XCircle, Clock, Loader2, SkipForward, ExternalLink,
    ArrowUp, ArrowDown, GitPullRequest, MessageSquare, Tag, User,
    FileText, Activity, GitCommit, Copy, FolderInput, Eye, Check, Bell
} from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getApiBaseUrl } from '../config/api-config';
import { useTaskStore } from '../stores/taskStore';
import { FileContentModal } from './FileContentModal';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import './FileExplorer.css';

// ============== SHARED HELPERS ==============

function formatRelativeDate(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 30) return `${diffDays}d ago`;
    return date.toLocaleDateString();
}

// ============== SHARED TYPES ==============

interface FileItem {
    name: string;
    type: 'file' | 'directory';
    path: string;
    size?: number;
    childCount?: number;
}

interface GitChange {
    path: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
    staged: boolean;
}

interface GitLogEntry {
    hash: string;
    shortHash: string;
    author: string;
    date: string;
    message: string;
}

interface GitStatus {
    isGitRepo: boolean;
    branch: string | null;
    changes: GitChange[];
    ahead: number;
    behind: number;
}

interface CICheck {
    name: string;
    status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'pending' | 'neutral';
    conclusion: string | null;
    startedAt: string | null;
    completedAt: string | null;
    url: string | null;
}

interface PRComment {
    author: string;
    body: string;
    createdAt: string;
    url: string;
}

interface CIStatus {
    isGitRepo: boolean;
    branch?: string;
    owner?: string;
    repo?: string;
    prNumber: number | null;
    prUrl: string | null;
    prState?: string | null;
    prTitle?: string | null;
    prBody?: string | null;
    prComments?: PRComment[];
    checks: CICheck[];
    error?: string;
}

interface GitHubLabel {
    name: string;
    color: string;
}

interface GitHubUser {
    login: string;
}

interface GitHubIssue {
    number: number;
    title: string;
    state: string;
    url: string;
    createdAt: string;
    updatedAt: string;
    closedAt: string | null;
    author: GitHubUser;
    assignees: GitHubUser[];
    labels: GitHubLabel[];
    comments: number;
    body: string;
}

interface GitHubIssuesStatus {
    isGitRepo: boolean;
    owner?: string;
    repo?: string;
    issues: GitHubIssue[];
    error?: string;
}

type TabId = 'files' | 'changes' | 'ci' | 'issues' | 'inbox' | 'jira';

interface GitHubNotification {
    id: string;
    reason: string;
    unread: boolean;
    updatedAt: string;
    lastReadAt: string | null;
    subject: {
        title: string;
        type: string;
        url: string;
        htmlUrl: string;
    };
    repository: {
        fullName: string;
        htmlUrl: string;
    };
}

interface NotificationsResponse {
    notifications: GitHubNotification[];
    error?: string;
}

interface FileExplorerProps {
    workspacePath: string | undefined;
    workspaceName: string | undefined;
}

interface ContextMenuState {
    x: number;
    y: number;
    items: ContextMenuItem[];
}

// ============== FILE UTILITIES ==============

function getFileColor(name: string): string {
    const ext = name.split('.').pop()?.toLowerCase() || '';
    const colorMap: Record<string, string> = {
        ts: '#3178c6', tsx: '#3178c6', js: '#f7df1e', jsx: '#f7df1e',
        json: '#6d8086', css: '#264de4', scss: '#cc6699', html: '#e34c26',
        md: '#519aba', py: '#3572a5', rs: '#dea584', go: '#00add8',
        java: '#b07219', rb: '#701516', php: '#4f5d95',
        yml: '#cb171e', yaml: '#cb171e', toml: '#9c4221',
        sh: '#89e051', bash: '#89e051', ps1: '#012456',
        sql: '#e38c00', svg: '#ffb13b',
        png: '#a074c4', jpg: '#a074c4', jpeg: '#a074c4', gif: '#a074c4',
        env: '#ecd53f', lock: '#6e7681', gitignore: '#f05032',
    };
    return colorMap[ext] || '#8b949e';
}

function formatSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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

// ============== FILE TREE COMPONENTS ==============

function DirectoryNode({
    item, workspacePath, depth = 0, onFileClick, selectedPaths, onContextMenu, onSelect,
}: {
    item: FileItem;
    workspacePath: string;
    depth?: number;
    onFileClick: (path: string) => void;
    selectedPaths: Set<string>;
    onContextMenu: (e: React.MouseEvent, path: string, type: 'file' | 'directory') => void;
    onSelect: (path: string, type: 'file' | 'directory', multi: boolean) => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const [children, setChildren] = useState<FileItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const isSelected = selectedPaths.has(item.path);

    const toggleExpand = useCallback(async (e: React.MouseEvent) => {
        // Don't expand if user is selecting
        if (e.ctrlKey || e.metaKey || e.shiftKey) {
            return;
        }

        if (!expanded && !loaded) {
            setLoading(true);
            try {
                const params = new URLSearchParams({ workspace: workspacePath, path: item.path });
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

    const handleClick = useCallback((e: React.MouseEvent) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey) {
            e.stopPropagation();
            onSelect(item.path, 'directory', true);
        } else {
            toggleExpand(e);
        }
    }, [item.path, onSelect, toggleExpand]);

    const handleContextMenu = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e, item.path, 'directory');
    }, [item.path, onContextMenu]);

    return (
        <div className="file-tree-node">
            <div
                className={`file-tree-item directory ${isSelected ? 'selected' : ''}`}
                style={{ paddingLeft: `${depth * 16 + 8}px` }}
                onClick={handleClick}
                onContextMenu={handleContextMenu}
                title={item.path}
            >
                <span className="file-tree-chevron">
                    {loading ? <RefreshCw size={12} className="spinning" />
                        : expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
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
                        <div className="file-tree-empty" style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}>
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
                                onFileClick={onFileClick}
                                selectedPaths={selectedPaths}
                                onContextMenu={onContextMenu}
                                onSelect={onSelect}
                            />
                        ) : (
                            <FileNode
                                key={child.path}
                                item={child}
                                depth={depth + 1}
                                onFileClick={onFileClick}
                                selectedPaths={selectedPaths}
                                onContextMenu={onContextMenu}
                                onSelect={onSelect}
                            />
                        )
                    )}
                </div>
            )}
        </div>
    );
}

function FileNode({
    item, depth = 0, onFileClick, selectedPaths, onContextMenu, onSelect,
}: {
    item: FileItem;
    depth?: number;
    onFileClick: (path: string) => void;
    selectedPaths: Set<string>;
    onContextMenu: (e: React.MouseEvent, path: string, type: 'file' | 'directory') => void;
    onSelect: (path: string, type: 'file' | 'directory', multi: boolean) => void;
}) {
    const color = getFileColor(item.name);
    const badge = getFileIcon(item.name);
    const isSelected = selectedPaths.has(item.path);
    const clickTimeoutRef = useRef<number | null>(null);

    const handleClick = useCallback((e: React.MouseEvent) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey) {
            // Multi-select
            e.stopPropagation();
            onSelect(item.path, 'file', true);
        } else {
            // Single click - select, double click - open
            if (clickTimeoutRef.current !== null) {
                // Double click detected
                clearTimeout(clickTimeoutRef.current);
                clickTimeoutRef.current = null;
                onFileClick(item.path);
            } else {
                // Wait for potential double click
                clickTimeoutRef.current = window.setTimeout(() => {
                    clickTimeoutRef.current = null;
                    onSelect(item.path, 'file', false);
                }, 300);
            }
        }
    }, [item.path, onFileClick, onSelect]);

    const handleContextMenu = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e, item.path, 'file');
    }, [item.path, onContextMenu]);

    useEffect(() => {
        return () => {
            if (clickTimeoutRef.current !== null) {
                clearTimeout(clickTimeoutRef.current);
            }
        };
    }, []);

    return (
        <div
            className={`file-tree-item file clickable ${isSelected ? 'selected' : ''}`}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
            title={`${item.path}${item.size ? ` (${formatSize(item.size)})` : ''}`}
            onClick={handleClick}
            onContextMenu={handleContextMenu}
        >
            <span className="file-tree-chevron" />
            <span className="file-tree-icon file-icon" style={{ color }}>
                {badge ? <span className="file-type-badge" style={{ color }}>{badge}</span> : <File size={14} />}
            </span>
            <span className="file-tree-name">{item.name}</span>
            {item.size !== undefined && item.size > 0 && (
                <span className="file-tree-size">{formatSize(item.size)}</span>
            )}
        </div>
    );
}

// ============== TAB: FILES ==============

function FilesTab({ workspacePath, isActive }: { workspacePath: string; isActive: boolean }) {
    const isConnected = useTaskStore(s => s.isConnected);
    const [rootItems, setRootItems] = useState<FileItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [hasLoaded, setHasLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
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

    useEffect(() => {
        if (workspacePath && workspacePath !== prevWorkspaceRef.current) {
            prevWorkspaceRef.current = workspacePath;
            setRootItems([]);
            setHasLoaded(false);
            setSelectedPaths(new Set());
            if (isActive && isConnected) loadRootFiles();
        }
    }, [workspacePath, isActive, isConnected, loadRootFiles]);

    useEffect(() => {
        if (isActive && isConnected && !hasLoaded && workspacePath && !loading) {
            loadRootFiles();
        }
    }, [isActive, isConnected, hasLoaded, workspacePath, loading, loadRootFiles]);

    const handleFileClick = useCallback((path: string) => {
        setSelectedFile(path);
    }, []);

    const handleSelect = useCallback((path: string, _type: 'file' | 'directory', multi: boolean) => {
        if (multi) {
            setSelectedPaths(prev => {
                const newSet = new Set(prev);
                if (newSet.has(path)) {
                    newSet.delete(path);
                } else {
                    newSet.add(path);
                }
                return newSet;
            });
        } else {
            setSelectedPaths(new Set([path]));
        }
    }, []);

    const handleContextMenu = useCallback((e: React.MouseEvent, path: string, _type: 'file' | 'directory') => {
        // Select the item if not already selected
        if (!selectedPaths.has(path)) {
            setSelectedPaths(new Set([path]));
        }

        const itemName = path.split('/').pop() || path;

        const items: ContextMenuItem[] = [
            {
                label: 'Show in Finder',
                icon: <Eye size={14} />,
                onClick: async () => {
                    try {
                        const res = await fetch(`${getApiBaseUrl()}/api/workspaces/files/reveal`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ workspace: workspacePath, path }),
                        });
                        if (!res.ok) {
                            const error = await res.json();
                            alert(`Failed to reveal file: ${error.error}`);
                        }
                    } catch (err) {
                        console.error('Failed to reveal file:', err);
                        alert('Failed to reveal file');
                    }
                },
            },
            { divider: true, label: '', icon: null, onClick: () => {} },
            {
                label: 'Copy',
                icon: <Copy size={14} />,
                onClick: async () => {
                    const newName = prompt(`Copy "${itemName}" to:`, itemName);
                    if (!newName || newName === itemName) return;

                    const parentPath = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
                    const destinationPath = parentPath ? `${parentPath}/${newName}` : newName;

                    try {
                        const res = await fetch(`${getApiBaseUrl()}/api/workspaces/files/copy`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                workspace: workspacePath,
                                sourcePath: path,
                                destinationPath,
                            }),
                        });

                        if (res.ok) {
                            loadRootFiles();
                        } else {
                            const error = await res.json();
                            alert(`Failed to copy: ${error.error}`);
                        }
                    } catch (err) {
                        console.error('Failed to copy:', err);
                        alert('Failed to copy file');
                    }
                },
            },
            {
                label: 'Move/Rename',
                icon: <FolderInput size={14} />,
                onClick: async () => {
                    const newName = prompt(`Move/Rename "${itemName}" to:`, itemName);
                    if (!newName || newName === itemName) return;

                    const parentPath = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
                    const destinationPath = parentPath ? `${parentPath}/${newName}` : newName;

                    try {
                        const res = await fetch(`${getApiBaseUrl()}/api/workspaces/files/move`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                workspace: workspacePath,
                                sourcePath: path,
                                destinationPath,
                            }),
                        });

                        if (res.ok) {
                            loadRootFiles();
                            setSelectedPaths(new Set());
                        } else {
                            const error = await res.json();
                            alert(`Failed to move: ${error.error}`);
                        }
                    } catch (err) {
                        console.error('Failed to move:', err);
                        alert('Failed to move file');
                    }
                },
            },
            { divider: true, label: '', icon: null, onClick: () => {} },
            {
                label: 'Delete',
                icon: <Trash2 size={14} />,
                danger: true,
                onClick: async () => {
                    const confirm = window.confirm(`Are you sure you want to delete "${itemName}"?`);
                    if (!confirm) return;

                    try {
                        const res = await fetch(`${getApiBaseUrl()}/api/workspaces/files`, {
                            method: 'DELETE',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ workspace: workspacePath, path }),
                        });

                        if (res.ok) {
                            loadRootFiles();
                            setSelectedPaths(new Set());
                        } else {
                            const error = await res.json();
                            alert(`Failed to delete: ${error.error}`);
                        }
                    } catch (err) {
                        console.error('Failed to delete:', err);
                        alert('Failed to delete file');
                    }
                },
            },
        ];

        setContextMenu({ x: e.clientX, y: e.clientY, items });
    }, [workspacePath, selectedPaths, loadRootFiles]);

    const dirCount = rootItems.filter(i => i.type === 'directory').length;
    const fileCount = rootItems.filter(i => i.type === 'file').length;

    return (
        <>
            <div className="fe-tab-content">
                <div className="fe-tab-toolbar">
                    {rootItems.length > 0 && (
                        <span className="fe-tab-stats">{dirCount} folders &bull; {fileCount} files</span>
                    )}
                    <button className="fe-toolbar-btn" onClick={() => loadRootFiles()} disabled={loading} title="Refresh">
                        <RefreshCw size={13} className={loading ? 'spinning' : ''} />
                    </button>
                </div>
                <div className="fe-tab-scroll">
                    {loading && rootItems.length === 0 && (
                        <div className="fe-loading"><RefreshCw size={16} className="spinning" /><span>Loading files...</span></div>
                    )}
                    {error && <div className="fe-error">{error}</div>}
                    {!loading && !error && hasLoaded && rootItems.length === 0 && <div className="fe-empty">No files found</div>}
                    {rootItems.map((item) =>
                        item.type === 'directory'
                            ? <DirectoryNode
                                key={item.path}
                                item={item}
                                workspacePath={workspacePath}
                                depth={0}
                                onFileClick={handleFileClick}
                                selectedPaths={selectedPaths}
                                onContextMenu={handleContextMenu}
                                onSelect={handleSelect}
                            />
                            : <FileNode
                                key={item.path}
                                item={item}
                                depth={0}
                                onFileClick={handleFileClick}
                                selectedPaths={selectedPaths}
                                onContextMenu={handleContextMenu}
                                onSelect={handleSelect}
                            />
                    )}
                </div>
            </div>
            {selectedFile && (
                <FileContentModal
                    workspacePath={workspacePath}
                    filePath={selectedFile}
                    onClose={() => setSelectedFile(null)}
                />
            )}
            {contextMenu && (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    items={contextMenu.items}
                    onClose={() => setContextMenu(null)}
                />
            )}
        </>
    );
}

// ============== TAB: CHANGES ==============

function ChangesTab({ workspacePath, isActive }: { workspacePath: string; isActive: boolean }) {
    const isConnected = useTaskStore(s => s.isConnected);
    const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
    const [gitLog, setGitLog] = useState<GitLogEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [logLoading, setLogLoading] = useState(false);
    const [hasLoaded, setHasLoaded] = useState(false);
    const [hasLogLoaded, setHasLogLoaded] = useState(false);
    const [selectedChange, setSelectedChange] = useState<{ path: string; staged: boolean } | null>(null);
    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
        staged: true,
        changes: true,
        history: true,
    });
    const prevWorkspaceRef = useRef<string | undefined>(undefined);

    const toggleSection = (section: string) => {
        setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
    };

    const loadStatus = useCallback(async () => {
        if (!workspacePath) return;
        setLoading(true);
        try {
            const params = new URLSearchParams({ workspace: workspacePath });
            const res = await fetch(`${getApiBaseUrl()}/api/workspaces/git-status?${params}`);
            if (res.ok) {
                setGitStatus(await res.json());
            }
        } catch (err) {
            console.error('[FileExplorer] Failed to load git status:', err);
        } finally {
            setLoading(false);
            setHasLoaded(true);
        }
    }, [workspacePath]);

    const loadLog = useCallback(async () => {
        if (!workspacePath) return;
        setLogLoading(true);
        try {
            const params = new URLSearchParams({ workspace: workspacePath, count: '50' });
            const res = await fetch(`${getApiBaseUrl()}/api/workspaces/git-log?${params}`);
            if (res.ok) {
                const data = await res.json();
                setGitLog(data.commits || []);
            }
        } catch (err) {
            console.error('[FileExplorer] Failed to load git log:', err);
        } finally {
            setLogLoading(false);
            setHasLogLoaded(true);
        }
    }, [workspacePath]);

    useEffect(() => {
        if (workspacePath && workspacePath !== prevWorkspaceRef.current) {
            prevWorkspaceRef.current = workspacePath;
            setGitStatus(null);
            setGitLog([]);
            setHasLoaded(false);
            setHasLogLoaded(false);
            if (isActive && isConnected) {
                loadStatus();
                loadLog();
            }
        }
    }, [workspacePath, isActive, isConnected, loadStatus, loadLog]);

    useEffect(() => {
        if (isActive && isConnected && !hasLoaded && workspacePath && !loading) {
            loadStatus();
        }
    }, [isActive, isConnected, hasLoaded, workspacePath, loading, loadStatus]);

    useEffect(() => {
        if (isActive && isConnected && !hasLogLoaded && workspacePath && !logLoading) {
            loadLog();
        }
    }, [isActive, isConnected, hasLogLoaded, workspacePath, logLoading, loadLog]);

    // Auto-refresh status every 10s, log every 30s — only when connected
    useEffect(() => {
        if (!isActive || !workspacePath || !isConnected) return;
        const statusInterval = setInterval(loadStatus, 10000);
        const logInterval = setInterval(loadLog, 30000);
        return () => {
            clearInterval(statusInterval);
            clearInterval(logInterval);
        };
    }, [isActive, workspacePath, isConnected, loadStatus, loadLog]);

    const statusIcon = (change: GitChange) => {
        switch (change.status) {
            case 'added': return <Plus size={13} className="git-status-added" />;
            case 'modified': return <Pencil size={13} className="git-status-modified" />;
            case 'deleted': return <Trash2 size={13} className="git-status-deleted" />;
            case 'untracked': return <FileQuestion size={13} className="git-status-untracked" />;
            case 'renamed': return <CircleDot size={13} className="git-status-renamed" />;
            default: return <File size={13} />;
        }
    };

    const statusLabel = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

    const handleChangeClick = useCallback((path: string, staged: boolean, status: string) => {
        // Deleted files can't be opened
        if (status === 'deleted') {
            return;
        }
        // Untracked files have no diff, open as file content
        if (status === 'untracked') {
            setSelectedFile(path);
            return;
        }
        setSelectedChange({ path, staged });
    }, []);

    const handleOpenFile = useCallback((e: React.MouseEvent, path: string) => {
        e.stopPropagation(); // Don't trigger the row's diff click
        setSelectedFile(path);
    }, []);

    const handleRefresh = useCallback(() => {
        loadStatus();
        loadLog();
    }, [loadStatus, loadLog]);

    if (!gitStatus) {
        return (
            <div className="fe-tab-content">
                <div className="fe-tab-scroll">
                    {loading ? (
                        <div className="fe-loading"><RefreshCw size={16} className="spinning" /><span>Loading...</span></div>
                    ) : (
                        <div className="fe-empty">No data</div>
                    )}
                </div>
            </div>
        );
    }

    if (!gitStatus.isGitRepo) {
        return (
            <div className="fe-tab-content">
                <div className="fe-tab-scroll"><div className="fe-empty">Not a git repository</div></div>
            </div>
        );
    }

    const staged = gitStatus.changes.filter(c => c.staged);
    const unstaged = gitStatus.changes.filter(c => !c.staged);

    return (
        <>
            <div className="fe-tab-content">
                <div className="fe-tab-toolbar">
                    <span className="fe-tab-stats">
                        <GitBranch size={12} />
                        <span className="fe-branch-name">{gitStatus.branch || 'HEAD'}</span>
                        {gitStatus.ahead > 0 && <span className="fe-ahead" title={`${gitStatus.ahead} ahead`}><ArrowUp size={10} />{gitStatus.ahead}</span>}
                        {gitStatus.behind > 0 && <span className="fe-behind" title={`${gitStatus.behind} behind`}><ArrowDown size={10} />{gitStatus.behind}</span>}
                    </span>
                    <button className="fe-toolbar-btn" onClick={handleRefresh} disabled={loading} title="Refresh">
                        <RefreshCw size={13} className={loading ? 'spinning' : ''} />
                    </button>
                </div>
                <div className="fe-tab-scroll">
                    {gitStatus.changes.length === 0 && (
                        <div className="fe-empty">Working tree clean</div>
                    )}

                    {/* STAGED section */}
                    {staged.length > 0 && (
                        <div className="git-section">
                            <button className="git-section-header-btn" onClick={() => toggleSection('staged')}>
                                {expandedSections.staged ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                <span>Staged</span>
                                <span className="git-section-count">{staged.length}</span>
                            </button>
                            {expandedSections.staged && (
                                <div className="git-section-content">
                                    {staged.map(c => (
                                        <div
                                            key={`s-${c.path}`}
                                            className={`git-change-item staged ${c.status} ${c.status !== 'deleted' ? 'clickable' : ''}`}
                                            title={`${statusLabel(c.status)}: ${c.path}`}
                                            onClick={() => handleChangeClick(c.path, c.staged, c.status)}
                                        >
                                            {statusIcon(c)}
                                            <span className="git-change-path">{c.path}</span>
                                            {c.status !== 'deleted' && (
                                                <button
                                                    className="git-change-open-btn"
                                                    title="Open file"
                                                    onClick={(e) => handleOpenFile(e, c.path)}
                                                >
                                                    <ExternalLink size={11} />
                                                </button>
                                            )}
                                            <span className={`git-change-badge ${c.status}`}>{c.status[0].toUpperCase()}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* CHANGES section */}
                    {unstaged.length > 0 && (
                        <div className="git-section">
                            <button className="git-section-header-btn" onClick={() => toggleSection('changes')}>
                                {expandedSections.changes ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                <span>Changes</span>
                                <span className="git-section-count">{unstaged.length}</span>
                            </button>
                            {expandedSections.changes && (
                                <div className="git-section-content">
                                    {unstaged.map(c => (
                                        <div
                                            key={`u-${c.path}`}
                                            className={`git-change-item ${c.status} ${c.status !== 'deleted' ? 'clickable' : ''}`}
                                            title={`${statusLabel(c.status)}: ${c.path}`}
                                            onClick={() => handleChangeClick(c.path, c.staged, c.status)}
                                        >
                                            {statusIcon(c)}
                                            <span className="git-change-path">{c.path}</span>
                                            {c.status !== 'deleted' && (
                                                <button
                                                    className="git-change-open-btn"
                                                    title="Open file"
                                                    onClick={(e) => handleOpenFile(e, c.path)}
                                                >
                                                    <ExternalLink size={11} />
                                                </button>
                                            )}
                                            <span className={`git-change-badge ${c.status}`}>{c.status[0].toUpperCase()}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* HISTORY section */}
                    <div className="git-section">
                        <button className="git-section-header-btn" onClick={() => toggleSection('history')}>
                            {expandedSections.history ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            <span>History</span>
                            <span className="git-section-count">{gitLog.length}</span>
                        </button>
                        {expandedSections.history && (
                            <div className="git-section-content">
                                {logLoading && gitLog.length === 0 ? (
                                    <div className="fe-loading" style={{ padding: '8px 10px' }}><RefreshCw size={12} className="spinning" /><span>Loading...</span></div>
                                ) : gitLog.length === 0 ? (
                                    <div className="fe-empty" style={{ padding: '8px 10px', fontSize: '11px' }}>No commits</div>
                                ) : (
                                    gitLog.map(commit => (
                                        <div key={commit.hash} className="git-log-item" title={`${commit.hash}\n${commit.author}\n${commit.date}`}>
                                            <GitCommit size={12} className="git-log-icon" />
                                            <div className="git-log-details">
                                                <div className="git-log-message">{commit.message}</div>
                                                <div className="git-log-meta">
                                                    <span className="git-log-hash">{commit.shortHash}</span>
                                                    <span className="git-log-author">{commit.author}</span>
                                                    <span className="git-log-date">{timeAgo(commit.date)}</span>
                                                </div>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>
            {selectedChange && (
                <FileContentModal
                    workspacePath={workspacePath}
                    filePath={selectedChange.path}
                    isDiff={true}
                    staged={selectedChange.staged}
                    onClose={() => setSelectedChange(null)}
                />
            )}
            {selectedFile && (
                <FileContentModal
                    workspacePath={workspacePath}
                    filePath={selectedFile}
                    onClose={() => setSelectedFile(null)}
                />
            )}
        </>
    );
}

// ============== TAB: PR ==============

function timeAgo(dateStr: string): string {
    const now = new Date();
    const date = new Date(dateStr);
    const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return date.toLocaleDateString();
}

function CITab({ workspacePath, isActive }: { workspacePath: string; isActive: boolean }) {
    const isConnected = useTaskStore(s => s.isConnected);
    const [ciStatus, setCIStatus] = useState<CIStatus | null>(null);
    const [loading, setLoading] = useState(false);
    const [hasLoaded, setHasLoaded] = useState(false);
    const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
        description: true,
        comments: true,
        checks: true,
    });
    const [editingBody, setEditingBody] = useState(false);
    const [editBodyText, setEditBodyText] = useState('');
    const [savingBody, setSavingBody] = useState(false);
    const [copied, setCopied] = useState(false);
    const prevWorkspaceRef = useRef<string | undefined>(undefined);

    const copyPrUrl = useCallback(() => {
        if (!ciStatus?.prUrl) return;
        navigator.clipboard.writeText(ciStatus.prUrl).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    }, [ciStatus?.prUrl]);

    const toggleSection = (section: string) => {
        setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
    };

    const startEditBody = () => {
        setEditBodyText(ciStatus?.prBody || '');
        setEditingBody(true);
    };

    const saveBody = async () => {
        setSavingBody(true);
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/workspaces/pr-description`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspace: workspacePath, body: editBodyText }),
            });
            if (res.ok) {
                setCIStatus(prev => prev ? { ...prev, prBody: editBodyText } : prev);
                setEditingBody(false);
            }
        } catch (err) {
            console.error('[FileExplorer] Failed to save PR description:', err);
        } finally {
            setSavingBody(false);
        }
    };

    const loadCI = useCallback(async () => {
        if (!workspacePath) return;
        setLoading(true);
        try {
            const params = new URLSearchParams({ workspace: workspacePath });
            const res = await fetch(`${getApiBaseUrl()}/api/workspaces/ci-status?${params}`);
            if (res.ok) {
                setCIStatus(await res.json());
            }
        } catch (err) {
            console.error('[FileExplorer] Failed to load CI status:', err);
        } finally {
            setLoading(false);
            setHasLoaded(true);
        }
    }, [workspacePath]);

    useEffect(() => {
        if (workspacePath && workspacePath !== prevWorkspaceRef.current) {
            prevWorkspaceRef.current = workspacePath;
            setCIStatus(null);
            setHasLoaded(false);
            if (isActive && isConnected) loadCI();
        }
    }, [workspacePath, isActive, isConnected, loadCI]);

    useEffect(() => {
        if (isActive && isConnected && !hasLoaded && workspacePath && !loading) {
            loadCI();
        }
    }, [isActive, isConnected, hasLoaded, workspacePath, loading, loadCI]);

    // Auto-refresh every 30s when active and connected
    useEffect(() => {
        if (!isActive || !workspacePath || !isConnected) return;
        const interval = setInterval(loadCI, 30000);
        return () => clearInterval(interval);
    }, [isActive, workspacePath, isConnected, loadCI]);

    const checkIcon = (check: CICheck) => {
        if (check.status === 'completed') {
            if (check.conclusion === 'success') return <CheckCircle2 size={14} className="ci-success" />;
            if (check.conclusion === 'failure') return <XCircle size={14} className="ci-failure" />;
            if (check.conclusion === 'skipped') return <SkipForward size={14} className="ci-skipped" />;
            if (check.conclusion === 'cancelled') return <XCircle size={14} className="ci-cancelled" />;
            return <CheckCircle2 size={14} className="ci-neutral" />;
        }
        if (check.status === 'in_progress') return <Loader2 size={14} className="ci-running spinning" />;
        if (check.status === 'queued' || check.status === 'waiting') return <Clock size={14} className="ci-queued" />;
        return <Clock size={14} className="ci-pending" />;
    };

    const checkLabel = (check: CICheck) => {
        if (check.status === 'completed') return check.conclusion || 'done';
        if (check.status === 'in_progress') return 'running';
        if (check.status === 'queued') return 'queued';
        if (check.status === 'waiting') return 'waiting';
        return 'pending';
    };

    const renderCheckItem = (check: CICheck, i: number) => {
        const content = (
            <>
                {checkIcon(check)}
                <span className="ci-check-name">{check.name}</span>
                <span className={`ci-check-status ${check.conclusion || check.status}`}>
                    {checkLabel(check)}
                </span>
                {check.url && <ExternalLink size={11} className="ci-check-link-icon" />}
            </>
        );
        return check.url ? (
            <a key={`${check.name}-${i}`} href={check.url} target="_blank" rel="noopener noreferrer"
                className={`ci-check-item clickable ${check.conclusion || check.status}`}>
                {content}
            </a>
        ) : (
            <div key={`${check.name}-${i}`} className={`ci-check-item ${check.conclusion || check.status}`}>
                {content}
            </div>
        );
    };

    if (!ciStatus) {
        return (
            <div className="fe-tab-content">
                <div className="fe-tab-scroll">
                    {loading ? (
                        <div className="fe-loading"><RefreshCw size={16} className="spinning" /><span>Loading...</span></div>
                    ) : (
                        <div className="fe-empty">No data</div>
                    )}
                </div>
            </div>
        );
    }

    if (!ciStatus.isGitRepo) {
        return (
            <div className="fe-tab-content">
                <div className="fe-tab-scroll"><div className="fe-empty">Not a git repository</div></div>
            </div>
        );
    }

    if (ciStatus.error) {
        return (
            <div className="fe-tab-content">
                <div className="fe-tab-scroll"><div className="fe-empty">{ciStatus.error}</div></div>
            </div>
        );
    }

    // Group checks by status category
    const failedChecks = ciStatus.checks.filter(c => c.conclusion === 'failure' || c.conclusion === 'cancelled');
    const runningChecks = ciStatus.checks.filter(c => c.status === 'in_progress' || c.status === 'queued' || c.status === 'waiting' || c.status === 'pending' || c.status === 'neutral');
    const passedChecks = ciStatus.checks.filter(c => c.status === 'completed' && c.conclusion !== 'failure' && c.conclusion !== 'cancelled' && c.conclusion !== 'skipped');
    const skippedChecks = ciStatus.checks.filter(c => c.conclusion === 'skipped');

    const successCount = passedChecks.length;
    const failCount = failedChecks.length;
    const runningCount = runningChecks.length;
    const comments = ciStatus.prComments || [];

    return (
        <div className="fe-tab-content">
            <div className="fe-tab-toolbar">
                <span className="fe-tab-stats">
                    <GitBranch size={12} />
                    <span className="fe-branch-name">{ciStatus.branch || ''}</span>
                </span>
                <button className="fe-toolbar-btn" onClick={() => loadCI()} disabled={loading} title="Refresh">
                    <RefreshCw size={13} className={loading ? 'spinning' : ''} />
                </button>
            </div>
            <div className="fe-tab-scroll">
                {!ciStatus.prNumber ? (
                    <div className="ci-no-pr">No PR found for this branch</div>
                ) : (
                    <>
                        {/* PR Header */}
                        <div className="ci-pr-info">
                            <span className={`ci-pr-badge ${ciStatus.prState?.toLowerCase() || ''}`}>
                                PR #{ciStatus.prNumber}
                            </span>
                            {ciStatus.prUrl && (
                                <div className="ci-pr-actions">
                                    <a href={ciStatus.prUrl} target="_blank" rel="noopener noreferrer"
                                        className="ci-pr-action-btn" title="Open PR on GitHub">
                                        <ExternalLink size={12} />
                                    </a>
                                    <button className="ci-pr-action-btn" onClick={copyPrUrl}
                                        title={copied ? 'Copied!' : 'Copy PR link'}>
                                        {copied ? <Check size={12} className="ci-copied-icon" /> : <Copy size={12} />}
                                    </button>
                                </div>
                            )}
                            {ciStatus.checks.length > 0 && (
                                <span className="ci-summary">
                                    {successCount > 0 && <span className="ci-success">{successCount} passed</span>}
                                    {failCount > 0 && <span className="ci-failure">{failCount} failed</span>}
                                    {runningCount > 0 && <span className="ci-running">{runningCount} running</span>}
                                </span>
                            )}
                        </div>

                        {/* Description Section */}
                        <div className="ci-section">
                            <div className="ci-section-header-row">
                                <button className="ci-section-header" onClick={() => toggleSection('description')}>
                                    {expandedSections.description ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                    <FileText size={12} />
                                    <span>Description</span>
                                </button>
                                {expandedSections.description && !editingBody && (
                                    <button className="ci-edit-btn" onClick={startEditBody} title="Edit description">
                                        <Pencil size={11} />
                                    </button>
                                )}
                            </div>
                            {expandedSections.description && (
                                <div className="ci-section-content">
                                    {ciStatus.prTitle && (
                                        <div className="ci-pr-title">{ciStatus.prTitle}</div>
                                    )}
                                    {editingBody ? (
                                        <div className="ci-edit-container">
                                            <textarea
                                                className="ci-edit-textarea"
                                                value={editBodyText}
                                                onChange={(e) => setEditBodyText(e.target.value)}
                                                rows={12}
                                                disabled={savingBody}
                                            />
                                            <div className="ci-edit-actions">
                                                <button className="ci-edit-save" onClick={saveBody} disabled={savingBody}>
                                                    {savingBody ? <Loader2 size={12} className="spinning" /> : 'Save'}
                                                </button>
                                                <button className="ci-edit-cancel" onClick={() => setEditingBody(false)} disabled={savingBody}>
                                                    Cancel
                                                </button>
                                            </div>
                                        </div>
                                    ) : ciStatus.prBody ? (
                                        <div className="ci-pr-body ci-markdown"><Markdown remarkPlugins={[remarkGfm]}>{ciStatus.prBody}</Markdown></div>
                                    ) : (
                                        <div className="ci-pr-body ci-pr-body-empty">No description provided</div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Comments Section */}
                        <div className="ci-section">
                            <button className="ci-section-header" onClick={() => toggleSection('comments')}>
                                {expandedSections.comments ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                <MessageSquare size={12} />
                                <span>Comments</span>
                                {comments.length > 0 && (
                                    <span className="ci-section-count">{comments.length}</span>
                                )}
                            </button>
                            {expandedSections.comments && (
                                <div className="ci-section-content">
                                    {comments.length === 0 ? (
                                        <div className="ci-pr-body ci-pr-body-empty">No comments yet</div>
                                    ) : (
                                        comments.map((comment, i) => (
                                            <div key={i} className="ci-comment">
                                                <div className="ci-comment-header">
                                                    <User size={11} />
                                                    <span className="ci-comment-author">{comment.author}</span>
                                                    <span className="ci-comment-time">{timeAgo(comment.createdAt)}</span>
                                                </div>
                                                <div className="ci-comment-body ci-markdown"><Markdown remarkPlugins={[remarkGfm]}>{comment.body}</Markdown></div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Checks Section */}
                        <div className="ci-section">
                            <button className="ci-section-header" onClick={() => toggleSection('checks')}>
                                {expandedSections.checks ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                <Activity size={12} />
                                <span>Checks</span>
                                {ciStatus.checks.length > 0 && (
                                    <span className="ci-section-count">{ciStatus.checks.length}</span>
                                )}
                            </button>
                            {expandedSections.checks && (
                                <div className="ci-section-content ci-section-checks">
                                    {ciStatus.checks.length === 0 && (
                                        <div className="ci-pr-body ci-pr-body-empty">No CI checks configured</div>
                                    )}

                                    {failedChecks.length > 0 && (
                                        <div className="ci-check-group">
                                            <div className="ci-check-group-header ci-check-group-failed">
                                                <XCircle size={12} />
                                                <span>Failed</span>
                                                <span className="ci-check-group-count">{failedChecks.length}</span>
                                            </div>
                                            {failedChecks.map((check, i) => renderCheckItem(check, i))}
                                        </div>
                                    )}

                                    {runningChecks.length > 0 && (
                                        <div className="ci-check-group">
                                            <div className="ci-check-group-header ci-check-group-running">
                                                <Loader2 size={12} className="spinning" />
                                                <span>In Progress</span>
                                                <span className="ci-check-group-count">{runningChecks.length}</span>
                                            </div>
                                            {runningChecks.map((check, i) => renderCheckItem(check, i))}
                                        </div>
                                    )}

                                    {passedChecks.length > 0 && (
                                        <div className="ci-check-group">
                                            <div className="ci-check-group-header ci-check-group-passed">
                                                <CheckCircle2 size={12} />
                                                <span>Passed</span>
                                                <span className="ci-check-group-count">{passedChecks.length}</span>
                                            </div>
                                            {passedChecks.map((check, i) => renderCheckItem(check, i))}
                                        </div>
                                    )}

                                    {skippedChecks.length > 0 && (
                                        <div className="ci-check-group">
                                            <div className="ci-check-group-header ci-check-group-skipped">
                                                <SkipForward size={12} />
                                                <span>Skipped</span>
                                                <span className="ci-check-group-count">{skippedChecks.length}</span>
                                            </div>
                                            {skippedChecks.map((check, i) => renderCheckItem(check, i))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

// ============== TAB: ISSUES ==============

function IssuesTab({ workspacePath, isActive }: { workspacePath: string; isActive: boolean }) {
    const isConnected = useTaskStore(s => s.isConnected);
    const [issuesStatus, setIssuesStatus] = useState<GitHubIssuesStatus | null>(null);
    const [loading, setLoading] = useState(false);
    const [hasLoaded, setHasLoaded] = useState(false);
    const [filterState, setFilterState] = useState<'open' | 'closed' | 'all'>('open');
    const [filterAssignee, setFilterAssignee] = useState<'all' | 'me'>('all');
    const [newIssueTitle, setNewIssueTitle] = useState('');
    const [creating, setCreating] = useState(false);
    const prevWorkspaceRef = useRef<string | undefined>(undefined);

    const loadIssues = useCallback(async () => {
        if (!workspacePath) return;
        setLoading(true);
        try {
            const params = new URLSearchParams({
                workspace: workspacePath,
                state: filterState,
                limit: '30'
            });
            if (filterAssignee === 'me') {
                params.append('assignee', '@me');
            }
            const res = await fetch(`${getApiBaseUrl()}/api/workspaces/github-issues?${params}`);
            if (res.ok) {
                setIssuesStatus(await res.json());
            }
        } catch (err) {
            console.error('[FileExplorer] Failed to load GitHub issues:', err);
        } finally {
            setLoading(false);
            setHasLoaded(true);
        }
    }, [workspacePath, filterState, filterAssignee]);

    const createIssue = useCallback(async () => {
        if (!workspacePath || !newIssueTitle.trim() || creating) return;

        setCreating(true);
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/workspaces/github-issues`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workspace: workspacePath,
                    title: newIssueTitle.trim()
                })
            });

            if (res.ok) {
                const data = await res.json();
                console.log('[FileExplorer] Created issue:', data);
                setNewIssueTitle('');
                // Reload issues to show the new one
                loadIssues();
            } else {
                const error = await res.json();
                console.error('[FileExplorer] Failed to create issue:', error);
                alert(`Failed to create issue: ${error.error}`);
            }
        } catch (err) {
            console.error('[FileExplorer] Failed to create issue:', err);
            alert('Failed to create issue. Check console for details.');
        } finally {
            setCreating(false);
        }
    }, [workspacePath, newIssueTitle, creating, loadIssues]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            createIssue();
        }
    }, [createIssue]);

    const toggleIssueState = useCallback(async (issueNumber: number, currentState: string) => {
        if (!workspacePath) return;

        const newState = currentState === 'OPEN' ? 'closed' : 'open';

        try {
            const res = await fetch(`${getApiBaseUrl()}/api/workspaces/github-issues/${issueNumber}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workspace: workspacePath,
                    state: newState
                })
            });

            if (res.ok) {
                console.log(`[FileExplorer] Issue #${issueNumber} ${newState === 'closed' ? 'closed' : 'reopened'}`);
                // Reload issues to show updated state
                loadIssues();
            } else {
                const error = await res.json();
                console.error('[FileExplorer] Failed to update issue:', error);
                alert(`Failed to ${newState === 'closed' ? 'close' : 'reopen'} issue: ${error.error}`);
            }
        } catch (err) {
            console.error('[FileExplorer] Failed to update issue:', err);
            alert(`Failed to ${newState === 'closed' ? 'close' : 'reopen'} issue. Check console for details.`);
        }
    }, [workspacePath, loadIssues]);

    useEffect(() => {
        if (workspacePath && workspacePath !== prevWorkspaceRef.current) {
            prevWorkspaceRef.current = workspacePath;
            setIssuesStatus(null);
            setHasLoaded(false);
            if (isActive && isConnected) loadIssues();
        }
    }, [workspacePath, isActive, isConnected, loadIssues]);

    useEffect(() => {
        if (isActive && isConnected && !hasLoaded && workspacePath && !loading) {
            loadIssues();
        }
    }, [isActive, isConnected, hasLoaded, workspacePath, loading, loadIssues]);

    // Reload when filter changes
    useEffect(() => {
        if (hasLoaded && isConnected) {
            loadIssues();
        }
    }, [filterState, filterAssignee, hasLoaded, isConnected, loadIssues]);

    // Auto-refresh every 2 minutes when active and connected
    useEffect(() => {
        if (!isActive || !workspacePath || !isConnected) return;
        const interval = setInterval(loadIssues, 120000);
        return () => clearInterval(interval);
    }, [isActive, workspacePath, isConnected, loadIssues]);

    if (!issuesStatus) {
        return (
            <div className="fe-tab-content">
                <div className="fe-tab-scroll">
                    {loading ? (
                        <div className="fe-loading"><RefreshCw size={16} className="spinning" /><span>Loading...</span></div>
                    ) : (
                        <div className="fe-empty">No data</div>
                    )}
                </div>
            </div>
        );
    }

    if (!issuesStatus.isGitRepo) {
        return (
            <div className="fe-tab-content">
                <div className="fe-tab-scroll"><div className="fe-empty">Not a git repository</div></div>
            </div>
        );
    }

    if (issuesStatus.error) {
        return (
            <div className="fe-tab-content">
                <div className="fe-tab-toolbar">
                    <span className="fe-tab-stats">
                        {issuesStatus.owner && issuesStatus.repo && (
                            <span className="fe-repo-name">{issuesStatus.owner}/{issuesStatus.repo}</span>
                        )}
                    </span>
                    <button className="fe-toolbar-btn" onClick={() => loadIssues()} disabled={loading} title="Refresh">
                        <RefreshCw size={13} className={loading ? 'spinning' : ''} />
                    </button>
                </div>
                <div className="fe-tab-scroll">
                    <div className="fe-error">{issuesStatus.error}</div>
                </div>
            </div>
        );
    }

    return (
        <div className="fe-tab-content">
            <div className="fe-tab-toolbar">
                <span className="fe-tab-stats">
                    {issuesStatus.owner && issuesStatus.repo && (
                        <span className="fe-repo-name">{issuesStatus.owner}/{issuesStatus.repo}</span>
                    )}
                    <span className="fe-issue-count">{issuesStatus.issues.length} issues</span>
                </span>
                <div className="fe-filter-buttons">
                    <button
                        className={`fe-filter-btn ${filterAssignee === 'all' ? 'active' : ''}`}
                        onClick={() => setFilterAssignee('all')}
                        title="All issues"
                    >
                        All
                    </button>
                    <button
                        className={`fe-filter-btn ${filterAssignee === 'me' ? 'active' : ''}`}
                        onClick={() => setFilterAssignee('me')}
                        title="My issues"
                    >
                        Mine
                    </button>
                </div>
                <div className="fe-filter-buttons">
                    <button
                        className={`fe-filter-btn ${filterState === 'open' ? 'active' : ''}`}
                        onClick={() => setFilterState('open')}
                        title="Open issues"
                    >
                        Open
                    </button>
                    <button
                        className={`fe-filter-btn ${filterState === 'closed' ? 'active' : ''}`}
                        onClick={() => setFilterState('closed')}
                        title="Closed issues"
                    >
                        Closed
                    </button>
                    <button
                        className={`fe-filter-btn ${filterState === 'all' ? 'active' : ''}`}
                        onClick={() => setFilterState('all')}
                        title="All issues"
                    >
                        All
                    </button>
                </div>
                <button className="fe-toolbar-btn" onClick={() => loadIssues()} disabled={loading} title="Refresh">
                    <RefreshCw size={13} className={loading ? 'spinning' : ''} />
                </button>
            </div>
            <div className="fe-tab-scroll">
                {issuesStatus.issues.length === 0 && (
                    <div className="fe-empty">No {filterState} issues</div>
                )}
                {issuesStatus.issues.map((issue) => (
                    <div
                        key={issue.number}
                        className={`issue-item ${issue.state.toLowerCase()}`}
                    >
                        <div className="issue-header">
                            <input
                                type="checkbox"
                                className="issue-checkbox"
                                checked={issue.state === 'CLOSED'}
                                onChange={(e) => {
                                    e.stopPropagation();
                                    toggleIssueState(issue.number, issue.state);
                                }}
                                title={issue.state === 'OPEN' ? 'Close issue' : 'Reopen issue'}
                            />
                            <span className={`issue-state-badge ${issue.state.toLowerCase()}`}>
                                {issue.state === 'OPEN' ? (
                                    <CircleDot size={12} />
                                ) : (
                                    <CheckCircle2 size={12} />
                                )}
                            </span>
                            <span className="issue-number">#{issue.number}</span>
                            <a
                                href={issue.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="issue-title-link"
                                title={`#${issue.number}: ${issue.title}`}
                            >
                                <span className="issue-title">{issue.title}</span>
                                <ExternalLink size={11} className="issue-external-icon" />
                            </a>
                        </div>
                        <div className="issue-meta">
                            <span className="issue-author" title={`Author: ${issue.author.login}`}>
                                <User size={11} />
                                {issue.author.login}
                            </span>
                            {issue.comments > 0 && (
                                <span className="issue-comments" title={`${issue.comments} comments`}>
                                    <MessageSquare size={11} />
                                    {issue.comments}
                                </span>
                            )}
                            {issue.assignees.length > 0 && (
                                <span className="issue-assignees" title={`Assigned to: ${issue.assignees.map(a => a.login).join(', ')}`}>
                                    <User size={11} />
                                    {issue.assignees.length}
                                </span>
                            )}
                            <span className="issue-updated">{formatRelativeDate(issue.updatedAt)}</span>
                        </div>
                        {issue.labels.length > 0 && (
                            <div className="issue-labels">
                                {issue.labels.slice(0, 3).map((label, idx) => (
                                    <span
                                        key={idx}
                                        className="issue-label"
                                        style={{
                                            backgroundColor: `#${label.color}20`,
                                            color: `#${label.color}`,
                                            borderColor: `#${label.color}40`
                                        }}
                                        title={label.name}
                                    >
                                        <Tag size={9} />
                                        {label.name}
                                    </span>
                                ))}
                                {issue.labels.length > 3 && (
                                    <span className="issue-label-more">+{issue.labels.length - 3}</span>
                                )}
                            </div>
                        )}
                    </div>
                ))}
            </div>
            {issuesStatus.owner && issuesStatus.repo && !issuesStatus.error && (
                <div className="issue-create-form">
                    <input
                        type="text"
                        className="issue-create-input"
                        placeholder="Create new issue... (press Enter)"
                        value={newIssueTitle}
                        onChange={(e) => setNewIssueTitle(e.target.value)}
                        onKeyDown={handleKeyDown}
                        disabled={creating}
                    />
                    {creating && <Loader2 size={14} className="spinning issue-create-spinner" />}
                </div>
            )}
        </div>
    );
}


// ============== INBOX TAB ==============

function InboxTab({ workspacePath, isActive, onUnreadCount }: { workspacePath: string; isActive: boolean; onUnreadCount?: (count: number) => void }) {
    const isConnected = useTaskStore(s => s.isConnected);
    const [data, setData] = useState<NotificationsResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [hasLoaded, setHasLoaded] = useState(false);
    const prevWorkspaceRef = useRef<string | undefined>(undefined);

    const loadNotifications = useCallback(async () => {
        if (!workspacePath) return;
        setLoading(true);
        try {
            const params = new URLSearchParams({ workspace: workspacePath });
            const res = await fetch(`${getApiBaseUrl()}/api/github/notifications?${params}`);
            if (res.ok) {
                setData(await res.json());
            }
        } catch (err) {
            console.error('[FileExplorer] Failed to load notifications:', err);
        } finally {
            setLoading(false);
            setHasLoaded(true);
        }
    }, [workspacePath]);

    const markAsRead = useCallback(async (threadId: string) => {
        if (!workspacePath) return;
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/github/notifications/${threadId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspace: workspacePath })
            });
            if (res.ok) {
                setData(prev => prev ? {
                    ...prev,
                    notifications: prev.notifications.map(n =>
                        n.id === threadId ? { ...n, unread: false } : n
                    )
                } : prev);
            }
        } catch (err) {
            console.error('[FileExplorer] Failed to mark notification as read:', err);
        }
    }, [workspacePath]);

    // Derive unread count from data — single source of truth for the badge
    useEffect(() => {
        const count = data?.notifications?.filter(n => n.unread).length || 0;
        onUnreadCount?.(count);
    }, [data, onUnreadCount]);

    useEffect(() => {
        if (workspacePath && workspacePath !== prevWorkspaceRef.current) {
            prevWorkspaceRef.current = workspacePath;
            setData(null);
            setHasLoaded(false);
            if (isActive && isConnected) loadNotifications();
        }
    }, [workspacePath, isActive, isConnected, loadNotifications]);

    useEffect(() => {
        if (isActive && isConnected && !hasLoaded && workspacePath && !loading) {
            loadNotifications();
        }
    }, [isActive, isConnected, hasLoaded, workspacePath, loading, loadNotifications]);

    useEffect(() => {
        if (!isActive || !workspacePath || !isConnected) return;
        const interval = setInterval(loadNotifications, 60000);
        return () => clearInterval(interval);
    }, [isActive, workspacePath, isConnected, loadNotifications]);

    const getReasonLabel = (reason: string) => {
        const map: Record<string, string> = {
            assign: 'assigned',
            author: 'author',
            comment: 'comment',
            ci_activity: 'CI',
            invitation: 'invited',
            manual: 'subscribed',
            mention: 'mentioned',
            review_requested: 'review',
            security_alert: 'security',
            state_change: 'state change',
            subscribed: 'subscribed',
            team_mention: 'team mention',
        };
        return map[reason] || reason;
    };

    const getTypeIcon = (type: string) => {
        switch (type) {
            case 'PullRequest': return <GitPullRequest size={13} />;
            case 'Issue': return <CircleDot size={13} />;
            case 'Release': return <Tag size={13} />;
            case 'CheckSuite': return <Activity size={13} />;
            case 'Commit': return <GitCommit size={13} />;
            default: return <Bell size={13} />;
        }
    };

    if (!data) {
        return (
            <div className="fe-tab-content">
                <div className="fe-tab-scroll">
                    {loading ? (
                        <div className="fe-loading"><RefreshCw size={16} className="spinning" /><span>Loading...</span></div>
                    ) : (
                        <div className="fe-empty">No data</div>
                    )}
                </div>
            </div>
        );
    }

    if (data.error) {
        return (
            <div className="fe-tab-content">
                <div className="fe-tab-toolbar">
                    <span className="fe-tab-stats">Inbox</span>
                    <button className="fe-toolbar-btn" onClick={() => loadNotifications()} disabled={loading} title="Refresh">
                        <RefreshCw size={13} className={loading ? 'spinning' : ''} />
                    </button>
                </div>
                <div className="fe-tab-scroll">
                    <div className="fe-error">{data.error}</div>
                </div>
            </div>
        );
    }

    const unreadCount = data.notifications.filter(n => n.unread).length;

    return (
        <div className="fe-tab-content">
            <div className="fe-tab-toolbar">
                <span className="fe-tab-stats">
                    <span className="fe-issue-count">{unreadCount} unread</span>
                </span>
                <button className="fe-toolbar-btn" onClick={() => loadNotifications()} disabled={loading} title="Refresh">
                    <RefreshCw size={13} className={loading ? 'spinning' : ''} />
                </button>
            </div>
            <div className="fe-tab-scroll">
                {data.notifications.length === 0 && (
                    <div className="fe-empty">No notifications</div>
                )}
                {data.notifications.map((notif) => (
                    <div key={notif.id} className={`notification-item ${notif.unread ? 'unread' : ''}`}>
                        <div className="notification-header">
                            <span className={`notification-type-icon ${notif.subject.type.toLowerCase()}`}>
                                {getTypeIcon(notif.subject.type)}
                            </span>
                            <a
                                href={notif.subject.htmlUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="notification-title-link"
                                title={notif.subject.title}
                            >
                                {notif.subject.title}
                            </a>
                            {notif.unread && (
                                <button
                                    className="notification-mark-read"
                                    onClick={(e) => { e.stopPropagation(); markAsRead(notif.id); }}
                                    title="Mark as read"
                                >
                                    <Check size={11} />
                                </button>
                            )}
                        </div>
                        <div className="notification-meta">
                            <span className="notification-reason">{getReasonLabel(notif.reason)}</span>
                            <span className="notification-repo">{notif.repository.fullName}</span>
                            <span className="notification-time">{formatRelativeDate(notif.updatedAt)}</span>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}


// ============== JIRA TAB ==============

interface JiraComment { id: string; author: string; created: string; body: string; }
interface JiraAttachment { id: string; filename: string; mimeType: string; size: number; created: string; }
interface JiraIssueData {
    key: string; summary: string; status: string; issueType: string;
    assignee: string | null; reporter: string | null; priority: string | null;
    labels: string[]; created: string; updated: string; description: string;
    comments: JiraComment[]; attachments: JiraAttachment[]; url: string;
}
interface JiraSearchRow { key: string; summary: string; status: string; issueType: string; assignee: string | null; updated: string; url: string; }

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function JiraTab({ isActive, focusKey, onFocusHandled }: { isActive: boolean; focusKey?: string | null; onFocusHandled?: () => void }) {
    const [queryInput, setQueryInput] = useState('');
    const [issue, setIssue] = useState<JiraIssueData | null>(null);
    const [results, setResults] = useState<JiraSearchRow[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [downloadingId, setDownloadingId] = useState<string | null>(null);

    const openTicket = useCallback(async (keyOrUrl: string) => {
        const value = keyOrUrl.trim();
        if (!value) return;
        setLoading(true); setError(null); setResults(null); setIssue(null);
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/jira/issue/${encodeURIComponent(value)}`);
            const data = await res.json().catch(() => ({}));
            if (res.ok) setIssue(data);
            else setError(data.error || `Failed to load ticket (HTTP ${res.status})`);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load ticket');
        } finally {
            setLoading(false);
        }
    }, []);

    const runSearch = useCallback(async (jql: string) => {
        setLoading(true); setError(null); setResults(null); setIssue(null);
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/jira/search?jql=${encodeURIComponent(jql)}`);
            const data = await res.json().catch(() => ({}));
            if (res.ok) setResults(data.issues || []);
            else setError(data.error || `Search failed (HTTP ${res.status})`);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Search failed');
        } finally {
            setLoading(false);
        }
    }, []);

    // Default view: tickets assigned to me. Load once when the tab first activates.
    const [hasLoaded, setHasLoaded] = useState(false);
    useEffect(() => {
        if (isActive && !hasLoaded) {
            setHasLoaded(true);
            runSearch('assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC');
        }
    }, [isActive, hasLoaded, runSearch]);

    // React to a session-driven focus request.
    useEffect(() => {
        if (focusKey) {
            openTicket(focusKey);
            onFocusHandled?.();
        }
    }, [focusKey, openTicket, onFocusHandled]);

    const submitQuery = useCallback(() => {
        const v = queryInput.trim();
        if (!v) return;
        // Heuristic: a bare KEY or /browse/ URL opens the ticket; anything else is JQL.
        if (/^[A-Za-z][A-Za-z0-9]+-\d+$/.test(v) || /\/browse\//i.test(v)) {
            openTicket(v);
        } else {
            runSearch(v);
        }
    }, [queryInput, openTicket, runSearch]);

    const downloadAttachment = useCallback(async (att: JiraAttachment) => {
        setDownloadingId(att.id);
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/jira/attachment/${encodeURIComponent(att.id)}`);
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                alert(`Download failed: ${d.error || res.status}`);
                return;
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = att.filename;
            document.body.appendChild(a); a.click(); a.remove();
            URL.revokeObjectURL(url);
        } catch (e) {
            alert(`Download failed: ${e instanceof Error ? e.message : 'error'}`);
        } finally {
            setDownloadingId(null);
        }
    }, []);

    return (
        <div className="fe-tab-content jira-tab">
            <div className="fe-issues-toolbar" style={{ display: 'flex', gap: 6, padding: 8 }}>
                <input
                    type="text"
                    value={queryInput}
                    onChange={(e) => setQueryInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') submitQuery(); }}
                    placeholder="Ticket key, URL, or JQL…"
                    className="fe-issue-input"
                    style={{ flex: 1 }}
                />
                <button className="fe-btn" onClick={submitQuery} disabled={loading} title="Open / Search">
                    {loading ? <Loader2 size={14} className="spinning" /> : <RefreshCw size={14} />}
                </button>
            </div>

            {error && (
                <div className="fe-empty" style={{ color: 'var(--error, #e06c75)', padding: 12 }}>
                    {error}
                </div>
            )}

            {!error && loading && <div className="fe-empty" style={{ padding: 12 }}>Loading…</div>}

            {/* Search results list */}
            {!loading && results && (
                results.length === 0
                    ? <div className="fe-empty" style={{ padding: 12 }}>No matching tickets.</div>
                    : <div className="fe-issues-list">
                        {results.map(r => (
                            <div key={r.key} className="fe-issue-item" style={{ cursor: 'pointer', padding: '8px 12px' }}
                                onClick={() => openTicket(r.key)}>
                                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                    <span style={{ fontWeight: 600 }}>{r.key}</span>
                                    <span className="fe-issue-badge">{r.status}</span>
                                </div>
                                <div style={{ fontSize: 13, opacity: 0.85 }}>{r.summary}</div>
                            </div>
                        ))}
                    </div>
            )}

            {/* Single ticket view */}
            {!loading && issue && (
                <div className="jira-issue-detail" style={{ padding: 12, overflowY: 'auto' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span style={{ fontWeight: 700 }}>{issue.key}</span>
                        <span className="fe-issue-badge">{issue.status}</span>
                        <a href={issue.url} target="_blank" rel="noreferrer" title="Open in Jira" style={{ marginLeft: 'auto' }}>
                            <ExternalLink size={14} />
                        </a>
                    </div>
                    <h3 style={{ margin: '4px 0 8px', fontSize: 15 }}>{issue.summary}</h3>
                    <div style={{ fontSize: 12, opacity: 0.75, display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 10 }}>
                        <span>{issue.issueType}</span>
                        {issue.priority && <span>Priority: {issue.priority}</span>}
                        <span>Assignee: {issue.assignee || 'Unassigned'}</span>
                        {issue.reporter && <span>Reporter: {issue.reporter}</span>}
                    </div>
                    {issue.labels.length > 0 && (
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
                            {issue.labels.map(l => <span key={l} className="fe-issue-badge"><Tag size={10} /> {l}</span>)}
                        </div>
                    )}

                    {issue.description && (
                        <div className="jira-section">
                            <div className="jira-section-title" style={{ fontWeight: 600, margin: '8px 0 4px' }}>Description</div>
                            <div className="jira-markdown" style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>
                                <Markdown remarkPlugins={[remarkGfm]}>{issue.description}</Markdown>
                            </div>
                        </div>
                    )}

                    {issue.attachments.length > 0 && (
                        <div className="jira-section">
                            <div className="jira-section-title" style={{ fontWeight: 600, margin: '12px 0 4px' }}>
                                Attachments ({issue.attachments.length})
                            </div>
                            {issue.attachments.map(att => (
                                <div key={att.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 13 }}>
                                    <File size={13} />
                                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.filename}</span>
                                    <span style={{ opacity: 0.6, fontSize: 11 }}>{formatBytes(att.size)}</span>
                                    <button className="fe-btn" onClick={() => downloadAttachment(att)} disabled={downloadingId === att.id} title="Download">
                                        {downloadingId === att.id ? <Loader2 size={13} className="spinning" /> : <ArrowDown size={13} />}
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    {issue.comments.length > 0 && (
                        <div className="jira-section">
                            <div className="jira-section-title" style={{ fontWeight: 600, margin: '12px 0 4px' }}>
                                Comments ({issue.comments.length})
                            </div>
                            {issue.comments.map(c => (
                                <div key={c.id} className="jira-comment" style={{ borderTop: '1px solid var(--border, #333)', padding: '6px 0', fontSize: 13 }}>
                                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', opacity: 0.75, fontSize: 12 }}>
                                        <User size={11} /> {c.author}
                                        <span style={{ marginLeft: 'auto' }}>{new Date(c.created).toLocaleString()}</span>
                                    </div>
                                    <div style={{ whiteSpace: 'pre-wrap', marginTop: 2 }}>{c.body}</div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {!loading && !issue && !results && !error && (
                <div className="fe-empty" style={{ padding: 12 }}>
                    Enter a ticket key (e.g. PROJ-123) or a JQL query.
                </div>
            )}
        </div>
    );
}

// ============== MAIN PANEL ==============

const PANEL_WIDTH_KEY = 'claudia-file-explorer-width';
const DEFAULT_PANEL_WIDTH = 300;

export function FileExplorer({ workspacePath, workspaceName }: FileExplorerProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    const [activeTab, setActiveTab] = useState<TabId>('files');
    const [inboxUnreadCount, setInboxUnreadCount] = useState(0);
    // Whether the Jira tab should be shown (enabled + a token configured).
    const [jiraAvailable, setJiraAvailable] = useState(false);
    // A ticket key a Claude session asked to open (via jira:focusTicket WS).
    const pendingJiraFocus = useTaskStore(s => s.pendingJiraFocus);
    const clearJiraFocus = useTaskStore(s => s.clearJiraFocus);

    // Poll Jira availability so the tab appears/disappears with the setting.
    useEffect(() => {
        let cancelled = false;
        const check = async () => {
            try {
                const res = await fetch(`${getApiBaseUrl()}/api/jira/config`);
                if (res.ok && !cancelled) {
                    const j = await res.json();
                    setJiraAvailable(!!j.jiraEnabled && !!j.hasToken);
                }
            } catch { /* ignore */ }
        };
        check();
        const interval = setInterval(check, 15000);
        return () => { cancelled = true; clearInterval(interval); };
    }, []);

    // When a session focuses a ticket, surface the Jira tab and expand the panel.
    useEffect(() => {
        if (pendingJiraFocus) {
            setJiraAvailable(true);
            setIsExpanded(true);
            setActiveTab('jira');
        }
    }, [pendingJiraFocus]);
    const [panelWidth, setPanelWidth] = useState(() => {
        try {
            const saved = localStorage.getItem(PANEL_WIDTH_KEY);
            return saved ? parseInt(saved, 10) : DEFAULT_PANEL_WIDTH;
        } catch { return DEFAULT_PANEL_WIDTH; }
    });
    const [isResizing, setIsResizing] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);

    // Persist width
    useEffect(() => {
        try { localStorage.setItem(PANEL_WIDTH_KEY, panelWidth.toString()); } catch { /* */ }
    }, [panelWidth]);

    // Resize handling
    useEffect(() => {
        if (!isResizing) return;
        const handleMouseMove = (e: MouseEvent) => {
            const newWidth = window.innerWidth - e.clientX;
            if (newWidth >= 200 && newWidth <= 600) {
                setPanelWidth(newWidth);
            }
        };
        const handleMouseUp = () => setIsResizing(false);
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isResizing]);

    if (!workspacePath) return null;

    return (
        <div className={`file-explorer ${isExpanded ? 'expanded' : 'collapsed'}`} ref={panelRef}
            style={isExpanded ? { width: `${panelWidth}px`, minWidth: '200px', maxWidth: '600px' } : undefined}>

            {/* Resize handle */}
            {isExpanded && (
                <div className={`fe-resize-handle ${isResizing ? 'resizing' : ''}`}
                    onMouseDown={() => setIsResizing(true)} />
            )}

            {/* Toggle tab (collapsed) */}
            {!isExpanded && (
                <button className="file-explorer-toggle" onClick={() => setIsExpanded(true)}
                    title="Expand file explorer">
                    <ChevronLeft size={14} />
                    <span className="file-explorer-toggle-label">Files</span>
                </button>
            )}

            {/* Expanded panel */}
            {isExpanded && (
                <div className="file-explorer-panel">
                    {/* Header */}
                    <div className="file-explorer-header">
                        <div className="file-explorer-title">
                            <Folder size={14} />
                            <span>{workspaceName || 'Project'}</span>
                        </div>
                        <button className="file-explorer-collapse" onClick={() => setIsExpanded(false)} title="Collapse">
                            <ChevronRight size={14} />
                        </button>
                    </div>

                    {/* Tabs */}
                    <div className="fe-tabs">
                        <button className={`fe-tab ${activeTab === 'files' ? 'active' : ''}`}
                            onClick={() => setActiveTab('files')} title="Project Files">
                            <Folder size={13} />
                            <span>Files</span>
                        </button>
                        <button className={`fe-tab ${activeTab === 'changes' ? 'active' : ''}`}
                            onClick={() => setActiveTab('changes')} title="Git Changes">
                            <GitBranch size={13} />
                            <span>Changes</span>
                        </button>
                        <button className={`fe-tab ${activeTab === 'ci' ? 'active' : ''}`}
                            onClick={() => setActiveTab('ci')} title="Pull Request">
                            <GitPullRequest size={13} />
                            <span>PR</span>
                        </button>
                        <button className={`fe-tab ${activeTab === 'issues' ? 'active' : ''}`}
                            onClick={() => setActiveTab('issues')} title="GitHub Issues">
                            <CircleDot size={13} />
                            <span>Issues</span>
                        </button>
                        <button className={`fe-tab ${activeTab === 'inbox' ? 'active' : ''}`}
                            onClick={() => setActiveTab('inbox')} title="GitHub Notifications">
                            <Bell size={13} />
                            <span>Inbox</span>
                            {inboxUnreadCount > 0 && <span className="fe-tab-badge">{inboxUnreadCount > 9 ? '9+' : inboxUnreadCount}</span>}
                        </button>
                        {jiraAvailable && (
                            <button className={`fe-tab ${activeTab === 'jira' ? 'active' : ''}`}
                                onClick={() => setActiveTab('jira')} title="Jira">
                                <FileText size={13} />
                                <span>Jira</span>
                            </button>
                        )}
                    </div>

                    {/* Tab content */}
                    {activeTab === 'files' && <FilesTab workspacePath={workspacePath} isActive={isExpanded && activeTab === 'files'} />}
                    {activeTab === 'changes' && <ChangesTab workspacePath={workspacePath} isActive={isExpanded && activeTab === 'changes'} />}
                    {activeTab === 'ci' && <CITab workspacePath={workspacePath} isActive={isExpanded && activeTab === 'ci'} />}
                    {activeTab === 'issues' && <IssuesTab workspacePath={workspacePath} isActive={isExpanded && activeTab === 'issues'} />}
                    {activeTab === 'inbox' && <InboxTab workspacePath={workspacePath} isActive={isExpanded && activeTab === 'inbox'} onUnreadCount={setInboxUnreadCount} />}
                    {activeTab === 'jira' && <JiraTab isActive={isExpanded && activeTab === 'jira'} focusKey={pendingJiraFocus} onFocusHandled={clearJiraFocus} />}
                </div>
            )}
        </div>
    );
}
