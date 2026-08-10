/**
 * Archived-worktree retention sweep.
 *
 * Implements docs/superpowers/specs/2026-07-18-archived-task-worktree-retention-design.md:
 * worktrees whose owning tasks are ARCHIVED are removed (folder + workspace
 * record + archived-task metadata) once the newest owning task is older than
 * `worktreeRetentionDays`. Worktrees with NO owning task anywhere (orphans)
 * are removed immediately. Worktrees referenced by any live/disconnected task
 * are NEVER touched. Every removal and every skip is logged with its reason.
 *
 * `worktreeRetentionDays = 0` disables the archived sweep (orphan removal
 * still runs — an orphan has no owner to wait for).
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from './logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('[WorktreeReaper]');

export interface WorktreeRecord {
    id: string;                 // absolute worktree path (workspace id)
    worktreeParentId: string;   // root repo path
}

export interface TaskRef {
    id: string;
    workspaceId: string;
    lastActivity: string | Date;
}

export type SweepDecision =
    | { action: 'skip'; reason: string }
    | { action: 'remove'; reason: 'orphan' | 'retention-expired'; archivedTaskIds: string[] };

/**
 * Pure decision function — unit-testable without filesystem/git.
 */
export function classifyWorktree(
    record: WorktreeRecord,
    activeTasks: TaskRef[],          // live + disconnected (getAllTasks)
    archivedTasks: TaskRef[],
    now: number,
    retentionDays: number,
): SweepDecision {
    const referencedByActive = activeTasks.some(t => t.workspaceId === record.id);
    if (referencedByActive) {
        return { action: 'skip', reason: 'referenced by a live/disconnected task' };
    }

    const owners = archivedTasks.filter(t => t.workspaceId === record.id);
    if (owners.length === 0) {
        return { action: 'remove', reason: 'orphan', archivedTaskIds: [] };
    }

    if (retentionDays === 0) {
        return { action: 'skip', reason: 'archived sweep disabled (retentionDays=0)' };
    }

    const newest = Math.max(...owners.map(t => new Date(t.lastActivity).getTime()));
    const ageMs = now - newest;
    const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
    if (ageMs < retentionMs) {
        const daysLeft = Math.ceil((retentionMs - ageMs) / (24 * 60 * 60 * 1000));
        return { action: 'skip', reason: `retained (${daysLeft}d left of ${retentionDays}d)` };
    }
    return { action: 'remove', reason: 'retention-expired', archivedTaskIds: owners.map(t => t.id) };
}

/**
 * Force-remove a git worktree; on failure, try unlocking first then retry
 * once (the spec's "--force --force" semantics for locked worktrees).
 */
export async function removeWorktreeWithUnlockRetry(
    repoPath: string,
    worktreePath: string,
): Promise<void> {
    const remove = () => execFileAsync('git', ['-C', repoPath, 'worktree', 'remove', '--force', worktreePath]);
    try {
        await remove();
    } catch (firstErr) {
        try {
            await execFileAsync('git', ['-C', repoPath, 'worktree', 'unlock', worktreePath]);
            await remove();
        } catch {
            throw firstErr;
        }
    }
}
