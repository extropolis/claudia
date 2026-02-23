![WF1ds0PyunwPNJfoZjzvS](https://github.com/user-attachments/assets/5169464e-7630-4327-8f2d-56500256f117)

# Claudia


A web-based UI for managing multiple Claude Code CLI instances simultaneously. Claudia provides a visual interface for spawning, monitoring, and interacting with Claude Code tasks across different workspaces.

## Features

- **Multi-Task Management** - Spawn and manage multiple Claude Code CLI instances at once
- **Real-Time Terminal** - Full terminal emulation with xterm.js and WebSocket streaming
- **Workspace Organization** - Group tasks by project directories
- **Voice Input** - Web Speech API integration for hands-free interaction
- **Git Integration** - Track changes and revert task modifications
- **Task Persistence** - Tasks survive server restarts with automatic reconnection

## Prerequisites

- **Node.js** 18+
- **npm** 9+
- **Claude Code CLI** - See Step 1 below
- **HAI CLI** - Required for Hyperspace AI Proxy (production-approved)

## Installation Video
**[Click to view](https://sapnam-my.sharepoint.com/:v:/g/personal/lance_hughes_sap_com/IQBjFLcg7j2SSpd7WekKAY3JAenz99GB5Rha_YVVrnZNH3s?nav=eyJyZWZlcnJhbEluZm8iOnsicmVmZXJyYWxBcHAiOiJPbmVEcml2ZUZvckJ1c2luZXNzIiwicmVmZXJyYWxBcHBQbGF0Zm9ybSI6IldlYiIsInJlZmVycmFsTW9kZSI6InZpZXciLCJyZWZlcnJhbFZpZXciOiJNeUZpbGVzTGlua0NvcHkifX0&e=C08ugl)**

## Step 1: Install Claude Code CLI

**macOS / Linux:**
```bash
curl -fsSL https://claude.ai/install.sh | bash
```

**Windows:**
```powershell
irm https://claude.ai/install.ps1 | iex
```

## Step 2: Install HAI CLI

Follow the official installation guide: **[Hyperspace CLI Installation](https://pages.github.tools.sap/hAIperspace/hai-docs/llm-proxy/installation/cli/#__tabbed_1_1)**

## Step 3: Configure Hyperspace AI Proxy

> **Note:** Hyperspace AI Proxy is the only production-approved method for using Claude at SAP.

1. Configure Claude Code for the HAI proxy:
   ```bash
   hai configure claude-code
   ```

2. Start the proxy:
   ```bash
   hai proxy start
   ```

3. Copy the API key displayed in the proxy window — you'll need it for Claudia settings.

## Step 4: Install Claudia

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

## Step 5: Running the App

### Quick Start

```bash
./start.sh
```

This will:
1. Kill any existing processes on required ports
2. Start the backend server (port 4001)
3. Start the frontend dev server (port 5173)

Access the UI at **http://localhost:5173**

### Configure Claudia Settings

On first launch, the Settings panel will open automatically:

1. Select **Hyperspace AI Proxy** as your provider
2. Paste the API key from Step 3 into the API Key field
3. Choose a model (e.g., Claude 4.5 Sonnet)

### SAP AI Core Setup (Alternative - Non-Production)

> **Note:** SAP AI Core is available for development/testing but is **not approved for production use**. Use Hyperspace AI Proxy for production workloads.

If you need to use SAP AI Core instead, enter your credentials (ask in [@ask-ai-blueprint](https://sap.slack.com/channels/ask-ai-blueprint) Slack channel):

1. **Auth URL** — your SAP authentication endpoint
2. **Client ID** and **Client Secret**
3. **Base URL** — your AI Core API endpoint
4. Choose a model (e.g., Claude 4.5 Sonnet)

Claudia runs an embedded proxy that translates Anthropic API calls into SAP AI Core requests.


## Usage

1. **Add a Workspace** - Click the **+** button in the top right corner and enter the path to your project directory
2. **Create a Task** - Use the text box at the bottom of the workspace panel to enter your prompt and start a new task
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

## Support

If you have any issues or questions:

- **Email**: lance.hughes@sap.com
- **Slack**: [#claudia-support](https://sap.slack.com/channels/claudia-support)
