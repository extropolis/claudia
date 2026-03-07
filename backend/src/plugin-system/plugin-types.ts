/**
 * Plugin System Type Definitions
 *
 * Defines interfaces and types for the Claudia plugin system.
 * Plugins can extend functionality by providing AI providers, proxies, and integrations.
 */

import { Router } from 'express';
import { ConfigStore } from '../config-store.js';

/**
 * Plugin Manifest - describes plugin capabilities and configuration
 */
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

/**
 * Route definition for plugin-provided API endpoints
 */
export interface RouteDefinition {
    path: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    handler: string;
    middleware?: string[];
}

/**
 * Configuration schema for validating plugin config
 */
export interface ConfigSchema {
    [key: string]: {
        type: 'string' | 'number' | 'boolean' | 'array' | 'object';
        required?: boolean;
        default?: any;
        secret?: boolean;
        description?: string;
        enum?: any[];
    };
}

/**
 * Model definition for AI models provided by plugin
 */
export interface ModelDefinition {
    id: string;
    name: string;
    tier?: 'opus' | 'sonnet' | 'haiku';
}

/**
 * Hook definition for lifecycle events
 */
export interface HookDefinition {
    event: string;
    handler: string;
}

/**
 * Context provided to plugins during initialization
 */
export interface PluginContext {
    configStore: ConfigStore;
    logger: any;
    express: typeof import('express');
    utils: {
        spawn: typeof import('child_process').spawn;
        fetch: typeof fetch;
    };
}

/**
 * Backend Plugin Interface
 * Plugins implement this interface to provide backend functionality
 */
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

/**
 * Frontend Plugin Interface
 */
export interface FrontendPlugin {
    SettingsComponent: React.ComponentType<{
        config: any;
        onChange: (config: any) => void;
        onTest?: () => Promise<void>;
    }>;
}

/**
 * Plugin metadata for API responses
 */
export interface PluginMetadata {
    name: string;
    version: string;
    type: string;
    displayName: string;
    description: string;
    author?: string;
    apiMode?: string;
    models?: ModelDefinition[];
    configSchema?: ConfigSchema;
    hasSettingsUI: boolean;
}
