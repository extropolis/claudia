/**
 * Backend abstraction layer for AI coding assistants
 * Supports Claude Code (PTY-based) and OpenCode (HTTP API-based)
 */

import { TaskState, WaitingInputType, TaskGitState } from '@claudia/shared';
import { EventEmitter } from 'events';

export type BackendType = 'claude-code' | 'opencode';

/**
 * Configuration for creating a new task
 */
export interface TaskConfig {
    prompt: string;
    workspaceId: string;
    systemPrompt?: string;
    skipPermissions?: boolean;
    model?: string;  // Model to use (e.g., 'anthropic/claude-sonnet-4-5' for OpenCode)
}

/**
 * Configuration for reconnecting to an existing task
 */
export interface ReconnectConfig {
    taskId: string;
    sessionId: string | null;
    workspaceId: string;
    shouldContinue?: boolean;
}

/**
 * Represents a task managed by a backend
 */
export interface BackendTask {
    id: string;
    sessionId: string | null;
    state: TaskState;
    workspaceId: string;
    prompt: string;
    createdAt: Date;
    lastActivity: Date;
    waitingInputType?: WaitingInputType;
    gitState?: TaskGitState;
    systemPrompt?: string;
}

/**
 * Installation status of a backend
 */
export interface BackendStatus {
    installed: boolean;
    version?: string;
    error?: string;
    serverRunning?: boolean; // For OpenCode: whether the server is running
    serverPort?: number;     // For OpenCode: which port the server is on
}

/**
 * Environment configuration for task execution
 */
export interface TaskEnvironment {
    [key: string]: string;
}

/**
 * Events emitted by backends
 */
export interface BackendEvents {
    'task:output': (taskId: string, data: string) => void;
    'task:stateChanged': (task: BackendTask) => void;
    'task:waitingInput': (taskId: string, inputType: WaitingInputType, context: string) => void;
    'task:exit': (taskId: string, exitCode: number) => void;
    'task:sessionCaptured': (taskId: string, sessionId: string) => void;
}

/**
 * Abstract base interface for AI coding assistant backends
 *
 * Implementations:
 * - ClaudeCodeBackend: PTY-based spawning of `claude` CLI
 * - OpenCodeBackend: HTTP API-based communication with `opencode serve`
 */
export interface CodeBackend extends EventEmitter {
    /** Backend identifier */
    readonly name: BackendType;

    /**
     * Check if the backend CLI/tool is installed and available
     */
    checkInstalled(): Promise<BackendStatus>;

    /**
     * Initialize the backend (start servers, etc.)
     */
    initialize(): Promise<void>;

    /**
     * Shutdown the backend gracefully
     */
    shutdown(): Promise<void>;

    /**
     * Create a new task with the given prompt
     */
    createTask(config: TaskConfig, environment: TaskEnvironment): Promise<BackendTask>;

    /**
     * Reconnect to an existing task/session
     */
    reconnectTask(config: ReconnectConfig, environment: TaskEnvironment): Promise<BackendTask>;

    /**
     * Send input/text to a running task
     */
    sendInput(taskId: string, input: string): void;

    /**
     * Resize the task's terminal (for PTY-based backends)
     */
    resizeTask(taskId: string, cols: number, rows: number): void;

    /**
     * Interrupt a running task (send ESC/Ctrl+C)
     */
    interruptTask(taskId: string): boolean;

    /**
     * Stop a running task
     */
    stopTask(taskId: string): boolean;

    /**
     * Destroy a task and clean up resources
     */
    destroyTask(taskId: string): void;

    /**
     * Get the current state of a task
     */
    getTaskState(taskId: string): TaskState | null;

    /**
     * Get a task by ID
     */
    getTask(taskId: string): BackendTask | undefined;

    /**
     * Get the output history for a task
     * @param taskId - The task ID
     * @param maxBytes - Maximum bytes to return (for memory efficiency)
     */
    getTaskHistory(taskId: string, maxBytes?: number): string | null;

    /**
     * Set a task as active (for streaming output)
     */
    setTaskActive(taskId: string, active: boolean): void;

    /**
     * Check if backend has processing indicators in recent output
     * Used for state detection in PTY-based backends
     */
    hasProcessingIndicators?(taskId: string): boolean;
}

/**
 * Factory function type for creating backends
 */
export type BackendFactory = (configStore: unknown) => CodeBackend;

/**
 * Registry of available backends
 */
export const BACKEND_INFO: Record<BackendType, { name: string; description: string; installUrl: string }> = {
    'claude-code': {
        name: 'Claude Code',
        description: "Anthropic's official CLI tool for Claude",
        installUrl: 'https://claude.ai/code'
    },
    'opencode': {
        name: 'OpenCode',
        description: 'Open-source AI coding agent by SST',
        installUrl: 'https://opencode.ai'
    }
};
