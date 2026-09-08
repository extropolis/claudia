/**
 * Flow 3 — the core flow: create a task, watch the CLI's output render in
 * xterm, send follow-up input, then archive it.
 *
 * Assertions deliberately go through the RENDERED TERMINAL, not the WebSocket
 * frames. The xterm write path — history replay, buffering, scroll handling —
 * is precisely what unit tests cannot reach.
 */
import { test, expect } from '../fixtures/test.js';
import { makeGitRepo, type TempRepo } from '../harness/repo.js';
import {
    addWorkspace, clickTaskAction, createTask, expectTerminalToContain, fakeArgv,
    fakeStdin, openApp, selectTask, sendFollowUp,
} from '../harness/ui.js';

test.describe.configure({ mode: 'serial' });

let repo: TempRepo;
const PROMPT = 'E2E_TASK_PROMPT_ALPHA';

test.beforeAll(() => {
    repo = makeGitRepo('task-lifecycle');
});

test('creates a task and spawns the CLI with the prompt', async ({ page }) => {
    await openApp(page);
    await addWorkspace(page, repo.path);

    const item = await createTask(page, repo.path, PROMPT);
    await expect(item.getByTestId('task-prompt')).toHaveText(PROMPT);

    // The prompt reached the real process boundary: the fake CLI logged it on stdin.
    await expect
        .poll(() => fakeStdin(), { message: 'prompt never reached the CLI stdin' })
        .toContain(PROMPT);
    expect(fakeArgv(), 'CLI should be spawned').not.toBe('');
});

test('renders the CLI output in the terminal', async ({ page }) => {
    await openApp(page);
    const item = page.locator('[data-testid="task-item"]').filter({ hasText: PROMPT });
    await selectTask(page, item);

    // The terminal header names the task…
    await expect(page.getByTestId('terminal-title')).toHaveText(PROMPT);
    // …and the fake CLI's echo of the prompt is actually painted into xterm.
    await expectTerminalToContain(page, PROMPT);
});

test('delivers follow-up input and renders the new output', async ({ page }) => {
    await openApp(page);
    const item = page.locator('[data-testid="task-item"]').filter({ hasText: PROMPT });
    await selectTask(page, item);
    await expectTerminalToContain(page, PROMPT);

    // EMIT_OUTPUT makes the fake CLI print a distinctive marker, so we can tell
    // "the terminal updated" from "the terminal still shows the old frame".
    await sendFollowUp(page, 'EMIT_OUTPUT please');

    await expect.poll(() => fakeStdin()).toContain('EMIT_OUTPUT');
    await expectTerminalToContain(page, 'FAKE_OUTPUT_MARKER_9000');
});

test('archives the task and it leaves the active list', async ({ page }) => {
    await openApp(page);
    const item = page.locator('[data-testid="task-item"]').filter({ hasText: PROMPT });
    await expect(item).toHaveCount(1);

    await clickTaskAction(item, 'task-delete');

    await expect(item).toHaveCount(0);
    await expect(page.getByTestId('no-task-selected')).toBeVisible();

    // Survives a reload — it was archived server-side, not just hidden in React.
    await page.reload();
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-ws-connected', 'true');
    await expect(page.locator('[data-testid="task-item"]').filter({ hasText: PROMPT })).toHaveCount(0);
});
