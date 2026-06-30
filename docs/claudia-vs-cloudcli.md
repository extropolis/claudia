# Claudia vs CloudCLI

A comparison between **Claudia** (this project) and **[siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)** (aka **CloudCLI**, formerly Claude Code UI).

> _Snapshot date: 2026-06-18_

---

## TL;DR

They're **closer to peers than alternatives** — both are web UIs for Claude Code with mobile access, plugins, workspaces/sessions, and git integration. But they made different bets:

- **Claudia** is an **orchestrator first** — multi-task, multi-workspace, parallel agents that coordinate via MCP. Single-user power-tool.
- **CloudCLI** is a **client first** — one polished chat per session, beautiful UX across desktop+mobile, plugin marketplace, with a paid Cloud tier behind it. 12k stars, commercial company, ships support for new Claude models the same week they launch.

CloudCLI has solved Claudia's terminal-garbling problem because **it never put the TUI in a browser** — it runs Claude Code via the **Agent SDK** with `stream-json` output and renders structured events as React components. That's the architectural lesson worth stealing regardless of what you decide to do.

---

## Side-by-side feature matrix

| Feature | Claudia | CloudCLI |
|---|---|---|
| **Stars / activity** | (this repo) | 12k stars, 1.6k forks, weekly releases |
| **License** | MIT-ish | AGPL-3.0-or-later |
| **Commercial backing** | No | Yes (Siteboon, sells CloudCLI Cloud at $7+/mo) |
| **Stack** | Express + React + xterm.js + node-pty | Express + React + Vite + Tailwind, Claude Agent SDK |
| **How it talks to Claude Code** | **PTY** (node-pty spawning `claude` interactive) | **Claude Agent SDK** with `stream-json` (no PTY) |
| **Garbling / resize hell** | ❌ Active fight (8+ commits) | ✅ Doesn't apply — no terminal |
| **Slash commands** | ✅ Native (real TUI) | ✅ Reimplemented in React (`/` triggers suggestions) |
| **Permission prompts** | ✅ Native TUI | ✅ React dialogs, **persisted across WebSocket reconnects** |
| **Plan mode** | ✅ Native | ✅ Native React `PlanDisplay` primitive |
| **Multi-task / parallel agents** | ✅ **Yes — core feature** | ⚠️ Multiple sessions, but not parallel-orchestrated |
| **Multi-workspace** | ✅ Yes | ✅ Yes (auto-discovers `~/.claude/projects`) |
| **Cross-task coordination** | ✅ **Claudia MCP** (siblings spawn each other) | ❌ No equivalent |
| **AI Supervisor Chat** | ✅ Right-panel AI that orchestrates other tasks | ❌ No |
| **Multiple agents (Claude / Cursor / Codex / Gemini)** | ⚠️ Claude Code + OpenCode | ✅ Claude Code, Cursor CLI, Codex, Gemini |
| **Mobile** | ✅ Expo native app + ngrok tunnel + voice | ✅ Responsive PWA, native app coming |
| **Voice input** | ✅ Deepgram on desktop + mobile | ❌ Removed Whisper code (per changelog) |
| **File explorer** | ⚠️ Recent commits | ✅ Polished, syntax highlighting, live editing |
| **Git integration** | ✅ Diffs, revert | ✅ Stage / commit / branches, redesigned panel |
| **Full-text search across conversations** | ❌ | ✅ |
| **Session rename / SQLite storage** | ⚠️ JSON files | ✅ better-sqlite3 with migrations |
| **Plugin system** | ❌ Internal "plugins" (claude-code/opencode/hai-proxy backends) | ✅ **Real third-party marketplace** — Project Stats, Claude Watch, Scheduler, PRISM, Token Calc, Task Queue, GitHub Issues board |
| **Checkpoints / git snapshots** | ✅ **Yes — restore / fork** | ❌ |
| **Cron scheduling** | ✅ Built-in | ✅ Via "CloudCLI Scheduler" plugin |
| **Token usage / cost tracking** | ✅ | ✅ With cache token support, modal viewer |
| **Notifications** | ✅ Mobile push (Expo) | ✅ Browser notifications system |
| **Docker sandbox / microVM** | ❌ | ✅ Experimental, hypervisor-level |
| **Cloud-hosted tier** | ❌ | ✅ $7/mo |
| **i18n** | ❌ English only | ✅ 10+ locales (en, ru, de, ko, zh-CN, zh-TW, ja, tr, it, …) |
| **MCP sync with `~/.claude`** | ✅ But skips own workspace | ✅ Native — UI is the same config |
| **Electron desktop app** | ✅ | ❌ Browser only |
| **Auto-reload dev experience** | ✅ tsx watch + custom dev-watcher | ✅ Vite HMR |
| **Codebase scale** | ~65k lines TS/TSX, 169 files | ~700 commits, larger team |

