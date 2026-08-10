/**
 * Integration tests for the git + worktree HTTP routes in server.ts.
 *
 * These drive the REAL Express app (via the shared harness) against REAL temp
 * git repos with real commits, branches and worktrees — no mocking of git, no
 * network, no dependence on the developer's ~/.gitconfig or ~/.claude.
 *
 * Routes covered:
 *   GET    /api/workspaces/git-status
 *   GET    /api/workspaces/git-diff
 *   GET    /api/workspaces/git-log
 *   GET    /api/worktrees
 *   POST   /api/worktrees
 *   DELETE /api/worktrees
 *   POST   /api/worktrees/prune
 *   GET    /api/worktrees/branches
 *   PATCH  /api/worktrees/auto
 *
 * NOTE ON TEMP DIRS: everything lives under homedir(), never os.tmpdir(). On
 * macOS os.tmpdir() resolves under /var, which validateWorkspacePath blocklists
 * as a system path — workspace ops against a /var repo get rejected before ever
 * reaching the code under test, so tests would pass for the wrong reason.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync, realpathSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { startHarness, makeGitRepo, git, waitFor, type Harness } from './helpers/server-harness.js';

/** Repos live here, NOT under the harness base — harness.stop() nukes its own base. */
let root: string;
let h: Harness;

/** Repo with 3 commits + a dirty working tree (modified / staged / untracked). */
let statusRepo: string;
/** Clean repo used for the worktree create → list → delete lifecycle. */
let wtRepo: string;
/** Clean repo used for the prune flow (worktree dir deleted behind git's back). */
let pruneRepo: string;
/** A plain directory that is NOT a git repo. */
let plainDir: string;
/** A directory seeded into workspace-config.json BEFORE createApp reads it. */
let registeredDir: string;
/** A real path on disk that is deliberately NOT a registered workspace. */
let unregisteredDir: string;
/** A path that does not exist at all. */
let missingDir: string;

const qs = (o: Record<string, string>) =>
    Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

/** `git worktree list` output from the repo itself — the ground truth for worktree assertions. */
const worktreeListRaw = (repo: string) => git(repo, 'worktree', 'list', '--porcelain');

beforeAll(async () => {
    // realpath so paths we assert on match what git reports back (symlinked $HOME).
    root = realpathSync(mkdtempSync(join(homedir(), '.claudia-git-routes-test-')));

    // ── status/diff/log fixture: 3 commits, then a dirty tree ──────────────
    statusRepo = makeGitRepo(join(root, 'status-repo'));           // commit 1: "init" (README.md)
    writeFileSync(join(statusRepo, 'tracked.txt'), 'line one\n');
    git(statusRepo, 'add', 'tracked.txt');
    git(statusRepo, 'commit', '-m', 'add tracked file');           // commit 2
    writeFileSync(join(statusRepo, 'README.md'), '# test repo\nsecond\n');
    git(statusRepo, 'add', 'README.md');
    git(statusRepo, 'commit', '-m', 'update readme');              // commit 3
    // Dirty state: one unstaged modification, one staged addition, one untracked file.
    appendFileSync(join(statusRepo, 'tracked.txt'), 'line two\n'); //  M tracked.txt
    writeFileSync(join(statusRepo, 'staged.txt'), 'staged content\n');
    git(statusRepo, 'add', 'staged.txt');                          // A  staged.txt
    writeFileSync(join(statusRepo, 'untracked.txt'), 'nobody tracks me\n'); // ?? untracked.txt

    // ── worktree fixtures ──────────────────────────────────────────────────
    wtRepo = makeGitRepo(join(root, 'wt-repo'));
    git(wtRepo, 'branch', 'feature/extra');   // extra local branch for the branches route
    pruneRepo = makeGitRepo(join(root, 'prune-repo'));

    // ── non-git / unregistered / missing paths ─────────────────────────────
    plainDir = join(root, 'plain-dir');
    mkdirSync(plainDir, { recursive: true });
    unregisteredDir = join(root, 'unregistered');
    mkdirSync(unregisteredDir, { recursive: true });
    missingDir = join(root, 'does-not-exist-ever');

    // Seeded BEFORE createApp so workspaceStore knows about it (PATCH auto needs
    // a registered workspace). Kept separate from the git fixtures because boot
    // syncs .mcp.json into every registered workspace, which would dirty the tree.
    registeredDir = join(root, 'registered-ws');
    mkdirSync(registeredDir, { recursive: true });

    h = await startHarness({
        prefix: '.claudia-git-routes-base-',
        workspaces: [{ id: registeredDir, name: 'registered-ws' }],
    });
}, 60000);

