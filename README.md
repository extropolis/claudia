![WF1ds0PyunwPNJfoZjzvS](https://github.com/user-attachments/assets/5169464e-7630-4327-8f2d-56500256f117)

# Claudia

A multi-instance Claude Code orchestrator — a web UI (and Electron desktop app) that lets you run, monitor, and manage multiple Claude Code CLI sessions simultaneously across different projects.

## Features

- **Multi-Task Management** - Spawn and manage multiple Claude Code CLI instances at once
- **Real-Time Terminal** - Full terminal emulation with xterm.js and WebSocket streaming
- **Multi-Backend Support** - Works with Claude Code CLI and OpenCode backends
- **AI Supervisor Chat** - Conversational AI interface with tool-calling for task management
- **Claudia MCP Server** - Let Claude Code agents spawn and coordinate sibling tasks via Model Context Protocol
- **Workspace Organization** - Group tasks by project directories with custom system prompts
- **Voice Input** - Deepgram-powered speech-to-text with auto-send on silence
- **Git Integration** - Track changes, view diffs, and revert task modifications
- **Task Persistence** - Tasks survive server restarts with automatic reconnection
- **Task Archival** - Archive completed tasks with lazy-loaded history
- **Learning System** - Extract and store learnings from completed tasks using semantic search
- **Mobile Access** - Remote access via ngrok tunnel with QR code for mobile devices
- **System Monitoring** - Real-time CPU and memory usage stats
- **Conversation History** - View parsed conversation history from Claude Code sessions
- **Cross-Platform** - Runs on Windows, macOS, and Linux
- **Electron Desktop App** - Standalone desktop application wrapper

## Prerequisites

- **Node.js** 18+
- **npm** 9+
- **Claude Code CLI** - Install first (see below)

## Step 1: Install Claude Code CLI

**macOS / Linux:**
```bash
curl -fsSL https://claude.ai/install.sh | bash
```

**Windows:**
```powershell
irm https://claude.ai/install.ps1 | iex
```

## Step 2: Install Claudia

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/extropolis/claudia/main/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/extropolis/claudia/main/install.ps1 | iex
```

**Or install directly via npm:**
```bash
npm install -g @extropolis/claudia
```

<details>
<summary>Manual installation (from source)</summary>

```bash
# Clone the repository
git clone https://github.com/extropolis/claudia.git
cd claudia

# Install dependencies
npm install

# Node.js v25+ only: upgrade node-pty for compatibility
node -v  # check your version
npm install node-pty@1.2.0-beta.11  # only if v25+

# Build the shared types package (required before first run)
npm run build -w shared
```
</details>

## Step 3: Running the App

### Quick Start

```bash
claudia
```

Or if running from a cloned repo:

**macOS / Linux:**
```bash
./start.sh
```

**Windows (PowerShell):**
```powershell
.\start.ps1
```

This will:
1. Kill any existing processes on required ports
2. Start the backend server (port 4001)
3. Start the frontend dev server (port 5173)

Access the UI at **http://localhost:5173**

### Electron Desktop App

To run as a standalone desktop application:

```bash
claudia electron
```

Or if running from a cloned repo:

**macOS / Linux:**
```bash
./start-electron.sh
```

**Windows (PowerShell):**
```powershell
.\start-electron.ps1
```

To build distributable packages:

```bash
npm run package          # Current platform
npm run package:mac      # macOS
npm run package:win      # Windows
npm run package:linux    # Linux
```

### Configure Claudia Settings

On first launch, the Settings panel will open automatically:

1. Enter your **Anthropic API Key**
2. Choose a model (e.g., Claude 4.5 Sonnet)

## Usage

### Getting Started

1. **Add a Workspace** — Click the **+** button in the top right corner and enter the path to your project directory
2. **Create a Task** — Use the text box at the bottom of the workspace panel to enter your prompt and start a new task
3. **Monitor Progress** — Watch the real-time terminal output as Claude works
4. **Interact** — Send follow-up messages or interrupt tasks as needed
5. **Use Supervisor Chat** — Toggle the right panel for AI-assisted task management with tool-calling
6. **Review Learnings** — After tasks complete, extract and save learnings from conversations
7. **Mobile Access** — Open Settings to enable mobile tunnel and scan the QR code on your phone

### Best Practices

**Run parallel workstreams across projects** — Add multiple workspaces and fire off tasks in each. They all run concurrently, and you can monitor everything from one screen.

**Divide and conquer within one project** — Spawn multiple tasks in the same workspace for independent work (e.g., "build the API endpoint" + "write the tests" + "update the docs"). The supervisor can coordinate between them.

**Use the Supervisor Chat for orchestration** — The right-panel AI can create tasks, send messages to running tasks, read their output, and analyze results. Great for high-level coordination like "Create a task to fix the login bug, and another to add unit tests for auth."

**Set system prompts per workspace** — Right-click a workspace to set a system prompt. Every task in that workspace inherits those instructions, keeping your Claude instances consistent.

**Use workspace references for cross-project context** — If a task needs to understand code in another directory, add it as a reference. Claude gets read-only access to that context without switching workspaces.

**Archive completed tasks** — Keep your workspace clean by archiving finished tasks. Their full output history is preserved and can be restored later.

## Architecture

```
┌──────────────────────────────────┐
│  Frontend (React + Vite)         │  :5173
│  3-panel layout:                 │
│  [Workspaces] [Terminal] [Chat]  │
└──────────┬───────────────────────┘
           │ WebSocket + REST API
           ▼
┌──────────────────────────────────┐
│  Backend (Express + Node.js)     │  :4001
│  TaskSpawner, SupervisorChat,    │
│  WorkspaceStore, GitUtils, etc.  │
└──────────┬───────────────────────┘
           │ Spawns PTY processes
           ▼
┌──────────────────────────────────┐
│  Claude Code CLI instances       │
│  (one process per task)          │
│  ┌─ Claudia MCP ─┐              │
│  │ claudia_*      │──→ Backend   │
│  └────────────────┘              │
└──────────────────────────────────┘
```

- **Frontend** — React SPA with a resizable 3-panel layout: workspace sidebar, terminal/content area, and supervisor chat. State is managed with Zustand and terminals are rendered with xterm.js.
- **Backend** — Express server that manages task lifecycles, spawns Claude Code processes via node-pty, streams output over WebSocket, and provides REST APIs for workspaces, config, and more.
- **Claude Code instances** — Each task is an independent Claude Code CLI process running in its own PTY. Tasks are fully isolated from each other. When the Claudia MCP is enabled, each instance can call back into the backend to create and coordinate sibling tasks.

## Core Concepts

### Workspaces

A **workspace** is a project directory (e.g., `/home/you/myproject`). You add workspaces to the sidebar and create tasks within them. Each workspace can have:

- **System prompts** — Custom instructions injected into every task in that workspace (e.g., "Use TypeScript, prefer functional patterns")
- **References** — Links to related directories that provide read-only context to Claude tasks
- **Task ordering** — Drag-and-drop reordering of tasks within a workspace

### Tasks

A **task** is a single Claude Code session. Each task maps 1:1 to a Claude Code CLI process. Tasks have the following states:

| State | Meaning |
|-------|---------|
| `starting` | Process spawned, Claude initializing |
| `busy` | Claude is actively working (output is changing) |
| `idle` | Claude has finished working and is waiting (output stable for 3+ seconds) |
| `waiting_input` | Claude is asking a question or requesting permission |
| `exited` | Process has terminated |
| `disconnected` | Lost connection to the process (can auto-reconnect on restart) |
| `interrupted` | Task was stopped by the user |

Any active state (`starting`, `busy`, `idle`, `waiting_input`) can transition to `exited` or `interrupted` at any time. Normal flow looks like:

```
starting → busy ⇄ idle ⇄ waiting_input → exited
```

The backend polls task state every 3 seconds by comparing output buffer sizes. Git state is captured before and after each task, enabling one-click revert of changes.

### Supervisor Chat

The **Supervisor Chat** (right panel) is an AI assistant with tool-calling capabilities that can:

- Create and delete tasks across any workspace
- Send messages/input to running tasks
- Read task conversation history and analyze results
- Monitor all tasks and auto-analyze when they change state

Think of it as a manager that can coordinate multiple Claude Code agents working in parallel.

### Claudia MCP Server

The **Claudia MCP** (Model Context Protocol) server lets Claude Code agents running inside Claudia communicate back with the orchestrator. When enabled, each task gets its own MCP server instance injected automatically — giving Claude Code the ability to spawn sibling tasks, check their progress, and send them input.

This enables **agent-to-agent orchestration**: a Claude Code task can break its own work into subtasks, delegate them, and wait for results — all without human intervention.

#### Enabling the MCP

The Claudia MCP is **opt-in** and disabled by default. To enable it:

1. Open the **Settings** panel in the Claudia UI
2. Toggle the **Claudia MCP Server** option on
3. New tasks will automatically have the MCP server injected

Once enabled, every new Claude Code task gets access to the `claudia_*` tools below. The MCP server runs as a stdio process alongside each Claude Code instance and communicates with the Claudia backend via HTTP and WebSocket.

#### Available MCP Tools

| Tool | Description |
|------|-------------|
| `claudia_list_tasks` | List all active tasks in the current workspace with their state, prompt, and timing info |
| `claudia_get_task_status` | Get detailed status of a specific task including state and a snippet of recent output |
| `claudia_get_task_output` | Fetch recent terminal output from a task (up to 32KB) to check progress or read results |
| `claudia_create_task` | Create a new Claude Code task in the current workspace with a prompt and optional display name |
| `claudia_send_input` | Send input to a task that is waiting (answer questions, grant permissions, provide text) |
| `claudia_rename_task` | Rename a task's display name in the sidebar (can rename itself or other tasks) |
| `claudia_archive_task` | Archive a completed task to remove it from the active list |

#### Example Use Cases

- **Parallel implementation** — A task working on a feature creates subtasks: one for the backend API, one for frontend components, and one for tests. It monitors their progress and integrates the results.
- **Delegation** — A task encounters work outside its scope and creates a sibling task to handle it, then continues with its own work.
- **Unblocking** — A task notices a sibling is waiting for permission and sends it the appropriate input.

#### Environment Variables

Each MCP server instance receives these environment variables from the task spawner:

| Variable | Purpose |
|----------|---------|
| `CLAUDIA_WORKSPACE_ID` | Scopes the MCP tools to the current workspace |
| `CLAUDIA_TASK_ID` | The task's own ID (used for self-rename) |
| `CLAUDIA_BACKEND_URL` | Backend API URL (default: `http://localhost:4001`) |
| `CLAUDIA_MCP_DEBUG` | Enable debug logging to stderr |

## Ports

| Service | Port |
|---------|------|
| Backend API/WebSocket | 4001 |
| Frontend | 5173 |


## Development

The project uses auto-reload for rapid development:

- **Backend**: `tsx watch` reloads on file changes (1-2 seconds)
- **Frontend**: Vite HMR provides instant updates

### Available Scripts

```bash
# Development
npm run dev                # Start backend + frontend concurrently
npm run dev:backend        # Backend only (tsx watch)
npm run dev:frontend       # Frontend only (Vite HMR)
npm run dev:electron       # Electron development mode

# Building
npm run build              # Build all workspaces
npm run package            # Build Electron distributable

# Testing
npm run test               # Run all tests
npm run test:backend       # Backend tests only
npm run test:frontend      # Frontend tests only
npm run test:watch         # Watch mode tests
```

### Test CLI

Test backend changes without the UI:

```bash
cd backend
npx tsx test-cli.ts --list-tasks
npx tsx test-cli.ts -m "your prompt" -w /path/to/workspace
npx tsx test-cli.ts --help
```

### CI/CD

Automated tests run on push to `main` and `develop` branches across Ubuntu and Windows environments. The pipeline builds the shared package, backend, and runs unit tests.

### Releasing

Versioning is controlled by a single file: **`version.txt`** in the project root. All package versions are synced from it.

**To release a new version:**

1. Edit `version.txt` with the new version (e.g., `0.2.0`)
2. Run the release command:
   ```bash
   npm run release
   ```

That's it. The script will:
- Sync the version into all `package.json` files
- Commit the changes
- Create a git tag (`v0.2.0`)
- Push to `main` with the tag

The CI/CD pipeline then:
1. Builds and runs all tests automatically
2. Pauses for **your approval** in GitHub Actions
3. Publishes `@extropolis/claudia` to npm

**Other version commands:**
```bash
npm run version:sync    # Sync package.json files to version.txt (no git)
npm run version:check   # Verify all packages match version.txt
```

### Project Structure

```
claudia/
├── backend/               # Express + WebSocket server
│   ├── src/
│   │   ├── server.ts              # Main server with routes and WebSocket
│   │   ├── task-spawner.ts        # Process management and task lifecycle
│   │   ├── claudia-mcp-server.ts  # Claudia MCP server (stdio)
│   │   ├── config-store.ts        # Settings and configuration storage
│   │   ├── supervisor-chat.ts     # AI supervisor with tool-calling
│   │   ├── learnings-store.ts     # Semantic learning storage (MemRL)
│   │   ├── llm-service.ts         # LLM response generation
│   │   ├── task-persistence.ts    # Task data persistence and archival
│   │   ├── task-state-detection.ts # Terminal output state analysis
│   │   ├── conversation-parser.ts # Claude conversation history parser
│   │   ├── git-utils.ts           # Git state tracking and revert
│   │   ├── tunnel-manager.ts      # ngrok tunnel for mobile access
│   │   ├── usage-reporter.ts      # Token usage analytics
│   │   ├── backends/              # Pluggable backend implementations
│   │   │   ├── claude-code-backend.ts  # Claude Code CLI (PTY)
│   │   │   └── opencode-backend.ts     # OpenCode HTTP API
│   │   ├── anthropic-proxy/       # Anthropic API proxy
│   │   └── hyperspace-proxy/      # Hyperspace AI Proxy integration
│   ├── hooks/                     # Claude Code lifecycle hooks
│   └── __tests__/                 # Unit tests (Vitest)
├── frontend/              # React + Vite SPA
│   └── src/
│       ├── App.tsx                # Main layout with resizable panels
│       ├── components/
│       │   ├── WorkspacePanel.tsx          # Sidebar with workspaces and tasks
│       │   ├── TerminalView.tsx            # xterm.js terminal emulator
│       │   ├── SupervisorChat.tsx          # AI chat interface
│       │   ├── SettingsMenu.tsx            # Full settings panel
│       │   ├── ConversationHistory.tsx     # Session conversation viewer
│       │   ├── TaskSummaryPanel.tsx        # Task results and actions
│       │   ├── LearnFromConversationModal.tsx # Learning extraction UI
│       │   ├── MobileAccessModal.tsx       # QR code mobile access
│       │   ├── GlobalVoiceManager.tsx      # Deepgram voice manager
│       │   ├── SystemStats.tsx             # CPU/memory monitoring
│       │   └── NotificationContainer.tsx   # Toast notifications
│       ├── hooks/
│       │   ├── useWebSocket.ts            # WebSocket with auto-reconnect
│       │   └── useVoiceRecognition.ts     # Deepgram speech-to-text
│       └── stores/
│           └── taskStore.ts               # Zustand global state
├── shared/                # Shared TypeScript types
│   └── src/index.ts       # Task, Workspace, ChatMessage types
├── electron/              # Electron desktop wrapper
│   ├── main.ts            # Main process and window management
│   ├── server-manager.ts  # Backend server lifecycle
│   └── preload.ts         # IPC bridge
├── start.sh               # Startup script (macOS/Linux)
├── start.ps1              # Startup script (Windows)
└── package.json           # Monorepo root config
```

## License

MIT - see [LICENSE](LICENSE) for details.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request on [GitHub](https://github.com/extropolis/claudia).

## Support

If you have any issues or questions, please [open an issue](https://github.com/extropolis/claudia/issues).
