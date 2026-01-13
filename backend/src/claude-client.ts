
import { EventEmitter } from 'events';
import * as pty from 'node-pty';
import { v4 as uuid } from 'uuid';
import stripAnsi from 'strip-ansi';
import { spawn } from 'child_process';

/**
 * Session mode determines how Claude CLI is invoked:
 * - 'print': Uses --print flag for one-shot responses (orchestrator decisions)
 * - 'interactive': Full xterm session for tasks users can watch
 */
export type SessionMode = 'print' | 'interactive';

/**
 * Interface matching SessionInfo from opencode-client
 */
export interface SessionInfo {
    id: string;
    title: string;
    taskId: string;
    status: 'active' | 'complete' | 'error' | 'aborted';
    startedAt: Date;
    completedAt?: Date;
    ptyProcess?: pty.IPty;
    mode: SessionMode;
}

export interface PromptResult {
    success: boolean;
    content?: string;
    error?: string;
}

/**
 * Claude Client - Wrapper for Claude Code CLI
 *
 * Supports two modes:
 * - Print mode: For orchestrator decisions, uses `claude --print` for clean output
 * - Interactive mode: Full xterm PTY session for tasks users can watch
 */
export class ClaudeClientService extends EventEmitter {
    private sessions: Map<string, SessionInfo> = new Map();
    private activePtyProcesses: Map<string, pty.IPty> = new Map();
    private sessionBuffers: Map<string, string> = new Map();
    private printProcesses: Map<string, { resolve: (result: PromptResult) => void; output: string }> = new Map();

    constructor() {
        super();
    }

    async start(): Promise<void> {
        console.log('[ClaudeClient] Started');
        this.emit('started', { url: 'local-cli' });
    }

    async stop(): Promise<void> {
        console.log('[ClaudeClient] Stopping...');
        for (const [id, proc] of this.activePtyProcesses) {
            try {
                proc.kill();
            } catch (e) {
                console.error(`[ClaudeClient] Error killing process ${id}:`, e);
            }
        }
        this.sessions.clear();
        this.activePtyProcesses.clear();
        this.emit('stopped');
    }

    isRunning(): boolean {
        return true;
    }

    /**
     * Create a new session
     * @param mode - 'print' for orchestrator, 'interactive' for tasks
     */
    async createSession(taskId: string, title: string, directory?: string, mode: SessionMode = 'interactive'): Promise<SessionInfo> {
        const sessionId = uuid();
        console.log(`[ClaudeClient] Creating ${mode} session ${sessionId} for task ${taskId} in ${directory || 'default'}`);

        const sessionInfo: SessionInfo = {
            id: sessionId,
            title,
            taskId,
            status: 'active',
            startedAt: new Date(),
            mode
        };

        this.sessions.set(sessionId, sessionInfo);

        // For interactive mode, spawn the PTY immediately
        if (mode === 'interactive') {
            await this.spawnInteractiveSession(sessionId, sessionInfo, directory);
        }
        // For print mode, we spawn per-prompt

        this.emit('sessionCreated', sessionInfo);
        return sessionInfo;
    }

    /**
     * Spawn an interactive PTY session with Claude CLI
     */
    private async spawnInteractiveSession(sessionId: string, sessionInfo: SessionInfo, directory?: string): Promise<void> {
        try {
            const cwd = directory || process.cwd();

            // Spawn claude directly (not bash + claude)
            const ptyProcess = pty.spawn('claude', [], {
                name: 'xterm-256color',
                cols: 120,
                rows: 40,
                cwd: cwd,
                env: {
                    ...process.env,
                    TERM: 'xterm-256color',
                    // Ensure Claude knows it's in a PTY
                    CLAUDE_CODE_ENTRYPOINT: 'cli'
                } as any
            });

            this.activePtyProcesses.set(sessionId, ptyProcess);
            sessionInfo.ptyProcess = ptyProcess;
            this.sessionBuffers.set(sessionId, '');

            // Handle output
            ptyProcess.onData((data) => {
                const output = stripAnsi(data);

                // Emit output for frontend streaming
                this.emit('output', {
                    sessionId,
                    text: output,
                    type: 'stdout'
                });

                // Accumulate buffer
                const currentBuffer = this.sessionBuffers.get(sessionId) || '';
                this.sessionBuffers.set(sessionId, currentBuffer + output);
            });

            ptyProcess.onExit(({ exitCode, signal }) => {
                console.log(`[ClaudeClient] Interactive process for session ${sessionId} exited with code ${exitCode}`);
                if (sessionInfo.status === 'active') {
                    this.completeSession(sessionId, exitCode === 0 ? 'complete' : 'error');
                }
            });

            console.log(`[ClaudeClient] Interactive session ${sessionId} spawned successfully`);

        } catch (error) {
            console.error('[ClaudeClient] Failed to spawn interactive process:', error);
            sessionInfo.status = 'error';
            throw error;
        }
    }

