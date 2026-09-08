/**
 * Page-object helpers for the Claudia UI.
 *
 * Everything here is web-first: locators + expect(), never waitForTimeout.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { FAKE_DIR } from './env.js';

/** Wait for the app shell to mount and the WebSocket to report connected. */
export async function waitForConnected(page: Page): Promise<void> {
    const root = page.getByTestId('app-root');
    await expect(root).toBeVisible();
    await expect(root).toHaveAttribute('data-ws-connected', 'true');
    await expect(page.getByTestId('reconnect-banner')).toHaveCount(0);
}

/** Open the app and wait until it is live. */
export async function openApp(page: Page): Promise<void> {
    await page.goto('/');
    await waitForConnected(page);
}

/** The workspace section for a given absolute workspace path (== workspace id). */
export function workspaceSection(page: Page, path: string): Locator {
    return page.locator(`[data-testid="workspace-section"][data-workspace-id="${cssEscape(path)}"]`);
}

function cssEscape(value: string): string {
    return value.replace(/["\\]/g, '\\$&');
}

/**
 * Add a workspace by absolute path.
 *
 * Deliberately drives the text-input path (PathInputModal), not the "Browse"
 * button — that one asks the BACKEND to open a native OS folder dialog, which
 * a browser test cannot drive and which would hang the server-side handler.
 */
export async function addWorkspace(page: Page, path: string): Promise<void> {
    await page.getByTestId('add-workspace').click();
    await page.getByTestId('wm-add-workspace').click();

    const input = page.getByTestId('path-input');
    await expect(input).toBeVisible();
    await input.fill(path);
    await page.getByTestId('path-submit').click();

    // Only the inner path modal auto-closes on success; the manager itself
    // stays open until the user dismisses it.
    await expect(input).toHaveCount(0);
    await page.getByTestId('wm-done').click();
    await expect(page.locator('.workspace-manager-overlay')).toHaveCount(0);

    await expect(workspaceSection(page, path)).toBeVisible();
}

/** Expand a workspace section if it is collapsed (the task form lives inside). */
export async function expandWorkspace(page: Page, path: string): Promise<void> {
    const section = workspaceSection(page, path);
    if ((await section.getAttribute('data-expanded')) !== 'true') {
        await section.getByTestId('workspace-header').click();
    }
    await expect(section).toHaveAttribute('data-expanded', 'true');
}

/** Type a prompt into a workspace's inline task form and submit it. */
export async function createTask(page: Page, path: string, prompt: string): Promise<Locator> {
    await expandWorkspace(page, path);
    const section = workspaceSection(page, path);
    const input = section.getByTestId('new-task-input');
    await expect(input).toBeVisible();
    await input.fill(prompt);
    await section.getByTestId('new-task-submit').click();

    const item = page.locator('[data-testid="task-item"]').filter({ hasText: prompt });
    await expect(item).toHaveCount(1);
    return item;
}

/**
 * Click a per-task action button (stop / delete / rename / …).
 *
 * These are `display: none` until `.task-item:hover`, so the row must be
 * hovered first — Playwright's actionability check runs before its own hover
 * and would otherwise wait forever on a never-visible element.
 */
export async function clickTaskAction(item: Locator, testId: string): Promise<void> {
    await item.hover();
    const button = item.getByTestId(testId);
    await expect(button).toBeVisible();
    await button.click();
}

/** Select a task so its terminal renders in the main panel. */
export async function selectTask(page: Page, item: Locator): Promise<void> {
    await item.click();
    await expect(item).toHaveAttribute('data-task-selected', 'true');
    await expect(page.getByTestId('terminal')).toBeVisible();
}

/** Send a follow-up message through the task input bar. */
export async function sendFollowUp(page: Page, message: string): Promise<void> {
    const input = page.getByTestId('task-input');
    await expect(input).toBeVisible();
    await input.fill(message);
    await page.getByTestId('task-input-send').click();
    await expect(input).toHaveValue('');
}

/**
 * All text currently rendered by xterm, flattened.
 *
 * xterm's DOM renderer paints rows as spans in `.xterm-rows`; `innerText`
 * collapses each row, so we join rows with newlines and strip the soft-wrap
 * artefacts before matching.
 */
export async function terminalText(page: Page): Promise<string> {
    return page.evaluate(() => {
        const rows = document.querySelector('.xterm-rows');
        if (!rows) return '';
        return Array.from(rows.children).map((r) => (r as HTMLElement).innerText).join('\n');
    });
}

/** Web-first assertion over rendered terminal content. */
export async function expectTerminalToContain(page: Page, needle: string): Promise<void> {
    await expect
        .poll(() => terminalText(page).then((t) => t.replace(/\s+/g, ' ')), {
            message: `terminal never rendered ${JSON.stringify(needle)}`,
            timeout: 30_000,
        })
        .toContain(needle.replace(/\s+/g, ' '));
}

/** Everything the fake CLI has received on stdin so far. */
export function fakeStdin(): string {
    const p = join(FAKE_DIR, 'input.log');
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

/** argv the fake CLI was spawned with (one arg per line). */
export function fakeArgv(): string {
    const p = join(FAKE_DIR, 'args.log');
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
}
