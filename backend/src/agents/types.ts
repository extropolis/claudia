/**
 * The agent adapter seam.
 *
 * One file per coding agent under `adapters/`, registered in `index.ts`.
 * Everything agent-specific lives behind this interface; the task engine
 * itself stays agent-neutral. Adding an agent is meant to be exactly two
 * touch points:
 *
 *   1. a new entry in `AGENT_IDS` (shared/src/index.ts)
 *   2. a new adapter file + one `registerAgent(...)` line in `agents/index.ts`
 *
 * The argv builders are deliberately PURE (config in, plan out) so they are
 * unit-testable on all three CI legs without a PTY — PTY-driven suites
 * `skipIf(isWin)`, which collides with the 60% new-file coverage floor.
 */
import type {
    AgentCapabilities,
    AgentDetectResult,
    AgentDisplayInfo,
    AgentId,
} from '@claudia/shared';
import type { ClaudeCodeSwitches } from '../config-store.js';

export type { AgentCapabilities, AgentDetectResult, AgentDisplayInfo, AgentId };

/**
 * How to launch the agent's executable.
 *
 * `prefixArgs` exists because Windows npm installs ship `claude.cmd`, which
 * node-pty cannot spawn directly — the resolver may return
 * `{ command: node, prefixArgs: ['…/cli.js'] }` instead.
 *
 * Composition rule for the engine:
 *   spawn(target.command, [...target.prefixArgs, ...plan.argv], { cwd, env })
 */
export interface SpawnTarget {
    command: string;
    prefixArgs: string[];
}

/**
 * Everything an argv builder is allowed to look at. No `this`, no config
 * store, no filesystem — whatever the builder needs is passed in, so the
 * result is a pure function of this object.
 */
export interface AgentSpawnConfig {
    /** Working directory for the child process (the workspace root). */
    cwd: string;
    /** Environment handed to the child process. */
    env: Record<string, string>;
    /** Argv prepended verbatim — e.g. `CC_CLAUDE_ARGS` split on spaces. */
    extraArgs?: string[];
    /** Fully-composed system prompt (orchestration guidance already merged). */
    systemPrompt?: string;
    /** Global "skip permission prompts" setting. */
    skipPermissions?: boolean;
    /** Agent CLI switches from Settings. */
    switches?: ClaudeCodeSwitches;
    /**
     * Per-task model override. Adapters MUST ignore ids outside their own
     * namespace rather than passing them through (a Codex task handed
     * `sonnet` would fail to start).
     */
    modelOverride?: string;
    /** Path of an already-written MCP config file, for agents taking a flag. */
    mcpConfigFile?: string;
    /** Model for agents that always take one explicitly (OpenCode). */
    model?: string;
}

/** The pure result of an argv builder. */
export interface SpawnPlan {
    /** The agent's own arguments — NOT including `SpawnTarget.prefixArgs`. */
    argv: string[];
    env: Record<string, string>;
    cwd: string;
}

/**
 * How an agent gets Claudia's MCP server wired in for one task.
 *
 * Shaped to cover both known mechanisms: Claude Code wants a temp JSON file
 * plus `--mcp-config <path>`; Codex wants repeatable `-c key=value` overrides
 * with the bearer token delivered through the environment so it never appears
 * on the command line.
 */
export interface McpInjection {
    /** Extra argv appended for MCP wiring. */
    argv: string[];
    /** Extra environment variables the child needs. */
    env: Record<string, string>;
    /** Files the engine must write before spawning. */
    files: Array<{ path: string; contents: string }>;
}

export interface McpInjectionContext {
    taskId: string;
    workspaceId: string;
    /** `mcpServers` map, already filtered to the enabled set. */
    mcpConfig: Record<string, unknown>;
}

/**
 * One coding agent.
 *
 * SCOPE NOTE: this slice implements `id`, `display`, `capabilities`,
 * `detect`, `resolveExecutable`, `buildSpawnArgs` and `buildResumeArgs`.
 * `injectMcp` is typed but throws — the engine extraction (issue #62 phase 1)
 * is what moves MCP building out of task-spawner.ts and onto this seam.
 */
export interface AgentAdapter {
    readonly id: AgentId;
    readonly display: AgentDisplayInfo;
    readonly capabilities: AgentCapabilities;

    /** Is the agent installed, and (if it has one) is its server up? */
    detect(): Promise<AgentDetectResult>;

    /** Where the executable lives and how to invoke it. */
    resolveExecutable(): SpawnTarget;

    /** Argv for a brand-new task. Pure. */
    buildSpawnArgs(config: AgentSpawnConfig): SpawnPlan;

    /** Argv for resuming an existing session. Pure. */
    buildResumeArgs(sessionId: string | null, config: AgentSpawnConfig): SpawnPlan;

    /** Per-task MCP wiring. Not yet implemented on this seam. */
    injectMcp(context: McpInjectionContext): McpInjection;
}

/**
 * The slice of `child_process.execSync` a `detect()` needs. Adapters take this
 * as an injectable dependency so version probing is testable without shelling
 * out — and so the CI legs do not depend on which CLIs happen to be installed.
 */
export type ExecSyncLike = (
    command: string,
    options: { encoding: 'utf8'; timeout: number },
) => string;

/** Shared "not on this seam yet" stub, so every adapter fails identically. */
export function notYetOnAdapterSeam(agentId: string, member: string): never {
    throw new Error(
        `[agents] ${agentId}.${member}() is not implemented on the adapter seam yet — ` +
        `task-spawner.ts still owns it. See issue #62 phase 1 (engine extraction).`
    );
}
