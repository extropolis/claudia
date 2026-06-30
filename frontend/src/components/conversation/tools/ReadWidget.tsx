/**
 * ReadWidget — compact "Reading <path>" card. We don't dump the file
 * contents into the conversation feed; the user almost always cares
 * about the fact that a file was read, not its contents (those are in
 * the assistant's resulting prose anyway). Shows offset/limit if set.
 */
import React from 'react';
import type { ConversationToolCall, ConversationToolResult } from '@claudia/shared';

interface Props {
  call: ConversationToolCall;
  result?: ConversationToolResult;
}

export const ReadWidget: React.FC<Props> = React.memo(({ call, result }) => {
  const filePath = call.input?.file_path ? String(call.input.file_path) : null;
  const offset = typeof call.input?.offset === 'number' ? call.input.offset : null;
  const limit = typeof call.input?.limit === 'number' ? call.input.limit : null;

  const range =
    offset !== null || limit !== null
      ? ` (lines ${offset ?? 1}${limit ? `–${(offset ?? 0) + limit}` : '+'})`
      : '';

  return (
    <div className="conv-tool conv-tool-read conv-tool-compact">
      <span className="conv-tool-icon">📖</span>
      <span className="conv-tool-name">Read</span>
      <span className="conv-tool-meta">{filePath ?? '(unknown)'}{range}</span>
      {result?.isError && (
        <span className="conv-tool-error-badge">error</span>
      )}
    </div>
  );
});

ReadWidget.displayName = 'ReadWidget';
