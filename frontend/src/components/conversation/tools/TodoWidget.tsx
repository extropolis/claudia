/**
 * TodoWidget — TodoWrite renders as a checklist. State icons reflect the
 * status field on each todo (pending, in_progress, completed).
 */
import React from 'react';
import type { ConversationToolCall, ConversationToolResult } from '@claudia/shared';

interface Todo {
  content?: string;
  subject?: string;
  description?: string;
  status?: 'pending' | 'in_progress' | 'completed' | string;
  activeForm?: string;
}

interface Props {
  call: ConversationToolCall;
  result?: ConversationToolResult;
}

const ICON: Record<string, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
};

export const TodoWidget: React.FC<Props> = React.memo(({ call }) => {
  const raw = (call.input?.todos as Todo[] | undefined) ?? [];
  return (
    <div className="conv-tool conv-tool-todos">
      <div className="conv-tool-head">
        <span className="conv-tool-icon">📋</span>
        <span className="conv-tool-name">Todos</span>
      </div>
      <ul className="conv-todos-list">
        {raw.map((t, i) => {
          const label = t.subject ?? t.content ?? t.description ?? '(untitled)';
          const status = t.status ?? 'pending';
          return (
            <li
              key={i}
              className={`conv-todo conv-todo-${status}`}
            >
              <span className="conv-todo-icon">{ICON[status] ?? '○'}</span>
              <span className="conv-todo-label">{label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
});

TodoWidget.displayName = 'TodoWidget';
