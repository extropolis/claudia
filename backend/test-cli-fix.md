# Test CLI Timeout Fix

## Problem
The test CLI had multiple competing timers that would sometimes:
- Timeout too early
- Timeout too late
- Conflict with each other

## Solution
Implemented a unified completion detection system:

### Changes Made

1. **Added state tracking:**
   ```typescript
   private completionTimer: NodeJS.Timeout | null = null;
   private lastActivityTime: number = 0;
   ```

2. **Single completion check method:**
   - `scheduleCompletionCheck()` - Cancels previous timer and schedules new check
   - `checkForCompletion()` - Checks if test is done based on:
     - No running tasks
     - At least one assistant response
     - 4 seconds of inactivity

3. **Activity tracking:**
   - All message handlers update `lastActivityTime`
   - Completion timer resets on any new activity

### How It Works

```
Message/Task Event
    ↓
Update lastActivityTime
    ↓
Schedule completion check (4s)
    ↓
[4 seconds of no activity]
    ↓
Check: No running tasks + Have responses?
    ↓  YES
Close connection
```

## Test Results

### ✅ Code Generation Test
```
[24.8s] ASSISTANT │ ✅ Created add function in 4 languages! Here's the implementation:
                   **JavaScript/TypeScript:**
                   function addTwoNumbers(a, b) {
                     return a + b;
                   }
                   ...
```

**Result**: Structured output working! Shows actual code, not just "task complete".

### Known Issue
External messages to the backend (like from a real frontend) will reset the completion timer. This is expected behavior - the test CLI sees all WebSocket traffic.

**Workaround**: Run tests when no other clients are connected to the backend.

## Files Modified

- `backend/test-cli.ts`:
  - Added `completionTimer` and `lastActivityTime` properties
  - Replaced multiple setTimeout() calls with unified `scheduleCompletionCheck()`
  - Added `checkForCompletion()` method
  - Updated `cleanup()` to clear timers

## Usage

The fixed test CLI now correctly:
- ✅ Waits for tasks to complete
- ✅ Waits for orchestrator summary
- ✅ Closes after 4 seconds of inactivity
- ✅ Handles task completion messages properly
- ✅ Doesn't timeout prematurely
- ✅ Doesn't hang indefinitely

```bash
npm run test:cli -- --message "your test" --timeout 90000
```

The test will automatically close 4 seconds after the last message/task activity.
