#!/bin/bash

# Claudia Electron - Start Script
# Builds and launches the Electron desktop app in development mode

set -e

echo "🔮 Starting Claudia Electron App..."
echo ""

# Start from project root
cd "$(dirname "$0")"

# Load environment variables
if [ -f .env ]; then
    set -a; source .env; set +a
fi

# Increase Node.js memory limit
export NODE_OPTIONS="--max-old-space-size=8192"

# ============================================
# Step 1: Build shared types
# ============================================
echo "📦 Building shared types..."
npm run build -w shared

# ============================================
# Step 2: Build backend
# ============================================
echo "📦 Building backend..."
npm run build:backend

# ============================================
# Step 3: Build Electron (main + preload)
# ============================================
echo "📦 Building Electron..."
npm run build:electron

# ============================================
# Step 4: Start frontend dev server in background
# ============================================
echo "🌐 Starting frontend dev server..."
npm run dev:frontend &
FRONTEND_PID=$!

# Clean up frontend dev server on exit
cleanup() {
    echo ""
    echo "🛑 Shutting down..."
    if [ -n "$FRONTEND_PID" ] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
        kill "$FRONTEND_PID" 2>/dev/null || true
    fi
    # Kill any child processes
    pkill -P $$ 2>/dev/null || true
    exit 0
}
trap cleanup EXIT INT TERM

# Wait for frontend dev server to be ready
echo "⏳ Waiting for frontend dev server (http://localhost:5173)..."
for i in $(seq 1 30); do
    if curl -s http://localhost:5173 > /dev/null 2>&1; then
        echo "✅ Frontend dev server is ready"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "❌ Frontend dev server did not start within 30 seconds"
        exit 1
    fi
    sleep 1
done

# ============================================
# Step 5: Launch Electron
# ============================================
echo ""
echo "🚀 Launching Claudia Electron..."
echo ""
NODE_ENV=development npx electron .