---

## Where Claudia is genuinely better

These are real differentiators — not just things CloudCLI hasn't gotten to:

1. **Parallel multi-agent orchestration.** CloudCLI is "lots of sessions you can switch between." Claudia is "agents working at the same time, coordinating via MCP, supervised by another agent." Fundamentally different product.
2. **Claudia MCP server** — sibling-task spawning. CloudCLI has no equivalent.
3. **Supervisor Chat** with tool-calling to orchestrate tasks. Closest CloudCLI has is plugins like "Task Queue."
4. **Checkpoints** with git snapshots, restore, fork. Genuinely rare.
5. **Native mobile app** with voice input. CloudCLI is browser-PWA only.
6. **Electron desktop wrapper** for users who want a real app icon.
7. **Workspace-scoped system prompts and references** (cross-project read-only context).

## Where CloudCLI is meaningfully ahead

Honest gaps:

1. **No garbling.** The whole architecture sidesteps Claudia's biggest pain point.
2. **Plugin marketplace** with third-party plugins. Claudia's "plugins" are pluggable backends, theirs is "add a new tab to the UI from a git URL."
3. **UX polish** — file explorer with live editing, redesigned chat composer, RTL detection, copy-as-markdown, full-text search, full i18n.
4. **Multi-CLI support** — Cursor, Codex, Gemini-CLI alongside Claude Code. Claudia's "OpenCode plugin" is narrower.
5. **Reconnect resilience** — preserves pending permission requests across WebSocket drops, 30s server heartbeat, frozen-session recovery. All things Claudia would have to build.
6. **SQLite + migrations** vs JSON files — scales better.
7. **Sandbox / microVM mode** for safe agent execution.
8. **Release velocity** — 72 releases; ships new-model support same week.
9. **License** — AGPL is more aggressive than MIT, depending on goals.

## Where they're roughly even

Mobile access, git integration, MCP config sync, token/cost tracking, model switching, session management, cron scheduling, conversation history.

---

## The strategic question

CloudCLI has decisively taken the "single-user beautiful chat UI" lane. Trying to out-polish them on chat UX is a losing battle — they have a company behind it, weekly releases, and an SDK-based architecture that sidesteps the rendering problems Claudia keeps chasing.

**But Claudia's actual product isn't "another chat UI."** It's **multi-agent orchestration** — parallel tasks, supervisor chat, MCP-based sibling spawning, checkpoints, mobile companion with voice. CloudCLI doesn't do that and shows no signs of going there.

### Realistic options

#### 1. Steal the architecture, keep the orchestration _(recommended)_

Adopt CloudCLI's approach — **Claude Agent SDK + `stream-json` + React rendering** — for individual task views. Keep everything that makes Claudia different (parallel tasks, supervisor, MCP siblings, checkpoints, mobile, Electron). Removes garbling forever and frees engineering time to widen the orchestration moat.

#### 2. Lean harder into the orchestration story

Make "I run 5 Claude Codes in parallel and a 6th one supervises them" the headline. The MCP-based sibling spawning is genuinely novel, and CloudCLI fundamentally can't match it without rebuilding around Claudia's model. Marketing this clearly may matter as much as the architecture swap.

#### 3. Don't compete on chat polish

Things like file explorer redesigns, full-text conversation search, locale support — fine if they come naturally, but spending sprints on them is fighting the wrong war.

---

## Sources

- [siteboon/claudecodeui README](https://github.com/siteboon/claudecodeui)
- [CloudCLI changelog](https://github.com/siteboon/claudecodeui/blob/main/CHANGELOG.md)
- [Claude Code Agent SDK / headless mode docs](https://code.claude.com/docs/en/headless)
- This repo's own `README.md` and recent git history
