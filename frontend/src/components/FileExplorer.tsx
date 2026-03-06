import { useState, useEffect, useCallback, useRef } from 'react';
import {
    ChevronRight, ChevronDown, File, Folder, FolderOpen,
    PanelRightClose, PanelRightOpen, RefreshCw,
    GitBranch, CircleDot, Plus, Trash2, Pencil, FileQuestion,
    CheckCircle2, XCircle, Clock, Loader2, SkipForward, ExternalLink,
    ArrowUp, ArrowDown
} from 'lucide-react';
import { getApiBaseUrl } from '../config/api-config';
import './FileExplorer.css';

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

interface CIStatus {
    isGitRepo: boolean;
    branch?: string;
    owner?: string;
    repo?: string;
    prNumber: number | null;
    prUrl: string | null;
    prState?: string | null;
    checks: CICheck[];
    error?: string;
}

type TabId = 'files' | 'changes' | 'ci';

interface FileExplorerProps {
    workspacePath: string | undefined;
    workspaceName: string | undefined;
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
    item, workspacePath, depth = 0,
}: { item: FileItem; workspacePath: string; depth?: number }) {
    const [expanded, setExpanded] = useState(false);
    const [children, setChildren] = useState<FileItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [loaded, setLoaded] = useState(false);

    const toggleExpand = useCallback(async () => {
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

    return (
        <div className="file-tree-node">
            <div className="file-tree-item directory" style={{ paddingLeft: `${depth * 16 + 8}px` }}
                onClick={toggleExpand} title={item.path}>
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
                            <DirectoryNode key={child.path} item={child} workspacePath={workspacePath} depth={depth + 1} />
                        ) : (
                            <FileNode key={child.path} item={child} depth={depth + 1} />
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
        <div className="file-tree-item file" style={{ paddingLeft: `${depth * 16 + 8}px` }}
            title={`${item.path}${item.size ? ` (${formatSize(item.size)})` : ''}`}>
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
    const [rootItems, setRootItems] = useState<FileItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [hasLoaded, setHasLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);
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
            if (isActive) loadRootFiles();
        }
    }, [workspacePath, isActive, loadRootFiles]);

    useEffect(() => {
        if (isActive && !hasLoaded && workspacePath && !loading) {
            loadRootFiles();
        }
    }, [isActive, hasLoaded, workspacePath, loading, loadRootFiles]);

    const dirCount = rootItems.filter(i => i.type === 'directory').length;
    const fileCount = rootItems.filter(i => i.type === 'file').length;

    return (
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
                        ? <DirectoryNode key={item.path} item={item} workspacePath={workspacePath} depth={0} />
                        : <FileNode key={item.path} item={item} depth={0} />
                )}
            </div>
        </div>
    );
}

// ============== TAB: CHANGES ==============

