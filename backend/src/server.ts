import express from 'express';
import { createServer, request as httpRequest } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import os from 'os';
import { spawn, ChildProcess } from 'child_process';
import { writeFileSync, existsSync, readFileSync, mkdirSync, unlinkSync, readdirSync, statSync } from 'fs';
import { readFile, readdir } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { TaskSpawner } from './task-spawner.js';
import { WorkspaceStore } from './workspace-store.js';
import { ConfigStore } from './config-store.js';
import { SupervisorChat } from './supervisor-chat.js';
import { getConversationHistory, getWorkspaceSessions } from './conversation-parser.js';
import { setUserId } from './usage-reporter.js';
import { Task, Workspace, WSMessage, WSMessageType, WSErrorPayload, ChatMessage, SuggestedAction, WaitingInputType, PORTS } from '@claudia/shared';
import { validateConfigUpdate, validateWorkspacePath } from './validation.js';
import { LearningsStore } from './learnings-store.js';
import { TunnelManager } from './tunnel-manager.js';
import { getMobilePageHtml } from './mobile-page.js';
import { getVoiceAgentPageHtml } from './voice-agent-page.js';
import { VoiceSupervisor } from './voice-supervisor.js';
import { ElevenLabsTTS } from './elevenlabs-tts.js';
import { createLogger } from './logger.js';
import { PluginManager, PluginContext } from './plugin-system/index.js';

// Note: Route modules available in ./routes/ for reference and future refactoring
// - config-routes.ts: Config API routes template
// - task-routes.ts: Task REST API routes template
// - ws-handlers.ts: WebSocket handlers template

const logger = createLogger('[Server]');

// ES module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Valid WebSocket message types for validation
const VALID_WS_MESSAGE_TYPES = new Set([
    'task:create',
    'task:select',
    'task:input',
    'task:resize',
    'task:destroy',
    'task:interrupt',
    'task:archive',
    'task:reconnect',
    'task:revert',
    'task:restore',
    'task:rename',
    'task:archived:list',
    'task:archived:restore',
    'task:archived:continue',
    'task:archived:delete',
    'workspace:create',
    'workspace:delete',
    'workspace:reorder',
    'workspace:rename',
    'workspace:openFolder',
    'workspace:openTerminal',
    'workspace:systemPrompt:get',
    'workspace:systemPrompt:set',
    'workspace:recent:list',
    'workspace:recent:clear',
    'git:push',
    'supervisor:action',
    'supervisor:analyze',
    'supervisor:chat:message',
    'supervisor:chat:history',
    'supervisor:chat:clear',
    'task:disconnect',
    'task:clear',
    'tunnel:status'
]);

// WebSocket message validation
interface WSClientMessage {
    type: string;
    payload?: Record<string, unknown>;
}

function isValidWSMessage(data: unknown): data is WSClientMessage {
    if (typeof data !== 'object' || data === null) return false;
    const msg = data as Record<string, unknown>;
    if (typeof msg.type !== 'string') return false;
    if (!VALID_WS_MESSAGE_TYPES.has(msg.type)) return false;
    if (msg.payload !== undefined && (typeof msg.payload !== 'object' || msg.payload === null)) return false;
    return true;
}

/**
 * Send an error response to a WebSocket client
 */
function sendWSError(ws: WebSocket, message: string, originalType?: string, code?: string): void {
    const errorPayload: WSErrorPayload = { message, originalType, code };
    ws.send(JSON.stringify({
        type: 'error' as WSMessageType,
        payload: errorPayload
    }));
}

