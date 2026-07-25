/**
 * Terminal-query injection regression suite (bug catalog class 4, previously
 * ZERO coverage — the ";1;1R?1;2c" garbage-injection incident).
 *
 * Mechanism under test: saved/replayed history containing terminal QUERY
 * escapes makes xterm.js ANSWER every stale query; the answers are sent to
 * the live PTY as typed input. Defense: @claudia/shared stripTerminalQueries
 * at persist AND replay, with carry-over so a query split across two append
 * batches can never reassemble on disk.
 *
 * The headless-xterm half replays history through a REAL xterm parser and
 * asserts zero response bytes — the exact experiment that proved the original
 * fix (5031 injected responses → 0), now a permanent gate.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error CJS default-export interop
import xtermPkg from '@xterm/headless';
import { stripTerminalQueries, incompleteEscapeSuffixStart } from '@claudia/shared';

const { Terminal } = xtermPkg;

const CONTENT = 'line one\r\nsome \x1b[38;2;255;0;0mcolored\x1b[0m output\r\nline three\r\n';
const QUERIES = '\x1b[?6n\x1b[6n\x1b[c\x1b[>0q\x1b[?2004$p\x1b]10;?\x07';

async function replayResponses(data: string): Promise<{ count: number; bytes: number }> {
    const term = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
    let responses = '';
    let count = 0;
    term.onData((d: string) => { responses += d; count++; });
    await new Promise<void>((resolve) => term.write(data, () => resolve()));
    term.dispose();
    return { count, bytes: responses.length };
}

describe('replay injection (headless xterm gate)', () => {
    it('RAW polluted history makes xterm emit responses (the bug exists)', async () => {
        const polluted = CONTENT + QUERIES.repeat(50) + CONTENT;
        const { count } = await replayResponses(polluted);
        expect(count).toBeGreaterThan(0); // control: proves the gate is testing something real
    });

    it('stripped history emits ZERO responses', async () => {
        const polluted = CONTENT + QUERIES.repeat(50) + CONTENT;
        const { count, bytes } = await replayResponses(stripTerminalQueries(polluted));
        expect(count).toBe(0);
        expect(bytes).toBe(0);
    });

    it('stripping preserves real content byte-for-byte (colors, text, line structure)', () => {
        const stripped = stripTerminalQueries(CONTENT + QUERIES + CONTENT);
        expect(stripped).toBe(CONTENT + CONTENT);
    });
});

describe('split-boundary carry (queries split across append batches)', () => {
    it('detects an incomplete trailing escape prefix', () => {
        expect(incompleteEscapeSuffixStart('hello\x1b')).toBe(5);
        expect(incompleteEscapeSuffixStart('hello\x1b[')).toBe(5);
        expect(incompleteEscapeSuffixStart('hello\x1b[?6')).toBe(5);
        expect(incompleteEscapeSuffixStart('hello\x1b[?')).toBe(5);
    });

    it('returns -1 for complete output', () => {
        expect(incompleteEscapeSuffixStart('hello world\r\n')).toBe(-1);
        expect(incompleteEscapeSuffixStart(CONTENT)).toBe(-1);
    });

    it('carry protocol: holding back the partial prevents on-disk reassembly', async () => {
        // Simulate the append path: chunk1 ends mid-query, chunk2 completes it
        const chunk1 = CONTENT + '\x1b[?6';
        const chunk2 = 'n' + CONTENT;

        // WITHOUT carry: strip each chunk independently → query reassembles
        const naive = stripTerminalQueries(chunk1) + stripTerminalQueries(chunk2);
        expect(naive).toContain('\x1b[?6n'); // demonstrates why carry exists

        // WITH carry (the append path's protocol)
        const cut = incompleteEscapeSuffixStart(chunk1);
        const persisted1 = stripTerminalQueries(chunk1.slice(0, cut));
        const carry = chunk1.slice(cut);
        const persisted2 = stripTerminalQueries(carry + chunk2);
        const onDisk = persisted1 + persisted2;
        expect(onDisk).not.toContain('\x1b[?6n');
        expect(onDisk).toBe(CONTENT + CONTENT);

        // And the replay gate agrees
        const { count } = await replayResponses(onDisk);
        expect(count).toBe(0);
    });
});
