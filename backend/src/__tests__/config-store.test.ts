import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { ConfigStore, AppConfig, MCPServerConfig, DEFAULT_TOKEN_PRICING } from '../config-store.js';

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
            rmSync(testBaseDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
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

    describe('helper methods', () => {
        it('should get apiMode', () => {
            store.updateConfig({ apiMode: 'custom-anthropic' });
            expect(store.getApiMode()).toBe('custom-anthropic');
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
                apiMode: 'custom-anthropic',
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

    describe('token tracking methods', () => {
        it('should default tokenTrackingEnabled to true', () => {
            expect(store.getTokenTrackingEnabled()).toBe(true);
        });

        it('should get and set tokenTrackingEnabled', () => {
            store.setTokenTrackingEnabled(false);
            expect(store.getTokenTrackingEnabled()).toBe(false);

            store.setTokenTrackingEnabled(true);
            expect(store.getTokenTrackingEnabled()).toBe(true);
        });

        it('should persist tokenTrackingEnabled', () => {
            store.setTokenTrackingEnabled(false);
            const newStore = new ConfigStore(testBaseDir);
            expect(newStore.getTokenTrackingEnabled()).toBe(false);
        });

        it('should update tokenTrackingEnabled via updateConfig', () => {
            store.updateConfig({ tokenTrackingEnabled: false });
            expect(store.getTokenTrackingEnabled()).toBe(false);
        });

        it('should default tokenCostEnabled to false', () => {
            expect(store.getTokenCostEnabled()).toBe(false);
        });

        it('should get and set tokenCostEnabled', () => {
            store.setTokenCostEnabled(true);
            expect(store.getTokenCostEnabled()).toBe(true);
        });

        it('should persist tokenCostEnabled', () => {
            store.setTokenCostEnabled(true);
            const newStore = new ConfigStore(testBaseDir);
            expect(newStore.getTokenCostEnabled()).toBe(true);
        });

        it('should update tokenCostEnabled via updateConfig', () => {
            store.updateConfig({ tokenCostEnabled: true });
            expect(store.getTokenCostEnabled()).toBe(true);
        });

        it('should return DEFAULT_TOKEN_PRICING when no custom pricing set', () => {
            const pricing = store.getTokenPricing();
            expect(pricing).toEqual(DEFAULT_TOKEN_PRICING);
        });

        it('should get and set token pricing', () => {
            const customPricing = {
                'my-model': {
                    inputPer1MTokens: 1.00,
                    outputPer1MTokens: 5.00,
                    cacheCreatePer1MTokens: 1.25,
                    cacheReadPer1MTokens: 0.10,
                },
            };
            store.setTokenPricing(customPricing);
            expect(store.getTokenPricing()).toEqual(customPricing);
        });

        it('should persist token pricing', () => {
            const customPricing = {
                'my-model': {
                    inputPer1MTokens: 2.00,
                    outputPer1MTokens: 8.00,
                    cacheCreatePer1MTokens: 2.50,
                    cacheReadPer1MTokens: 0.20,
                },
            };
            store.setTokenPricing(customPricing);
            const newStore = new ConfigStore(testBaseDir);
            expect(newStore.getTokenPricing()).toEqual(customPricing);
        });

        it('should update tokenPricing via updateConfig', () => {
            const p = { 'x': { inputPer1MTokens: 1, outputPer1MTokens: 1, cacheCreatePer1MTokens: 1, cacheReadPer1MTokens: 1 } };
            store.updateConfig({ tokenPricing: p });
            expect(store.getTokenPricing()).toEqual(p);
        });

        it('should include token fields in resetToDefaults', () => {
            store.setTokenTrackingEnabled(false);
            store.setTokenCostEnabled(true);
            store.setTokenPricing({ 'x': { inputPer1MTokens: 99, outputPer1MTokens: 99, cacheCreatePer1MTokens: 99, cacheReadPer1MTokens: 99 } });

            store.resetToDefaults();

            expect(store.getTokenTrackingEnabled()).toBe(true);
            expect(store.getTokenCostEnabled()).toBe(false);
            expect(store.getTokenPricing()).toEqual(DEFAULT_TOKEN_PRICING);
        });
    });

    describe('defaultBaseDirectory methods', () => {
        it('should default to undefined', () => {
            expect(store.getDefaultBaseDirectory()).toBeUndefined();
        });

        it('should get and set defaultBaseDirectory', () => {
            store.setDefaultBaseDirectory('/home/user/projects');
            expect(store.getDefaultBaseDirectory()).toBe('/home/user/projects');
        });

        it('should persist defaultBaseDirectory', () => {
            store.setDefaultBaseDirectory('/my/workspace');
            const newStore = new ConfigStore(testBaseDir);
            expect(newStore.getDefaultBaseDirectory()).toBe('/my/workspace');
        });

        it('should allow clearing defaultBaseDirectory to undefined', () => {
            store.setDefaultBaseDirectory('/some/path');
            store.setDefaultBaseDirectory(undefined);
            expect(store.getDefaultBaseDirectory()).toBeUndefined();
        });

        it('should update defaultBaseDirectory via updateConfig', () => {
            store.updateConfig({ defaultBaseDirectory: '/updated/path' });
            expect(store.getDefaultBaseDirectory()).toBe('/updated/path');
        });
    });

    describe('defaultModel migration', () => {
        it('should migrate old "model" field to "defaultModel" on load', () => {
            // Simulate a legacy (unversioned) config saved before the model→defaultModel rename.
            // The schema-version loader treats files without schemaVersion as legacy.
            const configPath = join(testBaseDir, 'config.json');
            const legacyConfig = {
                // No schemaVersion field → treated as legacy by loadVersioned
                claudeCodeSwitches: {
                    verbose: false,
                    maxTurns: null,
                    maxBudgetUsd: null,
                    permissionMode: null,
                    allowedTools: '',
                    disallowedTools: '',
                    appendSystemPrompt: '',
                    effortLevel: 'high',
                    model: 'claude-opus-4-6',   // old field name
                    // defaultModel intentionally absent
                },
            };
            writeFileSync(configPath, JSON.stringify(legacyConfig));

            const newStore = new ConfigStore(testBaseDir);
            const switches = newStore.getClaudeCodeSwitches();
            expect(switches.defaultModel).toBe('claude-opus-4-6');
        });

        it('should prefer defaultModel over legacy model field if both present', () => {
            const configPath = join(testBaseDir, 'config.json');
            const config = {
                // No schemaVersion → legacy
                claudeCodeSwitches: {
                    model: 'old-model',
                    defaultModel: 'new-model',
                },
            };
            writeFileSync(configPath, JSON.stringify(config));

            const newStore = new ConfigStore(testBaseDir);
            expect(newStore.getClaudeCodeSwitches().defaultModel).toBe('new-model');
        });

        it('should default defaultModel to empty string when neither field present', () => {
            const newStore = new ConfigStore(testBaseDir);
            expect(newStore.getClaudeCodeSwitches().defaultModel).toBe('');
        });
    });

    describe('claudiaMcpServerEnabled methods', () => {
        it('should default to true', () => {
            expect(store.getClaudioMcpServerEnabled()).toBe(true);
        });

        it('should get and set claudiaMcpServerEnabled', () => {
            store.setClaudioMcpServerEnabled(false);
            expect(store.getClaudioMcpServerEnabled()).toBe(false);

            store.setClaudioMcpServerEnabled(true);
            expect(store.getClaudioMcpServerEnabled()).toBe(true);
        });

        it('should persist claudiaMcpServerEnabled', () => {
            store.setClaudioMcpServerEnabled(false);
            const newStore = new ConfigStore(testBaseDir);
            expect(newStore.getClaudioMcpServerEnabled()).toBe(false);
        });

        it('should update via updateConfig', () => {
            store.updateConfig({ claudiaMcpServerEnabled: false });
            expect(store.getClaudioMcpServerEnabled()).toBe(false);
        });
    });

    describe('modelTiering', () => {
        it('returns disabled defaults on a fresh config', () => {
            const cfg = store.getModelTiering();
            expect(cfg.enabled).toBe(false);
            expect(cfg.tiers).toEqual({ low: 'haiku', medium: 'sonnet', high: 'opus' });
        });

        it('returns undefined when complexity is omitted', () => {
            store.setModelTiering({ enabled: true, tiers: { low: 'haiku', medium: 'sonnet', high: 'opus' } });
            expect(store.resolveModelForComplexity(undefined)).toBeUndefined();
        });

        it('returns undefined when tiering is disabled', () => {
            // default is disabled
            expect(store.resolveModelForComplexity('high')).toBeUndefined();
        });

        it('maps complexity to configured model when enabled', () => {
            store.setModelTiering({ enabled: true, tiers: { low: 'haiku', medium: 'sonnet', high: 'opus' } });
            expect(store.resolveModelForComplexity('low')).toBe('haiku');
            expect(store.resolveModelForComplexity('medium')).toBe('sonnet');
            expect(store.resolveModelForComplexity('high')).toBe('opus');
        });

        it('respects custom mappings', () => {
            store.setModelTiering({
                enabled: true,
                tiers: { low: 'claude-haiku-4-5-20251001', medium: 'claude-sonnet-4-6', high: 'claude-opus-4-7' }
            });
            expect(store.resolveModelForComplexity('low')).toBe('claude-haiku-4-5-20251001');
            expect(store.resolveModelForComplexity('high')).toBe('claude-opus-4-7');
        });

        it('falls through to undefined when a tier is empty (caller uses default)', () => {
            store.setModelTiering({ enabled: true, tiers: { low: '', medium: 'sonnet', high: 'opus' } });
            expect(store.resolveModelForComplexity('low')).toBeUndefined();
            expect(store.resolveModelForComplexity('medium')).toBe('sonnet');
        });

        it('trims whitespace from tier strings', () => {
            store.setModelTiering({ enabled: true, tiers: { low: '  haiku  ', medium: 'sonnet', high: 'opus' } });
            expect(store.resolveModelForComplexity('low')).toBe('haiku');
        });

        it('persists across save/load', () => {
            store.setModelTiering({ enabled: true, tiers: { low: 'haiku', medium: 'sonnet', high: 'claude-opus-4-7' } });

            const reloaded = new ConfigStore(testBaseDir);
            const cfg = reloaded.getModelTiering();
            expect(cfg.enabled).toBe(true);
            expect(cfg.tiers.high).toBe('claude-opus-4-7');
            expect(reloaded.resolveModelForComplexity('high')).toBe('claude-opus-4-7');
        });

        it('updateConfig accepts partial modelTiering and fills tier defaults', () => {
            // updateConfig merges partial tiers at runtime (validated upstream); cast to satisfy TS.
            store.updateConfig({ modelTiering: { enabled: true, tiers: { high: 'claude-opus-4-7' } as any } });
            const cfg = store.getModelTiering();
            expect(cfg.enabled).toBe(true);
            expect(cfg.tiers.high).toBe('claude-opus-4-7');
            // Other tiers fall back to defaults
            expect(cfg.tiers.low).toBe('haiku');
            expect(cfg.tiers.medium).toBe('sonnet');
        });

        it('partial updateConfig does not blow away existing tier mappings', () => {
            // Set custom mappings.
            store.updateConfig({ modelTiering: { enabled: true, tiers: { low: 'haiku-3', medium: 'sonnet-3', high: 'opus-3' } } });
            // Toggle only `enabled` off — tiers must survive.
            store.updateConfig({ modelTiering: { enabled: false } as any });
            const cfg = store.getModelTiering();
            expect(cfg.enabled).toBe(false);
            expect(cfg.tiers.low).toBe('haiku-3');
            expect(cfg.tiers.medium).toBe('sonnet-3');
            expect(cfg.tiers.high).toBe('opus-3');
        });
    });

    describe('Jira integration', () => {
        const jira = { baseUrl: 'https://acme.atlassian.net', email: 'me@acme.com', apiToken: 'secret-token' };

        it('defaults to disabled and unconfigured', () => {
            const config = store.getConfig();
            expect(config.jiraEnabled).toBe(false);
            expect(config.jira).toBeUndefined();
            expect(store.isJiraEnabled()).toBe(false);
            expect(store.isJiraConfigured()).toBe(false);
            expect(store.getJiraConfig()).toBeUndefined();
        });

        it('setJiraEnabled toggles the master switch and persists it', () => {
            store.setJiraEnabled(true);
            expect(store.isJiraEnabled()).toBe(true);
            expect(new ConfigStore(testBaseDir).isJiraEnabled()).toBe(true);

            store.setJiraEnabled(false);
            expect(store.isJiraEnabled()).toBe(false);
        });

        it('setJiraConfig stores a copy that survives a reload', () => {
            store.setJiraConfig(jira);
            expect(store.getJiraConfig()).toEqual(jira);
            expect(new ConfigStore(testBaseDir).getJiraConfig()).toEqual(jira);
        });

        it('getJiraConfig returns a defensive copy', () => {
            store.setJiraConfig(jira);
            const returned = store.getJiraConfig()!;
            returned.apiToken = 'mutated';
            expect(store.getJiraConfig()!.apiToken).toBe('secret-token');
        });

        it('isJiraConfigured requires enabled AND all three fields', () => {
            store.setJiraConfig(jira);
            expect(store.isJiraConfigured()).toBe(false); // configured but disabled

            store.setJiraEnabled(true);
            expect(store.isJiraConfigured()).toBe(true);

            store.setJiraConfig({ ...jira, apiToken: '' });
            expect(store.isJiraConfigured()).toBe(false);
            store.setJiraConfig({ ...jira, email: '' });
            expect(store.isJiraConfigured()).toBe(false);
            store.setJiraConfig({ ...jira, baseUrl: '' });
            expect(store.isJiraConfigured()).toBe(false);
        });

        it('updateConfig merges jira fields instead of replacing them', () => {
            store.updateConfig({ jiraEnabled: true, jira });
            // Frontend masks the token, so a follow-up save omits it — it must survive.
            store.updateConfig({ jira: { email: 'other@acme.com' } });
            expect(store.getJiraConfig()).toEqual({
                baseUrl: 'https://acme.atlassian.net',
                email: 'other@acme.com',
                apiToken: 'secret-token',
            });
        });

        it('updateConfig treats an empty apiToken as "keep the stored one"', () => {
            store.updateConfig({ jira });
            store.updateConfig({ jira: { baseUrl: 'https://new.atlassian.net', apiToken: '' } });
            const stored = store.getJiraConfig()!;
            expect(stored.baseUrl).toBe('https://new.atlassian.net');
            expect(stored.apiToken).toBe('secret-token');
        });

        it('updateConfig on a virgin store fills unset jira fields with empty strings', () => {
            store.updateConfig({ jira: { email: 'me@acme.com' } });
            expect(store.getJiraConfig()).toEqual({ baseUrl: '', email: 'me@acme.com', apiToken: '' });
        });

        it('resetToDefaults clears the Jira integration', () => {
            store.updateConfig({ jiraEnabled: true, jira });
            const reset = store.resetToDefaults();
            expect(reset.jiraEnabled).toBe(false);
            expect(reset.jira).toBeUndefined();
            expect(store.isJiraConfigured()).toBe(false);
        });

        it('loads jiraEnabled=false for configs written before the integration existed', () => {
            writeFileSync(join(testBaseDir, 'config.json'), JSON.stringify({ rules: 'legacy' }));
            const legacy = new ConfigStore(testBaseDir);
            expect(legacy.getConfig().jiraEnabled).toBe(false);
            expect(legacy.getJiraConfig()).toBeUndefined();
        });
    });
});
