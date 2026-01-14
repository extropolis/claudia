# Claudia - Project Architecture Documentation

**Claudia** is a web-based UI for managing multiple Claude Code CLI instances simultaneously. It provides a visual interface for spawning, monitoring, and interacting with Claude Code tasks across different workspaces.

## Project Structure

```
codeui/
├── backend/              # Node.js backend server
├── frontend/             # React frontend application
├── shared/               # Shared TypeScript types
├── electron/             # Electron desktop wrapper
├── knowledge/            # Knowledge base storage (MCP)
├── .claude/              # Claude Code project data
├── start.sh              # Main startup script
├── package.json          # Root monorepo config
└── CLAUDE.md             # Project instructions for Claude
```

---

## Technology Stack

| Layer | Technology |
|-------|------------|
| Backend Runtime | Node.js + TypeScript |
| Backend Framework | Express.js + WebSocket (ws) |
| Process Management | node-pty (pseudo-terminals) |
| Frontend Framework | React 18 + TypeScript |
| Frontend Build | Vite 5 (HMR) |
| State Management | Zustand |
| Terminal Emulator | xterm.js |
| Desktop App | Electron |

---

## Backend Files (`backend/src/`)

### Core Server

| File | Purpose |
|------|---------|
| `index.ts` | Entry point - creates server, handles graceful shutdown |
| `server.ts` | Main application factory - Express routes, WebSocket server, service wiring |

### Services

| File | Purpose |
|------|---------|
| `task-spawner.ts` | Spawns and manages Claude Code CLI processes using node-pty. Tracks task state (idle/busy/waiting_input/exited), handles hooks, manages output buffering, persists tasks to `tasks.json` |
| `task-supervisor.ts` | AI agent that analyzes tasks and generates summaries with suggested actions using Claude Code `--print` mode |
| `supervisor-chat.ts` | Conversational AI interface for free-form chat with context awareness from running tasks |
| `workspace-store.ts` | Manages workspace directories (project folders). Persists to `workspace-config.json` |
| `config-store.ts` | Manages application configuration (MCP servers, permissions, rules). Persists to `config.json` |
| `conversation-parser.ts` | Parses Claude Code conversation history from JSONL files in `~/.claude/projects/` |
| `git-utils.ts` | Git utilities for capturing state and enabling task revert functionality |

### Hooks (`backend/hooks/`)

| File | Purpose |
|------|---------|
| `pre-tool-use.sh` | Hook called when Claude starts using a tool → sets task to `busy` |
| `notification-hook.sh` | Hook called when Claude needs user input → sets task to `waiting_input` |
| `stop-notify.sh` | Hook called when Claude stops/finishes → sets task to `idle` |

### Configuration Files

| File | Purpose |
|------|---------|
| `package.json` | Dependencies, scripts (`dev` runs tsx watch) |
| `tasks.json` | Persisted task data (auto-generated) |
| `config.json` | Application configuration (auto-generated) |
| `workspace-config.json` | Workspace list (auto-generated) |

---

## Frontend Files (`frontend/src/`)

### Core

| File | Purpose |
|------|---------|
| `main.tsx` | React application entry point |
| `App.tsx` | Main application layout - resizable sidebar, view toggle (Terminal/Chat), settings |

### Components (`frontend/src/components/`)

| File | Purpose |
|------|---------|
| `WorkspacePanel.tsx` | Left sidebar showing workspaces and tasks with voice input support |
| `TerminalView.tsx` | xterm.js terminal emulator for task output and input |
| `SupervisorChat.tsx` | Chat interface for conversing with the AI supervisor |
| `TaskSummaryPanel.tsx` | Displays task summaries and suggested actions |
| `ConversationHistory.tsx` | Shows conversation history for a task |
| `SettingsMenu.tsx` | Application settings (MCP servers, voice, rules) |
| `VoiceInput.tsx` | Voice input component with Web Speech API |
| `ProjectPicker.tsx` | Modal for adding new workspaces |
| `VoiceSettingsContent.tsx` | Voice configuration panel |

### Hooks (`frontend/src/hooks/`)

| File | Purpose |
|------|---------|
| `useWebSocket.ts` | Manages WebSocket connection, message routing, auto-reconnect, status polling |
| `useVoiceRecognition.ts` | Web Speech API integration for voice input |

### State (`frontend/src/stores/`)

| File | Purpose |
|------|---------|
| `taskStore.ts` | Zustand store for global state (tasks, workspaces, chat, voice settings) |

### Styles (`frontend/src/styles/`)

