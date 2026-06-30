/**
 * UserMessage — same renderer as assistant but visually distinct so you
 * can scan the thread quickly. Optionally shows a timestamp footer when
 * this is the last message in its run (messenger-app style).
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

export const UserMessage: React.FC<Props> = React.memo(
  ({ text, timestamp, showTimestamp }) => {
    return (
      <div className="conv-msg-row conv-msg-row-user">
        <div className="conv-msg conv-msg-user">
          <div className="conv-msg-user-label">You</div>
          <MarkdownRenderer text={text} />
        </div>
        {showTimestamp && timestamp && (
          <div className="conv-msg-timestamp conv-msg-timestamp-user">
            {formatMessengerTime(timestamp)}
          </div>
        )}
      </div>
    );
  },
);

UserMessage.displayName = 'UserMessage';
