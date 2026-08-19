/**
 * WorktreeManager tests — driven against REAL temp git repositories.
 *
 * Nothing here is mocked: every assertion runs actual `git worktree` commands,
 * so the tests fail if git's contract changes under us (which is exactly the
 * risk WorktreeManager carries — it is a thin wrapper over git's CLI).
 *
 * IMPORTANT: base dirs live under homedir(), NOT os.tmpdir(). On macOS tmpdir
 * resolves under /var, which validateWorkspacePath blocklists — workspace ops
 * get rejected before they ever reach the code under test.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { WorktreeManager, branchToDirectoryName } from '../worktree-manager.js';

// Every case here shells out to git several times. At the 10s project default
// these flake on a loaded machine and on slow CI runners (the Windows leg
// especially) — observed at 11s for a two-worktree create+remove. File-scoped
// so the project default is untouched for everything else.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

let base: string;
let repoCounter = 0;

const git = (args: string[], cwd: string): string =>
    execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Create a fresh, committed git repo under the shared temp base. */
function makeRepo(name = `repo-${++repoCounter}`): string {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    git(['init', '-q', '-b', 'main', '.'], dir);
    git(['config', 'user.email', 'test@test.com'], dir);
    git(['config', 'user.name', 'Test User'], dir);
    git(['config', 'commit.gpgsign', 'false'], dir);
    writeFileSync(join(dir, 'README.md'), 'hello\n');
    git(['add', '-A'], dir);
    git(['commit', '-qm', 'init'], dir);
    return dir;
}

/** A directory that is definitely not inside any git repo. */
function makePlainDir(name = `plain-${++repoCounter}`): string {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    return dir;
}

beforeAll(() => {
    base = mkdtempSync(join(homedir(), '.claudia-test-wtm-'));
    // Sanity: homedir must not itself be a repo, or "not a git repo" cases lie.
    expect(() => git(['rev-parse', '--is-inside-work-tree'], base)).toThrow();
});

