import { describe, it, expect } from 'vitest';
import type { SlashCommand } from '@claudia/shared';
import { slashQueryAt, filterSlashCommands } from '../ChatView';

const cmd = (name: string, source: SlashCommand['source'] = 'user'): SlashCommand => ({
    name,
    description: `${name} description`,
    source,
});

describe('slashQueryAt', () => {
    it('opens on a slash at the very start of the input', () => {
        expect(slashQueryAt('/', 1)).toBe('');
    });

    it('returns the partial name typed after the slash', () => {
        expect(slashQueryAt('/rev', 4)).toBe('rev');
    });

    it('opens on a slash at the start of a later line', () => {
        const text = 'first line\n/dep';
        expect(slashQueryAt(text, text.length)).toBe('dep');
    });

    it('stays closed for a slash inside prose', () => {
        expect(slashQueryAt('look at src/foo.ts', 18)).toBeNull();
    });

    it('closes once a space starts the arguments', () => {
        expect(slashQueryAt('/review 123', 11)).toBeNull();
    });

    it('ignores text after the caret', () => {
        // Caret sits right after "/re" while "view" trails behind it.
        expect(slashQueryAt('/review', 3)).toBe('re');
    });

    it('returns null with no slash at all', () => {
        expect(slashQueryAt('hello there', 11)).toBeNull();
    });
});

describe('filterSlashCommands', () => {
    const commands = [
        cmd('analyze-logs', 'project'),
        cmd('agents-sdk'),
        cmd('compact', 'builtin'),
        cmd('cloudflare:wrangler', 'plugin'),
        cmd('review', 'builtin'),
    ];

    it('returns everything for an empty query', () => {
        expect(filterSlashCommands(commands, '')).toHaveLength(commands.length);
    });

    it('lists only commands starting with the typed letter', () => {
        const names = filterSlashCommands(commands, 'a').map((c) => c.name);
        expect(names).toEqual(['agents-sdk', 'analyze-logs']);
    });

    it('matches case-insensitively', () => {
        expect(filterSlashCommands(commands, 'REV').map((c) => c.name)).toContain('review');
    });

    it('finds a namespaced command by its un-namespaced tail', () => {
        expect(filterSlashCommands(commands, 'wrangler').map((c) => c.name)).toEqual(['cloudflare:wrangler']);
    });

    it('ranks prefix matches above substring matches', () => {
        const list = [cmd('do-compact'), cmd('compact')];
        expect(filterSlashCommands(list, 'compact').map((c) => c.name)).toEqual(['compact', 'do-compact']);
    });

    it('returns nothing when no command matches', () => {
        expect(filterSlashCommands(commands, 'zzz')).toEqual([]);
    });
});
