import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { ConfigStore, AppConfig, MCPServerConfig } from '../config-store.js';

describe('ConfigStore', () => {
    let testBaseDir: string;
    let store: ConfigStore;

    beforeEach(() => {
        // Use unique directory for each test
        const uniqueId = Date.now() + '-' + Math.random().toString(36).substring(7);
        testBaseDir = join(homedir(), '.claudia-config-test-' + uniqueId);
        mkdirSync(testBaseDir, { recursive: true });
        store = new ConfigStore(testBaseDir);
    });

    afterEach(() => {
        try {
            rmSync(testBaseDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    describe('initialization', () => {
        it('should create config file when config is saved', () => {
            // ConfigStore only creates the file when a change is made
            store.updateConfig({ rules: 'test' });
            const configPath = join(testBaseDir, 'config.json');
            expect(existsSync(configPath)).toBe(true);
        });

        it('should initialize with default values', () => {
            const config = store.getConfig();

            expect(config.skipPermissions).toBe(false);
            expect(config.rules).toBe('');
            expect(config.supervisorEnabled).toBe(false);
            expect(config.autoFocusOnInput).toBe(false);
            expect(config.apiMode).toBe('default');
            expect(Array.isArray(config.mcpServers)).toBe(true);
        });

        it('should include default MCP servers', () => {
            const config = store.getConfig();
            const playwrightServer = config.mcpServers.find(s => s.name === 'playwright');
            expect(playwrightServer).toBeDefined();
        });
    });

    describe('getConfig', () => {
        it('should return a copy of config', () => {
            const config1 = store.getConfig();
            const config2 = store.getConfig();

            expect(config1).toEqual(config2);
            expect(config1).not.toBe(config2); // Different objects
        });
    });

    describe('updateConfig', () => {
        it('should update skipPermissions', () => {
            store.updateConfig({ skipPermissions: true });
            expect(store.getConfig().skipPermissions).toBe(true);

            store.updateConfig({ skipPermissions: false });
            expect(store.getConfig().skipPermissions).toBe(false);
        });

        it('should update rules', () => {
            store.updateConfig({ rules: 'Custom rules here' });
            expect(store.getConfig().rules).toBe('Custom rules here');
        });

        it('should update supervisorEnabled', () => {
            store.updateConfig({ supervisorEnabled: true });
            expect(store.getConfig().supervisorEnabled).toBe(true);
        });

        it('should update autoFocusOnInput', () => {
            store.updateConfig({ autoFocusOnInput: true });
            expect(store.getConfig().autoFocusOnInput).toBe(true);
        });

        it('should update apiMode', () => {
            store.updateConfig({ apiMode: 'sap-ai-core' });
            expect(store.getConfig().apiMode).toBe('sap-ai-core');

            store.updateConfig({ apiMode: 'custom-anthropic' });
            expect(store.getConfig().apiMode).toBe('custom-anthropic');
        });

        it('should update customAnthropicApiKey', () => {
            store.updateConfig({ customAnthropicApiKey: 'sk-test-key-123' });
            expect(store.getConfig().customAnthropicApiKey).toBe('sk-test-key-123');
        });

        it('should update mcpServers', () => {
            const newServers: MCPServerConfig[] = [
                { name: 'test-server', command: 'node', args: ['server.js'], enabled: true },
            ];
            store.updateConfig({ mcpServers: newServers });

            const config = store.getConfig();
            expect(config.mcpServers.length).toBe(1);
            expect(config.mcpServers[0].name).toBe('test-server');
        });

        it('should update aiCoreCredentials', () => {
            const creds = {
                clientId: 'test-client',
                clientSecret: 'test-secret',
                authUrl: 'https://auth.example.com',
                baseUrl: 'https://api.example.com',
                resourceGroup: 'test-group',
                timeoutMs: 30000,
            };
            store.updateConfig({ aiCoreCredentials: creds });

            expect(store.getConfig().aiCoreCredentials).toEqual(creds);
        });

        it('should update supervisorSystemPrompt', () => {
            store.updateConfig({ supervisorSystemPrompt: 'Custom system prompt' });
            expect(store.getConfig().supervisorSystemPrompt).toBe('Custom system prompt');
        });

        it('should persist updates to file', () => {
            store.updateConfig({ rules: 'Persisted rules' });

            // Create new store instance
            const newStore = new ConfigStore(testBaseDir);
            expect(newStore.getConfig().rules).toBe('Persisted rules');
        });

        it('should return updated config', () => {
            const result = store.updateConfig({ rules: 'New rules' });
            expect(result.rules).toBe('New rules');
        });
    });

    describe('getAICoreCredentials / setAICoreCredentials', () => {
        it('should get and set AI Core credentials', () => {
            const creds = {
                clientId: 'client-123',
                clientSecret: 'secret-456',
                authUrl: 'https://auth.test.com',
                baseUrl: 'https://api.test.com',
                resourceGroup: 'group-1',
                timeoutMs: 60000,
            };

            store.setAICoreCredentials(creds);
            expect(store.getAICoreCredentials()).toEqual(creds);
        });

        it('should allow clearing credentials', () => {
            const creds = {
                clientId: 'client-123',
                clientSecret: 'secret-456',
                authUrl: 'https://auth.test.com',
                baseUrl: 'https://api.test.com',
                resourceGroup: 'group-1',
                timeoutMs: 60000,
            };

            store.setAICoreCredentials(creds);
            store.setAICoreCredentials(undefined);

            expect(store.getAICoreCredentials()).toBeUndefined();
        });
    });

    describe('helper methods', () => {
        it('should get apiMode', () => {
            store.updateConfig({ apiMode: 'sap-ai-core' });
            expect(store.getApiMode()).toBe('sap-ai-core');
        });

        it('should get customAnthropicApiKey', () => {
            store.updateConfig({ customAnthropicApiKey: 'sk-key' });
            expect(store.getCustomAnthropicApiKey()).toBe('sk-key');
        });

        it('should get supervisorEnabled', () => {
            store.updateConfig({ supervisorEnabled: true });
            expect(store.isSupervisorEnabled()).toBe(true);
        });

        it('should get and set supervisorSystemPrompt', () => {
            store.setSupervisorSystemPrompt('Custom prompt');
            expect(store.getSupervisorSystemPrompt()).toBe('Custom prompt');
        });

        it('should get skipPermissions', () => {
            store.updateConfig({ skipPermissions: true });
            expect(store.getSkipPermissions()).toBe(true);
        });

        it('should get and set rules', () => {
            store.setRules('Rule 1\nRule 2');
            expect(store.getRules()).toBe('Rule 1\nRule 2');
        });

        it('should get mcpServers as copy', () => {
            const servers1 = store.getMCPServers();
            const servers2 = store.getMCPServers();

            expect(servers1).toEqual(servers2);
            expect(servers1).not.toBe(servers2);
        });
    });

    describe('resetToDefaults', () => {
        it('should reset all config to defaults', () => {
            // Make some changes
            store.updateConfig({
                rules: 'Custom rules',
                skipPermissions: true,
                supervisorEnabled: true,
                apiMode: 'sap-ai-core',
            });

            // Reset
            const result = store.resetToDefaults();

            expect(result.rules).toBe('');
            expect(result.skipPermissions).toBe(false);
            expect(result.supervisorEnabled).toBe(false);
            expect(result.apiMode).toBe('default');
        });

        it('should persist reset to file', () => {
            store.updateConfig({ rules: 'Custom rules' });
            store.resetToDefaults();

            const newStore = new ConfigStore(testBaseDir);
            expect(newStore.getConfig().rules).toBe('');
        });
    });

    describe('backend methods', () => {
        it('should get and set backend', () => {
            store.setBackend('opencode');
            expect(store.getBackend()).toBe('opencode');

            store.setBackend('claude-code');
            expect(store.getBackend()).toBe('claude-code');
        });

        it('should update backend via updateConfig', () => {
            store.updateConfig({ backend: 'opencode' });
            expect(store.getConfig().backend).toBe('opencode');
        });

        it('should persist backend changes', () => {
            store.setBackend('opencode');
            const newStore = new ConfigStore(testBaseDir);
            expect(newStore.getBackend()).toBe('opencode');
        });

        it('should default to claude-code', () => {
            expect(store.getBackend()).toBe('claude-code');
        });
    });

    describe('opencodePort methods', () => {
        it('should get and set opencodePort', () => {
            store.setOpencodePort(5000);
            expect(store.getOpencodePort()).toBe(5000);
        });

        it('should update opencodePort via updateConfig', () => {
            store.updateConfig({ opencodePort: 8080 });
            expect(store.getConfig().opencodePort).toBe(8080);
        });

        it('should default to 4096', () => {
            expect(store.getOpencodePort()).toBe(4096);
        });

        it('should persist opencodePort changes', () => {
            store.setOpencodePort(9999);
            const newStore = new ConfigStore(testBaseDir);
            expect(newStore.getOpencodePort()).toBe(9999);
        });
    });

    describe('useLearnings methods', () => {
        it('should get and set useLearnings', () => {
            store.setUseLearnings(true);
            expect(store.getUseLearnings()).toBe(true);

            store.setUseLearnings(false);
            expect(store.getUseLearnings()).toBe(false);
        });

        it('should update useLearnings via updateConfig', () => {
            store.updateConfig({ useLearnings: true });
            expect(store.getConfig().useLearnings).toBe(true);
        });

        it('should default to false', () => {
            expect(store.getUseLearnings()).toBe(false);
        });

        it('should persist useLearnings changes', () => {
            store.setUseLearnings(true);
            const newStore = new ConfigStore(testBaseDir);
            expect(newStore.getUseLearnings()).toBe(true);
        });
    });

    describe('hyperspaceProxy methods', () => {
        it('should get and set hyperspaceProxy', () => {
            const proxyConfig = {
                proxyUrl: 'http://localhost:7777',
                apiKey: 'test-key-123',
                model: 'anthropic--claude-4.5-sonnet',
                alwaysThinkingEnabled: true
            };

            store.setHyperspaceProxy(proxyConfig);
            expect(store.getHyperspaceProxy()).toEqual(proxyConfig);
        });

        it('should update hyperspaceProxy via updateConfig', () => {
            const proxyConfig = {
                proxyUrl: 'http://localhost:8888',
                apiKey: 'key-456',
                model: 'anthropic--claude-3.5-sonnet',
                alwaysThinkingEnabled: false
            };

            store.updateConfig({ hyperspaceProxy: proxyConfig });
            expect(store.getConfig().hyperspaceProxy).toEqual(proxyConfig);
        });

        it('should have default hyperspaceProxy values', () => {
            const proxy = store.getHyperspaceProxy();
            expect(proxy.proxyUrl).toBe('http://localhost:6655');
            expect(proxy.apiKey).toBe('');
            expect(proxy.model).toBe('anthropic--claude-4.5-sonnet');
            expect(proxy.alwaysThinkingEnabled).toBe(false);
        });

        it('should persist hyperspaceProxy changes', () => {
            const proxyConfig = {
                proxyUrl: 'http://custom:1234',
                apiKey: 'persist-key',
                model: 'anthropic--claude-opus-4',
                alwaysThinkingEnabled: true
            };

            store.setHyperspaceProxy(proxyConfig);
            const newStore = new ConfigStore(testBaseDir);
            expect(newStore.getHyperspaceProxy()).toEqual(proxyConfig);
        });
    });

    describe('sapAiCoreModel methods', () => {
        it('should get and set sapAiCoreModel', () => {
            store.setSapAiCoreModel('anthropic--claude-3.5-sonnet');
            expect(store.getSapAiCoreModel()).toBe('anthropic--claude-3.5-sonnet');
        });

        it('should update sapAiCoreModel via updateConfig', () => {
            store.updateConfig({ sapAiCoreModel: 'anthropic--claude-3.5-haiku' });
            expect(store.getConfig().sapAiCoreModel).toBe('anthropic--claude-3.5-haiku');
        });

        it('should default to anthropic--claude-4.6-opus', () => {
            expect(store.getSapAiCoreModel()).toBe('anthropic--claude-4.6-opus');
        });

        it('should persist sapAiCoreModel changes', () => {
            store.setSapAiCoreModel('anthropic--claude-opus-4');
            const newStore = new ConfigStore(testBaseDir);
            expect(newStore.getSapAiCoreModel()).toBe('anthropic--claude-opus-4');
        });
    });

    describe('setAICoreCredentials URL sanitization', () => {
        it('should strip leading = from authUrl and baseUrl', () => {
            const creds = {
                clientId: 'client-123',
                clientSecret: 'secret-456',
                authUrl: '=https://auth.test.com',
                baseUrl: '==https://api.test.com',
                resourceGroup: 'group-1',
                timeoutMs: 60000,
            };

            store.setAICoreCredentials(creds);
            const stored = store.getAICoreCredentials();
            expect(stored?.authUrl).toBe('https://auth.test.com');
            expect(stored?.baseUrl).toBe('https://api.test.com');
        });
    });

    describe('config file handling', () => {
        it('should handle corrupted config file gracefully', () => {
            // Create corrupted config
            const configPath = join(testBaseDir, 'config.json');
            writeFileSync(configPath, 'not valid json!!!');

            // Should fall back to defaults
            const newStore = new ConfigStore(testBaseDir);
            const config = newStore.getConfig();

            expect(config.skipPermissions).toBe(false);
            expect(config.apiMode).toBe('default');
        });

        it('should merge partial config with defaults', () => {
            // Create partial config
            const configPath = join(testBaseDir, 'config.json');
            writeFileSync(configPath, JSON.stringify({ rules: 'Partial config' }));

            const newStore = new ConfigStore(testBaseDir);
            const config = newStore.getConfig();

            // Custom value preserved
            expect(config.rules).toBe('Partial config');
            // Defaults applied
            expect(config.skipPermissions).toBe(false);
            expect(config.apiMode).toBe('default');
        });
    });
});
