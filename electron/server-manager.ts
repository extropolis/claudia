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
    /** Version reported by `/api/health`, when the payload carries one. */
    version?: string;
}

/**
 * Probe for a backend that is already listening at `url`.
 *
 * This is what keeps a packaged/dev Electron window from booting a *second*
 * Claudia against a different data dir while the user's `./start.sh` backend
 * is already serving all their workspaces on 4001. Localhost only, no auth:
 * anything reachable at this URL is by definition already trusted by the user.
 *
 * @param url - Backend origin, e.g. `http://localhost:4001`
 * @param timeoutMs - Abort the probe after this long (default 1.5s)
 * @returns ServerInfo with `child: null` when a backend answered 200, else null
 */
export async function findRunningBackend(
    url: string,
    timeoutMs = 1500
): Promise<ServerInfo | null> {
    const base = url.replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(`${base}/api/health`, {
            signal: controller.signal,
            headers: { accept: 'application/json' }
        });
        if (!res.ok) {
            console.log(`[Backend probe] ${base}/api/health -> HTTP ${res.status}, not attaching`);
            return null;
        }

        let version: string | undefined;
        try {
            const body: unknown = await res.json();
            const v = (body as { version?: unknown } | null)?.version;
            if (typeof v === 'string' && v.length > 0) version = v;
        } catch {
            // Health payload is not JSON (or empty). A 200 is enough to attach.
        }

        let port: number;
        try {
            const parsed = new URL(base);
            port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
        } catch {
            console.log(`[Backend probe] ${base} is not a valid URL, not attaching`);
            return null;
        }

        return { child: null, port, url: base, version };
    } catch (err) {
        const reason = (err as Error)?.name === 'AbortError'
            ? `no response within ${timeoutMs}ms`
            : (err as Error)?.message ?? String(err);
        console.log(`[Backend probe] ${base}/api/health unreachable (${reason}), will spawn our own`);
        return null;
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
