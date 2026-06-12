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
- **Mobile** (`../mobile_claudia/`, sibling repo at `/Users/I850333/experiments/mobile_claudia`): Expo / React Native companion app — connects to the backend over an ngrok tunnel for remote monitoring, voice input, and push notifications. Lives outside this repo so its `node_modules` and Expo cache don't bloat the desktop project.
- **Shared** (`shared/src/`): TypeScript types shared between backend and frontend
- Backend port: **4001** (HTTP + WebSocket)
- Frontend dev port: **5173** (Vite)

### Key Backend Files
- `task-spawner.ts` — Core task lifecycle: create, reconnect, disconnect, state polling, history management
- `server.ts` — Express routes, WebSocket handlers, MCP config sync
- `config-store.ts` — Persisted configuration (model, pricing, MCP servers)
- `token-parser.ts` — Parse Claude Code JSONL session files for token usage
- `claudia-mcp-server.ts` — MCP server injected into Claude Code sessions
- `checkpoint-store.ts` — Per-task checkpoint snapshots (file state, git hash) for restore/rollback
- `cron-scheduler.ts` — Recurring + one-shot scheduled prompts persisted in `scheduled-tasks.json`
- `autonomous-controller.ts` — Autonomous loop / supervisor-driven task control
- `llm-service.ts` — Anthropic SDK wrapper for supervisor chat, summarization, planning
- `plugin-system/` — Pluggable backends (claude-code, opencode) and proxy plugins (hai-proxy)
- `task-state-detection.ts` — Heuristics that classify PTY output into task states (busy/idle/waiting_input)
- `dev-watcher.mjs` — Custom watcher used by `npm run dev`; debounces restarts and protects port 4001
- `tunnel-manager.ts` — Ngrok tunnel lifecycle + per-mobile-client token validation (`/api/mobile/*`, WS `?mobile=1&token=...`)
- `mobile-push.ts` — Device registration + Expo push delivery for `task:summary` events (`/api/mobile/register-push`)
- `mobile-page.ts` — Standalone HTML served to mobile browsers that hit the tunnel root (QR-pairing helper)
- `task-summary.ts` — Builds the natural-language summary payload that powers the companion feed and push notifications

### Key Frontend Files
- `TerminalView.tsx` — xterm.js terminal with resize buffering, history chunking, scroll-up lazy loading
- `WorkspacePanel.tsx` — Workspace list, task creation, drag-and-drop, collapsible sidebar
- `useWebSocket.ts` — WebSocket connection management with reconnection
- `taskStore.ts` — Zustand store for task/workspace state

### Key Mobile (Companion App) Files

The mobile companion lives at `/Users/I850333/experiments/mobile_claudia` (a sibling of this repo, not a subdirectory). Paths below are relative to that root.