afterAll(async () => {
    await h?.stop();
    try {
        // This suite creates real git worktrees, so it is the most exposed to
        // Windows holding handles open past shutdown — rmdir throws EBUSY and
        // fails teardown rather than any assertion.
        if (root) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
        // Ignore cleanup errors
    }
});

// ───────────────────────────────────────────────────────────────────────────
// GET /api/workspaces/git-status
// ───────────────────────────────────────────────────────────────────────────
describe('GET /api/workspaces/git-status', () => {
    it('parses modified, staged and untracked entries from a real dirty repo', async () => {
        const { status, body } = await h.req<{
            isGitRepo: boolean; branch: string; ahead: number; behind: number;
            changes: Array<{ path: string; status: string; staged: boolean }>;
        }>(`/api/workspaces/git-status?${qs({ workspace: statusRepo })}`);

        expect(status).toBe(200);
        expect(body.isGitRepo).toBe(true);
        expect(body.branch).toBe('main');

        const byPath = Object.fromEntries(body.changes.map(c => [c.path, c]));
        // Regression guard: trimming the porcelain output would shift the XY
        // columns and eat the first path character (" M tracked.txt" -> "racked.txt").
        expect(byPath['tracked.txt']).toEqual({ path: 'tracked.txt', status: 'modified', staged: false });
        expect(byPath['staged.txt']).toEqual({ path: 'staged.txt', status: 'added', staged: true });
        expect(byPath['untracked.txt']).toEqual({ path: 'untracked.txt', status: 'untracked', staged: false });
        expect(body.changes).toHaveLength(3);

        // No upstream configured and no network access -> both counters stay 0.
        expect(body.ahead).toBe(0);
        expect(body.behind).toBe(0);
    });

    it('reports isGitRepo:false for a directory that is not a git repo', async () => {
        const { status, body } = await h.req<{ isGitRepo: boolean; branch: null; changes: unknown[] }>(
            `/api/workspaces/git-status?${qs({ workspace: plainDir })}`
        );
        expect(status).toBe(200);
        expect(body).toEqual({ isGitRepo: false, branch: null, changes: [] });
    });

    it('400s (not 500s) when the workspace query param is missing', async () => {
        const { status, body } = await h.req<{ error: string }>('/api/workspaces/git-status');
        expect(status).toBe(400);
        expect(body.error).toMatch(/workspace query parameter is required/);
    });

    it('404s for a workspace path that does not exist', async () => {
        const { status, body } = await h.req<{ error: string }>(
            `/api/workspaces/git-status?${qs({ workspace: missingDir })}`
        );
        expect(status).toBe(404);
        expect(body.error).toBe('Workspace not found');
    });
});

