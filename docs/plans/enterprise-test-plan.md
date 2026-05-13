# Claudia Enterprise Test Plan

## Executive Summary

**Current State:** 399 tests (333 backend, 66 frontend) across 10 test files. All passing.
**Codebase Size:** ~31,600 LOC across backend, frontend, and shared packages.
**Critical Gap:** ~15,000+ lines of production code in 12 critical backend modules and 8 critical frontend modules have **zero test coverage**. No integration tests, no E2E tests, no performance tests exist.

### Coverage by Module

| Module | LOC | Test Cases | Status |
|--------|-----|-----------|--------|
| config-store.ts | ~600 | 67 | Covered |
| conversation-parser.ts | ~400 | 26 | Covered |
| git-utils.ts | ~300 | 23 | Covered |
| ring-buffer.ts | ~150 | 28 | Covered |
| task-spawner-args (in task-spawner) | ~200 | 27 | Covered |
| task-state-detection.ts | ~200 | 58 | Covered |
| token-parser.ts | ~350 | 46 | Covered |
| validation.ts | ~300 | 57 | Covered |
| workspace-store.ts | ~400 | 52 | Covered |
| taskStore.ts (frontend) | ~690 | 66 | Partial |
| **server.ts** | **5,696** | **0** | **NONE** |
| **task-spawner.ts** | **4,298** | **0** | **NONE** |
| **claude-code-backend.ts** | **1,087** | **0** | **NONE** |
| **supervisor-chat.ts** | **1,148** | **0** | **NONE** |
| **cron-scheduler.ts** | **658** | **0** | **NONE** |
| **task-persistence.ts** | **387** | **0** | **NONE** |
| **learnings-store.ts** | **362** | **0** | **NONE** |
| **tunnel-manager.ts** | **455** | **0** | **NONE** |
| **claudia-mcp-server.ts** | **983** | **0** | **NONE** |
| **llm-service.ts** | **164** | **0** | **NONE** |
| **plugin-manager.ts** | **358** | **0** | **NONE** |
| **opencode-backend.ts** | **~400** | **0** | **NONE** |
| **useWebSocket.ts** | **~850** | **0** | **NONE** |
| **All frontend components** | **~8,000** | **0** | **NONE** |

---

## Phase 1: Critical Backend Unit Tests (P0)

These modules have the highest risk and complexity. Testing them first provides the most safety for ongoing development.

### 1.1 Task Persistence (`task-persistence.test.ts`)
**Target: ~25 tests | Estimated effort: Small**

Why first: Pure data layer with no external process dependencies. Easy to test, high value for data integrity.

```
Tests to write:
- loadPersistedTasks
  - loads empty state from missing file
  - loads valid tasks.json with schema version
  - handles corrupted JSON gracefully (falls back to empty)
  - migrates embedded history to separate files
  - loads archived tasks from task-histories/

- saveTasks
  - writes tasks.json with current schema version
  - debounced save coalesces rapid calls
  - atomic write prevents partial file corruption
  - handles write permission errors

- saveTaskHistory / loadTaskHistory
  - round-trips history through base64 encoding
  - loads tail of large history files (maxSize param)
  - creates task-histories/ directory if missing
  - handles missing history file gracefully

- saveArchivedHistory / loadArchivedHistory / deleteArchivedHistory
  - round-trip archived history
  - delete removes file from disk
  - load returns null for missing archive

- Edge cases
  - concurrent save calls don't corrupt data
  - very large history (>10MB) handles truncation correctly
  - task IDs with special characters are safe in filenames
```

### 1.2 Cron Scheduler (`cron-scheduler.test.ts`)
**Target: ~40 tests | Estimated effort: Medium**

Pure logic module with timer management. Critical for scheduled task reliability.

