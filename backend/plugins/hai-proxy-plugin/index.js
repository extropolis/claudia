/**
 * HAI Proxy Plugin
 *
 * Manages Hyperspace AI (HAI) proxy lifecycle and provides integration with Claudia.
 * Automatically starts/stops the HAI proxy process and configures it with generated API keys.
 */

import { Router } from 'express';
import { spawn } from 'child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHyperspaceProxy } from './hyperspace-proxy/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HAI_PROXY_PORT = 6655;
const HAI_PROXY_URL = `http://localhost:${HAI_PROXY_PORT}`;

export default class HaiProxyPlugin {
    constructor() {
        // Load manifest
        const manifestPath = join(__dirname, 'plugin.json');
        this.manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

        this.context = null;
        this.haiProxyProcess = null;
        this.haiProxyApiKey = null;
        this.proxyRouter = null;
    }

    async initialize(context) {
        this.context = context;
        context.logger.info('HAI Proxy plugin initialized');

        // Create the hyperspace proxy router
        this.proxyRouter = createHyperspaceProxy(context.configStore);

        // Check if proxy is already running from a previous session
        const storedConfig = context.configStore.getHyperspaceProxy();
        if (storedConfig?.apiKey) {
            const running = await this.isHaiProxyRunning(storedConfig.apiKey);
            if (running) {
                context.logger.info('HAI proxy already running, restored from config');
                this.haiProxyApiKey = storedConfig.apiKey;
            }
        }
    }

