/**
 * resolveClaudeSpawn(): how the Claude CLI is located per platform.
 *
 * Windows is the whole reason this function exists. `npm i -g` installs
 * `claude.cmd`, which node-pty cannot spawn directly, so the CLI is resolved
 * via APPDATA rather than PATH. The cmd.exe fallback re-parses the command
 * line and corrupts long/multiline args (it silently dropped --model after a
 * multiline prompt), so which branch is taken is a correctness question, not a
 * cosmetic one.
 *
 * Both platform branches are exercised on BOTH CI legs: `process.platform` is
 * stubbed and the module re-imported, so nothing is actually spawned and the
 * whole file stays in a plain `describe`. Real directories back the existsSync
 * probes so the branch order is genuinely exercised.
 *
 * Temp dirs live under homedir(), not os.tmpdir().
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

type Resolved = { command: string; prefixArgs: string[] };

const realPlatform = process.platform;
const savedAppData = process.env['APPDATA'];
const tempDirs: string[] = [];

function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

/**
 * Re-import task-spawner under the given platform. `isWindows` is captured at
 * module scope, so the module cache must be reset for the stub to take effect.
 */
async function resolveUnder(platform: NodeJS.Platform, appData?: string): Promise<Resolved> {
    setPlatform(platform);
    if (appData === undefined) delete process.env['APPDATA'];
    else process.env['APPDATA'] = appData;

    const vitest = await import('vitest');
    vitest.vi.resetModules();
    const mod = await import('../task-spawner.js');
    return mod.resolveClaudeSpawn();
}

/** Build a fake global-npm tree containing the given claude-code entrypoints. */
function makeAppData(entries: { exe?: boolean; cliJs?: boolean }): string {
    const base = mkdtempSync(join(homedir(), '.claudia-resolve-test-'));
    tempDirs.push(base);
    const pkgDir = join(base, 'npm', 'node_modules', '@anthropic-ai', 'claude-code');
    mkdirSync(join(pkgDir, 'bin'), { recursive: true });
    if (entries.exe) writeFileSync(join(pkgDir, 'bin', 'claude.exe'), 'MZ');
    if (entries.cliJs) writeFileSync(join(pkgDir, 'cli.js'), '#!/usr/bin/env node\n');
    return base;
}

afterEach(async () => {
    setPlatform(realPlatform);
    if (savedAppData === undefined) delete process.env['APPDATA'];
    else process.env['APPDATA'] = savedAppData;
    const vitest = await import('vitest');
    vitest.vi.resetModules();
    for (const d of tempDirs.splice(0)) {
        try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
    }
});

describe('resolveClaudeSpawn on POSIX', () => {
    it('spawns plain `claude` from PATH with no prefix args', async () => {
        const r = await resolveUnder('darwin');
        expect(r).toEqual({ command: 'claude', prefixArgs: [] });
    });

    it('ignores APPDATA entirely on POSIX', async () => {
        const appData = makeAppData({ exe: true, cliJs: true });
        const r = await resolveUnder('linux', appData);
        expect(r).toEqual({ command: 'claude', prefixArgs: [] });
    });
});

describe('resolveClaudeSpawn on Windows', () => {
    it('prefers the native bin/claude.exe so multiline args pass through verbatim', async () => {
        const appData = makeAppData({ exe: true, cliJs: true });
        const r = await resolveUnder('win32', appData);

        expect(r.command).toBe(join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
        expect(r.prefixArgs).toEqual([]);
        // Must NOT fall back to the arg-mangling cmd.exe shim.
        expect(r.command).not.toContain('cmd.exe');
    });

    it('falls back to running cli.js under node on the older package layout', async () => {
        const appData = makeAppData({ cliJs: true });
        const r = await resolveUnder('win32', appData);

        expect(r.command).toBe(process.execPath);
        expect(r.prefixArgs).toEqual([
            join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
        ]);
    });

    it('falls back to cmd.exe /c claude.cmd when APPDATA has no claude-code install', async () => {
        const appData = makeAppData({});
        const r = await resolveUnder('win32', appData);

        expect(r).toEqual({ command: 'cmd.exe', prefixArgs: ['/c', 'claude.cmd'] });
    });

    it('falls back to cmd.exe /c claude.cmd when APPDATA is unset', async () => {
        const r = await resolveUnder('win32', undefined);
        expect(r).toEqual({ command: 'cmd.exe', prefixArgs: ['/c', 'claude.cmd'] });
    });

    it('never resolves the CLI from PATH on Windows', async () => {
        const appData = makeAppData({ exe: true });
        const r = await resolveUnder('win32', appData);
        // A bare `claude` would be the PATH lookup that node-pty cannot spawn.
        expect(r.command).not.toBe('claude');
    });
});