```
Tests to write:
- validateCronExpression
  - accepts valid 5-field expressions ("*/5 * * * *", "0 9 * * 1-5")
  - rejects invalid field counts (4 fields, 6 fields)
  - rejects out-of-range values (minute > 59, hour > 23, etc.)
  - handles step values (*/5, 1-30/5)
  - handles ranges (1-5, 10-20)
  - handles lists (1,3,5)
  - rejects malformed values (abc, -1, 100)

- describeCronExpression
  - generates human-readable descriptions for common patterns
  - handles edge cases (every minute, specific time)

- create / delete / list / get
  - creates scheduled task with valid expression
  - assigns unique 8-char ID
  - enforces 50-task limit per Claudia task
  - delete removes from persistence
  - list filters by taskId when provided
  - get returns null for unknown ID

- Scheduling & firing
  - fires task at correct time when idle
  - queues fire when task is busy
  - fires queued prompt when task becomes idle (onTaskIdle)
  - one-shot tasks auto-delete after firing
  - recurring tasks fire repeatedly

- Expiry
  - recurring tasks expire after 3 days
  - expired tasks are cleaned up on check
  - one-shot tasks don't have expiry (they auto-delete on fire)

- Pause / Resume
  - paused tasks don't fire
  - resumed tasks fire normally
  - pause state persists across saves

- Persistence
  - saves to scheduled-tasks.json on create/delete/update
  - loads scheduled tasks on start()
  - handles corrupted file gracefully

- fireNow
  - immediately fires task if idle
  - queues if task is busy
  - errors for unknown task
```

### 1.3 Learnings Store (`learnings-store.test.ts`)
**Target: ~30 tests | Estimated effort: Medium**

Data persistence + search logic. Mock the embedding API.

```
Tests to write:
- addLearning
  - stores learning with generated ID and timestamp
  - calls embedding API with learning text
  - saves to learnings.json
  - associates with workspace when provided

- searchLearnings
  - returns top-K results by cosine similarity
  - filters by workspace when provided
  - combines similarity score with utility score
  - handles empty store (returns empty array)
  - handles dimension mismatch in embeddings

- Cosine similarity (internal)
  - correct calculation for known vectors
  - handles zero vectors
  - handles single-dimension vectors

- updateUtility (MemRL)
  - increases utility on success (learningRate applied)
  - decreases utility on failure
  - clamps utility to [0, 1] range
  - default utility starts at 0.5

- recordRetrieval
  - increments retrievalCount for each learning
  - updates lastRetrievedAt timestamp

- deleteLearning / updateLearning
  - removes learning from store
  - update regenerates embedding when content changes
  - update preserves ID and timestamps

- formatForContext
  - formats learnings as numbered list
  - truncates very long content

- Persistence
  - loads from learnings.json on construction
  - handles missing file (starts empty)
  - handles corrupted JSON (starts empty)

- Edge cases
  - embedding API failure (fetch error) - should still save, skip embedding
  - very long text truncation for embedding
```

### 1.4 LLM Service (`llm-service.test.ts`)
**Target: ~15 tests | Estimated effort: Small**

Thin wrapper - quick to test with HTTP mocking.

```
Tests to write:
- initializeLLMService
  - stores config reference

- generateLLMResponse
  - sends correct payload to /v1/messages
  - respects model from config
  - respects LLM_MODEL env override
  - handles successful response (extracts text)
  - handles API error (non-200 status)
  - handles timeout (60s AbortController)
  - handles empty response content

- generatePlanResponse
  - uses planning-specific system prompt
  - passes user request as user message

- generateConversationalResponse
  - uses conversational system prompt
  - includes intent in system prompt

- generateTaskCreatedResponse
  - includes task name and description
```

### 1.5 Claude Code Backend (`claude-code-backend.test.ts`)
**Target: ~45 tests | Estimated effort: Large**

Critical process management. Requires careful mocking of node-pty.

