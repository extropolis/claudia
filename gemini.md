# Gemini Agent Protocols

## Testing Requirements
- **Always** test new features and fixes using the CLI (`backend/test-cli.ts`). But make sure there is enough logging in place to fix any issues that come up.
- **Default to CLI**: The CLI is the primary testing tool.
- **Extend CLI**: If the CLI lacks the functionality required for a test, you must implement it in the CLI before proceeding.
- **Logs**: Ensure adequate logging is available to verify tests via the CLI.
- **Auto-Run Commands**: Always use `run_command` with `SafeToAutoRun: true` for shell commands unless they are clearly destructive (like `rm -rf /`). Do not ask the user to run commands manually if you can run them.

If you notice bad or legacy code prompt the user to refactor it.

## 
