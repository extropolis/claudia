import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `server-manager.ts` statically imports `electron`, which is not loadable in a
// plain Node test process (the real package resolves to the binary path). The
// factory replaces the module outright, so the real one is never evaluated.
vi.mock('electron', () => ({
    utilityProcess: { fork: vi.fn() }
}));
vi.mock('get-port', () => ({ default: vi.fn(async () => 3001) }));

const { utilityProcess } = await import('electron');
const { findRunningBackend, resolveBackend, startServer, stopServer } =
    await import('../server-manager.js');
type ServerInfo = Awaited<ReturnType<typeof resolveBackend>>['info'];

/**
 * Stand-in for an Electron UtilityProcess: records listeners so a test can
 * drive the `message`/`exit` events startServer waits on.
 */
function fakeChild() {
    const handlers: Record<string, Array<(...args: any[]) => void>> = {};
    return {
        on: vi.fn((event: string, cb: (...args: any[]) => void) => {
            (handlers[event] ||= []).push(cb);
        }),
        postMessage: vi.fn(),
        kill: vi.fn(),
        emit(event: string, ...args: any[]) {
            (handlers[event] ?? []).forEach((cb) => cb(...args));
        }
    };
}

const json = (body: unknown, status = 200) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const notFound = () => json({ error: 'Not found' }, 404);

/**
 * Route the mocked fetch by endpoint. `undefined` means "route absent" (404),
 * an Error is thrown as a transport failure.
 */
function routeFetch(routes: { serverInfo?: Response | Error; health?: Response | Error }) {
    fetchMock.mockImplementation(async (url: string) => {
        const hit = url.endsWith('/api/server-info') ? routes.serverInfo
            : url.endsWith('/api/health') ? routes.health
            : undefined;
        if (hit instanceof Error) throw hit;
        return hit ?? notFound();
    });
}

const SERVER_INFO = {
    instanceId: 'inst-abc123',
    version: '0.4.0',
    protocolVersion: 1,
    dataDir: '/Users/dev/.claudia',
    startedAt: '2026-09-08T02:00:00.000Z'
};

/**
 * startServer registers its listeners only after `await getPort(...)`, so a
 * test must let that microtask land before driving the fake child's events.
 */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // Keep the probe's diagnostics out of the test output.
    vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('findRunningBackend via /api/server-info', () => {
    it('prefers server-info and carries the backend identity through', async () => {
        routeFetch({ serverInfo: json(SERVER_INFO) });

        const info = await findRunningBackend('http://localhost:4001');

        expect(info).toEqual({
            child: null,
            port: 4001,
            url: 'http://localhost:4001',
            instanceId: 'inst-abc123',
            version: '0.4.0',
            dataDir: '/Users/dev/.claudia'
        });
        // health is never consulted when server-info answers
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:4001/api/server-info');
    });

    // A null child is the whole point: it tells stopServer this process is not
    // ours, so quitting the app must not kill the user's `./start.sh` backend.
    it('marks the attached backend as externally owned', async () => {
        routeFetch({ serverInfo: json(SERVER_INFO) });
        const info = await findRunningBackend('http://localhost:4001');
        expect(info?.child).toBeNull();
    });

    it('tolerates a server-info payload with no version or dataDir', async () => {
        routeFetch({ serverInfo: json({ instanceId: 'inst-1' }) });

        const info = await findRunningBackend('http://localhost:4001');

        expect(info?.instanceId).toBe('inst-1');
        expect(info?.version).toBeUndefined();
        expect(info?.dataDir).toBeNull();
    });

    it('strips a trailing slash instead of probing a double-slashed path', async () => {
        routeFetch({ serverInfo: json(SERVER_INFO) });

        const info = await findRunningBackend('http://localhost:4001/');

        expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:4001/api/server-info');
        expect(info?.url).toBe('http://localhost:4001');
    });
});

