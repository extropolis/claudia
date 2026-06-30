/**
 * GenericToolWidget — the "I don't have a custom widget for this tool yet"
 * fallback. Renders the tool name and pretty-printed JSON input. Pairs
 * automatically with a ToolResult when one shows up later in the timeline.
 */
import React from 'react';
import type { ConversationToolCall, ConversationToolResult } from '@claudia/shared';

interface Props {
  call: ConversationToolCall;
  result?: ConversationToolResult;
}

const stripMcpPrefix = (name: string): string => name.replace(/^mcp__[^_]+__/, '');

export const GenericToolWidget: React.FC<Props> = React.memo(({ call, result }) => {
  const display = stripMcpPrefix(call.name);
  return (
    <div className="conv-tool conv-tool-generic">
      <div className="conv-tool-head">
        <span className="conv-tool-icon">⚙</span>
        <span className="conv-tool-name">{display}</span>
      </div>
      {Object.keys(call.input).length > 0 && (
        <pre className="conv-tool-input">{JSON.stringify(call.input, null, 2)}</pre>
      )}
      {result && (
        <pre
          className={`conv-tool-result ${result.isError ? 'is-error' : ''}`}
        >
          {result.output || '(no output)'}
        </pre>
      )}
    </div>
  );
});

GenericToolWidget.displayName = 'GenericToolWidget';
