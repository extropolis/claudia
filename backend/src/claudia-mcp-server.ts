#!/usr/bin/env node
/**
 * Claudia MCP Server - Allows Claude Code sessions to interact with Claudia orchestrator
 *
 * This is a stdio-based MCP server that exposes Claudia's task management capabilities
 * as tools that Claude Code can use. It communicates with the Claudia backend via HTTP REST API.
 *
 * The server is scoped to a specific workspace via the CLAUDIA_WORKSPACE_ID env var,
 * which is set automatically by the task-spawner when injecting this MCP server.
 *
 * Tools provided:
 *   - claudia_list_tasks: List all tasks in the current workspace
 *   - claudia_get_task_status: Get detailed status of a specific task
 *   - claudia_get_task_output: Fetch recent terminal output from a task
 *   - claudia_create_task: Create a new task in the current workspace
 *   - claudia_send_input: Send input to a task waiting for input
 *   - claudia_continue_task: Send a follow-up prompt to resume an idle task
 *   - claudia_stop_task: Gracefully stop a running task
 *   - claudia_stop_all_tasks: Stop all running tasks in the workspace
 *   - claudia_rename_task: Set a display name for a task
 *   - claudia_delete_task: Archive/remove a task from the sidebar
 *   - claudia_cron_create / claudia_cron_list / claudia_cron_delete / claudia_cron_pause:
 *     Manage scheduled (cron) prompts attached to tasks
 *

 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolveRootWorkspaceId, scopedWorkspaceIds, type WorkspaceScopeEntry } from './workspace-scope.js';

// Backend URL - defaults to localhost:4001, can be overridden via env
const BACKEND_URL = process.env.CLAUDIA_BACKEND_URL || 'http://localhost:4001';

// Workspace this MCP server is scoped to (set by task-spawner)
const WORKSPACE_ID = process.env.CLAUDIA_WORKSPACE_ID || '';

// This agent's own task ID (set by task-spawner, used for self-rename)
const SELF_TASK_ID = process.env.CLAUDIA_TASK_ID || '';

// Whether complexity-based model tiering is enabled. Set by task-spawner when
// the operator turns on the toggle in Settings. Controls whether the
// `complexity` parameter is exposed on claudia_create_task.
const MODEL_TIERING_ENABLED = process.env.CLAUDIA_MODEL_TIERING_ENABLED === '1';

/**
 * Format a duration in milliseconds to a human-readable string
 */
function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}

// Logger that writes to stderr (stdout is reserved for MCP stdio transport)
const log = {
    info: (...args: unknown[]) => console.error('[Claudia MCP]', ...args),
    error: (...args: unknown[]) => console.error('[Claudia MCP ERROR]', ...args),
    debug: (...args: unknown[]) => {
        if (process.env.CLAUDIA_MCP_DEBUG) {
            console.error('[Claudia MCP DEBUG]', ...args);
        }
    }
};

/** Wrap a value as the JSON text payload an MCP tool returns. */
function jsonResult(value: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * Get all workspace IDs that belong to the current workspace scope: the root repo
 * workspace plus all of its worktree children.
 *
 * Resolving upward first is what lets a task in an isolated worktree see its
 * siblings. Scoping to WORKSPACE_ID alone returns only the caller's own task, which
 * makes the duplicate-work check in claudia_list_tasks read as "nothing else is
 * running" — see workspace-scope.ts.
 */
async function getScopedWorkspaceIds(): Promise<Set<string>> {
    if (!WORKSPACE_ID) return new Set<string>();

    try {
        const response = await backendFetch('/api/workspaces');
        if (!response.ok) {
            log.error(
                `Workspace scope: /api/workspaces returned HTTP ${response.status}. ` +
                `Falling back to this workspace only (${WORKSPACE_ID}); sibling worktree ` +
                `tasks will not be visible.`
            );
            return new Set([WORKSPACE_ID]);
        }

        const data = await response.json();
        const workspaces: WorkspaceScopeEntry[] = data.workspaces || data;
        const rootId = resolveRootWorkspaceId(workspaces, WORKSPACE_ID);
        const ids = scopedWorkspaceIds(workspaces, WORKSPACE_ID);

        log.debug(`Workspace scope for ${WORKSPACE_ID}: root=${rootId}, ${ids.size} workspace(s) in scope`);
        return ids;
    } catch (error) {
        log.error(
            `Workspace scope: could not reach the Claudia backend at ${BACKEND_URL} ` +
            `(${error instanceof Error ? error.message : String(error)}). Falling back to ` +
            `this workspace only (${WORKSPACE_ID}); sibling worktree tasks will not be visible.`
        );
        return new Set([WORKSPACE_ID]);
    }
}

/**
 * Make an HTTP request to the Claudia backend
 */
async function backendFetch(path: string, options: RequestInit = {}): Promise<Response> {
    const url = `${BACKEND_URL}${path}`;
    log.debug(`Fetching: ${options.method || 'GET'} ${url}`);

    try {
        const response = await fetch(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers,
            },
        });
        return response;
    } catch (error) {
        log.error(`Backend request failed: ${path}`, error);
        throw new Error(`Failed to connect to Claudia backend at ${BACKEND_URL}. Is the server running?`);
    }
}

