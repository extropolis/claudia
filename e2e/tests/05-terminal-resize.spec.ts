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
import { VIEWPORT } from '../harness/env.js';
import {
    addWorkspace, createTask, expectTerminalToContain, openApp, selectTask,
    sendFollowUp, taskRow, terminalText,
} from '../harness/ui.js';

test.describe.configure({ mode: 'serial' });

let repo: TempRepo;
const PROMPT = 'E2E_RESIZE_PROMPT_CHARLIE';

test.beforeAll(() => {
    repo = makeGitRepo('resize');
});

interface ResizeFrame { cols: number; rows: number; /** ms since the watcher started */ t: number }

/** Reference point for the `t` in ResizeFrame — makes failure dumps readable. */
const t0 = Date.now();

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
            if (msg.type === 'task:resize' && msg.payload) {
                frames.push({ cols: msg.payload.cols, rows: msg.payload.rows, t: Date.now() - t0 });
            }
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

    // Mount sends one definitive resize after fit(), but layout can legitimately
    // settle again shortly after (fonts, the header/input bar, the DOM-renderer
    // fallback) and each of those is a real >2-col change. The guard under test
    // concerns a wobble AFTER the terminal has settled, so first wait for the
    // frame stream to go quiet: no new task:resize for a full debounce window
    // plus margin.
    await expect.poll(() => frames.length, { message: 'no initial resize was sent' })
        .toBeGreaterThan(0);
    await expect.poll(async () => {
        const before = frames.length;
        await new Promise((r) => setTimeout(r, 750));
        return frames.length === before;
    }, { timeout: 15_000, message: 'task:resize frames never settled after mount' }).toBe(true);
    const settled = frames.length;
    const colsBefore = frames[frames.length - 1].cols;

    // Sanity: the baseline really is the configured desktop viewport. If a
    // device preset ever overrides it again, the "wobble" below would be a
    // large resize and this test would fail for the wrong reason.
    expect(page.viewportSize()).toEqual(VIEWPORT);

    // --- Bug 1: a scrollbar-sized width wobble must NOT reach the backend. ---
    // ~10px is under one character cell pair, so cols moves by <= 2 and rows
    // is unchanged: precisely the oscillation case the guard exists for.
    const wobbleAt = Date.now() - t0;
    await page.setViewportSize({ width: VIEWPORT.width - 10, height: VIEWPORT.height });
    await page.setViewportSize(VIEWPORT);

    // The property under test is the ABSENCE of a frame, and absence can only
    // be observed by outlasting the window in which it could appear: the
    // client debounces resize by 150ms (TerminalView) and then fits. This is
    // the suite's one deliberate bounded wait; a web-first poll cannot express
    // "nothing happened", it would pass on its first tick.
    await page.waitForTimeout(1000);
    expect(
        frames.length,
        'a <=2 column width wobble must not send task:resize (scrollbar oscillation guard); ' +
            `wobbleAt=${wobbleAt}ms frames=${JSON.stringify(frames)}`,
    ).toBe(settled);

    // --- A genuinely large change must resize. ---
    await page.setViewportSize({ width: 1000, height: 900 });
    await expect.poll(() => frames.length, { timeout: 5000 }).toBeGreaterThan(settled);

    // Exactly one new frame: the big resize, and nothing left over from the
    // wobble. Its cols must be well outside the +-2 suppression band.
    expect(
        frames.length,
        `the large resize must send exactly one task:resize; frames=${JSON.stringify(frames)}`,
    ).toBe(settled + 1);
    const latest = frames[frames.length - 1];
    expect(latest.cols).toBeLessThan(colsBefore - 2);
    console.log(`[e2e] task:resize frames: ${JSON.stringify(frames)}`);
});

test('terminal content survives a resize without corruption', async ({ page }) => {
    await openApp(page);
    const item = taskRow(page, PROMPT);
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
    const item = taskRow(page, PROMPT);
    await selectTask(page, item);
    await expectTerminalToContain(page, PROMPT);

    // Resize and immediately push output through: the client buffers PTY output
    // for 250ms, so this exercises the buffer-then-flush path rather than the
    // straight-through write. Nothing may be dropped.
    await page.setViewportSize({ width: 1100, height: 820 });
    await sendFollowUp(page, 'EMIT_OUTPUT during resize window');

    await expectTerminalToContain(page, 'FAKE_OUTPUT_MARKER_9000');
});
