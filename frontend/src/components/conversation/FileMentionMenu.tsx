/**
 * FileMentionMenu — typeahead for `@` file references inside the chat
 * composer. Mirrors SlashMenu's contract (controlled, props-driven), so
 * TaskInputBar can switch between the two by trigger character.
 *
 * Not built for v1: live workspace-wide file walk. Phase 5 ships with a
 * placeholder list provided by the parent — recent files, open tabs, or
 * an REST-fetched workspace tree. The component is structurally complete;
 * fancier search comes later.
 */
import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import './SlashMenu.css'; // reuse the same shell styling

export interface FileMention {
  /** Path relative to the workspace root, e.g. "src/server.ts". */
  path: string;
  /** Optional last-modified hint shown in dim text. */
  modifiedAt?: string;
}

interface Props {
  files: FileMention[];
  selectedIndex: number;
  anchor: { left: number; bottom: number };
  onSelect: (file: FileMention) => void;
  onHoverIndex: (i: number) => void;
}

const MENU_HEIGHT_ESTIMATE = 320;
const MENU_WIDTH = 380;

export const FileMentionMenu: React.FC<Props> = ({
  files,
  selectedIndex,
  anchor,
  onSelect,
  onHoverIndex,
}) => {
  useEffect(() => {
    const item = document.querySelector<HTMLLIElement>(
      `[data-file-mention-idx="${selectedIndex}"]`,
    );
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (files.length === 0) return null;

  // Position above the caret if there's no room below.
  const top =
    anchor.bottom + MENU_HEIGHT_ESTIMATE > window.innerHeight
      ? anchor.bottom - MENU_HEIGHT_ESTIMATE - 24
      : anchor.bottom + 4;
  const left = Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 12);

  return createPortal(
    <div
      className="slash-menu"
      style={{ top, left, width: MENU_WIDTH }}
      role="listbox"
      aria-label="File mention suggestions"
    >
      <div className="slash-menu-section">Files</div>
      <ul className="slash-menu-list">
        {files.map((f, i) => (
          <li
            key={f.path}
            data-file-mention-idx={i}
            className={`slash-menu-item ${i === selectedIndex ? 'is-selected' : ''}`}
            onMouseEnter={() => onHoverIndex(i)}
            onMouseDown={(e) => {
              // mousedown prevents the textarea from losing focus before
              // we get to fire the select handler.
              e.preventDefault();
              onSelect(f);
            }}
            role="option"
            aria-selected={i === selectedIndex}
          >
            <div className="slash-menu-name">@{f.path}</div>
            {f.modifiedAt && (
              <div className="slash-menu-desc">{f.modifiedAt}</div>
            )}
          </li>
        ))}
      </ul>
    </div>,
    document.body,
  );
};
