/**
 * Selection logic for the periodic PR/CI badge refresh.
 *
 * Extracted as a pure function so the "which workspaces need re-polling"
 * decision is testable without a live backend, `gh`, or timers.
 *
 * Why this exists: the refresh pass used to key off task activity alone
 * (busy/starting/waiting_input) plus a one-time lazy fetch. A workspace whose
 * tasks had all gone idle was therefore refreshed exactly once and then frozen
 * — which is the common case, since a task pushes its branch, opens a PR, and
 * goes idle precisely while CI is still running. The badge kept showing the
 * state captured at push time. Refresh is now driven by whether the PR itself
 * can still change, not by what the task is doing.
 */

import { WorkspacePrInfo } from '@claudia/shared';

/** Task states that mean the task is actively doing something right now. */
const ACTIVE_TASK_STATES = new Set(['busy', 'starting', 'waiting_input']);

/**
 * True when a PR's badge can still change and is therefore worth re-polling:
 * CI still running, or the PR still open/draft (it can be merged or closed).
 * Merged/closed PRs with settled CI are terminal — polling them is wasted
 * `gh` calls.
 */
export function isPrNonTerminal(pr: WorkspacePrInfo | null | undefined): boolean {
    if (!pr) return false;
    return pr.ci === 'running' || pr.state === 'open' || pr.state === 'draft';
}

/**
 * Decide which workspace ids the next refresh pass should re-poll.
 *
 * A workspace qualifies when any of:
 *   1. it has an actively-running task;
 *   2. it has a task and has never been looked up (lazy first fetch);
 *   3. its PR is non-terminal — CI running, or still open/draft — with or
 *      without any remaining task (badges must settle to merged/failed even
 *      after the task that opened the PR is archived or deleted).
 *
 * @param tasks      current tasks (workspaceId + state)
 * @param workspaces workspaces with their last-known PR info
 * @param seen       workspace ids already looked up at least once
 */
export function selectWorkspacesToRefresh(
    tasks: { workspaceId: string; state: string }[],
    workspaces: { id: string; prInfo?: WorkspacePrInfo | null }[],
    seen: Set<string>
): string[] {
    const prByWorkspace = new Map<string, WorkspacePrInfo | null>(
        workspaces.map(w => [w.id, w.prInfo ?? null])
    );

    const toRefresh = new Set<string>();
    for (const task of tasks) {
        const id = task.workspaceId;
        if (!id || toRefresh.has(id)) continue;
        if (ACTIVE_TASK_STATES.has(task.state)) { toRefresh.add(id); continue; }
        if (!seen.has(id)) { toRefresh.add(id); continue; }
        if (isPrNonTerminal(prByWorkspace.get(id))) toRefresh.add(id);
    }

    // Workspaces with a live PR qualify on their own, not only via their tasks.
    // The task-driven loop above misses the common endgame: the task is
    // archived or deleted after pushing, the PR merges or CI fails afterwards,
    // and the badge stays frozen at its last task-era state forever. A
    // non-terminal PR is itself the reason to keep polling, whatever the tasks
    // are doing.
    for (const ws of workspaces) {
        if (toRefresh.has(ws.id)) continue;
        if (isPrNonTerminal(ws.prInfo)) toRefresh.add(ws.id);
    }
    return [...toRefresh];
}
