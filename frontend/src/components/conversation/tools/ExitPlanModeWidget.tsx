/**
 * ExitPlanModeWidget — renders Claude's plan when the model calls
 * ExitPlanMode. The user is then expected to approve / reject via the
 * permission dialog (Phase 4); here we just show the plan markdown clearly.
 */
import React from 'react';
import type { ConversationToolCall, ConversationToolResult } from '@claudia/shared';
import { MarkdownRenderer } from '../MarkdownRenderer';

interface Props {
  call: ConversationToolCall;
  result?: ConversationToolResult;
}

export const ExitPlanModeWidget: React.FC<Props> = React.memo(({ call, result }) => {
  const plan = String(call.input?.plan ?? '');
  return (
    <div className="conv-tool conv-tool-plan">
      <div className="conv-tool-head">
        <span className="conv-tool-icon">📋</span>
        <span className="conv-tool-name">Proposed plan</span>
        <span className="conv-tool-meta">— awaiting your approval</span>
      </div>
      <div className="conv-tool-plan-body">
        <MarkdownRenderer markdown={plan} />
      </div>
      {result && (
        <div className={`conv-tool-result ${result.isError ? 'is-error' : ''}`}>
          {/* The tool_result here is just an ack from the SDK runtime that the
              plan mode was exited. The actual approval flow happens in the
              PermissionDialog (Phase 4). */}
          {result.output && <pre>{result.output}</pre>}
        </div>
      )}
    </div>
  );
});

ExitPlanModeWidget.displayName = 'ExitPlanModeWidget';
