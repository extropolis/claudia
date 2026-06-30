# Claudia SDK Chat View — Investigation & Plan

**Goal:** clean-room rebuild a chat-style task view in Claudia that matches the polish and feature set of CloudCLI's Claude Code chat UI — slash commands, permission dialogs, plan mode, tool renderers, the works — using the official Claude Agent SDK instead of a PTY. Stay MIT-licensed (no AGPL contamination).

**Status:** investigation complete · ready for review · no code written yet

---

## What CloudCLI actually does

Cloned `siteboon/claudecodeui` and read the architecture. The whole thing rests on **one critical decision** — they ditched the PTY entirely and use the official SDK:

```js
import { query } from '@anthropic-ai/claude-agent-sdk';  // package.json: ^0.3.165
```

Everything else flows from that:

### Backend: `server/claude-sdk.js` (~895 lines)

A single module that:

1. **Spawns a query** with `query({ prompt, options })` from the SDK — no `claude` process, no PTY, no `node-pty`.
2. **Streams structured messages** back over WebSocket. Each event is normalized JSON with a `kind` field — never raw bytes. Observed kinds:
   - `session_created` — new session ID assigned
   - `permission_request` / `permission_cancelled` — tool approval flow
   - `status` — token budget, partial state
   - `error`, `action_required`, `notification`
   - SDK-provided message events (assistant text, tool use, tool result) flow through too
3. **Permission dialogs** are real. The SDK exposes a `canUseTool(toolName, input, context)` callback. CloudCLI sends a `permission_request` to the UI, awaits a `Promise` resolved by a matching WebSocket message from the client, then returns `{ behavior: 'allow' }` or `{ behavior: 'deny' }` to the SDK. There's a `pendingToolApprovals` `Map<requestId, resolver>` shared at module scope. They survive WebSocket reconnects (a recent changelog entry: "preserve pending permission requests across WebSocket reconnections").
4. **Hooks** for notifications and lifecycle events. The SDK lets you register `Notification`, `PreToolUse`, etc.
5. **MCP servers** loaded from `.mcp.json` and passed via `sdkOptions.mcpServers` — no synchronization gymnastics, the SDK reads them directly.
6. **Allow/deny lists** matched against `Bash(command:*)` shorthand. Stored permissions auto-approve without prompting.
7. **Token usage** parsed from the SDK's message stream (cache creation tokens, cache read tokens, direct input tokens — all separated).
8. **Aborts** via `queryInstance.interrupt()`. Aborted sessions land in an `abortedSessionIds` set so the run loop doesn't double-emit completion.

### Frontend: `src/components/chat/` (~885 lines for the core, plus ~20 sub-components)

Folder layout:
```
src/components/chat/
├── view/
│   ├── ChatInterface.tsx           (448 lines — top-level chat container)
│   └── subcomponents/
│       ├── ChatComposer.tsx        (input box with slash menu + @ mentions)
│       ├── ChatMessagesPane.tsx    (scrollback)
│       ├── MessageComponent.tsx    (one user/assistant turn)
│       ├── CommandMenu.tsx         (slash command picker)
│       ├── CommandResultModal.tsx
│       ├── PermissionRequestsBanner.tsx  (dialog for pending tool approvals)
│       ├── ImageAttachment.tsx
│       ├── Markdown.tsx
│       ├── MessageCopyControl.tsx
│       ├── ActivityIndicator.tsx   ("thinking" / "running")
│       ├── TokenUsageSummary.tsx
│       └── ProviderSelectionEmptyState.tsx
├── tools/
│   ├── ToolRenderer.tsx            (299 lines — dispatches per tool name)
│   └── components/
│       ├── PlanDisplay.tsx         (real React plan mode — not Claude's TUI)
│       ├── ToolDiffViewer.tsx      (diff render for Edit/Write tools)
│       ├── ToolStatusBadge.tsx
│       ├── CollapsibleDisplay.tsx
│       ├── CollapsibleSection.tsx
│       ├── OneLineDisplay.tsx
│       ├── SubagentContainer.tsx
│       ├── ContentRenderers/       (per content type — markdown, file lists, todos, Q&A, plain text)
│       └── InteractiveRenderers/
│           └── AskUserQuestionPanel.tsx
├── hooks/
│   ├── useChatMessages.ts
│   ├── useChatComposerState.ts
│   ├── useChatProviderState.ts
│   ├── useChatRealtimeHandlers.ts
│   ├── useChatSessionState.ts
│   ├── useSlashCommands.ts
│   └── useFileMentions.tsx
├── types/types.ts
└── utils/
```

That's roughly **~4-5k lines of TS/TSX** for the chat surface alone, give or take. Substantial but bounded.

### Key UX features it gets for free from the SDK approach

