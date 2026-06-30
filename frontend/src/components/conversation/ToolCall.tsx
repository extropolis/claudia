/**
 * ToolCall — dispatches to a tool-specific widget if we have one, otherwise
 * falls back to GenericToolWidget. Looks up the matching tool_result event
 * (by toolUseId) so widgets can render call+result together.
 */
import React from 'react';
import type { ConversationEvent } from '@claudia/shared';
import { GenericToolWidget } from './tools/GenericToolWidget';
import { BashWidget } from './tools/BashWidget';
import { EditWidget } from './tools/EditWidget';
import { WriteWidget } from './tools/WriteWidget';
import { ReadWidget } from './tools/ReadWidget';
import { GrepWidget } from './tools/GrepWidget';
import { GlobWidget } from './tools/GlobWidget';
import { TodoWidget } from './tools/TodoWidget';
import { AskUserQuestionWidget } from './tools/AskUserQuestionWidget';
import { ExitPlanModeWidget } from './tools/ExitPlanModeWidget';
import { TaskWidget } from './tools/TaskWidget';

interface Props {
  event: ConversationEvent; // type === 'tool_call'
  /** The matching tool_result event (by toolUseId), if it has arrived. */
  result?: ConversationEvent;
  /** WS for interactive widgets (e.g. AskUserQuestion answer buttons). */
  wsRef?: React.RefObject<WebSocket | null>;
  taskId?: string;
}

export const ToolCall: React.FC<Props> = React.memo(
  ({ event, result, wsRef, taskId }) => {
    const call = event.tool;
    if (!call) return null;
    const tr = result?.toolResult;

    switch (call.name) {
      case 'Bash':
        return <BashWidget call={call} result={tr} />;
      case 'Edit':
      case 'NotebookEdit':
        return <EditWidget call={call} result={tr} />;
      case 'Write':
        return <WriteWidget call={call} result={tr} />;
      case 'Read':
        return <ReadWidget call={call} result={tr} />;
      case 'Grep':
        return <GrepWidget call={call} result={tr} />;
      case 'Glob':
        return <GlobWidget call={call} result={tr} />;
      case 'TodoWrite':
        return <TodoWidget call={call} result={tr} />;
      case 'AskUserQuestion':
        return (
          <AskUserQuestionWidget
            call={call}
            result={tr}
            wsRef={wsRef}
            taskId={taskId}
          />
        );
      case 'ExitPlanMode':
        return <ExitPlanModeWidget call={call} result={tr} />;
      case 'Task':
        return <TaskWidget call={call} result={tr} />;
      default:
        return <GenericToolWidget call={call} result={tr} />;
    }
  },
);

ToolCall.displayName = 'ToolCall';
