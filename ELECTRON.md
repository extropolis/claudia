# Electron Desktop Application

Your Claude Code Orchestrator has been set up as a standalone Electron desktop application!

## Features

- **Standalone Desktop App**: No need to run separate backend and frontend servers
- **Auto-start Backend**: Express server starts automatically when you launch the app
- **Dynamic Port Allocation**: Automatically finds an available port (avoids conflicts)
- **Persistent Configuration**: Config files stored in user data directory
- **Cross-platform Support**: Can be packaged for macOS, Windows, and Linux

## Development

### Run in Electron (Development Mode)

This mode loads the frontend from Vite dev server (http://localhost:5173):

```bash
# Terminal 1: Start Vite dev server
npm run dev:frontend

# Terminal 2: Run Electron
npm run dev:electron
```

**Note**: The Electron app will connect to the Vite dev server, so you get hot reload for frontend changes!

### Traditional Web Development (Still Works!)

The original web development workflow is preserved:

```bash
npm run dev
# Opens http://localhost:5173 in your browser
```

## Building & Packaging

### Build All Components

```bash
npm run build
```

This builds:
- Backend (backend/dist)
- Frontend (frontend/dist)
- Electron (dist-electron)

### Create Installable Package

#### macOS (DMG + ZIP)
```bash
npm run package:mac
```

Creates:
- `release/Claude Orchestrator-1.0.0.dmg` - Installer
- `release/Claude Orchestrator-1.0.0-mac.zip` - Portable

#### Windows (EXE + ZIP)
```bash
npm run package:win
```

#### Linux (AppImage + deb)
```bash
npm run package:linux
```

#### All Platforms
```bash
npm run package
```

## Configuration Storage

### Development Mode
- Config files stored in: `backend/` directory
- Same as web development mode

### Production (Packaged App)
- macOS: `~/Library/Application Support/Claude Orchestrator/`
- Windows: `%APPDATA%\Claude Orchestrator\`
- Linux: `~/.config/Claude Orchestrator/`

Files stored:
- `orchestrator-config.json` - System prompts, tools, MCP servers
- `project-config.json` - Current project and recent projects
- `workspace-config.json` - Workspace list
- `data/conversations.json` - Conversation history

## Architecture

### Backend Integration
- Express server runs in Electron's main process
- Dynamic port allocation (defaults to 3001, finds next available)
- WebSocket support for real-time communication

### Frontend Loading
- **Development**: Loads from `http://localhost:5173` (Vite dev server)
- **Production**: Loads from packaged `frontend/dist/index.html`

### Security
- `nodeIntegration: false` - Renderer can't access Node.js directly
- `contextIsolation: true` - Preload script creates security bridge
- Safe API exposure via `contextBridge`

## Electron API (Frontend)

The frontend can access Electron-specific functionality:

```typescript
// Check if running in Electron
if (window.electronAPI) {
  // Get backend URL
  const url = window.electronAPI.getBackendUrl();

  // Open directory picker
  const path = await window.electronAPI.selectDirectory();

  // Check if in Electron
  const isElectron = window.electronAPI.isElectron();
}
```

## Troubleshooting

### "Cannot find module" errors
Make sure to build the backend and electron files:
```bash
npm run build:backend
npm run build:electron
```

### Port already in use
The app will automatically find an available port. If you see issues, check:
```bash
lsof -ti:3001
```

### Vite dev server not running (dev:electron)
Make sure Vite is running before starting Electron:
```bash
npm run dev:frontend  # Start this first
npm run dev:electron  # Then start Electron
```

### Config not persisting
In development, config is stored in `backend/`. In production, it's in the user data directory (see Configuration Storage above).

## Dependencies

### Runtime
- `get-port` - Dynamic port allocation
- `node-pty` - Pseudo-terminal for spawning Claude CLI

### Development
- `electron` - Desktop application framework
- `electron-builder` - Packaging and building

## Scripts Reference

| Command | Description |
|---------|-------------|
| `npm run dev` | Web development mode (backend + frontend) |
| `npm run dev:frontend` | Start Vite dev server only |
| `npm run dev:electron` | Run Electron in development mode |
| `npm run build` | Build all (backend + frontend + electron) |
| `npm run build:backend` | Build backend only |
| `npm run build:frontend` | Build frontend only |
| `npm run build:electron` | Build Electron files only |
| `npm run package` | Package for all platforms |
| `npm run package:mac` | Package for macOS |
| `npm run package:win` | Package for Windows |
| `npm run package:linux` | Package for Linux |

## What Changed

### New Files
- `electron/main.ts` - Electron main process
- `electron/preload.ts` - Security bridge (contextBridge)
- `electron/server-manager.ts` - Backend server lifecycle
- `electron/tsconfig.json` - TypeScript config for Electron
- `frontend/src/config/api-config.ts` - Centralized API URL configuration
- `frontend/src/types/electron.d.ts` - TypeScript definitions
- `electron-builder.json` - Packaging configuration
- `build/entitlements.mac.plist` - macOS security entitlements

### Modified Files
- `package.json` - Added Electron scripts and main field
- `backend/src/server.ts` - Accepts `basePath` parameter
- `backend/src/config-store.ts` - Supports dynamic config path
- `backend/src/project-store.ts` - Supports dynamic config path
- `backend/src/workspace-store.ts` - Supports dynamic config path
- `backend/src/conversation-store.ts` - Supports dynamic config path
- `frontend/src/hooks/useWebSocket.ts` - Uses dynamic WebSocket URL
- `frontend/src/components/ConfigPanel.tsx` - Uses dynamic API URL
- `frontend/src/components/CodeViewer.tsx` - Uses dynamic API URL

## Next Steps

1. **Test the app**: Run `npm run dev:electron` (with Vite dev server running)
2. **Package it**: Run `npm run package:mac` to create a DMG
3. **Distribute**: Share the DMG or ZIP file

The packaged app is completely standalone - users don't need Node.js or any dependencies installed!
