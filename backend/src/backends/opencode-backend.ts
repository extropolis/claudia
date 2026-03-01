/**
 * OpenCode Backend - PTY-based implementation
 * Spawns and manages OpenCode CLI processes (mirrors Claude Code approach)
 */

import { spawn, IPty } from '@homebridge/node-pty-prebuilt-multiarch';
import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, mkdirSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TaskState, WaitingInputType, TaskGitState } from '@claudia/shared';
import {
    CodeBackend,
    BackendType,
    BackendStatus,
    BackendTask,
    TaskConfig,
    ReconnectConfig,
    TaskEnvironment
} from './types.js';
import { ConfigStore } from '../config-store.js';
import { createLogger } from '../logger.js';

const logger = createLogger('[OpenCodeBackend]');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Internal task representation with PTY process
 */
interface InternalTask {
    id: string;
    prompt: string;
    workspaceId: string;
    process: IPty;
    state: TaskState;
    outputHistory: Buffer[];
    previousHistory?: Buffer;
    lazyHistoryBase64?: string;
    lastActivity: Date;
    createdAt: Date;
    isActive: boolean;
    initialPromptSent: boolean;
    pendingPrompt: string | null;
    sessionId: string | null;
    promptSubmitAttempts?: number;
    gitStateBefore?: Partial<TaskGitState>;
    gitState?: TaskGitState;
    systemPrompt?: string;
    waitingInputType?: WaitingInputType;
    lastOutputLength: number;
    hasStartedProcessing: boolean;
    stateTransitionLock?: boolean;
    shouldContinue?: boolean;
    continuationSent?: boolean;
    consecutiveOutputChanges?: number;
}

/**
 * OpenCode Backend implementation using PTY
 */
export class OpenCodeBackend extends EventEmitter implements CodeBackend {
    readonly name: BackendType = 'opencode';

    private tasks: Map<string, InternalTask> = new Map();
    private configStore: ConfigStore | null = null;
    private statePollingInterval: NodeJS.Timeout | null = null;
    private readonly statePollingMs: number;
    private historyDir: string;

    constructor(configStore?: ConfigStore, historyDir?: string) {
        super();
        this.configStore = configStore || null;

        // Configurable polling interval via environment variable (default: 3000ms)
        const envPollingMs = parseInt(process.env.STATE_POLLING_MS || '', 10);
        this.statePollingMs = !isNaN(envPollingMs) && envPollingMs >= 500 ? envPollingMs : 3000;

        this.historyDir = historyDir || join(__dirname, '..', '..', 'task-histories');
    }

    async checkInstalled(): Promise<BackendStatus> {
        try {
            const version = execSync('opencode --version', { encoding: 'utf8', timeout: 5000 }).trim();
            return { installed: true, version };
        } catch (error) {
            return {
                installed: false,
                error: 'OpenCode CLI is not installed. Please install it from: https://opencode.ai'
            };
        }
    }

    async initialize(): Promise<void> {
        // Start state polling
        this.startStatePolling();
        logger.info('OpenCode backend initialized', { pollingMs: this.statePollingMs });
    }

    async shutdown(): Promise<void> {
        // Stop state polling
        if (this.statePollingInterval) {
            clearInterval(this.statePollingInterval);
            this.statePollingInterval = null;
        }

        // Kill all processes
        for (const task of this.tasks.values()) {
            try {
                task.process.kill();
            } catch (_e) {
                // Process might already be dead
            }
        }
        this.tasks.clear();

        logger.info('OpenCode backend shut down');
    }

