/**
 * Thinking — collapsible block for assistant's chain-of-thought. Closed by
 * default. Useful when debugging why a tool call happened, but rarely the
 * thing a user wants to read inline.
 */
import React, { useState } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';

interface Props {
  text: string;
}

export const Thinking: React.FC<Props> = React.memo(({ text }) => {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="conv-thinking"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary>💭 thinking</summary>
      <div className="conv-thinking-body">
        <MarkdownRenderer text={text} />
      </div>
    </details>
  );
});

Thinking.displayName = 'Thinking';
