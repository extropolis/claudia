/**
 * Flow 8 — the guard rail again, from the other end of the run.
 *
 * 00-isolation asserts the sandbox is intact, but it runs FIRST: at that point
 * the backend has loaded its stores and served one workspace, and that is all.
 * Most state files are written lazily, by activity — `checkpoints.json` on the
 * first task, `todos.json` on the first TODO, `learnings.json` on the first
 * learning. A store wired up without a data directory therefore leaks into the
 * developer's checkout only AFTER 00-isolation has already reported green.
 *
 * That is not a hypothetical ordering argument: `checkpoints.json` and
 * `todos.json` were both being written to `backend/` on every single run while
 * 00-isolation passed, because a checkpoint is created when a task is created
 * and no task exists yet when that spec runs.
 *
 * So the same assertion is repeated here, in the last file the runner reaches.
 * The spec drives a task of its own first rather than relying on the specs
 * before it, so it is meaningful when run alone as well as in suite order.
 */
import { existsSync } from 'fs';
import { test, expect } from '../fixtures/test.js';
import { DEFAULT_STATE_FILES, STATE_DIR } from '../harness/env.js';
import { makeGitRepo, type TempRepo } from '../harness/repo.js';
import { addWorkspace, createTask, openApp } from '../harness/ui.js';

test.describe.configure({ mode: 'serial' });

let repo: TempRepo;
const PROMPT = 'E2E_LEAKCHECK_PROMPT_ECHO';

test.beforeAll(() => {
    repo = makeGitRepo('leakcheck');
});

test('the sandbox state dir is the one that actually gets written', async ({ page }) => {
    // Creating a task is what makes the backend take a checkpoint — the write
    // that was escaping. Drive it here so this spec does not depend on the
    // specs before it having run.
    await openApp(page);
    await addWorkspace(page, repo.path);
    await createTask(page, repo.path, PROMPT);

    // The mirror of the leak assertion below: an empty leak list only means
    // something if the writes happened at all.
    for (const file of ['tasks.json', 'workspace-config.json', 'config.json', 'checkpoints.json']) {
        await expect
            .poll(() => existsSync(`${STATE_DIR}/${file}`), {
                message: `${file} must be written inside the sandbox state dir`,
            })
            .toBe(true);
    }
});

test('no state escaped the sandbox over the whole run', () => {
    const leaked = DEFAULT_STATE_FILES.filter((f) => existsSync(f));
    expect(
        leaked,
        'a store wrote outside CLAUDIA_DATA_DIR — these files live in the ' +
        "developer's checkout and overwrite their running instance. Check that " +
        "every `join(__dirname, '..')` fallback in backend/src is given `dataDir`.",
    ).toEqual([]);
});
