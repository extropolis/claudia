# Complexity-Based Model Selection for Spawned Tasks

**Status:** Design (revised after code-aligned audit)
**Date:** 2026-05-01
**Owner:** Kalin Ovtcharov
**Scope:** v1 — global config only, `claude-code` backend only.

## Goal

Let a parent Claude agent reduce token cost when spawning child tasks via the
Claudia MCP server by tagging each spawned task with a *complexity tier*
(`low` / `medium` / `high`). The tier is mapped server-side to a configured
model — defaults `haiku` / `sonnet` / `opus` — so the parent agent reasons
about task difficulty, not about model SKUs.

The feature is gated behind an opt-in toggle and is disabled by default.

## Motivation

- Most parent-agent workflows spawn a mix of trivial and non-trivial subtasks.
  Routing all of them through the workspace's default model (often Opus or
  Sonnet) leaves easy money on the table.
- Today, `claudia_create_task` accepts only `prompt` and `displayName`. The
  spawning agent has no way to express that a subtask is cheap, so it gets
  the same model as everything else.
- A complexity hint that the operator maps to a model is more durable than
  having the agent pass a raw model SKU, since SKUs rotate.

## Non-goals (v1)

- Auto-classifying prompts in the backend.
- Per-workspace overrides (global config only). Adding workspace-level
  override later is straightforward but doubles UI scope and there is no
  existing precedent for global+workspace field-level merge in the codebase.
- `opencode` backend support. The override is plumbed through the
  `claude-code` path only; if `opencode` is the active backend, the
  complexity hint is ignored.
- Per-tier prompt caching policies, per-tier tool restrictions, etc.
- Migrations for existing tasks. Applies to tasks created after the toggle
  is enabled.

## Configuration

Add one new field to `AppConfig` in `backend/src/config-store.ts`:

```ts
export interface ModelTieringConfig {
    enabled: boolean;
    tiers: {
        low: string;
        medium: string;
        high: string;
    };
}

export const DEFAULT_MODEL_TIERING: ModelTieringConfig = {
    enabled: false,
    tiers: { low: 'haiku', medium: 'sonnet', high: 'opus' },
};
```

```ts
// AppConfig
modelTiering: ModelTieringConfig;
```

The model strings are passed verbatim to Claude Code as `--model <value>`.
Any value Claude Code accepts (`haiku`, `sonnet`, `opus`, full
`claude-*-latest` IDs, custom aliases) is valid.

### apiMode caveat

The defaults (`haiku` / `sonnet` / `opus`) work for `apiMode ∈ {'default',
'custom-anthropic'}`. They do **not** work for proxy modes:

- `sap-ai-core` and `hyperspace-proxy` route through a local proxy
  (`http://localhost:4001/anthropic`) that requires fully-qualified Anthropic
  IDs (e.g., `claude-3-5-haiku-20241022`) — see
  `backend/plugins/sap-ai-core-plugin/anthropic-proxy/deployment-catalog.ts`.
- Operators on those modes must edit the tier mappings to use IDs valid
  for their proxy.

The Settings UI calls this out in helper text.

### Migration

No schema bump needed. Reads spread the default into the loaded config:

```ts
// in getModelTiering(), mirroring getClaudeCodeSwitches() at config-store.ts:430
return {
    enabled: this.config.modelTiering?.enabled ?? DEFAULT_MODEL_TIERING.enabled,
    tiers: { ...DEFAULT_MODEL_TIERING.tiers, ...(this.config.modelTiering?.tiers || {}) }
};
```

Existing config files keep working; on first save after upgrade, the field
is persisted with defaults.

## Backend resolution

`ConfigStore` gains a helper:

```ts
resolveModelForComplexity(complexity: 'low' | 'medium' | 'high' | undefined): string | undefined {
    if (!complexity) return undefined;
    const cfg = this.getModelTiering();
    if (!cfg.enabled) return undefined;
    const model = cfg.tiers[complexity];
    if (!model || !model.trim()) return undefined; // fall through to default
    return model.trim();
}
```

