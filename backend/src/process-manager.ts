/**
 * Process Manager - Manages task execution through OpenCode SDK sessions
 * 
 * This is a major refactor from CLI-based spawning to SDK-based session management.
 * The interface remains mostly compatible to minimize changes in orchestrator.ts.
 */

import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import { Worker } from '@claudia/shared';
import { OpenCodeClientService, getOpenCodeClient, SessionInfo } from './opencode-client.js';
import { ClaudeClientService, getClaudeClient, SessionMode } from './claude-client.js';
import { ConfigStore } from './config-store.js';

export interface MCPServerConfig {
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    enabled: boolean;
}

interface WorkerSession extends Worker {
    sessionId: string;
    output: string[];
    projectPath?: string;
    backend: 'opencode' | 'claude';
}

export class ProcessManager extends EventEmitter {
    private workers: Map<string, WorkerSession> = new Map();
    private openCodeClient: OpenCodeClientService;
    private claudeClient: ClaudeClientService;
    private configStore: ConfigStore;

    // Track the last browser worker for session continuity
    private lastBrowserSessionId: string | null = null;
    private lastBrowserWorkerId: string | null = null;

    constructor(configStore: ConfigStore) {
        super();
        this.configStore = configStore;
        this.openCodeClient = getOpenCodeClient();
        this.claudeClient = getClaudeClient();
        this.setupEventHandlers();
    }

    /**
     * Setup event handlers from OpenCode client
     */
    /**
     * Setup event handlers from AI clients
     */
    private setupEventHandlers(): void {
        const handleOutput = (data: { sessionId: string; text: string; type: string }) => {
            console.log(`[ProcessManager] Received output event for sessionId=${data.sessionId}, type=${data.type}, text length=${data.text?.length}`);
            // Find worker by session ID and emit output
            let found = false;
            for (const [workerId, worker] of this.workers) {
                if (worker.sessionId === data.sessionId) {
                    found = true;
                    console.log(`[ProcessManager] Found worker ${workerId} for session ${data.sessionId}, emitting output`);
                    worker.output.push(data.text);
                    this.emit('output', {
                        workerId,
                        taskId: worker.taskId,
                        data: data.text
                    });
                    break;
                }
            }
            if (!found) {
                console.log(`[ProcessManager] No worker found for session ${data.sessionId}. Active workers: ${[...this.workers.keys()].join(', ')}`);
            }
        };

        const handleComplete = (sessionInfo: SessionInfo) => {
            for (const [workerId, worker] of this.workers) {
                if (worker.sessionId === sessionInfo.id) {
                    const exitCode = sessionInfo.status === 'complete' ? 0 : 1;
                    worker.status = sessionInfo.status === 'complete' ? 'complete' : 'error';
                    this.emit('complete', {
                        workerId,
                        taskId: worker.taskId,
                        exitCode,
                        status: worker.status
                    });
                    break;
                }
            }
        };

        const handleAborted = (sessionInfo: SessionInfo) => {
            for (const [workerId, worker] of this.workers) {
                if (worker.sessionId === sessionInfo.id) {
                    worker.status = 'error';
                    this.emit('complete', {
                        workerId,
                        taskId: worker.taskId,
                        exitCode: 1,
                        status: 'error'
                    });
                    break;
                }
            }
        };

        // Subscribe Opencode Client
        this.openCodeClient.on('output', handleOutput);
        this.openCodeClient.on('sessionCompleted', handleComplete);
        this.openCodeClient.on('sessionAborted', handleAborted);

        // Subscribe Claude Client
        this.claudeClient.on('output', handleOutput);
        this.claudeClient.on('sessionCompleted', handleComplete);
        this.claudeClient.on('sessionAborted', handleAborted);
    }

