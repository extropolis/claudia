# Token Usage Dashboard — Implementation Plan

**Strategy: B — Session File Parsing**
**Status: Scoped (not yet implementing)**
**Date: 2026-04-22**

---

## 1. Feasibility Summary

### Confirmed: Claude CLI exposes rich token/cost data

The `claude -p --output-format json` command returns structured metadata:

```json
{
  "total_cost_usd": 0.118602,
  "usage": {
    "input_tokens": 9,
    "cache_creation_input_tokens": 31504,
    "cache_read_input_tokens": 0,
    "output_tokens": 29
  },
  "modelUsage": {
    "Claude-Sonnet-4.6": {
      "inputTokens": 9,
      "outputTokens": 29,
      "cacheReadInputTokens": 0,
      "cacheCreationInputTokens": 31504,
      "costUSD": 0.118602
    }
  }
}
```

### Confirmed: Session JSONL files contain per-turn usage data

Claude Code writes API responses to `~/.claude/projects/<project>/<session-id>.jsonl`. Each assistant message entry includes:

```json
{
  "type": "assistant",
  "message": {
    "model": "claude-sonnet-4-6",
    "role": "assistant",
    "usage": {
      "input_tokens": 10,
      "cache_creation_input_tokens": 3066,
      "cache_read_input_tokens": 17906,
      "output_tokens": 3,
      "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
      "service_tier": "standard"
    }
  }
}
```

Tool result entries also include aggregated usage:

```json
{
  "type": "user",
  "toolUseResult": {
    "totalTokens": 21703,
    "totalToolUseCount": 1,
    "usage": {
      "input_tokens": 3,
      "cache_creation_input_tokens": 663,
      "cache_read_input_tokens": 20734,
      "output_tokens": 303
    }
  }
}
```

### Confirmed: Claudia already has the infrastructure

- **Session ID capture**: `startSessionCapture()` in `task-spawner.ts:1251` already monitors for new `.jsonl` files and extracts session IDs
- **Session file path resolution**: `getClaudeProjectsDir()` at `task-spawner.ts:1239` already resolves `~/.claude/projects/<workspace-hash>/`
- **JSONL parsing**: `conversation-parser.ts` already parses session JSONL files line-by-line using `readline`
- **State transition hooks**: `checkTaskStates()` at `task-spawner.ts:678` already detects `busy -> idle` and `busy -> exited` transitions — ideal hook points
- **Config store**: `config-store.ts` already supports typed config with defaults and persistence

---

## 2. Strategy Comparison (Why B)

| Strategy | Approach | Pros | Cons |
|----------|----------|------|------|
| **A: Parse `/cost` PTY output** | Send `/cost\n` to PTY, regex-parse ANSI output | No architecture change | Fragile regex, format changes between versions, adds latency |
| **B: Read session JSONL files** | Parse `~/.claude/projects/.../<session>.jsonl` on state transitions | Structured data, reliable, uses existing infrastructure | Depends on internal file format (stable but undocumented) |
| **C: Switch to `stream-json` pipe** | Replace PTY with pipe-based `--output-format stream-json` | First-class structured data, real-time per-turn | Major architecture rewrite, breaks terminal UX |

**Decision: Strategy B** — leverages existing session capture and JSONL parsing infrastructure with minimal risk. The JSONL format has been stable across Claude Code versions and contains everything needed.

---

## 3. Data Model Changes

### 3.1 Shared Types — `shared/src/index.ts`

Add to existing file:

```typescript
/** Per-model token usage breakdown */
export interface ModelTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

/** Aggregated token usage for a task */
export interface TaskTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalCostUsd: number;
  /** Breakdown by model name (e.g., "Claude-Sonnet-4.6") */
  modelBreakdown: Record<string, ModelTokenUsage>;
  /** ISO timestamp of last parse */
  lastUpdated: string;
}

/** Aggregated usage for the dashboard */
export interface UsageDashboardData {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  taskCount: number;
  byWorkspace: Record<string, {
    workspaceName: string;
    taskCount: number;
    totalCostUsd: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  byModel: Record<string, {
    taskCount: number;
    totalCostUsd: number;
    inputTokens: number;
    outputTokens: number;
  }>;
}

/** Configurable pricing per model */
export interface ModelPricing {
  inputPer1MTokens: number;   // USD
  outputPer1MTokens: number;  // USD
  cacheCreatePer1MTokens: number;
  cacheReadPer1MTokens: number;
}
```

### 3.2 Extend Task interface — `shared/src/index.ts`

```typescript
export interface Task {
  // ... existing fields ...
  tokenUsage?: TaskTokenUsage;  // NEW
}
```

### 3.3 Extend PersistedTask — `backend/src/task-spawner.ts:133`

```typescript
interface PersistedTask {
  // ... existing fields ...
  tokenUsage?: TaskTokenUsage;  // NEW — persisted to tasks.json
}
```

