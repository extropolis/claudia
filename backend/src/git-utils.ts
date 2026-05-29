import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { TaskGitState, FileDiff } from '@claudia/shared';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/** Validate a git commit hash (full or abbreviated SHA-1) */
function isValidCommitHash(hash: string): boolean {
    return /^[a-f0-9]{4,40}$/i.test(hash);
}

/** Validate a git branch/ref name (no shell metacharacters) */
function isValidBranchName(name: string): boolean {
    // Based on git-check-ref-format rules, simplified
    return /^[a-zA-Z0-9._\-/]+$/.test(name) && !name.startsWith('-');
}

/**
 * Git utilities for task revert functionality
 */

/**
 * Get the default branch name for a repository (main, master, etc.)
 * Checks the remote default, then falls back to local branch detection.
 */
export async function getDefaultBranch(cwd: string): Promise<string | null> {
    try {
        // Try to get the remote HEAD reference (most reliable)
        const { stdout } = await execAsync('git symbolic-ref refs/remotes/origin/HEAD', { cwd });
        const ref = stdout.trim(); // e.g., "refs/remotes/origin/main"
        const branch = ref.replace('refs/remotes/origin/', '');
        if (branch) return branch;
    } catch {
        // Remote HEAD not set, try common defaults
    }

    // Check if 'main' branch exists
    try {
        await execAsync('git rev-parse --verify main', { cwd });
        return 'main';
    } catch {
        // 'main' doesn't exist
    }

    // Check if 'master' branch exists
    try {
        await execAsync('git rev-parse --verify master', { cwd });
        return 'master';
    } catch {
        // 'master' doesn't exist either
    }

    return null;
}

/**
 * Get the current branch name
 */
export async function getCurrentBranch(cwd: string): Promise<string | null> {
    try {
        const { stdout } = await execAsync('git branch --show-current', { cwd });
        return stdout.trim() || null;
    } catch {
        return null;
    }
}

/**
 * Checkout a branch in a git repository
 */
export async function checkoutBranch(cwd: string, branch: string): Promise<{ success: boolean; error?: string }> {
    if (!isValidBranchName(branch)) {
        return { success: false, error: 'Invalid branch name' };
    }
    try {
        await execFileAsync('git', ['checkout', branch], { cwd });
        return { success: true };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
    }
}

/**
 * Check if a directory is a git repository
 */
export async function isGitRepo(cwd: string): Promise<boolean> {
    try {
        await execAsync('git rev-parse --git-dir', { cwd });
        return true;
    } catch {
        return false;
    }
}

/**
 * Get the current HEAD commit hash
 */
export async function getHeadCommit(cwd: string): Promise<string | null> {
    try {
        const { stdout } = await execAsync('git rev-parse HEAD', { cwd });
        return stdout.trim();
    } catch {
        return null;
    }
}

/**
 * Check if there are uncommitted changes (staged or unstaged)
 */
export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
    try {
        const { stdout } = await execAsync('git status --porcelain', { cwd });
        return stdout.trim().length > 0;
    } catch {
        return false;
    }
}

/**
 * Get list of modified files (both staged and unstaged)
 */
export async function getModifiedFiles(cwd: string): Promise<string[]> {
    try {
        const { stdout } = await execAsync('git status --porcelain', { cwd });
        return stdout.trim().split('\n')
            .filter(line => line.length > 0)
            .map(line => line.substring(3)); // Remove status prefix (e.g., " M ", "?? ")
    } catch {
        return [];
    }
}

/**
 * Get files changed between two commits
 */
export async function getFilesBetweenCommits(cwd: string, fromCommit: string, toCommit: string): Promise<string[]> {
    if (!isValidCommitHash(fromCommit) || !isValidCommitHash(toCommit)) return [];
    try {
        const { stdout } = await execFileAsync('git', ['diff', '--name-only', fromCommit, toCommit], { cwd });
        return stdout.trim().split('\n').filter(f => f.length > 0);
    } catch {
        return [];
    }
}

