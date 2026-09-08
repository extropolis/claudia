import { utilityProcess, UtilityProcess } from 'electron';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import getPort from 'get-port';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ServerInfo {
    /**
     * The utility process hosting the backend, or `null` when we attached to a
     * backend that was already running (started by `./start.sh`, another
     * Claudia window, ...). A null child means we do not own the process and
     * must never kill it.
     */
    child: UtilityProcess | null;
    port: number;
    url: string;
    /** Instance id from `/api/server-info`; absent when only `/api/health` answered. */
    instanceId?: string;
    /** Version reported by `/api/server-info`. */
    version?: string;
    /** Data directory the attached backend holds, per `/api/server-info`. */
    dataDir?: string | null;
}

/** Identity a probe can learn about a backend that is already running. */
interface BackendIdentity {
    instanceId?: string;
    version?: string;
    dataDir?: string | null;
}

/**
 * Ask `/api/server-info` who the backend is.
 *
 * This is the preferred probe: it answers with an identity we can log and, in
 * time, reason about (see the instance-lock work). It is deliberately
 * unauthenticated on the backend side, because the question is asked before any
 * credential exists. Returns null when the route is absent (older backend) or
 * the payload is not recognisably Claudia's, so the caller can fall back.
 */
async function probeServerInfo(base: string, signal: AbortSignal): Promise<BackendIdentity | null> {
    try {
        const res = await fetch(`${base}/api/server-info`, {
            signal,
            headers: { accept: 'application/json' }
        });
        if (!res.ok) {
            console.log(`[Backend probe] /api/server-info -> HTTP ${res.status}, falling back to /api/health`);
            return null;
        }

        const body = (await res.json()) as Record<string, unknown> | null;
        // The identity guard: a bare 200 proves only that *something* listens on
        // this port. A Claudia backend names itself.
        if (!body || typeof body.instanceId !== 'string' || body.instanceId.length === 0) {
            console.log('[Backend probe] /api/server-info answered without an instanceId, falling back to /api/health');
            return null;
        }

        return {
            instanceId: body.instanceId,
            version: typeof body.version === 'string' ? body.version : undefined,
            dataDir: typeof body.dataDir === 'string' ? body.dataDir : null
        };
    } catch {
        // Route missing, payload not JSON, or the connection died. Either the
        // health probe picks it up or the whole probe fails there.
        return null;
    }
}

/**
 * Fall back to `/api/health` for backends predating `/api/server-info`.
 *
 * Learns no identity, so an attach via this path logs only that it attached.
 */
async function probeHealth(base: string, signal: AbortSignal): Promise<BackendIdentity | null> {
    try {
        const res = await fetch(`${base}/api/health`, {
            signal,
            headers: { accept: 'application/json' }
        });
        if (!res.ok) {
            console.log(`[Backend probe] /api/health -> HTTP ${res.status}, not attaching`);
            return null;
        }

        const body = (await res.json()) as Record<string, unknown> | null;
        if (!body || body.status !== 'ok') {
            console.log('[Backend probe] /api/health answered 200 but not with Claudia\'s payload, not attaching');
            return null;
        }
        return {};
    } catch {
        return null;
    }
}

/**
 * Probe for a backend that is already listening at `url`.
 *
 * This is what keeps a packaged/dev Electron window from booting a *second*
 * Claudia against a different data dir while the user's `./start.sh` backend
 * is already serving all their workspaces on 4001.
 *
 * Tries `/api/server-info` first and falls back to `/api/health`, so it attaches
 * to backends both with and without the instance-lock work. Both probes require
 * the body to look like Claudia's, not merely a 200 — otherwise any unrelated
 * service holding the port would be attached to. That guard is sized for a
 * localhost default and needs real authentication before attach goes remote.
 *
 * @param url - Backend origin, e.g. `http://localhost:4001`
 * @param timeoutMs - Abort the whole probe, both requests, after this long
 * @returns ServerInfo with `child: null` when a Claudia backend answered, else null
 */
