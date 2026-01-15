import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { TaskSpawner } from './task-spawner.js';
import { WorkspaceStore } from './workspace-store.js';
import { ConfigStore } from './config-store.js';
import { SupervisorChat } from './supervisor-chat.js';
import { getConversationHistory, getWorkspaceSessions } from './conversation-parser.js';
import { createAnthropicProxy } from './anthropic-proxy/index.js';
import { Task, Workspace, WSMessage, WSMessageType, ChatMessage, SuggestedAction, WaitingInputType } from '@claudia/shared';

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
    'workspace:create',
    'workspace:delete',
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
    })();

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
        console.log(`[Server] taskStateChanged event: task=${task.id} state=${task.state}`);
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
        // Send updated task list after reconnection
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
                    console.error('[Server] Invalid JSON in WebSocket message');
                    return;
                }

                if (!isValidWSMessage(parsed)) {
                    console.error('[Server] Invalid WebSocket message format or unknown type:', parsed);
                    return;
                }

                const message = parsed;
                console.log('[Server] Received:', message.type);

                const payload = message.payload || {};

                switch (message.type) {
                    case 'task:create': {
                        // Create a new Claude Code CLI instance
                        const { prompt, workspaceId } = payload as { prompt?: string; workspaceId?: string };
                        if (!prompt || !workspaceId) {
                            console.error('[Server] task:create requires prompt and workspaceId');
                            return;
                        }
                        taskSpawner.createTask(prompt, workspaceId);
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
                        if (taskId) taskSpawner.destroyTask(taskId);
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
