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
import { writeFileSync } from 'fs';
import { join, resolve, basename } from 'path';

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

// Whether per-task TODO list is enabled. Controls whether claudia_todo_* tools are registered.
const TODO_ENABLED = process.env.CLAUDIA_TODO_ENABLED === '1';

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

/**
 * Get all workspace IDs that belong to the current workspace scope.
 * Includes the workspace itself plus any child worktree workspaces.
 * This ensures tasks in worktrees are visible to their parent workspace's MCP tools.
 */
/**
 * Resolve the session's workspace scope to the ROOT workspace plus all of its
 * worktree children. A session running INSIDE a worktree previously scoped to
 * just that worktree (one task — its own), so list_tasks appeared to "only
 * read a single claudia task". Fleet coordinators spawned in worktrees need to
 * see their sibling tasks, so worktree sessions now scope to the whole
 * workspace. Parent links are walked with a cycle guard (cyclic
 * worktreeParentId values have occurred in practice).
 *
 * Also returns the workspace map so callers can annotate tasks with the
 * worktree they run in.
 */
/** Cycle-guarded walk up worktreeParentId links to the root workspace. */
function resolveWorktreeRoot(wsById: Map<string, any>, startId: string): string {
    let root = startId;
    const seen = new Set<string>();
    while (wsById.get(root)?.worktreeParentId && !seen.has(root) && seen.size < 50) {
        seen.add(root);
        root = wsById.get(root)!.worktreeParentId;
    }
    return root;
}

/**
 * READ scope for a session: the ROOT workspace plus every workspace whose own
 * root-walk lands on the same root (transitive — covers legacy grandchild
 * worktrees, not just direct children). Used by claudia_list_tasks so fleet
 * coordinators inside worktrees see their siblings.
 *
 * NOTE: claudia_stop_all_tasks deliberately does NOT use this — stopping is
 * destructive, and widening its blast radius to the whole workspace meant a
 * worktree session's cleanup could kill the coordinator and every sibling.
 * Stop keeps the original self+children scope via getStopScope().
 */
async function getWorkspaceScope(): Promise<{ ids: Set<string>; wsById: Map<string, any> }> {
    const ids = new Set<string>();
    const wsById = new Map<string, any>();
    if (!WORKSPACE_ID) return { ids, wsById };

    try {
        const response = await backendFetch('/api/workspaces');
        if (response.ok) {
            const data = await response.json();
            const workspaces = data.workspaces || data;
            for (const ws of workspaces) wsById.set(ws.id, ws);

            const root = resolveWorktreeRoot(wsById, WORKSPACE_ID);
            ids.add(root);
            for (const ws of workspaces) {
                if (resolveWorktreeRoot(wsById, ws.id) === root && ws.worktreeParentId) ids.add(ws.id);
            }
        }
    } catch {
        // Backend unreachable — fall through to self-only scope below
    }

    // Always include the session's own workspace (also the fallback when the
    // backend fetch fails or the workspace isn't registered)
    ids.add(WORKSPACE_ID);

    return { ids, wsById };
}

/**
 * STOP scope: the session's own workspace + its direct worktree children only
 * (the pre-widening semantics). A worktree session stopping "all" tasks must
 * not reach the parent workspace or sibling worktrees.
 */
