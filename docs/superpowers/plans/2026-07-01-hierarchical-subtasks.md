# Hierarchical Subtasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Claudia task spawns other tasks (via `claudia_create_task`, optionally in isolated worktrees), record the parent-child relationship, let the parent wait for and collect child results, and render children nested under their parent in the sidebar.

**Architecture:** Store only `parentTaskId` on the child (children are derived, never dual-written). The MCP server already knows the calling task via `CLAUDIA_TASK_ID` — it threads that id through the existing WS `task:create` message. Result flow is pull-based: a new `claudia_wait_for_tasks` MCP tool polls child status and returns tail output when children settle. UI derives a tree from the flat task map with a pure `buildTaskTree` util.

**Tech Stack:** TypeScript, Express + WS backend, MCP SDK (zod schemas), Zustand + React frontend, vitest.

**Spec source:** `docs/feature-brainstorm.md` §1c "Hierarchical Task Decomposition" — Task Trees only. **Out of scope (YAGNI, separate plans):** dependency graph / `dependsOn`, map-reduce helpers, push-style result injection into the parent PTY, `claudia_create_subtask` as a separate tool (every task-created task IS a subtask automatically).

## Global Constraints

- **NEVER restart the server, run `./start.sh`, or touch ports 4001/5173.** `tsx watch` hot-reloads backend changes in 1–2s.
- All backend tests: `cd backend && npx vitest run`. Frontend: `cd frontend && npx vitest run`.
- E2E testing goes through `backend/test-cli.ts` against the already-running server on 4001.
- No attribution footers in commits (no "Co-Authored-By", no "Generated with Claude Code").
- Do not bump `TASKS_SCHEMA_VERSION` — `parentTaskId` is an additive optional field; v1 readers ignore it, and bumping would make older builds reject the file.
- Existing key facts (verified 2026-07-01): `TaskSpawner.createTask(prompt, workspaceId, systemPrompt?, initialCols?, initialRows?, modelOverride?)` at `backend/src/task-spawner.ts:2339`; every state change emits `taskStateChanged` with `toPublicTask(task)` (`task-spawner.ts:1289`, projection at `:2843`); WS `task:create` handler at `server.ts:1312` (auto-worktree block `:1347-1370`); MCP identity env vars at `claudia-mcp-server.ts:33-44` (`SELF_TASK_ID = process.env.CLAUDIA_TASK_ID`); MCP mutations go over WS via `sendWSMessage(type, payload)` (`:122`); worktree isolation for MCP-created tasks already exists (`handleCreateTask` `:468-575`).

---

### Task 1: `parentTaskId` on the shared Task model and persistence layer

**Files:**
- Modify: `shared/src/index.ts:31-53` (Task interface)
- Modify: `backend/src/task-persistence.ts:20-35` (PersistedTask)
- Test: `backend/src/__tests__/task-persistence.test.ts`

**Interfaces:**
- Consumes: existing `Task`, `PersistedTask`.
- Produces: `Task.parentTaskId?: string` and `PersistedTask.parentTaskId?: string` — every later task relies on these exact names.

- [ ] **Step 1: Write the failing test**

