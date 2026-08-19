/**
 * TunnelManager — state-machine and argv tests.
 *
 * No ngrok process is ever launched and no HTTP request is ever made: spawn,
 * execSync and fetch are injected through the constructor seam, so these tests
 * assert the argv ngrok *would* be given, the adopt/spawn/retry/stop
 * transitions, and cleanup on failure.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { TunnelManager, parseNgrokAddrPort, type TunnelManagerDeps } from '../tunnel-manager.js';

const PORT = 45231; // never 4001/5173 — nothing binds anyway, this is argv only

/** Minimal ChildProcess stand-in with the surface TunnelManager touches. */
class FakeChild extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    pid = 4242;
    killed = false;
    signals: Array<string | undefined> = [];
    kill(signal?: string) { this.signals.push(signal); this.killed = true; return true; }
}

type TunnelStep = string | null | Error;

function makeDeps(cfg: {
    ip?: string;          // omit → the ipify lookup fails (offline)
    tunnels?: TunnelStep[]; // per-call script for 127.0.0.1:4040; last entry repeats
    whichFails?: boolean; // simulate "ngrok not installed"
} = {}) {
    const children: FakeChild[] = [];
    const spawnCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
    const execCalls: string[] = [];
    const fetchCalls: string[] = [];
    let tunnelIdx = 0;

    const deps: Partial<TunnelManagerDeps> = {
        spawn: ((cmd: string, args: string[], opts: Record<string, unknown>) => {
            spawnCalls.push({ cmd, args, opts });
            const c = new FakeChild();
            children.push(c);
            return c;
        }) as unknown as TunnelManagerDeps['spawn'],

        execSync: ((cmd: string) => {
            execCalls.push(cmd);
            if (cfg.whichFails && /^(which|where) ngrok$/.test(cmd)) {
                throw new Error('not found');
            }
            return Buffer.from('');
        }) as unknown as TunnelManagerDeps['execSync'],

        fetch: async (url: string) => {
            fetchCalls.push(url);
            if (url.includes('ipify')) {
                if (cfg.ip === undefined) throw new Error('offline');
                return { json: async () => ({ ip: cfg.ip }) };
            }
            const seq = cfg.tunnels ?? [null];
            const step = seq[Math.min(tunnelIdx, seq.length - 1)];
            tunnelIdx++;
            if (step instanceof Error) throw step;
            return { json: async () => ({ tunnels: step ? [{ public_url: step, proto: 'https' }] : [] }) };
        },
    };

    return { deps, children, spawnCalls, execCalls, fetchCalls };
}

type Internals = { retryCount: number; adoptedMonitor: NodeJS.Timeout | null; stopping: boolean };
const priv = (t: TunnelManager) => t as unknown as Internals;

const events = (tm: TunnelManager) => {
    const log: Array<[string, unknown]> = [];
    for (const e of ['tunnel:ready', 'tunnel:closed', 'tunnel:error']) tm.on(e, (p: unknown) => log.push([e, p]));
    return log;
};

afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------
describe('initial state', () => {
    it('is inactive with no url or token', () => {
        const { deps } = makeDeps();
        expect(new TunnelManager(PORT, undefined, deps).getStatus()).toEqual({
            active: false, url: null, token: null, startedAt: null, error: null, publicIp: null,
        });
    });

    it('rejects any token before the tunnel starts', () => {
        const { deps } = makeDeps();
        const tm = new TunnelManager(PORT, undefined, deps);
        expect(tm.validateToken('anything')).toBe(false);
        expect(tm.validateToken('')).toBe(false);
    });

    it('treats an empty domain string as "no domain"', async () => {
        const { deps, spawnCalls } = makeDeps({ tunnels: [null, 'https://x.ngrok.app'] });
        await new TunnelManager(PORT, '', deps).start();
        expect(spawnCalls[0].args).toEqual(['http', String(PORT)]);
    });
});

