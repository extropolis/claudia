![WF1ds0PyunwPNJfoZjzvS](https://github.com/user-attachments/assets/5169464e-7630-4327-8f2d-56500256f117)

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


https://github.com/user-attachments/assets/e0d9d9a3-77eb-45b6-ac55-984d8ec9c663


## Prerequisites

- **Node.js** 18+
- **npm** 9+
- **Claude Code CLI** - Install from [claude.ai/download](https://claude.ai/download)

## Installation

```bash
# Clone the repository
git clone https://github.concur.com/ai-experiments/claudia.git
cd claudia

# Install dependencies
npm install

# Node.js v25+ only: upgrade node-pty for compatibility
node -v  # check your version
npm install node-pty@1.2.0-beta.11  # only if v25+

# Build the shared types package (required before first run)
npm run build -w shared
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

### SAP AI Core Setup

On first launch, the Settings panel will open automatically. Enter your SAP AI Core credentials:

1. **Auth URL** — your SAP authentication endpoint
2. **Client ID** and **Client Secret**
3. **Base URL** — your AI Core API endpoint
4. Choose a model (e.g., Claude 4.5 Sonnet)
5. Restart the server (`./start.sh`)

Claudia runs an embedded proxy that translates Anthropic API calls into SAP AI Core requests, so Claude Code works without a direct Anthropic login.


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
└── start.sh           # Startup script
```


