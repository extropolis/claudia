/**
 * VoiceWSHandler - WebSocket handler for voice communication
 *
 * Bridges frontend audio streams with the VoiceService (OpenAI Realtime API).
 * Handles:
 * - Audio streaming from browser microphone
 * - Audio playback data to browser
 * - Voice commands and task management
 * - Task completion announcements
 */

import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { EventEmitter } from 'events';
import { VoiceService, VoiceCommand, createVoiceService } from './voice-service.js';
import { createLogger } from './logger.js';

const logger = createLogger('[VoiceWSHandler]');

// Message types for voice WebSocket communication
export interface VoiceWSMessage {
    type: string;
    payload?: unknown;
}

// Incoming message types from frontend
type VoiceClientMessageType =
    | 'voice:connect'      // Connect to voice service
    | 'voice:disconnect'   // Disconnect from voice service
    | 'voice:audio'        // Send audio chunk
    | 'voice:commit'       // Commit audio buffer (end of speech)
    | 'voice:text'         // Send text message (fallback)
    | 'voice:setWorkspace' // Set current workspace context
    | 'voice:updateTasks'; // Update task context

// Outgoing message types to frontend
type VoiceServerMessageType =
    | 'voice:connected'    // Successfully connected
    | 'voice:disconnected' // Disconnected from service
    | 'voice:error'        // Error occurred
    | 'voice:transcript'   // Speech transcript (user or assistant)
    | 'voice:audio'        // Audio data to play
    | 'voice:response'     // Text response from assistant
    | 'voice:command'      // Command to execute (task creation, etc.)
    | 'voice:speechStart'  // User started speaking
    | 'voice:speechEnd'    // User stopped speaking
    | 'voice:status';      // Service status update

export interface VoiceClientCallbacks {
    onCreateTask: (prompt: string, workspaceId?: string) => Promise<{ taskId: string }>;
    onListTasks: (workspaceId?: string) => Array<{ id: string; prompt: string; state: string; workspaceId: string }>;
    onGetTaskStatus: (taskId: string) => { id: string; prompt: string; state: string; workspaceId: string } | null;
    onStopTask: (taskId: string) => boolean;
}

/**
 * VoiceWSHandler - Manages voice WebSocket connections
 */
export class VoiceWSHandler extends EventEmitter {
    private wss: WebSocketServer | null = null;
    private voiceService: VoiceService | null = null;
    private activeClient: WebSocket | null = null;
    private apiKey: string | null = null;
    private callbacks: VoiceClientCallbacks | null = null;
    private pendingFunctionCallId: string | null = null;

    constructor() {
        super();
    }

    /**
     * Initialize the voice WebSocket handler
     */
    initialize(wss: WebSocketServer, apiKey: string, callbacks: VoiceClientCallbacks): void {
        this.wss = wss;
        this.apiKey = apiKey;
        this.callbacks = callbacks;

        logger.info('VoiceWSHandler initialized');
    }

