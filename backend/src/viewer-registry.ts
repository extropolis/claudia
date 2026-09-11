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
 * SPLIT SCREEN. A client can display several terminals at once (one per pane).
 * Such a client declares the full set with `task:setVisible`, and from then on:
 *
 *   - it is counted as a viewer of EVERY task in that set, and
 *   - focusing one pane does NOT give up ownership of the other panes it is
 *     still showing. Without this, mounting pane B released pane A, and a second
 *     client (a phone) resizing A would silently claim it and shrink the PTY
 *     underneath a desktop that is actively displaying it.
 *
 *   A task leaves the client's view — losing that viewer, and the client's
 *   ownership — only when a later `task:setVisible` omits it (its pane closed
 *   or was pointed at another task), or when the client disconnects.
 *
 *   A client that never declares a set (an older frontend, a script, the mobile
 *   page before it sends one) keeps the original single-focus behaviour:
 *   focusing a new task releases the previous one.
 *
 * VIEWER COUNT. `count` is the number of connected clients currently DISPLAYING
 * the task — its focus for a single-focus client, its declared set for a
 * split-screen client — not the number of sockets attached to the server.
 *
 * This class is pure in-memory bookkeeping with no I/O and no timers, so it is
 * unit-testable on its own and safe to call from a hot WS path.
 */

export interface ViewerSnapshot {
    taskId: string;
    /** Connected clients currently displaying this task. */
    count: number;
    /** The client whose resizes are applied, or null if the task is unowned. */
    ownerClientId: string | null;
}

export class ViewerRegistry {
    /** clientId -> every task that client is currently displaying. */
    private readonly viewingByClient = new Map<string, Set<string>>();
    /**
     * clientId -> the visible set it declared with `task:setVisible`. Present
     * only for split-screen-aware clients; its absence is what selects the
     * legacy single-focus behaviour in focus().
     */
    private readonly declaredByClient = new Map<string, Set<string>>();
    /** taskId -> the clientId allowed to resize it. */
    private readonly ownerByTask = new Map<string, string>();

    private viewing(clientId: string): Set<string> {
        let set = this.viewingByClient.get(clientId);
        if (!set) {
            set = new Set();
            this.viewingByClient.set(clientId, set);
        }
        return set;
    }

    /** Stop counting `clientId` as a viewer of `taskId` and drop its ownership. */
    private leave(clientId: string, taskId: string): void {
        this.viewingByClient.get(clientId)?.delete(taskId);
        if (this.ownerByTask.get(taskId) === clientId) {
            this.ownerByTask.delete(taskId);
        }
    }

    /**
     * Record that `clientId` is now displaying `taskId`, making it the owner.
     *
     * A single-focus client gives up every other task it was displaying. A
     * split-screen client keeps the tasks in its declared visible set.
     *
     * Returns every taskId whose viewer state changed as a result — the newly
     * focused task, plus any task left behind (which just lost a viewer, and
     * possibly its owner). Callers broadcast `task:viewers` for each.
     */
    focus(taskId: string, clientId: string): string[] {
        const viewing = this.viewing(clientId);
        const declared = this.declaredByClient.get(clientId);
        const affected: string[] = [];

        for (const previous of [...viewing]) {
            if (previous === taskId || declared?.has(previous)) continue;
            // Looking elsewhere gives up ownership of the task left behind, so
            // whoever is still looking at it can resize it.
            this.leave(clientId, previous);
            affected.push(previous);
        }

        const alreadyOwner = this.ownerByTask.get(taskId) === clientId;
        if (viewing.has(taskId) && alreadyOwner) return affected;

        viewing.add(taskId);
        this.ownerByTask.set(taskId, clientId);
        affected.push(taskId);
        return affected;
    }

    /**
     * Split screen: `clientId` is displaying exactly `taskIds` (one per pane).
     *
     * Tasks absent from the set stop being viewed by this client and lose it as
     * owner; tasks new to the set gain it as a viewer. Ownership is NOT granted
     * here — that stays with focus(), which each pane sends when it mounts or
     * is clicked, so declaring a layout never steals a terminal from another
     * client.
     *
     * Returns every taskId whose viewer state changed.
     */
    setVisible(clientId: string, taskIds: string[]): string[] {
        const next = new Set(taskIds.filter((id) => typeof id === 'string' && id.length > 0));
        this.declaredByClient.set(clientId, next);
        const viewing = this.viewing(clientId);
        const affected: string[] = [];

        for (const previous of [...viewing]) {
            if (next.has(previous)) continue;
            this.leave(clientId, previous);
            affected.push(previous);
        }
        for (const id of next) {
            if (viewing.has(id)) continue;
            viewing.add(id);
            affected.push(id);
        }
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

    /** Connected clients currently displaying this task. */
    count(taskId: string): number {
        let n = 0;
        for (const viewing of this.viewingByClient.values()) {
            if (viewing.has(taskId)) n++;
        }
        return n;
    }

    /**
     * Forget a disconnected client: drop everything it was displaying and
     * release every task it owned. Returns the affected taskIds so the caller
     * can re-broadcast.
     */
    dropClient(clientId: string): string[] {
        const affected = new Set<string>(this.viewingByClient.get(clientId) ?? []);
        this.viewingByClient.delete(clientId);
        this.declaredByClient.delete(clientId);

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
        for (const viewing of this.viewingByClient.values()) viewing.delete(taskId);
        for (const declared of this.declaredByClient.values()) declared.delete(taskId);
    }

    snapshot(taskId: string): ViewerSnapshot {
        return { taskId, count: this.count(taskId), ownerClientId: this.owner(taskId) };
    }
}
