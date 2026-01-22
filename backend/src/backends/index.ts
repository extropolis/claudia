/**
 * Backend module - AI coding assistant backend implementations
 */

export * from './types.js';
export { ClaudeCodeBackend } from './claude-code-backend.js';
export { OpenCodeBackend } from './opencode-backend.js';

import { BackendType, CodeBackend } from './types.js';
import { ClaudeCodeBackend } from './claude-code-backend.js';
import { OpenCodeBackend } from './opencode-backend.js';
import { ConfigStore } from '../config-store.js';

/**
 * Create a backend instance based on the configured type
 */
export function createBackend(backendType: BackendType, configStore?: ConfigStore): CodeBackend {
    switch (backendType) {
        case 'opencode':
            return new OpenCodeBackend(configStore);
        case 'claude-code':
        default:
            return new ClaudeCodeBackend(configStore);
    }
}
