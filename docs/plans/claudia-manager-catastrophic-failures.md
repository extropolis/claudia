# Claudia Manager - Catastrophic Failure Analysis (Iteration 6)

**Date:** 2026-06-15  
**Review Type:** Worst-Case Scenarios  
**Goal:** What causes complete system failure?

---

## 1. Circular Dependency Deadlock

### CRITICAL: File Lock Deadlock Freezes All Operations

**Scenario:** Two REST requests create a deadlock

```
Request A: Update task-1 labels, then update task-2 labels
Request B: Update task-2 labels, then update task-1 labels

Timeline:
T0: Request A locks task-1.json ✅
T1: Request B locks task-2.json ✅
T2: Request A tries to lock task-2.json ⏳ (blocked by B)
T3: Request B tries to lock task-1.json ⏳ (blocked by A)

Result: DEADLOCK. Both requests wait forever.
```

**Current plan has no deadlock detection or timeout.**

```typescript
// proper-lockfile has retries but no timeout on waiting
const release = await lockfile.lock(taskFile, {
  retries: {
    retries: 5,
    minTimeout: 100,
    maxTimeout: 1000
  }
});
// If lock is held forever, this hangs forever
```

**FIX: Add lock timeout**

```typescript
const lockWithTimeout = async (filepath: string, timeoutMs: number = 5000) => {
  const lockPromise = lockfile.lock(filepath, {
    retries: { retries: 5, minTimeout: 100, maxTimeout: 1000 }
  });
  
  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error(`Lock timeout after ${timeoutMs}ms`)), timeoutMs)
  );
  
  return Promise.race([lockPromise, timeoutPromise]);
};

// Usage:
try {
  const release = await lockWithTimeout(taskFile, 5000);
  // ...
} catch (err) {
  if (err.message.includes('timeout')) {
    logger.error('File lock timeout - possible deadlock or hung process', {
      filepath: taskFile,
      timeout: 5000
    });
    return res.status(503).json({ 
      error: 'Server busy - please try again',
      retryAfter: 5 
    });
  }
  throw err;
}
```

**SEVERITY:** 🔴 **CRITICAL** - Can freeze entire system

---

## 2. Runaway Cron: Infinite Loop

### CRITICAL: Health Monitor Spawns Infinite Processes

**Scenario:** Health check hangs, but setInterval keeps firing

```typescript
// Current plan:
setInterval(() => this.check(), 5 * 60 * 1000);

async check() {
  if (this.isChecking) {
    console.warn('Health check still running, skipping');
    return;  // Skip, but interval keeps running
  }
  
  this.isChecking = true;
  try {
    await Promise.race([this.doCheck(), timeoutPromise]);
  } finally {
    this.isChecking = false;
  }
}
```

**What if doCheck() never returns AND timeout promise never rejects?**

```typescript
async doCheck() {
  const allTasks = this.taskSpawner.getAllTasksForHealth();
  
  // If getAllTasksForHealth() hangs (e.g., disk I/O frozen):
  // - Never returns
  // - timeout promise never fires (bug in Promise.race)
  // - isChecking = true forever
  // - All future checks skip
  // - Health monitoring silently stops working
}
```

**Even worse:** If timeout DOES fire but doCheck continues:

```
T0: check() starts, isChecking = true
T1: doCheck() starts (slow disk I/O)
T2: timeout fires (30s), catch block runs, isChecking = false
T3: doCheck() still running in background
T4: Next interval (5min), check() starts again, isChecking = true
T5: Now 2 doCheck() running in parallel
T10: Now 10 doCheck() running in parallel
T100: Out of memory, server crashes
```

**FIX: Process-level safeguard**

