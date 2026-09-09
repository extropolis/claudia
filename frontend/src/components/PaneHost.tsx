import { useCallback, useEffect, useState } from 'react';
import { SplitSquareHorizontal, SplitSquareVertical, X, Terminal } from 'lucide-react';
import { TerminalView } from './TerminalView';
import type { LeafNode } from '../stores/splitLayoutStore';
import type { Task, Workspace } from '@claudia/shared';
import { TASK_DRAG_MIME } from '../config/drag-constants';
import './PaneHost.css';

interface PaneHostProps {
    leaf: LeafNode;
    isFocused: boolean;
    task: Task | undefined;
    workspace: Workspace | undefined;
    wsRef: React.RefObject<WebSocket | null>;
    /** Remount key — bumped app-wide on WS reconnect. */
    refreshCounter: number;
    canSplit: boolean;
    canClose: boolean;
    /** True when this is the only pane — keeps the original single-pane copy. */
    isOnlyPane: boolean;
    onSplit: (paneId: string, direction: 'row' | 'column') => void;
    onClose: (paneId: string) => void;
    onDropTask: (paneId: string, taskId: string) => void;
}

/**
 * One pane in the split grid: a live TerminalView plus its pane chrome, or an
 * empty-state prompt when no task is assigned.
 *
 * The chrome is injected INTO TerminalView's own header (via `paneControls`)
 * rather than overlaid, so it can't collide with the copy/learn/resume buttons
 * that already live there.
 */
export function PaneHost({
    leaf, isFocused, task, workspace, wsRef, refreshCounter,
    canSplit, canClose, isOnlyPane, onSplit, onClose, onDropTask,
}: PaneHostProps) {
    const [isDropTarget, setIsDropTarget] = useState(false);

    const hasTaskDrag = (e: React.DragEvent) => e.dataTransfer.types.includes(TASK_DRAG_MIME);

    // A drag cancelled with Escape (or dropped outside any pane) fires no
    // dragleave when the cursor is still inside this pane, so the highlight would
    // stay stuck until the next drag passed over it. `dragend` always fires on the
    // source, and it bubbles to the document, so it is the reliable reset point.
    useEffect(() => {
        if (!isDropTarget) return;
        const clear = () => setIsDropTarget(false);
        document.addEventListener('dragend', clear);
        document.addEventListener('drop', clear);
        return () => {
            document.removeEventListener('dragend', clear);
            document.removeEventListener('drop', clear);
        };
    }, [isDropTarget]);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        if (!hasTaskDrag(e)) return;
        // Both preventDefault calls are required for a drop to fire at all.
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setIsDropTarget(true);
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        // Ignore leaves fired while moving between child elements of this pane.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setIsDropTarget(false);
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        if (!hasTaskDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setIsDropTarget(false);
        const taskId = e.dataTransfer.getData(TASK_DRAG_MIME);
        if (taskId) onDropTask(leaf.id, taskId);
    }, [leaf.id, onDropTask]);

    // Shortcut hints live in the tooltips because there is no menu bar to
    // discover them from. `mod` matches what the keydown handler in App accepts.
    const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl';

    const controls = (
        <div className="pane-controls">
            <button
                className="pane-control-button"
                onClick={() => onSplit(leaf.id, 'row')}
                disabled={!canSplit}
                title={canSplit ? `Split right (${mod}+\\)` : 'Pane limit reached'}
                aria-label="Split right"
            >
                <SplitSquareHorizontal size={14} />
            </button>
            <button
                className="pane-control-button"
                onClick={() => onSplit(leaf.id, 'column')}
                disabled={!canSplit}
                title={canSplit ? `Split down (${mod}+Shift+\\)` : 'Pane limit reached'}
                aria-label="Split down"
            >
                <SplitSquareVertical size={14} />
            </button>
            {canClose && (
                <button
                    className="pane-control-button pane-control-close"
                    onClick={() => onClose(leaf.id)}
                    title={`Close pane, ${mod}+Alt+W (the task keeps running)`}
                    aria-label="Close pane"
                >
                    <X size={14} />
                </button>
            )}
        </div>
    );

    return (
        <div
            className={`pane-host${isDropTarget ? ' pane-host--drop-target' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            {task ? (
                <TerminalView
                    key={`${task.id}-${refreshCounter}`}
                    task={task}
                    wsRef={wsRef}
                    workspace={workspace}
                    paneControls={controls}
                />
            ) : (
                <div className="pane-empty">
                    <div className="pane-empty-chrome">{controls}</div>
                    <div className="pane-empty-body">
                        <Terminal size={isOnlyPane ? 48 : 40} strokeWidth={1} />
                        {isOnlyPane ? (
                            <>
                                <h2>Select a task to view its terminal</h2>
                                <p>Add a workspace and create a task to get started</p>
                            </>
                        ) : (
                            <>
                                <h3>Empty pane</h3>
                                <p>
                                    {isFocused
                                        ? 'Click a task in the sidebar to open it here'
                                        : 'Drag a task here, or click this pane then pick a task'}
                                </p>
                            </>
                        )}
                    </div>
                </div>
            )}
            {isDropTarget && <div className="pane-drop-overlay">Drop to open here</div>}
        </div>
    );
}
