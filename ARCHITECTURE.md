# Claudia - Project Architecture Documentation

**Claudia** is a web-based UI for managing multiple Claude Code CLI instances simultaneously. It provides a visual interface for spawning, monitoring, and interacting with Claude Code tasks across different workspaces. Available as a web app or Electron desktop application with cross-platform support (Windows, macOS, Linux).

## Project Structure

```
claudia/
├── backend/              # Node.js backend server
│   ├── src/
│   │   ├── backends/             # Pluggable backend implementations
│   │   ├── anthropic-proxy/      # SAP AI Core proxy (Bedrock)
│   │   ├── hyperspace-proxy/     # Hyperspace AI Proxy integration
│   │   ├── commands/             # Auto-installed Claude Code commands
│   │   └── __tests__/            # Unit tests (Vitest)
│   └── hooks/                    # Claude Code lifecycle hooks
├── frontend/             # React frontend application
│   └── src/
│       ├── components/           # UI components
│       ├── hooks/                # Custom React hooks
│       ├── stores/               # Zustand state management
│       └── styles/               # CSS styles (dark theme)
├── shared/               # Shared TypeScript types
├── electron/             # Electron desktop wrapper
├── .claude/              # Claude Code project data
├── .github/workflows/    # CI/CD pipelines
├── start.sh              # Startup script (macOS/Linux)
├── start.ps1             # Startup script (Windows)
├── package.json          # Root monorepo config
├── CLAUDE.md             # Project instructions for Claude
└── ARCHITECTURE.md       # This file
```

---

## Technology Stack

| Layer | Technology |
|-------|------------|
| Backend Runtime | Node.js + TypeScript |
| Backend Framework | Express.js + WebSocket (ws) |
| Process Management | @homebridge/node-pty-prebuilt-multiarch (cross-platform PTY) |
| Frontend Framework | React 18 + TypeScript |
| Frontend Build | Vite (HMR) |
| State Management | Zustand |
| Terminal Emulator | xterm.js with addons |
| Voice Recognition | Deepgram API |
| Desktop App | Electron |

---

## Backend Files (`backend/src/`)

### Core Server

| File | Purpose |
|------|---------|
| `index.ts` | Entry point - creates server, handles graceful shutdown, auto-installs /learn command |
| `server.ts` | Main application factory - Express routes, WebSocket server, service wiring, 40+ WebSocket message types |

### Services

| File | Purpose |
|------|---------|
| `task-spawner.ts` | Spawns and manages CLI processes. Tracks task state lifecycle, handles hooks, manages output buffering, coordinates with backends |
| `supervisor-chat.ts` | Conversational AI interface with tool-calling (create_task, delete_task, send_task_input, list_tasks, etc.) and context awareness from running tasks |
| `workspace-store.ts` | Manages workspace directories (project folders). Persists to `workspace-config.json` |
| `config-store.ts` | Manages application configuration (API mode, MCP servers, permissions, rules). Supports SAP AI Core, Hyperspace, and direct API modes. Persists to `config.json` |
| `learnings-store.ts` | Vector-based learning storage with semantic search (cosine similarity). Implements MemRL (Memory Reinforcement Learning) for utility scoring. Methods: addLearning, searchLearnings, updateUtility |
| `llm-service.ts` | Dynamic LLM response generation via local `/v1/messages` endpoint. Functions: generateLLMResponse, generatePlanResponse, generateConversationalResponse |
| `task-persistence.ts` | Handles task metadata and output history persistence. Supports archived tasks with lazy-loaded history, debounced saves for performance |
| `task-state-detection.ts` | Analyzes terminal output to detect waiting states (question, permission, confirmation, text_input), processing indicators, and session IDs |
| `conversation-parser.ts` | Parses Claude Code conversation history from JSONL files in `~/.claude/projects/` and OpenCode message files |
| `git-utils.ts` | Git utilities for capturing state (commit hashes, diffs), tracking modified files, and enabling task revert functionality |
| `tunnel-manager.ts` | Creates public HTTPS URLs via ngrok for mobile device access. Supports QR code generation and token-based authentication |
| `usage-reporter.ts` | Fire-and-forget token usage analytics reporting to Claudia usage dashboard |

### Backends (`backend/src/backends/`)

Claudia supports pluggable backend implementations through the `CodeBackend` interface:

| File | Purpose |
|------|---------|
| `types.ts` | Backend abstraction types - `CodeBackend` interface, `TaskConfig`, `BackendTask`, `BACKEND_INFO` registry |
| `claude-code-backend.ts` | Claude Code CLI backend - spawns `claude` processes via PTY, full terminal lifecycle management |
| `opencode-backend.ts` | OpenCode backend - communicates via HTTP API with `opencode serve`, alternative to Claude Code |

### Proxy Systems

#### Anthropic Proxy (`backend/src/anthropic-proxy/`)

Translates Anthropic Messages API requests to SAP AI Core (AWS Bedrock Claude):

| File | Purpose |
|------|---------|
| `index.ts` | Express router with `/v1/models` and `/v1/messages` endpoints |
| `access-token-provider.ts` | OAuth2 token acquisition and caching (60-second buffer) |
| `deployment-catalog.ts` | Discovers and caches running Claude deployments from SAP AI Core |
| `request-transformer.ts` | Transforms Anthropic API requests to Bedrock format |
| `stream-transformer.ts` | Transforms Bedrock SSE to Anthropic SSE format (adds event types) |

#### Hyperspace Proxy (`backend/src/hyperspace-proxy/`)

Proxies requests to Hyperspace AI Proxy (production-approved external service):

| File | Purpose |
|------|---------|
| `index.ts` | Express router for Hyperspace proxy integration |
| Features | Sanitizes tools/system blocks, strips unsupported content types, intercepts warmup requests, tracks token usage from SSE events |

### Hooks (`backend/hooks/`)

Shell scripts that integrate with Claude Code CLI lifecycle events:

| File | Purpose |
|------|---------|
| `pre-tool-use.sh` | Called when Claude starts using a tool → sets task to `busy` |
| `notification-hook.sh` | Called when Claude needs user input → sets task to `waiting_input` |
| `stop-notify.sh` | Called when Claude stops/finishes → sets task to `idle` |

### Commands (`backend/src/commands/`)

| File | Purpose |
|------|---------|
| `learn.md` | Auto-installed `/learn` slash command for all Claude Code sessions. Provides self-evaluation, mistake identification, skill file management, and structured learning extraction |

### Configuration Files

| File | Purpose |
|------|---------|
| `package.json` | Dependencies, scripts (`dev` runs tsx watch) |
| `tasks.json` | Persisted task data (auto-generated) |
| `config.json` | Application configuration (auto-generated) |
| `workspace-config.json` | Workspace list (auto-generated) |

### Tests (`backend/__tests__/`)

Unit tests using Vitest:

| Test File | Coverage |
|-----------|----------|
| `config-store.test.ts` | Configuration persistence and API mode management |
| `conversation-parser.test.ts` | JSONL conversation parsing |
| `git-utils.test.ts` | Git state capture and revert |
| `ring-buffer.test.ts` | Output ring buffer |
| `task-state-detection.test.ts` | Terminal output state analysis |
| `validation.test.ts` | Input validation |
| `workspace-store.test.ts` | Workspace CRUD operations |

---

## Frontend Files (`frontend/src/`)

### Core

| File | Purpose |
|------|---------|
| `main.tsx` | React application entry point |
| `App.tsx` | Main application layout - resizable sidebar, view toggle (Terminal/Chat/Settings), panel management |

### Components (`frontend/src/components/`)

| File | Purpose |
|------|---------|
| `WorkspacePanel.tsx` | Left sidebar showing workspaces, tasks, task ordering, and voice input support |
| `TerminalView.tsx` | xterm.js terminal emulator for task output and input |
| `SupervisorChat.tsx` | Chat interface for conversing with the AI supervisor (tool-calling enabled) |
| `TaskSummaryPanel.tsx` | Displays task summaries, status, and suggested actions |
| `ConversationHistory.tsx` | Shows parsed conversation history for a task with session selector |
| `SettingsMenu.tsx` | Full settings panel - API provider, MCP servers, voice, permissions, rules |
| `LearnFromConversationModal.tsx` | Analyzes completed tasks and suggests learnings to save |
| `MobileAccessModal.tsx` | Displays QR code and tunnel URL for mobile remote access |
| `GlobalVoiceManager.tsx` | Logic-only component for managing Deepgram voice recognition app-wide |
| `GlobalVoiceToggle.tsx` | UI toggle for global voice recognition on/off with visual indicator |
| `VoiceInput.tsx` | Voice input widget with Deepgram speech-to-text and interim results |
| `VoiceSettingsContent.tsx` | Voice configuration panel (API key, auto-send, delay settings) |
| `SystemStats.tsx` | Real-time CPU and memory usage display with color-coded status |
| `NotificationContainer.tsx` | Centralized toast notification display with auto-dismiss |
| `ProjectPicker.tsx` | Modal for adding new workspace directories |

