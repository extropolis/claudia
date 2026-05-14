/**
 * Plugin Manager
 *
 * Discovers, loads, and manages plugins for the Claudia backend.
 * Handles plugin lifecycle, route registration, and configuration.
 */

import { Router } from 'express';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../logger.js';
import { BackendPlugin, PluginManifest, PluginContext, PluginMetadata } from './plugin-types.js';

const logger = createLogger('[PluginManager]');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class PluginManager {
  private plugins: Map<string, BackendPlugin> = new Map();
  private pluginPaths: Map<string, string> = new Map();
  private context: PluginContext;

  constructor(context: PluginContext) {
    this.context = context;
  }

  /**
   * Discover and load plugins from a directory
   */
  async discoverPlugins(pluginDir: string): Promise<void> {
    if (!existsSync(pluginDir)) {
      logger.info(`Plugin directory not found: ${pluginDir}`);
      return;
    }

    logger.info(`Discovering plugins in: ${pluginDir}`);

    try {
      const entries = readdirSync(pluginDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const pluginPath = join(pluginDir, entry.name);
        const manifestPath = join(pluginPath, 'plugin.json');

        if (existsSync(manifestPath)) {
          await this.loadPlugin(pluginPath);
        }
      }

      logger.info(`Loaded ${this.plugins.size} plugin(s)`);
    } catch (error) {
      logger.error('Error discovering plugins:', { error });
    }
  }

  /**
   * Load a single plugin from a directory
   */
  async loadPlugin(pluginPath: string): Promise<void> {
    try {
      const manifestPath = join(pluginPath, 'plugin.json');
      const manifest: PluginManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

      logger.info(`Loading plugin: ${manifest.displayName} (${manifest.name})`);

      // Validate manifest
      if (!manifest.name || !manifest.version || !manifest.displayName) {
        throw new Error('Invalid plugin manifest: missing required fields');
      }

      // Check if plugin is enabled in config
      if (!this.context.configStore.isPluginEnabled(manifest.name)) {
        logger.info(`Plugin ${manifest.name} is disabled, skipping`);
        return;
      }

      // Check if plugin already loaded
      if (this.plugins.has(manifest.name)) {
        logger.warn(`Plugin ${manifest.name} already loaded, skipping`);
        return;
      }

      // Dynamic import of plugin entry point
      if (!manifest.backend?.entry) {
        logger.warn(`Plugin ${manifest.name} has no backend entry, skipping`);
        return;
      }

      const entryPath = join(pluginPath, manifest.backend.entry);
      // Add cache busting for hot reload during development
      const cacheBust = `?t=${Date.now()}`;
      const pluginModule = await import(entryPath + cacheBust);

      const PluginClass = pluginModule.default || pluginModule;
      const plugin: BackendPlugin = new PluginClass();
      plugin.manifest = manifest;

      // Initialize plugin
      if (plugin.initialize) {
        await plugin.initialize(this.context);
      }

      this.plugins.set(manifest.name, plugin);
      this.pluginPaths.set(manifest.name, pluginPath);

      logger.info(`Plugin loaded successfully: ${manifest.displayName}`);
    } catch (error) {
      logger.error(`Failed to load plugin from ${pluginPath}:`, { error });
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
   * Get plugin metadata for all loaded plugins
   */
  getPluginMetadata(): PluginMetadata[] {
    const metadata: PluginMetadata[] = [];

    for (const plugin of this.plugins.values()) {
      const manifest = plugin.manifest;
      metadata.push({
        name: manifest.name,
        version: manifest.version,
        type: manifest.type,
        displayName: manifest.displayName,
        description: manifest.description,
        author: manifest.author,
        apiMode: manifest.backend?.provides.apiMode,
        models: manifest.backend?.provides.models,
        configSchema: manifest.backend?.provides.configSchema,
        hasSettingsUI: !!manifest.frontend?.settingsComponent,
        enabled: true, // Only loaded plugins are returned here
      });
    }

    return metadata;
  }

  /**
   * Get metadata for all available plugins (both enabled and disabled)
   */
  getAllAvailablePlugins(pluginDir: string): PluginMetadata[] {
    const metadata: PluginMetadata[] = [];

    if (!existsSync(pluginDir)) {
      return metadata;
    }

    try {
      const entries = readdirSync(pluginDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const pluginPath = join(pluginDir, entry.name);
        const manifestPath = join(pluginPath, 'plugin.json');

        if (existsSync(manifestPath)) {
          try {
            const manifest: PluginManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

            const enabled = this.context.configStore.isPluginEnabled(manifest.name);

            metadata.push({
              name: manifest.name,
              version: manifest.version,
              type: manifest.type,
              displayName: manifest.displayName,
              description: manifest.description,
              author: manifest.author,
              apiMode: manifest.backend?.provides?.apiMode,
              models: manifest.backend?.provides?.models,
              configSchema: manifest.backend?.provides?.configSchema,
              hasSettingsUI: !!manifest.frontend?.settingsComponent,
              enabled,
            });
          } catch (error) {
            logger.error(`Error reading plugin manifest from ${manifestPath}:`, { error });
          }
        }
      }
    } catch (error) {
      logger.error('Error listing available plugins:', { error });
    }

    return metadata;
  }

  /**
   * Register plugin routes with Express
   */
  registerRoutes(app: Router): void {
    logger.info('Registering plugin routes...');

    // First pass: register ai-provider plugins at Anthropic API paths if they match current apiMode
    const currentApiMode = this.context.configStore.getApiMode();
    for (const [name, plugin] of this.plugins.entries()) {
      if (
        plugin.manifest.type === 'ai-provider' &&
        plugin.manifest.backend?.provides?.apiMode === currentApiMode &&
        plugin.getRouter
      ) {
        try {
          const router = plugin.getRouter();
          // Mount at Anthropic-specific paths only, not root
          app.use('/v1', router);
          app.use('/anthropic', router);
          logger.info(`Registered AI provider routes for ${name} at /v1 and /anthropic`);
        } catch (error) {
          logger.error(`Error registering routes for ${name}:`, { error });
        }
      }
    }

    // Second pass: register all plugins at /plugins/{name}/
    for (const [name, plugin] of this.plugins.entries()) {
      if (plugin.getRouter) {
        try {
          const router = plugin.getRouter();
          const basePath = `/plugins/${name}`;
          app.use(basePath, router);
          logger.info(`Registered routes for ${name} at ${basePath}`);
        } catch (error) {
          logger.error(`Error registering routes for ${name}:`, { error });
        }
      }
    }
  }

  /**
   * Get task environment variables from plugin
   */
  getTaskEnvironment(apiMode: string, config: any): Record<string, string> {
    const plugin = this.getPluginByApiMode(apiMode);
    if (plugin?.getTaskEnvironment) {
      try {
        return plugin.getTaskEnvironment(config);
      } catch (error) {
        logger.error(`Error getting task environment from plugin:`, { error });
      }
    }
    return {};
  }

  /**
   * Validate config using plugin's validator
   */
  validatePluginConfig(apiMode: string, config: any): { valid: boolean; error?: string } {
    const plugin = this.getPluginByApiMode(apiMode);
    if (plugin?.validateConfig) {
      try {
        return plugin.validateConfig(config);
      } catch (error) {
        return {
          valid: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return { valid: true };
  }

  /**
   * Test connection using plugin's test method
   */
  async testPluginConnection(
    apiMode: string,
    config: any,
  ): Promise<{ success: boolean; error?: string }> {
    const plugin = this.getPluginByApiMode(apiMode);
    if (plugin?.testConnection) {
      try {
        return await plugin.testConnection(config);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return { success: false, error: 'Plugin does not support connection testing' };
  }

  /**
   * Notify plugins of config changes
   */
  async notifyConfigChange(apiMode: string, config: any): Promise<void> {
    const plugin = this.getPluginByApiMode(apiMode);
    if (plugin?.onConfigChange) {
      try {
        await plugin.onConfigChange(config);
      } catch (error) {
        logger.error(`Error notifying plugin of config change:`, { error });
      }
    }
  }

  /**
   * Shutdown all plugins
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down plugins...');

    for (const [name, plugin] of this.plugins.entries()) {
      if (plugin.shutdown) {
        try {
          await plugin.shutdown();
          logger.info(`Plugin ${name} shut down successfully`);
        } catch (error) {
          logger.error(`Error shutting down plugin ${name}:`, { error });
        }
      }
    }

    this.plugins.clear();
    this.pluginPaths.clear();
  }
}
