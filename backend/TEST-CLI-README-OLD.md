# Test CLI - Automated Testing Tool

A non-interactive CLI tool that emulates the frontend to test the orchestrator's structured output functionality.

## Purpose

Tests that when tasks retrieve data (news, search results, etc.), the orchestrator:
1. Receives structured output from workers
2. Parses and extracts the actual results
3. Shows the results to the user (not just "task complete")

## Usage

### Quick Start

```bash
# 1. Start the backend (in one terminal)
cd backend
npm run dev

# 2. Run the test CLI (in another terminal)
cd backend
npm run test:cli
```

### Custom Test Messages

```bash
# Test with different scenarios
npm run test:cli -- --message "search for the weather in San Francisco"
npm run test:cli -- --message "use playwright to get trending topics from twitter"
npm run test:cli -- --message "analyze the latest tech news and summarize it"
```

### Command Line Options

```bash
npm run test:cli -- [options]

Options:
  --url <url>        Backend WebSocket URL (default: ws://localhost:3001)
  --message <text>   Test message to send
  --timeout <ms>     Timeout in milliseconds (default: 60000)
  --help            Show help message
```

### Examples

```bash
# Default test (gets news headlines)
npm run test:cli

# Custom backend URL
npm run test:cli -- --url ws://localhost:4000

# Shorter timeout
npm run test:cli -- --timeout 30000

# Custom test message
npm run test:cli -- --message "get the latest sports scores"
```

## What It Tests

### Before Fix
```
📤 Sending message: "use playwright to get news"
[2.1s] TASK      │ Created: Get news headlines
[15.3s] TASK     │ Complete: Get news headlines
[15.5s] ASSISTANT│ ✅ Task complete
```
❌ **FAIL**: User doesn't see the actual news

### After Fix
```
📤 Sending message: "use playwright to get news"
[2.1s] TASK      │ Created: Get news headlines
[15.3s] TASK     │ Complete: Get news headlines
[15.5s] ASSISTANT│ 📰 Here are today's top headlines:
                  1. Mars rover discovers ancient water signs
                  2. AI breakthrough in language translation
                  3. Climate summit reaches historic agreement
```
✅ **PASS**: User sees the actual news content

## Output Format

The test CLI displays:
1. **Real-time events**: Chat messages, task status updates
2. **Summary**: Duration, message count, task count
3. **Assistant responses**: All messages from the assistant
4. **Verification**: Automatic pass/fail based on response content

## Test Verification

The test automatically verifies success by checking if:
- Assistant provided a response
- Response contains actual data (>50 chars)
- Response is not just "task complete" boilerplate

## Integration with CI/CD

Can be used in automated testing:

```bash
# Exit code 0 = success, 1 = failure
npm run test:cli && echo "Test passed" || echo "Test failed"
```

## Troubleshooting

### Connection Failed
- Ensure backend is running: `npm run dev`
- Check the WebSocket URL: default is `ws://localhost:3001`

### Test Timeout
- Increase timeout: `--timeout 120000` (120 seconds)
- Check if worker tasks are hanging
- Review backend logs for errors

### No Results Shown
- This indicates the bug still exists
- Check backend logs for structured result extraction
- Verify worker is outputting structured format

## Testing Different Scenarios

### Data Retrieval Tasks (Should use structured output)
```bash
npm run test:cli -- --message "get news headlines"
npm run test:cli -- --message "search for information about X"
npm run test:cli -- --message "analyze data and show results"
```

### File Operations (Structured output optional)
```bash
npm run test:cli -- --message "create a todo app"
npm run test:cli -- --message "fix the bug in file.ts"
```

## Architecture

```
Test CLI
  ├─ WebSocket Client
  │   └─ Connects to backend
  ├─ Message Handler
  │   ├─ chat:message
  │   ├─ task:created
  │   ├─ task:updated
  │   └─ task:complete
  └─ Verification Logic
      └─ Checks for actual content vs "task complete"
```

## Files

- `test-cli.ts` - Main test tool implementation
- `package.json` - Added `test:cli` script
- `TEST-CLI-README.md` - This file
