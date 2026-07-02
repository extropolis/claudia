// Settlement predicate for waiting on spawned subtasks.
const IDLE_GRACE_MS = 30_000;

export function isTaskSettled(state: string, sawBusy: boolean, elapsedMs: number): boolean {
    switch (state) {
        case 'exited':
        case 'interrupted':
        case 'disconnected':
        case 'waiting_input':
        case 'archived': // a subtask archived mid-wait is terminal — settle rather than block until timeout
            return true;
        case 'idle':
            return sawBusy || elapsedMs >= IDLE_GRACE_MS;
        default: // starting, busy, unknown
            return false;
    }
}
