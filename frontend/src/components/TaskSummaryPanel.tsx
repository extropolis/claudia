import { SuggestedAction } from '@claudia/shared';
import { useTaskStore } from '../stores/taskStore';
import { useWebSocket } from '../hooks/useWebSocket';
import { Bot, CheckCircle, AlertCircle, HelpCircle, Lock, RefreshCw } from 'lucide-react';
import './TaskSummaryPanel.css';

interface TaskSummaryPanelProps {
  taskId: string;
}

export function TaskSummaryPanel({ taskId }: TaskSummaryPanelProps) {
  const { taskSummaries, clearTaskSummary } = useTaskStore();
  const { executeSupervisorAction, requestTaskAnalysis } = useWebSocket();

  const summary = taskSummaries.get(taskId);

  if (!summary) {
    return null;
  }

  const handleAction = (action: SuggestedAction) => {
    if (action.type === 'custom' && action.value === '') {
      // For custom action, just clear and let user type
      clearTaskSummary(taskId);
      return;
    }
    executeSupervisorAction(taskId, action);
    clearTaskSummary(taskId);
  };

  const handleRefresh = () => {
    requestTaskAnalysis(taskId);
  };

  const handleDismiss = () => {
    clearTaskSummary(taskId);
  };

  const getStatusIcon = () => {
    switch (summary.status) {
      case 'completed':
        return <CheckCircle className="status-icon completed" />;
      case 'error':
        return <AlertCircle className="status-icon error" />;
      case 'waiting_permission':
        return <Lock className="status-icon permission" />;
      case 'needs_input':
      default:
        return <HelpCircle className="status-icon input" />;
    }
  };

  const getActionButtonClass = (type: SuggestedAction['type']) => {
    switch (type) {
      case 'approve':
        return 'action-btn approve';
      case 'reject':
        return 'action-btn reject';
      case 'command':
        return 'action-btn command';
      case 'custom':
        return 'action-btn custom';
      default:
        return 'action-btn';
    }
  };

  return (
    <div className="task-summary-panel">
      <div className="summary-header">
        <Bot className="bot-icon" />
        <span className="summary-title">Task Update</span>
        {getStatusIcon()}
        <button className="refresh-btn" onClick={handleRefresh} title="Refresh analysis">
          <RefreshCw size={14} />
        </button>
        <button className="dismiss-btn" onClick={handleDismiss} title="Dismiss">
          &times;
        </button>
      </div>

      <div className="summary-content">
        <p className="summary-text">{summary.summary}</p>
        {summary.lastAction && (
          <p className="last-action">
            <strong>Last action:</strong> {summary.lastAction}
          </p>
        )}
      </div>

      {summary.suggestedActions.length > 0 && (
        <div className="suggested-actions">
          {summary.suggestedActions.map((action) => (
            <button
              key={action.id}
              className={getActionButtonClass(action.type)}
              onClick={() => handleAction(action)}
              title={action.description}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