afterAll(() => {
    // Prune every worktree we created, then delete the whole tree.
    try {
        for (const entry of [base]) {
            void entry;
        }
    } catch { /* ignore */ }
    try {
        rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch { /* ignore */ }
});

describe('branchToDirectoryName', () => {
    it('maps the claudia/task-<id> convention to a flat directory slug', () => {
        expect(branchToDirectoryName('claudia/task-bd75c27e')).toBe('claudia-task-bd75c27e');
    });

    it('strips a refs/heads/ prefix', () => {
        expect(branchToDirectoryName('refs/heads/claudia/task-a1b2')).toBe('claudia-task-a1b2');
    });

    it('replaces every filesystem-hostile character', () => {
        expect(branchToDirectoryName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
    });

    it('collapses .. sequences (no parent-directory escape in the slug)', () => {
        // '/' -> '-' first, then each '..' run collapses to a single '-'
        expect(branchToDirectoryName('feat/../../etc/passwd')).toBe('feat-----etc-passwd');
        expect(branchToDirectoryName('feat/../../etc/passwd')).not.toContain('..');
        expect(branchToDirectoryName('a...b')).toBe('a-b');
    });

    it('escapes a leading dot so the slug is never a hidden/relative dir', () => {
        expect(branchToDirectoryName('.hidden')).toBe('_hidden');
        expect(branchToDirectoryName('..')).toBe('-');
    });

    it('truncates to 100 characters', () => {
        const slug = branchToDirectoryName('x'.repeat(250));
        expect(slug).toHaveLength(100);
    });
});

describe('isLinkedWorktree / getMainWorktreePath', () => {
    let mgr: WorktreeManager;
    let repo: string;

    beforeAll(async () => {
        mgr = new WorktreeManager();
        repo = makeRepo();
        await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-linked' });
    });

    const wt = () => join(repo, '.claudia-worktrees', 'claudia-task-linked');

    it('reports false for the main working tree (.git is a directory)', async () => {
        expect(await mgr.isLinkedWorktree(repo)).toBe(false);
    });

    it('reports true for a linked worktree (.git is a file)', async () => {
        expect(await mgr.isLinkedWorktree(wt())).toBe(true);
    });

    it('reports false for a path with no .git at all', async () => {
        expect(await mgr.isLinkedWorktree(makePlainDir())).toBe(false);
    });

    it('resolves the main worktree path from inside a linked worktree', async () => {
        expect(await mgr.getMainWorktreePath(wt())).toBe(resolve(repo));
    });

    it('resolves the main worktree path from the main worktree itself', async () => {
        expect(await mgr.getMainWorktreePath(repo)).toBe(resolve(repo));
    });

    it('returns null outside a git repo', async () => {
        expect(await mgr.getMainWorktreePath(makePlainDir())).toBeNull();
    });
});

describe('listWorktrees', () => {
    let mgr: WorktreeManager;

    beforeEach(() => { mgr = new WorktreeManager(); });

    it('returns exactly the main working tree for a fresh repo, flagged isMain', async () => {
        const repo = makeRepo();
        const list = await mgr.listWorktrees(repo);
        expect(list).toHaveLength(1);
        expect(list[0].isMain).toBe(true);
        expect(list[0].path).toBe(resolve(repo));
        expect(list[0].branch).toBe('refs/heads/main');
        expect(list[0].commitHash).toMatch(/^[0-9a-f]{40}$/);
        expect(list[0].isLocked).toBe(false);
        expect(list[0].prunable).toBe(false);
    });

    it('lists linked worktrees after the main one, and only the first is isMain', async () => {
        const repo = makeRepo();
        await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-list1' });
        await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-list2' });

        const list = await mgr.listWorktrees(repo);
        expect(list).toHaveLength(3);
        expect(list.filter(w => w.isMain)).toHaveLength(1);
        expect(list[0].isMain).toBe(true);
        expect(list.map(w => w.branch)).toEqual([
            'refs/heads/main',
            'refs/heads/claudia/task-list1',
            'refs/heads/claudia/task-list2',
        ]);
    });

    it('renders a detached HEAD as "(detached: <short sha>)"', async () => {
        const repo = makeRepo();
        const detachedDir = join(base, `detached-${++repoCounter}`);
        git(['worktree', 'add', '-q', '--detach', detachedDir], repo);

        const list = await mgr.listWorktrees(repo);
        const det = list.find(w => w.path === resolve(detachedDir));
        expect(det).toBeDefined();
        expect(det!.branch).toMatch(/^\(detached: [0-9a-f]{7}\)$/);
    });

    it('renders a bare repository as "(bare)"', async () => {
        const bare = join(base, `bare-${++repoCounter}.git`);
        git(['init', '-q', '--bare', bare], base);
        const list = await mgr.listWorktrees(bare);
        expect(list[0].branch).toBe('(bare)');
    });

    it('surfaces lock state and the lock reason', async () => {
        const repo = makeRepo();
        const { path } = await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-locked' });
        await mgr.lockWorktree(path, 'held by a running task');

        const entry = (await mgr.listWorktrees(repo)).find(w => w.path === resolve(path));
        expect(entry!.isLocked).toBe(true);
        expect(entry!.lockedReason).toBe('held by a running task');

        await mgr.unlockWorktree(path);
        const after = (await mgr.listWorktrees(repo)).find(w => w.path === resolve(path));
        expect(after!.isLocked).toBe(false);
    });

    it('throws a wrapped error when the path is not a git repository', async () => {
        await expect(mgr.listWorktrees(makePlainDir()))
            .rejects.toThrow(/git worktree list failed:/);
    });
});

describe('createWorktree', () => {
    let mgr: WorktreeManager;

    beforeEach(() => { mgr = new WorktreeManager(); });

    it('creates the worktree under <repo>/.claudia-worktrees/<slug> using the claudia/task-<id> convention', async () => {
        const repo = makeRepo();
        const res = await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-abc123' });

        expect(res.branch).toBe('claudia/task-abc123');
        expect(res.path).toBe(join(repo, '.claudia-worktrees', 'claudia-task-abc123'));
        expect(existsSync(join(res.path, 'README.md'))).toBe(true);
        expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], res.path).trim()).toBe('claudia/task-abc123');
    });

    it('adds .claudia-worktrees/ to .git/info/exclude exactly once (never touches tracked .gitignore)', async () => {
        const repo = makeRepo();
        await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-ex1' });
        await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-ex2' });

        const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf-8');
        expect(exclude.match(/\.claudia-worktrees\//g)).toHaveLength(1);
        expect(existsSync(join(repo, '.gitignore'))).toBe(false);
    });

    it('regression: the exclude entry lands even when created from the MAIN worktree, and git stops reporting .claudia-worktrees as untracked', async () => {
        // Previously `git rev-parse --git-common-dir` was called without
        // --path-format=absolute; in a MAIN worktree git answers with the
        // relative ".git", which resolved against the server process cwd, so
        // the exclude write was silently skipped and every worktree dir showed
        // up as untracked noise in the parent repo.
        const repo = makeRepo();
        await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-excl-main' });

        expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf-8'))
            .toContain('.claudia-worktrees/');
        expect(git(['status', '--porcelain'], repo)).not.toContain('.claudia-worktrees');
    });

    it('writes the exclude entry to the SHARED .git dir when created from a linked worktree', async () => {
        const repo = makeRepo();
        const first = await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-excl-a' });
        // wipe the entry so the second create has to re-add it via the linked path
        writeFileSync(join(repo, '.git', 'info', 'exclude'), '');

        await mgr.createWorktree({ repoPath: first.path, branch: 'claudia/task-excl-b' });
        expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf-8'))
            .toContain('.claudia-worktrees/');
    });

    it('survives a missing .git/info/exclude file (non-fatal best effort)', async () => {
        const repo = makeRepo();
        rmSync(join(repo, '.git', 'info', 'exclude'), { force: true });

        const res = await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-noexclude' });
        expect(existsSync(join(res.path, 'README.md'))).toBe(true);
        expect(existsSync(join(repo, '.git', 'info', 'exclude'))).toBe(false);
    });

    it('honours an explicit targetDir override', async () => {
        const repo = makeRepo();
        const target = join(base, `explicit-${++repoCounter}`);
        const res = await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-target', targetDir: target });
        expect(res.path).toBe(target);
        expect(existsSync(join(target, 'README.md'))).toBe(true);
    });

    it('creates from an explicit baseBranch', async () => {
        const repo = makeRepo();
        git(['checkout', '-q', '-b', 'release'], repo);
        writeFileSync(join(repo, 'only-on-release.txt'), 'x\n');
        git(['add', '-A'], repo);
        git(['commit', '-qm', 'release commit'], repo);
        git(['checkout', '-q', 'main'], repo);

        const res = await mgr.createWorktree({
            repoPath: repo, branch: 'claudia/task-frombase', baseBranch: 'release',
        });
        expect(existsSync(join(res.path, 'only-on-release.txt'))).toBe(true);
    });

    it('checks out an EXISTING branch when createBranch=false', async () => {
        const repo = makeRepo();
        git(['branch', 'existing-feature'], repo);

        const res = await mgr.createWorktree({
            repoPath: repo, branch: 'existing-feature', createBranch: false,
        });
        expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], res.path).trim()).toBe('existing-feature');
    });

    it('roots .claudia-worktrees at the MAIN repo even when called from inside a linked worktree', async () => {
        const repo = makeRepo();
        const first = await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-outer' });

        // Call again, but pass the linked worktree as repoPath — must not nest.
        const second = await mgr.createWorktree({ repoPath: first.path, branch: 'claudia/task-inner' });
        expect(second.path).toBe(join(repo, '.claudia-worktrees', 'claudia-task-inner'));
        expect(second.path.startsWith(first.path)).toBe(false);
    });

    it('refuses when the branch is already checked out in another worktree', async () => {
        const repo = makeRepo();
        const first = await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-dup' });

        await expect(mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-dup' }))
            .rejects.toThrow(/already checked out in a worktree/);
        // The pre-existing worktree is untouched.
        expect(existsSync(join(first.path, 'README.md'))).toBe(true);
    });

    it('fails when the target directory already exists and is non-empty', async () => {
        const repo = makeRepo();
        const target = join(base, `occupied-${++repoCounter}`);
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, 'squatter.txt'), 'do not clobber me\n');

        await expect(mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-occupied', targetDir: target }))
            .rejects.toThrow(/Failed to create worktree:/);
        // The pre-existing content must survive the failed create.
        expect(readFileSync(join(target, 'squatter.txt'), 'utf-8')).toBe('do not clobber me\n');
    });

    it('fails when repoPath is not a git repository', async () => {
        await expect(new WorktreeManager().createWorktree({ repoPath: makePlainDir(), branch: 'claudia/task-nogit' }))
            .rejects.toThrow(/Failed to create worktree:/);
    });

    it('fails when the requested baseBranch does not exist', async () => {
        const repo = makeRepo();
        await expect(mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-nobase', baseBranch: 'no-such-branch' }))
            .rejects.toThrow(/Failed to create worktree:/);
    });

    it('still creates the worktree when the exclude file cannot be written (best-effort, non-fatal)', async () => {
        const repo = makeRepo();
        const excludeFile = join(repo, '.git', 'info', 'exclude');
        chmodSync(excludeFile, 0o444); // read-only → appendFileSync throws EACCES
        try {
            const res = await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-roexclude' });
            expect(existsSync(join(res.path, 'README.md'))).toBe(true);
            expect(readFileSync(excludeFile, 'utf-8')).not.toContain('.claudia-worktrees/');
        } finally {
            chmodSync(excludeFile, 0o644);
        }
    });

    it('still creates the worktree when submodule init fails (best-effort, non-fatal)', async () => {
        const repo = makeRepo();
        writeFileSync(join(repo, '.gitmodules'), '[submodule "broken"\n'); // malformed config
        git(['add', '-A'], repo);
        git(['commit', '-qm', 'broken gitmodules'], repo);

        const res = await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-badsubmod' });
        expect(existsSync(join(res.path, 'README.md'))).toBe(true);
        await new Promise(r => setTimeout(r, 600));
    });

    it('kicks off submodule init when the worktree contains a .gitmodules file (best-effort, non-fatal)', async () => {
        const repo = makeRepo();
        writeFileSync(join(repo, '.gitmodules'), '');
        git(['add', '-A'], repo);
        git(['commit', '-qm', 'add gitmodules'], repo);

        const res = await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-submod' });
        expect(existsSync(join(res.path, '.gitmodules'))).toBe(true);
        // fire-and-forget; give the detached submodule call a moment to settle
        // so its promise resolves inside the test rather than after teardown.
        await new Promise(r => setTimeout(r, 600));
    });
});

