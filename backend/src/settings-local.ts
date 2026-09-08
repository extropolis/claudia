/**
 * Builds the contents of a workspace's `.claude/settings.local.json` that
 * Claudia syncs so spawned/resumed Claude Code sessions get the right tool
 * permissions.
 *
 * Two hard rules learned the hard way:
 *  1. NEVER emit a wildcard tool name ('*' or 'mcp__*') in an allow rule —
 *     current Claude Code rejects those as invalid, which surfaces as a
 *     /doctor error. For skip-permissions use `bypassPermissions` mode (grants
 *     everything with no allow rule); otherwise allow each MCP server
 *     explicitly as `mcp__<server>`.
 *  2. Parse-modify-serialize, never blind-append: preserve unrelated keys and
 *     HEAL a previously-corrupted file (e.g. duplicate keys from a bad external
 *     merge) by replacing the permissions block wholesale. Invalid JSON in the
 *     existing file is discarded rather than compounded.
 */

export interface BuildSettingsLocalParams {
    skipPermissions?: boolean;
    /** MCP server names to allow / advertise (e.g. ['playwright', 'claudia']). */
    serverNames: string[];
    /** Raw current file contents, if any. Tolerant of null/invalid JSON. */
    existingRaw?: string | null;
}

/** Returns the object to serialize into settings.local.json. Never throws. */
export function buildSettingsLocalContent(params: BuildSettingsLocalParams): Record<string, unknown> {
    const { skipPermissions, serverNames, existingRaw } = params;

    const permissions = skipPermissions
        ? { allow: [] as string[], deny: [] as string[], defaultMode: 'bypassPermissions' }
        : { allow: serverNames.map((n) => `mcp__${n}`), deny: [] as string[] };

    let existing: Record<string, unknown> = {};
    if (existingRaw) {
        try {
            const parsed = JSON.parse(existingRaw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                existing = parsed as Record<string, unknown>;
            }
        } catch {
            // Corrupt / invalid JSON — start clean rather than compounding it.
            existing = {};
        }
    }

    return {
        ...existing,
        permissions,
        enableAllProjectMcpServers: true,
        enabledMcpjsonServers: serverNames,
    };
}
