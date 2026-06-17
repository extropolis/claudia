import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmdirSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import {
    validateConfigUpdate,
    validateWorkspacePath,
    sanitizePrompt,
    decodeHtmlEntities,
} from '../validation.js';

describe('validateConfigUpdate', () => {
    it('should reject non-object input', () => {
        expect(validateConfigUpdate(null).valid).toBe(false);
        expect(validateConfigUpdate(undefined).valid).toBe(false);
        expect(validateConfigUpdate('string').valid).toBe(false);
        expect(validateConfigUpdate(123).valid).toBe(false);
        // Note: Arrays are technically objects in JS, so validateConfigUpdate([]) returns true
        // but it will return an empty config object which is valid
    });

    it('should accept empty object', () => {
        const result = validateConfigUpdate({});
        expect(result.valid).toBe(true);
        expect(result.data).toEqual({});
    });

    it('should validate rules field', () => {
        expect(validateConfigUpdate({ rules: 'test rules' }).valid).toBe(true);
        expect(validateConfigUpdate({ rules: 123 }).valid).toBe(false);
        expect(validateConfigUpdate({ rules: 123 }).error).toBe('rules must be a string');
    });

    it('should validate mcpServers array', () => {
        // Valid server config
        const validServers = [{
            name: 'test-server',
            command: 'npx',
            args: ['test'],
            enabled: true,
        }];
        expect(validateConfigUpdate({ mcpServers: validServers }).valid).toBe(true);

        // Invalid - not an array
        expect(validateConfigUpdate({ mcpServers: 'not-array' }).valid).toBe(false);
        expect(validateConfigUpdate({ mcpServers: 'not-array' }).error).toBe('mcpServers must be an array');

        // Invalid - missing name
        expect(validateConfigUpdate({ mcpServers: [{ command: 'test' }] }).valid).toBe(false);

        // Invalid - missing command
        expect(validateConfigUpdate({ mcpServers: [{ name: 'test' }] }).valid).toBe(false);

        // Invalid - enabled is not boolean
        expect(validateConfigUpdate({
            mcpServers: [{ name: 'test', command: 'cmd', enabled: 'yes' }]
        }).valid).toBe(false);
    });

    it('should validate boolean fields', () => {
        expect(validateConfigUpdate({ skipPermissions: true }).valid).toBe(true);
        expect(validateConfigUpdate({ skipPermissions: false }).valid).toBe(true);
        expect(validateConfigUpdate({ skipPermissions: 'yes' }).valid).toBe(false);

        expect(validateConfigUpdate({ autoFocusOnInput: true }).valid).toBe(true);
        expect(validateConfigUpdate({ autoFocusOnInput: 1 }).valid).toBe(false);

        expect(validateConfigUpdate({ supervisorEnabled: false }).valid).toBe(true);
        expect(validateConfigUpdate({ supervisorEnabled: null }).valid).toBe(false);
    });

    it('should validate apiMode enum', () => {
        expect(validateConfigUpdate({ apiMode: 'default' }).valid).toBe(true);
        expect(validateConfigUpdate({ apiMode: 'custom-anthropic' }).valid).toBe(true);
        expect(validateConfigUpdate({ apiMode: 'invalid' }).valid).toBe(false);
        expect(validateConfigUpdate({ apiMode: 'invalid' }).error).toContain('apiMode must be one of');
    });

    it('should validate customAnthropicApiKey', () => {
        expect(validateConfigUpdate({ customAnthropicApiKey: 'sk-test-key' }).valid).toBe(true);
        expect(validateConfigUpdate({ customAnthropicApiKey: 123 }).valid).toBe(false);
    });

    it('should validate apiMode values', () => {
        expect(validateConfigUpdate({ apiMode: 'default' }).valid).toBe(true);
        expect(validateConfigUpdate({ apiMode: 'custom-anthropic' }).valid).toBe(true);
        expect(validateConfigUpdate({ apiMode: 'hyperspace-proxy' }).valid).toBe(true);
        expect(validateConfigUpdate({ apiMode: 'sap-ai-core' }).valid).toBe(true);
        expect(validateConfigUpdate({ apiMode: 'invalid-mode' }).valid).toBe(false);
    });

    it('should validate backend enum', () => {
        expect(validateConfigUpdate({ backend: 'claude-code' }).valid).toBe(true);
        expect(validateConfigUpdate({ backend: 'opencode' }).valid).toBe(true);
        expect(validateConfigUpdate({ backend: 'invalid-backend' }).valid).toBe(false);
        expect(validateConfigUpdate({ backend: 'invalid-backend' }).error).toContain('backend must be one of');
        expect(validateConfigUpdate({ backend: 123 }).valid).toBe(false);
    });

    it('should validate opencodePort range', () => {
        expect(validateConfigUpdate({ opencodePort: 4096 }).valid).toBe(true);
        expect(validateConfigUpdate({ opencodePort: 1 }).valid).toBe(true);
        expect(validateConfigUpdate({ opencodePort: 65535 }).valid).toBe(true);
        expect(validateConfigUpdate({ opencodePort: 0 }).valid).toBe(false);
        expect(validateConfigUpdate({ opencodePort: -1 }).valid).toBe(false);
        expect(validateConfigUpdate({ opencodePort: 65536 }).valid).toBe(false);
        expect(validateConfigUpdate({ opencodePort: 'not-a-number' }).valid).toBe(false);
        expect(validateConfigUpdate({ opencodePort: 'not-a-number' }).error).toContain('opencodePort must be a number');
    });

    it('should validate supervisorSystemPrompt', () => {
        expect(validateConfigUpdate({ supervisorSystemPrompt: 'Custom prompt' }).valid).toBe(true);
        expect(validateConfigUpdate({ supervisorSystemPrompt: '' }).valid).toBe(true);
        expect(validateConfigUpdate({ supervisorSystemPrompt: 123 }).valid).toBe(false);
        expect(validateConfigUpdate({ supervisorSystemPrompt: 123 }).error).toBe('supervisorSystemPrompt must be a string');
    });

    it('should validate MCP server type enum', () => {
        // stdio server (default)
        expect(validateConfigUpdate({
            mcpServers: [{ name: 'test', command: 'cmd', enabled: true }]
        }).valid).toBe(true);

        // Explicit stdio type
        expect(validateConfigUpdate({
            mcpServers: [{ name: 'test', type: 'stdio', command: 'cmd', enabled: true }]
        }).valid).toBe(true);

        // streamableHttp server
        expect(validateConfigUpdate({
            mcpServers: [{ name: 'test', type: 'streamableHttp', url: 'http://localhost:3000', enabled: true }]
        }).valid).toBe(true);

        // http server
        expect(validateConfigUpdate({
            mcpServers: [{ name: 'test', type: 'http', url: 'http://localhost:3000', enabled: true }]
        }).valid).toBe(true);

        // Invalid type
        expect(validateConfigUpdate({
            mcpServers: [{ name: 'test', type: 'invalid', command: 'cmd', enabled: true }]
        }).valid).toBe(false);
        expect(validateConfigUpdate({
            mcpServers: [{ name: 'test', type: 'invalid', command: 'cmd', enabled: true }]
        }).error).toContain("type must be");

        // streamableHttp requires url
        expect(validateConfigUpdate({
            mcpServers: [{ name: 'test', type: 'streamableHttp', enabled: true }]
        }).valid).toBe(false);

        // streamableHttp requires valid url
        expect(validateConfigUpdate({
            mcpServers: [{ name: 'test', type: 'streamableHttp', url: 'not-a-url', enabled: true }]
        }).valid).toBe(false);
    });

    it('should validate MCP server optional fields', () => {
        // Valid timeout
        expect(validateConfigUpdate({
            mcpServers: [{ name: 'test', command: 'cmd', enabled: true, timeout: 5000 }]
        }).valid).toBe(true);

        // Invalid timeout - negative
        expect(validateConfigUpdate({
            mcpServers: [{ name: 'test', command: 'cmd', enabled: true, timeout: -1 }]
        }).valid).toBe(false);

        // Invalid timeout - zero
        expect(validateConfigUpdate({
            mcpServers: [{ name: 'test', command: 'cmd', enabled: true, timeout: 0 }]
        }).valid).toBe(false);

        // Valid description
        expect(validateConfigUpdate({
            mcpServers: [{ name: 'test', command: 'cmd', enabled: true, description: 'A test server' }]
        }).valid).toBe(true);

        // Invalid description
        expect(validateConfigUpdate({
            mcpServers: [{ name: 'test', command: 'cmd', enabled: true, description: 123 }]
        }).valid).toBe(false);

        // Valid headers
        expect(validateConfigUpdate({
            mcpServers: [{ name: 'test', type: 'http', url: 'http://localhost:3000', enabled: true, headers: { 'Authorization': 'Bearer token' } }]
        }).valid).toBe(true);

        // Invalid headers - not an object
        expect(validateConfigUpdate({
            mcpServers: [{ name: 'test', command: 'cmd', enabled: true, headers: 'invalid' }]
        }).valid).toBe(false);

        // Invalid headers - array
        expect(validateConfigUpdate({
            mcpServers: [{ name: 'test', command: 'cmd', enabled: true, headers: ['invalid'] }]
        }).valid).toBe(false);

        // Invalid headers - non-string value
        expect(validateConfigUpdate({
            mcpServers: [{ name: 'test', command: 'cmd', enabled: true, headers: { key: 123 } }]
        }).valid).toBe(false);

        // Valid autoApprove
        expect(validateConfigUpdate({
            mcpServers: [{ name: 'test', command: 'cmd', enabled: true, autoApprove: ['tool1', 'tool2'] }]
        }).valid).toBe(true);

        // Invalid autoApprove - not an array
        expect(validateConfigUpdate({
            mcpServers: [{ name: 'test', command: 'cmd', enabled: true, autoApprove: 'tool1' }]
        }).valid).toBe(false);

        // Invalid autoApprove - non-string items
        expect(validateConfigUpdate({
            mcpServers: [{ name: 'test', command: 'cmd', enabled: true, autoApprove: [123] }]
        }).valid).toBe(false);
    });

    it('should validate http url scheme', () => {
        // https accepted
        expect(validateConfigUpdate({
            mcpServers: [{ name: 'test', type: 'http', url: 'https://example.com', enabled: true }]
        }).valid).toBe(true);

        // non-http scheme rejected
        const res = validateConfigUpdate({
            mcpServers: [{ name: 'test', type: 'http', url: 'ftp://example.com', enabled: true }]
        });
        expect(res.valid).toBe(false);
        expect(res.error).toContain('http or https scheme');
    });

    it('should reject non-object mcpServers entries', () => {
        expect(validateConfigUpdate({ mcpServers: [null] }).valid).toBe(false);
        expect(validateConfigUpdate({ mcpServers: [null] }).error).toContain('must be an object');
        expect(validateConfigUpdate({ mcpServers: ['string-entry'] }).valid).toBe(false);
    });

    it('should reject empty server name', () => {
        const res = validateConfigUpdate({ mcpServers: [{ name: '', command: 'cmd', enabled: true }] });
        expect(res.valid).toBe(false);
        expect(res.error).toContain('name is required');
    });

    it('should reject http server with empty url', () => {
        const res = validateConfigUpdate({ mcpServers: [{ name: 't', type: 'http', url: '', enabled: true }] });
        expect(res.valid).toBe(false);
        expect(res.error).toContain('url is required');
    });

    it('should validate claudiaMcpServerEnabled boolean', () => {
        expect(validateConfigUpdate({ claudiaMcpServerEnabled: true }).valid).toBe(true);
        expect(validateConfigUpdate({ claudiaMcpServerEnabled: 'no' }).valid).toBe(false);
        expect(validateConfigUpdate({ claudiaMcpServerEnabled: 'no' }).error).toContain('must be a boolean');
    });

    it('should validate deepgramApiKey', () => {
        expect(validateConfigUpdate({ deepgramApiKey: 'key123' }).valid).toBe(true);
        const res = validateConfigUpdate({ deepgramApiKey: 123 });
        expect(res.valid).toBe(false);
        expect(res.error).toBe('deepgramApiKey must be a string');
    });

    it('should validate defaultBaseDirectory', () => {
        expect(validateConfigUpdate({ defaultBaseDirectory: '/some/path' }).valid).toBe(true);
        // null is allowed and coerced to undefined
        const nullRes = validateConfigUpdate({ defaultBaseDirectory: null });
        expect(nullRes.valid).toBe(true);
        expect(nullRes.data?.defaultBaseDirectory).toBeUndefined();
        // non-string non-null rejected
        const res = validateConfigUpdate({ defaultBaseDirectory: 123 });
        expect(res.valid).toBe(false);
        expect(res.error).toBe('defaultBaseDirectory must be a string');
    });

    describe('claudeCodeSwitches', () => {
        it('should reject non-object', () => {
            const res = validateConfigUpdate({ claudeCodeSwitches: 'x' });
            expect(res.valid).toBe(false);
            expect(res.error).toBe('claudeCodeSwitches must be an object');
            expect(validateConfigUpdate({ claudeCodeSwitches: null }).valid).toBe(false);
        });

        it('should validate verbose', () => {
            expect(validateConfigUpdate({ claudeCodeSwitches: { verbose: true } }).valid).toBe(true);
            const res = validateConfigUpdate({ claudeCodeSwitches: { verbose: 'yes' } });
            expect(res.valid).toBe(false);
            expect(res.error).toBe('claudeCodeSwitches.verbose must be a boolean');
        });

        it('should validate maxTurns', () => {
            expect(validateConfigUpdate({ claudeCodeSwitches: { maxTurns: 5 } }).valid).toBe(true);
            expect(validateConfigUpdate({ claudeCodeSwitches: { maxTurns: null } }).valid).toBe(true);
            expect(validateConfigUpdate({ claudeCodeSwitches: { maxTurns: 0 } }).valid).toBe(false);
            expect(validateConfigUpdate({ claudeCodeSwitches: { maxTurns: 1.5 } }).valid).toBe(false);
            const res = validateConfigUpdate({ claudeCodeSwitches: { maxTurns: -3 } });
            expect(res.valid).toBe(false);
            expect(res.error).toContain('maxTurns must be a positive integer');
        });

        it('should validate maxBudgetUsd', () => {
            expect(validateConfigUpdate({ claudeCodeSwitches: { maxBudgetUsd: 10 } }).valid).toBe(true);
            expect(validateConfigUpdate({ claudeCodeSwitches: { maxBudgetUsd: 0 } }).valid).toBe(true);
            expect(validateConfigUpdate({ claudeCodeSwitches: { maxBudgetUsd: null } }).valid).toBe(true);
            const res = validateConfigUpdate({ claudeCodeSwitches: { maxBudgetUsd: -1 } });
            expect(res.valid).toBe(false);
            expect(res.error).toContain('maxBudgetUsd must be a non-negative');
            expect(validateConfigUpdate({ claudeCodeSwitches: { maxBudgetUsd: 'x' } }).valid).toBe(false);
        });

        it('should validate permissionMode', () => {
            for (const mode of ['plan', 'safe', 'dangerous', 'auto', 'acceptEdits', 'bypassPermissions', 'default', 'dontAsk']) {
                expect(validateConfigUpdate({ claudeCodeSwitches: { permissionMode: mode } }).valid).toBe(true);
            }
            expect(validateConfigUpdate({ claudeCodeSwitches: { permissionMode: null } }).valid).toBe(true);
            const res = validateConfigUpdate({ claudeCodeSwitches: { permissionMode: 'bogus' } });
            expect(res.valid).toBe(false);
            expect(res.error).toContain('permissionMode must be one of');
            expect(validateConfigUpdate({ claudeCodeSwitches: { permissionMode: 42 } }).valid).toBe(false);
        });

        it('should validate string switches', () => {
            const r = validateConfigUpdate({
                claudeCodeSwitches: {
                    allowedTools: 'Read,Write',
                    disallowedTools: 'Bash',
                    appendSystemPrompt: 'extra',
                    model: 'opus',
                }
            });
            expect(r.valid).toBe(true);
            expect(r.data?.claudeCodeSwitches?.allowedTools).toBe('Read,Write');
            expect(r.data?.claudeCodeSwitches?.model).toBe('opus');

            expect(validateConfigUpdate({ claudeCodeSwitches: { allowedTools: 1 } }).error).toContain('allowedTools must be a string');
            expect(validateConfigUpdate({ claudeCodeSwitches: { disallowedTools: 1 } }).error).toContain('disallowedTools must be a string');
            expect(validateConfigUpdate({ claudeCodeSwitches: { appendSystemPrompt: 1 } }).error).toContain('appendSystemPrompt must be a string');
            expect(validateConfigUpdate({ claudeCodeSwitches: { model: 1 } }).error).toContain('model must be a string');
        });

        it('should validate defaultModel', () => {
            const r = validateConfigUpdate({ claudeCodeSwitches: { defaultModel: 'sonnet' } });
            expect(r.valid).toBe(true);
            expect(r.data?.claudeCodeSwitches?.defaultModel).toBe('sonnet');
            expect(validateConfigUpdate({ claudeCodeSwitches: { defaultModel: 1 } }).error)
                .toBe('claudeCodeSwitches.defaultModel must be a string');
        });

        it('should validate effortLevel', () => {
            const r = validateConfigUpdate({ claudeCodeSwitches: { effortLevel: 'high' } });
            expect(r.valid).toBe(true);
            expect(r.data?.claudeCodeSwitches?.effortLevel).toBe('high');
            expect(validateConfigUpdate({ claudeCodeSwitches: { effortLevel: 5 } }).error)
                .toBe('claudeCodeSwitches.effortLevel must be a string');
        });
    });

    describe('hyperspaceProxy', () => {
        it('should reject non-object', () => {
            expect(validateConfigUpdate({ hyperspaceProxy: 'x' }).error).toBe('hyperspaceProxy must be an object');
            expect(validateConfigUpdate({ hyperspaceProxy: null }).valid).toBe(false);
        });

        it('should validate fields', () => {
            const r = validateConfigUpdate({
                hyperspaceProxy: { proxyUrl: 'http://p', apiKey: 'k', model: 'm', alwaysThinkingEnabled: true }
            });
            expect(r.valid).toBe(true);
            expect(r.data?.hyperspaceProxy?.proxyUrl).toBe('http://p');
            expect(r.data?.hyperspaceProxy?.alwaysThinkingEnabled).toBe(true);

            expect(validateConfigUpdate({ hyperspaceProxy: { proxyUrl: 1 } }).error).toContain('proxyUrl must be a string');
            expect(validateConfigUpdate({ hyperspaceProxy: { apiKey: 1 } }).error).toContain('apiKey must be a string');
            expect(validateConfigUpdate({ hyperspaceProxy: { model: 1 } }).error).toContain('model must be a string');
            expect(validateConfigUpdate({ hyperspaceProxy: { alwaysThinkingEnabled: 'x' } }).error).toContain('alwaysThinkingEnabled must be a boolean');
        });
    });

    describe('sapAiCore', () => {
        it('should reject non-object', () => {
            expect(validateConfigUpdate({ sapAiCore: 'x' }).error).toBe('sapAiCore must be an object');
            expect(validateConfigUpdate({ sapAiCore: null }).valid).toBe(false);
        });

        it('should validate all fields', () => {
            const r = validateConfigUpdate({
                sapAiCore: {
                    clientId: 'id', clientSecret: 'secret', authUrl: 'http://auth',
                    baseUrl: 'http://base', resourceGroup: 'default', model: 'm', timeoutMs: 1000,
                }
            });
            expect(r.valid).toBe(true);
            expect(r.data?.sapAiCore?.clientId).toBe('id');
            expect(r.data?.sapAiCore?.timeoutMs).toBe(1000);
            expect(validateConfigUpdate({ sapAiCore: { timeoutMs: 0 } }).valid).toBe(true);
        });

        it('should reject invalid field types', () => {
            expect(validateConfigUpdate({ sapAiCore: { clientId: 1 } }).error).toContain('clientId must be a string');
            expect(validateConfigUpdate({ sapAiCore: { clientSecret: 1 } }).error).toContain('clientSecret must be a string');
            expect(validateConfigUpdate({ sapAiCore: { authUrl: 1 } }).error).toContain('authUrl must be a string');
            expect(validateConfigUpdate({ sapAiCore: { baseUrl: 1 } }).error).toContain('baseUrl must be a string');
            expect(validateConfigUpdate({ sapAiCore: { resourceGroup: 1 } }).error).toContain('resourceGroup must be a string');
            expect(validateConfigUpdate({ sapAiCore: { model: 1 } }).error).toContain('model must be a string');
            expect(validateConfigUpdate({ sapAiCore: { timeoutMs: -5 } }).error).toContain('timeoutMs must be a non-negative');
            expect(validateConfigUpdate({ sapAiCore: { timeoutMs: 'x' } }).valid).toBe(false);
        });
    });

    describe('modelTiering', () => {
        it('should reject non-object', () => {
            expect(validateConfigUpdate({ modelTiering: 'x' }).error).toBe('modelTiering must be an object');
            expect(validateConfigUpdate({ modelTiering: null }).valid).toBe(false);
        });

        it('should validate enabled', () => {
            expect(validateConfigUpdate({ modelTiering: { enabled: true } }).valid).toBe(true);
            expect(validateConfigUpdate({ modelTiering: { enabled: 'x' } }).error).toContain('enabled must be a boolean');
        });

        it('should validate tiers object', () => {
            const r = validateConfigUpdate({
                modelTiering: { enabled: true, tiers: { low: '  haiku  ', medium: 'sonnet', high: 'opus' } }
            });
            expect(r.valid).toBe(true);
            // values are trimmed
            expect(r.data?.modelTiering?.tiers?.low).toBe('haiku');
            expect(r.data?.modelTiering?.tiers?.high).toBe('opus');
        });

        it('should reject non-object tiers', () => {
            expect(validateConfigUpdate({ modelTiering: { tiers: 'x' } }).error).toContain('tiers must be an object');
            expect(validateConfigUpdate({ modelTiering: { tiers: null } }).valid).toBe(false);
        });

        it('should reject non-string tier value', () => {
            expect(validateConfigUpdate({ modelTiering: { tiers: { low: 123 } } }).error).toContain('low must be a string');
        });

        it('should reject overly long tier value', () => {
            const res = validateConfigUpdate({ modelTiering: { tiers: { medium: 'a'.repeat(201) } } });
            expect(res.valid).toBe(false);
            expect(res.error).toContain('medium too long');
        });
    });

    it('should validate multiple config fields at once', () => {
        const result = validateConfigUpdate({
            rules: 'test rules',
            skipPermissions: true,
            apiMode: 'default',
            backend: 'claude-code',
            opencodePort: 4096,
            supervisorEnabled: false,
        });
        expect(result.valid).toBe(true);
        expect(result.data?.rules).toBe('test rules');
        expect(result.data?.skipPermissions).toBe(true);
        expect(result.data?.apiMode).toBe('default');
        expect(result.data?.backend).toBe('claude-code');
        expect(result.data?.opencodePort).toBe(4096);
    });

});

