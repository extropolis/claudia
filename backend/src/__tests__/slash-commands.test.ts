import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listSlashCommands, clearSlashCommandCache } from '../slash-commands.js';

/**
 * Discovery is filesystem-driven, so these build a throwaway workspace on disk. Only
 * project-scoped sources are asserted on: user/plugin/builtin results depend on the
 * developer's real ~/.claude, which we can't control from a test.
 */
describe('listSlashCommands', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudia-slash-'));
        clearSlashCommandCache();
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        clearSlashCommandCache();
    });

    function writeCommand(rel: string, contents: string) {
        const full = path.join(dir, '.claude', 'commands', rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, contents);
    }

    function writeSkill(name: string, contents: string) {
        const full = path.join(dir, '.claude', 'skills', name, 'SKILL.md');
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, contents);
    }

    it('reads name and description from command frontmatter', () => {
        writeCommand('deploy.md', '---\ndescription: Ship it to prod\nargument-hint: "[env]"\n---\n\n# Deploy\n');

        const found = listSlashCommands(dir).find((c) => c.name === 'deploy');
        expect(found).toBeDefined();
        expect(found!.description).toBe('Ship it to prod');
        expect(found!.argumentHint).toBe('[env]');
        expect(found!.source).toBe('project');
    });

    it('namespaces nested command directories with a colon', () => {
        writeCommand('git/review.md', '---\ndescription: Review a diff\n---\n');

        const names = listSlashCommands(dir).map((c) => c.name);
        expect(names).toContain('git:review');
        expect(names).not.toContain('review-nested');
    });

    it('discovers project skills as commands', () => {
        writeSkill('lint-all', '---\nname: lint-all\ndescription: Lint the whole repo\n---\n');

        const found = listSlashCommands(dir).find((c) => c.name === 'lint-all');
        expect(found).toBeDefined();
        expect(found!.description).toBe('Lint the whole repo');
        expect(found!.source).toBe('project');
    });

    it('falls back to the first prose line when frontmatter has no description', () => {
        writeCommand('nodesc.md', '---\nname: nodesc\n---\n\n# Heading\n\nDoes a useful thing.\n');

        const found = listSlashCommands(dir).find((c) => c.name === 'nodesc');
        expect(found!.description).toBe('Does a useful thing.');
    });

    it('handles a command file with no frontmatter at all', () => {
        writeCommand('bare.md', 'Just a plain instruction file.\n');

        const found = listSlashCommands(dir).find((c) => c.name === 'bare');
        expect(found).toBeDefined();
        expect(found!.description).toBe('Just a plain instruction file.');
    });

    it('lets a project command shadow a builtin of the same name', () => {
        writeCommand('review.md', '---\ndescription: Our own review flow\n---\n');

        const matches = listSlashCommands(dir).filter((c) => c.name === 'review');
        expect(matches).toHaveLength(1);
        expect(matches[0].source).toBe('project');
        expect(matches[0].description).toBe('Our own review flow');
    });

    it('includes builtins and returns a sorted, unique list', () => {
        const commands = listSlashCommands(dir);

        expect(commands.some((c) => c.name === 'compact' && c.source === 'builtin')).toBe(true);

        const names = commands.map((c) => c.name);
        expect(new Set(names).size).toBe(names.length);
        expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    });

    it('ignores non-markdown files', () => {
        writeCommand('notes.txt', 'not a command');

        expect(listSlashCommands(dir).some((c) => c.name === 'notes')).toBe(false);
    });

    it('does not throw when the workspace has no .claude directory', () => {
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'claudia-empty-'));
        try {
            expect(() => listSlashCommands(empty)).not.toThrow();
            expect(listSlashCommands(empty).length).toBeGreaterThan(0); // builtins still present
        } finally {
            fs.rmSync(empty, { recursive: true, force: true });
        }
    });
});
