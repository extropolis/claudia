/**
 * VoiceAgent - Voice-optimized AI agent for mobile hands-free control
 *
 * Features:
 * - Responds directly to simple queries without creating tasks
 * - Uses Claudia backend tools to manage tasks (create, stop, list, etc.)
 * - Ultra-short responses (1-2 sentences, < 20 words)
 * - No markdown formatting, conversational tone
 * - STREAMS responses for lower latency
 * - Proactive task updates: periodically summarizes what running tasks are doing
 */

import Anthropic from '@anthropic-ai/sdk';
import { SupervisorChat } from './supervisor-chat.js';
import { TaskSpawner } from './task-spawner.js';
import { WorkspaceStore } from './workspace-store.js';
import { ConfigStore } from './config-store.js';
import { AutonomousController } from './autonomous-controller.js';
import { EventEmitter } from 'events';
import type { Task, ChatMessage } from '@claudia/shared';

const BACKEND_URL = process.env.CLAUDIA_BACKEND_URL || 'http://localhost:4001';

const VOICE_TOOLS: Anthropic.Tool[] = [
    {
        name: 'list_tasks',
        description: 'List all active tasks in the current workspace. Shows task ID, state, prompt, and whether it is waiting for input.',
        input_schema: {
            type: 'object' as const,
            properties: {},
            required: []
        }
    },
    {
        name: 'create_task',
        description: 'Create a new coding task. The task will be executed by a Claude Code agent in the current workspace.',
        input_schema: {
            type: 'object' as const,
            properties: {
                prompt: { type: 'string', description: 'The task description/prompt for Claude Code to execute' },
                displayName: { type: 'string', description: 'Optional short display name for the task in the sidebar' }
            },
            required: ['prompt']
        }
    },
    {
        name: 'get_task_status',
        description: 'Get detailed status of a specific task including state, runtime duration, and a snippet of recent output.',
        input_schema: {
            type: 'object' as const,
            properties: {
                taskId: { type: 'string', description: 'The task ID to get status for' }
            },
            required: ['taskId']
        }
    },
    {
        name: 'stop_task',
        description: 'Gracefully stop a running task by sending an interrupt signal. The task transitions to idle and can be resumed later.',
        input_schema: {
            type: 'object' as const,
            properties: {
                taskId: { type: 'string', description: 'The task ID to stop' }
            },
            required: ['taskId']
        }
    },
    {
        name: 'stop_all_tasks',
        description: 'Stop all running tasks in the current workspace.',
        input_schema: {
            type: 'object' as const,
            properties: {},
            required: []
        }
    },
    {
        name: 'send_input',
        description: 'Send input to a task that is waiting for input (e.g., answering a question or granting permission).',
        input_schema: {
            type: 'object' as const,
            properties: {
                taskId: { type: 'string', description: 'The task ID to send input to' },
                input: { type: 'string', description: 'The input text to send' }
            },
            required: ['taskId', 'input']
        }
    },
    {
        name: 'continue_task',
        description: 'Send a follow-up prompt to an idle or exited task, resuming its session with a new instruction.',
        input_schema: {
            type: 'object' as const,
            properties: {
                taskId: { type: 'string', description: 'The task ID to continue' },
                prompt: { type: 'string', description: 'The follow-up prompt/instructions' }
            },
            required: ['taskId', 'prompt']
        }
    },
    {
        name: 'get_task_output',
        description: 'Fetch recent terminal output from a task to see what it has been doing or check its results.',
        input_schema: {
            type: 'object' as const,
            properties: {
                taskId: { type: 'string', description: 'The task ID to get output from' }
            },
            required: ['taskId']
        }
    },
    // Autonomous mode tools
    {
        name: 'start_autonomous',
        description: 'Start autonomous development mode. The system will plan, build, test, and iterate on a project by itself. Ask the user for a workspace path before calling this.',
        input_schema: {
            type: 'object' as const,
            properties: {
                goal: { type: 'string', description: 'High-level goal (e.g. "Build a todo app with React and Tailwind")' },
                workspacePath: { type: 'string', description: 'Absolute path for the project workspace (required — ask the user where to create it)' },
                maxIterations: { type: 'number', description: 'Optional iteration budget (default 50)' }
            },
            required: ['goal', 'workspacePath']
        }
    },
    {
        name: 'stop_autonomous',
        description: 'Stop the current autonomous development session. All running tasks will be stopped.',
        input_schema: {
            type: 'object' as const,
            properties: {},
            required: []
        }
    },
    {
        name: 'pause_autonomous',
        description: 'Pause or resume the autonomous session. When paused, no new tasks are spawned but existing ones continue.',
        input_schema: {
            type: 'object' as const,
            properties: {},
            required: []
        }
    },
    {
        name: 'get_autonomous_status',
        description: 'Get the current status of the autonomous development session including plan progress, active tasks, and test results.',
        input_schema: {
            type: 'object' as const,
            properties: {},
            required: []
        }
    },
    {
        name: 'adjust_autonomous_goal',
        description: 'Adjust the goal of the current autonomous session mid-flight. The system will revise its plan accordingly.',
        input_schema: {
            type: 'object' as const,
            properties: {
                adjustment: { type: 'string', description: 'What to change (e.g. "Also add dark mode support")' }
            },
            required: ['adjustment']
        }
    }
];

