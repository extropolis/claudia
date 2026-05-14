import { useState, useCallback, useEffect } from 'react';
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
} from 'lucide-react';
import { getApiBaseUrl } from '../config/api-config';
import { PathInputModal } from './PathInputModal';
import './WorkspaceManager.css';

interface WorkspaceManagerProps {
  workspaces: Workspace[];
  onClose: () => void;
  onCreateWorkspace: (path: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onReorderWorkspaces: (fromIndex: number, toIndex: number) => void;
}

export function WorkspaceManager({
  workspaces,
  onClose,
  onCreateWorkspace,
  onDeleteWorkspace,
  onReorderWorkspaces,
}: WorkspaceManagerProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [defaultBaseDirectory, setDefaultBaseDirectory] = useState<string | undefined>(undefined);
  const [workspaceCountWhenModalOpened, setWorkspaceCountWhenModalOpened] = useState<number | null>(
    null,
  );

  // Filter workspaces by search query
  const filteredWorkspaces = workspaces.filter((ws) => {
    const displayName = ws.displayName || ws.name;
    const query = searchQuery.toLowerCase();
    return displayName.toLowerCase().includes(query) || ws.id.toLowerCase().includes(query);
  });

  // Track when add modal opens to detect successful workspace creation
  useEffect(() => {
    if (showAddModal && workspaceCountWhenModalOpened === null) {
      setWorkspaceCountWhenModalOpened(workspaces.length);
    }
  }, [showAddModal, workspaceCountWhenModalOpened, workspaces.length]);

  // Close add modal when a new workspace is successfully added
  useEffect(() => {
    if (
      showAddModal &&
      workspaceCountWhenModalOpened !== null &&
      workspaces.length > workspaceCountWhenModalOpened
    ) {
      setShowAddModal(false);
      setWorkspaceCountWhenModalOpened(null);
    }
  }, [showAddModal, workspaceCountWhenModalOpened, workspaces.length]);

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
    setSelectedIds((prev) => {
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
    setSelectedIds(new Set(filteredWorkspaces.map((ws) => ws.id)));
  }, [filteredWorkspaces]);

  // Deselect all
  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  // Delete selected workspaces
  const deleteSelected = useCallback(async () => {
    if (selectedIds.size === 0) return;

    const confirmed = window.confirm(
      `Delete ${selectedIds.size} workspace${selectedIds.size > 1 ? 's' : ''}? Tasks will not be deleted.`,
    );

    if (!confirmed) return;

    setIsDeleting(true);
    try {
      // Delete workspaces one by one
      for (const id of selectedIds) {
        onDeleteWorkspace(id);
        // Small delay to avoid overwhelming the server
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      setSelectedIds(new Set());
    } finally {
      setIsDeleting(false);
    }
  }, [selectedIds, onDeleteWorkspace]);

  // Add new workspace
  const handleAddWorkspace = useCallback(() => {
    setShowAddModal(true);
  }, []);

  const handleBrowseFolder = useCallback(async () => {
    try {
      setIsBrowsing(true);
      const resp = await fetch(`${getApiBaseUrl()}/api/browse-folder`, {
        method: 'POST',
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

  const handlePathSubmit = useCallback(
    (path: string) => {
      onCreateWorkspace(path);
      // Modal will close automatically when workspace count increases
    },
    [onCreateWorkspace],
  );

  const handlePathCancel = useCallback(() => {
    setShowAddModal(false);
    setWorkspaceCountWhenModalOpened(null);
  }, []);

  // Drag and drop handlers
  const handleDragStart = useCallback((index: number) => {
    setDragIndex(index);
    setDragOverIndex(index);
  }, []);

  const handleDragEnter = useCallback(
    (index: number) => {
      if (dragIndex !== null) {
        setDragOverIndex(index);
      }
    },
    [dragIndex],
  );

  const handleDragEnd = useCallback(() => {
    if (dragIndex !== null && dragOverIndex !== null && dragIndex !== dragOverIndex) {
      onReorderWorkspaces(dragIndex, dragOverIndex);
    }
    setDragIndex(null);
    setDragOverIndex(null);
  }, [dragIndex, dragOverIndex, onReorderWorkspaces]);

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

  const allSelected =
    filteredWorkspaces.length > 0 && filteredWorkspaces.every((ws) => selectedIds.has(ws.id));

  return (
    <div className="workspace-manager-overlay" onClick={onClose}>
      <div className="workspace-manager-modal" onClick={(e) => e.stopPropagation()}>
        <div className="workspace-manager-header">
          <div className="workspace-manager-title">
            <Briefcase size={20} />
            <h2>Manage Workspaces</h2>
          </div>
          <button className="workspace-manager-close" onClick={onClose} title="Close (Esc)">
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
              onChange={(e) => setSearchQuery(e.target.value)}
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

                return (
                  <div
                    key={workspace.id}
                    className={`workspace-manager-item ${isSelected ? 'selected' : ''} ${isDragging ? 'dragging' : ''} ${isDropTarget ? 'drop-target' : ''}`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move';
                      handleDragStart(index);
                    }}
                    onDragEnd={handleDragEnd}
                    onDragOver={(e) => e.preventDefault()}
                    onDragEnter={() => handleDragEnter(index)}
                  >
                    <div className="workspace-item-drag-handle">
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
                      </div>
                      <div className="workspace-item-path" title={workspace.id}>
                        {workspace.id}
                      </div>
                    </div>

                    <button
                      className="workspace-item-delete"
                      onClick={() => {
                        const confirmed = window.confirm(
                          `Delete workspace "${displayName}"? Tasks will not be deleted.`,
                        );
                        if (confirmed) {
                          onDeleteWorkspace(workspace.id);
                          setSelectedIds((prev) => {
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
              <span>
                {selectedIds.size} of {filteredWorkspaces.length} selected
              </span>
            ) : (
              <span>
                {filteredWorkspaces.length} workspace{filteredWorkspaces.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <button className="workspace-manager-done" onClick={onClose}>
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
