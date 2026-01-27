# Claudia Development Guide

## ⚠️ CRITICAL: DO NOT RESTART THE SERVER

**NEVER run `./start.sh`, `npm run dev`, or kill/restart the server during development.**

The backend uses `tsx watch` which **automatically reloads** when you change `.ts` files:
- Write code → Wait 1-2 seconds → Changes are live
- No restart needed!

**Why?** Restarting the server while tasks are running causes:
- Out of Memory (OOM) crashes (exit code 137)
- Nested server instances that consume all system memory
- Loss of active task connections

## Auto-Reload Development

1. Write code in `backend/src/`
2. Wait 1-2 seconds for automatic reload (watch for "restarted" in logs)
3. Test with the CLI or browser
4. **Never restart the server manually**

## Testing

Always test changes using the CLI (`backend/test-cli.ts`):

```bash
cd backend
npx tsx test-cli.ts --list-tasks
npx tsx test-cli.ts -m "your prompt" -w /path/to/workspace
npx tsx test-cli.ts --help
```

Add CLI functionality if needed for testing. Ensure adequate logging to debug issues.

## Starting the Server (Initial Startup Only)

**Only use this when the server is NOT running (e.g., after system reboot):**

```bash
./start.sh
```

The lock file will prevent accidental duplicate starts.
<!-- CODEUI-RULES -->
## Custom Rules

if it's a new feature, try to use a test cli unless it would be much easier to just have the user do a manual test (this is usually the case for visual features).. if it doesn't have functionality to do the test then add it. you can also use playwright mcp or curl if either of these would be easier. make sure you have enough logging to debug any issues.. if you create any test files, clean them up when you are done. If you need to restart the app use start.sh
<!-- /CODEUI-RULES -->
