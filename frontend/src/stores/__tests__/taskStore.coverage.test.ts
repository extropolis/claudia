import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useTaskStore } from '../taskStore';
import type {
    Task,
    TaskState,
    Workspace,
    ScheduledTask,
    TaskTokenUsage,
    WorkspacePrInfo,
} from '@claudia/shared';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WS_A = '/Users/test/work/alpha';
const WS_B = '/Users/test/work/beta';

const mkWorkspace = (id: string, over: Partial<Workspace> = {}): Workspace => ({
    id,
    name: id.split('/').pop() || id,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
});

const mkTask = (id: string, over: Partial<Task> = {}): Task => ({
    id,
    prompt: `prompt for ${id}`,
    state: 'idle' as TaskState,
    workspaceId: WS_A,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastActivity: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
});

const mkScheduled = (id: string, over: Partial<ScheduledTask> = {}): ScheduledTask => ({
    id,
    taskId: 'task-1',
    workspaceId: WS_A,
    cronExpression: '*/5 * * * *',
    prompt: 'check things',
    isRecurring: true,
    isPaused: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-04T00:00:00.000Z',
    fireCount: 0,
    ...over,
});

const mkTokenUsage = (over: Partial<TaskTokenUsage> = {}): TaskTokenUsage => ({
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalCostUsd: 0.42,
    modelBreakdown: {},
    lastUpdated: '2026-01-01T00:00:00.000Z',
    ...over,
});

const PR_OPEN: WorkspacePrInfo = {
    number: 7,
    title: 'Add coverage',
    state: 'open',
    url: 'https://example.test/pr/7',
    ci: 'running',
};

// The store is a module-level singleton. Snapshot it once (before any test
// mutates it) so every test can start from an identical, known-good state —
// including after a `persist.rehydrate()` which REPLACES the whole state object.
const PRISTINE = { ...useTaskStore.getState() };

function resetStore() {
    useTaskStore.setState(
        {
            ...PRISTINE,
            // Fresh collections so no test can leak mutations into the next one
            tasks: new Map(),
            archivedTasks: [],
            lastSelectedTaskByWorkspace: new Map(),
            workspaces: [],
            expandedWorkspaces: new Set<string>(),
            expandedWorkspacesInitialized: false,
            workspaceTaskListHeights: {},
            taskSummaries: new Map(),
            chatMessages: [],
            waitingInputNotifications: new Map(),
            taskDraftInputs: new Map(),
            scheduledTasks: new Map(),
            unreadTaskIds: new Set<string>(),
            activityLog: [],
            selectedTaskId: null,
            errorNotification: null,
            pendingDeleteRequests: [],
        },
        true, // replace — guarantees no field survives from a previous test
    );
    localStorage.clear();
}

/** Ids of the tasks in a workspace, in the store's own display sort order. */
function displayOrder(workspaceId: string): string[] {
    return Array.from(useTaskStore.getState().tasks.values())
        .filter(t => t.workspaceId === workspaceId)
        .sort((a, b) => {
            if (a.order !== undefined && b.order !== undefined) return a.order - b.order;
            if (a.order !== undefined) return -1;
            if (b.order !== undefined) return 1;
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        })
        .map(t => t.id);
}