```
Tests to write:
- initialize / shutdown
  - starts state polling interval
  - shutdown clears all intervals and kills processes

- createTask
  - spawns PTY with correct CLI arguments
  - sets working directory to workspace path
  - emits task:stateChanged on creation
  - handles spawn failure (node-pty error)
  - starts session capture polling
  - sets environment variables correctly

- sendInput
  - writes to PTY stdin
  - handles character-by-character mode (slowly option)
  - rejects input for non-existent task

- resizeTask
  - calls PTY resize with cols/rows
  - no-ops for non-existent task

- interruptTask / stopTask
  - sends ESC character to PTY
  - updates task state

- destroyTask
  - kills PTY process
  - clears intervals (session capture, state polling)
  - removes task from internal map
  - emits task:exit event

- State detection
  - detects idle state from output patterns
  - detects busy state from processing indicators
  - detects waiting_input from question patterns
  - handles rapid state transitions

- Session capture
  - polls for .jsonl files in ~/.claude/projects/
  - emits task:sessionCaptured when found
  - times out after 30 seconds
  - stops polling on task exit

- Output history
  - buffers output up to 2MB limit
  - getTaskHistory returns accumulated output
  - setTaskActive(false) trims history for memory

- Git state tracking
  - setGitStateBefore stores state
  - updateGitState captures after state
  - getGitStateBefore returns stored state

- Auth warning filtering
  - strips auth conflict warnings from output

- reconnectTask
  - spawns new PTY with --continue flag
  - restores session ID
```

### 1.6 Task Spawner (`task-spawner.test.ts`)
**Target: ~50 tests | Estimated effort: Large**

Orchestration layer over backends. Mock the backend interface.

```
Tests to write:
- createTask
  - creates task with unique ID and metadata
  - delegates to backend.createTask
  - captures git state before task starts
  - emits taskCreated event
  - persists task to disk
  - validates workspace exists
  - handles backend spawn failure gracefully

- destroyTask
  - delegates to backend.destroyTask
  - removes task from internal map
  - emits taskDestroyed event
  - persists updated task list

- writeToTask
  - delegates to backend.sendInput
  - handles non-existent task

- reconnectTask
  - captures current git state
  - delegates to backend.reconnectTask
  - updates task metadata

- archiveTask
  - saves task history to archive directory
  - removes from active tasks
  - emits taskArchived event
  - persists changes

- revertTask
  - calls git revert with before/after state
  - emits revert result
  - handles revert failure (too many commits, missing commit)
  - refuses revert when canRevert is false

- Token usage
  - getTaskTokenUsage parses session files
  - emits taskTokenUsage event
  - handles missing session files

- Event forwarding
  - forwards backend task:stateChanged events
  - forwards backend task:output events
  - forwards backend task:waitingInput events
  - forwards backend task:sessionCaptured events

- Task queries
  - getTask returns task by ID
  - getAllTasks returns all tasks
  - getTasksByWorkspace filters correctly

- State persistence
  - auto-saves on task state changes (debounced)
  - loads persisted tasks on initialization
```

### 1.7 Supervisor Chat (`supervisor-chat.test.ts`)
**Target: ~35 tests | Estimated effort: Large**

Complex module with tool calling, rate limiting, and concurrency control.

```
Tests to write:
- sendMessage
  - adds user message to chat history
  - processes with Claude analysis
  - emits message event with response
  - handles empty message
  - disabled when supervisor not enabled in config

- Rate limiting
  - allows up to 10 spawns per minute
  - rejects when rate limit exceeded
  - clears old timestamps from window

- Concurrency control
  - limits to MAX_CONCURRENT_ANALYSIS (2)
  - queues excess analysis requests
  - processes queue when analysis completes
  - prevents duplicate analysis for same task

- Tool calling
  - create_task tool creates task via spawner
  - delete_task tool destroys task
  - send_message_to_task writes input
  - list_tasks returns formatted task list
  - get_task_conversation returns conversation history
  - handles tool call errors gracefully

- Chat history
  - trims to 200 messages
  - persists to chat-history.json
  - loads history on initialization
  - scopes history by workspace
  - scopes history by task

- clearHistory / clearTaskHistory
  - clears all messages
  - clears only task-specific messages
  - emits appropriate events
  - persists changes

- Auto-analysis
  - triggers analysis on task state change
  - skips analysis if already processing this task
  - includes task output in analysis context

- Error handling
  - handles Claude process timeout
  - handles malformed JSON response
  - handles process crash mid-analysis
```

