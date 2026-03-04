# Claudia - Install Script (PowerShell)
# Usage: irm https://raw.githubusercontent.com/extropolis/claudia/main/install.ps1 | iex
#
# Installs Claudia globally via npm. After install, run `claudia` from anywhere.

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "Claudia Installer"
Write-Host "===================="
Write-Host ""

# ============================================
# Check prerequisites
# ============================================
Write-Host "Checking prerequisites..."

# Check Node.js
try {
    $nodeVersion = & node -v 2>$null
    Write-Host "   Node.js: $nodeVersion"
} catch {
    Write-Host "Node.js is not installed. Please install Node.js 18+ from https://nodejs.org"
    exit 1
}

$nodeMajor = [int]($nodeVersion -replace 'v','').Split('.')[0]
if ($nodeMajor -lt 18) {
    Write-Host "Node.js 18+ is required. Current version: $nodeVersion"
    exit 1
}

# Check npm
try {
    $npmVersion = & npm.cmd -v 2>$null
    Write-Host "   npm: $npmVersion"
} catch {
    Write-Host "npm is not installed. Please install npm 9+"
    exit 1
}

# Check Claude Code CLI (optional)
try {
    $claudeVersion = & claude --version 2>$null
    Write-Host "   Claude CLI: $claudeVersion"
} catch {
    Write-Host "   Claude Code CLI not found (optional). Install with:"
    Write-Host "      irm https://claude.ai/install.ps1 | iex"
}

Write-Host ""

# ============================================
# Install Claudia via npm
# ============================================
Write-Host "Installing Claudia..."
& npm.cmd install -g @extropolis/claudia@latest
if ($LASTEXITCODE -ne 0) { throw "Failed to install Claudia" }

Write-Host ""
Write-Host "Claudia installed successfully!"
Write-Host ""
Write-Host "   Usage:"
Write-Host "     claudia             Start the web app"
Write-Host "     claudia electron    Start the Electron desktop app"
Write-Host "     claudia --help      Show all commands"
Write-Host ""
