# Testing Structured Output Implementation

This guide explains how to test the structured output fix for the Claudia agent.

## Quick Start

### Option 1: Automated Test Script (Recommended)

```bash
# Terminal 1: Start the backend
cd backend
npm run dev

# Terminal 2: Run the test
cd backend
./run-test.sh
```

### Option 2: Manual Testing

```bash
# Terminal 1: Start the backend
cd backend
npm run dev

# Terminal 2: Build and run test
cd backend
npm run build
npm run test:cli
```

## What the Test Does

1. **Connects** to the backend WebSocket server
2. **Sends** a test message: "Use playwright to get the top 3 news headlines"
3. **Monitors** task execution and chat responses
4. **Verifies** that the assistant shows actual results (not just "task complete")
5. **Reports** pass/fail with detailed output

## Expected Output

### ✅ PASSING Test (After Fix)

```
🧪 Test CLI - Starting test
📡 Connecting to: ws://localhost:3001
💬 Test message: "Use playwright to get the top 3 news headlines"

✅ Connected to backend

📤 Sending message...
[0.2s] ASSISTANT │ I'll help you get the latest news headlines using Playwright.
[0.5s] TASK      │ Created: Get top news headlines
[2.1s] TASK      │ Status: running - Get top news headlines
[15.3s] TASK     │ Complete: Get top news headlines (complete)
[15.5s] ASSISTANT│ 📰 Here are today's top headlines from Hacker News:
                   1. Mars Rover Discovers Signs of Ancient Water
                   2. New AI Breakthrough in Language Translation
                   3. Climate Summit Reaches Historic Agreement

✅ Test complete - closing connection

================================================================================
📊 TEST SUMMARY
================================================================================

⏱️  Duration: 15.8s
💬 Chat messages: 2
📋 Tasks: 1

📝 ASSISTANT RESPONSES:
--------------------------------------------------------------------------------
  1. I'll help you get the latest news headlines using Playwright.

  2. 📰 Here are today's top headlines from Hacker News:
     1. Mars Rover Discovers Signs of Ancient Water
     2. New AI Breakthrough in Language Translation
     3. Climate Summit Reaches Historic Agreement

✅ TEST VERIFICATION:
--------------------------------------------------------------------------------
  ✅ PASS: Assistant provided detailed results (not just "task complete")
```

### ❌ FAILING Test (Before Fix)

```
[15.3s] TASK     │ Complete: Get top news headlines (complete)
[15.5s] ASSISTANT│ ✅ Task complete

📝 ASSISTANT RESPONSES:
--------------------------------------------------------------------------------
  1. I'll help you get the latest news headlines using Playwright.
  2. ✅ Task complete

✅ TEST VERIFICATION:
--------------------------------------------------------------------------------
  ❌ FAIL: Assistant only said "task complete" without showing results
```

## Test with Different Scenarios

### News Retrieval
```bash
npm run test:cli
# Uses default: "Get top 3 news headlines"
```

### Weather Information
```bash
npm run test:cli -- --message "search for the current weather in San Francisco"
```

### Data Analysis
```bash
npm run test:cli -- --message "analyze the top posts on Hacker News and summarize"
```

### Custom Message
```bash
npm run test:cli -- --message "your custom test here"
```

## Troubleshooting

### Backend Not Running
```
❌ WebSocket error: connect ECONNREFUSED
```
**Solution**: Start the backend first
```bash
cd backend && npm run dev
```

### Test Timeout
```
❌ Test timed out
```
**Solutions**:
- Increase timeout: `npm run test:cli -- --timeout 120000`
- Check backend logs for errors
- Verify Claude CLI is working: `claude --version`

### Build Errors
```
❌ Cannot find module './types.js'
```
**Solution**: Rebuild the backend
```bash
cd backend
npm run build
```

### No Structured Output
If the test fails with "Assistant only said task complete":

1. **Check worker prompt** - Verify instructions are included (orchestrator.ts:45-76)
2. **Check result extraction** - Look for "Extracted structured result" in backend logs
3. **Check LLM generation** - Look for "TASK RESULT" in LLM service logs
4. **Verify worker output** - Check if worker actually outputs the markers

## Monitoring Backend Logs

Run the backend with visible logs:
```bash
cd backend
npm run dev
```

Look for these log messages:
- `[ResultParser] Extracted structured result:` - Result was found
- `[TaskManager] Extracted structured result for task` - Parser succeeded
- `[LLM] Cleaned response for parsing:` - LLM analyzing results

## Architecture Flow

```
User Message
    ↓
Orchestrator receives "get news"
    ↓
Spawns Worker with structured output instructions
    ↓
Worker (Claude CLI) executes task
    ↓
Worker outputs results with markers:
    === STRUCTURED_RESULT ===
    { "result": "actual news content" }
    === END_STRUCTURED_RESULT ===
    ↓
TaskManager extracts structured result
    ↓
Orchestrator passes result to LLM
    ↓
LLM generates user message with actual content
    ↓
User sees: "📰 Here are today's headlines: ..."
```

## Files Changed

Implementation files:
- `backend/src/types.ts` - Added StructuredTaskResult interface
- `backend/src/result-parser.ts` - NEW: Parser for structured output
- `backend/src/task-manager.ts` - Extract results on completion
- `backend/src/llm-service.ts` - Prioritize structured results
- `backend/src/orchestrator.ts` - Add worker instructions

Test files:
- `backend/test-cli.ts` - NEW: Automated test tool
- `backend/run-test.sh` - NEW: Test runner script
- `backend/TEST-CLI-README.md` - Test tool documentation
- `TESTING.md` - This file

## CI/CD Integration

The test can be integrated into automated workflows:

```bash
# Exit code 0 = pass, 1 = fail
cd backend
npm run build
npm run test:cli || exit 1
```

## Next Steps After Successful Test

1. ✅ Structured output working
2. Test with real frontend
3. Deploy to production
4. Monitor user feedback

## Support

If tests fail consistently:
1. Check all files were modified correctly
2. Verify backend rebuilt: `npm run build`
3. Check Claude CLI is installed: `claude --version`
4. Review backend logs for errors
5. Test worker output manually
