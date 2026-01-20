# Claudia

A web-based UI for managing multiple Claude Code CLI instances simultaneously. Claudia provides a visual interface for spawning, monitoring, and interacting with Claude Code tasks across different workspaces.

## Features

- **Multi-Task Management** - Spawn and manage multiple Claude Code CLI instances at once
- **Real-Time Terminal** - Full terminal emulation with xterm.js and WebSocket streaming
- **Workspace Organization** - Group tasks by project directories
- **Voice Input** - Web Speech API integration for hands-free interaction
- **AI Supervisor** - Optional AI-powered task analysis and chat interface
- **Git Integration** - Track changes and revert task modifications
- **Task Persistence** - Tasks survive server restarts with automatic reconnection

## Prerequisites

- **Node.js** 18+
- **npm** 9+
- **Claude Code CLI** - Install from [claude.ai/download](https://claude.ai/download)

## Installation

```bash
# Clone the repository
git clone https://github.com/thisislance98/claudia.git
cd claudia

# Install dependencies
npm install
```

## Running the App

### Quick Start

```bash
./start.sh
```

This will:
1. Kill any existing processes on required ports
2. Start the backend server (port 4001)
3. Start the frontend dev server (port 5173)

Access the UI at **http://localhost:5173**

### Manual Start

```bash
# Start both backend and frontend
npm run dev

# Or run them separately:
npm run dev:backend   # Backend only (port 4001)
npm run dev:frontend  # Frontend only (port 5173)
```

### Run as Desktop App (Electron)

```bash
# Development mode
npm run dev:electron

# Build distributable
npm run package
```

## Usage

1. **Add a Workspace** - Click "Add Workspace" and select a project directory
2. **Create a Task** - Click the "+" button in a workspace panel and enter your prompt
3. **Monitor Progress** - Watch the real-time terminal output as Claude works
4. **Interact** - Send follow-up messages or interrupt tasks as needed

## Ports

| Service | Port |
|---------|------|
| Backend API/WebSocket | 4001 |
| Frontend | 5173 |

## Configuration

### Claude Code Setup

Claudia spawns Claude Code CLI instances. Make sure Claude Code is installed and configured:

```bash
# Verify Claude Code is installed
claude --version
```

### SAP AI Core Integration (Optional)

Claudia can proxy Claude API requests through SAP AI Core:

```bash
# Set environment variables or configure in Settings menu
export SAP_AICORE_AUTH_URL=https://xxx.authentication.xxx.hana.ondemand.com
export SAP_AICORE_CLIENT_ID=your-client-id
export SAP_AICORE_CLIENT_SECRET=your-client-secret
export SAP_AICORE_BASE_URL=https://api.ai.xxx.aws.ml.hana.ondemand.com
```

## Development

The project uses auto-reload for rapid development:

- **Backend**: `tsx watch` reloads on file changes (1-2 seconds)
- **Frontend**: Vite HMR provides instant updates

### Project Structure

```
claudia/
├── backend/           # Express + WebSocket server
│   ├── src/
│   │   ├── server.ts         # Main server
│   │   ├── task-spawner.ts   # Process management
│   │   └── config-store.ts   # Settings storage
├── frontend/          # React + Vite SPA
│   └── src/
│       ├── App.tsx
│       ├── components/
│       └── stores/
├── shared/            # Shared TypeScript types
├── electron/          # Desktop app wrapper
└── start.sh           # Startup script
```

## License

MIT