```typescript
class HealthMonitor {
  private checkCount = 0;  // Total checks started
  private completeCount = 0;  // Total checks completed
  
  async check() {
    const checkId = ++this.checkCount;
    
    // If more than 2 checks are incomplete, something is very wrong
    if (this.checkCount - this.completeCount > 2) {
      logger.error('Too many concurrent health checks - stopping monitor', {
        started: this.checkCount,
        completed: this.completeCount,
        hung: this.checkCount - this.completeCount
      });
      
      // STOP the interval to prevent runaway
      if (this.intervalHandle) {
        clearInterval(this.intervalHandle);
        this.intervalHandle = null;
      }
      
      // Alert user via WebSocket
      this.broadcast({
        type: 'manager:critical-error',
        message: 'Health monitor stopped due to hung checks',
        action: 'Restart server required'
      });
      
      return;
    }
    
    // ... rest of check logic
    
    this.completeCount++;
  }
  
  start() {
    this.intervalHandle = setInterval(() => this.check(), 5 * 60 * 1000);
  }
}
```

**SEVERITY:** 🔴 **CRITICAL** - Can crash server

---

## 3. Corrupted Config: Bootstrap Failure

### CRITICAL: config.json Corruption Prevents Startup

**Scenario:** Power loss during config save

```typescript
// User enables GitHub sync
await fs.writeJson(configFile, config);
// Power loss mid-write

// File contains: {"githubSync":{"enabled":tr
// Truncated, invalid JSON
```

**On server restart:**

```typescript
// server.ts
const config = await fs.readJson(configFile);  // JSON parse error!
// Server crashes, cannot start
```

**User cannot recover because server won't start to fix config.**

**FIX: Config validation + recovery**

```typescript
async function loadConfigSafe(configFile: string): Promise<AppConfig> {
  const backupFile = `${configFile}.backup`;
  
  try {
    // Try to load current config
    const config = await fs.readJson(configFile);
    
    // Validate structure
    if (!config || typeof config !== 'object') {
      throw new Error('Config is not an object');
    }
    
    // Create backup of working config
    await fs.copy(configFile, backupFile);
    
    return config;
  } catch (err) {
    logger.error('Config file corrupted, attempting recovery', {
      error: err.message
    });
    
    // Try to load backup
    if (await fs.pathExists(backupFile)) {
      try {
        const backupConfig = await fs.readJson(backupFile);
        logger.info('Restored config from backup');
        
        // Restore backup to main config
        await fs.copy(backupFile, configFile);
        
        return backupConfig;
      } catch (backupErr) {
        logger.error('Backup also corrupted');
      }
    }
    
    // Last resort: use defaults
    logger.warn('Using default config - all settings reset');
    const defaultConfig = getDefaultConfig();
    await fs.writeJson(configFile, defaultConfig);
    return defaultConfig;
  }
}

// Always use atomic writes for config
async function saveConfig(configFile: string, config: AppConfig) {
  await atomicWriteJson(configFile, config);
}
```

**SEVERITY:** 🔴 **CRITICAL** - Server won't start

---

## 4. Node.js Version Incompatibility

### HIGH: Breaks on Node.js Updates

**Problem:** Plan doesn't specify Node.js version requirement

```json
// package.json - MISSING:
{
  "engines": {
    "node": ">=18.0.0"
  }
}
```

**Scenario:** User runs on Node.js 16

```typescript
// Uses features from Node 18:
- fs.statfs() (added in Node 18.15.0)
- crypto.randomBytes() improvements
- Promise.withResolvers() (if used)
```

**Result:** Runtime errors, cryptic messages

**FIX: Version requirements**

```json
// package.json
{
  "engines": {
    "node": ">=18.15.0"
  },
  "scripts": {
    "preinstall": "node scripts/check-node-version.js"
  }
}

// scripts/check-node-version.js
const semver = require('semver');
const pkg = require('../package.json');

if (!semver.satisfies(process.version, pkg.engines.node)) {
  console.error(
    `Error: Claudia requires Node.js ${pkg.engines.node}, ` +
    `but you are using ${process.version}.\\n` +
    `Please upgrade Node.js: https://nodejs.org/`
  );
  process.exit(1);
}
```

**SEVERITY:** 🔴 **HIGH** - Silent failures on wrong Node version

---

## 5. Database Migration Race Condition

### HIGH: Concurrent Migrations Corrupt Data

**Scenario:** User runs two Claudia instances on same data directory

```
Instance A: Starts migration
Instance B: Starts migration (simultaneously)