Append to `backend/src/__tests__/task-persistence.test.ts`, inside the existing top-level `describe` (reuse the file's existing manager/tempdir setup — it creates a `TaskPersistenceManager` against a temp dir in `beforeEach`):

```ts
it('round-trips parentTaskId on persisted tasks', () => {
    const parent = makePersistedTask({ id: 'parent-1' });
    const child = makePersistedTask({ id: 'child-1', parentTaskId: 'parent-1' });
    manager.saveTasks([parent, child], []);
    const loaded = manager.loadTasks();
    expect(loaded.tasks.find(t => t.id === 'child-1')?.parentTaskId).toBe('parent-1');
    expect(loaded.tasks.find(t => t.id === 'parent-1')?.parentTaskId).toBeUndefined();
});
```

If the file has no `makePersistedTask` helper, add one near the top mirroring the minimal `PersistedTask` literals the existing tests already build (copy an existing test's task literal and spread overrides):

```ts
function makePersistedTask(overrides: Partial<PersistedTask> & { id: string }): PersistedTask {
    return {
        prompt: 'test', workspaceId: '/tmp/ws', createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(), lastState: 'idle', sessionId: null,
        ...overrides,
    } as PersistedTask;
}
```

Adjust field names/shapes to exactly match the literals already used in this test file — do not invent new required fields.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/__tests__/task-persistence.test.ts`
Expected: FAIL — TS error `parentTaskId does not exist on type PersistedTask` (compile failure counts as the failing state).

- [ ] **Step 3: Add the fields**

`shared/src/index.ts`, inside `Task` after `sessionWorktreePrInfo`:

```ts
    parentTaskId?: string;   // If set, this task was spawned by another task (subtask)
```

`backend/src/task-persistence.ts`, inside `PersistedTask` after `displayNameEditedByUser?`:

```ts
    parentTaskId?: string;   // Subtask linkage — id of the task that spawned this one
```

If `saveTasks`/`loadTasks` copy fields explicitly rather than spreading, add `parentTaskId` to those copy sites (search the file for `displayNameEditedByUser` and mirror it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/__tests__/task-persistence.test.ts`
Expected: PASS (all tests in file).

- [ ] **Step 5: Commit**

```bash
git add shared/src/index.ts backend/src/task-persistence.ts backend/src/__tests__/task-persistence.test.ts
git commit -m "feat: add parentTaskId to Task and PersistedTask models"
```

---

### Task 2: Pure task-link helpers (validation + orphaning)

**Files:**
- Create: `backend/src/task-links.ts`
- Test: `backend/src/__tests__/task-links.test.ts`

**Interfaces:**
- Consumes: nothing (pure functions).
- Produces:
  - `resolveParentLink(requestedParentId: string | undefined, existingTaskIds: ReadonlySet<string>): string | undefined`
  - `collectOrphanedChildIds(tasks: Iterable<{ id: string; parentTaskId?: string }>, removedTaskId: string): string[]`

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/task-links.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveParentLink, collectOrphanedChildIds } from '../task-links';

describe('resolveParentLink', () => {
    const existing = new Set(['t1', 't2']);
    it('returns the parent id when it exists', () => {
        expect(resolveParentLink('t1', existing)).toBe('t1');
    });
    it('returns undefined for unknown parents (dangling link never stored)', () => {
        expect(resolveParentLink('ghost', existing)).toBeUndefined();
    });
    it('returns undefined when no parent requested', () => {
        expect(resolveParentLink(undefined, existing)).toBeUndefined();
        expect(resolveParentLink('', existing)).toBeUndefined();
    });
});

describe('collectOrphanedChildIds', () => {
    it('finds direct children of the removed task', () => {
        const tasks = [
            { id: 'a' },
            { id: 'b', parentTaskId: 'a' },
            { id: 'c', parentTaskId: 'a' },
            { id: 'd', parentTaskId: 'b' },
        ];
        expect(collectOrphanedChildIds(tasks, 'a').sort()).toEqual(['b', 'c']);
    });
    it('returns empty when nothing links to the removed task', () => {
        expect(collectOrphanedChildIds([{ id: 'x' }], 'a')).toEqual([]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/__tests__/task-links.test.ts`
Expected: FAIL — cannot resolve `../task-links`.

- [ ] **Step 3: Implement**

Create `backend/src/task-links.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/__tests__/task-links.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/task-links.ts backend/src/__tests__/task-links.test.ts
git commit -m "feat: pure helpers for subtask parent-link validation and orphaning"
```

---

### Task 3: TaskSpawner threads, surfaces, persists, and orphans `parentTaskId`

**Files:**
- Modify: `backend/src/task-spawner.ts` (`createTask` :2339, `toPublicTask` :2843, `destroyTask` :3691, `archiveTask` :3774, PersistedTask mapping sites)

**Interfaces:**
- Consumes: `resolveParentLink`, `collectOrphanedChildIds` from Task 2; `Task.parentTaskId` from Task 1.
- Produces: `createTask(prompt, workspaceId, systemPrompt?, initialCols?, initialRows?, modelOverride?, parentTaskId?)` — the exact 7th positional param `server.ts` passes in Task 4. Public tasks and `task:stateChanged` broadcasts now carry `parentTaskId`.

No new unit test file — the pure logic was tested in Task 2; the wiring is covered end-to-end in Task 8. Steps:

- [ ] **Step 1: Extend `createTask`**

At `task-spawner.ts:2339`, add the final optional param and resolve it against live + disconnected tasks:

```ts
async createTask(prompt: string, workspaceId: string, systemPrompt?: string, initialCols?: number, initialRows?: number, modelOverride?: string, parentTaskId?: string): Promise<Task> {
    const existingIds = new Set<string>([...this.tasks.keys(), ...this.disconnectedTasks.keys()]);
    const resolvedParent = resolveParentLink(parentTaskId, existingIds);
    // ... existing body unchanged ...
```

After the existing body obtains the created task (both the OpenCode and Claude Code branches return a `Task`), set the link on the internal record and return a fresh projection:

```ts
    const created = /* existing return value */;
    if (resolvedParent) {
        const internal = this.tasks.get(created.id);
        if (internal) {
            internal.parentTaskId = resolvedParent;
            this.scheduleSave();
            return this.toPublicTask(internal);
        }
    }
    return created;
```

Add the import at the top: `import { resolveParentLink, collectOrphanedChildIds } from './task-links';`
Add to `InternalTask` (`:189-218`): `parentTaskId?: string;`

- [ ] **Step 2: Surface in `toPublicTask` and persistence**

In `toPublicTask` (`:2843-2867`) add `parentTaskId: task.parentTaskId,` alongside the other optional fields. In the PersistedTask construction sites (search the file for `displayNameEditedByUser` — there are save and disconnect paths) add `parentTaskId: task.parentTaskId,`; in the restore path (where `displayName` is read back from a PersistedTask) add `parentTaskId: persisted.parentTaskId,`.

- [ ] **Step 3: Orphan children on destroy/archive**

Add a private method and call it at the top of both `destroyTask` (`:3691`) and `archiveTask` (`:3774`):

```ts
private orphanChildrenOf(removedTaskId: string): void {
    const liveOrphans = collectOrphanedChildIds(this.tasks.values(), removedTaskId);
    for (const id of liveOrphans) {
        const t = this.tasks.get(id)!;
        t.parentTaskId = undefined;
        this.emit('taskStateChanged', this.toPublicTask(t)); // pushes the cleared link to clients
    }
    for (const [, pt] of this.disconnectedTasks) {
        if (pt.parentTaskId === removedTaskId) pt.parentTaskId = undefined;
    }
    if (liveOrphans.length > 0) this.scheduleSave();
}
```

Rationale: deleting a parent orphans children (they keep running) rather than cascade-killing them — an agent's children may still be doing useful work.

- [ ] **Step 4: Verify**

Run: `cd backend && npx vitest run && npx tsc --noEmit`
Expected: all existing tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/task-spawner.ts
git commit -m "feat: thread parentTaskId through task lifecycle with orphan-on-delete"
```

---

### Task 4: `task:create` WS handler accepts `parentTaskId`

**Files:**
- Modify: `backend/src/server.ts:1312-1411` (task:create case)

**Interfaces:**
- Consumes: `createTask(..., parentTaskId?)` from Task 3.
- Produces: WS `task:create` payload field `parentTaskId?: string` — exactly the name the MCP server sends in Task 5.

- [ ] **Step 1: Accept and pass through**

In the `case 'task:create'` destructure at `server.ts:1314`, add `parentTaskId`:

```ts
const { prompt, workspaceId, initialCols, initialRows, source, complexity, isolate, parentTaskId } = payload as { /* extend the existing cast */ parentTaskId?: string };
```

At the `createTask` call site (`:1403`), pass it as the 7th argument:

```ts
const newTask = await taskSpawner.createTask(prompt, validatedPath, systemPrompt, initialCols, initialRows, modelOverride, typeof parentTaskId === 'string' ? parentTaskId : undefined);
```

No extra validation here — `resolveParentLink` inside the spawner silently drops unknown parents, so a stale/forged id degrades to a normal top-level task. Note: this composes with the existing auto-worktree block (`:1347-1370`) untouched — a subtask created with `isolate` lands in its own worktree AND carries `parentTaskId`.

- [ ] **Step 2: Verify hot-reload + types**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors. (tsx watch reloads the running server automatically — do not restart it.)

- [ ] **Step 3: Commit**

```bash
git add backend/src/server.ts
git commit -m "feat: accept parentTaskId in task:create WS payload"
```

---

### Task 5: MCP `claudia_create_task` auto-links the calling task as parent

**Files:**
- Modify: `backend/src/claudia-mcp-server.ts` (`handleCreateTask` :468-575, tool registration :586-614)

**Interfaces:**
- Consumes: WS payload field `parentTaskId` from Task 4; `SELF_TASK_ID` env (`:33-44`).
- Produces: every MCP-created task is automatically a subtask of the caller. Tool result text includes the child task id (already does — keep it; Task 6 consumes those ids).

- [ ] **Step 1: Send the link**

In `handleCreateTask`, extend the `sendWSMessage('task:create', {...})` payload (`:522`):

```ts
const created = await sendWSMessage('task:create', {
    prompt: args.prompt,
    workspaceId: effectiveWorkspaceId,
    source: 'mcp',
    ...(complexity ? { complexity } : {}),
    parentTaskId: SELF_TASK_ID || undefined,
});
```

(Adapt to the existing object literal — the only change is the `parentTaskId` line.)

- [ ] **Step 2: Update the tool description**

In the `claudia_create_task` registration, append to the description string: `" The new task is recorded as a subtask of the calling task; use claudia_wait_for_tasks to collect its results."`

- [ ] **Step 3: Verify**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/claudia-mcp-server.ts
git commit -m "feat: MCP-created tasks record the calling task as parent"
```

---

### Task 6: `claudia_wait_for_tasks` MCP tool (pull-based result collection)

**Files:**
- Modify: `backend/src/claudia-mcp-server.ts`
- Create: `backend/src/subtask-wait.ts`
- Test: `backend/src/__tests__/subtask-wait.test.ts`

**Interfaces:**
- Consumes: REST `GET /api/tasks/:taskId/status` (`server.ts:3665`) and `GET /api/tasks/:taskId/output?maxBytes=` (`:3706`) via `backendFetch`.
- Produces: MCP tool `claudia_wait_for_tasks({ taskIds: string[], timeoutSeconds?: number })`; pure helper `isTaskSettled(state: string, sawBusy: boolean, elapsedMs: number): boolean`.

Design note (why `sawBusy`): a freshly spawned task passes through `starting` and may briefly read `idle` before Claude begins producing output (busy detection needs 2 consecutive changed polls — `task-spawner.ts:1153`). Treating that first `idle` as "done" would return empty results. So a task only counts as settled on `idle` if we've observed it `busy`/`waiting_input` at least once, OR a 30s grace period elapsed (covers instant-exit tasks).

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/subtask-wait.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isTaskSettled } from '../subtask-wait';

describe('isTaskSettled', () => {
    it('exited/interrupted always settle', () => {
        expect(isTaskSettled('exited', false, 0)).toBe(true);
        expect(isTaskSettled('interrupted', false, 0)).toBe(true);
    });
    it('waiting_input settles (parent must decide how to answer)', () => {
        expect(isTaskSettled('waiting_input', false, 0)).toBe(true);
    });
    it('idle before ever being busy does NOT settle inside the grace window', () => {
        expect(isTaskSettled('idle', false, 5_000)).toBe(false);
    });
    it('idle after being busy settles', () => {
        expect(isTaskSettled('idle', true, 5_000)).toBe(true);
    });
    it('idle past the 30s grace settles even if busy was never seen', () => {
        expect(isTaskSettled('idle', false, 31_000)).toBe(true);
    });
    it('busy/starting never settle', () => {
        expect(isTaskSettled('busy', true, 60_000)).toBe(false);
        expect(isTaskSettled('starting', false, 60_000)).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/__tests__/subtask-wait.test.ts`
Expected: FAIL — cannot resolve `../subtask-wait`.

- [ ] **Step 3: Implement the helper**

Create `backend/src/subtask-wait.ts`:

```ts
// Settlement predicate for waiting on spawned subtasks.
const IDLE_GRACE_MS = 30_000;

export function isTaskSettled(state: string, sawBusy: boolean, elapsedMs: number): boolean {
    switch (state) {
        case 'exited':
        case 'interrupted':
        case 'disconnected':
        case 'waiting_input':
            return true;
        case 'idle':
            return sawBusy || elapsedMs >= IDLE_GRACE_MS;
        default: // starting, busy, archived-in-flight, unknown
            return false;
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/__tests__/subtask-wait.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Register the MCP tool**

In `claudia-mcp-server.ts`, import `isTaskSettled` from `./subtask-wait` and register (place after `claudia_create_task`):

```ts
server.tool(
    'claudia_wait_for_tasks',
    'Block until the given tasks settle (idle after working, exited, or waiting for input), then return each task\'s final state and recent output. Use after claudia_create_task to collect subtask results. Polls every 3s.',
    {
        taskIds: z.array(z.string()).min(1).max(16).describe('Task ids to wait for (from claudia_create_task)'),
        timeoutSeconds: z.number().min(5).max(1800).optional().describe('Give up after this many seconds (default 600)'),
    },
    async (args) => {
        const timeoutMs = (args.timeoutSeconds ?? 600) * 1000;
        const start = Date.now();
        const sawBusy = new Map<string, boolean>(args.taskIds.map(id => [id, false]));
        const settled = new Map<string, string>(); // id -> final state
        while (settled.size < args.taskIds.length && Date.now() - start < timeoutMs) {
            for (const id of args.taskIds) {
                if (settled.has(id)) continue;
                const res = await backendFetch(`/api/tasks/${encodeURIComponent(id)}/status`);
                if (!res.ok) { settled.set(id, 'not_found'); continue; }
                const { state } = await res.json() as { state: string };
                if (state === 'busy' || state === 'waiting_input') sawBusy.set(id, true);
                if (isTaskSettled(state, sawBusy.get(id)!, Date.now() - start)) settled.set(id, state);
            }
            if (settled.size < args.taskIds.length) await new Promise(r => setTimeout(r, 3000));
        }
        const sections: string[] = [];
        for (const id of args.taskIds) {
            const state = settled.get(id) ?? 'timeout (still running)';
            let tail = '';
            if (settled.has(id) && settled.get(id) !== 'not_found') {
                const out = await backendFetch(`/api/tasks/${encodeURIComponent(id)}/output?maxBytes=8192`);
                if (out.ok) tail = (await out.json() as { output?: string }).output ?? '';
            }
            sections.push(`## Task ${id} — ${state}\n${tail ? '```\n' + tail + '\n```' : '(no output captured)'}`);
        }
        return { content: [{ type: 'text', text: sections.join('\n\n') }] };
    }
);
```

Match the surrounding tools' exact response envelope and `backendFetch` return handling (`:100`) — if `backendFetch` already returns parsed JSON rather than a Response, adapt the two call sites accordingly.

- [ ] **Step 6: Verify + commit**

Run: `cd backend && npx vitest run && npx tsc --noEmit`
Expected: PASS / no errors.

```bash
git add backend/src/subtask-wait.ts backend/src/__tests__/subtask-wait.test.ts backend/src/claudia-mcp-server.ts
git commit -m "feat: claudia_wait_for_tasks MCP tool for collecting subtask results"
```

---

### Task 7: Frontend task tree derivation (pure util + store wiring)

**Files:**
- Create: `frontend/src/utils/taskTree.ts`
- Test: `frontend/src/__tests__/taskTree.test.ts`

**Interfaces:**
- Consumes: `Task.parentTaskId` from Task 1 (shared package).
- Produces: `buildTaskTree(tasks: Task[]): { roots: Task[]; childrenByParent: Map<string, Task[]> }` — Task 8's rendering consumes exactly this.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/__tests__/taskTree.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildTaskTree } from '../utils/taskTree';
import type { Task } from '@claudia/shared';

function makeTask(id: string, parentTaskId?: string): Task {
    return { id, prompt: id, state: 'idle', workspaceId: '/ws', createdAt: new Date(), lastActivity: new Date(), parentTaskId } as Task;
}

describe('buildTaskTree', () => {
    it('splits roots from children and groups children by parent', () => {
        const tree = buildTaskTree([makeTask('a'), makeTask('b', 'a'), makeTask('c', 'a'), makeTask('d')]);
        expect(tree.roots.map(t => t.id)).toEqual(['a', 'd']);
        expect(tree.childrenByParent.get('a')?.map(t => t.id)).toEqual(['b', 'c']);
        expect(tree.childrenByParent.has('d')).toBe(false);
    });
    it('treats children of missing parents as roots (orphans)', () => {
        const tree = buildTaskTree([makeTask('b', 'ghost')]);
        expect(tree.roots.map(t => t.id)).toEqual(['b']);
    });
    it('handles grandchildren (nested one level per lookup)', () => {
        const tree = buildTaskTree([makeTask('a'), makeTask('b', 'a'), makeTask('c', 'b')]);
        expect(tree.roots.map(t => t.id)).toEqual(['a']);
        expect(tree.childrenByParent.get('b')?.map(t => t.id)).toEqual(['c']);
    });
});
```

Adjust the `Task` import path to match how other frontend files import shared types (check `frontend/src/stores/taskStore.ts`'s import of `Task` and copy it).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/taskTree.test.ts`
Expected: FAIL — cannot resolve `../utils/taskTree`.

- [ ] **Step 3: Implement**

Create `frontend/src/utils/taskTree.ts` (use the same `Task` import as the test):

```ts
import type { Task } from '@claudia/shared';

export interface TaskTree {
    roots: Task[];
    childrenByParent: Map<string, Task[]>;
}

// Derives a tree from the flat task list. A task whose parent is absent
// from the input (deleted, archived, filtered out) is promoted to root.
export function buildTaskTree(tasks: Task[]): TaskTree {
    const ids = new Set(tasks.map(t => t.id));
    const roots: Task[] = [];
    const childrenByParent = new Map<string, Task[]>();
    for (const t of tasks) {
        if (t.parentTaskId && ids.has(t.parentTaskId)) {
            const list = childrenByParent.get(t.parentTaskId) ?? [];
            list.push(t);
            childrenByParent.set(t.parentTaskId, list);
        } else {
            roots.push(t);
        }
    }
    return { roots, childrenByParent };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/__tests__/taskTree.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/taskTree.ts frontend/src/__tests__/taskTree.test.ts
git commit -m "feat: buildTaskTree util for deriving subtask hierarchy"
```

---

### Task 8: Nest subtasks under their parent in WorkspacePanel

**Files:**
- Modify: `frontend/src/components/WorkspacePanel.tsx` (`getTasksForWorkspace` :2303, `getWorktreeGroupsForWorkspace` :2308-2316, task list rendering ~:1806-1856, `TaskItem`)

**Interfaces:**
- Consumes: `buildTaskTree` from Task 7; existing `TaskItem` `worktreeInfo` prop (`:264-269`) and `WorktreeGroup` grouping.
- Produces: visual nesting — no new exports.

Rendering rules:
1. A subtask whose parent is visible renders indented under the parent, in the **parent's** list position — even if the subtask lives in a child-worktree workspace (it shows the existing branch badge via `worktreeInfo` / `task.sessionWorktreeBranch`).
2. Subtasks with visible parents are excluded from `WorktreeGroupSection` groups and from the top-level task list (no double rendering).
3. Orphans (parent deleted/archived) render exactly as today — `buildTaskTree` promotes them to roots.

- [ ] **Step 1: Compute the tree at the grouping layer**

In the workspace-card scope where `getTasksForWorkspace(workspace.id)` and `getWorktreeGroupsForWorkspace(workspace.id)` are combined (~:1806-1856), gather the workspace's tasks PLUS its worktree-children's tasks into one array, build the tree once, and re-filter:

```tsx
const allWorkspaceTasks = [
    ...getTasksForWorkspace(workspace.id),
    ...worktreeGroups.flatMap(g => g.tasks),
];
const taskTree = buildTaskTree(allWorkspaceTasks);
const subtaskIds = new Set(
    [...taskTree.childrenByParent.values()].flat().map(t => t.id)
);
// Top-level list: roots that belong to this workspace directly
const directTasks = taskTree.roots.filter(t => t.workspaceId === workspace.id);
// Worktree groups: drop tasks that render under a parent instead
const visibleWorktreeGroups = worktreeGroups
    .map(g => ({ ...g, tasks: g.tasks.filter(t => !subtaskIds.has(t.id)) }))
    .filter(g => g.tasks.length > 0);
```

Preserve the existing sort (`sortTasks`) on `directTasks`.

- [ ] **Step 2: Render children under each TaskItem**

Where the task list maps `directTasks` to `<TaskItem ...>`, render children after each item (one recursion level via a small helper so grandchildren also nest):

```tsx
const renderTaskWithChildren = (task: Task, depth: number): ReactNode => (
    <Fragment key={task.id}>
        <TaskItem task={task} depth={depth} {...existingProps(task)} />
        {(taskTree.childrenByParent.get(task.id) ?? []).map(child =>
            renderTaskWithChildren(child, depth + 1)
        )}
    </Fragment>
);
```

Add a `depth?: number` prop to `TaskItem` (default 0) and apply `style={{ marginLeft: depth * 16 }}` (or the codebase's existing indent idiom — match how `WorktreeGroupSection` indents its tasks) plus a small connector glyph consistent with the existing sidebar style (e.g. the `GitBranch`-badge pattern already used for `worktreeInfo` at `:264-269` — a subtask in a worktree keeps that badge).

- [ ] **Step 3: Type-check and unit tests**

Run: `cd frontend && npx tsc --noEmit && npx vitest run`
Expected: no errors, all tests PASS.

- [ ] **Step 4: Manual visual test (per project convention for visual features)**

With backend and frontend already running (do NOT restart anything):
1. `cd backend && npx tsx test-cli.ts -m "parent placeholder" -w <some workspace>` → note the task id.
2. `npx tsx test-cli.ts -m "child placeholder" -w <same workspace> --parent <parentId>` (flag added in Task 9 — if executing tasks in order 8 before 9, do 9 first or create the child via an MCP-enabled task).
3. In the browser at :5173: child renders indented under parent; deleting the parent promotes the child to top level; a child created with `isolate` shows its branch badge while nested.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/WorkspacePanel.tsx
git commit -m "feat: render subtasks nested under their parent task in the sidebar"
```

---

### Task 9: test-cli `--parent` flag + end-to-end verification

**Files:**
- Modify: `backend/test-cli.ts`

**Interfaces:**
- Consumes: WS `task:create` payload field `parentTaskId` (Task 4).
- Produces: `--parent <taskId>` CLI flag; this is the sanctioned E2E test path.

- [ ] **Step 1: Add the flag**

In `backend/test-cli.ts`, mirror how an existing optional flag (e.g. `-w/--workspace`) is parsed, add `--parent <taskId>`, and include `parentTaskId` in the `task:create` payload the CLI sends. Update the `--help` text with one line: `--parent <taskId>   Link the new task as a subtask of an existing task`.

- [ ] **Step 2: End-to-end verify against the running server**

```bash
cd backend
npx tsx test-cli.ts -m "echo parent" -w /Users/kovtcharov/Work/claudia   # → prints parent id P
npx tsx test-cli.ts -m "echo child" -w /Users/kovtcharov/Work/claudia --parent P
npx tsx test-cli.ts --list-tasks    # child row must show parentTaskId=P (add it to the list output if missing)
```

Expected: list output shows the child linked to P. Then delete the parent via the UI or CLI and re-list: child's `parentTaskId` is cleared (orphaning from Task 3). Clean up: delete both test tasks when done.

- [ ] **Step 3: Full test sweep + commit**

Run: `cd backend && npx vitest run && cd ../frontend && npx vitest run`
Expected: all green.

```bash
git add backend/test-cli.ts
git commit -m "feat: test-cli --parent flag for exercising subtask links"
```

---

## Self-Review Notes

- **Spec coverage (§1c Task Trees):** `parentTaskId` ✅ (Tasks 1–5); `childTaskIds[]` intentionally NOT stored — derived via `collectOrphanedChildIds`/`buildTaskTree` (documented in Architecture); spawn subtasks ✅ (Task 5 — automatic on `claudia_create_task`, worktree isolation via existing `isolate`); results flow back ✅ (Task 6, pull-based); visual tree ✅ (Tasks 7–8); parent summary of child outcomes → covered by `claudia_wait_for_tasks` output; `dependsOn`/DAG/map-reduce → explicitly out of scope.
- **Type consistency:** `parentTaskId` (never `parentId`) everywhere; `buildTaskTree` returns `{ roots, childrenByParent }` consumed with those exact names in Task 8; `createTask`'s 7th positional param matches the Task 4 call site.
- **Known line-number drift risk:** anchors reference the `fix/reconnect-input-delivery` checkout on 2026-07-01; if PRs #74/#75/#78/#79 merge first, re-locate by the quoted identifiers (search strings are given per step), not by line number.
