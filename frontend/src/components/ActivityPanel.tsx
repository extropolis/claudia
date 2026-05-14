import { useEffect, useRef } from 'react';
import { X, CheckCircle, AlertCircle, XCircle, Trash2 } from 'lucide-react';
import { useTaskStore, ActivityEvent } from '../stores/taskStore';
import './ActivityPanel.css';

interface ActivityPanelProps {
  onClose: () => void;
  onSelectTask: (taskId: string) => void;
}

function formatTimeAgo(date: Date): string {
  const now = Date.now();
  const then = date.getTime();
  const diffMs = now - then;
  if (diffMs < 0) return 'now';
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function ActivityIcon({ type }: { type: ActivityEvent['type'] }) {
  switch (type) {
    case 'completed':
      return <CheckCircle size={16} className="activity-icon completed" />;
    case 'waiting_input':
      return <AlertCircle size={16} className="activity-icon waiting" />;
    case 'error':
      return <XCircle size={16} className="activity-icon error" />;
  }
}

function activityLabel(type: ActivityEvent['type']): string {
  switch (type) {
    case 'completed':
      return 'Completed';
    case 'waiting_input':
      return 'Needs input';
    case 'error':
      return 'Error';
  }
}

export function ActivityPanel({ onClose, onSelectTask }: ActivityPanelProps) {
  const activityLog = useTaskStore((state) => state.activityLog);
  const unreadTaskIds = useTaskStore((state) => state.unreadTaskIds);
  const tasks = useTaskStore((state) => state.tasks);
  const clearAllActivityLog = useTaskStore((state) => state.clearAllActivityLog);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay to prevent the opening click from closing
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleClickEvent = (event: ActivityEvent) => {
    // Check if task still exists
    if (tasks.has(event.taskId)) {
      onSelectTask(event.taskId);
      onClose();
    }
  };

  return (
    <div className="activity-panel" ref={panelRef}>
      <div className="activity-panel-header">
        <span className="activity-panel-title">Activity</span>
        <div className="activity-panel-actions">
          {activityLog.length > 0 && (
            <button className="activity-clear-btn" onClick={clearAllActivityLog} title="Clear all">
              <Trash2 size={16} />
            </button>
          )}
          <button className="activity-close-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </div>
      <div className="activity-panel-body">
        {activityLog.length === 0 ? (
          <div className="activity-empty">No recent activity</div>
        ) : (
          activityLog.map((event) => {
            const isUnread = unreadTaskIds.has(event.taskId);
            const taskExists = tasks.has(event.taskId);
            return (
              <div
                key={event.id}
                className={`activity-event ${isUnread ? 'unread' : ''} ${taskExists ? 'clickable' : 'stale'}`}
                onClick={() => handleClickEvent(event)}
              >
                <ActivityIcon type={event.type} />
                <div className="activity-event-content">
                  <span className="activity-event-name">{event.taskName}</span>
                  <span className="activity-event-label">
                    {event.message || activityLabel(event.type)}
                  </span>
                </div>
                <span className="activity-event-time">{formatTimeAgo(event.timestamp)}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
