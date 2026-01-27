import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import os from 'os';
import { writeFileSync, existsSync, readFileSync, mkdirSync, unlinkSync, readdirSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import multer from 'multer';
import { TaskSpawner } from './task-spawner.js';
import { WorkspaceStore } from './workspace-store.js';
import { ConfigStore } from './config-store.js';
import { SupervisorChat } from './supervisor-chat.js';
import { getConversationHistory, getWorkspaceSessions } from './conversation-parser.js';
import { createAnthropicProxy } from './anthropic-proxy/index.js';
import { Task, Workspace, WSMessage, WSMessageType, WSErrorPayload, ChatMessage, SuggestedAction, WaitingInputType } from '@claudia/shared';
import { validateConfigUpdate, validateWorkspacePath, validateAICoreCredentials } from './validation.js';
import { createLogger } from './logger.js';

// Note: Route modules available in ./routes/ for reference and future refactoring
// - config-routes.ts: Config API routes template
// - task-routes.ts: Task REST API routes template
// - ws-handlers.ts: WebSocket handlers template

const logger = createLogger('[Server]');

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
    'task:archived:list',
    'task:archived:restore',
    'task:archived:continue',
    'task:archived:delete',
    'workspace:create',
    'workspace:delete',
    'workspace:reorder',
    'workspace:openFolder',
    'workspace:openTerminal',
    'workspace:systemPrompt:get',
    'workspace:systemPrompt:set',
    'git:push',
    'supervisor:action',
    'supervisor:analyze',
    'supervisor:chat:message',
    'supervisor:chat:history',
    'supervisor:chat:clear'
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

export function createApp(basePath?: string) {
    const app = express();
    const server = createServer(app);
    const wss = new WebSocketServer({ server });

    // Middleware
    app.use(cors());
    app.use(express.json({ limit: '50mb' })); // Increased limit for large AI requests

    // Initialize configStore first to determine API mode
    const configStore = new ConfigStore(basePath);

    // Mount Anthropic Proxy based on API mode
    const apiMode = configStore.getApiMode();
    const aiCoreCredentials = configStore.getAICoreCredentials();

    // Check for env var override (legacy support)
    const envConfigured = process.env.SAP_AICORE_CLIENT_ID && process.env.SAP_AICORE_CLIENT_SECRET;

    if (apiMode === 'sap-ai-core' && aiCoreCredentials?.clientId) {
        // Use credentials from config store
        console.log('[Server] API mode: sap-ai-core (from config), mounting Anthropic proxy');
        const anthropicProxy = createAnthropicProxy({
            clientId: aiCoreCredentials.clientId,
            clientSecret: aiCoreCredentials.clientSecret,
            authUrl: aiCoreCredentials.authUrl,
            baseUrl: aiCoreCredentials.baseUrl,
            resourceGroup: aiCoreCredentials.resourceGroup || 'default',
            requestTimeoutMs: aiCoreCredentials.timeoutMs || 120000
        });
        app.use('/', anthropicProxy);
    } else if (envConfigured) {
        // Legacy: env vars override for SAP AI Core
        console.log('[Server] SAP AI Core configured via env vars, mounting Anthropic proxy');
        const anthropicProxy = createAnthropicProxy({
            clientId: process.env.SAP_AICORE_CLIENT_ID!,
            clientSecret: process.env.SAP_AICORE_CLIENT_SECRET!,
            authUrl: process.env.SAP_AICORE_AUTH_URL || '',
            baseUrl: process.env.SAP_AICORE_BASE_URL || '',
            resourceGroup: process.env.SAP_AICORE_RESOURCE_GROUP || 'default',
            requestTimeoutMs: parseInt(process.env.SAP_AICORE_TIMEOUT_MS || '120000', 10)
        });
        app.use('/', anthropicProxy);
    } else {
        console.log(`[Server] API mode: ${apiMode}, Anthropic proxy not mounted`);
    }

    // Initialize remaining services
    const taskSpawner = new TaskSpawner(undefined, true, configStore);
    const workspaceStore = new WorkspaceStore(basePath);
    // SupervisorChat now handles both auto-analysis (formerly TaskSupervisor) and chat
    const supervisorChat = new SupervisorChat(taskSpawner, workspaceStore, configStore);

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

    // Track connected clients
    const clients = new Set<WebSocket>();

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

    // WebSocket connection handling
    wss.on('connection', async (ws: WebSocket) => {
        console.log('[Server] Client connected');
        clients.add(ws);

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
                // Only log non-frequent message types to avoid spam
                if (message.type !== 'task:input' && message.type !== 'task:resize') {
                    logger.info(`Received message`, { type: message.type });
                }

                const payload = message.payload || {};

                switch (message.type) {
                    case 'task:create': {
                        // Create a new Claude Code CLI instance
                        const { prompt, workspaceId } = payload as { prompt?: string; workspaceId?: string };
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
                        // Use workspace system prompt if set, otherwise fall back to global rules
                        const workspaceSystemPrompt = workspaceStore.getSystemPrompt(workspaceId);
                        const rules = configStore.getRules();
                        const systemPrompt = workspaceSystemPrompt?.trim() || rules?.trim() || undefined;
                        logger.info(`Creating task with system prompt`, { hasSystemPrompt: !!systemPrompt, source: workspaceSystemPrompt ? 'workspace' : (rules ? 'rules' : 'none') });
                        taskSpawner.createTask(prompt, workspaceValidation.data!, systemPrompt);
                        break;
                    }

                    case 'task:select': {
                        // Switch active task (for terminal viewing)
                        const { taskId } = payload as { taskId?: string };
                        if (taskId) taskSpawner.setTaskActive(taskId, true);
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

                    case 'task:reconnect': {
                        // Reconnect to a disconnected task
                        const { taskId } = payload as { taskId?: string };
                        if (!taskId) break;
                        const task = taskSpawner.reconnectTask(taskId);
                        if (task) {
                            broadcast({ type: 'tasks:updated', payload: { tasks: taskSpawner.getAllTasks() } });
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
                        // Create a task to push to GitHub
                        const pushPrompt = 'Push the latest changes to GitHub. First check git status to see what needs to be committed. If there are uncommitted changes, create a commit with an appropriate message, then push to the remote repository. If there are no changes, just confirm that everything is already up to date.';
                        const rules = configStore.getRules();
                        const systemPrompt = rules?.trim() || undefined;
                        logger.info('Creating git push task', { workspaceId });
                        taskSpawner.createTask(pushPrompt, workspaceValidation.data!, systemPrompt);
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
                        const { content, taskId } = payload as { content?: string; taskId?: string };
                        if (!content) {
                            console.error('[Server] supervisor:chat:message requires content');
                            return;
                        }
                        await supervisorChat.sendMessage(content, taskId);
                        break;
                    }

                    case 'supervisor:chat:history': {
                        // Request chat history
                        const history = supervisorChat.getHistory();
                        ws.send(JSON.stringify({
                            type: 'supervisor:chat:history',
                            payload: { messages: history }
                        }));
                        break;
                    }

                    case 'supervisor:chat:clear': {
                        // Clear chat history
                        supervisorChat.clearHistory();
                        broadcast({ type: 'supervisor:chat:history' as WSMessageType, payload: { messages: [] } });
                        break;
                    }
                }
            } catch (err) {
                logger.error('Error handling message', { error: err instanceof Error ? err.message : String(err) });
                sendWSError(ws, 'Internal server error processing request', undefined, 'INTERNAL_ERROR');
            }
        });

        ws.on('close', () => {
            console.log('[Server] Client disconnected');
            clients.delete(ws);
        });
    });

    // REST API routes
    app.get('/api/health', (_req, res) => {
        res.json({ status: 'ok' });
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
        res.json(workspaceStore.getWorkspaces());
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
                    // Add aiCoreConfigured flag based on env vars (takes precedence over config file)
                    const aiCoreConfiguredFromEnv = !!(
                        process.env.SAP_AICORE_CLIENT_ID &&
                        process.env.SAP_AICORE_CLIENT_SECRET
                    );
                    return res.json({ ...updatedConfig, aiCoreConfiguredFromEnv });
                }
            }
        }
        // Add aiCoreConfigured flag and populate from env vars if not in config
        const aiCoreConfiguredFromEnv = !!(
            process.env.SAP_AICORE_CLIENT_ID &&
            process.env.SAP_AICORE_CLIENT_SECRET
        );
        // If no credentials in config but have env vars, populate from env
        const aiCoreCredentials = config.aiCoreCredentials?.clientId
            ? config.aiCoreCredentials
            : (aiCoreConfiguredFromEnv ? {
                clientId: process.env.SAP_AICORE_CLIENT_ID || '',
                clientSecret: process.env.SAP_AICORE_CLIENT_SECRET || '',
                authUrl: process.env.SAP_AICORE_AUTH_URL || '',
                baseUrl: process.env.SAP_AICORE_BASE_URL || '',
                resourceGroup: process.env.SAP_AICORE_RESOURCE_GROUP || 'default',
                timeoutMs: parseInt(process.env.SAP_AICORE_TIMEOUT_MS || '120000', 10)
            } : undefined);
        res.json({ ...config, aiCoreCredentials, aiCoreConfiguredFromEnv });
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

            res.json(updatedConfig);
        } catch (error) {
            logger.error('Failed to update config', { error });
            res.status(500).json({ error: 'Failed to update config' });
        }
    });

    // MCP server config type
    interface MCPServerConfig {
        command?: string;
        args?: string[];
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

            // Extract global MCP servers
            const globalServers: { name: string; command: string; args?: string[]; scope: 'global' }[] = [];
            if (claudeConfig.mcpServers) {
                for (const [name, config] of Object.entries(claudeConfig.mcpServers)) {
                    globalServers.push({
                        name,
                        command: config.command || '',
                        args: config.args || [],
                        scope: 'global'
                    });
                }
            }

            // Extract project-specific MCP servers if workspace path provided
            const projectServers: { name: string; command: string; args?: string[]; scope: 'project'; projectPath: string }[] = [];
            if (claudeConfig.projects) {
                for (const [projectPath, projectConfig] of Object.entries(claudeConfig.projects)) {
                    if (projectConfig.mcpServers) {
                        for (const [name, config] of Object.entries(projectConfig.mcpServers)) {
                            // Include if no workspace filter, or if this project matches the workspace
                            if (!workspacePath || projectPath === workspacePath || workspacePath.startsWith(projectPath)) {
                                projectServers.push({
                                    name,
                                    command: config.command || '',
                                    args: config.args || [],
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
    app.get('/api/claude-config/mcp-servers', (_req, res) => {
        try {
            const homeDir = process.env.HOME || process.env.USERPROFILE || '';
            const claudeConfigPath = join(homeDir, '.claude.json');

            if (!existsSync(claudeConfigPath)) {
                // Return empty mcpServers if file doesn't exist
                return res.json({
                    content: JSON.stringify({}, null, 2),
                    path: claudeConfigPath,
                    exists: false
                });
            }

            const fileContent = readFileSync(claudeConfigPath, 'utf-8');
            const config = JSON.parse(fileContent);
            const mcpServers = config.mcpServers || {};

            res.json({
                content: JSON.stringify(mcpServers, null, 2),
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
            const { content } = req.body;

            if (typeof content !== 'string') {
                return res.status(400).json({ error: 'Content must be a string' });
            }

            // Validate JSON syntax and structure
            let mcpServers;
            try {
                mcpServers = JSON.parse(content);
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
            let config: Record<string, unknown> = {};
            if (existsSync(claudeConfigPath)) {
                const fileContent = readFileSync(claudeConfigPath, 'utf-8');
                config = JSON.parse(fileContent);
            }

            // Update only the mcpServers section
            config.mcpServers = mcpServers;

            writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2), 'utf-8');
            console.log('[Server] Updated MCP servers in Claude config:', claudeConfigPath);

            res.json({ success: true, path: claudeConfigPath });
        } catch (error) {
            console.error('[Server] Failed to write MCP servers config:', error);
            res.status(500).json({ error: 'Failed to write MCP servers config' });
        }
    });

    // Test AI Core credentials endpoint
    app.post('/api/aicore/test', async (req, res) => {
        try {
            const { clientId, clientSecret, authUrl, baseUrl, resourceGroup, timeoutMs } = req.body;

            if (!clientId || !clientSecret || !authUrl) {
                return res.status(400).json({
                    success: false,
                    error: 'Missing required credentials (clientId, clientSecret, authUrl)'
                });
            }

            // Test by obtaining an access token
            const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
            const tokenUrl = `${authUrl}/oauth/token?grant_type=client_credentials`;

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs || 30000);

            try {
                const tokenResponse = await fetch(tokenUrl, {
                    method: 'POST',
                    headers: {
                        Authorization: `Basic ${credentials}`,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    signal: controller.signal
                });

                clearTimeout(timeout);

                if (!tokenResponse.ok) {
                    const errorText = await tokenResponse.text();
                    return res.json({
                        success: false,
                        error: `Authentication failed: ${tokenResponse.status} - ${errorText}`
                    });
                }

                const tokenData = await tokenResponse.json();
                if (!tokenData.access_token) {
                    return res.json({
                        success: false,
                        error: 'Invalid token response from auth server'
                    });
                }

                // If baseUrl is provided, also test the AI Core API endpoint
                if (baseUrl) {
                    const apiUrl = `${baseUrl}/v2/lm/deployments?$top=1`;
                    const apiResponse = await fetch(apiUrl, {
                        headers: {
                            Authorization: `Bearer ${tokenData.access_token}`,
                            'AI-Resource-Group': resourceGroup || 'default'
                        }
                    });

                    if (!apiResponse.ok) {
                        return res.json({
                            success: false,
                            error: `API access failed: ${apiResponse.status} - Unable to access AI Core API`
                        });
                    }
                }

                res.json({
                    success: true,
                    message: baseUrl
                        ? 'Successfully authenticated and connected to AI Core API'
                        : 'Successfully authenticated with SAP AI Core'
                });

            } catch (fetchError: unknown) {
                clearTimeout(timeout);
                if (fetchError instanceof Error && fetchError.name === 'AbortError') {
                    return res.json({
                        success: false,
                        error: 'Connection timeout - unable to reach auth server'
                    });
                }
                const message = fetchError instanceof Error ? fetchError.message : String(fetchError);
                return res.json({
                    success: false,
                    error: `Connection error: ${message}`
                });
            }
        } catch (error: unknown) {
            console.error('[Server] Error testing AI Core credentials:', error);
            const message = error instanceof Error ? error.message : String(error);
            res.status(500).json({
                success: false,
                error: `Server error: ${message}`
            });
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
            const task = taskSpawner.getTask(taskId) || taskSpawner.getDisconnectedTask(taskId);

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

            const conversation = await getConversationHistory(workspace.id, task.sessionId);
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

            const conversation = await getConversationHistory(workspaceId, sessionId);
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

            const conversation = await getConversationHistory(workspace.id, task.sessionId);
            if (!conversation || conversation.messages.length === 0) {
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

    // Restart server endpoint - triggers graceful shutdown, tsx watch will restart
    app.post('/api/server/restart', (_req, res) => {
        console.log('[Server] Restart requested via API');
        res.json({ status: 'restarting' });

        // Give time for response to be sent, then trigger graceful shutdown
        setTimeout(() => {
            gracefulShutdown('RESTART');
        }, 100);
    });

    // Graceful shutdown handler
    function gracefulShutdown(signal: string): void {
        console.log(`[Server] Shutting down (${signal}), notifying clients and saving state...`);

        // Notify all connected clients that the server is reloading
        broadcast({ type: 'server:reloading' as WSMessageType, payload: {} });

        // Give clients enough time to receive the message and for I/O to complete
        // 500ms provides a good balance between responsiveness and reliability
        setTimeout(() => {
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

    return { app, server, wss, taskSpawner, workspaceStore, supervisorChat, gracefulShutdown };
}
