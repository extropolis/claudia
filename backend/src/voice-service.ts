/**
 * VoiceService - OpenAI Realtime API integration for voice assistant
 *
 * Provides bidirectional voice communication using OpenAI's Realtime API.
 * Features:
 * - Real-time speech-to-text and text-to-speech
 * - Voice commands for task management
 * - Task completion announcements
 * - Conversational context with task awareness
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { createLogger } from './logger.js';

const logger = createLogger('[VoiceService]');

// OpenAI Realtime API configuration
const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';

// Voice service configuration
export interface VoiceServiceConfig {
    apiKey: string;
    voice?: 'alloy' | 'echo' | 'shimmer' | 'ash' | 'ballad' | 'coral' | 'sage' | 'verse';
    systemInstructions?: string;
    turnDetection?: 'server_vad' | 'none';
}

// Events emitted by the voice service
export interface VoiceServiceEvents {
    'connected': () => void;
    'disconnected': (reason: string) => void;
    'error': (error: Error) => void;
    'transcript': (text: string, isFinal: boolean) => void;
    'response': (text: string, audioBase64?: string) => void;
    'audio': (audioBase64: string) => void;
    'speechStarted': () => void;
    'speechEnded': () => void;
    'command': (command: VoiceCommand) => void;
}

// Voice command types
export interface VoiceCommand {
    type: 'create_task' | 'list_tasks' | 'task_status' | 'get_task_status' | 'stop_task' | 'general_question';
    parameters: {
        prompt?: string;
        taskId?: string;
        workspaceId?: string;
        question?: string;
    };
}

// OpenAI Realtime API event types
interface RealtimeEvent {
    type: string;
    event_id?: string;
    [key: string]: unknown;
}

interface SessionUpdateEvent extends RealtimeEvent {
    type: 'session.update';
    session: {
        instructions?: string;
        voice?: string;
        turn_detection?: { type: string } | null;
        input_audio_transcription?: { model: string };
        tools?: Array<{
            type: 'function';
            name: string;
            description: string;
            parameters: Record<string, unknown>;
        }>;
    };
}

interface ConversationItemCreateEvent extends RealtimeEvent {
    type: 'conversation.item.create';
    item: {
        type: 'message' | 'function_call' | 'function_call_output';
        role?: 'user' | 'assistant' | 'system';
        content?: Array<{
            type: 'input_text' | 'input_audio' | 'text' | 'audio';
            text?: string;
            audio?: string;
        }>;
        call_id?: string;
        output?: string;
    };
}

/**
 * VoiceService - Manages OpenAI Realtime API connection for voice interactions
 */
export class VoiceService extends EventEmitter {
    private ws: WebSocket | null = null;
    private config: VoiceServiceConfig;
    private isConnected: boolean = false;
    private reconnectAttempts: number = 0;
    private maxReconnectAttempts: number = 3;
    private currentResponseId: string | null = null;
    private pendingFunctionCalls: Map<string, { name: string; arguments: string }> = new Map();

    // Task context for the voice assistant
    private taskContext: {
        activeTasks: Array<{ id: string; prompt: string; state: string; workspaceId: string }>;
        lastAnnouncedTaskId: string | null;
        currentWorkspaceId: string | null;
    } = {
        activeTasks: [],
        lastAnnouncedTaskId: null,
        currentWorkspaceId: null
    };

    constructor(config: VoiceServiceConfig) {
        super();
        this.config = {
            voice: 'alloy',
            turnDetection: 'server_vad',
            ...config
        };
    }

