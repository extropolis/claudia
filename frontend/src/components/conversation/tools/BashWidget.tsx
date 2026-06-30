/**
 * BashWidget — shell command + (optional) ANSI-colored result. Uses
 * ansi-to-html so terminal output that contains color sequences from
 * tools like `ls --color`, `git diff`, or test runners renders with
 * the colors preserved (not as the literal escape characters).
 *
 * IMPORTANT: ansi-to-html outputs HTML; we sanitize-by-construction by
 * only feeding it strings we got from a tool_result (Claude Code's
 * trusted JSONL) and rendering inside a styled <pre> with CSS that
 * scopes any styling to inline tags it produces.
 */
import React, { useMemo, useState } from 'react';
import AnsiToHtml from 'ansi-to-html';
import type { ConversationToolCall, ConversationToolResult } from '@claudia/shared';

interface Props {
  call: ConversationToolCall;
  result?: ConversationToolResult;
}

const ansiConverter = new AnsiToHtml({
  fg: '#e5e5e5',
  bg: '#0a0a0a',
  newline: false,
  escapeXML: true,
});

const COLLAPSE_THRESHOLD = 1500;

export const BashWidget: React.FC<Props> = React.memo(({ call, result }) => {
  const command = String(call.input?.command ?? '');
  const description = call.input?.description ? String(call.input.description) : null;

  const html = useMemo(() => {
    if (!result?.output) return '';
    try {
      return ansiConverter.toHtml(result.output);
    } catch {
      return result.output;
    }
  }, [result?.output]);

  const isLong = (result?.output?.length ?? 0) > COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(!isLong);

  return (
    <div className="conv-tool conv-tool-bash">
      <div className="conv-tool-head">
        <span className="conv-tool-icon">$</span>
        <span className="conv-tool-name">Bash</span>
        {description && <span className="conv-tool-meta">— {description}</span>}
      </div>
      <pre className="conv-tool-input">{command}</pre>
      {result && (
        <>
          <div
            className={`conv-tool-result ${result.isError ? 'is-error' : ''} ${
              !expanded ? 'is-collapsed' : ''
            }`}
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: html }}
          />
          {isLong && (
            <button
              className="conv-tool-toggle"
              onClick={() => setExpanded((e) => !e)}
              type="button"
            >
              {expanded ? 'Collapse' : `Show all (${result.output.length} chars)`}
            </button>
          )}
        </>
      )}
    </div>
  );
});

BashWidget.displayName = 'BashWidget';