    async createTask(config: TaskConfig, environment: TaskEnvironment): Promise<BackendTask> {
        const id = `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Use interactive 'opencode' CLI (like Claude Code)
        const opencodeArgs: string[] = [];

        // Use model from config (set by TaskSpawner based on API mode settings)
        // Falls back to OPENCODE_MODEL env var, then to openai/gpt-4o as last resort
        const model = config.model || process.env.OPENCODE_MODEL || 'openai/gpt-4o';
        opencodeArgs.push('-m', model);

        // Log SAP AI Core configuration if present
        const hasAICoreKey = !!environment['AICORE_SERVICE_KEY'];
        const hasResourceGroup = !!environment['AICORE_RESOURCE_GROUP'];
        logger.info('Using model', {
            model,
            hasAICoreKey,
            hasResourceGroup,
            resourceGroup: environment['AICORE_RESOURCE_GROUP']
        });
        if (hasAICoreKey) {
            logger.info('OpenCode will use SAP AI Core via AICORE_SERVICE_KEY');
        }

        logger.info('Creating OpenCode task (interactive)', { taskId: id, workspaceId: config.workspaceId, prompt: config.prompt });
        logger.debug('Command args', { args: opencodeArgs });

        const ptyProcess = spawn('opencode', opencodeArgs, {
            name: 'xterm-256color',
            cols: 120,
            rows: 40,
            cwd: config.workspaceId,
            env: environment,
        });

        const now = new Date();
        const task: InternalTask = {
            id,
            prompt: config.prompt,
            workspaceId: config.workspaceId,
            process: ptyProcess,
            state: 'starting',  // Start in 'starting' state until OpenCode is ready
            outputHistory: [],
            lastActivity: now,
            createdAt: now,
            isActive: false,
            initialPromptSent: false,  // Will send prompt when TUI is ready
            pendingPrompt: config.prompt,  // Queue the prompt for later
            sessionId: null,
            systemPrompt: config.systemPrompt?.trim() || undefined,
            lastOutputLength: 0,
            hasStartedProcessing: false,  // Will be true once output changes after prompt sent
        };

        this.setupProcessHandlers(task);
        this.tasks.set(id, task);
        this.emit('task:stateChanged', this.toBackendTask(task));

        return this.toBackendTask(task);
    }

    async reconnectTask(config: ReconnectConfig, environment: TaskEnvironment): Promise<BackendTask> {
        const opencodeArgs: string[] = [];

        if (config.sessionId) {
            opencodeArgs.push('--session', config.sessionId);
            logger.info('Reconnecting task with session', { taskId: config.taskId, sessionId: config.sessionId });
        } else {
            logger.info('Reconnecting task (fresh start)', { taskId: config.taskId });
        }

        const ptyProcess = spawn('opencode', opencodeArgs, {
            name: 'xterm-256color',
            cols: 120,
            rows: 40,
            cwd: config.workspaceId,
            env: environment,
        });

        const now = new Date();
        const shouldContinue = config.shouldContinue && config.sessionId != null;

        const resumeMessage = config.sessionId
            ? `\r\n\x1b[90m─── Resuming session ${config.sessionId} ───\x1b[0m\r\n\r\n`
            : `\r\n\x1b[90m─── Session reconnected ───\x1b[0m\r\n\r\n`;

        const task: InternalTask = {
            id: config.taskId,
            prompt: '',
            workspaceId: config.workspaceId,
            process: ptyProcess,
            state: shouldContinue ? 'starting' : 'idle',
            outputHistory: [Buffer.from(resumeMessage)],
            lastActivity: now,
            createdAt: now,
            isActive: false,
            initialPromptSent: !shouldContinue,
            pendingPrompt: shouldContinue ? 'continue' : null,
            sessionId: config.sessionId,
            lastOutputLength: resumeMessage.length,
            hasStartedProcessing: !shouldContinue,
            shouldContinue,
            continuationSent: false,
        };

        this.setupProcessHandlers(task);
        this.tasks.set(task.id, task);
        this.emit('task:stateChanged', this.toBackendTask(task));

        return this.toBackendTask(task);
    }

    sendInput(taskId: string, input: string, options: { typeCharByChar?: boolean } = {}): void {
        const task = this.tasks.get(taskId);
        if (!task) return;

        const endsWithEnter = input.endsWith('\r') || input.endsWith('\n');
        const hasMessageContent = input.length > 0;

        // Ensure we handle input correctly whether it ends with newline or not
        const messageContent = endsWithEnter ? input.slice(0, -1) : input;
        const enterKey = endsWithEnter ? input.slice(-1) : '';

        // Handle character-by-character typing (for initial prompt)
        if (options.typeCharByChar && messageContent.length > 0) {
            // Echo the full input to output history immediately so it's visible in UI
            const echoBuffer = Buffer.from(messageContent);
            task.outputHistory.push(echoBuffer);
            if (task.isActive) {
                this.emit('task:output', task.id, messageContent);
            }

            // Type character by character to the PTY
            let charIndex = 0;
            const typeNextChar = () => {
                if (charIndex < messageContent.length) {
                    task.process.write(messageContent[charIndex]);
                    charIndex++;
                    setTimeout(typeNextChar, 10); // 10ms delay per char
                } else if (enterKey) {
                    // Send Enter after typing finishes
                    setTimeout(() => this.sendEnterWithRetry(task, 3, { isInitialPrompt: false, enterKey }), 200);
                }
            };
            typeNextChar();
            return;
        }

        if (hasMessageContent && (task.state === 'idle' || task.state === 'waiting_input' || task.state === 'starting')) {
            // Echo to history immediately (UI)
            const echoBuffer = Buffer.from(messageContent);
            task.outputHistory.push(echoBuffer);
            if (task.isActive) {
                this.emit('task:output', task.id, messageContent);
            }

            task.process.write(messageContent);
            task.promptSubmitAttempts = 0;

            setTimeout(() => this.sendEnterWithRetry(task, 3, { isInitialPrompt: false, enterKey: enterKey || '\r' }), 200);
        } else {
            // For single characters or non-message input, echo them too
            const echoBuffer = Buffer.from(input);
            task.outputHistory.push(echoBuffer);
            if (task.isActive) {
                this.emit('task:output', task.id, input);
            }
            task.process.write(input);
        }
    }

    resizeTask(taskId: string, cols: number, rows: number): void {
        const task = this.tasks.get(taskId);
        if (task) {
            task.process.resize(cols, rows);
        }
    }

    interruptTask(taskId: string): boolean {
        const task = this.tasks.get(taskId);
        if (task && task.state === 'busy') {
            logger.info('Interrupting task', { taskId });
            task.process.write('\x1b');
            return true;
        }
        return false;
    }

    stopTask(taskId: string): boolean {
        const task = this.tasks.get(taskId);
        if (!task) {
            logger.info('stopTask: task not found', { taskId });
            return false;
        }

        if (task.state === 'busy' || task.state === 'starting' || task.state === 'waiting_input') {
            logger.info('Stopping task', { taskId, state: task.state });
            try {
                task.process.write('\x1b');
            } catch (_e) {
                // Process might already be dead
            }
            return true;
        }

        logger.info('stopTask: task not in stoppable state', { taskId, state: task.state });
        return false;
    }

    destroyTask(taskId: string): void {
        logger.info('Destroying task', { taskId });

        const task = this.tasks.get(taskId);
        if (task) {
            if (task.state === 'busy' || task.state === 'starting' || task.state === 'waiting_input') {
                try {
                    task.process.write('\x1b');
                } catch (_e) {
                    // Process might already be dead
                }
            }

            this.tasks.delete(taskId);
            try {
                task.process.kill();
            } catch (_e) {
                // Process might already be dead
            }
        }
    }

    getTaskState(taskId: string): TaskState | null {
        const task = this.tasks.get(taskId);
        return task ? task.state : null;
    }

    getTask(taskId: string): BackendTask | undefined {
        const task = this.tasks.get(taskId);
        return task ? this.toBackendTask(task) : undefined;
    }

    getTaskHistory(taskId: string, maxBytes: number = 2 * 1024 * 1024): string | null {
        const task = this.tasks.get(taskId);
        if (!task) return null;

        return this.getCombinedHistory(task, maxBytes);
    }

    setTaskActive(taskId: string, active: boolean): void {
        if (active) {
            // Clear decoded history from all other tasks to free memory
            for (const task of this.tasks.values()) {
                task.isActive = false;
                if (task.id !== taskId && task.previousHistory) {
                    task.previousHistory = undefined;
                    task.lazyHistoryBase64 = undefined;
                    logger.debug('Freed memory for inactive task', { taskId: task.id });
                }
            }
        }

        const task = this.tasks.get(taskId);
        if (task) {
            task.isActive = active;

            if (active) {
                const history = this.getCombinedHistory(task, 2 * 1024 * 1024);
                if (history) {
                    this.emit('task:output', task.id, history);
                }
            }
        }
    }

    hasProcessingIndicators(taskId: string): boolean {
        const task = this.tasks.get(taskId);
        if (!task) return false;

        const recentOutput = this.getRecentOutput(task, 1024);
        // OpenCode processing patterns
        const processingPatterns = [
            /Thinking/i,
            /Working/i,
            /Reading/i,
            /Writing/i,
            /Running/i,
            /Searching/i,
            /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,  // Spinner characters
            /✶|✳|✢|·|✻|✽|✺/,           // Other activity indicators
            /▸|▹|►/,                      // Arrow indicators
            /\.\.\./,                      // Ellipsis (loading)
        ];
        return processingPatterns.some(pattern => pattern.test(recentOutput));
    }

    /**
     * Get the internal task (for TaskSpawner compatibility during migration)
     */
    getInternalTask(taskId: string): InternalTask | undefined {
        return this.tasks.get(taskId);
    }

    /**
     * Update git state on a task
     */
    updateGitState(taskId: string, gitState: TaskGitState): void {
        const task = this.tasks.get(taskId);
        if (task) {
            task.gitState = gitState;
            this.emit('task:stateChanged', this.toBackendTask(task));
        }
    }

    /**
     * Set git state before task execution
     */
    setGitStateBefore(taskId: string, gitStateBefore: Partial<TaskGitState>): void {
        const task = this.tasks.get(taskId);
        if (task) {
            task.gitStateBefore = gitStateBefore;
        }
    }

    /**
     * Get git state before task execution
     */
    getGitStateBefore(taskId: string): Partial<TaskGitState> | undefined {
        const task = this.tasks.get(taskId);
        return task?.gitStateBefore;
    }

    // ============ Private Methods ============

    private startStatePolling(): void {
        if (this.statePollingInterval) return;

        this.statePollingInterval = setInterval(() => {
            this.checkTaskStates();
        }, this.statePollingMs);

        logger.info('State polling started', { intervalMs: this.statePollingMs });
    }

    private checkTaskStates(): void {
        const CONSECUTIVE_CHANGES_FOR_BUSY = 2;

        for (const task of this.tasks.values()) {
            if (task.state === 'exited') continue;
            if (task.stateTransitionLock) continue;

            const currentLength = task.outputHistory.reduce((sum, buf) => sum + buf.length, 0);
            const outputChanged = currentLength !== task.lastOutputLength;
            task.lastOutputLength = currentLength;

            if (outputChanged) {
                task.consecutiveOutputChanges = (task.consecutiveOutputChanges || 0) + 1;

                if (task.state === 'starting') {
                    if (task.hasStartedProcessing) {
                        this.transitionTaskState(task, 'busy', undefined, 'polling: starting with output');
                    }
                } else if (task.state === 'busy') {
                    // Already busy
                } else if (task.state === 'idle' || task.state === 'waiting_input') {
                    if (task.consecutiveOutputChanges >= CONSECUTIVE_CHANGES_FOR_BUSY) {
                        this.transitionTaskState(task, 'busy', undefined, `polling: sustained output (${task.consecutiveOutputChanges} consecutive)`);
                    }
                } else {
                    this.transitionTaskState(task, 'busy', undefined, 'polling: output changed');
                }
            } else {
                task.consecutiveOutputChanges = 0;

                if (task.state === 'busy') {
                    const recentOutput = this.getRecentOutput(task, 2048);
                    const inputType = this.detectWaitingForInput(recentOutput);

                    if (inputType) {
                        this.transitionTaskState(task, 'waiting_input', inputType, `polling: detected ${inputType}`);
                        this.emit('task:waitingInput', task.id, inputType, recentOutput);
                    } else {
                        this.transitionTaskState(task, 'idle', undefined, 'polling: output stable');
                    }
                }
            }
        }
    }

    private transitionTaskState(
        task: InternalTask,
        newState: TaskState,
        waitingInputType: WaitingInputType | undefined,
        reason: string
    ): void {
        if (task.stateTransitionLock) {
            logger.warn('Skipping state transition - lock held', { taskId: task.id, newState, reason });
            return;
        }
        task.stateTransitionLock = true;

        try {
            const oldState = task.state;
            if (oldState === newState && task.waitingInputType === waitingInputType) {
                return;
            }

            logger.debug('Task state transition', { taskId: task.id, oldState, newState, reason });
            task.state = newState;
            task.waitingInputType = waitingInputType;
            this.emit('task:stateChanged', this.toBackendTask(task));
        } finally {
            task.stateTransitionLock = false;
        }
    }

    private setupProcessHandlers(task: InternalTask): void {
        task.process.onData((data: string) => {
            // Filter out SAP AI Core service key warning message
            const filteredData = this.filterServiceKeyWarning(data);
            if (!filteredData) return; // Skip if entire chunk was just the warning

            const buffer = Buffer.from(filteredData, 'utf8');
            task.outputHistory.push(buffer);

            // Limit history to 2MB per task
            const MAX_HISTORY_SIZE = 2 * 1024 * 1024;
            let totalSize = task.outputHistory.reduce((sum, buf) => sum + buf.length, 0);
            while (totalSize > MAX_HISTORY_SIZE && task.outputHistory.length > 0) {
                const removed = task.outputHistory.shift();
                if (removed) totalSize -= removed.length;
            }

            task.lastActivity = new Date();
            const cleanData = this.stripAnsi(filteredData);

            // Try to extract session ID from OpenCode output
            if (!task.sessionId) {
                const sessionId = this.extractSessionId(cleanData);
                if (sessionId) {
                    logger.info('Found session ID', { taskId: task.id, sessionId });
                    task.sessionId = sessionId;
                    this.emit('task:sessionCaptured', task.id, sessionId);
                }
            }

            // Send initial prompt when OpenCode is ready
            // Check accumulated history, not just the current chunk, as output might be split
            const recentOutput = this.getRecentOutput(task, 5000);
            if (!task.initialPromptSent && task.pendingPrompt && this.isReadyForInitialInput(recentOutput)) {
                logger.debug('OpenCode ready, sending prompt', { taskId: task.id });
                task.initialPromptSent = true;
                const prompt = task.pendingPrompt;
                task.pendingPrompt = null;
                task.promptSubmitAttempts = 0;

                // Wait longer (2.5s) to ensure CLI is fully ready and screen is stable
                // Use typeCharByChar: true for "human-like" typing effect
                setTimeout(() => {
                    this.sendInput(task.id, prompt + '\r', { typeCharByChar: true });
                }, 2500);
            }

            // Stream output to active task
            if (task.isActive) {
                this.emit('task:output', task.id, filteredData);
            }
        });

        task.process.onExit(({ exitCode }) => {
            logger.info('Task exited', { taskId: task.id, exitCode });

            if (!this.tasks.has(task.id)) {
                logger.debug('Task already removed, skipping state change', { taskId: task.id });
                return;
            }
            task.state = 'exited';
            this.emit('task:stateChanged', this.toBackendTask(task));
            this.emit('task:exit', task.id, exitCode);
        });
    }

    private sendPromptWithRetry(task: InternalTask, prompt: string, maxRetries = 5): void {
        // Delegate to sendInput for consistent behavior
        this.sendInput(task.id, prompt + '\r');
    }

    private sendEnterWithRetry(
        task: InternalTask,
        retriesLeft: number,
        options: { isInitialPrompt?: boolean; enterKey?: string } = {}
    ): void {
        const { isInitialPrompt = false, enterKey = '\r' } = options;
        const context = isInitialPrompt ? 'initial prompt' : 'input';

        if (retriesLeft <= 0) {
            logger.debug('Max retries reached for Enter', { taskId: task.id, context });
            return;
        }

        task.promptSubmitAttempts = (task.promptSubmitAttempts || 0) + 1;
        logger.debug('Sending Enter', { taskId: task.id, context, attempt: task.promptSubmitAttempts });

        if (!isInitialPrompt && (task.state === 'idle' || task.state === 'waiting_input')) {
            task.state = 'busy';
            task.waitingInputType = undefined;
            this.emit('task:stateChanged', this.toBackendTask(task));
        }

        task.process.write(enterKey);

        setTimeout(() => {
            if (this.hasProcessingIndicators(task.id)) {
                logger.debug('Processing detected after Enter', { taskId: task.id, context, attempt: task.promptSubmitAttempts });
                if (task.state === 'starting' && !task.hasStartedProcessing) {
                    task.hasStartedProcessing = true;
                    task.state = 'busy';
                    this.emit('task:stateChanged', this.toBackendTask(task));
                }
                return;
            }

            logger.debug('No processing indicators, will retry Enter', { taskId: task.id });
            setTimeout(() => this.sendEnterWithRetry(task, retriesLeft - 1, options), 500);
        }, 800);
    }

    private extractSessionId(str: string): string | null {
        // OpenCode session ID format: ses_<alphanumeric> (e.g., ses_4186bf4b8ffeBrRCHWt7nDkIrP)
        const patterns = [
            // OpenCode session ID format (ses_ prefix with alphanumeric ID)
            /(ses_[a-zA-Z0-9]{20,})/,
            // Fallback: session followed by an ID
            /session[:\s]+(ses_[a-zA-Z0-9]+)/i,
            /session[:\s]+([a-zA-Z0-9_-]{20,})/i,
        ];
        for (const pattern of patterns) {
            const match = str.match(pattern);
            if (match) {
                logger.debug('Extracted session ID', { sessionId: match[1], pattern: pattern.source });
                return match[1];
            }
        }
        return null;
    }

    private stripAnsi(str: string): string {
        return str
            .replace(/\x1b\[[0-9;]*m/g, '')
            .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
            .replace(/\x1b\][^\x07]*\x07/g, '')
            .replace(/\x1b[PX^_].*?\x1b\\/g, '')
            .replace(/\x1b\[\?[0-9;]*[hl]/g, '')
            .replace(/\x1b[>=]/g, '')
            .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '')
            .replace(/\r/g, '');
    }

    /**
     * Filter out the SAP AI Core service key warning message from PTY output.
     * The warning appears as an INFO log line like:
     * "[timestamp] INFO (context): Found a service key in environment variable "AICORE_SERVICE_KEY"..."
     *
     * The terminal output contains ANSI escape sequences, so we need to match
     * key phrases that might be split across chunks or mixed with escape codes.
     */
    private filterServiceKeyWarning(data: string): string {
        // Check if this chunk contains any part of the warning message
        // by stripping ANSI codes first for detection
        const cleanData = this.stripAnsi(data);

        // Key phrases from the warning message
        const warningPhrases = [
            'Found a service key in environment variable "AICORE_SERVICE_KEY"',
            'Found a service key in environment variable \\"AICORE_SERVICE_KEY\\"',
            'AICORE_SERVICE_KEY". Using a service key is recommended',
            'Using a service key is recommended for local testing only',
            'Bind the AI Core service to the application for productive usage',
            'for productive usage.',
            'E_KEY". Using a service key',  // Partial match when split
        ];

        // If the clean data contains any warning phrase, filter the whole chunk
        for (const phrase of warningPhrases) {
            if (cleanData.includes(phrase)) {
                // Remove the entire line containing this phrase
                // Split by newlines, filter out lines with warning content, rejoin
                const lines = data.split(/(\r?\n)/);
                const filteredLines = lines.filter(line => {
                    const cleanLine = this.stripAnsi(line);
                    return !warningPhrases.some(p => cleanLine.includes(p));
                });
                return filteredLines.join('');
            }
        }

        return data;
    }

    private isReadyForInitialInput(str: string): boolean {
        // OpenCode ready patterns - adjust based on actual OpenCode TUI output
        return str.includes('opencode') ||
            str.includes('Enter message') ||
            str.includes('Type your message') ||
            str.includes('ask anything') ||
            str.includes('Sisyphus') ||
            str.includes('Claude Opus') ||
            str.includes('>') ||
            str.includes('❯');
    }

    private getRecentOutput(task: InternalTask, maxBytes: number): string {
        const buffers: Buffer[] = [];
        let totalSize = 0;

        for (let i = task.outputHistory.length - 1; i >= 0 && totalSize < maxBytes; i--) {
            const buf = task.outputHistory[i];
            buffers.unshift(buf);
            totalSize += buf.length;
        }

        const combined = Buffer.concat(buffers);
        const str = combined.toString('utf8');
        return this.stripAnsi(str.slice(-maxBytes));
    }

    private detectWaitingForInput(str: string): WaitingInputType | null {
        // Multiple choice question
        if (str.includes('Enter to select') && str.includes('↑/↓ to navigate')) {
            return 'question';
        }

        // Numbered selection menu
        if (str.match(/❯\s*\d+\.\s+\w/) && str.match(/\s+\d+\.\s+\w/)) {
            return 'question';
        }

        // Permission dialog
        if (str.includes('Allow') && str.includes('Deny')) {
            return 'permission';
        }

        // Yes/No confirmation
        if (str.match(/\(y\/n\)/i) || str.match(/\[y\/N\]/i) || str.match(/\[Y\/n\]/i)) {
            return 'confirmation';
        }

        // Question detection in last section
        const sections = str.split(/(?:⏺|─{3,})/);
        const meaningfulSections = sections.filter(s => {
            const trimmed = s.trim();
            if (!trimmed || trimmed === '❯' || /^❯\s*$/.test(trimmed)) return false;
            return true;
        });

        const lastSection = meaningfulSections.length > 0
            ? meaningfulSections[meaningfulSections.length - 1]
            : str;

        const hasQuestionMark = lastSection.includes('?');

        if (hasQuestionMark) {
            const questionPatterns = [
                /\bwhat\b/i, /\bwhich\b/i, /\bhow\b/i, /\bwhere\b/i,
                /\bwhen\b/i, /\bwhy\b/i, /\bwho\b/i, /\bwould you\b/i,
                /\bcould you\b/i, /\bdo you\b/i, /\bshould\b/i, /\bcan you\b/i,
                /\blet me know\b/i, /\bgive me\b/i, /\btell me\b/i, /\bprefer\b/i,
                /\blike to\b/i, /\bwant to\b/i, /\bchoose\b/i, /\bselect\b/i,
                /\bpick\b/i, /\bdecide\b/i, /\bconfirm\b/i, /\bproceed\b/i,
                /\bcontinue\b/i, /\bapproach\b/i, /\boption/i, /\balternative/i,
            ];

            for (const pattern of questionPatterns) {
                if (pattern.test(lastSection)) {
                    return 'question';
                }
            }

            const trimmedSection = lastSection.trim();
            if (trimmedSection.endsWith('?') && trimmedSection.length > 10) {
                return 'question';
            }
        }

        return null;
    }

    private getCombinedHistory(task: InternalTask, maxBytes: number): string | null {
        // Handle lazy loading from file
        if (!task.previousHistory && !task.lazyHistoryBase64) {
            const historyPath = join(this.historyDir, `${task.id}.txt`);
            if (existsSync(historyPath)) {
                try {
                    const stat = statSync(historyPath);
                    const fileSize = stat.size;
                    const maxBase64Size = Math.floor(maxBytes * 1.33);

                    let base64Content: string;

                    if (fileSize > maxBase64Size) {
                        const fd = openSync(historyPath, 'r');
                        const buffer = Buffer.alloc(maxBase64Size);
                        const offset = fileSize - maxBase64Size;
                        readSync(fd, buffer, 0, maxBase64Size, offset);
                        closeSync(fd);
                        base64Content = buffer.toString('utf-8');
                    } else {
                        base64Content = readFileSync(historyPath, 'utf-8');
                    }

                    const decoded = Buffer.from(base64Content, 'base64');

                    if (fileSize > maxBase64Size) {
                        const truncationMessage = Buffer.from('\r\n\x1b[90m─── [History truncated - showing last 2MB] ───\x1b[0m\r\n');
                        task.previousHistory = Buffer.concat([truncationMessage, decoded]);
                    } else {
                        task.previousHistory = decoded;
                    }
                } catch (e) {
                    logger.error('Failed to load history file', { taskId: task.id, error: e });
                }
            }
        }

        // Handle lazy loading from base64
        if (task.lazyHistoryBase64 && !task.previousHistory) {
            try {
                const fullHistory = Buffer.from(task.lazyHistoryBase64, 'base64');
                if (fullHistory.length > maxBytes) {
                    const truncationMessage = Buffer.from('\r\n\x1b[90m─── [History truncated - showing last 2MB] ───\x1b[0m\r\n');
                    task.previousHistory = Buffer.concat([
                        truncationMessage,
                        fullHistory.slice(fullHistory.length - maxBytes)
                    ]);
                } else {
                    task.previousHistory = fullHistory;
                }
                task.lazyHistoryBase64 = undefined;
            } catch (e) {
                logger.error('Failed to lazy load history', { taskId: task.id, error: e });
                task.lazyHistoryBase64 = undefined;
            }
        }

        const parts: Buffer[] = [];
        let totalSize = 0;

        for (let i = task.outputHistory.length - 1; i >= 0 && totalSize < maxBytes; i--) {
            parts.unshift(task.outputHistory[i]);
            totalSize += task.outputHistory[i].length;
        }

        if (task.previousHistory && totalSize < maxBytes) {
            const remainingSpace = maxBytes - totalSize;
            if (task.previousHistory.length <= remainingSpace) {
                parts.unshift(task.previousHistory);
            } else {
                const tailStart = task.previousHistory.length - remainingSpace;
                const truncationMessage = Buffer.from('\r\n\x1b[90m─── [History truncated - showing last 2MB] ───\x1b[0m\r\n');
                parts.unshift(task.previousHistory.slice(tailStart));
                parts.unshift(truncationMessage);
            }
        }

        if (parts.length === 0) return null;

        return Buffer.concat(parts).toString('utf8');
    }

    private toBackendTask(task: InternalTask): BackendTask {
        return {
            id: task.id,
            sessionId: task.sessionId,
            state: task.state,
            workspaceId: task.workspaceId,
            prompt: task.prompt,
            createdAt: task.createdAt,
            lastActivity: task.lastActivity,
            waitingInputType: task.waitingInputType,
            gitState: task.gitState,
            systemPrompt: task.systemPrompt,
        };
    }
}