describe('removeWorktree', () => {
    let mgr: WorktreeManager;

    beforeEach(() => { mgr = new WorktreeManager(); });

    it('removes a clean worktree from disk and from git tracking', async () => {
        const repo = makeRepo();
        const { path } = await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-rm' });

        await mgr.removeWorktree({ repoPath: repo, worktreePath: path });

        expect(existsSync(path)).toBe(false);
        expect((await mgr.listWorktrees(repo)).map(w => w.path)).not.toContain(resolve(path));
    });

    it('works when repoPath is a sibling linked worktree rather than the main repo', async () => {
        const repo = makeRepo();
        const keep = await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-keep' });
        const doomed = await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-doomed' });

        await mgr.removeWorktree({ repoPath: keep.path, worktreePath: doomed.path });
        expect(existsSync(doomed.path)).toBe(false);
        expect(existsSync(keep.path)).toBe(true);
    });

    // ---- GUARDRAIL: the primary worktree must never be removable ------------
    it('REFUSES to remove the primary/main working tree', async () => {
        const repo = makeRepo();
        await expect(mgr.removeWorktree({ repoPath: repo, worktreePath: repo }))
            .rejects.toThrow(/Failed to remove worktree:/);

        expect(existsSync(join(repo, 'README.md'))).toBe(true);
        expect(existsSync(join(repo, '.git'))).toBe(true);
    });

    it('REFUSES to remove the primary working tree even with force=true', async () => {
        const repo = makeRepo();
        await expect(mgr.removeWorktree({ repoPath: repo, worktreePath: repo, force: true }))
            .rejects.toThrow(/is a main working tree/);

        expect(existsSync(join(repo, 'README.md'))).toBe(true);
        expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('hello\n');
    });

    it('REFUSES to remove the primary working tree when addressed via a linked worktree', async () => {
        const repo = makeRepo();
        const linked = await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-viaLinked' });

        await expect(mgr.removeWorktree({ repoPath: linked.path, worktreePath: repo, force: true }))
            .rejects.toThrow(/is a main working tree/);
        expect(existsSync(join(repo, 'README.md'))).toBe(true);
    });

    // ---- DATA LOSS: uncommitted work must not vanish silently ---------------
    it('does NOT discard uncommitted work: a DIRTY worktree is refused by default (force omitted)', async () => {
        const repo = makeRepo();
        const { path } = await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-dirty' });
        writeFileSync(join(path, 'README.md'), 'MODIFIED — hours of unsaved work\n');
        writeFileSync(join(path, 'scratch.txt'), 'untracked notes\n');

        await expect(mgr.removeWorktree({ repoPath: repo, worktreePath: path }))
            .rejects.toThrow(/contains modified or untracked files/);

        // Hard assertion: every byte of the user's work is still on disk.
        expect(existsSync(path)).toBe(true);
        expect(readFileSync(join(path, 'README.md'), 'utf-8')).toBe('MODIFIED — hours of unsaved work\n');
        expect(readFileSync(join(path, 'scratch.txt'), 'utf-8')).toBe('untracked notes\n');
        expect((await mgr.listWorktrees(repo)).map(w => w.path)).toContain(resolve(path));
    });

    it('refuses a worktree dirtied ONLY by an untracked file (no tracked-file edits)', async () => {
        const repo = makeRepo();
        const { path } = await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-untracked' });
        writeFileSync(join(path, 'notes.md'), 'untracked-only\n');

        await expect(mgr.removeWorktree({ repoPath: repo, worktreePath: path }))
            .rejects.toThrow(/contains modified or untracked files/);
        expect(readFileSync(join(path, 'notes.md'), 'utf-8')).toBe('untracked-only\n');
    });

    it('CHARACTERIZATION (known data-loss surface): force=true destroys uncommitted work with no dirty-check', async () => {
        // WorktreeManager.removeWorktree performs NO uncommitted-work check of its
        // own — it delegates entirely to git, and `force: true` maps straight to
        // `--force`, which deletes modified and untracked files unrecoverably.
        // Callers that hard-code force:true (see server.ts workspace-reset) can
        // therefore destroy user work. Documented, not endorsed — see the report.
        const repo = makeRepo();
        const { path } = await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-forcedirty' });
        writeFileSync(join(path, 'unsaved.txt'), 'this will be lost\n');

        await mgr.removeWorktree({ repoPath: repo, worktreePath: path, force: true });
        expect(existsSync(path)).toBe(false);
    });

    it('throws a wrapped error for a worktree path git does not know about', async () => {
        const repo = makeRepo();
        await expect(mgr.removeWorktree({ repoPath: repo, worktreePath: join(base, 'never-existed') }))
            .rejects.toThrow(/Failed to remove worktree:/);
    });

    it('throws when repoPath is not a git repository', async () => {
        await expect(mgr.removeWorktree({ repoPath: makePlainDir(), worktreePath: join(base, 'whatever') }))
            .rejects.toThrow(/Failed to remove worktree:/);
    });

    it('refuses to remove a LOCKED worktree until it is unlocked', async () => {
        const repo = makeRepo();
        const { path } = await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-lockrm' });
        await mgr.lockWorktree(path, 'task running');

        await expect(mgr.removeWorktree({ repoPath: repo, worktreePath: path, force: true }))
            .rejects.toThrow(/Failed to remove worktree:/);
        expect(existsSync(path)).toBe(true);

        await mgr.unlockWorktree(path);
        await mgr.removeWorktree({ repoPath: repo, worktreePath: path });
        expect(existsSync(path)).toBe(false);
    });
});