    /**
     * Connect to OpenAI Realtime API
     */
    async connect(): Promise<void> {
        if (this.isConnected) {
            logger.warn('Already connected to OpenAI Realtime API');
            return;
        }

        return new Promise((resolve, reject) => {
            try {
                logger.info('Connecting to OpenAI Realtime API...');

                this.ws = new WebSocket(OPENAI_REALTIME_URL, {
                    headers: {
                        'Authorization': `Bearer ${this.config.apiKey}`,
                        'OpenAI-Beta': 'realtime=v1'
                    }
                });

                this.ws.on('open', () => {
                    logger.info('Connected to OpenAI Realtime API');
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    this.configureSession();
                    this.emit('connected');
                    resolve();
                });

                this.ws.on('message', (data: Buffer) => {
                    this.handleMessage(data);
                });

                this.ws.on('close', (code: number, reason: Buffer) => {
                    const reasonStr = reason.toString() || 'unknown';
                    logger.info(`Disconnected from OpenAI Realtime API: ${code} - ${reasonStr}`);
                    this.isConnected = false;
                    this.emit('disconnected', reasonStr);
                });

                this.ws.on('error', (error: Error) => {
                    logger.error('OpenAI Realtime API error', { error: error.message });
                    this.emit('error', error);
                    if (!this.isConnected) {
                        reject(error);
                    }
                });

            } catch (error) {
                logger.error('Failed to connect to OpenAI Realtime API', { error });
                reject(error);
            }
        });
    }

    /**
     * Disconnect from OpenAI Realtime API
     */
    disconnect(): void {
        if (this.ws) {
            this.ws.close(1000, 'Client disconnect');
            this.ws = null;
        }
        this.isConnected = false;
    }

    /**
     * Configure the session with instructions and tools
     */
    private configureSession(): void {
        const systemInstructions = this.buildSystemInstructions();

        const sessionUpdate: SessionUpdateEvent = {
            type: 'session.update',
            session: {
                instructions: systemInstructions,
                voice: this.config.voice,
                turn_detection: this.config.turnDetection === 'none'
                    ? null
                    : { type: 'server_vad' },
                input_audio_transcription: { model: 'whisper-1' },
                tools: this.getToolDefinitions()
            }
        };

        this.sendEvent(sessionUpdate);
        logger.info('Session configured with voice assistant instructions');
    }

    /**
     * Build system instructions for the voice assistant
     */
    private buildSystemInstructions(): string {
        const baseInstructions = this.config.systemInstructions || '';

        return `You are Claudia, a helpful voice assistant for a coding task management system. You help developers manage their AI coding tasks.

${baseInstructions}

Your capabilities:
1. Create new coding tasks - when users describe what they want to build or fix
2. Check task status - report on running, completed, or waiting tasks
3. List active tasks - show what tasks are currently running
4. Stop/interrupt tasks - cancel running tasks if requested
5. Answer questions about the system and tasks

Current context:
- Active tasks: ${this.taskContext.activeTasks.length}
${this.taskContext.activeTasks.map(t => `  - Task ${t.id.slice(-6)}: "${t.prompt.slice(0, 50)}..." (${t.state})`).join('\n')}
${this.taskContext.currentWorkspaceId ? `- Current workspace: ${this.taskContext.currentWorkspaceId}` : ''}

Guidelines:
- Be concise and friendly in responses
- When announcing task completions, give a brief summary
- Use natural conversational language
- If you need clarification, ask
- For task creation, extract the intent and workspace if mentioned
- Confirm actions before executing them when appropriate

When creating tasks:
- Extract the coding intent from the user's request
- If no workspace is specified, use the current workspace
- Confirm the task description before creating`;
    }

    /**
     * Get tool definitions for function calling
     */
    private getToolDefinitions(): Array<{
        type: 'function';
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    }> {
        return [
            {
                type: 'function',
                name: 'create_task',
                description: 'Create a new coding task for the AI assistant to work on',
                parameters: {
                    type: 'object',
                    properties: {
                        prompt: {
                            type: 'string',
                            description: 'The task description or coding request'
                        },
                        workspaceId: {
                            type: 'string',
                            description: 'Optional workspace/project path. If not provided, uses the current workspace.'
                        }
                    },
                    required: ['prompt']
                }
            },
            {
                type: 'function',
                name: 'list_tasks',
                description: 'List all active coding tasks and their status',
                parameters: {
                    type: 'object',
                    properties: {
                        workspaceId: {
                            type: 'string',
                            description: 'Optional workspace to filter tasks by'
                        }
                    }
                }
            },
            {
                type: 'function',
                name: 'get_task_status',
                description: 'Get detailed status of a specific task',
                parameters: {
                    type: 'object',
                    properties: {
                        taskId: {
                            type: 'string',
                            description: 'The task ID (can be partial, last 6 characters)'
                        }
                    },
                    required: ['taskId']
                }
            },
            {
                type: 'function',
                name: 'stop_task',
                description: 'Stop/interrupt a running task',
                parameters: {
                    type: 'object',
                    properties: {
                        taskId: {
                            type: 'string',
                            description: 'The task ID to stop'
                        }
                    },
                    required: ['taskId']
                }
            }
        ];
    }

