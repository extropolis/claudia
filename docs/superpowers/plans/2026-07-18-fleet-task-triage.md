# Fleet Task Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Claudia task (via the MCP server) see and bulk-manage every task across its whole workspace — including all of that workspace's worktrees — and reap orphaned worktree-workspaces left behind by archived tasks.

**Architecture:** Three layers. (1) MCP server (`claudia-mcp-server.ts`) gains a `claudia_delete_tasks` bulk tool and a verified cross-worktree read scope for `claudia_list_tasks`. (2) Backend `server.ts` gains a `task:bulkDeleteRequest` WS handler that shows ONE batched user-confirmation and, on approval, archives all selected tasks, plus a `worktree:reapOrphans` handler that removes worktree-workspaces with no live task. (3) Frontend gains a batched-confirm modal so the user approves a whole list at once, never 223 individual popups.

**Tech Stack:** TypeScript, Node, Express + `ws` WebSocket, Zod (MCP tool schemas), React + Zustand (frontend), vitest, `backend/test-cli.ts` for end-to-end checks.

## Global Constraints

- Never restart the server; `tsx watch` auto-reloads `backend/src/*.ts`. (CLAUDE.md)
- Never touch ports 4001 or 5173. (CLAUDE.md)
- Destructive actions on tasks/worktrees MUST be user-gated — no silent bulk deletion. Log every removal and every skip with a reason; no silent caps. (CLAUDE.md + safety)
- A task must never delete/stop itself in a bulk op (exclude `SELF_TASK_ID`).
- Removing a worktree keeps its branch ref (never `git branch -D`).
- Clean up any temporary test files/fixtures/worktrees created during testing.
- Do not commit or push without the user validating first. (CLAUDE.md)

---

### Task 1: Extract and unit-test the cross-worktree scope resolver

Establishes that "all tasks in the same workspace, across all its worktrees" resolves correctly, with a pure, testable function. Today the logic lives inline in `getWorkspaceScope` (`claudia-mcp-server.ts:108`) and calls `resolveWorktreeRoot` (`:87`). We extract the set-building into a pure function so it can be tested without a live backend.

**Files:**
- Modify: `backend/src/claudia-mcp-server.ts:87-134`
- Test: `backend/src/__tests__/mcp-scope.test.ts` (create)

**Interfaces:**
- Produces: `export function computeWorkspaceScope(workspaces: {id: string; worktreeParentId?: string}[], sessionWorkspaceId: string): Set<string>` — returns the root workspace id plus every workspace whose root-walk lands on the same root.

- [ ] **Step 1: Write the failing test**

```typescript
// backend/src/__tests__/mcp-scope.test.ts
import { describe, it, expect } from 'vitest';
import { computeWorkspaceScope } from '../claudia-mcp-server.js';

describe('computeWorkspaceScope', () => {
  const ws = [
    { id: '/repo' },
    { id: '/repo/.claudia-worktrees/a', worktreeParentId: '/repo' },
    { id: '/repo/.claudia-worktrees/b', worktreeParentId: '/repo' },
    { id: '/other' },
  ];

  it('from a worktree, includes the root and all sibling worktrees', () => {
    const scope = computeWorkspaceScope(ws, '/repo/.claudia-worktrees/a');
    expect([...scope].sort()).toEqual(
      ['/repo', '/repo/.claudia-worktrees/a', '/repo/.claudia-worktrees/b'].sort()
    );
  });

  it('does not include unrelated workspaces', () => {
    const scope = computeWorkspaceScope(ws, '/repo');
    expect(scope.has('/other')).toBe(false);
  });

  it('falls back to self when the session workspace is unknown', () => {
    const scope = computeWorkspaceScope(ws, '/ghost');
    expect([...scope]).toEqual(['/ghost']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/__tests__/mcp-scope.test.ts`
Expected: FAIL — `computeWorkspaceScope` is not exported / not a function.

- [ ] **Step 3: Write minimal implementation**

