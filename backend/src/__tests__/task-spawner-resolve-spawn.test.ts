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
 * stubbed around a direct call, so nothing is spawned and the whole file stays
 * in a plain `describe`. Real directories back the existsSync probes so the
 * branch order is genuinely exercised.
 *
 * Temp dirs live under homedir(), not os.tmpdir().
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { resolveClaudeSpawn } from '../claude-cli-resolver.js';

type Resolved = { command: string; prefixArgs: string[] };

const realPlatform = process.platform;
const savedAppData = process.env['APPDATA'];
const savedUserProfile = process.env['USERPROFILE'];
const tempDirs: string[] = [];

function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

/**
 * Evaluate the resolver under a faked platform.
 *
 * resolveClaudeSpawn lives in its own module precisely so this is safe: it
 * reads process.platform per call and imports nothing heavier than fs/path.
 * Faking the platform and re-importing task-spawner instead would make
 * node-pty load the prebuilt native binding for the WRONG platform and throw
 * (this failed the Windows CI leg exactly that way).
 */
function resolveUnder(platform: NodeJS.Platform, appData?: string, userProfile?: string): Resolved {
    setPlatform(platform);
    if (appData === undefined) delete process.env['APPDATA'];
    else process.env['APPDATA'] = appData;
    // USERPROFILE must be pinned too, not just APPDATA: the resolver probes
    // %USERPROFILE%\.local\bin\claude.exe before the cmd.exe fallback. Leaving
    // it at the real value makes every "falls back to cmd.exe" assertion pass
    // on a CI runner and fail on any developer machine that has the native
    // installer — the tests would encode the runner's environment, not the
    // contract. Default to an empty temp dir so the probe deterministically misses.
    process.env['USERPROFILE'] = userProfile ?? emptyDir();
    return resolveClaudeSpawn();
}

/** A directory guaranteed to contain no CLI, for probes that must miss. */
function emptyDir(): string {
    const base = mkdtempSync(join(homedir(), '.claudia-resolve-empty-'));
    tempDirs.push(base);
    return base;
}

/** Build a fake native-installer tree: %USERPROFILE%\.local\bin\claude.exe */
function makeNativeInstall(): string {
    const base = mkdtempSync(join(homedir(), '.claudia-resolve-native-'));
    tempDirs.push(base);
    const binDir = join(base, '.local', 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'claude.exe'), 'MZ');
    return base;
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

afterEach(() => {
    setPlatform(realPlatform);
    if (savedAppData === undefined) delete process.env['APPDATA'];
    else process.env['APPDATA'] = savedAppData;
    if (savedUserProfile === undefined) delete process.env['USERPROFILE'];
    else process.env['USERPROFILE'] = savedUserProfile;
    for (const d of tempDirs.splice(0)) {
        try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
    }
});

describe('resolveClaudeSpawn on POSIX', () => {
    it('spawns plain `claude` from PATH with no prefix args', () => {
        const r = resolveUnder('darwin');
        expect(r).toEqual({ command: 'claude', prefixArgs: [] });
    });

    it('ignores APPDATA entirely on POSIX', () => {
        const appData = makeAppData({ exe: true, cliJs: true });
        const r = resolveUnder('linux', appData);
        expect(r).toEqual({ command: 'claude', prefixArgs: [] });
    });
});

describe('resolveClaudeSpawn on Windows', () => {
    it('prefers the native bin/claude.exe so multiline args pass through verbatim', () => {
        const appData = makeAppData({ exe: true, cliJs: true });
        const r = resolveUnder('win32', appData);

        expect(r.command).toBe(join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
        expect(r.prefixArgs).toEqual([]);
        // Must NOT fall back to the arg-mangling cmd.exe shim.
        expect(r.command).not.toContain('cmd.exe');
    });

    it('falls back to running cli.js under node on the older package layout', () => {
        const appData = makeAppData({ cliJs: true });
        const r = resolveUnder('win32', appData);

        expect(r.command).toBe(process.execPath);
        expect(r.prefixArgs).toEqual([
            join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
        ]);
    });

    it('falls back to cmd.exe /c claude.cmd when APPDATA has no claude-code install', () => {
        const appData = makeAppData({});
        const r = resolveUnder('win32', appData);

        expect(r).toEqual({ command: 'cmd.exe', prefixArgs: ['/c', 'claude.cmd'] });
    });

    it('falls back to cmd.exe /c claude.cmd when APPDATA is unset', () => {
        const r = resolveUnder('win32', undefined);
        expect(r).toEqual({ command: 'cmd.exe', prefixArgs: ['/c', 'claude.cmd'] });
    });

    it('never resolves the CLI from PATH on Windows', () => {
        const appData = makeAppData({ exe: true });
        const r = resolveUnder('win32', appData);
        // A bare `claude` would be the PATH lookup that node-pty cannot spawn.
        expect(r.command).not.toBe('claude');
    });
});

/**
 * The native installer puts the binary at %USERPROFILE%\.local\bin\claude.exe
 * and ships NO claude.cmd — npm creates that shim, the native installer does
 * not. Before this probe existed, such an install fell through to
 * `cmd.exe /c claude.cmd`, which fails with "'claude.cmd' is not recognized"
 * because the shim exists nowhere on the system.
 */
describe('resolveClaudeSpawn with a native-installer layout', () => {
    it('resolves %USERPROFILE%\\.local\\bin\\claude.exe when APPDATA has no install', () => {
        const userProfile = makeNativeInstall();
        const r = resolveUnder('win32', makeAppData({}), userProfile);

        expect(r.command).toBe(join(userProfile, '.local', 'bin', 'claude.exe'));
        expect(r.prefixArgs).toEqual([]);
    });

    it('resolves the native exe when APPDATA is unset entirely', () => {
        const userProfile = makeNativeInstall();
        const r = resolveUnder('win32', undefined, userProfile);

        expect(r.command).toBe(join(userProfile, '.local', 'bin', 'claude.exe'));
    });

    it('never falls through to the missing claude.cmd shim when a native install exists', () => {
        const r = resolveUnder('win32', undefined, makeNativeInstall());
        expect(r.command).not.toContain('cmd.exe');
        expect(r.prefixArgs).not.toContain('claude.cmd');
    });

    it('still prefers an APPDATA install over the native one', () => {
        // APPDATA is probed first, so an npm-global install keeps its existing
        // behavior even on a machine that also has the native installer.
        const appData = makeAppData({ exe: true });
        const r = resolveUnder('win32', appData, makeNativeInstall());

        expect(r.command).toBe(join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
    });

    it('is ignored on POSIX, where the CLI comes from PATH', () => {
        const r = resolveUnder('darwin', undefined, makeNativeInstall());
        expect(r).toEqual({ command: 'claude', prefixArgs: [] });
    });
});
