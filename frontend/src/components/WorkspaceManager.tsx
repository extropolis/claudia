import { useState, useCallback, useEffect, useMemo } from 'react';
import { Workspace } from '@claudia/shared';
import {
    X,
    Trash2,
    FolderPlus,
    CheckSquare,
    Square,
    FolderOpen,
    Briefcase,
    Search,
    AlertCircle,
    GripVertical,
    GitBranch
} from 'lucide-react';
import { getApiBaseUrl } from '../config/api-config';
import { PathInputModal } from './PathInputModal';
import './WorkspaceManager.css';

interface WorkspaceManagerProps {
    /** The full store list, worktree children included — this component filters them out itself. */
    workspaces: Workspace[];
    onClose: () => void;
    onCreateWorkspace: (path: string) => void;
    onDeleteWorkspace: (workspaceId: string) => void;
    /** Persist an explicit full ordering (all ids, worktree children included). */
    onSetWorkspaceOrder: (orderedIds: string[]) => void;
}

export function WorkspaceManager({
    workspaces,
    onClose,
    onCreateWorkspace,
    onDeleteWorkspace,
    onSetWorkspaceOrder
}: WorkspaceManagerProps) {
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [searchQuery, setSearchQuery] = useState('');
    const [isDeleting, setIsDeleting] = useState(false);
    const [dragIndex, setDragIndex] = useState<number | null>(null);
    const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
    const [showAddModal, setShowAddModal] = useState(false);
    const [isBrowsing, setIsBrowsing] = useState(false);
    const [defaultBaseDirectory, setDefaultBaseDirectory] = useState<string | undefined>(undefined);
    const [workspaceCountWhenModalOpened, setWorkspaceCountWhenModalOpened] = useState<number | null>(null);

    // Worktree child workspaces are per-task checkouts, not workspaces: the
    // sidebar renders them as tasks inside their parent, and they are created
    // and reaped automatically. Listing them here buried the handful of real
    // workspaces under dozens of .claudia-worktrees rows.
    //
    // Orphans are the one exception. A worktree whose parent workspace was
    // deleted is rendered nowhere in the sidebar, so hiding it here too would
    // leave a record with no way to remove it. Those stay, flagged as orphaned.
    const workspaceIds = useMemo(() => new Set(workspaces.map(ws => ws.id)), [workspaces]);

    const manageableWorkspaces = useMemo(
        () => workspaces.filter(ws => !ws.worktreeParentId || !workspaceIds.has(ws.worktreeParentId)),
        [workspaces, workspaceIds]
    );

    // Worktree children keyed by parent id — drives the per-row count badge and
    // keeps children adjacent to their parent when the order is persisted.
    const worktreeChildren = useMemo(() => {
        const byParent = new Map<string, Workspace[]>();
        for (const ws of workspaces) {
            if (!ws.worktreeParentId || !workspaceIds.has(ws.worktreeParentId)) continue;
            const siblings = byParent.get(ws.worktreeParentId);
            if (siblings) siblings.push(ws);
            else byParent.set(ws.worktreeParentId, [ws]);
        }
        return byParent;
    }, [workspaces, workspaceIds]);

    const hiddenWorktreeCount = workspaces.length - manageableWorkspaces.length;

    // Filter workspaces by search query
    const filteredWorkspaces = manageableWorkspaces.filter(ws => {
        const displayName = ws.displayName || ws.name;
        const query = searchQuery.toLowerCase();
        return displayName.toLowerCase().includes(query) ||
               ws.id.toLowerCase().includes(query);
    });

    // Row indices only line up with the stored order when nothing is filtered out,
    // so reordering is only allowed when the search box is empty. `draggable` is
    // the visible half of this; the handlers re-check because a dragstart can
    // still reach them from a nested draggable element.
    const isReorderable = searchQuery === '';

    // Track when add modal opens to detect successful workspace creation.
    // Counted over the manageable list, not the raw store: running tasks create
    // worktree workspaces at any moment, and counting those closed the Add
    // Workspace dialog out from under the user mid-typing.
    const manageableCount = manageableWorkspaces.length;

    useEffect(() => {
        if (showAddModal && workspaceCountWhenModalOpened === null) {
            setWorkspaceCountWhenModalOpened(manageableCount);
        }
    }, [showAddModal, workspaceCountWhenModalOpened, manageableCount]);

    // Close add modal when a new workspace is successfully added
    useEffect(() => {
        if (showAddModal && workspaceCountWhenModalOpened !== null && manageableCount > workspaceCountWhenModalOpened) {
            setShowAddModal(false);
            setWorkspaceCountWhenModalOpened(null);
        }
    }, [showAddModal, workspaceCountWhenModalOpened, manageableCount]);

    // Fetch default base directory from config when modal opens
    useEffect(() => {
        if (!showAddModal) return;

        const fetchConfig = async () => {
            try {
                const response = await fetch(`${getApiBaseUrl()}/api/config`);
                if (response.ok) {
                    const config = await response.json();
                    setDefaultBaseDirectory(config.defaultBaseDirectory);
                }
            } catch (err) {
                console.error('[WorkspaceManager] Failed to fetch config:', err);
            }
        };

        fetchConfig();
    }, [showAddModal]);

    // Toggle selection for a workspace
    const toggleSelection = useCallback((workspaceId: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(workspaceId)) {
                next.delete(workspaceId);
            } else {
                next.add(workspaceId);
            }
            return next;
        });
    }, []);

    // Select all filtered workspaces
    const selectAll = useCallback(() => {
        setSelectedIds(new Set(filteredWorkspaces.map(ws => ws.id)));
    }, [filteredWorkspaces]);

    // Deselect all
    const deselectAll = useCallback(() => {
        setSelectedIds(new Set());
    }, []);

    // Worktrees are no longer listed here, so a delete confirm has to say out loud
    // what is attached to the row — otherwise the count of records that lose their
    // parent is invisible at the moment of deciding.
    const worktreeWarning = useCallback((ids: string[]) => {
        const count = ids.reduce((n, id) => n + (worktreeChildren.get(id)?.length ?? 0), 0);
        if (count === 0) return '';
        return ` ${count} worktree${count > 1 ? 's' : ''} will be left without a parent workspace;` +
            ' remove them from the sidebar instead to delete them properly.';
    }, [worktreeChildren]);

    // Delete selected workspaces
    const deleteSelected = useCallback(async () => {
        if (selectedIds.size === 0) return;

        const confirmed = window.confirm(
            `Delete ${selectedIds.size} workspace${selectedIds.size > 1 ? 's' : ''}? Tasks will not be deleted.` +
            worktreeWarning([...selectedIds])
        );

        if (!confirmed) return;

        setIsDeleting(true);
        try {
            // Delete workspaces one by one
            for (const id of selectedIds) {
                onDeleteWorkspace(id);
                // Small delay to avoid overwhelming the server
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            setSelectedIds(new Set());
        } finally {
            setIsDeleting(false);
        }
    }, [selectedIds, onDeleteWorkspace, worktreeWarning]);

    // Add new workspace
    const handleAddWorkspace = useCallback(() => {
        setShowAddModal(true);
    }, []);

    const handleBrowseFolder = useCallback(async () => {
        try {
            setIsBrowsing(true);
            const resp = await fetch(`${getApiBaseUrl()}/api/browse-folder`, {
                method: 'POST'
            });
            const data = await resp.json();
            if (data.success && data.path) {
                onCreateWorkspace(data.path);
                // Modal will close automatically when workspace count increases
            }
        } catch (err) {
            console.error('Failed to open folder picker:', err);
        } finally {
            setIsBrowsing(false);
        }
    }, [onCreateWorkspace]);

    const handlePathSubmit = useCallback((path: string) => {
        onCreateWorkspace(path);
        // Modal will close automatically when workspace count increases
    }, [onCreateWorkspace]);

    const handlePathCancel = useCallback(() => {
        setShowAddModal(false);
        setWorkspaceCountWhenModalOpened(null);
    }, []);

    // Drag and drop handlers
    const handleDragStart = useCallback((index: number) => {
        if (!isReorderable) return;
        setDragIndex(index);
        setDragOverIndex(index);
    }, [isReorderable]);

    const handleDragEnter = useCallback((index: number) => {
        if (dragIndex !== null) {
            setDragOverIndex(index);
        }
    }, [dragIndex]);

    // Guarded by `isReorderable`, so the drag indices are always positions in the
    // unfiltered manageable list — never in a search-narrowed view.
    const handleDragEnd = useCallback(() => {
        if (isReorderable && dragIndex !== null && dragOverIndex !== null && dragIndex !== dragOverIndex) {
            const reordered = [...manageableWorkspaces];
            const [moved] = reordered.splice(dragIndex, 1);
            reordered.splice(dragOverIndex, 0, moved);

            // Send the full stored order, not a pair of indices: the visible rows
            // are a subset of the store, so an index-based move would land on
            // whatever worktree happened to occupy that slot. Children ride along
            // directly behind their parent to keep the stored array grouped.
            const orderedIds: string[] = [];
            for (const ws of reordered) {
                orderedIds.push(ws.id);
                for (const child of worktreeChildren.get(ws.id) ?? []) orderedIds.push(child.id);
            }
            onSetWorkspaceOrder(orderedIds);
        }
        setDragIndex(null);
        setDragOverIndex(null);
    }, [isReorderable, dragIndex, dragOverIndex, manageableWorkspaces, worktreeChildren, onSetWorkspaceOrder]);

    // Close on Escape
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    const allSelected = filteredWorkspaces.length > 0 &&
        filteredWorkspaces.every(ws => selectedIds.has(ws.id));

    return (
        <div className="workspace-manager-overlay" onClick={onClose}>
            <div className="workspace-manager-modal" onClick={e => e.stopPropagation()}>
                <div className="workspace-manager-header">
                    <div className="workspace-manager-title">
                        <Briefcase size={20} />
                        <h2>Manage Workspaces</h2>
                    </div>
                    <button
                        className="workspace-manager-close"
                        onClick={onClose}
                        title="Close (Esc)"
                    >
                        <X size={20} />
                    </button>
                </div>

                <div className="workspace-manager-toolbar">
                    <div className="workspace-manager-search">
                        <Search size={16} />
                        <input
                            type="text"
                            placeholder="Search workspaces..."
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                            autoFocus
                        />
                        {searchQuery && (
                            <button
                                className="clear-search"
                                onClick={() => setSearchQuery('')}
                                title="Clear search"
                            >
                                <X size={14} />
                            </button>
                        )}
                    </div>

                    <div className="workspace-manager-actions">
                        {filteredWorkspaces.length > 0 && (
                            <button
                                className="workspace-action-btn select-all"
                                onClick={allSelected ? deselectAll : selectAll}
                                title={allSelected ? 'Deselect all' : 'Select all'}
                            >
                                {allSelected ? <CheckSquare size={16} /> : <Square size={16} />}
                                {allSelected ? 'Deselect All' : 'Select All'}
                            </button>
                        )}

                        {selectedIds.size > 0 && (
                            <button
                                className="workspace-action-btn delete-selected"
                                onClick={deleteSelected}
                                disabled={isDeleting}
                                title={`Delete ${selectedIds.size} workspace${selectedIds.size > 1 ? 's' : ''}`}
                            >
                                <Trash2 size={16} />
                                Delete {selectedIds.size} Selected
                            </button>
                        )}

                        <button
                            className="workspace-action-btn add-workspace"
                            onClick={handleAddWorkspace}
                            title="Add workspace"
                        >
                            <FolderPlus size={16} />
                            Add Workspace
                        </button>
                    </div>
                </div>

                <div className="workspace-manager-content">
                    {filteredWorkspaces.length === 0 ? (
                        <div className="workspace-manager-empty">
                            {searchQuery ? (
                                <>
                                    <AlertCircle size={32} />
                                    <p>No workspaces match "{searchQuery}"</p>
                                </>
                            ) : (
                                <>
                                    <FolderOpen size={32} />
                                    <p>No workspaces yet</p>
                                    <button
                                        className="workspace-action-btn add-workspace"
                                        onClick={handleAddWorkspace}
                                    >
                                        <FolderPlus size={16} />
                                        Add Your First Workspace
                                    </button>
                                </>
                            )}
                        </div>
                    ) : (
                        <div className="workspace-manager-list">
                            {filteredWorkspaces.map((workspace, index) => {
                                const isSelected = selectedIds.has(workspace.id);
                                const isDragging = dragIndex === index;
                                const isDropTarget = dragOverIndex === index && dragIndex !== null && !isDragging;
                                const displayName = workspace.displayName || workspace.name;
                                const childCount = worktreeChildren.get(workspace.id)?.length ?? 0;
                                const isOrphanedWorktree = !!workspace.worktreeParentId;

                                return (
                                    <div
                                        key={workspace.id}
                                        className={`workspace-manager-item ${isSelected ? 'selected' : ''} ${isDragging ? 'dragging' : ''} ${isDropTarget ? 'drop-target' : ''}`}
                                        draggable={isReorderable}
                                        onDragStart={(e) => {
                                            e.dataTransfer.effectAllowed = 'move';
                                            handleDragStart(index);
                                        }}
                                        onDragEnd={handleDragEnd}
                                        onDragOver={(e) => e.preventDefault()}
                                        onDragEnter={() => handleDragEnter(index)}
                                    >
                                        <div
                                            className={`workspace-item-drag-handle ${isReorderable ? '' : 'disabled'}`}
                                            title={isReorderable ? 'Drag to reorder' : 'Clear the search to reorder'}
                                        >
                                            <GripVertical size={16} />
                                        </div>

                                        <button
                                            className="workspace-item-checkbox"
                                            onClick={() => toggleSelection(workspace.id)}
                                            title={isSelected ? 'Deselect' : 'Select'}
                                        >
                                            {isSelected ? (
                                                <CheckSquare size={18} className="checked" />
                                            ) : (
                                                <Square size={18} />
                                            )}
                                        </button>

                                        <div className="workspace-item-info">
                                            <div className="workspace-item-name">
                                                <Briefcase size={16} />
                                                <span title={workspace.id}>{displayName}</span>
                                                {childCount > 0 && (
                                                    <span
                                                        className="workspace-item-worktree-badge"
                                                        title={`${childCount} worktree${childCount > 1 ? 's' : ''} — shown as tasks under this workspace in the sidebar`}
                                                    >
                                                        <GitBranch size={12} />
                                                        {childCount}
                                                    </span>
                                                )}
                                                {isOrphanedWorktree && (
                                                    <span
                                                        className="workspace-item-orphan-badge"
                                                        title="Worktree whose parent workspace no longer exists — safe to delete"
                                                    >
                                                        orphaned worktree
                                                    </span>
                                                )}
                                            </div>
                                            <div className="workspace-item-path" title={workspace.id}>
                                                {workspace.id}
                                            </div>
                                        </div>

                                        <button
                                            className="workspace-item-delete"
                                            onClick={() => {
                                                const confirmed = window.confirm(
                                                    `Delete workspace "${displayName}"? Tasks will not be deleted.` +
                                                    worktreeWarning([workspace.id])
                                                );
                                                if (confirmed) {
                                                    onDeleteWorkspace(workspace.id);
                                                    setSelectedIds(prev => {
                                                        const next = new Set(prev);
                                                        next.delete(workspace.id);
                                                        return next;
                                                    });
                                                }
                                            }}
                                            title="Delete workspace"
                                        >
                                            <Trash2 size={16} />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                <div className="workspace-manager-footer">
                    <div className="workspace-manager-stats">
                        {selectedIds.size > 0 ? (
                            <span>{selectedIds.size} of {filteredWorkspaces.length} selected</span>
                        ) : (
                            <span>
                                {filteredWorkspaces.length} workspace{filteredWorkspaces.length !== 1 ? 's' : ''}
                                {hiddenWorktreeCount > 0 && (
                                    <span className="workspace-manager-hidden-note">
                                        {' '}· {hiddenWorktreeCount} worktree{hiddenWorktreeCount !== 1 ? 's' : ''} hidden
                                    </span>
                                )}
                            </span>
                        )}
                    </div>
                    <button
                        className="workspace-manager-done"
                        onClick={onClose}
                    >
                        Done
                    </button>
                </div>
            </div>
            {showAddModal && (
                <PathInputModal
                    onSubmit={handlePathSubmit}
                    onCancel={handlePathCancel}
                    onBrowse={handleBrowseFolder}
                    isBrowsing={isBrowsing}
                    showBrowseButton={true}
                    defaultBaseDirectory={defaultBaseDirectory}
                />
            )}
        </div>
    );
}
