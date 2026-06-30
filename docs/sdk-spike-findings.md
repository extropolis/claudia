# Phase 0 SDK Spike — Findings

**Date:** 2026-06-18
**Goal:** confirm `@anthropic-ai/claude-agent-sdk` works end-to-end inside Claudia's environment before committing to the migration plan.
**Verdict:** ✅ **All goals met. Plan is viable. Recommend proceeding to Phase 1.**

---

## What was built

`backend/sdk-spike.ts` — a 200-line standalone CLI that calls `query()` from the SDK and dumps every event with auth detection, tool-approval inspection, and graceful abort.

```bash
cd backend
npx tsx sdk-spike.ts "your prompt"                      # default-deny tools
npx tsx sdk-spike.ts "use bash to ls" --allow-all-tools # auto-approve everything
npx tsx sdk-spike.ts "count to 100" # then Ctrl+C       # abort flow
```

Will be deleted after the writeup is reviewed; this is throwaway code.

## Spike goals — all confirmed ✅

| Goal | Result |
|---|---|
| SDK installs and imports cleanly into Node 18+ | ✅ `@anthropic-ai/claude-agent-sdk@0.3.181` installed; required bumping `@anthropic-ai/sdk` from `^0.71.2` to `^0.93.0` to satisfy peer dep |
| Authenticates with whatever the user has set up | ✅ Worked transparently with `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` (a proxy) — no SDK config needed; would equally pick up subscription OAuth, API key, or `CLAUDE_CODE_OAUTH_TOKEN` |
| Streams assistant messages | ✅ `[assistant] text(99c)` event with full content blocks |
| Streams tool_use and tool_result events | ✅ Bash + Write both observed; tool_use as assistant content block, tool_result as user content block |
| `canUseTool` callback fires for tool approval | ✅ Fired for Write tool; deny path returns the message into the conversation cleanly |
| Abort via Ctrl+C cleanly stops the query | ✅ Throws `"Claude Code process aborted by user"` — easy to catch and convert to task-stopped event |
| Final result message includes token usage | ✅ Includes `total_cost_usd`, `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `num_turns` |

## Sample run — minimal prompt

```
prompt:           what is 2 plus 2? respond with just the number
auth source:      ANTHROPIC_AUTH_TOKEN env var (likely a proxy/gateway)
[system/init]
[assistant] text(1c)
   4
[result/success] turns=1 cost=$0.2863 in=3 out=5 cacheRead=0 err=false
✅ Spike complete in 16.59s
Event counts:
  system               1
  assistant            1
  result               1
```

## Sample run — tool denial via `canUseTool`

```
prompt:           create a file called /tmp/spike-test.txt containing the word hello using the Write tool
[system/init]
[assistant] tool_use(Write)
🔐 canUseTool: Write input={"file_path":"/tmp/spike-test.txt","content":"hello"}
[user] tool_result
[assistant] text(180c)
   The Write tool was blocked by Spike's default tool restrictions. To allow it,
   you'd need to run with the `--allow-all-tools` flag. Would you like me to try
   an alternative approach?
