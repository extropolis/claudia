#!/bin/bash

# Claudia - Install Script
# Usage: curl -fsSL https://raw.githubusercontent.com/extropolis/claudia/main/install.sh | bash
#
# Installs Claudia globally via npm. After install, run `claudia` from anywhere.

set -e

echo ""
echo "🔮 Claudia Installer"
echo "===================="
echo ""

# ============================================
# Check prerequisites
# ============================================
echo "🔍 Checking prerequisites..."

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18+ from https://nodejs.org"
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
echo "   Node.js: $(node -v)"

if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js 18+ is required. Current version: $(node -v)"
    exit 1
fi

# Check npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed. Please install npm 9+"
    exit 1
fi
echo "   npm: $(npm -v)"

# Check Claude Code CLI (optional)
if command -v claude &> /dev/null; then
    echo "   Claude CLI: $(claude --version 2>/dev/null || echo 'installed')"
else
    echo "   ⚠️  Claude Code CLI not found (optional). Install with:"
    echo "      curl -fsSL https://claude.ai/install.sh | bash"
fi

echo ""

# ============================================
# Install Claudia via npm
# ============================================
echo "📦 Installing Claudia..."
npm install -g @extropolis/claudia@latest

echo ""
echo "✅ Claudia installed successfully!"
echo ""
echo "   Usage:"
echo "     claudia             Start the web app"
echo "     claudia electron    Start the Electron desktop app"
echo "     claudia --help      Show all commands"
echo ""