    getRouter() {
        const router = Router();

        // Mount hyperspace proxy routes at /hyperspace
        if (this.proxyRouter) {
            router.use('/hyperspace', this.proxyRouter.router);
        }

        // Status endpoint
        router.get('/status', async (req, res) => {
            try {
                const haiInstalled = await this.checkHaiInstalled();
                const storedConfig = this.context.configStore.getHyperspaceProxy();
                const currentApiKey = this.haiProxyApiKey || storedConfig?.apiKey || '';
                const proxyRunning = currentApiKey ? await this.isHaiProxyRunning(currentApiKey) : false;

                this.context.logger.info('HAI proxy status checked', { haiInstalled, proxyRunning });
                res.json({
                    haiInstalled,
                    proxyRunning,
                    apiKey: currentApiKey,
                    proxyUrl: HAI_PROXY_URL,
                    pid: this.haiProxyProcess?.pid || null
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                res.status(500).json({ success: false, error: message });
            }
        });

        // Start endpoint
        router.post('/start', async (req, res) => {
            try {
                const haiInstalled = await this.checkHaiInstalled();
                if (!haiInstalled) {
                    return res.status(400).json({
                        success: false,
                        error: 'hai CLI not found. Please install it first.'
                    });
                }

                // Reuse existing key if proxy is already running
                const candidateKey = this.haiProxyApiKey || this.context.configStore.getHyperspaceProxy()?.apiKey || null;
                if (candidateKey) {
                    const running = await this.isHaiProxyRunning(candidateKey);
                    if (running) {
                        this.context.logger.info('HAI proxy already running, reusing key');
                        this.haiProxyApiKey = candidateKey;
                        return res.json({
                            success: true,
                            apiKey: candidateKey,
                            proxyUrl: HAI_PROXY_URL,
                            alreadyRunning: true
                        });
                    }
                }

                // Kill any stale process
                if (this.haiProxyProcess) {
                    try { this.haiProxyProcess.kill(); } catch { }
                    this.haiProxyProcess = null;
                }

                // Generate a new API key
                const apiKey = randomUUID();
                this.haiProxyApiKey = apiKey;

                this.context.logger.info('Starting HAI proxy', { port: HAI_PROXY_PORT });

                // Start the proxy in headless mode (detached)
                const proc = spawn('hai', [
                    'proxy', 'start',
                    `--dangerous-api-key=${apiKey}`,
                    `--port=${HAI_PROXY_PORT}`,
                    '--headless'
                ], {
                    detached: true,
                    stdio: 'ignore'
                });

                this.haiProxyProcess = proc;
                proc.unref(); // Fully detach

                proc.on('exit', (code) => {
                    this.context.logger.info('HAI proxy process exited', { code });
                    if (this.haiProxyProcess === proc) {
                        this.haiProxyProcess = null;
                    }
                });

                // Wait up to 8 seconds for the proxy to be ready
                let ready = false;
                for (let i = 0; i < 16; i++) {
                    await new Promise(r => setTimeout(r, 500));
                    ready = await this.isHaiProxyRunning(apiKey);
                    if (ready) break;
                }

                if (!ready) {
                    try { proc.kill(); } catch { }
                    this.haiProxyProcess = null;
                    this.haiProxyApiKey = null;
                    return res.status(500).json({
                        success: false,
                        error: `HAI proxy did not start in time. Check that port ${HAI_PROXY_PORT} is available.`
                    });
                }

                // Configure Claude Code CLI to use this proxy
                try {
                    await new Promise((resolve, reject) => {
                        const configProc = spawn('hai', [
                            'configure', 'claude-code',
                            `--api-key=${apiKey}`,
                            `--port=${HAI_PROXY_PORT}`
                        ], { stdio: 'ignore' });
                        configProc.on('close', code => code === 0 ? resolve() : reject(new Error(`configure exited ${code}`)));
                        configProc.on('error', reject);
                    });
                    this.context.logger.info('HAI configure claude-code completed');
                } catch (configErr) {
                    this.context.logger.warn('HAI configure claude-code failed (non-fatal)', { error: configErr });
                }

                // Persist to config store
                const hyperspaceConfig = {
                    proxyUrl: HAI_PROXY_URL,
                    apiKey,
                    model: this.context.configStore.getHyperspaceProxy()?.model || '',
                    alwaysThinkingEnabled: this.context.configStore.getHyperspaceProxy()?.alwaysThinkingEnabled || false
                };
                this.context.configStore.updateConfig({ hyperspaceProxy: hyperspaceConfig });
                this.context.logger.info('HAI proxy started and config saved');

                res.json({ success: true, apiKey, proxyUrl: HAI_PROXY_URL, pid: proc.pid });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.context.logger.error('Failed to start HAI proxy', { error: message });
                res.status(500).json({ success: false, error: message });
            }
        });

        // Stop endpoint
        router.post('/stop', async (req, res) => {
            try {
                if (this.haiProxyProcess) {
                    this.haiProxyProcess.kill();
                    this.haiProxyProcess = null;
                    this.haiProxyApiKey = null;
                    this.context.logger.info('HAI proxy stopped');
                    res.json({ success: true });
                } else {
                    res.json({ success: true, message: 'No managed proxy process was running' });
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                res.status(500).json({ success: false, error: message });
            }
        });

        return router;
    }

    validateConfig(config) {
        // HAI proxy config is optional - if provided, validate it
        if (!config) {
            return { valid: true };
        }

        if (config.proxyUrl && typeof config.proxyUrl !== 'string') {
            return { valid: false, error: 'proxyUrl must be a string' };
        }

        if (config.apiKey && typeof config.apiKey !== 'string') {
            return { valid: false, error: 'apiKey must be a string' };
        }

        if (config.model && typeof config.model !== 'string') {
            return { valid: false, error: 'model must be a string' };
        }

        if (config.alwaysThinkingEnabled !== undefined && typeof config.alwaysThinkingEnabled !== 'boolean') {
            return { valid: false, error: 'alwaysThinkingEnabled must be a boolean' };
        }

        return { valid: true };
    }

    async testConnection(config) {
        if (!config || !config.apiKey || !config.proxyUrl) {
            return { success: false, error: 'API key and proxy URL are required' };
        }

        try {
            const running = await this.isHaiProxyRunning(config.apiKey, config.proxyUrl);
            if (running) {
                return { success: true };
            } else {
                return { success: false, error: 'HAI proxy is not responding' };
            }
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async onConfigChange(config) {
        // Config changes are handled automatically by the hyperspace proxy router
        // which reads from configStore on each request
        this.context?.logger.info('HAI proxy config changed (handled by router)');
    }

    getTaskEnvironment(config) {
        // Tasks connect to localhost:4001/hyperspace which forwards to HAI proxy
        // No special environment variables needed
        return {};
    }

    async shutdown() {
        this.context?.logger.info('HAI Proxy plugin shutting down');

        // Stop the proxy process if managed by us
        if (this.haiProxyProcess) {
            try {
                this.haiProxyProcess.kill();
                this.context?.logger.info('HAI proxy process killed');
            } catch (error) {
                this.context?.logger.warn('Failed to kill HAI proxy process', { error });
            }
            this.haiProxyProcess = null;
        }

        this.haiProxyApiKey = null;
    }

    // Helper methods

    async checkHaiInstalled() {
        try {
            await new Promise((resolve, reject) => {
                const proc = spawn('which', ['hai'], { stdio: 'ignore' });
                proc.on('close', code => code === 0 ? resolve() : reject());
                proc.on('error', reject);
            });
            return true;
        } catch {
            return false;
        }
    }

    async isHaiProxyRunning(apiKey, proxyUrl = HAI_PROXY_URL) {
        try {
            const url = `${proxyUrl}/anthropic/v1/models`;
            const response = await fetch(url, {
                method: 'GET',
                headers: { 'x-api-key': apiKey },
                signal: AbortSignal.timeout(2000)
            });
            return response.ok;
        } catch {
            return false;
        }
    }
}
