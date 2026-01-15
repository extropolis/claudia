# Gemini Agent Protocols

## Multi-Instance Development
**IMPORTANT**: Multiple Claude Code instances can work on this project simultaneously!

### Backend Auto-Reload
- ✅ **Backend auto-reloads on file changes** - Uses `tsx watch` (already configured)
- ❌ **DO NOT manually restart the backend** - It watches for changes and reloads automatically
- ✅ **Just write code and test** - Changes take effect within 1-2 seconds
- ⚠️ **If backend is not running** - User will start it with `./start.sh`

### Testing Protocol
- **Always** test new features and fixes using the CLI (`backend/test-cli.ts`)
- **CLI is auto-reload friendly** - Run tests immediately after code changes
- **Adequate logging** - Ensure enough logging to verify tests via CLI
- **Auto-run commands** - Use `run_command` with `SafeToAutoRun: true` for shell commands unless clearly destructive

### Multi-Instance Best Practices
1. **Focus on your task** - Don't worry about other instances
2. **Test immediately** - Backend reloads automatically, test right away
3. **Use the CLI** - Primary testing tool for all features
4. **Extend CLI** - If CLI lacks functionality, add it before testing
5. **Commit often** - Help other instances stay in sync

### What NOT to Do
- ❌ Don't restart the backend manually
- ❌ Don't worry about "interfering" with other instances
- ❌ Don't ask user to restart anything
- ❌ Don't pause for "coordination" - just work!

If you notice bad or legacy code, prompt the user to refactor it.

##

