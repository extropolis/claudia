# Claudia Best Practices

## Testing Completed Tasks

**IMPORTANT**: When you complete a task, always test it yourself before declaring it complete.

### Why This Matters
- Don't rely on the user to test your work
- Verify functionality end-to-end
- Catch issues early before the user encounters them
- Demonstrate thoroughness and professionalism

### How to Test

1. **For Web Applications**: Use the Playwright MCP tools to:
   - Navigate to the application URL
   - Interact with UI elements
   - Verify expected behavior
   - Take screenshots to document success

2. **For APIs/Backend**: Use curl or similar tools to:
   - Send test requests
   - Verify responses
   - Check logs for errors

3. **For CLI Tools**: Run the actual commands and verify output

### Example: Testing a Web App Fix

```bash
# Bad - Just making the fix and stopping
✗ Fixed the orchestrator bug in orchestrator.ts

# Good - Fix and test
✓ Fixed the orchestrator bug in orchestrator.ts
✓ Opened the app in browser at http://localhost:5173
✓ Sent a test message "hello, testing the orchestrator"
✓ Verified the orchestrator responded correctly
✓ Took screenshot showing successful interaction
```

## Recent Fixes Applied

### 2026-01-12: Task Output Duplication Bug
**Problem**: When multiple tasks were running simultaneously, the text output in each task would appear duplicated when viewing the terminal panel.

**Root Cause**: The frontend's `updateTask()` function in `taskStore.ts` was merging output arrays from task update events:
1. As tasks ran, the backend sent `task:output` messages with individual output chunks
2. The frontend's `appendOutput()` correctly added these chunks to the task's output array
3. When a task completed, the backend sent a `task:complete` event with the ENTIRE Task object, including the full accumulated `output` array
4. The `updateTask()` function (line 157) was merging these outputs: `task.output = [...existing.output, ...task.output.filter(o => !existing.output.includes(o))]`
5. This caused duplication because the frontend already had all output from incremental updates, and now it was appending the backend's full output array again

**Fix**: Modified `updateTask()` in `frontend/src/stores/taskStore.ts` to preserve the existing output array instead of merging:
```typescript
// Before (line 157):
task.output = [...existing.output, ...task.output.filter(o => !existing.output.includes(o))];

// After:
task.output = existing.output;  // Preserve existing output - updates come via appendOutput only
```

The key insight is that output updates should ONLY come through the `appendOutput()` function via `task:output` WebSocket messages. When `task:updated` or `task:complete` events arrive, they should only update metadata fields (status, exitCode, etc.) and preserve the existing output array.

**Testing Done**:
- Created two concurrent tasks (task-a.txt and task-b.txt)
- Verified both tasks showed exactly 4 lines of output with no duplication
- Switched between tasks multiple times to confirm output remained consistent
- Screenshot saved: `.playwright-mcp/task-duplication-fixed.png`

**Files Changed**:
- `/Users/I850333/projects/experiments/codeui/frontend/src/stores/taskStore.ts:157` - Changed output merging logic to preserve existing output array

### 2026-01-11: Message Duplication Bug
**Problem**: Messages from the orchestrator were appearing 3 times in the chat UI.

**Root Cause**: When the orchestrator returned a `show_plan` action, the code emitted messages twice:
1. First emission at line 278-285: Emitted `decision.message` from orchestrator response
2. Second emission at line 370-376: Emitted comprehensive plan message in `handlePlanFromOrchestrator()`

**Fix**: Modified `handleOrchestratorDecision()` method to skip emitting `decision.message` when `action === 'show_plan'`, since `handlePlanFromOrchestrator()` already emits a more comprehensive message with full plan details.

**Testing Done**:
- Started dev server (frontend on port 5175, backend on port 3001)
- Opened browser at http://localhost:5175
- Sent test message "tell me about this project"
- Verified only ONE orchestrator response appeared (previously would show 3 times)
- Screenshot saved: `.playwright-mcp/message-duplication-fixed.png`

**Files Changed**:
- `/Users/I850333/projects/experiments/codeui/backend/src/orchestrator.ts:278` - Added condition `&& decision.action !== 'show_plan'` to prevent duplicate emission

### 2026-01-11: Orchestrator Worker Spawning Bug
**Problem**: Orchestrator showed "❌ Orchestrator is not ready" error when receiving messages.

**Root Cause**: Premature check for `orchestratorWorker` existence before it could be spawned in on-demand mode.

**Fix**: Removed the blocking check in `sendMessage()` method (backend/src/orchestrator.ts:369-379), allowing `sendToOrchestratorWorker()` to spawn workers on-demand.

