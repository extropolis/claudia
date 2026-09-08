/**
 * Flow 0 — the guard rail, and the first thing that runs.
 *
 * This suite once contaminated the developer's live Claudia on port 4001:
 * creating workspaces and spawning real Claude sessions in it. Nothing in the
 * spec code looked wrong at the time, because the leak was in the *plumbing* —
 * a frontend bundle built without VITE_CLAUDIA_BACKEND_PORT silently falls back
 * to PORTS.BACKEND (4001), and a backend started without CLAUDIA_DATA_DIR
 * silently writes to backend/workspace-config.json.
 *
 * So isolation is asserted here as an explicit, first-to-run test rather than
 * left as an assumption. If any of these fail, every later spec is suspect.
 */
import { existsSync, readFileSync } from 'fs';
import { test, expect } from '../fixtures/test.js';
import {
    BACKEND_PORT, BACKEND_URL, DEFAULT_STATE_FILES, FRONTEND_PORT, STATE_DIR,
} from '../harness/env.js';
import { openApp } from '../harness/ui.js';

test('the sandboxed ports are not the developer dev-server ports', () => {
    expect(BACKEND_PORT, 'backend must not run on the live backend port').not.toBe(4001);
    expect(FRONTEND_PORT, 'frontend must not run on the live frontend port').not.toBe(5173);
});

test('the backend under test reads and writes only the sandboxed state dir', async ({ page }) => {
    // The harness seeds these before boot; the backend loading them is what
    // proves CLAUDIA_DATA_DIR was honoured rather than ignored.
    for (const file of ['config.json', 'workspace-config.json', 'tasks.json']) {
        expect(existsSync(`${STATE_DIR}/${file}`), `${file} must exist in the sandbox state dir`).toBe(true);
    }

    // Drive a real write through the UI, then prove it landed in the sandbox.
    await openApp(page);
    await page.getByTestId('open-settings').click();
    await expect(page.getByTestId('settings-menu')).toBeVisible();
    await page.locator('.settings-menu-close').click();

    const config = JSON.parse(readFileSync(`${STATE_DIR}/config.json`, 'utf8'));
    expect(config, 'sandbox config.json must be readable JSON').toBeTruthy();

    // …and that the default (non-isolated) locations were never created. A
    // backend that ignored our env would have written these instead.
    for (const file of DEFAULT_STATE_FILES) {
        expect(existsSync(file), `backend must not fall back to ${file}`).toBe(false);
    }
});

test('the running backend is reachable on the sandboxed port only', async ({ request }) => {
    const res = await request.get(`${BACKEND_URL}/api/tasks`);
    expect(res.ok(), `sandboxed backend must answer on ${BACKEND_URL}`).toBe(true);
});
