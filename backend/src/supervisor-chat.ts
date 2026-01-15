/**
 * Supervisor Chat - Unified AI supervisor for task monitoring and conversation
 *
 * This component:
 * 1. Monitors tasks and auto-analyzes when they stop (idle, waiting_input, exited)
 * 2. Provides free-form chat interface for user questions
 * 3. Has tools to manage tasks (create, delete, send messages, etc.)
 * 4. Uses a configurable system prompt to guide its behavior
 */
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TaskSpawner } from './task-spawner.js';
import { ConfigStore } from './config-store.js';
import { getConversationHistory, ConversationMessage } from './conversation-parser.js';
import { ChatMessage, Task, SuggestedAction } from '@claudia/shared';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Tool definitions for the supervisor
interface ToolDefinition {
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: Record<string, { type: string; description: string }>;
        required: string[];
    };
}

// Tool call from Claude
interface ToolCall {
    tool: string;
    parameters: Record<string, unknown>;
}

// Claude's response format
interface ClaudeResponse {
    response?: string;
    tool_calls?: ToolCall[];
}

const TOOLS: ToolDefinition[] = [
    {
        name: 'create_task',
        description: 'Create a new coding task. The task will be executed by a Claude Code instance.',
        parameters: {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description: 'The task description/prompt for Claude Code to execute'
                },
                workspace_id: {
                    type: 'string',
                    description: 'Optional workspace ID. If not provided, uses the default workspace.'
                }
            },
            required: ['prompt']
        }
    },
    {
        name: 'delete_task',
        description: 'Delete/remove a task by its ID',
        parameters: {
            type: 'object',
            properties: {
                task_id: {
                    type: 'string',
                    description: 'The ID of the task to delete'
                }
            },
            required: ['task_id']
        }
    },
    {
        name: 'get_task_conversation',
        description: 'Read the conversation history of a specific task',
        parameters: {
            type: 'object',
            properties: {
                task_id: {
                    type: 'string',
                    description: 'The ID of the task to read conversation from'
                }
            },
            required: ['task_id']
        }
    },
    {
        name: 'send_message_to_task',
        description: 'Send a message/input to a running task',
        parameters: {
            type: 'object',
            properties: {
                task_id: {
                    type: 'string',
                    description: 'The ID of the task to send the message to'
                },
                message: {
                    type: 'string',
                    description: 'The message to send to the task'
                }
            },
            required: ['task_id', 'message']
        }
    },
    {
        name: 'list_tasks',
        description: 'List all current tasks with their status',
        parameters: {
            type: 'object',
            properties: {},
            required: []
        }
    }
];

// Path for chat history persistence
const CHAT_HISTORY_FILE = join(__dirname, '..', 'chat-history.json');
const MAX_HISTORY_MESSAGES = 200; // Limit history to prevent unbounded growth

// Rate limiting for Claude process spawning
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute window
const MAX_SPAWNS_PER_WINDOW = 10; // Max Claude processes per window

export class SupervisorChat extends EventEmitter {
    private taskSpawner: TaskSpawner;
    private workspaceStore: { getWorkspaces: () => { id: string; name: string }[] };
    private configStore: ConfigStore;
    private chatHistory: ChatMessage[] = [];
    private isProcessing: boolean = false;
    private processingTasks: Set<string> = new Set();  // Prevent duplicate auto-analysis
    private saveDebounceTimer: NodeJS.Timeout | null = null;
    private spawnTimestamps: number[] = [];  // Track spawn timestamps for rate limiting

    constructor(
        taskSpawner: TaskSpawner,
        workspaceStore: { getWorkspaces: () => { id: string; name: string }[] },
        configStore: ConfigStore
    ) {
        super();
        this.taskSpawner = taskSpawner;
        this.workspaceStore = workspaceStore;
        this.configStore = configStore;

        // Load persisted chat history
        this.loadChatHistory();

        // Set up auto-analysis on task state changes
        this.setupTaskListeners();
    }