In `claudia-mcp-server.ts`, add above `getWorkspaceScope`:

```typescript
/** Pure scope resolver: root workspace + every workspace sharing that root. */
export function computeWorkspaceScope(
    workspaces: { id: string; worktreeParentId?: string }[],
    sessionWorkspaceId: string
): Set<string> {
    const wsById = new Map<string, { id: string; worktreeParentId?: string }>();
    for (const ws of workspaces) wsById.set(ws.id, ws);
    const ids = new Set<string>();
    if (!wsById.has(sessionWorkspaceId)) {
        ids.add(sessionWorkspaceId);
        return ids;
    }
    const root = resolveWorktreeRoot(wsById as Map<string, any>, sessionWorkspaceId);
    ids.add(root);
    for (const ws of workspaces) {
        if (resolveWorktreeRoot(wsById as Map<string, any>, ws.id) === root) ids.add(ws.id);
    }
    return ids;
}
```

Then refactor `getWorkspaceScope` to build `wsById`, then `for (const id of computeWorkspaceScope(workspaces, WORKSPACE_ID)) ids.add(id)`, preserving the existing `ids.add(WORKSPACE_ID)` fallback and `wsById` return.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/__tests__/mcp-scope.test.ts`
Expected: PASS (3 passing). Then `npx vitest run` — no other tests regress.

- [ ] **Step 5: Commit**

```bash
git add backend/src/claudia-mcp-server.ts backend/src/__tests__/mcp-scope.test.ts
git commit -m "refactor: extract pure computeWorkspaceScope + tests for cross-worktree listing"
```

---

### Task 2: Backend — batched bulk-delete WS handler

One user confirmation approves the whole list; on approval every selected task is archived. Mirrors the single-delete flow (`server.ts:1044` approval path, `taskSpawner.archiveTask`) but batched. Reuses the existing frontend confirm broadcast pattern.

**Files:**
- Modify: `backend/src/server.ts` (WS message switch; add `'task:bulkDeleteRequest'` to the allowed-types list near `:50-65`)
- Test: `backend/src/__tests__/bulk-delete.test.ts` (create)

**Interfaces:**
- Consumes: `taskSpawner.archiveTask(id)` (`task-spawner.ts:4010`), `taskSpawner.getAllTasks()`.
- Produces: WS in `{ type: 'task:bulkDeleteRequest', payload: { taskIds: string[], requestId: string } }`; WS out on approve `{ type: 'task:bulkDeleteResult', payload: { requestId, archived: string[], skipped: {id,reason}[] } }`; on reject `{ type: 'task:bulkDeleteRejected', payload: { requestId } }`. Broadcasts `{ type: 'task:bulkDeleteConfirm', payload: { requestId, tasks: {id,name}[] } }` for the frontend modal.

- [ ] **Step 1: Write the failing test**

```typescript
// backend/src/__tests__/bulk-delete.test.ts
import { describe, it, expect, vi } from 'vitest';
import { resolveBulkDelete } from '../bulk-delete.js';

