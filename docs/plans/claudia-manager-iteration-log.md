# Claudia Manager Plan - Iteration Log

**Started:** 2026-06-15  
**Scheduled:** Every 10 minutes until bulletproof  
**Goal:** Address all critiques, achieve bulletproof status

---

## Iteration 1 (Completed)

**Issues Addressed:** 3 HIGH + 1 NEW HIGH

### ✅ H1: GitHub Sync Workspace Cleanup
**Problem:** Tasks for closed PRs would accumulate forever  
**Solution:**
- Filter for `draft:false` and `state === 'OPEN'` PRs
- Cleanup loop marks closed PRs with `pr-closed` label
- Health monitor skips `pr-closed` tasks
- User can manually archive via filter

**Files Updated:**
- `claudia-manager.md` - GitHubSync.syncRepo() implementation

---

### ✅ H2: Health Monitor False Positive Handling  
**Problem:** No way to dismiss legitimate idle tasks  
**Solution:**
- Added `healthMonitorSnoozeUntil` field to Task
- Health monitor skips snoozed tasks
- REST endpoint `PUT /api/tasks/:id/snooze`
- UI dropdown: "Snooze 1hr / 4hr / 24hr"

**Files Updated:**
- `claudia-manager.md` - Task type, HealthMonitor.check(), UI mockups

---

### ✅ H3: Label Persistence Not Specified
**Problem:** Unclear where labels are stored after task creation  
**Solution:**
- Extended `PersistedTask` interface in task-persistence.ts
- Added fields: `labels`, `priority`, `healthMonitorSnoozeUntil`, `lastActivityAt`
- New method: `TaskPersistence.updateTaskMetadata()`
- `PUT /api/tasks/:id/labels` persists via TaskPersistence

**Files Updated:**
- `claudia-manager.md` - Implementation plan, data model, architecture

---

### ✅ H4: GitHub API Error Handling (NEW)
**Problem:** Sync failures were silent (auth, rate limit, network)  
**Solution:**
- Added error state tracking in GitHubSync
- `parseGitHubError()` method categorizes errors (auth | rate-limit | network | unknown)
- WebSocket broadcasts: `github:sync-error`, `github:sync-recovered`, `github:auth-required`
- Frontend shows banners with actionable guidance
- Pre-flight auth check before starting sync

**Files Updated:**
- `claudia-manager.md` - GitHubSync implementation, UI mockups
- `claudia-manager-critique-v2.md` - New H4 issue + solution

---

## Current Status

**HIGH Priority Issues:** 0 remaining (4 resolved)

**MEDIUM Priority Issues:** 4 remaining
- M1: Filter bar placement unclear
- M2: `gh` CLI error handling (partially resolved by H4)
- M3: Health monitor WebSocket spam
- M4: Test strategy missing integration test

**LOW Priority Issues:** 3 remaining
- L1: Label color palette
- L2: Cross-platform path handling
- L3: Metrics collection not automated

**Plan Quality:** 🟡 GOOD (was 🔴 CRITICAL → 🟢 READY → 🟡 GOOD with new issues)

**Blockers:** NONE

---

---

## Iteration 2 (Completed)

**Issues Addressed:** 2 NEW HIGH + 4 MEDIUM + 3 LOW

### ✅ M1: Filter Bar Placement (RESOLVED)
**Problem:** UI layout unclear  
**Solution:**
- Added complete workspace panel mockup with component hierarchy
- Filter bar sits between "Needs Attention" and "Workspaces" sections
- Component structure documented

**Files Updated:**
- `claudia-manager.md` - Complete UI mockup, component hierarchy

---

### ✅ M2: gh CLI Error Handling (RESOLVED via H4)
**Problem:** Already resolved in Iteration 1  
**Status:** No additional work needed

---

### ✅ M3: Health Monitor WebSocket Spam (RESOLVED)
**Problem:** Broadcasting every 5min even when no changes  
**Solution:**
- Added `lastProblematicSet` to track previous state
- Delta detection: only broadcast when health state changes
- `setsEqual()` helper compares task ID sets

**Files Updated:**
- `claudia-manager.md` - HealthMonitor.check() implementation

