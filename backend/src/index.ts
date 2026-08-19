import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { createApp } from './server.js';
import { resolveDataDir, dataPath } from './paths.js';
import { checkClaudeCodeInstalled } from './task-spawner.js';
import { SharedMcpManager, DEFAULT_SHARED_PLAYWRIGHT_PORT } from './shared-mcp-manager.js';
import { PORTS } from '@claudia/shared';

const PORT = process.env.CLAUDIA_BACKEND_PORT || PORTS.BACKEND;

// Check if Claude Code CLI is installed — warn but don't block startup.
// The CLI may be unreachable when off VPN or during network issues;
// the server should still start so the UI is accessible.
const claudeCheck = checkClaudeCodeInstalled();
if (!claudeCheck.installed) {
    console.warn('\n╔══════════════════════════════════════════════════════════════════╗');
    console.warn('║  WARNING: Claude Code CLI not detected                          ║');
    console.warn('║                                                                  ║');
    console.warn('║  Task creation will fail until the CLI is available.             ║');
    console.warn('║  Install from: https://claude.ai/code                            ║');
    console.warn('╚══════════════════════════════════════════════════════════════════╝\n');
} else {
    console.log(`Claude Code CLI detected: ${claudeCheck.version}`);
}

// Auto-install the /learn command to ~/.claude/commands/ so it's available in all Claude Code sessions
function installLearnCommand() {
    try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const sourceFile = path.join(__dirname, 'commands', 'learn.md');
        const commandsDir = path.join(os.homedir(), '.claude', 'commands');
        const destFile = path.join(commandsDir, 'learn.md');

        if (!fs.existsSync(sourceFile)) {
            console.warn('[LearnCommand] Source file not found:', sourceFile);
            return;
        }

        // Create ~/.claude/commands/ if it doesn't exist
        fs.mkdirSync(commandsDir, { recursive: true });

        const sourceContent = fs.readFileSync(sourceFile, 'utf-8');

        // Only update if content has changed (avoid unnecessary writes)
        if (fs.existsSync(destFile)) {
            const destContent = fs.readFileSync(destFile, 'utf-8');
            if (destContent === sourceContent) {
                console.log('[LearnCommand] /learn command already up-to-date at', destFile);
                return;
            }
        }

        fs.writeFileSync(destFile, sourceContent, 'utf-8');
        console.log('[LearnCommand] Installed /learn command to', destFile);
    } catch (err) {
        console.error('[LearnCommand] Failed to install /learn command:', err);
    }
}

installLearnCommand();


const { server, taskSpawner, gracefulShutdown } = await createApp();

// Bring up the shared Playwright MCP server before serving traffic, so tasks
// spawned immediately after boot get the HTTP URL rather than each starting
// their own subprocess. Adoption makes this a no-op across tsx watch reloads.
//
// Opt out with CLAUDIA_SHARED_MCP=0 to restore per-task stdio servers.
if (process.env.CLAUDIA_SHARED_MCP !== '0') {
    const sharedPort = parseInt(process.env.CLAUDIA_SHARED_MCP_PORT || '', 10);
    const sharedMcp = new SharedMcpManager(
        Number.isFinite(sharedPort) ? sharedPort : DEFAULT_SHARED_PLAYWRIGHT_PORT,
    );
    try {
        const ok = await sharedMcp.ensureStarted();
        // Only attach on success — otherwise tasks keep using stdio servers.
        if (ok) {
            taskSpawner.setSharedMcpManager(sharedMcp);
            console.log(`[Index] Shared Playwright MCP server ready at ${sharedMcp.getStatus().url}`);
        } else {
            console.warn('[Index] Shared Playwright MCP unavailable; using per-task stdio servers');
        }
    } catch (err) {
        console.error('[Index] Shared MCP startup failed; using per-task stdio servers:', err);
    }
} else {
    console.log('[Index] Shared MCP disabled via CLAUDIA_SHARED_MCP=0');
}

console.log(`[Index] Starting server on port ${PORT}...`);
let httpServer: ReturnType<typeof server.listen> | undefined;
try {
    httpServer = server.listen(PORT, () => {
        console.log(`Claude Code UI running on http://localhost:${PORT}`);
        console.log(`WebSocket available at ws://localhost:${PORT}`);
        console.log(`[Index] Server successfully listening`);

        // Only now is it safe to bring interrupted tasks back. Each reconnected
        // session dials this server's own /mcp endpoint for the claudia tools,
        // and Claude Code never retries an MCP server that failed to connect at
        // startup — so reconnecting before the listener was up left every
        // restored session permanently without claudia_* tools.
        taskSpawner.startAutoReconnect();
    });

    httpServer.on('error', (err: any) => {
        console.error('[Index] Server failed to start:', err);
        if (err.code === 'EADDRINUSE') {
            console.error(`Port ${PORT} is already in use`);
        }
        // CRITICAL: Exit so tsx watch can retry. Otherwise the process keeps running
        // with an active TaskSpawner that races on tasks.json with the other instance,
        // and the user gets "stuck reconnecting to backend" because nothing serves HTTP.
        process.exit(1);
    });
} catch (err) {
    console.error('[Index] Exception during server.listen:', err);
    process.exit(1);
}

// Graceful shutdown - use the server's gracefulShutdown which handles all cleanup
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// NOTE: We intentionally do NOT save on the 'exit' event because it causes race conditions
// when tsx watch restarts the server. The debounced save mechanism (500ms) is sufficient,
// and gracefulShutdown() already handles saving on SIGTERM/SIGINT.

// Crash logs follow the data directory: on a container they belong on the
// mounted volume, not inside the image layer where they vanish on redeploy.
const CRASH_LOG = dataPath(resolveDataDir(), 'crash.log');

process.on('uncaughtException', (err) => {
    console.error('[Index] Uncaught Exception:', err);
    try {
        const { appendFileSync } = require('fs');
        appendFileSync(CRASH_LOG,
            `[${new Date().toISOString()}] UNCAUGHT EXCEPTION: ${err.stack || err.message}\n`);
    } catch {}
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[Index] Unhandled Rejection at:', promise, 'reason:', reason);
    try {
        const { appendFileSync } = require('fs');
        appendFileSync(CRASH_LOG,
            `[${new Date().toISOString()}] UNHANDLED REJECTION: ${reason instanceof Error ? reason.stack : String(reason)}\n`);
    } catch {}
});

process.on('exit', (code) => {
    try {
        const { appendFileSync } = require('fs');
        appendFileSync(CRASH_LOG,
            `[${new Date().toISOString()}] PROCESS EXIT code=${code}\n`);
    } catch {}
});