### 3.4 Extend InternalTask — `backend/src/task-spawner.ts:175`

```typescript
interface InternalTask extends Task {
  // ... existing fields ...
  tokenUsage?: TaskTokenUsage;  // NEW — in-memory, synced to persisted
}
```

---

## 4. Backend Implementation

### 4.1 New File: `backend/src/token-parser.ts`

**Purpose**: Parse session JSONL files and extract aggregated token usage.

**Key functions**:

```typescript
/**
 * Parse a Claude Code session JSONL file and extract token usage.
 * Reads the file line-by-line (same pattern as conversation-parser.ts).
 * Aggregates usage from all assistant message entries.
 */
export async function parseSessionTokenUsage(
  sessionFilePath: string
): Promise<TaskTokenUsage | null>

/**
 * Convenience: resolve session file path and parse.
 * Uses same path resolution as conversation-parser.ts.
 */
export async function getTaskTokenUsage(
  workspacePath: string,
  sessionId: string
): Promise<TaskTokenUsage | null>
```

**Parsing logic**:

1. Open file with `fs.createReadStream` + `readline` (matches `conversation-parser.ts` pattern)
2. For each line, parse JSON and check:
   - If `type === 'assistant'` and `message.usage` exists → extract `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`
   - If `message.model` exists → track per-model breakdown
3. Sum all usage across turns
4. For cost: check if any entry contains `costUSD` in a `modelUsage`-style block; otherwise compute from token counts using default/configured pricing
5. Return `TaskTokenUsage` object

**Deduplication**: The JSONL contains two entries per assistant turn — a partial (thinking/streaming) and a final (with `stop_reason`). Only count entries where `stop_reason` is present to avoid double-counting. The UUID is the same for both entries, so track seen UUIDs.

**Edge cases**:
- File doesn't exist yet → return `null`
- File is being written to (task still running) → read what's available, return partial data
- Subagent usage: tool result entries contain nested `usage` from subagents — include these in the aggregate since they represent real API calls

### 4.2 Modify: `backend/src/task-spawner.ts`

**Hook point**: `checkTaskStates()` at line 678, specifically the `busy -> idle` transition at line 736:

```typescript
// Existing code at line 736:
this.transitionTaskState(task, 'idle', undefined, 'polling: output stable');
this.captureGitStateAfterTask(task.id).catch(err => { ... });

// ADD after captureGitStateAfterTask:
this.captureTokenUsage(task.id).catch(err => {
    logger.error('Failed to capture token usage', { taskId: task.id, error: err.message });
});
```

**Also hook** into the `onExit` handler in `setupProcessHandlers()` (line ~2097) for final capture when task exits.

**New method**:

```typescript
private async captureTokenUsage(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task?.sessionId) return;

    const usage = await getTaskTokenUsage(task.workspaceId, task.sessionId);
    if (!usage) return;

    task.tokenUsage = usage;
    this.emit('taskTokenUsage', taskId, usage);
    this.debounceSaveTasks();
}
```

**Persistence**: Add `tokenUsage` to the `saveTasks()` serialization (line 1062) and `loadTasks()` deserialization. The `PersistedTask` interface change handles this — just include it in the JSON write/read alongside existing fields.

**Restore on reload**: When `tsx watch` restarts and tasks are reloaded from `tasks.json`, the `tokenUsage` field is restored automatically since it's persisted.

### 4.3 Modify: `backend/src/config-store.ts`

Add pricing configuration to `AppConfig` (line 69):

```typescript
export interface AppConfig {
  // ... existing fields ...
  tokenPricing?: Record<string, ModelPricing>;  // Custom pricing overrides keyed by model name
  tokenTrackingEnabled?: boolean;  // Enable/disable token tracking (default: true)
}
```

Default pricing (Anthropic public rates as of 2026-04):

```typescript
const DEFAULT_TOKEN_PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-6': {
    inputPer1MTokens: 3.00,
    outputPer1MTokens: 15.00,
    cacheCreatePer1MTokens: 3.75,
    cacheReadPer1MTokens: 0.30,
  },
  'claude-opus-4-6': {
    inputPer1MTokens: 15.00,
    outputPer1MTokens: 75.00,
    cacheCreatePer1MTokens: 18.75,
    cacheReadPer1MTokens: 1.50,
  },
  'claude-haiku-4-5': {
    inputPer1MTokens: 0.80,
    outputPer1MTokens: 4.00,
    cacheCreatePer1MTokens: 1.00,
    cacheReadPer1MTokens: 0.08,
  },
};
```

**Enterprise use case**: Users can override pricing via the settings UI or `config.json` directly. When custom pricing is set, costs are recalculated from raw token counts instead of using the CLI's reported `costUSD`.

