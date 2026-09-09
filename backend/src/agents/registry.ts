/**
 * The agent registry — the single source of truth for "which coding agents
 * exist". `BACKEND_INFO`, `/api/backend/status`, the Settings radios and the
 * capability gates in task-spawner all read from here instead of each
 * hand-writing their own copy of the agent list.
 */
import { AGENT_IDS, type AgentCapabilities, type AgentDisplayInfo, type AgentId } from '@claudia/shared';
import type { AgentAdapter } from './types.js';

const registry = new Map<AgentId, AgentAdapter>();

/** Register (or replace) an adapter. Called once per agent from `index.ts`. */
export function registerAgent(adapter: AgentAdapter): void {
    registry.set(adapter.id, adapter);
}

/**
 * Registered ids. Ordered by the AGENT_IDS declaration first — so the
 * Settings list and the status endpoint have a stable, intentional order —
 * then any adapter registered under an id AGENT_IDS does not yet know about
 * (a plugin, or a test fake), in registration order.
 */
export function listAgentIds(): AgentId[] {
    const declared = AGENT_IDS.filter(id => registry.has(id));
    const extra = [...registry.keys()].filter(id => !(AGENT_IDS as readonly string[]).includes(id));
    return [...declared, ...extra];
}

/** Registered adapters, in AGENT_IDS declaration order. */
export function listAgents(): AgentAdapter[] {
    return listAgentIds().map(id => registry.get(id)!);
}

/** True if an adapter is registered for `id`. */
export function hasAgent(id: string): boolean {
    return registry.has(id as AgentId);
}

/**
 * Look up an adapter. Throws — naming the registered ids — rather than
 * returning undefined: a missing agent is a wiring bug, and a silent
 * `undefined` is exactly the failure mode this registry exists to kill.
 */
export function getAgent(id: AgentId): AgentAdapter {
    const adapter = registry.get(id);
    if (!adapter) {
        const known = listAgentIds().join(', ') || '<none registered>';
        throw new Error(`[agents] Unknown agent id "${id}". Registered agents: ${known}`);
    }
    return adapter;
}

/** Capability descriptor for `id`. Replaces the `=== 'claude-code'` gates. */
export function getAgentCapabilities(id: AgentId): AgentCapabilities {
    return getAgent(id).capabilities;
}

/**
 * The agent assumed when nothing else says otherwise: tasks persisted before
 * `backendType` existed, and any id that is no longer registered.
 */
export const DEFAULT_AGENT_ID: AgentId = 'claude-code';

/**
 * Tolerant capability lookup for ids that come from PERSISTED DATA rather than
 * from code — `config.json`'s `backend` field, or a task's stored
 * `backendType`. A hand-edited config or a task written by a newer build must
 * not crash the spawner on boot, so an unknown id degrades to the default
 * agent's capabilities and logs. This deliberately matches `createBackend()`,
 * which has always fallen back to Claude Code for an unrecognised type.
 *
 * Code paths that know the id statically should use `getAgentCapabilities`,
 * which throws.
 */
export function resolveAgentCapabilities(id: string | undefined | null): AgentCapabilities {
    if (id && hasAgent(id)) return getAgent(id as AgentId).capabilities;
    console.warn(
        `[agents] No adapter registered for "${id ?? '<unset>'}"; ` +
        `falling back to ${DEFAULT_AGENT_ID} capabilities. Registered: ${listAgentIds().join(', ')}`
    );
    return getAgent(DEFAULT_AGENT_ID).capabilities;
}

/** Display info for `id` — Settings name, task-row badge, colour. */
export function getAgentDisplay(id: AgentId): AgentDisplayInfo {
    return getAgent(id).display;
}

/** Every registered agent's display info, in registry order. */
export function listAgentDisplays(): AgentDisplayInfo[] {
    return listAgents().map(a => a.display);
}

/** Test-only: empty the registry so a suite can register fakes in isolation. */
export function __resetAgentRegistryForTests(): void {
    registry.clear();
}
