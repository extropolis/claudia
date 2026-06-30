/**
 * Sanitize scrollback before writing to a fresh ghostty-web terminal instance.
 *
 * Three-stage pipeline (extracted from TerminalView.tsx so it can be tested):
 *
 * 1. NUL bytes and Unicode validation: discard if corrupted, otherwise replace
 *    invalid code points with '?'.
 * 2. Strip cursor-state and TUI-animation escape sequences. Replayed history
 *    is NOT a real interactive TUI — relative cursor movement and erase ops
 *    have no anchor and end up clobbering legit content. We flatten them to
 *    a static linear text dump.
 * 3. Strip Claudia-specific artifacts: zsh PROMPT_SP spaces, Claude Code
 *    startup banner (drawn with box-drawing chars at one width), wide
 *    horizontal separators, and session-reconnect separator lines.
 *
 * Returns null when the input looks too corrupted to safely render.
 */
export function sanitizeHistoryForRestore(raw: string): string | null {
  // ── Stage 1: NUL bytes and Unicode validation ─────────────────────────
  let s = raw;
  if (s.includes('\x00')) {
    s = s.replace(/\x00/g, '');
  }

  // Detect binary corruption: too many control chars in the [0x01..0x06] or
  // [0x0E..0x1A] range usually means the file was clobbered by a binary write.
  let suspicious = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x01 && c <= 0x06) || (c >= 0x0E && c <= 0x1A)) suspicious++;
  }
  if (s.length > 0 && suspicious / s.length > 0.005) return null;

  // Replace invalid Unicode code points (paired surrogates etc.)
  let validated = '';
  let invalidCount = 0;
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i);
    if (cp === undefined || cp < 0 || cp > 0x10ffff) {
      invalidCount++;
      validated += '?';
    } else if (cp > 0xffff) {
      validated += String.fromCodePoint(cp);
      i++;
    } else {
      validated += s[i];
    }
  }
  if (s.length > 0 && invalidCount / s.length > 0.01) return null;

  // ── Stage 2: Strip cursor-state and TUI-animation escape sequences ────
  //
  // Why: Claude Code's TUI uses *relative* cursor movement (CSI A/B/C/D/E/F/G)
  // to animate the spinner glyph in the static logo line. Each frame is e.g.
  //   <CR><ESC>[8A<color>✶<reset><CR>
  // When replayed into a fresh terminal, the cursor isn't where Claude
  // assumed (top of the logo box) — it's at the bottom of the freshly-written
  // history. So `[8A` jumps 8 rows up into the middle of replayed text and
  // the spinner glyph clobbers a random "C" of "Claude" or "y" of "latest" —
  // exactly the orange-overlapping-letters garble we've been chasing.
  //
  // History replay produces a static visual snapshot, not an interactive TUI,
  // so flattening cursor movement and erase ops is safe. Live updates from
  // the active PTY redraw the spinner cleanly on top of the clean tail.
  let r = validated;
  r = r.replace(/\x1b[78]/g, ''); // ESC 7/8 cursor save/restore (DEC)
  r = r.replace(/\x1b\[s/g, ''); // CSI s cursor save
  r = r.replace(/\x1b\[u/g, ''); // CSI u cursor restore
  r = r.replace(/\x1b\[\d*;?\d*r/g, ''); // CSI r scroll region
  r = r.replace(/\x1b\[\d*;?\d*[Hf]/g, ''); // CSI H/f absolute cursor position
  r = r.replace(/\x1b\[\d*[ABCDEFG]/g, ''); // CSI A/B/C/D up/down/right/left + E/F next/prev line + G column abs
  r = r.replace(/\x1b\[\d*[JK]/g, ''); // CSI J/K erase in display/line
  r = r.replace(/\x1b\[[\d;]*[ST]/g, ''); // CSI S/T scroll up/down
  r = r.replace(/\x1b\[\d*[`a]/g, ''); // CSI ` (HPA), CSI a (HPR) — column abs/relative
  r = r.replace(/\x1b\[\d*d/g, ''); // CSI d (VPA — line position absolute)
  r = r.replace(/\x1b\[\d*e/g, ''); // CSI e (VPR — line position relative)
  r = r.replace(/\x1b\[\?(1049|47|1047)[hl]/g, ''); // alt screen buffer
  r = r.replace(/\x1b\[\?(25|12)[hl]/g, ''); // cursor visibility / blink
  r = r.replace(/\x1b\[\?7[hl]/g, ''); // autowrap mode
  r = r.replace(/\x1bc/g, ''); // RIS (full terminal reset)
  r = r.replace(/\x1b\[2J/g, ''); // clear screen (also caught by [JK] above)
  r = r.replace(/\x1b\[3J/g, ''); // clear screen + scrollback

  // ── Stage 3: Claudia-specific cleanups ────────────────────────────────
  // zsh PROMPT_SP: spaces before CR (not before \r\n)
  r = r.replace(/[ \t]+\r(?!\n)/g, '\r');

  // Strip Claude Code's startup TUI banner — it's drawn with box characters at
  // a specific terminal width and garbles badly when replayed at a different
  // width. We strip runs of lines that are predominantly box-drawing chars.
  r = r.replace(
    /(\r?\n[ \t]*[│╭╰╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬├┤┬┴┼─═║╔╗╚╝╠╣╦╩╬]+[^\r\n]*)+/g,
    '',
  );

  // Strip full-width horizontal separator lines (─ U+2500, - repeated, ═ U+2550)
  r = r.replace(/\r?\n?[ \t]*[-─═━]{10,}[ \t]*\r?\n?/g, '\n');

  // Strip accumulated session-reconnect separator lines
  r = r.replace(
    /\r?\n?\x1b\[90m─── (Resuming session [a-f0-9-]+|Session reconnected) ───\x1b\[0m\r?\n?\r?\n?/g,
    '',
  );

  // ── Stage 4: Collapse spinner-frame residue ───────────────────────────
  // After stripping cursor movement, each Claude Code spinner frame leaves
  // behind its trailer: a single colored spinner glyph (⏺ ✶ ✳ ✺ ✹ ✷ etc.)
  // followed by ~22 empty `<CR><LF>` lines. With thousands of frames in a
  // long-running task, this produces hundreds of thousands of blank lines
  // and lone spinner glyphs that push all real content off-screen. We
  // collapse two patterns:
  //
  //   1. Runs of "near-blank" lines (whitespace, bare CRs, and an optional
  //      colored spinner glyph wrapped in SGR) down to a single blank line.
  //   2. Runs of 4+ bare newlines down to one blank line.
  //
  // Real `\n\n` paragraph breaks emitted by claude/the user survive as one
  // blank line. Real content (any line with letters, digits, or symbols
  // beyond the spinner-glyph set) is untouched.
  //
  // Note: the "near-blank line" must allow embedded `\r` (CR without LF) —
  // Claude Code's spinner frames use `\r⏺\r\r\n` (CR before glyph, two CRs
  // after) so without `\r` the lines wouldn't match and we'd leave one
  // glyph-only line per spinner frame on screen.
  const SPINNER_GLYPHS = '⏺•·✢✳✶✻✽✺✹✷⠂⠃⠉⠘⠈';
  const nearBlankLine =
    `[ \\t\\r]*(?:\\x1b\\[[\\d;]*m)*[${SPINNER_GLYPHS}]?(?:\\x1b\\[[\\d;]*m)*[ \\t\\r]*`;
  // Match a newline followed by 2+ near-blank lines (each terminated by \n)
  // then optional trailing near-blank content. Replace with a single \n\n.
  r = r.replace(
    new RegExp(`(\\r?\\n)(?:${nearBlankLine}\\n){2,}${nearBlankLine}?`, 'g'),
    '$1\n',
  );
  // Final pass: collapse any remaining run of 4+ bare newlines.
  r = r.replace(/(\r?\n){4,}/g, '\n\n');

  // ── Stage 5: Drop typing-animation frames ─────────────────────────────
  // When the user types into Claude Code's input, every keystroke emits a
  // frame that re-renders the input buffer with a cursor block at the end:
  //   `\r<typed-text-so-far>\x1b[7m \x1b[27m\r\r`
  // After stripping cursor positioning in Stage 2, every keystroke ends up
  // on its own line in scrollback (one for each character typed). For a
  // long prompt that's hundreds of "growing prefix" lines that swamp any
  // real output. Real terminals never showed these as scrollback — they
  // were transient overwrites of the same input row.
  //
  // Detect the signature: a line ending in `\x1b[7m \x1b[27m` (reverse-video
  // cursor block, plus any trailing CRs). Within a run of typing frames the
  // PTY emits a few blank `\r` separator lines between each frame; we look
  // through those to keep the run intact and emit only the FINAL frame
  // (the snapshot of the fully-typed input).
  const cursorBlock = /\x1b\[7m\x20\x1b\[27m[\s\r]*$/;
  const isBlankish = (line: string) =>
    line.replace(/\x1b\[[\d;]*m/g, '').replace(/[\r\s]/g, '') === '';
  const lines2 = r.split('\n');
  const out: string[] = [];
  let lastTypingFrame: string | null = null;
  let pendingBlanks: string[] = [];
  for (const line of lines2) {
    if (cursorBlock.test(line)) {
      // We're in a typing-frame run; remember the latest frame and discard
      // any blank lines we'd been holding (they were inter-frame noise).
      lastTypingFrame = line;
      pendingBlanks = [];
      continue;
    }
    if (lastTypingFrame !== null && isBlankish(line)) {
      // Hold blank lines: they may just separate two typing frames.
      pendingBlanks.push(line);
      continue;
    }
    // Real content: flush the saved typing frame (if any) plus its blanks.
    if (lastTypingFrame !== null) {
      out.push(lastTypingFrame);
      out.push(...pendingBlanks);
      lastTypingFrame = null;
      pendingBlanks = [];
    }
    out.push(line);
  }
  if (lastTypingFrame !== null) {
    out.push(lastTypingFrame);
    out.push(...pendingBlanks);
  }
  r = out.join('\n');

  return r;
}
