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
    BACKEND_PORT, BACKEND_URL, DEFAULT_STATE_FILES, FRONTEND_PORT, STATE_DIR, authHeaders,
    legacyBaseline, legacyState,
} from '../harness/env.js';
import { makeGitRepo } from '../harness/repo.js';
import { addWorkspace, openApp, workspaceSection } from '../harness/ui.js';

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

    // The backend READ them: the seeded AI Core credentials are what stop the
    // onboarding modal covering the app, so a normal shell means our config.json
    // was the one loaded — not an empty default and not the developer's.
    await openApp(page);
    await expect(page.getByTestId('settings-menu')).toHaveCount(0);

    // And the backend WRITES there. Drive a real mutation through the UI and
    // assert the bytes on disk, in the sandbox, actually changed. Opening a
    // modal is not a write; this is.
    const repo = makeGitRepo('isolation');
    await addWorkspace(page, repo.path);

    // Read the ACTIVE workspace list, not the raw file: a removed workspace is
    // retained under `recentWorkspaces`, so a substring match on the whole file
    // would still find the path after removal and the delete half of this
    // assertion would pass vacuously.
    const configPath = `${STATE_DIR}/workspace-config.json`;
    const activeWorkspaceIds = (): string[] =>
        (JSON.parse(readFileSync(configPath, 'utf8')).data?.workspaces ?? [])
            .map((w: { id: string }) => w.id);

    await expect
        .poll(activeWorkspaceIds, {
            message: 'the workspace added through the UI never reached the sandbox state dir',
        })
        .toContain(repo.path);

    // Leave the state as we found it — 02-workspace-lifecycle asserts it starts
    // from zero workspaces, and this spec runs first.
    page.once('dialog', (dialog) => void dialog.accept());
    await workspaceSection(page, repo.path).getByTestId('workspace-menu').click();
    await page.getByTestId('workspace-remove').click();
    await expect(workspaceSection(page, repo.path)).toHaveCount(0);
    await expect
        .poll(activeWorkspaceIds, {
            message: 'the removal never reached the sandbox state dir',
        })
        .not.toContain(repo.path);

    // …and the default (non-isolated) locations were neither created nor
    // modified by this run. A backend that ignored our env — or a store wired
    // up without a data directory — would have written these instead, inside
    // the developer's checkout. Compared against the pre-boot snapshot, not
    // against "absent": on a fresh checkout (CI) the baseline is all-null, so
    // this is exactly "never created"; on a checkout where something else left
    // a file behind, it still catches the sandbox touching it.
    const before = legacyBaseline();
    const after = legacyState();
    for (const file of DEFAULT_STATE_FILES) {
        const verb = before[file] === null ? 'create' : 'modify';
        expect(after[file], `the sandboxed backend must not ${verb} ${file}`).toBe(before[file]);
    }
});

test('the running backend is reachable on the sandboxed port only', async ({ request }) => {
    const res = await request.get(`${BACKEND_URL}/api/tasks`, { headers: authHeaders() });
    expect(res.ok(), `sandboxed backend must answer on ${BACKEND_URL}`).toBe(true);
});

test('the sandboxed backend enforces auth: no token, or the wrong token, is refused', async ({ request }) => {
    // Auth is unconditional on /api (#261). If this ever answers 200 the suite
    // is either talking to a backend that predates it or to one whose gate is
    // broken — and every "the browser authenticated" signal elsewhere in the
    // suite would be vacuous.
    const anonymous = await request.get(`${BACKEND_URL}/api/tasks`);
    expect(anonymous.status(), 'unauthenticated /api request must be refused').toBe(401);

    const wrong = await request.get(`${BACKEND_URL}/api/tasks`, {
        headers: { 'x-claudia-token': '0'.repeat(64) },
    });
    expect(wrong.status(), 'a well-formed but wrong token must be refused').toBe(401);

    // The token the harness presents is the one stored in the SANDBOX data dir,
    // so a 200 here also proves the backend resolved its token from
    // CLAUDIA_DATA_DIR rather than the legacy backend/ location.
    const authed = await request.get(`${BACKEND_URL}/api/tasks`, { headers: authHeaders() });
    expect(authed.status(), 'the sandbox token must be accepted').toBe(200);
    expect(existsSync(`${STATE_DIR}/auth-token`), 'auth-token must live in the sandbox state dir').toBe(true);
});
