/**
 * VoiceSupervisor - Voice-optimized AI supervisor for mobile hands-free control
 *
 * This supervisor is optimized for voice interaction:
 * - Responds directly to simple queries without creating tasks
 * - Only uses SupervisorChat tools when explicitly asked
 * - Ultra-short responses (1-2 sentences, < 20 words)
 * - No markdown formatting
 * - Conversational tone
 * - STREAMS responses for lower latency
 */

import Anthropic from '@anthropic-ai/sdk';
import { SupervisorChat } from './supervisor-chat.js';
import { TaskSpawner } from './task-spawner.js';
import { EventEmitter } from 'events';
import type { Task, ChatMessage } from '@claudia/shared';

export class VoiceSupervisor extends EventEmitter {
    private supervisorChat: SupervisorChat;
    private taskSpawner: TaskSpawner;
    private anthropic: Anthropic | null = null;
    private customSystemPrompt: string;

    /**
     * @param options.anthropic Injectable Anthropic client. Test-only seam: when
     * omitted (always, in production) the client is built from ANTHROPIC_API_KEY
     * exactly as before. Pass `null` to force the "unavailable" path.
     */
    constructor(
        supervisorChat: SupervisorChat,
        taskSpawner: TaskSpawner,
        options?: { anthropic?: Anthropic | null }
    ) {
        super();
        this.supervisorChat = supervisorChat;
        this.taskSpawner = taskSpawner;

        if (options && 'anthropic' in options) {
            this.anthropic = options.anthropic ?? null;
        } else {
            // Initialize Anthropic SDK for streaming (optional - voice features disabled without API key)
            const apiKey = process.env.ANTHROPIC_API_KEY;
            if (!apiKey) {
                console.warn('[VoiceSupervisor] ANTHROPIC_API_KEY not set - voice features will be unavailable');
            } else {
                this.anthropic = new Anthropic({ apiKey });
            }
        }

        // Default system prompt
        this.customSystemPrompt = `You are a voice assistant for a coding environment. Keep responses ULTRA SHORT - 1-2 sentences max, under 20 words if possible. Be conversational, natural, and friendly. No markdown, no bullet points, no formatting. Just speak naturally.

Answer questions directly. If the user wants to create a task or control tasks, acknowledge briefly and do it.`;
    }

    /**
     * Process voice input and stream response in real-time
     * Returns a StreamingResponse object with event handlers
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
        console.log('[VoiceSupervisor] Processing (streaming):', transcript);

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
            // Stream the response from Claude
            const stream = await this.anthropic.messages.stream({
                model: 'claude-sonnet-4-6',
                max_tokens: 150, // Keep it short for voice
                messages: [{
                    role: 'user',
                    content: transcript
                }],
                system: systemPrompt
            });

            let fullText = '';

            // Listen for text deltas
            stream.on('text', (text) => {
                fullText += text;
                // Call callback for real-time TTS
                if (callbacks?.onTextChunk) {
                    callbacks.onTextChunk(text);
                }
            });

            // Wait for completion
            await stream.finalMessage();

            // Strip markdown and optimize for voice
            const voiceText = this.optimizeForVoice(fullText);

            if (callbacks?.onComplete) {
                callbacks.onComplete({
                    text: voiceText,
                    action: 'response'
                });
            }

        } catch (error) {
            console.error('[VoiceSupervisor] Streaming error:', error);
            const errorResponse = {
                text: "Sorry, I couldn't process that. Can you try again?",
                action: 'error' as const
            };

            if (callbacks?.onError) {
                callbacks.onError(error as Error);
            }
            if (callbacks?.onTextChunk) {
                callbacks.onTextChunk(errorResponse.text);
            }
            if (callbacks?.onComplete) {
                callbacks.onComplete(errorResponse);
            }
        }
    }

    /**
     * Process voice input and return voice-optimized response (non-streaming fallback)
     */
    async processVoiceMessage(
        transcript: string,
        workspaceId?: string,
        userId?: string
    ): Promise<VoiceResponse> {
        console.log('[VoiceSupervisor] Processing:', transcript);

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

        // Status queries
        if (lower.match(/what.*running|status|what.*doing|how.*going/)) {
            let tasks = this.taskSpawner.getAllTasks();

            // Filter by workspace if specified
            if (workspaceId) {
                tasks = tasks.filter(t => t.workspaceId === workspaceId);
            }

            const busyTasks = tasks.filter(t => t.state === 'busy');
            const idleTasks = tasks.filter(t => t.state === 'idle');

            if (busyTasks.length === 0 && idleTasks.length === 0) {
                return {
                    text: "Nothing's running right now.",
                    action: 'response'
                };
            }

            if (busyTasks.length > 0) {
                return {
                    text: `You have ${busyTasks.length} task${busyTasks.length > 1 ? 's' : ''} running.`,
                    action: 'response'
                };
            }

            if (idleTasks.length > 0) {
                return {
                    text: `${idleTasks.length} task${idleTasks.length > 1 ? 's' : ''} waiting for input.`,
                    action: 'response'
                };
            }
        }

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
                text: "I can create tasks, check status, and help you code. What do you need?",
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
            // Remove markdown headers
            .replace(/^#{1,6}\s+/gm, '')
            // Remove bold/italic
            .replace(/\*\*(.+?)\*\*/g, '$1')
            .replace(/\*(.+?)\*/g, '$1')
            .replace(/__(.+?)__/g, '$1')
            .replace(/_(.+?)_/g, '$1')
            // Remove code blocks
            .replace(/```[\s\S]*?```/g, '')
            .replace(/`([^`]+)`/g, '$1')
            // Remove bullet points
            .replace(/^\s*[-*+]\s+/gm, '')
            // Remove numbered lists
            .replace(/^\s*\d+\.\s+/gm, '')
            // Remove links but keep text
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            // Remove extra whitespace
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        // No length limit - let the full response through
        return cleaned;
    }

    /**
     * Task state monitoring strategy (using dynamic context)
     *
     * Previously, the voice agent received notifications for every task state change.
     * Now, task status is dynamically included in the system prompt context via buildTaskContext(),
     * reducing notification noise and allowing the agent to see the full task state on each interaction.
     */

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
        console.log('[VoiceSupervisor] System prompt updated');
    }

    /**
     * Get available tools (from SupervisorChat)
     */
    getAvailableTools(): Array<{ name: string; description: string }> {
        // These are the tools available through SupervisorChat
        return [
            {
                name: 'create_task',
                description: 'Create a new coding task. The task will be executed by a Claude Code instance.'
            },
            {
                name: 'delete_task',
                description: 'Delete/remove a task by its ID'
            },
            {
                name: 'get_task_conversation',
                description: 'Read the conversation history of a specific task'
            },
            {
                name: 'send_message_to_task',
                description: 'Send a message/input to a running task'
            },
            {
                name: 'list_tasks',
                description: 'List all current tasks with their status'
            }
        ];
    }
}

export interface VoiceResponse {
    text: string;
    action: 'response' | 'error' | 'stopped' | 'none';
    taskId?: string;
    workspaceId?: string;
}