### 4.4 Modify: `backend/src/server.ts`

Add new API endpoints:

```
GET  /api/usage/dashboard    — Aggregated usage across all active + archived tasks
GET  /api/usage/config       — Get current pricing configuration
PUT  /api/usage/config       — Update custom pricing overrides
```

**Dashboard endpoint implementation**:

```typescript
app.get('/api/usage/dashboard', (req, res) => {
    // Iterate all tasks (active + archived)
    // Aggregate tokenUsage fields into UsageDashboardData
    // Group by workspace (task.workspaceId) and model (tokenUsage.modelBreakdown keys)
    // Return JSON
});
```

**WebSocket event**: Add `task:tokenUsage` message type:

```typescript
// Emitted when token usage is captured/updated for a task
{ type: 'task:tokenUsage', payload: { taskId: string, tokenUsage: TaskTokenUsage } }
```

Register the event in the TaskSpawner event listener section (around line 373 in `task-spawner.ts`):

```typescript
this.backend.on('taskTokenUsage', (taskId: string, tokenUsage: TaskTokenUsage) => {
    this.broadcastToWorkspace(workspaceId, {
        type: 'task:tokenUsage',
        payload: { taskId, tokenUsage }
    });
});
```

---

## 5. Frontend Implementation

### 5.1 Per-Task Token Stats Bar — `frontend/src/components/TaskTokenStats.tsx` (NEW)

**Location**: Rendered at the bottom of the terminal view for each task, below the input bar.

**Design**: Compact single-line bar:

```
 Tokens: 12.4k in / 3.2k out / 45.1k cache  |  Cost: $0.42  |  Model: Sonnet 4.6
```

- Numbers use compact formatting (e.g., `12.4k`, `1.2M`)
- Click to expand: shows per-model breakdown table
- Updates in real-time via `task:tokenUsage` WebSocket event
- Only visible when `tokenUsage` data exists for the task
- Matches existing UI style (see `SystemStats.tsx` and `TaskSummaryPanel.tsx` patterns)

**Integration point**: Add to the task view layout in the main app component, positioned between the terminal and the input bar, or as a subtle footer below the terminal.

### 5.2 Usage Dashboard Page — `frontend/src/components/UsageDashboard.tsx` (NEW)

**Access**: New tab/button in the sidebar or settings area (alongside existing SystemStats).

**Sections**:

1. **Summary cards** (top row):
   - Total Cost ($)
   - Total Input Tokens
   - Total Output Tokens
   - Total Cache Tokens (creation + read)
   - Total Tasks

2. **By Workspace table**:
   | Workspace | Tasks | Input Tokens | Output Tokens | Cost |
   |-----------|-------|-------------|---------------|------|
   | claudia   | 12    | 245.3k      | 89.1k         | $4.23|
   | my-app    | 5     | 102.1k      | 34.2k         | $1.87|

3. **By Model table**:
   | Model | Tasks | Input Tokens | Output Tokens | Cost |
   |-------|-------|-------------|---------------|------|
   | Sonnet 4.6 | 15 | 312.1k   | 98.3k         | $3.21|
   | Opus 4.6   | 2  | 35.3k    | 25.0k         | $2.89|

4. **Pricing config section** (collapsible):
   - Shows current pricing per model
   - Toggle: "Use default Anthropic pricing" / "Custom enterprise pricing"
   - Editable price fields per model when in custom mode

**Data fetching**: `GET /api/usage/dashboard` on mount + periodic refresh (every 30s).

### 5.3 Store Changes — `frontend/src/stores/taskStore.ts`

Add `tokenUsage` to the task state type and handle the new WebSocket message:

```typescript
// In the store's task type (mirrors shared Task interface)
tokenUsage?: TaskTokenUsage;

// In the WebSocket message handler (useWebSocket.ts)
case 'task:tokenUsage': {
    const { taskId, tokenUsage } = message.payload;
    updateTaskTokenUsage(taskId, tokenUsage);
    break;
}
```

### 5.4 Shared Types Import

The frontend already imports from `@claudia/shared` — the new types (`TaskTokenUsage`, `UsageDashboardData`, `ModelPricing`) will be available automatically.

---

## 6. End-to-End Data Flow

```
1. User creates task
   └─> Claude Code spawns in PTY (interactive mode)

2. Session ID captured (existing flow)
   └─> startSessionCapture() detects new .jsonl file
   └─> task.sessionId = "<uuid>"

3. Claude processes the prompt
   └─> Claude Code writes API responses to ~/.claude/projects/<hash>/<session>.jsonl
   └─> Each assistant message includes usage: { input_tokens, output_tokens, ... }

4. Task transitions busy → idle (checkTaskStates at line 736)
   └─> captureTokenUsage(taskId) called
   └─> token-parser.ts reads session .jsonl
   └─> Aggregates all usage entries, deduplicates by UUID
   └─> task.tokenUsage = { inputTokens, outputTokens, ..., totalCostUsd }

5. Token usage persisted + broadcast
   └─> tasks.json updated with tokenUsage field
   └─> WebSocket event: task:tokenUsage → frontend

6. Frontend updates
   └─> TaskTokenStats bar shows per-task stats
   └─> UsageDashboard aggregates from /api/usage/dashboard

7. On task resume/continue
   └─> Same session file grows with new entries
   └─> Next idle transition re-parses → cumulative totals update
```