    /**
     * Load chat history from disk
     */
    private loadChatHistory(): void {
        try {
            if (existsSync(CHAT_HISTORY_FILE)) {
                const data = readFileSync(CHAT_HISTORY_FILE, 'utf-8');
                const parsed = JSON.parse(data);
                if (Array.isArray(parsed)) {
                    this.chatHistory = parsed;
                    console.log(`[SupervisorChat] Loaded ${this.chatHistory.length} messages from history`);
                }
            }
        } catch (error) {
            console.error('[SupervisorChat] Failed to load chat history:', error);
            this.chatHistory = [];
        }
    }

    /**
     * Save chat history to disk (debounced)
     */
    private saveChatHistory(): void {
        // Debounce saves to avoid excessive disk I/O
        if (this.saveDebounceTimer) {
            clearTimeout(this.saveDebounceTimer);
        }
        this.saveDebounceTimer = setTimeout(() => {
            this.saveChatHistoryNow();
        }, 500);
    }

    /**
     * Check if we can spawn a new Claude process (rate limiting)
     */
    private canSpawnProcess(): boolean {
        const now = Date.now();
        // Remove timestamps outside the window
        this.spawnTimestamps = this.spawnTimestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
        return this.spawnTimestamps.length < MAX_SPAWNS_PER_WINDOW;
    }

    /**
     * Record a process spawn for rate limiting
     */
    private recordSpawn(): void {
        this.spawnTimestamps.push(Date.now());
    }