describe('resolveBulkDelete', () => {
  it('archives all requested ids except self, reports skips', () => {
    const archived: string[] = [];
    const spawner = {
      getAllTasks: () => [{ id: 'a' }, { id: 'b' }, { id: 'self' }],
      archiveTask: (id: string) => archived.push(id),
    } as any;
    const res = resolveBulkDelete(spawner, ['a', 'b', 'self', 'ghost'], 'self');
    expect(archived.sort()).toEqual(['a', 'b']);
    expect(res.archived.sort()).toEqual(['a', 'b']);
    expect(res.skipped).toEqual(
      expect.arrayContaining([
        { id: 'self', reason: 'is-self' },
        { id: 'ghost', reason: 'not-found' },
      ])
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/__tests__/bulk-delete.test.ts`
Expected: FAIL — cannot find module `../bulk-delete.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// backend/src/bulk-delete.ts
interface SpawnerLike {
    getAllTasks(): { id: string }[];
    archiveTask(id: string): void;
}
export function resolveBulkDelete(spawner: SpawnerLike, taskIds: string[], selfId: string | null) {
    const known = new Set(spawner.getAllTasks().map(t => t.id));
    const archived: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of taskIds) {
        if (selfId && id === selfId) { skipped.push({ id, reason: 'is-self' }); continue; }
        if (!known.has(id)) { skipped.push({ id, reason: 'not-found' }); continue; }
        spawner.archiveTask(id);
        archived.push(id);
    }
    return { archived, skipped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/__tests__/bulk-delete.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the WS handler**

In `server.ts`, add `'task:bulkDeleteRequest'` to the allowed WS message-type list (near `:50`). In the message switch add:

```typescript
case 'task:bulkDeleteRequest': {
    const { taskIds, requestId } = payload as { taskIds?: string[]; requestId?: string };
    if (!Array.isArray(taskIds) || !requestId) {
        sendWSError(ws, 'task:bulkDeleteRequest requires taskIds[] and requestId', message.type, 'MISSING_PARAMS');
        break;
    }
    const all = taskSpawner.getAllTasks();
    const tasks = taskIds
        .map(id => all.find(t => t.id === id))
        .filter(Boolean)
        .map((t: any) => ({ id: t.id, name: t.displayName || t.prompt?.substring(0, 60) || t.id }));
    logger.info('task:bulkDeleteRequest', { requestId, requested: taskIds.length, matched: tasks.length });
    broadcast({ type: 'task:bulkDeleteConfirm' as WSMessageType, payload: { requestId, tasks } });
    break;
}
```

Add an approval handler (triggered by the frontend modal's Approve button):

```typescript
case 'task:bulkDeleteApprove': {
    const { taskIds, requestId, excludeTaskId } = payload as { taskIds?: string[]; requestId?: string; excludeTaskId?: string };
    if (!Array.isArray(taskIds) || !requestId) { sendWSError(ws, 'missing params', message.type, 'MISSING_PARAMS'); break; }
    const { resolveBulkDelete } = await import('./bulk-delete.js');
    const result = resolveBulkDelete(taskSpawner, taskIds, excludeTaskId ?? null);
    logger.info('task:bulkDeleteApprove complete', { requestId, ...result, archivedCount: result.archived.length });
    broadcast({ type: 'task:bulkDeleteResult' as WSMessageType, payload: { requestId, ...result } });
    break;
}
case 'task:bulkDeleteReject': {
    const { requestId } = payload as { requestId?: string };
    broadcast({ type: 'task:bulkDeleteRejected' as WSMessageType, payload: { requestId } });
    break;
}
```

Add the four new `WSMessageType` string literals (`task:bulkDeleteConfirm`, `task:bulkDeleteResult`, `task:bulkDeleteRejected`, plus inbound `task:bulkDeleteApprove`/`task:bulkDeleteReject`) to the shared `WSMessageType` union in `shared/src/index.ts`.

- [ ] **Step 6: Run tests + typecheck**

Run: `cd backend && npx vitest run && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add backend/src/bulk-delete.ts backend/src/__tests__/bulk-delete.test.ts backend/src/server.ts shared/src/index.ts
git commit -m "feat: batched bulk-delete WS handler with single user confirmation"
```

---

### Task 3: Backend — reap orphaned worktree-workspaces

Removes worktree-workspaces that have no live task (the 80 orphans), deleting the worktree folder and the workspace entry. Reuses `WorktreeManager.removeWorktree` (`worktree-manager.ts:217`) and `workspaceStore.deleteWorkspace`.

**Files:**
- Create: `backend/src/orphan-reaper.ts`
- Modify: `backend/src/server.ts` (WS handler `worktree:reapOrphans`)
- Test: `backend/src/__tests__/orphan-reaper.test.ts`

**Interfaces:**
- Produces: `export function findOrphanWorktrees(workspaces: {id:string;worktreeParentId?:string}[], liveWorkspaceIds: Set<string>): {id:string;parentId:string}[]` — worktree-workspaces whose id is not in `liveWorkspaceIds`.

- [ ] **Step 1: Write the failing test**

```typescript
// backend/src/__tests__/orphan-reaper.test.ts
import { describe, it, expect } from 'vitest';
import { findOrphanWorktrees } from '../orphan-reaper.js';

describe('findOrphanWorktrees', () => {
  it('returns worktree workspaces with no live task', () => {
    const ws = [
      { id: '/r' },
      { id: '/r/wt/a', worktreeParentId: '/r' },
      { id: '/r/wt/b', worktreeParentId: '/r' },
    ];
    const live = new Set(['/r/wt/a']); // only 'a' has a live task
    const orphans = findOrphanWorktrees(ws, live);
    expect(orphans).toEqual([{ id: '/r/wt/b', parentId: '/r' }]);
  });

  it('never returns non-worktree (root) workspaces', () => {
    const ws = [{ id: '/r' }];
    expect(findOrphanWorktrees(ws, new Set())).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/__tests__/orphan-reaper.test.ts`
Expected: FAIL — cannot find module `../orphan-reaper.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// backend/src/orphan-reaper.ts
export function findOrphanWorktrees(
    workspaces: { id: string; worktreeParentId?: string }[],
    liveWorkspaceIds: Set<string>
): { id: string; parentId: string }[] {
    return workspaces
        .filter(w => w.worktreeParentId && !liveWorkspaceIds.has(w.id))
        .map(w => ({ id: w.id, parentId: w.worktreeParentId! }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/__tests__/orphan-reaper.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the WS handler (dry-run capable)**

In `server.ts` add `'worktree:reapOrphans'` to the allowed types and:

```typescript
case 'worktree:reapOrphans': {
    const { dryRun = true } = payload as { dryRun?: boolean };
    const workspaces = workspaceStore.getWorkspaces();
    const liveWsIds = new Set(taskSpawner.getAllTasks().map(t => t.workspaceId));
    const { findOrphanWorktrees } = await import('./orphan-reaper.js');
    const orphans = findOrphanWorktrees(workspaces, liveWsIds);
    logger.info('worktree:reapOrphans', { dryRun, orphanCount: orphans.length });
    const removed: string[] = [];
    const failed: { id: string; error: string }[] = [];
    if (!dryRun) {
        const manager = new WorktreeManager();
        for (const o of orphans) {
            try {
                await manager.removeWorktree({ repoPath: o.parentId, worktreePath: o.id, force: true });
                workspaceStore.deleteWorkspace(o.id);
                broadcast({ type: 'workspace:deleted' as WSMessageType, payload: { workspaceId: o.id } });
                removed.push(o.id);
            } catch (err) {
                failed.push({ id: o.id, error: err instanceof Error ? err.message : String(err) });
                logger.warn('reapOrphans: removeWorktree failed', { id: o.id, error: failed.at(-1)!.error });
            }
        }
    }
    ws.send(JSON.stringify({ type: 'worktree:reapResult', payload: { dryRun, orphans: orphans.map(o => o.id), removed, failed } }));
    break;
}
```

`workspaceStore.getWorkspaces()` (workspace-store.ts:93) returns `Workspace[]`.

- [ ] **Step 6: Run tests + typecheck**

Run: `cd backend && npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/orphan-reaper.ts backend/src/__tests__/orphan-reaper.test.ts backend/src/server.ts shared/src/index.ts
git commit -m "feat: reap orphaned worktree-workspaces (dry-run default)"
```

---

### Task 4: MCP — `claudia_delete_tasks` bulk tool + `all_worktrees` list flag

Exposes bulk delete to agents and makes the cross-worktree read explicit. Bulk delete routes through the Task 2 batched confirmation (still user-gated).

**Files:**
- Modify: `backend/src/claudia-mcp-server.ts` (add tool near `:987`; add `all_worktrees` param to `claudia_list_tasks` at `:353`)
- Test: manual via `backend/test-cli.ts` (Task 5)

**Interfaces:**
- Consumes: `sendWSMessageWithMultiResponse` (existing helper used by single delete), `SELF_TASK_ID`, `getWorkspaceScope`.
- Produces: MCP tool `claudia_delete_tasks({ taskIds: string[] })`.

- [ ] **Step 1: Add the bulk tool**

```typescript
server.tool(
    'claudia_delete_tasks',
    'Request bulk deletion (archival) of multiple tasks at once. Shows the user ONE confirmation listing all tasks; nothing is deleted unless the user approves. Excludes the calling task automatically. Use for triage/cleanup when the user asks to remove many tasks.',
    { taskIds: z.array(z.string()).min(1).describe('Task IDs to delete. Get them from claudia_list_tasks.') },
    async ({ taskIds }) => {
        const ids = taskIds.filter(id => id !== SELF_TASK_ID);
        if (ids.length === 0) {
            return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'No deletable task IDs (self excluded).' }, null, 2) }] };
        }
        const requestId = `bulkdel-${process.pid}-${ids.length}`;
        log.info(`Requesting bulk delete confirmation for ${ids.length} tasks`, { requestId });
        try {
            const result = await sendWSMessageWithMultiResponse(
                'task:bulkDeleteRequest',
                { taskIds: ids, requestId },
                (msg) => {
                    if (msg.type === 'task:bulkDeleteResult' && msg.payload?.requestId === requestId) return { outcome: 'approved', payload: msg.payload };
                    if (msg.type === 'task:bulkDeleteRejected' && msg.payload?.requestId === requestId) return { outcome: 'rejected' };
                    return null;
                },
                120000
            );
            if (result.outcome === 'approved') {
                const p: any = result.payload;
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, archived: p.archived, skipped: p.skipped }, null, 2) }] };
            }
            return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'User rejected bulk deletion.' }, null, 2) }] };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
        }
    }
);
```

Note: `sendWSMessageWithMultiResponse` currently resolves on specific message types; confirm it forwards `task:bulkDeleteResult`/`task:bulkDeleteRejected` to the predicate (it is generic — grep its definition). If it filters by a fixed list, add these two types.

- [ ] **Step 2: Add `all_worktrees` to `claudia_list_tasks`**

Change the tool's input schema from `{}` to `{ all_worktrees: z.boolean().optional().describe('Include every task across all of this workspace\\'s worktrees (default true).') }`. The read scope already spans worktrees; this flag documents/guarantees it. When `all_worktrees === false`, filter to `WORKSPACE_ID` only.

- [ ] **Step 3: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors. (MCP tools have no vitest harness; validated end-to-end in Task 5.)

- [ ] **Step 4: Commit**

```bash
git add backend/src/claudia-mcp-server.ts
git commit -m "feat: claudia_delete_tasks bulk tool + all_worktrees list flag"
```

---

### Task 5: test-CLI commands for end-to-end verification

Per CLAUDE.md, add CLI coverage so the flows are testable without the UI.

**Files:**
- Modify: `backend/test-cli.ts`

**Interfaces:**
- Consumes: the WS handlers from Tasks 2–3.

- [ ] **Step 1: Add `--reap-orphans-dry` command**

Add a CLI branch that opens a WS, sends `{ type: 'worktree:reapOrphans', payload: { dryRun: true } }`, prints the `worktree:reapResult` payload (orphan count + ids), and exits. This is the safe way to confirm the 80 orphans are detected before any real removal.

- [ ] **Step 2: Add `--list-fleet` command**

Add a CLI branch that fetches `/api/tasks` and `/api/workspaces`, applies `computeWorkspaceScope(workspaces, <rootId-arg>)`, and prints how many tasks fall in scope grouped by state — reproducing what an agent's `claudia_list_tasks` would see.

- [ ] **Step 3: Run the dry-run against the live backend**

Run: `cd backend && npx tsx test-cli.ts --reap-orphans-dry`
Expected: prints ~80 orphan worktree ids, `removed: []` (dry run). Confirms detection before destructive use.

- [ ] **Step 4: Commit**

```bash
git add backend/test-cli.ts
git commit -m "test: CLI commands for orphan-reap dry-run and fleet listing"
```

---

### Task 6: Frontend — batched bulk-delete confirmation modal

The user approves the whole list once. Listens for `task:bulkDeleteConfirm`, shows a modal with the task list + count, and sends `task:bulkDeleteApprove` (with `excludeTaskId`) or `task:bulkDeleteReject`.

**Files:**
- Create: `frontend/src/components/BulkDeleteModal.tsx`
- Modify: the top-level component that already handles the single-delete confirm broadcast (grep `task:deleteRequest\|deleteRejected` in `frontend/src`), plus `useWebSocket.ts` if message routing is centralized.
- Test: manual via Playwright MCP (visual) — see Step 3.

**Interfaces:**
- Consumes: WS `task:bulkDeleteConfirm` `{ requestId, tasks: {id,name}[] }`.
- Produces: WS `task:bulkDeleteApprove` `{ requestId, taskIds, excludeTaskId }` / `task:bulkDeleteReject` `{ requestId }`.

- [ ] **Step 1: Build the modal component**

A modal listing `tasks` (scrollable, shows count in the header: "Delete N tasks?"), an "Archive all" primary button and "Cancel". On confirm, send `task:bulkDeleteApprove` with the ids; on cancel/overlay-click, send `task:bulkDeleteReject`. Mirror the styling of the existing delete-confirm modal.

- [ ] **Step 2: Wire the broadcast listener**

Where the single-delete confirm is handled, add a handler for `task:bulkDeleteConfirm` that opens `BulkDeleteModal` with the payload. Show a toast on `task:bulkDeleteResult` ("Archived X, skipped Y").

- [ ] **Step 3: Manual verification (Playwright MCP)**

Drive the UI: trigger a bulk delete (via the test-CLI or an MCP call from a scratch task) with 2–3 throwaway task ids, confirm the modal shows the list and count, approve, and confirm the tasks leave the sidebar. Screenshot before/after. Tear down any throwaway tasks/worktrees created.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/BulkDeleteModal.tsx frontend/src/<wired-files>
git commit -m "feat: batched bulk-delete confirmation modal"
```

---

## Self-Review

**Spec coverage:**
- Cross-worktree listing ("same workspace across worktrees") → Task 1 (resolver + tests) + Task 4 Step 2 (`all_worktrees`).
- Bulk delete, user-gated, one confirmation → Tasks 2 (handler), 4 (MCP tool), 6 (modal).
- Reap the 80 orphaned worktrees → Task 3 (+ Task 5 dry-run for safe verification).
- "Active tasks never silently deleted" → batched confirmation + self-exclusion in Tasks 2/4.
- Testability via CLI → Task 5.

**Placeholder scan:** Task 6 leaves the exact wired-file names to a grep because the frontend delete-confirm plumbing must be located first; every backend task has concrete code. No TBD/TODO in code steps.

**Type consistency:** WS message literals (`task:bulkDeleteRequest/Confirm/Approve/Reject/Result/Rejected`, `worktree:reapOrphans/reapResult`) are defined once in `shared/src/index.ts` (Task 2 Step 5) and reused verbatim in Tasks 3, 4, 6. `resolveBulkDelete`, `findOrphanWorktrees`, `computeWorkspaceScope` signatures match across their definition and call sites.

**Pre-verified:** `sendWSMessageWithMultiResponse` (claudia-mcp-server.ts:289) is generic — line 313 passes every message to the matcher, so the bulk-delete predicate works. `workspaceStore.getWorkspaces()` (workspace-store.ts:93) is the workspace accessor.
