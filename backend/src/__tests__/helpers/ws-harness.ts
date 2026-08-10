/**
 * Shared integration harness for driving the REAL server over WebSocket.
 *
 * Boots `createApp(base)` on an EPHEMERAL port with a fully isolated state dir,
 * so tests exercise the true handler code path (validation → store → broadcast)
 * rather than a mock of it.
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 *  1. The temp base dir lives under `homedir()`, NOT `os.tmpdir()`. On macOS
 *     tmpdir resolves under /var, which `validateWorkspacePath` blocklists as a
 *     system path — workspace ops would be rejected before ever reaching the
 *     code under test, and the tests would "pass" while asserting nothing.
 *
 *  2. `WSClient` buffers every frame it has ever received. A one-shot
 *     request/response helper races: many handlers `broadcast()` to all clients
 *     before the caller has attached a listener. Buffering + replay means
 *     `waitForMessage` can match frames that arrived BEFORE it was called, which
 *     is what makes assertions on broadcast fan-out reliable.
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, copyFileSync, chmodSync, existsSync, readFileSync } from 'fs';
import { join, dirname, delimiter } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import WebSocket from 'ws';
import { createApp } from '../../server.js';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export interface WSFrame {
    type: string;
    payload: any;
}

/** Poll `fn` until `pred` holds. Never a fixed sleep — pass a real condition. */
export async function waitFor<T>(
    fn: () => T | Promise<T>,
    pred: (v: T) => boolean,
    ms = 15000,
    step = 100,
): Promise<T> {
    const deadline = Date.now() + ms;
    let last: T;
    for (;;) {
        last = await fn();
        if (pred(last)) return last;
        if (Date.now() > deadline) {
            throw new Error(`waitFor timeout after ${ms}ms; last=${JSON.stringify(last)?.slice(0, 400)}`);
        }
        await new Promise(r => setTimeout(r, step));
    }
}

/**
 * A persistent WebSocket client that records every frame it receives.
 *
 * Recording (rather than one-shot listening) is what lets a test assert on a
 * *sequence* of broadcasts, and removes the send-before-listen race.
 */
export class WSClient {
    readonly frames: WSFrame[] = [];
    private ws!: WebSocket;
    private closed = false;

    private constructor(private readonly port: number) {}

    static async connect(port: number): Promise<WSClient> {
        const c = new WSClient(port);
        c.ws = new WebSocket(`ws://127.0.0.1:${port}`);
        c.ws.on('message', (data: Buffer) => {
            try {
                c.frames.push(JSON.parse(data.toString()));
            } catch {
                /* non-JSON frame: ignore, the server only speaks JSON */
            }
        });
        c.ws.on('close', () => { c.closed = true; });
        await new Promise<void>((res, rej) => {
            c.ws.once('open', () => res());
            c.ws.once('error', rej);
        });
        return c;
    }

    get isClosed(): boolean {
        return this.closed || this.ws.readyState === WebSocket.CLOSED;
    }

    /** Raw send — used to exercise malformed/non-JSON input. */
    sendRaw(data: string | Buffer): void {
        this.ws.send(data);
    }

    send(type: string, payload?: unknown): void {
        this.ws.send(JSON.stringify(payload === undefined ? { type } : { type, payload }));
    }

    /** All recorded frames of a given type. */
    all(type: string): WSFrame[] {
        return this.frames.filter(f => f.type === type);
    }

    /**
     * Wait for a frame matching `type` (and optional predicate), searching
     * frames already received as well as future ones.
     */
    async waitForMessage(type: string, pred: (f: WSFrame) => boolean = () => true, ms = 10000): Promise<WSFrame> {
        const found = await waitFor(
            () => this.frames.find(f => f.type === type && pred(f)),
            v => v !== undefined,
            ms,
        );
        return found!;
    }

    /** Send and wait for the first matching reply. */
    async request(type: string, payload: unknown, expect: string, pred?: (f: WSFrame) => boolean, ms = 10000): Promise<WSFrame> {
        const seen = this.frames.length;
        this.send(type, payload);
        return this.waitForMessage(
            expect,
            f => this.frames.indexOf(f) >= seen && (pred ? pred(f) : true),
            ms,
        );
    }

    /**
     * Send a message expected to produce NO reply, then prove the connection is
     * still alive and serving by round-tripping a known-good request.
     * This is the core assertion for "malformed input must not kill the socket".
     */
    async sendAndProveAlive(type: string, payload: unknown): Promise<void> {
        this.send(type, payload);
        await this.ping();
    }

    /** Round-trip a harmless request to prove the socket still serves traffic. */
    async ping(): Promise<void> {
        await this.request('task:archived:list', {}, 'task:archived:list');
    }

    close(): void {
        this.closed = true;
        try { this.ws.close(); } catch { /* already gone */ }
    }
}

export const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });

/** Create a git repo with an initial commit and deterministic identity. */
export function initRepo(path: string): string {
    mkdirSync(path, { recursive: true });
    git(path, 'init', '-b', 'main');
    git(path, 'config', 'user.email', 'test@example.com');
    git(path, 'config', 'user.name', 'Test');
    writeFileSync(join(path, 'README.md'), '# test\n');
    git(path, 'add', '.');
    git(path, 'commit', '-m', 'init');
    return path;
}

export interface TestTaskSeed {
    id: string;
    workspaceId: string;
    prompt?: string;
    lastState?: string;
    displayName?: string;
    sessionId?: string;
    order?: number;
    gitState?: unknown;
}