Both check: migration marker doesn't exist yet
Both run: migrate all tasks (add labels field)
Instance A: Writes migration marker
Instance B: Writes migration marker
Both complete

Result: Tasks migrated twice?
Some tasks might have labels: [[]]  (nested array)
```

**Current plan has no migration lock:**

```typescript
async migrateToMVP() {
  const migrationMarker = path.join(this.basePath, '.migration-mvp-v1');
  if (await fs.pathExists(migrationMarker)) {
    return;  // Already migrated
  }
  
  // RACE: Between check and write, another instance might run
  
  // ... migration logic
  
  await fs.writeFile(migrationMarker, new Date().toISOString());
}
```

**FIX: Lock-based migration**

```typescript
async migrateToMVP() {
  const migrationMarker = path.join(this.basePath, '.migration-mvp-v1');
  const lockFile = `${migrationMarker}.lock`;
  
  // Try to create lock file (exclusive)
  try {
    await fs.writeFile(lockFile, process.pid.toString(), { flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') {
      // Another process is migrating
      logger.info('Migration already in progress, waiting...');
      
      // Wait for migration to complete (check every second)
      for (let i = 0; i < 60; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (await fs.pathExists(migrationMarker)) {
          logger.info('Migration completed by other process');
          return;
        }
      }
      
      throw new Error('Migration timeout - lock file exists but migration not complete');
    }
    throw err;
  }
  
  try {
    // Check again now that we have the lock
    if (await fs.pathExists(migrationMarker)) {
      return;
    }
    
    // Run migration
    logger.info('Starting migration...');
    // ... migration logic
    
    // Write marker
    await fs.writeFile(migrationMarker, new Date().toISOString());
    logger.info('Migration complete');
  } finally {
    // Release lock
    await fs.remove(lockFile).catch(() => {});
  }
}
```

**SEVERITY:** 🔴 **HIGH** - Data corruption if multi-instance

---

## 6. Memory Exhaustion: Large Label Lists

### MEDIUM: Unbounded Growth in Frontend

**Scenario:** User creates 1000 unique labels over time

```typescript
// Frontend stores ALL labels for autocomplete
const [allLabels, setAllLabels] = useState<string[]>([]);

// Every task update adds labels to set
useEffect(() => {
  const labels = new Set<string>();
  tasks.forEach(task => {
    task.labels?.forEach(label => labels.add(label));
  });
  setAllLabels(Array.from(labels));
}, [tasks]);
```

**With 1000 labels:**
- Array: 1000 × 20 bytes = 20KB ✅ Fine
- But in React state, re-renders on every task update
- Label picker dropdown renders 1000 items ⚠️ Slow

**With 10,000 labels (pathological case):**
- Dropdown unusable
- Rendering lag
- Memory pressure

**FIX: Limit + pagination**

```typescript
const MAX_LABEL_SUGGESTIONS = 50;

// Show only recently used labels
const getRecentLabels = (tasks: Task[], limit: number = MAX_LABEL_SUGGESTIONS): string[] => {
  const labelCounts = new Map<string, number>();
  
  tasks.forEach(task => {
    task.labels?.forEach(label => {
      labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
    });
  });
  
  // Sort by usage frequency
  return Array.from(labelCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label]) => label);
};

// In label picker
<div className="label-suggestions">
  <p>Common labels ({recentLabels.length}):</p>
  {recentLabels.map(label => ...)}
  {allLabels.length > MAX_LABEL_SUGGESTIONS && (
    <p className="hint">
      Showing {MAX_LABEL_SUGGESTIONS} most used labels. 
      Type to search all {allLabels.length} labels.
    </p>
  )}
