#!/usr/bin/env bash
# Demo: complexity-based model selection for spawned tasks.
#
# Spawns three short-lived tasks (one per complexity tier) and inspects
# the resulting `claude` process argv to confirm each one was launched
# with the configured model. Restores the prior tiering state on exit.
#
# Requires: the Claudia backend running on http://localhost:4001.

set -euo pipefail

API=http://localhost:4001
WORKSPACE=/tmp/claudia-tier-demo
BACKEND_DIR="$(cd "$(dirname "$0")/.." && pwd)/backend"

cleanup() {
    echo
    echo "[cleanup] restoring prior tiering state and removing demo workspace…"
    if [[ -n "${PRIOR_CFG:-}" ]]; then
        curl -s -X PUT "$API/api/config" -H 'Content-Type: application/json' -d "{\"modelTiering\":$PRIOR_CFG}" > /dev/null
    fi
    if [[ -n "${SPAWNED_PIDS:-}" ]]; then
        for pid in $SPAWNED_PIDS; do
            kill -9 "$pid" 2>/dev/null || true
        done
    fi
    rm -rf "$WORKSPACE"
}
trap cleanup EXIT

echo "[1/4] saving current modelTiering config…"
PRIOR_CFG=$(curl -fsS "$API/api/config" | python3 -c 'import json,sys;print(json.dumps(json.load(sys.stdin).get("modelTiering",{"enabled":False,"tiers":{"low":"haiku","medium":"sonnet","high":"opus"}})))')
echo "  prior: $PRIOR_CFG"

echo "[2/4] enabling tiering with defaults (haiku / sonnet / opus)…"
curl -fsS -X PUT "$API/api/config" -H 'Content-Type: application/json' \
  -d '{"modelTiering":{"enabled":true,"tiers":{"low":"haiku","medium":"sonnet","high":"opus"}}}' > /dev/null

mkdir -p "$WORKSPACE"
( cd "$WORKSPACE" && [ -d .git ] || git init -q )

SPAWNED_PIDS=""
MODEL_LOW=""
MODEL_MEDIUM=""
MODEL_HIGH=""

spawn_and_inspect() {
    tier=$1
    # 4s timeout — we just need the spawn to start; we kill it on cleanup.
    ( cd "$BACKEND_DIR" && npx tsx test-cli.ts --task -m "echo $tier-tier-demo" -n "demo-$tier" -w "$WORKSPACE" --complexity "$tier" -t 4000 ) > /dev/null 2>&1 || true

    # Find the most recent claude process spawned by this run.
    pid=$(ps -o pid,args -ax | grep "claude --" | grep -v grep | grep -E -- "--model [^ ]+" | grep -v reconnect | tail -1 | awk '{print $1}')
    model=$(ps -o args= -p "$pid" 2>/dev/null | grep -oE -- '--model [^ ]+' | awk '{print $2}' || echo '?')
    SPAWNED_PIDS="$SPAWNED_PIDS $pid"
    case $tier in
        low)    MODEL_LOW="$model" ;;
        medium) MODEL_MEDIUM="$model" ;;
        high)   MODEL_HIGH="$model" ;;
    esac
    printf "  complexity=%-7s → spawned PID %s with --model %s\n" "$tier" "$pid" "$model"
}

echo "[3/4] spawning one task per tier and inspecting argv…"
spawn_and_inspect low
spawn_and_inspect medium
spawn_and_inspect high

echo
echo "[4/4] result"
echo "  tier   | configured | observed"
echo "  -------+------------+----------"
printf "  low    | haiku      | %s\n" "${MODEL_LOW:-?}"
printf "  medium | sonnet     | %s\n" "${MODEL_MEDIUM:-?}"
printf "  high   | opus       | %s\n" "${MODEL_HIGH:-?}"
echo
if [ "$MODEL_LOW" = "haiku" ] && [ "$MODEL_MEDIUM" = "sonnet" ] && [ "$MODEL_HIGH" = "opus" ]; then
    echo "✅ all three tiers mapped through to --model correctly."
else
    echo "❌ at least one tier did not match the configured model. Review the output above."
fi
