# Claudia Feature Brainstorm: Next-Generation Capabilities

## Current State Summary

Claudia (v0.2.26) is already a capable orchestrator with:
- **PTY-based task management** with state detection via output polling
- **Claudia MCP Server** (experimental) for basic inter-agent communication
- **Supervisor Chat** with tool-calling AI for task analysis
- **Learnings Store** with vector embeddings/RAG
- **Plugin System** for extensibility
- **Backend Abstraction** (Claude Code + OpenCode)
- **Git Integration** with before/after state capture and revert
- **Mobile Access** via ngrok tunnels

---

## 1. Agent Collaboration

### 1a. Shared Context/Memory (Priority: HIGH)

**Current gap:** Agents can only read each other's terminal output via `claudia_get_task_output`. There's no structured shared memory.

**Workspace Scratchpad**
- A per-workspace key-value store accessible to all agents via MCP tools
- Tools: `claudia_scratchpad_write(key, value)`, `claudia_scratchpad_read(key)`, `claudia_scratchpad_list()`, `claudia_scratchpad_subscribe(key)` (get notified on changes)
- Use cases: Agent A discovers an API schema, writes it to scratchpad, Agent B reads it when building the client
- Implementation: Add `scratchpad-store.ts` + new MCP tools in `claudia-mcp-server.ts`
- Storage: `backend/scratchpad/{workspaceHash}/{key}.json` with metadata (who wrote, when, TTL)

**Artifact Registry**
- Structured output artifacts (not just terminal text): code snippets, test results, analysis reports, file diffs
- Tools: `claudia_publish_artifact(type, name, content, metadata)`, `claudia_get_artifact(id)`, `claudia_search_artifacts(query)`
- Types: `code`, `analysis`, `test-result`, `decision`, `plan`, `review`
- These would persist beyond task lifetime, building workspace knowledge

**Context Broadcast Channel**
- Real-time pub/sub for agents in the same workspace
- Tools: `claudia_broadcast(channel, message)`, `claudia_subscribe(channel)`
- Channels: `discoveries`, `blockers`, `decisions`, `progress`
- Backend: WebSocket relay through existing infrastructure

### 1b. Agent-to-Agent Communication Patterns (Priority: HIGH)

**Current gap:** The MCP server only supports one-way communication (read output, send input). No structured request/response or streaming patterns.

**Request/Response Protocol**
- `claudia_request(targetTaskId, question, timeout)` blocks until target responds
- Target agent sees incoming request via MCP notification
- `claudia_respond(requestId, answer)` sends response back
- Implementation: Use WebSocket + pending request map in the MCP server
- Enables: Agent A asks Agent B "What's the schema for the user table?" and gets structured answer

**Agent Roles & Capabilities Registry**
- Agents can declare their specializations: `claudia_register_capability(role, description)`
- Other agents can discover: `claudia_find_agent(capability_query)` returns taskIds
- Roles: `code-reviewer`, `test-writer`, `architect`, `security-auditor`, `docs-writer`
- Enables dynamic team formation without hardcoded task IDs

**Delegation Protocol**
- `claudia_delegate(prompt, capabilities_needed, priority, callback)` creates subtask and returns when complete
- Synchronous delegation: calling agent waits for result
- Asynchronous delegation: calling agent gets notified via callback
- Auto-selects or creates the right agent based on capabilities

### 1c. Hierarchical Task Decomposition (Priority: HIGH)

**Current gap:** All tasks are flat siblings. No parent-child relationships, no dependency tracking.

**Task Trees**
- New fields: `parentTaskId`, `childTaskIds[]`, `dependsOn[]` in Task model
- Parent tasks can spawn subtasks: `claudia_create_subtask(prompt, dependsOn?)`
- Subtask results automatically flow back to parent
- Visual tree in the UI (indented task list or tree view)
- Parent task gets summary of child task outcomes

**Task Dependency Graph**
- Define dependencies between tasks: "Run tests AFTER code changes are complete"
- `claudia_create_task_with_deps(prompt, dependsOn: taskId[])`
- Tasks in `waiting` state until dependencies resolve to `idle/exited`
- Topological sort for execution order
- Circular dependency detection
- Visual DAG in the UI

**Map-Reduce Task Pattern**
- `claudia_map(prompts[], workspace)` spawns N parallel tasks
- `claudia_reduce(taskIds[], aggregation_prompt)` single task that processes all outputs
- Use case: "Review all 20 files in this PR" maps to 20 parallel review agents, reduces to single summary
- Built on top of task trees and dependency graphs

