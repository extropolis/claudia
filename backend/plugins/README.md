# Claudia Plugins

This directory contains optional plugins that extend Claudia's functionality.

## Available Plugins

### AI Provider Plugins

Plugins that add support for different AI model providers:

- `sap-ai-core-plugin` - SAP AI Core integration (coming soon)
- `hai-proxy-plugin` - Hyperspace AI Proxy lifecycle management (coming soon)

## Installing Plugins

### Option 1: Local Development

Place plugin directories here:

```
backend/plugins/
├── sap-ai-core-plugin/
│   ├── plugin.json
│   ├── index.js
│   └── ...
└── hai-proxy-plugin/
    ├── plugin.json
    ├── index.js
    └── ...
```

### Option 2: NPM Packages

Install plugins as npm packages:

```bash
cd backend
npm install @sap/claudia-ai-core-plugin
```

Then symlink to the plugins directory:

```bash
ln -s node_modules/@sap/claudia-ai-core-plugin plugins/sap-ai-core-plugin
```

## Creating a Plugin

See `PLUGIN-ARCHITECTURE.md` for detailed documentation on creating plugins.

### Quick Start

1. Create a new directory in `backend/plugins/`
2. Add a `plugin.json` manifest
3. Create an `index.ts` entry point that implements `BackendPlugin`
4. Build your plugin (`tsc` or `esbuild`)
5. Restart Claudia - your plugin will be auto-discovered

### Minimal Example

```json
// plugin.json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "type": "ai-provider",
  "displayName": "My Plugin",
  "description": "A sample plugin",
  "backend": {
    "entry": "./index.js",
    "provides": {
      "apiMode": "my-provider"
    }
  }
}
```

```typescript
// index.ts
import { BackendPlugin, PluginContext } from '../src/plugin-system';

export default class MyPlugin implements BackendPlugin {
  async initialize(context: PluginContext) {
    console.log('My plugin initialized!');
  }
}
```

## Plugin Discovery

Plugins are automatically discovered when:
- Claudia starts
- The server restarts
- Plugins directory is scanned

Plugins must have a valid `plugin.json` manifest to be loaded.

## Troubleshooting

**Plugin not loading?**
- Check that `plugin.json` exists and is valid JSON
- Ensure the `backend.entry` path is correct
- Check server logs for plugin loading errors
- Verify the plugin exports a default class implementing `BackendPlugin`

**Plugin crashes?**
- Check plugin logs in server console
- Verify all required dependencies are installed
- Test plugin's `initialize()` method

## Plugin Development

During development, use `tsx watch` to auto-reload:

```bash
cd backend
npm run dev
```

Changes to plugin files will trigger a server restart and reload your plugin.
