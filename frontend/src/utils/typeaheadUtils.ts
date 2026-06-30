/**
 * Typeahead utilities for the slash-command menu — port of Nimbalyst's
 * typeaheadUtils.ts. Two responsibilities:
 *
 *   1. extractTriggerMatch(): given the textarea value + caret position,
 *      decide whether a typeahead should be open and what query the user
 *      is typing. We trigger on "/" but ONLY when the slash is at column 0
 *      or follows whitespace — so paths like "/Users/foo" don't pop the
 *      menu mid-prompt.
 *
 *   2. getCursorCoordinates(): place the floating menu just above the
 *      caret. Uses the classic "mirror div" technique — a hidden div with
 *      the same styles as the textarea, where we render the text up to the
 *      caret and read the offset of a marker span. Expensive per-call but
 *      called only on trigger (not on every keystroke).
 */

export interface TriggerMatch {
  /** The character that opened the typeahead. We only support '/' for now. */
  trigger: '/';
  /** The query text after the trigger (no '/' prefix). */
  query: string;
  /** Index of the trigger char in the textarea value. */
  startIndex: number;
  /** Caret index when match was detected (= startIndex + 1 + query.length). */
  endIndex: number;
}

/** Detect a slash-command trigger at the caret. Returns null if the caret
 *  is not in a position where the menu should be open. */
export function extractTriggerMatch(
  value: string,
  caret: number,
): TriggerMatch | null {
  if (caret <= 0 || caret > value.length) return null;

  // Walk back from the caret looking for '/'. Stop at whitespace OR if we
  // hit a character that disqualifies the run (a space ends the query, a
  // newline ends it). The query itself can't contain spaces or another '/'.
  let i = caret - 1;
  let query = '';
  while (i >= 0) {
    const ch = value[i];
    if (ch === '/') {
      // Trigger candidate. Verify it's at column 0 or after whitespace.
      if (i === 0) {
        return { trigger: '/', query, startIndex: i, endIndex: caret };
      }
      const prev = value[i - 1];
      if (/\s/.test(prev)) {
        return { trigger: '/', query, startIndex: i, endIndex: caret };
      }
      // '/' embedded in a word/path — not a trigger.
      return null;
    }
    if (/\s/.test(ch)) {
      // Whitespace before any '/' means there's no active trigger.
      return null;
    }
    if (ch === '/') {
      // (Unreachable — the first branch handled this.)
      return null;
    }
    query = ch + query;
    i--;
  }
  return null;
}

/** Replace the trigger run with the chosen command name and append a space.
 *  Returns the new full value and the new caret position. */
export function insertAtTrigger(
  value: string,
  match: TriggerMatch,
  commandName: string,
): { value: string; caret: number } {
  const before = value.slice(0, match.startIndex);
  const after = value.slice(match.endIndex);
  const insertion = `/${commandName} `;
  return {
    value: before + insertion + after,
    caret: before.length + insertion.length,
  };
}

/* ─── cursor pixel coordinates (mirror-div technique) ─── */

const MIRROR_PROPS: (keyof CSSStyleDeclaration)[] = [
  'boxSizing',
  'width',
  'height',
  'overflowX',
  'overflowY',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderStyle',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'fontSizeAdjust',
  'lineHeight',
  'fontFamily',
  'textAlign',
  'textTransform',
  'textIndent',
  'textDecoration',
  'letterSpacing',
  'wordSpacing',
  'tabSize',
];

let mirrorDiv: HTMLDivElement | null = null;

function ensureMirror(): HTMLDivElement {
  if (mirrorDiv) return mirrorDiv;
  const div = document.createElement('div');
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.style.whiteSpace = 'pre-wrap';
  div.style.wordWrap = 'break-word';
  div.style.top = '0';
  div.style.left = '-9999px';
  document.body.appendChild(div);
  mirrorDiv = div;
  return div;
}

/** Returns the pixel position of the caret in viewport coordinates. */
export function getCursorCoordinates(
  textarea: HTMLTextAreaElement,
  caret: number,
): { left: number; top: number; bottom: number } {
  const div = ensureMirror();
  const computed = window.getComputedStyle(textarea);
  for (const prop of MIRROR_PROPS) {
    // @ts-expect-error -- string-indexed style copy
    div.style[prop] = computed[prop];
  }
  // Strip the leading content; we only render up to the caret + a marker.
  div.textContent = textarea.value.substring(0, caret);
  const span = document.createElement('span');
  // Use the next char (or a non-breaking space) as the marker so its bounding
  // rect coincides with where the caret sits.
  span.textContent = textarea.value.substring(caret) || '.';
  div.appendChild(span);

  const rect = textarea.getBoundingClientRect();
  const spanRect = span.getBoundingClientRect();
  const divRect = div.getBoundingClientRect();

  // span's offset relative to the mirror div, plus the textarea's viewport
  // origin, minus the textarea's scroll.
  const left = rect.left + (spanRect.left - divRect.left) - textarea.scrollLeft;
  const top = rect.top + (spanRect.top - divRect.top) - textarea.scrollTop;
  // Bottom of the caret line — useful when we want to position BELOW.
  const bottom = top + spanRect.height;

  // Cleanup span so the mirror div doesn't grow.
  div.removeChild(span);
  return { left, top, bottom };
}
