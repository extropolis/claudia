/**
 * Pure argv helpers for the Claude Code CLI.
 *
 * DUPLICATION NOTE (deliberate, temporary): `task-spawner.ts:67` still exports
 * its own `buildClaudeCodeSwitchArgs`, and `backends/claude-code-backend.ts:49`
 * has a third private copy. This module is the version the adapter seam uses;
 * the engine extraction (#62 phase 1) deletes the other two and repoints their
 * callers here. Until then `agents-claude-code-adapter.test.ts` asserts this
 * module and task-spawner's copy agree on a matrix of inputs, so the copies
 * cannot silently drift the way the state heuristics already did.
 *
 * The adapter cannot simply import task-spawner: task-spawner pulls in
 * node-pty, whose native binding is selected from `process.platform` at module
 * load, and dragging that into every adapter unit test is exactly what
 * `claude-cli-resolver.ts` was split out to avoid.
 */
import type { ClaudeCodeSwitches } from '../config-store.js';

/**
 * Map legacy permission mode values to actual Claude Code CLI values.
 * Claude CLI --permission-mode accepts: acceptEdits, bypassPermissions, default, dontAsk, plan
 * Old Claudia UI used: plan, safe, dangerous, auto
 */
export const PERMISSION_MODE_MAP: Record<string, string> = {
    // Legacy values → actual CLI values
    'safe': 'acceptEdits',
    'dangerous': 'bypassPermissions',
    'auto': 'dontAsk',
    // These are already valid CLI values (pass through)
    'plan': 'plan',
    'default': 'default',
    'acceptEdits': 'acceptEdits',
    'bypassPermissions': 'bypassPermissions',
    'dontAsk': 'dontAsk',
};

/** Build CLI args from ClaudeCodeSwitches config. Pure. */
export function buildClaudeCodeSwitchArgs(switches: ClaudeCodeSwitches): string[] {
    const args: string[] = [];

    if (switches.verbose) {
        args.push('--verbose');
    }

    if (switches.maxTurns != null && switches.maxTurns > 0) {
        args.push('--max-turns', String(switches.maxTurns));
    }

    if (switches.maxBudgetUsd != null && switches.maxBudgetUsd > 0) {
        args.push('--max-budget-usd', String(switches.maxBudgetUsd));
    }

    if (switches.permissionMode) {
        const cliMode = PERMISSION_MODE_MAP[switches.permissionMode] || switches.permissionMode;
        args.push('--permission-mode', cliMode);
    }

    if (switches.allowedTools && switches.allowedTools.trim()) {
        args.push('--allowedTools', switches.allowedTools.trim());
    }

    if (switches.disallowedTools && switches.disallowedTools.trim()) {
        args.push('--disallowedTools', switches.disallowedTools.trim());
    }

    if (switches.appendSystemPrompt && switches.appendSystemPrompt.trim()) {
        args.push('--append-system-prompt', switches.appendSystemPrompt.trim());
    }

    if (switches.defaultModel && switches.defaultModel.trim()) {
        args.push('--model', switches.defaultModel.trim());
    }

    return args;
}

/**
 * The global skip-permissions setting is not the only way permissions get
 * bypassed — a `bypassPermissions`/`dangerous` permission mode does it too,
 * and the create path treats both identically.
 */
export function bypassesPermissions(
    skipPermissions: boolean | undefined,
    switches: ClaudeCodeSwitches | undefined,
): boolean {
    const viaMode = switches?.permissionMode === 'bypassPermissions'
        || switches?.permissionMode === 'dangerous';
    return Boolean(skipPermissions) || viaMode;
}
