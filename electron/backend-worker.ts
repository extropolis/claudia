/**
 * Backend worker - runs the Express server in a utility process.
 *
 * This runs as a separate Node.js process (via Electron's utilityProcess)
 * because node-pty's native module crashes in Electron's main process.
 * The utility process has full Node.js support without Chromium overhead.
 *
 * Communication with main process:
 * - Receives: { type: 'start', port, basePath }
 * - Sends: { type: 'ready' } on success
 * - Sends: { type: 'error', message } on failure
 * - Sends: { type: 'log', level, message } for log forwarding
 */

import { createApp } from '../backend/dist/server.js';

// Electron utility process has parentPort on the process object
const parentPort = (process as any).parentPort;

// Forward console output to main process
const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;
const formatArgs = (args: unknown[]) => args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');

console.log = (...args: unknown[]) => {
    origLog(...args);
    parentPort?.postMessage({ type: 'log', level: 'log', message: formatArgs(args) });
};
console.error = (...args: unknown[]) => {
    origError(...args);
    parentPort?.postMessage({ type: 'log', level: 'error', message: formatArgs(args) });
};
console.warn = (...args: unknown[]) => {
    origWarn(...args);
    parentPort?.postMessage({ type: 'log', level: 'warn', message: formatArgs(args) });
};

parentPort?.on('message', async (e: any) => {
    const msg = e.data;

    if (msg.type === 'start') {
        try {
            const { port, basePath } = msg;
            console.log(`Starting backend on port ${port}...`);

            const { server } = await createApp(basePath || undefined);

            await new Promise<void>((resolve, reject) => {
                server.listen(port, () => {
                    console.log(`Backend server running on http://localhost:${port}`);
                    resolve();
                });
                server.on('error', (error: Error) => {
                    console.error('Failed to start backend server:', error);
                    reject(error);
                });
            });

            parentPort?.postMessage({ type: 'ready' });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('Backend startup failed:', message);
            parentPort?.postMessage({ type: 'error', message });
        }
    }
});