### 1.8 Plugin Manager (`plugin-manager.test.ts`)
**Target: ~25 tests | Estimated effort: Medium**

Dynamic loading with Express route registration. Use temp plugin directories.

```
Tests to write:
- discoverPlugins
  - finds plugins in plugin directory
  - loads plugin.json manifests
  - initializes each plugin
  - skips invalid manifests
  - handles empty plugin directory

- loadPlugin
  - dynamic imports plugin entry point
  - calls plugin.initialize()
  - registers plugin routes
  - handles import failure gracefully
  - handles missing entry point

- getPlugins / getPlugin
  - returns all loaded plugins
  - finds plugin by name
  - returns undefined for unknown plugin

- getPluginByApiMode
  - finds plugin matching API mode
  - returns undefined when no match

- registerRoutes
  - mounts ai-provider plugins at /v1
  - mounts other plugins at /plugins/{name}/
  - handles plugin with no routes

- getTaskEnvironment
  - returns env vars from plugin
  - returns empty object for unknown plugin

- validatePluginConfig
  - delegates to plugin validation
  - handles validation errors

- testPluginConnection
  - delegates to plugin test method
  - handles connection failure

- shutdown
  - calls shutdown on each plugin
  - handles individual shutdown errors
  - clears plugin maps
```

### 1.9 Tunnel Manager (`tunnel-manager.test.ts`)
**Target: ~20 tests | Estimated effort: Medium**

Process management with retry logic. Mock child_process and fetch.

```
Tests to write:
- start
  - spawns ngrok process
  - polls tunnel API for URL
  - emits tunnel:ready with URL
  - retries up to 3 times with exponential backoff (2s, 4s, 6s)
  - times out after 30 seconds of polling
  - handles ngrok not installed

- stop
  - kills ngrok process
  - clears adopted monitor interval
  - emits tunnel:closed

- getStatus
  - returns active tunnel URL and token
  - returns inactive when not started

- autoRecover
  - detects orphaned ngrok process via API
  - adopts orphaned tunnel
  - times out adoption check after 2 seconds

- validateToken
  - accepts valid UUID token
  - rejects invalid token

- setPort
  - updates port for dynamic scenarios

- Error handling
  - early process exit triggers retry
  - fetch failure during polling
  - process tree kill on Windows (taskkill /T)
```

### 1.10 OpenCode Backend (`opencode-backend.test.ts`)
**Target: ~15 tests | Estimated effort: Medium**

Mirrors claude-code-backend patterns. Reuse mocking strategy from 1.5.

```
Tests to write:
- createTask / destroyTask / sendInput / resizeTask
  - same lifecycle tests as claude-code-backend
  - uses OpenCode-specific CLI arguments
  - handles OpenCode HTTP API communication

- State detection
  - detects idle/busy/waiting states from OpenCode output
  - handles OpenCode-specific output format differences
```

### 1.11 Utilities (`utils.test.ts`)
**Target: ~15 tests | Estimated effort: Small**

Foundational utilities used by all persistence layers.

```
Tests to write:
- atomicWriteFileSync
  - writes file atomically (temp + rename)
  - handles write failure without corrupting original
  - creates parent directory if missing
  - handles concurrent writes

- loadVersioned / saveVersioned
  - round-trips data with schema version
  - returns default for missing file
  - returns default for corrupted JSON
  - handles version migration (old → current)
```

---

## Phase 2: Server & WebSocket Integration Tests (P0)

### 2.1 REST API Endpoints (`server-rest.test.ts`)
**Target: ~60 tests | Estimated effort: Large**

Use supertest to test HTTP endpoints without starting a real server.

