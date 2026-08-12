# Claudia Development Guide

## CRITICAL: DO NOT RESTART THE SERVER

**NEVER run `./start.sh`, `.\start.ps1`, `npm run dev`, or kill/restart the server during development.**

The backend uses `tsx watch` which **automatically reloads** when you change `.ts` files in `backend/src/`:
- Write code → Wait 1-2 seconds → Changes are live
- No restart needed!

**Why?** Restarting the server while tasks are running causes:
- Out of Memory (OOM) crashes (exit code 137)
- Nested server instances that consume all system memory
- Loss of active task connections

## Architecture Overview

- **Backend** (`backend/src/`): Express + WebSocket server, PTY task management via node-pty, MCP server integration
- **Frontend** (`frontend/src/`): React + Vite, xterm.js terminal emulation, Zustand state management
- **Shared** (`shared/src/`): TypeScript types shared between backend and frontend
- **Electron** (`electron/`): Desktop wrapper around the same backend + frontend
- Backend port: **4001** (HTTP + WebSocket)
- Frontend dev port: **5173** (Vite)

`ARCHITECTURE.md` holds the exhaustive file-by-file reference. What follows is only the
subset you most often need to touch — go there when a file isn't listed here.

### Key Backend Files
- `task-spawner.ts` — Core task lifecycle: create, reconnect, disconnect, state polling, history management
- `server.ts` — Express routes, WebSocket handlers (40+ message types), service wiring, MCP config sync
- `backends/` — Backend abstraction over AI assistants: `claude-code-backend.ts` (PTY) and `opencode-backend.ts` (HTTP API), behind the `types.ts` interface
- `config-store.ts` — Persisted configuration (model, pricing, MCP servers)
- `token-parser.ts` — Parse Claude Code JSONL session files for token usage
- `claudia-mcp-server.ts` — MCP server injected into Claude Code sessions
- `session-events.ts` — Incremental parse of the session JSONL into render-ready events (text, thinking, tool calls) for the chat views
- `session-summarizer.ts` — Batched LLM prose summaries for the minimal chat view; falls back to a deterministic description when the LLM is unavailable
- `slash-commands.ts` — Enumerates the command/skill sources Claude Code resolves, so the chat composer can autocomplete them
- `auto-responder.ts` — Pure, dependency-free rules deciding whether a waiting task can be answered automatically; deliberately escalates on anything irreversible or thrashing
- `checkpoint-store.ts` / `worktree-manager.ts` / `git-utils.ts` — Git snapshots, restore/fork, and `git worktree` wrapping
- `verification-store.ts` / `visual-capture.ts` — Visual verification cards and the pluggable screenshot capturers behind them
- `cron-scheduler.ts` — Scheduled/recurring prompts fired into an idle task's PTY
- `tunnel-manager.ts` — ngrok tunnel for mobile access (WebSocket-safe, unlike localtunnel)
- `plugin-system/` — Plugin manifest, registry, and manager for AI providers, proxies, and integrations
- `utils/atomic-write.ts`, `utils/schema-version.ts` — Crash-safe writes and versioned load/save used by every JSON store

### Key Frontend Files
A single `chatViewMode` state in `App.tsx` switches a task between three renderings —
`terminal`, `detailed`, and `minimal`. TerminalView stays mounted and is hidden with CSS
rather than unmounted (remounting it would drop terminal state), so a change to "the task
view" usually means touching more than one of these.
- `TerminalView.tsx` — xterm.js terminal with resize buffering, history chunking, scroll-up lazy loading
- `ChatView.tsx` — Renders both non-terminal modes from session events: `detailed` shows every event as markdown and tool cards, `minimal` shows periodic prose summaries. Read-side only: input still goes to the PTY via `task:input`, so permission prompts keep working
- `EditorPanel.tsx` / `FileTree.tsx` / `FileExplorer.tsx` — Monaco editor, diffs, and file browsing
- `WorkspacePanel.tsx` — Workspace list, task creation, drag-and-drop, collapsible sidebar
- `useWebSocket.ts` — WebSocket connection management with reconnection
- `taskStore.ts` — Zustand store for task/workspace state

### Persisted State
Backend JSON stores live at `backend/*.json` (`tasks.json`, `config.json`, `workspace-config.json`,
`checkpoints.json`, `verifications.json`, `scheduled-tasks.json`, `chat-history.json`). They are
runtime data, not source. Load and save them through `utils/schema-version.ts` and bump the schema
version when a shape changes — never hand-roll a read/write.

## Auto-Reload Development

1. Write code in `backend/src/`
2. Wait 1-2 seconds for automatic reload (watch for "restarted" in logs)
3. Test with the CLI or browser
4. **Never restart the server manually**

## Testing

Always test changes using the CLI (`backend/test-cli.ts`):

```bash
cd backend
npx tsx test-cli.ts --list-tasks
npx tsx test-cli.ts -m "your prompt" -w /path/to/workspace
npx tsx test-cli.ts --help
```

The CLI covers far more than task creation — workspaces, archived tasks, plan approval,
git push, backend selection, MCP server checks, cron scheduling, references, and
`--watch-output` / `--wait-idle` for driving a task to completion. Run `--help` and look
for an existing flag before writing a throwaway script.

Unit tests run through a Vitest workspace covering **both** backend and frontend:

```bash
npm test
```

Or scope to one side:
```bash
npm run test:backend
npm run test:frontend
```

Add CLI functionality if needed for testing. Ensure adequate logging to debug issues.

## Show Visual Evidence

**After fixing a bug or adding a feature, record a video of it working and present that video to the user.** Don't just say "done" or describe the change. Capture the proof yourself — never ask the user to go check for themselves.

