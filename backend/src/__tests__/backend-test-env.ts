/**
 * Shared scaffolding for the backend tests: a real fake CLI on PATH, a real
 * workspace directory, and a real (temporary) HOME.
 *
 * CRITICAL: base dirs live under homedir(), never os.tmpdir(). On macOS
 * tmpdir() resolves under /var, which validateWorkspacePath blocklists, so
 * workspace-scoped code paths get rejected before the code under test runs.
 */
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, chmodSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import type { TaskEnvironment } from '../backends/types.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export interface FakeCliEnv {
    /** Temp root (under homedir) — also used as HOME for the spawned CLI. */
    base: string;
    /** Directory used as the task cwd. */
    workspace: string;
    /** Directory prepended to PATH, containing the fake CLI. */
    binDir: string;
    /** A directory guaranteed to hold no executables. */
    emptyBinDir: string;
    /** Directory the backend uses for archived task history files. */
    historyDir: string;
    /** Build a TaskEnvironment for one spawn. */
    env(fakeDir: string, extra?: Record<string, string>): TaskEnvironment;
    /** Allocate a fresh, empty log directory for one spawn. */
    fakeDir(label: string): string;
    restore(): void;
}

/**
 * Install `fixtures/fake-agent.sh` on PATH under `binaryName` and point HOME
 * at a scratch dir. Call this BEFORE constructing a backend: the backends read
 * STATE_POLLING_MS in their constructor.
 */
export function setupFakeCli(binaryName: string, pollingMs = '500'): FakeCliEnv {
    // homedir() must be read before HOME is overridden.
    const base = mkdtempSync(join(homedir(), '.claudia-backend-test-'));
    const workspace = join(base, 'ws');
    const binDir = join(base, 'bin');
    const emptyBinDir = join(base, 'empty-bin');
    const historyDir = join(base, 'histories');
    const spawnRoot = join(base, 'spawns');
    for (const d of [workspace, binDir, emptyBinDir, historyDir, spawnRoot]) {
        mkdirSync(d, { recursive: true });
    }
    // A file so the workspace looks like a real project directory.
    writeFileSync(join(workspace, 'README.md'), '# fake workspace\n');

    copyFileSync(join(FIXTURES, 'fake-agent.sh'), join(binDir, binaryName));
    chmodSync(join(binDir, binaryName), 0o755);

    const savedEnv: Record<string, string | undefined> = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        CC_CLAUDE_ARGS: process.env.CC_CLAUDE_ARGS,
        OPENCODE_MODEL: process.env.OPENCODE_MODEL,
        STATE_POLLING_MS: process.env.STATE_POLLING_MS,
        CLAUDIA_FAKE_DIR: process.env.CLAUDIA_FAKE_DIR,
    };

    const pathWithFake = `${binDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`;
    process.env.PATH = pathWithFake;
    process.env.HOME = base;
    process.env.USERPROFILE = base;
    delete process.env.CC_CLAUDE_ARGS;
    delete process.env.OPENCODE_MODEL;
    process.env.STATE_POLLING_MS = pollingMs;

    let n = 0;
    const fakeDir = (label: string): string => {
        const dir = join(spawnRoot, `${String(++n).padStart(2, '0')}-${label}`);
        mkdirSync(dir, { recursive: true });
        return dir;
    };

    const env = (dir: string, extra: Record<string, string> = {}): TaskEnvironment => {
        const out: TaskEnvironment = {};
        for (const [k, v] of Object.entries(process.env)) {
            if (typeof v === 'string') out[k] = v;
        }
        out.PATH = pathWithFake;
        out.HOME = base;
        out.CLAUDIA_FAKE_DIR = dir;
        // Keep the fake's own knobs from leaking between spawns.
        delete out.CLAUDIA_FAKE_SID;
        delete out.CLAUDIA_FAKE_STDOUT_SID;
        delete out.CLAUDIA_FAKE_EXIT_CODE;
        delete out.CLAUDIA_FAKE_AUTH_WARN;
        return { ...out, ...extra };
    };

    const restore = (): void => {
        for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        rmSync(base, { recursive: true, force: true });
    };

    return { base, workspace, binDir, emptyBinDir, historyDir, env, fakeDir, restore };
}

/** Claude Code's on-disk projects dir for a workspace path. */
export function claudeProjectsDir(home: string, workspacePath: string): string {
    return join(home, '.claude', 'projects', workspacePath.replace(/[^a-zA-Z0-9-]/g, '-'));
}
