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
    type?: 'stdio' | 'http' | 'streamableHttp';  // Default: 'stdio'
    command?: string;  // Required for stdio, not for http/streamableHttp
    args?: string[];
    env?: Record<string, string>;
    url?: string;  // Required for http/streamableHttp
    enabled: boolean;
    timeout?: number;
    autoApprove?: string[];
    description?: string;
    headers?: Record<string, string>;  // For http/streamableHttp
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
    apiMode?: 'default' | 'custom-anthropic';
    customAnthropicApiKey?: string;
    backend?: 'claude-code' | 'opencode';
    opencodePort?: number;
    claudeCodeSwitches?: {
        verbose?: boolean;
        maxTurns?: number | null;
        maxBudgetUsd?: number | null;
        permissionMode?: string | null;
        allowedTools?: string;
        disallowedTools?: string;
        appendSystemPrompt?: string;
    };
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

            // Validate type if provided
            const serverType = server.type as string | undefined;
            if (serverType !== undefined && serverType !== 'stdio' && serverType !== 'streamableHttp' && serverType !== 'http') {
                return { valid: false, error: `mcpServers[${i}].type must be 'stdio', 'http', or 'streamableHttp'` };
            }

            // Validate based on server type
            if (serverType === 'streamableHttp' || serverType === 'http') {
                // HTTP servers require url, not command
                if (typeof server.url !== 'string' || !server.url) {
                    return { valid: false, error: `mcpServers[${i}].url is required for streamableHttp type` };
                }
                // Validate url is a valid URL
                try {
                    new URL(server.url);
                } catch {
                    return { valid: false, error: `mcpServers[${i}].url must be a valid URL` };
                }
            } else {
                // stdio servers (default) require command
                if (typeof server.command !== 'string' || !server.command) {
                    return { valid: false, error: `mcpServers[${i}].command is required for stdio type` };
                }
            }

            if (server.enabled !== undefined && typeof server.enabled !== 'boolean') {
                return { valid: false, error: `mcpServers[${i}].enabled must be a boolean` };
            }

            // Validate optional fields
            if (server.timeout !== undefined) {
                if (typeof server.timeout !== 'number' || server.timeout <= 0) {
                    return { valid: false, error: `mcpServers[${i}].timeout must be a positive number` };
                }
            }

            if (server.autoApprove !== undefined) {
                if (!Array.isArray(server.autoApprove) || !server.autoApprove.every(item => typeof item === 'string')) {
                    return { valid: false, error: `mcpServers[${i}].autoApprove must be an array of strings` };
                }
            }

            if (server.description !== undefined && typeof server.description !== 'string') {
                return { valid: false, error: `mcpServers[${i}].description must be a string` };
            }

            // Validate headers (optional object with string values)
            if (server.headers !== undefined) {
                if (typeof server.headers !== 'object' || server.headers === null || Array.isArray(server.headers)) {
                    return { valid: false, error: `mcpServers[${i}].headers must be an object` };
                }
                for (const [key, value] of Object.entries(server.headers)) {
                    if (typeof value !== 'string') {
                        return { valid: false, error: `mcpServers[${i}].headers.${key} must be a string` };
                    }
                }
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
        const validModes = ['default', 'custom-anthropic'];
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

    // Validate claudeCodeSwitches (optional object)
    if (payload.claudeCodeSwitches !== undefined) {
        if (typeof payload.claudeCodeSwitches !== 'object' || payload.claudeCodeSwitches === null) {
            return { valid: false, error: 'claudeCodeSwitches must be an object' };
        }
        const switches = payload.claudeCodeSwitches as Record<string, unknown>;
        result.claudeCodeSwitches = {};

        if (switches.verbose !== undefined) {
            if (typeof switches.verbose !== 'boolean') {
                return { valid: false, error: 'claudeCodeSwitches.verbose must be a boolean' };
            }
            result.claudeCodeSwitches.verbose = switches.verbose;
        }

        if (switches.maxTurns !== undefined) {
            if (switches.maxTurns !== null && (typeof switches.maxTurns !== 'number' || switches.maxTurns < 1 || !Number.isInteger(switches.maxTurns))) {
                return { valid: false, error: 'claudeCodeSwitches.maxTurns must be a positive integer or null' };
            }
            result.claudeCodeSwitches.maxTurns = switches.maxTurns as number | null;
        }

        if (switches.maxBudgetUsd !== undefined) {
            if (switches.maxBudgetUsd !== null && (typeof switches.maxBudgetUsd !== 'number' || switches.maxBudgetUsd < 0)) {
                return { valid: false, error: 'claudeCodeSwitches.maxBudgetUsd must be a non-negative number or null' };
            }
            result.claudeCodeSwitches.maxBudgetUsd = switches.maxBudgetUsd as number | null;
        }

        if (switches.permissionMode !== undefined) {
            if (switches.permissionMode !== null) {
                const validModes = ['plan', 'safe', 'dangerous', 'auto'];
                if (typeof switches.permissionMode !== 'string' || !validModes.includes(switches.permissionMode)) {
                    return { valid: false, error: `claudeCodeSwitches.permissionMode must be one of: ${validModes.join(', ')} or null` };
                }
            }
            result.claudeCodeSwitches.permissionMode = switches.permissionMode as string | null;
        }

        if (switches.allowedTools !== undefined) {
            if (typeof switches.allowedTools !== 'string') {
                return { valid: false, error: 'claudeCodeSwitches.allowedTools must be a string' };
            }
            result.claudeCodeSwitches.allowedTools = switches.allowedTools;
        }

        if (switches.disallowedTools !== undefined) {
            if (typeof switches.disallowedTools !== 'string') {
                return { valid: false, error: 'claudeCodeSwitches.disallowedTools must be a string' };
            }
            result.claudeCodeSwitches.disallowedTools = switches.disallowedTools;
        }

        if (switches.appendSystemPrompt !== undefined) {
            if (typeof switches.appendSystemPrompt !== 'string') {
                return { valid: false, error: 'claudeCodeSwitches.appendSystemPrompt must be a string' };
            }
            result.claudeCodeSwitches.appendSystemPrompt = switches.appendSystemPrompt;
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

    // Check for parent directory traversal in the raw input (before normalize resolves it away)
    if (/\.\./.test(path)) {
        return { valid: false, error: 'Invalid path: access to this location is not allowed' };
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
        /^\/etc(\/|$)/, // System config
        /^\/var(\/|$)/, // System var
        /^\/usr(\/|$)/, // System usr (except /usr/local)
        /^\/bin(\/|$)/, // System binaries
        /^\/sbin(\/|$)/, // System binaries
        /^\/root(\/|$)/, // Root home
        /^\/proc(\/|$)/, // Proc filesystem
        /^\/sys(\/|$)/, // Sys filesystem
        /^\/dev(\/|$)/, // Device files
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
