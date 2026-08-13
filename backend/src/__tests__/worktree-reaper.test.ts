import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import {
    classifyWorktree,
    removeWorktreeWithUnlockRetry,
    type TaskRef,
    type WorktreeRecord,
} from '../worktree-reaper.js';

// The suite below shells out to real git repeatedly; the 10s project default
// flakes under load and on slow CI runners. File-scoped — the project default
// is unchanged.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

const WT: WorktreeRecord = { id: '/repo/.claudia-worktrees/wt-1', worktreeParentId: '/repo' };
const NOW = new Date('2026-07-24T12:00:00Z').getTime();
const daysAgo = (d: number) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();
const task = (workspaceId: string, lastActivity: string, id = 't1'): TaskRef => ({ id, workspaceId, lastActivity });

describe('classifyWorktree (retention spec rules)', () => {
    it('NEVER removes a worktree referenced by a live/disconnected task', () => {
        const d = classifyWorktree(WT, [task(WT.id, daysAgo(100))], [task(WT.id, daysAgo(100), 'a1')], NOW, 30);
        expect(d).toEqual({ action: 'skip', reason: 'referenced by a live/disconnected task' });
    });

    it('removes orphans (no owning task anywhere) immediately', () => {
        const d = classifyWorktree(WT, [task('/repo', daysAgo(1))], [], NOW, 30);
        expect(d).toEqual({ action: 'remove', reason: 'orphan', archivedTaskIds: [] });
    });

    it('orphan removal runs even when the archived sweep is disabled', () => {
        const d = classifyWorktree(WT, [], [], NOW, 0);
        expect(d.action).toBe('remove');
    });

    it('retains archived-owner worktrees inside the retention window', () => {
        const d = classifyWorktree(WT, [], [task(WT.id, daysAgo(3), 'a1')], NOW, 30);
        expect(d.action).toBe('skip');
        expect((d as { reason: string }).reason).toContain('retained');
    });

    it('removes archived-owner worktrees past the retention window, listing owner task ids', () => {
        const d = classifyWorktree(WT, [], [task(WT.id, daysAgo(31), 'a1'), task(WT.id, daysAgo(45), 'a2')], NOW, 30);
        expect(d).toEqual({ action: 'remove', reason: 'retention-expired', archivedTaskIds: ['a1', 'a2'] });
    });

    it('uses the NEWEST owning task for the age check', () => {
        // one owner 45d old, another 5d old → newest wins → retained
        const d = classifyWorktree(WT, [], [task(WT.id, daysAgo(45), 'a1'), task(WT.id, daysAgo(5), 'a2')], NOW, 30);
        expect(d.action).toBe('skip');
    });

    it('retentionDays=0 disables the archived sweep (but not orphans)', () => {
        const d = classifyWorktree(WT, [], [task(WT.id, daysAgo(400), 'a1')], NOW, 0);
        expect(d).toEqual({ action: 'skip', reason: 'archived sweep disabled (retentionDays=0)' });
    });

    it('ignores tasks belonging to OTHER worktrees', () => {
        const d = classifyWorktree(WT, [task('/repo/.claudia-worktrees/wt-2', daysAgo(1))], [], NOW, 30);
        expect(d.action).toBe('remove'); // still an orphan — the active task is elsewhere
    });
});

/**
 * removeWorktreeWithUnlockRetry — driven against REAL temp git repos.
 * Base dirs live under homedir(), NOT os.tmpdir(): on macOS tmpdir resolves
 * under /var, which validateWorkspacePath blocklists.
 */
