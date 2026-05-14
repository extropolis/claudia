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
- Backend port: **4001** (HTTP + WebSocket)
- Frontend dev port: **5173** (Vite)

### Key Backend Files
- `task-spawner.ts` — Core task lifecycle: create, reconnect, disconnect, state polling, history management
- `server.ts` — Express routes, WebSocket handlers, MCP config sync
- `config-store.ts` — Persisted configuration (model, pricing, MCP servers)
- `token-parser.ts` — Parse Claude Code JSONL session files for token usage
- `claudia-mcp-server.ts` — MCP server injected into Claude Code sessions

### Key Frontend Files
- `TerminalView.tsx` — xterm.js terminal with resize buffering, history chunking, scroll-up lazy loading
- `WorkspacePanel.tsx` — Workspace list, task creation, drag-and-drop, collapsible sidebar
- `useWebSocket.ts` — WebSocket connection management with reconnection
- `taskStore.ts` — Zustand store for task/workspace state

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

Unit tests:
```bash
cd backend
npx vitest run
```

Add CLI functionality if needed for testing. Ensure adequate logging to debug issues.

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

## Releasing

1. Update `version.txt` to the new version number
2. Run `node scripts/bump-version.mjs` to sync all `package.json` files
3. Commit with message `chore: release vX.Y.Z`
4. Push, tag (`vX.Y.Z`), and create a GitHub release
<!-- CODEUI-RULES -->
## Custom Rules

if it's a new feature, try to use a test cli unless it would be much easier to just have the user do a manual test (this is usually the case for visual features).. if it doesn't have functionality to do the test then add it. you can also use playwright mcp or curl if either of these would be easier. make sure you have enough logging to debug any issues.. if you create any test files, clean them up when you are done.  NEVER TOUCH PORT 4001 or 5173.. if you are having issues with public apis, lookup examples online. NEVER create summary reports! NEVER push to main without explicit user approval. NEVER commit and push without letting the user test/validate changes first. Always ask before committing and before pushing. All changes should go through PRs, not direct pushes to main. NEVER add attribution comments like "Generated with Claude Code", "Co-Authored-By: Claude", or similar in PR descriptions, issues, commit messages, code comments, or any other artifacts.
<!-- /CODEUI-RULES -->
