# Claudia Manager Plan - Final Architectural Review

**Date:** 2026-06-15  
**Iteration:** 2  
**Goal:** Identify any remaining gaps before declaring bulletproof

---

## Deep Architecture Scan

### 1. Data Flow Analysis

**Task Creation → Labels:**
```
User creates task
  ↓
taskSpawner.createTask(prompt, workspace, ..., { labels: [...] })
  ↓
InternalTask created with labels in metadata
  ↓
TaskPersistence.saveTask() writes to .claudia/tasks/{workspace}/task-{id}.json
  ↓
WebSocket broadcast: task:created (includes labels)
  ↓
Frontend taskStore updates
  ↓
UI shows task with label pills
```

**✅ No gaps identified**

---

**Label Addition Post-Creation:**
```
User right-clicks task → "Add label"
  ↓
Frontend calls PUT /api/tasks/:id/labels { labels: ["urgent"] }
  ↓
Backend: taskPersistence.updateTaskMetadata(taskId, { labels })
  ↓
Loads task, updates labels field, saves to disk
  ↓
WebSocket broadcast: task:updated
  ↓
Frontend re-renders with new label
```

**✅ No gaps identified**

---

**Health Monitoring:**
```
Cron fires every 5min
  ↓
HealthMonitor.check() scans all tasks
  ↓
Detects idle >2hr, waiting >30min, error exit
  ↓
Compares to lastProblematicSet (delta detection)
  ↓
If changed: broadcast tasks:health
  ↓
Frontend updates needsAttention state
  ↓
UI shows/hides "Needs Attention" section
```

**⚠️ ISSUE FOUND: What if task transitions from idle → busy?**
- Current: Only broadcasts when problematic set changes
- Problem: If task was in "Needs Attention" and becomes busy, it should disappear
- Current logic: Task removed from problematicSet, broadcast fires ✅
- **Resolution:** Works correctly. Delta detection handles both additions and removals.

---

**GitHub Sync:**
```
Cron fires every 10min
  ↓
GitHubSync.sync() for each repo
  ↓
gh pr list --search "review-requested:@me draft:false"
  ↓
For each PR: check if task exists, create if not
  ↓
Cleanup loop: mark closed PRs with pr-closed label
  ↓
Tasks created with labels: ['pr-review']
  ↓
Health monitor sees them (if they go idle >2hr)
```

**⚠️ ISSUE FOUND: PR sync creates tasks, but how does user know?**
- Current: Tasks just appear in .claudia/github-sync workspace
- No notification that N new PR tasks were created
- User might miss them

**Recommendation:**
```typescript
// In GitHubSync.sync(), track stats
let newTasksCreated = 0;
// ... after creating tasks
newTasksCreated++;

// At end of sync:
if (newTasksCreated > 0) {
  this.broadcast({
    type: 'github:sync-complete',
    newTasks: newTasksCreated,
    repo
  });
}

// Frontend shows transient notification:
// "✅ GitHub sync: 3 new PR review tasks created"
```

**Priority:** MEDIUM (UX improvement, not blocker)

---

### 2. State Consistency Analysis

**Scenario: Server restarts while tasks exist**

1. Server goes down
2. Tasks exist in .claudia/tasks/{workspace}/
3. Server restarts
4. TaskSpawner.init() loads tasks from disk
5. InternalTasks created with labels, lastActivityAt from disk ✅
6. HealthMonitor starts, checks tasks
7. If task idle >2hr, broadcasts to frontend ✅

**✅ No gaps identified** (assuming lastActivityAt is persisted, which we added in H3 fix)

---

**Scenario: User has 2 browser tabs open**

1. Tab A adds label "urgent" to task
2. PUT /api/tasks/:id/labels succeeds
3. Backend broadcasts task:updated via WebSocket
4. Both Tab A and Tab B receive WebSocket message
5. Both update their taskStore ✅

**✅ No gaps identified** (existing WebSocket broadcast handles this)

---

**Scenario: GitHub PR gets merged while sync is running**

