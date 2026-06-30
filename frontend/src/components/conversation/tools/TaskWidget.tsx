/**
 * TaskWidget — renders a Task (subagent) tool call. The model spawned a
 * subagent; we show the prompt and (when available) summary of the result.
 *
 * The full subagent transcript isn't returned as ConversationEvents in v1
 * — the SDK normalizer drops sub-events for now. Phase 6 will surface a
 * collapsed nested view if the SDK exposes the subagent's events.
 */
import React, { useState } from 'react';
import type { ConversationToolCall, ConversationToolResult } from '@claudia/shared';

interface Props {
  call: ConversationToolCall;
  result?: ConversationToolResult;
}

export const TaskWidget: React.FC<Props> = React.memo(({ call, result }) => {
  const subagentType = String(call.input?.subagent_type ?? 'agent');
  const description = String(call.input?.description ?? '');
  const prompt = String(call.input?.prompt ?? '');
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="conv-tool conv-tool-task">
      <div className="conv-tool-head">
        <span className="conv-tool-icon">🤖</span>
        <span className="conv-tool-name">Subagent · {subagentType}</span>
        {description && <span className="conv-tool-meta">— {description}</span>}
      </div>
      <button
        className="conv-tool-toggle"
        onClick={() => setExpanded((e) => !e)}
        type="button"
      >
        {expanded ? 'Hide prompt' : 'Show prompt'}
      </button>
      {expanded && <pre className="conv-tool-input">{prompt}</pre>}
      {result && (
        <div className={`conv-tool-result ${result.isError ? 'is-error' : ''}`}>
          <pre>{result.output}</pre>
        </div>
      )}
    </div>
  );
});

TaskWidget.displayName = 'TaskWidget';
