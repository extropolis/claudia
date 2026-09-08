import { describe, it, expect } from 'vitest';
import { buildSettingsLocalContent } from '../settings-local';

describe('buildSettingsLocalContent', () => {
    it('never emits a wildcard allow rule in skip-permissions mode', () => {
        const c = buildSettingsLocalContent({ skipPermissions: true, serverNames: ['claudia', 'playwright'] });
        const perms = c.permissions as { allow: string[]; deny: string[]; defaultMode?: string };
        expect(perms.allow).toEqual([]);
        expect(perms.deny).toEqual([]);
        expect(perms.defaultMode).toBe('bypassPermissions');
        // No '*' or 'mcp__*' anywhere.
        expect(JSON.stringify(c)).not.toContain('"*"');
        expect(JSON.stringify(c)).not.toContain('mcp__*');
    });

    it('allows each MCP server explicitly (no wildcard) when not skipping permissions', () => {
        const c = buildSettingsLocalContent({ skipPermissions: false, serverNames: ['claudia', 'playwright'] });
        const perms = c.permissions as { allow: string[]; deny: string[]; defaultMode?: string };
        expect(perms.allow).toEqual(['mcp__claudia', 'mcp__playwright']);
        expect(perms.defaultMode).toBeUndefined();
        expect(JSON.stringify(c)).not.toContain('mcp__*');
    });

    it('advertises the server names and always produces valid, serializable JSON', () => {
        const c = buildSettingsLocalContent({ serverNames: ['playwright'] });
        expect(c.enableAllProjectMcpServers).toBe(true);
        expect(c.enabledMcpjsonServers).toEqual(['playwright']);
        // Round-trips cleanly (no duplicate keys / malformed output).
        expect(() => JSON.parse(JSON.stringify(c))).not.toThrow();
    });

    it('heals a corrupted existing file (duplicate keys / invalid JSON) instead of compounding it', () => {
        const corrupt = '{\n  "permissions": {\n    "allow": ["*"],\n    "deny": []\n    "allow": [],\n    "defaultMode": "bypassPermissions"\n  }\n}';
        const c = buildSettingsLocalContent({ skipPermissions: true, serverNames: ['claudia'], existingRaw: corrupt });
        const perms = c.permissions as { allow: string[]; deny: string[]; defaultMode?: string };
        expect(perms.allow).toEqual([]);
        expect(perms.defaultMode).toBe('bypassPermissions');
        // The output is valid JSON with a single permissions block.
        const reparsed = JSON.parse(JSON.stringify(c));
        expect(reparsed.permissions.allow).toEqual([]);
    });

    it('preserves unrelated keys from a valid existing file but replaces the permissions block', () => {
        const existing = JSON.stringify({
            permissions: { allow: ['stale', 'mcp__*'], deny: [] },
            somethingCustom: { keep: true },
        });
        const c = buildSettingsLocalContent({ serverNames: ['claudia'], existingRaw: existing });
        expect(c.somethingCustom).toEqual({ keep: true });
        expect((c.permissions as { allow: string[] }).allow).toEqual(['mcp__claudia']);
        expect(JSON.stringify(c)).not.toContain('mcp__*');
        expect(JSON.stringify(c)).not.toContain('stale');
    });
});
