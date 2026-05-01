# Complexity-Based Model Selection for Spawned Tasks

**Status:** Design
**Date:** 2026-05-01
**Owner:** Kalin Ovtcharov

## Goal

Let a parent Claude agent reduce token cost when spawning child tasks via the
Claudia MCP server by tagging each spawned task with a *complexity tier*
(`low` / `medium` / `high`). The tier is mapped server-side to a configured
model — typically Haiku for `low`, Sonnet for `medium`, Opus for `high` — so
the parent agent reasons about task difficulty, not about model SKUs.

The feature is gated behind an opt-in mode toggle and is disabled by default.

## Motivation

- Most parent-agent workflows spawn a mix of trivial and non-trivial subtasks.
  Routing all of them through the workspace's default model (often Opus or
  Sonnet) leaves easy money on the table.
- Today, `claudia_create_task` accepts only `prompt` and `displayName`. The
  spawning agent has no way to express that a subtask is cheap, so it gets the
  same model as everything else.
- Letting the agent pass a model name directly couples agent prompting to
  model SKUs, which rotate. A complexity hint that the operator maps to a
  model is more durable.

## Non-goals

- Auto-classifying prompts in the backend. The spawning agent has the context;
  forcing a classifier call would add latency and cost.
- Changing how the user's *interactive* (non-spawned) tasks pick a model.
  This feature only affects tasks created via the `claudia_create_task` MCP
  tool.
- Per-tier prompt caching policies, per-tier tool restrictions, or any other
  behavior beyond model selection. Future work.
- Migrating existing tasks. The feature applies to tasks created after the
  toggle is enabled.

## Configuration

### Global config (`AppConfig` in `backend/src/config-store.ts`)

Add one new field to `AppConfig`:

```ts
modelTiering: ModelTieringConfig;
```

Where:

```ts
export interface ModelTieringConfig {
    enabled: boolean;            // master toggle, default: false
    tiers: {
        low: string;             // default: "haiku"
        medium: string;          // default: "sonnet"
        high: string;            // default: "opus"
    };
}

export const DEFAULT_MODEL_TIERING: ModelTieringConfig = {
    enabled: false,
    tiers: { low: 'haiku', medium: 'sonnet', high: 'opus' },
};
```

The model strings are passed verbatim to Claude Code as `--model <value>`,
matching the existing `claudeCodeSwitches.defaultModel` convention. Any
string Claude Code accepts (`haiku`, `sonnet`, `opus`, full
`claude-*-latest` IDs, custom aliases) is valid.

### Per-workspace override (`Workspace` in `shared/src/index.ts`)

Add an optional override field to `Workspace`, mirroring the existing
optional `systemPrompt`:

```ts
modelTiering?: Partial<ModelTieringConfig>;
```

Resolution rules at task-creation time:

1. Start with the global `modelTiering` config.
2. If the workspace has `modelTiering.enabled` set, that overrides the global
   `enabled`.
3. If the workspace has any `modelTiering.tiers.*` field set, that overrides
   the corresponding global tier mapping. Other tiers fall through to the
   global value.
4. Empty string in a tier field means *unset* — fall through to the next
   level (workspace empty → global → built-in default).

This matches the existing pattern used by `Workspace.systemPrompt`: the
workspace value is optional and falls back to global when absent.

## MCP tool surface (`claudia_create_task`)

The MCP server (`backend/src/claudia-mcp-server.ts`) reads the resolved
`modelTiering` config for its `WORKSPACE_ID` at startup.

### Mode disabled (default)

Tool schema and description are exactly what they are today. No `complexity`
parameter is registered. Zero behavior change.

### Mode enabled

The tool gains an optional `complexity` parameter:

```ts
complexity: z.enum(['low', 'medium', 'high']).optional()
    .describe(
        'Cost/capability tier for the spawned task. ' +
        'Use "low" for trivial lookups, formatting, or single-file reads. ' +
        'Use "medium" for normal coding, refactors, or test writing. ' +
        'Use "high" for tricky architecture, gnarly debugging, or work ' +
        'requiring careful multi-step reasoning. Omit to use the workspace default.'
    )
```

The tool's top-level description gains one short paragraph pointing at the
`complexity` parameter and explaining that it controls cost.

When the agent invokes the tool with `complexity: "low"`, the MCP server
forwards `complexity` to the backend's `task:create` WebSocket handler
alongside `prompt` and `workspaceId`.

### Mid-session toggle changes

Each spawned task launches a fresh Claude Code subprocess, which spawns a
fresh `claudia-mcp-server.ts` subprocess. So toggle changes take effect on
the *next* spawn — no manual restart needed. The currently running parent's
MCP server keeps its old schema until the parent itself is restarted, but
that's acceptable since the toggle is rarely flipped.

## Backend resolution & spawn flow

The mapping happens in the WebSocket `task:create` handler in
`backend/src/server.ts` (the layer reached by `sendWSMessage('task:create',
...)`), before the task is handed to `task-spawner.ts`:

1. Receive `task:create` message. Payload may now include an optional
   `complexity: 'low' | 'medium' | 'high'` field.
2. Resolve the effective `ModelTieringConfig` for the target workspace
   (workspace override layered on global).
