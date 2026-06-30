/**
 * MessageRouter — given a single ConversationEvent, dispatch to the right
 * renderer. Tool results are NOT rendered as standalone rows; they're
 * paired with their tool_call by uuid lookup and rendered inside the
 * ToolCall widget.
 */
import React from 'react';
import type { ConversationEvent } from '@claudia/shared';
import { AssistantMessage } from './AssistantMessage';
import { UserMessage } from './UserMessage';
import { Thinking } from './Thinking';
import { ToolCall } from './ToolCall';

interface Props {
  event: ConversationEvent;
  /** Maps toolUseId → tool_result event so ToolCall can pair its result. */
  resultsByToolUseId: Map<string, ConversationEvent>;
  /** True when this message is the last in its sender's "run" — used to
   *  show a messenger-app-style delivery timestamp footer. */
  showTimestamp?: boolean;
  /** Plumbed through to interactive tool widgets (e.g. AskUserQuestion). */
  wsRef?: React.RefObject<WebSocket | null>;
  taskId?: string;
}

/** Returns true for user_message events that aren't from the human — they're
 *  runtime-injected system reminders or context updates. We don't want
 *  these polluting the chat view. */
function isInjectedUserMessage(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith('<system-reminder>')) return true;
  if (trimmed.startsWith('[CONTEXT UPDATE:')) return true;
  // Skill auto-loads (file headers Claude Code injects when a skill is
  // loaded). The first line typically reads "Base directory for this skill:".
  if (trimmed.startsWith('Base directory for this skill:')) return true;
  return false;
}

export const MessageRouter: React.FC<Props> = React.memo(
  ({ event, resultsByToolUseId, showTimestamp, wsRef, taskId }) => {
    switch (event.type) {
      case 'assistant_message':
        return (
          <AssistantMessage
            text={event.text ?? ''}
            timestamp={event.timestamp}
            showTimestamp={showTimestamp}
          />
        );
      case 'user_message': {
        const text = event.text ?? '';
        if (isInjectedUserMessage(text)) return null;
        return (
          <UserMessage
            text={text}
            timestamp={event.timestamp}
            showTimestamp={showTimestamp}
          />
        );
      }
      case 'thinking':
        return <Thinking text={event.text ?? ''} />;
      case 'tool_call':
        return (
          <ToolCall
            event={event}
            result={
              event.tool ? resultsByToolUseId.get(event.tool.toolUseId) : undefined
            }
            wsRef={wsRef}
            taskId={taskId}
          />
        );
      case 'tool_result':
        // Rendered inline inside its paired ToolCall above. Skip standalone.
        return null;
      case 'summary':
        return (
          <div className="conv-system conv-summary">
            📑 {event.text ?? '(summary)'}
          </div>
        );
      case 'system':
      case 'session_meta':
        // Quiet by default — these are internal markers. Show only if they
        // actually carry user-visible text.
        if (!event.text) return null;
        return <div className="conv-system">{event.text}</div>;
      default:
        return null;
    }
  },
);

MessageRouter.displayName = 'MessageRouter';
