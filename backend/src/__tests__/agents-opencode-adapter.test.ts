/**
 * OpenCode adapter — argv builders, `detect()` (CLI probe + server health)
 * and the capability descriptor.
 *
 * The capability expectations are the important part: they pin OpenCode to
 * exactly the subsystems it has TODAY, so this slice lands as a pure refactor
 * of the `=== 'claude-code'` gates rather than quietly switching state
 * polling, the idle reaper and the memory guard on for OpenCode.
 */
import { describe, it, expect, vi } from 'vitest';
import {
    OPENCODE_CAPABILITIES,
    OPENCODE_DISPLAY,
    OPENCODE_FALLBACK_MODEL,
    createOpenCodeAdapter,
} from '../agents/adapters/opencode.js';
import type { AgentSpawnConfig } from '../agents/types.js';

const BASE_CONFIG: AgentSpawnConfig = {
    cwd: '/work/repo',
    env: { HOME: '/home/dev' },
};

/** An adapter with no ambient env, so model resolution is deterministic. */
function makeAdapter(overrides: Parameters<typeof createOpenCodeAdapter>[0] = { getPort: () => 4096 }) {
    return createOpenCodeAdapter({ env: {}, ...overrides });
}

const adapter = makeAdapter();

describe('opencode adapter — identity', () => {
    it('badges as "opencode" and names itself "OpenCode"', () => {
        expect(adapter.id).toBe('opencode');
        expect(OPENCODE_DISPLAY.shortLabel).toBe('opencode');
        expect(OPENCODE_DISPLAY.name).toBe('OpenCode');
        expect(OPENCODE_DISPLAY.installUrl).toBe('https://opencode.ai');
    });

    it('keeps the four PTY subsystems OFF — exactly what the gates did', () => {
        // task-spawner gated state polling, the idle reaper and the memory
        // guard behind `=== 'claude-code'`; session capture too. Changing any
        // of these is issue #62 phase 4, not this slice.
        expect(OPENCODE_CAPABILITIES.ptyStatePolling).toBe(false);
        expect(OPENCODE_CAPABILITIES.idleReaper).toBe(false);
        expect(OPENCODE_CAPABILITIES.memoryGuard).toBe(false);
        expect(OPENCODE_CAPABILITIES.sessionFileCapture).toBe(false);
    });

    it('declares the rest of the descriptor completely', () => {
        expect(OPENCODE_CAPABILITIES).toEqual({
            ptyStatePolling: false,
            sessionFileCapture: false,
            idleReaper: false,
            memoryGuard: false,
            interactiveApprovals: false,
            resumeRequiresSessionFile: false,
            supportsSystemPromptFlag: false,
            transport: 'pty',
            expectedMemoryMb: 200,
        });
    });
});

describe('opencode adapter — buildSpawnArgs', () => {
    it('passes only -m <model>: the TUI takes the prompt by keystroke', () => {
        const { argv, cwd, env } = adapter.buildSpawnArgs({ ...BASE_CONFIG, model: 'anthropic/claude-sonnet-4-5' });
        expect(argv).toEqual(['-m', 'anthropic/claude-sonnet-4-5']);
        expect(cwd).toBe('/work/repo');
        expect(env).toEqual({ HOME: '/home/dev' });
    });

    it('falls back through model → modelOverride → OPENCODE_MODEL → default', () => {
        expect(adapter.buildSpawnArgs(BASE_CONFIG).argv)
            .toEqual(['-m', OPENCODE_FALLBACK_MODEL]);

        expect(adapter.buildSpawnArgs({ ...BASE_CONFIG, modelOverride: 'x/y' }).argv)
            .toEqual(['-m', 'x/y']);

        const withEnv = makeAdapter({ getPort: () => 4096, env: { OPENCODE_MODEL: 'env/model' } });
        expect(withEnv.buildSpawnArgs(BASE_CONFIG).argv).toEqual(['-m', 'env/model']);

        // An explicit model beats the environment.
        expect(withEnv.buildSpawnArgs({ ...BASE_CONFIG, model: 'explicit/model' }).argv)
            .toEqual(['-m', 'explicit/model']);
    });

    it('never emits the prompt on the command line', () => {
        const { argv } = adapter.buildSpawnArgs(BASE_CONFIG);
        expect(argv.join(' ')).not.toContain('prompt');
        expect(argv).toHaveLength(2);
    });
});

