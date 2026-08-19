/**
 * Shared-MCP bearer token persistence.
 *
 * The token used to be minted per boot. Claudia-spawned tasks tolerated that
 * because a restart respawns them with a freshly written --mcp-config, but a
 * Claude session started by hand reads the token out of its workspace's
 * .mcp.json exactly once and keeps it. Every backend restart therefore turned
 * that session's claudia_* calls into a permanent 401 — and with tsx watch
 * reloading on each source edit, "permanent" arrived within minutes.
 *
 * Regression targets:
 *  - the token survives a process restart (a fresh module registry)
 *  - a corrupt/truncated token file is replaced rather than trusted
 *  - an unwritable data dir still yields a working in-memory token
 *  - validation stays constant-time-shaped and rejects the obvious cases
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

let dataDir: string;

/** Import mcp-auth with a clean module registry, i.e. as a fresh process would. */
async function freshModule() {
    vi.resetModules();
    return await import('../mcp-auth.js');
}

beforeEach(() => {
    dataDir = mkdtempSync(join(homedir(), '.claudia-mcp-auth-'));
    vi.stubEnv('CLAUDIA_DATA_DIR', dataDir);
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    rmSync(dataDir, { recursive: true, force: true });
});

describe('shared MCP token', () => {
    it('is stable within a process', async () => {
        const { getSharedMcpToken } = await freshModule();
        expect(getSharedMcpToken()).toBe(getSharedMcpToken());
    });

    it('is 32 bytes of hex', async () => {
        const { getSharedMcpToken } = await freshModule();
        expect(getSharedMcpToken()).toMatch(/^[0-9a-f]{64}$/);
    });

    it('persists it to the data directory', async () => {
        const { getSharedMcpToken, MCP_TOKEN_FILENAME } = await freshModule();
        const token = getSharedMcpToken();

        const file = join(dataDir, MCP_TOKEN_FILENAME);
        expect(existsSync(file)).toBe(true);
        expect(readFileSync(file, 'utf-8').trim()).toBe(token);
    });

    it('survives a restart — this is the whole point', async () => {
        const first = (await freshModule()).getSharedMcpToken();
        const second = (await freshModule()).getSharedMcpToken();

        expect(second).toBe(first);
    });

    it('keeps a hand-started session authorized across a restart', async () => {
        // What a workspace .mcp.json captured before the restart.
        const bakedIntoWorkspaceConfig = (await freshModule()).getSharedMcpToken();

        const { isValidSharedMcpToken } = await freshModule();
        expect(isValidSharedMcpToken(bakedIntoWorkspaceConfig)).toBe(true);
    });

    it('replaces a corrupt token file instead of trusting it', async () => {
        const { MCP_TOKEN_FILENAME } = await freshModule();
        const file = join(dataDir, MCP_TOKEN_FILENAME);
        writeFileSync(file, 'not-a-token');

        const { getSharedMcpToken } = await freshModule();
        const token = getSharedMcpToken();

        expect(token).toMatch(/^[0-9a-f]{64}$/);
        expect(readFileSync(file, 'utf-8').trim()).toBe(token);
    });

    it('still issues a working token when the data dir cannot be written', async () => {
        // Point at a path that cannot hold a file: a nested path under a FILE.
        const blocker = join(dataDir, 'blocker');
        writeFileSync(blocker, 'x');
        vi.stubEnv('CLAUDIA_DATA_DIR', join(blocker, 'nested'));

        const { getSharedMcpToken, isValidSharedMcpToken } = await freshModule();
        const token = getSharedMcpToken();

        expect(token).toMatch(/^[0-9a-f]{64}$/);
        expect(isValidSharedMcpToken(token)).toBe(true);
    });
});

describe('token validation', () => {
    it('accepts the current token and rejects anything else', async () => {
        const { getSharedMcpToken, isValidSharedMcpToken } = await freshModule();
        const token = getSharedMcpToken();

        expect(isValidSharedMcpToken(token)).toBe(true);
        expect(isValidSharedMcpToken(undefined)).toBe(false);
        expect(isValidSharedMcpToken('')).toBe(false);
        expect(isValidSharedMcpToken('a'.repeat(64))).toBe(false);
        // Length mismatch must not throw out of timingSafeEqual.
        expect(isValidSharedMcpToken(token.slice(0, -1))).toBe(false);
        expect(isValidSharedMcpToken(token + 'a')).toBe(false);
    });
});