// ---------------------------------------------------------------------------
describe('argv construction', () => {
    it('spawns `ngrok http <port>` when no domain is configured', async () => {
        const { deps, spawnCalls } = makeDeps({ tunnels: [null, 'https://a.ngrok.app'] });
        await new TunnelManager(PORT, undefined, deps).start();
        expect(spawnCalls).toHaveLength(1);
        expect(spawnCalls[0].cmd).toBe('ngrok');
        expect(spawnCalls[0].args).toEqual(['http', String(PORT)]);
    });

    it('inserts --domain when one is configured', async () => {
        const { deps, spawnCalls } = makeDeps({ tunnels: [null, 'https://custom.ngrok.app'] });
        await new TunnelManager(PORT, 'custom.ngrok.app', deps).start();
        expect(spawnCalls[0].args).toEqual(['http', '--domain', 'custom.ngrok.app', String(PORT)]);
    });

    it('setPort changes the port used for the next spawn', async () => {
        const { deps, spawnCalls } = makeDeps({ tunnels: [null, 'https://a.ngrok.app'] });
        const tm = new TunnelManager(PORT, undefined, deps);
        tm.setPort(45999);
        await tm.start();
        expect(spawnCalls[0].args).toEqual(['http', '45999']);
    });

    it('pipes all three stdio streams', async () => {
        const { deps, spawnCalls } = makeDeps({ tunnels: [null, 'https://a.ngrok.app'] });
        await new TunnelManager(PORT, undefined, deps).start();
        expect(spawnCalls[0].opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
        expect(spawnCalls[0].opts.shell).toBe(process.platform === 'win32');
    });

    it('probes for the binary and clears stale processes before spawning', async () => {
        const { deps, execCalls } = makeDeps({ tunnels: [null, 'https://a.ngrok.app'] });
        await new TunnelManager(PORT, undefined, deps).start();
        expect(execCalls[0]).toBe(process.platform === 'win32' ? 'where ngrok' : 'which ngrok');
        expect(execCalls[1]).toContain(process.platform === 'win32' ? 'taskkill' : 'pkill');
    });

    it('queries the ngrok local API rather than scraping stdout', async () => {
        const { deps, fetchCalls } = makeDeps({ ip: '1.2.3.4', tunnels: [null, 'https://a.ngrok.app'] });
        await new TunnelManager(PORT, undefined, deps).start();
        expect(fetchCalls[0]).toBe('https://api.ipify.org?format=json');
        expect(fetchCalls.slice(1).every(u => u === 'http://127.0.0.1:4040/api/tunnels')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
describe('successful start', () => {
    it('publishes the url and a token, and emits tunnel:ready', async () => {
        const { deps } = makeDeps({ ip: '9.9.9.9', tunnels: [null, 'https://fresh.ngrok.app'] });
        const tm = new TunnelManager(PORT, undefined, deps);
        const log = events(tm);
        const status = await tm.start();

        expect(status.active).toBe(true);
        expect(status.url).toBe('https://fresh.ngrok.app');
        expect(status.token).toMatch(/^[0-9a-f-]{36}$/);
        expect(status.publicIp).toBe('9.9.9.9');
        expect(Date.parse(status.startedAt!)).not.toBeNaN();
        expect(log).toEqual([['tunnel:ready', { url: 'https://fresh.ngrok.app', token: status.token }]]);
    });

    it('still starts when the public-IP lookup fails', async () => {
        const { deps } = makeDeps({ tunnels: [null, 'https://fresh.ngrok.app'] });
        const status = await new TunnelManager(PORT, undefined, deps).start();
        expect(status.active).toBe(true);
        expect(status.publicIp).toBeNull();
    });

    it('accepts the token it issued and rejects others', async () => {
        const { deps } = makeDeps({ tunnels: [null, 'https://fresh.ngrok.app'] });
        const tm = new TunnelManager(PORT, undefined, deps);
        const { token } = await tm.start();
        expect(tm.validateToken(token!)).toBe(true);
        expect(tm.validateToken('not-the-token')).toBe(false);
    });

    it('ignores non-https tunnels reported by the API', async () => {
        const { deps } = makeDeps();
        // http-only tunnel list → treated as "no url yet"
        deps.fetch = async (url: string) => {
            if (url.includes('ipify')) throw new Error('offline');
            return { json: async () => ({ tunnels: [{ public_url: 'http://a.ngrok.app', proto: 'http' }] }) };
        };
        const tm = new TunnelManager(PORT, undefined, deps);
        // pollNgrokApi would spin for 15 s; assert the one-shot adopt check instead
        const check = (tm as unknown as { checkNgrokRunning(): Promise<string | null> }).checkNgrokRunning();
        expect(await check).toBeNull();
    });

    it('tolerates an API response with no tunnels field', async () => {
        const { deps } = makeDeps();
        deps.fetch = async () => ({ json: async () => ({}) });
        const tm = new TunnelManager(PORT, undefined, deps);
        const check = (tm as unknown as { checkNgrokRunning(): Promise<string | null> }).checkNgrokRunning();
        expect(await check).toBeNull();
    });
});

// ---------------------------------------------------------------------------
describe('adoption of an orphaned ngrok', () => {
    it('reuses the existing url instead of spawning', async () => {
        const { deps, spawnCalls, execCalls } = makeDeps({ tunnels: ['https://orphan.ngrok.app'] });
        const tm = new TunnelManager(PORT, undefined, deps);
        const log = events(tm);
        const status = await tm.start();

        expect(status.url).toBe('https://orphan.ngrok.app');
        expect(status.active).toBe(true);
        expect(spawnCalls).toHaveLength(0);
        expect(execCalls).toHaveLength(0); // no pkill — that would kill the tunnel we adopted
        expect(log[0][0]).toBe('tunnel:ready');
        await tm.stop();
    });

    it('validates tokens while in adopted mode', async () => {
        const { deps } = makeDeps({ tunnels: ['https://orphan.ngrok.app'] });
        const tm = new TunnelManager(PORT, undefined, deps);
        const { token } = await tm.start();
        expect(tm.validateToken(token!)).toBe(true);
        await tm.stop();
    });

    it('start() is idempotent — a second call neither spawns nor re-adopts', async () => {
        const { deps, spawnCalls } = makeDeps({ tunnels: ['https://orphan.ngrok.app'] });
        const tm = new TunnelManager(PORT, undefined, deps);
        const first = await tm.start();
        const second = await tm.start();
        expect(second).toEqual(first);
        expect(spawnCalls).toHaveLength(0);
        await tm.stop();
    });

    it('start() is idempotent after a real spawn too', async () => {
        const { deps, spawnCalls } = makeDeps({ tunnels: [null, 'https://fresh.ngrok.app'] });
        const tm = new TunnelManager(PORT, undefined, deps);
        await tm.start();
        await tm.start();
        expect(spawnCalls).toHaveLength(1);
    });

    it('autoRecover adopts a live orphan on startup', async () => {
        const { deps, spawnCalls } = makeDeps({ tunnels: ['https://orphan.ngrok.app'] });
        const tm = new TunnelManager(PORT, undefined, deps);
        const log = events(tm);
        await tm.autoRecover();
        expect(tm.getStatus().url).toBe('https://orphan.ngrok.app');
        expect(tm.getStatus().token).toMatch(/^[0-9a-f-]{36}$/);
        expect(spawnCalls).toHaveLength(0);
        expect(log[0][0]).toBe('tunnel:ready');
        await tm.stop();
    });

    it('autoRecover is a no-op when nothing is listening', async () => {
        const { deps } = makeDeps({ tunnels: [null] });
        const tm = new TunnelManager(PORT, undefined, deps);
        const log = events(tm);
        await tm.autoRecover();
        expect(tm.getStatus().active).toBe(false);
        expect(log).toEqual([]);
    });

    it('autoRecover is a no-op when a tunnel is already tracked', async () => {
        const { deps } = makeDeps({ tunnels: ['https://orphan.ngrok.app'] });
        const tm = new TunnelManager(PORT, undefined, deps);
        await tm.start();
        const before = tm.getStatus();
        await tm.autoRecover();
        expect(tm.getStatus()).toEqual(before);
        await tm.stop();
    });

    it('marks the tunnel closed once the adopted process disappears', async () => {
        vi.useFakeTimers();
        const { deps } = makeDeps({ tunnels: ['https://orphan.ngrok.app', 'https://orphan.ngrok.app', null] });
        const tm = new TunnelManager(PORT, undefined, deps);
        const log = events(tm);
        await tm.start();

        await vi.advanceTimersByTimeAsync(5000);   // still alive
        expect(tm.getStatus().active).toBe(true);

        await vi.advanceTimersByTimeAsync(5000);   // gone
        expect(log.map(e => e[0])).toEqual(['tunnel:ready', 'tunnel:closed']);
        expect(tm.getStatus()).toMatchObject({ active: false, url: null, token: null });
        expect(priv(tm).adoptedMonitor).toBeNull();

        await vi.advanceTimersByTimeAsync(20000);  // interval must not keep firing
        expect(log.filter(e => e[0] === 'tunnel:closed')).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
describe('failure to start', () => {
    it('reports a helpful message when ngrok is not on PATH', async () => {
        const { deps, spawnCalls } = makeDeps({ whichFails: true, tunnels: [null] });
        const tm = new TunnelManager(PORT, undefined, deps);
        const log = events(tm);
        const status = await tm.start();

        expect(status.active).toBe(false);
        expect(status.url).toBeNull();
        expect(status.error).toContain('ngrok is not installed');
        expect(spawnCalls).toHaveLength(0);
        expect(log).toEqual([['tunnel:error', status.error]]);
    });

    it('leaves no token behind after a failed start', async () => {
        const { deps } = makeDeps({ whichFails: true, tunnels: [null] });
        const tm = new TunnelManager(PORT, undefined, deps);
        await tm.start();
        expect(tm.getStatus().token).toBeNull();
        expect(tm.validateToken('anything')).toBe(false);
    });

    it('surfaces ngrok output when the process exits during startup', async () => {
        const { deps, children } = makeDeps({ tunnels: [null] });
        const tm = new TunnelManager(PORT, undefined, deps);
        const log = events(tm);
        const started = tm.start();

        // let start() reach the spawn, then fail the way a session conflict does
        await vi.waitFor(() => expect(children).toHaveLength(1), { timeout: 5000 });
        children[0].stderr.emit('data', Buffer.from('ERR_NGROK_108: limited to 1 session'));
        children[0].stdout.emit('data', Buffer.from('  '));       // whitespace-only is dropped
        children[0].emit('close', 1);

        const status = await started;
        expect(status.error).toBe('ngrok failed to start: ERR_NGROK_108: limited to 1 session');
        expect(status.active).toBe(false);
        expect(children[0].killed).toBe(true);
        expect(log).toEqual([['tunnel:error', status.error]]);
    });

    it('falls back to the exit code when ngrok printed nothing', async () => {
        const { deps, children } = makeDeps({ tunnels: [null] });
        const tm = new TunnelManager(PORT, undefined, deps);
        const started = tm.start();
        await vi.waitFor(() => expect(children).toHaveLength(1), { timeout: 5000 });
        children[0].emit('close', 7);
        expect((await started).error).toBe('ngrok failed to start: exit code 7');
    });

    it('joins multiple output lines with a pipe separator', async () => {
        const { deps, children } = makeDeps({ tunnels: [null] });
        const tm = new TunnelManager(PORT, undefined, deps);
        const started = tm.start();
        await vi.waitFor(() => expect(children).toHaveLength(1), { timeout: 5000 });
        children[0].stderr.emit('data', Buffer.from('line one'));
        children[0].stdout.emit('data', Buffer.from('line two'));
        children[0].emit('close', 1);
        expect((await started).error).toBe('ngrok failed to start: line one | line two');
    });

    it('re-emits a process-level spawn error', async () => {
        const { deps, children } = makeDeps({ tunnels: [null] });
        const tm = new TunnelManager(PORT, undefined, deps);
        const log = events(tm);
        const started = tm.start();
        await vi.waitFor(() => expect(children).toHaveLength(1), { timeout: 5000 });
        children[0].emit('error', new Error('EACCES'));
        children[0].emit('close', 1);
        await started;
        expect(log.map(e => e[1])).toContain('EACCES');
    });

    it('times out when the local API never reports a tunnel', async () => {
        vi.useFakeTimers();
        const { deps, children } = makeDeps({ tunnels: [null] }); // always empty
        const tm = new TunnelManager(PORT, undefined, deps);
        const started = tm.start();
        await vi.advanceTimersByTimeAsync(600);    // settle sleep, then polling begins
        await vi.advanceTimersByTimeAsync(16000);  // exceed the 15 s poll budget
        const status = await started;
        expect(status.error).toBe('ngrok startup timeout: no response from ngrok local API');
        expect(status.active).toBe(false);
        expect(children[0].killed).toBe(true);
    });

    it('reports API errors from the poll loop as a timeout with ngrok output', async () => {
        vi.useFakeTimers();
        const { deps, children } = makeDeps({ tunnels: [null, new Error('ECONNREFUSED')] });
        const tm = new TunnelManager(PORT, undefined, deps);
        const started = tm.start();
        await vi.advanceTimersByTimeAsync(600);
        children[0].stderr.emit('data', Buffer.from('authtoken missing'));
        await vi.advanceTimersByTimeAsync(16000);
        expect((await started).error).toBe('ngrok startup timeout: authtoken missing');
    });

    it('can start successfully after a failed attempt', async () => {
        const { deps, children, spawnCalls } = makeDeps({ tunnels: [null, null, null, 'https://second.ngrok.app'] });
        const tm = new TunnelManager(PORT, undefined, deps);
        const first = tm.start();
        await vi.waitFor(() => expect(children).toHaveLength(1), { timeout: 5000 });
        children[0].emit('close', 1);
        expect((await first).active).toBe(false);

        const second = await tm.start();
        expect(second.active).toBe(true);
        expect(second.url).toBe('https://second.ngrok.app');
        expect(spawnCalls).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
describe('disconnect and retry', () => {
    async function startWithFakeTimers(tunnels: TunnelStep[]) {
        vi.useFakeTimers();
        const ctx = makeDeps({ tunnels });
        const tm = new TunnelManager(PORT, undefined, ctx.deps);
        const log = events(tm);
        const started = tm.start();
        await vi.advanceTimersByTimeAsync(600); // the post-pkill settle sleep
        await started;
        return { tm, log, ...ctx };
    }

    it('schedules a reconnect with backoff when ngrok drops', async () => {
        const { tm, log, children, spawnCalls } = await startWithFakeTimers([
            null, 'https://one.ngrok.app', 'https://two.ngrok.app',
        ]);
        expect(tm.getStatus().url).toBe('https://one.ngrok.app');

        children[0].emit('close', 0);
        expect(log.map(e => e[0])).toEqual(['tunnel:ready', 'tunnel:closed']);
        expect(priv(tm).retryCount).toBe(1);
        expect(tm.getStatus().active).toBe(false);

        await vi.advanceTimersByTimeAsync(2000); // first backoff = 2000 * 1
        await vi.advanceTimersByTimeAsync(600);  // settle sleep inside the retry
        expect(spawnCalls).toHaveLength(2);
        expect(tm.getStatus().url).toBe('https://two.ngrok.app');
        expect(priv(tm).retryCount).toBe(0);     // reset after a good reconnect
        expect(log.filter(e => e[0] === 'tunnel:ready')).toHaveLength(3); // startNgrok + reconnect both announce
    });

    it('gives up and cleans up once maxRetries is exhausted', async () => {
        const { tm, log, children } = await startWithFakeTimers([null, 'https://one.ngrok.app']);
        priv(tm).retryCount = 3;
        children[0].emit('close', 0);
        expect(log.map(e => e[0])).toEqual(['tunnel:ready', 'tunnel:closed']);
        expect(tm.getStatus()).toMatchObject({ active: false, url: null, token: null });
        await vi.advanceTimersByTimeAsync(10000);
        expect(log.filter(e => e[0] === 'tunnel:ready')).toHaveLength(1);
    });

    it('escalates the backoff when a reconnect attempt itself fails, then gives up', async () => {
        vi.useFakeTimers();
        const ctx = makeDeps({ tunnels: [null, 'https://one.ngrok.app'] });
        // every reconnect finds no ngrok binary
        let calls = 0;
        const realExec = ctx.deps.execSync!;
        ctx.deps.execSync = ((cmd: string) => {
            if (/^(which|where) ngrok$/.test(cmd) && ++calls > 1) throw new Error('gone');
            return (realExec as (c: string) => Buffer)(cmd);
        }) as unknown as TunnelManagerDeps['execSync'];

        const tm = new TunnelManager(PORT, undefined, ctx.deps);
        const log = events(tm);
        const started = tm.start();
        await vi.advanceTimersByTimeAsync(600);
        await started;

        ctx.children[0].emit('close', 0);        // retryCount 0 → 1, retry in 2 s
        await vi.advanceTimersByTimeAsync(2000); // attempt 1 fails → retryCount 2, retry in 4 s
        expect(priv(tm).retryCount).toBe(2);
        await vi.advanceTimersByTimeAsync(4000); // attempt 2 fails → retryCount 3, retry in 6 s
        expect(priv(tm).retryCount).toBe(3);
        await vi.advanceTimersByTimeAsync(6000); // attempt 3 fails → out of retries

        expect(log.map(e => e[0]).filter(e => e === 'tunnel:error')).toHaveLength(1);
        expect(log.at(-1)).toEqual(['tunnel:error', 'Max retries reached']);
        expect(tm.getStatus().active).toBe(false);
    });

    it('does not retry after an intentional stop', async () => {
        const { tm, log, children, spawnCalls } = await startWithFakeTimers([null, 'https://one.ngrok.app']);
        const stopped = tm.stop();
        await vi.advanceTimersByTimeAsync(1200);
        await stopped;

        children[0].emit('close', 0); // ngrok finally exits after SIGTERM
        await vi.advanceTimersByTimeAsync(10000);
        expect(log.filter(e => e[0] === 'tunnel:closed')).toHaveLength(0);
        expect(spawnCalls).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
describe('stop', () => {
    it('signals the process and resets all state', async () => {
        vi.useFakeTimers();
        const { deps, children } = makeDeps({ tunnels: [null, 'https://one.ngrok.app'] });
        const tm = new TunnelManager(PORT, undefined, deps);
        const started = tm.start();
        await vi.advanceTimersByTimeAsync(600);
        await started;

        const stopping = tm.stop();
        await vi.advanceTimersByTimeAsync(1200);
        await stopping;

        if (process.platform !== 'win32') {
            expect(children[0].signals).toContain('SIGTERM');
        }
        expect(tm.getStatus()).toEqual({
            active: false, url: null, token: null, startedAt: null, error: null, publicIp: null,
        });
        expect(tm.validateToken('x')).toBe(false);
    });

    it('is safe to call when nothing was ever started', async () => {
        const { deps } = makeDeps();
        const tm = new TunnelManager(PORT, undefined, deps);
        await expect(tm.stop()).resolves.toBeUndefined();
        expect(tm.getStatus().active).toBe(false);
    });

    it('is idempotent', async () => {
        const { deps } = makeDeps({ tunnels: ['https://orphan.ngrok.app'] });
        const tm = new TunnelManager(PORT, undefined, deps);
        await tm.start();
        await tm.stop();
        await tm.stop();
        expect(tm.getStatus().active).toBe(false);
    });

    it('tears down the adopted-mode monitor', async () => {
        vi.useFakeTimers();
        const { deps } = makeDeps({ tunnels: ['https://orphan.ngrok.app'] });
        const tm = new TunnelManager(PORT, undefined, deps);
        const log = events(tm);
        await tm.start();
        expect(priv(tm).adoptedMonitor).not.toBeNull();

        await tm.stop();
        expect(priv(tm).adoptedMonitor).toBeNull();
        await vi.advanceTimersByTimeAsync(30000);
        expect(log.filter(e => e[0] === 'tunnel:closed')).toHaveLength(0);
    });

    it('cancels a pending retry timer', async () => {
        vi.useFakeTimers();
        const { deps, children, spawnCalls } = makeDeps({ tunnels: [null, 'https://one.ngrok.app'] });
        const tm = new TunnelManager(PORT, undefined, deps);
        const started = tm.start();
        await vi.advanceTimersByTimeAsync(600);
        await started;

        children[0].emit('close', 0);        // schedules a reconnect in 2 s
        const stopping = tm.stop();
        await vi.advanceTimersByTimeAsync(1200);
        await stopping;
        await vi.advanceTimersByTimeAsync(10000);
        expect(spawnCalls).toHaveLength(1);  // the retry never fired
    });

    it('does not throw when killing the process fails', async () => {
        vi.useFakeTimers();
        const { deps, children } = makeDeps({ tunnels: [null, 'https://one.ngrok.app'] });
        const tm = new TunnelManager(PORT, undefined, deps);
        const started = tm.start();
        await vi.advanceTimersByTimeAsync(600);
        await started;
        children[0].kill = () => { throw new Error('ESRCH'); };

        const stopping = tm.stop();
        await vi.advanceTimersByTimeAsync(1200);
        await expect(stopping).resolves.toBeUndefined();
        expect(tm.getStatus().active).toBe(false);
    });
});

/**
 * Adoption must be scoped to OUR port. Before this guard, every extra process
 * that constructed a TunnelManager — the integration-test harness on an
 * ephemeral port, a second backend instance — adopted whatever ngrok happened
 * to be running, and its teardown then ran `taskkill /f /im ngrok.exe`,
 * killing the live server's tunnel. Running `npm test` took mobile access
 * down until the user re-enabled the tunnel.
 */
describe('adoption is scoped to the port we serve', () => {
    /** deps whose /api/tunnels always reports one https tunnel with `addr`. */
    function depsWithAddr(addr: string | undefined) {
        const spawnCalls: string[][] = [];
        const deps: Partial<TunnelManagerDeps> = {
            spawn: ((cmd: string, args: string[]) => {
                spawnCalls.push(args);
                return new FakeChild();
            }) as unknown as TunnelManagerDeps['spawn'],
            execSync: (() => Buffer.from('')) as unknown as TunnelManagerDeps['execSync'],
            fetch: async (url: string) => {
                if (url.includes('ipify')) throw new Error('offline');
                return {
                    json: async () => ({
                        tunnels: [{
                            public_url: 'https://someone-elses.ngrok-free.dev',
                            proto: 'https',
                            ...(addr === undefined ? {} : { config: { addr } }),
                        }],
                    }),
                };
            },
        };
        return { deps, spawnCalls };
    }

    it('does NOT adopt a tunnel pointing at a different port', async () => {
        const { deps } = depsWithAddr('http://localhost:4001');
        const tm = new TunnelManager(PORT, undefined, deps);
        await tm.autoRecover();
        expect(tm.getStatus().active).toBe(false);
        expect(tm.getStatus().url).toBeNull();
    });

    it('DOES adopt a tunnel pointing at our port', async () => {
        const { deps } = depsWithAddr(`http://localhost:${PORT}`);
        const tm = new TunnelManager(PORT, undefined, deps);
        await tm.autoRecover();
        expect(tm.getStatus().url).toBe('https://someone-elses.ngrok-free.dev');
        await tm.stop();
    });

    it('accepts the bare host:port form older ngrok reports', async () => {
        const { deps } = depsWithAddr(`localhost:${PORT}`);
        const tm = new TunnelManager(PORT, undefined, deps);
        await tm.autoRecover();
        expect(tm.getStatus().active).toBe(true);
        await tm.stop();
    });

    it('still adopts when the API omits addr (older ngrok) — parse miss must not regress orphan recovery', async () => {
        const { deps } = depsWithAddr(undefined);
        const tm = new TunnelManager(PORT, undefined, deps);
        await tm.autoRecover();
        expect(tm.getStatus().active).toBe(true);
        await tm.stop();
    });

    it('honours setPort() when deciding what to adopt', async () => {
        const { deps } = depsWithAddr('http://localhost:4001');
        const tm = new TunnelManager(PORT, undefined, deps);
        tm.setPort(4001);
        await tm.autoRecover();
        expect(tm.getStatus().active).toBe(true);
        await tm.stop();
    });
});

describe('parseNgrokAddrPort', () => {
    it.each([
        ['http://localhost:4001', 4001],
        ['https://127.0.0.1:8080/', 8080],
        ['localhost:5173', 5173],
        ['0.0.0.0:65535', 65535],
    ])('parses %s as %i', (addr, expected) => {
        expect(parseNgrokAddrPort(addr as string)).toBe(expected);
    });

    it.each(['80', 'file:///tmp/sock', '', 'localhost:99999'])('returns null for %s', (addr) => {
        expect(parseNgrokAddrPort(addr)).toBeNull();
    });
});