| File | Purpose |
|------|---------|
| `index.css` | Global styles with CSS custom properties for dark theme |
| `*.css` | Component-specific styles |

---

## Shared Types (`shared/src/`)

| File | Purpose |
|------|---------|
| `index.ts` | TypeScript interfaces shared between backend/frontend |

### Key Types

```typescript
TaskState: 'idle' | 'busy' | 'waiting_input' | 'exited' | 'disconnected'

Task: { id, prompt, state, workspaceId, createdAt, lastActivity, gitState }

Workspace: { id (full path), name (folder name), createdAt }

TaskSummary: { taskId, status, summary, lastAction, suggestedActions }

ChatMessage: { id, role, content, timestamp, taskId }
```

---

## Root Files

| File | Purpose |
|------|---------|
| `start.sh` | Main startup script - kills existing processes, sets environment, runs `npm run dev` |
| `package.json` | Monorepo root config with workspaces: backend, frontend, shared |
| `CLAUDE.md` | Project instructions for Claude Code instances |
| `QUICK-START.md` | Quick reference guide |
| `MULTI-INSTANCE-GUIDE.md` | Multi-instance development documentation |

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                       Frontend (React)                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │WorkspacePanel│  │ TerminalView │  │   SupervisorChat     │  │
│  │  (Sidebar)   │  │  (xterm.js)  │  │     (Chat UI)        │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│                           │                                      │
│                    ┌──────┴──────┐                              │
│                    │  taskStore  │  (Zustand)                   │
│                    └──────┬──────┘                              │
│                           │ useWebSocket                        │
└───────────────────────────┼─────────────────────────────────────┘
                            │ WebSocket + REST API
                            ▼
┌───────────────────────────────────────────────────────────────────┐
│                       Backend (Express)                           │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                      server.ts                              │  │
│  │   REST: /api/tasks, /api/workspaces, /api/config           │  │
│  │   WebSocket: Real-time task events                         │  │
│  └─────────────────────────┬──────────────────────────────────┘  │
│                            │                                      │
│  ┌─────────────┐  ┌────────┴───────┐  ┌──────────────────────┐  │
│  │TaskSpawner  │  │TaskSupervisor  │  │  SupervisorChat      │  │
│  │(node-pty)   │  │(AI analysis)   │  │  (AI chat)           │  │
│  └──────┬──────┘  └────────────────┘  └──────────────────────┘  │
│         │                                                         │
│  ┌──────┴──────┐  ┌────────────────┐  ┌──────────────────────┐  │
│  │WorkspaceStore│ │  ConfigStore   │  │ ConversationParser   │  │
│  └─────────────┘  └────────────────┘  └──────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
                            │
                            │ Spawns processes
                            ▼
┌───────────────────────────────────────────────────────────────────┐
│                 Claude Code CLI Instances                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ Task 1 (pty)│  │ Task 2 (pty)│  │ Task 3 (pty)│              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
│                            │                                      │
│         Hooks: pre-tool-use.sh, notification-hook.sh, stop-notify.sh
└───────────────────────────────────────────────────────────────────┘
```

---

## Data Flow

### 1. Task Creation
```
User → WorkspacePanel → WebSocket (task:create) → server.ts → TaskSpawner
    → spawns claude CLI → WebSocket (task:created) → taskStore → UI updates
```

### 2. Task State Changes
```
Claude CLI → Hook script → POST /api/claude-* → server.ts
    → TaskSpawner updates state → WebSocket (task:stateChanged) → UI updates
```

### 3. Terminal I/O
```
Claude CLI output → node-pty → TaskSpawner → WebSocket (task:output) → TerminalView
User input → TerminalView → WebSocket (task:input) → TaskSpawner → node-pty → CLI
```

### 4. Supervisor Analysis
```
Task state → idle/waiting_input → TaskSupervisor listens
    → reads ~/.claude/projects/ conversation → calls claude --print
    → WebSocket (task:summary) → TaskSummaryPanel
```

---

## Key Features

| Feature | Implementation |
|---------|----------------|
| Multi-instance task management | TaskSpawner with node-pty |
| Real-time terminal | xterm.js + WebSocket |
| AI task supervision | TaskSupervisor + Claude --print |
| Conversational AI | SupervisorChat + Claude --print |
| Git integration | git-utils.ts (state capture, revert) |
| Voice input | Web Speech API |
| Persistent state | JSON files (tasks, config, workspaces) |
| Hook system | Shell scripts → HTTP callbacks |

---

## Development

### Auto-Reload
- **Backend:** `tsx watch` monitors `src/`, reloads in 1-2 seconds
- **Frontend:** Vite HMR provides instant updates

### Ports
- Backend: `http://localhost:3001`
- Frontend: `http://localhost:5173`