Returning `undefined` means *use the workspace default model* — the
spawn path treats `undefined` as no override.

## Per-task plumbing (the lowest-risk change)

Today, `task-spawner.ts:2351-2353` pulls switches fresh from `ConfigStore`
inside the spawn function:

```ts
const switches = this.configStore.getClaudeCodeSwitches();
const switchArgs = buildClaudeCodeSwitchArgs(switches);
```

There is no per-task switches override path. v1 introduces one in three
small steps:

1. **Add a parameter** to `TaskSpawner.createTask`:

   ```ts
   async createTask(
       prompt: string,
       workspaceId: string,
       systemPrompt?: string,
       initialCols?: number,
       initialRows?: number,
       modelOverride?: string,   // NEW
   ): Promise<Task>
   ```

   Forward it to `createTaskWithClaudeCode` (same signature suffix). The
   `createTaskWithOpenCode` path ignores it for v1 (logs a debug line).

2. **Apply the override** inside `createTaskWithClaudeCode`, replacing the
   existing block at line 2351:

   ```ts
   if (this.configStore) {
       let switches = this.configStore.getClaudeCodeSwitches();
       if (modelOverride && modelOverride.trim()) {
           switches = { ...switches, defaultModel: modelOverride.trim() };
           logger.info('Per-task model override', { taskId: id, model: modelOverride.trim() });
       }
       const switchArgs = buildClaudeCodeSwitchArgs(switches);
       ...
   }
   ```

   `buildClaudeCodeSwitchArgs` already pushes `--model switches.defaultModel`
   at `task-spawner.ts:77-78` — no change there.

3. **Resolve at the WS handler** (`server.ts` task:create case at line 1068).
   Accept optional `complexity` in the payload, resolve via
   `configStore.resolveModelForComplexity(complexity)`, and pass the result
   as the new `modelOverride` argument.

## MCP server changes

The MCP server is a separate process spawned by Claude Code. Its env is
constructed in `task-spawner.ts:539-544`:

```ts
const mcpEnv: Record<string, string> = {};
if (workspaceId) mcpEnv.CLAUDIA_WORKSPACE_ID = workspaceId;
if (taskId) mcpEnv.CLAUDIA_TASK_ID = taskId;
```

Add one line: when `configStore.getModelTiering().enabled` is true, set
`mcpEnv.CLAUDIA_MODEL_TIERING_ENABLED = '1'`.

In `claudia-mcp-server.ts`, read the env var at startup:

```ts
const MODEL_TIERING_ENABLED = process.env.CLAUDIA_MODEL_TIERING_ENABLED === '1';
```

`claudia_create_task` registration becomes conditional on that flag:

- **Disabled (default):** schema unchanged. No `complexity` parameter.
- **Enabled:** add an optional `complexity: z.enum(['low', 'medium', 'high'])`
  with a description explaining the tiers. Append a short paragraph to the
  tool's top-level description so the agent knows it can pass complexity to
  control cost.

When the agent passes `complexity`, the MCP server forwards it in the
`task:create` WS payload alongside `prompt` and `workspaceId`.

### Mid-session toggle behavior

Each top-level task spawns one Claude Code subprocess, which spawns one
`claudia-mcp-server` subprocess (`task-spawner.ts:529-547`). So:

- Tasks created **after** the toggle flips get the new env var → MCP
  schema reflects the new state.
- Tasks already running (and any sub-tasks they spawn through their child
  MCP server) keep the old schema until they're stopped/restarted.

This is acceptable — the toggle is rarely flipped.

## UI

In Settings, add a new section under the existing "Claude Code Switches"
area. One toggle and three text inputs:

