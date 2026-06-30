/**
 * EditWidget — Edit / NotebookEdit tool calls. Renders a side-by-side-ish
 * unified diff: each line of `old_string` becomes a red `-` row, each line
 * of `new_string` becomes a green `+` row. No external diff library; the
 * naive line-by-line split is what Nimbalyst does and it reads well in
 * practice for the typical small Edit case (where the strings ARE the
 * minimal patch).
 *
 * If the tool was called with the bulk `replacements` array form, we lay
 * out one diff block per replacement.
 */
import React from 'react';
import type { ConversationToolCall, ConversationToolResult } from '@claudia/shared';

interface Props {
  call: ConversationToolCall;
  result?: ConversationToolResult;
}

interface DiffPair {
  oldText: string;
  newText: string;
}

function asDiffPairs(input: Record<string, unknown>): DiffPair[] {
  const oldS = typeof input.old_string === 'string' ? input.old_string : null;
  const newS = typeof input.new_string === 'string' ? input.new_string : null;
  if (oldS !== null && newS !== null) {
    return [{ oldText: oldS, newText: newS }];
  }
  // Edit's bulk form: { replacements: Array<{old_string, new_string}> }
  const reps = input.replacements;
  if (Array.isArray(reps)) {
    return reps
      .map((r) =>
        typeof r === 'object' && r !== null
          ? {
              oldText: typeof (r as any).old_string === 'string' ? (r as any).old_string : '',
              newText: typeof (r as any).new_string === 'string' ? (r as any).new_string : '',
            }
          : null,
      )
      .filter((p): p is DiffPair => p !== null);
  }
  return [];
}

const DiffBlock: React.FC<{ pair: DiffPair }> = ({ pair }) => {
  const oldLines = pair.oldText.split('\n');
  const newLines = pair.newText.split('\n');
  return (
    <div className="conv-diff">
      {oldLines.map((line, i) => (
        <div key={`o-${i}`} className="conv-diff-line conv-diff-removed">
          <span className="conv-diff-marker">-</span>
          <span className="conv-diff-text">{line}</span>
        </div>
      ))}
      {newLines.map((line, i) => (
        <div key={`n-${i}`} className="conv-diff-line conv-diff-added">
          <span className="conv-diff-marker">+</span>
          <span className="conv-diff-text">{line}</span>
        </div>
      ))}
    </div>
  );
};

export const EditWidget: React.FC<Props> = React.memo(({ call, result }) => {
  const filePath = call.input?.file_path ? String(call.input.file_path) : null;
  const pairs = asDiffPairs(call.input);
  const isError = result?.isError;

  return (
    <div className="conv-tool conv-tool-edit">
      <div className="conv-tool-head">
        <span className="conv-tool-icon">✎</span>
        <span className="conv-tool-name">{call.name}</span>
        {filePath && <span className="conv-tool-meta">{filePath}</span>}
      </div>
      {pairs.map((p, i) => (
        <DiffBlock key={i} pair={p} />
      ))}
      {isError && result?.output && (
        <pre className="conv-tool-result is-error">{result.output}</pre>
      )}
    </div>
  );
});

EditWidget.displayName = 'EditWidget';