describe('removeWorktreeWithUnlockRetry (real git)', () => {
    let base: string;
    let counter = 0;

    const git = (args: string[], cwd: string): string =>
        execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

    function makeRepo(): string {
        const dir = join(base, `repo-${++counter}`);
        mkdirSync(dir, { recursive: true });
        git(['init', '-q', '-b', 'main', '.'], dir);
        git(['config', 'user.email', 'test@test.com'], dir);
        git(['config', 'user.name', 'Test User'], dir);
        git(['config', 'commit.gpgsign', 'false'], dir);
        // Windows git installs default core.autocrlf=true, which would rewrite
        // the LF below to CRLF on checkout and break the byte-exact assertion
        // in the primary-working-tree guardrail test.
        git(['config', 'core.autocrlf', 'false'], dir);
        writeFileSync(join(dir, 'README.md'), 'hello\n');
        git(['add', '-A'], dir);
        git(['commit', '-qm', 'init'], dir);
        return dir;
    }

    function addWorktree(repo: string, branch: string): string {
        const wt = join(repo, '.claudia-worktrees', branch.replace(/\//g, '-'));
        git(['worktree', 'add', '-q', '-b', branch, wt], repo);
        return wt;
    }

    let originalCeiling: string | undefined;

    beforeAll(() => {
        base = mkdtempSync(join(homedir(), '.claudia-test-wtr-'));
        // Stop git's upward .git search at homedir. Without this, the
        // "not a git repository" case below would spuriously succeed for a
        // developer who version-controls their home directory (dotfile repos).
        originalCeiling = process.env.GIT_CEILING_DIRECTORIES;
        process.env.GIT_CEILING_DIRECTORIES = homedir();
    });

    afterAll(() => {
        if (originalCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
        else process.env.GIT_CEILING_DIRECTORIES = originalCeiling;
        try {
            rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch { /* ignore */ }
    });

    it('removes a clean worktree on the first attempt', async () => {
        const repo = makeRepo();
        const wt = addWorktree(repo, 'claudia/task-clean');

        await removeWorktreeWithUnlockRetry(repo, wt);

        expect(existsSync(wt)).toBe(false);
        // git prints porcelain paths with forward slashes on every platform,
        // so normalise before comparing or this assertion passes vacuously on
        // Windows (where resolve() yields backslashes).
        const slash = (p: string) => p.replace(/\\/g, '/');
        expect(slash(git(['worktree', 'list', '--porcelain'], repo)))
            .not.toContain(slash(resolve(wt)));
    });

    it('unlocks and retries when the first removal fails because the worktree is LOCKED', async () => {
        const repo = makeRepo();
        const wt = addWorktree(repo, 'claudia/task-locked');
        git(['worktree', 'lock', '--reason', 'held', wt], repo);

        // sanity: a plain --force remove genuinely fails while locked
        expect(() => git(['worktree', 'remove', '--force', wt], repo)).toThrow();

        await removeWorktreeWithUnlockRetry(repo, wt);
        expect(existsSync(wt)).toBe(false);
    });

    it('rethrows the ORIGINAL failure (not the unlock failure) when the retry cannot help', async () => {
        const repo = makeRepo();
        const missing = join(repo, '.claudia-worktrees', 'never-existed');

        await expect(removeWorktreeWithUnlockRetry(repo, missing))
            .rejects.toThrow(/is not a working tree|No such file or directory/);
    });

    it('propagates failure when repoPath is not a git repository', async () => {
        const plain = join(base, `plain-${++counter}`);
        mkdirSync(plain, { recursive: true });

        await expect(removeWorktreeWithUnlockRetry(plain, join(plain, 'wt')))
            .rejects.toThrow(/not a git repository/);
    });

    it('GUARDRAIL: cannot destroy the primary working tree, even with --force', async () => {
        const repo = makeRepo();

        await expect(removeWorktreeWithUnlockRetry(repo, repo))
            .rejects.toThrow(/is a main working tree/);

        expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('hello\n');
        expect(existsSync(join(repo, '.git'))).toBe(true);
    });

    it('CHARACTERIZATION (known data-loss surface): the retention sweep --force-removes worktrees holding uncommitted work', async () => {
        // removeWorktreeWithUnlockRetry hard-codes `--force` and performs no
        // dirty check. classifyWorktree decides purely on task age/ownership,
        // so an orphaned or retention-expired worktree with uncommitted (or
        // committed-but-unpushed) work is deleted unrecoverably and silently.
        // Pinned as characterization, not endorsed: this test exists so that a
        // future dirty-check lands as a deliberate, visible change here.
        const repo = makeRepo();
        const wt = addWorktree(repo, 'claudia/task-dirty');
        writeFileSync(join(wt, 'unsaved-work.txt'), 'never pushed anywhere\n');
        writeFileSync(join(wt, 'README.md'), 'edited but not committed\n');

        await removeWorktreeWithUnlockRetry(repo, wt);
        expect(existsSync(wt)).toBe(false);
    });
});