### Hooks (`frontend/src/hooks/`)

| File | Purpose |
|------|---------|
| `useWebSocket.ts` | Manages WebSocket connection, message routing, auto-reconnect, status polling |
| `useVoiceRecognition.ts` | Deepgram API integration for speech-to-text recognition |

### State (`frontend/src/stores/`)

| File | Purpose |
|------|---------|
| `taskStore.ts` | Zustand store for global state (tasks, workspaces, chat history, voice settings, notifications). Persists to localStorage |

### Configuration

| File | Purpose |
|------|---------|
| `config/api-config.ts` | API endpoint configuration |

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
TaskState: 'idle' | 'busy' | 'starting' | 'waiting_input' | 'exited'
         | 'disconnected' | 'interrupted' | 'archived'

WaitingInputType: 'question' | 'permission' | 'text_input' | 'confirmation'

BackendType: 'claude-code' | 'opencode'

Task: {
  id, prompt, state, workspaceId, createdAt, lastActivity,
  gitState?, waitingInputType?, systemPrompt?, order?,
  sessionId?, backendType?
}

Workspace: { id (full path), name (folder name), createdAt, systemPrompt? }

TaskGitState: { commitBefore, commitAfter?, filesModified[], canRevert, revertedAt? }

FileDiff: { path, type, additions, deletions, hunks }

TaskSummary: { taskId, status, summary, lastAction, suggestedActions }

ChatMessage: { id, role, content, timestamp, taskId?, workspaceId? }

WSMessageType: 40+ types for task lifecycle, workspaces, chat, supervisor,
               archived tasks, learnings, tunnel, system stats, etc.
```

---

## Electron Desktop App (`electron/`)

| File | Purpose |
|------|---------|
| `main.ts` | Main process - window creation, lifecycle management, dev tools support |
| `server-manager.ts` | Starts/stops Express backend server, returns `ServerInfo` |
| `preload.ts` | IPC bridge - exposes `window.electronAPI` with `getBackendUrl()` |

---

## Root Files

| File | Purpose |
|------|---------|
| `start.sh` | Startup script (macOS/Linux) - kills existing processes, sets environment, runs `npm run dev` |
| `start.ps1` | Startup script (Windows/PowerShell) - port cleanup, environment setup, process management |
| `package.json` | Monorepo root config with workspaces: backend, frontend, shared, electron |
| `CLAUDE.md` | Project instructions for Claude Code instances |
| `ARCHITECTURE.md` | This architecture documentation |

---

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          Frontend (React + Vite)                          │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  ┌──────────────┐  │
│  │WorkspacePanel│  │ TerminalView │  │ Supervisor │  │   Settings   │  │
│  │  (Sidebar)   │  │  (xterm.js)  │  │   Chat     │  │    Menu      │  │
│  └──────────────┘  └──────────────┘  └────────────┘  └──────────────┘  │
│                                                                          │
│  ┌────────────────┐  ┌────────────────┐  ┌───────────────────────────┐  │
│  │ SystemStats    │  │ VoiceManager   │  │ LearnFromConversation     │  │
│  │ Notifications  │  │ MobileAccess   │  │ ConversationHistory       │  │
│  └────────────────┘  └────────────────┘  └───────────────────────────┘  │
│                           │                                              │
│                    ┌──────┴──────┐                                       │
│                    │  taskStore  │  (Zustand)                            │
│                    └──────┬──────┘                                       │
│                           │ useWebSocket                                 │
└───────────────────────────┼──────────────────────────────────────────────┘
                            │ WebSocket + REST API
                            ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                        Backend (Express) :4001                            │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                         server.ts                                   │  │
│  │   REST: /api/tasks, /api/workspaces, /api/config, /api/learnings  │  │
│  │         /api/tunnel, /api/system/stats, /api/upload, /v1/messages │  │
│  │   WebSocket: 40+ real-time event types                            │  │
│  └──────────────────────────┬─────────────────────────────────────────┘  │
│                              │                                            │
│  ┌─────────────┐  ┌─────────┴──────┐  ┌───────────────────────────────┐ │
│  │TaskSpawner  │  │SupervisorChat  │  │  LearningsStore (MemRL)       │ │
│  │(orchestrator)│  │(AI + tools)    │  │  LLM Service                  │ │
│  └──────┬──────┘  └────────────────┘  └───────────────────────────────┘ │
│         │                                                                 │
│  ┌──────┴──────────┐  ┌──────────────┐  ┌────────────────────────────┐  │
│  │ Backends:       │  │ ConfigStore  │  │ ConversationParser         │  │
│  │ ├ ClaudeCode    │  │ WorkspaceStore│ │ TaskPersistence            │  │
│  │ └ OpenCode      │  │ GitUtils     │  │ TaskStateDetection         │  │
│  └─────────────────┘  └──────────────┘  └────────────────────────────┘  │
│                                                                           │
│  ┌─────────────────┐  ┌──────────────┐  ┌────────────────────────────┐  │
│  │ Anthropic Proxy │  │  Hyperspace  │  │  TunnelManager (ngrok)     │  │
│  │ (SAP AI Core)   │  │    Proxy     │  │  UsageReporter             │  │
│  └─────────────────┘  └──────────────┘  └────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
                            │
                            │ Spawns processes (PTY or HTTP)
                            ▼
┌──────────────────────────────────────────────────────────────────────────┐
│               CLI Backend Instances                                       │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐       │
│  │ Claude Code (pty)│  │ Claude Code (pty)│  │ OpenCode (http) │       │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘       │
│                            │                                              │
│   Hooks: pre-tool-use.sh, notification-hook.sh, stop-notify.sh           │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow

### 1. Task Creation
```
User → WorkspacePanel → WebSocket (task:create) → server.ts → TaskSpawner
    → selects backend (ClaudeCode or OpenCode) → spawns CLI process
    → WebSocket (task:created) → taskStore → UI updates