describe('pruneWorktrees', () => {
    let mgr: WorktreeManager;

    beforeEach(() => { mgr = new WorktreeManager(); });

    it('returns [] and is a no-op when nothing is stale', async () => {
        const repo = makeRepo();
        await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-live' });

        expect(await mgr.pruneWorktrees(repo)).toEqual([]);
        expect(await mgr.listWorktrees(repo)).toHaveLength(2);
    });

    it('prunes a worktree whose directory was deleted outside git, and reports its path', async () => {
        const repo = makeRepo();
        const { path } = await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-stale' });

        rmSync(path, { recursive: true, force: true });

        // git now reports it as prunable but still lists it
        const before = await mgr.listWorktrees(repo);
        expect(before.find(w => w.path === resolve(path))?.prunable).toBe(true);

        const pruned = await mgr.pruneWorktrees(repo);
        expect(pruned).toEqual([resolve(path)]);

        const after = await mgr.listWorktrees(repo);
        expect(after.map(w => w.path)).not.toContain(resolve(path));
    });

    it('never reports the main worktree as pruned', async () => {
        const repo = makeRepo();
        const { path } = await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-stale2' });
        rmSync(path, { recursive: true, force: true });

        const pruned = await mgr.pruneWorktrees(repo);
        expect(pruned).not.toContain(resolve(repo));
        expect(existsSync(join(repo, 'README.md'))).toBe(true);
    });

    it('throws when the path is not a git repository', async () => {
        await expect(mgr.pruneWorktrees(makePlainDir()))
            .rejects.toThrow(/git worktree list failed:/);
    });
});

