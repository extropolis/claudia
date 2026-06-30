/**
 * Tests for parseQuickAnswers — the heuristic that extracts clickable
 * buttons from a Claude Code CLI permission/question prompt's PTY output.
 *
 * These cover the known shapes:
 *   - clean line-anchored numbered options
 *   - smushed inline options (TUI whitespace collapse)
 *   - bare "Do you want to..." permission prompts (synthetic Yes/No row)
 *   - (y/n) confirmations
 *   - false positives (file-path digits) we DON'T want to match
 */
import { describe, it, expect } from 'vitest';
import { parseQuickAnswers, stripAnsi } from '../utils/parseQuickAnswers';

describe('parseQuickAnswers', () => {
  it('parses clean line-anchored numbered options with the ❯ caret', () => {
    const ans = parseQuickAnswers(
      [
        'Which approach do you want?',
        '❯ 1. Full WebView wrapper',
        '  2. Hybrid: WebView + native settings',
        '  3. WebView as one tab',
        '  4. Type something.',
      ].join('\n'),
      'question',
    );
    expect(ans.map((a) => a.send)).toEqual(['1', '2', '3', '4']);
    expect(ans[0].label).toContain('Full WebView wrapper');
    expect(ans[1].label).toContain('Hybrid');
  });

  it('parses options smushed onto a single inline line (TUI whitespace collapse)', () => {
    // The PTY ring buffer occasionally drops the newlines between options
    // when ANSI cursor moves are stripped. We must still recover the row.
    const ans = parseQuickAnswers(
      "Bash command. Do you want to proceed?  ❯ 1. Yes  2. Yes, and don't ask again  3. No, and tell Claude what to do differently",
      'permission',
    );
    expect(ans.map((a) => a.send)).toEqual(['1', '2', '3']);
    expect(ans[0].label).toContain('Yes');
    expect(ans[1].label).toContain("don't ask again");
    expect(ans[2].label).toContain('tell Claude');
  });

  it('synthesizes a 3-button permission row when "Do you want" appears with no numbers', () => {
    // Sometimes the PTY buffer lands mid-paint and the option list isn't
    // present yet — we still want a clickable row so the user can answer.
    const ans = parseQuickAnswers(
      'Install react-native-webview. Do you want to proceed?',
      'permission',
    );
    expect(ans).toHaveLength(3);
    expect(ans[0]).toMatchObject({ send: '1', variant: 'primary' });
    expect(ans[2]).toMatchObject({ send: '3', variant: 'danger' });
  });

  it('returns Yes/No buttons for (y/n) confirmation prompts', () => {
    const ans = parseQuickAnswers('Continue? (y/n)', 'confirmation');
    expect(ans.map((a) => a.send)).toEqual(['y', 'n']);
    expect(ans.map((a) => a.label)).toEqual(['Yes', 'No']);
  });

  it('does NOT match file-path or version digits as numbered options', () => {
    // "1.x version" and "/tmp/foo.42.txt" must not produce phantom buttons.
    const ans = parseQuickAnswers(
      'Read /tmp/foo.42.txt and 1.x version notes',
      'question',
    );
    expect(ans).toEqual([]);
  });

  it('deduplicates options when the same number appears twice', () => {
    const ans = parseQuickAnswers(
      [
        '1. First',
        '2. Second',
        '1. Should not duplicate',
      ].join('\n'),
      'question',
    );
    expect(ans.map((a) => a.send)).toEqual(['1', '2']);
  });

  it('parses options when the dot has no whitespace before the label (PTY paint mangling)', () => {
    // Real-world breakage: ANSI cursor moves get stripped, leaving the
    // option labels jammed against the dot ("2.Round" instead of "2. Round").
    // Only option 1 had its space preserved here. We must still recover all
    // options, otherwise the user gets one button and a wall of text.
    const ans = parseQuickAnswers(
      'Which behavior do you want? 1. Highlight targeted block Only the single block 2.Roundedges Bevel exterior edges 3.Softshader Screen-space post-process 4.Per-blockround Replace cubes with rounded meshes 5.Typesomething. 6.Chataboutthis',
      'question',
    );
    expect(ans.map((a) => a.send)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(ans[1].label).toContain('Round');
    expect(ans[2].label).toContain('Soft');
  });

  it('returns an empty array when nothing matches', () => {
    const ans = parseQuickAnswers('just some plain text with no prompts', 'question');
    expect(ans).toEqual([]);
  });
});

describe('stripAnsi', () => {
  it('removes SGR color codes', () => {
    expect(stripAnsi('\x1b[34m❯\x1b[0m 1. Yes')).toBe('❯ 1. Yes');
  });

  it('removes carriage returns', () => {
    expect(stripAnsi('hello\rworld')).toBe('helloworld');
  });

  it('leaves plain text alone', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });
});