/**
 * Count commits between two commits (how many commits is fromCommit behind toCommit)
 */
export async function countCommitsBetween(cwd: string, fromCommit: string, toCommit: string): Promise<number> {
    if (!isValidCommitHash(fromCommit) || !isValidCommitHash(toCommit)) return -1;
    try {
        const { stdout } = await execFileAsync('git', ['rev-list', '--count', `${fromCommit}..${toCommit}`], { cwd });
        return parseInt(stdout.trim(), 10) || 0;
    } catch {
        return -1; // Error case
    }
}

/**
 * Check if a commit exists in the repository
 */
export async function commitExists(cwd: string, commit: string): Promise<boolean> {
    if (!isValidCommitHash(commit)) return false;
    try {
        await execFileAsync('git', ['cat-file', '-t', commit], { cwd });
        return true;
    } catch {
        return false;
    }
}

/**
 * Capture git state before task starts
 */
export async function captureGitStateBefore(cwd: string): Promise<Partial<TaskGitState> | null> {
    const isRepo = await isGitRepo(cwd);
    if (!isRepo) {
        console.log(`[GitUtils] ${cwd} is not a git repo, skipping git state capture`);
        return null;
    }

    const commitBefore = await getHeadCommit(cwd);
    if (!commitBefore) {
        console.log(`[GitUtils] Could not get HEAD commit for ${cwd}`);
        return null;
    }

    const uncommittedBefore = await hasUncommittedChanges(cwd);

    console.log(`[GitUtils] Captured before state: commit=${commitBefore.substring(0, 7)}, uncommitted=${uncommittedBefore}`);

    return {
        commitBefore,
        uncommittedBefore,
        filesModified: [],
        canRevert: true, // Will be updated after task completes
    };
}

/**
 * Capture git state after task completes
 */
export async function captureGitStateAfter(
    cwd: string,
    beforeState: Partial<TaskGitState>
): Promise<TaskGitState> {
    const commitAfter = await getHeadCommit(cwd);
    const hasUncommitted = await hasUncommittedChanges(cwd);

    // Get files that changed
    let filesModified: string[] = [];

    // Files changed in commits since before
    if (beforeState.commitBefore && commitAfter && beforeState.commitBefore !== commitAfter) {
        filesModified = await getFilesBetweenCommits(cwd, beforeState.commitBefore, commitAfter);
    }

    // Also include currently modified files (uncommitted changes)
    if (hasUncommitted) {
        const currentModified = await getModifiedFiles(cwd);
        filesModified = [...new Set([...filesModified, ...currentModified])];
    }

    // Determine if we can revert
    // Can revert if:
    // 1. There were no uncommitted changes before (we can safely git reset)
    // 2. OR commit hasn't changed (only uncommitted changes to deal with)
    const canRevert = !beforeState.uncommittedBefore || beforeState.commitBefore === commitAfter;

    console.log(`[GitUtils] Captured after state: commit=${commitAfter?.substring(0, 7)}, files=${filesModified.length}, canRevert=${canRevert}`);

    return {
        commitBefore: beforeState.commitBefore || '',
        commitAfter: commitAfter || undefined,
        uncommittedBefore: beforeState.uncommittedBefore || false,
        filesModified,
        canRevert,
    };
}

// Maximum number of commits we'll allow reverting across
// Beyond this, the task is considered stale and revert is blocked
const MAX_REVERT_COMMITS = 5;

/**
 * Detect if a directory is a git-linked worktree (not the main working tree).
 * In a linked worktree, `.git` is a FILE; in the main working tree it is a DIRECTORY.
 */
export async function isLinkedWorktree(cwd: string): Promise<boolean> {
    try {
        const { lstatSync, existsSync } = await import('fs');
        const { join } = await import('path');
        const gitPath = join(cwd, '.git');
        if (!existsSync(gitPath)) return false;
        return lstatSync(gitPath).isFile();
    } catch {
        return false;
    }
}

