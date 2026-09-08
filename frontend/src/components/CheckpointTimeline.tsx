import { useState, useEffect, useCallback } from 'react';
import {
  GitBranch,
  Clock,
  RotateCcw,
  GitFork,
  Trash2,
  Plus,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
} from 'lucide-react';
import { Checkpoint } from '@claudia/shared';
import './CheckpointTimeline.css';

interface CheckpointTimelineProps {
  taskId: string;
  workspaceId: string;
  wsRef: React.RefObject<WebSocket | null>;
}

interface ConflictState {
  checkpointId: string;
  checkpointName: string;
  restoredFiles: string[];
  conflictingFiles: string[];
  selectedFiles: Set<string>;
}

export function CheckpointTimeline({ taskId, workspaceId, wsRef }: CheckpointTimelineProps) {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [restoring, setRestoring] = useState(false);

  const sendWS = useCallback(
    (type: string, payload: Record<string, unknown>) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      wsRef.current.send(JSON.stringify({ type, payload }));
    },
    [wsRef],
  );

  const fetchCheckpoints = useCallback(() => {
    sendWS('checkpoint:list', { taskId });
  }, [sendWS, taskId]);

  useEffect(() => {
    fetchCheckpoints();
  }, [fetchCheckpoints]);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;

    const handler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case 'checkpoint:list':
            setCheckpoints(msg.payload.checkpoints || []);
            break;
          case 'checkpoint:created':
            if (msg.payload.taskId === taskId) {
              setCheckpoints((prev) => [msg.payload, ...prev]);
            }
            setCreating(false);
            setNewName('');
            break;
          case 'checkpoint:deleted':
            setCheckpoints((prev) => prev.filter((c) => c.id !== msg.payload.checkpointId));
            break;
          case 'checkpoint:restored':
          case 'checkpoint:forked':
            fetchCheckpoints();
            break;
          case 'checkpoint:restore-selective-result': {
            setRestoring(false);
            const { success, restoredFiles, conflictingFiles, checkpointId, error } = msg.payload;
            if (!success) {
              alert(`Restore failed: ${error}`);
              break;
            }
            if (conflictingFiles && conflictingFiles.length > 0) {
              const cp = checkpoints.find((c) => c.id === checkpointId);
              setConflict({
                checkpointId,
                checkpointName: cp?.name || 'checkpoint',
                restoredFiles: restoredFiles || [],
                conflictingFiles,
                selectedFiles: new Set(conflictingFiles),
              });
            } else if (restoredFiles && restoredFiles.length > 0) {
              fetchCheckpoints();
            }
            break;
          }
          case 'checkpoint:restore-force-result': {
            setConflict(null);
            if (!msg.payload.success) {
              alert(`Force restore failed: ${msg.payload.error}`);
            }
            fetchCheckpoints();
            break;
          }
        }
      } catch {
        /* ignore */
      }
    };

    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [wsRef, fetchCheckpoints, taskId, checkpoints]);

  const handleCreate = () => {
    sendWS('checkpoint:create', { taskId, workspaceId, name: newName || undefined });
  };

  const handleRestore = (checkpointId: string, name: string) => {
    if (!confirm(`Restore "${name}"? Only files changed by this task will be reverted.`)) return;
    setRestoring(true);
    sendWS('checkpoint:restore-selective', { checkpointId });
  };

  const handleForceRestore = () => {
    if (!conflict) return;
    const files = Array.from(conflict.selectedFiles);
    if (files.length === 0) {
      setConflict(null);
      return;
    }
    sendWS('checkpoint:restore-force', { checkpointId: conflict.checkpointId, files });
  };

  const toggleConflictFile = (file: string) => {
    if (!conflict) return;
    const next = new Set(conflict.selectedFiles);
    if (next.has(file)) next.delete(file);
    else next.add(file);
    setConflict({ ...conflict, selectedFiles: next });
  };

  const handleFork = (checkpointId: string) => {
    const branch = prompt('Branch name (leave empty for auto-generated):');
    if (branch === null) return;
    sendWS('checkpoint:fork', { checkpointId, branchName: branch || undefined });
  };

  const handleDelete = (checkpointId: string, name: string) => {
    if (!confirm(`Delete checkpoint "${name}"?`)) return;
    sendWS('checkpoint:delete', { checkpointId });
  };

  const formatTime = (timestamp: string) => {
    const d = new Date(timestamp);
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  return (
    <div className="cp-timeline">
      <div className="cp-header" onClick={() => setExpanded(!expanded)}>
        <span className="cp-toggle">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <GitBranch size={14} />
        <span className="cp-title">Checkpoints</span>
        <span className="cp-count">{checkpoints.length}</span>
        <button
          className="cp-create-btn"
          onClick={(e) => {
            e.stopPropagation();
            setCreating(!creating);
          }}
          title="Create checkpoint"
        >
          <Plus size={14} />
        </button>
      </div>

      {expanded && (
        <div className="cp-body">
          {creating && (
            <div className="cp-create-form">
              <input
                type="text"
                placeholder="Checkpoint name (optional)"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate();
                  if (e.key === 'Escape') setCreating(false);
                }}
                autoFocus
              />
              <button className="cp-save-btn" onClick={handleCreate}>
                Save
              </button>
            </div>
          )}

          {checkpoints.length === 0 && !creating && (
            <div className="cp-empty">No checkpoints yet. Create one to save your progress.</div>
          )}

          <div className="cp-list">
            {checkpoints.map((cp, idx) => (
              <div key={cp.id} className={`cp-node ${idx === 0 ? 'cp-node-latest' : ''}`}>
                <div className="cp-node-dot" />
                <div className="cp-node-content">
                  <div className="cp-node-name">{cp.name}</div>
                  <div className="cp-node-meta">
                    <Clock size={10} />
                    <span>{formatTime(cp.timestamp)}</span>
                    {cp.gitBranch && (
                      <>
                        <GitBranch size={10} />
                        <span>{cp.gitBranch}</span>
                      </>
                    )}
                    {cp.gitRef && <span className="cp-node-sha">{cp.gitRef.slice(0, 7)}</span>}
                  </div>
                  {cp.description && <div className="cp-node-desc">{cp.description}</div>}
                </div>
                <div className="cp-node-actions">
                  <button
                    onClick={() => handleRestore(cp.id, cp.name)}
                    title="Restore"
                    disabled={restoring}
                  >
                    <RotateCcw size={12} />
                  </button>
                  <button onClick={() => handleFork(cp.id)} title="Fork branch">
                    <GitFork size={12} />
                  </button>
                  <button
                    onClick={() => handleDelete(cp.id, cp.name)}
                    title="Delete"
                    className="cp-delete-btn"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {conflict && (
        <div className="cp-conflict-overlay" onClick={() => setConflict(null)}>
          <div className="cp-conflict-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="cp-conflict-header">
              <AlertTriangle size={16} />
              <span>Conflicting Files</span>
            </div>
            <p className="cp-conflict-desc">
              {conflict.restoredFiles.length > 0 && (
                <span>{conflict.restoredFiles.length} file(s) restored successfully. </span>
              )}
              The following files were modified by another task. Select which to force-restore:
            </p>
            <div className="cp-conflict-files">
              {conflict.conflictingFiles.map((file) => (
                <label key={file} className="cp-conflict-file">
                  <input
                    type="checkbox"
                    checked={conflict.selectedFiles.has(file)}
                    onChange={() => toggleConflictFile(file)}
                  />
                  <span>{file}</span>
                </label>
              ))}
            </div>
            <div className="cp-conflict-actions">
              <button className="cp-conflict-skip" onClick={() => setConflict(null)}>
                Skip All
              </button>
              <button className="cp-conflict-force" onClick={handleForceRestore}>
                Force Restore ({conflict.selectedFiles.size})
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
