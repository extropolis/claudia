import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { TaskSpawner } from './task-spawner.js';
import { WorkspaceStore } from './workspace-store.js';
import { ConfigStore } from './config-store.js';
import { SupervisorChat } from './supervisor-chat.js';
import { getConversationHistory, getWorkspaceSessions } from './conversation-parser.js';
import { createAnthropicProxy } from './anthropic-proxy/index.js';
import { Task, Workspace, WSMessage, WSMessageType, ChatMessage, SuggestedAction, WaitingInputType } from '@claudia/shared';

export function createApp(basePath?: string) {
    const app = express();
    const server = createServer(app);
    const wss = new WebSocketServer({ server });

    // Middleware
    app.use(cors());
    app.use(express.json({ limit: '50mb' })); // Increased limit for large AI requests

    // Mount Anthropic Proxy if SAP AI Core is configured
    if (process.env.SAP_AICORE_CLIENT_ID && process.env.SAP_AICORE_CLIENT_SECRET) {
        console.log('[Server] SAP AI Core configured, mounting Anthropic proxy at /');
        const anthropicProxy = createAnthropicProxy({
            clientId: process.env.SAP_AICORE_CLIENT_ID,
            clientSecret: process.env.SAP_AICORE_CLIENT_SECRET,
            authUrl: process.env.SAP_AICORE_AUTH_URL || '',
            baseUrl: process.env.SAP_AICORE_BASE_URL || '',
            resourceGroup: process.env.SAP_AICORE_RESOURCE_GROUP || 'default',
            requestTimeoutMs: parseInt(process.env.SAP_AICORE_TIMEOUT_MS || '120000', 10)
        });
        app.use('/', anthropicProxy);
    } else {
        console.log('[Server] SAP AI Core not configured, Anthropic proxy disabled');
    }

    // Initialize services
    const configStore = new ConfigStore(basePath);
    const taskSpawner = new TaskSpawner(undefined, true, configStore);
    const workspaceStore = new WorkspaceStore(basePath);
    // SupervisorChat now handles both auto-analysis (formerly TaskSupervisor) and chat
    const supervisorChat = new SupervisorChat(taskSpawner, workspaceStore, configStore);

    // Track connected clients
    const clients = new Set<WebSocket>();

    // Broadcast to all connected clients
    function broadcast(message: WSMessage): void {
        const data = JSON.stringify(message);
        console.log(`[Server] Broadcasting: type=${message.type}`);
        for (const client of clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(data);
            }
        }
    }

    // Wire up TaskSpawner events
    taskSpawner.on('taskCreated', (task: Task) => {
        broadcast({ type: 'task:created', payload: { task } });
        broadcast({ type: 'tasks:updated', payload: { tasks: taskSpawner.getAllTasks() } });
    });

    taskSpawner.on('taskStateChanged', (task: Task) => {
        broadcast({ type: 'task:stateChanged', payload: { task } });
        broadcast({ type: 'tasks:updated', payload: { tasks: taskSpawner.getAllTasks() } });
    });

    taskSpawner.on('taskOutput', (taskId: string, data: string) => {
        broadcast({ type: 'task:output', payload: { taskId, data } });
    });

    taskSpawner.on('taskRestore', (taskId: string, history: string) => {
        broadcast({ type: 'task:restore', payload: { taskId, history } });
    });

    taskSpawner.on('taskDestroyed', (taskId: string) => {
        broadcast({ type: 'task:destroyed', payload: { taskId } });
        broadcast({ type: 'tasks:updated', payload: { tasks: taskSpawner.getAllTasks() } });
    });

    taskSpawner.on('tasksUpdated', () => {
        broadcast({ type: 'tasks:updated', payload: { tasks: taskSpawner.getAllTasks() } });
    });

    taskSpawner.on('taskWaitingInput', (taskId: string, inputType: WaitingInputType, recentOutput: string) => {
        console.log(`[Server] Task ${taskId} waiting for input: ${inputType}`);
        broadcast({
            type: 'task:waitingInput',
            payload: { taskId, inputType, recentOutput }
        });
    });

    // Wire up SupervisorChat events (handles both auto-analysis and user chat)
    supervisorChat.on('message', (message: ChatMessage) => {
        broadcast({ type: 'supervisor:chat:response' as WSMessageType, payload: { message } });
    });

    supervisorChat.on('typing', (isTyping: boolean) => {
        broadcast({ type: 'supervisor:chat:typing' as WSMessageType, payload: { isTyping } });
    });

    // WebSocket connection handling
    wss.on('connection', (ws: WebSocket) => {
        console.log('[Server] Client connected');
        clients.add(ws);

        // Send current state to new client
        const tasks = taskSpawner.getAllTasks();
        const workspaces = workspaceStore.getWorkspaces();
        ws.send(JSON.stringify({
            type: 'init',
            payload: { tasks, workspaces }
        }));

        ws.on('message', async (data: Buffer) => {
            try {
                const message = JSON.parse(data.toString());
                console.log('[Server] Received:', message.type);

                switch (message.type) {
                    case 'task:create': {
                        // Create a new Claude Code CLI instance
                        const { prompt, workspaceId } = message.payload;
                        if (!prompt || !workspaceId) {
                            console.error('[Server] task:create requires prompt and workspaceId');
                            return;
                        }
                        taskSpawner.createTask(prompt, workspaceId);
                        break;
                    }

                    case 'task:select': {
                        // Switch active task (for terminal viewing)
                        const { taskId } = message.payload;
                        taskSpawner.setTaskActive(taskId, true);
                        break;
                    }

                    case 'task:input': {
                        // Send input to a task's terminal
                        const { taskId, input } = message.payload;
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
                        const { taskId, cols, rows } = message.payload;
                        taskSpawner.resizeTask(taskId, cols, rows);
                        break;
                    }

                    case 'task:destroy': {
                        // Kill and remove a task
                        const { taskId } = message.payload;
                        taskSpawner.destroyTask(taskId);
                        break;
                    }

                    case 'task:interrupt': {
                        // Interrupt a running task (send ESC to cancel current operation)
                        const { taskId } = message.payload;
                        taskSpawner.interruptTask(taskId);
                        break;
                    }

                    case 'task:reconnect': {
                        // Reconnect to a disconnected task
                        const { taskId } = message.payload;
                        const task = taskSpawner.reconnectTask(taskId);
                        if (task) {
                            broadcast({ type: 'tasks:updated', payload: { tasks: taskSpawner.getAllTasks() } });
                        }
                        break;
                    }

                    case 'task:restore': {
                        // Request terminal history restore
                        const { taskId } = message.payload;
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

                    case 'workspace:create': {
                        // Add a workspace
                        const { path } = message.payload;
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
                        const { workspaceId } = message.payload;
                        if (workspaceStore.deleteWorkspace(workspaceId)) {
                            broadcast({ type: 'workspace:deleted' as WSMessageType, payload: { workspaceId } });
                        }
                        break;
                    }

                    case 'supervisor:action': {
                        // Execute a supervisor-suggested action
                        const { taskId, action } = message.payload;
                        supervisorChat.executeAction(taskId, action as SuggestedAction);
                        break;
                    }

                    case 'supervisor:analyze': {
                        // Manually request task analysis (triggers auto-analysis)
                        const { taskId } = message.payload;
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
                        const { content, taskId } = message.payload;
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
                console.error('[Server] Error handling message:', err);
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

    app.get('/api/tasks', (_req, res) => {
        res.json(taskSpawner.getAllTasks());
    });

    // Poll endpoint for task status - more reliable than hooks
    app.get('/api/tasks/:taskId/status', (req, res) => {
        const { taskId } = req.params;
        const task = taskSpawner.getTask(taskId);

        if (!task) {
            // Check disconnected tasks
            const disconnected = taskSpawner.getDisconnectedTask(taskId);
            if (disconnected) {
                return res.json({
                    id: taskId,
                    state: 'disconnected'
                });
            }
            return res.status(404).json({ error: 'Task not found' });
        }

        res.json({
            id: task.id,
            state: task.state,
            lastActivity: task.lastActivity
        });
    });

    app.get('/api/workspaces', (_req, res) => {
        res.json(workspaceStore.getWorkspaces());
    });

    // Config API routes
    app.get('/api/config', (_req, res) => {
        res.json(configStore.getConfig());
    });

    app.put('/api/config', (req, res) => {
        try {
            const updatedConfig = configStore.updateConfig(req.body);

            // If rules were updated, sync to all workspace CLAUDE.md files
            if (req.body.rules !== undefined) {
                const workspaces = workspaceStore.getWorkspaces();
                for (const workspace of workspaces) {
                    try {
                        syncRulesToClaudeMd(workspace.id, req.body.rules);
                    } catch (err) {
                        console.error(`[Server] Failed to sync rules to ${workspace.id}:`, err);
                    }
                }
            }

            res.json(updatedConfig);
        } catch (error) {
            console.error('[Server] Failed to update config:', error);
            res.status(500).json({ error: 'Failed to update config' });
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

    // Claude Code PreToolUse Hook endpoint - fires when Claude starts using a tool (busy)
    app.post('/api/claude-busy', (req, res) => {
        const { session_id, tool_name } = req.body;
        console.log(`[Server] Claude busy hook received for session: ${session_id}, tool: ${tool_name || 'unknown'}`);
        if (session_id) {
            taskSpawner.handleBusyHook(session_id, tool_name);
        }
        res.json({ ok: true });
    });

    // Claude Code Stop Hook endpoint
    app.post('/api/claude-stopped', (req, res) => {
        const { session_id } = req.body;
        console.log(`[Server] Claude stop hook received for session: ${session_id}`);
        if (session_id) {
            taskSpawner.handleStopHook(session_id);
        }
        res.json({ ok: true });
    });

    // Claude Code Notification Hook endpoint
    // Fires when Claude needs user input (permission_prompt, idle_prompt)
    app.post('/api/claude-notification', (req, res) => {
        const { session_id, notification_type } = req.body;
        console.log(`[Server] Claude notification hook: ${notification_type} for session: ${session_id}`);
        if (session_id && notification_type) {
            taskSpawner.handleNotificationHook(session_id, notification_type);
        }
        res.json({ ok: true });
    });

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

    // Graceful shutdown handler
    function gracefulShutdown(signal: string): void {
        console.log(`[Server] Shutting down (${signal}), notifying clients and saving state...`);

        // Notify all connected clients that the server is reloading
        broadcast({ type: 'server:reloading' as WSMessageType, payload: {} });

        // Give clients a moment to receive the message
        setTimeout(() => {
            // Save all state
            taskSpawner.saveNow();
            supervisorChat.saveChatHistoryNow();
            taskSpawner.destroy();

            // Close WebSocket connections gracefully
            for (const client of clients) {
                client.close(1001, 'Server reloading');
            }

            process.exit(0);
        }, 100);
    }

    // Cleanup on server shutdown
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    return { app, server, wss, taskSpawner, workspaceStore };
}