async function getStopScope(): Promise<Set<string>> {
    const ids = new Set<string>();
    if (!WORKSPACE_ID) return ids;
    ids.add(WORKSPACE_ID);
    try {
        const response = await backendFetch('/api/workspaces');
        if (response.ok) {
            const data = await response.json();
            const workspaces = data.workspaces || data;
            for (const ws of workspaces) {
                if (ws.worktreeParentId === WORKSPACE_ID) ids.add(ws.id);
            }
        }
    } catch { /* self-only fallback */ }
    return ids;
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
            // The two fetches are independent — run them in parallel
            const [response, scope] = await Promise.all([
                backendFetch('/api/tasks'),
                WORKSPACE_ID ? getWorkspaceScope() : Promise.resolve({ ids: new Set<string>(), wsById: new Map<string, any>() }),
            ]);
            if (!response.ok) {
                return { content: [{ type: 'text', text: `Error: Failed to list tasks (HTTP ${response.status})` }] };
            }
            let tasks = await response.json();

            // Filter to the root workspace and all of its worktrees (a session
            // inside a worktree sees the whole workspace's fleet)
            const wsById = scope.wsById;
            if (WORKSPACE_ID) {
                tasks = tasks.filter((t: any) => scope.ids.has(t.workspaceId));
            }

            if (!tasks || tasks.length === 0) {
                return { content: [{ type: 'text', text: `No tasks in this workspace.` }] };
            }

            const now = Date.now();
            const formatted = tasks.map((t: any) => {
                const isRunning = t.state === 'busy' || t.state === 'starting';
                const startTime = t.processStartedAt || t.createdAt;
                const runningForMs = isRunning && startTime ? now - new Date(startTime).getTime() : null;

                // Annotate tasks that run in a worktree with its branch/name so
                // coordinators can tell which worktree each fleet member is in
                const taskWs = wsById.get(t.workspaceId);
                const worktree = taskWs?.worktreeParentId
                    ? (taskWs.worktreeBranch || t.workspaceId.split('/').pop())
                    : null;

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
                    ...(worktree ? { worktree } : {}),
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

            // Stop tasks in this session's OWN workspace + direct children only
            // (never the parent workspace or sibling worktrees — see getStopScope)
            const scopedIds = await getStopScope();
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
    'Request deletion (archival) of a task. This sends a confirmation popup to the user — the task is only deleted if the user approves. IMPORTANT: Only call this when the user explicitly asks to delete/remove a task. Never delete tasks automatically after completion — users want to review outputs.',
    {
        taskId: z.string().describe('The task ID to delete'),
    },
    async ({ taskId }) => {
        if (SELF_TASK_ID && taskId === SELF_TASK_ID) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: false,
                        message: `Cannot delete task '${taskId}' because it is the currently running session.`,
                    }, null, 2)
                }]
            };
        }

        try {
            // Look up task name for the confirmation dialog
            let taskName = taskId;
            try {
                const tasksResponse = await backendFetch('/api/tasks');
                if (tasksResponse.ok) {
                    const tasks = await tasksResponse.json();
                    const task = tasks.find((t: any) => t.id === taskId);
                    if (!task) {
                        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `Task '${taskId}' not found.` }, null, 2) }] };
                    }
                    taskName = task.displayName || task.prompt?.substring(0, 60) || taskId;
                }
            } catch { /* use taskId as fallback name */ }

            const requestId = `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            log.info(`Requesting user confirmation to delete task: ${taskId}`, { requestId });

            // Send deleteRequest — backend broadcasts to frontend which shows
            // a confirmation modal. We wait for either task:destroyed (approved)
            // or task:deleteRejected (denied).
            const result = await sendWSMessageWithMultiResponse(
                'task:deleteRequest',
                { taskId, requestId, taskName },
                (msg) => {
                    if (msg.type === 'task:destroyed' && msg.payload?.taskId === taskId) {
                        return { outcome: 'approved' };
                    }
                    if (msg.type === 'task:deleteRejected' && msg.payload?.requestId === requestId) {
                        return { outcome: 'rejected' };
                    }
                    return null;
                },
                60000
            );

            if (result.outcome === 'approved') {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: true,
                            message: `Task '${taskName}' deleted (archived) by user.`,
                        }, null, 2)
                    }]
                };
            } else {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            message: `User rejected deletion of task '${taskName}'.`,
                        }, null, 2)
                    }]
                };
            }
        } catch (error) {
            log.error('Failed to delete task:', error);
            const msg = error instanceof Error ? error.message : String(error);
            if (msg.includes('timed out')) {
                return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'User did not respond to the deletion confirmation within 60 seconds.' }, null, 2) }] };
            }
            return { content: [{ type: 'text', text: `Error deleting task: ${msg}` }] };
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
// Jira integration tools
// ============================================================================
// These proxy to the backend's /api/jira/* endpoints, which enforce the enabled
// flag, localhost-only access, and the SSRF guard. Tools surface a clear message
// when the integration is disabled instead of failing opaquely.

/** Helper: GET a Jira endpoint, returning parsed JSON or throwing a readable error. */
async function jiraGet(path: string): Promise<any> {
    const res = await backendFetch(path);
    if (res.status === 403) {
        throw new Error('Jira integration is disabled or not configured. Enable it in Claudia Settings and add an API token.');
    }
    if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(data.error || `Jira request failed (HTTP ${res.status})`);
    }
    return res.json();
}

server.tool(
    'jira_get_ticket',
    'Fetch a Jira ticket by key (e.g. "PROJ-123") or full browse URL. Returns summary, status, assignee, description, comments, and attachment metadata. Read-only.',
    {
        key: z.string().describe('Jira issue key (e.g. "PROJ-123") or a full /browse/ URL'),
    },
    async ({ key }) => {
        try {
            const issue = await jiraGet(`/api/jira/issue/${encodeURIComponent(key)}`);
            return { content: [{ type: 'text', text: JSON.stringify(issue, null, 2) }] };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
        }
    }
);

server.tool(
    'jira_search',
    'Search Jira issues with a JQL query (e.g. "assignee = currentUser() AND statusCategory != Done"). Returns matching issues (key, summary, status, assignee). Read-only.',
    {
        jql: z.string().describe('A JQL query string'),
        maxResults: z.number().optional().describe('Max results to return (1-100, default 25)'),
    },
    async ({ jql, maxResults }) => {
        try {
            const params = new URLSearchParams({ jql });
            if (maxResults) params.set('maxResults', String(maxResults));
            const result = await jiraGet(`/api/jira/search?${params.toString()}`);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
        }
    }
);

server.tool(
    'jira_list_attachments',
    'List the attachments on a Jira ticket (id, filename, size, type). Use jira_download_attachment to fetch one into the workspace.',
    {
        key: z.string().describe('Jira issue key (e.g. "PROJ-123") or a full /browse/ URL'),
    },
    async ({ key }) => {
        try {
            const data = await jiraGet(`/api/jira/issue/${encodeURIComponent(key)}/attachments`);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
        }
    }
);

server.tool(
    'jira_download_attachment',
    'Download a Jira attachment by its numeric id into the current workspace. Returns the saved file path. Get attachment ids from jira_list_attachments.',
    {
        attachmentId: z.string().describe('Numeric attachment id (from jira_list_attachments)'),
        filename: z.string().optional().describe('Optional filename to save as (defaults to the attachment name). Path components are stripped.'),
    },
    async ({ attachmentId, filename }) => {
        if (!WORKSPACE_ID) {
            return { content: [{ type: 'text', text: 'Error: No workspace configured (CLAUDIA_WORKSPACE_ID not set).' }] };
        }
        try {
            const res = await backendFetch(`/api/jira/attachment/${encodeURIComponent(attachmentId)}`);
            if (res.status === 403) {
                return { content: [{ type: 'text', text: 'Error: Jira integration is disabled or not configured.' }] };
            }
            if (!res.ok) {
                const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
                return { content: [{ type: 'text', text: `Error: ${data.error || `HTTP ${res.status}`}` }] };
            }

            // Derive the filename: prefer the caller's, else Content-Disposition, else the id.
            let name = filename;
            if (!name) {
                const cd = res.headers.get('content-disposition') || '';
                const m = cd.match(/filename="?([^"]+)"?/);
                name = m ? m[1] : `attachment-${attachmentId}`;
            }
            // Path-traversal guard: strip any directory components, then verify the
            // resolved path stays inside the workspace.
            const safeName = basename(name).replace(/[/\\]/g, '_');
            const destPath = join(WORKSPACE_ID, safeName);
            const resolvedDest = resolve(destPath);
            const resolvedWorkspace = resolve(WORKSPACE_ID);
            if (!resolvedDest.startsWith(resolvedWorkspace)) {
                return { content: [{ type: 'text', text: 'Error: Refusing to write outside the workspace.' }] };
            }

            const buf = Buffer.from(await res.arrayBuffer());
            writeFileSync(resolvedDest, buf);
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({ success: true, path: resolvedDest, bytes: buf.length }, null, 2),
                }],
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
        }
    }
);

server.tool(
    'jira_open_ticket',
    'Open a Jira ticket on the Claudia Jira tab so the user can see it. Validates the ticket exists, then surfaces it in the UI. Use this when the user asks you to pull up or show a ticket.',
    {
        key: z.string().describe('Jira issue key (e.g. "PROJ-123") or a full /browse/ URL'),
    },
    async ({ key }) => {
        try {
            const res = await backendFetch('/api/jira/focus', {
                method: 'POST',
                body: JSON.stringify({ key, workspaceId: WORKSPACE_ID || null }),
            });
            if (res.status === 403) {
                return { content: [{ type: 'text', text: 'Error: Jira integration is disabled or not configured.' }] };
            }
            if (!res.ok) {
                const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
                return { content: [{ type: 'text', text: `Error: ${data.error || `HTTP ${res.status}`}` }] };
            }
            const data = await res.json();
            return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...data }, null, 2) }] };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
        }
    }
);

// Helper: run a confirmation-gated Jira write. Sends jira:writeRequest and waits
// for the user's jira:writeApproved (with success/error) or jira:writeRejected.
async function requestJiraWrite(op: {
    action: 'comment' | 'transition';
    key: string;
    body?: string;
    transitionId?: string;
    summary: string;
}): Promise<{ ok: boolean; message: string }> {
    const { randomBytes } = await import('crypto');
    const requestId = `jira-${Date.now()}-${randomBytes(4).toString('hex')}`;
    try {
        const result = await sendWSMessageWithMultiResponse<{ ok: boolean; message: string }>(
            'jira:writeRequest',
            { requestId, ...op },
            (msg) => {
                if (msg.type === 'jira:writeApproved' && msg.payload?.requestId === requestId) {
                    if (msg.payload.success) return { ok: true, message: `Done: ${op.action} on ${op.key}.` };
                    return { ok: false, message: `Jira write failed: ${msg.payload.error || 'unknown error'}` };
                }
                if (msg.type === 'jira:writeRejected' && msg.payload?.requestId === requestId) {
                    return { ok: false, message: 'User rejected the Jira write.' };
                }
                return null;
            },
            120000,
        );
        return result;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('timed out')) return { ok: false, message: 'User did not respond within 2 minutes.' };
        return { ok: false, message: msg };
    }
}

server.tool(
    'jira_add_comment',
    'Add a comment to a Jira ticket. Requires user confirmation — a dialog is shown in Claudia and the comment is only posted if the user approves. Use for posting updates back to a ticket.',
    {
        key: z.string().describe('Jira issue key (e.g. "PROJ-123") or a full /browse/ URL'),
        comment: z.string().describe('The comment text to post (plain text)'),
    },
    async ({ key, comment }) => {
        const preview = comment.length > 140 ? comment.slice(0, 140) + '…' : comment;
        const r = await requestJiraWrite({ action: 'comment', key, body: comment, summary: preview });
        return { content: [{ type: 'text', text: JSON.stringify({ success: r.ok, message: r.message }, null, 2) }] };
    }
);

server.tool(
    'jira_transition_ticket',
    'Transition a Jira ticket to a new status (e.g. move to "In Progress" or "Done"). Requires user confirmation. First call jira_get_transitions to find the valid transition id for the ticket\'s current state.',
    {
        key: z.string().describe('Jira issue key (e.g. "PROJ-123") or a full /browse/ URL'),
        transitionId: z.string().describe('The numeric transition id (from jira_get_transitions)'),
        transitionName: z.string().optional().describe('Optional human-readable name for the confirmation dialog'),
    },
    async ({ key, transitionId, transitionName }) => {
        const r = await requestJiraWrite({
            action: 'transition', key, transitionId,
            summary: transitionName ? `Move to "${transitionName}"` : `Apply transition ${transitionId}`,
        });
        return { content: [{ type: 'text', text: JSON.stringify({ success: r.ok, message: r.message }, null, 2) }] };
    }
);

server.tool(
    'jira_get_transitions',
    'List the workflow transitions available for a Jira ticket in its current state (id + name). Use the id with jira_transition_ticket. Read-only.',
    {
        key: z.string().describe('Jira issue key (e.g. "PROJ-123") or a full /browse/ URL'),
    },
    async ({ key }) => {
        try {
            const data = await jiraGet(`/api/jira/issue/${encodeURIComponent(key)}/transitions`);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
        }
    }
);


// ============================================================================
// TODO Tools (only registered when TODO_ENABLED)
// ============================================================================
if (TODO_ENABLED) {
server.tool(
    'claudia_todo_create',
    `Add an item to your task's TODO work-plan, shown live in the Claudia toolbar. This list is YOUR working plan for the task — seed it up front with the steps you intend to take, keep it current as you work, and the user watches progress at a glance.

