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

/**
 * startServer registers its listeners only after `await getPort(...)`, so a
 * test must let that microtask land before driving the fake child's events.
 */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const okResponse = (body: unknown = { status: 'ok' }) =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

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

describe('findRunningBackend', () => {
    it('returns attach info when the health endpoint answers 200', async () => {
        fetchMock.mockResolvedValue(okResponse());

        const info = await findRunningBackend('http://localhost:4001');

        expect(info).toEqual({ child: null, port: 4001, url: 'http://localhost:4001', version: undefined });
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:4001/api/health');
    });

    // A null child is the whole point: it tells stopServer this process is not
    // ours, so quitting the app must not kill the user's `./start.sh` backend.
    it('marks the attached backend as externally owned', async () => {
        fetchMock.mockResolvedValue(okResponse());
        const info = await findRunningBackend('http://localhost:4001');
        expect(info?.child).toBeNull();
    });

    it('carries the version through when the health payload has one', async () => {
        fetchMock.mockResolvedValue(okResponse({ status: 'ok', version: '0.4.0' }));

        const info = await findRunningBackend('http://localhost:4001');

        expect(info?.version).toBe('0.4.0');
    });

    it('still attaches when the health payload is not JSON', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => { throw new SyntaxError('Unexpected token'); }
        } as unknown as Response);

        const info = await findRunningBackend('http://localhost:4001');

        expect(info).not.toBeNull();
        expect(info?.version).toBeUndefined();
    });

    it('strips a trailing slash instead of probing a double-slashed path', async () => {
        fetchMock.mockResolvedValue(okResponse());

        const info = await findRunningBackend('http://localhost:4001/');

        expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:4001/api/health');
        expect(info?.url).toBe('http://localhost:4001');
    });

    // fetch is mocked here, so a malformed origin can still reach the parse.
    // In production this guards against a garbage CLAUDIA_BACKEND_URL taking
    // down startup with an unhandled URL error.
    it('returns null when the URL cannot be parsed', async () => {
        fetchMock.mockResolvedValue(okResponse());

        await expect(findRunningBackend('not-a-url')).resolves.toBeNull();
    });

    it('returns null on a network error', async () => {
        fetchMock.mockRejectedValue(new TypeError('fetch failed'));

        await expect(findRunningBackend('http://localhost:4001')).resolves.toBeNull();
    });

    it('returns null on a non-200 response', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as unknown as Response);

        await expect(findRunningBackend('http://localhost:4001')).resolves.toBeNull();
    });

    it('returns null when the probe times out, and aborts the request', async () => {
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
