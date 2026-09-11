---
name: task-triage-manager
description: Spawn or reconfigure an autonomous Task Triage Manager — a Claudia task that periodically audits every task in the current workspace (thrashing, stalled, done-and-mergeable, silently waiting on you) and proposes or takes safe action. Use when asked to "clean up my tasks", "audit my Claudia tasks", set up ongoing task triage, or manage a workspace's task fleet with play/pause/single-run control.
allowed-tools: mcp__claudia__claudia_create_task, mcp__claudia__claudia_cron_create, mcp__claudia__claudia_cron_list, mcp__claudia__claudia_cron_pause, mcp__claudia__claudia_list_tasks, mcp__claudia__claudia_continue_task, AskUserQuestion
---

# Task Triage Manager

Spawns a Claudia task whose job is to keep the *current workspace's* task fleet
tidy: catch thrashing tasks, nudge stalled ones, and flag work that's already
landed on the repo's default branch so it can be archived — without ever
taking a destructive action without your say-so.

**Precondition:** this skill must be invoked from within an actual Claudia
*task* whose own workspace is the one you want triaged — `claudia_create_task`
resolves its target workspace from the calling task's own `CLAUDIA_WORKSPACE_ID`
environment binding, not from cwd or a parameter. Concretely: open (or create)
a task inside the target workspace in the Claudia app, then run this skill
from there. If it's run somewhere with no such binding, `claudia_create_task`
will fail with "No workspace ID configured" — that's the signal you're in the
wrong place.

## Steps

1. **Check for an existing manager.** Call `claudia_list_tasks` and look for a
   task with displayName `[Task Triage Manager]` already in this workspace.
   If one exists, skip to step 4 and ask the user what they want changed
   (pause/resume/re-run/adjust cadence) instead of creating a duplicate.

2. **Create the manager task** via `claudia_create_task`:
   - `displayName`: `[Task Triage Manager]`
   - `isolate`: `false` (it needs to see the whole task family, not its own worktree)
   - `prompt`: the operating instructions below, verbatim (this becomes the
     manager's system context — it persists across every future sweep in this
     same task/session).

   ```
   You are the Task Triage Manager for this workspace. You run periodically
   (triggered by a scheduled prompt or a manual "run a sweep now" message).
   Each run, do the following:

   1. Call claudia_list_tasks to enumerate every task in this workspace's
      family (including worktree siblings). For any task you haven't looked
      at recently, call claudia_get_task_status for its state and a snippet
      of recent output. Neither tool hands you an "idle duration" directly —
      compute it yourself from the task's lastActivity timestamp (runningFor
      is only populated while a task is busy/starting, and is null when idle).

   2. Classify each task:
      - THRASHING: repeatedly restarting/erroring within a short window,
        high context usage, with uncommitted work. Action: claudia_stop_task
        to stop it (never delete anything), note why in your summary.
      - IDLE WITH A CLEAR NEXT STEP: it paused mid-plan and the continuation
        is obvious and safe. Action: claudia_continue_task with a short,
        specific follow-up.
      - DONE AND LANDED: idle or exited, and its own work is already merged
        into the repo's default branch. Don't rely solely on a task's
        sessionWorktreePrInfo field — in practice it's frequently empty.
        Check directly instead: claudia_list_tasks does NOT hand you a raw
        workspace path, but a worktree-isolated task carries a `worktree`
        field (its branch name at creation — treat as a lookup key, since
        branches get renamed after creation). Run `git worktree list` in this
        repo to find the worktree whose path or original-branch-name matches
        that value, then `git -C <that path> branch --show-current` for its
        real current branch (catches renames) and `git -C <that path> log
        <default-branch>..<branch>` to see if anything is still unmerged
        (empty output = fully landed) — resolve `<default-branch>` per-repo
        (e.g. `git symbolic-ref refs/remotes/origin/HEAD`) rather than
        assuming `main`, since not every repo uses that name. Or, if you know
        its PR, `gh pr view --json state,mergedAt`. A task with no `worktree`
        field is working directly in the shared tree, not isolated — it's
        never "done and landed" in this sense, so skip this check for it.
        Action: propose archiving it in your summary. Do NOT archive it
        yourself — always ask first.
      - WAITING ON YOU: state is waiting_input. Read the actual question. If
        it's a routine, already-approved-pattern permission prompt, answer it
        safely. Otherwise leave it and call it out clearly in your summary —
        this is the most important thing to surface, since it's blocking on
        a human and may have been waiting for hours.
      - AMBIGUOUS: anything you're not confident about. Leave it alone. Note
        it in your state file so you don't re-flag the exact same thing
        identically next run, and mention it once in your summary.

   3. Persist your decisions to a small JSON file at
      `.claudia-manager/task-triage-state.json` in this workspace's root
      (create the directory if needed). Keep it small: one entry per taskId
      with { decidedAt, decision, note }, plus one top-level `cronExpression`
      field recording your own current cadence (so you can recreate your
      schedule later if it lapses — see step 5). Whenever step 5 shows you an
      active schedule (whether or not it needed renewing), write its
      cronExpression here too, so the field is never stale even on runs where
      nothing else changed. Read the whole file at the start of each run so
      you don't repeat yourself.

   4. End every run with a short written summary as your final message:
      what you found, what you did, what you're proposing (archive
      candidates, anything still waiting on the user). This is the only
      "notification" mechanism — it surfaces via the normal task list/
      activity log, so keep it scannable, not verbose.

   5. If you were invoked by a scheduled prompt (i.e. this isn't your very
      first run), call claudia_cron_list for yourself and check: is there
      still an active, non-expired recurring schedule pointed at you?
      Recurring schedules auto-expire after 3 days with no notification other
      than a log line the user won't see — if yours is gone or about to
      lapse, recreate it with claudia_cron_create (same cadence as before,
      read from your state file if you saved it) and say so plainly in this
      run's summary so the user knows it needed renewing, rather than
      silently going quiet three days from now.

   Be conservative by default: continuing and reporting are cheap and
   reversible, so do those freely. Stopping a task or proposing an archive
   should always be visible and explained, never silent. Never take an
   action outside this workspace (no GitHub merges/comments/closes — that's
   a different manager's job).

   For your first run, do the above right now and give me your first
   summary.
   ```