    /**
     * Save chat history immediately (used for graceful shutdown)
     */
    saveChatHistoryNow(): void {
        try {
            // Trim history if too long
            if (this.chatHistory.length > MAX_HISTORY_MESSAGES) {
                this.chatHistory = this.chatHistory.slice(-MAX_HISTORY_MESSAGES);
            }
            writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(this.chatHistory, null, 2));
            console.log(`[SupervisorChat] Saved ${this.chatHistory.length} messages to history`);
        } catch (error) {
            console.error('[SupervisorChat] Failed to save chat history:', error);
        }
    }

    /**
     * Listen for task events: creation and state changes
     */
    private setupTaskListeners(): void {
        // When a task is created, post the first message in its thread (only if supervisor enabled)
        this.taskSpawner.on('taskCreated', (task: Task) => {
            if (!this.configStore.isSupervisorEnabled()) {
                console.log(`[SupervisorChat] Supervisor disabled, skipping task created message`);
                return;
            }
            console.log(`[SupervisorChat] Task ${task.id} created, starting thread...`);
            this.postTaskCreatedMessage(task);
        });

        // When task state changes to idle/waiting_input/exited, auto-analyze (only if supervisor enabled)
        this.taskSpawner.on('taskStateChanged', async (task: Task) => {
            if (!this.configStore.isSupervisorEnabled()) {
                console.log(`[SupervisorChat] Supervisor disabled, skipping auto-analysis`);
                return;
            }

            const shouldAnalyze =
                task.state === 'idle' ||
                task.state === 'waiting_input' ||
                task.state === 'exited';

            if (shouldAnalyze) {
                console.log(`[SupervisorChat] Task ${task.id} changed to ${task.state}, auto-analyzing...`);
                await this.autoAnalyzeTask(task);
            }
        });
    }

    /**
     * Post the initial message when a task is created (starts the thread)
     */
    private postTaskCreatedMessage(task: Task): void {
        const message: ChatMessage = {
            id: randomUUID(),
            role: 'assistant',
            content: `**Task started**\n\n${task.prompt}`,
            timestamp: new Date().toISOString(),
            taskId: task.id
        };

        this.chatHistory.push(message);
        this.saveChatHistory();
        this.emit('message', message);
    }

    /**
     * Auto-analyze a task when its state changes (idle/waiting_input/exited)
     * Posts the analysis as a chat message
     */
    async autoAnalyzeTask(task: Task): Promise<void> {
        // Prevent duplicate processing
        if (this.processingTasks.has(task.id)) {
            console.log(`[SupervisorChat] Already processing task ${task.id}, skipping`);
            return;
        }

        this.processingTasks.add(task.id);

        try {
            // Get task conversation history
            const internalTask = this.taskSpawner.getTask(task.id);
            const sessionId = internalTask?.sessionId;

            let conversationContext = '';
            if (sessionId) {
                const workspace = this.workspaceStore.getWorkspaces().find(w => w.id === task.workspaceId);
                if (workspace) {
                    const conversation = await getConversationHistory(workspace.id, sessionId);
                    if (conversation && conversation.messages.length > 0) {
                        conversationContext = this.formatConversationForAnalysis(conversation.messages.slice(-10));
                    }
                }
            }

            // Get the configurable system prompt
            const systemPrompt = this.configStore.getSupervisorSystemPrompt();

            // Build analysis prompt
            const analysisPrompt = `${systemPrompt}

## Task Information
- Task ID: ${task.id}
- Current State: ${task.state}
- Original Prompt: "${task.prompt}"

## Recent Conversation
${conversationContext || 'No conversation history available.'}

## Your Task
Analyze this task and provide:
1. A brief summary of what happened (2-3 sentences)
2. Whether any follow-up actions are needed
3. Suggested next steps (if any)

Respond in a conversational way as if you're updating the user about their task.
If the task completed successfully with no issues, just confirm it's done.
If there are errors or the task needs input, explain what's needed.

Keep your response concise and actionable.`;

            // Call Claude Code for analysis
            const analysis = await this.callClaudeSimple(analysisPrompt, task.workspaceId);

            // Create assistant message with the analysis
            const assistantMessage: ChatMessage = {
                id: randomUUID(),
                role: 'assistant',
                content: analysis,
                timestamp: new Date().toISOString(),
                taskId: task.id
            };

            this.chatHistory.push(assistantMessage);
            this.saveChatHistory();
            this.emit('message', assistantMessage);

            console.log(`[SupervisorChat] Auto-analysis complete for task ${task.id}`);
        } catch (error) {
            console.error(`[SupervisorChat] Error auto-analyzing task ${task.id}:`, error);

            // Send fallback message
            const fallbackMessage: ChatMessage = {
                id: randomUUID(),
                role: 'assistant',
                content: `Task "${task.prompt.substring(0, 50)}${task.prompt.length > 50 ? '...' : ''}" is now ${task.state}.`,
                timestamp: new Date().toISOString(),
                taskId: task.id
            };
            this.chatHistory.push(fallbackMessage);
            this.saveChatHistory();
            this.emit('message', fallbackMessage);
        } finally {
            this.processingTasks.delete(task.id);
        }
    }

    /**
     * Format conversation messages for analysis
     */
    private formatConversationForAnalysis(messages: ConversationMessage[]): string {
        return messages.map(msg => {
            const role = msg.role === 'user' ? 'USER' : 'ASSISTANT';
            // Truncate long messages
            const content = msg.content.length > 500
                ? msg.content.substring(0, 500) + '...[truncated]'
                : msg.content;
            return `[${role}]: ${content}`;
        }).join('\n\n');
    }

    /**
     * Simple Claude call without tool support (for auto-analysis)
     */
    private async callClaudeSimple(prompt: string, workspaceId: string): Promise<string> {
        // Rate limiting check
        if (!this.canSpawnProcess()) {
            throw new Error('Rate limit exceeded: too many Claude processes spawned recently');
        }
        this.recordSpawn();

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                claudeProcess.kill();
                reject(new Error('Claude Code timeout'));
            }, 30000);

            const claudeProcess = spawn('claude', [
                '--print',
                '--output-format', 'text',
                '-p', prompt
            ], {
                cwd: workspaceId,
                env: process.env as { [key: string]: string },
                stdio: ['pipe', 'pipe', 'pipe']
            });

            claudeProcess.stdin?.end();

            let stdout = '';
            let stderr = '';

            claudeProcess.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            claudeProcess.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            claudeProcess.on('close', (code) => {
                clearTimeout(timeout);

                if (code !== 0) {
                    console.error(`[SupervisorChat] Claude Code exited with code ${code}: ${stderr}`);
                    reject(new Error(`Claude Code failed: ${stderr}`));
                    return;
                }

                resolve(stdout.trim());
            });

            claudeProcess.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
    }

    /**
     * Execute a suggested action on a task
     */
    executeAction(taskId: string, action: SuggestedAction): void {
        if (action.value === '__reconnect__') {
            this.taskSpawner.reconnectTask(taskId);
            return;
        }

        // Send the action value as input to the task
        this.taskSpawner.writeToTask(taskId, action.value + '\r');
        console.log(`[SupervisorChat] Executed action "${action.label}" for task ${taskId}`);
    }

    /**
     * Send a message to the supervisor and get a response
     */
    async sendMessage(content: string, taskId?: string): Promise<ChatMessage | null> {
        if (this.isProcessing) {
            console.log('[SupervisorChat] Already processing a message, please wait');
            return null;
        }

        this.isProcessing = true;
        this.emit('typing', true);

        try {
            // Create and store user message
            const userMessage: ChatMessage = {
                id: randomUUID(),
                role: 'user',
                content,
                timestamp: new Date().toISOString(),
                taskId
            };
            this.chatHistory.push(userMessage);
            this.saveChatHistory();
            this.emit('message', userMessage);

            // Get context about tasks
            const context = await this.buildContext(taskId);

            // Call Claude Code with tool support
            const result = await this.callClaudeWithTools(content, context);

            // Process tool calls if any
            let finalResponse = result.response || '';
            if (result.tool_calls && result.tool_calls.length > 0) {
                const toolResults = await this.executeToolCalls(result.tool_calls);

                // If we have tool results, get a final response incorporating them
                if (toolResults.length > 0) {
                    const toolResultsText = toolResults.map(r =>
                        `Tool: ${r.tool}\nResult: ${r.result}`
                    ).join('\n\n');

                    finalResponse = await this.getFollowUpResponse(content, toolResultsText, context);
                }
            }

            // Create and store assistant message
            const assistantMessage: ChatMessage = {
                id: randomUUID(),
                role: 'assistant',
                content: finalResponse,
                timestamp: new Date().toISOString(),
                taskId
            };
            this.chatHistory.push(assistantMessage);
            this.saveChatHistory();
            this.emit('message', assistantMessage);

            return assistantMessage;
        } catch (error) {
            console.error('[SupervisorChat] Error processing message:', error);

            // Send error response
            const errorMessage: ChatMessage = {
                id: randomUUID(),
                role: 'assistant',
                content: 'Sorry, I encountered an error processing your message. Please try again.',
                timestamp: new Date().toISOString(),
                taskId
            };
            this.chatHistory.push(errorMessage);
            this.saveChatHistory();
            this.emit('message', errorMessage);

            return errorMessage;
        } finally {
            this.isProcessing = false;
            this.emit('typing', false);
        }
    }

    /**
     * Execute tool calls and return results
     */
    private async executeToolCalls(toolCalls: ToolCall[]): Promise<{ tool: string; result: string }[]> {
        const results: { tool: string; result: string }[] = [];

        for (const call of toolCalls) {
            console.log(`[SupervisorChat] Executing tool: ${call.tool}`, call.parameters);

            try {
                let result: string;

                switch (call.tool) {
                    case 'create_task':
                        result = await this.toolCreateTask(call.parameters);
                        break;
                    case 'delete_task':
                        result = await this.toolDeleteTask(call.parameters);
                        break;
                    case 'get_task_conversation':
                        result = await this.toolGetTaskConversation(call.parameters);
                        break;
                    case 'send_message_to_task':
                        result = await this.toolSendMessageToTask(call.parameters);
                        break;
                    case 'list_tasks':
                        result = await this.toolListTasks();
                        break;
                    default:
                        result = `Unknown tool: ${call.tool}`;
                }

                results.push({ tool: call.tool, result });
            } catch (error) {
                results.push({ tool: call.tool, result: `Error: ${error}` });
            }
        }

        return results;
    }

    /**
     * Tool: Create a new task
     */
    private async toolCreateTask(params: Record<string, unknown>): Promise<string> {
        const prompt = params.prompt as string;
        let workspaceId = params.workspace_id as string | undefined;

        if (!prompt) {
            return 'Error: prompt is required';
        }

        // Get default workspace if not provided
        if (!workspaceId) {
            const workspaces = this.workspaceStore.getWorkspaces();
            if (workspaces.length === 0) {
                return 'Error: No workspaces available. Please create a workspace first.';
            }
            workspaceId = workspaces[0].id;
        }

        try {
            const task = await this.taskSpawner.createTask(prompt, workspaceId);
            return `Task created successfully!\nTask ID: ${task.id}\nPrompt: ${task.prompt}\nWorkspace: ${workspaceId}`;
        } catch (error) {
            return `Error creating task: ${error}`;
        }
    }

    /**
     * Tool: Delete a task
     */
    private async toolDeleteTask(params: Record<string, unknown>): Promise<string> {
        const taskId = params.task_id as string;

        if (!taskId) {
            return 'Error: task_id is required';
        }

        // Find task by ID or partial ID
        const task = this.findTaskById(taskId);
        if (!task) {
            return `Error: Task not found with ID: ${taskId}`;
        }

        try {
            this.taskSpawner.destroyTask(task.id);
            return `Task ${task.id} has been deleted successfully.`;
        } catch (error) {
            return `Error deleting task: ${error}`;
        }
    }

    /**
     * Tool: Get task conversation history
     */
    private async toolGetTaskConversation(params: Record<string, unknown>): Promise<string> {
        const taskId = params.task_id as string;

        if (!taskId) {
            return 'Error: task_id is required';
        }

        const task = this.findTaskById(taskId);
        if (!task) {
            return `Error: Task not found with ID: ${taskId}`;
        }

        const internalTask = this.taskSpawner.getTask(task.id);
        if (!internalTask?.sessionId) {
            return `Task ${task.id} has no conversation history yet.`;
        }

        const workspace = this.workspaceStore.getWorkspaces().find(w => w.id === internalTask.workspaceId);
        if (!workspace) {
            return 'Error: Workspace not found for this task.';
        }

        try {
            const conversation = await getConversationHistory(workspace.id, internalTask.sessionId);
            if (!conversation || conversation.messages.length === 0) {
                return `No conversation history found for task ${task.id}.`;
            }

            const formatted = conversation.messages.map(msg => {
                const role = msg.role === 'user' ? 'User' : 'Assistant';
                return `**${role}:** ${msg.content}`;
            }).join('\n\n');

            return `Conversation history for task ${task.id}:\n\n${formatted}`;
        } catch (error) {
            return `Error getting conversation: ${error}`;
        }
    }

    /**
     * Tool: Send message to a task
     */
    private async toolSendMessageToTask(params: Record<string, unknown>): Promise<string> {
        const taskId = params.task_id as string;
        const message = params.message as string;

        if (!taskId) {
            return 'Error: task_id is required';
        }
        if (!message) {
            return 'Error: message is required';
        }

        const task = this.findTaskById(taskId);
        if (!task) {
            return `Error: Task not found with ID: ${taskId}`;
        }

        try {
            // Send input to the task's terminal
            this.taskSpawner.writeToTask(task.id, message + '\n');
            return `Message sent to task ${task.id}: "${message}"`;
        } catch (error) {
            return `Error sending message: ${error}`;
        }
    }

    /**
     * Tool: List all tasks
     */
    private async toolListTasks(): Promise<string> {
        const tasks = this.taskSpawner.getAllTasks();

        if (tasks.length === 0) {
            return 'No tasks currently active.';
        }

        const taskList = tasks.map(task => {
            return `- **${task.id}** (${task.state}): "${task.prompt.substring(0, 80)}${task.prompt.length > 80 ? '...' : ''}"`;
        }).join('\n');

        return `Current tasks (${tasks.length}):\n${taskList}`;
    }

    /**
     * Find a task by full or partial ID
     */
    private findTaskById(taskId: string): Task | null {
        const tasks = this.taskSpawner.getAllTasks();

        // Try exact match first
        let task = tasks.find(t => t.id === taskId);
        if (task) return task;

        // Try partial match
        task = tasks.find(t => t.id.includes(taskId) || t.id.startsWith(taskId));
        return task || null;
    }

    /**
     * Build context about current tasks for the AI
     */
    private async buildContext(focusTaskId?: string): Promise<string> {
        const parts: string[] = [];

        // Get all tasks
        const tasks = this.taskSpawner.getAllTasks();

        if (tasks.length > 0) {
            parts.push('## Current Tasks\n');
            for (const task of tasks) {
                const marker = task.id === focusTaskId ? ' [FOCUSED]' : '';
                parts.push(`- Task ${task.id}${marker}: "${task.prompt.substring(0, 100)}" (${task.state})`);
            }
            parts.push('');
        } else {
            parts.push('## Current Tasks\nNo active tasks.\n');
        }

        // Get workspaces
        const workspaces = this.workspaceStore.getWorkspaces();
        if (workspaces.length > 0) {
            parts.push('## Available Workspaces\n');
            for (const ws of workspaces) {
                parts.push(`- ${ws.id} (${ws.name || 'unnamed'})`);
            }
            parts.push('');
        }

        // Get conversation history for focused task
        if (focusTaskId) {
            const internalTask = this.taskSpawner.getTask(focusTaskId);
            if (internalTask?.sessionId) {
                const workspace = this.workspaceStore.getWorkspaces().find(w => w.id === internalTask.workspaceId);
                if (workspace) {
                    const conversation = await getConversationHistory(workspace.id, internalTask.sessionId);
                    if (conversation && conversation.messages.length > 0) {
                        parts.push('## Recent Task Conversation\n');
                        const recentMessages = conversation.messages.slice(-5);
                        for (const msg of recentMessages) {
                            const role = msg.role === 'user' ? 'User' : 'Assistant';
                            const truncated = msg.content.length > 300
                                ? msg.content.substring(0, 300) + '...'
                                : msg.content;
                            parts.push(`**${role}:** ${truncated}\n`);
                        }
                    }
                }
            }
        }

        return parts.join('\n');
    }

    /**
     * Format chat history for the prompt
     */
    private formatChatHistory(): string {
        // Include last 10 messages for context
        const recent = this.chatHistory.slice(-10);
        if (recent.length === 0) return '';

        const formatted = recent.map(msg => {
            const role = msg.role === 'user' ? 'User' : 'Supervisor';
            return `${role}: ${msg.content}`;
        }).join('\n\n');

        return `## Previous Chat History\n${formatted}\n`;
    }

    /**
     * Build the system prompt with tools
     */
    private buildSystemPrompt(context: string): string {
        const toolsJson = JSON.stringify(TOOLS, null, 2);
        const chatHistorySection = this.formatChatHistory();

        return `You are a helpful AI supervisor assistant for a code development environment.
You help users understand and manage their coding tasks, answer questions about what's happening,
and can take actions using the tools available to you.

## Available Tools
You have access to the following tools. To use a tool, respond with JSON in this exact format:
\`\`\`json
{
  "response": "Your message to the user (can be empty if just calling tools)",
  "tool_calls": [
    {
      "tool": "tool_name",
      "parameters": { "param1": "value1" }
    }
  ]
}
\`\`\`

If you don't need to use any tools, respond with just:
\`\`\`json
{
  "response": "Your message to the user"
}
\`\`\`

Tools available:
${toolsJson}

## Context
${context}

${chatHistorySection}

IMPORTANT: Always respond with valid JSON. Do not include any text outside the JSON block.`;
    }

    /**
     * Call Claude Code with tool support
     */
    private async callClaudeWithTools(userMessage: string, context: string): Promise<ClaudeResponse> {
        // Rate limiting check
        if (!this.canSpawnProcess()) {
            throw new Error('Rate limit exceeded: too many Claude processes spawned recently');
        }
        this.recordSpawn();

        const systemPrompt = this.buildSystemPrompt(context);
        const fullPrompt = `${systemPrompt}\n\nUser message: "${userMessage}"\n\nRespond with JSON:`;

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                claudeProcess.kill();
                reject(new Error('Claude Code timeout'));
            }, 90000); // 90 second timeout for tool calls

            // Get the first workspace for cwd, or use current directory
            const workspaces = this.workspaceStore.getWorkspaces();
            const cwd = workspaces.length > 0 ? workspaces[0].id : process.cwd();

            const claudeProcess = spawn('claude', [
                '--print',
                '--output-format', 'text',
                '-p', fullPrompt
            ], {
                cwd,
                env: process.env as { [key: string]: string },
                stdio: ['pipe', 'pipe', 'pipe']
            });

            // Close stdin immediately
            claudeProcess.stdin?.end();

            let stdout = '';
            let stderr = '';

            claudeProcess.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            claudeProcess.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            claudeProcess.on('close', (code) => {
                clearTimeout(timeout);

                if (code !== 0) {
                    console.error(`[SupervisorChat] Claude Code exited with code ${code}: ${stderr}`);
                    reject(new Error(`Claude Code failed: ${stderr}`));
                    return;
                }

                const response = stdout.trim();
                console.log(`[SupervisorChat] Got response (${response.length} chars)`);

                // Parse JSON response
                try {
                    const parsed = this.parseClaudeResponse(response);
                    resolve(parsed);
                } catch (parseError) {
                    // If parsing fails, treat the entire response as text
                    console.warn('[SupervisorChat] Failed to parse JSON, using raw response');
                    resolve({ response: response });
                }
            });

            claudeProcess.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
    }

    /**
     * Parse Claude's JSON response
     */
    private parseClaudeResponse(response: string): ClaudeResponse {
        // Try to extract JSON from the response
        // Look for JSON block in markdown code fence
        const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[1].trim());
        }

        // Try parsing the entire response as JSON
        const trimmed = response.trim();
        if (trimmed.startsWith('{')) {
            return JSON.parse(trimmed);
        }

        // If no JSON found, return as plain response
        return { response: response };
    }

    /**
     * Get a follow-up response after tool execution
     */
    private async getFollowUpResponse(originalMessage: string, toolResults: string, _context: string): Promise<string> {
        // Rate limiting check
        if (!this.canSpawnProcess()) {
            // If rate limited, just return tool results directly
            return `Action completed:\n${toolResults}`;
        }
        this.recordSpawn();

        const prompt = `You previously received this user message: "${originalMessage}"

You called tools and got these results:
${toolResults}

Based on these results, provide a helpful response to the user. Be concise but informative.
Do NOT use JSON format for this response - just provide a natural language response.`;

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                claudeProcess.kill();
                reject(new Error('Claude Code timeout'));
            }, 60000);

            const workspaces = this.workspaceStore.getWorkspaces();
            const cwd = workspaces.length > 0 ? workspaces[0].id : process.cwd();

            const claudeProcess = spawn('claude', [
                '--print',
                '--output-format', 'text',
                '-p', prompt
            ], {
                cwd,
                env: process.env as { [key: string]: string },
                stdio: ['pipe', 'pipe', 'pipe']
            });

            claudeProcess.stdin?.end();

            let stdout = '';
            let stderr = '';

            claudeProcess.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            claudeProcess.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            claudeProcess.on('close', (code) => {
                clearTimeout(timeout);

                if (code !== 0) {
                    console.error(`[SupervisorChat] Follow-up failed with code ${code}: ${stderr}`);
                    // Return tool results directly if follow-up fails
                    resolve(`Action completed:\n${toolResults}`);
                    return;
                }

                resolve(stdout.trim());
            });

            claudeProcess.on('error', (err) => {
                clearTimeout(timeout);
                resolve(`Action completed:\n${toolResults}`);
            });
        });
    }

    /**
     * Get chat history (all messages)
     */
    getHistory(): ChatMessage[] {
        return [...this.chatHistory];
    }

    /**
     * Get chat history for a specific task thread
     */
    getTaskHistory(taskId: string): ChatMessage[] {
        return this.chatHistory.filter(msg => msg.taskId === taskId);
    }

    /**
     * Get all task threads (grouped by taskId)
     */
    getThreads(): Map<string, ChatMessage[]> {
        const threads = new Map<string, ChatMessage[]>();
        for (const msg of this.chatHistory) {
            if (msg.taskId) {
                const existing = threads.get(msg.taskId) || [];
                existing.push(msg);
                threads.set(msg.taskId, existing);
            }
        }
        return threads;
    }

    /**
     * Clear chat history
     */
    clearHistory(): void {
        this.chatHistory = [];
        this.saveChatHistory();
        this.emit('historyCleared');
    }

    /**
     * Clear history for a specific task thread
     */
    clearTaskHistory(taskId: string): void {
        this.chatHistory = this.chatHistory.filter(msg => msg.taskId !== taskId);
        this.saveChatHistory();
        this.emit('taskHistoryCleared', taskId);
    }
}
