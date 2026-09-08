/**
 * Playwright browser E2E configuration.
 *
 * Boots a FULLY SANDBOXED Claudia stack — real built backend, real built
 * frontend, real browser — on dedicated ports with an isolated state
 * directory and a fake Claude CLI on PATH. The developer's live dev servers
 * on 4001 / 5173 are never contacted, bound, or killed.
 */
import { defineConfig, devices } from '@playwright/test';
import {
    BACKEND_PORT, FRONTEND_PORT, FRONTEND_URL, REPO_ROOT, VIEWPORT,
    assertPortFree, backendEnv, prepareHarness,
} from './e2e/harness/env.js';
import { buildStack } from './e2e/harness/build.js';

// Config load happens before Playwright starts anything, so this is the one
// place guaranteed to run first: verify the ports, wipe state, build, go.
//
// Playwright re-imports this config inside every worker process. Those must NOT
// repeat the setup — re-running prepareHarness() mid-suite would wipe the state
// dir out from under the live backend, and assertPortFree would trip over our
// own servers. TEST_WORKER_INDEX is only set in worker processes.
if (process.env.TEST_WORKER_INDEX === undefined) {
    assertPortFree(BACKEND_PORT, 'e2e backend');
    assertPortFree(FRONTEND_PORT, 'e2e frontend');
    prepareHarness();
    buildStack();
}

export default defineConfig({
    testDir: './e2e/tests',
    // Serial: the suite drives one shared backend with one shared state dir.
    // Parallel workers would fight over workspaces and the task list.
    fullyParallel: false,
    workers: 1,
    forbidOnly: !!process.env.CI,
    // Deliberately ZERO retries, in CI too. A retry here would hide exactly the
    // kind of reconnect/resize race this suite exists to catch: a spec that only
    // passes on the second attempt is reporting a real bug, not noise.
    retries: 0,
    timeout: 60_000,
    expect: { timeout: 15_000 },
    globalTeardown: './e2e/harness/global-teardown.ts',
    reporter: [['list'], ['html', { open: 'never' }]],
    use: {
        baseURL: FRONTEND_URL,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
        actionTimeout: 15_000,
    },
    projects: [
        {
            name: 'chromium',
            // The viewport MUST be set here, after the device spread: a
            // project's `use` is merged over the top-level one, and
            // devices['Desktop Chrome'] carries its own 1280x720 viewport that
            // would silently win. (It did — the resize spec's "10px wobble"
            // was really a 160px jump from 1280 to 1440.)
            //
            // Claudia renders a mobile layout at <= 768px with no main panel,
            // terminal or file explorer; every spec needs the desktop layout,
            // and the resize spec assumes exactly this size as its baseline.
            use: { ...devices['Desktop Chrome'], viewport: VIEWPORT },
        },
    ],
    webServer: [
        {
            command: 'node backend/dist/index.js',
            cwd: REPO_ROOT,
            url: `http://127.0.0.1:${BACKEND_PORT}/api/tasks`,
            reuseExistingServer: false,
            timeout: 60_000,
            stdout: 'pipe',
            stderr: 'pipe',
            env: backendEnv(),
        },
        {
            command: `npx vite preview --port ${FRONTEND_PORT} --strictPort --host 127.0.0.1`,
            cwd: `${REPO_ROOT}/frontend`,
            url: FRONTEND_URL,
            reuseExistingServer: false,
            timeout: 60_000,
            stdout: 'pipe',
            stderr: 'pipe',
        },
    ],
});
