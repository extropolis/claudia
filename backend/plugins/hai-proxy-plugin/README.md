# HAI Proxy Plugin

This plugin integrates Hyperspace AI (HAI) proxy with Claudia, providing automatic lifecycle management for the HAI proxy process.

## Features

- **Automatic Lifecycle Management** - Starts/stops HAI proxy process as needed
- **API Key Generation** - Generates and manages secure API keys automatically
- **Process Recovery** - Detects and reuses existing proxy instances after server restart
- **Headless Mode** - Runs HAI proxy in detached mode for reliability
- **Configuration Persistence** - Saves proxy configuration to config store
- **Request Sanitization** - Cleans requests to work with HAI proxy format restrictions

## Configuration

The plugin requires HAI CLI to be installed:

```bash
npm install -g @hyperspace-ai/hai
```

### Config Options

- **proxyUrl**: HAI proxy URL (default: `http://localhost:6655`)
- **apiKey**: API key for authentication (auto-generated on start)
- **model**: Model name to inject in responses (optional)
- **alwaysThinkingEnabled**: Enable always-thinking mode (default: false)

## Usage

### Starting the Proxy

```bash
curl -X POST http://localhost:4001/plugins/hai-proxy-plugin/start
```

Returns:
```json
{
  "success": true,
  "apiKey": "uuid-here",
  "proxyUrl": "http://localhost:6655",
  "pid": 12345
}
```

### Checking Status

```bash
curl http://localhost:4001/plugins/hai-proxy-plugin/status
```

Returns:
```json
{
  "haiInstalled": true,
  "proxyRunning": true,
  "apiKey": "uuid-here",
  "proxyUrl": "http://localhost:6655",
  "pid": 12345
}
```

### Stopping the Proxy

```bash
curl -X POST http://localhost:4001/plugins/hai-proxy-plugin/stop
```

### Using the Proxy

Once started, the proxy is available at:

- **Messages API**: `POST /plugins/hai-proxy-plugin/hyperspace/v1/messages`
- **Models API**: `GET /plugins/hai-proxy-plugin/hyperspace/v1/models`

## Architecture

### Components

- **HaiProxyPlugin**: Main plugin class managing lifecycle
- **HyperspaceProxyRouter**: Express router for API proxying
- **Request Sanitization**: Filters unsupported fields and content types
- **Token Tracking**: Reports usage to Claudia's usage tracker

### Lifecycle Management

1. **Startup**: Plugin checks for existing proxy with stored API key
2. **Start Request**: Generates UUID API key, spawns `hai proxy start` in detached mode
3. **Configuration**: Runs `hai configure claude-code` to set up CLI
4. **Persistence**: Saves config to store for recovery after restart
5. **Recovery**: On server restart, detects running proxy and restores key
6. **Shutdown**: Kills managed proxy process on plugin shutdown

### Request Processing

The plugin sanitizes requests before forwarding to HAI proxy:

- **Field Filtering**: Only allows standard Anthropic API fields
- **Tool Sanitization**: Unwraps custom tool formats and strips unsupported fields
- **Content Filtering**: Removes unsupported content types (e.g., `tool_reference`)
- **Cache Control**: Strips `scope` from cache_control objects
- **Warmup Interception**: Blocks Claude Code warmup requests locally

### Response Processing

- **Model Injection**: Injects configured model name into responses
- **Token Tracking**: Extracts usage from streaming and non-streaming responses
- **Usage Reporting**: Reports token counts to Claudia usage tracker

## Development

### Project Structure

```
hai-proxy-plugin/
├── plugin.json              # Plugin manifest
├── index.js                 # Main plugin class
├── hyperspace-proxy/        # Proxy implementation
│   ├── index.js            # Router and request handling
│   └── index.ts            # TypeScript source
└── README.md               # This file
```

### Plugin Interface

The plugin implements the `BackendPlugin` interface:

```javascript
class HaiProxyPlugin {
    async initialize(context);
    getRouter();
    validateConfig(config);
    async testConnection(config);
    async onConfigChange(config);
    getTaskEnvironment(config);
    async shutdown();

    // Internal helpers
    async checkHaiInstalled();
    async isHaiProxyRunning(apiKey, proxyUrl);
}
```

## Troubleshooting

### Proxy Won't Start

- Check that HAI CLI is installed: `which hai`
- Check that port 6655 is available: `lsof -i :6655`
- Check HAI CLI logs for errors

### 401 Unauthorized

- API key mismatch - restart the proxy via `/start` endpoint
- Old proxy running - kill with `killall hai` and restart

### Missing Models

- Check HAI proxy logs
- Verify HAI CLI is authenticated properly
- Try restarting the proxy

## License

Copyright Hyperspace AI
