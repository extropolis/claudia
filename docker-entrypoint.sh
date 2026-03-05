#!/bin/bash
set -e

echo "================================================"
echo "  Claudia - Starting up"
echo "================================================"

# Validate: need either ANTHROPIC_API_KEY or AICORE_SERVICE_KEY
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${AICORE_SERVICE_KEY:-}" ]; then
    echo ""
    echo "ERROR: Either ANTHROPIC_API_KEY or AICORE_SERVICE_KEY is required."
    echo "  docker run -e ANTHROPIC_API_KEY=sk-ant-... claudia"
    echo "  docker run -e AICORE_SERVICE_KEY='{...}' -e AICORE_RESOURCE_GROUP=default claudia"
    echo ""
    exit 1
fi

# Initialize workspace config if it doesn't exist
WORKSPACE_CONFIG="/app/backend/workspace-config.json"
if [ ! -f "$WORKSPACE_CONFIG" ]; then
    echo '{"workspaces":[],"activeWorkspaceId":null,"recentWorkspaces":[]}' > "$WORKSPACE_CONFIG"
fi

# Initialize config.json if it doesn't exist (for persistent settings)
CONFIG_FILE="/app/backend/config.json"
if [ ! -f "$CONFIG_FILE" ]; then
    echo '{}' > "$CONFIG_FILE"
fi

# Auto-configure SAP AI Core from AICORE_SERVICE_KEY if present and config is empty
if [ -n "${AICORE_SERVICE_KEY:-}" ] && command -v python3 &>/dev/null; then
    CURRENT_API_MODE=$(python3 -c "import json; f=open('$CONFIG_FILE'); c=json.load(f); print(c.get('apiMode',''))" 2>/dev/null || echo "")
    if [ -z "$CURRENT_API_MODE" ] || [ "$CURRENT_API_MODE" = "default" ]; then
        # Parse AICORE_SERVICE_KEY and auto-configure
        python3 -c "
import json, sys
try:
    sk = json.loads('''${AICORE_SERVICE_KEY}''')
    with open('$CONFIG_FILE', 'r') as f:
        config = json.load(f)
    config['apiMode'] = 'sap-ai-core'
    config['aiCoreCredentials'] = {
        'clientId': sk.get('clientid', ''),
        'clientSecret': sk.get('clientsecret', ''),
        'authUrl': sk.get('url', ''),
        'baseUrl': sk.get('serviceurls', {}).get('AI_API_URL', ''),
        'resourceGroup': '${AICORE_RESOURCE_GROUP:-default}',
        'timeoutMs': 120000
    }
    with open('$CONFIG_FILE', 'w') as f:
        json.dump(config, f, indent=2)
    print('  Auto-configured SAP AI Core proxy from AICORE_SERVICE_KEY')
except Exception as e:
    print(f'  Warning: Could not auto-configure SAP AI Core: {e}', file=sys.stderr)
" 2>&1
    fi
fi

# Set default workspaces path
export CLAUDIA_WORKSPACES_DIR="${CLAUDIA_WORKSPACES_DIR:-/home/coder/workspaces}"

# Ensure workspaces directory exists
mkdir -p "$CLAUDIA_WORKSPACES_DIR"

# Configure git if SSH agent is forwarded
if [ -n "${SSH_AUTH_SOCK:-}" ]; then
    echo "  SSH Agent: forwarded (git push/pull will use your identity)"
    # Trust workspaces directory for git
    git config --global --add safe.directory '*'
fi

# Ensure Claude Code config directory exists
mkdir -p "$HOME/.claude"

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    echo "  API Mode: Anthropic Direct"
    echo "  API Key: ...${ANTHROPIC_API_KEY: -8}"
elif [ -n "${AICORE_SERVICE_KEY:-}" ]; then
    echo "  API Mode: SAP AI Core"
    echo "  Resource Group: ${AICORE_RESOURCE_GROUP:-default}"
fi
echo "  Workspaces: $CLAUDIA_WORKSPACES_DIR"
echo "  Port: ${CLAUDIA_BACKEND_PORT:-4001}"
echo ""

# Start the backend (serves API + static frontend)
cd /app
exec tsx backend/src/index.ts
