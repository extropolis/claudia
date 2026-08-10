#!/bin/bash
# Fake Claude Code CLI for end-to-end integration tests.
#
# Contract with the tests (all via env):
#   CLAUDIA_FAKE_DIR  — where to write args.log / input.log / alive marker
#   HOME              — session files land in $HOME/.claude/projects/<encoded cwd>
#   CLAUDIA_FAKE_SID  — session id to create (so tests can assert capture)
#
# Behavior:
#   - logs argv (one arg per line) to args.log — tests assert --resume,
#     --system-prompt, --model at the true process boundary
#   - writes a session JSONL like the real CLI (session capture observable)
#   - prints the TUI ready banner ("? for shortcuts") so ready-detection fires
#   - echoes every stdin chunk to input.log (prompt/input delivery observable)
#   - echoes a MARKER line to stdout when it receives one (output streaming)
#   - exits on SIGTERM (clean stop/archive paths)

FAKE_DIR="${CLAUDIA_FAKE_DIR:?CLAUDIA_FAKE_DIR required}"
printf '%s\n' "$@" > "$FAKE_DIR/args.log"
: > "$FAKE_DIR/input.log"
echo "$$" > "$FAKE_DIR/alive"

# Session file like the real CLI: HOME/.claude/projects/<cwd encoded>/<sid>.jsonl
SID="${CLAUDIA_FAKE_SID:-11111111-2222-3333-4444-555566667777}"
ENC=$(pwd | sed 's/[^a-zA-Z0-9-]/-/g')
SESS_DIR="$HOME/.claude/projects/$ENC"
mkdir -p "$SESS_DIR"
echo "{\"type\":\"user\",\"sessionId\":\"$SID\"}" > "$SESS_DIR/$SID.jsonl"

trap 'rm -f "$FAKE_DIR/alive"; exit 0' TERM INT HUP

sleep 0.2
# Ready banner (matches isReadyForInitialInput patterns)
printf '\n───────────\n❯ ready\n? for shortcuts\n'

# Echo stdin to input.log AND back to stdout (a real TUI echoes typed input —
# the spawner's Enter-retry and idle detection depend on seeing that echo).
# After each full line (Enter), print an idle prompt so state detection can
# settle back to idle.
while IFS= read -r -t 600 line; do
    printf '%s\n' "$line" >> "$FAKE_DIR/input.log"
    printf '%s\n' "$line"
    case "$line" in
        *EMIT_OUTPUT*) printf 'FAKE_OUTPUT_MARKER_9000\n' ;;
    esac
    printf '\n❯ \n? for shortcuts\n'
done