// ───────────────────────────────────────────────────────────────────────────
// GET /api/workspaces/git-diff
// ───────────────────────────────────────────────────────────────────────────
describe('GET /api/workspaces/git-diff', () => {
    it('returns the unstaged diff containing the actually-changed line', async () => {
        const { status, body } = await h.req<{ path: string; diff: string; staged: boolean }>(
            `/api/workspaces/git-diff?${qs({ workspace: statusRepo, file: 'tracked.txt' })}`
        );
        expect(status).toBe(200);
        expect(body.path).toBe('tracked.txt');
        expect(body.staged).toBe(false);
        expect(body.diff).toContain('diff --git');
        expect(body.diff).toContain('+line two');
        // The unstaged diff must NOT leak the staged-only file.
        expect(body.diff).not.toContain('staged content');
    });

    it('returns the staged diff when staged=true', async () => {
        const { status, body } = await h.req<{ diff: string; staged: boolean }>(
            `/api/workspaces/git-diff?${qs({ workspace: statusRepo, file: 'staged.txt', staged: 'true' })}`
        );
        expect(status).toBe(200);
        expect(body.staged).toBe(true);
        expect(body.diff).toContain('new file mode');
        expect(body.diff).toContain('+staged content');
    });

    it('returns an empty diff for a file with no changes (no throw)', async () => {
        const { status, body } = await h.req<{ diff: string }>(
            `/api/workspaces/git-diff?${qs({ workspace: statusRepo, file: 'README.md' })}`
        );
        expect(status).toBe(200);
        expect(body.diff).toBe('');
    });

    it('400s with "Not a git repository" for a non-git directory', async () => {
        const { status, body } = await h.req<{ error: string }>(
            `/api/workspaces/git-diff?${qs({ workspace: plainDir, file: 'anything.txt' })}`
        );
        expect(status).toBe(400);
        expect(body.error).toBe('Not a git repository');
    });

    it('400s (not 500s) when workspace or file is missing', async () => {
        const noWs = await h.req<{ error: string }>(`/api/workspaces/git-diff?${qs({ file: 'a.txt' })}`);
        expect(noWs.status).toBe(400);
        expect(noWs.body.error).toMatch(/workspace query parameter is required/);

        const noFile = await h.req<{ error: string }>(`/api/workspaces/git-diff?${qs({ workspace: statusRepo })}`);
        expect(noFile.status).toBe(400);
        expect(noFile.body.error).toMatch(/file query parameter is required/);
    });

    it('404s for a workspace path that does not exist', async () => {
        const { status, body } = await h.req<{ error: string }>(
            `/api/workspaces/git-diff?${qs({ workspace: missingDir, file: 'a.txt' })}`
        );
        expect(status).toBe(404);
        expect(body.error).toBe('Workspace not found');
    });
});

// ───────────────────────────────────────────────────────────────────────────
// GET /api/workspaces/git-log
// ───────────────────────────────────────────────────────────────────────────
describe('GET /api/workspaces/git-log', () => {
    interface Commit { hash: string; shortHash: string; author: string; date: string; message: string }

    it('returns real commits, newest first, with hash/author/date/subject populated', async () => {
        const { status, body } = await h.req<{ commits: Commit[] }>(
            `/api/workspaces/git-log?${qs({ workspace: statusRepo })}`
        );
        expect(status).toBe(200);
        expect(body.commits.map(c => c.message)).toEqual(['update readme', 'add tracked file', 'init']);

        const head = body.commits[0];
        expect(head.hash).toMatch(/^[0-9a-f]{40}$/);
        expect(head.shortHash).toBe(head.hash.slice(0, head.shortHash.length));
        expect(head.author).toBe('Test User');
        expect(Number.isNaN(Date.parse(head.date))).toBe(false);

        // Ground truth: the API's HEAD hash is the repo's actual HEAD.
        expect(head.hash).toBe(git(statusRepo, 'rev-parse', 'HEAD').trim());
    });

    it('honours the count query param', async () => {
        const { status, body } = await h.req<{ commits: Commit[] }>(
            `/api/workspaces/git-log?${qs({ workspace: statusRepo, count: '2' })}`
        );
        expect(status).toBe(200);
        expect(body.commits).toHaveLength(2);
        expect(body.commits.map(c => c.message)).toEqual(['update readme', 'add tracked file']);
    });

    it('returns an empty commit list for a non-git directory', async () => {
        const { status, body } = await h.req<{ commits: Commit[] }>(
            `/api/workspaces/git-log?${qs({ workspace: plainDir })}`
        );
        expect(status).toBe(200);
        expect(body.commits).toEqual([]);
    });

    it('400s (not 500s) when the workspace query param is missing', async () => {
        const { status, body } = await h.req<{ error: string }>('/api/workspaces/git-log');
        expect(status).toBe(400);
        expect(body.error).toMatch(/workspace query parameter is required/);
    });

    it('404s for a workspace path that does not exist', async () => {
        const { status, body } = await h.req<{ error: string }>(
            `/api/workspaces/git-log?${qs({ workspace: missingDir })}`
        );
        expect(status).toBe(404);
        expect(body.error).toBe('Workspace not found');
    });
});