/**
 * WebSocket helper for operations that require WS (task:create, task:input, etc.)
 */
async function sendWSMessage(type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const WebSocket = (await import('ws')).default;

    return new Promise((resolve, reject) => {
        const wsUrl = BACKEND_URL.replace('http://', 'ws://').replace('https://', 'wss://');
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(() => {
            ws.close();
            reject(new Error(`WebSocket operation timed out after 30s for ${type}`));
        }, 30000);

        ws.on('open', () => {
            log.debug(`WS connected, sending: ${type}`);
            ws.send(JSON.stringify({ type, payload }));
        });

        ws.on('message', (data: Buffer) => {
            try {
                const msg = JSON.parse(data.toString());
                log.debug(`WS received: ${msg.type}`, JSON.stringify(msg.payload).substring(0, 200));

                // For task:create, wait for task:created direct response.
                // Filter by source='mcp' to ignore broadcasts for other tasks.
                if (type === 'task:create' && msg.type === 'task:created' && msg.payload?.source === 'mcp') {
                    clearTimeout(timeout);
                    ws.close();
                    resolve(msg.payload);
                }

                // For task:input, wait for task:stateChanged (busy means input was accepted)
                if (type === 'task:input' && msg.type === 'task:stateChanged') {
                    clearTimeout(timeout);
                    ws.close();
                    resolve(msg.payload);
                }

                // For task:archive, wait for task:destroyed (archiving emits taskDestroyed internally)
                if (type === 'task:archive' && msg.type === 'task:destroyed') {
                    clearTimeout(timeout);
                    ws.close();
                    resolve(msg.payload);
                }

                // For task:interrupt, wait for state change
                if (type === 'task:interrupt' && msg.type === 'task:stateChanged') {
                    clearTimeout(timeout);
                    ws.close();
                    resolve(msg.payload);
                }

                // For task:rename, wait for task:stateChanged (active tasks) or tasks:updated (disconnected/archived)
                if (type === 'task:rename' && (msg.type === 'task:stateChanged' || msg.type === 'tasks:updated')) {
                    clearTimeout(timeout);
                    ws.close();
                    resolve(msg.payload);
                }

                // For task:stop, wait for task:stopped response
                if (type === 'task:stop' && msg.type === 'task:stopped') {
                    clearTimeout(timeout);
                    ws.close();
                    resolve(msg.payload);
                }

                // For task:stopAll, wait for task:stopAll:result response
                if (type === 'task:stopAll' && msg.type === 'task:stopAll:result') {
                    clearTimeout(timeout);
                    ws.close();
                    resolve(msg.payload);
                }

                // For task:destroy, wait for task:destroyed broadcast
                if (type === 'task:destroy' && msg.type === 'task:destroyed') {
                    clearTimeout(timeout);
                    ws.close();
                    resolve(msg.payload);
                }

                // Handle errors
                if (msg.type === 'error') {
                    clearTimeout(timeout);
                    ws.close();
                    reject(new Error(msg.payload?.message || 'Unknown WebSocket error'));
                }
            } catch (e) {
                // Ignore parse errors for non-JSON messages
            }
        });

        ws.on('error', (err: Error) => {
            clearTimeout(timeout);
            reject(new Error(`WebSocket error: ${err.message}. Is the Claudia server running?`));
        });

        ws.on('close', () => {
            clearTimeout(timeout);
        });
    });
}

/**
 * Send a WS message and wait for one of multiple possible responses.
 * The matcher function is called for each incoming message and should return
 * a result object if the message is the expected response, or null to keep waiting.
 */
async function sendWSMessageWithMultiResponse<T>(
    type: string,
    payload: Record<string, unknown>,
    matcher: (msg: { type: string; payload?: any }) => T | null,
    timeoutMs: number = 30000
): Promise<T> {
    const WebSocket = (await import('ws')).default;

    return new Promise((resolve, reject) => {
        const wsUrl = BACKEND_URL.replace('http://', 'ws://').replace('https://', 'wss://');
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(() => {
            ws.close();
            reject(new Error(`WebSocket operation timed out after ${timeoutMs / 1000}s for ${type}`));
        }, timeoutMs);

        ws.on('open', () => {
            log.debug(`WS connected, sending: ${type}`);
            ws.send(JSON.stringify({ type, payload }));
        });

        ws.on('message', (data: Buffer) => {
            try {
                const msg = JSON.parse(data.toString());
                const result = matcher(msg);
                if (result !== null) {
                    clearTimeout(timeout);
                    ws.close();
                    resolve(result);
                }
                if (msg.type === 'error') {
                    clearTimeout(timeout);
                    ws.close();
                    reject(new Error(msg.payload?.message || 'Unknown WebSocket error'));
                }
            } catch {
                // Ignore parse errors
            }
        });

        ws.on('error', (err: Error) => {
            clearTimeout(timeout);
            reject(new Error(`WebSocket error: ${err.message}`));
        });

        ws.on('close', () => {
            clearTimeout(timeout);
        });
    });
}

// Create the MCP server
const server = new McpServer({
    name: 'claudia',
    version: '1.0.0',
}, {
    capabilities: {
        tools: {},
    }
});

