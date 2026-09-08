/**
 * Flow 6 — settings round-trip: change a setting, reload, assert it stuck.
 *
 * Two settings with genuinely different persistence backends are covered,
 * because they fail independently:
 *   - Skip Permissions  → PUT /api/config on the backend
 *   - Theme             → localStorage, re-applied by the index.html bootstrap
 */
import { test, expect } from '../fixtures/test.js';
import { openApp } from '../harness/ui.js';

test.describe.configure({ mode: 'serial' });

async function openSettings(page: import('@playwright/test').Page) {
    await page.getByTestId('open-settings').click();
    await expect(page.getByTestId('settings-menu')).toBeVisible();
}

async function closeSettings(page: import('@playwright/test').Page) {
    await page.locator('.settings-menu-close').click();
    await expect(page.getByTestId('settings-menu')).toHaveCount(0);
}

/** The clickable surface of the Skip Permissions toggle. */
function skipPermissionsSlider(page: import('@playwright/test').Page) {
    return page.locator('.permission-item')
        .filter({ hasText: 'Skip Permissions' })
        .locator('.toggle-slider');
}

/** Panels start collapsed; their contents are not mounted until expanded. */
async function expandPanel(page: import('@playwright/test').Page, id: string) {
    const header = page.getByTestId(`settings-panel-${id}`);
    await expect(header).toBeVisible();
    if ((await header.getAttribute('data-expanded')) !== 'true') {
        await header.click();
    }
    await expect(header).toHaveAttribute('data-expanded', 'true');
}

test('a backend-persisted setting survives a reload', async ({ page }) => {
    await openApp(page);
    await openSettings(page);
    await expandPanel(page, 'permissions');

    const toggle = page.getByTestId('skip-permissions-toggle');
    await expect(toggle).not.toBeChecked();

    // The real <input> is visually hidden behind a custom .toggle-slider, so
    // it is not clickable — drive the slider the way a user does.
    await skipPermissionsSlider(page).click();

    // The component only flips its own state after the backend accepts the PUT,
    // so a checked box here already means the write round-tripped.
    await expect(toggle).toBeChecked();
    await expect(page.locator('.permission-warning')).toBeVisible();

    await closeSettings(page);
    await page.reload();
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-ws-connected', 'true');

    await openSettings(page);
    await expandPanel(page, 'permissions');
    await expect(page.getByTestId('skip-permissions-toggle')).toBeChecked();
});

test('the setting can be turned back off and that also persists', async ({ page }) => {
    await openApp(page);
    await openSettings(page);
    await expandPanel(page, 'permissions');

    const toggle = page.getByTestId('skip-permissions-toggle');
    await expect(toggle).toBeChecked();
    await skipPermissionsSlider(page).click();
    await expect(toggle).not.toBeChecked();

    await closeSettings(page);
    await page.reload();
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-ws-connected', 'true');

    await openSettings(page);
    await expandPanel(page, 'permissions');
    await expect(page.getByTestId('skip-permissions-toggle')).not.toBeChecked();
});

test('theme choice persists across a reload', async ({ page }) => {
    await openApp(page);
    await openSettings(page);
    await expandPanel(page, 'appearance');

    await page.locator('.theme-option').filter({ hasText: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await closeSettings(page);
    await page.reload();

    // Applied by the inline bootstrap in index.html before React mounts, so it
    // must be right immediately — no flash of the wrong theme.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