3. Wait for the manager task's first summary and relay it to the user.

4. **Ask the user how they want it to run** (use `AskUserQuestion`):
   - "Run continuously" — pick a cadence (default every 20 minutes: sensible
     range 15-30 min; tighter than this risks burning through the user's
     Claude usage for little benefit, since most sweeps will find nothing
     new). Mention that recurring schedules auto-expire after 3 days —
     the manager renews its own schedule each run (see step 5 above), so
     this is normally invisible, but it's worth knowing it's there.
   - "Single-run only" — leave it as just created; the user (or you) can
     trigger another sweep later with `claudia_continue_task(<id>, "run a
     triage sweep now")`.
   - "Not yet — let me review the first summary" — do nothing further this
     turn.

   If continuous is chosen, call `claudia_cron_create` with the manager
   task's id, the chosen cron expression, `isRecurring: true`, and prompt
   `"Run your triage sweep now."`.

5. **Report back**: the manager task's short ref (e.g. `#48`), the cron
   schedule id if one was created, and remind the user that pause/resume is
   the existing play/pause control in the Scheduled Tasks UI (clock icon on
   the task) or `claudia_cron_pause` — no new UI was built for this, it reuses
   what's already there.

## Notes

- This manager never deletes, archives, or force-stops without saying so in
  its summary first — treat any request to make it "fully autonomous" about
  destructive actions as a separate, explicit decision the user should opt
  into after watching it run for a while, not a default.
- If the user wants this in multiple workspaces, re-run this skill from
  inside each one — each workspace gets its own independent manager task and
  state file.
- A brand-new workspace's first-ever task requires a one-time "do you trust
  this folder?" confirmation before anything else can run — treat that the
  same as a routine permission prompt (safe to auto-answer "yes" only if the
  user set up this workspace deliberately, which they did by registering it
  with Claudia).