// ============================================================================
// Tool: claudia_list_tasks
// ============================================================================
server.tool(
    'claudia_list_tasks',
    `List all tasks in the current workspace (including disconnected/interrupted ones). Shows task ID, state, prompt, and whether it is waiting for input. Disconnected tasks can be resumed via claudia_continue_task.${WORKSPACE_ID ? ` Scoped to workspace: ${WORKSPACE_ID}` : ''}`,
    {},
    async () => {
        try {
            const response = await backendFetch('/api/tasks');
            if (!response.ok) {
                return { content: [{ type: 'text', text: `Error: Failed to list tasks (HTTP ${response.status})` }] };
            }
            let tasks = await response.json();

            // Filter to current workspace and its child worktrees
            if (WORKSPACE_ID) {
                const scopedIds = await getScopedWorkspaceIds();
                tasks = tasks.filter((t: any) => scopedIds.has(t.workspaceId));
            }

            if (!tasks || tasks.length === 0) {
                return { content: [{ type: 'text', text: `No tasks in this workspace.` }] };
            }

            const now = Date.now();
            const formatted = tasks.map((t: any) => {
                const isRunning = t.state === 'busy' || t.state === 'starting';
                const startTime = t.processStartedAt || t.createdAt;
                const runningForMs = isRunning && startTime ? now - new Date(startTime).getTime() : null;

                return {
                    id: t.id,
                    state: t.state,
                    prompt: t.displayName || (t.prompt?.substring(0, 100) + (t.prompt?.length > 100 ? '...' : '')),
                    createdAt: t.createdAt,
                    lastActivity: t.lastActivity,
                    processStartedAt: t.processStartedAt || null,
                    runningFor: runningForMs ? formatDuration(runningForMs) : null,
                    waitingInputType: t.waitingInputType || null,
                    canResume: t.state === 'disconnected' || t.state === 'interrupted' || t.state === 'idle' || t.state === 'exited',
                };
            });

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(formatted, null, 2)
                }]
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
        }
    }
);

// ============================================================================
// Tool: claudia_get_task_status
// ============================================================================
server.tool(
    'claudia_get_task_status',
    'Get detailed status of a specific task including state, runtime duration, and a snippet of recent output. Works for all task states including disconnected and interrupted tasks. Use this to check progress of spawned tasks without fetching full output.',
    {
        taskId: z.string().describe('The task ID to get status for'),
    },
    async ({ taskId }) => {
        try {
            // Fetch both task list (for full metadata) and recent output in parallel
            const [tasksResponse, outputResponse] = await Promise.all([
                backendFetch('/api/tasks'),
                backendFetch(`/api/tasks/${taskId}/output?maxBytes=2048`),
            ]);

            if (!tasksResponse.ok) {
                return { content: [{ type: 'text', text: `Error: Failed to fetch tasks (HTTP ${tasksResponse.status})` }] };
            }

            const tasks = await tasksResponse.json();
            const task = tasks.find((t: any) => t.id === taskId);

            if (!task) {
                return { content: [{ type: 'text', text: `Error: Task '${taskId}' not found.` }] };
            }

            const now = Date.now();
            const isRunning = task.state === 'busy' || task.state === 'starting';
            const startTime = task.processStartedAt || task.createdAt;
            const runningForMs = isRunning && startTime ? now - new Date(startTime).getTime() : null;

            // Get a short snippet of recent output
            let outputSnippet: string | null = null;
            if (outputResponse.ok) {
                const outputData = await outputResponse.json();
                if (outputData.output) {
                    // Take last 500 chars as a progress snippet
                    const raw = outputData.output;
                    outputSnippet = raw.length > 500 ? '...' + raw.slice(-500) : raw;
                }
            }

            const status = {
                id: task.id,
                state: task.state,
                prompt: task.displayName || (task.prompt?.substring(0, 200) + (task.prompt?.length > 200 ? '...' : '')),
                createdAt: task.createdAt,
                lastActivity: task.lastActivity,
                processStartedAt: task.processStartedAt || null,
                runningFor: runningForMs ? formatDuration(runningForMs) : null,
                waitingInputType: task.waitingInputType || null,
                canResume: task.state === 'disconnected' || task.state === 'interrupted' || task.state === 'idle' || task.state === 'exited',
                recentOutput: outputSnippet,
            };

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(status, null, 2)
                }]
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
        }
    }
);

// ============================================================================
// Tool: claudia_get_task_output
// ============================================================================
server.tool(
    'claudia_get_task_output',
    'Fetch recent terminal output from a task. Use this to see what a sibling task has been doing, check its progress, or read its results. Returns the most recent output (up to 16KB by default).',
    {
        taskId: z.string().describe('The task ID to get output from'),
        maxBytes: z.number().optional().describe('Maximum bytes of output to return (default: 16384, max: 32768)'),
    },
    async ({ taskId, maxBytes }) => {
        try {
            const limit = Math.min(maxBytes || 16384, 32768);
            const response = await backendFetch(`/api/tasks/${taskId}/output?maxBytes=${limit}`);
            if (!response.ok) {
                if (response.status === 404) {
                    return { content: [{ type: 'text', text: `Error: Task '${taskId}' not found.` }] };
                }
                return { content: [{ type: 'text', text: `Error: Failed to get task output (HTTP ${response.status})` }] };
            }
            const data = await response.json();

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        taskId: data.taskId,
                        state: data.state,
                        prompt: data.prompt,
                        lastActivity: data.lastActivity,
                        outputLength: data.output?.length || 0,
                        output: data.output
                    }, null, 2)
                }]
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
        }
    }
);

