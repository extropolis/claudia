/**
 * Claude Code adapter.
 *
 * The reference implementation of the seam: every capability on, PTY
 * transport, session transcripts on disk. The argv builders reproduce exactly
 * what `task-spawner.ts` builds today (create path `:3417-3600`, reconnect
 * path `:5223-5300`) so the engine extraction can swap the inline code for
 * these calls with the existing argv suites as the parity gate.
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
import { resolveClaudeSpawn } from '../../claude-cli-resolver.js';
import { buildClaudeCodeSwitchArgs, bypassesPermissions } from '../claude-code-args.js';

export const CLAUDE_CODE_DISPLAY: AgentDisplayInfo = {
    id: 'claude-code',
    name: 'Claude Code',
    shortLabel: 'claude',
    description: "Anthropic's official CLI tool for Claude",
    installUrl: 'https://claude.ai/code',
    colour: '#d97757',
};

export const CLAUDE_CODE_CAPABILITIES: AgentCapabilities = {
    ptyStatePolling: true,
    sessionFileCapture: true,
    idleReaper: true,
    memoryGuard: true,
    interactiveApprovals: true,
    resumeRequiresSessionFile: true,
    supportsSystemPromptFlag: true,
    transport: 'pty',
    // The memory guard's existing threshold, which was tuned to "~300 MB per
    // Claude CLI" and hardcoded because there was only ever one agent.
    expectedMemoryMb: 300,
};

const NOT_INSTALLED = 'Claude Code is not installed. Install from: https://claude.ai/code';

/** Injection points so `detect()` is testable without shelling out. */
export interface ClaudeCodeAdapterDeps {
    /** Defaults to `child_process.execSync`. */
    execSync?: ExecSyncLike;
}

const defaultExecSync: ExecSyncLike = (command, options) => nodeExecSync(command, options);

/** Allowed tools argument: everything when permissions are bypassed, MCP only otherwise. */
function allowedToolsArg(bypassed: boolean): string[] {
    return ['--allowedTools', bypassed ? '*' : 'mcp__*'];
}

export function createClaudeCodeAdapter(deps: ClaudeCodeAdapterDeps = {}): AgentAdapter {
    return {
        id: 'claude-code',
        display: CLAUDE_CODE_DISPLAY,
        capabilities: CLAUDE_CODE_CAPABILITIES,

        async detect(): Promise<AgentDetectResult> {
            const exec = deps.execSync ?? defaultExecSync;
            try {
                const version = exec('claude --version', { encoding: 'utf8', timeout: 5000 }).trim();
                return { installed: true, version };
            } catch {
                return { installed: false, error: NOT_INSTALLED };
            }
        },

        resolveExecutable(): SpawnTarget {
            return resolveClaudeSpawn();
        },

        buildSpawnArgs(config: AgentSpawnConfig): SpawnPlan {
            const argv: string[] = [...(config.extraArgs ?? [])];

            // A `bypassPermissions`/`dangerous` permission mode bypasses just
            // as effectively as the global toggle, and the create path has
            // always treated the two identically.
            const bypassed = bypassesPermissions(config.skipPermissions, config.switches);
            if (bypassed) argv.push('--dangerously-skip-permissions');

            if (config.systemPrompt && config.systemPrompt.trim()) {
                argv.push('--system-prompt', config.systemPrompt.trim());
            }

            // Claude does not auto-load MCP servers from ~/.claude.json in
            // non-interactive mode, so the config file is passed explicitly.
            if (config.mcpConfigFile) {
                argv.push('--mcp-config', config.mcpConfigFile);
            }

            argv.push(...allowedToolsArg(bypassed));

            if (config.switches) {
                const switches = config.modelOverride && config.modelOverride.trim()
                    ? { ...config.switches, defaultModel: config.modelOverride.trim() }
                    : config.switches;
                argv.push(...buildClaudeCodeSwitchArgs(switches));
            }

            // Terminates argument parsing — workaround for a Claude CLI bug
            // where a trailing --mcp-config value swallows later flags.
            // See: https://github.com/anthropics/claude-code/issues/22404
            argv.push('--');

            return { argv, env: config.env, cwd: config.cwd };
        },

        buildResumeArgs(sessionId: string | null, config: AgentSpawnConfig): SpawnPlan {
            const argv: string[] = [...(config.extraArgs ?? [])];

            // NOTE: resume intentionally reads only the global skip-permissions
            // toggle, not the permission MODE, and orders MCP/system-prompt
            // after the switches — both differ from the create path above.
            // Reproduced verbatim rather than "fixed": this slice is the seam,
            // not a behaviour change. Converging the two is engine-extraction
            // work with the reconnect suites as the gate.
            const skip = Boolean(config.skipPermissions);
            if (skip) argv.push('--dangerously-skip-permissions');

            argv.push(...allowedToolsArg(skip));

            if (config.switches) {
                argv.push(...buildClaudeCodeSwitchArgs(config.switches));
            }

            if (config.mcpConfigFile) {
                argv.push('--mcp-config', config.mcpConfigFile);
            }

            if (config.systemPrompt && config.systemPrompt.trim()) {
                argv.push('--system-prompt', config.systemPrompt.trim());
            }

            if (sessionId) {
                argv.push('--resume', sessionId);
            }

            return { argv, env: config.env, cwd: config.cwd };
        },

        injectMcp(_context: McpInjectionContext): McpInjection {
            return notYetOnAdapterSeam('claude-code', 'injectMcp');
        },
    };
}
