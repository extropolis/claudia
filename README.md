![WF1ds0PyunwPNJfoZjzvS](https://github.com/user-attachments/assets/5169464e-7630-4327-8f2d-56500256f117)

# Claudia

A web-based UI for managing multiple Claude Code CLI instances simultaneously. Claudia provides a visual interface for spawning, monitoring, and interacting with Claude Code tasks across different workspaces. Available as a web app or Electron desktop application.

## Features

- **Multi-Task Management** - Spawn and manage multiple Claude Code CLI instances at once
- **Real-Time Terminal** - Full terminal emulation with xterm.js and WebSocket streaming
- **Multi-Backend Support** - Works with Claude Code CLI and OpenCode backends
- **AI Supervisor Chat** - Conversational AI interface with tool-calling for task management
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

1. **Add a Workspace** - Click the **+** button in the top right corner and enter the path to your project directory
2. **Create a Task** - Use the text box at the bottom of the workspace panel to enter your prompt and start a new task
3. **Monitor Progress** - Watch the real-time terminal output as Claude works
4. **Interact** - Send follow-up messages or interrupt tasks as needed
5. **Use Supervisor Chat** - Switch to Chat view for AI-assisted task management with tool-calling
6. **Review Learnings** - After tasks complete, extract and save learnings from conversations
7. **Mobile Access** - Open Settings to enable mobile tunnel and scan the QR code on your phone

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
