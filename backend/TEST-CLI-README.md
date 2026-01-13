# Test CLI - Comprehensive Testing Tool

The Test CLI is a non-interactive command-line tool that emulates the frontend to test all orchestrator functionality. It now supports **all frontend features** including chat, tasks, workspaces, plans, and configuration management.

## Features

The CLI now provides complete coverage of all frontend capabilities:

### ✅ Chat Operations
- Send chat messages
- Attach images to messages
- Clear conversation history

### ✅ Task Management
- Create tasks directly
- Send input to running tasks (resume/continue)
- Stop running tasks
- Delete specific tasks
- Clear all tasks
- List all tasks with status
- View code files created by tasks

### ✅ Workspace Management
- Create workspaces from project paths
- Delete workspaces
- Set active workspace
- Associate tasks with workspaces

### ✅ Project Management
- Set current project directory

### ✅ Plan Mode Operations
- Approve plans
- Reject plans
- Toggle auto-approve mode

### ✅ Configuration
- Get orchestrator configuration
- View system prompts and settings

## Installation

No additional installation needed. The CLI uses the same dependencies as the backend.

## Usage

```bash
# Basic usage
npx tsx test-cli.ts [options]

# Or make it executable
chmod +x test-cli.ts
./test-cli.ts [options]
```

## Command Reference

### Basic Options

| Option | Description | Default |
|--------|-------------|---------|
| `--url <url>` | Backend WebSocket URL | `ws://localhost:3001` |
| `--message, -m <text>` | Message/description to send | `echo hello world` |
| `--timeout, -t <ms>` | Timeout in milliseconds | `120000` (2 min) |
| `--verbose, -v` | Show all WebSocket events | `false` |
| `--auth, -a <code>` | Auth code | `asdf123` |
| `--help, -h` | Show help message | - |

### Chat Operations

| Option | Description | Required Params |
|--------|-------------|----------------|
| `--clear` | Test clear chat functionality | None |
| `--image, -i <path>` | Attach image to message | Image file path |

### Task Operations

| Option | Description | Required Params |
|--------|-------------|----------------|
| `--task` | Create task directly | `--message` |
| `--task-name, -n <name>` | Name for the task | Used with `--task` |
| `--task-id <id>` | Task ID for operations | Various operations |
| `--task-input` | Send input to task | `--task-id`, `--message` |
| `--stop-task` | Stop running task | `--task-id` |
| `--delete-task` | Delete specific task | `--task-id` |
| `--clear-tasks` | Clear all tasks | None |
| `--list-tasks` | List all tasks | None |
| `--view-files` | View task's code files | `--task-id` |

### Workspace Operations

| Option | Description | Required Params |
|--------|-------------|----------------|
| `--workspace, -w <id>` | Workspace ID for task | Used with `--task` |
| `--create-workspace` | Create new workspace | `--project-path` |
| `--delete-workspace` | Delete workspace | `--workspace` |
| `--set-active-workspace` | Set active workspace | `--workspace` |

### Project Operations

| Option | Description | Required Params |
|--------|-------------|----------------|
| `--set-project` | Set current project | `--project-path` |
| `--project-path, -p <path>` | Project path | Various operations |

### Plan Operations

| Option | Description | Required Params |
|--------|-------------|----------------|
| `--approve-plan` | Approve current plan | None |
| `--reject-plan` | Reject current plan | None |
| `--auto-approve <bool>` | Toggle auto-approve | `true` or `false` |

### Configuration

| Option | Description | Required Params |
|--------|-------------|----------------|
| `--get-config` | Get orchestrator config | None |

## Examples

### Basic Chat

```bash
# Simple chat message
npx tsx test-cli.ts -m "create a file called hello.txt"

# Chat with verbose logging
npx tsx test-cli.ts -v -m "list all .ts files"

# Chat with image attachment
npx tsx test-cli.ts -m "What's in this image?" -i ./screenshot.png
```

### Task Management

```bash
# Create a task
npx tsx test-cli.ts --task -m "run the tests" -n "Run Tests"

# Create task in specific workspace
npx tsx test-cli.ts --task -w /Users/me/project -m "build the app"

# List all tasks
npx tsx test-cli.ts --list-tasks

# Send input to a running task
npx tsx test-cli.ts --task-input --task-id abc123def -m "yes, continue with the fix"

# Stop a running task
npx tsx test-cli.ts --stop-task --task-id abc123def

# Delete a specific task
npx tsx test-cli.ts --delete-task --task-id abc123def

# Clear all tasks
npx tsx test-cli.ts --clear-tasks

# View code files created by a task
npx tsx test-cli.ts --view-files --task-id abc123def
```

### Workspace Management

```bash
# Create a workspace
npx tsx test-cli.ts --create-workspace -p /Users/me/my-project

# Delete a workspace
npx tsx test-cli.ts --delete-workspace -w workspace123

# Set active workspace
npx tsx test-cli.ts --set-active-workspace -w workspace123
```

### Plan Mode

```bash
# Enable auto-approve mode
npx tsx test-cli.ts --auto-approve true

# Disable auto-approve mode
npx tsx test-cli.ts --auto-approve false

# Approve a plan (when auto-approve is off)
npx tsx test-cli.ts --approve-plan

# Reject a plan
npx tsx test-cli.ts --reject-plan
```

### Configuration

```bash
# Get full orchestrator configuration
npx tsx test-cli.ts --get-config
```

### Advanced Workflows

```bash
# Create workspace, set it active, and create a task in it
WORKSPACE_ID=$(npx tsx test-cli.ts --create-workspace -p /Users/me/project | grep -o 'workspace[0-9a-z]*')
npx tsx test-cli.ts --set-active-workspace -w $WORKSPACE_ID
npx tsx test-cli.ts --task -w $WORKSPACE_ID -m "run npm test" -n "Test Suite"

# Send chat message with image and verbose logging
npx tsx test-cli.ts -v -m "Analyze this screenshot for errors" -i ./error.png

# Clear chat history
npx tsx test-cli.ts --clear
```

