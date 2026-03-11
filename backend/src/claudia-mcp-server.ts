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
 *   - claudia_archive_task: Archive a completed task
 *
 * @experimental This feature is experimental and may change in future versions.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Backend URL - defaults to localhost:4001, can be overridden via env
const BACKEND_URL = process.env.CLAUDIA_BACKEND_URL || 'http://localhost:4001';

// Workspace this MCP server is scoped to (set by task-spawner)
const WORKSPACE_ID = process.env.CLAUDIA_WORKSPACE_ID || '';

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

                // For task:create, wait for task:created response
                if (type === 'task:create' && msg.type === 'task:created') {
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

                // For task:archive, wait for task:archived
                if (type === 'task:archive' && msg.type === 'task:archived') {
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
    `List all active tasks in the current workspace. Shows task ID, state, prompt, and whether it is waiting for input.${WORKSPACE_ID ? ` Scoped to workspace: ${WORKSPACE_ID}` : ''}`,
    {},
    async () => {
        try {
            const response = await backendFetch('/api/tasks');
            if (!response.ok) {
                return { content: [{ type: 'text', text: `Error: Failed to list tasks (HTTP ${response.status})` }] };
            }
            let tasks = await response.json();

            // Filter to current workspace
            if (WORKSPACE_ID) {
                tasks = tasks.filter((t: any) => t.workspaceId === WORKSPACE_ID);
            }

            if (!tasks || tasks.length === 0) {
                return { content: [{ type: 'text', text: `No active tasks in this workspace.` }] };
            }

            const formatted = tasks.map((t: any) => ({
                id: t.id,
                state: t.state,
                prompt: t.displayName || (t.prompt?.substring(0, 100) + (t.prompt?.length > 100 ? '...' : '')),
                workspace: t.workspaceId,
                createdAt: t.createdAt,
                lastActivity: t.lastActivity,
                waitingInputType: t.waitingInputType || null
            }));

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
    'Get detailed status information about a specific task in this workspace, including its state, last activity, and whether it is waiting for input.',
    {
        taskId: z.string().describe('The task ID to get status for'),
    },
    async ({ taskId }) => {
        try {
            const response = await backendFetch(`/api/tasks/${taskId}/status`);
            if (!response.ok) {
                if (response.status === 404) {
                    return { content: [{ type: 'text', text: `Error: Task '${taskId}' not found.` }] };
                }
                return { content: [{ type: 'text', text: `Error: Failed to get task status (HTTP ${response.status})` }] };
            }
            const status = await response.json();

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
server.tool(
    'claudia_create_task',
    `Create a new task in Claudia. The task will be assigned to a Claude Code agent in the current workspace (${WORKSPACE_ID || 'unknown'}). Use this to delegate work to other agents running in parallel.`,
    {
        prompt: z.string().describe('The prompt/instructions for the new task'),
    },
    async ({ prompt }) => {
        if (!WORKSPACE_ID) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: No workspace ID configured. The CLAUDIA_WORKSPACE_ID environment variable is not set.'
                }]
            };
        }

        try {
            log.info(`Creating task in workspace: ${WORKSPACE_ID}`);
            log.info(`Prompt: ${prompt.substring(0, 100)}...`);

            const result = await sendWSMessage('task:create', {
                prompt,
                workspaceId: WORKSPACE_ID,
            });

            const task = (result as any)?.task;
            if (task) {
                log.info(`Task created: ${task.id}`);
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: true,
                            taskId: task.id,
                            state: task.state,
                            workspace: task.workspaceId,
                            prompt: task.prompt?.substring(0, 200),
                            message: `Task '${task.id}' created successfully. It is now running in workspace '${WORKSPACE_ID}'.`
                        }, null, 2)
                    }]
                };
            }

            return {
                content: [{
                    type: 'text',
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
                    type: 'text',
                    text: `Error creating task: ${error instanceof Error ? error.message : String(error)}`
                }]
            };
        }
    }
);

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
                data: input + '\n',
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
// Tool: claudia_archive_task
// ============================================================================
server.tool(
    'claudia_archive_task',
    'Archive a task that has completed or exited. Archived tasks are stored for later reference but removed from the active task list.',
    {
        taskId: z.string().describe('The task ID to archive'),
    },
    async ({ taskId }) => {
        try {
            log.info(`Archiving task: ${taskId}`);

            const result = await sendWSMessage('task:archive', {
                taskId,
            });

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        message: `Task '${taskId}' archived successfully.`,
                        result
                    }, null, 2)
                }]
            };
        } catch (error) {
            log.error('Failed to archive task:', error);
            return {
                content: [{
                    type: 'text',
                    text: `Error archiving task: ${error instanceof Error ? error.message : String(error)}`
                }]
            };
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