// ============================================================================
// Tool: claudia_create_task
// ============================================================================
const createTaskBaseDescription = `Create a new task in Claudia. The task will be assigned to a Claude Code agent in the current workspace (${WORKSPACE_ID || 'unknown'}). Use this to delegate work to other agents running in parallel. PREFER this over launching your own internal subagent (the built-in Agent/Task tool) for any delegatable work — Claudia tasks are user-visible, monitorable, resumable, and isolated. Only use your own subagent for a quick throwaway lookup you need inline, or when a Claudia task would clearly give a worse result.`;

const createTaskTieringSuffix = `

You can pass an optional \`complexity\` hint to control the cost of the spawned task. The operator has mapped each tier to a specific model:
- \`low\` — trivial lookups, formatting, single-file reads, mechanical edits.
- \`medium\` — normal coding, refactors, writing tests.
- \`high\` — tricky architecture, gnarly debugging, work that needs careful multi-step reasoning.

Be conservative — pick \`low\` when the work is genuinely simple. Omit the parameter to use the workspace's default model.`;

async function handleCreateTask(args: { prompt: string; displayName?: string; complexity?: 'low' | 'medium' | 'high'; isolate?: boolean }) {
    const { prompt, displayName, complexity, isolate } = args;
    if (!WORKSPACE_ID) {
        return {
            content: [{
                type: 'text' as const,
                text: 'Error: No workspace ID configured. The CLAUDIA_WORKSPACE_ID environment variable is not set.'
            }]
        };
    }

    // If isolate=true, create an isolated worktree via the REST API before spawning the task
    let effectiveWorkspaceId = WORKSPACE_ID;
    if (isolate) {
        try {
            log.info('isolate=true: creating worktree before task spawn');
            const { randomBytes } = await import('crypto');
            const shortId = randomBytes(4).toString('hex');
            const branch = `claudia/task-${shortId}`;
            const res = await backendFetch(
                `/api/worktrees?workspace=${encodeURIComponent(WORKSPACE_ID)}`,
                {
                    method: 'POST',
                    body: JSON.stringify({ branch, createBranch: true }),
                }
            );
            if (res.ok) {
                const data = await res.json() as { worktreePath?: string; workspace?: { id?: string } };
                const worktreePath = data.workspace?.id ?? data.worktreePath;
                if (worktreePath) {
                    effectiveWorkspaceId = worktreePath;
                    log.info(`Worktree created: ${worktreePath} (branch=${branch})`);
                }
            } else {
                const err = await res.text();
                log.error(`Failed to create worktree (isolate): ${err}. Falling back to parent workspace.`);
            }
        } catch (isolateErr) {
            log.error('Worktree creation for isolate failed (non-fatal)', isolateErr);
        }
    }

    try {
        log.info(`Creating task in workspace: ${effectiveWorkspaceId}${complexity ? ` (complexity=${complexity})` : ''}${isolate ? ' (isolated)' : ''}`);
        log.info(`Prompt: ${prompt.substring(0, 100)}...`);

        const payload: Record<string, unknown> = {
            prompt,
            workspaceId: effectiveWorkspaceId,
            source: 'mcp',
        };
        if (MODEL_TIERING_ENABLED && complexity) {
            payload.complexity = complexity;
        }
        const result = await sendWSMessage('task:create', payload);

        const task = (result as any)?.task;
        if (task) {
            log.info(`Task created: ${task.id}`);

            // Rename the task if displayName was provided
            if (displayName) {
                try {
                    await sendWSMessage('task:rename', { taskId: task.id, displayName, source: 'agent' });
                    log.info(`Task renamed to: ${displayName}`);
                } catch (renameErr) {
                    log.error('Failed to rename task after creation:', renameErr);
                }
            }

            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        success: true,
                        taskId: task.id,
                        displayName: displayName || null,
                        state: task.state,
                        workspace: effectiveWorkspaceId,
                        isolated: isolate && effectiveWorkspaceId !== WORKSPACE_ID,
                        prompt: task.prompt?.substring(0, 200),
                        complexity: complexity || null,
                        message: `Task '${task.id}'${displayName ? ` (${displayName})` : ''} created successfully${isolate && effectiveWorkspaceId !== WORKSPACE_ID ? ` in isolated worktree '${effectiveWorkspaceId}'` : ` in workspace '${WORKSPACE_ID}'`}.`
                    }, null, 2)
                }]
            };
        }

        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    success: true,
                    message: 'Task creation request sent. Check claudia_list_tasks for the new task.',
                    result
                }, null, 2)
            }]
        };
    } catch (error) {
        log.error('Failed to create task:', error);
        return {
            content: [{
                type: 'text' as const,
                text: `Error creating task: ${error instanceof Error ? error.message : String(error)}`
            }]
        };
    }
}

