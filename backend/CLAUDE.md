# Backend (`backend/`)

Express + WebSocket server. Auto-reloads on `.ts` changes — **do not restart** (see root CLAUDE.md).

## Quick Commands

```bash
cd backend
npx tsx test-cli.ts --help          # All test-cli flags
npx vitest run                       # Unit tests
npx vitest run path/to/file.test.ts  # Single test file
```

## Persisted State

Files written to `backend/` at runtime — safe to inspect, risky to hand-edit while server is running:

| File | Purpose |
|------|---------|
| `config.json` | Backend choice, model, pricing, MCP server list |
| `checkpoints.json` | Per-task checkpoint snapshots (git hash + metadata) |
| `scheduled-tasks.json` | Cron + one-shot scheduled prompts |
| `usage-data.json` | Token usage history (parsed from Claude Code JSONL) |
| `archived-histories/` | Output histories of archived tasks |
| `chat-history.json` | Supervisor chat transcript |

## Task State Machine

`task-state-detection.ts` classifies PTY output into states: `starting`, `busy`, `idle`, `waiting_input`, `disconnected`, `exited`. State transitions drive auto-reconnect, cron firing, and frontend UI badges.

## MCP Server Injection

`claudia-mcp-server.ts` is started as an MCP server and injected into every spawned Claude Code session via the workspace's `.mcp.json`. It exposes the `claudia_*` tools that let agents collaborate. Sync skips the claudia workspace itself to avoid restart loops.

## Plugin System

`plugin-system/` holds backend adapters (`claude-code`, `opencode`) and proxy plugins. The active backend is selected via `test-cli.ts --set-backend <name>` or `config.json`.

<!-- CODEUI-RULES -->
## Custom Rules

if it's a new feature, try to use a test cli unless it would be much easier to just have the user do a manual test (this is usually the case for visual features).. if it doesn't have functionality to do the test then add it. you can also use playwright mcp or curl if either of these would be easier. make sure you have enough logging to debug any issues.. if you create any test files, clean them up when you are done.  NEVER TOUCH PORT 4001 or 5173.. if you are having issues with public apis, lookup examples online. NEVER create summary reports! 
<!-- /CODEUI-RULES -->
