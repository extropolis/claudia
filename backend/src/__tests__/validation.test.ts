import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmdirSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import {
    validateConfigUpdate,
    validateWorkspacePath,
    sanitizePrompt,
    validateAICoreCredentials,
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
        expect(validateConfigUpdate({ apiMode: 'sap-ai-core' }).valid).toBe(true);
        expect(validateConfigUpdate({ apiMode: 'invalid' }).valid).toBe(false);
        expect(validateConfigUpdate({ apiMode: 'invalid' }).error).toContain('apiMode must be one of');
    });

    it('should validate customAnthropicApiKey', () => {
        expect(validateConfigUpdate({ customAnthropicApiKey: 'sk-test-key' }).valid).toBe(true);
        expect(validateConfigUpdate({ customAnthropicApiKey: 123 }).valid).toBe(false);
    });

    it('should validate aiCoreCredentials', () => {
        // Valid credentials
        const validCreds = {
            aiCoreCredentials: {
                clientId: 'test-client',
                clientSecret: 'test-secret',
                authUrl: 'https://auth.example.com',
                baseUrl: 'https://api.example.com',
                resourceGroup: 'test-group',
                timeoutMs: 30000,
            }
        };
        expect(validateConfigUpdate(validCreds).valid).toBe(true);

        // Invalid - not an object
        expect(validateConfigUpdate({ aiCoreCredentials: 'invalid' }).valid).toBe(false);

        // Invalid - timeoutMs must be positive
        expect(validateConfigUpdate({
            aiCoreCredentials: { timeoutMs: -100 }
        }).valid).toBe(false);

        // Invalid - string fields must be strings
        expect(validateConfigUpdate({
            aiCoreCredentials: { clientId: 123 }
        }).valid).toBe(false);
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

describe('validateAICoreCredentials', () => {
    const validPayload = {
        clientId: 'test-client',
        clientSecret: 'test-secret',
        authUrl: 'https://auth.example.com/oauth/token',
    };

    it('should reject non-object input', () => {
        expect(validateAICoreCredentials(null).valid).toBe(false);
        expect(validateAICoreCredentials('string').valid).toBe(false);
        expect(validateAICoreCredentials(123).valid).toBe(false);
    });

    it('should require clientId', () => {
        const payload = { ...validPayload };
        delete (payload as Record<string, unknown>).clientId;
        expect(validateAICoreCredentials(payload).valid).toBe(false);
        expect(validateAICoreCredentials(payload).error).toBe('clientId is required');
    });

    it('should require clientSecret', () => {
        const payload = { ...validPayload };
        delete (payload as Record<string, unknown>).clientSecret;
        expect(validateAICoreCredentials(payload).valid).toBe(false);
        expect(validateAICoreCredentials(payload).error).toBe('clientSecret is required');
    });

    it('should require authUrl', () => {
        const payload = { ...validPayload };
        delete (payload as Record<string, unknown>).authUrl;
        expect(validateAICoreCredentials(payload).valid).toBe(false);
        expect(validateAICoreCredentials(payload).error).toBe('authUrl is required');
    });

    it('should validate authUrl is a valid URL', () => {
        const payload = { ...validPayload, authUrl: 'not-a-url' };
        expect(validateAICoreCredentials(payload).valid).toBe(false);
        expect(validateAICoreCredentials(payload).error).toBe('authUrl must be a valid URL');
    });

    it('should accept valid payload', () => {
        const result = validateAICoreCredentials(validPayload);
        expect(result.valid).toBe(true);
        expect(result.data?.clientId).toBe('test-client');
        expect(result.data?.clientSecret).toBe('test-secret');
        expect(result.data?.authUrl).toBe('https://auth.example.com/oauth/token');
    });

    it('should accept optional baseUrl if valid', () => {
        const payload = { ...validPayload, baseUrl: 'https://api.example.com' };
        const result = validateAICoreCredentials(payload);
        expect(result.valid).toBe(true);
        expect(result.data?.baseUrl).toBe('https://api.example.com');
    });

    it('should reject invalid baseUrl', () => {
        const payload = { ...validPayload, baseUrl: 'not-a-url' };
        expect(validateAICoreCredentials(payload).valid).toBe(false);
        expect(validateAICoreCredentials(payload).error).toBe('baseUrl must be a valid URL');
    });

    it('should accept optional resourceGroup and timeoutMs', () => {
        const payload = {
            ...validPayload,
            resourceGroup: 'my-group',
            timeoutMs: 60000,
        };
        const result = validateAICoreCredentials(payload);
        expect(result.valid).toBe(true);
        expect(result.data?.resourceGroup).toBe('my-group');
        expect(result.data?.timeoutMs).toBe(60000);
    });
});