describe('validateWorkspacePath', () => {
    // Use home directory which is allowed by validation
    const testDir = join(homedir(), '.claudia-test-' + Date.now());
    const testFile = join(testDir, 'test-file.txt');

    beforeEach(() => {
        if (!existsSync(testDir)) {
            mkdirSync(testDir, { recursive: true });
        }
        writeFileSync(testFile, 'test content');
    });

    afterEach(() => {
        try {
            if (existsSync(testFile)) unlinkSync(testFile);
            if (existsSync(testDir)) rmdirSync(testDir);
        } catch {
            // Ignore cleanup errors
        }
    });

    it('should reject non-string paths', () => {
        expect(validateWorkspacePath(null).valid).toBe(false);
        expect(validateWorkspacePath(123).valid).toBe(false);
        expect(validateWorkspacePath({}).valid).toBe(false);
        expect(validateWorkspacePath(null).error).toBe('Path must be a string');
    });

    it('should reject empty paths', () => {
        expect(validateWorkspacePath('').valid).toBe(false);
        expect(validateWorkspacePath('   ').valid).toBe(false);
        expect(validateWorkspacePath('').error).toBe('Path cannot be empty');
    });

    it('should accept valid directory paths', () => {
        const result = validateWorkspacePath(testDir);
        expect(result.valid).toBe(true);
        expect(result.data).toBe(testDir);
    });

    it('should reject non-existent paths', () => {
        const result = validateWorkspacePath('/non/existent/path');
        expect(result.valid).toBe(false);
        expect(result.error).toBe('Path does not exist');
    });

    it('should reject file paths (not directories)', () => {
        const result = validateWorkspacePath(testFile);
        expect(result.valid).toBe(false);
        expect(result.error).toBe('Path must be a directory');
    });

    it('should reject paths with parent directory traversal', () => {
        const result = validateWorkspacePath(testDir + '/../../../etc/passwd');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('not allowed');
    });

    it('should reject system paths', () => {
        const systemPaths = [
            '/etc/passwd',
            '/var/log',
            '/bin/bash',
            '/sbin/init',
            '/root',
            '/proc/1',
            '/sys/class',
            '/dev/null',
        ];

        for (const path of systemPaths) {
            const result = validateWorkspacePath(path);
            // Either doesn't exist or is blocked
            expect(result.valid).toBe(false);
        }
    });

    it('should handle relative paths that resolve differently', () => {
        // A relative path (no `..`) gets resolved against cwd; if it does not
        // exist this surfaces as a non-existent path rather than passing.
        const res = validateWorkspacePath('some-relative-nonexistent-dir');
        expect(res.valid).toBe(false);
    });

    it('should reject /usr non-local system path', () => {
        const res = validateWorkspacePath('/usr/bin');
        expect(res.valid).toBe(false);
        // On Unix /usr/bin exists and is blocked as a system path ('not
        // allowed'). On Windows it does not exist, so it is rejected earlier
        // with 'Path does not exist' — both are valid rejections.
        if (existsSync('/usr/bin')) {
            expect(res.error).toContain('not allowed');
        }
    });

    it('should allow /usr/local paths', () => {
        // This test may fail if /usr/local doesn't exist on the system
        const usrLocalPath = '/usr/local';
        if (existsSync(usrLocalPath)) {
            const result = validateWorkspacePath(usrLocalPath);
            expect(result.valid).toBe(true);
        }
    });
});

