import { useCallback, useEffect, useState } from 'react';
import Editor from '@monaco-editor/react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
    X, Loader2, Download, Copy, Check, Save, Eye, Code, GitBranch, Circle,
} from 'lucide-react';
import { getApiBaseUrl } from '../config/api-config';
import { getFileIconUrl } from '../utils/fileIcons';
import './EditorPanel.css';

export interface EditorTab {
    id: string; // `${path}` for files, `diff:${path}:${staged}` for diffs
    path: string;
    isDiff: boolean;
    staged?: boolean;
    pinned: boolean;
}

interface EditorPanelProps {
    workspacePath: string;
    tabs: EditorTab[];
    activeTabId: string | null;
    onSelectTab: (id: string) => void;
    onCloseTab: (id: string) => void;
    onPinTab: (id: string) => void;
    onCloseAll: () => void;
}

const LANGUAGE_MAP: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
    json: 'json', css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html',
    md: 'markdown', mdx: 'markdown', py: 'python', rs: 'rust', go: 'go',
    java: 'java', rb: 'ruby', php: 'php', yml: 'yaml', yaml: 'yaml', toml: 'toml',
    sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', sql: 'sql',
    xml: 'xml', svg: 'xml', dockerfile: 'dockerfile', graphql: 'graphql',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp', swift: 'swift', kt: 'kotlin',
};

function detectLanguage(path: string): string {
    const name = path.split('/').pop() || path;
    if (name.toLowerCase() === 'dockerfile') return 'dockerfile';
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
    return LANGUAGE_MAP[ext] || 'plaintext';
}

interface FileState {
    loading: boolean;
    error: string | null;
    content: string;
    isImage: boolean;
    diffOriginal?: string;
    edited: string;
    dirty: boolean;
    saving: boolean;
}

function useFileState(workspacePath: string, tab: EditorTab | undefined) {
    const [state, setState] = useState<FileState>({
        loading: true, error: null, content: '', isImage: false, edited: '', dirty: false, saving: false,
    });

    const load = useCallback(async () => {
        if (!tab) return;
        setState(s => ({ ...s, loading: true, error: null }));
        try {
            if (tab.isDiff) {
                const params = new URLSearchParams({ workspace: workspacePath, file: tab.path, staged: String(!!tab.staged) });
                const res = await fetch(`${getApiBaseUrl()}/api/workspaces/git-diff?${params}`);
                if (res.ok) {
                    const data = await res.json();
                    setState(s => ({ ...s, loading: false, content: data.diff || '', edited: data.diff || '', isImage: false }));
                } else {
                    const err = await res.json().catch(() => ({ error: 'Failed to load diff' }));
                    setState(s => ({ ...s, loading: false, error: err.error }));
                }
            } else {
                const params = new URLSearchParams({ workspace: workspacePath, file: tab.path });
                const res = await fetch(`${getApiBaseUrl()}/api/workspaces/read-file?${params}`);
                if (res.ok) {
                    const data = await res.json();
                    setState(s => ({ ...s, loading: false, content: data.content, edited: data.content, isImage: !!data.isImage, dirty: false }));
                } else {
                    const err = await res.json().catch(() => ({ error: 'Failed to load file' }));
                    setState(s => ({ ...s, loading: false, error: err.error }));
                }
            }
        } catch (err) {
            console.error('[EditorPanel] Failed to load content:', err);
            setState(s => ({ ...s, loading: false, error: 'Failed to connect to server' }));
        }
    }, [workspacePath, tab?.path, tab?.isDiff, tab?.staged]);

    useEffect(() => { load(); }, [load]);

    return { state, setState };
}

