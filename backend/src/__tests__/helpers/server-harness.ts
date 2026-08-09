/**
 * Shared integration-test harness: boots the REAL Express + WS server via
 * createApp(basePath) on an ephemeral port with a fully isolated state dir.
 *
 * Why this exists: server.ts is ~6.6k lines behind 85 HTTP routes, and every
 * suite that wanted to touch them was re-implementing the same fiddly setup
 * (temp base under $HOME, seeded workspace-config.json/tasks.json, fake claude
 * on PATH, listen(0), shutdownForTests, env restore).
 *
 * IMPORTANT — base dirs live under homedir(), NOT os.tmpdir():
 * on macOS os.tmpdir() resolves under /var, which validateWorkspacePath
 * blocklists as a system path. Workspace ops against a /var temp repo get
 * rejected before ever reaching the code under test, so the tests would pass
 * for the wrong reason.
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, copyFileSync, chmodSync } from 'fs';
import { join, dirname, delimiter } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { createApp } from '../../server.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/**
 * The fake CLI fixtures are bash scripts relying on a shebang, so they cannot
 * be executed as `claude` on Windows. CI runs the backend suite on a
 * ubuntu + windows matrix, so any suite that needs the fake CLI must skip on
 * Windows rather than fail there.
 *
 * Guard those suites with `describe.skipIf(!SUPPORTS_FAKE_CLI)` and keep
 * everything that does NOT need a spawned CLI in a plain `describe`, so the
 * Windows leg still exercises it.
 *
 * Exported as a plain boolean on purpose: exporting a pre-bound
 * `describe.skip` makes tsc infer a type naming vitest internals it cannot
 * reference, which fails the BUILD with TS4023 (tsconfig compiles __tests__).
 */
export const SUPPORTS_FAKE_CLI = process.platform !== 'win32';

export interface HarnessWorkspaceSeed {
    id: string;
    name?: string;
    worktreeParentId?: string;
    worktreeBranch?: string;
    [k: string]: unknown;
}

export interface HarnessOptions {
    /** Prefix for the temp base dir (under homedir()). */
    prefix?: string;
    /** Workspace records to seed into workspace-config.json. */
    workspaces?: HarnessWorkspaceSeed[];
    /** Task records to seed into tasks.json. */
    tasks?: Array<Record<string, unknown>>;
    /**
     * Point $HOME at the temp base so anything reading ~/.claudia (notably the
     * image cache dir, captured at createApp time) stays inside the sandbox.
     * Default true.
     */
    isolateHome?: boolean;
    /** Put fixtures/fake-claude.sh on PATH as `claude`. Default false. */
    fakeClaude?: boolean;
    /** Extra env applied before createApp and restored on stop(). */
    env?: Record<string, string | undefined>;
}

export interface Harness {
    /** Isolated state dir passed to createApp. */
    base: string;
    port: number;
    baseUrl: string;
    /** Directory the fake CLI logs argv/stdin into (only when fakeClaude). */
    fakeDir: string;
    server: Awaited<ReturnType<typeof createApp>>;
    /** fetch() against the harness, path-relative. */
    fetch(path: string, init?: RequestInit): Promise<Response>;
    /** fetch + JSON parse, never throws on non-2xx. Body is null if unparseable. */
    req<T = any>(path: string, init?: RequestInit): Promise<{ status: number; body: T }>;
    /** POST/PUT/PATCH/DELETE with a JSON body. */
    send<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }>;
    stop(): Promise<void>;
}

export function seedWorkspaceFile(base: string, workspaces: HarnessWorkspaceSeed[]): void {
    writeFileSync(join(base, 'workspace-config.json'), JSON.stringify({
        schemaVersion: 1,
        data: {
            workspaces: workspaces.map(w => ({
                name: w.name ?? w.id.split('/').pop() ?? 'ws',
                createdAt: new Date().toISOString(),
                ...w,
            })),
        },
    }, null, 2));
}

export function seedTasksFile(base: string, tasks: Array<Record<string, unknown>>): void {
    writeFileSync(join(base, 'tasks.json'), JSON.stringify({ tasks, archivedTasks: [] }, null, 2));
}

/**
 * A disconnected, non-interrupted task record — loaded into the spawner's lazy
 * set on boot and never respawned, so read-only route tests stay hermetic.
 */
export function makeTaskRecord(id: string, workspaceId: string, extra: Record<string, unknown> = {}) {
    return {
        id,
        prompt: `task ${id}`,
        workspaceId,
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        lastState: 'idle',
        wasInterrupted: false,
        shouldContinue: false,
        backendType: 'claude-code',
        ...extra,
    };
}

export const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });

/** Create a real git repo with one commit on `main`. Returns the repo path. */
export function makeGitRepo(dir: string, opts: { file?: string; content?: string } = {}): string {
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test User');
    git(dir, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, opts.file ?? 'README.md'), opts.content ?? '# test repo\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'init');
    return dir;
}

/** Poll `fn` until `pred` holds. Deterministic alternative to sleeping. */
export async function waitFor<T>(
    fn: () => T | Promise<T>,
    pred: (v: T) => boolean,
    ms = 10000,
    step = 100,
): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (pred(v)) return v;
        if (Date.now() > deadline) {
            throw new Error(`waitFor timeout; last=${String(JSON.stringify(v)).slice(0, 300)}`);
        }
        await new Promise(r => setTimeout(r, step));
    }
}

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
    const base = mkdtempSync(join(homedir(), opts.prefix ?? '.claudia-http-test-'));
    const fakeDir = join(base, 'fake');
    mkdirSync(fakeDir, { recursive: true });

    const saved: Record<string, string | undefined> = {};
    const setEnv = (k: string, v: string | undefined) => {
        if (!(k in saved)) saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    };

    if (opts.isolateHome !== false) {
        setEnv('HOME', base);
        setEnv('USERPROFILE', base);
    }

    if (opts.fakeClaude) {
        const bin = join(base, 'bin');
        mkdirSync(bin, { recursive: true });
        const dest = join(bin, 'claude');
        copyFileSync(join(FIXTURES, 'fake-claude.sh'), dest);
        chmodSync(dest, 0o755);
        // `delimiter`, not a hard-coded ':' — Windows uses ';'. (The fixture
        // still cannot run there; see SUPPORTS_FAKE_CLI.)
        setEnv('PATH', `${bin}${delimiter}${process.env.PATH}`);
        setEnv('CLAUDIA_FAKE_DIR', fakeDir);
    }

    for (const [k, v] of Object.entries(opts.env ?? {})) setEnv(k, v);

    seedWorkspaceFile(base, opts.workspaces ?? []);
    seedTasksFile(base, opts.tasks ?? []);

    const parts = await createApp(base);
    await new Promise<void>(resolve => parts.server.listen(0, '127.0.0.1', () => resolve()));
    const port = (parts.server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const doFetch = (path: string, init?: RequestInit) => fetch(`${baseUrl}${path}`, init);

    const req = async <T>(path: string, init?: RequestInit) => {
        const res = await doFetch(path, init);
        const text = await res.text();
        let body: unknown = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = text; }
        return { status: res.status, body: body as T };
    };

    const send = <T>(method: string, path: string, body?: unknown) =>
        req<T>(path, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });

    let stopped = false;
    const stop = async () => {
        if (stopped) return;
        stopped = true;
        try { await parts.shutdownForTests(); } catch { /* best effort */ }
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        rmSync(base, { recursive: true, force: true });
    };

    return { base, port, baseUrl, fakeDir, server: parts, fetch: doFetch, req, send, stop };
}
