import { createApp } from './server.js';

const PORT = process.env.PORT || 3001;

const { server, processManager, taskManager, orchestrator } = createApp();

const httpServer = server.listen(PORT, () => {
    console.log(`🔮 Claudia Backend running on http://localhost:${PORT}`);
    console.log(`   WebSocket available at ws://localhost:${PORT}`);
});

// Graceful shutdown
const shutdown = async (signal: string) => {
    console.log(`\n[${signal}] Shutting down...`);

    // Close HTTP server first to stop accepting new connections
    httpServer.close(() => {
        console.log('HTTP server closed');
    });

    try {
        // Clean up managers
        console.log('Cleaning up orchestrator...');
        orchestrator.stop();

        console.log('Cleaning up process manager...');
        await processManager.shutdown();

        console.log('Cleaning up task manager...');
        taskManager.cleanup();

        console.log('Cleanup complete');
        process.exit(0);
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

