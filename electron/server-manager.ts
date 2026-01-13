import { Server } from 'http';
import getPort from 'get-port';
import { createApp } from '../backend/dist/server.js';

export interface ServerInfo {
    server: Server;
    port: number;
    url: string;
}

/**
 * Start the Express backend server on an available port
 * @param basePath - Optional base path for configuration files (e.g., app.getPath('userData'))
 * @returns ServerInfo with server instance, port, and URL
 */
export async function startServer(basePath?: string): Promise<ServerInfo> {
    try {
        // Find an available port (prefer 3001, but use any available port)
        const port = await getPort({ port: 3001 });

        console.log(`🔮 Starting Claudia backend on port ${port}...`);

        // Create the Express app with optional basePath for config files
        const { server } = createApp(basePath);

        // Start listening
        await new Promise<void>((resolve, reject) => {
            server.listen(port, () => {
                console.log(`✅ Backend server running on http://localhost:${port}`);
                resolve();
            });

            server.on('error', (error) => {
                console.error('❌ Failed to start backend server:', error);
                reject(error);
            });
        });

        const url = `http://localhost:${port}`;

        return { server, port, url };
    } catch (error) {
        console.error('❌ Error starting server:', error);
        throw error;
    }
}

/**
 * Stop the Express backend server gracefully
 * @param server - The HTTP server instance to stop
 */
export async function stopServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        console.log('🛑 Stopping backend server...');

        server.close((error) => {
            if (error) {
                console.error('❌ Error stopping server:', error);
                reject(error);
            } else {
                console.log('✅ Backend server stopped');
                resolve();
            }
        });

        // Force close any remaining connections after 5 seconds
        setTimeout(() => {
            console.log('⚠️  Force closing server connections...');
            resolve();
        }, 5000);
    });
}
