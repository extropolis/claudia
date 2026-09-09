/**
 * Agent registration — the ONE place built-in agents are wired up.
 *
 * Adding a coding agent (Codex is next) is exactly two touch points:
 *   1. add its id to `AGENT_IDS` in shared/src/index.ts
 *   2. add `adapters/<agent>.ts` and one `registerAgent(...)` line below
 *
 * Everything else — `BACKEND_INFO`, config validation, `/api/backend/status`,
 * the Settings radios, the capability gates in task-spawner — derives from
 * those two.
 */
import { registerAgent } from './registry.js';
import { createClaudeCodeAdapter } from './adapters/claude-code.js';
import { createOpenCodeAdapter } from './adapters/opencode.js';

export * from './types.js';
export * from './registry.js';
export { CLAUDE_CODE_CAPABILITIES, CLAUDE_CODE_DISPLAY, createClaudeCodeAdapter } from './adapters/claude-code.js';
export { OPENCODE_CAPABILITIES, OPENCODE_DISPLAY, createOpenCodeAdapter } from './adapters/opencode.js';

/**
 * The OpenCode server port lives in the config store, which is constructed
 * long after this module loads. Rather than give the registry a config-store
 * import edge, the port is read through a provider the server installs at
 * startup; until then the config-store default (4096) applies.
 */
const DEFAULT_OPENCODE_PORT = 4096;
let opencodePortProvider: () => number = () => DEFAULT_OPENCODE_PORT;

/** Point the OpenCode adapter's health probe at the configured port. */
export function setOpencodePortProvider(provider: () => number): void {
    opencodePortProvider = provider;
}

/** The port the OpenCode adapter will probe on its next `detect()`. */
export function getOpencodePort(): number {
    return opencodePortProvider();
}

registerAgent(createClaudeCodeAdapter());
registerAgent(createOpenCodeAdapter({ getPort: getOpencodePort }));