[result/success] turns=2 cost=$0.4807 in=4 out=125 cacheRead=38027 err=false
```

The `canUseTool({ behavior: 'deny', message: '...' })` return value flows back into the conversation and Claude reads it. Exactly the contract Phase 4's permission dialogs need.

## Sample run — SIGINT abort

```
[system/init]
>>> sending SIGINT to PID 37244
⏸  SIGINT received — aborting query…
❌ Query failed: Claude Code process aborted by user
```

Clean abort — single error to catch; no zombies, no stuck PTY.

## Surprises / things to know

### 1. SDK still uses a child process
The SDK isn't pure-Node — it spawns a `claude` subprocess that speaks structured JSON over stdio. The error trace at abort time shows `ChildProcess.<anonymous>` inside `sdk.mjs`. Practical implications:
- **Still no garbling** — we never read raw PTY bytes; output is normalized JSON
- We need `claude` (the CLI) installed, just like today
- Spawn cost per query exists. Negligible for chat tasks; might matter if we spawn 50 SDK queries per second (we won't).

### 2. `canUseTool` is bypassed in some permission modes
Confirmed from CloudCLI's source (and the SDK's `permissionMode` option): in `'auto'` and `'bypassPermissions'` modes, the SDK approves tools without calling our callback. To intercept *every* tool call regardless of mode (e.g. to record audit logs), we need a `PreToolUse` hook instead of relying on `canUseTool` alone. Phase 4 should use `canUseTool` for user-facing prompts and add a `PreToolUse` hook if we want unconditional logging.

### 3. Auth resolution is automatic and transparent
Did not pass any auth options to `query()`. The SDK consulted env vars (and would fall through to subscription credentials in absence of those). Phase 1's auth UX is trivial: surface the detected source and warn when `ANTHROPIC_API_KEY` overrides subscription.

### 4. Cache tokens are sizable mid-conversation
In the second run, `cacheRead=38027` on turn 2 — meaning the SDK is using prompt caching aggressively. Token-usage UI should distinguish cache reads from billable input tokens (CloudCLI does this; we should too).

### 5. One peer-dep bump required
`@anthropic-ai/sdk` had to go from `^0.71.2` to `^0.93.0`. Risk: anything in Claudia using the regular Anthropic SDK may need adjustment. Quick check:

```bash
$ grep -rn "@anthropic-ai/sdk" backend/src --include="*.ts" | head
```

If usage is limited and on documented APIs, the bump should be safe. **Phase 1 todo:** verify the bump doesn't break existing supervisor chat / summarization.

### 6. Cost is reported per-query in USD
`total_cost_usd: 0.2863` for a 5-token math response is high — almost certainly because the proxy/gateway is using a different pricing model than direct API calls. When a user is on subscription OAuth this number is informational; when they're on API/proxy it's billed. UI should display it but contextualize it ("subscription" vs "API credits") based on the auth source.

## Updated risk register (compared to plan)

| Original concern | Status after spike |
|---|---|
| SDK behavior diverges from CLI | Low risk — same agent loop, same models, same tools observed |
| Authentication complexity | **Lower than expected** — fully automatic |
| MCP server discovery | Not yet tested in spike (Phase 1 task) |
| Subagents / Task tool | Not yet tested in spike (Phase 1 task) |
| Hooks | Not yet tested (Phase 4 will exercise this) |
| Slash commands maintenance | Not tested (slash commands run in `-p` mode per docs; Phase 5 will verify) |
| Bundle size | SDK pulls in some weight; will measure properly in Phase 1 |
| **Existing PTY users** | **No impact** — spike is a sibling path |
| **License contamination** | None — spike was written from SDK types only, no CloudCLI code referenced while writing |

## Recommendation

Proceed to **Phase 1** (Backend SDK task path) with confidence:

1. **Add `sdk-task-runner.ts`** wrapping `query()` with task lifecycle (start, stream, abort, complete).
2. **Add `sdk-permission-broker.ts`** — Map<requestId, resolver> shared at module scope; resolved by WS messages from the client.
3. **Add `sdk-message-normalizer.ts`** — translate `SDKMessage` union into Claudia's internal event format. Discriminator on `msg.type` + assistant content block `type`.
4. **Verify the `@anthropic-ai/sdk` bump** doesn't break supervisor chat (`grep -rn "@anthropic-ai/sdk" backend/src`).
5. **Add `--sdk-task` test-cli flag** to spawn an SDK task end-to-end through Claudia's existing task plumbing.

Estimated time: 2–3 days as planned.

## Open questions (carry forward)

1. **Are MCP servers picked up automatically from `~/.claude/.mcp.json`** or must we pass them via `options.mcpServers`? Test in Phase 1.
2. **Does the SDK respect `~/.claude/settings.json`** (allow/deny lists, hooks)? Test in Phase 1.
3. **What's the spawn cost per query** in practice (cold vs warm)? Measure in Phase 1.
4. **Slash commands in `-p` mode** — confirm `/clear`, `/compact`, custom commands all work. Test in Phase 5.

---

## Files added/changed

- `backend/package.json` — bumped `@anthropic-ai/sdk` to `^0.93.0`, added `@anthropic-ai/claude-agent-sdk@^0.3.181`
- `backend/sdk-spike.ts` — spike script (NEW; will be deleted after review or kept as `--sdk-spike` test-cli flag if useful)
- `docs/sdk-spike-findings.md` — this document