| Feature | How |
|---|---|
| **Slash commands** | `useSlashCommands` hook + `CommandMenu` component. Triggered by `/` anywhere in input (recent fix made it work mid-line, not just at start). Sent as part of the prompt string to the SDK. |
| **`@` file mentions** | `useFileMentions` hook with file tree picker. Resolves to file paths in the prompt. |
| **Permission dialogs** | Real React modal. WebSocket `permission_request` → user picks Allow/Deny/Allow-and-remember → WebSocket reply → SDK callback resolves. |
| **Plan mode** | `PlanDisplay.tsx` renders the plan as collapsible React, with approve/edit. Not a TUI overlay. |
| **Tool calls** | `ToolRenderer` switch on `toolName`. Bash, Read, Edit, Write, Grep, Glob etc. each get a dedicated renderer (collapsible, syntax-highlighted, status badge). |
| **Reconnect resilience** | Pending approvals persist server-side; on reconnect the client re-fetches them. |
| **No garbling** | There is no terminal. Ever. |

---

## How this maps into Claudia

Claudia today runs `claude` interactively in a `node-pty` PTY, streams raw bytes over WebSocket, and renders them in xterm.js. That model gives us slash menus and prompts "for free" via the TUI — and gives us garbling, resize hell, and an opaque rendering pipeline as the cost.

The proposed chat view runs **alongside** the existing PTY-based view, behind a per-task toggle. Same task lifecycle (workspaces, parallel orchestration, supervisor chat, MCP siblings, checkpoints) — different transport and rendering for the user-facing surface.

### Architectural changes

**Backend** — add a new "SDK task" path next to the PTY task path:

```
backend/src/
├── task-spawner.ts          (existing — PTY tasks, untouched)
├── sdk-task-runner.ts       NEW — wraps @anthropic-ai/claude-agent-sdk query()
├── sdk-permission-broker.ts NEW — pendingApprovals Map + WS roundtrip
├── sdk-message-normalizer.ts NEW — SDK events → Claudia WS protocol
└── server.ts                (extended — new WS message kinds, REST endpoints)
```

A "task" in Claudia stays the same conceptual thing (taskId, workspace, status, etc.) — only the underlying mechanism differs. `task.kind: 'pty' | 'sdk'` discriminator. Every existing API (list, archive, send-input, abort, output stream) gets an SDK-aware branch.

**Frontend** — add a chat view mode for tasks:

```
frontend/src/components/conversation/    (folder already exists)
├── ConversationView.tsx           NEW — top-level chat
├── ChatComposer.tsx               NEW — input + slash + @ mentions
├── MessageList.tsx                NEW
├── Message.tsx                    NEW — user/assistant/system bubble
├── ToolCallRenderer.tsx           NEW — per-tool dispatch
├── ToolRenderers/                 NEW
│   ├── BashRenderer.tsx
│   ├── EditRenderer.tsx           (with diff viewer)
│   ├── ReadRenderer.tsx
│   ├── PlanDisplay.tsx
│   ├── TodoListRenderer.tsx
│   └── ...
├── PermissionDialog.tsx           NEW — React modal for tool approvals
├── SlashCommandMenu.tsx           NEW
├── FileMentionPicker.tsx          NEW
└── hooks/
    ├── useSdkSession.ts
    ├── useSlashCommands.ts
    └── useFileMentions.ts
```

**Per-task view toggle**: each task row has Terminal / Chat tabs. Default to Chat for new tasks; existing PTY tasks default to Terminal. User can switch any time.

### Reused vs new

| Stays | Becomes new |
|---|---|
| Workspaces, task list, archival, supervisor chat | Per-task transport (PTY ↔ SDK) |
| Claudia MCP server, sibling spawning | Message rendering (xterm ↔ React chat) |
| Mobile app, voice, push, ngrok tunnel | Permission flow (TUI ↔ React dialog) |
| Checkpoints, git, cron scheduler | Slash menu (TUI ↔ React) |
| Token parsing, conversation history | File mentions (TUI ↔ React) |
| WebSocket bus | New message kinds added |

---

## Clean-room boundaries (license safety)

Working under "Clean-room rebuild, keep MIT" the user picked. This means:

✅ **OK** — read CloudCLI to understand:
- What WebSocket message kinds are useful (`permission_request`, `session_created`, etc.)
- What architectural shape works (separate SDK module, pending approvals map, normalized events)
- What features to build (Plan mode primitive, Q&A panel, todos, diff viewer)
- What the SDK API looks like (it's Anthropic's, fully public)

❌ **NOT OK** — copy:
- Source files, even partial
- Their type definitions or message schemas verbatim
- Their CSS / Tailwind class strings as-is
- Their component structure as a literal copy

