# Archived-Task Worktree Retention — Design

**Date:** 2026-07-18
**Status:** Approved (pending spec review)

## Problem

Isolated tasks run inside a git *worktree* — a private on-disk copy of the repo under
`<repo>/.claudia-worktrees/<branch-slug>/`. Worktrees are **workspace/branch-scoped, not
task-scoped**, and arrive two ways:

1. **Auto-worktree** — Claudia runs `git worktree add` and registers a worktree *workspace*;
   the task's `workspaceId` **is** that worktree path (`server.ts:~1355`, `addWorktreeWorkspace`).
2. **Session worktree** — the Claude session itself runs `git worktree add`; the task stays in
   its original workspace but records `task.sessionWorktreeBranch`, discovered on idle
   (`server.ts:814,988`).

`archiveTask` and `destroyTask` (`task-spawner.ts:3927,4010`) remove the task but **never remove
the worktree folder**. `removeWorktree` is only ever called from the manual `worktree:remove`
handler. Result: every archived isolated task leaves its folder behind → observed backlog of ~59
folders, with no mechanism to reclaim the disk.

## Goal

Automatically reclaim worktree disk once a task is genuinely done, without ever risking active
work or committed history.

## Non-Goals

- No change to how worktrees are *created*.
- No deletion of git branches (branch refs are cheap and preserve unmerged commits).
- No sidebar redesign. A lightweight inventory count is in scope; rich UI is a follow-up.

## Approved Behavior (decisions locked)

- **Trigger:** a time-based retention sweep. Archived tasks older than `retentionDays` (default
  **30**) are fully deleted, worktree folder included.
- **Active tasks are never touched.** The sweep iterates only the `archivedTasks` set. Before
  removing any worktree it verifies no live/disconnected/active task references that path/branch.
- **Dirty worktrees are force-removed** once past the retention window (user decision). Committed
  work survives on the retained branch; only uncommitted scratch is lost — acceptable for a
  30-day-abandoned folder.
- **Opt-out / control:** `retentionDays = 0` disables the auto-sweep. Setting is user-visible.

## Design

### 1. Data model — record when a task was archived

`ArchivedTaskMetadata` (`task-spawner.ts:239`) currently has `createdAt` and `lastActivity` but no
archive timestamp, and no worktree pointer for session worktrees.

- Add `archivedAt: string` (ISO). Set it in `archiveTask`.
- Add `sessionWorktreeBranch?: string` — carried over from the live task so the sweep can resolve
  a session worktree's path via `WorktreeManager.isBranchInWorktree`.
- **Backfill on load:** existing archived entries have no `archivedAt`; default it to
  `lastActivity` (fallback: persistence-file mtime) so the current backlog ages correctly.

### 2. Worktree resolution for an archived task

- **Auto-worktree:** the archived task's `workspaceId` is the worktree path *iff* a workspace is
  registered there with `worktreeParentId` set (parent repo = `worktreeParentId`).
- **Session worktree:** resolve `sessionWorktreeBranch` → path via
  `WorktreeManager.isBranchInWorktree(parentRepo, branch)`.
- A worktree may be shared by multiple tasks; resolution yields a candidate path that the guard
  (below) re-checks.

### 3. Retention sweep

A daily job, registered like the existing idle reaper (`task-spawner.ts:1100`), plus one run
shortly after startup. For each archived task with `now - archivedAt > retentionDays`:

1. Resolve candidate worktree path(s).
2. **Guard:** skip worktree removal if any non-archived task (live/disconnected in the tasks map)
   has `workspaceId === worktreePath` **or** `sessionWorktreeBranch === branch`.
3. `WorktreeManager.removeWorktree({ force: true })`. If it fails because the worktree is *locked*,
   unlock then retry (`--force --force` semantics); log and continue on any other failure.
4. If the removed path is a registered worktree workspace: `workspaceStore.deleteWorkspace(path)`
   and broadcast `workspace:deleted`.
5. Delete the archived task's metadata + history file (reuse the existing archived-delete path used
   by `task:archived:delete`); broadcast `task:archived:deleted` / `tasks:updated`.
6. **Log every removal and every skip with reason** (no silent caps).

The interval handle is cleared on shutdown alongside the other reapers.

### 4. Config

- Add `archivedTaskRetentionDays: number` to `AppConfig` / config-store defaults (**30**), with
  validation (`validation.ts`): non-negative integer, `0` disables.
- Settings UI: a number field + note ("Archived tasks and their worktree folders are deleted after
  N days. 0 = never."). The sweep reads `configStore` each run, so changes take effect without
  restart.

### 5. Backlog reconciliation — "Clean up now"

A WS message (and test-CLI command) that runs the sweep immediately **and** additionally removes
truly orphaned worktree folders — entries in `git worktree list` under `.claudia-worktrees/` whose
owning task no longer exists in either the active or archived sets. Force-remove, same guard,
report counts.

### 6. Visibility (accurate count/control)

A read-only inventory the user asked for: an endpoint + test-CLI command reporting, per repo, the
worktree folders on disk with — for each — owning-task state (active / archived / orphaned), age,
and dirty/clean. This makes the "how many, and how many are cleanable" question answerable without
guessing from folder counts. A sidebar badge is a possible follow-up, not part of this spec.

## Safety Summary

- Sweep deletes **only** archived tasks; it never enumerates live tasks for deletion.
- Every worktree removal is gated on "no active/disconnected task references this".
- Branches are retained → committed history is never lost.
- Dirty force-remove is intentional and bounded to the >`retentionDays` window.
- `retentionDays = 0` fully disables automatic deletion.

## Testing

- **Unit (vitest):** `archivedAt` set on archive; backfill on load; sweep selects only entries past
  the cutoff; guard skips worktrees shared with an active task; dirty worktree is force-removed;
  branch survives removal; `retentionDays = 0` disables.
- **Test CLI (`backend/test-cli.ts`):** commands to (a) print the worktree inventory (§6), and
  (b) run the sweep with an explicit cutoff and a `--dry-run` flag that logs what *would* be removed
  without touching disk. Dry-run is the primary manual-verification path.
- Clean up any temporary worktrees/fixtures created during testing.

## Rollout

Ship behind the config default of 30 days. First sweep will clear the aged portion of the current
backlog; the rest ages out or is cleared via "Clean up now".