    /**
     * Send an event to the OpenAI Realtime API
     */
    private sendEvent(event: RealtimeEvent): void {
        if (!this.ws || !this.isConnected) {
            logger.warn('Cannot send event: not connected');
            return;
        }

        try {
            this.ws.send(JSON.stringify(event));
        } catch (error) {
            logger.error('Failed to send event', { error, eventType: event.type });
        }
    }

    /**
     * Handle incoming messages from OpenAI Realtime API
     */
    private handleMessage(data: Buffer): void {
        try {
            const event = JSON.parse(data.toString()) as RealtimeEvent;

            switch (event.type) {
                case 'session.created':
                case 'session.updated':
                    logger.debug('Session event', { type: event.type });
                    break;

                case 'input_audio_buffer.speech_started':
                    this.emit('speechStarted');
                    break;

                case 'input_audio_buffer.speech_stopped':
                    this.emit('speechEnded');
                    break;

                case 'conversation.item.input_audio_transcription.completed':
                    this.handleTranscription(event);
                    break;

                case 'response.created':
                    this.currentResponseId = (event as { response?: { id?: string } }).response?.id || null;
                    break;

                case 'response.output_item.added':
                    // New output item in response
                    break;

                case 'response.audio_transcript.delta':
                    this.handleTranscriptDelta(event);
                    break;

                case 'response.audio_transcript.done':
                    this.handleTranscriptDone(event);
                    break;

                case 'response.audio.delta':
                    this.handleAudioDelta(event);
                    break;

                case 'response.audio.done':
                    // Audio output complete
                    break;

                case 'response.function_call_arguments.delta':
                    this.handleFunctionCallDelta(event);
                    break;

                case 'response.function_call_arguments.done':
                    this.handleFunctionCallDone(event);
                    break;

                case 'response.done':
                    this.handleResponseDone(event);
                    break;

                case 'error':
                    this.handleError(event);
                    break;

                default:
                    // logger.debug('Unhandled event type', { type: event.type });
                    break;
            }
        } catch (error) {
            logger.error('Failed to parse message', { error });
        }
    }

    /**
     * Handle user speech transcription
     */
    private handleTranscription(event: RealtimeEvent): void {
        const transcript = (event as { transcript?: string }).transcript;
        if (transcript) {
            logger.info('User said:', { transcript });
            this.emit('transcript', transcript, true);
        }
    }

    /**
     * Handle assistant response transcript delta
     */
    private handleTranscriptDelta(event: RealtimeEvent): void {
        const delta = (event as { delta?: string }).delta;
        if (delta) {
            this.emit('transcript', delta, false);
        }
    }

    /**
     * Handle completed transcript
     */
    private handleTranscriptDone(event: RealtimeEvent): void {
        const transcript = (event as { transcript?: string }).transcript;
        if (transcript) {
            this.emit('response', transcript);
        }
    }

    /**
     * Handle audio output delta
     */
    private handleAudioDelta(event: RealtimeEvent): void {
        const delta = (event as { delta?: string }).delta;
        if (delta) {
            this.emit('audio', delta);
        }
    }

    /**
     * Handle function call arguments delta
     */
    private handleFunctionCallDelta(event: RealtimeEvent): void {
        const callId = (event as { call_id?: string }).call_id;
        const delta = (event as { delta?: string }).delta;

        if (callId && delta) {
            const existing = this.pendingFunctionCalls.get(callId);
            if (existing) {
                existing.arguments += delta;
            }
        }
    }

    /**
     * Handle completed function call
     */
    private handleFunctionCallDone(event: RealtimeEvent): void {
        const callId = (event as { call_id?: string }).call_id;
        const name = (event as { name?: string }).name;
        const args = (event as { arguments?: string }).arguments;

        if (callId && name) {
            this.pendingFunctionCalls.set(callId, { name, arguments: args || '{}' });
            logger.info('Function call received', { callId, name, arguments: args });
        }
    }