1. Sync fetches PR list at T=0s
2. PR #123 is in list (state: OPEN)
3. Task created for PR #123
4. PR #123 merges at T=5s
5. Cleanup loop runs at T=10s
6. Cleanup fetches PR list again... wait, does it?

**⚠️ ISSUE FOUND: Cleanup uses same PR list from fetch**

Current code:
```typescript
const prs = JSON.parse(stdout);  // Fetched once
const activePrNumbers = new Set(prs.filter(pr => pr.state === 'OPEN').map(pr => pr.number));

// Cleanup loop uses same `prs` array
```

**Problem:** If PR merges between fetch and cleanup, cleanup won't detect it until next sync cycle (10min later).

**Resolution:** This is acceptable for MVP.
- 10min delay in cleanup is fine
- Next sync cycle will clean it up
- Alternative (fetch twice) wastes API calls

**Priority:** LOW (acceptable latency)

---

**Scenario: User snoozes task for 1hr, then server restarts**

1. Task snoozed, healthMonitorSnoozeUntil = "2026-06-15T14:00:00Z"
2. Server restarts at 13:30
3. TaskPersistence loads task with snoozeUntil field ✅
4. HealthMonitor checks at 13:35
5. Snooze still active, task skipped ✅
6. HealthMonitor checks at 14:05
7. Snooze expired, task flagged ✅

**✅ No gaps identified**

---

### 3. Edge Case Analysis

**Edge: User has 0 tasks**

- HealthMonitor.check() returns empty array
- No broadcast (delta detection: empty → empty, no change) ✅
- Frontend never shows "Needs Attention" ✅

**✅ No issue**

---

**Edge: User has 1000+ tasks**

- HealthMonitor.check() loops through 1000 tasks every 5min
- Each check: ~1ms × 1000 = 1 second CPU time
- Acceptable? Yes, non-blocking async loop ✅

**Performance consideration:** If users report slowness with >5000 tasks, add index:
```typescript
// Maintain index of potentially problematic tasks
private potentiallyProblematicTasks = new Set<string>();

// On task state change, update index
onTaskStateChange(task) {
  if (task.state === 'idle' || task.state === 'waiting_input' || task.state === 'exited') {
    this.potentiallyProblematicTasks.add(task.id);
  } else {
    this.potentiallyProblematicTasks.delete(task.id);
  }
}

// In check(), only scan indexed tasks
for (const taskId of this.potentiallyProblematicTasks) {
  const task = this.taskSpawner.getTask(taskId);
  // ... check logic
}
```

**Priority:** DEFER to Phase 1 (only if users hit performance issues)

---

**Edge: GitHub repo has 100 open PRs**

- Sync fetches all 100 PRs
- Creates 100 tasks in .claudia/github-sync workspace
- Workspace panel shows 100 tasks 😱

**Mitigation options:**
1. Filter: only PRs where I'm a **requested** reviewer (not optional)
2. Limit: max 20 PRs per repo (configurable)
3. Pagination: show "Load more" in workspace panel

**Recommendation for MVP:**
```typescript
// In GitHubSync.syncRepo()
const MAX_PRS_PER_REPO = 20;  // Configurable

const { stdout } = await execAsync(
  `gh pr list --repo ${repo} --search "review-requested:@me draft:false" --limit ${MAX_PRS_PER_REPO} --json number,title,url,state`
);
```

**Priority:** MEDIUM (add to config, document limitation)

---

**Edge: User deletes .claudia/github-sync workspace**

1. User deletes workspace via UI or manually
2. GitHubSync.sync() runs
3. ensureWorkspace() tries to get workspace
4. Workspace not found
5. Creates new workspace ✅
6. Syncs PRs again ✅

**✅ No issue** (workspace auto-recreates)

---

**Edge: User adds same label twice**

Frontend:
```typescript
// Current implementation
const newLabels = [...filters.labels, label];
```

**Problem:** Allows duplicates ["urgent", "urgent"]

