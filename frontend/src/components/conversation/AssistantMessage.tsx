/**
 * AssistantMessage — wraps the renderer with a "speaker" header so the
 * conversation reads chronologically without us needing avatars.
 * Optionally shows a timestamp footer when this is the last message
 * in its run (messenger-app style).
 */
import React from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { formatMessengerTime } from '../../utils/formatMessengerTime';

interface Props {
  text: string;
  timestamp?: string;
  /** If true, render a small "delivered at" timestamp below the bubble. */
  showTimestamp?: boolean;
}

export const AssistantMessage: React.FC<Props> = React.memo(
  ({ text, timestamp, showTimestamp }) => {
    return (
      <div className="conv-msg-row conv-msg-row-assistant">
        <div className="conv-msg conv-msg-assistant">
          <MarkdownRenderer text={text} />
        </div>
        {showTimestamp && timestamp && (
          <div className="conv-msg-timestamp conv-msg-timestamp-assistant">
            {formatMessengerTime(timestamp)}
          </div>
        )}
      </div>
    );
  },
);

AssistantMessage.displayName = 'AssistantMessage';