function TabStrip({
    tabs, activeTabId, dirtyIds, onSelectTab, onCloseTab, onPinTab, onCloseAll,
}: {
    tabs: EditorTab[];
    activeTabId: string | null;
    dirtyIds: Set<string>;
    onSelectTab: (id: string) => void;
    onCloseTab: (id: string) => void;
    onPinTab: (id: string) => void;
    onCloseAll: () => void;
}) {
    return (
        <div className="ep-tabstrip">
            {tabs.map(tab => {
                const name = tab.path.split('/').pop() || tab.path;
                const isDirty = dirtyIds.has(tab.id);
                return (
                    <div
                        key={tab.id}
                        className={`ep-tab ${tab.id === activeTabId ? 'active' : ''} ${!tab.pinned ? 'preview' : ''}`}
                        onClick={() => onSelectTab(tab.id)}
                        onDoubleClick={() => onPinTab(tab.id)}
                        title={tab.isDiff ? `Diff: ${tab.path}` : tab.path}
                    >
                        {tab.isDiff
                            ? <GitBranch size={13} className="ep-tab-icon" />
                            : <img src={getFileIconUrl(name)} alt="" width={14} height={14} className="ep-tab-icon" />}
                        <span className="ep-tab-name">{tab.isDiff ? `${name} (diff)` : name}</span>
                        <span className="ep-tab-close-slot">
                            {isDirty && <Circle size={7} className="ep-tab-dirty" fill="currentColor" />}
                            <button className="ep-tab-close" onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }} title="Close">
                                <X size={12} />
                            </button>
                        </span>
                    </div>
                );
            })}
            {tabs.length > 0 && (
                <button className="ep-close-all" onClick={onCloseAll} title="Close all tabs">
                    Close All
                </button>
            )}
        </div>
    );
}

