/**
 * Claude Code adapter — the argv builders and `detect()`.
 *
 * The builders are the parity gate for the engine extraction: when
 * `createTaskWithClaudeCode` / the reconnect path start CALLING these instead
 * of assembling argv inline, these expectations are what prove the command
 * line did not change. So they encode the *current* command line verbatim,
 * including the two places create and resume disagree with each other.
 *
 * Nothing here spawns a process or touches a PTY, so it runs identically on
 * the Ubuntu, Windows and macOS CI legs.
 */
import { describe, it, expect, vi } from 'vitest';
import {
    CLAUDE_CODE_CAPABILITIES,
    CLAUDE_CODE_DISPLAY,
    createClaudeCodeAdapter,
} from '../agents/adapters/claude-code.js';
import { buildClaudeCodeSwitchArgs, bypassesPermissions } from '../agents/claude-code-args.js';
import { buildClaudeCodeSwitchArgs as switchArgsFromTaskSpawner } from '../task-spawner.js';
import type { AgentSpawnConfig } from '../agents/types.js';
import type { ClaudeCodeSwitches } from '../config-store.js';

const BASE_SWITCHES: ClaudeCodeSwitches = {
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

const BASE_CONFIG: AgentSpawnConfig = {
    cwd: '/work/repo',
    env: { HOME: '/home/dev' },
};

const adapter = createClaudeCodeAdapter();

describe('claude-code adapter — identity', () => {
    it('badges as "claude" and names itself "Claude Code"', () => {
        expect(adapter.id).toBe('claude-code');
        expect(CLAUDE_CODE_DISPLAY.shortLabel).toBe('claude');
        expect(CLAUDE_CODE_DISPLAY.name).toBe('Claude Code');
    });

    it('has every subsystem enabled — it is the reference implementation', () => {
        expect(CLAUDE_CODE_CAPABILITIES).toEqual({
            ptyStatePolling: true,
            sessionFileCapture: true,
            idleReaper: true,
            memoryGuard: true,
            interactiveApprovals: true,
            resumeRequiresSessionFile: true,
            supportsSystemPromptFlag: true,
            transport: 'pty',
            expectedMemoryMb: 300,
        });
    });
});

describe('claude-code adapter — buildSpawnArgs (create path parity)', () => {
    it('reproduces the minimal create command line', () => {
        const { argv, cwd, env } = adapter.buildSpawnArgs(BASE_CONFIG);
        expect(argv).toEqual(['--allowedTools', 'mcp__*', '--']);
        expect(cwd).toBe('/work/repo');
        expect(env).toEqual({ HOME: '/home/dev' });
    });

    it('places CC_CLAUDE_ARGS first, verbatim', () => {
        const { argv } = adapter.buildSpawnArgs({ ...BASE_CONFIG, extraArgs: ['--debug', 'x'] });
        expect(argv.slice(0, 2)).toEqual(['--debug', 'x']);
    });

    it('widens the tool allowlist to * when permissions are skipped', () => {
        const { argv } = adapter.buildSpawnArgs({ ...BASE_CONFIG, skipPermissions: true });
        expect(argv).toEqual([
            '--dangerously-skip-permissions',
            '--allowedTools', '*',
            '--',
        ]);
    });

    it('treats a bypassPermissions/dangerous permission MODE as skipping too', () => {
        for (const mode of ['bypassPermissions', 'dangerous']) {
            const { argv } = adapter.buildSpawnArgs({
                ...BASE_CONFIG,
                switches: { ...BASE_SWITCHES, permissionMode: mode },
            });
            expect(argv).toContain('--dangerously-skip-permissions');
            expect(argv.slice(argv.indexOf('--allowedTools'))[1]).toBe('*');
        }
    });

    it('a non-bypassing permission mode does NOT widen the allowlist', () => {
        const { argv } = adapter.buildSpawnArgs({
            ...BASE_CONFIG,
            switches: { ...BASE_SWITCHES, permissionMode: 'plan' },
        });
        expect(argv).not.toContain('--dangerously-skip-permissions');
        expect(argv).toEqual([
            '--allowedTools', 'mcp__*',
            '--permission-mode', 'plan',
            '--',
        ]);
    });

    it('orders system prompt, MCP config, allowlist, switches, then the -- terminator', () => {
        const { argv } = adapter.buildSpawnArgs({
            ...BASE_CONFIG,
            skipPermissions: true,
            systemPrompt: '  be careful  ',
            mcpConfigFile: '/tmp/claudia-mcp-task-1.json',
            switches: { ...BASE_SWITCHES, verbose: true, defaultModel: 'opus' },
        });
        expect(argv).toEqual([
            '--dangerously-skip-permissions',
            '--system-prompt', 'be careful',
            '--mcp-config', '/tmp/claudia-mcp-task-1.json',
            '--allowedTools', '*',
            '--verbose',
            '--model', 'opus',
            '--',
        ]);
    });

    it('drops a blank system prompt rather than passing an empty flag value', () => {
        const { argv } = adapter.buildSpawnArgs({ ...BASE_CONFIG, systemPrompt: '   ' });
        expect(argv).not.toContain('--system-prompt');
    });

    it('a per-task model override wins over the configured default model', () => {
        const { argv } = adapter.buildSpawnArgs({
            ...BASE_CONFIG,
            switches: { ...BASE_SWITCHES, defaultModel: 'sonnet' },
            modelOverride: '  haiku  ',
        });
        expect(argv).toContain('--model');
        expect(argv[argv.indexOf('--model') + 1]).toBe('haiku');
        expect(argv).not.toContain('sonnet');
    });

    it('a blank model override leaves the configured default alone', () => {
        const { argv } = adapter.buildSpawnArgs({
            ...BASE_CONFIG,
            switches: { ...BASE_SWITCHES, defaultModel: 'sonnet' },
            modelOverride: '   ',
        });
        expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');
    });

    it('always terminates argument parsing with --', () => {
        const { argv } = adapter.buildSpawnArgs(BASE_CONFIG);
        expect(argv[argv.length - 1]).toBe('--');
    });

    it('is pure — the same config twice yields equal, independent arrays', () => {
        const a = adapter.buildSpawnArgs(BASE_CONFIG);
        const b = adapter.buildSpawnArgs(BASE_CONFIG);
        expect(a.argv).toEqual(b.argv);
        expect(a.argv).not.toBe(b.argv);
    });
});

describe('claude-code adapter — buildResumeArgs (reconnect path parity)', () => {
    it('appends --resume <sessionId> last', () => {
        const { argv } = adapter.buildResumeArgs('sess-123', BASE_CONFIG);
        expect(argv).toEqual(['--allowedTools', 'mcp__*', '--resume', 'sess-123']);
    });

    it('omits --resume entirely for a fresh start', () => {
        const { argv } = adapter.buildResumeArgs(null, BASE_CONFIG);
        expect(argv).toEqual(['--allowedTools', 'mcp__*']);
    });

    it('orders allowlist, switches, MCP config, system prompt, then --resume', () => {
        const { argv } = adapter.buildResumeArgs('sess-9', {
            ...BASE_CONFIG,
            skipPermissions: true,
            systemPrompt: 'stay read-only',
            mcpConfigFile: '/tmp/claudia-mcp-task-9-reconnect.json',
            switches: { ...BASE_SWITCHES, verbose: true },
        });
        expect(argv).toEqual([
            '--dangerously-skip-permissions',
            '--allowedTools', '*',
            '--verbose',
            '--mcp-config', '/tmp/claudia-mcp-task-9-reconnect.json',
            '--system-prompt', 'stay read-only',
            '--resume', 'sess-9',
        ]);
    });

    it('does NOT append the -- terminator that the create path appends', () => {
        // Documented divergence, reproduced deliberately: this slice is the
        // seam, not a behaviour change. Converging the two command lines is
        // engine-extraction work with the reconnect suites as the gate.
        expect(adapter.buildResumeArgs('s', BASE_CONFIG).argv).not.toContain('--');
    });

    it('reads only the global skip toggle, not the permission MODE', () => {
        // The other documented divergence: on the create path a
        // `bypassPermissions` mode implies --dangerously-skip-permissions;
        // on reconnect it never has.
        const { argv } = adapter.buildResumeArgs('s', {
            ...BASE_CONFIG,
            switches: { ...BASE_SWITCHES, permissionMode: 'bypassPermissions' },
        });
        expect(argv).not.toContain('--dangerously-skip-permissions');
        expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('mcp__*');
    });

    it('ignores modelOverride, matching the reconnect path today', () => {
        const { argv } = adapter.buildResumeArgs('s', {
            ...BASE_CONFIG,
            switches: { ...BASE_SWITCHES, defaultModel: 'sonnet' },
            modelOverride: 'haiku',
        });
        expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');
    });
});

describe('claude-code adapter — switch-args parity with task-spawner', () => {
    // task-spawner.ts still exports its own copy of this builder; the engine
    // extraction deletes it. Until then, assert the two agree so they cannot
    // drift the way the state heuristics already did.
    const CASES: ClaudeCodeSwitches[] = [
        BASE_SWITCHES,
        { ...BASE_SWITCHES, verbose: true },
        { ...BASE_SWITCHES, maxTurns: 12, maxBudgetUsd: 3.5 },
        { ...BASE_SWITCHES, maxTurns: 0, maxBudgetUsd: 0 },
        { ...BASE_SWITCHES, permissionMode: 'safe' },
        { ...BASE_SWITCHES, permissionMode: 'auto' },
        { ...BASE_SWITCHES, permissionMode: 'acceptEdits' },
        { ...BASE_SWITCHES, permissionMode: 'somethingNew' },
        { ...BASE_SWITCHES, allowedTools: ' Bash ', disallowedTools: ' Write ' },
        { ...BASE_SWITCHES, appendSystemPrompt: '  extra  ' },
        { ...BASE_SWITCHES, defaultModel: '  opus  ' },
        {
            ...BASE_SWITCHES,
            verbose: true,
            maxTurns: 3,
            maxBudgetUsd: 1,
            permissionMode: 'dangerous',
            allowedTools: 'Bash',
            disallowedTools: 'Write',
            appendSystemPrompt: 'be brief',
            defaultModel: 'sonnet',
        },
    ];

    it.each(CASES.map((c, i) => [i, c] as const))(
        'case %i produces identical argv in both copies',
        (_i, switches) => {
            expect(buildClaudeCodeSwitchArgs(switches))
                .toEqual(switchArgsFromTaskSpawner(switches));
        },
    );
});

describe('bypassesPermissions', () => {
    it('is true for the global toggle regardless of mode', () => {
        expect(bypassesPermissions(true, undefined)).toBe(true);
        expect(bypassesPermissions(true, { ...BASE_SWITCHES, permissionMode: 'plan' })).toBe(true);
    });

    it('is true for a bypassing mode even with the toggle off', () => {
        expect(bypassesPermissions(false, { ...BASE_SWITCHES, permissionMode: 'bypassPermissions' })).toBe(true);
        expect(bypassesPermissions(false, { ...BASE_SWITCHES, permissionMode: 'dangerous' })).toBe(true);
    });

    it('is false otherwise', () => {
        expect(bypassesPermissions(undefined, undefined)).toBe(false);
        expect(bypassesPermissions(false, BASE_SWITCHES)).toBe(false);
    });
});

describe('claude-code adapter — detect()', () => {
    it('reports the trimmed version when the CLI answers', async () => {
        const execSync = vi.fn().mockReturnValue('1.2.3 (Claude Code)\n');
        const a = createClaudeCodeAdapter({ execSync });
        await expect(a.detect()).resolves.toEqual({ installed: true, version: '1.2.3 (Claude Code)' });
        expect(execSync).toHaveBeenCalledWith('claude --version', { encoding: 'utf8', timeout: 5000 });
    });

    it('reports not-installed with an install URL when the probe throws', async () => {
        const a = createClaudeCodeAdapter({
            execSync: () => { throw new Error('ENOENT'); },
        });
        const result = await a.detect();
        expect(result.installed).toBe(false);
        expect(result.error).toContain('https://claude.ai/code');
        expect(result.version).toBeUndefined();
    });
});

describe('claude-code adapter — resolveExecutable()', () => {
    it('returns a spawnable command and its prefix args', () => {
        const target = adapter.resolveExecutable();
        expect(typeof target.command).toBe('string');
        expect(target.command.length).toBeGreaterThan(0);
        expect(Array.isArray(target.prefixArgs)).toBe(true);
    });

    it('resolves to plain "claude" off Windows', () => {
        if (process.platform === 'win32') return;
        expect(adapter.resolveExecutable()).toEqual({ command: 'claude', prefixArgs: [] });
    });
});