describe('sanitizePrompt', () => {
    it('should remove null bytes', () => {
        expect(sanitizePrompt('hello\0world')).toBe('helloworld');
        expect(sanitizePrompt('\0\0test\0')).toBe('test');
    });

    it('should remove ANSI escape sequences', () => {
        // Color codes
        expect(sanitizePrompt('\x1b[31mred text\x1b[0m')).toBe('red text');
        // Cursor movement
        expect(sanitizePrompt('\x1b[2Amove up')).toBe('move up');
        // OSC sequences
        expect(sanitizePrompt('\x1b]0;title\x07content')).toBe('content');
    });

    it('should truncate very long prompts', () => {
        const longPrompt = 'a'.repeat(150000);
        const result = sanitizePrompt(longPrompt);
        expect(result.length).toBe(100000);
    });

    it('should preserve normal text', () => {
        const normalText = 'Hello, world! How are you today? 123 !@#$%';
        expect(sanitizePrompt(normalText)).toBe(normalText);
    });

    it('should handle empty strings', () => {
        expect(sanitizePrompt('')).toBe('');
    });

    it('should handle unicode', () => {
        const unicodeText = 'Hello 世界 🌍 émoji';
        expect(sanitizePrompt(unicodeText)).toBe(unicodeText);
    });
});