3. If `enabled === false`: ignore `complexity` silently. Fall through to the
   normal model resolution (workspace switches → global default).
4. If `enabled === true` and `complexity` is provided:
   - Look up `tiers[complexity]`.
   - If non-empty, set `claudeCodeSwitches.model` to that string for the
     task being spawned (overriding the workspace's
     `claudeCodeSwitches.defaultModel`).
   - If the looked-up value is empty string, log a warning and fall through
     to the default model (don't crash, don't reject).
5. If `enabled === true` and `complexity` is not provided: use the default
   model. The agent simply didn't opt into a tier.

`task-spawner.ts` already passes `switches.model` to `--model` (lines
76–78). No spawner changes are needed once the resolved model lands in the
switches object.

### Validation

- The MCP layer enforces `complexity ∈ {'low', 'medium', 'high'}` via
  `z.enum`. Invalid values are rejected by the SDK before the handler runs.
- The `task:create` handler additionally validates `complexity` if present
  (defense in depth, since the WS endpoint is reachable by sources other
  than the MCP server). Invalid value → reject with a clear error message
  so a misbehaving caller learns.

### Conflicts with explicit model

If a `task:create` payload somehow contains both `complexity` and an
explicit `claudeCodeSwitches.model` override, `complexity` wins. The MCP
server is the only documented producer of `complexity` and it never sets
`model` directly, so this conflict should be rare.

## UI

In the Settings dialog, add a new section: **Model tiering**.

- One checkbox: "Allow agents to select model by task complexity"
  (off by default).
- When checked, three rows appear, each labeled `Low`, `Medium`, `High`,
  with a single text input pre-filled with `haiku`, `sonnet`, `opus`. (Text
  input rather than dropdown to match the existing `defaultModel` field's
  style and accept arbitrary aliases.)
- A short helper line: *"Spawned tasks tagged with a complexity tier will
  use the corresponding model. Leave a field empty to use the workspace
  default for that tier."*

The same section appears in workspace settings, with one extra control per
field: an "Inherit from global" checkbox. When inherited, the field is
disabled and shows the global value greyed-out.

No new screens, modals, or routes. One section in an existing dialog.

## Logging

- When a task is spawned with a tier, log:
  `[task:create] complexity=high → model="opus" (workspace=<id>)`
- When mode is disabled and the agent passes `complexity` anyway, log a
  single line at debug level so the operator can spot agents trying to use
  the feature: `[task:create] complexity ignored (mode disabled)`
- When a tier maps to an empty string and we fall through, log a warning:
  `[task:create] complexity=low has empty mapping; using default model`

## Testing

### Backend (test-cli)

Add `--complexity <low|medium|high>` to `backend/test-cli.ts`. The flag is
passed through to the `task:create` request alongside the prompt.

Cases to verify (in `backend/src/__tests__/`):

1. **Mode disabled, complexity passed** — task spawns with the default
   model; complexity is ignored; debug log emitted.
2. **Mode enabled, complexity = "high"** — task spawns with `--model opus`
   on its argv (or whatever `tiers.high` is configured to).
3. **Mode enabled, complexity omitted** — task spawns with the default
   model.
4. **Mode enabled, invalid complexity (`"medium-rare"`)** — `task:create`
   rejected with a clear error.
5. **Mode enabled at global, disabled at workspace** — workspace override
   wins; complexity is ignored.
6. **Mode enabled, tier mapping empty (`tiers.low = ""`)** — falls through
   to default model with a warning logged.

Where feasible, assert on the spawned process's argv (the existing
`task-spawner.ts` test patterns already do this).

### MCP layer

Unit-test the schema-shape decision in `claudia-mcp-server.ts`:

- When `enabled === false`, the registered tool's input schema does NOT
  include `complexity`.
- When `enabled === true`, the schema includes `complexity` with the three
  valid enum values.

### UI

Manual visual check only — one checkbox, three text inputs, one helper
line. Verify the inputs hide/show with the toggle and that workspace
inherit behavior matches the existing `systemPrompt` pattern.

## Risks & rollback

- **Risk:** An agent passes `complexity: "low"` for a task that genuinely
  needs reasoning power, leading to a poor result. *Mitigation:* The
  feature is opt-in. Operators who don't trust their agents' judgment leave
  it off. The tool description steers the agent toward conservative use.
- **Risk:** A misconfigured tier (e.g., `high` mapped to a deprecated model
  ID) breaks all `complexity: "high"` spawns. *Mitigation:* Logging plus
  the empty-string fall-through. The operator can flip the toggle off to
  immediately revert to today's behavior.
- **Rollback:** Set `modelTiering.enabled = false` in global config. All
  spawned tasks revert to today's model resolution. No data migration
  needed.

## Open questions

- Should the per-workspace UI initially ship as "inherit only" (no override
  surface), with override added in a follow-up? Probably not — the override
  is cheap to build and the spec is cleaner with it included from v1.
- Future work: surface the spawning agent's `complexity` choice in the task
  list UI (small badge next to the task name) so operators can see at a
  glance which tasks are running cheap vs. expensive. Out of scope for v1.