```
Tests to write:
- Health & Status
  - GET /api/health returns { status: 'ok' }
  - GET /api/backend/status returns backend info

- Task CRUD
  - GET /api/tasks returns all tasks
  - GET /api/tasks/:taskId/status returns task info
  - GET /api/tasks/:taskId/output returns recent output
  - DELETE /api/tasks/:taskId destroys task
  - GET /api/task/:taskId/history returns paginated history
  - PUT /api/tasks/:taskId/rename updates name

- Workspace CRUD
  - GET /api/workspaces returns all workspaces
  - POST /api/workspaces creates workspace (valid path)
  - POST /api/workspaces rejects invalid path
  - DELETE /api/workspaces/:id removes workspace

- Config
  - GET /api/config returns current config
  - PUT /api/config updates config fields
  - PUT /api/config rejects invalid values

- Cron endpoints
  - GET /api/cron lists all scheduled tasks
  - POST /api/tasks/:taskId/cron creates schedule
  - DELETE /api/cron/:cronId removes schedule
  - PUT /api/cron/:cronId updates schedule

- File operations
  - POST /api/upload/image accepts image upload
  - DELETE /api/upload/image/:filename removes image
  - GET /api/workspaces/files returns file tree
  - GET /api/workspaces/read-file returns file content

- Learnings
  - GET /api/learnings returns all learnings
  - POST /api/learnings creates learning
  - PUT /api/learnings/:id updates learning
  - DELETE /api/learnings/:id deletes learning
  - POST /api/learnings/search returns search results

- Error handling
  - 404 for unknown task IDs
  - 400 for malformed request bodies
  - 500 for internal server errors (mock failures)
```

### 2.2 WebSocket Message Handlers (split into domain files)
**Target: ~70 tests | Estimated effort: Very Large**

Split by domain for maintainability. Use a shared WS test harness that creates a real Express+WS server with mocked backends.

#### `server-ws-tasks.test.ts` (~30 tests)
```
- Connection lifecycle
  - accepts WebSocket upgrade
  - sends init message on connect
  - handles client disconnect cleanup
  - rejects invalid JSON messages
  - rejects unknown message types

- Task operations (14 handlers)
  - task:create with valid params creates task
  - task:create missing prompt returns MISSING_PARAMS error
  - task:create invalid workspace returns INVALID_WORKSPACE error
  - task:create invalid complexity returns INVALID_COMPLEXITY error
  - task:select activates task
  - task:input sends input to task
  - task:input injects context updates when references changed
  - task:resize resizes terminal
  - task:destroy removes task
  - task:stop sends interrupt
  - task:stopAll stops all workspace tasks
  - task:interrupt sends ESC
  - task:archive archives task
  - task:rename updates display name
  - task:rename with source='user' locks from agent rename
  - task:reorder reorders tasks
  - task:reconnect reconnects disconnected task
  - task:revert reverts git changes
  - task:restore sends terminal history

- Archived task operations
  - task:archived:list returns archived tasks
  - task:archived:restore restores task
  - task:archived:continue restores and reconnects
  - task:archived:delete permanently removes
```

#### `server-ws-workspaces.test.ts` (~15 tests)
```
- workspace:create adds workspace
- workspace:delete removes workspace
- workspace:reorder reorders workspaces
- workspace:rename renames workspace
- workspace:browseFolder opens folder picker
- workspace:reset archives all tasks + checkout main
- workspace:systemPrompt:get/set round-trips prompt
- workspace:references:add/remove/toggle manages references
- workspace:recent:list returns recent workspaces
- workspace:recent:clear clears recent list
```

#### `server-ws-shell.test.ts` (~10 tests)
```
- shell:create spawns shell PTY
- shell:input sends input to shell
- shell:resize resizes shell terminal
- shell:close closes shell and emits exit
- shell output broadcasts to connected clients
```

#### `server-ws-supervisor.test.ts` (~8 tests)
```
- supervisor:chat:message sends message and receives response
- supervisor:chat:history returns chat history
- supervisor:chat:clear clears history
- supervisor:action executes suggested action
- supervisor:analyze triggers manual analysis
```

#### `server-ws-broadcast.test.ts` (~7 tests)
```
- broadcasts task:stateChanged to all connected clients
- broadcasts task:output to all connected clients
- batches state changes within 150ms window
- deduplicates tasks:updated broadcasts
- tunnel:status broadcasts tunnel state changes
- cron:fired broadcasts when scheduled task fires
```

### 2.3 MCP Server (`claudia-mcp-server.test.ts`)
**Target: ~30 tests | Estimated effort: Medium**