</div>
```

**SEVERITY:** 🟡 **MEDIUM** - UX degradation with many labels

---

## 7. Clock Skew: Snooze in the Past

### LOW: System Clock Changes Break Snooze

**Scenario:** User snoozes task for 1 hour, then system clock goes backwards

```
T0 (10:00 AM): User snoozes task
    healthMonitorSnoozeUntil = "2026-06-15T11:00:00Z"

T1 (10:05 AM): Admin adjusts system clock back 2 hours
    System time now: 08:05 AM

T2 (08:06 AM): Health monitor checks
    Date.now() < new Date("2026-06-15T11:00:00Z")  // Still in future!
    Task remains snoozed for 3 more hours instead of 55 minutes
```

**Also affects:** Recent exits tracking (24 hour window)

**FIX: Use elapsed time, not wall clock**

```typescript
// Instead of absolute timestamp, store snooze duration
interface Task {
  healthMonitorSnooze?: {
    startedAt: number;  // Date.now() when snoozed
    durationMs: number;  // How long to snooze
  };
}

// Check if snoozed
function isSnoozed(task: Task): boolean {
  if (!task.healthMonitorSnooze) return false;
  
  const elapsed = Date.now() - task.healthMonitorSnooze.startedAt;
  return elapsed < task.healthMonitorSnooze.durationMs;
}
```

**SEVERITY:** 🟢 **LOW** - Rare, minor impact

---

## Summary: Catastrophic Failures

### CRITICAL (3)

**F1: File Lock Deadlock**
- Two requests lock different files in different order
- FIX: Lock timeout (5s) + 503 retry response

**F2: Runaway Cron**
- Hung checks accumulate, OOM crash
- FIX: Track incomplete checks, stop interval if >2 hung

**F3: Corrupted Config Bootstrap**
- Power loss corrupts config.json, server won't start
- FIX: Config backup + recovery, atomic writes

### HIGH (2)

**F4: Node.js Version Incompatibility**
- Breaks on Node 16, cryptic errors
- FIX: engines field + preinstall check

**F5: Migration Race Condition**
- Two instances migrate simultaneously
- FIX: Lock file for migration

### MEDIUM (1)

**F6: Memory Exhaustion (Large Label Lists)**
- 1000+ labels cause UI lag
- FIX: Limit suggestions to top 50 by usage

### LOW (1)

**F7: Clock Skew**
- System time change breaks snooze duration
- FIX: Use elapsed time instead of absolute timestamp

---

## Total Issues Found (All Iterations)

| Iteration | Critical | High | Medium | Low | Total |
|-----------|----------|------|--------|-----|-------|
| 0 → v2 | 10 | 0 | 0 | 0 | 10 |
| 1 | 0 | 4 | 0 | 0 | 4 |
| 2 | 0 | 2 | 4 | 3 | 9 |
| 3 (Red Team) | 3 | 2 | 3 | 0 | 8 |
| 4 (Integration) | 2 | 2 | 3 | 0 | 7 |
| 5 (Production Ops) | 2 | 1 | 5 | 2 | 10 |
| 6 (Catastrophic) | 3 | 2 | 1 | 1 | 7 |
| **TOTAL** | **20** | **13** | **16** | **6** | **55** |

**Issues remaining:** 7 (all from this iteration)

---

## Confidence Assessment

| Aspect | Iter 5 | Iter 6 | Change |
|--------|--------|--------|--------|
| Architecture | 100% | 100% | ✅ |
| Implementation | 100% | 100% | ✅ |
| Concurrency | 100% | 95% | -5% (deadlock risk) |
| Production Ready | 50% | 60% | +10% (O1-O3 fixed) |
| **Fault Tolerance** | **N/A** | **70%** | **NEW** |
| **Overall** | **83%** | **85%** | **+2%** |

**Status:** 🟡 **NEEDS FAULT TOLERANCE** (F1-F5 must be fixed)
