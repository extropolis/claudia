import { describe, it, expect, afterEach } from 'vitest';
import { lastKnownTerminalSize } from '../terminal-size';

/**
 * `lastKnownTerminalSize` is a deliberately mutable module singleton: TerminalView
 * writes the dimensions it just fitted, and WorkspacePanel reads them when spawning
 * a task so the PTY starts at the real size instead of a guess from panel width.
 *
 * That cross-module handoff only works if every importer shares one object
 * identity — so the tests below pin the shape, the defaults, and the sharing.
 */
describe('lastKnownTerminalSize', () => {
    const original = { ...lastKnownTerminalSize };

    afterEach(() => {
        lastKnownTerminalSize.cols = original.cols;
        lastKnownTerminalSize.rows = original.rows;
    });

    it('starts at a usable default rather than 0x0', () => {
        // A zero/NaN default would spawn the PTY at a degenerate size, which is
        // what reading the panel's pixel width used to produce.
        expect(original.cols).toBe(220);
        expect(original.rows).toBe(50);
        expect(Number.isInteger(original.cols)).toBe(true);
        expect(Number.isInteger(original.rows)).toBe(true);
        expect(original.cols).toBeGreaterThan(0);
        expect(original.rows).toBeGreaterThan(0);
    });

    it('is mutable in place, so a writer updates what every reader sees', () => {
        // Mirrors TerminalView's assignment after a successful fit.
        lastKnownTerminalSize.cols = 100;
        lastKnownTerminalSize.rows = 30;

        expect(lastKnownTerminalSize).toEqual({ cols: 100, rows: 30 });
    });

    it('hands the same object to every importer', async () => {
        // Re-importing must not yield a fresh copy: WorkspacePanel has to observe
        // the value TerminalView wrote, not a per-import snapshot.
        const reimported = await import('../terminal-size');

        lastKnownTerminalSize.cols = 137;

        expect(reimported.lastKnownTerminalSize).toBe(lastKnownTerminalSize);
        expect(reimported.lastKnownTerminalSize.cols).toBe(137);
    });
});
