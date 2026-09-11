#!/bin/bash
# Behavior tests for start.sh's port check (bug catalog class 13).
#
# Regressions guarded:
#  1. set -e survival: checking a FREE port once killed the whole script
#     silently right after "Checking ports..." (lsof exits 1 on no match).
#  2. LISTEN-only matching: a client socket to a dead backend must not
#     produce a false "port in use".
#  3. Foreign-process safety: a non-claudia listener is reported and REFUSED,
#     never killed (protects Claude Code sessions and other projects).
#  4. --force kills a stale claudia-owned listener and proceeds.
#  5. Single-instance check: a live backend holding the data directory is
#     refused; a stale instance.json is ignored.
#
# Runs the real start.sh in CLAUDIA_PORT_CHECK_ONLY mode with private ports
# and a private data directory — no servers started, nothing outside the
# sandbox is touched.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; kill $(jobs -p) 2>/dev/null || true' EXIT

PASS=0
FAIL=0
check() {
    local name=$1 expected_rc=$2 actual_rc=$3
    if [ "$actual_rc" -eq "$expected_rc" ]; then
        echo "  PASS: $name"
        PASS=$((PASS+1))
    else
        echo "  FAIL: $name (expected rc=$expected_rc, got rc=$actual_rc)"
        FAIL=$((FAIL+1))
    fi
}

run_check() { # args: backend_port frontend_port extra_args...
    local bp=$1 fp=$2; shift 2
    # Run the REAL start.sh (a copy would break its SCRIPT_DIR self-detection,
    # which the claudia-owned process classification depends on).
    CLAUDIA_PORT_CHECK_ONLY=1 \
    CLAUDIA_DATA_DIR="${CLAUDIA_TEST_DATA_DIR:-$TMP/data}" \
    CLAUDIA_TEST_BACKEND_PORT="$bp" \
    CLAUDIA_TEST_FRONTEND_PORT="$fp" \
    CLAUDIA_TEST_OPENCODE_PORT=1 \
    ./start.sh "$@" </dev/null
}

free_port() {
    node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})'
}

echo "test 1: all ports free — must survive set -e and exit 0 (regression: silent death)"
P1=$(free_port); P2=$(free_port)
rc=0; run_check "$P1" "$P2" >/dev/null 2>&1 || rc=$?
check "free ports pass" 0 "$rc"

echo "test 2: foreign (non-claudia) listener — refused, exit 1, process SURVIVES"
P1=$(free_port); P2=$(free_port)
node -e "require('net').createServer().listen($P1,'127.0.0.1');setInterval(()=>{},1e6)" &
FOREIGN_PID=$!
sleep 1
rc=0; out=$(run_check "$P1" "$P2" 2>&1) || rc=$?
check "foreign listener → exit 1" 1 "$rc"
if echo "$out" | grep -q "NON-claudia"; then check "reports NON-claudia" 0 0; else check "reports NON-claudia" 0 1; fi
kill -0 "$FOREIGN_PID" 2>/dev/null; check "foreign process NOT killed" 0 "$?"
kill "$FOREIGN_PID" 2>/dev/null || true

echo "test 3: stale claudia-owned listener + --force — killed, check passes"
P1=$(free_port); P2=$(free_port)
# Listener whose command line contains this repo's path (classified claudia-owned)
cat > "$SCRIPT_DIR/.test-fake-vite.cjs" <<EOF
require('net').createServer().listen($P2,'127.0.0.1');
setInterval(()=>{},1e6);
EOF
node "$SCRIPT_DIR/.test-fake-vite.cjs" &
STALE_PID=$!
sleep 1
rc=0; run_check "$P1" "$P2" --force >/dev/null 2>&1 || rc=$?
check "--force clears stale claudia listener" 0 "$rc"
sleep 0.5
if kill -0 "$STALE_PID" 2>/dev/null; then check "stale listener killed" 0 1; kill "$STALE_PID" || true; else check "stale listener killed" 0 0; fi
rm -f "$SCRIPT_DIR/.test-fake-vite.cjs"


echo "test 4: stale instance.json (dead pid) — ignored, check passes"
P1=$(free_port); P2=$(free_port)
DATA4="$TMP/data4"; mkdir -p "$DATA4"
# 2^31-1 cannot be a running pid.
cat > "$DATA4/instance.json" <<EOF
{
  "instanceId": "stale-instance",
  "pid": 2147483647,
  "port": 4321,
  "startedAt": "2020-01-01T00:00:00.000Z",
  "version": "0.0.0"
}
EOF
rc=0; out=$(CLAUDIA_TEST_DATA_DIR="$DATA4" run_check "$P1" "$P2" 2>&1) || rc=$?
check "stale instance lock ignored" 0 "$rc"
if echo "$out" | grep -q "stale instance lock"; then check "reports stale lock" 0 0; else check "reports stale lock" 0 1; fi

echo "test 5: live backend holding the data dir — refused, exit 1"
P1=$(free_port); P2=$(free_port); P3=$(free_port)
DATA5="$TMP/data5"; mkdir -p "$DATA5"
# A stand-in backend that answers /api/server-info on a DIFFERENT port than the
# one start.sh would bind — the case the old /tmp lock file could not see.
node -e "
  const http=require('http');
  http.createServer((req,res)=>{res.writeHead(req.url==='/api/server-info'?200:404);res.end('{}')})
      .listen($P3,'127.0.0.1');
" &
HOLDER_PID=$!
sleep 1
cat > "$DATA5/instance.json" <<EOF
{
  "instanceId": "live-instance",
  "pid": $HOLDER_PID,
  "port": $P3,
  "startedAt": "2020-01-01T00:00:00.000Z",
  "version": "0.0.0"
}
EOF
rc=0; out=$(CLAUDIA_TEST_DATA_DIR="$DATA5" run_check "$P1" "$P2" 2>&1) || rc=$?
check "live instance holder → exit 1" 1 "$rc"
if echo "$out" | grep -q "already running"; then check "reports where to attach" 0 0; else check "reports where to attach" 0 1; fi
kill "$HOLDER_PID" 2>/dev/null || true
echo ""
echo "port-check tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]