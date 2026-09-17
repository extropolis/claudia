/**
 * Flow 2 — workspace lifecycle: add → rename → survive a reload → remove.
 *
 * Serial by design: each step builds on the previous one's server state, which
 * is exactly the property under test (does it actually persist?).
 */
import { test, expect } from '../fixtures/test.js';
import { makeGitRepo, type TempRepo } from '../harness/repo.js';
import { addWorkspace, openApp, workspaceSection } from '../harness/ui.js';

test.describe.configure({ mode: 'serial' });

let repo: TempRepo;
const RENAMED = 'Renamed By E2E';

test.beforeAll(() => {
    repo = makeGitRepo('ws-lifecycle');
});

test('adds a workspace from an absolute path', async ({ page, pageErrors }) => {
    await openApp(page);

    // Precondition: this run starts from a clean state dir.
    await expect(page.getByTestId('workspace-section')).toHaveCount(0);

    await addWorkspace(page, repo.path);

    const section = workspaceSection(page, repo.path);
    await expect(section.getByTestId('workspace-name')).toHaveText(repo.name);
    expect(pageErrors).toEqual([]);
});

test('renames the workspace inline', async ({ page }) => {
    await openApp(page);
    const section = workspaceSection(page, repo.path);
    await expect(section).toBeVisible();

    await section.getByTestId('workspace-rename').click();
    const input = section.getByTestId('workspace-name-input');
    await expect(input).toBeVisible();
    await input.fill(RENAMED);
    await input.press('Enter');

    await expect(section.getByTestId('workspace-name')).toHaveText(RENAMED);
});

test('the workspace and its new name survive a full page reload', async ({ page }) => {
    await openApp(page);
    await expect(workspaceSection(page, repo.path).getByTestId('workspace-name')).toHaveText(RENAMED);

    await page.reload();
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-ws-connected', 'true');

    // Re-query after reload: the old handles point at a destroyed document.
    await expect(workspaceSection(page, repo.path).getByTestId('workspace-name')).toHaveText(RENAMED);
});

test('removes the workspace', async ({ page }) => {
    await openApp(page);
    const section = workspaceSection(page, repo.path);
    await expect(section).toBeVisible();

    // Removal goes through window.confirm, not an in-app modal.
    page.once('dialog', (dialog) => {
        expect(dialog.message()).toContain('Remove workspace');
        void dialog.accept();
    });

    await section.getByTestId('workspace-menu').click();
    await page.getByTestId('workspace-remove').click();

    await expect(section).toHaveCount(0);

    // And it stays gone — proves the delete reached the backend, not just React.
    await page.reload();
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-ws-connected', 'true');
    await expect(workspaceSection(page, repo.path)).toHaveCount(0);
});
