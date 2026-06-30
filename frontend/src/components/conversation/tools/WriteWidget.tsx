/**
 * WriteWidget — file-creation widget. Shows the file path and the new
 * contents as a green-tinted block (semantically, "everything is added").
 * Long files collapse with a Show-all toggle.
 */
import React, { useState } from 'react';
import type { ConversationToolCall, ConversationToolResult } from '@claudia/shared';

interface Props {
  call: ConversationToolCall;
  result?: ConversationToolResult;
}

const COLLAPSE_LINES = 30;

export const WriteWidget: React.FC<Props> = React.memo(({ call, result }) => {
  const filePath = call.input?.file_path ? String(call.input.file_path) : null;
  const content = call.input?.content ? String(call.input.content) : '';
  const lines = content.split('\n');
  const isLong = lines.length > COLLAPSE_LINES;
  const [expanded, setExpanded] = useState(!isLong);
  const visible = expanded ? lines : lines.slice(0, COLLAPSE_LINES);

  return (
    <div className="conv-tool conv-tool-write">
      <div className="conv-tool-head">
        <span className="conv-tool-icon">+</span>
        <span className="conv-tool-name">Write</span>
        {filePath && <span className="conv-tool-meta">{filePath}</span>}
      </div>
      <div className="conv-diff">
        {visible.map((line, i) => (
          <div key={i} className="conv-diff-line conv-diff-added">
            <span className="conv-diff-marker">+</span>
            <span className="conv-diff-text">{line}</span>
          </div>
        ))}
      </div>
      {isLong && (
        <button
          className="conv-tool-toggle"
          onClick={() => setExpanded((e) => !e)}
          type="button"
        >
          {expanded ? 'Collapse' : `Show all ${lines.length} lines`}
        </button>
      )}
      {result?.isError && result.output && (
        <pre className="conv-tool-result is-error">{result.output}</pre>
      )}
    </div>
  );
});

WriteWidget.displayName = 'WriteWidget';
