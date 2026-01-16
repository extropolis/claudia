import { spawn, IPty } from 'node-pty';
import { EventEmitter } from 'events';
import { Task, TaskState, TaskGitState, WaitingInputType } from '@claudia/shared';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { ConfigStore } from './config-store.js';
import { captureGitStateBefore, captureGitStateAfter, revertTaskChanges } from './git-utils.js';

/**
 * Check if Claude Code CLI is installed and available
 */
export function checkClaudeCodeInstalled(): { installed: boolean; version?: string; error?: string } {
    try {
        const version = execSync('claude --version', { encoding: 'utf8', timeout: 5000 }).trim();
        return { installed: true, version };
    } catch (error) {
        return {
            installed: false,
            error: 'Claude Code CLI is not installed. Please install it from: https://claude.ai/code'
        };
    }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Default persistence file path
const DEFAULT_PERSISTENCE_PATH = join(__dirname, '..', 'tasks.json');

// Persisted task data (no process, just metadata)
interface PersistedTask {
    id: string;
    prompt: string;
    workspaceId: string;
    createdAt: string;
    lastActivity: string;
    lastState: TaskState;
    sessionId: string | null;
    outputHistory?: string;
    gitState?: TaskGitState;
    wasInterrupted?: boolean;  // True if task was busy when backend shut down
    systemPrompt?: string;     // Custom system prompt for this task
}

interface TaskPersistence {
    tasks: PersistedTask[];
    archivedTasks?: PersistedTask[];
}

interface InternalTask extends Task {
    process: IPty;
    outputHistory: Buffer[];
    previousHistory?: Buffer; // Historical output from before reconnection (kept separate)
    isActive: boolean;
    initialPromptSent: boolean;
    pendingPrompt: string | null;
    sessionId: string | null;
    promptSubmitAttempts?: number;
    gitStateBefore?: Partial<TaskGitState>;
    systemPrompt?: string;
}

/**
 * TaskSpawner - Manages Claude Code CLI instances
 *
 * State management is simple:
 * - Task created → busy
 * - PreToolUse hook → busy
 * - Stop hook → idle
 * - Process exit → exited
 */
export class TaskSpawner extends EventEmitter {
    private tasks: Map<string, InternalTask> = new Map();
    private disconnectedTasks: Map<string, PersistedTask> = new Map();
    private sessionToTaskId: Map<string, string> = new Map();
    private persistencePath: string;
    private saveDebounceTimer: NodeJS.Timeout | null = null;
    private configStore: ConfigStore | null = null;
    private pendingSessionCapture: Map<string, { taskId: string; workspaceId: string; startTime: number }> = new Map();
    private autoReconnectPromise: Promise<void> | null = null;
    private isReconnecting: boolean = false;

    constructor(persistencePath?: string, autoReconnect: boolean = true, configStore?: ConfigStore) {
        super();
        this.persistencePath = persistencePath || DEFAULT_PERSISTENCE_PATH;
        this.configStore = configStore || null;
        this.loadPersistedTasks();

        if (autoReconnect && this.disconnectedTasks.size > 0) {
            // Start auto-reconnect immediately but track the promise
            this.autoReconnectPromise = this.autoReconnectTasks();
        }
    }

    /**
     * Wait for auto-reconnect to complete (if in progress)
     * Returns immediately if no reconnection is happening
     */
    async waitForReconnect(): Promise<void> {
        if (this.autoReconnectPromise) {
            await this.autoReconnectPromise;
        }
    }

    /**
     * Check if reconnection is currently in progress
     */
    isReconnectInProgress(): boolean {
        return this.isReconnecting;
    }

    private async autoReconnectTasks(): Promise<void> {
        const disconnectedIds = Array.from(this.disconnectedTasks.keys());
        if (disconnectedIds.length === 0) {
            this.autoReconnectPromise = null;
            return;
        }

        this.isReconnecting = true;
        this.emit('reconnectStart', disconnectedIds.length);
        console.log(`[TaskSpawner] Auto-reconnecting ${disconnectedIds.length} disconnected tasks...`);

        const MAX_RETRIES = 2;
        const failedTasks: string[] = [];

        for (let i = 0; i < disconnectedIds.length; i++) {
            const taskId = disconnectedIds[i];
            const persisted = this.disconnectedTasks.get(taskId);
            if (!persisted) continue;

            console.log(`[TaskSpawner] Auto-reconnecting task ${i + 1}/${disconnectedIds.length}: ${taskId}`);

            let success = false;
            for (let attempt = 1; attempt <= MAX_RETRIES && !success; attempt++) {
                try {
                    const task = this.reconnectTask(taskId);
                    if (task) {
                        console.log(`[TaskSpawner] Successfully reconnected task ${taskId}`);
                        success = true;
                    } else {
                        console.log(`[TaskSpawner] Failed to reconnect task ${taskId} (attempt ${attempt}/${MAX_RETRIES})`);
                        if (attempt < MAX_RETRIES) {
                            await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
                        }
                    }
                } catch (error) {
                    console.error(`[TaskSpawner] Error reconnecting task ${taskId} (attempt ${attempt}/${MAX_RETRIES}):`, error);
                    if (attempt < MAX_RETRIES) {
                        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                    }
                }
            }

            if (!success) {
                failedTasks.push(taskId);
            }

            // Small delay between tasks to avoid overwhelming the system
            if (i < disconnectedIds.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 300));
            }
        }

        this.isReconnecting = false;
        this.autoReconnectPromise = null;
        this.emit('reconnectComplete', {
            total: disconnectedIds.length,
            failed: failedTasks.length,
            failedIds: failedTasks
        });

        if (failedTasks.length > 0) {
            console.log(`[TaskSpawner] Auto-reconnect complete. ${failedTasks.length} task(s) failed to reconnect.`);
        } else {
            console.log(`[TaskSpawner] Auto-reconnect complete. All tasks reconnected successfully.`);
        }
    }

    private loadPersistedTasks(): void {
        try {
            if (existsSync(this.persistencePath)) {
                const data = readFileSync(this.persistencePath, 'utf-8');
                const persistence: TaskPersistence = JSON.parse(data);
                console.log(`[TaskSpawner] Loading ${persistence.tasks.length} persisted tasks`);

                for (const persisted of persistence.tasks) {
                    this.disconnectedTasks.set(persisted.id, persisted);
                }
            }
        } catch (error) {
            console.error('[TaskSpawner] Failed to load persisted tasks:', error);
        }
    }

    private scheduleSave(): void {
        if (this.saveDebounceTimer) {
            clearTimeout(this.saveDebounceTimer);
        }
        this.saveDebounceTimer = setTimeout(() => this.saveTasks(), 500);
    }

    private saveTasks(): void {
        try {
            const tasksToSave: PersistedTask[] = [];

            for (const task of this.tasks.values()) {
                // Combine previous history + current output for persistence
                const buffers: Buffer[] = [];
                if (task.previousHistory) {
                    buffers.push(task.previousHistory);
                }
                buffers.push(...task.outputHistory);
                const historyBuffer = Buffer.concat(buffers);
                const historyBase64 = historyBuffer.toString('base64');

                // Track if task was busy when being saved (will be interrupted)
                const wasInterrupted = task.state === 'busy';

                tasksToSave.push({
                    id: task.id,
                    prompt: task.prompt,
                    workspaceId: task.workspaceId,
                    createdAt: task.createdAt.toISOString(),
                    lastActivity: task.lastActivity.toISOString(),
                    lastState: task.state,
                    sessionId: task.sessionId,
                    outputHistory: historyBase64,
                    wasInterrupted,
                    systemPrompt: task.systemPrompt,
                });
            }

            for (const task of this.disconnectedTasks.values()) {
                tasksToSave.push(task);
            }

            const persistence: TaskPersistence = { tasks: tasksToSave };
            const dir = dirname(this.persistencePath);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }

            writeFileSync(this.persistencePath, JSON.stringify(persistence, null, 2));
            console.log(`[TaskSpawner] Saved ${tasksToSave.length} tasks`);
        } catch (error) {
            console.error('[TaskSpawner] Failed to save tasks:', error);
        }
    }

    private extractSessionId(str: string): string | null {
        const patterns = [
            /session[:\s]+([a-f0-9-]{36})/i,
            /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i,
        ];
        for (const pattern of patterns) {
            const match = str.match(pattern);
            if (match) return match[1];
        }
        return null;
    }

    /**
     * Called when PreToolUse hook fires → set to busy
     */
    handleBusyHook(sessionId: string, toolName?: string): void {
        const taskId = this.sessionToTaskId.get(sessionId);
        if (taskId) {
            const task = this.tasks.get(taskId);
            if (task && task.state !== 'busy') {
                console.log(`[TaskSpawner] Busy hook: task ${taskId} → busy (tool=${toolName || 'unknown'})`);
                task.state = 'busy';
                task.waitingInputType = undefined; // Clear waiting input state
                this.emit('taskStateChanged', this.toPublicTask(task));
            }
        } else {
            // Try to find a non-busy task to associate
            console.log(`[TaskSpawner] Busy hook for unknown session ${sessionId}`);
            for (const task of this.tasks.values()) {
                if (task.state === 'idle' || task.state === 'waiting_input') {
                    console.log(`[TaskSpawner] Associating session ${sessionId} with task ${task.id}`);
                    if (!task.sessionId) {
                        task.sessionId = sessionId;
                        this.sessionToTaskId.set(sessionId, task.id);
                        this.scheduleSave();
                    }
                    task.state = 'busy';
                    task.waitingInputType = undefined; // Clear waiting input state
                    this.emit('taskStateChanged', this.toPublicTask(task));
                    break;
                }
            }
        }
    }

    /**
     * Called when Stop hook fires → check if waiting for input, else set to idle
     */
    handleStopHook(sessionId: string): void {
        const taskId = this.sessionToTaskId.get(sessionId);
        if (taskId) {
            const task = this.tasks.get(taskId);
            if (task) {
                if (!task.sessionId) {
                    task.sessionId = sessionId;
                    this.scheduleSave();
                }

                // Check if Claude is asking a question before marking as idle
                const recentOutput = this.getRecentOutput(task, 2048);
                const inputType = this.detectWaitingForInput(recentOutput);

                if (inputType) {
                    console.log(`[TaskSpawner] Stop hook: task ${taskId} → waiting_input (${inputType})`);
                    task.state = 'waiting_input';
                    task.waitingInputType = inputType;
                    this.emit('taskStateChanged', this.toPublicTask(task));
                    this.emit('taskWaitingInput', task.id, inputType, recentOutput);
                } else {
                    console.log(`[TaskSpawner] Stop hook: task ${taskId} → idle`);
                    task.state = 'idle';
                    task.waitingInputType = undefined;
                    // Capture git state when task becomes idle (task finished doing work)
                    this.captureGitStateAfterTask(taskId);
                    this.emit('taskStateChanged', this.toPublicTask(task));
                }
            }
        } else {
            // Fallback: mark any busy task as idle/waiting_input
            console.log(`[TaskSpawner] Stop hook for unknown session ${sessionId}`);
            for (const task of this.tasks.values()) {
                if (task.state === 'busy') {
                    if (!task.sessionId) {
                        task.sessionId = sessionId;
                        this.sessionToTaskId.set(sessionId, task.id);
                        this.scheduleSave();
                    }

                    // Check if Claude is asking a question
                    const recentOutput = this.getRecentOutput(task, 2048);
                    const inputType = this.detectWaitingForInput(recentOutput);

                    if (inputType) {
                        console.log(`[TaskSpawner] Stop hook: task ${task.id} → waiting_input (${inputType})`);
                        task.state = 'waiting_input';
                        task.waitingInputType = inputType;
                        this.emit('taskStateChanged', this.toPublicTask(task));
                        this.emit('taskWaitingInput', task.id, inputType, recentOutput);
                    } else {
                        task.state = 'idle';
                        task.waitingInputType = undefined;
                        // Capture git state when task becomes idle
                        this.captureGitStateAfterTask(task.id);
                        this.emit('taskStateChanged', this.toPublicTask(task));
                    }
                }
            }
        }
    }

    /**
     * Called when Notification hook fires (kept for compatibility but doesn't change state)
     */
    handleNotificationHook(sessionId: string, notificationType: string): void {
        console.log(`[TaskSpawner] Notification hook: ${notificationType} for session ${sessionId} (ignored)`);
    }

    registerSession(taskId: string, sessionId: string): void {
        this.sessionToTaskId.set(sessionId, taskId);
        const task = this.tasks.get(taskId);
        if (task) {
            task.sessionId = sessionId;
        }
    }

    private workspaceToClaudeFolder(workspacePath: string): string {
        return workspacePath.replace(/\//g, '-');
    }

    private getClaudeProjectsDir(workspacePath: string): string {
        const homeDir = process.env.HOME || process.env.USERPROFILE || '';
        const folderName = this.workspaceToClaudeFolder(workspacePath);
        return join(homeDir, '.claude', 'projects', folderName);
    }

    private startSessionCapture(taskId: string, workspaceId: string): void {
        const claudeDir = this.getClaudeProjectsDir(workspaceId);

        let existingFiles = new Set<string>();
        try {
            if (existsSync(claudeDir)) {
                existingFiles = new Set(readdirSync(claudeDir).filter(f => f.endsWith('.jsonl')));
            }
        } catch (_e) {
            // Directory might not exist yet
        }

        this.pendingSessionCapture.set(taskId, {
            taskId,
            workspaceId,
            startTime: Date.now()
        });

        const checkInterval = setInterval(() => {
            try {
                if (!existsSync(claudeDir)) return;

                const currentFiles = readdirSync(claudeDir).filter(f => f.endsWith('.jsonl'));

                for (const file of currentFiles) {
                    if (!existingFiles.has(file)) {
                        const sessionId = file.replace('.jsonl', '');
                        const task = this.tasks.get(taskId);

                        if (task && !task.sessionId) {
                            console.log(`[TaskSpawner] Captured sessionId ${sessionId} for task ${taskId}`);
                            task.sessionId = sessionId;
                            this.sessionToTaskId.set(sessionId, taskId);
                            this.scheduleSave();
                        }

                        clearInterval(checkInterval);
                        this.pendingSessionCapture.delete(taskId);
                        return;
                    }
                }

                existingFiles = new Set(currentFiles);

                const pending = this.pendingSessionCapture.get(taskId);
                if (pending && Date.now() - pending.startTime > 30000) {
                    console.log(`[TaskSpawner] Session capture timeout for task ${taskId}`);
                    clearInterval(checkInterval);
                    this.pendingSessionCapture.delete(taskId);
                }
            } catch (_e) {
                // Ignore errors
            }
        }, 500);
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

    private isReadyForInitialInput(str: string): boolean {
        return str.includes('Try "') ||
            str.includes('? for shortcuts') ||
            (str.includes('───') && str.includes('❯'));
    }

    /**
     * Get the recent output from a task (for pattern detection)
     */
    private getRecentOutput(task: InternalTask, maxBytes: number): string {
        const buffers: Buffer[] = [];
        let totalSize = 0;

        // Read from end backwards
        for (let i = task.outputHistory.length - 1; i >= 0 && totalSize < maxBytes; i--) {
            const buf = task.outputHistory[i];
            buffers.unshift(buf);
            totalSize += buf.length;
        }

        const combined = Buffer.concat(buffers);
        const str = combined.toString('utf8');
        return this.stripAnsi(str.slice(-maxBytes));
    }

    /**
     * Detect if Claude Code is actively asking the user a question
     * Only returns a type if Claude is genuinely asking something
     * Returns null for normal idle state (waiting for next command)
     */
    private detectWaitingForInput(str: string): WaitingInputType | null {
        // Multiple choice question (like AskUserQuestion tool)
        // Look for: "Enter to select · ↑/↓ to navigate · Esc to cancel"
        if (str.includes('Enter to select') && str.includes('↑/↓ to navigate')) {
            return 'question';
        }

        // Permission dialog - "Allow" / "Deny" patterns (tool permissions)
        if (str.includes('Allow') && str.includes('Deny')) {
            return 'permission';
        }

        // Yes/No confirmation prompts
        if (str.match(/\(y\/n\)/i) || str.match(/\[y\/N\]/i) || str.match(/\[Y\/n\]/i)) {
            return 'confirmation';
        }

        // Check if Claude asked a question anywhere in recent output
        // Exclude known non-question patterns
        const cleanStr = str
            .replace(/\? for shortcuts/g, '')
            .replace(/Try "[^"]*"/g, '')
            .replace(/\/model to try/g, '');

        // Look for question marks that indicate real questions
        const questionMatch = cleanStr.match(/[^.!]\?/);  // ? not after . or !
        if (questionMatch) {
            // Verify it's a real question by checking for question words nearby
            const hasQuestionPattern =
                cleanStr.includes('What ') ||
                cleanStr.includes('Which ') ||
                cleanStr.includes('How ') ||
                cleanStr.includes('Where ') ||
                cleanStr.includes('When ') ||
                cleanStr.includes('Why ') ||
                cleanStr.includes('Who ') ||
                cleanStr.includes('Would you') ||
                cleanStr.includes('Could you') ||
                cleanStr.includes('Do you') ||
                cleanStr.includes('Should ') ||
                cleanStr.includes('Can you') ||
                cleanStr.includes('Let me know') ||
                cleanStr.includes('give me') ||
                cleanStr.includes('tell me');

            if (hasQuestionPattern) {
                return 'question';
            }
        }

        return null;
    }

    /**
     * Detect if Claude is actively busy by checking for busy indicators in output.
     * Claude shows "ctrl+c to interrupt" when it's processing.
     * This is a fallback when hooks don't fire reliably.
     */
    detectBusyFromOutput(taskId: string): boolean {
        const task = this.tasks.get(taskId);
        if (!task) return false;

        // Get recent output (last 4KB should be enough to check)
        const recentOutput = this.getRecentOutput(task, 4096).toLowerCase();

        // Pattern that indicates Claude is actively processing
        // The terminal shows "ctrl+c to interrupt" while Claude is working
        const busyIndicators = [
            'ctrl+c to interrupt',
            'ctrl-c to interrupt',
            '⏳', // spinner/loading indicators
            'thinking',
        ];

        for (const indicator of busyIndicators) {
            if (recentOutput.includes(indicator)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Get the actual state by combining stored state with output-based detection.
     * This helps when hooks miss state transitions.
     * Also updates the internal state when detection corrects it.
     */
    getActualTaskState(taskId: string): TaskState | null {
        const task = this.tasks.get(taskId);
        if (!task) {
            const disconnected = this.disconnectedTasks.get(taskId);
            return disconnected ? 'disconnected' : null;
        }

        // If task is already exited or disconnected, trust that
        if (task.state === 'exited' || task.state === 'disconnected') {
            return task.state;
        }

        // Use output-based detection for busy state
        const isBusyFromOutput = this.detectBusyFromOutput(taskId);

        if (isBusyFromOutput) {
            // Output says busy, so it's busy
            if (task.state !== 'busy') {
                console.log(`[TaskSpawner] Output-based detection: task ${taskId} appears busy (was ${task.state})`);
                task.state = 'busy';
                this.emit('taskStateChanged', this.toPublicTask(task));
            }
            return 'busy';
        }

        // If output doesn't show busy indicators, check for waiting input
        if (task.state === 'busy') {
            // Hooks might have missed the stop - check if waiting for input
            const recentOutput = this.getRecentOutput(task, 2048);
            const inputType = this.detectWaitingForInput(recentOutput);
            if (inputType) {
                console.log(`[TaskSpawner] Output-based detection: task ${taskId} waiting for ${inputType}`);
                task.state = 'waiting_input';
                task.waitingInputType = inputType;
                this.emit('taskStateChanged', this.toPublicTask(task));
                this.emit('taskWaitingInput', task.id, inputType, recentOutput);
                return 'waiting_input';
            }
            // If not busy indicators and not waiting for input, likely idle
            console.log(`[TaskSpawner] Output-based detection: task ${taskId} appears idle (was busy)`);
            task.state = 'idle';
            task.waitingInputType = undefined;
            this.captureGitStateAfterTask(taskId);
            this.emit('taskStateChanged', this.toPublicTask(task));
            return 'idle';
        }

        // Return the stored state
        return task.state;
    }

    private sendPromptWithRetry(task: InternalTask, prompt: string, maxRetries = 3): void {
        console.log(`[TaskSpawner] Writing prompt to PTY: "${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}"`);

        // For short prompts, type character by character for a nice effect
        // For longer prompts (>50 chars), paste directly to avoid slow typing
        if (prompt.length <= 50) {
            let charIndex = 0;
            const writeNextChar = () => {
                if (charIndex < prompt.length) {
                    task.process.write(prompt[charIndex]);
                    charIndex++;
                    setTimeout(writeNextChar, 5);
                } else {
                    setTimeout(() => this.sendEnterWithRetry(task, maxRetries), 600);
                }
            };
            writeNextChar();
        } else {
            // Paste the entire prompt at once, then use retry mechanism to ensure Enter is accepted
            task.process.write(prompt);
            task.promptSubmitAttempts = 0;
            // Small delay to let the prompt be written, then send Enter with retries
            setTimeout(() => this.sendEnterWithRetry(task, maxRetries), 300);
        }
    }

    private sendEnterWithRetry(task: InternalTask, retriesLeft: number): void {
        if (retriesLeft <= 0) {
            console.log(`[TaskSpawner] Max retries reached for task ${task.id}`);
            return;
        }

        task.promptSubmitAttempts = (task.promptSubmitAttempts || 0) + 1;
        console.log(`[TaskSpawner] Sending Enter (attempt ${task.promptSubmitAttempts}) to task ${task.id}`);
        task.process.write('\r');

        setTimeout(() => {
            if (task.state === 'busy') {
                console.log(`[TaskSpawner] Prompt accepted, Claude is busy`);
            } else {
                console.log(`[TaskSpawner] Claude still idle, retrying Enter`);
                setTimeout(() => this.sendEnterWithRetry(task, retriesLeft - 1), 500);
            }
        }, 800);
    }

    private getHookSettings(): string {
        const hooksDir = join(__dirname, '..', 'hooks');
        const stopHook = process.env['CC_HOOK_SCRIPT'] || join(hooksDir, 'stop-notify.sh');
        const preToolUseHook = join(hooksDir, 'pre-tool-use.sh');

        const settings = {
            hooks: {
                PreToolUse: [{
                    hooks: [{
                        type: "command",
                        command: preToolUseHook,
                        timeout: 5
                    }]
                }],
                Stop: [{
                    hooks: [{
                        type: "command",
                        command: stopHook,
                        timeout: 5
                    }]
                }]
            }
        };
        return JSON.stringify(settings);
    }

    async createTask(prompt: string, workspaceId: string, systemPrompt?: string): Promise<Task> {
        const id = `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        const gitStateBefore = await captureGitStateBefore(workspaceId);
        if (gitStateBefore) {
            console.log(`[TaskSpawner] Captured git state: commit=${gitStateBefore.commitBefore?.substring(0, 7)}`);
        }

        const customArgs = process.env['CC_CLAUDE_ARGS']
            ? process.env['CC_CLAUDE_ARGS'].split(' ')
            : [];

        const hookSettings = this.getHookSettings();
        const claudeArgs = [...customArgs, '--settings', hookSettings];

        if (this.configStore?.getSkipPermissions()) {
            claudeArgs.push('--dangerously-skip-permissions');
            console.log(`[TaskSpawner] Skip permissions enabled`);
        }

        // Add custom system prompt if provided
        if (systemPrompt && systemPrompt.trim()) {
            claudeArgs.push('--system-prompt', systemPrompt.trim());
            console.log(`[TaskSpawner] Using custom system prompt`);
        }

        console.log(`[TaskSpawner] Creating task ${id} in ${workspaceId}`);
        console.log(`[TaskSpawner] Command: claude ${claudeArgs.join(' ')}`);

        const ptyProcess = spawn('claude', claudeArgs, {
            name: 'xterm-256color',
            cols: 120,
            rows: 40,
            cwd: workspaceId,
            env: process.env as { [key: string]: string },
        });

        const now = new Date();
        const task: InternalTask = {
            id,
            prompt,
            workspaceId,
            process: ptyProcess,
            state: 'busy',  // Start as busy
            outputHistory: [],
            lastActivity: now,
            createdAt: now,
            isActive: false,
            initialPromptSent: false,
            pendingPrompt: prompt,
            sessionId: null,
            gitStateBefore: gitStateBefore || undefined,
            systemPrompt: systemPrompt?.trim() || undefined,
        };

        this.setupProcessHandlers(task);
        this.tasks.set(id, task);
        this.scheduleSave();
        this.emit('taskCreated', this.toPublicTask(task));
        this.startSessionCapture(id, workspaceId);

        return this.toPublicTask(task);
    }

    private setupProcessHandlers(task: InternalTask): void {
        task.process.onData((data: string) => {
            const buffer = Buffer.from(data, 'utf8');
            task.outputHistory.push(buffer);

            // Limit history to 10MB
            const MAX_HISTORY_SIZE = 10 * 1024 * 1024;
            let totalSize = task.outputHistory.reduce((sum, buf) => sum + buf.length, 0);
            while (totalSize > MAX_HISTORY_SIZE && task.outputHistory.length > 0) {
                const removed = task.outputHistory.shift();
                if (removed) totalSize -= removed.length;
            }

            task.lastActivity = new Date();
            const cleanData = this.stripAnsi(data);

            // Try to extract session ID
            if (!task.sessionId) {
                const sessionId = this.extractSessionId(cleanData);
                if (sessionId) {
                    console.log(`[TaskSpawner] Found session ID: ${sessionId}`);
                    task.sessionId = sessionId;
                    this.sessionToTaskId.set(sessionId, task.id);
                }
            }

            // Send initial prompt when Claude is ready
            if (!task.initialPromptSent && task.pendingPrompt && this.isReadyForInitialInput(cleanData)) {
                console.log(`[TaskSpawner] Claude ready, sending prompt`);
                task.initialPromptSent = true;
                const prompt = task.pendingPrompt;
                task.pendingPrompt = null;
                task.promptSubmitAttempts = 0;

                setTimeout(() => this.sendPromptWithRetry(task, prompt), 1200);
            }

            // Detect if Claude is waiting for user input
            // Check the recent output (last ~2KB) for input patterns
            const recentOutput = this.getRecentOutput(task, 2048);
            const inputType = this.detectWaitingForInput(recentOutput);

            if (inputType && task.state !== 'waiting_input') {
                console.log(`[TaskSpawner] Task ${task.id} waiting for input: ${inputType}`);
                task.state = 'waiting_input';
                task.waitingInputType = inputType;
                this.emit('taskStateChanged', this.toPublicTask(task));
                this.emit('taskWaitingInput', task.id, inputType, recentOutput);
            }

            // Stream output to active task
            if (task.isActive) {
                this.emit('taskOutput', task.id, data);
            }
        });

        task.process.onExit(({ exitCode }) => {
            console.log(`[TaskSpawner] Task ${task.id} exited with code ${exitCode}`);
            // Only emit events if task still exists in map (not being destroyed)
            if (!this.tasks.has(task.id)) {
                console.log(`[TaskSpawner] Task ${task.id} already removed, skipping state change`);
                return;
            }
            task.state = 'exited';
            this.scheduleSave();
            this.emit('taskStateChanged', this.toPublicTask(task));
            this.emit('taskExit', task.id, exitCode);
        });
    }

    private toPublicTask(task: InternalTask): Task {
        return {
            id: task.id,
            prompt: task.prompt,
            state: task.state,
            workspaceId: task.workspaceId,
            lastActivity: task.lastActivity,
            createdAt: task.createdAt,
            gitState: task.gitState,
            waitingInputType: task.waitingInputType,
            systemPrompt: task.systemPrompt,
        };
    }

    async captureGitStateAfterTask(taskId: string): Promise<void> {
        const task = this.tasks.get(taskId);
        if (!task || !task.gitStateBefore) return;

        try {
            const gitState = await captureGitStateAfter(task.workspaceId, task.gitStateBefore);
            task.gitState = gitState;
            this.scheduleSave();
            console.log(`[TaskSpawner] Git state after task: ${gitState.filesModified.length} files modified`);
            this.emit('taskStateChanged', this.toPublicTask(task));
        } catch (error) {
            console.error(`[TaskSpawner] Failed to capture git state:`, error);
        }
    }

    async revertTask(taskId: string, cleanUntracked: boolean = false): Promise<{ success: boolean; error?: string; filesReverted: string[] }> {
        const task = this.tasks.get(taskId);
        const persisted = this.disconnectedTasks.get(taskId);

        const gitState = task?.gitState || persisted?.gitState;
        const workspaceId = task?.workspaceId || persisted?.workspaceId;

        if (!gitState) {
            return { success: false, error: 'No git state available', filesReverted: [] };
        }
        if (!workspaceId) {
            return { success: false, error: 'Cannot find workspace', filesReverted: [] };
        }
        if (!gitState.canRevert) {
            return { success: false, error: 'Cannot revert: uncommitted changes existed before task', filesReverted: [] };
        }

        console.log(`[TaskSpawner] Reverting task ${taskId}`);
        const result = await revertTaskChanges(workspaceId, gitState, cleanUntracked);

        if (result.success) {
            gitState.revertedAt = new Date().toISOString();
            gitState.canRevert = false;

            if (task) task.gitState = gitState;
            if (persisted) persisted.gitState = gitState;

            this.scheduleSave();
            if (task) this.emit('taskStateChanged', this.toPublicTask(task));
        }

        return result;
    }

    getTask(taskId: string): InternalTask | undefined {
        return this.tasks.get(taskId);
    }

    getDisconnectedTask(taskId: string): { id: string; workspaceId: string; sessionId: string | null } | undefined {
        const persisted = this.disconnectedTasks.get(taskId);
        if (persisted) {
            return {
                id: persisted.id,
                workspaceId: persisted.workspaceId,
                sessionId: persisted.sessionId
            };
        }
        return undefined;
    }

    setTaskActive(taskId: string, active: boolean): void {
        if (active) {
            for (const task of this.tasks.values()) {
                task.isActive = false;
            }
        }

        if (active && this.disconnectedTasks.has(taskId)) {
            console.log(`[TaskSpawner] Auto-reconnecting task ${taskId}`);
            const reconnectedTask = this.reconnectTask(taskId);
            if (reconnectedTask) {
                const task = this.tasks.get(taskId);
                if (task) {
                    task.isActive = true;
                    this.emit('tasksUpdated');

                    // Send combined history: previous + current
                    const history = this.getCombinedHistory(task);
                    if (history) {
                        this.emit('taskRestore', task.id, history);
                    }
                }
            }
            return;
        }

        const task = this.tasks.get(taskId);
        if (task) {
            task.isActive = active;

            if (active) {
                // Send combined history: previous + current
                const history = this.getCombinedHistory(task);
                if (history) {
                    this.emit('taskRestore', task.id, history);
                }
            }
        }
    }

    /**
     * Get combined history: previous session output + current session output
     * This ensures historical terminal output is shown before live output
     */
    private getCombinedHistory(task: InternalTask): string | null {
        const parts: string[] = [];

        // Add previous history first (from before reconnection)
        if (task.previousHistory) {
            parts.push(task.previousHistory.toString('utf8'));
        }

        // Then add current session output
        if (task.outputHistory.length > 0) {
            parts.push(task.outputHistory.map(buf => buf.toString('utf8')).join(''));
        }

        return parts.length > 0 ? parts.join('') : null;
    }

    writeToTask(taskId: string, data: string): void {
        const task = this.tasks.get(taskId);
        if (task) {
            // User sending input → mark as busy (from idle or waiting_input)
            const isEnterKey = data === '\r' || data === '\n' || data.includes('\r');
            if ((task.state === 'idle' || task.state === 'waiting_input') && isEnterKey) {
                task.state = 'busy';
                task.waitingInputType = undefined;
                this.emit('taskStateChanged', this.toPublicTask(task));
            }
            task.process.write(data);
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
            console.log(`[TaskSpawner] Interrupting task ${taskId}`);
            task.process.write('\x1b');
            return true;
        }
        return false;
    }

    destroyTask(taskId: string): void {
        console.log(`[TaskSpawner] destroyTask called for ${taskId}`);
        let destroyed = false;
        let source = '';

        const task = this.tasks.get(taskId);
        if (task) {
            console.log(`[TaskSpawner] Found task ${taskId} in live tasks (state: ${task.state})`);
            // Delete from map FIRST to prevent onExit handler from emitting state changes
            this.tasks.delete(taskId);
            try {
                task.process.kill();
            } catch (_e) {
                // Process might already be dead
            }
            destroyed = true;
            source = 'live';
        }

        if (this.disconnectedTasks.has(taskId)) {
            console.log(`[TaskSpawner] Found task ${taskId} in disconnected tasks`);
            this.disconnectedTasks.delete(taskId);
            destroyed = true;
            source = source ? 'both' : 'disconnected';
        }

        // Only emit once, regardless of which map(s) the task was in
        if (destroyed) {
            console.log(`[TaskSpawner] Task ${taskId} destroyed from ${source}, emitting event`);
            this.scheduleSave();
            this.emit('taskDestroyed', taskId);
        } else {
            console.log(`[TaskSpawner] Task ${taskId} not found in any map!`);
        }
    }

    archiveTask(taskId: string): void {
        // Archive removes task from active list but keeps it in persistent storage
        // For now, it behaves the same as destroy - just removes the task
        // TODO: In the future, could move to an archived state instead of deleting
        let archived = false;
        let wasLive = false;

        const task = this.tasks.get(taskId);
        if (task) {
            // Delete from map FIRST to prevent onExit handler from emitting state changes
            this.tasks.delete(taskId);
            try {
                task.process.kill();
            } catch (_e) {
                // Process might already be dead
            }
            archived = true;
            wasLive = true;
        }

        if (this.disconnectedTasks.has(taskId)) {
            this.disconnectedTasks.delete(taskId);
            archived = true;
        }

        // Only emit once, regardless of which map(s) the task was in
        if (archived) {
            this.scheduleSave();
            this.emit('taskDestroyed', taskId);
            console.log(`[TaskSpawner] Archived (destroyed) ${wasLive ? 'live' : 'disconnected'} task ${taskId}`);
        }
    }

    getAllTasks(): Task[] {
        const liveTasks = Array.from(this.tasks.values()).map(task => this.toPublicTask(task));

        const disconnectedTasks = Array.from(this.disconnectedTasks.values()).map(persisted => ({
            id: persisted.id,
            prompt: persisted.prompt,
            // Show 'interrupted' state if task was busy when killed, otherwise 'disconnected'
            state: (persisted.wasInterrupted ? 'interrupted' : 'disconnected') as TaskState,
            workspaceId: persisted.workspaceId,
            createdAt: new Date(persisted.createdAt),
            lastActivity: new Date(persisted.lastActivity),
        }));

        return [...liveTasks, ...disconnectedTasks];
    }

    reconnectTask(taskId: string): Task | null {
        const persisted = this.disconnectedTasks.get(taskId);
        if (!persisted) {
            console.log(`[TaskSpawner] Cannot reconnect: task ${taskId} not found`);
            return null;
        }

        const customArgs = process.env['CC_CLAUDE_ARGS']
            ? process.env['CC_CLAUDE_ARGS'].split(' ')
            : [];

        const hookSettings = this.getHookSettings();
        const claudeArgs = [...customArgs, '--settings', hookSettings];

        if (this.configStore?.getSkipPermissions()) {
            claudeArgs.push('--dangerously-skip-permissions');
        }

        if (persisted.sessionId) {
            claudeArgs.push('--resume', persisted.sessionId);
            console.log(`[TaskSpawner] Reconnecting task ${taskId} with session ${persisted.sessionId}`);
        } else {
            console.log(`[TaskSpawner] Reconnecting task ${taskId} (fresh start)`);
        }

        const ptyProcess = spawn('claude', claudeArgs, {
            name: 'xterm-256color',
            cols: 120,
            rows: 40,
            cwd: persisted.workspaceId,
            env: process.env as { [key: string]: string },
        });

        const now = new Date();

        // Restore previous history as a separate buffer (not mixed with live output)
        let previousHistory: Buffer | undefined;
        if (persisted.outputHistory) {
            try {
                previousHistory = Buffer.from(persisted.outputHistory, 'base64');
                console.log(`[TaskSpawner] Restored ${previousHistory.length} bytes of history`);
            } catch (_e) {
                console.error(`[TaskSpawner] Failed to restore history`);
            }
        }

        // Create a separator message for the live output stream
        const resumeMessage = persisted.sessionId
            ? `\r\n\x1b[90m─── Resuming session ${persisted.sessionId} ───\x1b[0m\r\n\r\n`
            : `\r\n\x1b[90m─── Session reconnected ───\x1b[0m\r\n\r\n`;

        const task: InternalTask = {
            id: persisted.id,
            prompt: persisted.prompt,
            workspaceId: persisted.workspaceId,
            process: ptyProcess,
            state: 'idle',  // Start as idle on reconnect
            outputHistory: [Buffer.from(resumeMessage)], // Start fresh, only resume message
            previousHistory, // Keep historical output separate
            lastActivity: now,
            createdAt: new Date(persisted.createdAt),
            isActive: false,
            initialPromptSent: true,
            pendingPrompt: null,
            sessionId: persisted.sessionId,
        };

        this.setupProcessHandlers(task);
        this.tasks.set(task.id, task);

        if (persisted.sessionId) {
            this.sessionToTaskId.set(persisted.sessionId, task.id);
        }

        this.disconnectedTasks.delete(taskId);
        this.scheduleSave();

        this.emit('taskStateChanged', this.toPublicTask(task));
        return this.toPublicTask(task);
    }

    destroy(): void {
        this.saveTasks();

        for (const task of this.tasks.values()) {
            try {
                task.process.kill();
            } catch (_e) {
                // Process might already be dead
            }
        }
        this.tasks.clear();
    }

    saveNow(): void {
        if (this.saveDebounceTimer) {
            clearTimeout(this.saveDebounceTimer);
            this.saveDebounceTimer = null;
        }
        this.saveTasks();
    }
}