export class VoiceAgent extends EventEmitter {
    private supervisorChat: SupervisorChat;
    private taskSpawner: TaskSpawner;
    private workspaceStore: WorkspaceStore;
    private anthropic: Anthropic | null = null;
    private customSystemPrompt: string;
    private autonomousController: AutonomousController;

    // Proactive update state
    private proactiveInterval: NodeJS.Timeout | null = null;
    private proactiveIntervalMs: number = 60000; // 60 seconds
    private lastTaskOutputSnapshots: Map<string, string> = new Map(); // taskId -> last seen output
    private proactiveEnabled: boolean = true;
    private activeVoiceWorkspaces: Set<string> = new Set(); // workspaces with voice clients

    constructor(
        supervisorChat: SupervisorChat,
        taskSpawner: TaskSpawner,
        workspaceStore: WorkspaceStore,
        configStore: ConfigStore
    ) {
        super();
        this.supervisorChat = supervisorChat;
        this.taskSpawner = taskSpawner;
        this.workspaceStore = workspaceStore;

        // Initialize Anthropic SDK for streaming (optional - voice features disabled without API key)
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            console.warn('[VoiceAgent] ANTHROPIC_API_KEY not set - voice features will be unavailable');
        } else {
            this.anthropic = new Anthropic({ apiKey });
        }

        // Initialize autonomous controller
        this.autonomousController = new AutonomousController(taskSpawner, workspaceStore, configStore);
        this.autonomousController.on('autonomous:announce', (msg: string) => {
            this.emit('voice:autonomous_update', { text: msg });
        });
        this.autonomousController.on('autonomous:stateChanged', (status: any) => {
            this.emit('voice:autonomous_status', status);
        });