Track every kind of work item here:
- Your own steps ('source: claude', 'kind: action') — what you're going to do.
- Actions the user must take ('source: user', 'kind: manual') — run a VPN, approve a deploy, test in a browser; you're notified when they check it off.
- GitHub issues/PRs the task involves ('source: github', 'kind: github-issue' | 'github-pr', with 'url' + 'externalRef' like "amd/gaia#1859") — these render as clickable links.

Order items in execution sequence ('order', lower = earlier) and set 'priority'. Use 'parentId' to break a big item into subtasks (one level only). Mark exactly one item 'status: active' as you work it (via claudia_todo_update).${SELF_TASK_ID ? ` Your task ID is: ${SELF_TASK_ID}` : ''}`,
    {
        title: z.string().describe('Concise, actionable work item'),
        description: z.string().optional().describe('Optional details or instructions'),
        status: z.enum(['pending', 'active', 'completed']).optional().describe("Item state; default 'pending'. Set 'active' for the one item you're working on now."),
        priority: z.enum(['high', 'normal', 'low']).optional().describe("Priority badge; default 'normal'"),
        source: z.enum(['user', 'claude', 'github']).optional().describe("Who owns it: 'user' (needs the human), 'claude' (your step), 'github'. Default 'user'."),
        kind: z.enum(['manual', 'action', 'github-issue', 'github-pr']).optional().describe("Item type; default 'manual'. Use github-issue/github-pr for GitHub work."),
        url: z.string().optional().describe('External link (GitHub issue/PR URL) — rendered clickable'),
        externalRef: z.string().optional().describe('Short ref like "amd/gaia#1859"; re-adding the same ref updates it instead of duplicating'),
        parentId: z.string().optional().describe('Parent TODO id to make this a subtask (one level of nesting only)'),
        order: z.number().optional().describe('Execution sequence (lower = earlier); defaults to end of list'),
    },
    async ({ title, description, status, priority, source, kind, url, externalRef, parentId, order }) => {
        const taskId = SELF_TASK_ID;
        if (!taskId) {
            return { content: [{ type: 'text', text: 'Error: No task ID configured (CLAUDIA_TASK_ID not set).' }] };
        }

        try {
            log.info(`Creating TODO for task ${taskId}: ${title}`);
            const response = await backendFetch(`/api/tasks/${taskId}/todos`, {
                method: 'POST',
                body: JSON.stringify({ title, description, status, priority, source, kind, url, externalRef, parentId, order }),
            });

            if (!response.ok) {
                const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
                return { content: [{ type: 'text', text: `Error: ${error.error || response.statusText}` }] };
            }

            const todo = await response.json();
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        todoId: todo.id,
                        title: todo.title,
                        status: todo.status,
                        message: `TODO created: "${todo.title}". It's live in the toolbar work-plan.`
                    }, null, 2)
                }]
            };
        } catch (error) {
            log.error('Failed to create TODO:', error);
            return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
        }
    }
);

