#!/bin/bash
# Fake GitHub CLI for integration tests.
#
# server.ts shells out to `gh` for CI status, issues, notifications and PR
# description edits. Those routes are otherwise untestable without hitting the
# real GitHub API, so this stands in on PATH and answers with canned JSON —
# the same trick fixtures/fake-claude.sh plays for the Claude CLI.
#
# Contract with the tests (all via env):
#   CLAUDIA_FAKE_GH_DIR   — argv of every invocation is appended to gh-args.log here
#   CLAUDIA_FAKE_GH_FAIL  — when "1", every subcommand exits non-zero (drives the
#                           "gh not installed / not authenticated" fallback branches)
#
# Only the shapes server.ts actually parses are emitted.

if [ -n "$CLAUDIA_FAKE_GH_DIR" ]; then
    printf '%s\n' "$*" >> "$CLAUDIA_FAKE_GH_DIR/gh-args.log"
fi

if [ "$CLAUDIA_FAKE_GH_FAIL" = "1" ]; then
    echo "fake gh: forced failure" >&2
    exit 1
fi

case "$1" in
    --version)
        echo "gh version 2.0.0 (fake)"
        exit 0
        ;;
    pr)
        case "$2" in
            view)
                # `gh pr view --json comments --jq '.comments'` vs the metadata form
                if [[ "$*" == *"comments"* ]]; then
                    cat <<'JSON'
[{"author":{"login":"octocat"},"body":"looks good to me","createdAt":"2024-01-02T03:04:05Z","url":"https://github.com/acme/widgets/pull/42#issuecomment-1"}]
JSON
                else
                    cat <<'JSON'
{"number":42,"url":"https://github.com/acme/widgets/pull/42","state":"OPEN","title":"Add widgets","body":"PR body text"}
JSON
                fi
                exit 0
                ;;
            checks)
                cat <<'JSON'
[{"name":"build","state":"SUCCESS","link":"https://github.com/acme/widgets/runs/1"},
 {"name":"lint","state":"FAILURE","link":"https://github.com/acme/widgets/runs/2"},
 {"name":"e2e","state":"PENDING","link":"https://github.com/acme/widgets/runs/3"}]
JSON
                exit 0
                ;;
            edit)
                # `gh pr edit --body-file <tmp>` — record the body so the test can
                # assert the description actually reached the CLI boundary.
                for arg in "$@"; do
                    if [ -f "$arg" ] && [ -n "$CLAUDIA_FAKE_GH_DIR" ]; then
                        cp "$arg" "$CLAUDIA_FAKE_GH_DIR/pr-body.txt"
                    fi
                done
                echo "https://github.com/acme/widgets/pull/42"
                exit 0
                ;;
        esac
        ;;
    issue)
        case "$2" in
            list)
                cat <<'JSON'
[{"number":7,"title":"Widget falls over","state":"OPEN","body":"repro steps","url":"https://github.com/acme/widgets/issues/7","createdAt":"2024-01-01T00:00:00Z","updatedAt":"2024-01-01T00:00:00Z","author":{"login":"octocat"},"labels":[{"name":"bug","color":"d73a4a"}],"assignees":[],"comments":[]}]
JSON
                exit 0
                ;;
            create)
                echo "https://github.com/acme/widgets/issues/8"
                exit 0
                ;;
            edit|close|reopen)
                exit 0
                ;;
        esac
        ;;
    api)
        # `gh api notifications ...` and PATCH of a notification thread
        if [[ "$*" == *"notifications"* ]]; then
            cat <<'JSON'
[{"id":"1","unread":true,"reason":"review_requested","updated_at":"2024-01-01T00:00:00Z","subject":{"title":"Add widgets","type":"PullRequest","url":"https://api.github.com/repos/acme/widgets/pulls/42"},"repository":{"full_name":"acme/widgets"}}]
JSON
            exit 0
        fi
        exit 0
        ;;
esac

echo "fake gh: unhandled args: $*" >&2
exit 1