Test each of the 11 MCP tools. Mock HTTP/WebSocket calls to backend.

```
Tests to write:
- claudia_list_tasks
  - returns tasks filtered by workspace
  - returns empty list for no tasks

- claudia_get_task_status
  - returns status with output snippet
  - handles unknown task ID

- claudia_get_task_output
  - returns recent output up to maxBytes
  - caps at 32KB maximum
  - handles missing task

- claudia_create_task
  - creates task via WebSocket
  - applies optional complexity hint
  - optional rename after creation

- claudia_send_input
  - sends input to waiting_input task
  - rejects when task not in waiting state

- claudia_continue_task
  - sends follow-up prompt to idle task

- claudia_stop_task
  - sends ESC interrupt
  - prevents stopping self (CLAUDIA_TASK_ID check)

- claudia_stop_all_tasks
  - stops all workspace tasks
  - excludes calling task

- claudia_rename_task
  - sets display name
  - respects user-edited names (displayNameEditedByUser flag)

- claudia_cron_create/list/delete/pause
  - creates scheduled task
  - lists scheduled tasks
  - deletes by cronId
  - pauses/resumes

- Error handling
  - timeout after 30 seconds
  - backend unavailable
  - invalid parameters (zod validation)
```

---

## Phase 3: Frontend Tests (P1)

### 3.1 useWebSocket Hook (`useWebSocket.test.ts`)
**Target: ~40 tests | Estimated effort: Large**

Mock WebSocket. Test message dispatching, reconnection, state management.

```
Tests to write:
- Connection
  - creates WebSocket to backend URL
  - handles tunnel warmup (HTTP before WS)
  - reconnects with exponential backoff (1s base, 30s max)
  - stops reconnecting on explicit disconnect

- Message dispatching
  - init message hydrates tasks and workspaces
  - task:created adds task to store
  - task:stateChanged updates task in store
  - task:output dispatches to terminal
  - task:waitingInput triggers notification
  - task:destroyed removes task from store
  - supervisor:chat:response adds chat message
  - supervisor:chat:typing sets typing indicator
  - error message shows error notification
  - server:reloading sets reloading flag

- Auto-focus logic
  - focuses task on waiting_input when autoFocusOnInput enabled
  - does not focus when autoFocusOnInput disabled
  - dispatches terminal:scrollToBottom events

- Send function
  - sends JSON message when WS open
  - no-ops when WS not open
  - skips logging for high-frequency messages

- State regression prevention
  - does not regress task state from newer to older

- Cleanup
  - closes WebSocket on unmount
  - clears event listeners
```

### 3.2 Task Store Extensions (`taskStore.test.ts` - additions)
**Target: ~25 tests | Estimated effort: Small**

Add missing test coverage to existing test file.

```
Tests to add:
- Scheduled tasks
  - setScheduledTasks replaces all
  - addScheduledTask appends
  - removeScheduledTask removes by ID
  - getScheduledTasksForTask filters by taskId

- Activity tracking
  - addActivityEvent appends event
  - clearTaskUnread resets unread count
  - clearAllActivityLog clears everything

- Sort preferences
  - setWorkspaceColumns persists
  - setWorkspaceSortBy persists
  - setTaskSortBy persists

- Token usage
  - updateTaskTokenUsage sets usage data
  - handles unknown taskId gracefully

- Chat deduplication
  - addChatMessage skips duplicate IDs

- Persisted state
  - localStorage round-trip preserves Map/Set types
  - handles corrupted localStorage gracefully
```

### 3.3 Component Tests (Selective)
**Target: ~30 tests | Estimated effort: Medium**

Test business logic extracted from components. Use @testing-library/react.

```
SupervisorChat.tsx:
  - groups messages into threads by taskId
  - sorts threads by most recent message
  - tracks unread counts per thread
  - marks thread as read on expand
  - formats relative timestamps correctly

TaskInputBar.tsx:
  - persists draft input per task
  - restores draft when switching tasks
  - clears draft on send
  - disables send when WebSocket disconnected
  - appends image paths to message

WorkspaceManager.tsx:
  - filters workspaces by search query
  - bulk select/deselect
  - confirms before bulk delete
```

