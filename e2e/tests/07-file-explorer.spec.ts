/**
 * Flow 7 — file explorer: browse the workspace tree, open a file, read it.
 *
 * The explorer is bound to the SELECTED TASK's workspace (App.tsx derives
 * `selectedWorkspace` from `selectedTask`), so a task must exist and be
 * selected before it renders at all.
 */
import { test, expect } from '../fixtures/test.js';
import { makeGitRepo, type TempRepo } from '../harness/repo.js';
import { addWorkspace, createTask, openApp, selectTask } from '../harness/ui.js';

test.describe.configure({ mode: 'serial' });

let repo: TempRepo;
const PROMPT = 'E2E_EXPLORER_PROMPT_DELTA';

test.beforeAll(() => {
    repo = makeGitRepo('explorer');
});

async function openExplorer(page: import('@playwright/test').Page) {
    await openApp(page);
    const existing = page.locator('[data-testid="task-item"]').filter({ hasText: PROMPT });
    const item = (await existing.count()) ? existing : await createTask(page, repo.path, PROMPT);
    await selectTask(page, item);

    // Collapsed by default and not persisted, so every visit starts closed.
    const toggle = page.getByTestId('file-explorer-toggle');
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.locator('.file-explorer.expanded')).toBeVisible();
}

test('lists the workspace tree', async ({ page }) => {
    await openApp(page);
    await addWorkspace(page, repo.path);
    await openExplorer(page);

    // The committed fixture files show up at the root.
    await expect(page.locator('[data-testid="file-node"][data-file-path="README.md"]')).toBeVisible();
    await expect(page.locator('[data-testid="dir-node"][data-file-path="src"]')).toBeVisible();
});

test('expands a directory to reveal its children', async ({ page }) => {
    await openExplorer(page);

    const dir = page.locator('[data-testid="dir-node"][data-file-path="src"]');
    await dir.click();

    // Children are fetched lazily on expand.
    await expect(page.locator('[data-testid="file-node"][data-file-path="src/hello.txt"]')).toBeVisible();
});

test('opens a file and renders its content', async ({ page }) => {
    await openExplorer(page);

    // Opening is a hand-rolled 300ms double-click detector, not onDoubleClick —
    // a single click only selects.
    await page.locator('[data-testid="file-node"][data-file-path="README.md"]').dblclick();

    const modal = page.getByTestId('file-content-modal');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('file-content-path')).toHaveText('README.md');
    // Markdown renders through .file-content-markdown-rendered rather than the
    // raw <code> path, so assert on the body which covers both.
    const body = modal.locator('.file-content-modal-body');
    await expect(body).toContainText(repo.name);
    await expect(body).toContainText('E2E fixture repo.');
});

test('opens a nested file with the content written by the fixture', async ({ page }) => {
    await openExplorer(page);

    await page.locator('[data-testid="dir-node"][data-file-path="src"]').click();
    const nested = page.locator('[data-testid="file-node"][data-file-path="src/hello.txt"]');
    await expect(nested).toBeVisible();
    await nested.dblclick();

    const modal = page.getByTestId('file-content-modal');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('file-content-path')).toHaveText('src/hello.txt');
    await expect(modal.locator('.file-content-code')).toContainText('CLAUDIA_E2E_FILE_CONTENT_MARKER');
    await expect(modal.locator('.file-content-code')).toContainText('second line');

    await modal.locator('.file-content-close-btn').click();
    await expect(modal).toHaveCount(0);
});
