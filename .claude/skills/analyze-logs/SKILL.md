---
name: analyze-logs
description: Analyze Claudia backend logs for errors or issues. Use when debugging problems with the orchestrator.
allowed-tools: Bash, Read, Grep
---

# Analyze Claudia Logs

Analyze the Claudia orchestrator logs for issues.

1. **Check recent task histories** in `backend/task-histories/`
2. **Look for errors** - Search for ERROR, error, Exception, failed
3. **Check server status** - Look for connection issues, timeouts

If $ARGUMENTS is provided, filter logs for that specific term or task ID.

Provide a summary of:
- Recent errors found
- Potential issues identified
- Suggestions for fixes