    /**
     * Ensure the configured AI backend client is started
     */
    async ensureStarted(): Promise<void> {
        const backend = this.configStore.getConfig().aiBackend;
        console.log(`[ProcessManager] ensureStarted called with backend=${backend}`);

        if (backend === 'claude') {
            console.log(`[ProcessManager] Checking Claude client - isRunning=${this.claudeClient.isRunning()}`);
            if (!this.claudeClient.isRunning()) {
                console.log(`[ProcessManager] Starting Claude client...`);
                await this.claudeClient.start();
                console.log(`[ProcessManager] Claude client started successfully`);
            } else {
                console.log(`[ProcessManager] Claude client already running`);
            }
        } else {
            // Default to opencode
            console.log(`[ProcessManager] Checking OpenCode client - isRunning=${this.openCodeClient.isRunning()}`);
            if (!this.openCodeClient.isRunning()) {
                console.log(`[ProcessManager] Starting OpenCode client...`);
                await this.openCodeClient.start();
                console.log(`[ProcessManager] OpenCode client started successfully`);
            } else {
                console.log(`[ProcessManager] OpenCode client already running`);
            }
        }
    }

    /**
     * Test if a backend can be started successfully
     */
    async testBackend(backend: 'opencode' | 'claude'): Promise<{ success: boolean; message: string; error?: string }> {
        try {
            console.log(`[ProcessManager] Testing ${backend} backend...`);

            if (backend === 'claude') {
                // Test Claude CLI
                if (this.claudeClient.isRunning()) {
                    return {
                        success: true,
                        message: 'Claude Code CLI is already running and ready'
                    };
                }

                // Try to start it
                await this.claudeClient.start();

                if (this.claudeClient.isRunning()) {
                    return {
                        success: true,
                        message: 'Claude Code CLI started successfully'
                    };
                } else {
                    return {
                        success: false,
                        message: 'Claude Code CLI failed to start',
                        error: 'Client is not running after start attempt'
                    };
                }
            } else {
                // Test OpenCode SDK
                if (this.openCodeClient.isRunning()) {
                    return {
                        success: true,
                        message: 'OpenCode SDK is already running and ready'
                    };
                }

                // Try to start it
                await this.openCodeClient.start();

                if (this.openCodeClient.isRunning()) {
                    return {
                        success: true,
                        message: 'OpenCode SDK started successfully'
                    };
                } else {
                    return {
                        success: false,
                        message: 'OpenCode SDK failed to start',
                        error: 'Client is not running after start attempt'
                    };
                }
            }
        } catch (error) {
            console.error(`[ProcessManager] Backend test failed for ${backend}:`, error);
            return {
                success: false,
                message: `Failed to test ${backend} backend`,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * Switch to a different backend, stopping the old one and starting the new one
     */
    async switchBackend(newBackend: 'opencode' | 'claude'): Promise<void> {
        console.log(`[ProcessManager] Switching backend to ${newBackend}...`);

        try {
            // Stop both clients to ensure clean state
            if (this.openCodeClient.isRunning()) {
                console.log('[ProcessManager] Stopping OpenCode client...');
                await this.openCodeClient.stop();
            }
            if (this.claudeClient.isRunning()) {
                console.log('[ProcessManager] Stopping Claude client...');
                await this.claudeClient.stop();
            }

            // Start the new backend
            if (newBackend === 'claude') {
                console.log('[ProcessManager] Starting Claude client...');
                await this.claudeClient.start();
            } else {
                console.log('[ProcessManager] Starting OpenCode client...');
                await this.openCodeClient.start();
            }

            console.log(`[ProcessManager] Successfully switched to ${newBackend}`);
        } catch (error) {
            console.error(`[ProcessManager] Failed to switch backend to ${newBackend}:`, error);
            throw error;
        }
    }

    /**
     * Spawn a new worker for a task using OpenCode SDK sessions
     * This replaces the CLI-based spawn method
     * @param mode - For Claude backend: 'print' for orchestrator (clean output), 'interactive' for tasks (xterm)
     */
    async spawn(
        taskId: string,
        taskPrompt: string,
        cwd?: string,
        mcpServers?: MCPServerConfig[],
        mode: SessionMode = 'interactive'
    ): Promise<Worker> {
        const workerId = uuid();
        const backend = this.configStore.getConfig().aiBackend || 'claude';

        console.log(`[ProcessManager] Spawning worker ${workerId} for task ${taskId} using ${backend}`);
        console.log(`[ProcessManager] Prompt: ${taskPrompt.substring(0, 100)}...`);
        console.log(`[ProcessManager] CWD: ${cwd || process.cwd()}`);
        console.log(`[ProcessManager] MCP Servers: ${mcpServers?.length || 0} configured`);

        // Ensure client is started
        await this.ensureStarted();

        // Select client
        const client = backend === 'claude' ? this.claudeClient : this.openCodeClient;

        // Register MCP servers if provided
        if (mcpServers && mcpServers.length > 0) {
            console.log(`[ProcessManager] Registering ${mcpServers.length} MCP server(s)...`);
            await client.registerMcpServers(mcpServers);
        }

        // Create a session for this task with the correct working directory
        const sessionTitle = `Task ${taskId.substring(0, 8)}`;
        console.log(`[ProcessManager] Creating session for task ${taskId} in directory ${cwd || 'default'} with mode ${mode}...`);
        // Pass mode for Claude client (OpenCode client ignores it)
        const sessionInfo = await (client as any).createSession(taskId, sessionTitle, cwd, mode);
        console.log(`[ProcessManager] Session created: ${sessionInfo.id}`);

        const worker: WorkerSession = {
            id: workerId,
            taskId,
            status: 'running',
            sessionId: sessionInfo.id,
            output: [],
            projectPath: cwd,
            backend
        };

        this.workers.set(workerId, worker);

        // If there's context to inject (like project path), do it first
        if (cwd) {
            await client.injectContext(
                sessionInfo.id,
                `You are working in the project directory: ${cwd}\nComplete the following task.`
            );
        }

        // Send the task prompt (this runs async and completes via event handlers)
        this.executePrompt(workerId, sessionInfo.id, taskPrompt, backend);

        console.log(`[ProcessManager] Worker ${workerId} spawned successfully for task ${taskId}`);
        return {
            id: workerId,
            taskId,
            status: 'running',
            sessionId: sessionInfo.id
        };
    }


    private async executePrompt(workerId: string, sessionId: string, prompt: string, backend: 'opencode' | 'claude'): Promise<void> {
        try {
            console.log(`[ProcessManager] executePrompt called for worker=${workerId}, session=${sessionId}, backend=${backend}`);

            // Use the correct client based on backend
            const client = backend === 'claude' ? this.claudeClient : this.openCodeClient;

            const result = await client.sendPrompt(sessionId, prompt);
            console.log(`[ProcessManager] sendPrompt completed for worker=${workerId}, success=${result.success}, content length=${result.content?.length}`);

            if (result.success) {
                // Note: We DO NOT emit output here because streaming output is already handled
                // by the 'output' event listener (line 54) which receives delta updates from opencode-client.
                // Emitting result.content here would duplicate the final output.

                // Just store the final content if we need it
                if (result.content) {
                    const worker = this.workers.get(workerId);
                    if (worker) {
                        // Content is already in worker.output from streaming, no need to add again
                        console.log(`[ProcessManager] Task completed for worker=${workerId}, total output length=${worker.output.join('').length}`);
                    }
                }

                // Mark session as complete
                client.completeSession(sessionId, 'complete');
            } else {
                console.error(`[ProcessManager] Prompt failed: ${result.error}`);
                client.completeSession(sessionId, 'error');
            }
        } catch (error) {
            console.error(`[ProcessManager] Error executing prompt:`, error);
            const client = backend === 'claude' ? this.claudeClient : this.openCodeClient;
            client.completeSession(sessionId, 'error');
        }
    }

    /**
     * Spawn a worker that resumes an existing session
     * This allows sharing browser state across tasks
     */
    async spawnWithResume(
        taskId: string,
        taskPrompt: string,
        resumeSessionId: string,
        cwd?: string,
        mcpServers?: MCPServerConfig[]
    ): Promise<Worker> {
        const workerId = uuid();

        console.log(`[ProcessManager] Spawning worker ${workerId} for task ${taskId} (RESUMING session ${resumeSessionId})`);
        console.log(`[ProcessManager] Prompt: ${taskPrompt.substring(0, 100)}...`);

        await this.ensureStarted();

        // For resume, we send to the existing session
        const sessionInfo = this.openCodeClient.getSession(resumeSessionId);
        if (!sessionInfo) {
            console.log(`[ProcessManager] Session ${resumeSessionId} not found, creating new session`);
            return this.spawn(taskId, taskPrompt, cwd, mcpServers);
        }

        const worker: WorkerSession = {
            id: workerId,
            taskId,
            status: 'running',
            sessionId: resumeSessionId,
            output: [],
            projectPath: cwd,
            backend: 'opencode'
        };

        this.workers.set(workerId, worker);

        // Execute the prompt on the existing session
        this.executePrompt(workerId, resumeSessionId, taskPrompt);

        return {
            id: workerId,
            taskId,
            status: 'running',
            sessionId: resumeSessionId
        };
    }

    /**
     * Get the session ID of a worker
     */
    getSessionId(workerId: string): string | undefined {
        return this.workers.get(workerId)?.sessionId;
    }

    /**
     * Set the last browser session for continuity
     */
    setBrowserSession(workerId: string, sessionId: string): void {
        this.lastBrowserWorkerId = workerId;
        this.lastBrowserSessionId = sessionId;
        console.log(`[ProcessManager] Set browser session: ${sessionId} (worker: ${workerId})`);
    }

    /**
     * Get the last browser session ID
     */
    getLastBrowserSessionId(): string | null {
        return this.lastBrowserSessionId;
    }

    /**
     * Clear browser session
     */
    clearBrowserSession(): void {
        this.lastBrowserWorkerId = null;
        this.lastBrowserSessionId = null;
    }

    /**
     * Kill a running worker by aborting its session
     */
    async kill(workerId: string): Promise<boolean> {
        const worker = this.workers.get(workerId);
        if (!worker) return false;

        console.log(`[ProcessManager] Killing worker ${workerId}`);

        const success = await this.openCodeClient.abortSession(worker.sessionId);
        if (success) {
            worker.status = 'error';
        }
        return success;
    }

    /**
     * Send input to a running worker's session
     * In SDK mode, this sends a follow-up prompt
     */
    async sendInput(workerId: string, input: string): Promise<boolean> {
        const worker = this.workers.get(workerId);
        if (!worker || worker.status !== 'running') {
            console.log(`[ProcessManager] Cannot send input to worker ${workerId}: not running`);
            return false;
        }

        console.log(`[ProcessManager] Sending input to worker ${workerId}: ${input.substring(0, 100)}...`);

        const result = await this.openCodeClient.sendPrompt(worker.sessionId, input);
        return result.success;
    }

    /**
     * Get the accumulated output of a worker
     */
    getOutput(workerId: string): string[] {
        return this.workers.get(workerId)?.output || [];
    }

    /**
     * Get a worker by ID
     */
    getWorker(workerId: string): Worker | undefined {
        const worker = this.workers.get(workerId);
        if (!worker) return undefined;
        return {
            id: worker.id,
            taskId: worker.taskId,
            status: worker.status,
            sessionId: worker.sessionId
        };
    }

    /**
     * Get all workers
     */
    getAllWorkers(): Worker[] {
        return Array.from(this.workers.values()).map(w => ({
            id: w.id,
            taskId: w.taskId,
            status: w.status,
            sessionId: w.sessionId
        }));
    }

    /**
     * Clean up completed workers
     */
    cleanup(): void {
        for (const [id, worker] of this.workers) {
            if (worker.status !== 'running') {
                this.workers.delete(id);
            }
        }
    }

    /**
     * Stop the OpenCode client
     */
    async shutdown(): Promise<void> {
        await this.openCodeClient.stop();
    }
}
