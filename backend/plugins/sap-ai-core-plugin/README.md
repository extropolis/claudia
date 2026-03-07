# SAP AI Core Plugin

This plugin integrates SAP AI Core with Claudia, allowing you to use Claude models deployed on SAP AI Core via AWS Bedrock.

## Features

- **Automatic OAuth2 token management** - Handles SAP AI Core authentication automatically
- **Model catalog** - Auto-discovers available Claude models from your SAP AI Core deployment
- **Credential validation** - Tests credentials before saving them
- **Seamless integration** - Works transparently as an Anthropic API proxy

## Configuration

The plugin requires the following SAP AI Core credentials:

- **Client ID**: OAuth2 client ID
- **Client Secret**: OAuth2 client secret
- **Auth URL**: OAuth2 token endpoint URL
- **Base URL**: SAP AI Core API base URL
- **Resource Group**: (Optional) Resource group name, defaults to "default"
- **Timeout**: (Optional) Request timeout in milliseconds, defaults to 120000

### Setup

1. Configure credentials in Claudia settings UI
2. Select "SAP AI Core" as your API mode
3. The plugin will automatically handle authentication and model discovery

### Environment Variables (Legacy)

For backward compatibility, the plugin also supports environment variables:

```bash
SAP_AICORE_CLIENT_ID=your-client-id
SAP_AICORE_CLIENT_SECRET=your-client-secret
SAP_AICORE_AUTH_URL=https://your-auth-url
SAP_AICORE_BASE_URL=https://your-api-url
SAP_AICORE_RESOURCE_GROUP=default  # optional
SAP_AICORE_TIMEOUT_MS=120000  # optional
```

## Architecture

### Components

- **AccessTokenProvider**: Manages OAuth2 tokens with automatic refresh
- **DeploymentCatalog**: Discovers and caches available models
- **RequestTransformer**: Converts Anthropic API requests to SAP AI Core format
- **StreamTransformer**: Handles streaming responses
- **UsageInterceptor**: Tracks token usage and reports to Claudia

### API Endpoints

When configured, the plugin mounts the following endpoints:

- `POST /v1/messages` - Send messages to Claude models
- `GET /v1/models` - List available models

## Development

### Project Structure

```
sap-ai-core-plugin/
├── plugin.json           # Plugin manifest
├── index.js             # Main plugin class
├── anthropic-proxy/     # Proxy implementation
│   ├── index.js
│   ├── access-token-provider.js
│   ├── deployment-catalog.js
│   ├── request-transformer.js
│   ├── stream-transformer.js
│   └── usage-interceptor.js
└── README.md            # This file
```

### Plugin Interface

The plugin implements the `BackendPlugin` interface:

```typescript
interface BackendPlugin {
    manifest: PluginManifest;
    initialize(context: PluginContext): Promise<void>;
    getRouter(): Router;
    validateConfig(config: any): { valid: boolean; error?: string };
    testConnection(config: any): Promise<{ success: boolean; error?: string }>;
    onConfigChange(config: any): Promise<void>;
    getTaskEnvironment(config: any): Record<string, string>;
    shutdown(): Promise<void>;
}
```

## License

Copyright SAP
