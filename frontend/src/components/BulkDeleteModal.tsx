import { useState, useEffect, useMemo, useRef } from 'react';
import type { DeleteRequestPayload, DeleteRequestTask } from '@claudia/shared';
import { ConfirmModal } from './ConfirmModal';

export type BulkDeleteRequest = DeleteRequestPayload;

/** One agent's answer: exactly which of ITS tasks were approved and kept. */
export interface BulkDeleteResolution {
    requestId: string;
    approvedIds: string[];
    rejectedIds: string[];
}

/** A task row, plus the request it came from and how deep it nests. */
interface Row extends DeleteRequestTask {
    requestId: string;
    depth: number;
}

/**
 * Flatten every pending request into one ordered list, each parent immediately
 * followed by its descendants.
 *
 * Requests are coalesced rather than queued: two agents in a fleet can each
 * raise a delete request, and stacking two modals means answering the same
 * question twice. Each request is still RESOLVED separately, because each has
 * its own agent waiting on its own requestId.
 *
 * The same task id can legitimately appear in two requests (two agents asking
 * to delete the same task). It renders once, under the first request that named
 * it, so the user is never asked about one task twice; both resolutions are then
 * derived from that single row.
 */
export function buildRows(requests: BulkDeleteRequest[]): Row[] {
    const rows: Row[] = [];
    const seen = new Set<string>();

    for (const request of requests) {
        const inRequest = new Set(request.tasks.map(t => t.taskId));
        const childrenOf = new Map<string, DeleteRequestTask[]>();
        const roots: DeleteRequestTask[] = [];
        for (const task of request.tasks) {
            // A parent link only nests when the parent is part of THIS request;
            // otherwise the row would be indented under an invisible parent.
            if (task.parentTaskId && inRequest.has(task.parentTaskId) && task.parentTaskId !== task.taskId) {
                const list = childrenOf.get(task.parentTaskId) ?? [];
                list.push(task);
                childrenOf.set(task.parentTaskId, list);
            } else {
                roots.push(task);
            }
        }

        // Cycle-guarded walk: cyclic parentTaskId values have occurred in
        // practice, and an unguarded recursion here would hang the renderer.
        const emitted = new Set<string>();
        const emit = (task: DeleteRequestTask, depth: number) => {
            if (emitted.has(task.taskId)) return;
            emitted.add(task.taskId);
            if (!seen.has(task.taskId)) {
                seen.add(task.taskId);
                rows.push({ ...task, requestId: request.requestId, depth });
            }
            for (const child of childrenOf.get(task.taskId) ?? []) emit(child, depth + 1);
        };
        for (const root of roots) emit(root, 0);
        // Anything left sat inside a parent cycle — render it flat, never drop it.
        for (const task of request.tasks) emit(task, 0);
    }

    return rows;
}

/**
 * One confirmation for an agent-requested delete of any number of tasks.
 *
 * Everything starts checked — the agent already proposed this exact set, so the
 * common answer is "yes, all of them" and the user only interacts to spare
 * something. Cancelling keeps every task; there is no path to a partial delete
 * the user did not choose.
 */
