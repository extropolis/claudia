# Claudia Development Guide

## ⚠️ CRITICAL: DO NOT RESTART THE SERVER

**NEVER run `./start.sh`, `.\start.ps1`, `npm run dev`, or kill/restart the server during development.**

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

**macOS / Linux:**
```bash
./start.sh
```

**Windows (PowerShell):**
```powershell
.\start.ps1
```

The lock file will prevent accidental duplicate starts.

## Cross-Platform Notes

- **Windows**: Use `.\start.ps1` for startup. Use forward slashes `/` for paths in code, backslashes `\` in shell commands.
- **macOS/Linux**: Use `./start.sh` for startup.
- The codebase uses `@homebridge/node-pty-prebuilt-multiarch` for cross-platform PTY support.
- CI runs on both Ubuntu and Windows to ensure compatibility.
## Releasing

1. Update `version.txt` to the new version number
2. Run `node scripts/bump-version.mjs` to sync all `package.json` files
3. Commit with message `chore: release vX.Y.Z`
4. Push, tag (`vX.Y.Z`), and create a GitHub release

<!-- CODEUI-RULES -->
## Custom Rules

if it's a new feature, try to use a test cli unless it would be much easier to just have the user do a manual test (this is usually the case for visual features).. if it doesn't have functionality to do the test then add it. you can also use playwright mcp or curl if either of these would be easier. make sure you have enough logging to debug any issues.. if you create any test files, clean them up when you are done.  NEVER TOUCH PORT 4001.. if you are having issues with public apis, lookup examples online. always review your changes for gaps and issues after making extensive changes.
<!-- /CODEUI-RULES -->
