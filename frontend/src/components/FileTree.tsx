import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Tree, NodeApi, NodeRendererProps, RowRendererProps, TreeApi } from 'react-arborist';
import { ChevronRight, RefreshCw } from 'lucide-react';
import { getApiBaseUrl } from '../config/api-config';
import { getFileIconUrl, getFolderIconUrl } from '../utils/fileIcons';
import './FileTree.css';

export interface FileTreeItem {
    id: string;
    name: string;
    type: 'file' | 'directory';
    path: string;
    size?: number;
    children?: FileTreeItem[] | null; // null/undefined = not loaded yet
}

interface DecoratedItem extends FileTreeItem {
    children?: DecoratedItem[] | null;
    gitStatus?: GitDecoration['status'];
    gitBadge?: string;
}

export interface GitDecoration {
    status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
    staged: boolean;
}

interface FileTreeProps {
    workspacePath: string;
    rootItems: FileTreeItem[];
    setRootItems: React.Dispatch<React.SetStateAction<FileTreeItem[]>>;
    gitDecorations: Map<string, GitDecoration>;
    onOpenFile: (path: string, pin: boolean) => void;
    onContextMenu: (e: React.MouseEvent, path: string, type: 'file' | 'directory') => void;
    onMove?: (sourcePath: string, destPath: string) => void;
    onRename?: (path: string, newName: string) => void;
    treeApiRef?: React.MutableRefObject<TreeApi<FileTreeItem> | null | undefined>;
}

const STATUS_LETTER: Record<GitDecoration['status'], string> = {
    added: 'A', modified: 'M', deleted: 'D', renamed: 'R', untracked: 'U',
};

/** Minimal ResizeObserver hook — avoids pulling in a dependency for one measurement. */
function useElementSize<T extends HTMLElement>() {
    const ref = useRef<T | null>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const observer = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (entry) {
                const { width, height } = entry.contentRect;
                setSize({ width, height });
            }
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    return { ref, ...size };
}

function findNode(items: FileTreeItem[], path: string): FileTreeItem | null {
    for (const item of items) {
        if (item.path === path) return item;
        if (item.children) {
            const found = findNode(item.children, path);
            if (found) return found;
        }
    }
    return null;
}

function updateChildren(items: FileTreeItem[], path: string, children: FileTreeItem[]): FileTreeItem[] {
    return items.map(item => {
        if (item.path === path) return { ...item, children };
        if (item.children) return { ...item, children: updateChildren(item.children, path, children) };
        return item;
    });
}

/** Pure content for a row: icon, chevron, name, git badge. No click/selection wiring — that's in RowShell. */
function NodeContent({ node, style, dragHandle }: NodeRendererProps<DecoratedItem>) {
    const data = node.data;
    const isDir = data.type === 'directory';

    return (
        <div ref={dragHandle} style={style} className="ft-node">
            <div className="ft-indent" style={{ width: node.level * 16 }}>
                {Array.from({ length: node.level }).map((_, i) => (
                    <span key={i} className="ft-indent-guide" style={{ left: i * 16 + 7 }} />
                ))}
            </div>

            <span className={`ft-chevron ${isDir ? '' : 'ft-chevron-hidden'}`}
                onClick={(e) => { e.stopPropagation(); node.toggle(); }}>
                {isDir && <ChevronRight size={13} className={node.isOpen ? 'ft-chevron-open' : ''} />}
            </span>

            <span className="ft-icon">
                <img
                    src={isDir ? getFolderIconUrl(data.name, node.isOpen) : getFileIconUrl(data.name)}
                    alt=""
                    width={16}
                    height={16}
                    loading="lazy"
                />
            </span>

            {node.isEditing ? (
                <input
                    className="ft-rename-input"
                    autoFocus
                    defaultValue={data.name}
                    onClick={(e) => e.stopPropagation()}
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={() => node.reset()}
                    onKeyDown={(e) => {
                        if (e.key === 'Escape') node.reset();
                        if (e.key === 'Enter') node.submit(e.currentTarget.value);
                    }}
                />
            ) : (
                <span className={`ft-name ${data.gitStatus ? `ft-name-${data.gitStatus}` : ''}`}>{data.name}</span>
            )}

            {data.gitBadge && (
                <span className={`ft-git-badge ft-git-${data.gitStatus}`}>{data.gitBadge}</span>
            )}
        </div>
    );
}

function LoadingNodeContent({ node, style }: { node: NodeApi<DecoratedItem>; style: React.CSSProperties }) {
    return (
        <div style={style} className="ft-node">
            <div className="ft-indent" style={{ width: node.level * 16 }} />
            <span className="ft-chevron"><RefreshCw size={12} className="spinning" /></span>
            <span className="ft-icon" />
            <span className="ft-name">{node.data.name}</span>
        </div>
    );
}

