# Claudia Testing Quick Reference

Quick commands and examples for running tests.

## Quick Commands

```bash
# Run all tests (unit + integration + CLI)
npm test

# Unit tests only
npm run test:unit

# Specific unit tests
npm run test:unit:parser    # Result parser tests
npm run test:unit:tasks     # Task manager tests

# Integration tests
npm run test:integration

# CLI tests
npm run test:cli -- --message "your test"
```

## Test Structure

```
backend/
├── tests/
│   ├── unit/
│   │   ├── result-parser.test.ts  ✅ 10 tests
│   │   └── task-manager.test.ts   ✅ 7 tests
│   └── integration/
│       └── orchestrator.integration.test.ts  ✅ 5 tests
├── src/
│   └── test-utils.ts              # Shared utilities
├── test-cli.ts                     # Manual testing tool
└── run-all-tests.sh               # Full test suite runner
```

## Test Results

### Unit Tests

#### Result Parser (10 tests)
- ✅ Valid JSON structured result extraction
- ✅ Structured result with artifacts
- ✅ No structured result markers
- ✅ Incomplete markers handling
- ✅ Invalid JSON handling
- ✅ Multiple structured results
- ✅ New format: RESULT_OUTPUT section
- ✅ Remove markers from output
- ✅ No markers to remove
- ✅ Multiple marker sets

#### Task Manager (7 tests)
- ✅ Task creation
- ✅ Status updates
- ✅ Output appending
- ✅ Task completion
- ✅ Task hierarchy
- ✅ Task listing
- ✅ Task deletion

### Integration Tests (5 tests)
- ✅ Simple echo command
- ✅ Structured output - news retrieval
- ✅ File creation
- ✅ Multiple tasks
- ✅ Error handling

## Common Testing Scenarios

### Test Structured Output

```bash
npm run test:cli -- --message "use playwright to get top 5 news from Hacker News"
```

### Test File Creation

```bash
npm run test:cli -- --message "create a file called test.txt"
```

### Test with Verbose Logging

```bash
npm run test:cli -- -v --message "your test"
```

### Test Task Operations

```bash
# Create task
npm run test:cli -- --task --task-name "My Task" --message "do something"

# List tasks
npm run test:cli -- --list-tasks

# View task files
npm run test:cli -- --view-files --task-id <task-id>
```

## Debugging Failed Tests

### Check Backend Logs

```bash
# Backend runs in watch mode - check terminal output
# Or check test logs:
cat /tmp/claudia-test-backend.log
```

### Run Tests Individually

```bash
# Run specific test file
npx tsx tests/unit/result-parser.test.ts

# Run with verbose output
npm run test:cli -- -v --message "test"
```

### Common Issues

**Backend not running:**
```bash
cd backend
npm run dev  # Start in separate terminal
```

**Build errors:**
```bash
cd backend
npm run build
```

**Port in use:**
```bash
lsof -ti:3001 | xargs kill -9
```

## CI/CD

Tests run automatically on:
- Push to `main` or `develop`
- Pull requests to `main` or `develop`

GitHub Actions workflow: `.github/workflows/tests.yml`

## Documentation

- **TEST-SUITE.md** - Comprehensive test documentation
- **TESTING.md** - Structured output testing guide
- **backend/TEST-CLI-README.md** - CLI test tool documentation

## Test Coverage

- **Result Parser**: 100% (10/10 tests passing)
- **Task Manager**: 100% (7/7 tests passing)
- **Integration**: All major workflows covered (5 scenarios)
- **CLI Validation**: Automated testing available

## Adding New Tests

See TEST-SUITE.md for detailed instructions on writing new tests.

Quick template:

```typescript
function testYourFeature(): TestResult {
    try {
        // Your test logic
        return { name: 'Your Feature', passed: true };
    } catch (error) {
        return {
            name: 'Your Feature',
            passed: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
```

## Support

For detailed information, see:
- `/TEST-SUITE.md` - Full documentation
- `/TESTING.md` - Structured output testing
- `backend/TEST-CLI-README.md` - CLI tool guide

Run `npm test` to validate your changes!
