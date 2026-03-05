#!/bin/bash
# =============================================================================
# Claudia DevVM Setup - Single script to install everything
# =============================================================================
# Run on your devVM:
#   ssh faraday.dev-vm
#   bash devvm-setup.sh
#
# Installs: Node.js, Homebrew, gh, hai CLI, Claude Code, Claudia
# =============================================================================
set -euo pipefail

CLAUDIA_DIR="$HOME/claudia"
CLAUDIA_PORT=4001
REPO_URL="${CLAUDIA_REPO_URL:-https://github.com/extropolis/claudia.git}"
BRANCH="${CLAUDIA_BRANCH:-main}"

echo "================================================"
echo "  Claudia DevVM Setup"
echo "================================================"
echo ""

# ---------------------------------------------------------------------------
# 1) System dependencies
# ---------------------------------------------------------------------------
echo "[1/7] Installing system dependencies..."

if command -v dnf &>/dev/null; then
    # Install each package individually to avoid conflicts blocking everything
    for pkg in git gcc gcc-c++ make python3 procps-ng tar gzip; do
        sudo dnf install -y "$pkg" 2>/dev/null || true
    done
elif command -v apt-get &>/dev/null; then
    sudo apt-get update -qq
    sudo apt-get install -y git build-essential python3 procps curl 2>&1 | tail -1
else
    echo "Unsupported package manager. Need git, gcc, make, python3."
    exit 1
fi
echo "  Done"
echo ""

# ---------------------------------------------------------------------------
# 2) Node.js via nvm
# ---------------------------------------------------------------------------
echo "[2/7] Setting up Node.js..."

