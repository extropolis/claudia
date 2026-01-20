# Claudia Development Guide

## Auto-Reload Development

The backend auto-reloads on file changes via `tsx watch`. Do not manually restart it.

1. Write code
2. Wait 1-2 seconds for reload
3. Test with the CLI

## Testing

Always test changes using the CLI (`backend/test-cli.ts`):

```bash
cd backend
npx tsx test-cli.ts --list-tasks
npx tsx test-cli.ts -m "your prompt" -w /path/to/workspace
npx tsx test-cli.ts --help
```

Add CLI functionality if needed for testing. Ensure adequate logging to debug issues.

## Starting the Server

If the backend is not running:

```bash
./start.sh
```
<!-- CODEUI-RULES -->
## Custom Rules

if it's a new feature, try to use a test cli unless it would be much easier to just have the user do a manual test (this is usually the case for visual features).. if it doesn't have functionality to do the test then add it. you can also use playwright mcp or curl if either of these would be easier. make sure you have enough logging to debug any issues.. if you create any test files, clean them up when you are done. Always use start.sh to restart the server

<!-- /CODEUI-RULES -->
