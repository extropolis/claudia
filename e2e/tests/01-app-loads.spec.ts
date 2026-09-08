/**
 * Flow 1 — the app boots, reaches the backend over WebSocket, and does so
 * without throwing in the browser.
 *
 * This is the canary: if the bundle, the WS handshake, or the API base URL
 * regress, every other spec's failure would be noise. This one names the cause.
 */
import { test, expect } from '../fixtures/test.js';
import { BACKEND_URL } from '../harness/env.js';
import { openApp, waitForConnected } from '../harness/ui.js';

test('shell renders and the WebSocket reaches connected', async ({ page, pageErrors }) => {
    await page.goto('/');

    await expect(page.locator('.logo h1')).toHaveText('Claudia');
    await waitForConnected(page);

    // Nothing selected yet — the main panel shows its empty state.
    await expect(page.getByTestId('no-task-selected')).toBeVisible();
    expect(pageErrors, 'uncaught exceptions during boot').toEqual([]);
});

test('boot produces no console errors', async ({ page, consoleErrors, pageErrors }) => {
    await openApp(page);
    // Give any late-firing subscription a chance to fail loudly.
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-ws-connected', 'true');

    expect(consoleErrors, 'console errors during boot').toEqual([]);
    expect(pageErrors, 'uncaught exceptions during boot').toEqual([]);
});

test('the browser talks to the sandboxed backend, never the dev server', async ({ page }) => {
    const seen = new Set<string>();
    page.on('request', (req) => {
        const url = new URL(req.url());
        if (url.port) seen.add(`${url.protocol}//${url.hostname}:${url.port}`);
    });

    await openApp(page);
    // Let the initial data fetches settle.
    await expect(page.getByTestId('add-workspace')).toBeVisible();

    const ports = [...seen];
    expect(ports, 'browser must reach the sandboxed backend').toContain(BACKEND_URL);
    expect(
        ports.filter((p) => p.endsWith(':4001') || p.endsWith(':5173')),
        'browser must NEVER contact the developer dev servers on 4001/5173',
    ).toEqual([]);
});