export NVM_DIR="$HOME/.nvm"
if [ ! -d "$NVM_DIR" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

if ! command -v node &>/dev/null || [[ "$(node --version)" != v20* && "$(node --version)" != v22* ]]; then
    nvm install 20
    nvm use 20
    nvm alias default 20
fi
echo "  Node: $(node --version), npm: $(npm --version)"
echo ""

# ---------------------------------------------------------------------------
# 3) gh CLI (used by hai for authentication)
# ---------------------------------------------------------------------------
echo "[3/7] Installing GitHub CLI..."

if ! command -v gh &>/dev/null; then
    echo "  Installing gh..."
    sudo dnf install -y 'dnf-command(config-manager)' 2>/dev/null || true
    sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo 2>/dev/null || true
    sudo dnf install -y gh 2>/dev/null || {
        # Fallback: direct binary
        GH_VERSION="2.67.0"
        curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" -o /tmp/gh.tar.gz
        tar -xzf /tmp/gh.tar.gz -C /tmp
        sudo cp /tmp/gh_${GH_VERSION}_linux_amd64/bin/gh /usr/local/bin/
        rm -rf /tmp/gh.tar.gz /tmp/gh_${GH_VERSION}_linux_amd64
    }
fi
echo "  gh: $(gh --version 2>&1 | head -1)"
echo ""

# ---------------------------------------------------------------------------
# 4) hai CLI
# ---------------------------------------------------------------------------
echo "[4/7] Installing hai CLI..."

HAI_VERSION="v1.1.3"
HAI_RELEASE_URL="https://github.concur.com/api/v3/repos/ai-experiments/claudia/releases/tags/tools-v1"
HAI_BINARY_URL="https://github.concur.com/ai-experiments/claudia/releases/download/tools-v1/hai-linux.amd64.tar.gz"

if ! command -v hai &>/dev/null; then
    # Try downloading from our GitHub Enterprise release
    # Needs a GH token since it's a private repo
    GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"

    if [ -z "$GH_TOKEN" ] && command -v gh &>/dev/null; then
        GH_TOKEN=$(gh auth token --hostname github.concur.com 2>/dev/null || echo "")
    fi

    if [ -n "$GH_TOKEN" ]; then
        echo "  Downloading hai $HAI_VERSION from github.concur.com..."
        # Download via GitHub API (handles auth for release assets)
        ASSET_ID=$(curl -fsSL -H "Authorization: token $GH_TOKEN" "$HAI_RELEASE_URL" 2>/dev/null \
            | python3 -c "import json,sys; a=json.load(sys.stdin).get('assets',[]); print([x['id'] for x in a if 'hai-linux.amd64' in x['name']][0])" 2>/dev/null || echo "")

        if [ -n "$ASSET_ID" ]; then
            curl -fsSL -H "Authorization: token $GH_TOKEN" -H "Accept: application/octet-stream" \
                "https://github.concur.com/api/v3/repos/ai-experiments/claudia/releases/assets/$ASSET_ID" \
                -o /tmp/hai-linux.amd64.tar.gz
        fi
    fi

    # Fallback: check if tarball was pre-staged
    if [ ! -f /tmp/hai-linux.amd64.tar.gz ]; then
        for loc in "$CLAUDIA_DIR/hai-linux.amd64.tar.gz" "$HOME/hai-linux.amd64.tar.gz"; do
            [ -f "$loc" ] && cp "$loc" /tmp/hai-linux.amd64.tar.gz && break
        done
    fi

    if [ -f /tmp/hai-linux.amd64.tar.gz ]; then
        cd /tmp && tar -xzf hai-linux.amd64.tar.gz && sudo mv hai /usr/local/bin/hai && sudo chmod +x /usr/local/bin/hai
        rm -f /tmp/hai-linux.amd64.tar.gz
    else
        echo ""
        echo "  Could not download hai CLI. Run with a GitHub token:"
        echo "    GH_TOKEN=ghp_xxx bash devvm-setup.sh"
        echo ""
        echo "  Or copy the binary manually from your laptop:"
        echo "    scp /tmp/hai-linux.amd64.tar.gz faraday.dev-vm:/tmp/"
        echo "    Then re-run this script."
        exit 1
    fi
fi
echo "  hai: $(hai version 2>&1 | head -1)"
echo ""

# ---------------------------------------------------------------------------
# 5) Claude Code CLI
# ---------------------------------------------------------------------------
echo "[5/7] Installing Claude Code CLI..."

if ! command -v claude &>/dev/null; then
    curl -fsSL https://claude.ai/install.sh | bash
    export PATH="$HOME/.claude/bin:$PATH"
    if ! grep -q '.claude/bin' "$HOME/.bashrc" 2>/dev/null; then
        echo 'export PATH="$HOME/.claude/bin:$PATH"' >> "$HOME/.bashrc"
    fi
fi
echo "  claude: $(claude --version 2>&1 | head -1)"
echo ""

# ---------------------------------------------------------------------------
# 6) Clone / update Claudia + install deps
# ---------------------------------------------------------------------------
echo "[6/7] Setting up Claudia..."

if [ -d "$CLAUDIA_DIR/.git" ]; then
    echo "  Updating existing repo..."
    cd "$CLAUDIA_DIR"
    git fetch origin
    git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH"
    git pull origin "$BRANCH" || echo "  Warning: pull failed, using existing code"
else
    echo "  Cloning..."
    git clone -b "$BRANCH" "$REPO_URL" "$CLAUDIA_DIR"
    cd "$CLAUDIA_DIR"
fi

echo "  Installing npm dependencies..."
npm ci
echo "  Done"
echo ""

# ---------------------------------------------------------------------------
# 7) Configure hai + Claude Code
# ---------------------------------------------------------------------------
echo "[7/7] Configuring hai and Claude Code..."

mkdir -p "$HOME/.config/hai"

# Skip onboarding for Claude Code
if [ ! -f "$HOME/.claude.json" ]; then
    echo '{"hasCompletedOnboarding": true}' > "$HOME/.claude.json"
fi

# Try auto-configure (may fail if not authenticated yet — that's OK)
hai configure claude-code 2>&1 || {
    echo "  hai configure needs authentication first (see next steps below)"
}
echo ""

# ---------------------------------------------------------------------------
# Create run script
# ---------------------------------------------------------------------------
cat > "$CLAUDIA_DIR/devvm-run.sh" << 'RUNEOF'
#!/bin/bash
# =============================================================================
# Run Claudia on devVM (native — no Docker)
# =============================================================================
set -euo pipefail

CLAUDIA_PORT=4001
FRONTEND_PORT=5173

# Source nvm + brew
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv 2>/dev/null || echo '')"
export PATH="$HOME/.claude/bin:$PATH"