    /**
     * Send a prompt to the session
     */
    async sendPrompt(sessionId: string, prompt: string): Promise<PromptResult> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return { success: false, error: 'Session not found' };
        }

        if (session.mode === 'print') {
            return this.sendPrintPrompt(sessionId, session, prompt);
        } else {
            return this.sendInteractivePrompt(sessionId, session, prompt);
        }
    }

    /**
     * Send prompt using --print mode (for orchestrator)
     * Clean output, no terminal UI
     */
    private async sendPrintPrompt(sessionId: string, session: SessionInfo, prompt: string): Promise<PromptResult> {
        const TIMEOUT_MS = 120000; // 2 minute timeout for print mode

        return new Promise((resolve) => {
            console.log(`[ClaudeClient] Sending print prompt to session ${sessionId}`);

            const cwd = session.taskId ? process.cwd() : process.cwd(); // Could get from session

            let resolved = false;
            const resolveOnce = (result: PromptResult) => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeoutId);
                    resolve(result);
                }
            };

            // Use claude --print for one-shot execution
            const proc = spawn('claude', ['--print', prompt], {
                cwd: cwd,
                env: {
                    ...process.env,
                    // Disable any interactive features
                    CI: 'true'
                },
                stdio: ['pipe', 'pipe', 'pipe']
            });

            // Add timeout to prevent infinite hangs
            const timeoutId = setTimeout(() => {
                console.error(`[ClaudeClient] Print mode timeout after ${TIMEOUT_MS}ms, killing process`);
                proc.kill('SIGKILL');
                resolveOnce({
                    success: false,
                    error: `Timeout: claude --print did not respond within ${TIMEOUT_MS / 1000} seconds`
                });
            }, TIMEOUT_MS);

            let stdout = '';
            let stderr = '';

            proc.stdout?.on('data', (data) => {
                const text = data.toString();
                stdout += text;

                // Emit output for streaming
                this.emit('output', {
                    sessionId,
                    text: text,
                    type: 'stdout'
                });
            });

            proc.stderr?.on('data', (data) => {
                const text = data.toString();
                stderr += text;
                console.log(`[ClaudeClient] Print mode stderr: ${text}`);
            });

            proc.on('close', (code) => {
                console.log(`[ClaudeClient] Print mode completed with code ${code}`);

                if (code === 0) {
                    resolveOnce({
                        success: true,
                        content: stdout
                    });
                } else {
                    resolveOnce({
                        success: false,
                        error: stderr || `Process exited with code ${code}`
                    });
                }
            });

            proc.on('error', (error) => {
                console.error(`[ClaudeClient] Print mode error:`, error);
                resolveOnce({
                    success: false,
                    error: error.message
                });
            });
        });
    }

    /**
     * Send prompt to interactive PTY session (for tasks)
     * Full terminal experience users can watch
     */
    private async sendInteractivePrompt(sessionId: string, session: SessionInfo, prompt: string): Promise<PromptResult> {
        if (!session.ptyProcess) {
            return { success: false, error: 'Interactive session not active' };
        }

        console.log(`[ClaudeClient] Sending interactive prompt to ${sessionId}`);

        try {
            // Write prompt to the PTY stdin
            // Add newline to submit
            session.ptyProcess.write(prompt + '\r');

            // For interactive mode, we return immediately
            // Output streams via events
            return {
                success: true,
                content: '' // Content comes via streaming events
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    async abortSession(sessionId: string): Promise<boolean> {
        const session = this.sessions.get(sessionId);
        if (session) {
            if (session.ptyProcess) {
                session.ptyProcess.kill();
            }
            this.completeSession(sessionId, 'aborted');
            return true;
        }
        return false;
    }

    getSession(sessionId: string): SessionInfo | undefined {
        return this.sessions.get(sessionId);
    }

    completeSession(sessionId: string, status: 'complete' | 'error' | 'aborted'): void {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.status = status;
            session.completedAt = new Date();
            this.emit('sessionCompleted', session);

            // Cleanup PTY process
            if (this.activePtyProcesses.has(sessionId)) {
                const proc = this.activePtyProcesses.get(sessionId);
                try {
                    proc?.kill();
                } catch (e) {
                    // Already dead
                }
                this.activePtyProcesses.delete(sessionId);
            }
        }
    }

    /**
     * Inject context into a session
     * For print mode: prepend to next prompt
     * For interactive mode: send as message
     */
    async injectContext(sessionId: string, context: string): Promise<boolean> {
        const session = this.sessions.get(sessionId);
        if (!session) return false;

        if (session.mode === 'interactive' && session.ptyProcess) {
            // For interactive, we can send context as a message
            // But typically we'd include it in the prompt instead
            // Let's just store it for now
            console.log(`[ClaudeClient] Context for interactive session ${sessionId}: ${context.substring(0, 100)}...`);
            return true;
        }

        // For print mode, context is included in the prompt
        return true;
    }

    async registerMcpServers(servers: any[]): Promise<boolean> {
        // Claude CLI handles MCP via config file
        // Would need to write to ~/.claude/mcp_servers.json
        console.log('[ClaudeClient] MCP servers registration requested', servers.length);
        return true;
    }

    /**
     * Resize the PTY (for interactive sessions)
     */
    resizeSession(sessionId: string, cols: number, rows: number): void {
        const proc = this.activePtyProcesses.get(sessionId);
        if (proc) {
            proc.resize(cols, rows);
        }
    }

    /**
     * Send raw input to interactive session (for user typing)
     */
    sendRawInput(sessionId: string, data: string): void {
        const proc = this.activePtyProcesses.get(sessionId);
        if (proc) {
            proc.write(data);
        }
    }
}

// Singleton instance
let instance: ClaudeClientService | null = null;

export function getClaudeClient(): ClaudeClientService {
    if (!instance) {
        instance = new ClaudeClientService();
    }
    return instance;
}
