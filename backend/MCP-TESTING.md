# MCP Server Testing Guide

## Quick Start

### List configured MCP servers
```bash
npx tsx test-mcp.ts --list
```

### Test MCP server registration (no AI calls)
```bash
npx tsx test-mcp-direct.ts
```

### Test specific MCP server with AI interaction
```bash
npx tsx test-mcp.ts --server playwright
npx tsx test-mcp.ts --server framework-learner
```

### Test all MCP servers
```bash
npx tsx test-mcp.ts --all
```

## Available MCP Servers

### Playwright
Browser automation and web testing
```bash
npx tsx test-mcp.ts --server playwright
```

### Framework Learner
AI-powered code learning and knowledge base
```bash
npx tsx test-mcp.ts --server framework-learner
```

## Test Scripts

### `test-mcp.ts` - Full Testing
Tests MCP servers with AI interaction (requires credentials)

**Options:**
- `--list, -l` : List all configured servers
- `--server, -s <name>` : Test specific server
- `--all, -a` : Test all enabled servers
- `--verbose, -v` : Verbose output
- `--help, -h` : Show help

### `test-mcp-direct.ts` - Direct Testing
Tests MCP server registration without AI calls

**What it does:**
- Starts OpenCode server
- Registers MCP servers
- Checks connection status
- Queries OpenCode API

## Configuration

MCP servers are configured in `backend/orchestrator-config.json`:

```json
{
  "mcpServers": [
    {
      "name": "playwright",
      "command": "npx",
      "args": ["@playwright/mcp@latest"],
      "enabled": true
    },
    {
      "name": "framework-learner",
      "command": "npx",
      "args": ["tsx", "/path/to/learner/src/index.ts"],
      "enabled": true
    }
  ]
}
```

## Troubleshooting

### No AI responses
If you get no responses from AI:
- Check SAP AI Core credentials in environment
- Or use the main backend CLI: `npx tsx test-cli.ts`

### MCP server won't connect
- Check the command and args are correct
- Verify the MCP server binary exists
- Try running the command manually

### OpenCode won't start
- Check port 4097 is available
- Look for error messages in output
- Try restarting

## Advanced Usage

### Add new MCP server
Edit `backend/orchestrator-config.json`:
```json
{
  "mcpServers": [
    {
      "name": "my-server",
      "command": "node",
      "args": ["/path/to/server.js"],
      "env": {
        "API_KEY": "xxx"
      },
      "enabled": true
    }
  ]
}
```

Then test:
```bash
npx tsx test-mcp-direct.ts
npx tsx test-mcp.ts --server my-server
```

## See Also

- Main test CLI: `backend/test-cli.ts`
- OpenCode client: `backend/src/opencode-client.ts`
- Config store: `backend/src/config-store.ts`