**Fix:**
```typescript
const newLabels = filters.labels.includes(label)
  ? filters.labels.filter(l => l !== label)
  : [...filters.labels, label];
```

**Status:** Already implemented correctly in plan ✅

---

**Edge: Label name contains special characters**

User creates label: `bug/critical` or `@urgent` or `#hashtag`

**Potential issues:**
- CSS selector issues if label used as class name
- URL encoding if label in query params
- Display issues if label contains emoji

**Mitigation:**
```typescript
// Validate label name
function isValidLabel(label: string): boolean {
  // Allow alphanumeric, dash, underscore only
  return /^[a-zA-Z0-9_-]+$/.test(label);
}

// In PUT /api/tasks/:id/labels:
if (!isValidLabel(label)) {
  return res.status(400).json({ error: 'Invalid label format' });
}
```

**Priority:** MEDIUM (add validation)

---

### 4. Security Analysis

**Attack: Label injection**

Attacker creates label: `<script>alert('xss')</script>`

**Mitigation:** React escapes by default ✅

**Verification needed:** Ensure no `dangerouslySetInnerHTML` used for labels

---

**Attack: Label bombing**

Attacker creates 10,000 labels to DoS the filter bar

**Mitigation:**
```typescript
const MAX_LABELS_PER_TASK = 10;

// In PUT /api/tasks/:id/labels:
if (newLabels.length > MAX_LABELS_PER_TASK) {
  return res.status(400).json({ error: 'Too many labels' });
}
```

**Priority:** LOW (add limit)

---

**Attack: Snooze far future**

Attacker snoozes task until 2099

**Mitigation:**
```typescript
const MAX_SNOOZE_HOURS = 7 * 24;  // 1 week

// In PUT /api/tasks/:id/snooze:
if (hours > MAX_SNOOZE_HOURS) {
  return res.status(400).json({ error: 'Snooze duration too long' });
}
```

**Priority:** LOW (add validation)

---

### 5. Missing Implementation Details

**❌ REST Endpoints Not Fully Specified**

Plan mentions:
- `PUT /api/tasks/:id/labels`
- `PUT /api/tasks/:id/snooze`

But doesn't show:
- Request/response schemas
- Error codes
- Authentication (if any)

**Add to plan:**

```typescript
// PUT /api/tasks/:id/labels
Request: {
  labels: string[];  // Full replacement, not delta
}
Response: {
  taskId: string;
  labels: string[];
}
Errors:
  404 - Task not found
  400 - Invalid label format
  400 - Too many labels (>10)

// PUT /api/tasks/:id/snooze
Request: {
  hours: number;  // 1, 4, or 24
}
Response: {
  taskId: string;
  healthMonitorSnoozeUntil: string;  // ISO timestamp
}
Errors:
  404 - Task not found
  400 - Invalid duration
  400 - Duration too long (>168 hours)
```

**Priority:** HIGH (add to implementation plan)

---

**❌ WebSocket Message Types Not Added to Shared Types**

Plan adds `tasks:health` but doesn't update shared types file.

**Add to plan:**

```typescript
// shared/src/index.ts

type WSMessageType = 
  // ... existing types
  | 'tasks:health'
  | 'github:sync-error'
  | 'github:sync-recovered'
  | 'github:auth-required'
  | 'github:sync-complete';

interface TasksHealthMessage {
  type: 'tasks:health';
  tasks: TaskHealthIssue[];
}

interface GitHubSyncErrorMessage {
  type: 'github:sync-error';
  repo: string;
  error: string;
  errorType: 'auth' | 'rate-limit' | 'network' | 'unknown';
  retryAfter?: string;
}

interface GitHubSyncRecoveredMessage {
  type: 'github:sync-recovered';
  repo: string;
}

interface GitHubAuthRequiredMessage {
  type: 'github:auth-required';
  message: string;
}

interface GitHubSyncCompleteMessage {
  type: 'github:sync-complete';
  newTasks: number;
  repo: string;
}
```

**Priority:** HIGH (required for type safety)

---