// ───────────────────────────────────────────────────────────────────────────
// Worktree lifecycle: POST -> GET -> DELETE, driven against a real repo.
// Kept as one test because the steps are genuinely sequential; every step
// cross-checks against `git worktree list` in the repo itself.
// ───────────────────────────────────────────────────────────────────────────
describe('worktree lifecycle (POST/GET/DELETE /api/worktrees)', () => {
    interface WtInfo { path: string; branch: string; isMain: boolean; taskCount?: number; prunable: boolean }

    it('creates a worktree on disk, lists it, then removes it', async () => {
        // ── create ─────────────────────────────────────────────────────────
        const created = await h.send<{ worktreePath: string; branch: string; workspace: Record<string, unknown> }>(
            'POST', `/api/worktrees?${qs({ workspace: wtRepo })}`, { branch: 'feature/one' }
        );
        expect(created.status).toBe(200);
        expect(created.body.branch).toBe('feature/one');

        const wtPath = created.body.worktreePath;
        // Slug: `/` is sanitized to `-` and the dir lands under the repo root.
        expect(wtPath).toBe(join(wtRepo, '.claudia-worktrees', 'feature-one'));
        expect(existsSync(wtPath)).toBe(true);
        expect(existsSync(join(wtPath, 'README.md'))).toBe(true);
        // Ground truth: git itself knows about the new worktree.
        expect(worktreeListRaw(wtRepo)).toContain(`worktree ${wtPath}`);
        // It was registered as a child workspace of the repo.
        expect(created.body.workspace).toMatchObject({
            id: wtPath,
            worktreeParentId: wtRepo,
            worktreeBranch: 'feature/one',
        });

        // ── list ───────────────────────────────────────────────────────────
        const listed = await h.req<{ worktrees: WtInfo[] }>(`/api/worktrees?${qs({ workspace: wtRepo })}`);
        expect(listed.status).toBe(200);
        expect(listed.body.worktrees).toHaveLength(2);

        const main = listed.body.worktrees.find(w => w.isMain)!;
        expect(main.path).toBe(wtRepo);
        expect(main.branch).toBe('refs/heads/main');

        const child = listed.body.worktrees.find(w => !w.isMain)!;
        expect(child.path).toBe(wtPath);
        expect(child.branch).toBe('refs/heads/feature/one');
        expect(child.prunable).toBe(false);
        // No tasks were seeded against the worktree.
        expect(child.taskCount).toBe(0);

        // ── delete ─────────────────────────────────────────────────────────
        const removed = await h.send<{ success: boolean }>(
            'DELETE', `/api/worktrees?${qs({ workspace: wtRepo, worktreePath: wtPath })}`
        );
        expect(removed.status).toBe(200);
        expect(removed.body).toEqual({ success: true });

        await waitFor(() => existsSync(wtPath), gone => gone === false);
        expect(worktreeListRaw(wtRepo)).not.toContain(`worktree ${wtPath}`);

        const afterDelete = await h.req<{ worktrees: WtInfo[] }>(`/api/worktrees?${qs({ workspace: wtRepo })}`);
        expect(afterDelete.body.worktrees).toHaveLength(1);
        expect(afterDelete.body.worktrees[0].isMain).toBe(true);
    }, 30000);

    it('can check out an EXISTING branch with createBranch=false', async () => {
        const created = await h.send<{ worktreePath: string; branch: string }>(
            'POST', `/api/worktrees?${qs({ workspace: wtRepo })}`,
            { branch: 'feature/extra', createBranch: false }
        );
        expect(created.status).toBe(200);
        const wtPath = created.body.worktreePath;
        expect(existsSync(wtPath)).toBe(true);
        expect(git(wtPath, 'branch', '--show-current').trim()).toBe('feature/extra');

        // Clean up so later tests see a single-worktree repo.
        const removed = await h.send('DELETE', `/api/worktrees?${qs({ workspace: wtRepo, worktreePath: wtPath })}`);
        expect(removed.status).toBe(200);
        await waitFor(() => existsSync(wtPath), gone => gone === false);
    }, 30000);
});