export function FileTree({
    workspacePath, rootItems, setRootItems, gitDecorations,
    onOpenFile, onContextMenu, onMove, onRename, treeApiRef,
}: FileTreeProps) {
    const { ref, width, height } = useElementSize<HTMLDivElement>();
    const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
    const clickTimerRef = useRef<number | null>(null);

    const decoratedData = useMemo(() => {
        function decorate(items: FileTreeItem[]): DecoratedItem[] {
            return items.map(item => {
                const decoration = gitDecorations.get(item.path);
                const children = item.children ? decorate(item.children) : item.children;
                return {
                    ...item,
                    children,
                    gitStatus: decoration?.status,
                    gitBadge: decoration ? STATUS_LETTER[decoration.status] : undefined,
                };
            });
        }
        return decorate(rootItems);
    }, [rootItems, gitDecorations]);

    const loadChildren = useCallback(async (path: string) => {
        setLoadingIds(prev => new Set(prev).add(path));
        try {
            const params = new URLSearchParams({ workspace: workspacePath, path });
            const res = await fetch(`${getApiBaseUrl()}/api/workspaces/files?${params}`);
            if (res.ok) {
                const data = await res.json();
                const children: FileTreeItem[] = (data.items || []).map((it: any) => ({
                    id: it.path,
                    name: it.name,
                    type: it.type,
                    path: it.path,
                    size: it.size,
                    children: undefined,
                }));
                setRootItems(prev => updateChildren(prev, path, children));
            }
        } catch (err) {
            console.error('[FileTree] Failed to load directory:', err);
        } finally {
            setLoadingIds(prev => { const s = new Set(prev); s.delete(path); return s; });
        }
    }, [workspacePath, setRootItems]);

    const handleToggle = useCallback((id: string) => {
        const node = findNode(rootItems, id);
        if (node && node.type === 'directory' && node.children === undefined) {
            loadChildren(id);
        }
    }, [rootItems, loadChildren]);

    const handleActivate = useCallback((node: NodeApi<DecoratedItem>) => {
        if (node.data.type === 'file') {
            if (clickTimerRef.current !== null) { clearTimeout(clickTimerRef.current); clickTimerRef.current = null; }
            onOpenFile(node.data.path, true);
        }
    }, [onOpenFile]);

    const handleRowClick = useCallback((node: NodeApi<DecoratedItem>) => {
        if (node.data.type === 'directory') {
            node.toggle();
            return;
        }
        if (clickTimerRef.current !== null) clearTimeout(clickTimerRef.current);
        clickTimerRef.current = window.setTimeout(() => {
            clickTimerRef.current = null;
            onOpenFile(node.data.path, false);
        }, 200);
    }, [onOpenFile]);

    useEffect(() => {
        return () => { if (clickTimerRef.current !== null) clearTimeout(clickTimerRef.current); };
    }, []);

    const handleMove = useCallback(({ dragNodes, parentNode }: { dragNodes: NodeApi<DecoratedItem>[]; parentNode: NodeApi<DecoratedItem> | null }) => {
        if (!onMove) return;
        const destDir = parentNode ? parentNode.data.path : '';
        for (const dn of dragNodes) {
            const destPath = destDir ? `${destDir}/${dn.data.name}` : dn.data.name;
            if (destPath !== dn.data.path) onMove(dn.data.path, destPath);
        }
    }, [onMove]);

    const handleRename = useCallback(({ id, name }: { id: string; name: string }) => {
        if (name && onRename) onRename(id, name);
    }, [onRename]);

    const RowShell = useCallback(({ node, innerRef, attrs, children }: RowRendererProps<DecoratedItem>) => (
        <div
            {...attrs}
            ref={innerRef}
            className={`ft-row ${node.isSelected ? 'selected' : ''} ${node.willReceiveDrop ? 'drop-target' : ''}`}
            onClick={(e) => { node.handleClick(e); handleRowClick(node); }}
            onContextMenu={(e) => {
                e.preventDefault();
                if (!node.isSelected) node.select();
                onContextMenu(e, node.data.path, node.data.type);
            }}
        >
            {loadingIds.has(node.data.path)
                ? <LoadingNodeContent node={node} style={{}} />
                : children}
        </div>
    ), [handleRowClick, onContextMenu, loadingIds]);

    return (
        <div ref={ref} className="ft-container">
            <Tree<DecoratedItem>
                ref={(api) => { if (treeApiRef) treeApiRef.current = api as any; }}
                data={decoratedData}
                idAccessor="path"
                childrenAccessor={(d) => (d.type === 'directory' ? (d.children ?? []) : null)}
                openByDefault={false}
                width={width}
                height={height || 400}
                indent={16}
                rowHeight={22}
                overscanCount={12}
                onToggle={handleToggle}
                onActivate={handleActivate}
                onMove={handleMove}
                onRename={handleRename}
                disableDrag={(d) => d.type !== 'file' && d.type !== 'directory'}
                renderRow={RowShell}
            >
                {NodeContent}
            </Tree>
        </div>
    );
}
