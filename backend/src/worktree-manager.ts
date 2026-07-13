/**
 * WorktreeManager - Wraps `git worktree` commands with safety checks
 *
 * All operations are cross-platform (Windows + Unix).
 * REST callers should use query-param based routing to avoid Windows path
 * encoding issues in URL path segments.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, lstatSync, appendFileSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve, basename } from 'path';
import { WorktreeInfo } from '@claudia/shared';
import { createLogger } from './logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('[WorktreeManager]');

/** Sanitize a branch name into a filesystem-safe directory name */
export function branchToDirectoryName(branch: string): string {
    return branch
        .replace(/^refs\/heads\//, '')
        .replace(/[\/\\:*?"<>|]/g, '-')
        .replace(/\.{2,}/g, '-')
        .replace(/^\./, '_')
        .slice(0, 100);
}

/** Parse the output of `git worktree list --porcelain` */
function parseWorktreeListOutput(stdout: string): WorktreeInfo[] {
    const results: WorktreeInfo[] = [];
    const blocks = stdout.trim().split(/\n\n+/);

    for (const block of blocks) {
        if (!block.trim()) continue;
        const lines = block.trim().split('\n');
        const info: Partial<WorktreeInfo> & { path: string; commitHash: string; branch: string; isMain: boolean; isLocked: boolean; prunable: boolean } = {
            path: '',
            commitHash: '',
            branch: '',
            isMain: false,
            isLocked: false,
            prunable: false,
        };

        let lockedReason: string | undefined;

        for (const line of lines) {
            if (line.startsWith('worktree ')) {
                info.path = line.slice('worktree '.length).trim();
            } else if (line.startsWith('HEAD ')) {
                info.commitHash = line.slice('HEAD '.length).trim();
            } else if (line.startsWith('branch ')) {
                info.branch = line.slice('branch '.length).trim();
            } else if (line === 'bare') {
                info.branch = '(bare)';
            } else if (line === 'detached') {
                info.branch = info.commitHash ? `(detached: ${info.commitHash.slice(0, 7)})` : '(detached)';
            } else if (line === 'locked') {
                info.isLocked = true;
            } else if (line.startsWith('locked ')) {
                info.isLocked = true;
                lockedReason = line.slice('locked '.length).trim();
            } else if (line === 'prunable') {
                info.prunable = true;
            } else if (line.startsWith('prunable ')) {
                info.prunable = true;
            }
        }

        if (info.path) {
            results.push({
                path: info.path,
                commitHash: info.commitHash,
                branch: info.branch || '(unknown)',
                isMain: false,
                isLocked: info.isLocked,
                lockedReason,
                prunable: info.prunable,
            });
        }
    }

    // The first worktree block in `git worktree list` is always the main working tree.
    if (results.length > 0) {
        results[0].isMain = true;
    }

    return results;
}

export class WorktreeManager {

    /**
     * Check if a directory is a linked worktree (vs. main working tree).
     * In a linked worktree, .git is a FILE containing "gitdir: ...".
     * In the main worktree, .git is a DIRECTORY.
     */
    async isLinkedWorktree(cwd: string): Promise<boolean> {
        try {
            const gitPath = join(cwd, '.git');
            if (!existsSync(gitPath)) return false;
            return lstatSync(gitPath).isFile();
        } catch {
            return false;
        }
    }

    /**
     * Get the absolute path to the main working tree from any worktree.
     * Works from both linked worktrees and the main working tree itself.
     */
    async getMainWorktreePath(cwd: string): Promise<string | null> {
        try {
            const { stdout } = await execFileAsync(
                'git',
                ['rev-parse', '--path-format=absolute', '--git-common-dir'],
                { cwd }
            );
            // Returns the shared .git directory path (e.g. /repo/.git or /repo/.git/worktrees/...)
            // Strip trailing /.git to get the main worktree path
            const gitCommonDir = stdout.trim();
            return resolve(gitCommonDir.replace(/[\/\\]\.git[\/\\]?$/, ''));
        } catch {
            return null;
        }
    }

    /**
     * List all worktrees for the repository containing `repoPath`.
     */
    async listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
        try {
            const { stdout } = await execFileAsync(
                'git',
                ['worktree', 'list', '--porcelain'],
                { cwd: repoPath }
            );
            logger.debug('listWorktrees', { repoPath, outputLen: stdout.length });
            return parseWorktreeListOutput(stdout);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error('listWorktrees failed', { repoPath, error: msg });
            throw new Error(`git worktree list failed: ${msg}`);
        }
    }

    /**
     * Create a new worktree for the given branch.
     * The worktree is placed at `{repoPath}/.claudia-worktrees/{branch-slug}/`.
     *
     * @param opts.repoPath - Main repo path (or any worktree of it)
     * @param opts.branch - Branch name to create or checkout
     * @param opts.baseBranch - Base branch to create from (default: current HEAD)
     * @param opts.createBranch - true = create new branch, false = checkout existing
     * @param opts.targetDir - Override destination directory
     */
    async createWorktree(opts: {
        repoPath: string;
        branch: string;
        baseBranch?: string;
        createBranch?: boolean;
        targetDir?: string;
    }): Promise<{ path: string; branch: string }> {
        const { repoPath, branch, baseBranch, createBranch = true } = opts;

        // Resolve to the main worktree root so the .claudia-worktrees dir is always in the repo root
        const mainPath = await this.getMainWorktreePath(repoPath) ?? repoPath;

        // Check if branch is already in use by another worktree
        const existingWorktreePath = await this.isBranchInWorktree(mainPath, branch);
        if (existingWorktreePath) {
            throw new Error(
                `Branch "${branch}" is already checked out in a worktree at ${existingWorktreePath}. ` +
                `Choose a different branch name or remove the existing worktree first.`
            );
        }

        const slug = branchToDirectoryName(branch);
        const targetDir = opts.targetDir ?? join(mainPath, '.claudia-worktrees', slug);

        // Build git worktree add args
        const args: string[] = ['worktree', 'add'];
        if (createBranch) {
            args.push('-b', branch);
        }
        args.push(targetDir);
        if (baseBranch) {
            args.push(baseBranch);
        } else if (!createBranch) {
            args.push(branch);
        }

        logger.info('createWorktree', { mainPath, branch, targetDir, createBranch, baseBranch });

        try {
            await execFileAsync('git', args, { cwd: mainPath });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error('createWorktree failed', { error: msg });
            throw new Error(`Failed to create worktree: ${msg}`);
        }

        // Ensure .claudia-worktrees is in .git/info/exclude (local gitignore, no tracked file change)
        await this.ensureWorktreeDirExcluded(mainPath);

        // Initialize submodules if present (non-blocking, best-effort)
        this.initSubmodulesAsync(targetDir);

        return { path: targetDir, branch };
    }

    /**
     * Remove a worktree from disk and git's tracking.
     * Throws if there are active Claudia tasks (check before calling, or pass force=true).
     */
    async removeWorktree(opts: {
        repoPath: string;
        worktreePath: string;
        force?: boolean;
    }): Promise<void> {
        const { repoPath, worktreePath, force = false } = opts;
        const mainPath = await this.getMainWorktreePath(repoPath) ?? repoPath;

        logger.info('removeWorktree', { mainPath, worktreePath, force });

        const args = ['worktree', 'remove', worktreePath];
        if (force) args.push('--force');

        try {
            await execFileAsync('git', args, { cwd: mainPath });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error('removeWorktree failed', { error: msg });
            throw new Error(`Failed to remove worktree: ${msg}`);
        }
    }

    /**
     * Prune stale worktree references (directories deleted outside of git).
     * Returns list of paths that were pruned.
     */
    async pruneWorktrees(repoPath: string): Promise<string[]> {
        logger.info('pruneWorktrees', { repoPath });

        // First list what's stale
        const worktrees = await this.listWorktrees(repoPath);
        const stale = worktrees.filter(wt => wt.prunable && !wt.isMain).map(wt => wt.path);

        try {
            await execFileAsync('git', ['worktree', 'prune'], { cwd: repoPath });
            logger.info('pruneWorktrees complete', { pruned: stale });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error('pruneWorktrees failed', { error: msg });
            throw new Error(`git worktree prune failed: ${msg}`);
        }

        return stale;
    }

    /**
     * Lock a worktree to prevent accidental removal.
     */
    async lockWorktree(worktreePath: string, reason?: string): Promise<void> {
        const args = ['worktree', 'lock', worktreePath];
        if (reason) args.push('--reason', reason);
        try {
            await execFileAsync('git', args, { cwd: worktreePath });
        } catch (err) {
            throw new Error(`Failed to lock worktree: ${err instanceof Error ? err.message : err}`);
        }
    }

    /**
     * Unlock a worktree.
     */
    async unlockWorktree(worktreePath: string): Promise<void> {
        try {
            await execFileAsync('git', ['worktree', 'unlock', worktreePath], { cwd: worktreePath });
        } catch (err) {
            throw new Error(`Failed to unlock worktree: ${err instanceof Error ? err.message : err}`);
        }
    }

    /**
     * Check if a branch is already checked out in any worktree.
     * Returns the worktree path if found, null otherwise.
     */
    async isBranchInWorktree(repoPath: string, branch: string): Promise<string | null> {
        try {
            const worktrees = await this.listWorktrees(repoPath);
            const normalizedBranch = branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`;
            const found = worktrees.find(wt =>
                wt.branch === normalizedBranch ||
                wt.branch === branch ||
                wt.branch.replace('refs/heads/', '') === branch.replace('refs/heads/', '')
            );
            return found?.path ?? null;
        } catch {
            return null;
        }
    }

    /**
     * Get available remote branches for a repo (for autocomplete in create modal).
     * Returns short branch names (without refs/remotes/origin/ prefix).
     */
    async getRemoteBranches(repoPath: string): Promise<string[]> {
        try {
            const { stdout } = await execFileAsync(
                'git',
                ['branch', '-r', '--format=%(refname:short)'],
                { cwd: repoPath }
            );
            return stdout.trim().split('\n')
                .filter(b => b && !b.includes('HEAD'))
                .map(b => b.replace(/^origin\//, ''));
        } catch {
            return [];
        }
    }

    /**
     * Get local branches for a repo.
     */
    async getLocalBranches(repoPath: string): Promise<string[]> {
        try {
            const { stdout } = await execFileAsync(
                'git',
                ['branch', '--format=%(refname:short)'],
                { cwd: repoPath }
            );
            return stdout.trim().split('\n').filter(Boolean);
        } catch {
            return [];
        }
    }

    /**
     * Add `.claudia-worktrees/` to `.git/info/exclude` (local-only ignore,
     * does not modify tracked .gitignore).
     */
    private async ensureWorktreeDirExcluded(repoPath: string): Promise<void> {
        try {
            // Locate .git dir (works from main worktree and linked worktrees)
            const { stdout: gitDir } = await execFileAsync(
                'git', ['rev-parse', '--git-common-dir'], { cwd: repoPath }
            );
            const excludeFile = join(gitDir.trim(), 'info', 'exclude');
            if (!existsSync(excludeFile)) return;

            const content = readFileSync(excludeFile, 'utf-8');
            if (content.includes('.claudia-worktrees/')) return;

            appendFileSync(excludeFile, '\n# Claudia worktrees\n.claudia-worktrees/\n');
            logger.info('Added .claudia-worktrees/ to .git/info/exclude', { repoPath });
        } catch (err) {
            // Non-fatal: if we can't write the exclude file, the worktree still works
            logger.warn('Failed to update .git/info/exclude', { error: err instanceof Error ? err.message : err });
        }
    }

    /**
     * Initialize submodules in a newly-created worktree (best-effort, non-blocking).
     */
    private initSubmodulesAsync(worktreePath: string): void {
        const gitmodulesPath = join(worktreePath, '.gitmodules');
        if (!existsSync(gitmodulesPath)) return;

        execFileAsync('git', ['submodule', 'update', '--init', '--recursive'], {
            cwd: worktreePath,
            timeout: 60_000,
        }).then(() => {
            logger.info('Submodules initialized in worktree', { worktreePath });
        }).catch(err => {
            logger.warn('Submodule init failed (non-fatal)', {
                worktreePath,
                error: err instanceof Error ? err.message : String(err)
            });
        });
    }
}
