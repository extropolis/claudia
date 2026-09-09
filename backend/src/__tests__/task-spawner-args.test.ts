import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { buildClaudeCodeSwitchArgs, TaskSpawner } from '../task-spawner.js';
import { CLAUDE_PRIVACY_SETTINGS, PRIVACY_SETTINGS_FILENAME } from '../claude-privacy.js';
import type { ClaudeCodeSwitches } from '../config-store.js';

const BASE: ClaudeCodeSwitches = {
    verbose: false,
    maxTurns: null,
    maxBudgetUsd: null,
    permissionMode: null,
    allowedTools: '',
    disallowedTools: '',
    appendSystemPrompt: '',
    effortLevel: 'high',
    defaultModel: '',
};

describe('buildClaudeCodeSwitchArgs', () => {
    it('returns empty array for all-default switches', () => {
        expect(buildClaudeCodeSwitchArgs(BASE)).toEqual([]);
    });

    describe('--verbose', () => {
        it('adds --verbose when true', () => {
            const args = buildClaudeCodeSwitchArgs({ ...BASE, verbose: true });
            expect(args).toContain('--verbose');
        });

        it('omits --verbose when false', () => {
            const args = buildClaudeCodeSwitchArgs({ ...BASE, verbose: false });
            expect(args).not.toContain('--verbose');
        });
    });

    describe('--max-turns', () => {
        it('adds --max-turns with value when set', () => {
            const args = buildClaudeCodeSwitchArgs({ ...BASE, maxTurns: 10 });
            expect(args).toContain('--max-turns');
            expect(args[args.indexOf('--max-turns') + 1]).toBe('10');
        });

        it('omits --max-turns when null', () => {
            const args = buildClaudeCodeSwitchArgs({ ...BASE, maxTurns: null });
            expect(args).not.toContain('--max-turns');
        });

        it('omits --max-turns when 0', () => {
            const args = buildClaudeCodeSwitchArgs({ ...BASE, maxTurns: 0 });
            expect(args).not.toContain('--max-turns');
        });

        it('omits --max-turns when negative', () => {
            const args = buildClaudeCodeSwitchArgs({ ...BASE, maxTurns: -5 });
            expect(args).not.toContain('--max-turns');
        });
    });

    describe('--max-budget-usd', () => {
        it('adds --max-budget-usd with value when set', () => {
            const args = buildClaudeCodeSwitchArgs({ ...BASE, maxBudgetUsd: 5.50 });
            expect(args).toContain('--max-budget-usd');
            expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('5.5');
        });

        it('omits --max-budget-usd when null', () => {
            const args = buildClaudeCodeSwitchArgs({ ...BASE, maxBudgetUsd: null });
            expect(args).not.toContain('--max-budget-usd');
        });

        it('omits --max-budget-usd when 0', () => {
            const args = buildClaudeCodeSwitchArgs({ ...BASE, maxBudgetUsd: 0 });
            expect(args).not.toContain('--max-budget-usd');
        });
    });

    describe('--permission-mode', () => {
        it('adds --permission-mode for known mode', () => {
            const args = buildClaudeCodeSwitchArgs({ ...BASE, permissionMode: 'auto' });
            expect(args).toContain('--permission-mode');
        });

        it('omits --permission-mode when null', () => {
            const args = buildClaudeCodeSwitchArgs({ ...BASE, permissionMode: null });
            expect(args).not.toContain('--permission-mode');
        });

        it('omits --permission-mode for empty string', () => {
            const args = buildClaudeCodeSwitchArgs({ ...BASE, permissionMode: '' });
            expect(args).not.toContain('--permission-mode');
        });
    });

    describe('--allowedTools', () => {
        it('adds --allowedTools when set', () => {
            const args = buildClaudeCodeSwitchArgs({ ...BASE, allowedTools: 'Bash,Write' });
            expect(args).toContain('--allowedTools');
            expect(args[args.indexOf('--allowedTools') + 1]).toBe('Bash,Write');
        });

        it('omits --allowedTools when empty string', () => {
            const args = buildClaudeCodeSwitchArgs({ ...BASE, allowedTools: '' });
            expect(args).not.toContain('--allowedTools');
        });

        it('omits --allowedTools for whitespace-only string', () => {
            const args = buildClaudeCodeSwitchArgs({ ...BASE, allowedTools: '   ' });
            expect(args).not.toContain('--allowedTools');
        });

        it('trims whitespace from allowedTools value', () => {
            const args = buildClaudeCodeSwitchArgs({ ...BASE, allowedTools: '  Bash  ' });
            const idx = args.indexOf('--allowedTools');
            expect(args[idx + 1]).toBe('Bash');
        });
    });

    describe('--disallowedTools', () => {
        it('adds --disallowedTools when set', () => {
            const args = buildClaudeCodeSwitchArgs({ ...BASE, disallowedTools: 'Write' });
            expect(args).toContain('--disallowedTools');
            expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Write');
        });

        it('omits --disallowedTools when empty', () => {
            const args = buildClaudeCodeSwitchArgs({ ...BASE, disallowedTools: '' });
            expect(args).not.toContain('--disallowedTools');
        });
    });

    describe('--append-system-prompt', () => {
        it('adds --append-system-prompt when set', () => {
            const args = buildClaudeCodeSwitchArgs({ ...BASE, appendSystemPrompt: 'Be concise.' });
            expect(args).toContain('--append-system-prompt');
            expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('Be concise.');
        });

        it('omits --append-system-prompt when empty', () => {
            const args = buildClaudeCodeSwitchArgs({ ...BASE, appendSystemPrompt: '' });
            expect(args).not.toContain('--append-system-prompt');
        });

        it('omits --append-system-prompt for whitespace-only', () => {
            const args = buildClaudeCodeSwitchArgs({ ...BASE, appendSystemPrompt: '   ' });
            expect(args).not.toContain('--append-system-prompt');
        });
    });

    describe('--model (defaultModel)', () => {
        it('adds --model when defaultModel is set', () => {
            const args = buildClaudeCodeSwitchArgs({ ...BASE, defaultModel: 'claude-opus-latest' });
            expect(args).toContain('--model');
            expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-latest');
        });

        it('omits --model when defaultModel is empty string', () => {
            const args = buildClaudeCodeSwitchArgs({ ...BASE, defaultModel: '' });
            expect(args).not.toContain('--model');
        });

        it('omits --model for whitespace-only defaultModel', () => {
            const args = buildClaudeCodeSwitchArgs({ ...BASE, defaultModel: '   ' });
            expect(args).not.toContain('--model');
        });

        it('trims whitespace from defaultModel', () => {
            const args = buildClaudeCodeSwitchArgs({ ...BASE, defaultModel: '  claude-sonnet-4-6  ' });
            const idx = args.indexOf('--model');
            expect(args[idx + 1]).toBe('claude-sonnet-4-6');
        });

        it('passes custom model IDs through unchanged', () => {
            // Custom model IDs like Claude-Opus-4.6[1m] used on Vertex/SAP AI Core
            const customModel = 'Claude-Opus-4.6[1m]';
            const args = buildClaudeCodeSwitchArgs({ ...BASE, defaultModel: customModel });
            expect(args[args.indexOf('--model') + 1]).toBe(customModel);
        });
    });

    describe('argument order and combinations', () => {
        it('produces correct arg pairs for multiple flags', () => {
            const args = buildClaudeCodeSwitchArgs({
                ...BASE,
                verbose: true,
                maxTurns: 5,
                defaultModel: 'claude-sonnet-4-6',
            });

            expect(args).toContain('--verbose');
            expect(args).toContain('--max-turns');
            expect(args).toContain('--model');

            // Values must follow their flags
            expect(args[args.indexOf('--max-turns') + 1]).toBe('5');
            expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-4-6');
        });

        it('does not add any flag for all-null/empty switches', () => {
            const args = buildClaudeCodeSwitchArgs({
                verbose: false,
                maxTurns: null,
                maxBudgetUsd: null,
                permissionMode: null,
                allowedTools: '',
                disallowedTools: '',
                appendSystemPrompt: '',
                effortLevel: 'high',
                defaultModel: '',
            });
            expect(args).toHaveLength(0);
        });
    });
});

