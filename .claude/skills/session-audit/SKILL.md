---
name: session-audit
description: Use when asked to audit Claude Code sessions or Claudia tasks for usage patterns, mine session history for agent/feature ideas, synthesize workflows into scoped GitHub issues, or re-prioritize existing issues from session evidence.
---

# Session Audit

## Overview
Mine this machine's Claude Code session history + Claudia task metadata for recurring workflows, then convert them into evidence-backed GitHub issue drafts. Evidence = counts + anonymized quotes, never raw dumps. All GitHub mutations are DRAFTED, then applied only after the approval gate (step 6).

## Data sources
1. `~/.claude/projects/<encoded-workspace>/*.jsonl` — one file per session. Encoded dir name = workspace path with non-alphanumerics → `-`.
2. Claudia backend (if present): `backend/tasks.json` (`.tasks` + `.archivedTasks`: prompt, displayName, workspaceId, timestamps, lastState, wasInterrupted), `backend/scheduled-tasks.json` (cron), `backend/config.json` (enabled/disabled scaffolds).

## Procedure

### 1. Partition the corpus (don't double-count)
Enumerate ALL project dirs; if fanning out, assign each dir to exactly one auditor. Classify every file into exactly one class:
- **real** — has ≥1 genuinely typed user prompt
- **stub** — slash-command-only or non-transcript records (e.g. a single `last-prompt` metadata line; not every JSONL line is a message record)
- **agent-spawned** — only tool traffic, no typed prompt
- **corrupted** — opening is terminal-escape garbage (`;2c`, `?1;2c`); tally these as a pain-point signal too
- **active** — the session currently running this audit; EXCLUDE it from pain-point statistics (its interrupts reflect the audit itself)

Worktree dirs (`*--claudia-worktrees-*`) ≈ one Claudia task each. Report counts per class; only **real** sessions feed pattern mining.

### 2. Extract prompts correctly
First real user message = `type:"user"` record whose text is NOT: a tool_result; starting with `[` or `<`; a slash-command expansion (record has `<command-name>` tags or follows one); a skill-body injection (starts with "Base directory for this skill"); or flagged `isMeta:true`. Slash-command templates like the `/doctor` fix prompt are RITUAL evidence, not archetype prompts — don't cluster them as typed intent. This includes templates PASTED as plain text: any multi-sentence opener appearing verbatim in ≥2 workspaces is a template → file under rituals, and use the session's first non-template message as its intent instead.

### 3. Cluster with hand verification
Keyword classifiers over-collapse (baseline runs misfiled ~30% into a catch-all). Auto-cluster first, then read every cluster's members' opening prompts and re-file by hand. Report counts as curated, with 1–2 representative quotes each.

### 4. Mine four things
- **Archetypes**: named clusters + counts.
- **Rituals**: repeated multi-step shapes (fan-out → poll → synthesize; issue → worktree → PR; audit → fix → verify). Fan-out = ≥3 tasks, same repo, `createdAt` within a 5-minute window.
- **Pain points**: `[Request interrupted by user]` counts, bare `continue`/`yes`/`status?` re-prompts, corrupted openings, duplicate throwaway prompts (`hi` twice in seconds = input-delivery failure), hand-pasted defensive boilerplate (`reset --hard` preambles).
- **Hand-rolled scaffolds**: cron babysitters, templated role preambles, disabled config features users rebuild manually (`supervisorEnabled:false` + hand-written monitor crons) — the highest-value candidates.

### 5. Cross-reference GitHub (read-only)
`gh issue list --limit 200 --state open --json number,title,labels`. A pattern **matches** an issue when the issue's problem statement would be solved by automating the pattern — judge semantically, not by title keywords. Before drafting anything, check whether the repo already fixed it (recent commits/PRs); if so, note "already addressed", draft nothing. Then:
- match → **draft** a comment with the new evidence (counts, quotes)
- match + evidence from a second machine (only when the user states the prior evidence came from elsewhere, or the request says so) → also **draft** a priority-label bump (p2→p1→p0)
- no match → **draft** a new issue: Problem / Evidence / Proposal / Acceptance criteria

### 6. Approval gate + report
Present one report with sections in this order: **Corpus partition** (counts table) → **Archetypes** → **Rituals** → **Pain points** → **Scaffolds** → **Issue actions** (drafted comments / bumps / new issues). Apply GitHub mutations only after the user approves, unless their request pre-authorized updates.

## Common mistakes
- Trusting task-ID references to attribute sessions: audit/orchestrator sessions reference other tasks' IDs; prefer first-prompt ↔ task-prompt matching.
- Reading whole files: sample opening + first ~15 user messages; grep for markers beyond that.
- Pasting personal VALUES into issues (balances, names, addresses, health details) — anonymize. Describing a financial/health-domain *workflow* is fine; quoting its data is not.