### 1d. Consensus/Voting Mechanisms (Priority: MEDIUM)

**Multi-Agent Review**
- `claudia_review_request(content, reviewerCount, strategy)`
- Strategies: `unanimous`, `majority`, `any-approve`, `weighted`
- Each reviewer agent independently analyzes and votes
- Aggregation: structured JSON votes to final decision
- Use case: Code changes go through 3 independent AI reviewers before merge

**Debate Protocol**
- Two agents argue opposing positions on a design decision
- Third agent (or supervisor) judges
- Structured format: thesis, antithesis, rebuttals, verdict
- Reduces hallucination risk through adversarial validation

---

## 2. Workflow Automation

### 2a. CI/CD Integration (Priority: HIGH)

**GitHub Webhook Handler**
- New endpoint: `POST /api/webhooks/github` with signature verification
- Events to handle:
  - `pull_request.opened` - Auto-spawn review agent
  - `pull_request.synchronize` - Re-review on new commits
  - `issue_comment.created` - Agent responds to @mentions
  - `push` to main - Run test/lint agent
  - `issues.opened` - Triage agent assigns labels and priority
- Configuration: Per-workspace webhook settings with event filters
- Templates: Map GitHub events to task prompts

**PR Review Pipeline**
- Automatic multi-stage review:
  1. Security scan agent - checks for vulnerabilities
  2. Code quality agent - style, complexity, best practices
  3. Test coverage agent - identifies untested paths
  4. Architecture agent - checks for design violations
- Results posted as GitHub PR comments via `gh` CLI
- Blocking: Can mark checks as pass/fail
- Configuration: Which stages to run, thresholds, auto-approve rules

**Post-Merge Actions**
- On merge to main: Auto-spawn agents for:
  - Changelog generation
  - Documentation updates
  - Dependency audits
  - Performance regression checks

### 2b. Scheduled/Cron-Based Tasks (Priority: HIGH)

**Current gap:** No scheduling capability at all.

**Task Scheduler**
- New store: `scheduler-store.ts`
- Cron syntax: `"0 9 * * MON"` for "Every Monday at 9 AM"
- Interval syntax: `"every 30m"`, `"every 2h"`, `"daily"`
- Schedule definition:
  ```typescript
  interface ScheduledTask {
    id: string;
    name: string;
    prompt: string;
    workspaceId: string;
    schedule: string; // cron expression
    enabled: boolean;
    lastRun?: Date;
    nextRun?: Date;
    maxConcurrent: number;
    onFailure: 'retry' | 'notify' | 'disable';
    retryCount: number;
    tags: string[];
  }
  ```
- UI: Schedule management panel in settings
- WebSocket messages: `schedule:create`, `schedule:update`, `schedule:delete`, `schedule:list`
- Use cases:
  - Daily code quality reports
  - Hourly dependency vulnerability checks
  - Weekly documentation freshness audits
  - Nightly full test suite runs

### 2c. Event-Driven Pipelines (Priority: MEDIUM)

