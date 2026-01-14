import 'dotenv/config';
import { createApp } from './server.js';

const PORT = process.env.PORT || 3001;

const { server, taskSpawner } = createApp();

const httpServer = server.listen(PORT, () => {
    console.log(`Claude Code UI running on http://localhost:${PORT}`);
    console.log(`WebSocket available at ws://localhost:${PORT}`);
});

// Graceful shutdown
const shutdown = (signal: string) => {
    console.log(`\n[${signal}] Shutting down...`);

    httpServer.close(() => {
        console.log('HTTP server closed');
    });

    try {
        console.log('Cleaning up tasks...');
        taskSpawner.destroy();
        console.log('Cleanup complete');
        process.exit(0);
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
