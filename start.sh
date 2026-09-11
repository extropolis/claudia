#!/bin/bash

# Claudia - Start Script
#
# Usage:
#   ./start.sh           # backend runs no-watch (default; stable, no spurious restarts)
#   ./start.sh --watch   # backend runs tsx watch (auto-reload on backend/src edits)

set -e

WATCH=0
FORCE=0
for arg in "$@"; do
    case "$arg" in
        --watch|-w) WATCH=1 ;;
        --force|-f) FORCE=1 ;;
    esac
done

# Recursively kill a process and all its descendants (vite spawns esbuild
# grandchildren that `pkill -P` alone would miss). ONLY safe for the frontend:
# the backend's children are live Claude Code sessions — never tree-kill it.
kill_tree() {
    local pid=$1
    for child in $(pgrep -P "$pid" 2>/dev/null); do
        kill_tree "$child"
    done
    kill "$pid" 2>/dev/null || true
}

# ============================================
# PORT CONFIGURATION - Single source of truth
# ============================================
# CLAUDIA_TEST_* overrides exist ONLY for scripts/test-start-port-check.sh
BACKEND_PORT="${CLAUDIA_TEST_BACKEND_PORT:-4001}"
FRONTEND_PORT="${CLAUDIA_TEST_FRONTEND_PORT:-5173}"
OPENCODE_PORT="${CLAUDIA_TEST_OPENCODE_PORT:-4097}"
# ============================================

# ============================================
# SINGLE INSTANCE CHECK
# ============================================
# Authoritative mutual exclusion lives in the backend: instance-lock.ts claims
# <dataDir>/instance.json at startup and refuses to boot a second backend
# against the same data directory. This block is only the friendly front door
# for that check — it tells the user WHERE the running Claudia is instead of
# letting npm spend ten seconds booting a process that immediately exits 1.
#
# It replaces a /tmp/claudia-server.lock file, which guarded the wrong thing:
# it covered only processes started through this script on this machine's /tmp,
# so Electron, `npm run dev`, containers and CI all bypassed it, and it said
# nothing at all about which data directory was in use. The data directory is
# the resource that must not be shared; the launcher is not.
INSTANCE_DIR="${CLAUDIA_DATA_DIR:-$(cd "$(dirname "$0")" && pwd)/backend}"
INSTANCE_FILE="$INSTANCE_DIR/instance.json"

# Pull one scalar field out of the lock file. instance.json is written
# pretty-printed, one field per line, so this stays a one-liner without pulling
# in a JSON parser before the dependency check has even run.
instance_field() { # args: field-name
    sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",]*\).*/\1/p" "$INSTANCE_FILE" 2>/dev/null | head -1
}

if [ -f "$INSTANCE_FILE" ]; then
    HOLDER_PID=$(instance_field pid)
    HOLDER_PORT=$(instance_field port)
    # Both signals must agree before we refuse, exactly as the backend does: a
    # live pid alone is ambiguous (a tsx-watch process on its way out still has
    # one, and pids get recycled), so the holder must also still be SERVING.
    if [ -n "$HOLDER_PID" ] && kill -0 "$HOLDER_PID" 2>/dev/null && [ -n "$HOLDER_PORT" ] \
        && curl -fsS --max-time 2 "http://127.0.0.1:$HOLDER_PORT/api/server-info" >/dev/null 2>&1; then
        echo "❌ Claudia is already running (PID: $HOLDER_PID) at http://localhost:$HOLDER_PORT"
        echo "   It holds the data directory: $INSTANCE_DIR"
        echo "   Attach to it instead of starting a second instance, or stop it first:"
        echo "     kill $HOLDER_PID"
        exit 1
    fi
    echo "ℹ️  Ignoring stale instance lock from PID ${HOLDER_PID:-unknown} (not serving)."
fi

# Ensure OpenCode CLI is in PATH
export PATH=$HOME/.opencode/bin:$PATH

# Load environment variables if .env exists
if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
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

# Check if ports are available — LISTENERS only. A plain `lsof -ti:port`
# also matches client sockets (e.g. a browser's CLOSED/TIME_WAIT connection
# to a dead backend), which produced false "port in use" failures.
echo "🔍 Checking ports..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ports_busy=0
for port in $BACKEND_PORT $FRONTEND_PORT $OPENCODE_PORT; do
    # `|| true`: the script runs under `set -e`, and lsof exits 1 when a port
    # has no listener — without the guard, a FREE port silently killed the
    # whole script right after "Checking ports...".
    listener_pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
    if [ -z "$listener_pids" ]; then
        continue
    fi

    for pid in $listener_pids; do
        cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
        # SAFETY: only ever offer to kill a process that provably belongs to
        # THIS claudia checkout (command line contains this repo's path).
        # Anything else — Claude Code sessions, other projects, unknown
        # processes — is reported and never touched.
        case "$cmd" in
            *"$SCRIPT_DIR"*)
                echo "⚠️  Port $port is held by a stale claudia process (PID $pid):"
                echo "    ${cmd:0:120}"
                do_kill=0
                if [ "$FORCE" -eq 1 ]; then
                    do_kill=1
                elif [ -t 0 ]; then
                    printf "    Kill it to free port %s? [y/N] " "$port"
                    read -r answer || true
                    if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
                        do_kill=1
                    fi
                fi
                if [ "$do_kill" -eq 1 ]; then
                    if [ "$port" = "$BACKEND_PORT" ]; then
                        # Backend: plain SIGTERM only — graceful shutdown saves
                        # task state; its children are live Claude Code sessions
                        # and must NOT be tree-killed out from under it.
                        kill "$pid" 2>/dev/null || true
                        # Wait up to 10s for graceful exit
                        for _ in $(seq 1 20); do
                            kill -0 "$pid" 2>/dev/null || break
                            sleep 0.5
                        done
                    else
                        # Frontend/opencode: tree-kill (vite's esbuild children)
                        kill_tree "$pid"
                        sleep 1
                    fi
                fi
                ;;
            *)
                echo "❌ Port $port is in use by a NON-claudia process (PID $pid) — refusing to touch it:"
                echo "    ${cmd:0:120}"
                ;;
        esac
    done

    # Re-check after any kills
    if [ -n "$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null)" ]; then
        ports_busy=1
    fi
done

if [ $ports_busy -eq 1 ]; then
    echo ""
    echo "Please free the ports above and try again (or re-run with --force"
    echo "to auto-kill stale claudia processes)."
    exit 1
fi

echo "✅ Ports are free"

# Test hook: CI runs the port-check logic in isolation (see
# scripts/test-start-port-check.sh) without starting any servers.
if [ "${CLAUDIA_PORT_CHECK_ONLY:-0}" = "1" ]; then
    exit 0
fi
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

# Frontend as a background child; kill its whole tree on exit.
# (kill_tree is defined near the top of the script.)
npm run dev -w frontend &
FRONTEND_PID=$!
trap 'kill_tree "$FRONTEND_PID"' EXIT INT TERM

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

