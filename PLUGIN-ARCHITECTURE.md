# Claudia Plugin System Architecture

## Overview

A modular plugin system that allows dynamic loading of backend providers and proxy services without modifying the core codebase.

## Goals

1. **Single Codebase**: Maintain one repo (Extropolis) with optional plugins
2. **Clean Separation**: Core app works without plugins, plugins extend functionality
3. **Easy Distribution**: Plugins can be npm packages or local directories
4. **Zero Core Changes**: Plugins register themselves without modifying core code
5. **Hot Reload**: Plugins can be added/removed without server restart (optional)

## Architecture

### Directory Structure

```
claudia/
├── backend/
│   ├── src/
│   │   ├── plugin-system/
│   │   │   ├── plugin-manager.ts      # Core plugin loader
│   │   │   ├── plugin-registry.ts     # Plugin registration
│   │   │   └── plugin-types.ts        # TypeScript interfaces
│   │   ├── server.ts                  # Modified to support plugins
│   │   └── ...
│   └── plugins/                        # Optional plugins directory
│       ├── sap-ai-core-plugin/
│       │   ├── package.json
│       │   ├── plugin.json            # Plugin manifest
│       │   ├── index.ts               # Plugin entry point
│       │   ├── anthropic-proxy/       # Existing code
│       │   └── README.md
│       └── hai-proxy-plugin/
│           ├── package.json
│           ├── plugin.json
│           ├── index.ts
│           ├── hyperspace-proxy/      # Existing code
│           ├── hai-manager.ts
│           └── README.md
├── frontend/
│   └── src/
│       ├── plugin-system/
│       │   └── plugin-loader.tsx      # Frontend plugin loader
│       └── ...
└── package.json
```

## Plugin Manifest (plugin.json)

Each plugin has a manifest describing its capabilities:

```json
{
  "name": "sap-ai-core-plugin",
  "version": "1.0.0",
  "type": "ai-provider",
  "displayName": "SAP AI Core",
  "description": "Use Claude models through SAP AI Core deployment",
  "author": "SAP",

  "backend": {
    "entry": "./index.js",
    "provides": {
      "apiMode": "sap-ai-core",
      "routes": [
        {
          "path": "/v1/messages",
          "method": "POST",
          "handler": "anthropicProxy"
        },
        {
          "path": "/v1/embeddings",
          "method": "POST",
          "handler": "embeddingsProxy"
        }
      ],
      "configSchema": {
        "clientId": { "type": "string", "required": true },
        "clientSecret": { "type": "string", "required": true, "secret": true },
        "authUrl": { "type": "string", "required": true },
        "baseUrl": { "type": "string", "required": true },
        "resourceGroup": { "type": "string", "default": "default" },
        "timeoutMs": { "type": "number", "default": 120000 }
      },
      "models": [
        { "id": "anthropic--claude-4.5-opus", "name": "Claude 4.5 Opus" },
        { "id": "anthropic--claude-4.5-sonnet", "name": "Claude 4.5 Sonnet" }
      ]
    }
  },

  "frontend": {
    "settingsComponent": "./SettingsUI.tsx",
    "assets": ["./logo.svg"]
  },

  "dependencies": {
    "axios": "^1.6.0"
  }
}
```

## Plugin Types

### Backend Plugin Interface

```typescript
// backend/src/plugin-system/plugin-types.ts

import { Router } from 'express';
import { ConfigStore } from '../config-store.js';

export interface PluginManifest {
  name: string;
  version: string;
  type: 'ai-provider' | 'utility' | 'integration';
  displayName: string;
  description: string;
  author?: string;

  backend?: {
    entry: string;
    provides: {
      apiMode?: string;
      routes?: RouteDefinition[];
      configSchema?: ConfigSchema;
      models?: ModelDefinition[];
      hooks?: HookDefinition[];
    };
  };

  frontend?: {
    settingsComponent?: string;
    assets?: string[];
  };

  dependencies?: Record<string, string>;
}

export interface RouteDefinition {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  handler: string;
  middleware?: string[];
}

export interface ConfigSchema {
  [key: string]: {
    type: 'string' | 'number' | 'boolean' | 'array' | 'object';
    required?: boolean;
    default?: any;
    secret?: boolean;
    description?: string;
  };
}

export interface ModelDefinition {
  id: string;
  name: string;
  tier?: 'opus' | 'sonnet' | 'haiku';
}

export interface HookDefinition {
  event: string;
  handler: string;
}

export interface PluginContext {
  configStore: ConfigStore;
  logger: any;
  express: typeof import('express');
  utils: {
    spawn: typeof import('child_process').spawn;
    fetch: typeof fetch;
  };
}

export interface BackendPlugin {
  manifest: PluginManifest;

  // Lifecycle hooks
  initialize?(context: PluginContext): Promise<void>;
  onConfigChange?(config: any): Promise<void>;
  shutdown?(): Promise<void>;

  // Route handlers
  getRouter?(): Router;

  // Task environment
  getTaskEnvironment?(config: any): Record<string, string>;

  // Validation
  validateConfig?(config: any): { valid: boolean; error?: string };
  testConnection?(config: any): Promise<{ success: boolean; error?: string }>;
}

export interface FrontendPlugin {
  SettingsComponent: React.ComponentType<{
    config: any;
    onChange: (config: any) => void;
    onTest?: () => Promise<void>;
  }>;
}
```

