import { useEffect, useRef } from 'react';
import { Task, Workspace } from '@claudia/shared';
import { Terminal as TerminalIcon, Sparkles } from 'lucide-react';
import { TaskInputBar } from './TaskInputBar';
import { TaskTokenStats } from './TaskTokenStats';
import { CheckpointTimeline } from './CheckpointTimeline';
import { useTaskStore } from '../stores/taskStore';
import './MinimalChatView.css';

interface MinimalChatViewProps {
  task: Task;
  wsRef: React.RefObject<WebSocket | null>;
  workspace?: Workspace;
}

/**
 * Minimal chat-style alternative to the xterm TerminalView.
 *
 * Renders a stream of first-person narration bubbles produced by the
 * backend's TaskNarrator. The input bar at the bottom is the same
 * component the terminal view uses, so messages route to the underlying
 * Claude Code PTY identically — toggling the view doesn't change
 * conversation behavior.
 */
export function MinimalChatView({ task, wsRef, workspace }: MinimalChatViewProps) {
  const narrations = useTaskStore((s) => s.narrations.get(task.id) ?? []);
  const setTaskViewMode = useTaskStore((s) => s.setTaskViewMode);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastIdRef = useRef<string | null>(null);

  // Request narration restore once per task on mount so we paint any
  // history the server has buffered. The restore message arrives via the
  // existing `task:narration:restore` handler.
  const restoreRequestedRef = useRef<string | null>(null);
  useEffect(() => {
    if (restoreRequestedRef.current === task.id) return;
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(
      JSON.stringify({ type: 'task:restore', payload: { taskId: task.id } }),
    );
    restoreRequestedRef.current = task.id;
  }, [task.id, wsRef]);

  // Auto-scroll to bottom when a new narration arrives.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const newest = narrations[narrations.length - 1];
    if (!newest) return;
    if (lastIdRef.current === newest.id) return;
    lastIdRef.current = newest.id;
    // Smooth-scroll the new bubble into view.
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [narrations]);

  const stateLabel = task.state === 'interrupted' ? 'INTERRUPTED' : task.state;

  return (
    <div className="terminal-view minimal-chat-view">
      <div className="terminal-header">
        <span className="terminal-title">{task.prompt}</span>
        <button
          className="view-toggle-button"
          onClick={() => setTaskViewMode(task.id, 'terminal')}
          title="Switch to terminal view"
        >
          <TerminalIcon size={14} />
          <span>Terminal</span>
        </button>
        <span className={`terminal-state ${task.state}`}>{stateLabel}</span>
      </div>
      <div className="minimal-chat-stream" ref={scrollRef}>
        {narrations.length === 0 ? (
          <div className="minimal-chat-empty">
            <Sparkles size={28} strokeWidth={1.5} />
            <p>Waiting for Claude to start narrating…</p>
            <p className="minimal-chat-hint">
              You'll see short, conversational updates here while the task is running.
            </p>
          </div>
        ) : (
          <ul className="minimal-chat-bubbles">
            {narrations.map((m) => (
              <li key={m.id} className="minimal-chat-bubble">
                <div className="minimal-chat-bubble-text">{m.text}</div>
                <div className="minimal-chat-bubble-time">
                  {new Date(m.timestamp).toLocaleTimeString([], {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <TaskInputBar task={task} wsRef={wsRef} />
      {workspace && (
        <CheckpointTimeline taskId={task.id} workspaceId={workspace.id} wsRef={wsRef} />
      )}
      <TaskTokenStats taskId={task.id} />
    </div>
  );
}
