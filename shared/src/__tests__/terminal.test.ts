/**
 * Guards the terminal-query stripping contract that BOTH the backend
 * (history persistence) and frontend (history replay) depend on.
 *
 * Why this matters: xterm.js answers every query sequence it replays, and
 * those answers are fed back to the live PTY as typed input — the escaped bug
 * where replaying history injected literal garbage like ";1;1R?1;2c" into the
 * user's session. `shared/` had no test package of its own, so this module was
 * only exercised indirectly and never appeared in any coverage report.
 */
import { describe, it, expect } from 'vitest';
import { stripTerminalQueries, incompleteEscapeSuffixStart } from '../terminal.js';

const ESC = '\x1b';

describe('stripTerminalQueries', () => {
    it('leaves plain text untouched', () => {
        expect(stripTerminalQueries('hello world')).toBe('hello world');
        expect(stripTerminalQueries('')).toBe('');
    });

    it('leaves text with non-query escapes untouched', () => {
        // SGR colour codes are output, not queries — stripping them would
        // destroy the rendered terminal.
        const colored = `${ESC}[31mred${ESC}[0m`;
        expect(stripTerminalQueries(colored)).toBe(colored);
    });

    describe('strips each query family', () => {
        const cases: Array<[string, string]> = [
            ['DSR cursor position (CPR)', `${ESC}[6n`],
            ['DSR device status', `${ESC}[5n`],
            ['DECXCPR', `${ESC}[?6n`],
            ['DA1 primary device attributes', `${ESC}[c`],
            ['DA1 with explicit 0', `${ESC}[0c`],
            ['DA2 secondary device attributes', `${ESC}[>c`],
            ['DA3 tertiary device attributes', `${ESC}[=c`],
            ['XTVERSION', `${ESC}[>0q`],
            ['DECRQM mode query', `${ESC}[?2026$p`],
            ['OSC 10 foreground colour query', `${ESC}]10;?${'\x07'}`],
            ['OSC 11 background colour query', `${ESC}]11;?${'\x07'}`],
            ['OSC 4 palette query', `${ESC}]4;1;?${'\x07'}`],
        ];

        for (const [name, seq] of cases) {
            it(name, () => {
                expect(stripTerminalQueries(seq)).toBe('');
                expect(stripTerminalQueries(`before${seq}after`)).toBe('beforeafter');
            });
        }
    });

    it('strips repeated and interleaved queries in one pass', () => {
        const input = `a${ESC}[6nb${ESC}[c${ESC}[6nc`;
        expect(stripTerminalQueries(input)).toBe('abc');
    });

    it('preserves surrounding output while stripping', () => {
        const input = `${ESC}[32mOK${ESC}[0m${ESC}[6n\r\n$ `;
        expect(stripTerminalQueries(input)).toBe(`${ESC}[32mOK${ESC}[0m\r\n$ `);
    });

    it('is idempotent', () => {
        const input = `x${ESC}[6ny${ESC}[>0qz`;
        const once = stripTerminalQueries(input);
        expect(stripTerminalQueries(once)).toBe(once);
    });
});

describe('incompleteEscapeSuffixStart', () => {
    it('returns -1 when there is no trailing partial escape', () => {
        expect(incompleteEscapeSuffixStart('plain text')).toBe(-1);
        expect(incompleteEscapeSuffixStart('')).toBe(-1);
        // A COMPLETE sequence is not a partial — it has already been stripped.
        expect(incompleteEscapeSuffixStart(`done${ESC}[0m`)).toBe(-1);
    });

    it('finds a bare trailing ESC', () => {
        const data = `hello${ESC}`;
        expect(incompleteEscapeSuffixStart(data)).toBe(5);
        expect(data.slice(incompleteEscapeSuffixStart(data))).toBe(ESC);
    });

    it('finds a trailing CSI cut mid-sequence', () => {
        for (const partial of [`${ESC}[`, `${ESC}[?`, `${ESC}[?6`, `${ESC}[>0`]) {
            const data = `output${partial}`;
            const idx = incompleteEscapeSuffixStart(data);
            expect(idx).toBe('output'.length);
            expect(data.slice(idx)).toBe(partial);
        }
    });

    it('finds a trailing OSC cut mid-sequence', () => {
        const data = `output${ESC}]11;`;
        const idx = incompleteEscapeSuffixStart(data);
        expect(data.slice(idx)).toBe(`${ESC}]11;`);
    });

    it('lets a query split across two chunks be stripped, not reassembled', () => {
        // The whole point: `\x1b[6n` arriving as "...\x1b[" + "6n" must not
        // survive into persisted history.
        const chunk1 = `line1${ESC}[`;
        const chunk2 = `6n\r\nline2`;

        const cut = incompleteEscapeSuffixStart(chunk1);
        expect(cut).toBeGreaterThanOrEqual(0);

        const emitted = stripTerminalQueries(chunk1.slice(0, cut));
        const carry = chunk1.slice(cut);
        const rest = stripTerminalQueries(carry + chunk2);

        expect(emitted + rest).toBe('line1\r\nline2');
        expect(emitted + rest).not.toContain(ESC);
    });

    it('only scans a bounded tail, so long clean output stays cheap', () => {
        expect(incompleteEscapeSuffixStart('x'.repeat(10_000))).toBe(-1);
    });
});
