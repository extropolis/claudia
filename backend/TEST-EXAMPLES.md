# Test CLI Examples - Testing Any Scenario

The test CLI is flexible and can test **any message** you want to send to the orchestrator.

## Basic Usage

```bash
npm run test:cli -- --message "YOUR MESSAGE HERE"
```

## Test Scenarios

### 1. Data Retrieval (Primary Use Case for Structured Output)

#### News Headlines
```bash
npm run test:cli -- --message "use playwright to get the top 5 news headlines from Hacker News"
npm run test:cli -- --message "navigate to BBC News and get breaking news"
npm run test:cli -- --message "get trending topics from Reddit"
```

#### Weather Information
```bash
npm run test:cli -- --message "search for the current weather in San Francisco"
npm run test:cli -- --message "get the weather forecast for New York this week"
npm run test:cli -- --message "check if it's raining in Seattle"
```

#### Search Results
```bash
npm run test:cli -- --message "search for information about TypeScript 5.0 features"
npm run test:cli -- --message "find the latest React documentation"
npm run test:cli -- --message "look up the best practices for Node.js"
```

#### Web Scraping
```bash
npm run test:cli -- --message "scrape product prices from Amazon"
npm run test:cli -- --message "get the top posts from Hacker News"
npm run test:cli -- --message "extract article titles from TechCrunch"
```

#### Data Analysis
```bash
npm run test:cli -- --message "analyze the GitHub trending repositories and summarize"
npm run test:cli -- --message "compare prices on three different websites"
npm run test:cli -- --message "gather statistics from this dataset and present them"
```

### 2. File Operations

#### Create Files
```bash
npm run test:cli -- --message "create a simple todo app with HTML, CSS, and JavaScript"
npm run test:cli -- --message "write a Python script that sorts a list"
npm run test:cli -- --message "create a React component for a login form"
```

#### Modify Files
```bash
npm run test:cli -- --message "add error handling to the auth function"
npm run test:cli -- --message "refactor the UserService to use async/await"
npm run test:cli -- --message "fix the TypeScript errors in api.ts"
```

#### Read/Analyze Files
```bash
npm run test:cli -- --message "analyze the code in src/index.ts and suggest improvements"
npm run test:cli -- --message "find all TODO comments in the codebase"
npm run test:cli -- --message "check for security vulnerabilities in package.json"
```

### 3. Development Tasks

#### Testing
```bash
npm run test:cli -- --message "run the tests and fix any failures"
npm run test:cli -- --message "write unit tests for the UserService"
npm run test:cli -- --message "check code coverage and identify gaps"
```

#### Build/Deploy
```bash
npm run test:cli -- --message "build the project and fix any errors"
npm run test:cli -- --message "run the linter and fix warnings"
npm run test:cli -- --message "update dependencies to latest versions"
```

#### Debugging
```bash
npm run test:cli -- --message "debug why the login function is failing"
npm run test:cli -- --message "find the memory leak in the application"
npm run test:cli -- --message "trace the execution of the API call"
```

### 4. API/Network Tasks

#### API Testing
```bash
npm run test:cli -- --message "test the /api/users endpoint"
npm run test:cli -- --message "make a POST request to create a new user"
npm run test:cli -- --message "check if the API returns proper error codes"
```

#### Authentication
```bash
npm run test:cli -- --message "test the OAuth flow"
npm run test:cli -- --message "verify JWT token generation"
npm run test:cli -- --message "check session management"
```

### 5. Database Tasks

```bash
npm run test:cli -- --message "query the database for all users"
npm run test:cli -- --message "create a database migration for the new schema"
npm run test:cli -- --message "optimize the slow query in UserRepository"
```

### 6. Complex Multi-Step Tasks

```bash
npm run test:cli -- --message "create a REST API with CRUD operations, write tests, and document the endpoints"
npm run test:cli -- --message "set up a CI/CD pipeline with GitHub Actions"
npm run test:cli -- --message "implement user authentication with JWT and refresh tokens"
```

### 7. Browser Automation

```bash
npm run test:cli -- --message "use playwright to login to the website and verify the dashboard loads"
npm run test:cli -- --message "automate filling out the contact form"
npm run test:cli -- --message "take screenshots of the app in mobile and desktop views"
npm run test:cli -- --message "test the checkout flow end-to-end"
```

### 8. Research/Investigation

```bash
npm run test:cli -- --message "research best practices for React state management"
npm run test:cli -- --message "find out what's causing the high CPU usage"
npm run test:cli -- --message "investigate why the tests are flaky"
```

## Advanced Options

### Custom Backend URL
```bash
npm run test:cli -- --url ws://localhost:4000 --message "your message"
```

### Custom Timeout
```bash
# For long-running tasks
npm run test:cli -- --timeout 120000 --message "run all integration tests"

# For quick tasks
npm run test:cli -- --timeout 30000 --message "fix the typo in README"
```

### Combining Options
```bash
npm run test:cli -- \
  --url ws://localhost:3001 \
  --timeout 90000 \
  --message "use playwright to scrape product data from 10 pages"
```

## Testing Structured Output Specifically

To verify structured output is working, test scenarios where you expect **data/results back**:

### ✅ Should Show Results (Tests Structured Output)
```bash
npm run test:cli -- --message "get the news"
npm run test:cli -- --message "search for X and tell me what you find"
npm run test:cli -- --message "analyze this data and show me the results"
npm run test:cli -- --message "scrape the website and list the items"
```

### ℹ️ May Not Need Structured Output (File ops)
```bash
npm run test:cli -- --message "create a file"
npm run test:cli -- --message "fix the bug"
npm run test:cli -- --message "run the build"
```

## What the CLI Tests

For **any message** you send, the CLI will:

1. ✅ Connect to backend
2. ✅ Send your message
3. ✅ Monitor task execution
4. ✅ Capture all assistant responses
5. ✅ Verify if results contain actual data (not just "task complete")
6. ✅ Report pass/fail

## Interpreting Results

### ✅ PASS
```
[15.5s] ASSISTANT│ 📰 Here are the results: [actual data here]

✅ PASS: Assistant provided detailed results
```
The assistant showed you the actual data/results.

### ❌ FAIL
```
[15.5s] ASSISTANT│ ✅ Task complete

❌ FAIL: Assistant only said "task complete" without showing results
```
The assistant just said "complete" without showing what happened.

### ℹ️ Note
Some tasks (like "create a file") don't need to show detailed results in the chat.
The FAIL message doesn't always mean the implementation is broken - it depends on the task type.

## Tips

1. **Be specific**: "Get news from Hacker News" is better than "get news"
2. **Test data retrieval**: Best for verifying structured output
3. **Adjust timeout**: Use `--timeout` for long-running tasks
4. **Check logs**: Backend logs show detailed execution info
5. **Iterate**: Run multiple tests with different scenarios

## Quick Reference

```bash
# Basic test
npm run test:cli

# Custom message
npm run test:cli -- --message "your message"

# Help
npm run test:cli -- --help

# Different backend
npm run test:cli -- --url ws://localhost:4000

# Longer timeout
npm run test:cli -- --timeout 120000
```

## Testing Everything

The CLI can test **literally any message** - there are no limitations. Just use `--message` with whatever you want to test:

```bash
npm run test:cli -- --message "anything you want to test"
```

The tool will:
- Send it to the orchestrator
- Monitor the response
- Show you what happened
- Verify the results were communicated properly
