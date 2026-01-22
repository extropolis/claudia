/**
 * Input validation utilities for REST API endpoints
 */

import { existsSync, statSync } from 'fs';
import { resolve, normalize, isAbsolute } from 'path';

/**
 * Result of a validation operation
 */
export interface ValidationResult<T> {
    valid: boolean;
    data?: T;
    error?: string;
}

/**
 * MCP Server configuration (matches config-store.ts)
 */
interface MCPServerConfig {
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    enabled: boolean;
}

/**
 * Config update payload validation
 */
export interface ConfigUpdatePayload {
    rules?: string;
    mcpServers?: MCPServerConfig[];
    skipPermissions?: boolean;
    autoFocusOnInput?: boolean;
    supervisorEnabled?: boolean;
    supervisorSystemPrompt?: string;
    apiMode?: 'default' | 'custom-anthropic' | 'sap-ai-core';
    customAnthropicApiKey?: string;
    aiCoreCredentials?: {
        clientId?: string;
        clientSecret?: string;
        authUrl?: string;
        baseUrl?: string;
        resourceGroup?: string;
        timeoutMs?: number;
    };
    backend?: 'claude-code' | 'opencode';
    opencodePort?: number;
}

/**
 * Validates config update payload
 * @param body - The request body to validate
 * @returns Validation result with sanitized data or error
 */
export function validateConfigUpdate(body: unknown): ValidationResult<ConfigUpdatePayload> {
    if (typeof body !== 'object' || body === null) {
        return { valid: false, error: 'Request body must be an object' };
    }

    const payload = body as Record<string, unknown>;
    const result: ConfigUpdatePayload = {};

    // Validate rules (optional string)
    if (payload.rules !== undefined) {
        if (typeof payload.rules !== 'string') {
            return { valid: false, error: 'rules must be a string' };
        }
        result.rules = payload.rules;
    }

    // Validate mcpServers (optional array of MCP server configs)
    if (payload.mcpServers !== undefined) {
        if (!Array.isArray(payload.mcpServers)) {
            return { valid: false, error: 'mcpServers must be an array' };
        }
        // Validate each server config
        for (let i = 0; i < payload.mcpServers.length; i++) {
            const server = payload.mcpServers[i] as Record<string, unknown>;
            if (typeof server !== 'object' || server === null) {
                return { valid: false, error: `mcpServers[${i}] must be an object` };
            }
            if (typeof server.name !== 'string' || !server.name) {
                return { valid: false, error: `mcpServers[${i}].name is required` };
            }
            if (typeof server.command !== 'string' || !server.command) {
                return { valid: false, error: `mcpServers[${i}].command is required` };
            }
            if (server.enabled !== undefined && typeof server.enabled !== 'boolean') {
                return { valid: false, error: `mcpServers[${i}].enabled must be a boolean` };
            }
        }
        result.mcpServers = payload.mcpServers as MCPServerConfig[];
    }

    // Validate booleans
    const booleanFields: (keyof ConfigUpdatePayload)[] = [
        'skipPermissions',
        'autoFocusOnInput',
        'supervisorEnabled'
    ];

    for (const field of booleanFields) {
        if (payload[field] !== undefined) {
            if (typeof payload[field] !== 'boolean') {
                return { valid: false, error: `${field} must be a boolean` };
            }
            (result as Record<string, unknown>)[field] = payload[field];
        }
    }

    // Validate supervisorSystemPrompt (optional string)
    if (payload.supervisorSystemPrompt !== undefined) {
        if (typeof payload.supervisorSystemPrompt !== 'string') {
            return { valid: false, error: 'supervisorSystemPrompt must be a string' };
        }
        result.supervisorSystemPrompt = payload.supervisorSystemPrompt;
    }

    // Validate apiMode (optional enum)
    if (payload.apiMode !== undefined) {
        const validModes = ['default', 'custom-anthropic', 'sap-ai-core'];
        if (!validModes.includes(payload.apiMode as string)) {
            return { valid: false, error: `apiMode must be one of: ${validModes.join(', ')}` };
        }
        result.apiMode = payload.apiMode as ConfigUpdatePayload['apiMode'];
    }

    // Validate customAnthropicApiKey (optional string)
    if (payload.customAnthropicApiKey !== undefined) {
        if (typeof payload.customAnthropicApiKey !== 'string') {
            return { valid: false, error: 'customAnthropicApiKey must be a string' };
        }
        result.customAnthropicApiKey = payload.customAnthropicApiKey;
    }

    // Validate backend (optional enum)
    if (payload.backend !== undefined) {
        const validBackends = ['claude-code', 'opencode'];
        if (!validBackends.includes(payload.backend as string)) {
            return { valid: false, error: `backend must be one of: ${validBackends.join(', ')}` };
        }
        result.backend = payload.backend as ConfigUpdatePayload['backend'];
    }

    // Validate opencodePort (optional number)
    if (payload.opencodePort !== undefined) {
        if (typeof payload.opencodePort !== 'number' || payload.opencodePort < 1 || payload.opencodePort > 65535) {
            return { valid: false, error: 'opencodePort must be a number between 1 and 65535' };
        }
        result.opencodePort = payload.opencodePort;
    }

    // Validate aiCoreCredentials (optional object)
    if (payload.aiCoreCredentials !== undefined) {
        if (typeof payload.aiCoreCredentials !== 'object' || payload.aiCoreCredentials === null) {
            return { valid: false, error: 'aiCoreCredentials must be an object' };
        }
        const creds = payload.aiCoreCredentials as Record<string, unknown>;
        result.aiCoreCredentials = {};

        const stringFields = ['clientId', 'clientSecret', 'authUrl', 'baseUrl', 'resourceGroup'];
        for (const field of stringFields) {
            if (creds[field] !== undefined) {
                if (typeof creds[field] !== 'string') {
                    return { valid: false, error: `aiCoreCredentials.${field} must be a string` };
                }
                (result.aiCoreCredentials as Record<string, unknown>)[field] = creds[field];
            }
        }

        if (creds.timeoutMs !== undefined) {
            if (typeof creds.timeoutMs !== 'number' || creds.timeoutMs < 0) {
                return { valid: false, error: 'aiCoreCredentials.timeoutMs must be a positive number' };
            }
            result.aiCoreCredentials.timeoutMs = creds.timeoutMs;
        }
    }

    return { valid: true, data: result };
}

