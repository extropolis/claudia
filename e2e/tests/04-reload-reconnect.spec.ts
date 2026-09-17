/**
 * Flow 4 — reload / reconnect resilience. The highest-value regression target:
 * session recovery and terminal reattach have broken repeatedly (see PR #155).
 *
 * A reload throws away the entire WebSocket, the xterm instance and all React
 * state. Everything the user sees afterwards has to be rebuilt from the
 * backend's persisted history — which is exactly the path that keeps breaking
 * and that no unit test exercises.
 */
import { test, expect } from '../fixtures/test.js';
import { makeGitRepo, type TempRepo } from '../harness/repo.js';
import {
    addWorkspace, createTask, expectTerminalToContain, fakeStdin, openApp,
    selectTask, sendFollowUp, taskRow,
} from '../harness/ui.js';

test.describe.configure({ mode: 'serial' });

let repo: TempRepo;
const PROMPT = 'E2E_RECONNECT_PROMPT_BRAVO';
const BEFORE_MARKER = 'MARKER_BEFORE_RELOAD_7788';

test.beforeAll(() => {
    repo = makeGitRepo('reconnect');
});

test('a running task survives a full page reload with its history intact', async ({ page }) => {
    await openApp(page);
    await addWorkspace(page, repo.path);

    const item = await createTask(page, repo.path, PROMPT);
    await selectTask(page, item);
    await expectTerminalToContain(page, PROMPT);

    // Put a distinctive line into the scrollback so we can prove the history —
    // not just an empty reattached terminal — comes back.
    await sendFollowUp(page, BEFORE_MARKER);
    await expectTerminalToContain(page, BEFORE_MARKER);

    await page.reload();
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-ws-connected', 'true');

    // 1. The task is still listed.
    const restored = taskRow(page, PROMPT);
    await expect(restored).toHaveCount(1);

    // 2. Selecting it reattaches a terminal…
    await selectTask(page, restored);

    // 3. …that replays the pre-reload history, both the prompt and the marker.
    await expectTerminalToContain(page, PROMPT);
    await expectTerminalToContain(page, BEFORE_MARKER);
});

test('the reattached terminal still delivers input to the live process', async ({ page }) => {
    await openApp(page);
    const item = taskRow(page, PROMPT);
    await expect(item).toHaveCount(1);
    await selectTask(page, item);
    await expectTerminalToContain(page, BEFORE_MARKER);

    // A terminal that renders history but no longer writes to the PTY looks
    // perfectly healthy and is completely broken — assert the write path too.
    await sendFollowUp(page, 'EMIT_OUTPUT after reload');

    await expect
        .poll(() => fakeStdin(), { message: 'post-reload input never reached the CLI' })
        .toContain('EMIT_OUTPUT after reload');
    await expectTerminalToContain(page, 'FAKE_OUTPUT_MARKER_9000');
});

test('history survives repeated reloads without duplicating', async ({ page }) => {
    await openApp(page);
    await selectTask(page, taskRow(page, PROMPT));
    await expectTerminalToContain(page, BEFORE_MARKER);

    await page.reload();
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-ws-connected', 'true');
    await selectTask(page, taskRow(page, PROMPT));
    await expectTerminalToContain(page, BEFORE_MARKER);

    // The prompt was sent once. Replaying history must not stack copies of it —
    // double-replay on reconnect is a real and easy regression.
    const occurrences = await page.evaluate((marker) => {
        const rows = document.querySelector('.xterm-rows');
        if (!rows) return -1;
        const text = Array.from(rows.children).map((r) => (r as HTMLElement).innerText).join('\n');
        return text.split(marker).length - 1;
    }, BEFORE_MARKER);

    // The fake CLI echoes each line once, so the marker appears once per send
    // (it was sent once). Allow the echo + any prompt redraw, but not runaway
    // duplication from repeated history replay.
    expect(occurrences).toBeGreaterThan(0);
    expect(occurrences, 'history appears to be replayed more than once').toBeLessThanOrEqual(3);
});