const isolateParam = {
    isolate: z.boolean().optional().describe(
        'When true, creates a new isolated git worktree for this task (branch: claudia/task-<id>). ' +
        'Use this when the task will make file changes that should not conflict with other tasks running in the same workspace. ' +
        'Recommended for parallel feature development or any task that will commit changes.'
    ),
};

if (MODEL_TIERING_ENABLED) {
    server.tool(
        'claudia_create_task',
        createTaskBaseDescription + createTaskTieringSuffix,
        {
            prompt: z.string().describe('The prompt/instructions for the new task'),
            displayName: z.string().optional().describe('Optional short display name for the task in the Claudia sidebar (e.g., "Build API endpoint", "Write tests")'),
            complexity: z.enum(['low', 'medium', 'high']).optional().describe(
                'Cost/capability tier for the spawned task. Use "low" for trivial work, "medium" for normal coding, "high" for hard reasoning. Omit to use the workspace default model.'
            ),
            ...isolateParam,
        },
        async (args) => handleCreateTask(args)
    );
} else {
    server.tool(
        'claudia_create_task',
        createTaskBaseDescription,
        {
            prompt: z.string().describe('The prompt/instructions for the new task'),
            displayName: z.string().optional().describe('Optional short display name for the task in the Claudia sidebar (e.g., "Build API endpoint", "Write tests")'),
            ...isolateParam,
        },
        async (args) => handleCreateTask(args)
    );
}

// ============================================================================
// Tool: claudia_send_input
// ============================================================================
server.tool(
    'claudia_send_input',
    'Send input to a task that is waiting for input (e.g., answering a question, granting permission, or providing text). Check task status first to see if the task is in waiting_input state.',
    {
        taskId: z.string().describe('The task ID to send input to'),
        input: z.string().describe('The input text to send to the task'),
    },
    async ({ taskId, input }) => {
        try {
            log.info(`Sending input to task: ${taskId}`);

            const result = await sendWSMessage('task:input', {
                taskId,
                input: input + '\r',
            });

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        message: `Input sent to task '${taskId}'.`,
                        result
                    }, null, 2)
                }]
            };
        } catch (error) {
            log.error('Failed to send input:', error);
            return {
                content: [{
                    type: 'text',
                    text: `Error sending input: ${error instanceof Error ? error.message : String(error)}`
                }]
            };
        }
    }
);

// ============================================================================
// Tool: claudia_continue_task
// ============================================================================
server.tool(
    'claudia_continue_task',
    'Send a follow-up prompt to an idle, exited, disconnected, or interrupted Claude Code task, resuming its session with a new instruction. Disconnected/interrupted tasks will be automatically reconnected before the prompt is delivered. The task will start processing the new prompt.',
    {
        taskId: z.string().describe('The task ID to continue'),
        prompt: z.string().describe('The follow-up prompt/instructions to send to the task'),
    },
    async ({ taskId, prompt }) => {
        try {
            // Verify task exists and check its state
            const tasksResponse = await backendFetch('/api/tasks');
            if (tasksResponse.ok) {
                const tasks = await tasksResponse.json();
                const task = tasks.find((t: any) => t.id === taskId);
                if (!task) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                message: `Task '${taskId}' not found.`,
                            }, null, 2)
                        }]
                    };
                }
                if (task.state === 'busy' || task.state === 'starting') {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                message: `Task '${taskId}' is currently ${task.state}. Wait for it to finish or stop it first before sending a follow-up prompt.`,
                            }, null, 2)
                        }]
                    };
                }
                if (task.state === 'disconnected' || task.state === 'interrupted') {
                    log.info(`Task ${taskId} is ${task.state}, will auto-reconnect on input`);
                }
            }

            log.info(`Continuing task: ${taskId}`);

            const result = await sendWSMessage('task:input', {
                taskId,
                input: prompt + '\r',
            });

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        message: `Follow-up prompt sent to task '${taskId}'. The task is now processing.`,
                    }, null, 2)
                }]
            };
        } catch (error) {
            log.error('Failed to continue task:', error);
            return {
                content: [{
                    type: 'text',
                    text: `Error continuing task: ${error instanceof Error ? error.message : String(error)}`
                }]
            };
        }
    }
);

// ============================================================================
// Tool: claudia_stop_task
// ============================================================================
server.tool(
    'claudia_stop_task',
    'Gracefully stop a running task by sending an interrupt signal (ESC). This cancels the current Claude Code operation without killing the process — the task transitions to idle and can be resumed later. Works on tasks in busy, starting, or waiting_input states.',
    {
        taskId: z.string().describe('The task ID to stop'),
    },
    async ({ taskId }) => {
        // Prevent a task from stopping itself — would kill the orchestrating Claude session
        if (SELF_TASK_ID && taskId === SELF_TASK_ID) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: false,
                        message: `Cannot stop task '${taskId}' because it is the currently running session. It will stop naturally when done.`,
                    }, null, 2)
                }]
            };
        }

        try {
            log.info(`Stopping task: ${taskId}`);

            const result = await sendWSMessage('task:stop', { taskId }) as { taskId: string; stopped: boolean };

            if (result.stopped) {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: true,
                            message: `Task '${taskId}' stopped successfully. The task is now idle and can be resumed.`,
                        }, null, 2)
                    }]
                };
            } else {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            message: `Task '${taskId}' could not be stopped — it may not be in a running state.`,
                        }, null, 2)
                    }]
                };
            }
        } catch (error) {
            log.error('Failed to stop task:', error);
            return {
                content: [{
                    type: 'text',
                    text: `Error stopping task: ${error instanceof Error ? error.message : String(error)}`
                }]
            };
        }
    }
);

