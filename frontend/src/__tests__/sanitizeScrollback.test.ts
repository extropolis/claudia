import { describe, it, expect } from 'vitest';
import { sanitizeHistoryForRestore } from '../utils/sanitizeScrollback';

const ESC = '\x1b';

describe('sanitizeHistoryForRestore', () => {
  it('passes through plain text unchanged', () => {
    expect(sanitizeHistoryForRestore('hello\nworld')).toBe('hello\nworld');
  });

  it('strips NUL bytes', () => {
    expect(sanitizeHistoryForRestore('a\x00b\x00c')).toBe('abc');
  });

  it('returns null when input is binary-corrupted', () => {
    // 50 control chars in [0x01..0x06] over 100 chars → 50% > 0.5% threshold
    const corrupted = '\x01'.repeat(50) + 'a'.repeat(50);
    expect(sanitizeHistoryForRestore(corrupted)).toBeNull();
  });

  // ── The bug this PR fixes ────────────────────────────────────────────
  // Claude Code's spinner update is `<CR><ESC>[8A<color>✶<reset><CR>` —
  // a relative cursor move 8 rows UP into the static logo line. Replaying
  // it into a fresh terminal lands the colored glyph on top of "Claude"
  // text. We strip ALL relative cursor moves so replay is static.
  it('strips relative cursor up/down (CSI A/B)', () => {
    const input = `line1${ESC}[8A${ESC}[3Bline2`;
    expect(sanitizeHistoryForRestore(input)).toBe('line1line2');
  });

  it('strips cursor right/left/E/F (CSI C/D/E/F)', () => {
    const input = `${ESC}[5C${ESC}[2D${ESC}[1E${ESC}[1Fhello`;
    expect(sanitizeHistoryForRestore(input)).toBe('hello');
  });

  it('strips column-absolute moves (CSI G, CSI `)', () => {
    const input = `${ESC}[12Gtext${ESC}[24\`more`;
    expect(sanitizeHistoryForRestore(input)).toBe('textmore');
  });

  it('strips line-position moves (CSI d, CSI e)', () => {
    const input = `${ESC}[5d${ESC}[3etext`;
    expect(sanitizeHistoryForRestore(input)).toBe('text');
  });

  it('strips bare CSI A (no count = default 1)', () => {
    const input = `up${ESC}[Adown`;
    expect(sanitizeHistoryForRestore(input)).toBe('updown');
  });

  it('strips erase in display / line (CSI J, CSI K)', () => {
    const input = `before${ESC}[Jmiddle${ESC}[2Kend`;
    expect(sanitizeHistoryForRestore(input)).toBe('beforemiddleend');
  });

  it('strips DEC cursor save/restore (ESC 7 / ESC 8)', () => {
    expect(sanitizeHistoryForRestore(`a${ESC}7b${ESC}8c`)).toBe('abc');
  });

  it('strips absolute cursor positioning (CSI H/f)', () => {
    expect(sanitizeHistoryForRestore(`${ESC}[1;1Hhi${ESC}[5;10ftxt`)).toBe('hitxt');
  });

  it('strips alt-screen toggles', () => {
    expect(sanitizeHistoryForRestore(`${ESC}[?1049hcontent${ESC}[?1049l`)).toBe('content');
  });

  it('strips cursor visibility/blink toggles', () => {
    expect(sanitizeHistoryForRestore(`${ESC}[?25l${ESC}[?12htext${ESC}[?25h`)).toBe('text');
  });

  it('strips full reset (RIS)', () => {
    expect(sanitizeHistoryForRestore(`${ESC}cfresh`)).toBe('fresh');
  });

  it('preserves color SGR sequences', () => {
    const colored = `${ESC}[38;2;215;119;87mORANGE${ESC}[39m`;
    // SGR (m) is NOT in the strip list — color codes must survive replay
    // so the visual snapshot looks correct.
    expect(sanitizeHistoryForRestore(colored)).toBe(colored);
  });

  // ── End-to-end: a real spinner-update sequence captured from the bug ──
  it('flattens a Claude Code spinner update to nothing', () => {
    // Captured from task-1781802715677-3d9797630d.txt:
    //   <ESC>[2C<ESC>[3A<ESC>[2D<ESC>[3B<CR><ESC>[8A<ESC>[38;2;215;119;87m✶<ESC>[39m<CR><CR><LF>
    const spinnerFrame =
      `${ESC}[2C${ESC}[3A${ESC}[2D${ESC}[3B\r${ESC}[8A` +
      `${ESC}[38;2;215;119;87m✶${ESC}[39m\r\r\n`;
    const out = sanitizeHistoryForRestore(spinnerFrame);
    // What survives: the carriage returns + the colored glyph + the newline.
    // Color codes are intentionally preserved (see test above).
    expect(out).toBe(`\r${ESC}[38;2;215;119;87m✶${ESC}[39m\r\r\n`);
    // No cursor-movement bytes remain
    expect(out).not.toMatch(/\x1b\[\d*[ABCDEFGJK]/);
  });

  it('strips horizontal separator lines', () => {
    const sep = '\n────────────────\nbody';
    const out = sanitizeHistoryForRestore(sep);
    expect(out).not.toContain('────');
  });

  it('strips session-reconnect separators', () => {
    const sep = `\n${ESC}[90m─── Resuming session abc-123 ───${ESC}[0m\nnext`;
    const out = sanitizeHistoryForRestore(sep);
    expect(out).not.toContain('Resuming session');
  });

  it('handles empty input', () => {
    expect(sanitizeHistoryForRestore('')).toBe('');
  });

  // ── Stage 4: collapse spinner-frame residue ──────────────────────────
  it('collapses runs of blank lines from spinner frames', () => {
    // Real residue: 22 \r\n blank lines between each spinner glyph
    const blankRun = '\r\n'.repeat(22);
    const input = `before\n${blankRun}after`;
    const out = sanitizeHistoryForRestore(input)!;
    // Should collapse to no more than one blank line between
    const blanks = out.match(/\n\s*\n/g)?.length ?? 0;
    expect(out).toContain('before');
    expect(out).toContain('after');
    expect(out.split('\n').length).toBeLessThan(8);
  });

  it('collapses runs of lone spinner-glyph lines', () => {
    // After Stage 2 strips cursor moves, the spinner residue looks like
    // many lines that contain just a colored glyph wrapped in SGR.
    const glyph = `${ESC}[38;2;153;153;153m⏺${ESC}[39m`;
    const blank = '\r\n';
    const run = (`${blank}\r${glyph}\r\r\n` + blank.repeat(22)).repeat(20);
    const input = `intro\n${run}\noutro`;
    const out = sanitizeHistoryForRestore(input)!;
    expect(out).toContain('intro');
    expect(out).toContain('outro');
    // Should NOT have 20 visible glyph lines preserved
    const glyphLines = out.split('\n').filter((l) => l.includes('⏺'));
    expect(glyphLines.length).toBeLessThanOrEqual(2);
  });

  // ── Stage 5: collapse user typing-animation frames ───────────────────
  it('collapses a run of user-typing keystroke frames into one snapshot', () => {
    // Each keystroke emits: \r<typed-prefix>\x1b[7m \x1b[27m\r\r\n + 2 blank lines
    const frame = (typed: string) =>
      `\r${typed}${ESC}[7m ${ESC}[27m\r\r\n\r\n\r\n`;
    const input =
      'banner\n' + frame('h') + frame('hi') + frame('hi!') + 'next-content';
    const out = sanitizeHistoryForRestore(input)!;
    // Only the LAST snapshot ("hi!") should survive
    expect(out).toContain('hi!');
    expect(out).not.toContain('\rh\x1b'); // first frame's content shouldn't be there
    // And not "hi" as a standalone frame either
    const lines = out.split('\n');
    const cursorBlockLines = lines.filter((l) =>
      /\x1b\[7m \x1b\[27m/.test(l),
    );
    expect(cursorBlockLines.length).toBeLessThanOrEqual(1);
  });

  it('preserves real content between separate typing runs', () => {
    const frame = (typed: string) =>
      `\r${typed}${ESC}[7m ${ESC}[27m\r\r\n`;
    // Two distinct typing runs with real output between them
    const input =
      frame('a') +
      frame('ab') +
      'real intermediate content\n' +
      frame('x') +
      frame('xy');
    const out = sanitizeHistoryForRestore(input)!;
    expect(out).toContain('real intermediate content');
    // Each run should leave at most one snapshot
    expect(out).toContain('ab');
    expect(out).toContain('xy');
  });
});