    /**
     * Handle response completion - execute any pending function calls
     */
    private handleResponseDone(event: RealtimeEvent): void {
        // Process any pending function calls
        for (const [callId, { name, arguments: args }] of this.pendingFunctionCalls) {
            this.executeFunctionCall(callId, name, args);
        }
        this.pendingFunctionCalls.clear();
        this.currentResponseId = null;
    }

    /**
     * Execute a function call and send the result back
     */
    private executeFunctionCall(callId: string, name: string, argsJson: string): void {
        try {
            const args = JSON.parse(argsJson);
            logger.info('Executing function call', { callId, name, args });

            // Emit command event for the server to handle
            const command: VoiceCommand = {
                type: name as VoiceCommand['type'],
                parameters: {
                    prompt: args.prompt,
                    taskId: args.taskId,
                    workspaceId: args.workspaceId || this.taskContext.currentWorkspaceId,
                    question: args.question
                }
            };

            this.emit('command', command);

            // The response will be sent via sendFunctionResult when the command is processed

        } catch (error) {
            logger.error('Failed to execute function call', { error, callId, name });
            this.sendFunctionResult(callId, { error: 'Failed to execute command' });
        }
    }

    /**
     * Send function call result back to the API
     */
    sendFunctionResult(callId: string, result: Record<string, unknown>): void {
        const event: ConversationItemCreateEvent = {
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify(result)
            }
        };

        this.sendEvent(event);

        // Request a response after sending the function result
        this.sendEvent({ type: 'response.create' });
    }

    /**
     * Handle API errors
     */
    private handleError(event: RealtimeEvent): void {
        const error = (event as { error?: { message?: string; code?: string } }).error;
        logger.error('OpenAI Realtime API error', { error });
        this.emit('error', new Error(error?.message || 'Unknown API error'));
    }

    /**
     * Send audio input to the API
     * @param audioBase64 - Base64-encoded PCM16 audio at 24kHz
     */
    sendAudio(audioBase64: string): void {
        this.sendEvent({
            type: 'input_audio_buffer.append',
            audio: audioBase64
        });
    }

    /**
     * Commit the audio buffer and request a response
     */
    commitAudio(): void {
        this.sendEvent({ type: 'input_audio_buffer.commit' });
        this.sendEvent({ type: 'response.create' });
    }

    /**
     * Send a text message (for testing or text-based fallback)
     */
    sendTextMessage(text: string): void {
        const event: ConversationItemCreateEvent = {
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text }]
            }
        };

        this.sendEvent(event);
        this.sendEvent({ type: 'response.create' });
    }

    /**
     * Announce a task completion via voice
     */
    announceTaskCompletion(taskId: string, summary: string): void {
        if (!this.isConnected) {
            logger.warn('Cannot announce: not connected');
            return;
        }

        this.taskContext.lastAnnouncedTaskId = taskId;

        const announcement = `Task ${taskId.slice(-6)} has completed. ${summary}`;

        const event: ConversationItemCreateEvent = {
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'user',
                content: [{
                    type: 'input_text',
                    text: `[SYSTEM: Announce this task completion to the user in a friendly way] ${announcement}`
                }]
            }
        };

        this.sendEvent(event);
        this.sendEvent({ type: 'response.create' });
    }

    /**
     * Update task context for the voice assistant
     */
    updateTaskContext(tasks: Array<{ id: string; prompt: string; state: string; workspaceId: string }>): void {
        this.taskContext.activeTasks = tasks;
    }

    /**
     * Set the current workspace context
     */
    setCurrentWorkspace(workspaceId: string): void {
        this.taskContext.currentWorkspaceId = workspaceId;
    }

    /**
     * Check if the service is connected
     */
    get connected(): boolean {
        return this.isConnected;
    }
}

/**
 * Create a new VoiceService instance
 */
export function createVoiceService(apiKey: string, options?: Partial<VoiceServiceConfig>): VoiceService {
    return new VoiceService({
        apiKey,
        ...options
    });
}