describe('decodeHtmlEntities', () => {
    it('should decode hexadecimal numeric entities', () => {
        expect(decodeHtmlEntities('it&#x27;s')).toBe("it's");
        // Uppercase hex prefix and digits
        expect(decodeHtmlEntities('&#X27;')).toBe('&#X27;'); // only lowercase x is matched
        expect(decodeHtmlEntities('&#x3C;')).toBe('<');
    });

    it('should decode decimal numeric entities', () => {
        expect(decodeHtmlEntities('it&#39;s')).toBe("it's");
        expect(decodeHtmlEntities('&#60;tag&#62;')).toBe('<tag>');
    });

    it('should decode named entities', () => {
        expect(decodeHtmlEntities('&lt;')).toBe('<');
        expect(decodeHtmlEntities('&gt;')).toBe('>');
        expect(decodeHtmlEntities('&quot;')).toBe('"');
        expect(decodeHtmlEntities('&apos;')).toBe("'");
        expect(decodeHtmlEntities('a&nbsp;b')).toBe('a b');
    });

    it('should decode &amp; last to avoid double-decoding', () => {
        expect(decodeHtmlEntities('release notes &amp; agent CI')).toBe('release notes & agent CI');
        // &amp;lt; must become &lt; (literal), not <
        expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;');
    });

    it('should leave plain text untouched', () => {
        expect(decodeHtmlEntities('no entities here')).toBe('no entities here');
        expect(decodeHtmlEntities('')).toBe('');
    });
});

