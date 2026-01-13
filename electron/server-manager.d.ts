import { Server } from 'http';
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
export declare function startServer(basePath?: string): Promise<ServerInfo>;
/**
 * Stop the Express backend server gracefully
 * @param server - The HTTP server instance to stop
 */
export declare function stopServer(server: Server): Promise<void>;
