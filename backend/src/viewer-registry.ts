/**
 * Per-task terminal ownership for the multi-client viewer model.
 *
 * One backend now serves many clients at once — the desktop app, a browser tab
 * and a phone can all watch the same task. Terminal *input* fans out harmlessly,
 * but terminal *size* does not: a PTY has exactly one width, so before this
 * registry every `task:resize` was applied unconditionally and the last client
 * to send a width won. Three viewers with three window widths meant a PTY
 * SIGWINCH storm and a permanently garbled TUI.
 *
 * The model is deliberately minimal:
 *
 *   - Each task has at most one OWNER: the client that most recently focused it.
 *   - Only the owner's resizes reach the PTY. A non-owner's resize is dropped
 *     silently — a background tab reflowing is not a fault, so it is not an error.
 *   - An unowned task is claimed by the first client that resizes it, so a client
 *     that never sends `task:focus` (an older frontend, a script) still works.
 *   - Disconnecting releases every task the client owned; the next focus or
 *     resize claims it.
 *
 * VIEWER COUNT. `count` is the number of connected clients whose CURRENT FOCUS
 * is that task, not the number of sockets attached to the server. The UI mounts
 * exactly one `TerminalView` at a time, so a client focuses one task at a time
 * and "focused" is the same thing as "viewing" — which makes this both the
 * useful definition (it answers "who else is looking at this?") and one that can
 * be computed exactly rather than approximated.
 *
 * This class is pure in-memory bookkeeping with no I/O and no timers, so it is
 * unit-testable on its own and safe to call from a hot WS path.
 */

export interface ViewerSnapshot {
    taskId: string;
    /** Connected clients currently focused on this task. */
    count: number;
    /** The client whose resizes are applied, or null if the task is unowned. */
    ownerClientId: string | null;
}

export class ViewerRegistry {
    /** clientId -> the single task that client is currently displaying. */
    private readonly focusByClient = new Map<string, string>();
    /** taskId -> the clientId allowed to resize it. */
    private readonly ownerByTask = new Map<string, string>();

    /**
     * Record that `clientId` is now displaying `taskId`, making it the owner.
     *
     * Returns every taskId whose viewer state changed as a result — the newly
     * focused task, plus the previously focused one (which just lost a viewer,
     * and possibly its owner). Callers broadcast `task:viewers` for each.
     */
    focus(taskId: string, clientId: string): string[] {
        const previous = this.focusByClient.get(clientId);
        const alreadyOwner = this.ownerByTask.get(taskId) === clientId;
        if (previous === taskId && alreadyOwner) return [];

        const affected: string[] = [];

        if (previous !== undefined && previous !== taskId) {
            this.focusByClient.delete(clientId);
            // Focusing elsewhere gives up ownership of the task left behind, so
            // whoever is still looking at it can resize it.
            if (this.ownerByTask.get(previous) === clientId) {
                this.ownerByTask.delete(previous);
            }
            affected.push(previous);
        }

        this.focusByClient.set(clientId, taskId);
        this.ownerByTask.set(taskId, clientId);
        affected.push(taskId);

        return affected;
    }

    /**
     * Ownership check used by the resize path: true if `clientId` owns `taskId`,
     * claiming an UNOWNED task for it on the way. False means "silently drop
     * this resize" — someone else owns the terminal.
     */
    claim(taskId: string, clientId: string): boolean {
        const owner = this.ownerByTask.get(taskId);
        if (owner === undefined) {
            this.ownerByTask.set(taskId, clientId);
            return true;
        }
        return owner === clientId;
    }

    /** True only if the task is already owned by this client (never claims). */
    isOwner(taskId: string, clientId: string): boolean {
        return this.ownerByTask.get(taskId) === clientId;
    }

    owner(taskId: string): string | null {
        return this.ownerByTask.get(taskId) ?? null;
    }

    /** Connected clients currently focused on this task. */
    count(taskId: string): number {
        let n = 0;
        for (const focused of this.focusByClient.values()) {
            if (focused === taskId) n++;
        }
        return n;
    }

    /**
     * Forget a disconnected client: drop its focus and release every task it
     * owned. Returns the affected taskIds so the caller can re-broadcast.
     */
    dropClient(clientId: string): string[] {
        const affected = new Set<string>();

        const focused = this.focusByClient.get(clientId);
        if (focused !== undefined) {
            this.focusByClient.delete(clientId);
            affected.add(focused);
        }

        for (const [taskId, owner] of this.ownerByTask) {
            if (owner === clientId) {
                this.ownerByTask.delete(taskId);
                affected.add(taskId);
            }
        }

        return [...affected];
    }

    /** Forget a task entirely (destroyed/archived) so the maps cannot leak. */
    dropTask(taskId: string): void {
        this.ownerByTask.delete(taskId);
        for (const [clientId, focused] of this.focusByClient) {
            if (focused === taskId) this.focusByClient.delete(clientId);
        }
    }

    snapshot(taskId: string): ViewerSnapshot {
        return { taskId, count: this.count(taskId), ownerClientId: this.owner(taskId) };
    }
}