/**
 * Validates a workspace path
 * - Must be an absolute path
 * - Must exist
 * - Must be a directory
 * - Must not traverse outside expected boundaries
 * @param path - The path to validate
 * @returns Validation result with sanitized path or error
 */
export function validateWorkspacePath(path: unknown): ValidationResult<string> {
    if (typeof path !== 'string') {
        return { valid: false, error: 'Path must be a string' };
    }

    if (!path.trim()) {
        return { valid: false, error: 'Path cannot be empty' };
    }

    // Normalize and resolve the path
    const normalizedPath = normalize(path);
    const resolvedPath = isAbsolute(normalizedPath) ? normalizedPath : resolve(normalizedPath);

    // Check for path traversal attempts
    if (resolvedPath !== normalizedPath && !isAbsolute(path)) {
        // Path was relative and resolved differently, could be traversal
        return { valid: false, error: 'Invalid path: path traversal detected' };
    }

    // Disallow paths containing suspicious patterns
    const suspiciousPatterns = [
        /\.\./, // Parent directory traversal
        /^\/etc\//, // System config
        /^\/var\//, // System var
        /^\/usr\//, // System usr (except /usr/local)
        /^\/bin\//, // System binaries
        /^\/sbin\//, // System binaries
        /^\/root\//, // Root home
        /^\/proc\//, // Proc filesystem
        /^\/sys\//, // Sys filesystem
        /^\/dev\//, // Device files
    ];

    for (const pattern of suspiciousPatterns) {
        if (pattern.test(resolvedPath)) {
            // Allow /usr/local
            if (resolvedPath.startsWith('/usr/local')) {
                continue;
            }
            return { valid: false, error: 'Invalid path: access to this location is not allowed' };
        }
    }

    // Check if path exists
    if (!existsSync(resolvedPath)) {
        return { valid: false, error: 'Path does not exist' };
    }

    // Check if it's a directory
    try {
        const stats = statSync(resolvedPath);
        if (!stats.isDirectory()) {
            return { valid: false, error: 'Path must be a directory' };
        }
    } catch (err) {
        return { valid: false, error: 'Cannot access path' };
    }

    return { valid: true, data: resolvedPath };
}

/**
 * Sanitizes a prompt string to prevent command injection
 * Removes or escapes potentially dangerous characters
 * @param prompt - The prompt to sanitize
 * @returns Sanitized prompt string
 */
export function sanitizePrompt(prompt: string): string {
    // Remove null bytes which could truncate strings
    let sanitized = prompt.replace(/\0/g, '');

    // Remove ANSI escape sequences that could manipulate terminal
    sanitized = sanitized.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    sanitized = sanitized.replace(/\x1b\][^\x07]*\x07/g, '');

    // Limit length to prevent DoS
    const MAX_PROMPT_LENGTH = 100000;
    if (sanitized.length > MAX_PROMPT_LENGTH) {
        sanitized = sanitized.substring(0, MAX_PROMPT_LENGTH);
    }

    return sanitized;
}

/**
 * Validates AI Core test credentials
 */
export interface AICoreTestPayload {
    clientId: string;
    clientSecret: string;
    authUrl: string;
    baseUrl?: string;
    resourceGroup?: string;
    timeoutMs?: number;
}

/**
 * Validates AI Core credentials for testing
 * @param body - The request body to validate
 * @returns Validation result
 */
export function validateAICoreCredentials(body: unknown): ValidationResult<AICoreTestPayload> {
    if (typeof body !== 'object' || body === null) {
        return { valid: false, error: 'Request body must be an object' };
    }

    const payload = body as Record<string, unknown>;

    // Required fields
    if (typeof payload.clientId !== 'string' || !payload.clientId) {
        return { valid: false, error: 'clientId is required' };
    }
    if (typeof payload.clientSecret !== 'string' || !payload.clientSecret) {
        return { valid: false, error: 'clientSecret is required' };
    }
    if (typeof payload.authUrl !== 'string' || !payload.authUrl) {
        return { valid: false, error: 'authUrl is required' };
    }

    // Validate URLs
    try {
        new URL(payload.authUrl);
    } catch {
        return { valid: false, error: 'authUrl must be a valid URL' };
    }

    if (payload.baseUrl !== undefined) {
        if (typeof payload.baseUrl !== 'string') {
            return { valid: false, error: 'baseUrl must be a string' };
        }
        try {
            new URL(payload.baseUrl);
        } catch {
            return { valid: false, error: 'baseUrl must be a valid URL' };
        }
    }

    const result: AICoreTestPayload = {
        clientId: payload.clientId,
        clientSecret: payload.clientSecret,
        authUrl: payload.authUrl,
        baseUrl: payload.baseUrl as string | undefined,
        resourceGroup: typeof payload.resourceGroup === 'string' ? payload.resourceGroup : undefined,
        timeoutMs: typeof payload.timeoutMs === 'number' ? payload.timeoutMs : undefined
    };

    return { valid: true, data: result };
}
