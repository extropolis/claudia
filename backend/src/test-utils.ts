/**
 * Test utilities for automated and integration testing
 */

import WebSocket from 'ws';
import { WSMessage, ChatMessage, Task } from './types.js';

export interface TestResult {
    passed: boolean;
    duration: number;
    error?: string;
    details?: any;
}

export interface TestContext {
    ws: WebSocket;
    messages: ChatMessage[];
    tasks: Map<string, Task>;
    startTime: number;
}

/**
 * Create a WebSocket connection for testing
 */
export async function createTestConnection(url: string = 'ws://localhost:3001'): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);

        ws.on('open', () => resolve(ws));
        ws.on('error', (error) => reject(error));

        setTimeout(() => reject(new Error('Connection timeout')), 10000);
    });
}

/**
 * Send a message and wait for response
 */
export async function sendMessageAndWait(
    ws: WebSocket,
    content: string,
    timeoutMs: number = 30000
): Promise<ChatMessage[]> {
    const messages: ChatMessage[] = [];

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Message timeout'));
        }, timeoutMs);

        const messageHandler = (data: Buffer) => {
            try {
                const message: WSMessage = JSON.parse(data.toString());

                if (message.type === 'chat:message') {
                    const chatMsg = (message.payload as any).message as ChatMessage;
                    messages.push(chatMsg);

                    // Check if assistant responded
                    if (chatMsg.role === 'assistant') {
                        // Wait a bit more for potential additional messages
                        setTimeout(() => {
                            clearTimeout(timeout);
                            ws.off('message', messageHandler);
                            resolve(messages);
                        }, 2000);
                    }
                }
            } catch (error) {
                // Ignore parse errors
            }
        };

        ws.on('message', messageHandler);

        // Send the message
        const msg = {
            type: 'chat:send',
            payload: { content }
        };
        ws.send(JSON.stringify(msg));
    });
}

/**
 * Wait for a task to complete
 */
export async function waitForTaskCompletion(
    ws: WebSocket,
    taskId: string,
    timeoutMs: number = 60000
): Promise<Task> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Task completion timeout'));
        }, timeoutMs);

        const messageHandler = (data: Buffer) => {
            try {
                const message: WSMessage = JSON.parse(data.toString());

                if (message.type === 'task:complete') {
                    const task = (message.payload as any).task as Task;
                    if (task.id === taskId) {
                        clearTimeout(timeout);
                        ws.off('message', messageHandler);
                        resolve(task);
                    }
                }
            } catch (error) {
                // Ignore parse errors
            }
        };

        ws.on('message', messageHandler);
    });
}

/**
 * Create a test task
 */
export async function createTestTask(
    ws: WebSocket,
    name: string,
    description: string,
    workspaceId?: string
): Promise<string> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Task creation timeout'));
        }, 10000);

        const messageHandler = (data: Buffer) => {
            try {
                const message: WSMessage = JSON.parse(data.toString());

                if (message.type === 'task:created') {
                    const task = (message.payload as any).task as Task;
                    clearTimeout(timeout);
                    ws.off('message', messageHandler);
                    resolve(task.id);
                }
            } catch (error) {
                // Ignore parse errors
            }
        };

        ws.on('message', messageHandler);

        // Send task creation message
        const msg = {
            type: 'task:create',
            payload: { name, description, workspaceId }
        };
        ws.send(JSON.stringify(msg));
    });
}

/**
 * Assert that a message contains expected content
 */
export function assertMessageContains(message: ChatMessage, expectedContent: string): boolean {
    return message.content.toLowerCase().includes(expectedContent.toLowerCase());
}

/**
 * Assert that task completed successfully
 */
export function assertTaskSuccess(task: Task): boolean {
    return task.status === 'complete' && (task.exitCode === 0 || task.exitCode === undefined);
}

/**
 * Assert that structured result exists
 */
export function assertStructuredResult(task: Task): boolean {
    return task.structuredResult !== undefined && task.structuredResult !== null;
}

/**
 * Extract assistant responses from messages
 */
export function extractAssistantResponses(messages: ChatMessage[]): ChatMessage[] {
    return messages.filter(m => m.role === 'assistant');
}

/**
 * Check if response has real content (not just "task complete")
 */
export function hasRealContent(message: ChatMessage): boolean {
    const content = message.content.toLowerCase();

    // Check if it's just a generic completion message
    const isGenericComplete = content.match(/^[✅❌⚠️]?\s*(task|worker).*complete/i);

    // Check if it has substantial content
    const hasSubstantialContent = message.content.length > 50;

    return hasSubstantialContent && !isGenericComplete;
}

/**
 * Wait for a specified amount of time
 */
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Cleanup WebSocket connection
 */
export function cleanup(ws: WebSocket): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
    }
}

/**
 * Collect all messages from a WebSocket connection
 */
export class MessageCollector {
    private messages: WSMessage[] = [];
    private chatMessages: ChatMessage[] = [];
    private tasks: Map<string, Task> = new Map();

    constructor(private ws: WebSocket) {
        this.ws.on('message', this.handleMessage.bind(this));
    }

    private handleMessage(data: Buffer): void {
        try {
            const message: WSMessage = JSON.parse(data.toString());
            this.messages.push(message);

            switch (message.type) {
                case 'chat:message':
                    this.chatMessages.push((message.payload as any).message);
                    break;
                case 'task:created':
                case 'task:updated':
                case 'task:complete':
                    const task = (message.payload as any).task as Task;
                    this.tasks.set(task.id, task);
                    break;
            }
        } catch (error) {
            // Ignore parse errors
        }
    }

    getMessages(): WSMessage[] {
        return this.messages;
    }

    getChatMessages(): ChatMessage[] {
        return this.chatMessages;
    }

    getTasks(): Map<string, Task> {
        return this.tasks;
    }

    getAssistantMessages(): ChatMessage[] {
        return this.chatMessages.filter(m => m.role === 'assistant');
    }

    getTask(taskId: string): Task | undefined {
        return this.tasks.get(taskId);
    }

    waitForAssistantMessage(timeoutMs: number = 10000): Promise<ChatMessage> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Timeout waiting for assistant message'));
            }, timeoutMs);

            const check = setInterval(() => {
                const assistantMessages = this.getAssistantMessages();
                if (assistantMessages.length > 0) {
                    clearTimeout(timeout);
                    clearInterval(check);
                    resolve(assistantMessages[assistantMessages.length - 1]);
                }
            }, 100);
        });
    }

    waitForTaskComplete(timeoutMs: number = 60000): Promise<Task> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Timeout waiting for task completion'));
            }, timeoutMs);

            const check = setInterval(() => {
                const tasks = Array.from(this.tasks.values());
                const completedTask = tasks.find(t =>
                    t.status === 'complete' || t.status === 'error'
                );

                if (completedTask) {
                    clearTimeout(timeout);
                    clearInterval(check);
                    resolve(completedTask);
                }
            }, 100);
        });
    }
}