### 6. Documentation Gaps

**❌ User-facing docs not mentioned**

MVP will add:
- Label system (how to use?)
- Health monitoring (what do the warnings mean?)
- GitHub sync (how to set up?)
- Snooze feature (when to use?)

**Add to rollout plan:**

```markdown
### Week 1: Day 5 - Write User Docs

**Create docs/user-guide/manager-mvp.md:**

#### Labels
- How to add labels (right-click menu)
- Recommended label naming (use kebab-case, avoid special chars)
- Label colors (built-in palette)
- Filtering by label

#### Health Monitoring
- What triggers "Needs Attention" (idle 2hr, waiting 30min, error exit)
- When to snooze vs. fix
- Snooze durations

#### GitHub Sync
- Prerequisites (gh CLI installed and authenticated)
- How to enable in settings
- Which PRs are synced (review-requested:@me, not draft, limit 20)
- Cleanup behavior (closed PRs marked with #pr-closed)
- Troubleshooting auth/rate limit errors

#### Filters
- How to use filter bar
- Combining filters
- Persisted to localStorage
```

**Priority:** MEDIUM (needed before user testing)

---

## Summary of Findings

### NEW HIGH Priority Issues

**H5: REST API Schemas Missing**
- Add request/response types for `/api/tasks/:id/labels` and `/api/tasks/:id/snooze`
- Add error codes and validation

**H6: WebSocket Types Missing**
- Add new message types to `shared/src/index.ts`
- Required for TypeScript type safety

### NEW MEDIUM Priority Issues

**M5: GitHub Sync Notification**
- Add broadcast when new PR tasks created
- Show transient notification in frontend

**M6: GitHub PR Limit**
- Add `MAX_PRS_PER_REPO = 20` config
- Document limitation in user guide

**M7: Label Validation**
- Add regex validation: `/^[a-zA-Z0-9_-]+$/`
- Add max labels per task limit (10)

**M8: User Documentation**
- Write user guide for MVP features
- Include troubleshooting section

### RESOLVED MEDIUM Priority Issues

- ✅ M1: Filter bar placement (added mockup + component hierarchy)
- ✅ M2: gh CLI error handling (resolved by H4)
- ✅ M3: WebSocket spam (delta detection added)
- ✅ M4: Integration tests (Playwright tests added)

### RESOLVED LOW Priority Issues

- ✅ L1: Label color palette (added to implementation)
- ✅ L2: Cross-platform paths (path.join added)
- ✅ L3: Metrics collection (telemetry system added)

### DEFERRED Issues (Not Blockers for MVP)

- D1: Auto-delete pr-closed tasks after N days (Phase 1)
- D2: Snooze far-future validation (add in Week 2 if time)
- D3: Label bombing protection (add in Week 2 if time)
- D4: Performance optimization for 5000+ tasks (Phase 1, only if needed)

---

## Bulletproof Checklist

- [x] All v1 CRITICAL issues resolved (10/10)
- [x] All v2 HIGH issues resolved (4/4 from Iteration 1)
- [ ] All v2.1 HIGH issues resolved (2 NEW, see H5-H6)
- [x] All MEDIUM issues resolved (4/4 original)
- [ ] All NEW MEDIUM issues addressed (4 NEW, see M5-M8)
- [x] Architecture flaws identified and fixed
- [x] Data flow validated
- [x] Edge cases documented
- [x] Security analyzed
- [x] Cost model complete
- [ ] API contracts fully specified (missing H5)
- [ ] Type safety ensured (missing H6)
- [x] Test plan complete

**Status:** 🟡 Near-Bulletproof (2 HIGH, 4 MEDIUM remaining)

**Next Iteration:** Resolve H5-H6, address M5-M8

---

## Recommendation

**MVP is implementable NOW** with caveat:
- Add REST API schemas (H5) before Week 1
- Add WebSocket types (H6) before Week 1
- MEDIUM issues (M5-M8) can be done during Week 1-2

**Bulletproof status achievable in 1 more iteration.**
