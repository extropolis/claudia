#!/bin/bash
# Generic fake agent CLI used to drive the CodeBackend contract suite.
#
# It stands in for BOTH `claude` and `opencode` (copy it onto PATH under the
# name the backend under test spawns). A superset of fixtures/fake-claude.sh:
# same ready-banner / stdin-echo contract, plus the knobs the contract suite
# needs (version probe, self-exit with a chosen code, stdout-announced session
# id, a "stay busy" mode so `busy`-only transitions can be observed).
#
# Contract with the tests (all via env):
#   CLAUDIA_FAKE_DIR         — where to write args.log / cwd.log / input.log / alive
#   CLAUDIA_FAKE_VERSION     — string printed for `--version` (then exit 0)
#   CLAUDIA_FAKE_SID         — write a Claude-style session JSONL under
#                              $HOME/.claude/projects/<encoded cwd>/<sid>.jsonl
#   CLAUDIA_FAKE_STDOUT_SID  — announce this session id on stdout (OpenCode style)
#   CLAUDIA_FAKE_EXIT_CODE   — exit with this code instead of serving a TUI
#   CLAUDIA_FAKE_EXIT_DELAY  — seconds to wait before that exit (default 0.3)
#   CLAUDIA_FAKE_BUSY_TICKS  — how many 0.15s "Thinking..." ticks a STAY_BUSY
#                              line produces (default 30 ≈ 4.5s of live output)
#
# Behavior:
#   - logs argv (one arg per line) to args.log, and appends to all-args.log so
#     a second spawn into the same dir is still observable
#   - logs its cwd to cwd.log (proves the workspace was used as cwd)
#   - prints a ready banner that satisfies BOTH backends' ready detection
#   - echoes every stdin line to input.log and back to stdout, followed by a
#     processing indicator (both backends look for /Thinking/i)
#   - exits on SIGTERM/SIGINT/SIGHUP, removing the `alive` marker

if [ "$1" = "--version" ]; then
    echo "${CLAUDIA_FAKE_VERSION:-9.9.9-fake}"
    exit 0
fi

FAKE_DIR="${CLAUDIA_FAKE_DIR:?CLAUDIA_FAKE_DIR required}"
mkdir -p "$FAKE_DIR"

# Install the exit trap BEFORE anything else: a kill that lands in the window
# between "alive" appearing and the trap being installed would strand the
# marker and make teardown assertions flaky.
trap 'rm -f "$FAKE_DIR/alive"; exit 0' TERM INT HUP

echo "$$" > "$FAKE_DIR/alive"
echo "$$" > "$FAKE_DIR/pid"      # never removed — lets tests check liveness by pid
printf '%s\n' "$@" > "$FAKE_DIR/args.log"
printf -- '--- spawn %s\n' "$$" >> "$FAKE_DIR/all-args.log"
printf '%s\n' "$@" >> "$FAKE_DIR/all-args.log"
pwd > "$FAKE_DIR/cwd.log"
printenv > "$FAKE_DIR/env.log"
: > "$FAKE_DIR/input.log"

# Claude-style session file: HOME/.claude/projects/<cwd encoded>/<sid>.jsonl
if [ -n "$CLAUDIA_FAKE_SID" ]; then
    ENC=$(pwd | sed 's/[^a-zA-Z0-9-]/-/g')
    SESS_DIR="$HOME/.claude/projects/$ENC"
    mkdir -p "$SESS_DIR"
    echo "{\"type\":\"user\",\"sessionId\":\"$CLAUDIA_FAKE_SID\"}" > "$SESS_DIR/$CLAUDIA_FAKE_SID.jsonl"
fi

# Crash/exit mode: never serves a TUI, just dies with the requested code.
if [ -n "$CLAUDIA_FAKE_EXIT_CODE" ]; then
    sleep "${CLAUDIA_FAKE_EXIT_DELAY:-0.3}"
    rm -f "$FAKE_DIR/alive"
    exit "$CLAUDIA_FAKE_EXIT_CODE"
fi

sleep 0.2

# Reproduce the Claude Code auth-conflict warning (the backend filters it out).
if [ -n "$CLAUDIA_FAKE_AUTH_WARN" ]; then
    printf 'Auth conflict: Both a token (claude.ai) and an API key (ANTHROPIC_API_KEY) are set\n'
    printf 'This may lead to unexpected behavior\n'
    printf 'AUTH_WARN_SENTINEL_KEEP\n'
fi

# OpenCode announces its session id in the TUI output.
if [ -n "$CLAUDIA_FAKE_STDOUT_SID" ]; then
    printf 'session %s\n' "$CLAUDIA_FAKE_STDOUT_SID"
fi

# Ready banner. Satisfies ClaudeCodeBackend ("? for shortcuts", "───" + "❯")
# and OpenCodeBackend ("❯").
printf '\n───────────\n❯ ready\n? for shortcuts\n'

while IFS= read -r -t 600 line; do
    printf '%s\n' "$line" >> "$FAKE_DIR/input.log"
    printf '%s\n' "$line"
    case "$line" in
        *STAY_BUSY*)
            n=0
            while [ "$n" -lt "${CLAUDIA_FAKE_BUSY_TICKS:-30}" ]; do
                printf 'Thinking...\n'
                sleep 0.15
                n=$((n + 1))
            done
            ;;
        *EMIT_OUTPUT*) printf 'FAKE_OUTPUT_MARKER_9000\n' ;;
    esac
    printf 'Thinking...\n'
    printf '\n❯ \n? for shortcuts\n'
done