// ============================================================================
// Tool: claudia_stop_all_tasks
// ============================================================================
server.tool(
    'claudia_stop_all_tasks',
    `Stop all running tasks in the current workspace. Sends an interrupt signal (ESC) to every task that is busy, starting, or waiting for input. Tasks transition to idle and can be resumed later. The calling task (orchestrator) is automatically excluded to prevent a race condition where the orchestrator stops itself.${WORKSPACE_ID ? ` Scoped to workspace: ${WORKSPACE_ID}` : ''}`,
    {},
    async () => {
        if (!WORKSPACE_ID) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: No workspace ID configured. The CLAUDIA_WORKSPACE_ID environment variable is not set.'
                }]
            };
        }

        try {
            log.info(`Stopping all tasks in workspace: ${WORKSPACE_ID}${SELF_TASK_ID ? ` (excluding self: ${SELF_TASK_ID})` : ''}`);

            // Stop tasks in the parent workspace and all child worktrees
            const scopedIds = await getScopedWorkspaceIds();
            let totalStopped = 0;
            const allStoppedIds: string[] = [];

            for (const wsId of scopedIds) {
                const result = await sendWSMessage('task:stopAll', {
                    workspaceId: wsId,
                    ...(SELF_TASK_ID ? { excludeTaskId: SELF_TASK_ID } : {}),
                }) as {
                    workspaceId: string;
                    stoppedCount: number;
                    stoppedIds: string[];
                };
                totalStopped += result.stoppedCount;
                allStoppedIds.push(...result.stoppedIds);
            }

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        stoppedCount: totalStopped,
                        stoppedIds: allStoppedIds,
                        message: totalStopped > 0
                            ? `Stopped ${totalStopped} task(s): ${allStoppedIds.join(', ')}`
                            : 'No running tasks found in this workspace.',
                    }, null, 2)
                }]
            };
        } catch (error) {
            log.error('Failed to stop all tasks:', error);
            return {
                content: [{
                    type: 'text',
                    text: `Error stopping tasks: ${error instanceof Error ? error.message : String(error)}`
                }]
            };
        }
    }
);

// ============================================================================
// Tool: claudia_rename_task
// ============================================================================
server.tool(
    'claudia_rename_task',
    `Rename a task's display name in the Claudia UI sidebar. Use this to give tasks descriptive names that reflect what they're working on. Will be rejected if the user has manually edited the task title. ${SELF_TASK_ID ? `YOUR OWN TASK ID IS: ${SELF_TASK_ID} — after you have written your first response about the task, call this tool with taskId="${SELF_TASK_ID}" and a short descriptive title (3-6 words). Do NOT call this before producing output.` : ''}`,
    {
        taskId: z.string().describe(`The task ID to rename.${SELF_TASK_ID ? ` To title your own task, use "${SELF_TASK_ID}".` : ''}`),
        displayName: z.string().describe('The new display name for the task (short, descriptive)'),
    },
    async ({ taskId, displayName }) => {
        try {
            // Check if the task title was user-edited before attempting rename
            const tasksResponse = await backendFetch('/api/tasks');
            if (tasksResponse.ok) {
                const tasks = await tasksResponse.json();
                const task = tasks.find((t: any) => t.id === taskId);
                if (task?.displayNameEditedByUser) {
                    log.info(`Rename blocked for task ${taskId} — title was edited by user`);
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                message: `Cannot rename task '${taskId}' — the title was manually edited by the user. Do not retry.`,
                                displayNameEditedByUser: true,
                            }, null, 2)
                        }]
                    };
                }
            }

            log.info(`Renaming task ${taskId} to: ${displayName}`);

            const result = await sendWSMessage('task:rename', {
                taskId,
                displayName,
                source: 'agent',
            });

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        message: `Task '${taskId}' renamed to '${displayName}'.`,
                    }, null, 2)
                }]
            };
        } catch (error) {
            log.error('Failed to rename task:', error);
            return {
                content: [{
                    type: 'text',
                    text: `Error renaming task: ${error instanceof Error ? error.message : String(error)}`
                }]
            };
        }
    }
);