    /**
     * Handle a new voice WebSocket connection
     */
    handleConnection(ws: WebSocket, request: IncomingMessage): void {
        const url = new URL(request.url || '', `http://${request.headers.host}`);

        // Check if this is a voice connection
        if (url.pathname !== '/voice') {
            return;
        }

        logger.info('Voice client connected');

        // Only allow one active voice client at a time
        if (this.activeClient && this.activeClient.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'voice:error',
                payload: { message: 'Another voice session is already active' }
            }));
            ws.close(4000, 'Another session active');
            return;
        }

        this.activeClient = ws;

        ws.on('message', (data: Buffer) => {
            this.handleMessage(ws, data);
        });

        ws.on('close', () => {
            logger.info('Voice client disconnected');
            if (this.activeClient === ws) {
                this.activeClient = null;
                this.disconnectVoiceService();
            }
        });

        ws.on('error', (error: Error) => {
            logger.error('Voice WebSocket error', { error: error.message });
        });

        // Send initial status
        this.sendToClient({
            type: 'voice:status',
            payload: {
                connected: false,
                ready: !!this.apiKey
            }
        });
    }

    /**
     * Handle incoming WebSocket messages
     */
    private async handleMessage(ws: WebSocket, data: Buffer): Promise<void> {
        try {
            const message = JSON.parse(data.toString()) as VoiceWSMessage;

            switch (message.type as VoiceClientMessageType) {
                case 'voice:connect':
                    await this.handleConnect(ws);
                    break;

                case 'voice:disconnect':
                    this.handleDisconnect();
                    break;

                case 'voice:audio':
                    this.handleAudio(message.payload as { audio: string });
                    break;

                case 'voice:commit':
                    this.handleCommit();
                    break;

                case 'voice:text':
                    this.handleText(message.payload as { text: string });
                    break;

                case 'voice:setWorkspace':
                    this.handleSetWorkspace(message.payload as { workspaceId: string });
                    break;

                case 'voice:updateTasks':
                    this.handleUpdateTasks(message.payload as {
                        tasks: Array<{ id: string; prompt: string; state: string; workspaceId: string }>
                    });
                    break;

                default:
                    logger.warn('Unknown voice message type', { type: message.type });
            }
        } catch (error) {
            logger.error('Failed to handle voice message', { error });
            this.sendToClient({
                type: 'voice:error',
                payload: { message: 'Failed to process message' }
            });
        }
    }

    /**
     * Handle connect request - initialize VoiceService
     */
    private async handleConnect(ws: WebSocket): Promise<void> {
        if (!this.apiKey) {
            this.sendToClient({
                type: 'voice:error',
                payload: { message: 'OpenAI API key not configured' }
            });
            return;
        }

        try {
            // Create and connect voice service
            this.voiceService = createVoiceService(this.apiKey, {
                voice: 'alloy',
                turnDetection: 'server_vad'
            });

            // Set up event handlers
            this.setupVoiceServiceEvents();

            await this.voiceService.connect();

            this.sendToClient({
                type: 'voice:connected',
                payload: { message: 'Connected to voice service' }
            });

        } catch (error) {
            logger.error('Failed to connect voice service', { error });
            this.sendToClient({
                type: 'voice:error',
                payload: { message: 'Failed to connect to voice service' }
            });
        }
    }

    /**
     * Set up event handlers for VoiceService
     */
    private setupVoiceServiceEvents(): void {
        if (!this.voiceService) return;

        this.voiceService.on('connected', () => {
            logger.info('VoiceService connected');
        });

        this.voiceService.on('disconnected', (reason: string) => {
            logger.info('VoiceService disconnected', { reason });
            this.sendToClient({
                type: 'voice:disconnected',
                payload: { reason }
            });
        });

        this.voiceService.on('error', (error: Error) => {
            logger.error('VoiceService error', { error: error.message });
            this.sendToClient({
                type: 'voice:error',
                payload: { message: error.message }
            });
        });

        this.voiceService.on('transcript', (text: string, isFinal: boolean) => {
            this.sendToClient({
                type: 'voice:transcript',
                payload: { text, isFinal, role: isFinal ? 'user' : 'assistant' }
            });
        });

        this.voiceService.on('response', (text: string) => {
            this.sendToClient({
                type: 'voice:response',
                payload: { text }
            });
        });

        this.voiceService.on('audio', (audioBase64: string) => {
            this.sendToClient({
                type: 'voice:audio',
                payload: { audio: audioBase64 }
            });
        });

        this.voiceService.on('speechStarted', () => {
            this.sendToClient({
                type: 'voice:speechStart',
                payload: {}
            });
        });

        this.voiceService.on('speechEnded', () => {
            this.sendToClient({
                type: 'voice:speechEnd',
                payload: {}
            });
        });

        this.voiceService.on('command', async (command: VoiceCommand) => {
            await this.handleVoiceCommand(command);
        });
    }

    /**
     * Handle voice commands from the AI
     */
    private async handleVoiceCommand(command: VoiceCommand): Promise<void> {
        if (!this.callbacks) {
            logger.warn('No callbacks configured for voice commands');
            return;
        }

        logger.info('Handling voice command', { type: command.type, parameters: command.parameters });

        let result: Record<string, unknown> = {};

        try {
            switch (command.type) {
                case 'create_task': {
                    if (!command.parameters.prompt) {
                        result = { error: 'No task description provided' };
                        break;
                    }
                    const taskResult = await this.callbacks.onCreateTask(
                        command.parameters.prompt,
                        command.parameters.workspaceId
                    );
                    result = {
                        success: true,
                        taskId: taskResult.taskId,
                        message: `Task created with ID ${taskResult.taskId.slice(-6)}`
                    };

                    // Emit event for UI notification
                    this.emit('taskCreated', taskResult.taskId, command.parameters.prompt);
                    break;
                }

                case 'list_tasks': {
                    const tasks = this.callbacks.onListTasks(command.parameters.workspaceId);
                    result = {
                        tasks: tasks.map(t => ({
                            id: t.id.slice(-6),
                            fullId: t.id,
                            prompt: t.prompt.slice(0, 100),
                            state: t.state
                        })),
                        count: tasks.length
                    };
                    break;
                }

                case 'task_status':
                case 'get_task_status': {
                    if (!command.parameters.taskId) {
                        result = { error: 'No task ID provided' };
                        break;
                    }
                    const task = this.callbacks.onGetTaskStatus(command.parameters.taskId);
                    if (task) {
                        result = {
                            found: true,
                            id: task.id.slice(-6),
                            fullId: task.id,
                            prompt: task.prompt,
                            state: task.state,
                            workspace: task.workspaceId
                        };
                    } else {
                        result = { found: false, error: 'Task not found' };
                    }
                    break;
                }

                case 'stop_task': {
                    if (!command.parameters.taskId) {
                        result = { error: 'No task ID provided' };
                        break;
                    }
                    const stopped = this.callbacks.onStopTask(command.parameters.taskId);
                    result = {
                        success: stopped,
                        message: stopped ? 'Task stopped' : 'Failed to stop task'
                    };
                    break;
                }

                default:
                    result = { error: `Unknown command type: ${command.type}` };
            }
        } catch (error) {
            logger.error('Error executing voice command', { error, command });
            result = { error: 'Failed to execute command' };
        }

        // Send result back to voice service for response generation
        // Note: In a full implementation, we'd track the call_id from the function call
        // For now, we send a text message with the result
        if (this.voiceService) {
            // The voice service will handle sending this back to OpenAI
            // and generating an appropriate spoken response
        }

        // Also notify the client UI
        this.sendToClient({
            type: 'voice:command',
            payload: { command: command.type, result }
        });
    }

    /**
     * Handle disconnect request
     */
    private handleDisconnect(): void {
        this.disconnectVoiceService();
        this.sendToClient({
            type: 'voice:disconnected',
            payload: { reason: 'Client requested disconnect' }
        });
    }

    /**
     * Disconnect voice service
     */
    private disconnectVoiceService(): void {
        if (this.voiceService) {
            this.voiceService.disconnect();
            this.voiceService.removeAllListeners();
            this.voiceService = null;
        }
    }

    /**
     * Handle audio chunk from client
     */
    private handleAudio(payload: { audio: string }): void {
        if (!this.voiceService?.connected) {
            logger.warn('Cannot send audio: voice service not connected');
            return;
        }

        this.voiceService.sendAudio(payload.audio);
    }

    /**
     * Handle audio commit (end of user speech)
     */
    private handleCommit(): void {
        if (!this.voiceService?.connected) {
            return;
        }

        this.voiceService.commitAudio();
    }

    /**
     * Handle text message (fallback for non-voice input)
     */
    private handleText(payload: { text: string }): void {
        if (!this.voiceService?.connected) {
            logger.warn('Cannot send text: voice service not connected');
            return;
        }

        this.voiceService.sendTextMessage(payload.text);
    }

    /**
     * Handle workspace context update
     */
    private handleSetWorkspace(payload: { workspaceId: string }): void {
        if (this.voiceService) {
            this.voiceService.setCurrentWorkspace(payload.workspaceId);
        }
    }

    /**
     * Handle task context update
     */
    private handleUpdateTasks(payload: {
        tasks: Array<{ id: string; prompt: string; state: string; workspaceId: string }>
    }): void {
        if (this.voiceService) {
            this.voiceService.updateTaskContext(payload.tasks);
        }
    }

    /**
     * Announce a task completion to the voice client
     */
    announceTaskCompletion(taskId: string, summary: string): void {
        if (this.voiceService?.connected) {
            this.voiceService.announceTaskCompletion(taskId, summary);
        }
    }

    /**
     * Send message to active client
     */
    private sendToClient(message: { type: VoiceServerMessageType | string; payload: unknown }): void {
        if (this.activeClient && this.activeClient.readyState === WebSocket.OPEN) {
            this.activeClient.send(JSON.stringify(message));
        }
    }

    /**
     * Check if voice service is active
     */
    get isActive(): boolean {
        return this.voiceService?.connected || false;
    }

    /**
     * Cleanup
     */
    destroy(): void {
        this.disconnectVoiceService();
        if (this.activeClient) {
            this.activeClient.close(1000, 'Server shutdown');
            this.activeClient = null;
        }
    }
}

/**
 * Create a singleton VoiceWSHandler
 */
let voiceHandler: VoiceWSHandler | null = null;

export function getVoiceHandler(): VoiceWSHandler {
    if (!voiceHandler) {
        voiceHandler = new VoiceWSHandler();
    }
    return voiceHandler;
}
