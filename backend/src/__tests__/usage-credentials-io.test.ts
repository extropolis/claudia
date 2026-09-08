/**
 * I/O half of usage-credentials: readOAuthCredentials() against a mocked
 * keychain shell-out (macOS) and a mocked credentials file (everything else).
 * The token must never leak into logs, so the logger is spied on too.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execFileMock = vi.fn();
const readFileMock = vi.fn();

vi.mock('node:child_process', () => ({
    execFile: (...args: unknown[]) => execFileMock(...args),
}));
vi.mock('node:fs/promises', () => ({
    readFile: (...args: unknown[]) => readFileMock(...args),
}));

import { readOAuthCredentials, keychainServiceName } from '../usage-credentials.js';

const NESTED = JSON.stringify({ claudeAiOauth: { accessToken: 'tok-secret-123', subscriptionType: 'max' } });

/** Make the (promisified) execFile mock resolve or reject. */
function keychainReturns(stdout: string | Error) {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb?: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
        // promisify() passes (file, args, callback) when no options are given.
        const done = typeof _opts === 'function' ? (_opts as typeof cb) : cb;
        if (stdout instanceof Error) done!(stdout);
        else done!(null, { stdout, stderr: '' });
    });
}

const originalPlatform = process.platform;
function setPlatform(p: string) {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    execFileMock.mockReset();
    readFileMock.mockReset();
    process.env.DEBUG = '1';
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    setPlatform(originalPlatform);
    delete process.env.DEBUG;
    logSpy.mockRestore();
    warnSpy.mockRestore();
});

function allLogged(): string {
    return [...logSpy.mock.calls, ...warnSpy.mock.calls].flat().map(String).join('\n');
}

describe('readOAuthCredentials on macOS (Keychain)', () => {
    beforeEach(() => setPlatform('darwin'));

    it('reads the "Claude Code-credentials" generic password and parses it', async () => {
        keychainReturns(NESTED + '\n');
        const creds = await readOAuthCredentials();
        expect(creds).toEqual({ accessToken: 'tok-secret-123', subscriptionType: 'max' });

        const [cmd, args] = execFileMock.mock.calls[0];
        expect(cmd).toBe('security');
        expect(args).toEqual(expect.arrayContaining(['find-generic-password', '-s', 'Claude Code-credentials', '-w']));
        expect(readFileMock).not.toHaveBeenCalled();
    });

    it('returns null when the keychain item is missing and no file exists', async () => {
        keychainReturns(new Error('The specified item could not be found in the keychain.'));
        readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        expect(await readOAuthCredentials()).toBeNull();
    });

    it('looks the item up under the OS username', async () => {
        keychainReturns(NESTED);
        await readOAuthCredentials();
        const args = execFileMock.mock.calls[0][1] as string[];
        expect(args[args.indexOf('-a') + 1]).toBe(process.env.USER || require('node:os').userInfo().username);
    });

    it('falls back to the credentials file when the Keychain is unreachable (SSH/tmux)', async () => {
        // `security` fails with no controlling terminal; Claude Code itself
        // falls back to the file here, so reporting "no token" to a signed-in
        // user was wrong.
        keychainReturns(new Error('User interaction is not allowed.'));
        readFileMock.mockResolvedValue(NESTED);
        const creds = await readOAuthCredentials();
        expect(creds?.accessToken).toBe('tok-secret-123');
        expect(allLogged()).not.toContain('tok-secret-123');
    });

    it('returns null when the item exists but holds no claudeAiOauth token', async () => {
        // On Claude Code 2.1.x a signed-out user still has an item holding only
        // `mcpOAuth`. That is a normal state, not a parse failure.
        keychainReturns('{"mcpOAuth":{"something":"else"}}');
        readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        expect(await readOAuthCredentials()).toBeNull();
        expect(allLogged()).toMatch(/holds no claudeAiOauth accessToken/);
    });

    it('never writes the token to the logs', async () => {
        keychainReturns(NESTED);
        await readOAuthCredentials();
        const logged = allLogged();
        expect(logged).toMatch(/macos-keychain/);
        expect(logged).not.toContain('tok-secret-123');
    });
});

describe('readOAuthCredentials elsewhere (~/.claude/.credentials.json)', () => {
    beforeEach(() => setPlatform('linux'));

    it('reads the credentials file from the home directory', async () => {
        readFileMock.mockResolvedValue(NESTED);
        const creds = await readOAuthCredentials();
        expect(creds?.accessToken).toBe('tok-secret-123');
        expect(String(readFileMock.mock.calls[0][0])).toMatch(/\.claude[\\/]\.credentials\.json$/);
        expect(execFileMock).not.toHaveBeenCalled();
    });

    it('returns null when the file is missing', async () => {
        readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        expect(await readOAuthCredentials()).toBeNull();
        expect(allLogged()).toMatch(/No credentials file/);
    });

    it('returns null when the file is not valid JSON', async () => {
        readFileMock.mockResolvedValue('not json');
        expect(await readOAuthCredentials()).toBeNull();
    });
});

describe('CLAUDE_CONFIG_DIR relocates both stores', () => {
    afterEach(() => { delete process.env.CLAUDE_CONFIG_DIR; });

    it('uses the plain service name when CLAUDE_CONFIG_DIR is unset', () => {
        expect(keychainServiceName()).toBe('Claude Code-credentials');
    });

    it('appends the config-dir hash to the Keychain service name', () => {
        // Claude Code suffixes the service with the first 8 hex of
        // sha256(configDir). Hardcoding the plain name reported "no token" for
        // every user with a relocated config dir.
        process.env.CLAUDE_CONFIG_DIR = '/tmp/some-other-claude';
        const name = keychainServiceName();
        expect(name).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
        expect(name).not.toBe('Claude Code-credentials');

        process.env.CLAUDE_CONFIG_DIR = '/tmp/a-different-one';
        expect(keychainServiceName()).not.toBe(name); // derived from the path
    });

    it('reads the credentials file from CLAUDE_CONFIG_DIR, not ~/.claude', async () => {
        setPlatform('linux');
        process.env.CLAUDE_CONFIG_DIR = '/tmp/relocated-claude';
        readFileMock.mockResolvedValue(NESTED);
        await readOAuthCredentials();
        expect(String(readFileMock.mock.calls[0][0])).toBe('/tmp/relocated-claude/.credentials.json');
    });
});