describe('opencode adapter — buildResumeArgs', () => {
    it('passes --session <id> and nothing else', () => {
        expect(adapter.buildResumeArgs('sess-42', BASE_CONFIG).argv)
            .toEqual(['--session', 'sess-42']);
    });

    it('passes no arguments at all for a fresh start', () => {
        expect(adapter.buildResumeArgs(null, BASE_CONFIG).argv).toEqual([]);
    });

    it('does NOT re-send -m on resume, matching the reconnect path today', () => {
        const { argv } = adapter.buildResumeArgs('sess-42', { ...BASE_CONFIG, model: 'x/y' });
        expect(argv).not.toContain('-m');
    });
});

describe('opencode adapter — resolveExecutable()', () => {
    it('adds the .exe suffix node-pty needs on Windows', () => {
        const win = makeAdapter({ getPort: () => 4096, platform: 'win32' });
        expect(win.resolveExecutable()).toEqual({ command: 'opencode.exe', prefixArgs: [] });
    });

    it('uses the bare name elsewhere', () => {
        const nix = makeAdapter({ getPort: () => 4096, platform: 'linux' });
        expect(nix.resolveExecutable()).toEqual({ command: 'opencode', prefixArgs: [] });
    });
});

describe('opencode adapter — detect()', () => {
    it('reports version and a running server when both probes succeed', async () => {
        const execSync = vi.fn().mockReturnValue('opencode 0.4.2\n');
        const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
        const a = makeAdapter({ getPort: () => 4242, execSync, fetch: fetchMock as unknown as typeof fetch });

        await expect(a.detect()).resolves.toEqual({
            installed: true,
            version: 'opencode 0.4.2',
            serverRunning: true,
        });
        expect(execSync).toHaveBeenCalledWith('opencode --version', { encoding: 'utf8', timeout: 5000 });
        expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:4242/global/health');
    });

    it('probes the port the provider returns AT CALL TIME, not at construction', async () => {
        let port = 1111;
        const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
        const a = makeAdapter({
            getPort: () => port,
            execSync: () => 'v1',
            fetch: fetchMock as unknown as typeof fetch,
        });

        await a.detect();
        port = 2222;
        await a.detect();

        expect(fetchMock.mock.calls[0][0]).toContain(':1111/');
        expect(fetchMock.mock.calls[1][0]).toContain(':2222/');
    });

    it('stays "installed" when the health probe fails — server-down is not missing', async () => {
        const a = makeAdapter({
            getPort: () => 4096,
            execSync: () => 'opencode 0.4.2',
            fetch: (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch,
        });
        await expect(a.detect()).resolves.toEqual({
            installed: true,
            version: 'opencode 0.4.2',
            serverRunning: false,
        });
    });

    it('treats a non-ok health response as server-down', async () => {
        const a = makeAdapter({
            getPort: () => 4096,
            execSync: () => 'v',
            fetch: (() => Promise.resolve({ ok: false } as Response)) as unknown as typeof fetch,
        });
        expect((await a.detect()).serverRunning).toBe(false);
    });

    it('reports not-installed with an install URL when the CLI is missing', async () => {
        const fetchMock = vi.fn();
        const a = makeAdapter({
            getPort: () => 4096,
            execSync: () => { throw new Error('ENOENT'); },
            fetch: fetchMock as unknown as typeof fetch,
        });
        const result = await a.detect();
        expect(result).toEqual({
            installed: false,
            error: 'OpenCode is not installed. Install from: https://opencode.ai',
        });
        // No point probing a server for a CLI that is not there.
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
