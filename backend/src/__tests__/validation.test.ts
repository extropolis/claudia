import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmdirSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import {
    validateConfigUpdate,
    validateWorkspacePath,
    sanitizePrompt,
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
        expect(validateConfigUpdate({ apiMode: 'hyperspace-proxy' }).valid).toBe(false);
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

