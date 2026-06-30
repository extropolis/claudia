/**
 * Heuristic parser that extracts quick-action buttons from a Claude Code
 * CLI prompt's PTY output. The conversation view's WaitingInputBanner uses
 * this to surface clickable "1. Yes / 2. No / 3. ..." options without
 * forcing the user to drop into the input bar.
 *
 * The parser is intentionally forgiving: the upstream PTY ring buffer
 * sometimes loses whitespace and ANSI cursor moves so option lines arrive
 * smushed together on a single line, and Claude Code's permission gate
 * occasionally renders without the leading "❯" caret. We try a strict
 * line-anchored pattern first, then fall back to a lenient inline pattern,
 * then to canned (Yes/No) buttons for known prompt shapes.
 *
 * Everything here is a regex over PTY text — there's no semantic
 * understanding. If a prompt slips through, the user can always type a
 * free-text reply in the input bar below.
 */

export interface QuickAnswer {
  /** What appears on the button. */
  label: string;
  /** Keystroke(s) to send to the PTY. Plain "1" means "type 1 then Enter".
   *  For raw control sequences, just send the string as-is — TaskInputBar's
   *  Enter handling won't be involved (we send via wsRef directly). */
  send: string;
  /** Optional UI styling hint. */
  variant?: 'primary' | 'danger' | 'neutral';
}

/** Strip ANSI escape sequences from PTY output. Tolerates non-string input
 *  (returns ""), since SDK-driven tasks broadcast a `task:waitingInput` event
 *  without a PTY-output snapshot — the banner just shows the icon + label
 *  in that case. */
export function stripAnsi(s: string | null | undefined): string {
  if (typeof s !== 'string' || !s) return '';
  // eslint-disable-next-line no-control-regex
  return s
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[PX^_].*?\x1b\\/g, '')
    .replace(/\x1b\[\?[0-9;]*[hl]/g, '')
    .replace(/\x1b[>=]/g, '')
    .replace(/\r/g, '');
}

/** Parse the cleaned PTY output for known interactive prompt patterns and
 *  return matching quick-action buttons. Cheap heuristic, designed to be
 *  forgiving — if nothing matches, the user falls back to the input bar. */
export function parseQuickAnswers(
  cleaned: string,
  inputType: string,
): QuickAnswer[] {
  const answers: QuickAnswer[] = [];
  const seen = new Set<string>();

  // Pattern 1a (strict): numbered options anchored to the start of a line —
  // "1. Yes", "1) Yes", or "❯ 1. Foo" with the caret form.
  //   ^\s*[❯>•]?\s*(\d)[.)]\s+(.+)$
  const lineNumberRegex = /^\s*[❯>•]?\s*(\d)[.)]\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = lineNumberRegex.exec(cleaned)) !== null) {
    const num = match[1];
    const text = match[2].trim().slice(0, 60);
    if (seen.has(num)) continue;
    seen.add(num);
    answers.push({ label: `${num}. ${text}`, send: num });
  }

  // Pattern 1b (lenient): the TUI renderer collapses whitespace so options
  // sometimes arrive as one long line — e.g.
  //   "❯ 1. Yes  2. Yes, and don't ask again  3. No, tell Claude what to do".
  // Worse, ANSI cursor-move stripping can drop the space *between the dot
  // and the label* too, so we see "2.Roundedges 3.Softshader …". Walk the
  // whole `cleaned` string for "<digit>." or "<digit>)" runs and stop each
  // label at the next "<digit>." marker (or end of string). We require
  // either whitespace or end-of-string before a digit to avoid matching the
  // "12" in "v12.0", and we cap the run at ~120 chars so a runaway match
  // can't swallow the entire output.
  if (answers.length === 0) {
    // (^|[\s❯>•(]) — boundary before the digit so "v1.0" / "foo.42" don't match.
    // (\d)         — the option number.
    // ([.)])       — the "." or ")".
    // (\s*)        — captured whitespace after the dot (may be empty).
    // ([^]+?)      — non-greedy label body.
    // (?=…)        — stop at the next " <digit>[.)]", or at the end.
    const inlineRegex =
      /(?:^|[\s❯>•(])(\d)([.)])(\s*)([^]{1,120}?)(?=\s+\d[.)]|$)/g;
    let m: RegExpExecArray | null;
    while ((m = inlineRegex.exec(cleaned)) !== null) {
      const num = m[1];
      const gap = m[3];
      const rawText = m[4];
      const text = rawText.trim().replace(/\s+/g, ' ').slice(0, 80);
      if (!text || seen.has(num)) continue;
      // Sanity: bail on numbers > 9 — they're probably file-path digits.
      if (Number(num) < 1 || Number(num) > 9) continue;
      // When there's no whitespace gap after the dot (the broken-paint
      // case), the label must look like the start of a real sentence —
      // not a version suffix like "1.x" or a file extension. Heuristic:
      // first non-space char is capital, digit, or a sentence-y symbol.
      if (gap.length === 0 && !/^[A-Z0-9"'(\[]/.test(rawText)) continue;
      seen.add(num);
      answers.push({ label: `${num}. ${text}`, send: num });
    }
  }

  // Pattern 2: y/n prompts. "(y/n)", "[y/N]", "yes/no?"
  if (
    answers.length === 0 &&
    /\b(y(es)?\s*\/\s*n(o)?|\(y\/n\)|\[y\/n\])\b/i.test(cleaned)
  ) {
    answers.push({ label: 'Yes', send: 'y', variant: 'primary' });
    answers.push({ label: 'No', send: 'n', variant: 'neutral' });
  }

  // Pattern 3: Claude Code permission prompt. The TUI shows the canonical
  //   "❯ 1. Yes / 2. Yes, and don't ask again / 3. No, and tell Claude…"
  // triplet for any tool that needs approval. When the numbered-list regex
  // failed (mangled whitespace, partial paint), seeing "Do you want to" is
  // a strong signal — synthesize the standard 3-button row so the user can
  // still answer with one click.
  if (
    answers.length === 0 &&
    (inputType === 'permission' || /\bdo you want\b/i.test(cleaned))
  ) {
    answers.push({ label: '1. Yes', send: '1', variant: 'primary' });
    answers.push({
      label: "2. Yes, don't ask again",
      send: '2',
      variant: 'neutral',
    });
    answers.push({ label: '3. No', send: '3', variant: 'danger' });
  }

  return answers;
}
