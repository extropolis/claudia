/**
 * GlobWidget — pattern + path one-liner with match count.
 */
import React, { useState } from 'react';
import type { ConversationToolCall, ConversationToolResult } from '@claudia/shared';

interface Props {
  call: ConversationToolCall;
  result?: ConversationToolResult;
}

export const GlobWidget: React.FC<Props> = React.memo(({ call, result }) => {
  const pattern = call.input?.pattern ? String(call.input.pattern) : '';
  const pathInput = call.input?.path ? String(call.input.path) : null;
  const [expanded, setExpanded] = useState(false);
  const out = result?.output ?? '';
  const matchCount = out ? out.split('\n').filter(Boolean).length : null;

  return (
    <div className="conv-tool conv-tool-glob">
      <div className="conv-tool-head">
        <span className="conv-tool-icon">📁</span>
        <span className="conv-tool-name">Glob</span>
        <span className="conv-tool-meta">
          {pattern}{pathInput ? ` in ${pathInput}` : ''}
          {matchCount !== null && ` — ${matchCount} file${matchCount === 1 ? '' : 's'}`}
        </span>
      </div>
      {result && out && (
        <>
          {expanded && (
            <pre className={`conv-tool-result ${result.isError ? 'is-error' : ''}`}>{out}</pre>
          )}
          <button
            className="conv-tool-toggle"
            onClick={() => setExpanded((e) => !e)}
            type="button"
          >
            {expanded ? 'Hide files' : 'Show files'}
          </button>
        </>
      )}
    </div>
  );
});

GlobWidget.displayName = 'GlobWidget';
