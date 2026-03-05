#!/bin/bash
# =============================================================================
# Claudia DevVM Test Script
# =============================================================================
# Run this ON the devVM after setup to verify everything works:
#   ssh faraday.dev-vm
#   cd ~/claudia
#   bash test-devvm.sh
# =============================================================================

set -euo pipefail

CLAUDIA_PORT=4001
TEST_WORKSPACE="/tmp/test-workspace-$$"

echo "================================================"
echo "  Claudia DevVM Integration Test"
echo "================================================"
echo ""

# ---------------------------------------------------------------------------
# 1) Verify Docker image exists
# ---------------------------------------------------------------------------
echo "📦 [1/6] Checking Docker image..."

if ! sudo docker images | grep -q "^claudia "; then
    echo "   ❌ Claudia Docker image not found. Run devvm-setup.sh first!"
    exit 1
fi

echo "   ✅ Docker image 'claudia' found"

# ---------------------------------------------------------------------------
# 2) Verify API key is set
# ---------------------------------------------------------------------------
echo ""
echo "🔑 [2/6] Checking API key..."

if [ -f .env ]; then
    source .env
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    echo "   ❌ ANTHROPIC_API_KEY not set. Set it in .env or export it"
    exit 1
fi

echo "   ✅ API key configured (...${ANTHROPIC_API_KEY: -8})"

# ---------------------------------------------------------------------------
# 3) Start container (if not already running)
# ---------------------------------------------------------------------------
echo ""
echo "🚀 [3/6] Starting Claudia container..."

# Stop existing test container
sudo docker stop claudia-test 2>/dev/null || true
sudo docker rm claudia-test 2>/dev/null || true

# Create test workspace
mkdir -p "$TEST_WORKSPACE"

# Start container
sudo docker run -d \
    --name claudia-test \
    -p $CLAUDIA_PORT:4001 \
    -e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" \
    -e "CLAUDIA_WORKSPACES_DIR=/home/coder/workspaces" \
    -v "$TEST_WORKSPACE:/home/coder/workspaces" \
    claudia >/dev/null

echo "   ✅ Container started (claudia-test)"
echo "   Waiting for startup..."
sleep 5

# ---------------------------------------------------------------------------
# 4) Test health endpoint
# ---------------------------------------------------------------------------
echo ""
echo "🏥 [4/6] Testing health endpoint..."

HEALTH_RESPONSE=$(curl -s http://localhost:$CLAUDIA_PORT/api/health || echo "FAILED")

if [[ "$HEALTH_RESPONSE" == *'"status":"ok"'* ]]; then
    echo "   ✅ Health check passed: $HEALTH_RESPONSE"
else
    echo "   ❌ Health check failed: $HEALTH_RESPONSE"
    echo ""
    echo "Container logs:"
    sudo docker logs claudia-test 2>&1 | tail -20
    exit 1
fi

# ---------------------------------------------------------------------------
# 5) Test workspaces endpoint
# ---------------------------------------------------------------------------
echo ""
echo "📂 [5/6] Testing workspaces endpoint..."

WORKSPACES_RESPONSE=$(curl -s http://localhost:$CLAUDIA_PORT/api/workspaces || echo "FAILED")

if [[ "$WORKSPACES_RESPONSE" == "["* ]]; then
    echo "   ✅ Workspaces API working: $WORKSPACES_RESPONSE"
else
    echo "   ❌ Workspaces API failed: $WORKSPACES_RESPONSE"
    exit 1
fi

# ---------------------------------------------------------------------------
# 6) Test volume persistence
# ---------------------------------------------------------------------------
echo ""
echo "💾 [6/6] Testing workspace persistence..."

# Create test file through container
sudo docker exec claudia-test bash -c "echo 'test-data' > /home/coder/workspaces/test.txt"

# Verify from host
if [ -f "$TEST_WORKSPACE/test.txt" ]; then
    CONTENT=$(cat "$TEST_WORKSPACE/test.txt")
    if [[ "$CONTENT" == "test-data" ]]; then
        echo "   ✅ Volume mounting works correctly"
    else
        echo "   ❌ Volume content mismatch: $CONTENT"
        exit 1
    fi
else
    echo "   ❌ Volume file not found on host"
    exit 1
fi

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------
echo ""
echo "🧹 Cleaning up test resources..."

sudo docker stop claudia-test >/dev/null
sudo docker rm claudia-test >/dev/null
rm -rf "$TEST_WORKSPACE"

echo "   ✅ Cleanup complete"

# ---------------------------------------------------------------------------
# Success!
# ---------------------------------------------------------------------------
echo ""
echo "================================================"
echo "  ✅ All Tests Passed!"
echo "================================================"
echo ""
echo "  Claudia is ready to use on this devVM."
echo ""
echo "  To start the production container:"
echo "    cd ~/claudia && ./devvm-run.sh"
echo ""
echo "  From your laptop, forward the port:"
echo "    ssh -L $CLAUDIA_PORT:localhost:$CLAUDIA_PORT faraday.dev-vm"
echo ""
echo "  Then open: http://localhost:$CLAUDIA_PORT"
echo ""
echo "  Container logs: sudo docker logs -f claudia"
echo "  Stop: sudo docker stop claudia"
echo "================================================"