---

## 7. File Change Summary

| File | Action | What Changes |
|------|--------|-------------|
| `shared/src/index.ts` | MODIFY | Add `TaskTokenUsage`, `ModelTokenUsage`, `UsageDashboardData`, `ModelPricing` types; extend `Task` with `tokenUsage` field |
| `backend/src/token-parser.ts` | **NEW** | Session JSONL parser for token usage extraction (~150 lines) |
| `backend/src/task-spawner.ts` | MODIFY | Add `captureTokenUsage()` method; hook into state transitions; extend `PersistedTask` and `InternalTask`; add event emission |
| `backend/src/config-store.ts` | MODIFY | Add `tokenPricing` and `tokenTrackingEnabled` to `AppConfig`; add default pricing constants |
| `backend/src/server.ts` | MODIFY | Add `/api/usage/dashboard`, `/api/usage/config` endpoints; handle `taskTokenUsage` WebSocket event |
| `frontend/src/components/TaskTokenStats.tsx` | **NEW** | Per-task token stats bar component (~100 lines) |
| `frontend/src/components/TaskTokenStats.css` | **NEW** | Styles for token stats bar |
| `frontend/src/components/UsageDashboard.tsx` | **NEW** | Full usage dashboard page (~250 lines) |
| `frontend/src/components/UsageDashboard.css` | **NEW** | Dashboard styles |
| `frontend/src/stores/taskStore.ts` | MODIFY | Add `tokenUsage` field handling |
| `frontend/src/hooks/useWebSocket.ts` | MODIFY | Handle `task:tokenUsage` message type |

**Total: 5 new files, 6 modified files**

---

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| JSONL format changes in future Claude Code versions | Token parsing breaks | Version-check the `version` field in JSONL entries; add fallback/skip on parse errors; log warnings |
| Duplicate counting from partial + final assistant entries | Inflated token counts | Deduplicate by UUID — only count entries with `stop_reason` present |
| Session file not yet written when task first goes idle | Missing initial usage data | Retry with backoff (0s, 1s, 3s); file is written continuously during conversation |
| Large session files (long conversations) | Slow parsing, memory | Stream with readline (already proven in conversation-parser.ts); only parse usage fields, skip content |
| Subagent token usage (nested tool results) | Usage could be missed or double-counted | Tool result entries contain separate `usage` from subagents — include these; the parent assistant entry's usage already excludes subagent costs |
| `tsx watch` restart loses in-memory state | Temporary gap in tracking | `tokenUsage` is persisted to `tasks.json` — survives restarts; re-parse on next idle transition fills any gaps |
| Enterprise pricing varies by contract | Default pricing may be wrong | Configurable pricing overrides in settings; UI toggle between default and custom; use CLI's `costUSD` as primary when available |

---

## 9. Testing Plan

### CLI testing (`backend/test-cli.ts`)

Add test commands:

```bash
# Parse token usage for a specific task
npx tsx test-cli.ts --token-usage <taskId>

# Show dashboard data
npx tsx test-cli.ts --usage-dashboard

# Test pricing config
npx tsx test-cli.ts --get-pricing
npx tsx test-cli.ts --set-pricing '{"claude-sonnet-4-6": {"inputPer1MTokens": 5.00, ...}}'
```

### Manual verification

1. Create a task, wait for it to complete
2. Check task token stats appear in the terminal footer
3. Open usage dashboard, verify aggregations match
4. Change pricing config, verify costs recalculate
5. Resume a task, verify cumulative tokens update correctly

### Edge cases to test

- Task with no session ID (capture failed)
- Very long conversation (100+ turns)
- Multiple models in one session (e.g., Sonnet + Haiku via agents)
- Concurrent tasks updating simultaneously
- `tsx watch` restart mid-capture

---

## 10. Future Enhancements (Out of Scope)

- **Time-series charts**: Daily/weekly cost trends with chart.js or recharts
- **Cost alerts**: Configurable thresholds with notifications ("task exceeded $5")
- **Export**: CSV/JSON export of usage data
- **Per-user tracking**: If Claudia supports multiple users in future
- **Real-time streaming**: Strategy C pipe-based approach for live per-turn token display
- **Budget limits**: Auto-stop tasks when budget exceeded (Claude CLI already supports `--max-budget-usd`)