        // Default system prompt
        this.customSystemPrompt = `You are a voice assistant for a coding environment called Claudia. Keep responses ULTRA SHORT - 1-2 sentences max, under 20 words if possible. Be conversational, natural, and friendly. No markdown, no bullet points, no formatting. Just speak naturally.

You have tools to manage coding tasks. Use them when the user asks to create tasks, check status, stop tasks, send input, or interact with running tasks. After using tools, summarize the result briefly in a conversational way.

You can also start AUTONOMOUS MODE — where you plan, build, test, and iterate on a project by yourself. When the user asks you to "build something autonomously" or "go autonomous", use start_autonomous. ALWAYS ask the user where they want the project created before starting.

Answer questions directly. If the user wants to create a task or control tasks, use your tools to do it.`;
    }

    /**
     * Process voice input and stream response in real-time with tool use support
     */
    async processVoiceMessageStreaming(
        transcript: string,
        workspaceId?: string,
        userId?: string,
        callbacks?: {
            onTextChunk?: (text: string) => void;
            onComplete?: (response: VoiceResponse) => void;
            onError?: (error: Error) => void;
        }
    ): Promise<void> {
        console.log('[VoiceAgent] Processing (streaming):', transcript);

        // Check for interrupt commands first
        if (this.isInterruptCommand(transcript)) {
            const response = await this.handleInterrupt(transcript);
            if (callbacks?.onTextChunk) callbacks.onTextChunk(response.text);
            if (callbacks?.onComplete) callbacks.onComplete(response);
            return;
        }

        // Check for simple status queries that don't need LLM
        const simpleResponse = this.trySimpleResponse(transcript, workspaceId);
        if (simpleResponse) {
            if (callbacks?.onTextChunk) callbacks.onTextChunk(simpleResponse.text);
            if (callbacks?.onComplete) callbacks.onComplete(simpleResponse);
            return;
        }

        // Build dynamic context with task status
        const taskContext = this.buildTaskContext(workspaceId);

        // Build system prompt with custom prompt and dynamic context
        const systemPrompt = `${this.customSystemPrompt}

${taskContext ? `\n## Current Task Status\n${taskContext}\n` : ''}`;

        try {
            if (!this.anthropic) {
                const err = new Error('Voice features unavailable: ANTHROPIC_API_KEY not configured');
                if (callbacks?.onError) callbacks.onError(err);
                return;
            }

            // Tool use loop: keep calling Claude until we get a final text response
            const messages: Anthropic.MessageParam[] = [{
                role: 'user',
                content: transcript
            }];

            const MAX_TOOL_ITERATIONS = 5;
            for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
                const stream = await this.anthropic.messages.stream({
                    model: 'claude-sonnet-4-6',
                    max_tokens: 1024,
                    messages,
                    system: systemPrompt,
                    tools: VOICE_TOOLS
                });

                let fullText = '';
                const toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
                let currentToolUse: { id: string; name: string; inputJson: string } | null = null;

                // Collect the full response (text + tool_use blocks)
                stream.on('text', (text) => {
                    fullText += text;
                    if (callbacks?.onTextChunk) {
                        callbacks.onTextChunk(text);
                    }
                });

                stream.on('contentBlock', (block) => {
                    if (block.type === 'tool_use') {
                        toolUseBlocks.push({
                            id: block.id,
                            name: block.name,
                            input: block.input as Record<string, unknown>
                        });
                    }
                });

                const finalMessage = await stream.finalMessage();

                // If no tool use, we're done — stream already delivered text
                if (finalMessage.stop_reason !== 'tool_use' || toolUseBlocks.length === 0) {
                    const voiceText = this.optimizeForVoice(fullText);
                    if (callbacks?.onComplete) {
                        callbacks.onComplete({
                            text: voiceText,
                            action: 'response'
                        });
                    }
                    return;
                }

                // Execute tool calls and build tool results
                console.log(`[VoiceAgent] Executing ${toolUseBlocks.length} tool call(s) (iteration ${iteration + 1})`);

                // Build assistant message content from the final message
                const assistantContent: Anthropic.ContentBlockParam[] = [];
                for (const block of finalMessage.content) {
                    if (block.type === 'text' && block.text) {
                        assistantContent.push({ type: 'text', text: block.text });
                    } else if (block.type === 'tool_use') {
                        assistantContent.push({
                            type: 'tool_use',
                            id: block.id,
                            name: block.name,
                            input: block.input as Record<string, unknown>
                        });
                    }
                }

                messages.push({ role: 'assistant', content: assistantContent });

                // Execute tools and add results
                const toolResults: Anthropic.ToolResultBlockParam[] = [];
                for (const tool of toolUseBlocks) {
                    const result = await this.executeTool(tool.name, tool.input, workspaceId);
                    console.log(`[VoiceAgent] Tool ${tool.name} result:`, result.substring(0, 200));
                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: tool.id,
                        content: result
                    });
                }

                messages.push({ role: 'user', content: toolResults });
            }

            // Max iterations reached — send whatever we have
            if (callbacks?.onTextChunk) callbacks.onTextChunk("I've completed the actions you asked for.");
            if (callbacks?.onComplete) {
                callbacks.onComplete({
                    text: "I've completed the actions you asked for.",
                    action: 'response'
                });
            }

        } catch (error) {
            console.error('[VoiceAgent] Streaming error:', error);
            if (callbacks?.onError) {
                callbacks.onError(error as Error);
            }
            if (callbacks?.onTextChunk) {
                callbacks.onTextChunk("Sorry, I couldn't process that. Can you try again?");
            }
            if (callbacks?.onComplete) {
                callbacks.onComplete({
                    text: "Sorry, I couldn't process that. Can you try again?",
                    action: 'error'
                });
            }
        }
    }

    /**
     * Execute a tool call against the Claudia backend
     */
    private async executeTool(name: string, input: Record<string, unknown>, workspaceId?: string): Promise<string> {
        try {
            switch (name) {
                case 'list_tasks':
                    return await this.toolListTasks(workspaceId);
                case 'create_task':
                    return await this.toolCreateTask(input.prompt as string, workspaceId, input.displayName as string | undefined);
                case 'get_task_status':
                    return await this.toolGetTaskStatus(input.taskId as string);
                case 'get_task_output':
                    return await this.toolGetTaskOutput(input.taskId as string);
                case 'stop_task':
                    return await this.toolStopTask(input.taskId as string);
                case 'stop_all_tasks':
                    return await this.toolStopAllTasks(workspaceId);
                case 'send_input':
                    return await this.toolSendInput(input.taskId as string, input.input as string);
                case 'continue_task':
                    return await this.toolContinueTask(input.taskId as string, input.prompt as string);
                case 'start_autonomous':
                    return await this.toolStartAutonomous(input.goal as string, input.workspacePath as string, input.maxIterations as number | undefined);
                case 'stop_autonomous':
                    return await this.toolStopAutonomous();
                case 'pause_autonomous':
                    return await this.toolPauseAutonomous();
                case 'get_autonomous_status':
                    return await this.toolGetAutonomousStatus();
                case 'adjust_autonomous_goal':
                    return await this.toolAdjustAutonomousGoal(input.adjustment as string);
                default:
                    return JSON.stringify({ error: `Unknown tool: ${name}` });
            }
        } catch (error) {
            return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
        }
    }

    private async toolListTasks(workspaceId?: string): Promise<string> {
        const response = await fetch(`${BACKEND_URL}/api/tasks`);
        if (!response.ok) return JSON.stringify({ error: `Failed to list tasks (HTTP ${response.status})` });
        let tasks = await response.json();
        if (workspaceId) {
            tasks = tasks.filter((t: any) => t.workspaceId === workspaceId);
        }
        if (!tasks || tasks.length === 0) {
            return JSON.stringify({ message: 'No active tasks in this workspace.' });
        }
        const now = Date.now();
        const formatted = tasks.map((t: any) => ({
            id: t.id,
            state: t.state,
            prompt: t.displayName || (t.prompt?.substring(0, 100) + (t.prompt?.length > 100 ? '...' : '')),
            runningFor: (t.state === 'busy' && t.processStartedAt) ? this.formatDuration(now - new Date(t.processStartedAt).getTime()) : null,
            waitingInputType: t.waitingInputType || null,
        }));
        return JSON.stringify(formatted);
    }

    private async toolCreateTask(prompt: string, workspaceId?: string, displayName?: string): Promise<string> {
        if (!workspaceId) {
            return JSON.stringify({ error: 'No workspace ID available. Cannot create task.' });
        }
        const result = await this.sendWSMessage('task:create', {
            prompt,
            workspaceId,
            source: 'voice',
        });
        const task = (result as any)?.task;
        if (task && displayName) {
            try {
                await this.sendWSMessage('task:rename', { taskId: task.id, displayName, source: 'agent' });
            } catch (e) {
                // rename is best-effort
            }
        }
        if (task) {
            return JSON.stringify({
                success: true,
                taskId: task.id,
                displayName: displayName || null,
                state: task.state,
                message: `Task '${task.id}'${displayName ? ` (${displayName})` : ''} created successfully.`
            });
        }
        return JSON.stringify({ success: true, message: 'Task creation request sent.', result });
    }

    private async toolGetTaskStatus(taskId: string): Promise<string> {
        const [tasksResponse, outputResponse] = await Promise.all([
            fetch(`${BACKEND_URL}/api/tasks`),
            fetch(`${BACKEND_URL}/api/tasks/${taskId}/output?maxBytes=2048`),
        ]);
        if (!tasksResponse.ok) return JSON.stringify({ error: `Failed to fetch tasks (HTTP ${tasksResponse.status})` });
        const tasks = await tasksResponse.json();
        const task = tasks.find((t: any) => t.id === taskId);
        if (!task) return JSON.stringify({ error: `Task '${taskId}' not found.` });

        const now = Date.now();
        const isRunning = task.state === 'busy' || task.state === 'starting';
        const startTime = task.processStartedAt || task.createdAt;
        const runningForMs = isRunning && startTime ? now - new Date(startTime).getTime() : null;

        let outputSnippet: string | null = null;
        if (outputResponse.ok) {
            const outputData = await outputResponse.json();
            if (outputData.output) {
                outputSnippet = outputData.output.length > 500 ? '...' + outputData.output.slice(-500) : outputData.output;
            }
        }

        return JSON.stringify({
            id: task.id,
            state: task.state,
            prompt: task.displayName || (task.prompt?.substring(0, 200)),
            runningFor: runningForMs ? this.formatDuration(runningForMs) : null,
            waitingInputType: task.waitingInputType || null,
            recentOutput: outputSnippet,
        });
    }

    private async toolGetTaskOutput(taskId: string): Promise<string> {
        const response = await fetch(`${BACKEND_URL}/api/tasks/${taskId}/output?maxBytes=8192`);
        if (!response.ok) {
            if (response.status === 404) return JSON.stringify({ error: `Task '${taskId}' not found.` });
            return JSON.stringify({ error: `Failed to get task output (HTTP ${response.status})` });
        }
        const data = await response.json();
        return JSON.stringify({
            taskId: data.taskId,
            state: data.state,
            output: data.output
        });
    }

    private async toolStopTask(taskId: string): Promise<string> {
        const result = await this.sendWSMessage('task:stop', { taskId }) as { taskId: string; stopped: boolean };
        if (result.stopped) {
            return JSON.stringify({ success: true, message: `Task '${taskId}' stopped successfully.` });
        }
        return JSON.stringify({ success: false, message: `Task '${taskId}' could not be stopped — it may not be running.` });
    }

    private async toolStopAllTasks(workspaceId?: string): Promise<string> {
        if (!workspaceId) {
            return JSON.stringify({ error: 'No workspace ID available.' });
        }
        const result = await this.sendWSMessage('task:stopAll', { workspaceId }) as {
            stoppedCount: number;
            stoppedIds: string[];
        };
        return JSON.stringify({
            success: true,
            stoppedCount: result.stoppedCount,
            stoppedIds: result.stoppedIds,
            message: result.stoppedCount > 0
                ? `Stopped ${result.stoppedCount} task(s).`
                : 'No running tasks found.'
        });
    }

    private async toolSendInput(taskId: string, input: string): Promise<string> {
        await this.sendWSMessage('task:input', { taskId, input: input + '\r' });
        return JSON.stringify({ success: true, message: `Input sent to task '${taskId}'.` });
    }

    private async toolContinueTask(taskId: string, prompt: string): Promise<string> {
        // Verify task exists and is not busy
        const tasksResponse = await fetch(`${BACKEND_URL}/api/tasks`);
        if (tasksResponse.ok) {
            const tasks = await tasksResponse.json();
            const task = tasks.find((t: any) => t.id === taskId);
            if (!task) return JSON.stringify({ error: `Task '${taskId}' not found.` });
            if (task.state === 'busy' || task.state === 'starting') {
                return JSON.stringify({ error: `Task '${taskId}' is currently ${task.state}. Wait for it to finish first.` });
            }
        }
        await this.sendWSMessage('task:input', { taskId, input: prompt + '\r' });
        return JSON.stringify({ success: true, message: `Follow-up prompt sent to task '${taskId}'.` });
    }

    // ===== AUTONOMOUS MODE TOOLS =====

    private async toolStartAutonomous(goal: string, workspacePath: string, maxIterations?: number): Promise<string> {
        try {
            const sessionId = await this.autonomousController.start(goal, workspacePath, maxIterations);
            return JSON.stringify({
                success: true,
                sessionId,
                message: `Autonomous mode started. Goal: "${goal}". Planning in progress...`
            });
        } catch (err) {
            return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
        }
    }

    async startAutonomousFromUI(goal: string, workspaceId?: string): Promise<void> {
        const workspacePath = workspaceId || this.workspaceStore.getWorkspaces()[0]?.id;
        if (!workspacePath) {
            this.emit('voice:response', { text: 'No workspace available. Please select a workspace first.' });
            return;
        }
        try {
            await this.autonomousController.start(goal, workspacePath);
        } catch (err) {
            this.emit('voice:response', { text: `Failed to start autonomous mode: ${err instanceof Error ? err.message : String(err)}` });
        }
    }

    private async toolStopAutonomous(): Promise<string> {
        try {
            await this.autonomousController.stop();
            return JSON.stringify({ success: true, message: 'Autonomous mode stopped.' });
        } catch (err) {
            return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
        }
    }

    private async toolPauseAutonomous(): Promise<string> {
        try {
            if (this.autonomousController.isActive()) {
                const status = this.autonomousController.getStatus();
                if (status?.state === 'paused') {
                    await this.autonomousController.resume();
                    return JSON.stringify({ success: true, message: 'Autonomous mode resumed.' });
                } else {
                    await this.autonomousController.pause();
                    return JSON.stringify({ success: true, message: 'Autonomous mode paused.' });
                }
            }
            return JSON.stringify({ error: 'No active autonomous session.' });
        } catch (err) {
            return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
        }
    }

    private async toolGetAutonomousStatus(): Promise<string> {
        const status = this.autonomousController.getStatus();
        if (!status) {
            return JSON.stringify({ message: 'No autonomous session active.' });
        }
        return JSON.stringify(status);
    }

    private async toolAdjustAutonomousGoal(adjustment: string): Promise<string> {
        try {
            await this.autonomousController.adjustGoal(adjustment);
            return JSON.stringify({ success: true, message: `Goal adjusted: "${adjustment}". Plan is being revised.` });
        } catch (err) {
            return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
        }
    }

    /**
     * Send a WebSocket message to the backend and wait for a response
     */
    private async sendWSMessage(type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
        const WebSocket = (await import('ws')).default;

        return new Promise((resolve, reject) => {
            const wsUrl = BACKEND_URL.replace('http://', 'ws://').replace('https://', 'wss://');
            const ws = new WebSocket(wsUrl);
            const timeout = setTimeout(() => {
                ws.close();
                reject(new Error(`WebSocket operation timed out after 30s for ${type}`));
            }, 30000);

            ws.on('open', () => {
                ws.send(JSON.stringify({ type, payload }));
            });

            ws.on('message', (data: Buffer) => {
                try {
                    const msg = JSON.parse(data.toString());

                    if (type === 'task:create' && msg.type === 'task:created' && msg.payload?.source === 'voice') {
                        clearTimeout(timeout);
                        ws.close();
                        resolve(msg.payload);
                    }
                    if (type === 'task:input' && msg.type === 'task:stateChanged') {
                        clearTimeout(timeout);
                        ws.close();
                        resolve(msg.payload);
                    }
                    if (type === 'task:stop' && msg.type === 'task:stopped') {
                        clearTimeout(timeout);
                        ws.close();
                        resolve(msg.payload);
                    }
                    if (type === 'task:stopAll' && msg.type === 'task:stopAll:result') {
                        clearTimeout(timeout);
                        ws.close();
                        resolve(msg.payload);
                    }
                    if (type === 'task:rename' && (msg.type === 'task:stateChanged' || msg.type === 'tasks:updated')) {
                        clearTimeout(timeout);
                        ws.close();
                        resolve(msg.payload);
                    }
                    if (msg.type === 'error') {
                        clearTimeout(timeout);
                        ws.close();
                        reject(new Error(msg.payload?.message || 'Unknown WebSocket error'));
                    }
                } catch (e) {
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

    private formatDuration(ms: number): string {
        const seconds = Math.floor(ms / 1000);
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
        const hours = Math.floor(minutes / 60);
        return `${hours}h ${minutes % 60}m`;
    }

    /**
     * Process voice input and return voice-optimized response (non-streaming fallback)
     */
    async processVoiceMessage(
        transcript: string,
        workspaceId?: string,
        userId?: string
    ): Promise<VoiceResponse> {
        console.log('[VoiceAgent] Processing:', transcript);

        // Check for interrupt commands first
        if (this.isInterruptCommand(transcript)) {
            return await this.handleInterrupt(transcript);
        }

        // Check for simple status queries that don't need LLM
        const simpleResponse = this.trySimpleResponse(transcript, workspaceId);
        if (simpleResponse) {
            return simpleResponse;
        }

        // Build dynamic context with task status
        const taskContext = this.buildTaskContext(workspaceId);

        // Send message with task context as system prompt enhancement
        const message = await this.supervisorChat.sendMessageWithContext(
            transcript,
            taskContext,
            undefined,
            workspaceId
        );

        if (!message) {
            return {
                text: "Sorry, I couldn't process that. Can you try again?",
                action: 'error'
            };
        }

        // Strip markdown and optimize for voice
        const voiceText = this.optimizeForVoice(message.content);

        return {
            text: voiceText,
            action: 'response',
            taskId: message.taskId
        };
    }

    /**
     * Build context string about current tasks for system prompt
     */
    private buildTaskContext(workspaceId?: string): string {
        let tasks = this.taskSpawner.getAllTasks();

        // Filter by workspace if specified
        if (workspaceId) {
            tasks = tasks.filter(t => t.workspaceId === workspaceId);
        }

        if (tasks.length === 0) {
            return '';
        }

        const busyTasks = tasks.filter(t => t.state === 'busy');
        const idleTasks = tasks.filter(t => t.state === 'idle');
        const exitedTasks = tasks.filter(t => t.state === 'exited');

        const parts: string[] = [];

        if (busyTasks.length > 0) {
            parts.push(`Running tasks (${busyTasks.length}):`);
            busyTasks.forEach(t => {
                const shortPrompt = t.prompt.substring(0, 50) + (t.prompt.length > 50 ? '...' : '');
                parts.push(`- Task ${t.id}: "${shortPrompt}"`);
            });
        }

        if (idleTasks.length > 0) {
            parts.push(`\nTasks waiting for input (${idleTasks.length}):`);
            idleTasks.forEach(t => {
                const shortPrompt = t.prompt.substring(0, 50) + (t.prompt.length > 50 ? '...' : '');
                parts.push(`- Task ${t.id}: "${shortPrompt}"`);
            });
        }

        if (exitedTasks.length > 0) {
            parts.push(`\nCompleted tasks (${exitedTasks.length}):`);
            exitedTasks.forEach(t => {
                const shortPrompt = t.prompt.substring(0, 50) + (t.prompt.length > 50 ? '...' : '');
                parts.push(`- Task ${t.id}: "${shortPrompt}"`);
            });
        }

        return parts.length > 0 ? parts.join('\n') : '';
    }

    /**
     * Try to handle simple queries without spawning a Claude process
     */
    private trySimpleResponse(transcript: string, workspaceId?: string): VoiceResponse | null {
        const lower = transcript.toLowerCase().trim();

        // Greetings
        if (lower.match(/^(hi|hello|hey|good morning|good afternoon)$/)) {
            return {
                text: "Hey! What can I help you with?",
                action: 'response'
            };
        }

        // Help queries
        if (lower.match(/help|what can you do/)) {
            return {
                text: "I can create tasks, check status, stop them, and send input. What do you need?",
                action: 'response'
            };
        }

        return null;
    }

    /**
     * Check if transcript is an interrupt command
     */
    private isInterruptCommand(text: string): boolean {
        const interrupts = ['stop', 'cancel', 'pause', 'halt', 'abort', 'never mind', 'stop that'];
        const lower = text.toLowerCase().trim();
        return interrupts.some(cmd => lower.includes(cmd));
    }

    /**
     * Handle interrupt commands
     */
    private async handleInterrupt(text: string): Promise<VoiceResponse> {
        const tasks = this.taskSpawner.getAllTasks();
        const runningTasks = tasks.filter(t => t.state === 'busy');

        if (runningTasks.length === 0) {
            return {
                text: "Nothing's running right now.",
                action: 'none'
            };
        }

        // Stop all running tasks
        for (const task of runningTasks) {
            this.taskSpawner.destroyTask(task.id);
        }

        return {
            text: `Stopped ${runningTasks.length} task${runningTasks.length > 1 ? 's' : ''}.`,
            action: 'stopped'
        };
    }

    /**
     * Strip markdown and optimize text for TTS
     */
    private optimizeForVoice(text: string): string {
        let cleaned = text
            .replace(/^#{1,6}\s+/gm, '')
            .replace(/\*\*(.+?)\*\*/g, '$1')
            .replace(/\*(.+?)\*/g, '$1')
            .replace(/__(.+?)__/g, '$1')
            .replace(/_(.+?)_/g, '$1')
            .replace(/```[\s\S]*?```/g, '')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/^\s*[-*+]\s+/gm, '')
            .replace(/^\s*\d+\.\s+/gm, '')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        return cleaned;
    }

    /**
     * Get the current system prompt
     */
    getSystemPrompt(): string {
        return this.customSystemPrompt;
    }

    /**
     * Set a custom system prompt
     */
    setSystemPrompt(prompt: string): void {
        this.customSystemPrompt = prompt;
        console.log('[VoiceAgent] System prompt updated');
    }

    /**
     * Get available tools (from SupervisorChat)
     */
    getAvailableTools(): Array<{ name: string; description: string }> {
        return VOICE_TOOLS.map(t => ({ name: t.name, description: t.description || '' }));
    }

    // ===== PROACTIVE TASK UPDATES =====

    /**
     * Register a workspace as having an active voice client.
     * Starts proactive updates if tasks are running.
     */
    addVoiceWorkspace(workspaceId: string): void {
        this.activeVoiceWorkspaces.add(workspaceId || '__all__');
        console.log('[VoiceAgent] Voice workspace added:', workspaceId || '__all__');
        this.maybeStartProactiveUpdates();
    }

    /**
     * Remove a workspace from active voice tracking.
     * Stops updates if no voice clients remain.
     */
    removeVoiceWorkspace(workspaceId: string): void {
        this.activeVoiceWorkspaces.delete(workspaceId || '__all__');
        console.log('[VoiceAgent] Voice workspace removed:', workspaceId || '__all__');
        if (this.activeVoiceWorkspaces.size === 0) {
            this.stopProactiveUpdates();
        }
    }

    /**
     * Notify the voice agent that a task state changed.
     * Used to start/stop proactive update polling.
     */
    onTaskStateChanged(task: Task): void {
        if (task.state === 'busy') {
            this.maybeStartProactiveUpdates();
        } else {
            const allTasks = this.taskSpawner.getAllTasks();
            const hasBusy = allTasks.some(t => t.state === 'busy');
            if (!hasBusy) {
                this.stopProactiveUpdates();
                this.lastTaskOutputSnapshots.clear();
            }
        }
    }

    /**
     * Enable or disable proactive updates
     */
    setProactiveEnabled(enabled: boolean): void {
        this.proactiveEnabled = enabled;
        console.log('[VoiceAgent] Proactive updates:', enabled ? 'enabled' : 'disabled');
        if (!enabled) {
            this.stopProactiveUpdates();
        } else {
            this.maybeStartProactiveUpdates();
        }
    }

    private maybeStartProactiveUpdates(): void {
        if (this.proactiveInterval) return;
        if (!this.proactiveEnabled) return;
        if (this.activeVoiceWorkspaces.size === 0) return;
        if (!this.anthropic) return;

        const allTasks = this.taskSpawner.getAllTasks();
        const hasBusy = allTasks.some(t => t.state === 'busy');
        if (!hasBusy) return;

        console.log('[VoiceAgent] Starting proactive update interval (60s)');
        this.proactiveInterval = setInterval(() => this.generateProactiveUpdate(), this.proactiveIntervalMs);
    }

    private stopProactiveUpdates(): void {
        if (this.proactiveInterval) {
            clearInterval(this.proactiveInterval);
            this.proactiveInterval = null;
            console.log('[VoiceAgent] Stopped proactive updates');
        }
    }

    private async generateProactiveUpdate(): Promise<void> {
        if (!this.anthropic) return;
        if (this.autonomousController.isActive()) return;

        const allTasks = this.taskSpawner.getAllTasks();
        const busyTasks = allTasks.filter(t => t.state === 'busy');

        if (busyTasks.length === 0) {
            this.stopProactiveUpdates();
            return;
        }

        // Fetch recent output for each busy task and check for changes
        const taskSummaries: Array<{ id: string; name: string; output: string }> = [];

        for (const task of busyTasks) {
            try {
                const response = await fetch(`${BACKEND_URL}/api/tasks/${task.id}/output?maxBytes=2048`);
                if (!response.ok) continue;
                const data = await response.json();
                const output = (data.output || '') as string;

                const lastSnapshot = this.lastTaskOutputSnapshots.get(task.id) || '';
                if (output === lastSnapshot) continue;

                // Get only the new portion of output
                const newOutput = output.startsWith(lastSnapshot)
                    ? output.slice(lastSnapshot.length)
                    : output.slice(-2000);

                this.lastTaskOutputSnapshots.set(task.id, output);

                if (newOutput.trim()) {
                    taskSummaries.push({
                        id: task.id,
                        name: task.displayName || task.prompt?.substring(0, 50) || task.id,
                        output: newOutput.slice(-2000)
                    });
                }
            } catch (err) {
                console.error('[VoiceAgent] Error fetching task output for proactive update:', err);
            }
        }

        if (taskSummaries.length === 0) return;

        // Generate LLM summary
        try {
            const taskDescriptions = taskSummaries.map(t =>
                `Task "${t.name}" (${t.id}):\n${t.output}`
            ).join('\n\n---\n\n');

            const response = await this.anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 150,
                system: `You generate ultra-brief voice status updates about coding tasks. One or two short sentences max. Be specific about what's happening (e.g. "running tests", "installing packages", "writing a component"). No markdown. Conversational tone. If multiple tasks, briefly mention each.`,
                messages: [{
                    role: 'user',
                    content: `Here is the recent terminal output from ${taskSummaries.length} running task(s). Summarize what they're currently doing in 1-2 sentences for a voice update:\n\n${taskDescriptions}`
                }]
            });

            const textBlock = response.content.find(b => b.type === 'text');
            const summary = textBlock ? this.optimizeForVoice(textBlock.text) : null;

            if (summary) {
                console.log('[VoiceAgent] Proactive update:', summary);
                this.emit('voice:proactive_update', { text: summary });
            }
        } catch (err) {
            console.error('[VoiceAgent] Error generating proactive update:', err);
        }
    }
}

export interface VoiceResponse {
    text: string;
    action: 'response' | 'error' | 'stopped' | 'none';
    taskId?: string;
    workspaceId?: string;
}