export async function createApp(basePath?: string) {
    const app = express();
    const server = createServer(app);
    // Use noServer mode so we can manually route WebSocket upgrade requests.
    // This is critical for tunnel access: Vite HMR WebSocket connections need
    // to be proxied to the Vite dev server, not handled by our app's WSS.
    const wss = new WebSocketServer({ noServer: true });

    // Middleware
    app.use(cors());
    app.use(express.json({ limit: '50mb' })); // Increased limit for large AI requests

    // TunnelManager for mobile remote access (ngrok-based, created early for middleware use)
    const tunnelManager = new TunnelManager(PORTS.BACKEND);
    logger.info('TunnelManager created (ngrok)');

    // ===== Tunnel → React Frontend Proxy =====
    // When accessed through the tunnel, proxy non-API requests to the Vite
    // dev server (development) or let them fall through to the static server (production).
    const isDev = process.env.NODE_ENV === 'development' || process.env.CLAUDIA_DEV === '1';

    function isTunnelHost(host: string): boolean {
        return host.includes('.loca.lt') || host.includes('localtunnel') ||
               host.includes('.ngrok-free.app') || host.includes('.ngrok.io') || host.includes('ngrok');
    }

    app.use((req, res, next) => {
        const host = req.headers.host || '';
        if (!isTunnelHost(host)) {
            return next();
        }

        // Tunnel visitor at root without a token → redirect with token so React can auth the WS
        if (req.path === '/' && !req.query.token) {
            const status = tunnelManager.getStatus();
            if (status.active && status.token) {
                logger.info('Tunnel visitor at root, redirecting with token', { host });
                return res.redirect(`/?token=${status.token}`);
            }
        }

        // Let API routes pass through
        if (req.path.startsWith('/api/')) {
            return next();
        }

        // In production, let requests fall through to the static file server
        if (!isDev) {
            return next();
        }

        // In development, proxy to the Vite dev server
        const proxyReq = httpRequest({
            hostname: 'localhost',
            port: PORTS.FRONTEND,
            path: req.originalUrl,
            method: req.method,
            headers: { ...req.headers, host: `localhost:${PORTS.FRONTEND}` },
        }, (proxyRes) => {
            res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
            proxyRes.pipe(res);
        });
        proxyReq.on('error', (err) => {
            logger.error('Vite proxy error', { error: err.message, path: req.path });
            res.status(502).send('Frontend proxy error — is Vite running?');
        });
        req.pipe(proxyReq);
    });

    // Initialize configStore first to determine API mode
    const configStore = new ConfigStore(basePath);

    // Initialize Plugin System
    logger.info('Initializing plugin system...');
    const pluginContext: PluginContext = {
        configStore,
        logger: createLogger('[Plugin]'),
        express,
        utils: { spawn, fetch }
    };

    const pluginManager = new PluginManager(pluginContext);

    // Discover and load plugins from backend/plugins directory
    const pluginsDir = join(__dirname, '..', 'plugins');
    await pluginManager.discoverPlugins(pluginsDir);

    // Initialize LLM service with config store so it can use the correct model
    const { initializeLLMService } = await import('./llm-service.js');
    initializeLLMService(configStore);

    // Register plugin routes (handles both SAP AI Core and HAI Proxy)
    pluginManager.registerRoutes(app);

    // Initialize remaining services
    const persistencePath = basePath ? join(basePath, 'tasks.json') : undefined;
    const taskSpawner = new TaskSpawner(persistencePath, true, configStore);
    const workspaceStore = new WorkspaceStore(basePath);
    // SupervisorChat now handles both auto-analysis (formerly TaskSupervisor) and chat
    const supervisorChat = new SupervisorChat(taskSpawner, workspaceStore, configStore);
    // VoiceSupervisor for hands-free voice control
    const voiceSupervisor = new VoiceSupervisor(supervisorChat, taskSpawner);
    // LearningsStore for RAG-based learnings
    const learningsStore = new LearningsStore(basePath, configStore);

    // Backfill workspaces from existing tasks
    // This ensures tasks created before workspace tracking still show up in UI
    try {
        const tasks = taskSpawner.getAllTasks();
        logger.info(`Backfill: Found ${tasks.length} tasks`);
        const workspacePathsToAdd = new Set<string>();

        // Get recent workspaces (ones that were intentionally removed by user)
        const recentWorkspaceIds = new Set(workspaceStore.getRecentWorkspaces().map(w => w.id));

        for (const task of tasks) {
            if (task.workspaceId) {
                const exists = existsSync(task.workspaceId);
                const alreadyInStore = workspaceStore.getWorkspace(task.workspaceId);
                const wasRemoved = recentWorkspaceIds.has(task.workspaceId);
                logger.info(`Backfill: Task ${task.id} workspace ${task.workspaceId} exists=${exists} inStore=${!!alreadyInStore} wasRemoved=${wasRemoved}`);

                // Only add if it exists, isn't already in store, AND wasn't intentionally removed by user
                if (!alreadyInStore && exists && !wasRemoved) {
                    workspacePathsToAdd.add(task.workspaceId);
                }
            }
        }

        logger.info(`Backfill: Will add ${workspacePathsToAdd.size} unique workspace(s)`);
        if (workspacePathsToAdd.size > 0) {
            for (const workspacePath of workspacePathsToAdd) {
                try {
                    const workspace = workspaceStore.addWorkspace(workspacePath);
                    logger.info(`Added workspace: ${workspacePath}`, { workspace });
                } catch (error) {
                    logger.error(`Failed to add workspace ${workspacePath}:`, { error });
                }
            }
        }
    } catch (error) {
        logger.error('Failed to backfill workspaces from tasks', { error });
    }

    // Wire up tunnel events for broadcasting
    tunnelManager.on('tunnel:ready', (data: { url: string; token: string }) => {
        logger.info('Tunnel ready, broadcasting status', { url: data.url });
        broadcast({ type: 'tunnel:status' as WSMessageType, payload: tunnelManager.getStatus() });
    });
    tunnelManager.on('tunnel:error', (error: string) => {
        logger.error('Tunnel error', { error });
        broadcast({ type: 'tunnel:status' as WSMessageType, payload: { ...tunnelManager.getStatus(), error } });
    });
    tunnelManager.on('tunnel:closed', () => {
        logger.info('Tunnel closed, broadcasting status');
        broadcast({ type: 'tunnel:status' as WSMessageType, payload: tunnelManager.getStatus() });
    });

    // Helper to extract rules from CLAUDE.md (reverse sync) - async version
    async function extractRulesFromClaudeMd(workspacePath: string): Promise<string | null> {
        const claudeMdPath = join(workspacePath, 'CLAUDE.md');
        const marker = '<!-- CODEUI-RULES -->';
        const endMarker = '<!-- /CODEUI-RULES -->';

        if (!existsSync(claudeMdPath)) {
            return null;
        }

        try {
            const content = await readFile(claudeMdPath, 'utf-8');
            const startIdx = content.indexOf(marker);
            const endIdx = content.indexOf(endMarker);

            if (startIdx === -1 || endIdx === -1) {
                return null;
            }

            // Extract content between markers, removing the "## Custom Rules" header
            const rulesContent = content.slice(startIdx + marker.length, endIdx);
            const lines = rulesContent.split('\n');

            // Filter out the "## Custom Rules" header and leading/trailing empty lines
            const filteredLines = lines.filter((line) => {
                const trimmed = line.trim();
                if (trimmed === '## Custom Rules') return false;
                return true;
            });

            return filteredLines.join('\n').trim();
        } catch (error) {
            console.error(`[Server] Error reading CLAUDE.md from ${workspacePath}:`, error);
            return null;
        }
    }

    // On startup, sync rules FROM CLAUDE.md if config.rules is empty
    (async function initRulesFromClaudeMd() {
        try {
            const config = configStore.getConfig();
            if (!config.rules) {
                const workspaces = workspaceStore.getWorkspaces();
                for (const workspace of workspaces) {
                    const rules = await extractRulesFromClaudeMd(workspace.id);
                    if (rules) {
                        console.log(`[Server] Found existing rules in ${workspace.id}/CLAUDE.md, syncing to config`);
                        configStore.updateConfig({ rules });
                        break; // Use rules from first workspace that has them
                    }
                }
            }
        } catch (error) {
            logger.error('Failed to initialize rules from CLAUDE.md', { error: error instanceof Error ? error.message : String(error) });
        }
    })();

    // On startup, sync MCP config files to all workspaces
    // This ensures .mcp.json and .claude/settings.local.json are always up-to-date
    // (prevents stale files from overriding global config, e.g. missing headers for HTTP servers)
    try {
        const workspaces = workspaceStore.getWorkspaces();
        if (workspaces.length > 0) {
            const workspaceIds = workspaces.map(w => w.id);
            taskSpawner.syncWorkspaceMcpConfigs(workspaceIds);
            logger.info('Synced MCP config to all workspaces on startup', { count: workspaceIds.length });
        }
    } catch (error) {
        logger.error('Failed to sync MCP configs on startup', { error });
    }

    // Track connected clients with their alive status for heartbeat
    const clients = new Set<WebSocket>();
    const clientAliveMap = new WeakMap<WebSocket, boolean>();

    // Heartbeat interval to keep WebSocket connections alive
    const HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds
    // Track missed pongs - only terminate after multiple missed heartbeats
    const clientMissedPongs = new WeakMap<WebSocket, number>();

    const heartbeatInterval = setInterval(() => {
        // Only log heartbeat when clients are connected
        if (clients.size > 0) {
            console.log(`[Server] Heartbeat check - ${clients.size} client(s) connected`);
        }
        for (const client of clients) {
            if (clientAliveMap.get(client) === false) {
                // Client didn't respond to last ping
                const missed = (clientMissedPongs.get(client) || 0) + 1;
                clientMissedPongs.set(client, missed);
                console.log(`[Server] Client missed heartbeat (${missed}/3)`);

                if (missed >= 3) {
                    // Only terminate after 3 missed pongs (90 seconds of no response)
                    console.log('[Server] Client failed 3 heartbeats, terminating connection');
                    client.terminate();
                    clients.delete(client);
                    continue;
                }
            } else {
                // Reset missed count on successful pong
                clientMissedPongs.set(client, 0);
            }
            // Mark as not alive, will be set to true when pong received
            clientAliveMap.set(client, false);
            client.ping();
            console.log('[Server] Sent ping to client');
        }
    }, HEARTBEAT_INTERVAL_MS);

    // Batched broadcast state - accumulate state changes and send periodically
    const BROADCAST_BATCH_INTERVAL_MS = 150; // Batch broadcasts every 150ms
    let pendingTaskStateChanges: Map<string, Task> = new Map();
    let pendingTasksUpdated = false;
    let batchBroadcastTimer: NodeJS.Timeout | null = null;

    // Broadcast to all connected clients
    function broadcast(message: WSMessage): void {
        const data = JSON.stringify(message);
        for (const client of clients) {
            try {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(data);
                }
            } catch (err) {
                console.error('[Server] Error sending to client:', err);
                // Remove broken client from set
                clients.delete(client);
            }
        }
    }

    // Flush batched broadcasts
    function flushBatchedBroadcasts(): void {
        // Send individual task state changes (deduplicated - only latest state per task)
        for (const task of pendingTaskStateChanges.values()) {
            broadcast({ type: 'task:stateChanged', payload: { task } });
        }
        pendingTaskStateChanges.clear();

        // Send tasks:updated only once if flagged
        if (pendingTasksUpdated) {
            broadcast({ type: 'tasks:updated', payload: { tasks: taskSpawner.getAllTasks() } });
            pendingTasksUpdated = false;
        }

        batchBroadcastTimer = null;
    }

    // Schedule a batched broadcast
    function scheduleBatchedBroadcast(): void {
        if (!batchBroadcastTimer) {
            batchBroadcastTimer = setTimeout(flushBatchedBroadcasts, BROADCAST_BATCH_INTERVAL_MS);
        }
    }

    // Queue a task state change for batched broadcast
    function queueTaskStateChange(task: Task): void {
        pendingTaskStateChanges.set(task.id, task);
        scheduleBatchedBroadcast();
    }

    // Queue a tasks:updated broadcast (will be deduplicated)
    function queueTasksUpdated(): void {
        pendingTasksUpdated = true;
        scheduleBatchedBroadcast();
    }

    // Wire up TaskSpawner events
    taskSpawner.on('taskCreated', (task: Task) => {
        broadcast({ type: 'task:created', payload: { task } });
        queueTasksUpdated(); // Batched
    });

    taskSpawner.on('taskStateChanged', (task: Task) => {
        console.log(`[Server] taskStateChanged event: task=${task.id} state=${task.state}`);
        queueTaskStateChange(task); // Batched - deduplicates rapid state changes
    });

    taskSpawner.on('taskOutput', (taskId: string, data: string) => {
        broadcast({ type: 'task:output', payload: { taskId, data } });
    });

    taskSpawner.on('taskRestore', (taskId: string, history: string) => {
        broadcast({ type: 'task:restore', payload: { taskId, history } });
    });

    taskSpawner.on('taskDestroyed', (taskId: string) => {
        broadcast({ type: 'task:destroyed', payload: { taskId } });
        queueTasksUpdated(); // Batched
    });

    taskSpawner.on('tasksUpdated', () => {
        queueTasksUpdated(); // Batched
    });

    taskSpawner.on('taskWaitingInput', (taskId: string, inputType: WaitingInputType, recentOutput: string) => {
        console.log(`[Server] Task ${taskId} waiting for input: ${inputType}`);
        broadcast({
            type: 'task:waitingInput',
            payload: { taskId, inputType, recentOutput }
        });
    });

    // Reconnection events - notify clients about reconnection progress
    taskSpawner.on('reconnectStart', (count: number) => {
        console.log(`[Server] Reconnection started for ${count} tasks`);
        broadcast({
            type: 'server:reconnecting' as WSMessageType,
            payload: { message: `Reconnecting ${count} task(s)...`, count }
        });
    });

    taskSpawner.on('reconnectComplete', (result: { total: number; failed: number; failedIds: string[] }) => {
        console.log(`[Server] Reconnection complete: ${result.total - result.failed}/${result.total} tasks`);
        // Send updated task list after reconnection (immediate, not batched - important for startup)
        broadcast({ type: 'tasks:updated', payload: { tasks: taskSpawner.getAllTasks() } });
    });

    // Wire up SupervisorChat events (handles both auto-analysis and user chat)
    supervisorChat.on('message', (message: ChatMessage) => {
        broadcast({ type: 'supervisor:chat:response' as WSMessageType, payload: { message } });
    });

    supervisorChat.on('typing', (isTyping: boolean) => {
        broadcast({ type: 'supervisor:chat:typing' as WSMessageType, payload: { isTyping } });
    });

    // ===== WebSocket Upgrade Routing =====
    // Using noServer mode so we can selectively handle upgrades.
    // Through the tunnel, Vite's HMR client also tries to connect a WebSocket
    // (because the frontend is served from the same origin). We reject those
    // non-app connections so they don't create noise or compete with the real WS.
    server.on('upgrade', (req, socket, head) => {
        const host = req.headers.host || '';
        const isTunnel = host.includes('.loca.lt') || host.includes('localtunnel') ||
                         host.includes('.ngrok-free.app') || host.includes('.ngrok.io') || host.includes('ngrok');
        const url = new URL(req.url || '/', `http://${host || 'localhost'}`);

        logger.info('WebSocket upgrade request', {
            url: req.url,
            host,
            isTunnel,
            hasToken: url.searchParams.has('token'),
            mobile: url.searchParams.get('mobile'),
        });

        if (isTunnel) {
            const hasToken = url.searchParams.has('token');
            const isMobile = url.searchParams.get('mobile') === '1';

            if (!hasToken && !isMobile) {
                // Vite HMR or other non-app WebSocket — silently reject.
                // HMR isn't needed through the tunnel (mobile users don't need it).
                logger.info('Tunnel WebSocket: rejecting non-app upgrade (likely Vite HMR)', { path: req.url });
                socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
                socket.destroy();
                return;
            }

            logger.info('Tunnel WebSocket: routing to app WSS');
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    });

    // WebSocket connection handling
    wss.on('connection', async (ws: WebSocket, req) => {
        // Check for mobile token auth on query string
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const mobileToken = url.searchParams.get('token');
        const isMobile = url.searchParams.get('mobile') === '1';

        if (isMobile) {
            if (!mobileToken || !tunnelManager.validateToken(mobileToken)) {
                logger.error('Mobile WebSocket rejected: invalid token');
                ws.close(4001, 'Invalid token');
                return;
            }
            logger.info('Mobile client connected via tunnel');
        }

        console.log('[Server] Client connected' + (isMobile ? ' (mobile)' : ''));
        clients.add(ws);
        clientAliveMap.set(ws, true); // Mark as alive on connection

        // Handle pong responses to keep connection alive
        ws.on('pong', () => {
            clientAliveMap.set(ws, true);
            // Debug: log pong received
            console.log('[Server] Pong received from client');
        });

        // If reconnection is in progress, send a status message and wait
        if (taskSpawner.isReconnectInProgress()) {
            console.log('[Server] Reconnection in progress, notifying client...');
            ws.send(JSON.stringify({
                type: 'server:reconnecting',
                payload: { message: 'Reconnecting tasks...' }
            }));
            // Wait for reconnection to complete before sending init
            await taskSpawner.waitForReconnect();
        }

        // Send current state to new client (after reconnection completes)
        const tasks = taskSpawner.getAllTasks();
        const workspaces = workspaceStore.getWorkspaces();
        ws.send(JSON.stringify({
            type: 'init',
            payload: { tasks, workspaces }
        }));

        ws.on('message', async (data: Buffer) => {
            let messageTypeForError: string | undefined;
            try {
                let parsed: unknown;
                try {
                    parsed = JSON.parse(data.toString());
                } catch {
                    logger.error('Invalid JSON in WebSocket message');
                    sendWSError(ws, 'Invalid JSON format', undefined, 'INVALID_JSON');
                    return;
                }

                if (!isValidWSMessage(parsed)) {
                    logger.error('Invalid WebSocket message format or unknown type', { parsed });
                    sendWSError(ws, 'Invalid message format or unknown type', (parsed as Record<string, unknown>)?.type as string, 'INVALID_MESSAGE');
                    return;
                }

                const message = parsed;
                messageTypeForError = message.type;
                // Only log non-frequent message types to avoid spam
                if (message.type !== 'task:input' && message.type !== 'task:resize') {
                    logger.info(`Received message`, { type: message.type });
                }

                const payload = message.payload || {};

                switch (message.type) {
                    case 'task:create': {
                        // Create a new Claude Code CLI instance
                        const { prompt, workspaceId, initialCols, initialRows } = payload as { prompt?: string; workspaceId?: string; initialCols?: number; initialRows?: number };
                        if (!prompt || !workspaceId) {
                            logger.error('task:create requires prompt and workspaceId');
                            sendWSError(ws, 'task:create requires prompt and workspaceId', message.type, 'MISSING_PARAMS');
                            return;
                        }
                        // Validate workspace path
                        const workspaceValidation = validateWorkspacePath(workspaceId);
                        if (!workspaceValidation.valid) {
                            logger.error('Invalid workspace path', { error: workspaceValidation.error });
                            sendWSError(ws, workspaceValidation.error || 'Invalid workspace path', message.type, 'INVALID_WORKSPACE');
                            return;
                        }

                        // Auto-add workspace if it doesn't exist yet
                        const validatedPath = workspaceValidation.data!;
                        if (!workspaceStore.getWorkspace(validatedPath)) {
                            try {
                                const workspace = workspaceStore.addWorkspace(validatedPath);
                                logger.info('Auto-added workspace for new task', { workspaceId: validatedPath });
                                broadcast({ type: 'workspace:created' as WSMessageType, payload: { workspace } });
                            } catch (error) {
                                logger.error('Failed to auto-add workspace', { error });
                                // Continue anyway - task creation shouldn't fail if workspace can't be added
                            }
                        }

                        // Use workspace system prompt if set, otherwise fall back to global rules
                        const workspaceSystemPrompt = workspaceStore.getSystemPrompt(workspaceId);
                        const rules = configStore.getRules();
                        const systemPrompt = workspaceSystemPrompt?.trim() || rules?.trim() || undefined;
                        logger.info(`Creating task with system prompt`, { hasSystemPrompt: !!systemPrompt, source: workspaceSystemPrompt ? 'workspace' : (rules ? 'rules' : 'none') });

                        // Pass initial dimensions if provided
                        try {
                            await taskSpawner.createTask(prompt, validatedPath, systemPrompt, initialCols, initialRows);
                        } catch (err) {
                            const errorMessage = err instanceof Error ? err.message : String(err);
                            logger.error('Failed to create task', { error: errorMessage });
                            if (errorMessage.includes('posix_spawnp')) {
                                sendWSError(
                                    ws,
                                    'Failed to spawn process: posix_spawnp failed. This usually means node-pty is incompatible with your Node.js version. ' +
                                    'If you are using Node.js v25+, run: npm install node-pty@1.2.0-beta.11 && npm install',
                                    message.type,
                                    'SPAWN_FAILED'
                                );
                            } else {
                                sendWSError(ws, `Failed to create task: ${errorMessage}`, message.type, 'TASK_CREATE_FAILED');
                            }
                        }
                        break;
                    }

                    case 'task:select': {
                        // Switch active task (for terminal viewing)
                        const { taskId } = payload as { taskId?: string };
                        if (taskId) {
                            try {
                                taskSpawner.setTaskActive(taskId, true);
                            } catch (error) {
                                const errorMessage = error instanceof Error ? error.message : String(error);
                                logger.error('Failed to activate task', { taskId, error: errorMessage });
                                sendWSError(ws, `Failed to activate task: ${errorMessage}`, message.type, 'TASK_SELECT_FAILED');
                            }
                        }
                        break;
                    }

                    case 'task:input': {
                        // Send input to a task's terminal
                        const { taskId, input } = payload as { taskId?: string; input?: string };
                        if (!taskId || !input) break;
                        // Filter out focus events (ESC [ I and ESC [ O) that confuse Claude's TUI
                        const filteredInput = input
                            .replace(/\x1b\[I/g, '')  // Focus in
                            .replace(/\x1b\[O/g, ''); // Focus out
                        if (filteredInput) {
                            taskSpawner.writeToTask(taskId, filteredInput);
                        }
                        break;
                    }

                    case 'task:resize': {
                        // Resize a task's terminal
                        const { taskId, cols, rows } = payload as { taskId?: string; cols?: number; rows?: number };
                        if (taskId && cols && rows) taskSpawner.resizeTask(taskId, cols, rows);
                        break;
                    }

                    case 'task:destroy': {
                        // Kill and remove a task
                        const { taskId } = payload as { taskId?: string };
                        console.log(`[Server] task:destroy received for taskId: ${taskId}`);
                        if (taskId) {
                            taskSpawner.destroyTask(taskId);
                        } else {
                            console.error('[Server] task:destroy missing taskId');
                        }

                        break;
                    }

                    case 'task:disconnect': {
                        // Disconnect a task (simulate server restart)
                        const { taskId } = payload as { taskId?: string };
                        if (taskId) {
                            taskSpawner.disconnectTask(taskId);
                        }
                        break;
                    }

                    case 'task:clear': {
                        // Clear all tasks
                        taskSpawner.clearAllTasks();
                        break;
                    }

                    case 'task:interrupt': {
                        // Interrupt a running task (send ESC to cancel current operation)
                        const { taskId } = payload as { taskId?: string };
                        if (taskId) taskSpawner.interruptTask(taskId);
                        break;
                    }

                    case 'task:archive': {
                        // Archive a completed task (removes from view)
                        const { taskId } = payload as { taskId?: string };
                        if (taskId) taskSpawner.archiveTask(taskId);
                        break;
                    }

                    case 'task:rename': {
                        // Rename a task (set displayName)
                        const { taskId, displayName } = payload as { taskId?: string; displayName?: string };
                        if (!taskId || displayName === undefined) break;
                        const renamed = taskSpawner.renameTask(taskId, displayName);
                        if (renamed) {
                            broadcast({ type: 'task:stateChanged' as WSMessageType, payload: { tasks: taskSpawner.getAllTasks() } });
                        }
                        break;
                    }

                    case 'task:reconnect': {
                        // Reconnect to a disconnected task
                        const { taskId } = payload as { taskId?: string };
                        if (!taskId) break;
                        try {
                            const task = taskSpawner.reconnectTask(taskId);
                            if (task) {
                                // Ensure reconnected task becomes active so output is streamed
                                // and history is restored immediately.
                                taskSpawner.setTaskActive(taskId, true);
                                broadcast({ type: 'tasks:updated', payload: { tasks: taskSpawner.getAllTasks() } });
                            }
                        } catch (error) {
                            const errorMessage = error instanceof Error ? error.message : String(error);
                            logger.error('Failed to reconnect task', { taskId, error: errorMessage });
                            sendWSError(ws, `Failed to reconnect task: ${errorMessage}`, message.type, 'TASK_RECONNECT_FAILED');
                        }
                        break;
                    }

                    case 'task:revert': {
                        // Revert changes made by a task
                        const { taskId, cleanUntracked } = payload as { taskId?: string; cleanUntracked?: boolean };
                        if (!taskId) break;
                        const result = await taskSpawner.revertTask(taskId, cleanUntracked || false);
                        // Send result back to client
                        ws.send(JSON.stringify({
                            type: 'task:revertResult',
                            payload: { taskId, ...result }
                        }));
                        if (result.success) {
                            broadcast({ type: 'tasks:updated', payload: { tasks: taskSpawner.getAllTasks() } });
                        }
                        break;
                    }

                    case 'task:restore': {
                        // Request terminal history restore
                        const { taskId } = payload as { taskId?: string };
                        if (!taskId) break;
                        const task = taskSpawner.getTask(taskId);
                        if (task && task.outputHistory.length > 0) {
                            const history = task.outputHistory.map(buf => buf.toString('utf8')).join('');
                            ws.send(JSON.stringify({
                                type: 'task:restore',
                                payload: { taskId, history }
                            }));
                        }
                        break;
                    }

                    case 'task:archived:list': {
                        // Get list of archived tasks
                        const archivedTasks = taskSpawner.getArchivedTasks();
                        ws.send(JSON.stringify({
                            type: 'task:archived:list',
                            payload: { tasks: archivedTasks }
                        }));
                        break;
                    }

                    case 'task:archived:restore': {
                        // Restore an archived task back to active state
                        const { taskId } = payload as { taskId?: string };
                        if (!taskId) break;
                        const restoredTask = taskSpawner.restoreArchivedTask(taskId);
                        if (restoredTask) {
                            ws.send(JSON.stringify({
                                type: 'task:archived:restored',
                                payload: { task: restoredTask }
                            }));
                            broadcast({ type: 'tasks:updated', payload: { tasks: taskSpawner.getAllTasks() } });
                        } else {
                            ws.send(JSON.stringify({
                                type: 'task:archived:restoreError',
                                payload: { taskId, error: 'Task not found in archive' }
                            }));
                        }
                        break;
                    }

                    case 'task:archived:continue': {
                        // Continue an archived task - restores and reconnects it
                        const { taskId } = payload as { taskId?: string };
                        if (!taskId) break;
                        const continuedTask = taskSpawner.continueArchivedTask(taskId);
                        if (continuedTask) {
                            ws.send(JSON.stringify({
                                type: 'task:archived:continued',
                                payload: { task: continuedTask }
                            }));
                            broadcast({ type: 'tasks:updated', payload: { tasks: taskSpawner.getAllTasks() } });
                        } else {
                            ws.send(JSON.stringify({
                                type: 'task:archived:continueError',
                                payload: { taskId, error: 'Task not found in archive' }
                            }));
                        }
                        break;
                    }

                    case 'task:archived:delete': {
                        // Permanently delete an archived task
                        const { taskId } = payload as { taskId?: string };
                        if (!taskId) break;
                        const deleted = taskSpawner.deleteArchivedTask(taskId);
                        ws.send(JSON.stringify({
                            type: 'task:archived:deleted',
                            payload: { taskId, success: deleted }
                        }));
                        break;
                    }

                    case 'workspace:create': {
                        // Add a workspace
                        const { path } = payload as { path?: string };
                        if (!path) break;
                        try {
                            const workspace = workspaceStore.addWorkspace(path);
                            broadcast({ type: 'workspace:created' as WSMessageType, payload: { workspace } });
                        } catch (error) {
                            console.error('[Server] Failed to create workspace:', error);
                        }
                        break;
                    }

                    case 'workspace:delete': {
                        // Remove a workspace
                        const { workspaceId } = payload as { workspaceId?: string };
                        if (!workspaceId) break;
                        if (workspaceStore.deleteWorkspace(workspaceId)) {
                            broadcast({ type: 'workspace:deleted' as WSMessageType, payload: { workspaceId } });
                        }
                        break;
                    }

                    case 'workspace:reorder': {
                        // Reorder workspaces
                        const { fromIndex, toIndex } = payload as { fromIndex?: number; toIndex?: number };
                        if (typeof fromIndex !== 'number' || typeof toIndex !== 'number') break;
                        if (workspaceStore.reorderWorkspaces(fromIndex, toIndex)) {
                            // Broadcast updated workspace list to all clients
                            const workspaces = workspaceStore.getWorkspaces();
                            broadcast({ type: 'workspace:reordered' as WSMessageType, payload: { workspaces } });
                        }
                        break;
                    }

                    case 'workspace:rename': {
                        // Rename a workspace (set displayName)
                        const { workspaceId, displayName } = payload as { workspaceId?: string; displayName?: string };
                        if (!workspaceId || displayName === undefined) break;
                        if (workspaceStore.renameWorkspace(workspaceId, displayName)) {
                            const workspaces = workspaceStore.getWorkspaces();
                            broadcast({ type: 'workspace:updated' as WSMessageType, payload: { workspaces } });
                        }
                        break;
                    }

                    case 'workspace:openFolder': {
                        // Open workspace folder in native file explorer
                        const { workspaceId } = payload as { workspaceId?: string };
                        if (!workspaceId) break;
                        const { exec } = await import('child_process');
                        const platform = process.platform;
                        let command: string;
                        if (platform === 'darwin') {
                            command = `open "${workspaceId}"`;
                        } else if (platform === 'win32') {
                            command = `explorer "${workspaceId}"`;
                        } else {
                            command = `xdg-open "${workspaceId}"`;
                        }
                        exec(command, (error) => {
                            if (error) {
                                logger.error('Failed to open folder', { workspaceId, error: error.message });
                            }
                        });
                        break;
                    }

                    case 'workspace:openTerminal': {
                        // Open terminal at workspace folder
                        const { workspaceId } = payload as { workspaceId?: string };
                        if (!workspaceId) break;
                        const { exec } = await import('child_process');
                        const platform = process.platform;
                        let command: string;
                        if (platform === 'darwin') {
                            // Use AppleScript to open Terminal.app at the specified directory
                            command = `osascript -e 'tell application "Terminal" to do script "cd \\"${workspaceId}\\""' -e 'tell application "Terminal" to activate'`;
                        } else if (platform === 'win32') {
                            command = `start cmd /K "cd /d "${workspaceId}""`;
                        } else {
                            // Try common Linux terminal emulators
                            command = `x-terminal-emulator --working-directory="${workspaceId}" 2>/dev/null || gnome-terminal --working-directory="${workspaceId}" 2>/dev/null || xterm -e "cd '${workspaceId}' && bash"`;
                        }
                        exec(command, (error) => {
                            if (error) {
                                logger.error('Failed to open terminal', { workspaceId, error: error.message });
                            }
                        });
                        break;
                    }

                    case 'workspace:systemPrompt:get': {
                        // Get system prompt for a workspace
                        const { workspaceId } = payload as { workspaceId?: string };
                        if (!workspaceId) break;
                        const systemPrompt = workspaceStore.getSystemPrompt(workspaceId);
                        ws.send(JSON.stringify({
                            type: 'workspace:systemPrompt',
                            payload: { workspaceId, systemPrompt: systemPrompt || '' }
                        }));
                        break;
                    }

                    case 'workspace:systemPrompt:set': {
                        // Set system prompt for a workspace
                        const { workspaceId, systemPrompt } = payload as { workspaceId?: string; systemPrompt?: string };
                        if (!workspaceId) break;
                        const success = workspaceStore.setSystemPrompt(workspaceId, systemPrompt || undefined);
                        if (success) {
                            // Broadcast updated workspace list to all clients
                            const workspaces = workspaceStore.getWorkspaces();
                            broadcast({ type: 'workspace:updated' as WSMessageType, payload: { workspaces } });
                        }
                        ws.send(JSON.stringify({
                            type: 'workspace:systemPrompt:result',
                            payload: { workspaceId, success }
                        }));
                        break;
                    }

                    case 'workspace:recent:list': {
                        // Get list of recent workspaces (removed but still exist on disk)
                        const recentWorkspaces = workspaceStore.getRecentWorkspaces();
                        ws.send(JSON.stringify({
                            type: 'workspace:recent:list',
                            payload: { recentWorkspaces }
                        }));
                        break;
                    }

                    case 'workspace:recent:clear': {
                        // Clear a specific recent workspace or all recent workspaces
                        const { workspaceId } = payload as { workspaceId?: string };
                        if (workspaceId) {
                            workspaceStore.clearRecentWorkspace(workspaceId);
                        } else {
                            workspaceStore.clearAllRecentWorkspaces();
                        }
                        // Send updated list back
                        const recentWorkspaces = workspaceStore.getRecentWorkspaces();
                        ws.send(JSON.stringify({
                            type: 'workspace:recent:list',
                            payload: { recentWorkspaces }
                        }));
                        break;
                    }

                    case 'git:push': {
                        // Create a task to push changes to GitHub
                        const { workspaceId } = payload as { workspaceId?: string };
                        if (!workspaceId) {
                            logger.error('git:push requires workspaceId');
                            sendWSError(ws, 'git:push requires workspaceId', message.type, 'MISSING_PARAMS');
                            return;
                        }
                        // Validate workspace path
                        const workspaceValidation = validateWorkspacePath(workspaceId);
                        if (!workspaceValidation.valid) {
                            logger.error('Invalid workspace path', { error: workspaceValidation.error });
                            sendWSError(ws, workspaceValidation.error || 'Invalid workspace path', message.type, 'INVALID_WORKSPACE');
                            return;
                        }

                        // Auto-add workspace if it doesn't exist yet
                        const validatedPath = workspaceValidation.data!;
                        if (!workspaceStore.getWorkspace(validatedPath)) {
                            try {
                                const workspace = workspaceStore.addWorkspace(validatedPath);
                                logger.info('Auto-added workspace for git push task', { workspaceId: validatedPath });
                                broadcast({ type: 'workspace:created' as WSMessageType, payload: { workspace } });
                            } catch (error) {
                                logger.error('Failed to auto-add workspace', { error });
                            }
                        }

                        // Create a task to push to GitHub
                        const pushPrompt = 'Push the latest changes to GitHub. First check git status to see what needs to be committed. If there are uncommitted changes, create a commit with an appropriate message, then push to the remote repository. If there are no changes, just confirm that everything is already up to date.';
                        const rules = configStore.getRules();
                        const systemPrompt = rules?.trim() || undefined;
                        logger.info('Creating git push task', { workspaceId });
                        taskSpawner.createTask(pushPrompt, validatedPath, systemPrompt);
                        break;
                    }

                    case 'supervisor:action': {
                        // Execute a supervisor-suggested action
                        const { taskId, action } = payload as { taskId?: string; action?: SuggestedAction };
                        if (taskId && action) supervisorChat.executeAction(taskId, action);
                        break;
                    }

                    case 'supervisor:analyze': {
                        // Manually request task analysis (triggers auto-analysis)
                        const { taskId } = payload as { taskId?: string };
                        if (!taskId) break;
                        const task = taskSpawner.getTask(taskId);
                        if (task) {
                            await supervisorChat.autoAnalyzeTask({
                                id: task.id,
                                prompt: task.prompt,
                                state: task.state,
                                workspaceId: task.workspaceId,
                                createdAt: task.createdAt,
                                lastActivity: task.lastActivity
                            });
                        }
                        break;
                    }

                    case 'supervisor:chat:message': {
                        // User sends a chat message to the supervisor
                        const { content, taskId, workspaceId } = payload as { content?: string; taskId?: string; workspaceId?: string };
                        if (!content) {
                            console.error('[Server] supervisor:chat:message requires content');
                            return;
                        }
                        console.log(`[Server] supervisor:chat:message workspaceId=${workspaceId || 'none'}`);
                        await supervisorChat.sendMessage(content, taskId, workspaceId);
                        break;
                    }

                    case 'supervisor:chat:history': {
                        // Request chat history (optionally scoped to a workspace)
                        const { workspaceId: histWorkspaceId } = (payload || {}) as { workspaceId?: string };
                        const history = histWorkspaceId
                            ? supervisorChat.getWorkspaceHistory(histWorkspaceId)
                            : supervisorChat.getHistory();
                        console.log(`[Server] supervisor:chat:history workspaceId=${histWorkspaceId || 'all'} messages=${history.length}`);
                        ws.send(JSON.stringify({
                            type: 'supervisor:chat:history',
                            payload: { messages: history, workspaceId: histWorkspaceId }
                        }));
                        break;
                    }

                    case 'supervisor:chat:clear': {
                        // Clear chat history
                        supervisorChat.clearHistory();
                        broadcast({ type: 'supervisor:chat:history' as WSMessageType, payload: { messages: [] } });
                        break;
                    }

                    case 'tunnel:status': {
                        // Request tunnel status
                        ws.send(JSON.stringify({
                            type: 'tunnel:status',
                            payload: tunnelManager.getStatus()
                        }));
                        break;
                    }
                }
            } catch (err) {
                logger.error('Error handling message', {
                    type: messageTypeForError,
                    error: err instanceof Error ? err.message : String(err),
                    stack: err instanceof Error ? err.stack : undefined
                });
                sendWSError(ws, 'Internal server error processing request', messageTypeForError, 'INTERNAL_ERROR');
            }
        });

        ws.on('close', (code: number, reason: Buffer) => {
            const reasonStr = reason.toString() || 'no reason';
            console.log(`[Server] Client disconnected - code: ${code}, reason: ${reasonStr}`);
            clients.delete(ws);
        });

        ws.on('error', (error: Error) => {
            console.error('[Server] WebSocket error:', error.message);
        });
    });

    // REST API routes
    app.get('/api/health', (_req, res) => {
        res.json({ status: 'ok' });
    });

    // Plugin API routes
    app.get('/api/plugins', (_req, res) => {
        try {
            const plugins = pluginManager.getAllAvailablePlugins(pluginsDir);
            res.json({ success: true, plugins });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            res.status(500).json({ success: false, error: message });
        }
    });

    // Enable a plugin
    app.post('/api/plugins/:name/enable', async (req, res) => {
        try {
            const { name } = req.params;
            logger.info(`[API] Enabling plugin: ${name}`);

            configStore.setPluginEnabled(name, true);

            // Reload plugins to activate the newly enabled plugin
            await pluginManager.discoverPlugins(pluginsDir);
            pluginManager.registerRoutes(app);

            res.json({ success: true, message: `Plugin ${name} enabled successfully` });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error(`[API] Error enabling plugin:`, { error });
            res.status(500).json({ success: false, error: message });
        }
    });

    // Disable a plugin
    app.post('/api/plugins/:name/disable', async (req, res) => {
        try {
            const { name } = req.params;
            logger.info(`[API] Disabling plugin: ${name}`);

            configStore.setPluginEnabled(name, false);

            // Note: Disabling requires a server restart to fully unload the plugin
            // For now, we just update the config
            res.json({
                success: true,
                message: `Plugin ${name} disabled. Restart server to fully unload.`,
                requiresRestart: true
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error(`[API] Error disabling plugin:`, { error });
            res.status(500).json({ success: false, error: message });
        }
    });

    // HAI Proxy Plugin API routes (for frontend Settings)
    app.post('/api/hyperspace-proxy/test', async (req, res) => {
        try {
            const { proxyUrl, apiKey } = req.body;
            if (!proxyUrl || !apiKey) {
                return res.status(400).json({
                    success: false,
                    error: 'proxyUrl and apiKey are required'
                });
            }

            // Test connection by hitting the models endpoint
            let modelsUrl = proxyUrl;
            if (!modelsUrl.endsWith('/')) {
                modelsUrl += '/';
            }
            if (!modelsUrl.endsWith('anthropic/')) {
                modelsUrl += 'anthropic/';
            }
            modelsUrl += 'v1/models';

            const response = await fetch(modelsUrl, {
                method: 'GET',
                headers: { 'x-api-key': apiKey },
                signal: AbortSignal.timeout(5000)
            });

            if (response.ok) {
                res.json({ success: true });
            } else {
                res.status(500).json({
                    success: false,
                    error: 'HAI proxy is not responding or credentials are invalid'
                });
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error('Failed to test HAI proxy connection', { error: message });
            res.status(500).json({ success: false, error: message });
        }
    });

    app.post('/api/hyperspace-proxy/models', async (req, res) => {
        try {
            const { proxyUrl, apiKey } = req.body;
            if (!proxyUrl || !apiKey) {
                return res.status(400).json({
                    success: false,
                    error: 'proxyUrl and apiKey are required'
                });
            }

            // Fetch models from the HAI proxy
            let modelsUrl = proxyUrl;
            if (!modelsUrl.endsWith('/')) {
                modelsUrl += '/';
            }
            if (!modelsUrl.endsWith('anthropic/')) {
                modelsUrl += 'anthropic/';
            }
            modelsUrl += 'v1/models';

            const response = await fetch(modelsUrl, {
                method: 'GET',
                headers: { 'x-api-key': apiKey },
                signal: AbortSignal.timeout(5000)
            });

            if (!response.ok) {
                const errorText = await response.text();
                return res.status(500).json({
                    success: false,
                    error: `Failed to fetch models: ${response.status} ${errorText}`
                });
            }

            const data = await response.json();

            // Transform the response to match frontend expectations
            // Anthropic API returns { data: [...models...] }
            const models = data.data?.map((model: any) => ({
                id: model.id,
                name: model.display_name || model.id,
            })) || [];

            res.json({ success: true, models });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error('Failed to fetch HAI proxy models', { error: message });
            res.status(500).json({ success: false, error: message });
        }
    });

    // ===== Tunnel Management Routes =====
    app.post('/api/tunnel/start', async (_req, res) => {
        try {
            logger.info('Starting tunnel via API');
            const status = await tunnelManager.start();
            res.json(status);
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            logger.error('Failed to start tunnel', { error: errorMsg });
            res.status(500).json({ error: errorMsg });
        }
    });

    app.post('/api/tunnel/stop', async (_req, res) => {
        try {
            logger.info('Stopping tunnel via API');
            await tunnelManager.stop();
            res.json({ active: false });
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            logger.error('Failed to stop tunnel', { error: errorMsg });
            res.status(500).json({ error: errorMsg });
        }
    });

    app.get('/api/tunnel/status', (_req, res) => {
        res.json(tunnelManager.getStatus());
    });

    // ===== Voice Agent API =====

    // Streaming voice message endpoint - streams text chunks and audio in real-time
    app.get('/api/voice/message/stream', async (req, res) => {
        try {
            const transcript = typeof req.query.transcript === 'string' ? req.query.transcript : undefined;
            const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
            const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
            const clientId = typeof req.query.clientId === 'string' ? req.query.clientId : undefined;

            if (!transcript || typeof transcript !== 'string') {
                return res.status(400).json({ error: 'Missing or invalid transcript' });
            }

            logger.info('[Voice API] Processing transcript (streaming)', { transcript, workspaceId, clientId });

            // Set up Server-Sent Events
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            // Initialize ElevenLabs TTS streaming session
            const elevenlabsKey = process.env.ELEVENLABS_API_KEY;
            let ttsSession: any = null;

            logger.info('[Voice API] ElevenLabs API key present:', !!elevenlabsKey);

            if (elevenlabsKey) {
                logger.info('[Voice API] Creating ElevenLabs streaming session...');
                const { ElevenLabsTTS } = await import('./elevenlabs-tts.js');
                const tts = new ElevenLabsTTS(elevenlabsKey);
                ttsSession = tts.createStreamingSession();

                // Forward audio chunks to client
                ttsSession.on('audio', (audioChunk: Buffer) => {
                    logger.info('[Voice API] Received audio chunk, length:', audioChunk.length);
                    const base64Audio = audioChunk.toString('base64');
                    res.write(`event: audio\ndata: ${JSON.stringify({ audio: base64Audio })}\n\n`);
                });

                ttsSession.on('error', (error: Error) => {
                    logger.error('[Voice API] TTS error', { error });
                });

                ttsSession.on('ready', () => {
                    logger.info('[Voice API] ElevenLabs TTS session ready');
                });

                // Wait for TTS to be ready
                logger.info('[Voice API] Waiting for TTS session to be ready...');
                await new Promise((resolve) => {
                    ttsSession.once('ready', resolve);
                });
                logger.info('[Voice API] TTS session is ready!');
            }

            // Start processing with callbacks
            await voiceSupervisor.processVoiceMessageStreaming(
                transcript,
                workspaceId,
                userId,
                {
                    onTextChunk: (text: string) => {
                        logger.info('[Voice API] Text chunk:', text);
                        // Send text chunk to client
                        res.write(`event: text\ndata: ${JSON.stringify({ text })}\n\n`);

                        // Send to TTS for streaming audio generation
                        if (ttsSession) {
                            logger.info('[Voice API] Sending text to TTS:', text);
                            ttsSession.sendText(text);
                        }
                    },
                    onComplete: (response: any) => {
                        // Flush TTS and close session
                        if (ttsSession) {
                            ttsSession.flush();
                            setTimeout(() => {
                                ttsSession.close();
                            }, 1000); // Give time for final audio chunks
                        }

                        // Send completion event
                        res.write(`event: complete\ndata: ${JSON.stringify(response)}\n\n`);
                        res.end();
                    },
                    onError: (error: Error) => {
                        logger.error('[Voice API] Processing error', { error });
                        if (ttsSession) {
                            ttsSession.close();
                        }
                        res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
                        res.end();
                    }
                }
            );

        } catch (error) {
            logger.error('[Voice API] Error in streaming', { error });
            res.write(`event: error\ndata: ${JSON.stringify({ error: 'Processing error' })}\n\n`);
            res.end();
        }
    });

    // Voice message endpoint - processes voice input with voice-optimized responses (non-streaming fallback)
    app.post('/api/voice/message', async (req, res) => {
        try {
            const { transcript, workspaceId, userId, clientId } = req.body;

            if (!transcript || typeof transcript !== 'string') {
                return res.status(400).json({ error: 'Missing or invalid transcript' });
            }

            logger.info('[Voice API] Processing transcript', { transcript, workspaceId, clientId });

            const response = await voiceSupervisor.processVoiceMessage(
                transcript,
                workspaceId,
                userId
            );

            logger.info('[Voice API] Response generated', { action: response.action });
            res.json(response);
        } catch (error) {
            logger.error('[Voice API] Error processing message', { error });
            res.status(500).json({
                error: 'Failed to process voice message',
                text: "Sorry, something went wrong. Try again?",
                action: 'error'
            });
        }
    });

    // Get voice agent system prompt
    app.get('/api/voice-agent/system-prompt', async (req, res) => {
        try {
            const systemPrompt = voiceSupervisor.getSystemPrompt();
            res.json({ systemPrompt });
        } catch (error) {
            logger.error('[Voice API] Error getting system prompt', { error });
            res.status(500).json({ error: 'Failed to get system prompt' });
        }
    });

    // Update voice agent system prompt
    app.post('/api/voice-agent/system-prompt', async (req, res) => {
        try {
            const { systemPrompt } = req.body;

            if (!systemPrompt || typeof systemPrompt !== 'string') {
                return res.status(400).json({ error: 'Missing or invalid systemPrompt' });
            }

            voiceSupervisor.setSystemPrompt(systemPrompt);
            logger.info('[Voice API] System prompt updated');
            res.json({ success: true });
        } catch (error) {
            logger.error('[Voice API] Error updating system prompt', { error });
            res.status(500).json({ error: 'Failed to update system prompt' });
        }
    });

    // Get available tools for voice agent
    app.get('/api/voice-agent/tools', async (req, res) => {
        try {
            const tools = voiceSupervisor.getAvailableTools();
            res.json({ tools });
        } catch (error) {
            logger.error('[Voice API] Error getting tools', { error });
            res.status(500).json({ error: 'Failed to get tools' });
        }
    });

    // Voice agent page route
    app.get('/voice', (req, res) => {
        let token = req.query.token as string;

        if (!token) {
            const host = req.headers.host || '';
            const tunnelStatus = tunnelManager.getStatus();

            if (isTunnelHost(host) && tunnelStatus.active && tunnelStatus.token) {
                token = tunnelStatus.token;
            } else {
                res.status(401).send('Access denied: Missing token');
                return;
            }
        }

        // Allow local tokens (starting with 'local-') or validate tunnel tokens
        const isLocalToken = token.startsWith('local-');
        if (!isLocalToken && !tunnelManager.validateToken(token)) {
            res.status(401).send('Access denied: Invalid or expired token');
            return;
        }

        // Use WebSocket URL from request
        const protocol = req.protocol === 'https' ? 'wss' : 'ws';
        const host = req.get('host');
        const wsUrl = `${protocol}://${host}`;

        // Get Deepgram API key from config
        const deepgramApiKey = configStore.getConfig().deepgramApiKey || '';

        const html = getVoiceAgentPageHtml(wsUrl, token, deepgramApiKey);
        logger.info('[Voice Agent] Page served', { hasToken: !!token, hasDeepgramKey: !!deepgramApiKey });
        res.send(html);
    });

    // Send voice announcements via WebSocket
    voiceSupervisor.on('voice:announce', (announcement) => {
        logger.info('[Voice Supervisor] Broadcasting announcement', {
            text: announcement.text,
            taskId: announcement.taskId
        });
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    type: 'voice_announcement',
                    ...announcement
                }));
            }
        });
    });

    // ===== Mobile Route (legacy redirect) =====
    // Old /mobile route now redirects to the React app root with the token.
    // The responsive React frontend handles mobile layout automatically.
    app.get('/mobile', (req, res) => {
        let token = req.query.token as string;

        if (!token) {
            const host = req.headers.host || '';
            const tunnelStatus = tunnelManager.getStatus();

            if (isTunnelHost(host) && tunnelStatus.active && tunnelStatus.token) {
                token = tunnelStatus.token;
            } else {
                res.status(401).send('Access denied: Missing token');
                return;
            }
        }

        if (!tunnelManager.validateToken(token)) {
            res.status(401).send('Access denied: Invalid or expired token');
            return;
        }

        // Redirect to the React app with the auth token
        logger.info('Redirecting /mobile to React app', { hasToken: !!token });
        res.redirect(`/?token=${token}`);
    });

    // ===== ElevenLabs TTS Route =====
    const ELEVENLABS_VOICES: Record<string, string> = {
        charlotte: 'XB0fDUnXU5powFXDhCwa',
        verity: 'oW8bn5YtBB89X2nJ0DT9',
        george: 'JBFqnCBsd6RMkjVDRZzb',
        brian: 'nPczCjzI2devNBz1zQrb',
        jessica: 'cgSgspJ2msm6clMCkdEp',
        daisy: 'DYAWdnlYLnZyj3yWpS75',
    };

    function sanitizeTtsText(text: string): string {
        return text
            // Remove markdown headings
            .replace(/#{1,6}\s/g, '')
            // Remove bold/italic markers
            .replace(/\*\*(.+?)\*\*/g, '$1')
            .replace(/\*(.+?)\*/g, '$1')
            // Remove inline code
            .replace(/`(.+?)`/g, '$1')
            // Remove code blocks
            .replace(/```[\s\S]*?```/g, '')
            // Remove links, keep text
            .replace(/\[(.+?)\]\(.+?\)/g, '$1')
            // Remove common emojis/symbols that sound odd when spoken
            .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
            // Collapse multiple newlines
            .replace(/\n{2,}/g, '. ')
            .replace(/\n/g, ' ')
            // Collapse whitespace
            .replace(/\s{2,}/g, ' ')
            .trim();
    }

    app.post('/api/tts', async (req, res) => {
        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!apiKey) {
            logger.error('ElevenLabs API key not configured');
            res.status(500).json({ error: 'TTS not configured: missing ELEVENLABS_API_KEY' });
            return;
        }

        const { text, voice } = req.body as { text?: string; voice?: string };
        if (!text || typeof text !== 'string') {
            res.status(400).json({ error: 'Missing or invalid "text" field' });
            return;
        }

        const voiceName = (voice || 'charlotte').toLowerCase();
        const voiceId = ELEVENLABS_VOICES[voiceName];
        if (!voiceId) {
            res.status(400).json({ error: `Unknown voice "${voice}". Available: ${Object.keys(ELEVENLABS_VOICES).join(', ')}` });
            return;
        }

        const cleanText = sanitizeTtsText(text);
        if (!cleanText) {
            res.status(400).json({ error: 'Text is empty after sanitization' });
            return;
        }

        logger.info('TTS request', { voice: voiceName, textLength: cleanText.length });

        try {
            const elevenLabsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
                method: 'POST',
                headers: {
                    'xi-api-key': apiKey,
                    'Content-Type': 'application/json',
                    'Accept': 'audio/mpeg',
                },
                body: JSON.stringify({
                    text: cleanText,
                    model_id: 'eleven_multilingual_v2',
                    voice_settings: {
                        stability: 0.5,
                        similarity_boost: 0.75,
                    },
                }),
            });

            if (!elevenLabsRes.ok) {
                const errBody = await elevenLabsRes.text();
                logger.error('ElevenLabs API error', { status: elevenLabsRes.status, body: errBody });
                res.status(elevenLabsRes.status).json({ error: `ElevenLabs API error: ${elevenLabsRes.status}`, detail: errBody });
                return;
            }

            const audioBuffer = Buffer.from(await elevenLabsRes.arrayBuffer());
            logger.info('TTS response', { audioBytes: audioBuffer.length });

            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Content-Length', audioBuffer.length);
            res.send(audioBuffer);
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            logger.error('TTS fetch failed', { error: errorMsg });
            res.status(500).json({ error: 'TTS request failed', detail: errorMsg });
        }
    });

    // Get available ElevenLabs voices
    app.get('/api/elevenlabs/voices', async (req, res) => {
        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!apiKey) {
            logger.error('ElevenLabs API key not configured');
            res.status(500).json({ error: 'TTS not configured: missing ELEVENLABS_API_KEY' });
            return;
        }

        try {
            const { ElevenLabsTTS } = await import('./elevenlabs-tts.js');
            const tts = new ElevenLabsTTS(apiKey);
            const voices = await tts.getVoices();

            logger.info('Fetched ElevenLabs voices', { count: voices.length });
            res.json({ voices });
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            logger.error('Failed to fetch voices', { error: errorMsg });
            res.status(500).json({ error: 'Failed to fetch voices', detail: errorMsg });
        }
    });

    // Get preview audio for a specific voice
    app.get('/api/elevenlabs/voices/:voiceId/preview', async (req, res) => {
        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!apiKey) {
            logger.error('ElevenLabs API key not configured');
            res.status(500).json({ error: 'TTS not configured: missing ELEVENLABS_API_KEY' });
            return;
        }

        const { voiceId } = req.params;
        const { sampleId } = req.query;

        if (!voiceId) {
            res.status(400).json({ error: 'Missing voiceId parameter' });
            return;
        }

        try {
            const { ElevenLabsTTS } = await import('./elevenlabs-tts.js');
            const tts = new ElevenLabsTTS(apiKey);
            const audioBuffer = await tts.getVoicePreview(voiceId, sampleId as string | undefined);

            logger.info('Voice preview generated', { voiceId, audioBytes: audioBuffer.length });

            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Content-Length', audioBuffer.length);
            res.send(audioBuffer);
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            logger.error('Failed to generate voice preview', { voiceId, error: errorMsg });
            res.status(500).json({ error: 'Failed to generate voice preview', detail: errorMsg });
        }
    });

    // Usage tracking — receives the unique user ID from the frontend
    app.post('/api/user-id', (req, res) => {
        const { userId } = req.body as { userId?: string };
        if (userId && typeof userId === 'string' && userId.length > 0) {
            setUserId(userId);
        }
        res.json({ ok: true });
    });

    // Image upload configuration
    const uploadsDir = join(basePath || process.cwd(), 'uploads');
    if (!existsSync(uploadsDir)) {
        mkdirSync(uploadsDir, { recursive: true });
    }

    const storage = multer.diskStorage({
        destination: (_req, _file, cb) => {
            cb(null, uploadsDir);
        },
        filename: (_req, file, cb) => {
            // Generate unique filename with timestamp
            const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
            const ext = file.originalname.split('.').pop() || 'png';
            cb(null, `image-${uniqueSuffix}.${ext}`);
        }
    });

    const upload = multer({
        storage,
        limits: { fileSize: 20 * 1024 * 1024 }, // 20MB limit
        fileFilter: (_req, file, cb) => {
            // Allow common image types
            const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
            if (allowedTypes.includes(file.mimetype)) {
                cb(null, true);
            } else {
                cb(new Error(`Invalid file type: ${file.mimetype}. Only images are allowed.`));
            }
        }
    });

    // Image upload endpoint
    app.post('/api/upload/image', upload.single('image'), (req, res) => {
        if (!req.file) {
            return res.status(400).json({ error: 'No image file provided' });
        }
        const filePath = join(uploadsDir, req.file.filename);
        console.log(`[Server] Image uploaded: ${filePath}`);
        res.json({
            success: true,
            filePath,
            filename: req.file.filename,
            originalName: req.file.originalname,
            size: req.file.size,
            mimetype: req.file.mimetype
        });
    });

    // Delete uploaded image endpoint
    app.delete('/api/upload/image/:filename', (req, res) => {
        const { filename } = req.params;
        // Validate filename to prevent directory traversal
        if (filename.includes('/') || filename.includes('..')) {
            return res.status(400).json({ error: 'Invalid filename' });
        }
        const filePath = join(uploadsDir, filename);
        if (existsSync(filePath)) {
            try {
                unlinkSync(filePath);
                console.log(`[Server] Image deleted: ${filePath}`);
                res.json({ success: true });
            } catch (error) {
                console.error(`[Server] Error deleting image: ${error}`);
                res.status(500).json({ error: 'Failed to delete image' });
            }
        } else {
            res.status(404).json({ error: 'Image not found' });
        }
    });

    // Cleanup old uploads (files older than 24 hours)
    const cleanupOldUploads = () => {
        try {
            const files = readdirSync(uploadsDir);
            const now = Date.now();
            const maxAge = 24 * 60 * 60 * 1000; // 24 hours
            for (const file of files) {
                const filePath = join(uploadsDir, file);
                try {
                    const timestamp = parseInt(file.split('-')[1] || '0', 10);
                    if (timestamp && now - timestamp > maxAge) {
                        unlinkSync(filePath);
                        console.log(`[Server] Cleaned up old upload: ${file}`);
                    }
                } catch {
                    // Ignore files that can't be parsed
                }
            }
        } catch (error) {
            console.error('[Server] Error cleaning up uploads:', error);
        }
    };
    // Run cleanup on startup and every hour
    cleanupOldUploads();
    setInterval(cleanupOldUploads, 60 * 60 * 1000);

    // Backend status endpoint - check which backend is configured and its status
    app.get('/api/backend/status', async (_req, res) => {
        const currentBackend = configStore.getBackend();
        let status: { installed: boolean; version?: string; error?: string; serverRunning?: boolean };

        try {
            if (currentBackend === 'opencode') {
                // Check OpenCode installation
                const { execSync } = await import('child_process');
                try {
                    const version = execSync('opencode --version', { encoding: 'utf8', timeout: 5000 }).trim();

                    // Check if server is running
                    let serverRunning = false;
                    const port = configStore.getOpencodePort();
                    try {
                        const response = await fetch(`http://127.0.0.1:${port}/global/health`, {
                            signal: AbortSignal.timeout(2000)
                        });
                        serverRunning = response.ok;
                    } catch {
                        serverRunning = false;
                    }

                    status = { installed: true, version, serverRunning };
                } catch {
                    status = { installed: false, error: 'OpenCode is not installed. Install from: https://opencode.ai' };
                }
            } else {
                // Check Claude Code installation
                const { execSync } = await import('child_process');
                try {
                    const version = execSync('claude --version', { encoding: 'utf8', timeout: 5000 }).trim();
                    status = { installed: true, version };
                } catch {
                    status = { installed: false, error: 'Claude Code is not installed. Install from: https://claude.ai/code' };
                }
            }
        } catch (error) {
            status = { installed: false, error: 'Failed to check backend status' };
        }

        res.json({
            backend: currentBackend,
            ...status,
            availableBackends: ['claude-code', 'opencode']
        });
    });

    // System stats endpoint for CPU and memory monitoring
    let lastCpuInfo = os.cpus();
    let lastCpuTime = Date.now();

    app.get('/api/system/stats', (_req, res) => {
        const currentCpuInfo = os.cpus();
        const currentTime = Date.now();

        // Calculate CPU usage since last call
        let totalIdleDiff = 0;
        let totalTickDiff = 0;

        for (let i = 0; i < currentCpuInfo.length; i++) {
            const currentCpu = currentCpuInfo[i];
            const lastCpu = lastCpuInfo[i] || currentCpu;

            const currentTotal = currentCpu.times.user + currentCpu.times.nice +
                currentCpu.times.sys + currentCpu.times.idle + currentCpu.times.irq;
            const lastTotal = lastCpu.times.user + lastCpu.times.nice +
                lastCpu.times.sys + lastCpu.times.idle + lastCpu.times.irq;

            totalIdleDiff += currentCpu.times.idle - lastCpu.times.idle;
            totalTickDiff += currentTotal - lastTotal;
        }

        // Update for next call
        lastCpuInfo = currentCpuInfo;
        lastCpuTime = currentTime;

        // Calculate CPU percentage
        const cpuUsage = totalTickDiff > 0
            ? Math.round(100 - (totalIdleDiff / totalTickDiff * 100))
            : 0;

        // Get memory info
        const totalMemory = os.totalmem();
        const freeMemory = os.freemem();
        const usedMemory = totalMemory - freeMemory;

        res.json({
            cpu: Math.max(0, Math.min(100, cpuUsage)),
            memory: {
                used: usedMemory,
                total: totalMemory,
                percent: Math.round((usedMemory / totalMemory) * 100)
            }
        });
    });

    app.get('/api/tasks', (_req, res) => {
        res.json(taskSpawner.getAllTasks());
    });

    // Poll endpoint for task status - returns stored state (Stop hook manages transitions)
    app.get('/api/tasks/:taskId/status', (req, res) => {
        const { taskId } = req.params;

        const state = taskSpawner.getTaskState(taskId);

        if (!state) {
            return res.status(404).json({ error: 'Task not found' });
        }

        const task = taskSpawner.getTask(taskId);

        res.json({
            id: taskId,
            state,
            lastActivity: task?.lastActivity
        });
    });

    // Debug endpoint for task output analysis
    app.get('/api/tasks/:taskId/debug', (req, res) => {
        const { taskId } = req.params;
        const task = taskSpawner.getTask(taskId);

        if (!task) {
            return res.status(404).json({ error: 'Task not found' });
        }

        // Get the raw output for debugging
        const recentOutput = taskSpawner.getRecentOutputForDebug(taskId, 2048);

        res.json({
            taskId,
            state: task.state,
            outputLength: recentOutput.length,
            last200Chars: recentOutput.slice(-200),
            lastActivity: task.lastActivity
        });
    });

    app.get('/api/workspaces', (_req, res) => {
        res.json({ workspaces: workspaceStore.getWorkspaces() });
    });

    // File explorer endpoint - list files and directories for a workspace
    app.get('/api/workspaces/files', async (req, res) => {
        const workspacePath = req.query.workspace as string;
        const subPath = (req.query.path as string) || '';

        if (!workspacePath) {
            return res.status(400).json({ error: 'workspace query parameter is required' });
        }

        // Resolve the target directory
        const targetDir = subPath ? join(workspacePath, subPath) : workspacePath;

        // Security: ensure the resolved path is within the workspace
        const resolvedTarget = resolve(targetDir);
        const resolvedWorkspace = resolve(workspacePath);
        if (!resolvedTarget.startsWith(resolvedWorkspace)) {
            return res.status(403).json({ error: 'Path traversal not allowed' });
        }

        if (!existsSync(resolvedTarget)) {
            return res.status(404).json({ error: 'Directory not found' });
        }

        // Directories to skip entirely
        const IGNORED_DIRS = new Set([
            'node_modules', '.git', '.svn', '.hg', '__pycache__',
            '.next', '.nuxt', 'dist', 'build', '.cache', '.parcel-cache',
            'coverage', '.nyc_output', '.tox', '.venv', 'venv',
            '.idea', '.vscode', '.vs', 'vendor', 'target',
            '.terraform', '.serverless', '.angular'
        ]);

        // Files to skip
        const IGNORED_FILES = new Set([
            '.DS_Store', 'Thumbs.db', 'desktop.ini'
        ]);

        try {
            const entries = await readdir(resolvedTarget, { withFileTypes: true });
            const items: Array<{
                name: string;
                type: 'file' | 'directory';
                path: string;
                size?: number;
                childCount?: number;
            }> = [];

            for (const entry of entries) {
                // Skip hidden files/dirs (starting with .) except important config files
                const isHiddenButImportant = ['.env', '.gitignore', '.npmrc', '.eslintrc', '.prettierrc', '.editorconfig', '.claude'].includes(entry.name);
                if (entry.name.startsWith('.') && !isHiddenButImportant) {
                    continue;
                }

                if (entry.isDirectory()) {
                    if (IGNORED_DIRS.has(entry.name)) continue;
                    const dirRelPath = subPath ? `${subPath}/${entry.name}` : entry.name;
                    // Count children for the directory (shallow)
                    let childCount = 0;
                    try {
                        const children = readdirSync(join(resolvedTarget, entry.name));
                        childCount = children.filter(c => !IGNORED_FILES.has(c)).length;
                    } catch {
                        // Permission denied or other error
                    }
                    items.push({
                        name: entry.name,
                        type: 'directory',
                        path: dirRelPath,
                        childCount
                    });
                } else if (entry.isFile()) {
                    if (IGNORED_FILES.has(entry.name)) continue;
                    const fileRelPath = subPath ? `${subPath}/${entry.name}` : entry.name;
                    let size = 0;
                    try {
                        const stat = statSync(join(resolvedTarget, entry.name));
                        size = stat.size;
                    } catch {
                        // Permission denied
                    }
                    items.push({
                        name: entry.name,
                        type: 'file',
                        path: fileRelPath,
                        size
                    });
                }
            }

            // Sort: directories first, then files, both alphabetically
            items.sort((a, b) => {
                if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
                return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
            });

            res.json({
                path: subPath || '.',
                workspace: workspacePath,
                items
            });
        } catch (err) {
            logger.error('Failed to list files', { error: err instanceof Error ? err.message : String(err) });
            res.status(500).json({ error: 'Failed to list directory contents' });
        }
    });

    // Git status endpoint — uncommitted changes for a workspace
    app.get('/api/workspaces/git-status', async (req, res) => {
        const workspacePath = req.query.workspace as string;
        if (!workspacePath) {
            return res.status(400).json({ error: 'workspace query parameter is required' });
        }
        if (!existsSync(workspacePath)) {
            return res.status(404).json({ error: 'Workspace not found' });
        }

        try {
            const execAsync = (await import('util')).promisify((await import('child_process')).exec);

            // Check if it's a git repo
            try {
                await execAsync('git rev-parse --git-dir', { cwd: workspacePath });
            } catch {
                return res.json({ isGitRepo: false, branch: null, changes: [] });
            }

            // Get current branch
            let branch = '';
            try {
                const { stdout } = await execAsync('git branch --show-current', { cwd: workspacePath });
                branch = stdout.trim();
            } catch {
                branch = 'HEAD';
            }

            // Get status with porcelain v2 for richer info
            const { stdout: statusOutput } = await execAsync('git status --porcelain', { cwd: workspacePath });
            const changes = statusOutput.trim().split('\n')
                .filter(line => line.length > 0)
                .map(line => {
                    const staged = line[0];
                    const unstaged = line[1];
                    const filePath = line.substring(3);
                    // Determine status
                    let status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' = 'modified';
                    let isStaged = false;
                    if (staged === '?' && unstaged === '?') {
                        status = 'untracked';
                    } else if (staged === 'A') {
                        status = 'added';
                        isStaged = true;
                    } else if (staged === 'D' || unstaged === 'D') {
                        status = 'deleted';
                        isStaged = staged === 'D';
                    } else if (staged === 'R') {
                        status = 'renamed';
                        isStaged = true;
                    } else if (staged === 'M') {
                        status = 'modified';
                        isStaged = true;
                    } else if (unstaged === 'M') {
                        status = 'modified';
                        isStaged = false;
                    }
                    return { path: filePath, status, staged: isStaged };
                });

            // Get ahead/behind info
            let ahead = 0;
            let behind = 0;
            try {
                const { stdout: abOutput } = await execAsync('git rev-list --left-right --count HEAD...@{upstream}', { cwd: workspacePath });
                const parts = abOutput.trim().split(/\s+/);
                ahead = parseInt(parts[0], 10) || 0;
                behind = parseInt(parts[1], 10) || 0;
            } catch {
                // No upstream configured
            }

            res.json({ isGitRepo: true, branch, changes, ahead, behind });
        } catch (err) {
            logger.error('Failed to get git status', { error: err instanceof Error ? err.message : String(err) });
            res.status(500).json({ error: 'Failed to get git status' });
        }
    });

    // CI/CD checks endpoint - get PR check status from GitHub
    app.get('/api/workspaces/ci-status', async (req, res) => {
        const workspacePath = req.query.workspace as string;
        if (!workspacePath) {
            return res.status(400).json({ error: 'workspace query parameter is required' });
        }
        if (!existsSync(workspacePath)) {
            return res.status(404).json({ error: 'Workspace not found' });
        }

        try {
            const execAsync = (await import('util')).promisify((await import('child_process')).exec);

            // Check if it's a git repo
            try {
                await execAsync('git rev-parse --git-dir', { cwd: workspacePath });
            } catch {
                return res.json({ isGitRepo: false, checks: [], prNumber: null, prUrl: null });
            }

            // Get current branch
            let branch = '';
            try {
                const { stdout } = await execAsync('git branch --show-current', { cwd: workspacePath });
                branch = stdout.trim();
            } catch {
                return res.json({ isGitRepo: true, checks: [], prNumber: null, prUrl: null, error: 'Cannot determine branch' });
            }

            // Get remote URL to determine owner/repo
            let owner = '';
            let repo = '';
            try {
                const { stdout } = await execAsync('git remote get-url origin', { cwd: workspacePath });
                const url = stdout.trim();
                // Parse GitHub URL: https://github.com/owner/repo.git or git@github.com:owner/repo.git
                const httpsMatch = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
                if (httpsMatch) {
                    owner = httpsMatch[1];
                    repo = httpsMatch[2];
                }
            } catch {
                return res.json({ isGitRepo: true, checks: [], prNumber: null, prUrl: null, error: 'No remote origin' });
            }

            if (!owner || !repo) {
                return res.json({ isGitRepo: true, checks: [], prNumber: null, prUrl: null, error: 'Not a GitHub repository' });
            }

            // Use gh CLI to get PR info and checks
            let prNumber: number | null = null;
            let prUrl: string | null = null;
            let prState: string | null = null;

            try {
                const { stdout: prOutput } = await execAsync(
                    `gh pr view --json number,url,state --jq ".number,.url,.state"`,
                    { cwd: workspacePath }
                );
                const prLines = prOutput.trim().split('\n');
                if (prLines.length >= 3) {
                    prNumber = parseInt(prLines[0], 10);
                    prUrl = prLines[1];
                    prState = prLines[2];
                }
            } catch {
                // No PR for this branch
            }

            // Get check runs for current branch
            interface CICheck {
                name: string;
                status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'pending' | 'neutral';
                conclusion: string | null;
                startedAt: string | null;
                completedAt: string | null;
                url: string | null;
            }
            let checks: CICheck[] = [];

            try {
                const { stdout: checksOutput } = await execAsync(
                    `gh pr checks --json name,state,link`,
                    { cwd: workspacePath }
                );
                const checksData = JSON.parse(checksOutput);
                checks = checksData.map((c: { name: string; state: string; link: string }) => {
                    let status: CICheck['status'] = 'pending';
                    let conclusion: string | null = null;
                    const state = c.state?.toUpperCase();

                    if (state === 'SUCCESS' || state === 'PASS') {
                        status = 'completed';
                        conclusion = 'success';
                    } else if (state === 'FAILURE' || state === 'FAIL' || state === 'ERROR') {
                        status = 'completed';
                        conclusion = 'failure';
                    } else if (state === 'PENDING') {
                        status = 'pending';
                    } else if (state === 'SKIPPING' || state === 'SKIPPED') {
                        status = 'completed';
                        conclusion = 'skipped';
                    } else if (state === 'CANCELLED') {
                        status = 'completed';
                        conclusion = 'cancelled';
                    } else {
                        status = 'in_progress';
                    }

                    return {
                        name: c.name,
                        status,
                        conclusion,
                        startedAt: null,
                        completedAt: null,
                        url: c.link || null,
                    };
                });
            } catch {
                // gh pr checks failed — no PR or no checks
            }

            res.json({
                isGitRepo: true,
                branch,
                owner,
                repo,
                prNumber,
                prUrl,
                prState,
                checks,
            });
        } catch (err) {
            logger.error('Failed to get CI status', { error: err instanceof Error ? err.message : String(err) });
            res.status(500).json({ error: 'Failed to get CI status' });
        }
    });

    // GitHub Issues endpoint
    app.get('/api/workspaces/github-issues', async (req, res) => {
        const workspacePath = req.query.workspace as string;
        const state = req.query.state as string || 'open'; // open, closed, all
        const limit = parseInt(req.query.limit as string) || 30;
        const assignee = req.query.assignee as string; // @me for current user, username, or empty

        if (!workspacePath) {
            return res.status(400).json({ error: 'workspace query parameter is required' });
        }
        if (!existsSync(workspacePath)) {
            return res.status(404).json({ error: 'Workspace not found' });
        }

        try {
            const execAsync = (await import('util')).promisify((await import('child_process')).exec);

            // Check if it's a git repo
            try {
                await execAsync('git rev-parse --git-dir', { cwd: workspacePath });
            } catch {
                return res.json({ isGitRepo: false, issues: [] });
            }

            // Get remote URL to determine owner/repo
            // Prefer public github.com remotes over GitHub Enterprise
            let owner = '';
            let repo = '';
            try {
                // Get all remotes
                const { stdout: remotesOutput } = await execAsync('git remote', { cwd: workspacePath });
                const remotes = remotesOutput.trim().split('\n').filter(r => r.length > 0);

                // Try to find a github.com remote first
                let foundUrl = '';
                for (const remote of remotes) {
                    try {
                        const { stdout } = await execAsync(`git remote get-url ${remote}`, { cwd: workspacePath });
                        const url = stdout.trim();
                        if (url.includes('github.com')) {
                            foundUrl = url;
                            break;
                        }
                        // Keep first GitHub URL as fallback
                        if (!foundUrl && url.match(/github[^:/]*[:/]/)) {
                            foundUrl = url;
                        }
                    } catch {
                        continue;
                    }
                }

                if (foundUrl) {
                    // Parse GitHub URL (supports github.com and GitHub Enterprise)
                    const match = foundUrl.match(/github[^:/]*[:/]([^/]+)\/([^/.]+)/);
                    if (match) {
                        owner = match[1];
                        repo = match[2];
                    }
                }
            } catch {
                return res.json({ isGitRepo: true, issues: [], error: 'No remote origin' });
            }

            if (!owner || !repo) {
                return res.json({ isGitRepo: true, issues: [], error: 'Not a GitHub repository' });
            }

            // Check if gh CLI is installed
            try {
                await execAsync('gh --version', { cwd: workspacePath });
            } catch {
                return res.json({ isGitRepo: true, owner, repo, issues: [], error: 'gh CLI not installed. Install from https://cli.github.com' });
            }

            // Fetch issues using gh CLI
            interface GitHubIssue {
                number: number;
                title: string;
                state: string;
                url: string;
                createdAt: string;
                updatedAt: string;
                closedAt: string | null;
                author: { login: string };
                assignees: { login: string }[];
                labels: { name: string; color: string }[];
                comments: number;
                body: string;
            }

            let issues: GitHubIssue[] = [];
            try {
                const assigneeArg = assignee ? `--assignee ${assignee}` : '';
                const { stdout } = await execAsync(
                    `gh issue list --repo ${owner}/${repo} --state ${state} ${assigneeArg} --limit ${limit} --json number,title,state,url,createdAt,updatedAt,closedAt,author,assignees,labels,comments,body`,
                    { cwd: workspacePath }
                );
                issues = JSON.parse(stdout);
            } catch (err) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                // Check if it's an auth error
                if (errorMsg.includes('authentication') || errorMsg.includes('HTTP 401')) {
                    return res.json({
                        isGitRepo: true,
                        owner,
                        repo,
                        issues: [],
                        error: 'GitHub authentication required. Run: gh auth login'
                    });
                }
                return res.json({
                    isGitRepo: true,
                    owner,
                    repo,
                    issues: [],
                    error: errorMsg.includes('Could not resolve to a Repository')
                        ? 'Repository not found or no access'
                        : 'Failed to fetch issues'
                });
            }

            res.json({
                isGitRepo: true,
                owner,
                repo,
                issues,
            });
        } catch (err) {
            logger.error('Failed to get GitHub issues', { error: err instanceof Error ? err.message : String(err) });
            res.status(500).json({ error: 'Failed to get GitHub issues' });
        }
    });

    // Create GitHub Issue endpoint
    app.post('/api/workspaces/github-issues', async (req, res) => {
        const workspacePath = req.body.workspace as string;
        const title = req.body.title as string;
        const body = req.body.body as string || '';

        if (!workspacePath) {
            return res.status(400).json({ error: 'workspace is required' });
        }
        if (!title || title.trim().length === 0) {
            return res.status(400).json({ error: 'title is required' });
        }
        if (!existsSync(workspacePath)) {
            return res.status(404).json({ error: 'Workspace not found' });
        }

        try {
            const execAsync = (await import('util')).promisify((await import('child_process')).exec);

            // Check if it's a git repo
            try {
                await execAsync('git rev-parse --git-dir', { cwd: workspacePath });
            } catch {
                return res.status(400).json({ error: 'Not a git repository' });
            }

            // Get remote URL to determine owner/repo
            let owner = '';
            let repo = '';
            try {
                // Get all remotes
                const { stdout: remotesOutput } = await execAsync('git remote', { cwd: workspacePath });
                const remotes = remotesOutput.trim().split('\n').filter(r => r.length > 0);

                // Try to find a github.com remote first
                let foundUrl = '';
                for (const remote of remotes) {
                    try {
                        const { stdout } = await execAsync(`git remote get-url ${remote}`, { cwd: workspacePath });
                        const url = stdout.trim();
                        if (url.includes('github.com')) {
                            foundUrl = url;
                            break;
                        }
                        // Keep first GitHub URL as fallback
                        if (!foundUrl && url.match(/github[^:/]*[:/]/)) {
                            foundUrl = url;
                        }
                    } catch {
                        continue;
                    }
                }

                if (foundUrl) {
                    // Parse GitHub URL (supports github.com and GitHub Enterprise)
                    const match = foundUrl.match(/github[^:/]*[:/]([^/]+)\/([^/.]+)/);
                    if (match) {
                        owner = match[1];
                        repo = match[2];
                    }
                }
            } catch {
                return res.status(400).json({ error: 'No remote origin' });
            }

            if (!owner || !repo) {
                return res.status(400).json({ error: 'Not a GitHub repository' });
            }

            // Check if gh CLI is installed
            try {
                await execAsync('gh --version', { cwd: workspacePath });
            } catch {
                return res.status(400).json({ error: 'gh CLI not installed. Install from https://cli.github.com' });
            }

            // Create issue using gh CLI
            try {
                // gh CLI requires --body when running non-interactively, so provide empty string if not given
                const bodyText = body || '';
                // Auto-assign to current user (@me)
                const { stdout } = await execAsync(
                    `gh issue create --repo ${owner}/${repo} --title "${title.replace(/"/g, '\\"')}" --body "${bodyText.replace(/"/g, '\\"')}" --assignee @me`,
                    { cwd: workspacePath }
                );
                // gh issue create returns the URL of the created issue
                const issueUrl = stdout.trim();
                // Extract issue number from URL (e.g., https://github.com/owner/repo/issues/123)
                const match = issueUrl.match(/\/issues\/(\d+)$/);
                const issueNumber = match ? parseInt(match[1], 10) : null;

                res.json({
                    success: true,
                    issue: {
                        number: issueNumber,
                        url: issueUrl
                    }
                });
            } catch (err) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                // Check if it's an auth error
                if (errorMsg.includes('authentication') || errorMsg.includes('HTTP 401')) {
                    return res.status(401).json({
                        error: 'GitHub authentication required. Run: gh auth login'
                    });
                }
                return res.status(500).json({
                    error: 'Failed to create issue: ' + errorMsg
                });
            }
        } catch (err) {
            logger.error('Failed to create GitHub issue', { error: err instanceof Error ? err.message : String(err) });
            res.status(500).json({ error: 'Failed to create GitHub issue' });
        }
    });

    // Close/Reopen GitHub Issue endpoint
    app.patch('/api/workspaces/github-issues/:issueNumber', async (req, res) => {
        const workspacePath = req.body.workspace as string;
        const issueNumber = parseInt(req.params.issueNumber, 10);
        const state = req.body.state as 'open' | 'closed';

        if (!workspacePath) {
            return res.status(400).json({ error: 'workspace is required' });
        }
        if (!issueNumber || isNaN(issueNumber)) {
            return res.status(400).json({ error: 'Invalid issue number' });
        }
        if (!state || !['open', 'closed'].includes(state)) {
            return res.status(400).json({ error: 'state must be "open" or "closed"' });
        }
        if (!existsSync(workspacePath)) {
            return res.status(404).json({ error: 'Workspace not found' });
        }

        try {
            const execAsync = (await import('util')).promisify((await import('child_process')).exec);

            // Check if it's a git repo
            try {
                await execAsync('git rev-parse --git-dir', { cwd: workspacePath });
            } catch {
                return res.status(400).json({ error: 'Not a git repository' });
            }

            // Get remote URL to determine owner/repo
            let owner = '';
            let repo = '';
            try {
                const { stdout: remotesOutput } = await execAsync('git remote', { cwd: workspacePath });
                const remotes = remotesOutput.trim().split('\n').filter(r => r.length > 0);

                let foundUrl = '';
                for (const remote of remotes) {
                    try {
                        const { stdout } = await execAsync(`git remote get-url ${remote}`, { cwd: workspacePath });
                        const url = stdout.trim();
                        if (url.includes('github.com')) {
                            foundUrl = url;
                            break;
                        }
                        if (!foundUrl && url.match(/github[^:/]*[:/]/)) {
                            foundUrl = url;
                        }
                    } catch {
                        continue;
                    }
                }

                if (foundUrl) {
                    const match = foundUrl.match(/github[^:/]*[:/]([^/]+)\/([^/.]+)/);
                    if (match) {
                        owner = match[1];
                        repo = match[2];
                    }
                }
            } catch {
                return res.status(400).json({ error: 'No remote origin' });
            }

            if (!owner || !repo) {
                return res.status(400).json({ error: 'Not a GitHub repository' });
            }

            // Check if gh CLI is installed
            try {
                await execAsync('gh --version', { cwd: workspacePath });
            } catch {
                return res.status(400).json({ error: 'gh CLI not installed' });
            }

            // Close or reopen the issue using gh CLI
            try {
                const stateArg = state === 'closed' ? '--close' : '--reopen';
                await execAsync(
                    `gh issue ${state === 'closed' ? 'close' : 'reopen'} ${issueNumber} --repo ${owner}/${repo}`,
                    { cwd: workspacePath }
                );

                res.json({
                    success: true,
                    issue: {
                        number: issueNumber,
                        state: state.toUpperCase()
                    }
                });
            } catch (err) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                if (errorMsg.includes('authentication') || errorMsg.includes('HTTP 401')) {
                    return res.status(401).json({
                        error: 'GitHub authentication required. Run: gh auth login'
                    });
                }
                return res.status(500).json({
                    error: 'Failed to update issue: ' + errorMsg
                });
            }
        } catch (err) {
            logger.error('Failed to update GitHub issue', { error: err instanceof Error ? err.message : String(err) });
            res.status(500).json({ error: 'Failed to update GitHub issue' });
        }
    });

    // Read file contents endpoint
    app.get('/api/workspaces/read-file', async (req, res) => {
        const workspacePath = req.query.workspace as string;
        const filePath = req.query.file as string;

        if (!workspacePath) {
            return res.status(400).json({ error: 'workspace query parameter is required' });
        }
        if (!filePath) {
            return res.status(400).json({ error: 'file query parameter is required' });
        }

        // Resolve the full file path
        const fullPath = join(workspacePath, filePath);

        // Security: ensure the resolved path is within the workspace
        const resolvedPath = resolve(fullPath);
        const resolvedWorkspace = resolve(workspacePath);
        if (!resolvedPath.startsWith(resolvedWorkspace)) {
            return res.status(403).json({ error: 'Path traversal not allowed' });
        }

        if (!existsSync(resolvedPath)) {
            return res.status(404).json({ error: 'File not found' });
        }

        try {
            const stats = statSync(resolvedPath);
            if (!stats.isFile()) {
                return res.status(400).json({ error: 'Path is not a file' });
            }

            // Read file contents
            const content = await readFile(resolvedPath, 'utf-8');
            res.json({
                path: filePath,
                content,
                size: stats.size
            });
        } catch (err) {
            logger.error('Failed to read file', { error: err instanceof Error ? err.message : String(err) });
            res.status(500).json({ error: 'Failed to read file' });
        }
    });

    // Save file contents endpoint
    app.post('/api/workspaces/save-file', async (req, res) => {
        const workspacePath = req.body.workspace as string;
        const filePath = req.body.file as string;
        const content = req.body.content as string;

        if (!workspacePath) {
            return res.status(400).json({ error: 'workspace parameter is required' });
        }
        if (!filePath) {
            return res.status(400).json({ error: 'file parameter is required' });
        }
        if (content === undefined) {
            return res.status(400).json({ error: 'content parameter is required' });
        }

        // Resolve the full file path
        const fullPath = join(workspacePath, filePath);

        // Security: ensure the resolved path is within the workspace
        const resolvedPath = resolve(fullPath);
        const resolvedWorkspace = resolve(workspacePath);
        if (!resolvedPath.startsWith(resolvedWorkspace)) {
            return res.status(403).json({ error: 'Path traversal not allowed' });
        }

        try {
            // Write file contents
            writeFileSync(resolvedPath, content, 'utf-8');
            const stats = statSync(resolvedPath);
            res.json({
                path: filePath,
                size: stats.size,
                success: true
            });
        } catch (err) {
            logger.error('Failed to save file', { error: err instanceof Error ? err.message : String(err) });
            res.status(500).json({ error: 'Failed to save file' });
        }
    });

    // Git diff endpoint
    app.get('/api/workspaces/git-diff', async (req, res) => {
        const workspacePath = req.query.workspace as string;
        const filePath = req.query.file as string;
        const staged = req.query.staged === 'true';

        if (!workspacePath) {
            return res.status(400).json({ error: 'workspace query parameter is required' });
        }
        if (!filePath) {
            return res.status(400).json({ error: 'file query parameter is required' });
        }

        if (!existsSync(workspacePath)) {
            return res.status(404).json({ error: 'Workspace not found' });
        }

        try {
            const execAsync = (await import('util')).promisify((await import('child_process')).exec);

            // Check if it's a git repo
            try {
                await execAsync('git rev-parse --git-dir', { cwd: workspacePath });
            } catch {
                return res.status(400).json({ error: 'Not a git repository' });
            }

            // Get the diff
            let diff = '';
            try {
                const command = staged
                    ? `git diff --cached -- "${filePath}"`
                    : `git diff -- "${filePath}"`;
                const { stdout } = await execAsync(command, { cwd: workspacePath, maxBuffer: 10 * 1024 * 1024 });
                diff = stdout;
            } catch (err) {
                logger.error('Failed to get git diff', { error: err instanceof Error ? err.message : String(err) });
            }

            res.json({
                path: filePath,
                diff,
                staged
            });
        } catch (err) {
            logger.error('Failed to get git diff', { error: err instanceof Error ? err.message : String(err) });
            res.status(500).json({ error: 'Failed to get git diff' });
        }
    });

    // Config API routes

    app.get('/api/config', async (_req, res) => {
        // If rules are empty, try to sync from CLAUDE.md files
        const config = configStore.getConfig();
        if (!config.rules) {
            const workspaces = workspaceStore.getWorkspaces();
            for (const workspace of workspaces) {
                const rules = await extractRulesFromClaudeMd(workspace.id);
                if (rules) {
                    console.log(`[Server] Syncing rules from ${workspace.id}/CLAUDE.md to config`);
                    configStore.updateConfig({ rules });
                    const updatedConfig = configStore.getConfig();
                    return res.json(updatedConfig);
                }
            }
        }
        res.json(config);
    });

    app.put('/api/config', async (req, res) => {
        try {
            // Validate the config update payload
            const validation = validateConfigUpdate(req.body);
            if (!validation.valid) {
                logger.warn('Invalid config update payload', { error: validation.error });
                return res.status(400).json({ error: validation.error });
            }

            // Check if backend is being changed
            const currentBackend = configStore.getBackend();
            const newBackend = validation.data!.backend;

            // Cast is needed because ConfigUpdatePayload has optional fields but AppConfig requires them
            const updatedConfig = configStore.updateConfig(validation.data! as Parameters<typeof configStore.updateConfig>[0]);

            // If backend was changed, switch the task spawner's backend
            if (newBackend && newBackend !== currentBackend) {
                logger.info('Backend config changed, switching task spawner backend', { from: currentBackend, to: newBackend });
                await taskSpawner.switchBackend(newBackend);
            }

            // If rules were updated, sync to all workspace CLAUDE.md files
            if (validation.data!.rules !== undefined) {
                const workspaces = workspaceStore.getWorkspaces();
                for (const workspace of workspaces) {
                    try {
                        syncRulesToClaudeMd(workspace.id, validation.data!.rules!);
                    } catch (err) {
                        logger.error(`Failed to sync rules to workspace`, { workspaceId: workspace.id, error: err });
                    }
                }
            }

            // If MCP servers were updated, sync .mcp.json and settings.local.json to all workspaces
            if (validation.data!.mcpServers !== undefined) {
                const workspaces = workspaceStore.getWorkspaces();
                if (workspaces.length > 0) {
                    const workspaceIds = workspaces.map(w => w.id);
                    taskSpawner.syncWorkspaceMcpConfigs(workspaceIds);
                    logger.info('Synced MCP config to all workspaces after config update', { count: workspaceIds.length });
                }
            }

            res.json(updatedConfig);
        } catch (error) {
            logger.error('Failed to update config', { error });
            res.status(500).json({ error: 'Failed to update config' });
        }
    });

    // MCP server config type - supports stdio, http, and streamableHttp types
    interface MCPServerConfig {
        type?: 'stdio' | 'http' | 'streamableHttp';
        command?: string;  // For stdio
        args?: string[];   // For stdio
        env?: Record<string, string>;  // For stdio
        url?: string;      // For http/streamableHttp
        headers?: Record<string, string>;  // For http/streamableHttp
        timeout?: number;
        autoApprove?: string[];
        description?: string;
        [key: string]: unknown;
    }

    interface ClaudeProjectConfig {
        mcpServers?: Record<string, MCPServerConfig>;
        [key: string]: unknown;
    }

    // Get Claude Code's global MCP servers from ~/.claude.json
    app.get('/api/claude-mcp-servers', (req, res) => {
        try {
            const homeDir = process.env.HOME || process.env.USERPROFILE || '';
            const claudeConfigPath = join(homeDir, '.claude.json');

            if (!existsSync(claudeConfigPath)) {
                return res.json({ global: [], project: [] });
            }

            const claudeConfig = JSON.parse(readFileSync(claudeConfigPath, 'utf-8')) as {
                mcpServers?: Record<string, MCPServerConfig>;
                projects?: Record<string, ClaudeProjectConfig>;
            };
            const workspacePath = req.query.workspace as string;

            // Helper to extract server config supporting stdio, http, and streamableHttp types
            const extractServerConfig = (name: string, config: MCPServerConfig) => {
                const serverType = config.type || 'stdio';
                if (serverType === 'streamableHttp' || serverType === 'http') {
                    return {
                        name,
                        type: serverType as 'http' | 'streamableHttp',
                        url: config.url || '',
                        headers: config.headers,
                        timeout: config.timeout,
                        autoApprove: config.autoApprove,
                        description: config.description,
                    };
                } else {
                    return {
                        name,
                        type: 'stdio' as const,
                        command: config.command || '',
                        args: config.args || [],
                        env: config.env,
                        description: config.description,
                    };
                }
            };

            // Extract global MCP servers
            const globalServers: Array<ReturnType<typeof extractServerConfig> & { scope: 'global' }> = [];
            if (claudeConfig.mcpServers) {
                for (const [name, config] of Object.entries(claudeConfig.mcpServers)) {
                    globalServers.push({
                        ...extractServerConfig(name, config),
                        scope: 'global'
                    });
                }
            }

            // Extract project-specific MCP servers if workspace path provided
            const projectServers: Array<ReturnType<typeof extractServerConfig> & { scope: 'project'; projectPath: string }> = [];
            if (claudeConfig.projects) {
                for (const [projectPath, projectConfig] of Object.entries(claudeConfig.projects)) {
                    if (projectConfig.mcpServers) {
                        for (const [name, config] of Object.entries(projectConfig.mcpServers)) {
                            // Include if no workspace filter, or if this project matches the workspace
                            if (!workspacePath || projectPath === workspacePath || workspacePath.startsWith(projectPath)) {
                                projectServers.push({
                                    ...extractServerConfig(name, config),
                                    scope: 'project',
                                    projectPath
                                });
                            }
                        }
                    }
                }
            }

            res.json({ global: globalServers, project: projectServers });
        } catch (error) {
            console.error('[Server] Failed to read Claude MCP servers:', error);
            res.status(500).json({ error: 'Failed to read Claude MCP servers' });
        }
    });

    // Get mcpServers section from ~/.claude.json for direct editing
    app.get('/api/claude-config/mcp-servers', (req, res) => {
        try {
            const homeDir = process.env.HOME || process.env.USERPROFILE || '';
            const claudeConfigPath = join(homeDir, '.claude.json');

            if (!existsSync(claudeConfigPath)) {
                return res.json({
                    mcpServers: JSON.stringify({}, null, 2),
                    path: claudeConfigPath,
                    exists: false
                });
            }

            const fileContent = readFileSync(claudeConfigPath, 'utf-8');
            const config = JSON.parse(fileContent) as {
                mcpServers?: Record<string, unknown>;
            };

            res.json({
                mcpServers: JSON.stringify(config.mcpServers || {}, null, 2),
                path: claudeConfigPath,
                exists: true
            });
        } catch (error) {
            console.error('[Server] Failed to read Claude MCP servers:', error);
            res.status(500).json({ error: 'Failed to read MCP servers config' });
        }
    });

    // Update mcpServers section in ~/.claude.json
    app.put('/api/claude-config/mcp-servers', (req, res) => {
        try {
            const { mcpServers: mcpServersContent } = req.body;

            if (typeof mcpServersContent !== 'string') {
                return res.status(400).json({ error: 'mcpServers must be a string' });
            }

            let mcpServers: Record<string, unknown>;
            try {
                mcpServers = JSON.parse(mcpServersContent);
                if (typeof mcpServers !== 'object' || Array.isArray(mcpServers)) {
                    return res.status(400).json({ error: 'mcpServers must be an object' });
                }
            } catch (parseError) {
                return res.status(400).json({
                    error: 'Invalid JSON syntax',
                    details: parseError instanceof Error ? parseError.message : 'Parse error'
                });
            }

            const homeDir = process.env.HOME || process.env.USERPROFILE || '';
            const claudeConfigPath = join(homeDir, '.claude.json');

            // Read existing config or create new one
            interface ClaudeConfig {
                mcpServers?: Record<string, unknown>;
                [key: string]: unknown;
            }
            let config: ClaudeConfig = {};
            if (existsSync(claudeConfigPath)) {
                const fileContent = readFileSync(claudeConfigPath, 'utf-8');
                config = JSON.parse(fileContent);
            }

            config.mcpServers = mcpServers;
            console.log('[Server] Updated MCP servers');

            writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2), 'utf-8');
            console.log('[Server] Saved Claude config:', claudeConfigPath);

            res.json({ success: true, path: claudeConfigPath });
        } catch (error) {
            console.error('[Server] Failed to write MCP servers config:', error);
            res.status(500).json({ error: 'Failed to write MCP servers config' });
        }
    });

    // Test MCP server connection
    app.post('/api/mcp/test', async (req, res) => {
        const { server } = req.body;

        if (!server || !server.name) {
            return res.status(400).json({ success: false, error: 'Server configuration required' });
        }

        const serverType = server.type || 'stdio';
        logger.info(`Testing MCP server connection: ${server.name} (${serverType})`);

        try {
            if (serverType === 'streamableHttp' || serverType === 'http') {
                // Test HTTP-based MCP server
                const url = server.url;
                if (!url) {
                    return res.json({ success: false, error: 'URL is required for HTTP MCP server' });
                }

                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 10000);

                try {
                    // Send MCP initialize request
                    const headers: Record<string, string> = {
                        'Content-Type': 'application/json',
                        ...(server.headers || {})
                    };

                    const initRequest = {
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'initialize',
                        params: {
                            protocolVersion: '2024-11-05',
                            capabilities: {},
                            clientInfo: {
                                name: 'claudia-test',
                                version: '1.0.0'
                            }
                        }
                    };

                    const response = await fetch(url, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(initRequest),
                        signal: controller.signal
                    });

                    clearTimeout(timeout);

                    if (response.ok) {
                        const data = await response.json() as { result?: { serverInfo?: { name?: string; version?: string }; capabilities?: Record<string, unknown> }; error?: { message?: string } };
                        if (data.result) {
                            const serverInfo = data.result.serverInfo;
                            const capabilities = data.result.capabilities || {};
                            const toolCount = capabilities.tools ? 'available' : 'not advertised';

                            logger.info(`MCP server ${server.name} connected successfully: ${serverInfo?.name || 'unknown'} v${serverInfo?.version || 'unknown'}`);
                            return res.json({
                                success: true,
                                message: `Connected to ${serverInfo?.name || server.name}${serverInfo?.version ? ` v${serverInfo.version}` : ''}`,
                                details: {
                                    serverName: serverInfo?.name,
                                    serverVersion: serverInfo?.version,
                                    tools: toolCount
                                }
                            });
                        } else if (data.error) {
                            return res.json({ success: false, error: data.error.message || 'Server returned error' });
                        }
                        return res.json({ success: true, message: 'Server responded' });
                    } else {
                        return res.json({ success: false, error: `HTTP ${response.status}: ${response.statusText}` });
                    }
                } catch (fetchError: unknown) {
                    clearTimeout(timeout);
                    const errorMessage = fetchError instanceof Error && fetchError.name === 'AbortError'
                        ? 'Connection timed out'
                        : (fetchError instanceof Error ? fetchError.message : 'Connection failed');
                    return res.json({ success: false, error: errorMessage });
                }
            } else {
                // Test stdio-based MCP server
                const command = server.command;
                const args = server.args || [];

                if (!command) {
                    return res.json({ success: false, error: 'Command is required for stdio MCP server' });
                }

                // Spawn the process
                let mcpProcess: ChildProcess;
                try {
                    mcpProcess = spawn(command, args, {
                        stdio: ['pipe', 'pipe', 'pipe'],
                        env: { ...process.env, ...(server.env || {}) }
                    });
                } catch (spawnError) {
                    const errorMessage = spawnError instanceof Error ? spawnError.message : 'Failed to spawn process';
                    return res.json({ success: false, error: `Failed to start: ${errorMessage}` });
                }

                // Set up timeout
                const timeoutMs = 10000;
                let resolved = false;
                const timeoutId = setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        mcpProcess.kill();
                        return res.json({ success: false, error: 'Connection timed out (no response within 10s)' });
                    }
                }, timeoutMs);

                // Collect stderr for error reporting
                let stderrOutput = '';
                mcpProcess.stderr?.on('data', (data: Buffer) => {
                    stderrOutput += data.toString();
                });

                // Handle process exit
                mcpProcess.on('error', (error: Error) => {
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeoutId);
                        return res.json({ success: false, error: `Process error: ${error.message}` });
                    }
                });

                mcpProcess.on('exit', (code: number | null, signal: string | null) => {
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeoutId);
                        if (code !== null && code !== 0) {
                            const errorInfo = stderrOutput ? `: ${stderrOutput.trim().slice(0, 200)}` : '';
                            return res.json({ success: false, error: `Process exited with code ${code}${errorInfo}` });
                        }
                        if (signal) {
                            return res.json({ success: false, error: `Process killed by signal ${signal}` });
                        }
                    }
                });

                // Buffer for incoming data
                let buffer = '';

                mcpProcess.stdout?.on('data', (data: Buffer) => {
                    buffer += data.toString();

                    // Try to parse JSON-RPC response
                    const lines = buffer.split('\n');
                    for (const line of lines) {
                        if (line.trim()) {
                            try {
                                const response = JSON.parse(line) as { result?: { serverInfo?: { name?: string; version?: string }; capabilities?: Record<string, unknown> }; error?: { message?: string } };
                                if (response.result && !resolved) {
                                    resolved = true;
                                    clearTimeout(timeoutId);
                                    mcpProcess.kill();

                                    const serverInfo = response.result.serverInfo;
                                    const capabilities = response.result.capabilities || {};
                                    const toolCount = capabilities.tools ? 'available' : 'not advertised';

                                    logger.info(`MCP server ${server.name} connected successfully: ${serverInfo?.name || 'unknown'} v${serverInfo?.version || 'unknown'}`);
                                    return res.json({
                                        success: true,
                                        message: `Connected to ${serverInfo?.name || server.name}${serverInfo?.version ? ` v${serverInfo.version}` : ''}`,
                                        details: {
                                            serverName: serverInfo?.name,
                                            serverVersion: serverInfo?.version,
                                            tools: toolCount
                                        }
                                    });
                                } else if (response.error && !resolved) {
                                    resolved = true;
                                    clearTimeout(timeoutId);
                                    mcpProcess.kill();
                                    return res.json({ success: false, error: response.error.message || 'Server returned error' });
                                }
                            } catch {
                                // Not valid JSON yet, continue collecting
                            }
                        }
                    }
                });

                // Send MCP initialize request
                const initRequest = {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: {
                        protocolVersion: '2024-11-05',
                        capabilities: {},
                        clientInfo: {
                            name: 'claudia-test',
                            version: '1.0.0'
                        }
                    }
                };

                mcpProcess.stdin?.write(JSON.stringify(initRequest) + '\n');
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            logger.error(`MCP test failed for ${server.name}`, { error: error instanceof Error ? error.message : String(error) });
            return res.json({ success: false, error: errorMessage });
        }
    });

    // ============================================================
    // Learnings API - RAG-based learnings management
    // ============================================================

    // Get all learnings (optionally filtered by workspace)
    app.get('/api/learnings', (req, res) => {
        try {
            const { workspaceId } = req.query;
            const learnings = learningsStore.getLearnings(workspaceId as string | undefined);
            // Return without embedding vectors (they're large)
            const learningsWithoutEmbeddings = learnings.map(l => ({
                ...l,
                embedding: undefined,
                embeddingDimensions: l.embedding?.length || 0
            }));
            res.json({ learnings: learningsWithoutEmbeddings });
        } catch (error) {
            logger.error('Failed to get learnings', { error: error instanceof Error ? error.message : String(error) });
            res.status(500).json({ error: 'Failed to get learnings' });
        }
    });

    // Get a single learning
    app.get('/api/learnings/:id', (req, res) => {
        try {
            const learning = learningsStore.getLearning(req.params.id);
            if (!learning) {
                return res.status(404).json({ error: 'Learning not found' });
            }
            res.json({
                ...learning,
                embedding: undefined,
                embeddingDimensions: learning.embedding?.length || 0
            });
        } catch (error) {
            logger.error('Failed to get learning', { error: error instanceof Error ? error.message : String(error) });
            res.status(500).json({ error: 'Failed to get learning' });
        }
    });

    // Add a new learning
    app.post('/api/learnings', async (req, res) => {
        try {
            const { workspaceId, title, content, sourceTaskId } = req.body;

            if (!workspaceId || !title || !content) {
                return res.status(400).json({ error: 'Missing required fields: workspaceId, title, content' });
            }

            const learning = await learningsStore.addLearning({
                workspaceId,
                title,
                content,
                sourceTaskId
            });

            res.json({
                ...learning,
                embedding: undefined,
                embeddingDimensions: learning.embedding?.length || 0
            });
        } catch (error) {
            logger.error('Failed to add learning', { error: error instanceof Error ? error.message : String(error) });
            res.status(500).json({ error: 'Failed to add learning' });
        }
    });

    // Update a learning
    app.put('/api/learnings/:id', async (req, res) => {
        try {
            const { title, content } = req.body;
            const learning = await learningsStore.updateLearning(req.params.id, { title, content });
            if (!learning) {
                return res.status(404).json({ error: 'Learning not found' });
            }
            res.json({
                ...learning,
                embedding: undefined,
                embeddingDimensions: learning.embedding?.length || 0
            });
        } catch (error) {
            logger.error('Failed to update learning', { error: error instanceof Error ? error.message : String(error) });
            res.status(500).json({ error: 'Failed to update learning' });
        }
    });

    // Delete a learning
    app.delete('/api/learnings/:id', (req, res) => {
        try {
            const success = learningsStore.deleteLearning(req.params.id);
            if (!success) {
                return res.status(404).json({ error: 'Learning not found' });
            }
            res.json({ success: true });
        } catch (error) {
            logger.error('Failed to delete learning', { error: error instanceof Error ? error.message : String(error) });
            res.status(500).json({ error: 'Failed to delete learning' });
        }
    });

    // Search learnings (semantic search)
    app.post('/api/learnings/search', async (req, res) => {
        try {
            const { query, workspaceId, topK, minScore } = req.body;

            if (!query) {
                return res.status(400).json({ error: 'Missing query' });
            }

            const results = await learningsStore.searchLearnings({
                query,
                workspaceId,
                topK: topK || 5,
                minScore: minScore || 0.3
            });

            // Return without embedding vectors
            res.json({
                results: results.map(r => ({
                    learning: {
                        ...r.learning,
                        embedding: undefined,
                        embeddingDimensions: r.learning.embedding?.length || 0
                    },
                    score: r.score
                }))
            });
        } catch (error) {
            logger.error('Failed to search learnings', { error: error instanceof Error ? error.message : String(error) });
            res.status(500).json({ error: 'Failed to search learnings' });
        }
    });

    // Get learnings for a task (based on task prompt)
    // Also returns which learnings were actually injected into this task's context
    app.get('/api/tasks/:taskId/learnings', async (req, res) => {
        try {
            const { taskId } = req.params;
            const task = taskSpawner.getTask(taskId) || taskSpawner.getDisconnectedTask(taskId);

            if (!task) {
                return res.status(404).json({ error: 'Task not found' });
            }

            // Get the learning IDs that were actually injected into this task
            const injectedIds = taskSpawner.getTaskLearnings(taskId);

            // Search for relevant learnings based on task prompt
            const results = await learningsStore.searchLearnings({
                query: task.prompt,
                workspaceId: task.workspaceId,
                topK: 5,
                minScore: 0.3
            });

            // Format for context injection
            const contextText = learningsStore.formatForContext(results);

            // Get the actual injected learnings
            const injectedLearnings = injectedIds.map(id => learningsStore.getLearning(id)).filter(Boolean);

            res.json({
                results: results.map(r => ({
                    learning: {
                        ...r.learning,
                        embedding: undefined
                    },
                    score: r.score
                })),
                contextText,
                injected: injectedLearnings.map(l => ({
                    ...l,
                    embedding: undefined
                })),
                injectedCount: injectedIds.length
            });
        } catch (error) {
            logger.error('Failed to get task learnings', { error: error instanceof Error ? error.message : String(error) });
            res.status(500).json({ error: 'Failed to get task learnings' });
        }
    });

    // Helper to sync rules to CLAUDE.md
    function syncRulesToClaudeMd(workspacePath: string, rules: string): void {
        const claudeMdPath = join(workspacePath, 'CLAUDE.md');
        const marker = '<!-- CODEUI-RULES -->';
        const endMarker = '<!-- /CODEUI-RULES -->';

        let content = '';
        if (existsSync(claudeMdPath)) {
            content = readFileSync(claudeMdPath, 'utf-8');
        }

        // Remove existing rules section if present
        const startIdx = content.indexOf(marker);
        const endIdx = content.indexOf(endMarker);
        if (startIdx !== -1 && endIdx !== -1) {
            content = content.slice(0, startIdx) + content.slice(endIdx + endMarker.length);
        }

        // Add new rules section at the end if there are rules
        if (rules.trim()) {
            const rulesSection = `\n${marker}\n## Custom Rules\n\n${rules}\n${endMarker}\n`;
            content = content.trimEnd() + rulesSection;
        }

        writeFileSync(claudeMdPath, content, 'utf-8');
        console.log(`[Server] Synced rules to ${claudeMdPath}`);
    }

    // Conversation History API
    app.get('/api/tasks/:taskId/conversation', async (req, res) => {
        try {
            const { taskId } = req.params;
            const activeTask = taskSpawner.getTask(taskId);
            const disconnectedTask = taskSpawner.getDisconnectedTask(taskId);
            const task = activeTask || disconnectedTask;

            if (!task) {
                return res.status(404).json({ error: 'Task not found' });
            }

            if (!task.sessionId) {
                return res.status(404).json({ error: 'Task has no session ID' });
            }

            // Get workspace path from workspace store
            const workspace = workspaceStore.getWorkspaces().find(w => w.id === task.workspaceId);
            if (!workspace) {
                return res.status(404).json({ error: 'Workspace not found' });
            }

            // Determine backend type: from task, or from task backends map, or auto-detect
            const backendType = ('backendType' in task && task.backendType)
                ? task.backendType
                : undefined;

            logger.info('Getting conversation history', { taskId, sessionId: task.sessionId, backendType });

            const conversation = await getConversationHistory(workspace.id, task.sessionId, backendType);
            if (!conversation) {
                return res.status(404).json({ error: 'Conversation not found' });
            }

            res.json(conversation);
        } catch (error) {
            console.error('[Server] Failed to get conversation:', error);
            res.status(500).json({ error: 'Failed to get conversation' });
        }
    });

    // Get all sessions for a workspace
    app.get('/api/workspaces/:workspaceId/sessions', async (req, res) => {
        try {
            const { workspaceId } = req.params;
            const workspace = workspaceStore.getWorkspaces().find(w => w.id === workspaceId);

            if (!workspace) {
                return res.status(404).json({ error: 'Workspace not found' });
            }

            const sessions = await getWorkspaceSessions(workspace.id);
            res.json(sessions);
        } catch (error) {
            console.error('[Server] Failed to get sessions:', error);
            res.status(500).json({ error: 'Failed to get sessions' });
        }
    });

    // Get conversation for a specific session
    app.get('/api/sessions/:sessionId/conversation', async (req, res) => {
        try {
            const { sessionId } = req.params;
            const { workspaceId } = req.query;

            if (!workspaceId || typeof workspaceId !== 'string') {
                return res.status(400).json({ error: 'workspaceId query parameter required' });
            }

            // Look up workspace to get the path
            const workspace = workspaceStore.getWorkspaces().find(w => w.id === workspaceId);
            if (!workspace) {
                return res.status(404).json({ error: 'Workspace not found' });
            }

            const conversation = await getConversationHistory(workspace.id, sessionId);
            if (!conversation) {
                return res.status(404).json({ error: 'Conversation not found' });
            }

            res.json(conversation);
        } catch (error) {
            console.error('[Server] Failed to get session conversation:', error);
            res.status(500).json({ error: 'Failed to get conversation' });
        }
    });

    // Learn from conversation - analyze and suggest system prompt improvements
    app.post('/api/tasks/:taskId/learn', async (req, res) => {
        try {
            const { taskId } = req.params;
            const { currentSystemPrompt, workspaceId } = req.body;

            // Get the task to find its session ID
            const task = taskSpawner.getTask(taskId) || taskSpawner.getDisconnectedTask(taskId);
            if (!task) {
                return res.status(404).json({ error: 'Task not found' });
            }

            if (!task.sessionId) {
                return res.status(404).json({ error: 'Task has no conversation history (no session ID)' });
            }

            // Get the conversation history
            const workspace = workspaceStore.getWorkspaces().find(w => w.id === (workspaceId || task.workspaceId));
            if (!workspace) {
                return res.status(404).json({ error: 'Workspace not found' });
            }

            // Determine backend type from task
            const backendType = ('backendType' in task && task.backendType)
                ? task.backendType
                : undefined;

            logger.info('Learn from conversation - looking up history', {
                taskId,
                sessionId: task.sessionId,
                workspacePath: workspace.id,
                backendType
            });

            const conversation = await getConversationHistory(workspace.id, task.sessionId, backendType);
            if (!conversation || conversation.messages.length === 0) {
                logger.warn('No conversation history found', { taskId, sessionId: task.sessionId, workspacePath: workspace.id });
                return res.status(404).json({ error: 'No conversation history found' });
            }

            // Build the conversation summary for analysis
            const conversationText = conversation.messages
                .map(m => `${m.role.toUpperCase()}: ${m.content.substring(0, 1500)}${m.content.length > 1500 ? '...' : ''}`)
                .join('\n\n');

            // Use the LLM to analyze the conversation and suggest improvements
            const { generateLLMResponse } = await import('./llm-service.js');

            const analysisPrompt = `You are analyzing a conversation between a user and an AI coding assistant to improve the system prompt.

CURRENT SYSTEM PROMPT (may be empty):
${currentSystemPrompt || '(No system prompt set)'}

CONVERSATION:
${conversationText}

Analyze this conversation to identify:
1. Mistakes or misunderstandings the AI made that could be prevented with better instructions
2. Repeated lookups or questions that could be pre-answered in the system prompt
3. Project-specific knowledge that would help the AI be more effective
4. Preferences the user expressed that should be remembered

Respond in this exact JSON format:
{
  "suggestions": [
    {
      "id": "unique_id_1",
      "description": "Short description of what this suggestion improves",
      "promptAddition": "The actual text to add to the system prompt for this suggestion"
    }
  ],
  "reasoning": "A brief explanation of what you learned from this conversation"
}

Guidelines:
- Each suggestion should be independent and self-contained
- The promptAddition should be a complete instruction that can be added to the system prompt
- Keep each promptAddition concise (1-3 sentences)
- Focus on actionable instructions that prevent specific mistakes
- Generate 2-5 suggestions maximum
- Use unique IDs like "s1", "s2", etc.`;

            const response = await generateLLMResponse(
                'You are a system prompt optimization expert. Always respond with valid JSON.',
                analysisPrompt,
                { maxTokens: 2000, temperature: 0.3, timeoutMs: 90000 }
            );

            // Parse the JSON response
            let analysis;
            try {
                // Try to extract JSON from the response (in case there's extra text)
                const jsonMatch = response.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    analysis = JSON.parse(jsonMatch[0]);
                } else {
                    throw new Error('No JSON found in response');
                }
            } catch (parseError) {
                console.error('[Server] Failed to parse LLM response as JSON:', response);
                // Return a fallback response
                analysis = {
                    suggestions: [],
                    reasoning: 'The analysis could not be completed. Please try again.'
                };
            }

            // Validate the response structure
            if (!analysis.suggestions || !Array.isArray(analysis.suggestions)) {
                analysis.suggestions = [];
            }
            // Validate each suggestion has required fields
            analysis.suggestions = analysis.suggestions.filter((s: { id?: string; description?: string; promptAddition?: string }) =>
                s && typeof s.id === 'string' && typeof s.description === 'string' && typeof s.promptAddition === 'string'
            );
            if (!analysis.reasoning || typeof analysis.reasoning !== 'string') {
                analysis.reasoning = 'No specific reasoning provided.';
            }

            logger.info('Learn from conversation analysis complete', {
                taskId,
                suggestionCount: analysis.suggestions.length
            });

            res.json(analysis);
        } catch (error) {
            console.error('[Server] Failed to learn from conversation:', error);
            res.status(500).json({ error: 'Failed to analyze conversation' });
        }
    });

    // Save selected learnings from conversation analysis
    app.post('/api/tasks/:taskId/learn/save', async (req, res) => {
        try {
            const { taskId } = req.params;
            const { learnings, workspaceId } = req.body;

            if (!learnings || !Array.isArray(learnings) || learnings.length === 0) {
                return res.status(400).json({ error: 'No learnings provided' });
            }

            const task = taskSpawner.getTask(taskId) || taskSpawner.getDisconnectedTask(taskId);
            const effectiveWorkspaceId = workspaceId || task?.workspaceId;

            if (!effectiveWorkspaceId) {
                return res.status(400).json({ error: 'Workspace ID required' });
            }

            const savedLearnings = [];
            for (const learning of learnings) {
                if (!learning.title || !learning.content) {
                    continue;
                }

                try {
                    const saved = await learningsStore.addLearning({
                        workspaceId: effectiveWorkspaceId,
                        title: learning.title,
                        content: learning.content,
                        sourceTaskId: taskId
                    });
                    savedLearnings.push({
                        ...saved,
                        embedding: undefined,
                        embeddingDimensions: saved.embedding?.length || 0
                    });
                } catch (err) {
                    logger.error('Failed to save learning', { error: err instanceof Error ? err.message : String(err) });
                }
            }

            logger.info('Saved learnings from conversation', {
                taskId,
                count: savedLearnings.length
            });

            res.json({ saved: savedLearnings });
        } catch (error) {
            console.error('[Server] Failed to save learnings:', error);
            res.status(500).json({ error: 'Failed to save learnings' });
        }
    });

    // Restart server endpoint - triggers graceful shutdown, tsx watch will restart
    app.post('/api/server/restart', async (_req, res) => {
        console.log('[Server] Restart requested via API');
        res.json({ status: 'restarting' });

        // Give time for response to be sent
        setTimeout(async () => {
            // Touch a watched file to trigger tsx watch restart
            // This is more reliable than process.exit(0) which tsx may not restart
            try {
                const { utimes } = await import('fs/promises');
                const restartTriggerFile = join(__dirname, 'index.ts');
                const now = new Date();
                await utimes(restartTriggerFile, now, now);
                console.log('[Server] Touched index.ts to trigger tsx watch restart');
            } catch (error) {
                console.error('[Server] Failed to touch restart trigger file, falling back to graceful shutdown:', error);
                gracefulShutdown('RESTART');
            }
        }, 100);
    });

    // ===== Production Static Frontend Serving =====
    // When installed via npm (no Vite dev server), serve the pre-built frontend
    const __server_filename = fileURLToPath(import.meta.url);
    const __server_dirname = dirname(__server_filename);
    const frontendDistPath = join(__server_dirname, '..', '..', 'frontend', 'dist');
    if (existsSync(frontendDistPath)) {
        logger.info('Serving frontend from static dist', { path: frontendDistPath });
        app.use(express.static(frontendDistPath));
        // SPA fallback: serve index.html for any non-API route
        app.get('*', (_req, res) => {
            res.sendFile(join(frontendDistPath, 'index.html'));
        });
    }

    // Graceful shutdown handler
    function gracefulShutdown(signal: string): void {
        console.log(`[Server] Shutting down (${signal}), notifying clients and saving state...`);

        // Clear heartbeat interval
        clearInterval(heartbeatInterval);

        // Notify all connected clients that the server is reloading
        broadcast({ type: 'server:reloading' as WSMessageType, payload: {} });

        // Give clients enough time to receive the message and for I/O to complete
        // 500ms provides a good balance between responsiveness and reliability
        setTimeout(() => {
            // Stop tunnel if active
            tunnelManager.stop().catch(() => {});

            // Save all state synchronously before exit
            taskSpawner.saveNow();
            supervisorChat.saveChatHistoryNow();
            taskSpawner.destroy();

            // Close WebSocket connections gracefully
            for (const client of clients) {
                client.close(1001, 'Server reloading');
            }

            console.log('[Server] Shutdown complete');
            process.exit(0);
        }, 500);
    }

    // Note: SIGINT/SIGTERM handlers are set up in index.ts to avoid duplicate handlers
    // The gracefulShutdown function is exported for use by the restart endpoint

    return { app, server, wss, taskSpawner, workspaceStore, supervisorChat, gracefulShutdown, tunnelManager };
}