// ============================================================================
// Tool: claudia_todo_list
// ============================================================================
server.tool(
    'claudia_todo_list',
    'Read back your task work-plan: all items ordered by execution sequence, plus a progress summary (percent done, which item is active now, which is next). Call this to re-orient on what is left and keep the plan in sync with reality.',
    {
        taskId: z.string().optional().describe(`Task ID to list TODOs for. Defaults to your own task.${SELF_TASK_ID ? ` Your task ID is: ${SELF_TASK_ID}` : ''}`),
    },
    async ({ taskId }) => {
        const effectiveTaskId = taskId || SELF_TASK_ID;
        try {
            const url = effectiveTaskId ? `/api/tasks/${effectiveTaskId}/todos` : '/api/todos';
            const response = await backendFetch(url);

            if (!response.ok) {
                return { content: [{ type: 'text', text: `Error: Failed to list TODOs (HTTP ${response.status})` }] };
            }

            const todos = await response.json();

            if (!todos || todos.length === 0) {
                return { content: [{ type: 'text', text: effectiveTaskId ? `No TODOs for this task yet. Seed your work-plan with claudia_todo_create.` : 'No TODOs.' }] };
            }

            let summary: any = null;
            if (effectiveTaskId) {
                const sres = await backendFetch(`/api/tasks/${effectiveTaskId}/todos/summary`).catch(() => null);
                if (sres && sres.ok) summary = await sres.json();
            }

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        summary,
                        todos: todos.map((t: any) => ({
                            id: t.id,
                            title: t.title,
                            description: t.description || null,
                            status: t.status || (t.completed ? 'completed' : 'pending'),
                            priority: t.priority || 'normal',
                            order: t.order ?? null,
                            source: t.source || 'user',
                            kind: t.kind || 'manual',
                            url: t.url || null,
                            externalRef: t.externalRef || null,
                            parentId: t.parentId || null,
                            completedAt: t.completedAt || null,
                            createdAt: t.createdAt,
                        })),
                    }, null, 2)
                }]
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
        }
    }
);

