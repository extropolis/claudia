import { useState, useEffect, useMemo } from 'react';
import { ConfirmModal } from './ConfirmModal';

export interface BulkDeleteRequest {
    requestId: string;
    tasks: { taskId: string; taskName: string }[];
}

/**
 * One confirmation for an agent-requested delete of any number of tasks.
 *
 * Everything starts checked — the agent already proposed this exact set, so the
 * common case is "yes, all of them" and the user only interacts to spare something.
 * Cancelling keeps every task, never a partial delete.
 */
export function BulkDeleteModal({ request, onResolve }: {
    request: BulkDeleteRequest;
    onResolve: (approvedIds: string[], rejectedIds: string[]) => void;
}) {
    const allIds = useMemo(() => request.tasks.map(t => t.taskId), [request.tasks]);
    const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set(allIds));

    // A new request must not inherit the previous one's selection.
    useEffect(() => { setCheckedIds(new Set(allIds)); }, [request.requestId, allIds]);

    const toggle = (taskId: string) => setCheckedIds(prev => {
        const next = new Set(prev);
        if (!next.delete(taskId)) next.add(taskId);
        return next;
    });

    const checkedCount = checkedIds.size;
    const total = request.tasks.length;

    return (
        <ConfirmModal
            title={total === 1 ? 'Delete Task' : `Delete ${total} Tasks`}
            variant="danger"
            confirmLabel={checkedCount === 0 ? 'Delete none' : `Delete ${checkedCount}`}
            cancelLabel="Cancel"
            confirmDisabled={checkedCount === 0}
            onConfirm={() => onResolve(
                allIds.filter(id => checkedIds.has(id)),
                allIds.filter(id => !checkedIds.has(id)),
            )}
            onCancel={() => onResolve([], allIds)}
        >
            <p>
                An agent is requesting to delete{' '}
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
                {request.tasks.map(({ taskId, taskName }) => {
                    const checked = checkedIds.has(taskId);
                    return (
                        <li key={taskId}>
                            <label className={checked ? 'bulk-delete-item' : 'bulk-delete-item keeping'}>
                                <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => toggle(taskId)}
                                />
                                <span className="bulk-delete-name" title={taskName}>{taskName}</span>
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
        </ConfirmModal>
    );
}