/**
 * Get the absolute path to the main working tree from any worktree.
 * Uses `git rev-parse --path-format=absolute --git-common-dir` which works in both
 * the main working tree and in linked worktrees.
 */
export async function getMainWorktreePath(cwd: string): Promise<string | null> {
    try {
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const { resolve } = await import('path');
        const execFileA = promisify(execFile);
        const { stdout } = await execFileA(
            'git',
            ['rev-parse', '--path-format=absolute', '--git-common-dir'],
            { cwd }
        );
        // Strip trailing /.git[/] to get the main worktree directory
        return resolve(stdout.trim().replace(/[\/\\]\.git[\/\\]?$/, ''));
    } catch {
        return null;
    }
}

/**
 * Revert changes made by a task
 * This will:
 * 1. Reset to the commit before the task started
 * 2. Optionally clean untracked files
 *
 * Safety: Refuses to revert if the stored commitBefore is too far behind current HEAD
 */
export async function revertTaskChanges(
    cwd: string,
    gitState: TaskGitState,
    cleanUntracked: boolean = false
): Promise<{ success: boolean; error?: string; filesReverted: string[] }> {
    try {
        if (!gitState.canRevert) {
            return {
                success: false,
                error: 'Cannot revert: there were uncommitted changes before the task started',
                filesReverted: []
            };
        }

        // Get current HEAD to compare against
        const currentHead = await getHeadCommit(cwd);
        if (!currentHead) {
            return {
                success: false,
                error: 'Cannot determine current HEAD commit',
                filesReverted: []
            };
        }

        // Check if commitBefore still exists
        if (!await commitExists(cwd, gitState.commitBefore)) {
            return {
                success: false,
                error: `Target commit ${gitState.commitBefore.substring(0, 7)} no longer exists in repository`,
                filesReverted: []
            };
        }

        // Safety check: count how many commits we'd be reverting
        // Compare against CURRENT head, not the stored commitAfter (which may be stale)
        if (gitState.commitBefore !== currentHead) {
            const commitsBehind = await countCommitsBetween(cwd, gitState.commitBefore, currentHead);

            if (commitsBehind < 0) {
                return {
                    success: false,
                    error: 'Could not determine commit distance - revert blocked for safety',
                    filesReverted: []
                };
            }

            if (commitsBehind > MAX_REVERT_COMMITS) {
                return {
                    success: false,
                    error: `Revert blocked: would undo ${commitsBehind} commits (max ${MAX_REVERT_COMMITS}). ` +
                           `The task's snapshot is too old. Use git manually if you need to revert.`,
                    filesReverted: []
                };
            }

            console.log(`[GitUtils] Revert will undo ${commitsBehind} commit(s)`);
        }

        // First, check if there are uncommitted changes now
        const hasUncommitted = await hasUncommittedChanges(cwd);

        // If commit changed, reset to before commit
        if (currentHead !== gitState.commitBefore) {
            if (!isValidCommitHash(gitState.commitBefore)) {
                return { success: false, error: 'Invalid commit hash in stored git state', filesReverted: [] };
            }
            console.log(`[GitUtils] Resetting to commit ${gitState.commitBefore.substring(0, 7)} (undoing ${await countCommitsBetween(cwd, gitState.commitBefore, currentHead)} commits)`);
            await execFileAsync('git', ['reset', '--hard', gitState.commitBefore], { cwd });
        } else if (hasUncommitted) {
            // Just discard uncommitted changes
            console.log(`[GitUtils] Discarding uncommitted changes`);
            await execFileAsync('git', ['checkout', '--', '.'], { cwd });
        }

        // Optionally clean untracked files
        if (cleanUntracked) {
            console.log(`[GitUtils] Cleaning untracked files`);
            await execFileAsync('git', ['clean', '-fd'], { cwd });
        }

        return {
            success: true,
            filesReverted: gitState.filesModified
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[GitUtils] Revert failed:`, message);
        return {
            success: false,
            error: message,
            filesReverted: []
        };
    }
}