export function BulkDeleteModal({ requests, onResolve }: {
    requests: BulkDeleteRequest[];
    onResolve: (resolutions: BulkDeleteResolution[]) => void;
}) {
    const rows = useMemo(() => buildRows(requests), [requests]);
    const allIds = useMemo(() => rows.map(r => r.taskId), [rows]);
    const requestKey = requests.map(r => r.requestId).join('|');

    const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set(allIds));

    // Requests already on screen when the user last touched a checkbox. A NEW
    // request must not inherit the previous one's selection, but a request that
    // arrives while the dialog is open must not silently reset decisions the
    // user already made about the requests it joins.
    const knownRequestIds = useRef<Set<string>>(new Set(requests.map(r => r.requestId)));
    useEffect(() => {
        setCheckedIds(prev => {
            const next = new Set<string>();
            for (const row of rows) {
                const alreadyShown = knownRequestIds.current.has(row.requestId);
                if (!alreadyShown || prev.has(row.taskId)) next.add(row.taskId);
            }
            knownRequestIds.current = new Set(requests.map(r => r.requestId));
            return next;
        });
        // rows/requests are derived from requestKey; keying on it avoids a loop.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [requestKey]);

    /** Transitive descendants of a task within the rendered rows (cycle-guarded). */
    const descendantsOf = useMemo(() => {
        const kids = new Map<string, string[]>();
        for (const row of rows) {
            if (!row.parentTaskId) continue;
            kids.set(row.parentTaskId, [...(kids.get(row.parentTaskId) ?? []), row.taskId]);
        }
        const walk = (id: string, acc: string[], seen: Set<string>): string[] => {
            for (const child of kids.get(id) ?? []) {
                if (seen.has(child)) continue;
                seen.add(child);
                acc.push(child);
                walk(child, acc, seen);
            }
            return acc;
        };
        return (id: string) => walk(id, [], new Set([id]));
    }, [rows]);

    /**
     * Toggling a parent takes its subtasks with it. Deleting a coordinator and
     * silently leaving its fleet behind is exactly the surprise this dialog
     * exists to prevent — the user can still spare an individual child after.
     */
    const toggle = (taskId: string) => setCheckedIds(prev => {
        const next = new Set(prev);
        const turningOn = !next.has(taskId);
        for (const id of [taskId, ...descendantsOf(taskId)]) {
            if (turningOn) next.add(id); else next.delete(id);
        }
        return next;
    });

    const checkedCount = checkedIds.size;
    const total = rows.length;

    // Subtasks the user is keeping whose parent is being deleted. They survive,
    // but lose their parent row and move to the sidebar's top level — say so
    // rather than let the hierarchy rearrange itself silently.
    const orphanedCount = rows.filter(
        r => r.parentTaskId && checkedIds.has(r.parentTaskId) && !checkedIds.has(r.taskId)
    ).length;

    // Archiving kills the task's process but never touches its git worktree —
    // that stays consistent with the single-task delete path, and the branch and
    // any uncommitted work survive. Users assume "delete" reclaims the worktree.
    const checkedWorktrees = [...new Set(
        rows.filter(r => checkedIds.has(r.taskId) && r.worktree).map(r => r.worktree!)
    )];

    const resolve = (approved: Set<string>) => onResolve(requests.map(request => {
        const ids = request.tasks.map(t => t.taskId);
        return {
            requestId: request.requestId,
            approvedIds: ids.filter(id => approved.has(id)),
            rejectedIds: ids.filter(id => !approved.has(id)),
        };
    }));

    return (
        <ConfirmModal
            title={total === 1 ? 'Delete Task' : `Delete ${total} Tasks`}
            variant="danger"
            confirmLabel={checkedCount === 0 ? 'Delete none' : `Delete ${checkedCount}`}
            cancelLabel="Cancel"
            confirmDisabled={checkedCount === 0}
            onConfirm={() => resolve(checkedIds)}
            onCancel={() => resolve(new Set())}
        >
            <p>
                {requests.length === 1 ? 'An agent is' : `${requests.length} agents are`} requesting to delete{' '}
                {total === 1 ? 'this task' : `these ${total} tasks`}. Uncheck any you want to keep.
            </p>

            {total > 1 && (
                <div className="bulk-delete-actions">
                    <button type="button" onClick={() => setCheckedIds(new Set(allIds))}>Select all</button>
                    <button type="button" onClick={() => setCheckedIds(new Set())}>Select none</button>
                    <span className="bulk-delete-count">{checkedCount} of {total} selected</span>
                </div>
            )}

            <ul className="bulk-delete-list">
                {rows.map(row => {
                    const checked = checkedIds.has(row.taskId);
                    const classes = ['bulk-delete-item'];
                    if (!checked) classes.push('keeping');
                    if (row.depth > 0) classes.push('child');
                    return (
                        <li key={row.taskId}>
                            <label className={classes.join(' ')}>
                                <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => toggle(row.taskId)}
                                />
                                <span className="bulk-delete-name" title={row.taskName}>{row.taskName}</span>
                                {row.impliedByParent && <span className="bulk-delete-tag">subtask</span>}
                                {row.worktree && <span className="bulk-delete-tag">{row.worktree}</span>}
                                {!checked && <span className="bulk-delete-keep-tag">keep</span>}
                            </label>
                        </li>
                    );
                })}
            </ul>

            <div className="confirm-note">
                {checkedCount === 0
                    ? 'Nothing is selected — no task will be deleted.'
                    : `${checkedCount === 1 ? 'The task' : `${checkedCount} tasks`} will be archived and can be restored later.`}
            </div>

            {orphanedCount > 0 && (
                <div className="bulk-delete-warning">
                    {orphanedCount === 1 ? '1 subtask you are keeping' : `${orphanedCount} subtasks you are keeping`}
                    {' '}will move to the top level of the sidebar once{' '}
                    {orphanedCount === 1 ? 'its parent is' : 'their parents are'} gone.
                </div>
            )}

            {checkedWorktrees.length > 0 && (
                <div className="bulk-delete-warning">
                    {checkedWorktrees.length === 1
                        ? `The git worktree ${checkedWorktrees[0]} is left on disk`
                        : `${checkedWorktrees.length} git worktrees are left on disk`}
                    {' '}— archiving a task never removes its branch or uncommitted work.
                </div>
            )}
        </ConfirmModal>
    );
}