## Output Formats

### Chat Messages
Shows real-time chat messages with timestamps and role indicators:
```
[1.2s] USER      │ create a file called hello.txt
[3.5s] ASSISTANT │ I'll create a file called hello.txt for you.
```

### Task List
Shows organized task list by workspace:
```
📋 TASK LIST
================================================================================

📁 /Users/me/project
--------------------------------------------------------------------------------
  ▶️ [abc123de...] Run Tests
     Status: running
  ✅ [def456gh...] Build App
     Status: complete
```

### Code Files
Shows created/modified/deleted files with syntax:
```
📂 CODE FILES
================================================================================

➕ src/hello.txt [created] (text)
--------------------------------------------------------------------------------
Hello World!
```

### Configuration
Shows full configuration as JSON:
```
⚙️  ORCHESTRATOR CONFIGURATION
================================================================================
{
  "systemPrompts": {
    "planResponse": "...",
    "conversational": "..."
  },
  "tools": [...],
  "mcpServers": {...}
}
```

## Testing Scenarios

### Scenario 1: Full Task Lifecycle
```bash
# 1. Create a task
npx tsx test-cli.ts --task -m "create hello.txt with 'Hello World'" -n "Create File"

# 2. List tasks to get task ID
npx tsx test-cli.ts --list-tasks

# 3. View files created (use task ID from step 2)
npx tsx test-cli.ts --view-files --task-id <task-id>

# 4. Delete the task
npx tsx test-cli.ts --delete-task --task-id <task-id>
```

### Scenario 2: Plan Mode Testing
```bash
# 1. Enable manual plan approval
npx tsx test-cli.ts --auto-approve false

# 2. Send a message that triggers plan creation
npx tsx test-cli.ts -m "refactor the authentication module"

# 3. Approve the plan (in another terminal while first is waiting)
npx tsx test-cli.ts --approve-plan

# 4. Re-enable auto-approve
npx tsx test-cli.ts --auto-approve true
```

### Scenario 3: Workspace Management
```bash
# 1. Create multiple workspaces
npx tsx test-cli.ts --create-workspace -p /Users/me/project-a
npx tsx test-cli.ts --create-workspace -p /Users/me/project-b

# 2. List all tasks to see workspaces
npx tsx test-cli.ts --list-tasks

# 3. Set active workspace
npx tsx test-cli.ts --set-active-workspace -w <workspace-id>

# 4. Create task in active workspace
npx tsx test-cli.ts --task -m "build the project" -n "Build"
```

## Comparison with Frontend

| Feature | Frontend | CLI | Notes |
|---------|----------|-----|-------|
| Chat messages | ✅ | ✅ | Full parity |
| Image attachments | ✅ | ✅ | Base64 encoding |
| Task creation | ✅ | ✅ | Full parity |
| Task input/resume | ✅ | ✅ | Full parity |
| Task stop/delete | ✅ | ✅ | Full parity |
| Task list view | ✅ | ✅ | CLI: terminal format |
| Code file viewer | ✅ | ✅ | CLI: terminal format |
| Workspace mgmt | ✅ | ✅ | Full parity |
| Plan approval | ✅ | ✅ | Full parity |
| Auto-approve toggle | ✅ | ✅ | Full parity |
| Config viewing | ✅ | ✅ | Full parity |
| Voice input | ✅ | ❌ | N/A for CLI |
| Voice output | ✅ | ❌ | N/A for CLI |
| UI interactions | ✅ | ❌ | N/A for CLI |

## Troubleshooting

### Connection Issues
```bash
# Check if backend is running
curl http://localhost:3000/health

# Try different URL
npx tsx test-cli.ts --url ws://localhost:3001 -m "test"
```

### Timeout Issues
```bash
# Increase timeout for long-running operations
npx tsx test-cli.ts -t 300000 -m "complex task"
```

### Image Loading Errors
```bash
# Verify image path is correct
ls -la ./image.png

# Use absolute path
npx tsx test-cli.ts -i /Users/me/screenshots/image.png -m "analyze"
```

### Task ID Not Found
```bash
# List all tasks first
npx tsx test-cli.ts --list-tasks

# Copy full task ID (not just the shortened version shown)
```

## Architecture

The CLI uses:
- **WebSocket** for real-time communication with the backend
- **fetch API** for REST endpoints (config, file viewing)
- **EventEmitter pattern** for message handling
- **Async/await** for operation sequencing

All message types match exactly what the frontend sends, ensuring perfect compatibility.

## Development

To extend the CLI:

1. Add new config option to `TestConfig` interface
2. Implement handler method (e.g., `sendNewOperation()`)
3. Add case to `run()` method's connection handler
4. Add command-line argument parsing in `parseArgs()`
5. Update help text with new option
6. Test with backend

## Best Practices

1. **Always use `--verbose`** when debugging
2. **Use `--list-tasks`** to get task IDs before operations
3. **Set reasonable timeouts** based on operation complexity
4. **Check backend logs** when CLI operations fail
5. **Use absolute paths** for files and projects
6. **Test with auto-approve** disabled to verify plan mode

## Future Enhancements

Potential additions:
- Interactive mode (prompt for input)
- Conversation selection/resumption
- Configuration modification (PUT /api/config)
- Task output streaming to file
- Batch operations from file
- JSON output mode for scripting

## Support

For issues or questions:
1. Check backend logs: `backend/logs/`
2. Use `--verbose` mode for detailed logging
3. Verify backend is running on correct port
4. Check CLAUDE.md for project-specific guidelines