beforeEach(() => {
    resetStore();
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// selectTask
// ---------------------------------------------------------------------------

describe('selectTask', () => {
    beforeEach(() => {
        useTaskStore.getState().setTasks([
            mkTask('t1', { workspaceId: WS_A }),
            mkTask('t2', { workspaceId: WS_B }),
        ]);
    });

    it('clears the unread badge for the task being selected', () => {
        useTaskStore.setState({ unreadTaskIds: new Set(['t1', 't2']) });

        useTaskStore.getState().selectTask('t1');

        const { selectedTaskId, unreadTaskIds } = useTaskStore.getState();
        expect(selectedTaskId).toBe('t1');
        expect(unreadTaskIds.has('t1')).toBe(false);
        expect(unreadTaskIds.has('t2')).toBe(true); // other badges untouched
    });

    it('remembers the last selected task per workspace', () => {
        useTaskStore.getState().selectTask('t1');
        useTaskStore.getState().selectTask('t2');

        const { lastSelectedTaskByWorkspace } = useTaskStore.getState();
        expect(lastSelectedTaskByWorkspace.get(WS_A)).toBe('t1');
        expect(lastSelectedTaskByWorkspace.get(WS_B)).toBe('t2');
    });

    it('leaves the unread set untouched when the selected task has no badge', () => {
        useTaskStore.setState({ unreadTaskIds: new Set(['t2']) });
        const before = useTaskStore.getState().unreadTaskIds;

        useTaskStore.getState().selectTask('t1');

        expect(useTaskStore.getState().unreadTaskIds).toBe(before);
    });

    it('selects an unknown id without recording a workspace mapping', () => {
        useTaskStore.getState().selectTask('does-not-exist');

        expect(useTaskStore.getState().selectedTaskId).toBe('does-not-exist');
        expect(useTaskStore.getState().lastSelectedTaskByWorkspace.size).toBe(0);
    });

    it('deselects with null', () => {
        useTaskStore.getState().selectTask('t1');
        useTaskStore.getState().selectTask(null);
        expect(useTaskStore.getState().selectedTaskId).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// setTasks — merge / regression protection / order preservation
// ---------------------------------------------------------------------------

describe('setTasks', () => {
    it('preserves a locally-assigned drag order when the server omits it', () => {
        useTaskStore.setState({ tasks: new Map([['t1', mkTask('t1', { order: 3 })]]) });

        // Server snapshot has no `order` field at all
        useTaskStore.getState().setTasks([mkTask('t1', { prompt: 'renamed' })]);

        const t1 = useTaskStore.getState().tasks.get('t1')!;
        expect(t1.order).toBe(3);
        expect(t1.prompt).toBe('renamed'); // rest of the server payload still applied
    });

    it('lets the server override the order when it sends one', () => {
        useTaskStore.setState({ tasks: new Map([['t1', mkTask('t1', { order: 3 })]]) });

        useTaskStore.getState().setTasks([mkTask('t1', { order: 9 })]);

        expect(useTaskStore.getState().tasks.get('t1')!.order).toBe(9);
    });

    it('keeps the local task when the incoming snapshot is older (state regression guard)', () => {
        useTaskStore.setState({
            tasks: new Map([
                ['t1', mkTask('t1', { state: 'busy', lastActivity: new Date(5000) })],
            ]),
        });

        useTaskStore.getState().setTasks([
            mkTask('t1', { state: 'idle', lastActivity: new Date(1000) }),
        ]);

        expect(useTaskStore.getState().tasks.get('t1')!.state).toBe('busy');
    });

    it('accepts the incoming task when it is newer', () => {
        useTaskStore.setState({
            tasks: new Map([
                ['t1', mkTask('t1', { state: 'busy', lastActivity: new Date(1000) })],
            ]),
        });

        useTaskStore.getState().setTasks([
            mkTask('t1', { state: 'idle', lastActivity: new Date(5000) }),
        ]);

        expect(useTaskStore.getState().tasks.get('t1')!.state).toBe('idle');
    });

    it('drops tasks missing from the snapshot and clears the selection when it vanishes', () => {
        useTaskStore.getState().setTasks([mkTask('t1'), mkTask('t2')]);
        useTaskStore.getState().selectTask('t2');

        useTaskStore.getState().setTasks([mkTask('t1')]);

        expect(useTaskStore.getState().tasks.has('t2')).toBe(false);
        expect(useTaskStore.getState().selectedTaskId).toBeNull();
    });

    it('keeps the selection when the selected task survives the snapshot', () => {
        useTaskStore.getState().setTasks([mkTask('t1'), mkTask('t2')]);
        useTaskStore.getState().selectTask('t1');

        useTaskStore.getState().setTasks([mkTask('t1'), mkTask('t3')]);

        expect(useTaskStore.getState().selectedTaskId).toBe('t1');
    });
});

// ---------------------------------------------------------------------------
// updateTask
// ---------------------------------------------------------------------------

describe('updateTask', () => {
    it('applies an update for a task the store has never seen', () => {
        useTaskStore.getState().updateTask(mkTask('t1', { state: 'busy' }));
        expect(useTaskStore.getState().tasks.get('t1')!.state).toBe('busy');
    });

    it('ignores an out-of-order (older) update', () => {
        useTaskStore.setState({
            tasks: new Map([['t1', mkTask('t1', { state: 'busy', lastActivity: new Date(5000) })]]),
        });

        useTaskStore.getState().updateTask(
            mkTask('t1', { state: 'exited', lastActivity: new Date(1000) }),
        );

        expect(useTaskStore.getState().tasks.get('t1')!.state).toBe('busy');
    });

    it('does not create a new tasks Map when nothing meaningful changed', () => {
        const existing = mkTask('t1', { state: 'idle', lastActivity: new Date(1000) });
        useTaskStore.setState({ tasks: new Map([['t1', existing]]) });
        const mapBefore = useTaskStore.getState().tasks;

        // Same timestamp, same state, same waitingInputType → no-op
        useTaskStore.getState().updateTask(mkTask('t1', { state: 'idle', lastActivity: new Date(1000) }));

        expect(useTaskStore.getState().tasks).toBe(mapBefore);
    });

    it('applies a same-timestamp update when the state changed', () => {
        useTaskStore.setState({
            tasks: new Map([['t1', mkTask('t1', { state: 'idle', lastActivity: new Date(1000) })]]),
        });

        useTaskStore.getState().updateTask(mkTask('t1', { state: 'busy', lastActivity: new Date(1000) }));

        expect(useTaskStore.getState().tasks.get('t1')!.state).toBe('busy');
    });

    it('applies a same-timestamp update when only waitingInputType changed', () => {
        useTaskStore.setState({
            tasks: new Map([
                ['t1', mkTask('t1', { state: 'waiting_input', lastActivity: new Date(1000) })],
            ]),
        });

        useTaskStore.getState().updateTask(
            mkTask('t1', {
                state: 'waiting_input',
                waitingInputType: 'permission',
                lastActivity: new Date(1000),
            }),
        );

        expect(useTaskStore.getState().tasks.get('t1')!.waitingInputType).toBe('permission');
    });

    it('preserves the local drag order when the update omits it', () => {
        useTaskStore.setState({
            tasks: new Map([['t1', mkTask('t1', { order: 2, lastActivity: new Date(1000) })]]),
        });

        useTaskStore.getState().updateTask(mkTask('t1', { state: 'busy', lastActivity: new Date(2000) }));

        const t1 = useTaskStore.getState().tasks.get('t1')!;
        expect(t1.order).toBe(2);
        expect(t1.state).toBe('busy');
    });

    it('KNOWN BUG: a PR/CI badge refresh with an unchanged timestamp+state is dropped', () => {
        // A PR/CI poll republishes the task with a new sessionWorktreePrInfo but
        // does not touch lastActivity or state (the task is idle — nothing ran).
        // updateTask's "nothing meaningfully changed" guard only compares
        // state + waitingInputType, so the badge update never reaches the UI.
        useTaskStore.setState({
            tasks: new Map([
                ['t1', mkTask('t1', {
                    state: 'idle',
                    lastActivity: new Date(1000),
                    sessionWorktreeBranch: 'claudia/task-1',
                    sessionWorktreePrInfo: null,
                })],
            ]),
        });

        useTaskStore.getState().updateTask(
            mkTask('t1', {
                state: 'idle',
                lastActivity: new Date(1000),
                sessionWorktreeBranch: 'claudia/task-1',
                sessionWorktreePrInfo: PR_OPEN,
            }),
        );

        // Documents current (buggy) behavior — the badge stays stale.
        expect(useTaskStore.getState().tasks.get('t1')!.sessionWorktreePrInfo).toBeNull();
    });

    it('KNOWN BUG: string lastActivity (the real WebSocket payload shape) disables the ordering guard', () => {
        // WS payloads are plain JSON.parse output, so `lastActivity` is a string,
        // not a Date. `lastActivity?.getTime?.() ?? 0` then yields 0 for BOTH
        // sides, so a genuinely older message is treated as same-timestamp and
        // is applied (or dropped) purely on the state comparison.
        useTaskStore.setState({
            tasks: new Map([
                ['t1', mkTask('t1', {
                    state: 'busy',
                    lastActivity: '2026-01-01T00:05:00.000Z' as unknown as Date,
                })],
            ]),
        });

        useTaskStore.getState().updateTask(
            mkTask('t1', {
                state: 'exited',
                lastActivity: '2026-01-01T00:00:00.000Z' as unknown as Date, // 5 min OLDER
            }),
        );

        // The stale message wins — this is the regression the guard was meant to stop.
        expect(useTaskStore.getState().tasks.get('t1')!.state).toBe('exited');
    });
});

// ---------------------------------------------------------------------------
// updateTaskTokenUsage
// ---------------------------------------------------------------------------

describe('updateTaskTokenUsage', () => {
    it('attaches token usage to an existing task without touching other fields', () => {
        useTaskStore.getState().addTask(mkTask('t1', { state: 'busy', order: 4 }));

        useTaskStore.getState().updateTaskTokenUsage('t1', mkTokenUsage({ totalCostUsd: 1.25 }));

        const t1 = useTaskStore.getState().tasks.get('t1')!;
        expect(t1.tokenUsage?.totalCostUsd).toBe(1.25);
        expect(t1.state).toBe('busy');
        expect(t1.order).toBe(4);
    });

    it('overwrites previous usage on a later update', () => {
        useTaskStore.getState().addTask(mkTask('t1', { tokenUsage: mkTokenUsage({ inputTokens: 10 }) }));

        useTaskStore.getState().updateTaskTokenUsage('t1', mkTokenUsage({ inputTokens: 999 }));

        expect(useTaskStore.getState().tasks.get('t1')!.tokenUsage?.inputTokens).toBe(999);
    });

    it('is a no-op for an unknown task id', () => {
        useTaskStore.getState().addTask(mkTask('t1'));
        const mapBefore = useTaskStore.getState().tasks;

        useTaskStore.getState().updateTaskTokenUsage('ghost', mkTokenUsage());

        expect(useTaskStore.getState().tasks).toBe(mapBefore);
        expect(useTaskStore.getState().tasks.has('ghost')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Archived tasks
// ---------------------------------------------------------------------------

describe('archived tasks', () => {
    it('replaces the archived list wholesale', () => {
        useTaskStore.getState().setArchivedTasks([mkTask('a1'), mkTask('a2')]);
        useTaskStore.getState().setArchivedTasks([mkTask('a3')]);

        expect(useTaskStore.getState().archivedTasks.map(t => t.id)).toEqual(['a3']);
    });

    it('removes a single archived task (unarchive/delete) and leaves the rest', () => {
        useTaskStore.getState().setArchivedTasks([mkTask('a1'), mkTask('a2'), mkTask('a3')]);

        useTaskStore.getState().removeArchivedTask('a2');

        expect(useTaskStore.getState().archivedTasks.map(t => t.id)).toEqual(['a1', 'a3']);
    });

    it('removing an unknown archived id leaves the list intact', () => {
        useTaskStore.getState().setArchivedTasks([mkTask('a1')]);

        useTaskStore.getState().removeArchivedTask('nope');

        expect(useTaskStore.getState().archivedTasks.map(t => t.id)).toEqual(['a1']);
    });

    it('toggles the archived section visibility', () => {
        expect(useTaskStore.getState().showArchivedTasks).toBe(false);
        useTaskStore.getState().setShowArchivedTasks(true);
        expect(useTaskStore.getState().showArchivedTasks).toBe(true);
        useTaskStore.getState().setShowArchivedTasks(false);
        expect(useTaskStore.getState().showArchivedTasks).toBe(false);
    });

    it('archived tasks are a separate list from live tasks', () => {
        useTaskStore.getState().addTask(mkTask('t1'));
        useTaskStore.getState().setArchivedTasks([mkTask('t1', { state: 'archived' })]);

        expect(useTaskStore.getState().tasks.has('t1')).toBe(true);
        expect(useTaskStore.getState().archivedTasks).toHaveLength(1);

        useTaskStore.getState().removeArchivedTask('t1');
        expect(useTaskStore.getState().tasks.has('t1')).toBe(true); // live task untouched
    });
});

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

describe('workspaces', () => {
    it('drops duplicate ids from a workspace snapshot, keeping the first occurrence', () => {
        const first = mkWorkspace(WS_A, { displayName: 'first' });
        const dupe = mkWorkspace(WS_A, { displayName: 'second' });

        useTaskStore.getState().setWorkspaces([first, dupe, mkWorkspace(WS_B)]);

        const { workspaces } = useTaskStore.getState();
        expect(workspaces.map(w => w.id)).toEqual([WS_A, WS_B]);
        expect(workspaces[0].displayName).toBe('first');
    });

    it('updateWorkspace replaces only the matching workspace', () => {
        useTaskStore.getState().setWorkspaces([mkWorkspace(WS_A), mkWorkspace(WS_B)]);

        useTaskStore.getState().updateWorkspace(
            mkWorkspace(WS_A, { displayName: 'Alpha renamed', prInfo: PR_OPEN }),
        );

        const { workspaces } = useTaskStore.getState();
        expect(workspaces.map(w => w.id)).toEqual([WS_A, WS_B]); // order preserved
        expect(workspaces[0].displayName).toBe('Alpha renamed');
        expect(workspaces[0].prInfo?.state).toBe('open');
        expect(workspaces[1].displayName).toBeUndefined();
    });

    it('updateWorkspace for an unknown id changes nothing', () => {
        useTaskStore.getState().setWorkspaces([mkWorkspace(WS_A)]);

        useTaskStore.getState().updateWorkspace(mkWorkspace('/not/here', { displayName: 'x' }));

        expect(useTaskStore.getState().workspaces.map(w => w.id)).toEqual([WS_A]);
    });

    it('addWorkspace appends and expands; a duplicate add is ignored', () => {
        useTaskStore.getState().addWorkspace(mkWorkspace(WS_A));
        useTaskStore.getState().addWorkspace(mkWorkspace(WS_A, { displayName: 'dupe' }));

        const { workspaces, expandedWorkspaces } = useTaskStore.getState();
        expect(workspaces).toHaveLength(1);
        expect(workspaces[0].displayName).toBeUndefined();
        expect(expandedWorkspaces.has(WS_A)).toBe(true);
    });

    it('removeWorkspace drops it from the list and from the expanded set', () => {
        useTaskStore.getState().addWorkspace(mkWorkspace(WS_A));
        useTaskStore.getState().addWorkspace(mkWorkspace(WS_B));

        useTaskStore.getState().removeWorkspace(WS_A);

        const { workspaces, expandedWorkspaces } = useTaskStore.getState();
        expect(workspaces.map(w => w.id)).toEqual([WS_B]);
        expect(expandedWorkspaces.has(WS_A)).toBe(false);
        expect(expandedWorkspaces.has(WS_B)).toBe(true);
    });

    it('reorderWorkspaces moves an entry and ignores no-op / out-of-bounds indices', () => {
        const C = mkWorkspace('/Users/test/work/gamma');
        useTaskStore.getState().setWorkspaces([mkWorkspace(WS_A), mkWorkspace(WS_B), C]);

        useTaskStore.getState().reorderWorkspaces(0, 2);
        expect(useTaskStore.getState().workspaces.map(w => w.id)).toEqual([WS_B, C.id, WS_A]);

        const snapshot = useTaskStore.getState().workspaces;
        useTaskStore.getState().reorderWorkspaces(1, 1);   // same index
        useTaskStore.getState().reorderWorkspaces(-1, 0);  // from < 0
        useTaskStore.getState().reorderWorkspaces(9, 0);   // from >= length
        useTaskStore.getState().reorderWorkspaces(0, -1);  // to < 0
        useTaskStore.getState().reorderWorkspaces(0, 9);   // to >= length
        expect(useTaskStore.getState().workspaces).toBe(snapshot);
    });

    it('toggleWorkspaceExpanded flips both ways', () => {
        useTaskStore.getState().toggleWorkspaceExpanded(WS_A);
        expect(useTaskStore.getState().expandedWorkspaces.has(WS_A)).toBe(true);
        useTaskStore.getState().toggleWorkspaceExpanded(WS_A);
        expect(useTaskStore.getState().expandedWorkspaces.has(WS_A)).toBe(false);
    });

    it('groups worktree workspaces under their parent via worktreeParentId', () => {
        const parent = mkWorkspace(WS_A);
        const wt = mkWorkspace('/Users/test/.worktrees/task-1', {
            worktreeParentId: WS_A,
            worktreeBranch: 'claudia/task-1',
        });

        useTaskStore.getState().setWorkspaces([parent, wt]);

        const { workspaces } = useTaskStore.getState();
        const children = workspaces.filter(w => w.worktreeParentId === parent.id);
        expect(children.map(w => w.id)).toEqual([wt.id]);
        expect(children[0].worktreeBranch).toBe('claudia/task-1');
        // Both are expanded on a true first load
        expect(useTaskStore.getState().expandedWorkspaces.size).toBe(2);
    });

    it('setWorkspaceColumns / SortBy / taskSortBy round-trip', () => {
        useTaskStore.getState().setWorkspaceColumns(3);
        useTaskStore.getState().setWorkspaceSortBy('manual');
        useTaskStore.getState().setTaskSortBy('last-modified');
        useTaskStore.getState().setShowProjectPicker(true);

        const s = useTaskStore.getState();
        expect(s.workspaceColumns).toBe(3);
        expect(s.workspaceSortBy).toBe('manual');
        expect(s.taskSortBy).toBe('last-modified');
        expect(s.showProjectPicker).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// reorderTasks
// ---------------------------------------------------------------------------

describe('reorderTasks', () => {
    /** Three tasks in WS_A, already carrying explicit orders 0,1,2. */
    function seedOrdered() {
        useTaskStore.setState({
            tasks: new Map([
                ['t1', mkTask('t1', { order: 0 })],
                ['t2', mkTask('t2', { order: 1 })],
                ['t3', mkTask('t3', { order: 2 })],
            ]),
        });
    }

    it('moves a task down and renumbers every task in the workspace', () => {
        seedOrdered();

        useTaskStore.getState().reorderTasks(WS_A, 0, 2);

        expect(displayOrder(WS_A)).toEqual(['t2', 't3', 't1']);
        const tasks = useTaskStore.getState().tasks;
        expect([tasks.get('t2')!.order, tasks.get('t3')!.order, tasks.get('t1')!.order]).toEqual([0, 1, 2]);
    });

    it('moves a task up', () => {
        seedOrdered();

        useTaskStore.getState().reorderTasks(WS_A, 2, 0);

        expect(displayOrder(WS_A)).toEqual(['t3', 't1', 't2']);
    });

    it('is a no-op when from and to are the same index', () => {
        seedOrdered();
        const before = useTaskStore.getState().tasks;

        useTaskStore.getState().reorderTasks(WS_A, 1, 1);

        expect(useTaskStore.getState().tasks).toBe(before);
    });

    it('ignores out-of-bounds indices in both directions', () => {
        seedOrdered();
        const before = useTaskStore.getState().tasks;

        useTaskStore.getState().reorderTasks(WS_A, -1, 0);
        useTaskStore.getState().reorderTasks(WS_A, 3, 0);
        useTaskStore.getState().reorderTasks(WS_A, 0, -1);
        useTaskStore.getState().reorderTasks(WS_A, 0, 3);

        expect(useTaskStore.getState().tasks).toBe(before);
    });

    it('ignores a reorder for a workspace with no tasks', () => {
        seedOrdered();
        const before = useTaskStore.getState().tasks;

        useTaskStore.getState().reorderTasks(WS_B, 0, 1);

        expect(useTaskStore.getState().tasks).toBe(before);
    });

    it('sorts unordered tasks newest-first before reordering', () => {
        useTaskStore.setState({
            tasks: new Map([
                ['old', mkTask('old', { createdAt: new Date('2026-01-01T00:00:00Z') })],
                ['mid', mkTask('mid', { createdAt: new Date('2026-01-02T00:00:00Z') })],
                ['new', mkTask('new', { createdAt: new Date('2026-01-03T00:00:00Z') })],
            ]),
        });

        // Display order is new, mid, old — move the newest to the bottom.
        useTaskStore.getState().reorderTasks(WS_A, 0, 2);

        expect(displayOrder(WS_A)).toEqual(['mid', 'old', 'new']);
    });

    it('places already-ordered tasks ahead of unordered ones', () => {
        useTaskStore.setState({
            tasks: new Map([
                ['pinned', mkTask('pinned', { order: 0 })],
                ['a', mkTask('a', { createdAt: new Date('2026-01-01T00:00:00Z') })],
                ['b', mkTask('b', { createdAt: new Date('2026-01-02T00:00:00Z') })],
            ]),
        });

        // Display order: pinned (has order), then b, then a (newest-first).
        useTaskStore.getState().reorderTasks(WS_A, 2, 0);

        expect(displayOrder(WS_A)).toEqual(['a', 'pinned', 'b']);
    });

    it('does not renumber tasks belonging to a different workspace', () => {
        useTaskStore.setState({
            tasks: new Map([
                ['a1', mkTask('a1', { workspaceId: WS_A, order: 0 })],
                ['a2', mkTask('a2', { workspaceId: WS_A, order: 1 })],
                ['b1', mkTask('b1', { workspaceId: WS_B, order: 7 })],
            ]),
        });

        useTaskStore.getState().reorderTasks(WS_A, 0, 1);

        expect(useTaskStore.getState().tasks.get('b1')!.order).toBe(7);
        expect(displayOrder(WS_A)).toEqual(['a2', 'a1']);
    });
});

// ---------------------------------------------------------------------------
// Scheduled tasks (cron)
// ---------------------------------------------------------------------------

describe('scheduled tasks', () => {
    it('setScheduledTasks replaces the whole map, keyed by cron id', () => {
        useTaskStore.getState().setScheduledTasks([mkScheduled('c1'), mkScheduled('c2')]);
        expect([...useTaskStore.getState().scheduledTasks.keys()].sort()).toEqual(['c1', 'c2']);

        useTaskStore.getState().setScheduledTasks([mkScheduled('c3')]);
        expect([...useTaskStore.getState().scheduledTasks.keys()]).toEqual(['c3']);
    });

    it('addScheduledTask inserts, and re-adding the same id updates in place', () => {
        useTaskStore.getState().addScheduledTask(mkScheduled('c1', { fireCount: 0 }));
        useTaskStore.getState().addScheduledTask(mkScheduled('c1', { fireCount: 5, isPaused: true }));

        const { scheduledTasks } = useTaskStore.getState();
        expect(scheduledTasks.size).toBe(1);
        expect(scheduledTasks.get('c1')!.fireCount).toBe(5);
        expect(scheduledTasks.get('c1')!.isPaused).toBe(true);
    });

    it('removeScheduledTask deletes only the given cron id', () => {
        useTaskStore.getState().setScheduledTasks([mkScheduled('c1'), mkScheduled('c2')]);

        useTaskStore.getState().removeScheduledTask('c1');

        expect([...useTaskStore.getState().scheduledTasks.keys()]).toEqual(['c2']);
    });

    it('removing an unknown cron id is harmless', () => {
        useTaskStore.getState().setScheduledTasks([mkScheduled('c1')]);
        useTaskStore.getState().removeScheduledTask('nope');
        expect(useTaskStore.getState().scheduledTasks.size).toBe(1);
    });

    it('getScheduledTasksForTask filters by owning task', () => {
        useTaskStore.getState().setScheduledTasks([
            mkScheduled('c1', { taskId: 'task-1' }),
            mkScheduled('c2', { taskId: 'task-2' }),
            mkScheduled('c3', { taskId: 'task-1' }),
        ]);

        const forTask1 = useTaskStore.getState().getScheduledTasksForTask('task-1');
        expect(forTask1.map(s => s.id).sort()).toEqual(['c1', 'c3']);
        expect(useTaskStore.getState().getScheduledTasksForTask('task-9')).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Activity log / unread badges
// ---------------------------------------------------------------------------

describe('activity log', () => {
    const evt = (taskId: string, over: Partial<Parameters<ReturnType<typeof useTaskStore.getState>['addActivityEvent']>[0]> = {}) => ({
        taskId,
        type: 'completed' as const,
        taskName: `name-${taskId}`,
        timestamp: new Date('2026-01-01T00:00:00Z'),
        ...over,
    });

    it('adds an event, marks the task unread by default, and stamps an id', () => {
        useTaskStore.getState().addActivityEvent(evt('t1'));

        const { activityLog, unreadTaskIds } = useTaskStore.getState();
        expect(activityLog).toHaveLength(1);
        expect(activityLog[0].taskId).toBe('t1');
        expect(activityLog[0].id).toBeTruthy();
        expect(unreadTaskIds.has('t1')).toBe(true);
    });

    it('can add an event without marking it unread', () => {
        useTaskStore.getState().addActivityEvent(evt('t1'), false);

        expect(useTaskStore.getState().activityLog).toHaveLength(1);
        expect(useTaskStore.getState().unreadTaskIds.has('t1')).toBe(false);
    });

    it('keeps only the newest event per task, newest-first', () => {
        useTaskStore.getState().addActivityEvent(evt('t1', { message: 'first' }));
        useTaskStore.getState().addActivityEvent(evt('t2'));
        useTaskStore.getState().addActivityEvent(evt('t1', { type: 'error', message: 'second' }));

        const { activityLog } = useTaskStore.getState();
        expect(activityLog).toHaveLength(2);
        expect(activityLog[0].taskId).toBe('t1');
        expect(activityLog[0].type).toBe('error');
        expect(activityLog[0].message).toBe('second');
        expect(activityLog[1].taskId).toBe('t2');
    });

    it('caps the log at 50 entries, dropping the oldest', () => {
        for (let i = 0; i < 60; i++) {
            useTaskStore.getState().addActivityEvent(evt(`t${i}`));
        }

        const { activityLog } = useTaskStore.getState();
        expect(activityLog).toHaveLength(50);
        expect(activityLog[0].taskId).toBe('t59');   // newest kept
        expect(activityLog.some(e => e.taskId === 't0')).toBe(false); // oldest dropped
    });

    it('clearTaskUnread clears one badge and leaves the log alone', () => {
        useTaskStore.getState().addActivityEvent(evt('t1'));
        useTaskStore.getState().addActivityEvent(evt('t2'));

        useTaskStore.getState().clearTaskUnread('t1');

        const { unreadTaskIds, activityLog } = useTaskStore.getState();
        expect(unreadTaskIds.has('t1')).toBe(false);
        expect(unreadTaskIds.has('t2')).toBe(true);
        expect(activityLog).toHaveLength(2);
    });

    it('clearTaskUnread is a no-op for a task with no badge', () => {
        useTaskStore.getState().addActivityEvent(evt('t1'));
        const before = useTaskStore.getState().unreadTaskIds;

        useTaskStore.getState().clearTaskUnread('t2');

        expect(useTaskStore.getState().unreadTaskIds).toBe(before);
    });

    it('clearAllActivityLog empties both the log and every badge', () => {
        useTaskStore.getState().addActivityEvent(evt('t1'));
        useTaskStore.getState().addActivityEvent(evt('t2'));

        useTaskStore.getState().clearAllActivityLog();

        expect(useTaskStore.getState().activityLog).toEqual([]);
        expect(useTaskStore.getState().unreadTaskIds.size).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Waiting input / drafts / delete confirmation / error notification
// ---------------------------------------------------------------------------

describe('waiting input notifications', () => {
    const info = (taskId: string) => ({
        taskId,
        inputType: 'permission' as const,
        recentOutput: 'Allow Bash?',
        timestamp: new Date('2026-01-01T00:00:00Z'),
    });

    it('sets, replaces and clears a per-task waiting notification', () => {
        useTaskStore.getState().setWaitingInput(info('t1'));
        useTaskStore.getState().setWaitingInput({ ...info('t1'), inputType: 'question' });
        useTaskStore.getState().setWaitingInput(info('t2'));

        let map = useTaskStore.getState().waitingInputNotifications;
        expect(map.size).toBe(2);
        expect(map.get('t1')!.inputType).toBe('question');

        useTaskStore.getState().clearWaitingInput('t1');
        map = useTaskStore.getState().waitingInputNotifications;
        expect(map.has('t1')).toBe(false);
        expect(map.has('t2')).toBe(true);
    });
});

describe('draft inputs', () => {
    it('stores a per-task draft and returns it', () => {
        useTaskStore.getState().setTaskDraftInput('t1', 'half typed');
        useTaskStore.getState().setTaskDraftInput('t2', 'other');

        expect(useTaskStore.getState().getTaskDraftInput('t1')).toBe('half typed');
        expect(useTaskStore.getState().getTaskDraftInput('t2')).toBe('other');
    });

    it('returns an empty string for a task with no draft', () => {
        expect(useTaskStore.getState().getTaskDraftInput('nope')).toBe('');
    });

    it('setting an empty draft deletes the entry', () => {
        useTaskStore.getState().setTaskDraftInput('t1', 'text');
        useTaskStore.getState().setTaskDraftInput('t1', '');

        expect(useTaskStore.getState().taskDraftInputs.has('t1')).toBe(false);
        expect(useTaskStore.getState().getTaskDraftInput('t1')).toBe('');
    });

    it('clearTaskDraftInput removes only that task draft', () => {
        useTaskStore.getState().setTaskDraftInput('t1', 'a');
        useTaskStore.getState().setTaskDraftInput('t2', 'b');

        useTaskStore.getState().clearTaskDraftInput('t1');

        expect(useTaskStore.getState().getTaskDraftInput('t1')).toBe('');
        expect(useTaskStore.getState().getTaskDraftInput('t2')).toBe('b');
    });
});

describe('pending delete requests', () => {
    // The single-slot `pendingDeleteRequest` / `setPendingDeleteRequest` pair was
    // replaced by a queue (batch delete) — add/remove many, confirm in one dialog.
    it('queues MCP delete confirmations and removes them by request id', () => {
        const store = () => useTaskStore.getState();

        store().addPendingDeleteRequest({ taskId: 't1', requestId: 'req-1', taskName: 'Build API' });
        store().addPendingDeleteRequest({ taskId: 't2', requestId: 'req-2', taskName: 'Write tests' });

        expect(store().pendingDeleteRequests.map(r => r.requestId)).toEqual(['req-1', 'req-2']);

        store().removePendingDeleteRequests(['req-1']);
        expect(store().pendingDeleteRequests).toEqual([
            { taskId: 't2', requestId: 'req-2', taskName: 'Write tests' },
        ]);

        store().removePendingDeleteRequests(['req-2']);
        expect(store().pendingDeleteRequests).toEqual([]);
    });

    it('ignores a duplicate request id instead of queueing it twice', () => {
        const request = { taskId: 't1', requestId: 'req-1', taskName: 'Build API' };

        useTaskStore.getState().addPendingDeleteRequest(request);
        useTaskStore.getState().addPendingDeleteRequest({ ...request, taskName: 'renamed' });

        expect(useTaskStore.getState().pendingDeleteRequests).toEqual([request]);
    });
});

describe('error notification', () => {
    it('records message, code and a timestamp, then clears', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-03-01T12:00:00.000Z'));

        useTaskStore.getState().setErrorNotification('spawn failed', 'ENOENT');

        const err = useTaskStore.getState().errorNotification!;
        expect(err.message).toBe('spawn failed');
        expect(err.code).toBe('ENOENT');
        expect(err.timestamp.toISOString()).toBe('2026-03-01T12:00:00.000Z');

        useTaskStore.getState().clearErrorNotification();
        expect(useTaskStore.getState().errorNotification).toBeNull();
    });

    it('allows omitting the code', () => {
        useTaskStore.getState().setErrorNotification('generic failure');
        expect(useTaskStore.getState().errorNotification!.code).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Connection / voice / settings setters
// ---------------------------------------------------------------------------

describe('connection state', () => {
    it('reconnecting clears the "server reloading" banner', () => {
        useTaskStore.getState().setServerReloading(true);
        useTaskStore.getState().setConnected(false);
        expect(useTaskStore.getState().isServerReloading).toBe(true);

        useTaskStore.getState().setConnected(true);
        const s = useTaskStore.getState();
        expect(s.isConnected).toBe(true);
        expect(s.isServerReloading).toBe(false);
    });

    it('tracks browser offline state', () => {
        useTaskStore.getState().setOffline(true);
        expect(useTaskStore.getState().isOffline).toBe(true);
        useTaskStore.getState().setOffline(false);
        expect(useTaskStore.getState().isOffline).toBe(false);
    });
});

describe('voice settings', () => {
    it('setElevenLabsVoice stores id and name together', () => {
        useTaskStore.getState().setElevenLabsVoice('v-123', 'Rachel');

        const s = useTaskStore.getState();
        expect(s.elevenLabsVoiceId).toBe('v-123');
        expect(s.elevenLabsVoiceName).toBe('Rachel');
    });

    it('setVoiceSettings applies the whole bundle', () => {
        useTaskStore.getState().setVoiceSettings({
            voiceName: 'Samantha', rate: 1.4, pitch: 0.8, volume: 0.5,
        });

        const s = useTaskStore.getState();
        expect(s.selectedVoiceName).toBe('Samantha');
        expect(s.voiceRate).toBe(1.4);
        expect(s.voicePitch).toBe(0.8);
        expect(s.voiceVolume).toBe(0.5);
    });

    it('consumeVoiceTranscript returns the accumulated text and empties the buffer', () => {
        useTaskStore.getState().appendVoiceTranscript('hello');
        useTaskStore.getState().appendVoiceTranscript('world');
        useTaskStore.getState().setVoiceInterimTranscript('partial');

        expect(useTaskStore.getState().consumeVoiceTranscript()).toBe('hello world');
        const s = useTaskStore.getState();
        expect(s.voiceTranscript).toBe('');
        expect(s.voiceInterimTranscript).toBe('');
    });

    it('setDeepgramApiKey stores the key locally and syncs it to the backend', async () => {
        const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
        const originalFetch = global.fetch;
        global.fetch = fetchMock as unknown as typeof fetch;
        try {
            useTaskStore.getState().setDeepgramApiKey('dg-secret');

            expect(useTaskStore.getState().deepgramApiKey).toBe('dg-secret');
            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
            expect(url).toContain('/api/config');
            expect(init.method).toBe('PUT');
            expect(JSON.parse(init.body as string)).toEqual({ deepgramApiKey: 'dg-secret' });
        } finally {
            global.fetch = originalFetch;
        }
    });

    it('still stores the key when the backend sync rejects', async () => {
        const originalFetch = global.fetch;
        global.fetch = vi.fn(() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
        try {
            useTaskStore.getState().setDeepgramApiKey('dg-offline');
            // Let the rejection settle so the .catch handler runs (no unhandled rejection).
            await Promise.resolve();
            expect(useTaskStore.getState().deepgramApiKey).toBe('dg-offline');
        } finally {
            global.fetch = originalFetch;
        }
    });
});

describe('settings setters', () => {
    it('round-trip every notification/sound/theme setting', () => {
        const s = useTaskStore.getState();
        s.setAutoFocusOnInput(true);
        s.setSupervisorEnabled(true);
        s.setAiCoreConfigured(false);
        s.setShowSystemStats(true);
        s.setBrowserNotificationsEnabled(true);
        s.setNotifyOnCompletion(false);
        s.setNotifyOnWaitingInput(false);
        s.setThinkingSoundEnabled(true);
        s.setThinkingSoundInterval(12000);
        s.setVoiceSummaryOnCompletion(true);
        s.setVoiceProgressUpdatesEnabled(true);
        s.setVoiceProgressUpdateInterval(60000);
        s.setThemePreference('dark');
        s.setTokenCostEnabled(true);

        expect(useTaskStore.getState()).toMatchObject({
            autoFocusOnInput: true,
            supervisorEnabled: true,
            aiCoreConfigured: false,
            showSystemStats: true,
            browserNotificationsEnabled: true,
            notifyOnCompletion: false,
            notifyOnWaitingInput: false,
            thinkingSoundEnabled: true,
            thinkingSoundInterval: 12000,
            voiceSummaryOnCompletion: true,
            voiceProgressUpdatesEnabled: true,
            voiceProgressUpdateInterval: 60000,
            themePreference: 'dark',
            tokenCostEnabled: true,
        });
    });

    it('aiCoreConfigured supports the "not checked yet" null state', () => {
        useTaskStore.getState().setAiCoreConfigured(true);
        expect(useTaskStore.getState().aiCoreConfigured).toBe(true);
        useTaskStore.getState().setAiCoreConfigured(null);
        expect(useTaskStore.getState().aiCoreConfigured).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// localStorage persistence: partialize + merge (rehydrate)
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'claudia-task-store';

/** Read what the persist middleware has written to localStorage. */
function readPersisted(): Record<string, unknown> {
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    return JSON.parse(raw as string).state;
}

describe('persistence — what gets written', () => {
    it('persists UI preferences and drops transient task state', () => {
        useTaskStore.getState().setThemePreference('light');
        useTaskStore.getState().toggleWorkspaceExpanded(WS_A);
        useTaskStore.getState().setWorkspaceTaskListHeight(WS_A, 275);
        useTaskStore.getState().addTask(mkTask('t1'));

        const persisted = readPersisted();
        expect(persisted.themePreference).toBe('light');
        expect(persisted.expandedWorkspaces).toEqual([WS_A]);
        expect(persisted.workspaceTaskListHeights).toEqual({ [WS_A]: 275 });
        // Live task state is deliberately NOT persisted
        expect(persisted).not.toHaveProperty('tasks');
        expect(persisted).not.toHaveProperty('workspaces');
        expect(persisted).not.toHaveProperty('activityLog');
        expect(persisted).not.toHaveProperty('scheduledTasks');
    });

    it('persists task summaries as entries and chat messages as-is', () => {
        useTaskStore.getState().setTaskSummary({
            taskId: 't1',
            status: 'completed',
            summary: 'done',
            suggestedActions: [],
            timestamp: new Date('2026-01-01T00:00:00Z'),
        });
        useTaskStore.getState().addChatMessage({
            id: 'm1', role: 'user', content: 'hi', timestamp: '2026-01-01T00:00:00.000Z',
        });

        const persisted = readPersisted();
        expect((persisted.taskSummaries as unknown[])).toHaveLength(1);
        expect((persisted.taskSummaries as [string, unknown][])[0][0]).toBe('t1');
        expect((persisted.chatMessages as { id: string }[])[0].id).toBe('m1');
    });
});

describe('persistence — rehydration (merge)', () => {
    /** Write a persisted payload the way the persist middleware would. */
    function seedStorage(state: Record<string, unknown>) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ state, version: 0 }));
    }

    it('restores saved preferences, rebuilding Set/Map shapes', async () => {
        seedStorage({
            selectedTaskId: 't-restored',
            showArchivedTasks: true,
            expandedWorkspaces: [WS_A, WS_B],
            expandedWorkspacesInitialized: true,
            workspaceTaskListHeights: { [WS_A]: 300 },
            workspaceColumns: 2,
            workspaceSortBy: 'alphabetical',
            taskSortBy: 'last-modified',
            voiceEnabled: true,
            autoSpeakResponses: true,
            selectedVoiceName: 'Samantha',
            voiceRate: 1.5,
            voicePitch: 0.9,
            voiceVolume: 0.4,
            elevenLabsVoiceId: 'v-1',
            elevenLabsVoiceName: 'Rachel',
            globalVoiceEnabled: true,
            autoSendEnabled: true,
            autoSendDelayMs: 1500,
            deepgramApiKey: 'dg-persisted',
            autoFocusOnInput: true,
            supervisorEnabled: true,
            showSystemStats: true,
            browserNotificationsEnabled: true,
            notifyOnCompletion: false,
            notifyOnWaitingInput: false,
            thinkingSoundEnabled: true,
            thinkingSoundInterval: 9000,
            voiceSummaryOnCompletion: true,
            voiceProgressUpdatesEnabled: true,
            voiceProgressUpdateInterval: 45000,
            themePreference: 'dark',
            tokenCostEnabled: true,
            taskSummaries: [['t1', {
                taskId: 't1', status: 'completed', summary: 'restored',
                suggestedActions: [], timestamp: '2026-01-01T00:00:00.000Z',
            }]],
            chatMessages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: '2026-01-01T00:00:00.000Z' }],
        });

        await useTaskStore.persist.rehydrate();

        const s = useTaskStore.getState();
        expect(s.selectedTaskId).toBe('t-restored');
        expect(s.showArchivedTasks).toBe(true);
        expect(s.expandedWorkspaces).toBeInstanceOf(Set);
        expect([...s.expandedWorkspaces].sort()).toEqual([WS_A, WS_B].sort());
        expect(s.expandedWorkspacesInitialized).toBe(true);
        expect(s.workspaceTaskListHeights).toEqual({ [WS_A]: 300 });
        expect(s.workspaceColumns).toBe(2);
        expect(s.workspaceSortBy).toBe('alphabetical');
        expect(s.taskSortBy).toBe('last-modified');
        expect(s.voiceEnabled).toBe(true);
        expect(s.autoSpeakResponses).toBe(true);
        expect(s.selectedVoiceName).toBe('Samantha');
        expect(s.voiceRate).toBe(1.5);
        expect(s.voicePitch).toBe(0.9);
        expect(s.voiceVolume).toBe(0.4);
        expect(s.elevenLabsVoiceId).toBe('v-1');
        expect(s.elevenLabsVoiceName).toBe('Rachel');
        expect(s.globalVoiceEnabled).toBe(true);
        expect(s.autoSendEnabled).toBe(true);
        expect(s.autoSendDelayMs).toBe(1500);
        expect(s.deepgramApiKey).toBe('dg-persisted');
        expect(s.autoFocusOnInput).toBe(true);
        expect(s.supervisorEnabled).toBe(true);
        expect(s.showSystemStats).toBe(true);
        expect(s.browserNotificationsEnabled).toBe(true);
        expect(s.notifyOnCompletion).toBe(false);
        expect(s.notifyOnWaitingInput).toBe(false);
        expect(s.thinkingSoundEnabled).toBe(true);
        expect(s.thinkingSoundInterval).toBe(9000);
        expect(s.voiceSummaryOnCompletion).toBe(true);
        expect(s.voiceProgressUpdatesEnabled).toBe(true);
        expect(s.voiceProgressUpdateInterval).toBe(45000);
        expect(s.themePreference).toBe('dark');
        expect(s.tokenCostEnabled).toBe(true);
        expect(s.taskSummaries).toBeInstanceOf(Map);
        expect(s.taskSummaries.get('t1')!.summary).toBe('restored');
        expect(s.chatMessages.map(m => m.id)).toEqual(['m1']);

        // Actions survive the state replacement
        expect(typeof s.selectTask).toBe('function');
    });

    it('falls back to defaults for every field missing from an old persisted payload', async () => {
        // A payload written by an older app version: nothing but a theme.
        seedStorage({ themePreference: 'light' });

        await useTaskStore.persist.rehydrate();

        const s = useTaskStore.getState();
        expect(s.themePreference).toBe('light');
        // Defaults preserved rather than clobbered with undefined
        expect(s.selectedTaskId).toBeNull();
        expect(s.showArchivedTasks).toBe(false);
        expect(s.expandedWorkspaces).toBeInstanceOf(Set);
        expect(s.expandedWorkspaces.size).toBe(0);
        expect(s.workspaceColumns).toBe(0);
        expect(s.workspaceSortBy).toBe('date-created');
        expect(s.taskSortBy).toBe('date-created');
        expect(s.voiceRate).toBe(1.0);
        expect(s.autoSendDelayMs).toBe(3000);
        expect(s.deepgramApiKey).toBe('');
        expect(s.notifyOnCompletion).toBe(true);
        expect(s.thinkingSoundInterval).toBe(5000);
        expect(s.voiceProgressUpdateInterval).toBe(180000);
        expect(s.tokenCostEnabled).toBe(false);
        expect(s.taskSummaries).toBeInstanceOf(Map);
        expect(s.taskSummaries.size).toBe(0);
        expect(s.chatMessages).toEqual([]);
        // No expanded-state key at all → treated as "never initialized"
        expect(s.expandedWorkspacesInitialized).toBe(false);
    });

    it('infers "already initialized" from a persisted expanded list without the flag', async () => {
        seedStorage({ expandedWorkspaces: [] }); // user had collapsed everything

        await useTaskStore.persist.rehydrate();

        expect(useTaskStore.getState().expandedWorkspacesInitialized).toBe(true);
        // …and that flag is what stops a reload from re-expanding everything
        useTaskStore.getState().setWorkspaces([mkWorkspace(WS_A), mkWorkspace(WS_B)]);
        expect(useTaskStore.getState().expandedWorkspaces.size).toBe(0);
    });

    it('keeps working with defaults when nothing is stored', async () => {
        localStorage.clear();

        await useTaskStore.persist.rehydrate();

        const s = useTaskStore.getState();
        expect(s.themePreference).toBe('system');
        expect(s.expandedWorkspaces).toBeInstanceOf(Set);
        // The store is still fully operational
        s.addTask(mkTask('t1'));
        expect(useTaskStore.getState().tasks.get('t1')!.id).toBe('t1');
    });

    it('survives malformed JSON in localStorage', async () => {
        localStorage.setItem(STORAGE_KEY, '{ this is not json ');
        useTaskStore.getState().setThemePreference('dark');
        localStorage.setItem(STORAGE_KEY, '{ this is not json ');

        await expect(useTaskStore.persist.rehydrate()).resolves.toBeUndefined();

        const s = useTaskStore.getState();
        expect(s.themePreference).toBe('dark'); // in-memory state untouched
        s.addTask(mkTask('t1'));
        expect(useTaskStore.getState().tasks.size).toBe(1);
    });

    it('survives a localStorage that throws on read', async () => {
        const spy = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
            throw new Error('SecurityError: storage disabled');
        });
        try {
            await expect(useTaskStore.persist.rehydrate()).resolves.toBeUndefined();
        } finally {
            spy.mockRestore();
        }

        const s = useTaskStore.getState();
        expect(typeof s.addTask).toBe('function');
        s.addTask(mkTask('t1'));
        expect(useTaskStore.getState().tasks.size).toBe(1);
    });
});
