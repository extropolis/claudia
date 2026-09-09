/**
 * TerminalMirror — the server-side screen-state emulation behind task:restore.
 *
 * These tests encode the invariants proven on real 8-9MB task histories during
 * the design spike (15/15 screen-exact round-trips):
 *   1. serialize -> replay reproduces the screen exactly at the same size
 *   2. screen clears are EXECUTED, so stale frames can't overlap (the root
 *      cause of the old strip-and-replay garbling)
 *   3. device queries are consumed, never re-emitted (the ";1;1R?1;2c" class)
 *   4. the mirror resizes in lockstep and rejects insane dimensions
 *   5. legacy rebuilds never start replay mid-escape-sequence
 */
import { describe, it, expect } from 'vitest';
import headlessPkg from '@xterm/headless';
import { TerminalMirror, buildSnapshotFromHistory, DEFAULT_COLS, DEFAULT_ROWS } from '../terminal-mirror.js';

const { Terminal } = headlessPkg as unknown as typeof import('@xterm/headless');

/** Render arbitrary ANSI into a fresh headless terminal and dump its screen. */
async function renderScreen(data: string, cols: number, rows: number): Promise<string[]> {
    const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
    await new Promise<void>((resolve) => term.write(data, resolve));
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = buf.viewportY; i < buf.viewportY + rows && i < buf.length; i++) {
        lines.push(buf.getLine(i)?.translateToString(true).replace(/\s+$/, '') ?? '');
    }
    term.dispose();
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
}

/** A miniature Claude-Code-style TUI burst: colored frame, redraw-in-place. */
function tuiFrame(status: string, extra = ''): string {
    return (
        `\x1b[2J\x1b[H` + // clear + home (frame repaint)
        `\x1b[1;36m* ${status}\x1b[0m\r\n` +
        `  \x1b[90mtip: some dim text\x1b[0m\r\n` +
        extra +
        `\r\n\x1b[7m > \x1b[0m input box`
    );
}

describe('TerminalMirror', () => {
    it('round-trips a TUI stream: serialize -> replay is screen-identical', async () => {
        const mirror = new TerminalMirror(80, 24);
        await mirror.writeAndWait(tuiFrame('Thinking...'));
        await mirror.writeAndWait(tuiFrame('Running tests', '  passed 3 of 7\r\n'));
        const snap = await mirror.snapshot();

        const mirrorScreen = await renderScreen(snap.data, 80, 24);
        expect(snap.cols).toBe(80);
        expect(snap.rows).toBe(24);
        // The snapshot renders ONLY the final frame, exactly
        expect(mirrorScreen.join('\n')).toContain('* Running tests');
        expect(mirrorScreen.join('\n')).toContain('passed 3 of 7');
        expect(mirrorScreen.join('\n')).not.toContain('Thinking');

        // Second-generation round trip: replaying the snapshot and serializing
        // again must be a fixed point (screen-identical)
        const mirror2 = new TerminalMirror(80, 24);
        await mirror2.writeAndWait(snap.data);
        const snap2 = await mirror2.snapshot();
        const screen2 = await renderScreen(snap2.data, 80, 24);
        expect(screen2).toEqual(mirrorScreen);
        mirror.dispose();
        mirror2.dispose();
    });

    it('executes screen clears so stale frames cannot overlap', async () => {
        const mirror = new TerminalMirror(80, 24);
        // 50 successive frames — the old strip-and-replay approach stacked
        // these on top of each other (the reported garbled-text symptom)
        for (let i = 0; i < 50; i++) {
            await mirror.writeAndWait(tuiFrame(`Frame number ${i}`));
        }
        const snap = await mirror.snapshot();
        const screen = await renderScreen(snap.data, 80, 24);
        const text = screen.join('\n');
        expect(text).toContain('Frame number 49');
        for (let i = 0; i < 49; i++) {
            expect(text).not.toContain(`Frame number ${i}\n`);
        }
    });

    it('consumes device queries — snapshots never re-emit them', async () => {
        const mirror = new TerminalMirror(80, 24);
        await mirror.writeAndWait('before \x1b[6n\x1b[0c\x1b]10;?\x07 after');
        const snap = await mirror.snapshot();
        expect(snap.data).not.toContain('\x1b[6n');
        expect(snap.data).not.toContain('\x1b[0c');
        expect(snap.data).not.toContain(']10;?');
        const screen = await renderScreen(snap.data, 80, 24);
        expect(screen.join('\n')).toContain('before');
        expect(screen.join('\n')).toContain('after');
        mirror.dispose();
    });

    it('resizes in lockstep and reports current dimensions', async () => {
        const mirror = new TerminalMirror(120, 40);
        expect(mirror.cols).toBe(120);
        expect(mirror.rows).toBe(40);
        mirror.resize(100, 30);
        expect(mirror.cols).toBe(100);
        expect(mirror.rows).toBe(30);
        const snap = await mirror.snapshot();
        expect(snap.cols).toBe(100);
        expect(snap.rows).toBe(30);
        mirror.dispose();
    });

    it('sanitizes insane dimensions to defaults', () => {
        const mirror = new TerminalMirror(NaN, -5);
        expect(mirror.cols).toBe(DEFAULT_COLS);
        expect(mirror.rows).toBe(DEFAULT_ROWS);
        mirror.resize(100000, 0); // out of range -> defaults
        expect(mirror.cols).toBe(DEFAULT_COLS);
        expect(mirror.rows).toBe(DEFAULT_ROWS);
        mirror.dispose();
    });

    it('is inert after dispose', async () => {
        const mirror = new TerminalMirror(80, 24);
        await mirror.writeAndWait('hello');
        mirror.dispose();
        expect(mirror.isDisposed).toBe(true);
        mirror.write('ignored'); // must not throw
        mirror.resize(90, 30);   // must not throw
        const snap = await mirror.snapshot();
        expect(snap.data).toBe('');
        mirror.dispose(); // double dispose must not throw
    });
});

describe('buildSnapshotFromHistory', () => {
    it('rebuilds the final screen from a raw history stream', async () => {
        let history = '';
        for (let i = 0; i < 20; i++) {
            history += tuiFrame(`Step ${i}`);
        }
        const snap = await buildSnapshotFromHistory(history, 80, 24);
        expect(snap.cols).toBe(80);
        const screen = await renderScreen(snap.data, 80, 24);
        expect(screen.join('\n')).toContain('* Step 19');
        expect(screen.join('\n')).not.toContain('* Step 18');
    });

    it('never starts a tail replay mid-escape-sequence', async () => {
        // Build a history whose tail-cut lands inside an SGR sequence, then
        // check no literal fragment like "38;2;15m" appears on screen.
        const colorSpam = '\x1b[38;2;200;100;50mcolored\x1b[0m '.repeat(2000);
        const history = colorSpam + tuiFrame('Final frame');
        const snap = await buildSnapshotFromHistory(history, 80, 24, 4096);
        const screen = await renderScreen(snap.data, 80, 24);
        const text = screen.join('\n');
        expect(text).toContain('Final frame');
        expect(text).not.toMatch(/\d+;\d+;\d+m/); // literal SGR fragments
    });

    it('handles an empty history', async () => {
        const snap = await buildSnapshotFromHistory('', 80, 24);
        expect(typeof snap.data).toBe('string');
        expect(snap.cols).toBe(80);
    });
});