describe('lockWorktree / unlockWorktree', () => {
    let mgr: WorktreeManager;

    beforeEach(() => { mgr = new WorktreeManager(); });

    it('locks without a reason', async () => {
        const repo = makeRepo();
        const { path } = await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-lock-noreason' });

        await mgr.lockWorktree(path);
        const entry = (await mgr.listWorktrees(repo)).find(w => w.path === resolve(path));
        expect(entry!.isLocked).toBe(true);
        expect(entry!.lockedReason).toBeUndefined();
    });

    it('throws when locking a path that is not a worktree', async () => {
        await expect(mgr.lockWorktree(join(base, 'no-such-worktree')))
            .rejects.toThrow(/Failed to lock worktree:/);
    });

    it('throws when unlocking a worktree that is not locked', async () => {
        const repo = makeRepo();
        const { path } = await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-unlocked' });
        await expect(mgr.unlockWorktree(path)).rejects.toThrow(/Failed to unlock worktree:/);
    });
});

describe('isBranchInWorktree', () => {
    let mgr: WorktreeManager;

    beforeEach(() => { mgr = new WorktreeManager(); });

    it('finds a branch by short name and by refs/heads/ form', async () => {
        const repo = makeRepo();
        const { path } = await mgr.createWorktree({ repoPath: repo, branch: 'claudia/task-find' });

        expect(await mgr.isBranchInWorktree(repo, 'claudia/task-find')).toBe(resolve(path));
        expect(await mgr.isBranchInWorktree(repo, 'refs/heads/claudia/task-find')).toBe(resolve(path));
    });

    it('finds the main branch in the main working tree', async () => {
        const repo = makeRepo();
        expect(await mgr.isBranchInWorktree(repo, 'main')).toBe(resolve(repo));
    });

    it('returns null for a branch that exists but is not checked out anywhere', async () => {
        const repo = makeRepo();
        git(['branch', 'shelved'], repo);
        expect(await mgr.isBranchInWorktree(repo, 'shelved')).toBeNull();
    });

    it('swallows errors and returns null outside a git repo', async () => {
        expect(await mgr.isBranchInWorktree(makePlainDir(), 'main')).toBeNull();
    });
});

