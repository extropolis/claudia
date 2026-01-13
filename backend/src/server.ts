import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import { ProcessManager } from './process-manager.js';
import { TaskManager } from './task-manager.js';
import { ConversationStore } from './conversation-store.js';
import { Orchestrator } from './orchestrator.js';
import { TodoManager } from './todo-manager.js';
import { AuthService } from './auth-service.js';
import { ConfigStore } from './config-store.js';
import { ProjectStore } from './project-store.js';
import { WorkspaceStore } from './workspace-store.js';
import { createAuthRoutes } from './auth-routes.js';
import { createAuthMiddleware, createOptionalAuthMiddleware } from './auth-middleware.js';
import { IntentRouter } from './services/intent-router.js';
import { CommandExecutor } from './services/command-executor.js';
import { WebSearcher } from './services/web-searcher.js';
import { ContextManager } from './services/context-manager.js';
import { ChatMessage, Task, WSMessage, WSMessageType, ConversationSummary, Workspace } from '@claudia/shared';

export function createApp(basePath?: string) {
    const app = express();
    const server = createServer(app);
    const wss = new WebSocketServer({ server });

    // Middleware
    app.use(cors());
    app.use(express.json());

    // Initialize managers with optional basePath for Electron userData
    const configStore = new ConfigStore(basePath);
    const processManager = new ProcessManager(configStore);
    const taskManager = new TaskManager();
    const conversationStore = new ConversationStore(basePath);
    const todoManager = new TodoManager();
    const authService = new AuthService();
    const projectStore = new ProjectStore(basePath);
    const workspaceStore = new WorkspaceStore(basePath);

    // Initialize services
    const intentRouter = new IntentRouter();
    const contextManager = new ContextManager(conversationStore);
    const commandExecutor = new CommandExecutor();
    const webSearcher = new WebSearcher();

    const orchestrator = new Orchestrator(
        processManager,
        taskManager,
        conversationStore,
        projectStore,
        configStore,
        workspaceStore,
        {
            intentRouter,
            commandExecutor,
            webSearcher,
            contextManager
        }
    );

    // Create middleware
    const authMiddleware = createAuthMiddleware(authService);
    const optionalAuthMiddleware = createOptionalAuthMiddleware(authService);

    // Track connected clients
    const clients = new Set<WebSocket>();

    // Broadcast to all connected clients
    function broadcast(message: WSMessage): void {
        const data = JSON.stringify(message);
        console.log(`[Server] Broadcasting: type=${message.type}, clients=${clients.size}, payload preview=${data.substring(0, 200)}`);
        for (const client of clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(data);
            }
        }
    }

    // WebSocket connection handling
    wss.on('connection', (ws: WebSocket) => {
        console.log('[Server] Client connected');
        clients.add(ws);

        // Send current state to new client
        const tasks = taskManager.getAllTasks();
        const currentProject = projectStore.getCurrentProject();
        const workspaces = workspaceStore.getWorkspaces();
        const activeWorkspaceId = workspaceStore.getActiveWorkspaceId();
        ws.send(JSON.stringify({
            type: 'init',
            payload: { tasks, currentProject, workspaces, activeWorkspaceId }
        }));

        ws.on('message', async (data: Buffer) => {
            try {
                const message = JSON.parse(data.toString());
                console.log('[Server] Received:', message);

                if (message.type === 'chat:send') {
                    await orchestrator.sendMessage(message.payload.content, message.payload.images);
                } else if (message.type === 'conversation:select') {
                    // User selected a conversation to resume
                    await orchestrator.selectConversation(
                        message.payload.conversationId,
                        message.payload.originalMessage
                    );
                } else if (message.type === 'task:delete') {
                    // Delete a single task
                    const { taskId } = message.payload;
                    taskManager.deleteTask(taskId);
                } else if (message.type === 'task:clear') {
                    // Clear all tasks
                    taskManager.clearTasks();
                } else if (message.type === 'chat:clear') {
                    // Clear chat conversation
                    conversationStore.clearCurrentConversation();
                    broadcast({ type: 'chat:cleared' as WSMessageType, payload: {} });
                } else if (message.type === 'task:stop') {
                    // Stop a running task
                    const { taskId } = message.payload;
                    await orchestrator.stopTask(taskId);
                } else if (message.type === 'project:set') {
                    // Set current project directory
                    try {
                        const { path } = message.payload;
                        projectStore.setCurrentProject(path);
                        const currentProject = projectStore.getCurrentProject();
                        broadcast({ type: 'project:changed' as WSMessageType, payload: { currentProject } });
                    } catch (error) {
                        ws.send(JSON.stringify({
                            type: 'project:error' as WSMessageType,
                            payload: { error: (error as Error).message }
                        }));
                    }
                } else if (message.type === 'task:input') {
                    // Send input to a running task's worker or resume a completed/stopped task
                    const { taskId, input } = message.payload;
                    const task = taskManager.getTask(taskId);

                    if (!task) {
                        console.log(`[Server] Task ${taskId} not found`);
                        return;
                    }

                    if (task.workerId && task.status === 'running') {
                        // Task is running - send input to existing worker
                        const success = await processManager.sendInput(task.workerId, input);
                        if (!success) {
                            console.log(`[Server] Failed to send input to task ${taskId}`);
                        }
                    } else if (task.status === 'complete' || task.status === 'stopped' || task.status === 'error' || task.status === 'pending') {
                        // Task is not running - resume with new instructions
                        console.log(`[Server] Resuming task ${taskId} with new instructions: ${input}`);

                        // Emit the user's input message to the task output so it appears in the task view
                        taskManager.appendOutput(task.id, `\n\nYou:\n${input}\n\n`);

                        // Get project path from task
                        const cwd = task.projectPath;

                        // Spawn new worker with continuation instructions
                        const mcpServers = configStore.getMCPServers();
                        const workerPrompt = `Continue the task: ${task.name}\n\nPrevious work: ${task.description}\n\nNew instructions: ${input}`;

                        const worker = await processManager.spawn(task.id, workerPrompt, cwd, mcpServers);
                        taskManager.assignWorker(task.id, worker.id);
                    }
                } else if (message.type === 'workspace:create') {
                    // Add workspace by path
                    try {
                        const { path } = message.payload;
                        const workspace = workspaceStore.addWorkspace(path);
                        broadcast({ type: 'workspace:created' as WSMessageType, payload: { workspace } });
                    } catch (error) {
                        ws.send(JSON.stringify({
                            type: 'project:error' as WSMessageType,
                            payload: { error: (error as Error).message }
                        }));
                    }
                } else if (message.type === 'workspace:delete') {
                    // Delete workspace
                    const { workspaceId } = message.payload;
                    if (workspaceStore.deleteWorkspace(workspaceId)) {
                        broadcast({ type: 'workspace:deleted' as WSMessageType, payload: { workspaceId } });
                    }
                } else if (message.type === 'workspace:setActive') {
                    // Set active workspace for orchestrator
                    try {
                        const { workspaceId } = message.payload;
                        orchestrator.setWorkspace(workspaceId);
                        broadcast({ type: 'workspace:setActive' as WSMessageType, payload: { workspaceId } });
                    } catch (error) {
                        ws.send(JSON.stringify({
                            type: 'project:error' as WSMessageType,
                            payload: { error: (error as Error).message }
                        }));
                    }
                } else if (message.type === 'task:create') {
                    // Manually create a task and spawn worker
                    const { name, description, workspaceId } = message.payload;
                    console.log(`[Server] task:create received: name=${name}, workspaceId=${workspaceId}`);
                    const task = await orchestrator.spawnTask(name, description, undefined, workspaceId);
                    // Task is now running with worker assigned
                    broadcast({ type: 'task:created' as WSMessageType, payload: { task } });
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

    // Wire up events to broadcast
    taskManager.on('created', (task: Task) => {
        broadcast({ type: 'task:created', payload: { task } });
    });

    taskManager.on('updated', (task: Task) => {
        broadcast({ type: 'task:updated', payload: { task } });
    });

    taskManager.on('output', ({ taskId, data }: { taskId: string; data: string }) => {
        broadcast({ type: 'task:output', payload: { taskId, data } });
    });

    taskManager.on('complete', (task: Task) => {
        broadcast({ type: 'task:complete', payload: { task } });
    });

    taskManager.on('deleted', (taskId: string) => {
        broadcast({ type: 'task:deleted', payload: { taskId } });
    });

    taskManager.on('cleared', (taskIds: string[]) => {
        broadcast({ type: 'task:cleared', payload: { taskIds } });
    });

    orchestrator.on('chat', (message: ChatMessage) => {
        broadcast({ type: 'chat:message', payload: { message } });
    });

    // Conversation events
    orchestrator.on('conversation:select', ({ candidates, originalMessage }: { candidates: ConversationSummary[], originalMessage: string }) => {
        broadcast({ type: 'conversation:select' as WSMessageType, payload: { candidates, originalMessage } });
    });

    orchestrator.on('conversation:resumed', ({ conversation }) => {
        broadcast({ type: 'conversation:resumed' as WSMessageType, payload: { conversation } });
    });

    // Wire process manager events to task manager
    processManager.on('output', ({ workerId, taskId, data }) => {
        taskManager.appendOutput(taskId, data);
    });

    processManager.on('complete', ({ workerId, taskId, exitCode }) => {
        taskManager.completeTask(taskId, exitCode);
    });

    processManager.on('error', ({ workerId, taskId, error }) => {
        taskManager.updateStatus(taskId, 'error', error);
    });

    // REST API routes

    // Auth routes (no authentication required)
    app.use('/api/auth', createAuthRoutes(authService));

    app.get('/api/health', (req, res) => {
        res.json({ status: 'ok' });
    });

    // Task routes - optional authentication
    app.get('/api/tasks', optionalAuthMiddleware, (req, res) => {
        res.json(taskManager.getAllTasks());
    });

    app.get('/api/tasks/:id', optionalAuthMiddleware, (req, res) => {
        const task = taskManager.getTask(req.params.id);
        if (!task) {
            return res.status(404).json({ error: 'Task not found' });
        }
        res.json(task);
    });

    app.get('/api/tasks/:id/files', optionalAuthMiddleware, (req, res) => {
        const files = taskManager.getTaskFiles(req.params.id);
        res.json(files);
    });

    app.post('/api/tasks', optionalAuthMiddleware, async (req, res) => {
        const { name, description, parentId, projectPath } = req.body;
        if (!name || !description) {
            return res.status(400).json({ error: 'name and description required' });
        }
        const task = await orchestrator.spawnTask(name, description, parentId, projectPath);
        res.json(task);
    });

    // Chat routes - optional authentication
    app.post('/api/chat', optionalAuthMiddleware, async (req, res) => {
        const { content } = req.body;
        if (!content) {
            return res.status(400).json({ error: 'content required' });
        }
        await orchestrator.sendMessage(content);
        res.json({ status: 'sent' });
    });

    // Todo routes - optional authentication
    app.get('/api/todos', optionalAuthMiddleware, (req, res) => {
        res.json(todoManager.getAllTodos());
    });

    app.get('/api/todos/:id', optionalAuthMiddleware, (req, res) => {
        const todo = todoManager.getTodoById(req.params.id);
        if (!todo) {
            return res.status(404).json({ error: 'Todo not found' });
        }
        res.json(todo);
    });

    app.post('/api/todos', optionalAuthMiddleware, (req, res) => {
        const { title, description } = req.body;
        if (!title) {
            return res.status(400).json({ error: 'title required' });
        }
        const todo = todoManager.createTodo(title, description);
        res.status(201).json(todo);
    });

    app.put('/api/todos/:id', optionalAuthMiddleware, (req, res) => {
        const { title, description, completed } = req.body;
        const todo = todoManager.updateTodo(req.params.id, { title, description, completed });
        if (!todo) {
            return res.status(404).json({ error: 'Todo not found' });
        }
        res.json(todo);
    });

    app.delete('/api/todos/:id', optionalAuthMiddleware, (req, res) => {
        const deleted = todoManager.deleteTodo(req.params.id);
        if (!deleted) {
            return res.status(404).json({ error: 'Todo not found' });
        }
        res.status(204).send();
    });

    // Config routes
    app.get('/api/config', optionalAuthMiddleware, (req, res) => {
        console.log('[Server] GET /api/config');
        res.json(configStore.getConfig());
    });

    app.put('/api/config', optionalAuthMiddleware, async (req, res) => {
        console.log('[Server] PUT /api/config', req.body);
        try {
            // Check if backend is changing
            const oldConfig = configStore.getConfig();
            const oldBackend = oldConfig.aiBackend || 'opencode';
            const newBackend = req.body.aiBackend;
            const backendChanged = newBackend && newBackend !== oldBackend;

            // Update config
            const updated = configStore.updateConfig(req.body);

            // If backend changed, trigger hot-swap
            if (backendChanged) {
                console.log(`[Server] Backend changed from ${oldBackend} to ${newBackend}, triggering hot-swap...`);
                try {
                    await processManager.switchBackend(newBackend);
                    console.log('[Server] Backend hot-swap completed successfully');

                    // Broadcast backend change to all clients
                    broadcast({
                        type: 'config:backend-changed' as WSMessageType,
                        payload: { backend: newBackend }
                    });
                } catch (error) {
                    console.error('[Server] Backend hot-swap failed:', error);
                    // Still return success for config save, but log the error
                    // The backend will be switched on next spawn attempt
                }
            }

            res.json(updated);
        } catch (error) {
            res.status(500).json({ error: 'Failed to update config' });
        }
    });

    app.get('/api/config/prompts', optionalAuthMiddleware, (req, res) => {
        console.log('[Server] GET /api/config/prompts');
        res.json(configStore.getSystemPrompts());
    });

    app.put('/api/config/prompts', optionalAuthMiddleware, (req, res) => {
        console.log('[Server] PUT /api/config/prompts', Object.keys(req.body));
        try {
            const updated = configStore.updateSystemPrompts(req.body);
            res.json(updated);
        } catch (error) {
            res.status(500).json({ error: 'Failed to update prompts' });
        }
    });

    app.post('/api/config/reset', optionalAuthMiddleware, (req, res) => {
        console.log('[Server] POST /api/config/reset');
        try {
            const config = configStore.resetToDefaults();
            res.json(config);
        } catch (error) {
            res.status(500).json({ error: 'Failed to reset config' });
        }
    });

    app.post('/api/config/test-backend', optionalAuthMiddleware, async (req, res) => {
        console.log('[Server] POST /api/config/test-backend', req.body);
        try {
            const { backend } = req.body;
            if (!backend || (backend !== 'opencode' && backend !== 'claude')) {
                return res.status(400).json({ error: 'Invalid backend. Must be "opencode" or "claude"' });
            }

            // Test if the backend can be started
            const testResult = await processManager.testBackend(backend);
            res.json(testResult);
        } catch (error) {
            console.error('[Server] Backend test failed:', error);
            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : 'Backend test failed'
            });
        }
    });

    // Project routes
    app.get('/api/project', optionalAuthMiddleware, (req, res) => {
        console.log('[Server] GET /api/project');
        res.json({ currentProject: projectStore.getCurrentProject() });
    });

    app.post('/api/project', optionalAuthMiddleware, (req, res) => {
        console.log('[Server] POST /api/project', req.body);
        try {
            const { path } = req.body;
            if (!path) {
                return res.status(400).json({ error: 'path required' });
            }
            projectStore.setCurrentProject(path);
            const currentProject = projectStore.getCurrentProject();

            // Broadcast to all connected clients
            broadcast({ type: 'project:changed' as WSMessageType, payload: { currentProject } });

            res.json({ currentProject });
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    app.get('/api/project/recent', optionalAuthMiddleware, (req, res) => {
        console.log('[Server] GET /api/project/recent');
        res.json({ recentProjects: projectStore.getRecentProjects() });
    });

    app.delete('/api/project/recent/:path', optionalAuthMiddleware, (req, res) => {
        console.log('[Server] DELETE /api/project/recent', req.params.path);
        try {
            const path = decodeURIComponent(req.params.path);
            projectStore.removeFromRecent(path);
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: 'Failed to remove from recent' });
        }
    });

    // Start orchestrator
    orchestrator.start();

    return { app, server, wss, orchestrator, taskManager, processManager, configStore, projectStore };
}
