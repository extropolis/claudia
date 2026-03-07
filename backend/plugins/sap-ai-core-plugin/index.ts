/**
 * SAP AI Core Plugin
 *
 * Provides SAP AI Core integration for Claude models via AWS Bedrock.
 * This plugin proxies Anthropic Messages API requests to SAP AI Core deployments.
 */

import { Router } from 'express';
import { BackendPlugin, PluginContext, PluginManifest } from '../../src/plugin-system/index.js';
import { createAnthropicProxy, AnthropicProxyInstance } from './anthropic-proxy/index.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface SapAiCoreConfig {
    clientId: string;
    clientSecret: string;
    authUrl: string;
    baseUrl: string;
    resourceGroup?: string;
    timeoutMs?: number;
}

export default class SapAiCorePlugin implements BackendPlugin {
    manifest: PluginManifest;
    private context?: PluginContext;
    private proxyInstance?: AnthropicProxyInstance;
    private currentConfig?: SapAiCoreConfig;

    constructor() {
        // Load manifest
        const manifestPath = join(__dirname, 'plugin.json');
        this.manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    }

    async initialize(context: PluginContext): Promise<void> {
        this.context = context;
        context.logger.info('SAP AI Core plugin initialized');

        // Get config from config store if apiMode is set to sap-ai-core
        const config = context.configStore.getConfig();
        if (config.apiMode === 'sap-ai-core' && config.aiCoreCredentials) {
            this.currentConfig = {
                clientId: config.aiCoreCredentials.clientId,
                clientSecret: config.aiCoreCredentials.clientSecret,
                authUrl: config.aiCoreCredentials.authUrl,
                baseUrl: config.aiCoreCredentials.baseUrl,
                resourceGroup: config.aiCoreCredentials.resourceGroup || 'default',
                timeoutMs: config.aiCoreCredentials.timeoutMs || 120000
            };

            // Create proxy instance
            this.proxyInstance = createAnthropicProxy({
                clientId: this.currentConfig.clientId,
                clientSecret: this.currentConfig.clientSecret,
                authUrl: this.currentConfig.authUrl,
                baseUrl: this.currentConfig.baseUrl,
                resourceGroup: this.currentConfig.resourceGroup,
                requestTimeoutMs: this.currentConfig.timeoutMs
            });

            context.logger.info('SAP AI Core proxy created', {
                baseUrl: this.currentConfig.baseUrl,
                resourceGroup: this.currentConfig.resourceGroup
            });
        }
    }

    getRouter(): Router {
        // Return the proxy router if it exists, otherwise empty router
        if (this.proxyInstance) {
            return this.proxyInstance.router;
        }

        // Return empty router with helpful message
        const router = Router();
        router.all('*', (_req, res) => {
            res.status(503).json({
                error: 'SAP AI Core plugin not configured',
                message: 'Please configure SAP AI Core credentials in settings'
            });
        });
        return router;
    }

    validateConfig(config: any): { valid: boolean; error?: string } {
        if (!config) {
            return { valid: false, error: 'Config is required' };
        }

        const required = ['clientId', 'clientSecret', 'authUrl', 'baseUrl'];
        for (const field of required) {
            if (!config[field] || typeof config[field] !== 'string') {
                return { valid: false, error: `${field} is required and must be a string` };
            }
        }

        // Validate URLs
        try {
            new URL(config.authUrl);
            new URL(config.baseUrl);
        } catch {
            return { valid: false, error: 'authUrl and baseUrl must be valid URLs' };
        }

        if (config.resourceGroup && typeof config.resourceGroup !== 'string') {
            return { valid: false, error: 'resourceGroup must be a string' };
        }

        if (config.timeoutMs && (typeof config.timeoutMs !== 'number' || config.timeoutMs < 0)) {
            return { valid: false, error: 'timeoutMs must be a positive number' };
        }

        return { valid: true };
    }

    async testConnection(config: SapAiCoreConfig): Promise<{ success: boolean; error?: string }> {
        try {
            // Create temporary proxy to test credentials
            const tempProxy = createAnthropicProxy({
                clientId: config.clientId,
                clientSecret: config.clientSecret,
                authUrl: config.authUrl,
                baseUrl: config.baseUrl,
                resourceGroup: config.resourceGroup || 'default',
                requestTimeoutMs: config.timeoutMs || 120000
            });

            // Validate credentials
            const validationResult = await tempProxy.tokenProvider.validateCredentials();
            if (!validationResult.valid) {
                return { success: false, error: validationResult.error };
            }

            // Try to list models to ensure full access
            await tempProxy.deploymentCatalog.getModels();

            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    }

    async onConfigChange(config: any): Promise<void> {
        if (!this.context) return;

        const appConfig = this.context.configStore.getConfig();

        // Only react if apiMode is sap-ai-core and we have credentials
        if (appConfig.apiMode === 'sap-ai-core' && appConfig.aiCoreCredentials) {
            const newConfig: SapAiCoreConfig = {
                clientId: appConfig.aiCoreCredentials.clientId,
                clientSecret: appConfig.aiCoreCredentials.clientSecret,
                authUrl: appConfig.aiCoreCredentials.authUrl,
                baseUrl: appConfig.aiCoreCredentials.baseUrl,
                resourceGroup: appConfig.aiCoreCredentials.resourceGroup || 'default',
                timeoutMs: appConfig.aiCoreCredentials.timeoutMs || 120000
            };

            // Update existing proxy or create new one
            if (this.proxyInstance) {
                this.proxyInstance.updateConfig(newConfig);
                this.context.logger.info('SAP AI Core proxy config updated');
            } else {
                this.proxyInstance = createAnthropicProxy(newConfig);
                this.context.logger.info('SAP AI Core proxy created');
            }

            this.currentConfig = newConfig;
        } else if (this.proxyInstance) {
            // Config removed or apiMode changed, clear proxy
            this.proxyInstance = undefined;
            this.currentConfig = undefined;
            this.context.logger.info('SAP AI Core proxy disabled');
        }
    }

    getTaskEnvironment(config: any): Record<string, string> {
        // No special environment variables needed for SAP AI Core
        // The proxy handles all the OAuth and routing internally
        return {};
    }

    async shutdown(): Promise<void> {
        this.context?.logger.info('SAP AI Core plugin shutting down');
        this.proxyInstance = undefined;
        this.currentConfig = undefined;
    }
}