In practice: keep CloudCLI open as a reference for "what does good look like," but every line we write is original. Different file names, different prop shapes, different styling choices. Use `@anthropic-ai/claude-agent-sdk` (Anthropic's package, MIT) directly, not via CloudCLI's wrapper.

We can also use any MIT-licensed third-party renderers — `react-markdown`, `shiki`, `react-diff-viewer-continued`, etc. — and build on top.

---

## Implementation phases

### Phase 0 — Spike & SDK familiarization (½ day)

- Add `@anthropic-ai/claude-agent-sdk` to `backend/package.json`.
- New `backend/test-cli.ts` flag: `--sdk-spike "your prompt" -w <workspace>`.
- Wire a minimal `sdk-task-runner.ts` that runs one query, prints every event to stdout.
- Goal: confirm SDK works in our env, see the actual event shapes, understand abort behavior.

**Exit criteria:** can run `npx tsx test-cli.ts --sdk-spike "list files" -w /some/path` and see assistant messages, tool calls, tool results stream in.

### Phase 1 — Backend SDK task path (2–3 days)

- `sdk-task-runner.ts`: full query lifecycle — spawn, stream, abort, complete.
- `sdk-permission-broker.ts`: `pendingApprovals` Map, request → WS → resolve flow. Reconnect-safe (keyed by taskId + requestId, persisted in memory; survive client disconnect, recoverable when client reconnects).
- `sdk-message-normalizer.ts`: SDK events → Claudia's WS protocol. Define our own message kinds (don't crib CloudCLI's names verbatim). Suggested:
  - `sdk:assistant_message`
  - `sdk:tool_call`
  - `sdk:tool_result`
  - `sdk:permission_request`
  - `sdk:permission_resolved`
  - `sdk:plan`
  - `sdk:status`
  - `sdk:complete`
- Extend `taskStore` shape: `task.kind: 'pty' | 'sdk'`, `task.transcript: SdkEvent[]` for SDK tasks.
- New REST endpoints:
  - `POST /api/tasks/:id/permission` — Allow/Deny/Remember
  - `POST /api/tasks/:id/abort` — abort SDK query (in addition to existing PTY-friendly stop)
- Persist transcript to disk (similar to PTY history, but structured JSON).
- Unit tests for the normalizer and permission broker.
- CLI test flags:
  - `--create-sdk-task --task-name X -w <id> -m "..."`
  - `--watch-sdk-events --task-id <id>` (NDJSON to stdout)
  - `--respond-permission --task-id <id> --request-id X --decision allow`

**Exit criteria:** can spawn an SDK task via test-cli, watch structured events stream, respond to a permission request from the CLI, and see the task complete.

### Phase 2 — Minimal chat UI (2–3 days)

- `ConversationView.tsx` rendering message stream. Read-only at first.
- `Message.tsx` for user / assistant / system turns.
- `ChatComposer.tsx` for plain text input → POST to backend → SDK runs.
- Connect to WS, subscribe to `sdk:*` events for the active task.
- Per-task tab: Terminal | Chat. Default new tasks to Chat.

**Exit criteria:** can create an SDK task in the UI, type a prompt, see assistant text stream in. No tool rendering yet — show raw JSON for tool calls.

### Phase 3 — Tool renderers (3–4 days)

Build tool-specific renderers. Priority order:
1. **Bash** — collapsed by default, command + output, status badge, copy button.
2. **Edit / Write** — diff viewer (use `react-diff-viewer-continued` or similar MIT-licensed lib).
3. **Read** — file path, expandable content, line range.
4. **Grep / Glob** — collapsed result list.
5. **TodoWrite** — checklist UI.
6. **Plan (ExitPlanMode)** — full plan display with Approve / Reject buttons.
7. **Generic fallback** — pretty-print JSON for unknown tools.
8. **MCP tools** — generic + per-server overrides.

Shared primitives:
- `CollapsibleSection`
- `ToolStatusBadge`
- `OneLineDisplay` (compact tool calls)
- `Markdown` wrapper around `react-markdown` + `shiki`

**Exit criteria:** all common Claude Code tool calls render usefully. Long bash output collapses cleanly. Diffs are readable.

### Phase 4 — Permission dialogs (1–2 days)

- `PermissionDialog.tsx` — modal, shows tool name + input, Allow / Deny / Allow + Remember rule (e.g. `Bash(npm test:*)`).
- Subscribe to `sdk:permission_request` events. Queue if multiple pending.
- POST decision to backend. Backend resolves SDK callback.
- Mobile: deliver as Expo push + native dialog screen.
- Persisted allow/deny lists per workspace, editable in settings.

**Exit criteria:** can run a task that needs Bash permission, see dialog, approve, see it execute. "Remember" persists for the workspace.

### Phase 5 — Slash commands & file mentions (2 days)

- `useSlashCommands.ts` — fetch the actual commands available (Claude Code has a built-in set; SDK exposes them or we maintain a list).
- `SlashCommandMenu.tsx` — popup on `/`, fuzzy filter, arrow-key navigation, Enter to select.
- `FileMentionPicker.tsx` — popup on `@`, fuzzy file-tree search, scoped to workspace.
- Resolved selections inject into the prompt as text the SDK understands.

**Exit criteria:** typing `/` opens menu, `@` opens file picker, both work end-to-end and the selected command/file makes it into the prompt.

### Phase 6 — Polish & parity (open-ended, prioritized)

In order of impact:
1. **Plan mode** UI with approve/edit (Phase 3 stub → real flow).
2. **Token usage** display per turn + cumulative — already parsed by Claudia, just surface it.
3. **Activity indicator** ("Thinking…" / "Running Bash…").
4. **Image paste / drag-drop** to prompt.
5. **Copy as markdown** for assistant messages.
6. **Reconnect resilience** — stress-test WS drops mid-permission, mid-tool-call.
7. **Mobile chat** — port the new conversation view into the Expo app (current mobile view is its own thing — can converge).
8. **i18n** — out of scope for v1, file an issue.

### Phase 7 — Optional: deprecate PTY for Claude Code tasks

Once SDK chat is solid, the PTY path becomes opt-in for shell-style usage and edge cases. Claudia's value moves to:
- Garbling-free chat as default
- Parallel SDK tasks orchestrated via supervisor + MCP siblings (uniquely Claudia)
- PTY available for non-Claude shells, debugging, raw tool access

This is a **separate decision** to make once Phases 1–5 ship, not now.

---

## Risk register

| Risk | Mitigation |
|---|---|
| **SDK behavior diverges from CLI** (slash commands, MCP, hooks) | Phase 0 spike validates this before committing. Anthropic's docs say SDK == CLI agent loop, but verify. |
| **Authentication** — SDK auth model differs from `claude login` | The SDK supports Anthropic API key, OAuth, Bedrock, Vertex. Reuse Claudia's existing API key config. The user already has Claude CLI installed; SDK can use the same credentials in most cases. |
| **MCP server discovery** | SDK accepts `mcpServers` directly. Pass Claudia's existing config. The "skip own workspace" hack stays in place for the file-write side; SDK side just doesn't write `.mcp.json`. |
| **Subagents / Task tool** | The Task tool nests subagents. SDK should handle it, but verify in Phase 0. Render with `SubagentContainer` (mirror name; original code). |
| **Hook system** (PreToolUse, etc.) | Inherit from Claudia's existing hook infra if any; SDK supports `hooks` option directly. |
| **Slash commands maintenance** | Anthropic updates them. Build the menu data-driven so a JSON list update is enough. |
| **Bundle size** | SDK is server-only, so frontend stays lean. New deps: `react-markdown`, `shiki` or `prismjs`, a diff viewer. ~200KB gzipped extra. Acceptable. |
| **Existing PTY users** | Per-task toggle. Existing tasks default to Terminal. No forced migration. |
| **License contamination** | Don't open CloudCLI files while writing equivalent Claudia files. Treat their code as a feature spec, not a code source. Have a second pair of eyes (or a tool) confirm no copied lines if paranoid. |

---

## Effort estimate

| Phase | Estimate |
|---|---|
| 0. Spike | ½ day |
| 1. Backend SDK path | 2–3 days |
| 2. Minimal chat UI | 2–3 days |
| 3. Tool renderers | 3–4 days |
| 4. Permission dialogs | 1–2 days |
| 5. Slash + mentions | 2 days |
| 6. Polish | 3–5 days (rolling) |
| **Total to ship behind a flag** | **~2 weeks of focused work** |

This is real work, but it's the work — and it eliminates the garbling problem permanently while building exactly the surface CloudCLI proved customers want.

---

## What I'd do first

1. **Phase 0 spike today.** ½ day to confirm the SDK behaves the way we hope. If it doesn't (e.g. auth doesn't work in our environment), we adjust before committing weeks of work.
2. After spike: phased plan above, behind a feature flag, MVP at end of Phase 5.
3. Don't touch the PTY code path until SDK chat is proven. Ship as a parallel option, validate, then consider deprecating.

---

## Open questions for the user

1. **Auth source.** Should SDK tasks reuse Claudia's existing API key config, or fall back to whatever `claude login` set? (Recommendation: support both; prefer Claudia's config when present.)
2. **Default view for new tasks** — Chat or Terminal? (Recommendation: Chat once Phase 5 ships; Terminal until then.)
3. **Mobile timing** — port to Expo app immediately when Phase 5 ships, or after we're sure the desktop UX is right?
4. **AGPL of CloudCLI** — confirm we keep the cloned repo under `/tmp` and never link it from Claudia. (Already in `/tmp/cloudcli-research`, will not be checked in.)