// ============================================================================
// Tool: claudia_delete_task
// ============================================================================
server.tool(
    'claudia_delete_task',
    'Request deletion (archival) of one or more tasks. This sends a SINGLE confirmation popup listing every task, each pre-checked; the user unchecks any they want to keep and confirms once. Pass every task you want removed in one call rather than calling this repeatedly — one call is one prompt, N calls are N prompts. IMPORTANT: Only call this when the user explicitly asks to delete/remove tasks. Never delete tasks automatically after completion — users want to review outputs.',
    {
        taskIds: z.array(z.string()).min(1).describe('The task IDs to delete. Pass all of them in one call to get a single confirmation prompt.'),
    },
    async ({ taskIds }) => {
        const requested = [...new Set(taskIds)];
        const selfRequested = SELF_TASK_ID && requested.includes(SELF_TASK_ID);
        const deletable = requested.filter(id => id !== SELF_TASK_ID);

        if (deletable.length === 0) {
            return jsonResult({
                success: false,
                message: selfRequested
                    ? 'Cannot delete the currently running session, and no other tasks were requested.'
                    : 'No task IDs were provided.',
            });
        }

        try {
            // Resolve display names for the dialog, and drop ids the backend does not
            // know about — listing a phantom row would make the user approve nothing.
            const names = new Map<string, string>();
            const notFound: string[] = [];
            const tasksResponse = await backendFetch('/api/tasks');
            if (tasksResponse.ok) {
                const allTasks = await tasksResponse.json();
                const byId = new Map(allTasks.map((t: any) => [t.id, t]));
                for (const id of deletable) {
                    const task: any = byId.get(id);
                    if (!task) { notFound.push(id); continue; }
                    names.set(id, task.displayName || task.prompt?.substring(0, 60) || id);
                }
            } else {
                log.error(`Task lookup returned HTTP ${tasksResponse.status}; showing raw ids in the dialog`);
                for (const id of deletable) names.set(id, id);
            }

            if (names.size === 0) {
                return jsonResult({
                    success: false,
                    message: `None of the requested tasks exist: ${notFound.join(', ')}`,
                });
            }

            const requestId = `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const tasks = [...names].map(([taskId, taskName]) => ({ taskId, taskName }));
            log.info(`Requesting user confirmation to delete ${tasks.length} task(s)`, { requestId });

            // One request, one dialog. The backend archives the approved subset and
            // replies with task:deleteResolved naming exactly what it did.
            const result = await sendWSMessageWithMultiResponse(
                'task:deleteRequest',
                { requestId, tasks },
                (msg) => {
                    if (msg.type === 'task:deleteResolved' && msg.payload?.requestId === requestId) {
                        return msg.payload as {
                            archivedIds: string[];
                            keptIds: string[];
                            failed: Array<{ taskId: string; reason: string }>;
                        };
                    }
                    return null;
                },
                300000
            );

            const nameOf = (id: string) => names.get(id) ?? id;
            return jsonResult({
                success: result.archivedIds.length > 0,
                deleted: result.archivedIds.map(nameOf),
                kept: result.keptIds.map(nameOf),
                ...(result.failed.length > 0 && {
                    failed: result.failed.map(f => ({ task: nameOf(f.taskId), reason: f.reason })),
                }),
                ...(notFound.length > 0 && { notFound }),
                ...(selfRequested && { skipped: 'the currently running session cannot delete itself' }),
                message: `${result.archivedIds.length} deleted, ${result.keptIds.length} kept by the user`
                    + (result.failed.length > 0 ? `, ${result.failed.length} failed to archive` : ''),
            });
        } catch (error) {
            log.error('Failed to delete tasks:', error);
            const msg = error instanceof Error ? error.message : String(error);
            if (msg.includes('timed out')) {
                return jsonResult({
                    success: false,
                    message: 'User did not respond to the deletion confirmation within 5 minutes. Nothing was deleted.',
                });
            }
            return { content: [{ type: 'text', text: `Error deleting tasks: ${msg}` }] };
        }
    }
);

// ============================================================================
// Tool: claudia_cron_create
// ============================================================================
server.tool(
    'claudia_cron_create',
    `Schedule a recurring or one-shot prompt for a task. The prompt will be sent to the task's terminal at the scheduled time. Uses standard 5-field cron expressions (minute hour day-of-month month day-of-week). Examples: "*/5 * * * *" = every 5 minutes, "0 * * * *" = every hour, "0 9 * * 1-5" = weekdays at 9am. Recurring tasks auto-expire after 3 days. Max 50 scheduled tasks per task.`,
    {
        taskId: z.string().describe(`The task ID to schedule a prompt for.${SELF_TASK_ID ? ` Use "${SELF_TASK_ID}" for yourself.` : ''}`),
        cronExpression: z.string().describe('5-field cron expression: "minute hour day-of-month month day-of-week". Examples: "*/5 * * * *" (every 5 min), "0 9 * * *" (daily 9am), "30 14 * * 1-5" (weekdays 2:30pm)'),
        prompt: z.string().describe('The prompt to send when the schedule fires'),
        isRecurring: z.boolean().optional().describe('true (default) for recurring, false for one-shot (fires once then deletes itself)'),
    },
    async ({ taskId, cronExpression, prompt, isRecurring }) => {
        try {
            log.info(`Creating scheduled task for: ${taskId}, cron: ${cronExpression}`);

            const response = await backendFetch(`/api/tasks/${taskId}/cron`, {
                method: 'POST',
                body: JSON.stringify({ cronExpression, prompt, isRecurring: isRecurring ?? true }),
            });

            if (!response.ok) {
                const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
                return { content: [{ type: 'text', text: `Error: ${error.error || response.statusText}` }] };
            }

            const scheduled = await response.json();
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        scheduledTaskId: scheduled.id,
                        cronExpression: scheduled.cronExpression,
                        description: scheduled.description,
                        isRecurring: scheduled.isRecurring,
                        nextFireAt: scheduled.nextFireAt,
                        expiresAt: scheduled.expiresAt,
                        message: `Scheduled task '${scheduled.id}' created. ${scheduled.description}. Next fire: ${scheduled.nextFireAt || 'calculating...'}`
                    }, null, 2)
                }]
            };
        } catch (error) {
            log.error('Failed to create scheduled task:', error);
            return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
        }
    }
);