---

## Phase 4: Integration & E2E Tests (P1)

### 4.1 WebSocket Integration (`integration/websocket-flow.test.ts`)
**Target: ~20 tests | Estimated effort: Large**

Spin up real Express server with mocked backends. Test full request/response flows.

```
Tests to write:
- Full task lifecycle
  - create task -> receive task:created -> receive task:stateChanged -> task completes
  - create task -> send input -> receive output -> task completes
  - create task -> archive -> list archived -> restore

- Multi-client scenarios
  - two clients see same task updates
  - client disconnect doesn't affect other clients
  - task created by one client visible to another

- Workspace operations
  - create workspace -> create task in workspace -> delete workspace

- Error scenarios
  - backend spawn failure propagates error to client
  - task destroy during active processing
```

### 4.2 E2E Tests with Playwright (`e2e/`)
**Target: ~15 tests | Estimated effort: Very Large**

Test critical user workflows through the browser.

```
Tests to write:
- Basic flows
  - load app, see workspace panel
  - create workspace from path
  - create task with prompt
  - see task output in terminal
  - switch between tasks

- Workspace management
  - add workspace via browse button
  - rename workspace
  - delete workspace with confirmation
  - drag-drop workspace reorder

- Task interaction
  - send input to waiting task
  - stop running task
  - archive completed task
  - restore archived task

- Settings
  - open settings menu
  - change API mode
  - configure MCP server
```

---

## Phase 5: Robustness & Security Tests (P2)

### 5.1 Concurrency & Race Conditions (`stress/concurrency.test.ts`)
**Target: ~15 tests | Estimated effort: Medium**

```
Tests to write:
- Rapid task create/destroy cycles
- Concurrent WebSocket messages from multiple clients
- Simultaneous config updates
- Debounced save under rapid mutations
- State polling during task state transitions
```

### 5.2 Security Tests (`security/`)
**Target: ~20 tests | Estimated effort: Medium**

```
Tests to write:
- Input validation
  - path traversal in workspace paths (../../etc/passwd)
  - null bytes in filenames
  - ANSI injection in prompts
  - XSS in task names/prompts
  - very long inputs (>1MB prompts)

- WebSocket security
  - malformed JSON doesn't crash server
  - unknown message types rejected
  - oversized messages handled

- File operations
  - symlink traversal prevention
  - workspace path validation (no system dirs)
  - task ID sanitization in file paths

- Process security
  - CLI argument injection prevention
  - environment variable sanitization
```

### 5.3 Error Recovery (`recovery/`)
**Target: ~10 tests | Estimated effort: Medium**

Note: Data corruption recovery for individual stores (tasks.json, config.json, learnings.json) is already covered in Phase 1 unit tests. These tests focus on **cross-module recovery** and **multi-step failure scenarios** that unit tests can't cover.

```
Tests to write:
- Multi-component recovery
  - server restart with corrupted tasks.json + valid config → partial recovery
  - task output write fails mid-stream → buffer state remains consistent
  - archive operation interrupted → no orphaned files

- Process failure cascades
  - PTY crash during active WebSocket broadcast → clients notified, no hang
  - supervisor analysis timeout during task state change → queue drains
  - cron fires while task is mid-reconnect → prompt queued correctly

- Graceful degradation
  - embedding API unreachable → learnings store works without search
  - tunnel process dies → auto-recovery or clean error state
```

---

## Phase 6: Performance & Monitoring (P2)

### 6.1 Performance Benchmarks (`perf/`)
**Target: ~10 tests | Estimated effort: Medium**

```
Tests to write:
- WebSocket message throughput (messages/sec)
- Terminal output rendering (bytes/sec)
- Task creation latency
- State detection accuracy under load
- History load time for large files (>5MB)
- Cron scheduler accuracy (drift measurement)
```

---

## Implementation Order & Dependencies