## Plugin Manager

```typescript
// backend/src/plugin-system/plugin-manager.ts

import { Router } from 'express';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { BackendPlugin, PluginManifest, PluginContext } from './plugin-types.js';

export class PluginManager {
  private plugins: Map<string, BackendPlugin> = new Map();
  private pluginPaths: Map<string, string> = new Map();

  constructor(private context: PluginContext) {}

  /**
   * Discover and load plugins from a directory
   */
  async discoverPlugins(pluginDir: string): Promise<void> {
    if (!existsSync(pluginDir)) {
      console.log(`[PluginManager] Plugin directory not found: ${pluginDir}`);
      return;
    }

    const entries = readdirSync(pluginDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const pluginPath = join(pluginDir, entry.name);
      const manifestPath = join(pluginPath, 'plugin.json');

      if (existsSync(manifestPath)) {
        await this.loadPlugin(pluginPath);
      }
    }
  }

  /**
   * Load a single plugin from a directory
   */
  async loadPlugin(pluginPath: string): Promise<void> {
    try {
      const manifestPath = join(pluginPath, 'plugin.json');
      const manifest: PluginManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

      console.log(`[PluginManager] Loading plugin: ${manifest.displayName} (${manifest.name})`);

      // Dynamic import of plugin entry point
      const entryPath = join(pluginPath, manifest.backend?.entry || 'index.js');
      const pluginModule = await import(entryPath);

      const plugin: BackendPlugin = pluginModule.default || pluginModule;
      plugin.manifest = manifest;

      // Initialize plugin
      if (plugin.initialize) {
        await plugin.initialize(this.context);
      }

      this.plugins.set(manifest.name, plugin);
      this.pluginPaths.set(manifest.name, pluginPath);

      console.log(`[PluginManager] Plugin loaded: ${manifest.displayName}`);
    } catch (error) {
      console.error(`[PluginManager] Failed to load plugin from ${pluginPath}:`, error);
    }
  }

  /**
   * Get all loaded plugins
   */
  getPlugins(): Map<string, BackendPlugin> {
    return this.plugins;
  }

  /**
   * Get plugin by name
   */
  getPlugin(name: string): BackendPlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Get plugin by API mode
   */
  getPluginByApiMode(apiMode: string): BackendPlugin | undefined {
    for (const plugin of this.plugins.values()) {
      if (plugin.manifest.backend?.provides.apiMode === apiMode) {
        return plugin;
      }
    }
    return undefined;
  }

  /**
   * Register plugin routes with Express
   */
  registerRoutes(app: Router): void {
    for (const [name, plugin] of this.plugins.entries()) {
      if (plugin.getRouter) {
        const router = plugin.getRouter();
        const basePath = `/plugins/${name}`;
        app.use(basePath, router);
        console.log(`[PluginManager] Registered routes for ${name} at ${basePath}`);
      }
    }
  }

  /**
   * Get task environment variables from plugin
   */
  getTaskEnvironment(apiMode: string, config: any): Record<string, string> {
    const plugin = this.getPluginByApiMode(apiMode);
    if (plugin?.getTaskEnvironment) {
      return plugin.getTaskEnvironment(config);
    }
    return {};
  }

  /**
   * Shutdown all plugins
   */
  async shutdown(): Promise<void> {
    for (const [name, plugin] of this.plugins.entries()) {
      if (plugin.shutdown) {
        try {
          await plugin.shutdown();
          console.log(`[PluginManager] Plugin ${name} shut down`);
        } catch (error) {
          console.error(`[PluginManager] Error shutting down ${name}:`, error);
        }
      }
    }
  }
}
```

## Example Plugin: SAP AI Core

