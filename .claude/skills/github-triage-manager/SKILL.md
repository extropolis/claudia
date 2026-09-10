---
name: github-triage-manager
description: Spawn or reconfigure an autonomous GitHub Triage Manager — a Claudia task that periodically scans a repo's open PRs/issues/notifications, skips anything already owned by a live Claudia task, and spawns worker tasks for the rest (rebase, fix CI, address review comments). Use when asked to triage GitHub PRs/issues, set up ongoing PR/inbox triage, or manage a repo's review queue with play/pause/single-run control.
allowed-tools: mcp__claudia__claudia_create_task, mcp__claudia__claudia_cron_create, mcp__claudia__claudia_cron_list, mcp__claudia__claudia_cron_pause, mcp__claudia__claudia_list_tasks, mcp__claudia__claudia_continue_task, Bash, AskUserQuestion
---

# GitHub Triage Manager

Spawns a Claudia task whose job is to keep one repo's open PRs/issues moving:
detect what needs rebasing, what's CI-red, what has unanswered review
comments, and what's ready to merge — then either spawn a worker task to fix
it or flag it for your approval. It never merges, closes, comments, or
relabels on its own; those leave the machine and always come back to you.

**Precondition:** this skill must be invoked from within a Claudia task whose
own `CLAUDIA_WORKSPACE_ID` binding is the workspace tracking the target repo
(`claudia_create_task` resolves its target workspace from the caller's own
binding, not from cwd or a parameter — it errors with "No workspace ID
configured" if run somewhere without one).

## Steps

1. **Determine the repo.** Use `$ARGUMENTS` if it names an `owner/repo`;
   otherwise infer it from the current workspace's git remote, or ask the
   user. Start scoped to exactly one repo — if the user wants more than one,
   run this skill again per repo rather than building a multi-repo prompt.

2. **Check for an existing manager.** Call `claudia_list_tasks` and look for
   a task with displayName `[GitHub Triage Manager: <repo>]` already present.
   If one exists, skip to step 4 and ask what the user wants changed instead
   of creating a duplicate.

3. **Create the manager task** via `claudia_create_task`:
   - `displayName`: `[GitHub Triage Manager: <owner/repo>]`
   - `isolate`: `false`
   - `prompt`: the operating instructions below, with `<owner/repo>`
     substituted, verbatim. This persists as the manager's context across
     every future sweep in this same task/session.

   ```
   You are the GitHub Triage Manager for <owner/repo>. You run periodically
   (triggered by a scheduled prompt or a manual "run a sweep now" message).
   Each run, do the following:

   1. Enumerate open work (pass --limit explicitly — both commands default to
      only 30 results, which silently drops the tail on any repo with more
      open PRs/issues than that):
      `gh pr list --repo <owner/repo> --limit 200 --json number,title,url,isDraft,mergeable,reviewDecision,statusCheckRollup,headRefName`
      `gh issue list --repo <owner/repo> --limit 200 --json number,title,url,labels,assignees --state open`
      and check for anything needing your attention in notifications:
      `gh api notifications` filtered to this repo (or ask about
      GET /api/github/notifications if this repo is registered as a Claudia
      workspace).

   2. Cross-reference against live Claudia tasks so you never duplicate work
      already in flight. In practice, tasks rarely have their
      sessionWorktreePrInfo field populated, and a PR's number rarely
      appears verbatim in a task's prompt/displayName (e.g. a task titled
      "Audio transcription pipeline" owns a PR with no mention of its number
      anywhere) — number-substring matching alone WILL miss real ownership.
      Use branch name as the primary signal instead, via this join (`claudia_list_tasks`
      does NOT return a raw workspace path — don't look for one; it returns a
      `worktree` field instead, which is what to use):
        a. Call claudia_list_tasks. Each worktree-isolated task carries a
           `worktree` field — usually its branch name as recorded at creation
           time, but it's a label to look up with, not a final answer:
           branches often get renamed after creation (e.g. `claudia/task-xxx`
           renamed to something descriptive once real work starts), so the
           recorded name can be stale.
        b. Run `git worktree list` in this repo to get every live worktree's
           path and its CURRENT branch. Find the worktree whose path or
           original-branch-name matches a task's `worktree` value, then run
           `git -C <that worktree's path> branch --show-current` to get its
           real, current branch (this is what actually catches a rename).
           Compare that branch to each PR's headRefName.
      A task with no `worktree` field (i.e. it's working directly in the main
      workspace, not isolated) can't own a PR this way — fall back to
      number-substring-in-text matching only for those. Log any PR you
      couldn't confidently resolve either way as "ownership unclear" rather
      than silently guessing.

   3. For each unowned PR, categorize:
      - NEEDS REBASE: mergeable state shows conflicts.
      - NEEDS CI FIX: statusCheckRollup shows a failing check. Before
        spawning a worker, distinguish a genuine failure from an aborted/
        cancelled run (e.g. all checks show CANCELLED, none actually FAILED)
        — the latter just needs a re-trigger, not a code fix; say so in the
        worker prompt you write. Also check whether multiple unowned PRs are
        failing on the *same named check* — if so, that's one shared root
        cause, not N independent ones: spawn a single diagnostic worker (or
        flag it for the user) rather than one worker per PR.
      - NEEDS REVIEW: checks are green/clean, no conflicts, but it has no
        reviews yet — distinct from a PR that has reviews requesting
        changes (that's NEEDS REVIEW RESPONSE) or one that's genuinely
        untouched and old (STALE/BACKLOG). Don't collapse "green and
        clean but nobody's looked at it yet" into stale-backlog.
      - NEEDS REVIEW RESPONSE: has unresolved review comments or changes
        requested.
      - READY TO MERGE: checks green, approved, no conflicts.
      - STALE/BACKLOG: old, untouched, no clear next action, and not simply
        awaiting its first review.

      For each unowned open issue, categorize similarly (e.g. claimed with
      an active PR/assignee vs. genuinely open vs. stale-and-closeable).

   4. For NEEDS REBASE / NEEDS CI FIX / NEEDS REVIEW RESPONSE items, spawn a
      worker: claudia_create_task with isolate: true and a short, specific
      prompt in the same style you'd write by hand, e.g. "Rebase PR #<N> in
      <owner/repo> onto the latest default branch, resolve conflicts, verify,
      and push." (don't hardcode "main" — resolve the repo's actual default
      branch, e.g. via `gh repo view --json defaultBranchRef`, since not
      every repo uses that name) or "Diagnose PR #<N>'s failing CI: if it's a
      genuine code failure, fix it; if the run was cancelled/aborted, just
      re-trigger it." or "Address the unresolved review comments on PR #<N>."

   5. For READY TO MERGE, NEEDS REVIEW, STALE/BACKLOG, or anything that would
      require merging, closing, commenting, or relabeling: do NOT act. List
      these clearly in your summary as items awaiting your explicit approval.
      This line never moves — these are the only actions that leave the
      machine, and they always need a human yes.

   6. Persist your decisions to a small JSON file at
      `.claudia-manager/github-triage-state.json` in this workspace's root
      (create the directory if needed), keyed by `<owner/repo>#<number>`,
      with { decidedAt, decision, note }, plus one top-level `cronExpression`
      field recording your own current cadence. Read it at the start of each
      run so you don't re-spawn a worker for a PR you already handled, and
      don't re-flag the same ready-to-merge PR identically every single run
      (a quiet reminder in the summary is fine; don't repeat the full
      write-up).

   7. End every run with a short written summary: what's moving (workers
      spawned and for what, including any shared-root-cause consolidation),
      what's stuck (blocked on you), and what's ready for your approval. Keep
      it scannable.

   8. If you were invoked by a scheduled prompt (i.e. this isn't your very
      first run), call claudia_cron_list for yourself and check: is there
      still an active, non-expired recurring schedule pointed at you?
      Recurring schedules auto-expire after 3 days with no notification other
      than a log line the user won't see — if yours is gone or about to
      lapse, recreate it with claudia_cron_create (same cadence as before,
      from your state file) and say so plainly in this run's summary so the
      user knows it needed renewing, rather than silently going quiet three
      days from now.

   Be conservative: spawning a worker to fix something is safe and
   reversible (it's just another Claudia task you can stop), so do that
   freely for genuinely unowned, actionable items. Never touch anything
   outside this repo, and never take the merge/close/comment/relabel step
   yourself.

   For your first run, do the above right now and give me your first
   summary.
   ```

4. Wait for the manager task's first summary and relay it to the user.

5. **Ask the user how they want it to run** (use `AskUserQuestion`):
   - "Run continuously" — pick a cadence (default every 45 minutes: PR/issue
     churn is bursty rather than continuous, and each sweep costs several
     `gh` calls plus an LLM pass, so tighter than 30 min mostly burns quota
     for no new information). Mention that recurring schedules auto-expire
     after 3 days — the manager renews its own schedule each run (see step 8
     above), so this is normally invisible, but it's worth knowing it's there.
   - "Single-run only" — leave it as just created; trigger another sweep
     later with `claudia_continue_task(<id>, "run a triage sweep now")`.
   - "Not yet — let me review the first summary" — do nothing further.

   If continuous is chosen, call `claudia_cron_create` with the manager
   task's id, the chosen cron expression, `isRecurring: true`, and prompt
   `"Run your triage sweep now."`.

6. **Report back**: the manager task's short ref, the cron schedule id if
   created, and remind the user pause/resume uses the existing Scheduled
   Tasks UI (clock icon on the task) or `claudia_cron_pause`.

## Notes

- This manager's worker-spawning is the only "autonomous action" — it's
  scoped to read-only-repo-state-driven task creation, not to anything that
  posts, merges, or closes. Treat any request to let it merge/close/comment
  automatically as a separate, explicit decision, not a default.
- If two workers could plausibly target the same PR (e.g. a rebase fix and a
  CI fix both needed), spawn one worker with a combined prompt rather than
  two competing ones — the state file's per-PR key naturally prevents this
  as long as you check it before spawning.
- Ownership matching is branch-name-first, not PR-number-in-text — a live
  dry run against a real repo showed the number-substring fallback alone
  produces false negatives (a task named after a feature, not a PR number,
  reads as "unowned" even though it's actively working that exact PR).
