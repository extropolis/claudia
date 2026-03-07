/**
 * Plugin System
 *
 * Main exports for the Claudia plugin system
 */

export { PluginManager } from './plugin-manager.js';
export { validateManifest, createManifestTemplate } from './plugin-registry.js';
export type {
    PluginManifest,
    BackendPlugin,
    PluginContext,
    PluginMetadata,
    RouteDefinition,
    ConfigSchema,
    ModelDefinition,
    HookDefinition,
    FrontendPlugin
} from './plugin-types.js';
