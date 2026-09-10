/**
 * OpenCode adapter.
 *
 * Capabilities mirror what the code does for OpenCode TODAY, not what it
 * should do. State polling, the idle reaper and the memory guard are all
 * gated off for OpenCode by the `=== 'claude-code'` checks in task-spawner,
 * and this descriptor preserves that exactly so the seam lands as a pure
 * refactor. Turning them on is issue #62 phase 4 (OpenCode migration), where
 * OpenCode moves onto the shared engine and *gains* the subsystems it lacks.
 */
import type {
    AgentAdapter,
    AgentDetectResult,
    AgentSpawnConfig,
    ExecSyncLike,
    McpInjection,
    McpInjectionContext,
    SpawnPlan,
    SpawnTarget,
} from '../types.js';
import type { AgentCapabilities, AgentDisplayInfo } from '@claudia/shared';
import { notYetOnAdapterSeam } from '../types.js';
import { execSync as nodeExecSync } from 'child_process';

export const OPENCODE_DISPLAY: AgentDisplayInfo = {
    id: 'opencode',
    name: 'OpenCode',
    shortLabel: 'opencode',
    description: 'Open-source AI coding agent by SST',
    installUrl: 'https://opencode.ai',
    colour: '#5b8def',
};

export const OPENCODE_CAPABILITIES: AgentCapabilities = {
    // All four gated OFF today by task-spawner's `=== 'claude-code'` checks.
    ptyStatePolling: false,
    sessionFileCapture: false,
    idleReaper: false,
    memoryGuard: false,
    // The TUI does prompt, but Claudia has no interception path for it.
    interactiveApprovals: false,
    // `--session <id>` is handed straight to the CLI; nothing checks a file.
    resumeRequiresSessionFile: false,
    supportsSystemPromptFlag: false,
    transport: 'pty',
    expectedMemoryMb: 200,
};

const NOT_INSTALLED = 'OpenCode is not installed. Install from: https://opencode.ai';

const defaultExecSync: ExecSyncLike = (command, options) => nodeExecSync(command, options);

/** Last-resort model, matching the current spawn path. */
export const OPENCODE_FALLBACK_MODEL = 'openai/gpt-4o';

export interface OpenCodeAdapterDeps {
    /** Defaults to `child_process.execSync`. */
    execSync?: ExecSyncLike;
    /** Defaults to global `fetch`. Used for the `/global/health` probe. */
    fetch?: typeof fetch;
    /** Defaults to `process.platform`. */
    platform?: string;
    /** Defaults to `process.env`. */
    env?: Record<string, string | undefined>;
}

export interface OpenCodeAdapterOptions extends OpenCodeAdapterDeps {
    /**
     * Where the OpenCode server is expected to listen. Passed in rather than
     * read from the config store so the adapter stays unit-testable and has
     * no import edge to configuration.
     */
    getPort: () => number;
}

/** node-pty needs the .exe suffix on Windows to find the executable. */
function opencodeExe(platform: string): string {
    return platform === 'win32' ? 'opencode.exe' : 'opencode';
}

export function createOpenCodeAdapter(options: OpenCodeAdapterOptions): AgentAdapter {
    const platform = () => options.platform ?? process.platform;
    const env = () => options.env ?? process.env;

    /** The model the CLI is launched with: explicit > env > fallback. */
    function resolveModel(config: AgentSpawnConfig): string {
        return config.model
            || config.modelOverride
            || env()['OPENCODE_MODEL']
            || OPENCODE_FALLBACK_MODEL;
    }

    return {
        id: 'opencode',
        display: OPENCODE_DISPLAY,
        capabilities: OPENCODE_CAPABILITIES,

        async detect(): Promise<AgentDetectResult> {
            const exec = options.execSync ?? defaultExecSync;
            let version: string;
            try {
                version = exec('opencode --version', { encoding: 'utf8', timeout: 5000 }).trim();
            } catch {
                return { installed: false, error: NOT_INSTALLED };
            }

            // Installed but server-down is a normal, reportable state — a
            // failed probe must not turn into "not installed".
            const doFetch = options.fetch ?? globalThis.fetch;
            let serverRunning = false;
            try {
                const response = await doFetch(`http://127.0.0.1:${options.getPort()}/global/health`, {
                    signal: AbortSignal.timeout(2000),
                });
                serverRunning = response.ok;
            } catch {
                serverRunning = false;
            }
            return { installed: true, version, serverRunning };
        },

        resolveExecutable(): SpawnTarget {
            return { command: opencodeExe(platform()), prefixArgs: [] };
        },

        buildSpawnArgs(config: AgentSpawnConfig): SpawnPlan {
            // The interactive TUI takes the prompt by keystroke once it is
            // ready, not on the command line — so the only create-time arg is
            // the model.
            return {
                argv: ['-m', resolveModel(config)],
                env: config.env,
                cwd: config.cwd,
            };
        },

        buildResumeArgs(sessionId: string | null, config: AgentSpawnConfig): SpawnPlan {
            // Matches the reconnect path in task-spawner: session only, no
            // `-m`. A fresh start (no session id) passes no arguments at all.
            return {
                argv: sessionId ? ['--session', sessionId] : [],
                env: config.env,
                cwd: config.cwd,
            };
        },

        injectMcp(_context: McpInjectionContext): McpInjection {
            return notYetOnAdapterSeam('opencode', 'injectMcp');
        },
    };
}