describe('findRunningBackend falling back to /api/health', () => {
    it('attaches without an identity when server-info is missing (older backend)', async () => {
        routeFetch({ health: json({ status: 'ok' }) });

        const info = await findRunningBackend('http://localhost:4001');

        expect(info).toEqual({ child: null, port: 4001, url: 'http://localhost:4001' });
        expect(info?.instanceId).toBeUndefined();
        expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
            'http://localhost:4001/api/server-info',
            'http://localhost:4001/api/health'
        ]);
    });

    it('falls back when server-info answers 200 without an instanceId', async () => {
        routeFetch({ serverInfo: json({ hello: 'some other service' }), health: json({ status: 'ok' }) });

        const info = await findRunningBackend('http://localhost:4001');

        expect(info).not.toBeNull();
        expect(info?.instanceId).toBeUndefined();
    });

    it('falls back when the server-info payload is not JSON', async () => {
        routeFetch({
            serverInfo: { ok: true, status: 200, json: async () => { throw new SyntaxError('nope'); } } as unknown as Response,
            health: json({ status: 'ok' })
        });

        await expect(findRunningBackend('http://localhost:4001')).resolves.not.toBeNull();
    });
});

// The identity guard. A 200 proves only that SOMETHING listens on the port;
// attaching to an unrelated service would leave the app pointed at a backend
// that cannot serve it. This is sized for a localhost-only default and needs
// real authentication before attach is ever offered against a remote host.
describe('findRunningBackend refuses anything that is not Claudia', () => {
    it('does not attach when health answers 200 with a foreign payload', async () => {
        routeFetch({ health: json({ status: 'healthy', service: 'grafana' }) });

        await expect(findRunningBackend('http://localhost:4001')).resolves.toBeNull();
    });

    it('does not attach when the health payload is not JSON', async () => {
        routeFetch({
            health: { ok: true, status: 200, json: async () => { throw new SyntaxError('not json'); } } as unknown as Response
        });

        await expect(findRunningBackend('http://localhost:4001')).resolves.toBeNull();
    });

    it('returns null when both endpoints 404', async () => {
        routeFetch({});

        await expect(findRunningBackend('http://localhost:4001')).resolves.toBeNull();
    });

    it('returns null on a non-200 health response', async () => {
        routeFetch({ health: json({ error: 'unavailable' }, 503) });

        await expect(findRunningBackend('http://localhost:4001')).resolves.toBeNull();
    });

    it('returns null on a network error', async () => {
        routeFetch({ serverInfo: new TypeError('fetch failed'), health: new TypeError('fetch failed') });

        await expect(findRunningBackend('http://localhost:4001')).resolves.toBeNull();
    });

    // Parsed before any request, so a garbage CLAUDIA_BACKEND_URL cannot take
    // down startup with an unhandled URL error.
    it('returns null without probing when the URL cannot be parsed', async () => {
        await expect(findRunningBackend('not-a-url')).resolves.toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('times out across both probes on one budget, and aborts the request', async () => {
        let signal: AbortSignal | undefined;
        fetchMock.mockImplementation((_url: string, init: RequestInit) => {
            signal = init.signal as AbortSignal;
            return new Promise((_resolve, reject) => {
                signal!.addEventListener('abort', () => {
                    const err = new Error('The operation was aborted');
                    err.name = 'AbortError';
                    reject(err);
                });
            });
        });

        const result = await findRunningBackend('http://localhost:4001', 10);

        expect(result).toBeNull();
        expect(signal?.aborted).toBe(true);
        // The health fallback is skipped once the shared budget is spent.
        expect(fetchMock).toHaveBeenCalledOnce();
    });
});

describe('resolveBackend', () => {
    it('attaches and never calls spawn when the probe finds a backend', async () => {
        const found: ServerInfo = { child: null, port: 4001, url: 'http://localhost:4001' };
        const spawn = vi.fn();

        const result = await resolveBackend({ probe: async () => found, spawn });

        expect(result).toEqual({ info: found, attached: true });
        expect(spawn).not.toHaveBeenCalled();
    });

    it('spawns when the probe finds nothing', async () => {
        const spawned = { child: {} as never, port: 3001, url: 'http://localhost:3001' };
        const spawn = vi.fn().mockResolvedValue(spawned);

        const result = await resolveBackend({ probe: async () => null, spawn });

        expect(result).toEqual({ info: spawned, attached: false });
        expect(spawn).toHaveBeenCalledOnce();
    });
});

describe('startServer', () => {
    it('resolves once the worker reports ready, and starts it on the chosen port', async () => {
        const child = fakeChild();
        vi.mocked(utilityProcess.fork).mockReturnValue(child as never);

        const pending = startServer('/tmp/userData');
        await flush();
        child.emit('message', { type: 'ready' });

        await expect(pending).resolves.toEqual({
            child,
            port: 3001,
            url: 'http://localhost:3001'
        });
        expect(child.postMessage).toHaveBeenCalledWith({
            type: 'start',
            port: 3001,
            basePath: '/tmp/userData'
        });
    });

    it('passes an empty basePath through when none is given', async () => {
        const child = fakeChild();
        vi.mocked(utilityProcess.fork).mockReturnValue(child as never);

        const pending = startServer();
        await flush();
        child.emit('message', { type: 'ready' });
        await pending;

        expect(child.postMessage).toHaveBeenCalledWith({
            type: 'start',
            port: 3001,
            basePath: ''
        });
    });

    it('forwards worker log messages to the onLog callback', async () => {
        const child = fakeChild();
        vi.mocked(utilityProcess.fork).mockReturnValue(child as never);
        const onLog = vi.fn();

        const pending = startServer(undefined, onLog);
        await flush();
        child.emit('message', { type: 'log', level: 'warn', message: 'heads up' });
        child.emit('message', { type: 'ready' });
        await pending;

        expect(onLog).toHaveBeenCalledWith('warn', 'heads up');
    });

    it('rejects when the worker reports an error', async () => {
        const child = fakeChild();
        vi.mocked(utilityProcess.fork).mockReturnValue(child as never);

        const pending = startServer();
        await flush();
        child.emit('message', { type: 'error', message: 'port already bound' });

        await expect(pending).rejects.toThrow('port already bound');
    });

    it('rejects when the worker exits non-zero', async () => {
        const child = fakeChild();
        vi.mocked(utilityProcess.fork).mockReturnValue(child as never);

        const pending = startServer();
        await flush();
        child.emit('exit', 1);

        await expect(pending).rejects.toThrow('Backend process exited with code 1');
    });

    it('stays pending on a clean exit code rather than rejecting', async () => {
        const child = fakeChild();
        vi.mocked(utilityProcess.fork).mockReturnValue(child as never);
        const settled = vi.fn();

        const pending = startServer().then(settled, settled);
        await flush();
        child.emit('exit', 0);
        await flush();

        expect(settled).not.toHaveBeenCalled();
        child.emit('message', { type: 'ready' });
        await pending;
        expect(settled).toHaveBeenCalledOnce();
    });

    it('rejects if the worker never reports ready within 30s', async () => {
        vi.useFakeTimers();
        const child = fakeChild();
        vi.mocked(utilityProcess.fork).mockReturnValue(child as never);

        const pending = startServer();
        const assertion = expect(pending).rejects.toThrow('Backend startup timeout (30s)');
        await vi.advanceTimersByTimeAsync(30_000);
        await assertion;
    });
});

describe('stopServer', () => {
    it('is a no-op for an attached (externally owned) backend', async () => {
        await expect(stopServer(null)).resolves.toBeUndefined();
    });

    it('kills a child process that we spawned', async () => {
        const child = fakeChild();

        const pending = stopServer(child as never);
        expect(child.kill).toHaveBeenCalledOnce();
        child.emit('exit', 0);
        await expect(pending).resolves.toBeUndefined();
    });

    // A wedged child must not block app quit forever.
    it('gives up and resolves after 5s if the child never exits', async () => {
        vi.useFakeTimers();
        const child = fakeChild();

        const pending = stopServer(child as never);
        await vi.advanceTimersByTimeAsync(5_000);

        await expect(pending).resolves.toBeUndefined();
        expect(child.kill).toHaveBeenCalledOnce();
    });
});