// ============================================================================
// Tool: claudia_cron_list
// ============================================================================
server.tool(
    'claudia_cron_list',
    'List all scheduled tasks for a specific task, or all scheduled tasks if no taskId is provided. Shows schedule, next fire time, and fire count.',
    {
        taskId: z.string().optional().describe('Optional task ID to filter by. Omit to list all scheduled tasks.'),
    },
    async ({ taskId }) => {
        try {
            const url = taskId ? `/api/tasks/${taskId}/cron` : '/api/cron';
            const response = await backendFetch(url);

            if (!response.ok) {
                return { content: [{ type: 'text', text: `Error: Failed to list scheduled tasks (HTTP ${response.status})` }] };
            }

            const scheduled = await response.json();

            if (!scheduled || scheduled.length === 0) {
                return { content: [{ type: 'text', text: taskId ? `No scheduled tasks for task '${taskId}'.` : 'No scheduled tasks.' }] };
            }

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(scheduled.map((s: any) => ({
                        id: s.id,
                        taskId: s.taskId,
                        cronExpression: s.cronExpression,
                        description: s.description,
                        prompt: s.prompt.substring(0, 100) + (s.prompt.length > 100 ? '...' : ''),
                        isRecurring: s.isRecurring,
                        isPaused: s.isPaused || false,
                        nextFireAt: s.nextFireAt,
                        lastFiredAt: s.lastFiredAt || null,
                        fireCount: s.fireCount,
                        expiresAt: s.expiresAt,
                    })), null, 2)
                }]
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
        }
    }
);

// ============================================================================
// Tool: claudia_cron_delete
// ============================================================================
server.tool(
    'claudia_cron_delete',
    'Delete/cancel a scheduled task by its ID. Use claudia_cron_list to find scheduled task IDs.',
    {
        cronId: z.string().describe('The 8-character scheduled task ID to delete'),
    },
    async ({ cronId }) => {
        try {
            log.info(`Deleting scheduled task: ${cronId}`);

            const response = await backendFetch(`/api/cron/${cronId}`, { method: 'DELETE' });

            if (!response.ok) {
                if (response.status === 404) {
                    return { content: [{ type: 'text', text: `Error: Scheduled task '${cronId}' not found.` }] };
                }
                return { content: [{ type: 'text', text: `Error: Failed to delete scheduled task (HTTP ${response.status})` }] };
            }

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        message: `Scheduled task '${cronId}' deleted successfully.`,
                    }, null, 2)
                }]
            };
        } catch (error) {
            log.error('Failed to delete scheduled task:', error);
            return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
        }
    }
);

// ============================================================================
// Tool: claudia_cron_pause
// ============================================================================
server.tool(
    'claudia_cron_pause',
    'Pause or resume a scheduled task. Paused tasks will not fire until resumed. Use claudia_cron_list to find scheduled task IDs and their current pause state.',
    {
        cronId: z.string().describe('The 8-character scheduled task ID to pause/resume'),
        paused: z.boolean().describe('true to pause the scheduled task, false to resume it'),
    },
    async ({ cronId, paused }) => {
        try {
            log.info(`${paused ? 'Pausing' : 'Resuming'} scheduled task: ${cronId}`);

            const response = await backendFetch(`/api/cron/${cronId}`, {
                method: 'PUT',
                body: JSON.stringify({ isPaused: paused }),
            });

            if (!response.ok) {
                if (response.status === 404) {
                    return { content: [{ type: 'text', text: `Error: Scheduled task '${cronId}' not found.` }] };
                }
                const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
                return { content: [{ type: 'text', text: `Error: ${error.error || response.statusText}` }] };
            }

            const updated = await response.json();
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        message: `Scheduled task '${cronId}' ${paused ? 'paused' : 'resumed'} successfully.`,
                        isPaused: updated.isPaused,
                        nextFireAt: updated.nextFireAt || null,
                    }, null, 2)
                }]
            };
        } catch (error) {
            log.error(`Failed to ${paused ? 'pause' : 'resume'} scheduled task:`, error);
            return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
        }
    }
);

// ============================================================================
// Start the server
// ============================================================================
async function main() {
    log.info('Starting Claudia MCP Server...');
    log.info(`Backend URL: ${BACKEND_URL}`);
    log.info(`Workspace: ${WORKSPACE_ID || '(not scoped)'}`);

    // Verify backend connectivity
    try {
        const health = await backendFetch('/api/health');
        if (health.ok) {
            log.info('Backend connection verified');
        } else {
            log.error(`Backend health check failed: HTTP ${health.status}`);
        }
    } catch (error) {
        log.error('Warning: Could not connect to Claudia backend. Tools will fail until the backend is available.');
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info('Claudia MCP Server running on stdio');
}

main().catch((error) => {
    log.error('Fatal error:', error);
    process.exit(1);
});
