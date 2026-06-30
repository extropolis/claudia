/**
 * ConversationSettings — gear-button + popover that lets the user choose
 * which ConversationEvent types are visible in the React conversation view.
 *
 * When all checkboxes are checked, the view shows everything we receive
 * from Claude Code (parity with the raw terminal output). Toggling any
 * off filters those rows out of the rendered list.
 *
 * State lives in taskStore.conversationFilters and is persisted to
 * localStorage via the existing zustand persist config — settings are
 * global (not per-task) so they apply everywhere consistently.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Settings as SettingsIcon } from 'lucide-react';
import { useTaskStore } from '../../stores/taskStore';
import type { ConversationFilterSettings } from '../../stores/taskStore';
import { getApiBaseUrl } from '../../config/api-config';

interface FilterRow {
  key: keyof ConversationFilterSettings;
  label: string;
  hint?: string;
  groupStart?: string; // section heading shown above this row
}

const ROWS: FilterRow[] = [
  { key: 'userMessages', label: 'User messages', hint: 'Your prompts', groupStart: 'Messages' },
  { key: 'assistantMessages', label: 'Assistant messages', hint: "Claude's replies" },
  { key: 'thinking', label: 'Thinking', hint: 'Hidden chain-of-thought' },
  { key: 'toolCalls', label: 'Tool calls + results', hint: 'Reads, edits, bash, etc.' },
  { key: 'system', label: 'System notices', hint: 'System reminders + side-channel info' },
  { key: 'summary', label: 'Summaries', hint: 'e.g. /compact output' },
  { key: 'sessionMeta', label: 'Session metadata', hint: 'Model, working dir markers' },
  { key: 'statusBar', label: 'Status messages', hint: 'Bottom status strip (Working…, Idle, Waiting)', groupStart: 'Status & usage' },
  { key: 'tokenStats', label: 'Token usage', hint: 'Token chip + token totals panel' },
  { key: 'cost', label: 'Cost', hint: 'Estimated USD cost' },
];

export const ConversationSettings: React.FC = () => {
  const filters = useTaskStore((s) => s.conversationFilters);
  const setConversationFilter = useTaskStore((s) => s.setConversationFilter);
  const setAllConversationFilters = useTaskStore((s) => s.setAllConversationFilters);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [popPos, setPopPos] = useState<{ top: number; right: number } | null>(null);

  // Backend-gated toggle for the auto-generated mobile chat summaries that
  // fire when a task settles to idle. Lives in /api/config (not in the
  // localStorage-backed conversationFilters) because the backend is the one
  // spawning `claude -p` to write them.
  const [mobileSummariesEnabled, setMobileSummariesEnabled] = useState<boolean | null>(null);

  // Fetch the current value once the popover opens (avoids a request on every
  // mount). null = unknown; treat as on for the optimistic UI.
  useEffect(() => {
    if (!open || mobileSummariesEnabled !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${getApiBaseUrl()}/api/config`);
        if (!res.ok) return;
        const cfg = await res.json();
        if (cancelled) return;
        // Default is true when the field is missing/undefined.
        setMobileSummariesEnabled(cfg.mobileSummariesEnabled !== false);
      } catch {
        // Ignore — fall back to optimistic on.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, mobileSummariesEnabled]);

  const updateMobileSummaries = async (next: boolean) => {
    // Optimistic: flip immediately, revert on failure.
    setMobileSummariesEnabled(next);
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobileSummariesEnabled: next }),
      });
      if (!res.ok) {
        setMobileSummariesEnabled(!next);
      }
    } catch {
      setMobileSummariesEnabled(!next);
    }
  };

  // Recompute popover position from the button's bounding rect. We render
  // the popover into a portal on document.body so it escapes the
  // .terminal-header's overflow: hidden — otherwise the dropdown gets
  // clipped and disappears behind the conversation panel below it.
  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => {
      const btn = btnRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      setPopPos({
        top: r.bottom + 6,
        right: Math.max(8, window.innerWidth - r.right),
      });
    };
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  // Close popover on outside click / Escape. Outside-click must also account
  // for the portaled popover, since it lives outside wrapRef in the DOM.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const allOn = ROWS.every((r) => filters[r.key]);
  const allOff = ROWS.every((r) => !filters[r.key]);

  return (
    <div className="conv-settings-wrap" ref={wrapRef}>
      <button
        ref={btnRef}
        className="view-toggle-button"
        onClick={() => setOpen((o) => !o)}
        title="Conversation view settings"
        aria-haspopup="menu"
        aria-expanded={open}
        type="button"
      >
        <SettingsIcon size={14} />
        <span>Settings</span>
      </button>
      {open && popPos &&
        createPortal(
          <div
            ref={popRef}
            className="conv-settings-pop"
            role="menu"
            style={{ top: popPos.top, right: popPos.right }}
          >
            <div className="conv-settings-header">
              <span className="conv-settings-title">Show in conversation</span>
              <div className="conv-settings-bulk">
                <button
                  type="button"
                  className="conv-settings-bulk-btn"
                  disabled={allOn}
                  onClick={() => setAllConversationFilters(true)}
                >
                  All
                </button>
                <span className="conv-settings-bulk-sep">·</span>
                <button
                  type="button"
                  className="conv-settings-bulk-btn"
                  disabled={allOff}
                  onClick={() => setAllConversationFilters(false)}
                >
                  None
                </button>
              </div>
            </div>
            <ul className="conv-settings-list">
              {ROWS.map((row) => (
                <React.Fragment key={row.key}>
                  {row.groupStart && (
                    <li
                      className="conv-settings-group"
                      role="presentation"
                      aria-hidden="true"
                    >
                      {row.groupStart}
                    </li>
                  )}
                  <li className="conv-settings-row">
                    <label className="conv-settings-label">
                      <input
                        type="checkbox"
                        checked={filters[row.key]}
                        onChange={(e) => setConversationFilter(row.key, e.target.checked)}
                      />
                      <span className="conv-settings-text">
                        <span className="conv-settings-name">{row.label}</span>
                        {row.hint && <span className="conv-settings-hint">{row.hint}</span>}
                      </span>
                    </label>
                  </li>
                </React.Fragment>
              ))}
              <li
                className="conv-settings-group"
                role="presentation"
                aria-hidden="true"
              >
                Mobile
              </li>
              <li className="conv-settings-row">
                <label className="conv-settings-label">
                  <input
                    type="checkbox"
                    checked={mobileSummariesEnabled !== false}
                    disabled={mobileSummariesEnabled === null}
                    onChange={(e) => updateMobileSummaries(e.target.checked)}
                  />
                  <span className="conv-settings-text">
                    <span className="conv-settings-name">Idle summaries</span>
                    <span className="conv-settings-hint">
                      Auto-generate a chat-style summary when a task goes idle
                      (also sent to paired phones)
                    </span>
                  </span>
                </label>
              </li>
            </ul>
            <div className="conv-settings-footer">
              {allOn
                ? 'Showing everything Claude Code emits.'
                : 'Some event types are hidden.'}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
};
