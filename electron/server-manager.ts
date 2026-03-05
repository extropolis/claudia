import { utilityProcess, UtilityProcess } from 'electron';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import getPort from 'get-port';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ServerInfo {
    child: UtilityProcess;
    port: number;
    url: string;
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
export async function stopServer(child: UtilityProcess): Promise<void> {
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