function ChangesTab({ workspacePath, isActive }: { workspacePath: string; isActive: boolean }) {
    const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
    const [loading, setLoading] = useState(false);
    const [hasLoaded, setHasLoaded] = useState(false);
    const prevWorkspaceRef = useRef<string | undefined>(undefined);

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

    useEffect(() => {
        if (workspacePath && workspacePath !== prevWorkspaceRef.current) {
            prevWorkspaceRef.current = workspacePath;
            setGitStatus(null);
            setHasLoaded(false);
            if (isActive) loadStatus();
        }
    }, [workspacePath, isActive, loadStatus]);

    useEffect(() => {
        if (isActive && !hasLoaded && workspacePath && !loading) {
            loadStatus();
        }
    }, [isActive, hasLoaded, workspacePath, loading, loadStatus]);

    // Auto-refresh every 10s when active
    useEffect(() => {
        if (!isActive || !workspacePath) return;
        const interval = setInterval(loadStatus, 10000);
        return () => clearInterval(interval);
    }, [isActive, workspacePath, loadStatus]);

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
        <div className="fe-tab-content">
            <div className="fe-tab-toolbar">
                <span className="fe-tab-stats">
                    <GitBranch size={12} />
                    <span className="fe-branch-name">{gitStatus.branch || 'HEAD'}</span>
                    {gitStatus.ahead > 0 && <span className="fe-ahead" title={`${gitStatus.ahead} ahead`}><ArrowUp size={10} />{gitStatus.ahead}</span>}
                    {gitStatus.behind > 0 && <span className="fe-behind" title={`${gitStatus.behind} behind`}><ArrowDown size={10} />{gitStatus.behind}</span>}
                </span>
                <button className="fe-toolbar-btn" onClick={() => loadStatus()} disabled={loading} title="Refresh">
                    <RefreshCw size={13} className={loading ? 'spinning' : ''} />
                </button>
            </div>
            <div className="fe-tab-scroll">
                {gitStatus.changes.length === 0 && (
                    <div className="fe-empty">Working tree clean</div>
                )}
                {staged.length > 0 && (
                    <div className="git-section">
                        <div className="git-section-header">Staged ({staged.length})</div>
                        {staged.map(c => (
                            <div key={`s-${c.path}`} className={`git-change-item staged ${c.status}`} title={`${statusLabel(c.status)}: ${c.path}`}>
                                {statusIcon(c)}
                                <span className="git-change-path">{c.path}</span>
                                <span className={`git-change-badge ${c.status}`}>{c.status[0].toUpperCase()}</span>
                            </div>
                        ))}
                    </div>
                )}
                {unstaged.length > 0 && (
                    <div className="git-section">
                        <div className="git-section-header">Changes ({unstaged.length})</div>
                        {unstaged.map(c => (
                            <div key={`u-${c.path}`} className={`git-change-item ${c.status}`} title={`${statusLabel(c.status)}: ${c.path}`}>
                                {statusIcon(c)}
                                <span className="git-change-path">{c.path}</span>
                                <span className={`git-change-badge ${c.status}`}>{c.status[0].toUpperCase()}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

// ============== TAB: CI/CD ==============

function CITab({ workspacePath, isActive }: { workspacePath: string; isActive: boolean }) {
    const [ciStatus, setCIStatus] = useState<CIStatus | null>(null);
    const [loading, setLoading] = useState(false);
    const [hasLoaded, setHasLoaded] = useState(false);
    const prevWorkspaceRef = useRef<string | undefined>(undefined);

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
            if (isActive) loadCI();
        }
    }, [workspacePath, isActive, loadCI]);

    useEffect(() => {
        if (isActive && !hasLoaded && workspacePath && !loading) {
            loadCI();
        }
    }, [isActive, hasLoaded, workspacePath, loading, loadCI]);

    // Auto-refresh every 30s when active
    useEffect(() => {
        if (!isActive || !workspacePath) return;
        const interval = setInterval(loadCI, 30000);
        return () => clearInterval(interval);
    }, [isActive, workspacePath, loadCI]);

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

    const successCount = ciStatus.checks.filter(c => c.conclusion === 'success').length;
    const failCount = ciStatus.checks.filter(c => c.conclusion === 'failure').length;
    const runningCount = ciStatus.checks.filter(c => c.status === 'in_progress').length;

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
                {/* PR info */}
                {ciStatus.prNumber ? (
                    <div className="ci-pr-info">
                        <span className={`ci-pr-badge ${ciStatus.prState?.toLowerCase() || ''}`}>
                            PR #{ciStatus.prNumber}
                        </span>
                        {ciStatus.prUrl && (
                            <a href={ciStatus.prUrl} target="_blank" rel="noopener noreferrer" className="ci-pr-link"
                                title="Open PR on GitHub">
                                <ExternalLink size={12} />
                            </a>
                        )}
                        {ciStatus.checks.length > 0 && (
                            <span className="ci-summary">
                                {successCount > 0 && <span className="ci-success">{successCount} passed</span>}
                                {failCount > 0 && <span className="ci-failure">{failCount} failed</span>}
                                {runningCount > 0 && <span className="ci-running">{runningCount} running</span>}
                            </span>
                        )}
                    </div>
                ) : (
                    <div className="ci-no-pr">No PR found for this branch</div>
                )}

                {/* Check runs */}
                {ciStatus.checks.length === 0 && ciStatus.prNumber && (
                    <div className="fe-empty">No CI checks configured</div>
                )}
                {ciStatus.checks.map((check, i) => (
                    <div key={`${check.name}-${i}`} className={`ci-check-item ${check.conclusion || check.status}`}>
                        {checkIcon(check)}
                        <span className="ci-check-name">{check.name}</span>
                        <span className={`ci-check-status ${check.conclusion || check.status}`}>
                            {checkLabel(check)}
                        </span>
                        {check.url && (
                            <a href={check.url} target="_blank" rel="noopener noreferrer" className="ci-check-link" title="View details">
                                <ExternalLink size={11} />
                            </a>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}

// ============== MAIN PANEL ==============

const PANEL_WIDTH_KEY = 'claudia-file-explorer-width';
const DEFAULT_PANEL_WIDTH = 300;

export function FileExplorer({ workspacePath, workspaceName }: FileExplorerProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    const [activeTab, setActiveTab] = useState<TabId>('files');
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
                    <PanelRightOpen size={16} />
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
                            <PanelRightClose size={14} />
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
                            onClick={() => setActiveTab('ci')} title="CI/CD Status">
                            <CircleDot size={13} />
                            <span>CI/CD</span>
                        </button>
                    </div>

                    {/* Tab content */}
                    {activeTab === 'files' && <FilesTab workspacePath={workspacePath} isActive={isExpanded && activeTab === 'files'} />}
                    {activeTab === 'changes' && <ChangesTab workspacePath={workspacePath} isActive={isExpanded && activeTab === 'changes'} />}
                    {activeTab === 'ci' && <CITab workspacePath={workspacePath} isActive={isExpanded && activeTab === 'ci'} />}
                </div>
            )}
        </div>
    );
}