cd "$(dirname "$0")"

# ---- Start hai proxy if not running ----
if ! curl -s http://localhost:6655/health &>/dev/null 2>&1; then
    echo "Starting hai proxy..."
    nohup hai proxy start > /tmp/hai-proxy.log 2>&1 &
    for i in $(seq 1 15); do
        if curl -s http://localhost:6655/health &>/dev/null 2>&1; then
            echo "  hai proxy ready (port 6655)"
            break
        fi
        sleep 1
        [ $i -eq 15 ] && echo "  Warning: hai proxy may not be ready. Check /tmp/hai-proxy.log"
    done
else
    echo "hai proxy already running on port 6655"
fi

# ---- Kill existing Claudia processes on our ports ----
echo "Cleaning up existing processes..."
for port in $CLAUDIA_PORT $FRONTEND_PORT; do
    pids=$(lsof -ti:$port 2>/dev/null || true)
    if [ -n "$pids" ]; then
        echo "  Killing processes on port $port"
        echo "$pids" | xargs kill -9 2>/dev/null || true
    fi
done
sleep 1

# ---- Environment ----
export CLAUDIA_BACKEND_PORT=$CLAUDIA_PORT
export NODE_OPTIONS="--max-old-space-size=4096"

# Load .env if present (AICORE_SERVICE_KEY, ANTHROPIC_API_KEY, etc.)
[ -f .env ] && source .env

echo ""
echo "================================================"
echo "  Claudia starting..."
echo "  Backend:  http://localhost:$CLAUDIA_PORT"
echo "  Frontend: http://localhost:$FRONTEND_PORT"
echo "================================================"
echo ""
echo "  From your laptop:"
echo "    ssh -L $CLAUDIA_PORT:localhost:$CLAUDIA_PORT faraday.dev-vm"
echo "    Open http://localhost:$CLAUDIA_PORT"
echo ""
echo "  Stop: Ctrl+C"
echo ""

# ---- Start frontend in background ----
npm run dev -w frontend &
FRONTEND_PID=$!

# ---- Backend with restart loop ----
while true; do
    set +e
    npm run dev -w backend
    EXIT_CODE=$?
    set -e

    if [ $EXIT_CODE -eq 0 ]; then
        echo "Backend exited cleanly, stopping."
        kill $FRONTEND_PID 2>/dev/null || true
        break
    fi

    echo "Backend exited (code $EXIT_CODE), restarting in 2s..."
    sleep 2
done
RUNEOF
chmod +x "$CLAUDIA_DIR/devvm-run.sh"

# Create .env template if not present
if [ ! -f "$CLAUDIA_DIR/.env" ]; then
    cat > "$CLAUDIA_DIR/.env" << 'ENVEOF'
# Claudia devVM environment
# These are optional — hai proxy handles authentication by default.
# Only set these if you want to use SAP AI Core or direct Anthropic API instead.

# Option A: Anthropic Direct API
# export ANTHROPIC_API_KEY=sk-ant-...

# Option B: SAP AI Core
# export AICORE_SERVICE_KEY='{...}'
# export AICORE_RESOURCE_GROUP=default
ENVEOF
fi

# ---------------------------------------------------------------------------
# Done!
# ---------------------------------------------------------------------------
echo ""
echo "================================================"
echo "  Setup Complete!"
echo "================================================"
echo ""
echo "  Next steps:"
echo ""
echo "  1. Authenticate hai (one-time, opens browser):"
echo "       hai auth login"
echo ""
echo "  2. Configure Claude Code for hai:"
echo "       hai configure claude-code"
echo ""
echo "  3. Start Claudia:"
echo "       cd ~/claudia && ./devvm-run.sh"
echo ""
echo "  4. From your laptop:"
echo "       ssh -L 4001:localhost:4001 faraday.dev-vm"
echo "       Open http://localhost:4001"
echo ""
echo "  hai proxy starts automatically with Claudia."
echo "  In Claudia settings, select 'Hyperspace Proxy' as API mode."
echo "================================================"