export async function findRunningBackend(
    url: string,
    timeoutMs = 1500
): Promise<ServerInfo | null> {
    const base = url.replace(/\/+$/, '');

    let port: number;
    try {
        const parsed = new URL(base);
        port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
    } catch {
        console.log(`[Backend probe] ${base} is not a valid URL, not attaching`);
        return null;
    }

    // One budget covers both requests, so a hung backend cannot double the
    // startup delay by stalling each probe in turn.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        let identity = await probeServerInfo(base, controller.signal);
        if (!identity && !controller.signal.aborted) {
            identity = await probeHealth(base, controller.signal);
        }

        if (!identity) {
            const why = controller.signal.aborted
                ? `no response within ${timeoutMs}ms`
                : 'no Claudia backend answered';
            console.log(`[Backend probe] ${base}: ${why}, will spawn our own`);
            return null;
        }

        return { child: null, port, url: base, ...identity };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Decide where the backend comes from: attach to a running one if the probe
 * finds it, otherwise spawn our own.
 *
 * Kept as a pure-ish function (both sides injected) precisely so it is
 * testable — `main.ts` runs Electron app lifecycle at import time and cannot
 * be exercised in a unit test.
 */
export async function resolveBackend(deps: {
    probe: () => Promise<ServerInfo | null>;
    spawn: () => Promise<ServerInfo>;
}): Promise<{ info: ServerInfo; attached: boolean }> {
    const found = await deps.probe();
    if (found) return { info: found, attached: true };
    return { info: await deps.spawn(), attached: false };
}

/**
 * Start the Express backend server in a utility process.
 *
 * The backend runs in a separate process because node-pty (native module)
 * segfaults when loaded in Electron's main process. Electron's utilityProcess
 * provides a full Node.js environment without Chromium overhead.
 *
 * @param basePath - Optional base path for configuration files (e.g., app.getPath('userData'))
 * @param onLog - Callback for forwarded backend log messages
 */
export async function startServer(
    basePath?: string,
    onLog?: (level: string, message: string) => void
): Promise<ServerInfo> {
    const port = await getPort({ port: 3001 });
    const workerPath = join(__dirname, 'backend-worker.js');

    console.log(`🔮 Starting Claudia backend on port ${port} (utility process)...`);

    const child = utilityProcess.fork(workerPath);

    return new Promise<ServerInfo>((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Backend startup timeout (30s)'));
        }, 30000);

        child.on('message', (msg: any) => {
            if (msg.type === 'ready') {
                clearTimeout(timeout);
                const url = `http://localhost:${port}`;
                console.log(`✅ Backend server running on ${url}`);
                resolve({ child, port, url });
            } else if (msg.type === 'error') {
                clearTimeout(timeout);
                reject(new Error(msg.message));
            } else if (msg.type === 'log' && onLog) {
                onLog(msg.level, msg.message);
            }
        });

        child.on('exit', (code) => {
            clearTimeout(timeout);
            if (code !== 0) {
                reject(new Error(`Backend process exited with code ${code}`));
            }
        });

        // Send start command
        child.postMessage({ type: 'start', port, basePath: basePath || '' });
    });
}

/**
 * Stop the backend server gracefully
 */
export async function stopServer(child: UtilityProcess | null): Promise<void> {
    // We attached to a backend somebody else started — it is not ours to kill.
    if (!child) {
        console.log('↩️  Attached backend is externally owned, leaving it running');
        return;
    }
    console.log('🛑 Stopping backend server...');
    child.kill();
    // Wait for exit with timeout
    await new Promise<void>((resolve) => {
        child.on('exit', () => {
            console.log('✅ Backend server stopped');
            resolve();
        });
        setTimeout(() => {
            console.log('⚠️  Force closing backend...');
            resolve();
        }, 5000);
    });
}
