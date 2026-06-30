/**
 * GrepWidget — pattern + glob path one-liner. Result preview is collapsed
 * by default but expandable since match counts and matched lines are
 * sometimes worth seeing inline.
 */
import React, { useState } from 'react';
import type { ConversationToolCall, ConversationToolResult } from '@claudia/shared';

interface Props {
  call: ConversationToolCall;
  result?: ConversationToolResult;
}

export const GrepWidget: React.FC<Props> = React.memo(({ call, result }) => {
  const pattern = call.input?.pattern ? String(call.input.pattern) : '';
  const pathInput = call.input?.path ? String(call.input.path) : null;
  const glob = call.input?.glob ? String(call.input.glob) : null;
  const [expanded, setExpanded] = useState(false);
  const out = result?.output ?? '';
  const summary = pathInput || glob ? ` in ${pathInput ?? glob}` : '';
  const matchCount = out ? out.split('\n').filter(Boolean).length : null;

  return (
    <div className="conv-tool conv-tool-grep">
      <div className="conv-tool-head">
        <span className="conv-tool-icon">🔍</span>
        <span className="conv-tool-name">Grep</span>
        <span className="conv-tool-meta">
          “{pattern}”{summary}
          {matchCount !== null && ` — ${matchCount} match${matchCount === 1 ? '' : 'es'}`}
        </span>
      </div>
      {result && out && (
        <>
          {expanded ? (
            <pre className={`conv-tool-result ${result.isError ? 'is-error' : ''}`}>{out}</pre>
          ) : null}
          <button
            className="conv-tool-toggle"
            onClick={() => setExpanded((e) => !e)}
            type="button"
          >
            {expanded ? 'Hide matches' : 'Show matches'}
          </button>
        </>
      )}
    </div>
  );
});

GrepWidget.displayName = 'GrepWidget';