**Video is the default for anything touching the UI.** Record the actual browser session, then deliver the `.webm` to the user in your response so they can watch and verify it. A screenshot is a fallback for a purely static visual difference (a color, a spacing fix); anything involving interaction, state changes, or multiple steps gets a video.

Non-UI changes still need evidence, just not video:
- **Backend/CLI changes** — the pasted terminal output from `npx tsx test-cli.ts ...` showing the new behavior, or the relevant backend log lines proving the code path ran.
- **Bug fixes** — evidence of the failure mode being gone: the passing test that used to fail, or the log/output that previously showed the error.
- **Unit tests** — the actual `npx vitest run` output, not a claim that tests pass.

For a bug fix, the video should show the **specific thing that used to be broken now working** — reproduce the original failing path on camera. Record before/after when the difference is what matters.

If evidence genuinely isn't capturable (e.g. requires the user's own credentials, a physical device, or a hard-to-reproduce timing bug), say so explicitly and give the exact steps for the user to verify it themselves.

### Recording a Video

The `playwright` MCP server is configured in `.mcp.json` with `--caps=devtools`, which enables video recording. Videos are WebM, saved to `/tmp/claudia-recordings/`.

1. `browser_navigate` to http://localhost:5173
2. `browser_video_show_actions` — overlays clicks and typing so the user can follow along
3. `browser_start_video`
4. Drive the feature: click, type, navigate. Move deliberately and pause on results so they're readable — a video that flashes past the important moment proves nothing.
5. `browser_video_chapter` at each meaningful step, with a title describing what's being shown
6. `browser_stop_video`
7. **Send the `.webm` to the user** and say what to look for in it. A recorded video that never reaches the user is not evidence.

Notes:
- Recording requires the devtools capability, so it only works through the `playwright` MCP server — not the built-in browser tools.
- Watch the console errors reported in the tool output while recording; if the feature throws, that's a finding to report, not something to leave in the video unmentioned.

## Starting the Server (Initial Startup Only)

**Only use this when the server is NOT running (e.g., after system reboot):**

**macOS / Linux:**
```bash
./start.sh
```

**Windows (PowerShell):**
```powershell
.\start.ps1
```

The lock file will prevent accidental duplicate starts.

## Cross-Platform Notes

- **Windows**: Use `.\start.ps1` for startup. Use forward slashes `/` for paths in code, backslashes `\` in shell commands. PowerShell folder dialogs require `-STA` flag.
- **macOS/Linux**: Use `./start.sh` for startup.
- The codebase uses `@homebridge/node-pty-prebuilt-multiarch` for cross-platform PTY support.
- Claude CLI is resolved via `APPDATA` on Windows (not PATH) — see `resolveClaudeSpawn()` in task-spawner.ts.
- CI runs on both Ubuntu and Windows to ensure compatibility.

## Known Gotchas

- **MCP sync skips claudia's own workspace** to prevent tsx watch restart loops (writes .mcp.json to workspace roots) — see `syncMcpConfig()` in task-spawner.ts
- **History files** cap at 10MB on disk, 2MB in memory, 2MB sent to clients
- **Terminal resize** buffers PTY output for 250ms after resize to prevent width-mismatch corruption
- **Sleep/wake** auto-reconnects tasks whose PTY processes died during OS suspension
- **Scrollbar oscillation** — resize events with ≤2 col change are suppressed to prevent feedback loops
- **Prompt Enter delay scales with length** — 500ms base + 50ms per 100 chars, capped at 2500ms. A long prompt submitted too early gets truncated by the TUI
- **Chat views are read-only renderings.** Input always goes to the PTY via `task:input`; don't route it around the terminal or permission prompts break
- **WebGL/canvas screenshots need Chromium.** They come back silently blank under WebKit (playwright#17904)
- **Never sleep before a screenshot** — wait on an explicit readiness signal; arbitrary timeouts are the top source of flaky captures
- **A judged verification card is pasted into the filing task's session.** `POST /api/verifications/:cardId/judge` writes the verdict into `card.taskId`'s PTY, so `taskId` is validated at card-creation time (404 if the task is unknown) — an unvalidated one would be a write primitive into any other task. Everything interpolated into that message (`claim`, `rejectionNote`) goes through `sanitizeForSession()`: newlines and control chars are flattened so injected text cannot start its own line and read as a fresh instruction
- **Auto-responder stays silent by design** on anything irreversible, secret-bearing, or thrashing. Widening it to approve more is a correctness regression, not an improvement

## Releasing

1. Update `version.txt` to the new version number
2. Run `npm run release` — syncs every `package.json`, commits `chore: release vX.Y.Z`, tags, and pushes. CI handles the rest.

`npm run release` **pushes and tags**, so it needs explicit user approval first (see Custom
Rules below) — never run it on your own initiative.

To do the version sync alone without committing, use `npm run version:sync`
(or `npm run version:check` to verify everything is already in step).
<!-- CODEUI-RULES -->
## Custom Rules

if it's a new feature, try to use a test cli unless it would be much easier to just have the user do a manual test (this is usually the case for visual features).. if it doesn't have functionality to do the test then add it. you can also use playwright mcp or curl if either of these would be easier. make sure you have enough logging to debug any issues.. if you create any test files, clean them up when you are done.  NEVER TOUCH PORT 4001 or 5173.. if you are having issues with public apis, lookup examples online. NEVER create summary reports! NEVER push to main without explicit user approval. NEVER commit and push without letting the user test/validate changes first. Always ask before committing and before pushing. All changes should go through PRs, not direct pushes to main. NEVER add attribution comments like "Generated with Claude Code", "Co-Authored-By: Claude", or similar in PR descriptions, issues, commit messages, code comments, or any other artifacts.
<!-- /CODEUI-RULES -->