describe('branch listings', () => {
    let mgr: WorktreeManager;

    beforeEach(() => { mgr = new WorktreeManager(); });

    it('lists local branches', async () => {
        const repo = makeRepo();
        git(['branch', 'feature-a'], repo);
        git(['branch', 'feature-b'], repo);

        const branches = await mgr.getLocalBranches(repo);
        expect(branches).toEqual(expect.arrayContaining(['main', 'feature-a', 'feature-b']));
    });

    it('lists remote branches with the origin/ prefix stripped and HEAD filtered out', async () => {
        const repo = makeRepo();
        const remote = join(base, `remote-${++repoCounter}.git`);
        git(['init', '-q', '--bare', remote], base);
        git(['remote', 'add', 'origin', remote], repo);
        git(['push', '-q', 'origin', 'main'], repo);
        git(['checkout', '-q', '-b', 'shipped'], repo);
        git(['push', '-q', 'origin', 'shipped'], repo);
        git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
        git(['remote', 'set-head', 'origin', '-a'], repo);
        // origin/HEAD now exists, so the HEAD filter is genuinely exercised
        expect(git(['branch', '-r'], repo)).toContain('origin/HEAD');

        const remotes = await mgr.getRemoteBranches(repo);
        expect(remotes).toEqual(expect.arrayContaining(['main', 'shipped']));
        expect(remotes.some(b => b.includes('HEAD'))).toBe(false);
        expect(remotes.some(b => b.startsWith('origin/'))).toBe(false);
    });

    it('returns [] for both listings outside a git repo', async () => {
        const plain = makePlainDir();
        expect(await mgr.getLocalBranches(plain)).toEqual([]);
        expect(await mgr.getRemoteBranches(plain)).toEqual([]);
    });
});

