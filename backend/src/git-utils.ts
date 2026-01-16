import { exec } from 'child_process';
import { promisify } from 'util';
import { TaskGitState } from '@claudia/shared';

const execAsync = promisify(exec);

/**
 * Git utilities for task revert functionality
 */

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
    try {
        const { stdout } = await execAsync(`git diff --name-only ${fromCommit} ${toCommit}`, { cwd });
        return stdout.trim().split('\n').filter(f => f.length > 0);
    } catch {
        return [];
    }
}

/**
 * Count commits between two commits (how many commits is fromCommit behind toCommit)
 */
export async function countCommitsBetween(cwd: string, fromCommit: string, toCommit: string): Promise<number> {
    try {
        const { stdout } = await execAsync(`git rev-list --count ${fromCommit}..${toCommit}`, { cwd });
        return parseInt(stdout.trim(), 10) || 0;
    } catch {
        return -1; // Error case
    }
}

/**
 * Check if a commit exists in the repository
 */
export async function commitExists(cwd: string, commit: string): Promise<boolean> {
    try {
        await execAsync(`git cat-file -t ${commit}`, { cwd });
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
            console.log(`[GitUtils] Resetting to commit ${gitState.commitBefore.substring(0, 7)} (undoing ${await countCommitsBetween(cwd, gitState.commitBefore, currentHead)} commits)`);
            await execAsync(`git reset --hard ${gitState.commitBefore}`, { cwd });
        } else if (hasUncommitted) {
            // Just discard uncommitted changes
            console.log(`[GitUtils] Discarding uncommitted changes`);
            await execAsync('git checkout -- .', { cwd });
        }

        // Optionally clean untracked files
        if (cleanUntracked) {
            console.log(`[GitUtils] Cleaning untracked files`);
            await execAsync('git clean -fd', { cwd });
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
