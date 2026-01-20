import 'dotenv/config';
import { createApp } from './server.js';
import { checkClaudeCodeInstalled } from './task-spawner.js';
import { PORTS } from '@claudia/shared';

const PORT = process.env.PORT || PORTS.BACKEND;

// Check if Claude Code CLI is installed before starting
const claudeCheck = checkClaudeCodeInstalled();
if (!claudeCheck.installed) {
    console.error('\n╔══════════════════════════════════════════════════════════════════╗');
    console.error('║  ERROR: Claude Code CLI is not installed!                        ║');
    console.error('║                                                                  ║');
    console.error('║  This application requires Claude Code CLI to function.         ║');
    console.error('║  Please install it from: https://claude.ai/code                 ║');
    console.error('╚══════════════════════════════════════════════════════════════════╝\n');
    process.exit(1);
}
console.log(`Claude Code CLI detected: ${claudeCheck.version}`);

// Debug: Log memory usage every 2 seconds to trace OOM issues
setInterval(() => {
    const usage = process.memoryUsage();
    console.log(`[Memory] RSS: ${(usage.rss / 1024 / 1024).toFixed(2)}MB | HeapUsed: ${(usage.heapUsed / 1024 / 1024).toFixed(2)}MB | HeapTotal: ${(usage.heapTotal / 1024 / 1024).toFixed(2)}MB | External: ${(usage.external / 1024 / 1024).toFixed(2)}MB`);
}, 2000);


const { server, taskSpawner, gracefulShutdown } = createApp();

console.log(`[Index] Starting server on port ${PORT}...`);
let httpServer: ReturnType<typeof server.listen> | undefined;
try {
    httpServer = server.listen(PORT, () => {
        console.log(`Claude Code UI running on http://localhost:${PORT}`);
        console.log(`WebSocket available at ws://localhost:${PORT}`);
        console.log(`[Index] Server successfully listening`);
    });

    httpServer.on('error', (err: any) => {
        console.error('[Index] Server failed to start:', err);
        if (err.code === 'EADDRINUSE') {
            console.error(`Port ${PORT} is already in use`);
        }
    });
} catch (err) {
    console.error('[Index] Exception during server.listen:', err);
}

// Graceful shutdown - use the server's gracefulShutdown which handles all cleanup
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
    console.error('[Index] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[Index] Unhandled Rejection at:', promise, 'reason:', reason);
});