```

### 2. Task State Changes
```
Claude CLI → Hook script → POST /api/claude-* → server.ts
    → TaskSpawner updates state → WebSocket (task:stateChanged) → UI updates

Terminal output → TaskStateDetection → detects waiting_input type
    → WebSocket (task:stateChanged) → UI shows appropriate input prompt
```

### 3. Terminal I/O
```
Claude CLI output → node-pty → TaskSpawner → WebSocket (task:output) → TerminalView
User input → TerminalView → WebSocket (task:input) → TaskSpawner → node-pty → CLI
```

### 4. Supervisor Chat
```
User message → SupervisorChat → WebSocket (supervisor:message) → server.ts
    → SupervisorChat (AI with tools) → may call create_task, send_task_input, etc.
    → WebSocket (supervisor:response) → Chat UI updates
```

### 5. Learning Extraction
```
Task completes → User clicks "Learn" → POST /api/tasks/:id/learn
    → LLM analyzes conversation → suggests learnings
    → User selects learnings → POST /api/tasks/:id/learn/save
    → LearningsStore generates embeddings → persists with MemRL scoring
```

### 6. Mobile Access
```
User enables tunnel → POST /api/tunnel/start → TunnelManager → ngrok
    → Public HTTPS URL generated → QR code displayed
    → Mobile device scans QR → connects via tunnel → full UI access
```

---

## REST API Endpoints

### Task Management
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/tasks` | List all active tasks |
| GET | `/api/tasks/:taskId/status` | Get task status |
| GET | `/api/tasks/:taskId/debug` | Debug information |

### WebSocket Events (Task)
| Event | Direction | Purpose |
|-------|-----------|---------|
| `task:create` | Client → Server | Create a new task |
| `task:input` | Client → Server | Send input to task |
| `task:output` | Server → Client | Terminal output stream |
| `task:stateChanged` | Server → Client | Task state update |
| `task:resize` | Client → Server | Resize terminal |
| `task:interrupt` | Client → Server | Interrupt task (ESC) |
| `task:stop` | Client → Server | Stop task |
| `task:destroy` | Client → Server | Destroy task |
| `task:summary` | Server → Client | AI-generated task summary |

### Learnings
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/learnings` | List all learnings |
| GET | `/api/learnings/:id` | Get learning by ID |
| POST | `/api/learnings` | Create learning |
| PUT | `/api/learnings/:id` | Update learning |
| DELETE | `/api/learnings/:id` | Delete learning |
| POST | `/api/learnings/search` | Semantic search learnings |
| POST | `/api/tasks/:taskId/learn` | Analyze task for learnings |
| POST | `/api/tasks/:taskId/learn/save` | Save learnings from analysis |

### Conversation History
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/tasks/:taskId/conversation` | Get task conversation |
| GET | `/api/workspaces/:workspaceId/sessions` | List workspace sessions |
| GET | `/api/sessions/:sessionId/conversation` | Get session conversation |

