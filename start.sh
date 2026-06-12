#!/bin/bash

# Claudia - Start Script
#
# Usage:
#   ./start.sh           # backend runs no-watch (default; stable, no spurious restarts)
#   ./start.sh --watch   # backend runs tsx watch (auto-reload on backend/src edits)

set -e

WATCH=0
for arg in "$@"; do
    case "$arg" in
        --watch|-w) WATCH=1 ;;
    esac
done

# ============================================
# PORT CONFIGURATION - Single source of truth
# ============================================
BACKEND_PORT=4001
FRONTEND_PORT=5173
OPENCODE_PORT=4097
# ============================================

# Lock file to prevent duplicate starts
LOCK_FILE="/tmp/claudia-server.lock"

if [ -f "$LOCK_FILE" ]; then
    LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
    if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
        echo "❌ Claudia is already running (PID: $LOCK_PID)."
        echo "   Stop it first or remove the lock file: rm $LOCK_FILE"
        exit 1
    fi
    # Remove stale lock file
    rm -f "$LOCK_FILE"
fi

# Create lock file with our PID
echo $$ > "$LOCK_FILE"

# Clean up lock file on exit
trap "rm -f '$LOCK_FILE'" EXIT INT TERM

# Ensure OpenCode CLI is in PATH
export PATH=$HOME/.opencode/bin:$PATH

# Load environment variables if .env exists
if [ -f .env ]; then
    set -a; source .env; set +a
fi

# ============================================
# DEPENDENCY CHECK
# ============================================
check_deps() {
    local missing=0

    if ! command -v node &>/dev/null; then
        echo "❌ Node.js is not installed."
        echo "   Install it from https://nodejs.org/ or via your package manager."
        missing=1
    fi

    if ! command -v npm &>/dev/null; then
        echo "❌ npm is not installed."
        echo "   It usually comes with Node.js. Install Node.js from https://nodejs.org/"
        missing=1
    fi

    if [ ! -d "node_modules" ] || [ ! -x "node_modules/.bin/tsx" ] || [ ! -x "node_modules/.bin/vite" ]; then
        echo "❌ Dependencies are not installed."
        echo "   Run: npm install"
        missing=1
    fi

    if [ $missing -eq 1 ]; then
        echo ""
        echo "Please install the missing dependencies and try again."
        exit 1
    fi
}

check_deps

# Fix node-pty spawn-helper permissions (npm doesn't preserve execute bits)
for helper in node_modules/node-pty/prebuilds/*/spawn-helper; do
    [ -f "$helper" ] && chmod +x "$helper"
done

# Check if ports are available
echo "🔍 Checking ports..."
ports_busy=0
for port in $BACKEND_PORT $FRONTEND_PORT $OPENCODE_PORT; do
    if lsof -ti:$port >/dev/null 2>&1; then
        echo "❌ Port $port is already in use:"
        lsof -i:$port
        ports_busy=1
    fi
done

if [ $ports_busy -eq 1 ]; then
    echo ""
    echo "Please free the ports above and try again."
    echo "You can kill processes on a port with: kill \$(lsof -ti:<port>)"
    exit 1
fi

echo "✅ Ports are free"
echo ""
echo "🔮 Starting Claudia..."
echo "   Backend: http://localhost:$BACKEND_PORT"
echo "   Frontend: http://localhost:$FRONTEND_PORT"
echo ""

# Start from project root
cd "$(dirname "$0")"

# Export CLAUDIA_BACKEND_PORT for the backend to use
export CLAUDIA_BACKEND_PORT=$BACKEND_PORT

# Increase Node.js memory limit for backend (handles many persisted tasks + archived tasks)
export NODE_OPTIONS="--max-old-space-size=8192"

# Start backend and frontend.
# Backend defaults to no-watch to prevent spurious restarts from file changes
# (e.g., Claude Code tasks editing source files, antivirus). Pass --watch for auto-reload.
# Frontend: Vite HMR auto-reloads on file changes.
#
# The backend runs in a RELAUNCH LOOP: exit code 75 (triggered by POST
# /api/server/restart) relaunches it; any other exit code stops everything.
if [ "$WATCH" -eq 1 ]; then BACKEND_SCRIPT="dev"; else BACKEND_SCRIPT="dev:no-watch"; fi
echo "Backend mode: $BACKEND_SCRIPT"

# Recursively kill a process and all its descendants (vite spawns esbuild
# grandchildren that `pkill -P` alone would miss).
kill_tree() {
    local pid=$1
    for child in $(pgrep -P "$pid" 2>/dev/null); do
        kill_tree "$child"
    done
    kill "$pid" 2>/dev/null
}

# Frontend as a background child; kill its whole tree on exit.
npm run dev -w frontend &
FRONTEND_PID=$!
trap "rm -f '$LOCK_FILE'; kill_tree $FRONTEND_PID" EXIT INT TERM

RESTART_EXIT_CODE=75
while true; do
    set +e
    npm run "$BACKEND_SCRIPT" -w backend
    code=$?
    set -e
    if [ "$code" -eq "$RESTART_EXIT_CODE" ]; then
        echo "Backend requested restart (exit $code) -- relaunching..."
        sleep 0.5
        continue
    fi
    echo "Backend exited (code $code) -- shutting down."
    break
done