/**
 * Wiring guard for the claude.ai privacy pinning.
 *
 * claude-privacy.test.ts covers the arg builder in isolation. What that cannot
 * catch is the spawner forgetting to call it, or calling it with the wrong data
 * directory — so this drives the real TaskSpawner and checks the args it would
 * hand to the CLI.
 */
describe('TaskSpawner privacy args', () => {
    let dir: string;
    let spawner: any;

    beforeEach(() => {
        // Under homedir(), not os.tmpdir(): /tmp resolves under /var on macOS,
        // which validateWorkspacePath blocklists as a system path.
        dir = mkdtempSync(join(homedir(), 'claudia-spawner-privacy-'));
    });

    afterEach(() => {
        try { spawner?.destroy?.(); } catch { /* best effort */ }
        rmSync(dir, { recursive: true, force: true });
    });

    // The constructor calls configStore.getBackend() before anything privacy
    // related runs, so a stub that only carries the privacy getter would blow up
    // there and never reach the code under test.
    const makeSpawner = (configStore?: Record<string, unknown>) =>
        new TaskSpawner(
            join(dir, 'tasks.json'),
            false,
            (configStore && { getBackend: () => 'claude-code', ...configStore }) as never
        );

    it('pins the privacy settings file next to tasks.json by default', () => {
        spawner = makeSpawner();
        const args = spawner.buildPrivacyArgs([]);

        expect(args[0]).toBe('--settings');
        expect(args[1]).toBe(join(dir, PRIVACY_SETTINGS_FILENAME));
        // The file must actually exist — a path to nothing silently disables the CLI flag.
        expect(JSON.parse(readFileSync(args[1], 'utf8'))).toEqual(CLAUDE_PRIVACY_SETTINGS);
    });

    it('defaults to private when no config store is wired in at all', () => {
        spawner = makeSpawner(undefined);
        expect(spawner.buildPrivacyArgs([])).toHaveLength(2);
    });

    it('stays private when the config store says cloud sync is off', () => {
        spawner = makeSpawner({ isClaudeCloudSyncEnabled: () => false });
        expect(spawner.buildPrivacyArgs([])).toHaveLength(2);
    });

    it('steps aside when the user explicitly opted into cloud sync', () => {
        spawner = makeSpawner({ isClaudeCloudSyncEnabled: () => true });
        expect(spawner.buildPrivacyArgs([])).toEqual([]);
    });

    it('does not clobber an operator-supplied --settings', () => {
        spawner = makeSpawner();
        expect(spawner.buildPrivacyArgs(['--settings', '/custom.json'])).toEqual([]);
    });
});
