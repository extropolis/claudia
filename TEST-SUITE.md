# Claudia Test Suite Documentation

Comprehensive guide for automated and integration testing in the Claudia orchestrator.

## Table of Contents

- [Quick Start](#quick-start)
- [Test Structure](#test-structure)
- [Running Tests](#running-tests)
- [Unit Tests](#unit-tests)
- [Integration Tests](#integration-tests)
- [CLI Tests](#cli-tests)
- [Writing New Tests](#writing-new-tests)
- [CI/CD Integration](#cicd-integration)
- [Troubleshooting](#troubleshooting)

## Quick Start

### Run All Tests

```bash
cd backend
npm test
```

This runs the full automated test suite including:
- Unit tests for core components
- Integration tests for orchestrator workflows
- CLI tests for structured output validation

### Run Specific Test Types

```bash
# Unit tests only
npm run test:unit

# Integration tests only
npm run test:integration

# CLI tests only
npm run test:cli

# Specific unit test
npm run test:unit:parser
npm run test:unit:tasks
```

## Test Structure

```
backend/
├── tests/
│   ├── unit/                          # Unit tests
│   │   ├── result-parser.test.ts      # Result parser tests
│   │   └── task-manager.test.ts       # Task manager tests
│   ├── integration/                   # Integration tests
│   │   └── orchestrator.integration.test.ts
│   └── ...
├── src/
│   └── test-utils.ts                  # Shared test utilities
├── test-cli.ts                        # Manual CLI test tool
└── run-all-tests.sh                   # Automated test runner
```

## Running Tests

### Prerequisites

1. **Node.js 20+** installed
2. **Backend built**: `npm run build`
3. **Dependencies installed**: `npm install`

### Manual Test Execution

#### Run All Tests
```bash
cd backend
./run-all-tests.sh
```

The test runner will:
1. Check if backend is running, or start it automatically
2. Run all unit tests
3. Run all integration tests
4. Run CLI validation tests
5. Print a comprehensive summary
6. Clean up background processes

#### Run Individual Test Files
```bash
# Result parser unit tests
npx tsx tests/unit/result-parser.test.ts

# Task manager unit tests
npx tsx tests/unit/task-manager.test.ts

# Orchestrator integration tests
npx tsx tests/integration/orchestrator.integration.test.ts
```

### Automated CI/CD

Tests run automatically on:
- Push to `main` or `develop` branches
- Pull requests to `main` or `develop`

GitHub Actions workflow: `.github/workflows/tests.yml`

## Unit Tests

### Result Parser Tests (`tests/unit/result-parser.test.ts`)

Tests the extraction and cleaning of structured results from task output.

**Test Cases:**
- ✅ Valid JSON structured result extraction
- ✅ Structured result with artifacts
- ✅ No structured result markers
- ✅ Incomplete markers handling
- ✅ Invalid JSON handling
- ✅ Multiple structured results (first wins)
- ✅ Nested objects support
- ✅ Marker removal from output

**Run:**
```bash
npm run test:unit:parser
```

**Expected Output:**
```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                    RESULT PARSER - EXTRACTION TESTS                           ║
╚═══════════════════════════════════════════════════════════════════════════════╝

✅ PASS: Valid JSON structured result
✅ PASS: Structured result with artifacts
✅ PASS: No structured result markers
...

📊 Total: 14 passed, 0 failed
```

### Task Manager Tests (`tests/unit/task-manager.test.ts`)

Tests core task management functionality.

**Test Cases:**
- ✅ Task creation with proper initialization
- ✅ Status updates and timestamps
- ✅ Output appending
- ✅ Task completion with exit codes
- ✅ Task hierarchy (parent-child relationships)
- ✅ Task listing and filtering
- ✅ Task deletion

**Run:**
```bash
npm run test:unit:tasks
```

**Expected Output:**
```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                         TASK MANAGER UNIT TESTS                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝

✅ PASS: Task Creation
✅ PASS: Status Updates
✅ PASS: Output Appending
...

📊 Results: 7 passed, 0 failed
```

## Integration Tests

### Orchestrator Integration Tests (`tests/integration/orchestrator.integration.test.ts`)

End-to-end tests of the orchestrator system via WebSocket.

**Test Cases:**
- ✅ Simple echo command
- ✅ Structured output - news retrieval
- ✅ File creation
- ✅ Multiple tasks
- ✅ Error handling

**Run:**
```bash
npm run test:integration
```

**Expected Output:**
```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                    ORCHESTRATOR INTEGRATION TESTS                             ║
╚═══════════════════════════════════════════════════════════════════════════════╝

═══════════════════════════════════════════════════════════════════════════════
🧪 Running: Simple Echo Command
═══════════════════════════════════════════════════════════════════════════════
📝 Message: echo "Hello from test"

✅ Connected to backend
📤 Message sent
✅ TEST PASSED in 5.2s

...

📊 Results: 5 passed, 0 failed (5 total)
⏱️  Total duration: 145.3s
```

## CLI Tests

### Manual CLI Testing Tool (`test-cli.ts`)

The CLI test tool provides detailed manual testing capabilities.

**Features:**
- WebSocket connection to backend
- Real-time message and task monitoring
- Structured output validation
- Automatic pass/fail detection
- Verbose logging mode

**Usage:**
```bash
# Basic test
npm run test:cli -- --message "your test message"

# With verbose logging
npm run test:cli -- -v --message "get top news"

# With timeout
npm run test:cli -- --timeout 60000 --message "complex task"

# Create task directly
npm run test:cli -- --task --task-name "My Task" --message "do something"
```

**Example Output:**
```
🧪 Test CLI - Starting test
📡 Connecting to: ws://localhost:3001
💬 Test message: "echo hello world"

✅ Connected to backend

[0.2s] INIT      │ Received 0 existing tasks, 1 workspaces
[0.5s] ASSISTANT │ I'll help you run that command.
[2.1s] TASK      │ Created: Run echo command
[2.3s] TASK      │ Status: running - Run echo command
[4.5s] COMPLETE  │ Run echo command (exit: 0, status: complete)

✅ Test complete - closing connection

═══════════════════════════════════════════════════════════════════════════════
📊 TEST SUMMARY
═══════════════════════════════════════════════════════════════════════════════

⏱️  Duration: 4.7s
💬 Chat messages: 2
📋 Tasks: 1

📝 ASSISTANT RESPONSES:
───────────────────────────────────────────────────────────────────────────────
  1. I'll help you run that command.
  2. ✅ Task completed successfully

✅ TEST VERIFICATION:
───────────────────────────────────────────────────────────────────────────────
  ✅ PASS: Assistant provided detailed results
```

## Writing New Tests

### Unit Test Template

```typescript
#!/usr/bin/env node
/**
 * Unit tests for YourComponent
 */

interface TestResult {
    name: string;
    passed: boolean;
    error?: string;
}

function testYourFeature(): TestResult {
    try {
        // Test logic here
        // ...

        return { name: 'Your Feature', passed: true };
    } catch (error) {
        return {
            name: 'Your Feature',
            passed: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

function runAllTests() {
    console.log('\n╔═══════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                         YOUR COMPONENT TESTS                                  ║');
    console.log('╚═══════════════════════════════════════════════════════════════════════════════╝\n');

    const tests = [testYourFeature];
    const results: TestResult[] = tests.map(test => test());

    let passed = 0;
    let failed = 0;

    results.forEach(result => {
        if (result.passed) {
            console.log(`✅ PASS: ${result.name}`);
            passed++;
        } else {
            console.log(`❌ FAIL: ${result.name}`);
            console.log(`   ${result.error}`);
            failed++;
        }
    });

    console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    runAllTests();
}
```

### Integration Test Template

```typescript
#!/usr/bin/env node
/**
 * Integration tests for YourFeature
 */

import { createTestConnection, MessageCollector, cleanup, sleep } from '../../src/test-utils.js';

interface TestCase {
    name: string;
    message: string;
    validate: (collector: MessageCollector) => Promise<void>;
    timeoutMs?: number;
}

const TEST_CASES: TestCase[] = [
    {
        name: 'Your Test Case',
        message: 'your test message',
        validate: async (collector) => {
            await collector.waitForTaskComplete(30000);
            const tasks = Array.from(collector.getTasks().values());

            if (tasks.length === 0) {
                throw new Error('No tasks created');
            }

            // Your validation logic
        },
        timeoutMs: 45000
    }
];

async function runTest(testCase: TestCase): Promise<{ passed: boolean; error?: string; duration: number }> {
    const startTime = Date.now();
    let ws;

    try {
        ws = await createTestConnection();
        const collector = new MessageCollector(ws);

        await sleep(1000);

        const msg = {
            type: 'chat:send',
            payload: { content: testCase.message }
        };
        ws.send(JSON.stringify(msg));

        await testCase.validate(collector);

        const duration = Date.now() - startTime;
        return { passed: true, duration };

    } catch (error) {
        const duration = Date.now() - startTime;
        return {
            passed: false,
            error: error instanceof Error ? error.message : String(error),
            duration
        };
    } finally {
        if (ws) cleanup(ws);
    }
}

// Run tests...
```

### Test Utilities

The `test-utils.ts` file provides helpful utilities:

```typescript
import {
    createTestConnection,     // Create WebSocket connection
    MessageCollector,         // Collect and monitor messages
    sendMessageAndWait,       // Send message and wait for response
    waitForTaskCompletion,    // Wait for specific task
    createTestTask,           // Create a task
    assertMessageContains,    // Assert message content
    assertTaskSuccess,        // Assert task succeeded
    assertStructuredResult,   // Assert structured result exists
    cleanup,                  // Close connection
    sleep                     // Wait utility
} from '../../src/test-utils.js';
```

## CI/CD Integration

### GitHub Actions Workflow

The `.github/workflows/tests.yml` file defines the CI pipeline:

1. **Unit Tests Job**: Runs all unit tests
2. **Integration Tests Job**: Runs integration tests with live backend
3. **CLI Tests Job**: Runs CLI validation tests
4. **Full Test Suite Job**: Runs complete test suite

### Adding to CI

To add new tests to CI, update `.github/workflows/tests.yml`:

```yaml
- name: Run your new tests
  run: cd backend && npx tsx tests/unit/your-test.test.ts
```

## Troubleshooting

### Backend Not Running

**Error:**
```
❌ WebSocket error: connect ECONNREFUSED
```

**Solution:**
```bash
# Start backend manually
cd backend
npm run dev

# Or let test runner start it
./run-all-tests.sh
```

### Test Timeouts

**Error:**
```
❌ Test timed out
```

**Solutions:**
- Increase timeout: `--timeout 120000`
- Check backend logs for errors
- Verify Claude CLI or OpenCode SDK is working

### Build Errors

**Error:**
```
Cannot find module './types.js'
```

**Solution:**
```bash
cd backend
npm run build
```

### Port Already in Use

**Error:**
```
❌ Backend failed to start
Error: listen EADDRINUSE: address already in use :::3001
```

**Solution:**
```bash
# Find and kill process on port 3001
lsof -ti:3001 | xargs kill -9

# Or use a different port
export PORT=3002
```

### Test Failures

If tests fail consistently:
1. Check all files were created correctly
2. Verify backend rebuilt: `npm run build`
3. Check dependencies installed: `npm install`
4. Review backend logs for errors
5. Run tests individually to isolate issues

### Verbose Debugging

Enable verbose mode for more details:

```bash
# Integration tests with verbose output
npm run test:cli -- -v --message "your test"

# Full test suite with backend logs
cd backend
npm run dev  # In one terminal
./run-all-tests.sh  # In another terminal
```

## Best Practices

### Writing Tests

1. **Keep tests focused**: One test should verify one thing
2. **Use descriptive names**: Test names should explain what they verify
3. **Test edge cases**: Include tests for error conditions
4. **Clean up resources**: Always close connections and cleanup
5. **Use timeouts**: Prevent tests from hanging indefinitely

### Running Tests

1. **Run tests before commits**: Catch issues early
2. **Run full suite before PRs**: Ensure nothing broke
3. **Check CI results**: Don't merge if tests fail
4. **Review test logs**: Understand why tests failed

### Maintaining Tests

1. **Update tests with code changes**: Keep tests in sync
2. **Remove obsolete tests**: Clean up outdated tests
3. **Add tests for bugs**: Prevent regressions
4. **Document complex tests**: Explain non-obvious test logic

## Test Coverage Goals

- **Unit Tests**: 80%+ coverage of core components
- **Integration Tests**: All major workflows covered
- **CLI Tests**: All structured output scenarios validated
- **E2E Tests**: Critical user paths tested

## Support

For issues or questions:
1. Check troubleshooting section above
2. Review test logs for errors
3. Check backend logs: `/tmp/claudia-test-backend.log`
4. Open an issue with test output and logs

## Summary

This comprehensive test suite ensures the Claudia orchestrator works reliably:

- ✅ **Unit tests** verify individual components
- ✅ **Integration tests** verify end-to-end workflows
- ✅ **CLI tests** verify structured output functionality
- ✅ **Automated runner** executes all tests
- ✅ **CI/CD pipeline** catches issues early

Run `npm test` to validate your changes!
