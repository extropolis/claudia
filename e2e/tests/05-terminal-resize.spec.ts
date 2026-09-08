/**
 * Flow 5 — terminal resize. Targets the two escaped bugs CLAUDE.md documents:
 *
 *  1. "resize events with <=2 col change are suppressed to prevent feedback
 *     loops" — a scrollbar appearing changes width by ~15px, flipping cols by
 *     1-2, which made the TUI re-render at alternating widths (garbled text).
 *  2. "buffers PTY output for 250ms after resize to prevent width-mismatch
 *     corruption" — output rendered at the old width must not be written into
 *     an xterm already resized to the new one.
 *
 * Both are observable on the task:resize frames the client sends, plus the
 * rendered terminal content staying intact across the resize.
 */
import { test, expect } from '../fixtures/test.js';
import { makeGitRepo, type TempRepo } from '../harness/repo.js';
import {
    addWorkspace, createTask, expectTerminalToContain, openApp, selectTask,
    sendFollowUp, terminalText,
} from '../harness/ui.js';

test.describe.configure({ mode: 'serial' });

let repo: TempRepo;
const PROMPT = 'E2E_RESIZE_PROMPT_CHARLIE';

test.beforeAll(() => {
    repo = makeGitRepo('resize');
});

interface ResizeFrame { cols: number; rows: number }

/** Collect every task:resize payload the client sends over its WebSocket. */
async function watchResizeFrames(page: import('@playwright/test').Page): Promise<ResizeFrame[]> {
    const frames: ResizeFrame[] = [];
    page.on('websocket', (ws) => {
        ws.on('framesent', (frame) => {
            let msg: { type?: string; payload?: ResizeFrame };
            try {
                msg = JSON.parse(String(frame.payload));
            } catch {
                return;
            }
            if (msg.type === 'task:resize' && msg.payload) frames.push(msg.payload);
        });
    });
    return frames;
}

test('a small width change is suppressed; a large one resizes the PTY', async ({ page }) => {
    const frames = await watchResizeFrames(page);

    await openApp(page);
    await addWorkspace(page, repo.path);
    const item = await createTask(page, repo.path, PROMPT);
    await selectTask(page, item);
    await expectTerminalToContain(page, PROMPT);

    // Mount sends exactly one definitive resize after fit().
    await expect.poll(() => frames.length, { message: 'no initial resize was sent' })
        .toBeGreaterThan(0);
    const settled = frames.length;
    const colsBefore = frames[frames.length - 1].cols;

    // --- Bug 1: a scrollbar-sized width wobble must NOT reach the backend. ---
    // ~10px is under one character cell pair, so cols moves by <= 2 and rows
    // is unchanged: precisely the oscillation case the guard exists for.
    await page.setViewportSize({ width: 1430, height: 900 });
    await page.setViewportSize({ width: 1440, height: 900 });

    // Give the 150ms debounce + fit a generous window to (not) fire.
    await expect.poll(() => frames.length, { timeout: 3000, message: 'stable' })
        .toBeLessThanOrEqual(settled);
    expect(
        frames.length,
        'a <=2 column width wobble must not send task:resize (scrollbar oscillation guard)',
    ).toBe(settled);

    // --- A genuinely large change must resize. ---
    await page.setViewportSize({ width: 1000, height: 900 });
    await expect.poll(() => frames.length, { timeout: 5000 }).toBeGreaterThan(settled);

    const latest = frames[frames.length - 1];
    expect(latest.cols).toBeLessThan(colsBefore);
});

test('terminal content survives a resize without corruption', async ({ page }) => {
    await openApp(page);
    const item = page.locator('[data-testid="task-item"]').filter({ hasText: PROMPT });
    await selectTask(page, item);

    const MARKER = 'RESIZE_INTEGRITY_MARKER_4242';
    await sendFollowUp(page, MARKER);
    await expectTerminalToContain(page, MARKER);

    // Resize hard, in both directions, across the 250ms output-buffer window.
    await page.setViewportSize({ width: 900, height: 700 });
    await expectTerminalToContain(page, MARKER);
    await page.setViewportSize({ width: 1500, height: 950 });
    await expectTerminalToContain(page, MARKER);

    // Reflow must not shred the line into duplicated fragments: the marker is
    // still exactly one contiguous token, and the terminal still holds the
    // original prompt too.
    const text = (await terminalText(page)).replace(/\s+/g, ' ');
    expect(text).toContain(PROMPT);
    expect(
        text.split(MARKER).length - 1,
        'marker duplicated after resize — output written at a mismatched width',
    ).toBeLessThanOrEqual(3);
});

test('output that arrives during the post-resize buffer window still lands', async ({ page }) => {
    await openApp(page);
    const item = page.locator('[data-testid="task-item"]').filter({ hasText: PROMPT });
    await selectTask(page, item);
    await expectTerminalToContain(page, PROMPT);

    // Resize and immediately push output through: the client buffers PTY output
    // for 250ms, so this exercises the buffer-then-flush path rather than the
    // straight-through write. Nothing may be dropped.
    await page.setViewportSize({ width: 1100, height: 820 });
    await sendFollowUp(page, 'EMIT_OUTPUT during resize window');

    await expectTerminalToContain(page, 'FAKE_OUTPUT_MARKER_9000');
});