// ============================================================================
// Tool: claudia_todo_update
// ============================================================================
server.tool(
    'claudia_todo_update',
    "Update a work-plan item: retitle, edit details, change priority/order/parent, or set status. Setting status:'active' marks it as what you're working on now (any previously-active item in the task is demoted to pending — only one is active at a time). Mark status:'completed' as you finish each item so the progress bar advances.",
    {
        todoId: z.string().describe('The TODO item ID to update'),
        title: z.string().optional().describe('New title'),
        description: z.string().optional().describe('New description'),
        completed: z.boolean().optional().describe('Shortcut: true marks completed, false reopens as pending'),
        status: z.enum(['pending', 'active', 'completed']).optional().describe("New state. 'active' = working on it now (single active per task)."),
        priority: z.enum(['high', 'normal', 'low']).optional().describe('New priority'),
        order: z.number().optional().describe('New execution-sequence index (lower = earlier)'),
        parentId: z.string().nullable().optional().describe('Set a parent id to make this a subtask, or null to detach'),
    },
    async ({ todoId, title, description, completed, status, priority, order, parentId }) => {
        try {
            log.info(`Updating TODO ${todoId}`, { title, description, completed, status, priority, order, parentId });
            const response = await backendFetch(`/api/todos/${todoId}`, {
                method: 'PATCH',
                body: JSON.stringify({ title, description, completed, status, priority, order, parentId }),
            });

            if (!response.ok) {
                if (response.status === 404) {
                    return { content: [{ type: 'text', text: `Error: TODO '${todoId}' not found.` }] };
                }
                const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
                return { content: [{ type: 'text', text: `Error: ${error.error || response.statusText}` }] };
            }

            const todo = await response.json();
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        todo: { id: todo.id, title: todo.title, status: todo.status, completed: todo.completed },
                        message: `TODO '${todo.title}' updated.`
                    }, null, 2)
                }]
            };
        } catch (error) {
            log.error('Failed to update TODO:', error);
            return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
        }
    }
);