export function EditorPanel({ workspacePath, tabs, activeTabId, onSelectTab, onCloseTab, onPinTab, onCloseAll }: EditorPanelProps) {
    const activeTab = tabs.find(t => t.id === activeTabId);
    const { state, setState } = useFileState(workspacePath, activeTab);
    const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());
    const [copied, setCopied] = useState(false);
    const isMarkdown = activeTab && !activeTab.isDiff && /\.(md|mdx|markdown)$/i.test(activeTab.path);
    const [showRendered, setShowRendered] = useState(false);

    useEffect(() => {
        setShowRendered(!!isMarkdown);
    }, [activeTab?.id, isMarkdown]);

    useEffect(() => {
        setState(s => ({ ...s, dirty: activeTab ? dirtyIds.has(activeTab.id) : false }));
    }, [activeTab?.id]);

    const handleChange = useCallback((value: string | undefined) => {
        if (!activeTab || activeTab.isDiff) return;
        const newVal = value ?? '';
        setState(s => {
            const isDirty = newVal !== s.content;
            setDirtyIds(prev => {
                const next = new Set(prev);
                if (isDirty) next.add(activeTab.id); else next.delete(activeTab.id);
                return next;
            });
            return { ...s, edited: newVal, dirty: isDirty };
        });
    }, [activeTab]);

    const handleSave = useCallback(async () => {
        if (!activeTab || activeTab.isDiff) return;
        setState(s => ({ ...s, saving: true }));
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/workspaces/save-file`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspace: workspacePath, file: activeTab.path, content: state.edited }),
            });
            if (res.ok) {
                setState(s => ({ ...s, saving: false, content: s.edited, dirty: false }));
                setDirtyIds(prev => { const next = new Set(prev); next.delete(activeTab.id); return next; });
            } else {
                const err = await res.json().catch(() => ({ error: 'Failed to save' }));
                setState(s => ({ ...s, saving: false, error: err.error }));
            }
        } catch (err) {
            console.error('[EditorPanel] Failed to save:', err);
            setState(s => ({ ...s, saving: false, error: 'Failed to connect to server' }));
        }
    }, [activeTab, workspacePath, state.edited]);

    // Cmd/Ctrl+S to save
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's' && activeTab && !activeTab.isDiff && state.dirty) {
                e.preventDefault();
                handleSave();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [activeTab, state.dirty, handleSave]);

    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(state.edited);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    }, [state.edited]);

    const handleDownload = useCallback(() => {
        if (!activeTab) return;
        const blob = new Blob([state.edited], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = activeTab.path.split('/').pop() || 'file.txt';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, [activeTab, state.edited]);

    if (tabs.length === 0) {
        return (
            <div className="ep-panel">
                <div className="ep-empty">
                    <Code size={28} strokeWidth={1.2} />
                    <span>Select a file to view it here</span>
                </div>
            </div>
        );
    }

    return (
        <div className="ep-panel">
            <TabStrip
                tabs={tabs}
                activeTabId={activeTabId}
                dirtyIds={dirtyIds}
                onSelectTab={onSelectTab}
                onCloseTab={onCloseTab}
                onPinTab={onPinTab}
                onCloseAll={onCloseAll}
            />
            {activeTab && (
                <>
                    <div className="ep-toolbar">
                        <span className="ep-toolbar-path">{activeTab.path}</span>
                        <div className="ep-toolbar-actions">
                            {isMarkdown && !activeTab.isDiff && (
                                <button className={`ep-toolbar-btn ${showRendered ? 'active' : ''}`}
                                    onClick={() => setShowRendered(v => !v)}
                                    title={showRendered ? 'Show source' : 'Show preview'}>
                                    {showRendered ? <Code size={13} /> : <Eye size={13} />}
                                </button>
                            )}
                            {!activeTab.isDiff && (
                                <button className="ep-toolbar-btn" onClick={handleSave}
                                    disabled={!state.dirty || state.saving} title="Save (Cmd+S)">
                                    {state.saving ? <Loader2 size={13} className="spinning" /> : <Save size={13} />}
                                </button>
                            )}
                            <button className="ep-toolbar-btn" onClick={handleCopy} title="Copy to clipboard">
                                {copied ? <Check size={13} /> : <Copy size={13} />}
                            </button>
                            <button className="ep-toolbar-btn" onClick={handleDownload} title="Download">
                                <Download size={13} />
                            </button>
                        </div>
                    </div>
                    <div className="ep-body">
                        {state.loading && (
                            <div className="ep-loading"><Loader2 size={18} className="spinning" /><span>Loading...</span></div>
                        )}
                        {state.error && <div className="ep-error">{state.error}</div>}
                        {!state.loading && !state.error && state.isImage && (
                            <div className="ep-image-container">
                                <img src={state.content} alt={activeTab.path} className="ep-image" />
                            </div>
                        )}
                        {!state.loading && !state.error && !state.isImage && activeTab.isDiff && (
                            <DiffTextView content={state.content} />
                        )}
                        {!state.loading && !state.error && !state.isImage && !activeTab.isDiff && isMarkdown && showRendered && (
                            <div className="ep-markdown-rendered">
                                <Markdown remarkPlugins={[remarkGfm]}>{state.content}</Markdown>
                            </div>
                        )}
                        {!state.loading && !state.error && !state.isImage && !activeTab.isDiff && !(isMarkdown && showRendered) && (
                            <Editor
                                key={activeTab.id}
                                path={activeTab.path}
                                defaultLanguage={detectLanguage(activeTab.path)}
                                defaultValue={state.content}
                                theme="vs-dark"
                                onChange={handleChange}
                                options={{
                                    fontSize: 13,
                                    fontFamily: "'SF Mono', Monaco, Menlo, monospace",
                                    minimap: { enabled: true, scale: 1 },
                                    scrollBeyondLastLine: false,
                                    automaticLayout: true,
                                    tabSize: 2,
                                    renderWhitespace: 'selection',
                                    smoothScrolling: true,
                                }}
                            />
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

/** Colored +/- diff text rendering — kept lightweight instead of Monaco's DiffEditor since
    the backend returns a unified diff string, not two full file contents to align. */
function DiffTextView({ content }: { content: string }) {
    if (!content) return <div className="ep-empty-inline">No changes</div>;
    return (
        <pre className="ep-diff-pre">
            <code>
                {content.split('\n').map((line, i) => {
                    let cls = 'diff-context';
                    if (line.startsWith('+++') || line.startsWith('---')) cls = 'diff-header';
                    else if (line.startsWith('@@')) cls = 'diff-hunk';
                    else if (line.startsWith('+')) cls = 'diff-add';
                    else if (line.startsWith('-')) cls = 'diff-remove';
                    return <div key={i} className={`diff-line ${cls}`}>{line}</div>;
                })}
            </code>
        </pre>
    );
}
