/**
 * Permission-mode helpers for the conversation view's "current mode" chip
 * and the Shift+Tab cycle binding.
 *
 * Claude Code's TUI prints a footer line that announces the active permission
 * mode and tells the user to press Shift+Tab to cycle. We don't try to drive
 * the cycle ourselves — Claude Code does — we just parse the footer for
 * display and forward the Shift+Tab keystroke to the PTY.
 *
 * Footer formats observed in real Claude Code output:
 *   ⏵⏵ accept edits on (shift+tab to cycle)
 *   ⏸ plan mode on (shift+tab to cycle)
 *   ⏵⏵ bypass permissions on (shift+tab to cycle)
 *   (default mode shows hints with no "<mode> on" line)
 */

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'bypassPermissions';

/** Captures the mode name out of Claude Code's footer line.
 *  Permissive on prefix glyph since rendering varies by terminal/font. */
const FOOTER_REGEX =
  /(?:⏵⏵|⏸|>>|>)?\s*(accept edits|plan mode|bypass permissions|bypass mode)\s+on\s*\(\s*shift\+tab/i;

/** Map the captured footer phrase → our normalised mode key. */
function phraseToMode(phrase: string): PermissionMode {
  const p = phrase.toLowerCase();
  if (p.startsWith('accept')) return 'acceptEdits';
  if (p.startsWith('plan')) return 'plan';
  if (p.startsWith('bypass')) return 'bypassPermissions';
  return 'default';
}

/**
 * Parse the latest permission mode out of a chunk of PTY output.
 * Returns `null` when the chunk has no footer line, so callers can
 * leave their stored mode untouched (sticky behaviour).
 */
export function parsePermissionModeFromOutput(
  chunk: string,
): PermissionMode | null {
  if (!chunk) return null;
  const match = FOOTER_REGEX.exec(chunk);
  if (!match) return null;
  return phraseToMode(match[1]);
}

/** Human-readable label that mirrors what Claude Code prints. */
export function permissionModeLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'acceptEdits':
      return 'accept edits on';
    case 'plan':
      return 'plan mode on';
    case 'bypassPermissions':
      return 'bypass permissions on';
    case 'default':
    default:
      return 'default mode';
  }
}

/** Tone hint for the mode chip — used by the CSS class on the chip. */
export function permissionModeTone(
  mode: PermissionMode,
): 'neutral' | 'plan' | 'warn' {
  if (mode === 'plan') return 'plan';
  if (mode === 'bypassPermissions') return 'warn';
  return 'neutral';
}
