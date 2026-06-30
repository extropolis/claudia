/**
 * SdkPermissionDialog — modal for tool-approval requests from SDK tasks.
 *
 * Behavior:
 *   - Subscribes to the SDK pending-permissions queue for the task.
 *   - Shows the first pending request as a modal with Allow / Deny buttons.
 *   - "Allow & remember" derives a permission rule (e.g. Bash(git status:*))
 *     and posts it via respondSdkPermission so the backend's allow-list grows.
 *   - When the user resolves one, the next queued request becomes visible.
 *
 * Integration: render once near the app root with the active taskId. Multiple
 * tasks would each render their own instance.
 */
import React, { useMemo, useState } from 'react';
import { useSdkPendingPermissions } from '../../stores/sdkTaskStore';
import './SdkPermissionDialog.css';

interface Props {
  taskId: string;
  /** Hook callback — typically from useWebSocket().respondSdkPermission. */
  onRespond: (
    taskId: string,
    requestId: string,
    response: {
      allow: boolean;
      rememberRule?: string;
      updatedInput?: Record<string, unknown>;
      message?: string;
    },
  ) => Promise<void>;
}

/**
 * Build a Bash-style remember rule from a Bash command. Mirrors how Claude
 * Code's own permission system encodes them: `Bash(<binary>:*)` so the user
 * can easily approve "any git command" or "any npm command" without seeing
 * future prompts. Returns null when the tool isn't Bash-shaped.
 */
function deriveRememberRule(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === 'Bash') {
    const command = String(input.command ?? '').trim();
    const firstWord = command.split(/\s+/)[0];
    if (firstWord) return `Bash(${firstWord}:*)`;
    return 'Bash(*)';
  }
  // For non-Bash tools, the rule is just the tool name.
  return toolName;
}

export const SdkPermissionDialog: React.FC<Props> = ({ taskId, onRespond }) => {
  const pending = useSdkPendingPermissions(taskId);
  const current = pending[0];
  const [busy, setBusy] = useState(false);

  const rule = useMemo(
    () => (current ? deriveRememberRule(current.toolName, current.input) : null),
    [current],
  );

  if (!current) return null;

  const handleRespond = async (allow: boolean, remember = false): Promise<void> => {
    setBusy(true);
    try {
      await onRespond(taskId, current.requestId, {
        allow,
        rememberRule: remember && rule ? rule : undefined,
        message: allow ? undefined : 'User denied tool use',
      });
    } finally {
      setBusy(false);
    }
  };

  // Pretty-print the input as JSON for inspection.
  const inputStr = JSON.stringify(current.input, null, 2);
  const truncated = inputStr.length > 1500;
  const display = truncated ? `${inputStr.slice(0, 1500)}\n…(truncated)` : inputStr;

  return (
    <div className="sdk-perm-overlay" role="dialog" aria-modal="true">
      <div className="sdk-perm-card">
        <div className="sdk-perm-header">
          <span className="sdk-perm-icon">🔐</span>
          <h3 className="sdk-perm-title">Allow {current.toolName}?</h3>
          {pending.length > 1 && (
            <span className="sdk-perm-queue">+{pending.length - 1} more</span>
          )}
        </div>
        <pre className="sdk-perm-input">{display}</pre>
        <div className="sdk-perm-actions">
          <button
            type="button"
            className="sdk-perm-btn sdk-perm-deny"
            onClick={() => handleRespond(false)}
            disabled={busy}
          >
            Deny
          </button>
          <button
            type="button"
            className="sdk-perm-btn sdk-perm-allow"
            onClick={() => handleRespond(true)}
            disabled={busy}
          >
            Allow once
          </button>
          {rule && (
            <button
              type="button"
              className="sdk-perm-btn sdk-perm-allow-remember"
              onClick={() => handleRespond(true, true)}
              disabled={busy}
              title={`Add ${rule} to allowed list for this workspace`}
            >
              Allow & remember <code>{rule}</code>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