```
Phase 1 (Weeks 1-3): Backend Unit Tests
  1.11 utils.test.ts               [no deps, foundational - start here]
  1.1  task-persistence.test.ts    [depends on 1.11 for atomic-write]
  1.2  cron-scheduler.test.ts      [no deps]
  1.3  learnings-store.test.ts     [no deps]
  1.4  llm-service.test.ts         [no deps]
  1.5  claude-code-backend.test.ts [mock node-pty]
  1.6  task-spawner.test.ts        [depends on 1.5 patterns]
  1.7  supervisor-chat.test.ts     [depends on 1.6 patterns]
  1.8  plugin-manager.test.ts      [no deps]
  1.9  tunnel-manager.test.ts      [no deps]
  1.10 opencode-backend.test.ts    [reuse 1.5 patterns]

Phase 2 (Weeks 3-5): Server Integration Tests
  2.1 server-rest.test.ts           [depends on Phase 1 mocks]
  2.2 server-ws-{domain}.test.ts    [depends on Phase 1 mocks, split by domain]
  2.3 claudia-mcp-server.test.ts    [depends on 2.1/2.2 patterns]

Phase 3 (Weeks 5-6): Frontend Tests
  3.1 useWebSocket.test.ts         [mock WebSocket]
  3.2 taskStore extensions         [no deps]
  3.3 component tests              [depends on 3.1]

Phase 4 (Weeks 6-8): Integration & E2E
  4.1 WebSocket integration        [depends on Phase 2]
  4.2 Playwright E2E               [depends on running app]

Phase 5 (Weeks 8-9): Robustness & Security
  5.1 Concurrency tests            [depends on Phase 2]
  5.2 Security tests               [depends on Phase 1]
  5.3 Recovery tests (cross-module) [depends on Phase 2]

Phase 6 (Week 10): Performance
  6.1 Performance benchmarks       [depends on Phase 4]
```

## Infrastructure Requirements

### Test tooling to add:
- **supertest** - HTTP endpoint testing without server startup
- **mock-socket** or **ws** mock - WebSocket testing
- **MSW (Mock Service Worker)** - HTTP mocking for frontend
- **Playwright** - E2E browser testing
- **vitest coverage thresholds** - Enforce minimum coverage in CI

Note: `@testing-library/react-hooks` is deprecated and merged into `@testing-library/react` (already installed). Use `renderHook` from `@testing-library/react` directly.

### CI/CD enhancements:
- Add coverage reporting to GitHub Actions
- Set coverage thresholds (start at 40%, target 70%)
- Add Playwright E2E job (separate from unit tests)
- Add performance regression detection

### vitest.config.ts updates needed:
```typescript
// backend/vitest.config.ts
coverage: {
  thresholds: {
    lines: 40,    // start here, increase over time
    functions: 40,
    branches: 30,
    statements: 40
  }
}
```

## Test Count Summary

| Phase | Tests | Priority |
|-------|-------|----------|
| Phase 1: Backend Unit Tests (1.1-1.11) | ~315 | P0 |
| Phase 2: Server Integration | ~160 | P0 |
| Phase 3: Frontend Tests | ~95 | P1 |
| Phase 4: Integration & E2E | ~35 | P1 |
| Phase 5: Robustness & Security | ~45 | P2 |
| Phase 6: Performance | ~10 | P2 |
| **Total New Tests** | **~660** | |
| **Existing Tests** | **399** | |
| **Grand Total** | **~1,059** | |

## Key Risks If Tests Are Not Written

1. **Data loss** - Task persistence has no tests for corruption recovery. A bad deploy could lose all task history.
2. **Process leaks** - PTY process management is untested. Zombie processes could exhaust system resources.
3. **State corruption** - No concurrency tests for the task state machine. Race conditions in WebSocket handlers could corrupt task state silently.
4. **Security vulnerabilities** - No path traversal or injection tests. Workspace paths and CLI arguments are built from user input.
5. **Regression risk** - 15,000+ LOC of untested code means any refactor is a gamble.
6. **Cron reliability** - Scheduled tasks have no tests for timing accuracy, expiry, or persistence. Critical for autonomous agent workflows.