**Testing Done**:
- Restarted the dev server
- Opened browser at http://localhost:5173
- Sent test message through UI
- Verified orchestrator spawned worker and responded correctly
- Screenshot saved: `.playwright-mcp/orchestrator-working.png`

**Files Changed**:
- `/Users/I850333/projects/experiments/codeui/backend/src/orchestrator.ts`

### 2026-01-12: Task Continuation Message Format Bug
**Problem**: When sending a message to a completed/stopped task using `-p` flag or the UI input, the message appeared at the top of the terminal with "Continue with:" prefix instead of appearing at the bottom with just the actual message.

**Root Cause**: In `backend/src/server.ts` at line 143, when resuming a task, the code was:
1. Updating the task description to include "Continue with: {input}"
2. Broadcasting this updated description to the UI
3. The terminal panel would then display this modified description in the prompt at the top

**Fix**: Removed the task description update completely (lines 142-143 and 156-157 in server.ts). The worker prompt already correctly formats the continuation message as "New instructions: {input}", so there's no need to modify the task description. The original task description now stays unchanged, and the new message appears only in the output at the bottom.

**Testing Done**:
- Started dev servers (frontend on port 5176, backend on port 3001)
- Opened browser at http://localhost:5176
- Created task: "create a simple test.txt file with 'hello world' in it"
- Waited for task to complete
- Sent continuation message: "now add another line saying 'goodbye world'"
- Verified:
  - Terminal prompt still shows original description: `$ claudia -p "create a simple test.txt file with "hello world" in it..."`
  - New message appears at the BOTTOM of the output (not top)
  - No "Continue with:" prefix anywhere in the UI
  - Worker correctly received and processed the continuation message
- Screenshot saved: `.playwright-mcp/task-continuation-fixed-final.png`

**Files Changed**:
- `/Users/I850333/projects/experiments/codeui/backend/src/server.ts:138-151` - Removed task description update that was adding "Continue with:" prefix

### 2026-01-12: Task Continuation Message Format Improvement
**Problem**: When resuming a completed task, the continuation message displayed "🔄 Resuming task with new instructions:" followed by the user's message, which was verbose and not consistent with typical chat interfaces.

**Root Cause**: In `backend/src/server.ts` at line 143, when appending the user's continuation message to the task output, the code was prefixing it with "🔄 Resuming task with new instructions:\n".

**Fix**: Changed the message format from "🔄 Resuming task with new instructions:" to simply "You:" to match typical chat interface conventions and be more concise.

**Testing Done**:
- Started dev servers (frontend on port 5176, backend on port 3001)
- Opened browser at http://localhost:5176
- Opened existing completed task "hi"
- Sent continuation message: "create a file called test-continuation.txt with the text \"testing the You: format\""
- Verified:
  - Message now displays cleanly as "You:\n<message content>"
  - No emoji or verbose prefix
  - Format is consistent with typical chat interfaces
  - Task successfully resumed and executed the new instruction
- Screenshot saved: `.playwright-mcp/task-continuation-you-format.png`

**Files Changed**:
- `/Users/I850333/projects/experiments/codeui/backend/src/server.ts:143` - Changed message format from "🔄 Resuming task with new instructions:" to "You:"

### 2026-01-12: Task Resume Message Not Appearing in Task View
**Problem**: When sending a message to resume a completed task, the user's resume message was not appearing in the task output view. Only Claudia's responses were visible, making it unclear what instruction was given to resume the task.

**Root Cause**: In `backend/src/server.ts` at lines 138-151, when resuming a task, the code was:
1. Creating a worker prompt that includes the user's input: `New instructions: ${input}`
2. Spawning the worker with this prompt
3. BUT not emitting the user's message to the task output before spawning the worker
4. The worker prompt goes to Claudia CLI internally but doesn't get displayed in the UI

**Fix**: Added a call to `taskManager.appendOutput()` at line 143 to emit the user's resume message to the task output BEFORE spawning the new worker. This ensures the user's message appears in the task view, followed by Claudia's responses.

**Testing Done**:
- Started dev servers (frontend on port 5176, backend on port 3001)
- Opened browser at http://localhost:5176
- Opened existing completed task "hi"
- Sent continuation message: "now add another line to the file that says \"second continuation message\""
- Verified:
  - User's resume message appears in task output with "You:" prefix
  - Message appears at the bottom of the existing output
  - Claudia's response appears below the user's message
  - Task successfully resumed and executed the instruction
- Screenshot saved: `.playwright-mcp/task-resumption-message-fixed.png`

**Files Changed**:
- `/Users/I850333/projects/experiments/codeui/backend/src/server.ts:143` - Added `taskManager.appendOutput(task.id, ...)` to emit user's resume message to task output