- `App.tsx` + `src/screens/` — Three-screen flow: `ConnectScreen` (QR / URL pairing), `ChatScreen` (single-agent chat per workspace), `TerminalScreen` (drill-in monospace view of a task's PTY output)
- `src/screens/ChatScreen.tsx` — Vertical chat thread for the active workspace. User/agent/system bubbles, dynamic quick-action chips on each agent message, voice + text composer, workspace pill that opens `WorkspacePicker`
- `src/screens/TerminalScreen.tsx` — Tap-an-agent-bubble drill-in. REST initial paint via `/api/tasks/:id/output`, live updates via `task:output` WS events; ANSI stripped for readability
- `src/components/AgentMessage.tsx` / `UserMessage.tsx` / `WorkspacePicker.tsx` / `QuickActionChip.tsx` / `VoiceButton.tsx` / `QRScanner.tsx` — chat UI primitives
- `src/lib/bridge.ts` — REST helpers: `/api/mobile/bridge-info`, `/api/mobile/register-push`, `/api/mobile/simulate-summary`, `/api/voice/deepgram-token`, `/api/mobile/chat`, `/api/workspaces`, `/api/tasks/:id/output`. Also normalizes user-entered URLs and converts http→ws
- `src/hooks/useWebSocket.ts` — WS client; opens `wss://<tunnel>/?mobile=1&token=<token>`. Handles `init`, `task:created/stateChanged/destroyed`, `chat:message`, `task:output`
- `src/hooks/usePushToken.ts` — Expo push token registration (`expo-notifications`)
- `src/hooks/useDeepgram.ts` — Streaming voice transcription via Deepgram (token fetched from backend)
- `src/store/taskStore.ts` — Zustand store: tasks map, workspaces list, `activeWorkspaceId`, per-workspace `transcripts`, per-task `taskOutputs` rolling buffer, route (`chat` | `terminal`)
- `src/lib/storage.ts` — `react-native-mmkv` persistence for tunnel URL, auth token, deviceId, active workspace

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

Common flags worth knowing:
- `--create-task --task-name "X" -w <id>` — spawn a task in a workspace
- `--watch-output --task-id <id>` — stream PTY output to stdout
- `--wait-for-idle` — block until task transitions to idle
- `--cron-create --cron-expression "*/5 * * * *" -m "ping"` — schedule a recurring prompt
- `--list-mcp-servers` / `--test-mcp-server <name>` — validate MCP config without a WS connection
- `--check-api-config` — print backend mode + credential/plugin status

Unit tests:
```bash
cd backend
npx vitest run
```

Root-level (runs all workspaces via `vitest.workspace.ts`):
```bash
npx vitest run
```

Add CLI functionality if needed for testing. Ensure adequate logging to debug issues.

## Companion App (Mobile)

The Expo app at `/Users/I850333/experiments/mobile_claudia` is a **separate package** (`@extropolis/claudia-mobile`) that lives outside this repo. It talks to the backend exclusively over the ngrok tunnel — never directly to `localhost:4001` from a real device.

### Running locally
```bash
cd /Users/I850333/experiments/mobile_claudia
npm install            # only needed the first time
npx expo start         # then press i (iOS sim), a (Android), or w (web)
```

The backend's tunnel must be active for pairing. Open the desktop app, start the tunnel, and the companion uses its QR scanner (`QRScanner.tsx`) or manual URL entry to capture `<tunnel-url>` + token.

### UX model — single-agent chat per workspace

Each workspace has one chat thread between the user and a **mobile agent**, served by `backend/src/mobile-agent.ts`:
- Tasks settling to idle proactively post a chat-style summary message (a few sentences + dynamic quick-action chips that mimic the user's own past prompts).
- Free-text input from the device runs an Anthropic tool-use loop with workspace-scoped tools (`list_tasks`, `get_task_output`, `send_input_to_task`, `create_task`, `continue_task`, `stop_task`) and posts the agent's reply.
- Tapping any agent message that is tied to a task opens `TerminalScreen` for that task — full PTY output (ANSI stripped), live-streamed via the existing `task:output` WS broadcast.
- Transcripts persist server-side in `backend/mobile-chat-history.json` so multiple paired devices stay in sync.

### Backend endpoints the companion relies on
- `GET  /api/mobile/bridge-info` — version, tunnel status, voice + push capability flags
- `POST /api/mobile/register-push` — register an Expo push token for a device
- `POST /api/mobile/simulate-summary` — emit a fake `task:summary` for end-to-end testing (legacy card UI; still wired up)
- `GET  /api/voice/deepgram-token` — short-lived Deepgram key for streaming STT
- `GET  /api/mobile/chat?workspaceId=...` — fetch transcript
- `POST /api/mobile/chat` (body `{ workspaceId, text }`) — run one agent turn; broadcasts each new message as `chat:message` over WS
- `DELETE /api/mobile/chat?workspaceId=...` — wipe transcript
- `POST /api/mobile/chat/summarize-task` (body `{ taskId }`) — force the chat-style summary path on demand
- `WS   /?mobile=1&token=<token>` — same WS bus used by the desktop, scoped to mobile; receives `chat:message` and `task:output`

All `/api/mobile/*` routes are gated by `TunnelManager.validateToken()`; reuse that helper if you add new endpoints. Workspace IDs are filesystem paths (with slashes), so `/api/mobile/chat` uses `?workspaceId=...` query/body args rather than path params — Express path matching strips embedded slashes even when URL-encoded.

### Testing
- Use `--check-api-config` and `--list-tasks` from the regular CLI to confirm backend health before debugging mobile.
- For an end-to-end agent turn without a real device: `npx tsx test-cli.ts --mobile-chat-send -w <workspaceId> -m "..."` then `--mobile-chat-show -w <workspaceId>` to see the transcript.
- For the auto-summary path without a real busy→idle transition: `npx tsx test-cli.ts --mobile-summary --task-id <id>`.
- Legacy card UI test still works: `npx tsx test-cli.ts --simulate-mobile-event`.
- Type-check the mobile project with `cd /Users/I850333/experiments/mobile_claudia && npm run lint` (runs `tsc --noEmit`).

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

- **MCP sync skips claudia's own workspace** to prevent tsx watch restart loops (writes .mcp.json to workspace roots)
- **History files** cap at 10MB on disk, 2MB sent to clients, 512KB loaded into memory on reconnect
- **Terminal resize** buffers PTY output for 250ms after resize to prevent width-mismatch corruption
- **Sleep/wake** auto-reconnects tasks whose PTY processes died during OS suspension
- **Scrollbar oscillation** — resize events with ≤2 col change are suppressed to prevent feedback loops
- **Checkpoints** are stored in `backend/checkpoints.json` and reference git commit hashes — don't hand-edit while tasks are running
- **Cron scheduler** persists to `backend/scheduled-tasks.json`; recurring tasks auto-expire after 7 days
- **Plugin system** loads from `backend/plugins/`; the active backend (claude-code vs opencode) is set via `--set-backend` or config
- **Claude CLI resolution** — on Windows uses `APPDATA`, not `PATH`. See `resolveClaudeSpawn()` in `task-spawner.ts`
- **`dev-watcher.mjs`** debounces tsx-watch restarts to avoid OOM cascades when many files change at once
- **Mobile tunnel tokens** rotate on every backend restart — `tsx watch` reloads invalidate the companion's saved token, so the app must re-pair (or re-fetch `bridge-info`). Don't hardcode tokens in tests.
- **Mobile WS connections** must include `?mobile=1&token=<token>`; missing/invalid tokens are dropped at the upgrade handshake (see `server.ts` around line 1170).
- **`/api/mobile/*` auth** is tunnel-token only — do not assume the desktop's session cookie applies.
- **Expo push** requires `expo-notifications` permissions on a real device (simulators silently no-op). Use `simulate-summary` to exercise the WS path without push.
- **MCP sync skips the mobile workspace too** — the mobile project (now at `/Users/I850333/experiments/mobile_claudia`, outside this repo) has its own `package.json` and is not a Claudia "workspace" in the task-spawner sense; don't add it to workspace lists.

## Releasing

1. Update `version.txt` to the new version number
2. Run `node scripts/bump-version.mjs` to sync all `package.json` files
3. Commit with message `chore: release vX.Y.Z`
4. Push, tag (`vX.Y.Z`), and create a GitHub release
<!-- CODEUI-RULES -->
## Custom Rules

if it's a new feature, try to use a test cli unless it would be much easier to just have the user do a manual test (this is usually the case for visual features).. if it doesn't have functionality to do the test then add it. you can also use playwright mcp or curl if either of these would be easier. make sure you have enough logging to debug any issues.. if you create any test files, clean them up when you are done.  NEVER TOUCH PORT 4001 or 5173.. if you are having issues with public apis, lookup examples online. NEVER create summary reports! NEVER push to main without explicit user approval. NEVER commit and push without letting the user test/validate changes first. Always ask before committing and before pushing. All changes should go through PRs, not direct pushes to main. NEVER add attribution comments like "Generated with Claude Code", "Co-Authored-By: Claude", or similar in PR descriptions, issues, commit messages, code comments, or any other artifacts.
<!-- /CODEUI-RULES -->