// ============================================================================
// Tool: claudia_todo_reorder
// ============================================================================
server.tool(
    'claudia_todo_reorder',
    'Set the execution sequence of your work-plan by listing item ids in the order you intend to do them. The first id becomes order 0, and so on. Use this when priorities shift.',
    {
        orderedIds: z.array(z.string()).describe('Item ids in the desired execution order'),
        taskId: z.string().optional().describe(`Task whose TODOs to reorder. Defaults to your own task.${SELF_TASK_ID ? ` Your task ID is: ${SELF_TASK_ID}` : ''}`),
    },
    async ({ orderedIds, taskId }) => {
        const effectiveTaskId = taskId || SELF_TASK_ID;
        if (!effectiveTaskId) {
            return { content: [{ type: 'text', text: 'Error: No task ID configured (CLAUDIA_TASK_ID not set).' }] };
        }
        try {
            const response = await backendFetch(`/api/tasks/${effectiveTaskId}/todos/reorder`, {
                method: 'POST',
                body: JSON.stringify({ orderedIds }),
            });
            if (!response.ok) {
                return { content: [{ type: 'text', text: `Error: Failed to reorder TODOs (HTTP ${response.status})` }] };
            }
            const todos = await response.json();
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({ success: true, count: todos.length, message: 'Work-plan reordered.' }, null, 2)
                }]
            };
        } catch (error) {
            log.error('Failed to reorder TODOs:', error);
            return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
        }
    }
);

} // end if (TODO_ENABLED)

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
