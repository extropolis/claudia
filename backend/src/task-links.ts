// Pure helpers for parent/child task links. Only parentTaskId is stored;
// children are always derived, so links cannot drift out of sync.

export function resolveParentLink(
    requestedParentId: string | undefined,
    existingTaskIds: ReadonlySet<string>,
): string | undefined {
    if (!requestedParentId) return undefined;
    return existingTaskIds.has(requestedParentId) ? requestedParentId : undefined;
}

export function collectOrphanedChildIds(
    tasks: Iterable<{ id: string; parentTaskId?: string }>,
    removedTaskId: string,
): string[] {
    const orphaned: string[] = [];
    for (const t of tasks) {
        if (t.parentTaskId === removedTaskId) orphaned.push(t.id);
    }
    return orphaned;
}
