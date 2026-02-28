---
name: list-tasks
description: List all tasks in the Claudia orchestrator using the test CLI. Use when you need to see running or completed tasks.
allowed-tools: Bash, Read
---

# List Claudia Tasks

Run the test CLI to list all tasks in the orchestrator:

```bash
cd /Users/I850333/projects/experiments/claudia/backend && npx tsx test-cli.ts --list-tasks
```

Format the output nicely showing:
- Task ID
- Task name
- Status (running/completed/error)
- Workspace

If $ARGUMENTS contains a task ID, also show detailed info for that specific task.