export interface TestEnvOptions {
    /** Workspace dirs to create + register. First one is the "primary". */
    workspaces?: string[];
    /** Tasks seeded into tasks.json as disconnected (never respawned). */
    tasks?: TestTaskSeed[];
    /** Put fixtures/fake-claude.sh on PATH as `claude` and point HOME at the temp dir. */
    withFakeClaude?: boolean;
    /** Prefix for the temp dir name (aids debugging leaked dirs). */
    prefix?: string;
}

export interface TestEnv {
    base: string;
    port: number;
    workspaces: string[];
    fakeDir: string;
    /** Read a file written by the fake claude CLI ('' if absent). */
    readFake(name: string): string;
    api(path: string): Promise<any>;
    connect(): Promise<WSClient>;
    /** Boot a SECOND server on the same state dir — proves persistence survives restart. */
    restart(): Promise<{ port: number; shutdown: () => Promise<void> }>;
    cleanup(): Promise<void>;
}

/**
 * The fake CLI is a bash script relying on a shebang, so it cannot run as
 * `claude` on Windows. CI builds the backend on a ubuntu + windows matrix, so
 * suites that spawn a task must SKIP on Windows rather than fail there.
 *
 * Exported as a plain boolean, used as `describe.skipIf(!SUPPORTS_FAKE_CLI)`.
 * Exporting a pre-bound `describe.skip` instead makes tsc infer a type naming
 * vitest internals it cannot reference, failing the BUILD with TS4023 —
 * backend/tsconfig.json compiles __tests__ too.
 */
export const SUPPORTS_FAKE_CLI = process.platform !== 'win32';

export async function createTestEnv(opts: TestEnvOptions = {}): Promise<TestEnv> {
    const base = mkdtempSync(join(homedir(), `.claudia-${opts.prefix || 'ws'}-test-`));
    const fakeDir = join(base, 'fake');
    mkdirSync(fakeDir, { recursive: true });

    const savedEnv: Record<string, string | undefined> = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CLAUDIA_FAKE_DIR: process.env.CLAUDIA_FAKE_DIR,
        CLAUDIA_FAKE_SID: process.env.CLAUDIA_FAKE_SID,
        STATE_POLLING_MS: process.env.STATE_POLLING_MS,
    };

    if (opts.withFakeClaude) {
        const bin = join(base, 'bin');
        mkdirSync(bin, { recursive: true });
        copyFileSync(join(FIXTURES, 'fake-claude.sh'), join(bin, 'claude'));
        chmodSync(join(bin, 'claude'), 0o755);
        // `delimiter`, not ':' — Windows uses ';'.
        process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
        process.env.HOME = base;
        process.env.CLAUDIA_FAKE_DIR = fakeDir;
        process.env.CLAUDIA_FAKE_SID = 'ws00000-1111-2222-3333-444455556666';
        process.env.STATE_POLLING_MS = '400';
    }

    const workspaces = (opts.workspaces || []).map(name => {
        const p = join(base, name);
        mkdirSync(p, { recursive: true });
        return p;
    });

    writeFileSync(join(base, 'workspace-config.json'), JSON.stringify({
        schemaVersion: 1,
        data: {
            workspaces: workspaces.map(p => ({
                id: p,
                name: p.split('/').pop(),
                createdAt: new Date().toISOString(),
            })),
        },
    }, null, 2));

    writeFileSync(join(base, 'tasks.json'), JSON.stringify({
        tasks: (opts.tasks || []).map(t => ({
            prompt: `task ${t.id}`,
            createdAt: new Date().toISOString(),
            lastActivity: new Date().toISOString(),
            lastState: 'idle',
            wasInterrupted: false,
            shouldContinue: false,
            backendType: 'claude-code',
            ...t,
        })),
        archivedTasks: [],
    }, null, 2));

    const parts = await createApp(base);
    await new Promise<void>(res => parts.server.listen(0, '127.0.0.1', () => res()));
    const port = (parts.server.address() as { port: number }).port;

    const extraShutdowns: Array<() => Promise<void>> = [];
    const clients: WSClient[] = [];

    return {
        base,
        port,
        workspaces,
        fakeDir,
        readFake: (name: string) => {
            const p = join(fakeDir, name);
            return existsSync(p) ? readFileSync(p, 'utf8') : '';
        },
        api: (path: string) => fetch(`http://127.0.0.1:${port}${path}`).then(r => r.json()),
        connect: async () => {
            const c = await WSClient.connect(port);
            clients.push(c);
            return c;
        },
        restart: async () => {
            const p2 = await createApp(base);
            await new Promise<void>(res => p2.server.listen(0, '127.0.0.1', () => res()));
            const port2 = (p2.server.address() as { port: number }).port;
            extraShutdowns.push(p2.shutdownForTests);
            return { port: port2, shutdown: p2.shutdownForTests };
        },
        cleanup: async () => {
            for (const c of clients) c.close();
            for (const s of extraShutdowns) {
                try { await s(); } catch { /* already down */ }
            }
            try { await parts.shutdownForTests(); } catch { /* already down */ }
            for (const [k, v] of Object.entries(savedEnv)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
            try {
                // maxRetries/retryDelay + catch: on Windows the just-closed server
                // and git-worktree handles linger a moment and rmdir throws EBUSY,
                // failing the suite in teardown rather than on a real assertion.
                rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            } catch {
                // Ignore cleanup errors
            }
        },
    };
}