### Configuration
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/config` | Get current configuration |
| PUT | `/api/config` | Update configuration |
| POST | `/api/config/validate-aicore` | Validate SAP AI Core settings |
| GET | `/api/aicore/models` | List SAP AI Core models |
| POST | `/api/aicore/test` | Test SAP AI Core connection |
| POST | `/api/hyperspace/models` | List Hyperspace models |
| GET | `/api/claude-mcp-servers` | List Claude MCP servers |
| GET | `/api/claude-config/mcp-servers` | Get MCP configuration |
| PUT | `/api/claude-config/mcp-servers` | Update MCP servers |

### Remote Access
| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/tunnel/start` | Start ngrok tunnel |
| POST | `/api/tunnel/stop` | Stop ngrok tunnel |
| GET | `/api/tunnel/status` | Get tunnel status |
| GET | `/mobile` | Mobile web interface |

### System
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/health` | Health check |
| GET | `/api/backend/status` | Backend status and info |
| GET | `/api/system/stats` | CPU/memory stats |
| POST | `/api/upload/image` | Upload image file |
| DELETE | `/api/upload/image/:filename` | Delete uploaded image |
| POST | `/api/tts` | Text-to-speech synthesis |

### Proxy Endpoints
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/v1/models` | List available Claude models |
| POST | `/v1/messages` | Anthropic Messages API (proxied) |
| POST | `/v1/embeddings` | Generate embeddings |

---

## Key Features

| Feature | Implementation |
|---------|----------------|
| Multi-instance task management | TaskSpawner with pluggable backends (ClaudeCode PTY, OpenCode HTTP) |
| Real-time terminal emulation | xterm.js + WebSocket streaming |
| AI supervisor chat | SupervisorChat with tool-calling (create/delete/input tasks) |
| Learning system | LearningsStore with embeddings, semantic search, MemRL utility scoring |
| Git integration | git-utils.ts (state capture, diff tracking, revert) |
| Voice input | Deepgram API with auto-send on silence |
| Task persistence | JSON files with debounced saves, archived task lazy-loading |
| Task state detection | Terminal output analysis for waiting_input types |
| Mobile access | ngrok tunnel with QR code and token authentication |
| System monitoring | Real-time CPU/memory stats polling |
| Conversation history | Claude Code JSONL + OpenCode message parsing |
| Hook system | Shell scripts → HTTP callbacks for lifecycle events |
| Embedded proxies | Anthropic (SAP AI Core/Bedrock) + Hyperspace AI Proxy |
| Usage analytics | Token tracking via fire-and-forget reporter |
| Cross-platform | Windows (PowerShell), macOS, Linux support |
| Desktop app | Electron wrapper with embedded backend |

---

## Development

### Auto-Reload
- **Backend:** `tsx watch` monitors `src/`, reloads in 1-2 seconds
- **Frontend:** Vite HMR provides instant updates

### Ports
- Backend: `http://localhost:4001`
- Frontend: `http://localhost:5173`

### Starting the Project

**macOS / Linux:**
```bash
./start.sh
```

**Windows (PowerShell):**
```powershell
.\start.ps1
```

**Or use npm directly:**
```bash
npm run dev
```

### Testing
```bash
# Unit tests
npm run test

# Test CLI
cd backend
npx tsx test-cli.ts --list-tasks
npx tsx test-cli.ts -m "your prompt" -w /path/to/workspace
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
    │ ANTHROPIC_BASE_URL=http://localhost:4001
    ▼
┌───────────────────────────────────────────────────────────────────┐
│                    Backend (Express) :4001                         │
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
    "ANTHROPIC_BASE_URL": "http://localhost:4001",
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

### Proxy Features

- **OAuth2 Token Caching:** Tokens cached with 60-second expiry buffer
- **Model Discovery:** Automatically discovers running deployments
- **Streaming Support:** Full SSE streaming with proper event types
- **Reasoning Support:** Converts `reasoning_effort` to `thinking` budget
- **Error Handling:** Proper HTTP status codes and error responses

---

## Hyperspace AI Proxy

The backend also includes a proxy for Hyperspace AI Proxy, which is the production-approved method for Claude API access at SAP.

### Features

- Proxies Anthropic API requests to external Hyperspace service
- Sanitizes tools and system blocks for compatibility
- Strips unsupported content types from messages
- Intercepts warmup requests to avoid quota waste
- Tracks token usage from SSE events
- Supports both streaming and non-streaming responses