- Checkbox: **"Enable model tiering for spawned tasks"** (off by default).
- When checked, three rows appear: `Low`, `Medium`, `High`, each with a
  text input. Pre-filled with `haiku` / `sonnet` / `opus`.
- Helper text:

  > *Spawned tasks (via the Claudia MCP) can pass a complexity hint that
  > maps to one of these models. Use values your current API mode accepts —
  > for SAP AI Core or Hyperspace proxies, use fully-qualified Anthropic
  > model IDs (e.g., `claude-3-5-haiku-20241022`).*

Note for operators: the existing `claudeCodeSwitches.effortLevel` field
(`low` / `medium` / `high`) sits in the same Settings tab and may visually
sit close to this section. Label this section clearly as
**"Model tiering"** to keep them distinct.

## Validation

- MCP layer enforces `complexity ∈ {'low','medium','high'}` via `z.enum`.
- The `task:create` WS handler validates `complexity` if present (defense in
  depth, since the WS is reachable by sources other than the MCP server).
  Invalid values get rejected with a clear error.
- Tier strings written from the UI go through trim + length cap; no
  shell-meta validation needed since `--model` argv is passed without shell
  interpretation.

## Logging

- Spawned with override:
  `[task:create] complexity=high → model="opus" (workspace=<id>)`
- Mode disabled but `complexity` passed:
  `[task:create] complexity ignored (mode disabled)`
- Tier mapping empty:
  `[task:create] complexity=low has empty mapping; using default model`
- OpenCode + override (rare):
  `[opencode] modelOverride ignored (not yet supported)`

## Cost tracking interaction

The token-usage dashboard (current branch: `feat/token-usage-dashboard`)
attributes cost based on the spawned process's actual usage events, not on
the configured `defaultModel`. Tier-based spawns surface in cost reports
under their *actual* model, which is exactly the desired behavior — cheaper
tasks show up cheaper.

## Testing

### Unit (existing test infra)

Pure-function tests are realistic; there is no `task-spawner.test.ts` and
no `node-pty.spawn` mock infrastructure today.

In `config-store.test.ts`:
1. `getModelTiering()` returns defaults on a fresh config.
2. `resolveModelForComplexity` returns `undefined` when disabled.
3. `resolveModelForComplexity('high')` returns `'opus'` with default config
   when enabled.
4. `resolveModelForComplexity('low')` returns `undefined` when
   `tiers.low === ''` (fall-through behavior).
5. Custom mappings persist through save → load.

### End-to-end (test-cli)

Add a `--complexity <low|medium|high>` flag to `backend/test-cli.ts`. The
flag is passed in the `task:create` payload.

Manual matrix:
- Tiering disabled + `--complexity high` → log shows complexity ignored;
  task spawns with default model.
- Tiering enabled + `--complexity high` → log shows
  `complexity=high → model="opus"`; spawned argv contains `--model opus`.
- Tiering enabled + no flag → log shows no override; default model used.
- Tiering enabled + `--complexity bogus` → CLI rejects (z.enum on the WS
  side will reject too).

### UI

Manual visual check: toggle reveals/hides the three fields, helper text
visible, save persists.

## Risks & rollback

- **Risk:** Agent picks a too-cheap tier for a hard task. *Mitigation:*
  feature is opt-in; the tool description steers conservatively.
- **Risk:** Tier mapping invalid for the user's `apiMode`. *Mitigation:*
  helper text + empty-string fall-through; flipping the toggle off
  immediately reverts.
- **Risk:** OpenCode user enables tiering and is surprised the hint is
  ignored. *Mitigation:* debug log; documented as a v1 limitation.
- **Rollback:** `modelTiering.enabled = false` reverts behavior. No
  migration to undo.

## Future work

- Per-workspace overrides.
- OpenCode backend support.
- Surface the spawning agent's complexity choice in the task list UI.
- Per-`apiMode` default tier mappings (so SAP AI Core / Hyperspace users
  get sensible defaults out of the box).