```typescript
// backend/plugins/sap-ai-core-plugin/index.ts

import { Router } from 'express';
import { BackendPlugin, PluginContext } from '../../src/plugin-system/plugin-types.js';
import { createAnthropicProxy } from './anthropic-proxy/index.js';

export default class SapAiCorePlugin implements BackendPlugin {
  private context!: PluginContext;
  private proxyInstance: any = null;

  async initialize(context: PluginContext): Promise<void> {
    this.context = context;
    console.log('[SapAiCorePlugin] Initialized');
  }

  getRouter(): Router {
    const router = Router();

    // Mount proxy routes
    const config = this.context.configStore.getConfig();
    const credentials = config.aiCoreCredentials;

    if (credentials) {
      this.proxyInstance = createAnthropicProxy({
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        authUrl: credentials.authUrl,
        baseUrl: credentials.baseUrl,
        resourceGroup: credentials.resourceGroup || 'default',
        requestTimeoutMs: credentials.timeoutMs || 120000
      });

      // Mount at plugin base path (will be /plugins/sap-ai-core-plugin/)
      router.use('/', this.proxyInstance.router);
    }

    return router;
  }

  getTaskEnvironment(config: any): Record<string, string> {
    const backendPort = process.env.PORT || 4001;
    return {
      ANTHROPIC_BASE_URL: `http://localhost:${backendPort}/plugins/sap-ai-core-plugin`,
      ANTHROPIC_API_KEY: 'sk-ant-dummy-sap-ai-core',
      ANTHROPIC_MODEL: config.sapAiCoreModel || 'anthropic--claude-4.5-sonnet'
    };
  }

  validateConfig(config: any): { valid: boolean; error?: string } {
    if (!config.clientId) return { valid: false, error: 'Client ID required' };
    if (!config.clientSecret) return { valid: false, error: 'Client Secret required' };
    if (!config.authUrl) return { valid: false, error: 'Auth URL required' };
    if (!config.baseUrl) return { valid: false, error: 'Base URL required' };
    return { valid: true };
  }

  async testConnection(config: any): Promise<{ success: boolean; error?: string }> {
    // Test logic here
    return { success: true };
  }

  async onConfigChange(config: any): Promise<void> {
    // Recreate proxy with new config
    if (this.proxyInstance?.updateConfig) {
      this.proxyInstance.updateConfig(config);
    }
  }

  async shutdown(): Promise<void> {
    console.log('[SapAiCorePlugin] Shutting down');
  }
}
```

## Server Integration

```typescript
// backend/src/server.ts (modified)

import { PluginManager } from './plugin-system/plugin-manager.js';
import { PluginContext } from './plugin-system/plugin-types.js';

export async function createApp(basePath?: string) {
  const app = express();
  const configStore = new ConfigStore(basePath);

  // Initialize plugin system
  const pluginContext: PluginContext = {
    configStore,
    logger: createLogger('[Plugin]'),
    express,
    utils: { spawn, fetch }
  };

  const pluginManager = new PluginManager(pluginContext);

  // Discover and load plugins
  const pluginsDir = join(__dirname, '..', 'plugins');
  await pluginManager.discoverPlugins(pluginsDir);

  // Register plugin routes
  pluginManager.registerRoutes(app);

  // ... rest of server setup ...

  // Use plugin for task environment
  taskSpawner.setPluginManager(pluginManager);

  return { app, server, pluginManager };
}
```

## Frontend Plugin Loader

```typescript
// frontend/src/plugin-system/plugin-loader.tsx

export class FrontendPluginLoader {
  private plugins: Map<string, any> = new Map();

  async loadPlugins(): Promise<void> {
    // Fetch available plugins from backend
    const response = await fetch('/api/plugins');
    const pluginList = await response.json();

    for (const pluginInfo of pluginList) {
      if (pluginInfo.frontend?.settingsComponent) {
        // Dynamic import of frontend component
        const component = await import(
          /* @vite-ignore */
          `/plugins/${pluginInfo.name}/${pluginInfo.frontend.settingsComponent}`
        );
        this.plugins.set(pluginInfo.name, component.default);
      }
    }
  }

  getSettingsComponent(pluginName: string): React.ComponentType | undefined {
    return this.plugins.get(pluginName);
  }
}
```

## Benefits

1. **Clean Separation**: SAP/Concur-specific code stays in plugins
2. **Easy Distribution**: Plugins can be npm packages (`@sap/claudia-ai-core-plugin`)
3. **No Core Changes**: Extropolis repo doesn't need SAP-specific code
4. **Flexible Deployment**: Include/exclude plugins per environment
5. **Better Testing**: Test plugins independently
6. **Version Management**: Plugin versions independent of core

## Migration Path

1. **Phase 1**: Implement plugin system in Extropolis repo
2. **Phase 2**: Extract SAP AI Core into plugin
3. **Phase 3**: Extract HAI Proxy into plugin
4. **Phase 4**: Test plugins work standalone
5. **Phase 5**: Deprecate Concur repo, use Extropolis + plugins

## Plugin Distribution

```bash
# Install as npm package
npm install @sap/claudia-ai-core-plugin

# Or use local directory
ln -s /path/to/sap-plugins backend/plugins/
```

## Next Steps

1. Implement core plugin system
2. Create plugin template/generator
3. Migrate SAP AI Core to plugin
4. Migrate HAI Proxy to plugin
5. Document plugin development guide