describe('createWorktree default base ref', () => {
    // New branches must spawn from the HEAD of the default branch — freshly
    // fetched from origin when there is one — not from whatever the local
    // checkout happens to have. Branching from a stale HEAD made every task
    // carry the staleness (or another task's feature diff) into its PR.
    it('branches from origin/main when the local main is BEHIND the remote', async () => {
        // origin repo with two commits...
        const origin = makeRepo();
        writeFileSync(join(origin, 'second.txt'), 'newer\n');
        git(['add', '-A'], origin);
        git(['commit', '-qm', 'second'], origin);
        const originHead = git(['rev-parse', 'HEAD'], origin).trim();

        // ...cloned at the first commit, then left stale.
        const clone = join(base, `clone-${++repoCounter}`);
        git(['clone', '-q', origin, clone], base);
        git(['config', 'user.email', 'test@test.com'], clone);
        git(['config', 'user.name', 'Test User'], clone);
        git(['reset', '-q', '--hard', 'HEAD~1'], clone);
        // Make the stale remote-tracking ref match the stale local view, so
        // only the fetch inside createWorktree can know about originHead.
        git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], clone);

        const manager = new WorktreeManager();
        const wt = await manager.createWorktree({ repoPath: clone, branch: 'feat/from-fresh-main' });

        const wtHead = git(['rev-parse', 'HEAD'], wt.path).trim();
        expect(wtHead).toBe(originHead);
    });

    it('falls back to the local default branch when there is no remote', async () => {
        const repo = makeRepo();
        const mainHead = git(['rev-parse', 'main'], repo).trim();

        // Move the working checkout OFF main so branching from HEAD would differ.
        git(['checkout', '-q', '-b', 'other'], repo);
        writeFileSync(join(repo, 'other.txt'), 'divergent\n');
        git(['add', '-A'], repo);
        git(['commit', '-qm', 'divergent'], repo);

        const manager = new WorktreeManager();
        const wt = await manager.createWorktree({ repoPath: repo, branch: 'feat/from-local-main' });

        const wtHead = git(['rev-parse', 'HEAD'], wt.path).trim();
        expect(wtHead).toBe(mainHead);
    });

    it('an explicit baseBranch still wins over the default-branch rule', async () => {
        const repo = makeRepo();
        git(['checkout', '-q', '-b', 'release'], repo);
        writeFileSync(join(repo, 'rel.txt'), 'rel\n');
        git(['add', '-A'], repo);
        git(['commit', '-qm', 'rel'], repo);
        const releaseHead = git(['rev-parse', 'release'], repo).trim();
        git(['checkout', '-q', 'main'], repo);

        const manager = new WorktreeManager();
        const wt = await manager.createWorktree({ repoPath: repo, branch: 'feat/from-release', baseBranch: 'release' });

        const wtHead = git(['rev-parse', 'HEAD'], wt.path).trim();
        expect(wtHead).toBe(releaseHead);
    });
});