**File Watcher Triggers**
- Watch workspace directories for changes using `chokidar`
- Configurable patterns: `"src/**/*.ts"`, `"*.config.*"`, `"package.json"`
- Debounced triggers (don't fire on every keystroke)
- Actions: spawn task, send input to existing task, run command
- Use case: Auto-run tests when source files change

**Pipeline Definition Language**
- YAML-based workflow definitions stored per workspace:
  ```yaml
  name: "PR Review Pipeline"
  trigger:
    type: webhook
    event: pull_request.opened
  steps:
    - name: security-scan
      prompt: "Scan this PR for security vulnerabilities..."
      parallel: true
    - name: code-review
      prompt: "Review code quality..."
      parallel: true
    - name: aggregate
      prompt: "Combine reviews from {security-scan} and {code-review}..."
      dependsOn: [security-scan, code-review]
  on_complete:
    action: github-comment
    template: "## AI Review Summary\n{aggregate.output}"
  ```
- Pipeline executor in backend
- UI for visual pipeline builder (drag-and-drop)

**Task Chains**
- Simple linear pipelines: Task A (on idle) Task B (on idle) Task C
- Each task receives previous task's output as context
- Error handling: retry, skip, abort chain
- Implementation: `nextTaskPrompt` field on Task model

### 2d. Template-Based Task Patterns (Priority: MEDIUM)

**Task Templates**
- Pre-defined prompt templates with variables:
  ```typescript
  interface TaskTemplate {
    id: string;
    name: string;
    description: string;
    category: 'review' | 'testing' | 'docs' | 'refactor' | 'custom';
    promptTemplate: string; // "Review {{file}} for {{criteria}}"
    variables: TemplateVariable[];
    defaultWorkspace?: string;
    systemPrompt?: string;
    tags: string[];
  }
  ```
- Template library UI with search/filter
- Community templates (import/export JSON)
- Quick-launch: Click template, fill variables, spawn task
- Built-in templates:
  - "Code Review" - reviews files/PRs
  - "Write Tests" - generates test suites
  - "Refactor" - restructures code
  - "Document" - generates documentation
  - "Debug" - investigates and fixes issues
  - "Security Audit" - scans for vulnerabilities

---

## 3. Intelligence Layer

### 3a. Task Priority & Resource Management (Priority: HIGH)

**Current gap:** No limits on concurrent tasks. No priority system. Supervisor has rate limiting (10/min, 2 concurrent) but tasks themselves don't.

**Concurrency Manager**
- Global max concurrent tasks (configurable, default: 5)
- Per-workspace limits
- Priority queue: `urgent`, `high`, `normal`, `low`, `background`
- Resource-aware scheduling: check system memory/CPU before spawning
- Preemption: Pause low-priority tasks when urgent tasks arrive
- Queue UI: Show pending tasks, estimated wait times

**Cost Tracking & Budgets**
- Parse Claude Code's cost output from terminal
- Per-task cost tracking: `costUsd` field on Task
- Per-workspace daily/weekly/monthly budgets
- Alerts at thresholds (50%, 80%, 100%)
- Auto-pause tasks when budget exceeded
- Cost analytics dashboard: charts, trends, per-workspace breakdown
- Implementation: Parse `"Total cost: $X.XX"` from task output via regex

**Smart Throttling**
- Detect system resource pressure (memory, CPU)
- Auto-throttle: delay new task spawns when system is under pressure
- Auto-pause: hibernate idle tasks consuming memory
- Health monitoring: track per-task resource usage

### 3b. Learning from Past Task Outcomes (Priority: HIGH)

**Current gap:** Learnings store exists but doesn't automatically capture outcomes. No feedback loop.

**Automatic Outcome Tracking**
- On task exit, auto-classify outcome: `success`, `partial`, `failure`, `timeout`, `user-cancelled`
- Classification via: exit code, output analysis, git state (did it make commits?), user signals
- Store: `task-outcomes.json` with searchable metadata
- Metrics: success rate by workspace, prompt type, time of day

**Prompt Optimization Engine**
- Track which prompts lead to good outcomes
- A/B test prompt variations automatically
- Suggest prompt improvements based on past failures
- "Similar tasks that succeeded used these prompts..."
- Implementation: Vector similarity on prompts + outcome correlation

**Failure Pattern Detection**
- Detect recurring failure patterns:
  - Same error across multiple tasks suggests fix
  - Permission denials suggest permission mode change
  - Timeouts suggest task decomposition
  - Repeated retries suggest different approach
- Proactive alerts: "Tasks in this workspace have a 40% failure rate with this type of prompt"

**Auto-Learning Pipeline**
- On task completion (idle/exited):
  1. Parse conversation history
  2. Extract key decisions and their outcomes
  3. Generate learning embeddings
  4. Store with outcome metadata
  5. Inject relevant learnings into future similar tasks
- Feedback loop: track if injected learnings improved outcomes

### 3c. Smart Routing & Task Matching (Priority: MEDIUM)

**Intelligent Task Router**
- Analyze incoming prompt and determine optimal configuration
- Routing dimensions:
  - Model selection: Simple task uses Haiku, Complex uses Opus
  - Permission mode: Safe for reads, dangerous for writes
  - Max turns: Short tasks get 5, long tasks get unlimited
  - System prompt: Auto-inject relevant domain knowledge
  - MCP servers: Auto-enable relevant tools (Playwright for web, etc.)
- Training: Learn from past task configurations and outcomes
- Implementation: Use learnings store + prompt classification

**Workspace Expertise Profiles**
- Auto-detect workspace characteristics:
  - Language/framework (React, Python, Go, etc.)
  - Test framework (Jest, Pytest, etc.)
  - Build system (npm, cargo, make, etc.)
  - CI/CD platform (GitHub Actions, Jenkins, etc.)
- Use profiles to configure task defaults
- Auto-inject relevant documentation and patterns

---

## 4. Observability & Analytics

### 4a. Task Analytics Dashboard (Priority: MEDIUM)

**Metrics Collection**
- Time metrics: creation to first output, total duration, idle time
- Outcome metrics: success/failure rates, retry counts
- Cost metrics: tokens used, API cost per task
- Volume metrics: tasks per day/week, peak hours
- Workspace metrics: most active workspaces, trending areas

**Dashboard Views**
- Real-time: Active tasks, queue depth, system load
- Historical: Task volume trends, success rates over time
- Cost: Spending by workspace, by task type, forecasts
- Performance: Average task duration, bottlenecks
- Implementation: New `GET /api/analytics/*` endpoints + frontend dashboard component

### 4b. Audit Trail (Priority: LOW)

**Event Log**
- Log all significant events:
  - Task created/completed/failed
  - Git changes made and reverted
  - Configuration changes
  - User interactions (approvals, rejections)
- Searchable, filterable event log
- Export capability (JSON, CSV)
- Retention policy (auto-archive old events)

---

## 5. Developer Experience

### 5a. Headless API Mode (Priority: HIGH)

**Current gap:** Test CLI exists but is not designed for production automation.

**REST API for External Automation**
- Extend existing API endpoints with proper authentication
- OpenAPI/Swagger documentation
- API key management
- Rate limiting
- SDKs: `@claudia/sdk` for Node.js
- Use cases:
  - CI/CD pipeline integration
  - Custom dashboards
  - Slack/Discord bots
  - IDE extensions

### 5b. Task Checkpointing & Replay (Priority: MEDIUM)

**Conversation Checkpoints**
- Save task state at key points (before risky operations)
- Restore from checkpoint without re-running entire conversation
- Branch from checkpoint: try different approaches from same starting point
- Implementation: Use Claude Code's `--resume` with session ID + conversation state

**Task Replay**
- Re-run a task with the exact same inputs
- Modified replay: same prompt, different configuration
- Use case: "This task failed. Let me replay it with more permissions."

### 5c. Multi-Workspace Orchestration (Priority: MEDIUM)

**Current gap:** Workspaces are isolated. No cross-workspace coordination.

**Cross-Workspace Tasks**
- Tasks that span multiple repositories
- Use case: Update shared library, propagate changes to all consuming repos
- Cross-workspace dependency tracking
- Monorepo sub-workspace support

---

## 6. Security & Governance

### 6a. Policy Engine (Priority: MEDIUM)

**Task Policies**
- Rules that govern what agents can do:
  - "Never push to main branch"
  - "Always run tests before committing"
  - "No changes to production config files"
  - "Maximum 100 files changed per task"
- Policy enforcement: Pre-task validation + runtime monitoring
- Policy violations: Alert, block, or require approval

### 6b. Approval Workflows (Priority: MEDIUM)

**Human-in-the-Loop Gates**
- Define approval points in workflows
- Multi-approver support
- Slack/email notifications for pending approvals
- Time-based auto-approve/reject
- Approval audit trail

---

## 7. Integration Layer

### 7a. Notification Channels (Priority: MEDIUM)

**Multi-Channel Notifications**
- Slack integration: Task completion, errors, approvals needed
- Discord webhooks
- Email notifications
- Custom webhooks (generic HTTP POST)
- Configurable per workspace, per event type

### 7b. External Tool Integration (Priority: LOW)

**Built-in MCP Servers**
- Database Explorer: Read schemas, run queries safely
- Log Analyzer: Parse and summarize application logs
- Metrics Reader: Pull from Prometheus/Grafana/DataDog
- Jira/Linear Integration: Create/update tickets
- Confluence/Notion: Read/write documentation

---

## Prioritized Roadmap Recommendation

### Phase 1: Foundation (Next Release)
1. **Task Trees** (parent-child relationships) - enables all hierarchical patterns
2. **Workspace Scratchpad** (shared memory) - enables agent collaboration
3. **Concurrency Manager** (resource limits) - prevents runaway tasks
4. **Cost Tracking** - essential for production use

### Phase 2: Automation (Following Release)
5. **Task Scheduler** (cron) - enables recurring workflows
6. **Task Templates** - reduces prompt engineering friction
7. **GitHub Webhook Handler** - enables CI/CD integration
8. **Automatic Outcome Tracking** - enables the learning flywheel

### Phase 3: Intelligence (Subsequent Release)
9. **Request/Response Protocol** (agent-to-agent) - rich collaboration
10. **Intelligent Task Router** - auto-configuration
11. **Pipeline Definitions** (YAML workflows) - complex automation
12. **Analytics Dashboard** - operational visibility

### Phase 4: Enterprise (Future)
13. **Policy Engine** - governance
14. **Approval Workflows** - human-in-the-loop
15. **Multi-Channel Notifications** - integration
16. **Headless API Mode** - external automation
