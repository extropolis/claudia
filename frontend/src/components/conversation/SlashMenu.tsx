/**
 * SlashMenu — floating typeahead that opens above the textarea when the
 * user types "/" at column 0 or after whitespace. Renders via a portal so
 * the textarea's overflow doesn't clip it.
 *
 * Driven entirely by props from TaskInputBar — owns no state of its own
 * except hover-vs-keyboard nav. The parent decides when to show, what's
 * filtered, and what to do on selection.
 */
import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { SlashCommand } from './slashCommands';
import './SlashMenu.css';

interface Props {
  /** Filtered, ranked command list to display. */
  commands: SlashCommand[];
  /** Currently-highlighted index within `commands` (keyboard nav). */
  selectedIndex: number;
  /** Anchor position in viewport coordinates — typically the caret bottom. */
  anchor: { left: number; bottom: number };
  /** User selected a command (mouse click or keyboard Enter). */
  onSelect: (cmd: SlashCommand) => void;
  /** Hover changes keyboard selection so Enter targets the hovered item. */
  onHoverIndex: (i: number) => void;
}

const MENU_HEIGHT_ESTIMATE = 320;
const MENU_WIDTH = 360;

export const SlashMenu: React.FC<Props> = ({
  commands,
  selectedIndex,
  anchor,
  onSelect,
  onHoverIndex,
}) => {
  // Keep the highlighted item in view when arrow keys move it past the
  // visible window. Done via DOM rather than scrollIntoView({block}) so
  // we can pin it to the menu's own scrollable region.
  useEffect(() => {
    const el = document.querySelector(
      `.slash-menu-item[data-index="${selectedIndex}"]`,
    );
    if (el && 'scrollIntoView' in el) {
      (el as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (commands.length === 0) return null;

  // Decide whether to flip above or below the caret. Default: above the
  // caret so the textarea isn't covered. If we'd run off the top, drop
  // below.
  const wouldGoOffTop = anchor.bottom - MENU_HEIGHT_ESTIMATE < 8;
  const top = wouldGoOffTop ? anchor.bottom + 6 : undefined;
  const bottom = wouldGoOffTop
    ? undefined
    : Math.max(8, window.innerHeight - anchor.bottom + 18);

  // Keep menu inside viewport horizontally.
  const left = Math.min(
    Math.max(8, anchor.left),
    window.innerWidth - MENU_WIDTH - 8,
  );

  // Group consecutive items by section for lightweight headers.
  const grouped: Array<{ section: string; items: SlashCommand[] }> = [];
  for (const cmd of commands) {
    const last = grouped[grouped.length - 1];
    if (last && last.section === cmd.section) last.items.push(cmd);
    else grouped.push({ section: cmd.section, items: [cmd] });
  }

  // Compute a stable visual index across sections so keyboard nav matches
  // the order in `commands` even when sections are inserted between.
  let runningIndex = 0;

  return createPortal(
    <div
      className="slash-menu"
      style={{
        position: 'fixed',
        left,
        top,
        bottom,
        width: MENU_WIDTH,
      }}
      // Don't steal focus from the textarea on click.
      onMouseDown={(e) => e.preventDefault()}
    >
      {grouped.map((group) => (
        <div key={group.section} className="slash-menu-section">
          <div className="slash-menu-section-header">{group.section}</div>
          {group.items.map((cmd) => {
            const idx = runningIndex++;
            const selected = idx === selectedIndex;
            return (
              <div
                key={cmd.name}
                className={`slash-menu-item ${selected ? 'is-selected' : ''}`}
                data-index={idx}
                onMouseEnter={() => onHoverIndex(idx)}
                onClick={() => onSelect(cmd)}
              >
                <span className="slash-menu-name">/{cmd.name}</span>
                {cmd.argHint && (
                  <span className="slash-menu-arg">{cmd.argHint}</span>
                )}
                <span className="slash-menu-desc">{cmd.description}</span>
              </div>
            );
          })}
        </div>
      ))}
      <div className="slash-menu-footer">
        <span>↑↓</span>
        <span className="slash-menu-footer-label">navigate</span>
        <span>↵</span>
        <span className="slash-menu-footer-label">select</span>
        <span>esc</span>
        <span className="slash-menu-footer-label">close</span>
      </div>
    </div>,
    document.body,
  );
};