// ───────────────────────────────────────────────────────────────────────────
// Worktree route error contracts
// ───────────────────────────────────────────────────────────────────────────
describe('worktree route error contracts', () => {
    it('GET /api/worktrees 400s without workspace and 404s for a missing path', async () => {
        const noWs = await h.req<{ error: string }>('/api/worktrees');
        expect(noWs.status).toBe(400);
        expect(noWs.body.error).toMatch(/workspace query parameter is required/);

        const missing = await h.req<{ error: string }>(`/api/worktrees?${qs({ workspace: missingDir })}`);
        expect(missing.status).toBe(404);
        expect(missing.body.error).toBe('Workspace not found');
    });

    it('GET /api/worktrees 500s with a git error for a non-git directory', async () => {
        // Documents current behaviour: the route has no "is this a repo?" guard,
        // so WorktreeManager's throw surfaces as a 500 rather than a 400.
        const { status, body } = await h.req<{ error: string }>(`/api/worktrees?${qs({ workspace: plainDir })}`);
        expect(status).toBe(500);
        expect(body.error).toMatch(/git worktree list failed/);
    });

    it('POST /api/worktrees 400s without workspace, 404s for a missing path, 400s without branch', async () => {
        const noWs = await h.send<{ error: string }>('POST', '/api/worktrees', { branch: 'x' });
        expect(noWs.status).toBe(400);
        expect(noWs.body.error).toMatch(/workspace query parameter is required/);

        const missing = await h.send<{ error: string }>(
            'POST', `/api/worktrees?${qs({ workspace: missingDir })}`, { branch: 'x' }
        );
        expect(missing.status).toBe(404);
        expect(missing.body.error).toBe('Workspace not found');

        const noBranch = await h.send<{ error: string }>('POST', `/api/worktrees?${qs({ workspace: wtRepo })}`, {});
        expect(noBranch.status).toBe(400);
        expect(noBranch.body.error).toBe('branch is required');
    });

    it('POST /api/worktrees 400s (not 500s) for a branch already checked out, and for an invalid ref name', async () => {
        // `main` is checked out in the main working tree already.
        const dup = await h.send<{ error: string }>(
            'POST', `/api/worktrees?${qs({ workspace: wtRepo })}`, { branch: 'main', createBranch: false }
        );
        expect(dup.status).toBe(400);
        expect(dup.body.error).toMatch(/already checked out in a worktree/);

        // git rejects a ref name ending in ".lock" — must surface as 400, not 500.
        const bad = await h.send<{ error: string }>(
            'POST', `/api/worktrees?${qs({ workspace: wtRepo })}`, { branch: 'bogus.lock' }
        );
        expect(bad.status).toBe(400);
        expect(bad.body.error).toMatch(/Failed to create worktree/);

        // Nothing leaked onto disk from either failure.
        expect(worktreeListRaw(wtRepo).match(/^worktree /gm)).toHaveLength(1);
    }, 30000);

    it('DELETE /api/worktrees 400s when required params are missing', async () => {
        const noWs = await h.send<{ error: string }>('DELETE', `/api/worktrees?${qs({ worktreePath: wtRepo })}`);
        expect(noWs.status).toBe(400);
        expect(noWs.body.error).toMatch(/workspace and worktreePath query parameters are required/);

        const noWt = await h.send<{ error: string }>('DELETE', `/api/worktrees?${qs({ workspace: wtRepo })}`);
        expect(noWt.status).toBe(400);
        expect(noWt.body.error).toMatch(/workspace and worktreePath query parameters are required/);
    });

    it('DELETE /api/worktrees refuses to remove the primary workspace', async () => {
        const { status, body } = await h.send<{ error: string }>(
            'DELETE', `/api/worktrees?${qs({ workspace: wtRepo, worktreePath: wtRepo })}`
        );
        expect(status).toBe(400);
        expect(body.error).toBe('Cannot remove the primary workspace');
        // The repo is untouched.
        expect(existsSync(join(wtRepo, '.git'))).toBe(true);
    });

    it('DELETE /api/worktrees 400s (not 500s) for a path git does not know about', async () => {
        // No existsSync guard on this route, so a bogus path surfaces git's error as 400.
        const { status, body } = await h.send<{ error: string }>(
            'DELETE', `/api/worktrees?${qs({ workspace: wtRepo, worktreePath: missingDir })}`
        );
        expect(status).toBe(400);
        expect(body.error).toMatch(/Failed to remove worktree/);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /api/worktrees/prune
// ───────────────────────────────────────────────────────────────────────────
describe('POST /api/worktrees/prune', () => {
    it('reports worktrees whose directory vanished behind git\'s back', async () => {
        const created = await h.send<{ worktreePath: string }>(
            'POST', `/api/worktrees?${qs({ workspace: pruneRepo })}`, { branch: 'stale/one' }
        );
        expect(created.status).toBe(200);
        const wtPath = created.body.worktreePath;
        expect(existsSync(wtPath)).toBe(true);

        // Nothing is stale yet.
        const clean = await h.send<{ pruned: string[] }>('POST', `/api/worktrees/prune?${qs({ workspace: pruneRepo })}`);
        expect(clean.status).toBe(200);
        expect(clean.body.pruned).toEqual([]);
        expect(existsSync(wtPath)).toBe(true);

        // Delete the directory out from under git -> now it is prunable.
        rmSync(wtPath, { recursive: true, force: true });

        const pruned = await h.send<{ pruned: string[] }>('POST', `/api/worktrees/prune?${qs({ workspace: pruneRepo })}`);
        expect(pruned.status).toBe(200);
        expect(Array.isArray(pruned.body.pruned)).toBe(true);
        expect(pruned.body.pruned).toContain(wtPath);
        // git's own bookkeeping agrees the entry is gone.
        expect(worktreeListRaw(pruneRepo)).not.toContain(`worktree ${wtPath}`);
    }, 30000);

    it('400s (not 500s) without workspace and 404s for a missing path', async () => {
        const noWs = await h.send<{ error: string }>('POST', '/api/worktrees/prune');
        expect(noWs.status).toBe(400);
        expect(noWs.body.error).toMatch(/workspace query parameter is required/);

        const missing = await h.send<{ error: string }>('POST', `/api/worktrees/prune?${qs({ workspace: missingDir })}`);
        expect(missing.status).toBe(404);
        expect(missing.body.error).toBe('Workspace not found');
    });
});

// ───────────────────────────────────────────────────────────────────────────
// GET /api/worktrees/branches
// ───────────────────────────────────────────────────────────────────────────
describe('GET /api/worktrees/branches', () => {
    it('lists real local branches; remote is empty because no remote exists', async () => {
        const { status, body } = await h.req<{ local: string[]; remote: string[] }>(
            `/api/worktrees/branches?${qs({ workspace: wtRepo })}`
        );
        expect(status).toBe(200);
        expect(body.local).toContain('main');
        expect(body.local).toContain('feature/extra');
        // Asserted rather than skipped: the fixture repo has no remotes at all.
        expect(body.remote).toEqual([]);
        expect(git(wtRepo, 'remote').trim()).toBe('');
    });

    it('400s (not 500s) when the workspace query param is missing', async () => {
        const { status, body } = await h.req<{ error: string }>('/api/worktrees/branches');
        expect(status).toBe(400);
        expect(body.error).toMatch(/workspace query parameter is required/);
    });

    it('degrades to empty lists (200, not 404/500) for a missing or non-git path', async () => {
        // This route has no existsSync guard and swallows git failures by design.
        const missing = await h.req<{ local: string[]; remote: string[] }>(
            `/api/worktrees/branches?${qs({ workspace: missingDir })}`
        );
        expect(missing.status).toBe(200);
        expect(missing.body).toEqual({ local: [], remote: [] });

        const nonGit = await h.req<{ local: string[]; remote: string[] }>(
            `/api/worktrees/branches?${qs({ workspace: plainDir })}`
        );
        expect(nonGit.status).toBe(200);
        expect(nonGit.body).toEqual({ local: [], remote: [] });
    });
});

// ───────────────────────────────────────────────────────────────────────────
// PATCH /api/worktrees/auto
// ───────────────────────────────────────────────────────────────────────────
describe('PATCH /api/worktrees/auto', () => {
    const autoOf = async (id: string) => {
        const { body } = await h.req<{ workspaces: Array<{ id: string; autoWorktree?: boolean }> }>('/api/workspaces');
        return body.workspaces.find(w => w.id === id)?.autoWorktree;
    };

    it('toggles autoWorktree on a registered workspace and persists it', async () => {
        expect(await autoOf(registeredDir)).toBeUndefined();

        const on = await h.send<{ success: boolean; autoWorktree: boolean }>(
            'PATCH', `/api/worktrees/auto?${qs({ workspace: registeredDir })}`, { enabled: true }
        );
        expect(on.status).toBe(200);
        expect(on.body).toEqual({ success: true, autoWorktree: true });
        expect(await autoOf(registeredDir)).toBe(true);

        const off = await h.send<{ success: boolean; autoWorktree: boolean }>(
            'PATCH', `/api/worktrees/auto?${qs({ workspace: registeredDir })}`, { enabled: false }
        );
        expect(off.status).toBe(200);
        expect(off.body).toEqual({ success: true, autoWorktree: false });
        expect(await autoOf(registeredDir)).toBe(false);
    });

    it('404s for a real path on disk that is not a registered workspace', async () => {
        const { status, body } = await h.send<{ error: string }>(
            'PATCH', `/api/worktrees/auto?${qs({ workspace: unregisteredDir })}`, { enabled: true }
        );
        expect(status).toBe(404);
        expect(body.error).toBe('Workspace not found');
    });

    it('400s when enabled is not a boolean, or absent entirely', async () => {
        const notBool = await h.send<{ error: string }>(
            'PATCH', `/api/worktrees/auto?${qs({ workspace: registeredDir })}`, { enabled: 'yes' }
        );
        expect(notBool.status).toBe(400);
        expect(notBool.body.error).toMatch(/enabled \(boolean\) is required/);

        const absent = await h.send<{ error: string }>(
            'PATCH', `/api/worktrees/auto?${qs({ workspace: registeredDir })}`, {}
        );
        expect(absent.status).toBe(400);
        expect(absent.body.error).toMatch(/enabled \(boolean\) is required/);

        // The failed writes did not change stored state.
        expect(await autoOf(registeredDir)).toBe(false);
    });

    it('400s (not 500s) when the workspace query param is missing', async () => {
        const { status, body } = await h.send<{ error: string }>('PATCH', '/api/worktrees/auto', { enabled: true });
        expect(status).toBe(400);
        expect(body.error).toMatch(/workspace query parameter is required/);
    });
});