---

### ✅ M4: Integration Tests (RESOLVED)
**Problem:** No automated E2E tests  
**Solution:**
- Added comprehensive Playwright test suite
- Tests cover: health monitoring, label filtering, snooze, GitHub sync
- Test helpers for creating tasks, mocking time

**Files Updated:**
- `claudia-manager.md` - e2e/manager-mvp.spec.ts implementation

---

### ✅ L1: Label Color Palette (RESOLVED)
**Problem:** Colors not specified  
**Solution:**
- Added `LABEL_COLORS` constant with predefined palette
- Colors for priority (urgent/high/low), type (bug/feature/refactor/docs), status (blocked/waiting/pr-review/pr-closed)
- `getLabelColor()` helper function

**Files Updated:**
- `claudia-manager.md` - Frontend implementation with color map

---

### ✅ L2: Cross-Platform Paths (RESOLVED)
**Problem:** Hardcoded paths with `/`  
**Solution:**
- Changed `.claudia/github-sync` to `path.join('.claudia', 'github-sync')`
- Ensures Windows compatibility

**Files Updated:**
- `claudia-manager.md` - GitHubSync class

---

### ✅ L3: Metrics Collection (RESOLVED)
**Problem:** No way to collect validation metrics  
**Solution:**
- Added `Telemetry` class for opt-in event tracking
- Tracks: label:added, filter:applied, health:clicked, github:task-created
- `getMetrics()` calculates success metrics for Week 3 validation
- `exportMetrics()` to JSON for analysis

**Files Updated:**
- `claudia-manager.md` - Telemetry implementation

---

### ✅ H5: REST API Schemas (RESOLVED)
**Problem:** Request/response types not specified  
**Solution:**
- Added full API contract for `PUT /api/tasks/:id/labels`
- Added full API contract for `PUT /api/tasks/:id/snooze`
- Includes request/response types, error codes, validation logic, curl examples

**Files Updated:**
- `claudia-manager.md` - New "REST API Contracts" section

---

### ✅ H6: WebSocket Types (RESOLVED)
**Problem:** New message types not in shared types  
**Solution:**
- Added `TasksHealthMessage`, `GitHubSyncErrorMessage`, `GitHubSyncRecoveredMessage`, `GitHubAuthRequiredMessage`, `GitHubSyncCompleteMessage`
- Updated `WSMessageType` union type
- Updated `WSMessage` union type

**Files Updated:**
- `claudia-manager.md` - Data Model section

---

## Next Iteration Focus

**Target:** Address MEDIUM priority issues to reach bulletproof status

### M1: Filter Bar Placement
**Effort:** LOW (add to mockup, clarify injection point)

### M2: `gh` CLI Error Handling
**Effort:** DONE (resolved by H4 fixes)

### M3: Health Monitor WebSocket Spam
**Effort:** MEDIUM (implement delta-only broadcast)

### M4: Integration Test
**Effort:** MEDIUM (add Playwright test)

---

## Bulletproof Criteria

**Remaining requirements:**
- [ ] All HIGH priority issues resolved ✅ (4/4 done)
- [ ] All MEDIUM priority issues resolved (1/4 done, 3 remaining)
- [ ] All edge cases documented with mitigations
- [ ] No architectural flaws
- [ ] Cost model validated
- [ ] Implementation plan complete with no gaps

**Estimated iterations to bulletproof:** 1-2 more

---

## Metrics

| Iteration | Issues Resolved | Issues Added | Net Progress |
|-----------|----------------|--------------|--------------|
| 0 (v1)    | 0              | 10 CRITICAL  | -10          |
| 0 (v2)    | 10 CRITICAL    | 3 HIGH       | +7           |
| 1         | 4 HIGH         | 0            | +4           |
| **Total** | **14**         | **3**        | **+11**      |

**Issue Velocity:** +4 per iteration (resolving faster than discovering)

---

## Notes

- Iteration 1 focused on HIGH priority issues only
- New H4 issue discovered while fixing H1 (error handling gap)
- MVP is now implementable with resolved HIGH issues
- MEDIUM issues are polish, not blockers
- LOW issues can be deferred to Phase 1+