### Starting the Project
```bash
./start.sh
# OR
npm run dev
```

### Multi-Instance
Multiple Claude Code instances can work on this project simultaneously without conflicts. The backend auto-reloads on changes.

---

## Embedded Anthropic Proxy

The backend includes an optional embedded proxy that translates Anthropic Messages API requests to SAP AI Core (AWS Bedrock Claude). This eliminates the need for a separate `sap-ai-proxy` instance.

### Architecture

```
Claude Code CLI
    │
    │ ANTHROPIC_BASE_URL=http://localhost:3001
    ▼
┌───────────────────────────────────────────────────────────────────┐
│                    Backend (Express) :3001                        │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Anthropic Proxy (embedded)                     │  │
│  │   GET  /v1/models    - List available Claude models         │  │
│  │   POST /v1/messages  - Anthropic Messages API               │  │
│  │   GET  /health       - Proxy health check                   │  │
│  └─────────────────────────┬──────────────────────────────────┘  │
│                            │                                      │
│  ┌─────────────────────────┼──────────────────────────────────┐  │
│  │  AccessTokenProvider    │  DeploymentCatalog               │  │
│  │  (OAuth2 caching)       │  (model discovery)               │  │
│  └─────────────────────────┼──────────────────────────────────┘  │
│                            │                                      │
│  ┌─────────────────────────┼──────────────────────────────────┐  │
│  │  RequestTransformer     │  StreamTransformer               │  │
│  │  (Bedrock format)       │  (SSE event types)               │  │
│  └─────────────────────────┴──────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
                            │
                            │ OAuth2 + Bearer Token
                            ▼
┌───────────────────────────────────────────────────────────────────┐
│                      SAP AI Core                                  │
│   /v2/lm/deployments          - Model discovery                  │
│   /v2/inference/deployments/  - Claude inference (Bedrock)       │
└───────────────────────────────────────────────────────────────────┘
```

### Proxy Files (`backend/src/anthropic-proxy/`)

| File | Purpose |
|------|---------|
| `index.ts` | Express router with `/v1/models` and `/v1/messages` endpoints |
| `access-token-provider.ts` | OAuth2 token acquisition and caching (60-second buffer) |
| `deployment-catalog.ts` | Discovers and caches running Claude deployments from SAP AI Core |
| `request-transformer.ts` | Transforms Anthropic API requests to Bedrock format |
| `stream-transformer.ts` | Transforms Bedrock SSE to Anthropic SSE format (adds event types) |

### Configuration

Set these environment variables in `backend/.env`:

```bash
SAP_AICORE_AUTH_URL=https://xxx.authentication.xxx.hana.ondemand.com
SAP_AICORE_CLIENT_ID=your-client-id
SAP_AICORE_CLIENT_SECRET=your-client-secret
SAP_AICORE_BASE_URL=https://api.ai.xxx.aws.ml.hana.ondemand.com
SAP_AICORE_RESOURCE_GROUP=default
SAP_AICORE_TIMEOUT_MS=120000
```

### Claude Code Configuration

To use the embedded proxy, update your Claude Code settings (`~/.claude/settings.json`):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3001",
    "ANTHROPIC_MODEL": "claude-sonnet-4-5-20250929"
  }
}
```

### Supported Models

The proxy maps external model names to internal SAP AI Core deployments:

| External (Anthropic API) | Internal (SAP AI Core) |
|--------------------------|------------------------|
| `claude-sonnet-4-5-20250929` | `anthropic--claude-4.5-sonnet` |
| `claude-sonnet-4-20250514` | `anthropic--claude-sonnet-4` |
| `claude-3-7-sonnet-20250219` | `anthropic--claude-3.7-sonnet` |
| `claude-3-5-sonnet-20241022` | `anthropic--claude-3.5-sonnet` |
| `claude-opus-4-20250514` | `anthropic--claude-opus-4` |
| `claude-4-5-opus` | `anthropic--claude-4.5-opus` |

### Features

- **OAuth2 Token Caching:** Tokens cached with 60-second expiry buffer
- **Model Discovery:** Automatically discovers running deployments
- **Streaming Support:** Full SSE streaming with proper event types
- **Reasoning Support:** Converts `reasoning_effort` to `thinking` budget
- **Error Handling:** Proper HTTP status codes and error responses
