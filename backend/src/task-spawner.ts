import { spawn, IPty } from 'node-pty';
import { EventEmitter } from 'events';
import { Task, TaskState, TaskGitState, WaitingInputType } from '@claudia/shared';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, appendFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import { execSync } from 'child_process';
import { ConfigStore } from './config-store.js';
import { captureGitStateBefore, captureGitStateAfter, revertTaskChanges } from './git-utils.js';
import { sanitizePrompt } from './validation.js';
import { createLogger } from './logger.js';

const logger = createLogger('[TaskSpawner]');

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
    shouldContinue?: boolean;  // True if task should auto-continue on reconnect
}

// Lightweight metadata for archived tasks (no outputHistory - loaded lazily from disk)
interface ArchivedTaskMetadata {
    id: string;
    prompt: string;
    workspaceId: string;
    createdAt: string;
    lastActivity: string;
    sessionId: string | null;
    gitState?: TaskGitState;
    systemPrompt?: string;
    // Size of output history in bytes (for display purposes)
    historySize?: number;
}

interface TaskPersistence {
    tasks: PersistedTask[];
    // Archived tasks now only contain metadata (history stored separately)
    archivedTasks?: ArchivedTaskMetadata[];
}

interface InternalTask extends Task {
    process: IPty;
    outputHistory: Buffer[];
    previousHistory?: Buffer; // Historical output from before reconnection (kept separate)
    lazyHistoryBase64?: string; // Base64-encoded history for lazy loading (memory efficient)
    isActive: boolean;
    initialPromptSent: boolean;
    pendingPrompt: string | null;
    sessionId: string | null;
    promptSubmitAttempts?: number;
    gitStateBefore?: Partial<TaskGitState>;
    systemPrompt?: string;
    lastOutputLength: number; // Track output size for state polling
    hasStartedProcessing: boolean; // True once Claude actually starts processing (output changes after prompt)
    stateTransitionLock?: boolean; // Prevents concurrent state transitions during polling
    shouldContinue?: boolean; // True if this is a reconnected task that should auto-continue
    continuationSent?: boolean; // True if continuation prompt has been sent
    consecutiveOutputChanges?: number; // Count of consecutive polls with output changes (for idle→busy debouncing)
}

/**
 * TaskSpawner - Manages Claude Code CLI instances
 *
 * State management (polling-based detection):
 * - Polls every 3 seconds to check if output has changed
 * - Output changed since last check → busy
 * - Output stable → idle OR waiting_input (via output parsing)
 * - Process exit → exited
 */
/**
 * TaskSpawner - Manages Claude Code CLI instances
 *
 * Responsible for:
 * - Spawning and managing PTY processes for Claude Code CLI
 * - Tracking task state through polling-based detection
 * - Persisting task data across server restarts
 * - Managing session capture and reconnection
 *
 * Events emitted:
 * - 'taskCreated': When a new task is created
 * - 'taskStateChanged': When a task's state changes
 * - 'taskOutput': When a task produces output
 * - 'taskDestroyed': When a task is destroyed
 * - 'taskWaitingInput': When a task is waiting for user input
 * - 'reconnectStart': When auto-reconnection begins
 * - 'reconnectComplete': When auto-reconnection finishes
 */
export class TaskSpawner extends EventEmitter {
    private tasks: Map<string, InternalTask> = new Map();
    private disconnectedTasks: Map<string, PersistedTask> = new Map();
    private archivedTasks: Map<string, ArchivedTaskMetadata> = new Map();
    private persistencePath: string;
    private saveDebounceTimer: NodeJS.Timeout | null = null;
    private configStore: ConfigStore | null = null;
    private pendingSessionCapture: Map<string, { taskId: string; workspaceId: string; startTime: number }> = new Map();
    /** Map of task IDs to their session capture interval timers */
    private sessionCaptureIntervals: Map<string, NodeJS.Timeout> = new Map();
    private autoReconnectPromise: Promise<void> | null = null;
    private isReconnecting: boolean = false;
    private sessionToTaskId: Map<string, string> = new Map(); // Map session IDs to task IDs

    // State polling (replaces hooks and output-based streaming detection)
    private statePollingInterval: NodeJS.Timeout | null = null;
    /** Polling interval in ms - configurable via STATE_POLLING_MS env var */
    private readonly statePollingMs: number;

    /**
     * Creates a new TaskSpawner instance
     * @param persistencePath - Optional path for task persistence file (default: tasks.json in backend dir)
     * @param autoReconnect - Whether to automatically reconnect disconnected tasks on startup
     * @param configStore - Optional config store for reading settings
     */
    constructor(persistencePath?: string, autoReconnect: boolean = true, configStore?: ConfigStore) {
        super();
        this.persistencePath = persistencePath || DEFAULT_PERSISTENCE_PATH;
        this.configStore = configStore || null;

        // Configurable polling interval via environment variable (default: 3000ms)
        const envPollingMs = parseInt(process.env.STATE_POLLING_MS || '', 10);
        this.statePollingMs = !isNaN(envPollingMs) && envPollingMs >= 500 ? envPollingMs : 3000;

        this.loadPersistedTasks();

        // Start state polling
        this.startStatePolling();

        if (autoReconnect && this.disconnectedTasks.size > 0) {
            // Start auto-reconnect immediately but track the promise
            this.autoReconnectPromise = this.autoReconnectTasks();
        }
    }

    /**
     * Get the directory for archived task histories
     */
    private getTaskHistoryPath(taskId: string): string {
        return join(this.getHistoryDir(), `${taskId}.txt`);
    }

    /**
     * Get the directory for task histories
     */
    private getHistoryDir(): string {
        return join(dirname(this.persistencePath), 'task-histories');
    }

    /**
     * Get the directory for archived task histories
     */
    private getArchivedHistoryDir(): string {
        return join(dirname(this.persistencePath), 'archived-histories');
    }

    /**
     * Get the file path for an archived task's history
     */
    private getArchivedHistoryPath(taskId: string): string {
        return join(this.getArchivedHistoryDir(), `${taskId}.txt`);
    }

    /**
     * Start polling to check task states at the configured interval
     */
    private startStatePolling(): void {
        if (this.statePollingInterval) return;

        this.statePollingInterval = setInterval(() => {
            this.checkTaskStates();
        }, this.statePollingMs);

        logger.info(`State polling started`, { intervalMs: this.statePollingMs });
    }

    /**
     * Check all tasks for state changes based on output changes.
     * Uses a per-task lock to prevent race conditions from concurrent state transitions.
     */
    private checkTaskStates(): void {
        // Number of consecutive polls with output changes required to transition idle → busy
        // This prevents spurious transitions from one-time terminal redraws (resize, focus, etc.)
        const CONSECUTIVE_CHANGES_FOR_BUSY = 2;

        if (process.env.DEBUG_POLLING) {
            console.log(`[TaskSpawner] checking state for ${this.tasks.size} tasks`);
        }

        for (const task of this.tasks.values()) {
            if (task.state === 'exited') continue;

            // Skip if this task is already being transitioned (prevents race conditions)
            if (task.stateTransitionLock) {
                continue;
            }

            const currentLength = task.outputHistory.reduce((sum, buf) => sum + buf.length, 0);
            const outputChanged = currentLength !== task.lastOutputLength;
            task.lastOutputLength = currentLength;

            if (outputChanged) {
                // Track consecutive output changes for idle → busy debouncing
                task.consecutiveOutputChanges = (task.consecutiveOutputChanges || 0) + 1;

                // Output is changing → busy (or starting → busy if task actually started)
                if (task.state === 'starting') {
                    // Task is starting and we got output - check if it's real processing or just TUI setup
                    if (task.hasStartedProcessing) {
                        this.transitionTaskState(task, 'busy', undefined, 'polling: starting with output');
                    }
                    // If not hasStartedProcessing, leave in 'starting' state - it's just TUI setup
                } else if (task.state === 'busy') {
                    // Already busy, no transition needed
                } else if (task.state === 'idle' || task.state === 'waiting_input') {
                    // Only transition idle/waiting_input → busy if we've seen consecutive output changes
                    // This prevents one-time TUI redraws (from resize, focus, etc.) from causing spurious busy state
                    if (task.consecutiveOutputChanges >= CONSECUTIVE_CHANGES_FOR_BUSY) {
                        this.transitionTaskState(task, 'busy', undefined, `polling: sustained output (${task.consecutiveOutputChanges} consecutive)`);
                    }
                    // Single output change is likely just terminal housekeeping - wait for sustained activity
                } else {
                    // Other states (e.g., disconnected) - transition to busy on any output
                    this.transitionTaskState(task, 'busy', undefined, 'polling: output changed');
                }
            } else {
                // Reset consecutive output counter when output is stable
                task.consecutiveOutputChanges = 0;

                // Output stable → check if idle or waiting_input (but only for tasks that have started)
                if (task.state === 'busy') {
                    const recentOutput = this.getRecentOutput(task, 2048);
                    const inputType = this.detectWaitingForInput(recentOutput);

                    if (inputType) {
                        this.transitionTaskState(task, 'waiting_input', inputType, `polling: detected ${inputType}`);
                        this.emit('taskWaitingInput', task.id, inputType, recentOutput);
                    } else {
                        this.transitionTaskState(task, 'idle', undefined, 'polling: output stable');
                        this.captureGitStateAfterTask(task.id);
                    }
                }
                // Don't transition 'starting' → 'idle' - leave it in starting until Enter is accepted
            }
        }
    }

    /**
     * Safely transition a task's state with locking to prevent race conditions.
     * @param task - The task to transition
     * @param newState - The new state
     * @param waitingInputType - Optional waiting input type (only for 'waiting_input' state)
     * @param reason - Reason for the transition (for logging)
     */
    private transitionTaskState(
        task: InternalTask,
        newState: TaskState,
        waitingInputType: WaitingInputType | undefined,
        reason: string
    ): void {
        // Acquire lock
        if (task.stateTransitionLock) {
            logger.warn('Skipping state transition - lock held', { taskId: task.id, newState, reason });
            return;
        }
        task.stateTransitionLock = true;

        try {
            const oldState = task.state;
            if (oldState === newState && task.waitingInputType === waitingInputType) {
                // No actual change, skip
                return;
            }

            console.log(`[TaskSpawner] Polling: task ${task.id} → ${newState} (${reason})`);
            task.state = newState;
            task.waitingInputType = waitingInputType;
            this.emit('taskStateChanged', this.toPublicTask(task));
        } finally {
            // Release lock
            task.stateTransitionLock = false;
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

        // Only auto-reconnect tasks that were interrupted (busy) or have shouldContinue set
        // Other tasks will stay disconnected and reconnect on-demand when selected
        const tasksToReconnect = disconnectedIds.filter(id => {
            const task = this.disconnectedTasks.get(id);
            return task && (task.wasInterrupted || task.shouldContinue);
        });

        if (tasksToReconnect.length === 0) {
            console.log(`[TaskSpawner] No interrupted tasks to auto-reconnect. ${disconnectedIds.length} tasks matching lazy load criteria.`);
            this.autoReconnectPromise = null;
            return;
        }

        this.isReconnecting = true;
        this.emit('reconnectStart', tasksToReconnect.length);
        console.log(`[TaskSpawner] Auto-reconnecting ${tasksToReconnect.length} interrupted tasks (of ${disconnectedIds.length} total)...`);

        const MAX_RETRIES = 2;
        const failedTasks: string[] = [];

        for (let i = 0; i < tasksToReconnect.length; i++) {
            const taskId = tasksToReconnect[i];
            const persisted = this.disconnectedTasks.get(taskId);
            if (!persisted) continue;

            console.log(`[TaskSpawner] Auto-reconnecting task ${i + 1}/${tasksToReconnect.length}: ${taskId}`);

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
                // Use 'any' for raw persistence to handle migration from old format
                const persistence = JSON.parse(data) as { tasks: PersistedTask[]; archivedTasks?: any[] };
                console.log(`[TaskSpawner] Loading ${persistence.tasks.length} persisted tasks`);

                // Ensure history directory exists
                const historyDir = this.getHistoryDir();
                if (!existsSync(historyDir)) {
                    mkdirSync(historyDir, { recursive: true });
                }

                for (const persisted of persistence.tasks) {
                    // MIGRATION: If task has outputHistory string, move it to file
                    if (persisted.outputHistory && typeof persisted.outputHistory === 'string') {
                        try {
                            writeFileSync(this.getTaskHistoryPath(persisted.id), persisted.outputHistory);
                            if (process.env.DEBUG_TASKS) {
                                console.log(`[TaskSpawner] Migrated history for task ${persisted.id} to file`);
                            }
                            // Remove from object to free memory
                            delete persisted.outputHistory;
                        } catch (e) {
                            console.error(`[TaskSpawner] Failed to migrate history for task ${persisted.id}:`, e);
                        }
                    }

                    // Debug: log each task being loaded
                    if (process.env.DEBUG_TASKS) {
                        console.log(`[TaskSpawner] Loading task ${persisted.id}`);
                    }
                    this.disconnectedTasks.set(persisted.id, persisted);
                }

                // Load archived tasks - migrate old format if needed
                if (persistence.archivedTasks) {
                    console.log(`[TaskSpawner] Loading ${persistence.archivedTasks.length} archived tasks (metadata only)`);
                    let migratedCount = 0;
                    const historyDir = this.getArchivedHistoryDir();

                    for (const archived of persistence.archivedTasks) {
                        // Migration: if archived task has embedded outputHistory, save to disk
                        if (archived.outputHistory && typeof archived.outputHistory === 'string') {
                            // Save history to disk
                            if (!existsSync(historyDir)) {
                                mkdirSync(historyDir, { recursive: true });
                            }
                            try {
                                writeFileSync(this.getArchivedHistoryPath(archived.id), archived.outputHistory);
                                migratedCount++;
                            } catch (e) {
                                console.error(`[TaskSpawner] Failed to migrate history for ${archived.id}:`, e);
                            }
                        }

                        // Store only metadata (no outputHistory in memory)
                        const metadata: ArchivedTaskMetadata = {
                            id: archived.id,
                            prompt: archived.prompt,
                            workspaceId: archived.workspaceId,
                            createdAt: archived.createdAt,
                            lastActivity: archived.lastActivity,
                            sessionId: archived.sessionId,
                            gitState: archived.gitState,
                            systemPrompt: archived.systemPrompt,
                            historySize: archived.outputHistory
                                ? Math.floor(archived.outputHistory.length * 0.75)
                                : archived.historySize || 0,
                        };
                        this.archivedTasks.set(archived.id, metadata);
                    }

                    if (migratedCount > 0) {
                        console.log(`[TaskSpawner] Migrated ${migratedCount} archived tasks to lazy loading format`);
                        // Save immediately to persist the migration (removes outputHistory from JSON)
                        this.saveTasks();
                    }
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
                // Save history to separate file
                const historyPath = this.getTaskHistoryPath(task.id);
                try {
                    const buffers: Buffer[] = [];

                    // If we have base history loaded, we can overwrite safely
                    if (task.previousHistory) {
                        buffers.push(task.previousHistory);
                        if (task.outputHistory.length > 0) {
                            buffers.push(...task.outputHistory);
                        }
                        const fullHistory = Buffer.concat(buffers);
                        writeFileSync(historyPath, fullHistory.toString('base64'));
                    }
                    // If we DON'T have base history, check if file exists
                    else if (!existsSync(historyPath)) {
                        // New file, safe to write current output
                        if (task.outputHistory.length > 0) {
                            const fullHistory = Buffer.concat(task.outputHistory);
                            writeFileSync(historyPath, fullHistory.toString('base64'));
                        }
                    }
                    // Else: File exists but unloaded history. Skip to avoid data loss.
                    // (History will be saved when task is viewed)
                } catch (e) {
                    console.error(`[TaskSpawner] Failed to save history for task ${task.id}:`, e);
                }

                // Track if task was busy when being saved (will be interrupted)
                const wasInterrupted = task.state === 'busy' || task.state === 'starting';
                // Tasks that were busy should auto-continue on restart
                const shouldContinue = wasInterrupted && task.sessionId != null;

                tasksToSave.push({
                    id: task.id,
                    prompt: task.prompt,
                    workspaceId: task.workspaceId,
                    createdAt: task.createdAt.toISOString(),
                    lastActivity: task.lastActivity.toISOString(),
                    lastState: task.state,
                    sessionId: task.sessionId,
                    // outputHistory removed from JSON
                    wasInterrupted,
                    shouldContinue,
                    systemPrompt: task.systemPrompt,
                });
            }

            for (const task of this.disconnectedTasks.values()) {
                tasksToSave.push(task);
            }

            // Archived tasks metadata (history is stored separately in files)
            const archivedTasksToSave: ArchivedTaskMetadata[] = Array.from(this.archivedTasks.values());

            const persistence: TaskPersistence = {
                tasks: tasksToSave,
                archivedTasks: archivedTasksToSave
            };
            const dir = dirname(this.persistencePath);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }

            writeFileSync(this.persistencePath, JSON.stringify(persistence, null, 2));
            console.log(`[TaskSpawner] Saved ${tasksToSave.length} tasks, ${archivedTasksToSave.length} archived (metadata only)`);
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

    private workspaceToClaudeFolder(workspacePath: string): string {
        return workspacePath.replace(/\//g, '-');
    }

    private getClaudeProjectsDir(workspacePath: string): string {
        const homeDir = process.env.HOME || process.env.USERPROFILE || '';
        const folderName = this.workspaceToClaudeFolder(workspacePath);
        return join(homeDir, '.claude', 'projects', folderName);
    }

    /**
     * Starts monitoring for session file creation
     * Watches the Claude projects directory for new .jsonl files
     * @param taskId - The task ID to capture session for
     * @param workspaceId - The workspace path
     */
    private startSessionCapture(taskId: string, workspaceId: string): void {
        // Clear any existing capture for this task to prevent race conditions
        this.clearSessionCapture(taskId);

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
                            logger.info(`Captured session for task`, { taskId, sessionId });
                            task.sessionId = sessionId;
                            this.sessionToTaskId.set(sessionId, taskId);
                            this.scheduleSave();
                        }

                        this.clearSessionCapture(taskId);
                        return;
                    }
                }

                existingFiles = new Set(currentFiles);

                const pending = this.pendingSessionCapture.get(taskId);
                if (pending && Date.now() - pending.startTime > 30000) {
                    logger.warn(`Session capture timeout`, { taskId });
                    this.clearSessionCapture(taskId);
                }
            } catch (_e) {
                // Ignore errors during session capture
            }
        }, 500);

        // Store the interval so we can clear it later
        this.sessionCaptureIntervals.set(taskId, checkInterval);
    }

    /**
     * Clears any pending session capture for a task
     * @param taskId - The task ID to clear capture for
     */
    private clearSessionCapture(taskId: string): void {
        const interval = this.sessionCaptureIntervals.get(taskId);
        if (interval) {
            clearInterval(interval);
            this.sessionCaptureIntervals.delete(taskId);
        }
        this.pendingSessionCapture.delete(taskId);
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
     * Get environment variables for spawning Claude tasks based on API mode
     * - default: Use Claude's default settings from ~/.claude.json
     * - custom-anthropic: Use custom API key with Anthropic's API directly
     * - sap-ai-core: Use the embedded proxy that routes through SAP AI Core
     */
    private getTaskEnvironment(): { [key: string]: string } {
        const taskEnv = { ...process.env } as { [key: string]: string };

        if (!this.configStore) return taskEnv;

        const apiMode = this.configStore.getApiMode();
        console.log(`[TaskSpawner] API mode: ${apiMode}`);

        if (apiMode === 'custom-anthropic') {
            const apiKey = this.configStore.getCustomAnthropicApiKey();
            if (apiKey) {
                taskEnv['ANTHROPIC_API_KEY'] = apiKey;
                console.log(`[TaskSpawner] Using custom Anthropic API key`);
            }
        } else if (apiMode === 'sap-ai-core') {
            // Point to the embedded proxy server
            // The proxy is mounted at the backend's root, so we use the backend URL
            const backendPort = process.env.PORT || '3001';
            taskEnv['ANTHROPIC_BASE_URL'] = `http://localhost:${backendPort}`;
            console.log(`[TaskSpawner] Using SAP AI Core proxy at localhost:${backendPort}`);
        }
        // 'default' mode: don't set any env vars, let Claude Code use its own settings

        return taskEnv;
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
     * Public method for debugging output detection
     */
    getRecentOutputForDebug(taskId: string, maxBytes: number): string {
        const task = this.tasks.get(taskId);
        if (!task) return '';
        return this.getRecentOutput(task, maxBytes);
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

        // Get the last meaningful section of output (separated by ⏺ dots or horizontal lines)
        // Claude separates messages with ⏺ or ─── lines
        // Important: After a response, there's often an empty input prompt section (just "❯")
        // We need to find the last section that actually contains Claude's response
        const sections = str.split(/(?:⏺|─{3,})/);

        // Filter out empty sections and sections that are just the input prompt
        const meaningfulSections = sections.filter(s => {
            const trimmed = s.trim();
            // Skip empty sections or sections that are just the input prompt marker
            if (!trimmed || trimmed === '❯' || /^❯\s*$/.test(trimmed)) {
                return false;
            }
            // Skip sections that are only TUI chrome (shortcuts, model info, etc.)
            if (/^\s*(?:\? for shortcuts|Try "|\/model|bypass permissions|shift\+tab)/i.test(trimmed)) {
                return false;
            }
            return true;
        });

        const lastSection = meaningfulSections.length > 0
            ? meaningfulSections[meaningfulSections.length - 1]
            : str;

        // Clean up the section for analysis
        const cleanSection = lastSection
            .replace(/\? for shortcuts/g, '')  // Help text
            .replace(/Try "[^"]*"/g, '')       // Suggestion text
            .replace(/\/model to try/g, '')    // Model switcher text
            .replace(/bypass permissions/gi, '') // Permission mode text
            .replace(/shift\+tab to cycle/gi, ''); // Keyboard hint

        // Look for question marks that indicate real questions
        const hasQuestionMark = cleanSection.includes('?');

        if (hasQuestionMark) {
            // Verify it's a real question by checking for question patterns
            const questionPatterns = [
                /\bwhat\b/i,
                /\bwhich\b/i,
                /\bhow\b/i,
                /\bwhere\b/i,
                /\bwhen\b/i,
                /\bwhy\b/i,
                /\bwho\b/i,
                /\bwould you\b/i,
                /\bcould you\b/i,
                /\bdo you\b/i,
                /\bshould\b/i,
                /\bcan you\b/i,
                /\blet me know\b/i,
                /\bgive me\b/i,
                /\btell me\b/i,
                /\bprefer\b/i,
                /\blike to\b/i,
                /\bwant to\b/i,
                /\bchoose\b/i,
                /\bselect\b/i,
                /\bpick\b/i,
                /\bdecide\b/i,
                /\bconfirm\b/i,
                /\bproceed\b/i,
                /\bcontinue\b/i,
                /\bapproach\b/i,
                /\boption/i,
                /\balternative/i,
            ];

            for (const pattern of questionPatterns) {
                if (pattern.test(cleanSection)) {
                    console.log(`[TaskSpawner] Question detected in last section: "${cleanSection.slice(0, 100)}..."`);
                    return 'question';
                }
            }

            // Also check if the last section ends with a question (even without explicit patterns)
            // This catches cases like "Is this what you wanted?"
            const trimmedSection = cleanSection.trim();
            if (trimmedSection.endsWith('?') && trimmedSection.length > 10) {
                console.log(`[TaskSpawner] Question detected (ends with ?): "${trimmedSection.slice(-80)}"`);
                return 'question';
            }

            // Debug: log when we have a question mark but didn't detect a question
            console.log(`[TaskSpawner] Has '?' but no question pattern matched. Section: "${trimmedSection.slice(0, 150)}"`);
        }

        return null;
    }

    /**
     * Get the current state of a task.
     * Simply returns the stored state - polling manages state transitions.
     */
    getTaskState(taskId: string): TaskState | null {
        const task = this.tasks.get(taskId);
        if (!task) {
            const disconnected = this.disconnectedTasks.get(taskId);
            return disconnected ? 'disconnected' : null;
        }
        return task.state;
    }

    private sendPromptWithRetry(task: InternalTask, prompt: string, maxRetries = 5): void {
        console.log(`[TaskSpawner] Writing prompt to PTY: "${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}"`);

        // For small messages (≤200 chars), type character by character
        // This gives the TUI time to process and makes Enter more reliable
        // For longer prompts, paste directly to avoid excessive delay
        if (prompt.length <= 200) {
            let charIndex = 0;
            const charDelay = prompt.length <= 20 ? 10 : 5; // Slower for very short messages
            const writeNextChar = () => {
                if (charIndex < prompt.length) {
                    task.process.write(prompt[charIndex]);
                    charIndex++;
                    setTimeout(writeNextChar, charDelay);
                } else {
                    // Give TUI time to settle before Enter
                    setTimeout(() => this.sendEnterWithRetry(task, maxRetries, { isInitialPrompt: true }), 500);
                }
            };
            writeNextChar();
        } else {
            // Paste the entire prompt at once, then use retry mechanism to ensure Enter is accepted
            task.process.write(prompt);
            task.promptSubmitAttempts = 0;
            // Give more time for longer prompts to be written before sending Enter
            const delayMs = Math.min(500 + Math.floor(prompt.length / 100) * 50, 1000);
            console.log(`[TaskSpawner] Waiting ${delayMs}ms before sending Enter for prompt of ${prompt.length} chars`);
            setTimeout(() => this.sendEnterWithRetry(task, maxRetries, { isInitialPrompt: true }), delayMs);
        }
    }

    /**
     * Check if recent output indicates Claude has started processing
     * Look for spinner characters, "Thinking", "Working", etc.
     */
    private hasProcessingIndicators(task: InternalTask): boolean {
        const recentOutput = this.getRecentOutput(task, 1024);
        // Look for Claude processing indicators
        const processingPatterns = [
            /Thinking/i,
            /Working/i,
            /Concocting/i,
            /Analyzing/i,
            /Reading/i,
            /Writing/i,
            /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,  // Spinner characters
            /✶|✳|✢|·|✻|✽|✺/,  // Claude spinner chars
            /───.*Claude/,  // Header lines
        ];
        return processingPatterns.some(pattern => pattern.test(recentOutput));
    }

    /**
     * Send Enter key with retry logic to ensure Claude accepts the input.
     * Consolidates logic for both initial prompt submission and follow-up input.
     * @param task - The task to send Enter to
     * @param retriesLeft - Number of retries remaining
     * @param options - Options for retry behavior
     */
    private sendEnterWithRetry(
        task: InternalTask,
        retriesLeft: number,
        options: { isInitialPrompt?: boolean; enterKey?: string } = {}
    ): void {
        const { isInitialPrompt = false, enterKey = '\r' } = options;
        const context = isInitialPrompt ? 'initial prompt' : 'input';

        if (retriesLeft <= 0) {
            console.log(`[TaskSpawner] Max retries reached for ${context} on task ${task.id}, giving up`);
            // Just return, do not send burst to avoid PTY crashes
            return;
        }

        task.promptSubmitAttempts = (task.promptSubmitAttempts || 0) + 1;
        console.log(`[TaskSpawner] Sending Enter for ${context} (attempt ${task.promptSubmitAttempts}) to task ${task.id}`);

        // For follow-up input, transition to busy state before sending Enter
        if (!isInitialPrompt && (task.state === 'idle' || task.state === 'waiting_input')) {
            task.state = 'busy';
            task.waitingInputType = undefined;
            this.emit('taskStateChanged', this.toPublicTask(task));
        }

        // Send Enter
        task.process.write(enterKey);

        setTimeout(() => {
            // Check if Claude started processing (not just any output change)
            if (this.hasProcessingIndicators(task)) {
                console.log(`[TaskSpawner] Claude processing detected for ${context} after attempt ${task.promptSubmitAttempts}`);
                if (isInitialPrompt && task.state === 'starting' && !task.hasStartedProcessing) {
                    task.hasStartedProcessing = true;
                    task.state = 'busy';
                    console.log(`[TaskSpawner] Task ${task.id} transitioned: starting → busy`);
                    this.emit('taskStateChanged', this.toPublicTask(task));
                }
                return;
            }

            // Not started yet - schedule retry with longer delay
            console.log(`[TaskSpawner] No processing indicators found for ${context}, will retry Enter in 500ms`);
            setTimeout(() => this.sendEnterWithRetry(task, retriesLeft - 1, options), 500);
        }, 800);
    }

    /**
     * Creates a new Claude Code task
     * @param prompt - The user's prompt for the task
     * @param workspaceId - The workspace directory path
     * @param systemPrompt - Optional system prompt override
     * @returns The created task object
     */
    async createTask(prompt: string, workspaceId: string, systemPrompt?: string): Promise<Task> {
        const id = `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Sanitize prompt to prevent command injection and other issues
        const sanitizedPrompt = sanitizePrompt(prompt);
        const sanitizedSystemPrompt = systemPrompt ? sanitizePrompt(systemPrompt) : undefined;

        const gitStateBefore = await captureGitStateBefore(workspaceId);
        if (gitStateBefore) {
            logger.info(`Captured git state before task`, { taskId: id, commit: gitStateBefore.commitBefore?.substring(0, 7) });
        }

        const customArgs = process.env['CC_CLAUDE_ARGS']
            ? process.env['CC_CLAUDE_ARGS'].split(' ')
            : [];

        const claudeArgs = [...customArgs];

        if (this.configStore?.getSkipPermissions()) {
            claudeArgs.push('--dangerously-skip-permissions');
            logger.info(`Skip permissions enabled`);
        }

        // Add custom system prompt if provided
        if (sanitizedSystemPrompt && sanitizedSystemPrompt.trim()) {
            claudeArgs.push('--system-prompt', sanitizedSystemPrompt.trim());
            logger.info(`Using custom system prompt`);
        }

        logger.info(`Creating task`, { taskId: id, workspaceId });
        logger.debug(`Command args`, { args: claudeArgs });

        // Get environment with API mode settings
        const taskEnv = this.getTaskEnvironment();

        const ptyProcess = spawn('claude', claudeArgs, {
            name: 'xterm-256color',
            cols: 120,
            rows: 40,
            cwd: workspaceId,
            env: taskEnv,
        });

        const now = new Date();
        const task: InternalTask = {
            id,
            prompt: sanitizedPrompt,
            workspaceId,
            process: ptyProcess,
            state: 'starting',  // Start in 'starting' state until Claude actually begins processing
            outputHistory: [],
            lastActivity: now,
            createdAt: now,
            isActive: false,
            initialPromptSent: false,
            pendingPrompt: sanitizedPrompt,
            sessionId: null,
            gitStateBefore: gitStateBefore || undefined,
            systemPrompt: sanitizedSystemPrompt?.trim() || undefined,
            lastOutputLength: 0,  // Initialize for state polling
            hasStartedProcessing: false,  // Will be true once output changes after prompt sent
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

            // Limit history to 2MB per task (reduced from 10MB for better memory usage with many tasks)
            const MAX_HISTORY_SIZE = 2 * 1024 * 1024;
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

            // Note: State detection is now handled by polling in checkTaskStates()

            // Stream output to active task
            if (task.isActive) {
                this.emit('taskOutput', task.id, data);
            }
        });

        task.process.onExit(({ exitCode }) => {
            console.log(`[TaskSpawner] Task ${task.id} exited with code ${exitCode}`);

            // Clean up session capture interval to prevent memory leak
            this.clearSessionCapture(task.id);

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
            // Clear decoded history from all other tasks to free memory
            // This prevents memory buildup when rapidly switching between tasks
            for (const task of this.tasks.values()) {
                task.isActive = false;
                // If this task has decoded history but isn't the one being activated,
                // clear it to free memory. We can reload from disk later.
                if (task.id !== taskId && task.previousHistory) {
                    task.previousHistory = undefined;
                    // Also clear lazyHistoryBase64 if it exists (legacy)
                    task.lazyHistoryBase64 = undefined;
                    console.log(`[TaskSpawner] Freed memory for inactive task ${task.id}`);
                }
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
     * 
     * NOTE: We limit the history sent to prevent memory exhaustion on tasks
     * with very large histories (some can be 10+ MB).
     * 
     * This also handles lazy loading - history may be stored as base64 and
     * decoded only when the task is actually selected.
     */
    private getCombinedHistory(task: InternalTask): string | null {
        // Limit history sent to frontend to prevent memory exhaustion
        const MAX_HISTORY_TO_SEND = 2 * 1024 * 1024; // 2MB max

        // Handle lazy loading from file
        if (!task.previousHistory && !task.lazyHistoryBase64) {
            const historyPath = this.getTaskHistoryPath(task.id);
            if (existsSync(historyPath)) {
                try {
                    const stat = statSync(historyPath);
                    const fileSize = stat.size;

                    let base64Content: string;

                    // If file is larger than MAX_HISTORY_TO_SEND, only read the tail
                    // Base64 encoding inflates size by ~33%, so calculate raw max size
                    const maxBase64Size = Math.floor(MAX_HISTORY_TO_SEND * 1.33);

                    if (fileSize > maxBase64Size) {
                        // Only read the last portion of the file
                        const fd = openSync(historyPath, 'r');
                        const buffer = Buffer.alloc(maxBase64Size);
                        const offset = fileSize - maxBase64Size;
                        readSync(fd, buffer, 0, maxBase64Size, offset);
                        closeSync(fd);
                        base64Content = buffer.toString('utf-8');
                        console.log(`[TaskSpawner] Loaded tail of history from file for ${task.id}: ${fileSize} bytes (file) -> ${maxBase64Size} bytes (loaded)`);
                    } else {
                        // File is small enough, read it all
                        base64Content = readFileSync(historyPath, 'utf-8');
                        console.log(`[TaskSpawner] Loaded complete history from file for ${task.id}: ${fileSize} bytes`);
                    }

                    // Decode base64 to buffer
                    const decoded = Buffer.from(base64Content, 'base64');

                    // Add truncation message if we only loaded partial history
                    if (fileSize > maxBase64Size) {
                        const truncationMessage = Buffer.from('\r\n\x1b[90m─── [History truncated - showing last 2MB] ───\x1b[0m\r\n');
                        task.previousHistory = Buffer.concat([truncationMessage, decoded]);
                    } else {
                        task.previousHistory = decoded;
                    }
                } catch (e) {
                    console.error(`[TaskSpawner] Failed to load history file for ${task.id}:`, e);
                }
            }
        }

        // Handle lazy loading: decode base64 history on first access
        if (task.lazyHistoryBase64 && !task.previousHistory) {
            try {
                const fullHistory = Buffer.from(task.lazyHistoryBase64, 'base64');
                if (fullHistory.length > MAX_HISTORY_TO_SEND) {
                    // Only keep the last 2MB
                    const truncationMessage = Buffer.from('\r\n\x1b[90m─── [History truncated - showing last 2MB] ───\x1b[0m\r\n');
                    task.previousHistory = Buffer.concat([
                        truncationMessage,
                        fullHistory.slice(fullHistory.length - MAX_HISTORY_TO_SEND)
                    ]);
                    console.log(`[TaskSpawner] Lazy loaded and truncated history from ${fullHistory.length} to ${task.previousHistory.length} bytes`);
                } else {
                    task.previousHistory = fullHistory;
                    console.log(`[TaskSpawner] Lazy loaded ${task.previousHistory.length} bytes of history`);
                }
                // Clear the base64 string to free memory
                task.lazyHistoryBase64 = undefined;

            } catch (e) {
                console.error(`[TaskSpawner] Failed to lazy load history:`, e);
                task.lazyHistoryBase64 = undefined;
            }
        }

        const parts: Buffer[] = [];
        let totalSize = 0;

        // Add current session output first (we want to keep recent output)
        for (let i = task.outputHistory.length - 1; i >= 0 && totalSize < MAX_HISTORY_TO_SEND; i--) {
            parts.unshift(task.outputHistory[i]);
            totalSize += task.outputHistory[i].length;
        }

        // Then add previous history if we still have room
        if (task.previousHistory && totalSize < MAX_HISTORY_TO_SEND) {
            const remainingSpace = MAX_HISTORY_TO_SEND - totalSize;
            if (task.previousHistory.length <= remainingSpace) {
                parts.unshift(task.previousHistory);
            } else {
                // Only include the tail of previous history
                const tailStart = task.previousHistory.length - remainingSpace;
                const truncationMessage = Buffer.from('\r\n\x1b[90m─── [History truncated - showing last 2MB] ───\x1b[0m\r\n');
                parts.unshift(task.previousHistory.slice(tailStart));
                parts.unshift(truncationMessage);
            }
        }

        if (parts.length === 0) return null;

        return Buffer.concat(parts).toString('utf8');
    }

    writeToTask(taskId: string, data: string): void {
        const task = this.tasks.get(taskId);
        if (task) {
            // Check if this is a message with Enter at the end (from input bar)
            const endsWithEnter = data.endsWith('\r') || data.endsWith('\n');
            const hasMessageContent = data.length > 1 && endsWithEnter;

            if (hasMessageContent && (task.state === 'idle' || task.state === 'waiting_input')) {
                // Split message from Enter key - write message first, then retry Enter
                const messageContent = data.slice(0, -1);
                const enterKey = data.slice(-1);

                console.log(`[TaskSpawner] Writing message to task ${taskId}, will retry Enter if needed`);
                task.process.write(messageContent);
                task.promptSubmitAttempts = 0;

                // Use consolidated retry mechanism with follow-up input options
                setTimeout(() => this.sendEnterWithRetry(task, 3, { isInitialPrompt: false, enterKey }), 200);
            } else {
                // Single keypress or task is busy - write directly
                task.process.write(data);
            }
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

    /**
     * Stop a running task by sending ESC (interrupt) and then killing the process
     * Returns true if task was stopped, false if task wasn't running
     */
    stopTask(taskId: string): boolean {
        const task = this.tasks.get(taskId);
        if (!task) {
            logger.info(`stopTask: task not found`, { taskId });
            return false;
        }

        if (task.state === 'busy' || task.state === 'starting' || task.state === 'waiting_input') {
            logger.info(`Stopping task`, { taskId, state: task.state });
            // Send ESC to interrupt Claude first (more graceful)
            try {
                task.process.write('\x1b');
            } catch (_e) {
                // Process might already be dead
            }
            return true;
        }

        logger.info(`stopTask: task not in stoppable state`, { taskId, state: task.state });
        return false;
    }

    /**
     * Destroys a task, killing its process and removing it from all maps
     * @param taskId - The task ID to destroy
     */
    destroyTask(taskId: string): void {
        logger.info(`Destroying task`, { taskId });
        let destroyed = false;
        let source = '';

        // Clean up any pending session capture for this task
        this.clearSessionCapture(taskId);

        const task = this.tasks.get(taskId);
        if (task) {
            logger.info(`Found task in live tasks`, { taskId, state: task.state });

            // If task is running, first try to stop it gracefully
            if (task.state === 'busy' || task.state === 'starting' || task.state === 'waiting_input') {
                logger.info(`Task is running, sending interrupt first`, { taskId, state: task.state });
                try {
                    task.process.write('\x1b'); // Send ESC to interrupt
                } catch (_e) {
                    // Process might already be dead
                }
            }

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
            logger.info(`Found task in disconnected tasks`, { taskId });
            this.disconnectedTasks.delete(taskId);
            destroyed = true;
            source = source ? 'both' : 'disconnected';
        }

        // Only emit once, regardless of which map(s) the task was in
        if (destroyed) {
            logger.info(`Task destroyed`, { taskId, source });
            this.scheduleSave();
            this.emit('taskDestroyed', taskId);
        } else {
            logger.warn(`Task not found in any map`, { taskId });
        }
    }

    archiveTask(taskId: string): void {
        // Archive moves task from active list to archived storage
        let archived = false;
        let wasLive = false;

        const task = this.tasks.get(taskId);
        if (task) {
            // Convert live task to persisted format for archiving
            let historyBase64: string;
            let historySize: number;

            // Handle lazy loading case - avoid decoding if possible
            if (task.lazyHistoryBase64 && !task.previousHistory) {
                const currentOutputSize = task.outputHistory.reduce((sum, buf) => sum + buf.length, 0);
                if (currentOutputSize < 1024) {
                    historyBase64 = task.lazyHistoryBase64;
                    historySize = Math.floor(historyBase64.length * 0.75);
                } else {
                    const currentOutput = Buffer.concat(task.outputHistory);
                    const lazyHistory = Buffer.from(task.lazyHistoryBase64, 'base64');
                    historyBase64 = Buffer.concat([lazyHistory, currentOutput]).toString('base64');
                    historySize = Math.floor(historyBase64.length * 0.75);
                }
            } else {
                const buffers: Buffer[] = [];
                if (task.previousHistory) {
                    buffers.push(task.previousHistory);
                }
                buffers.push(...task.outputHistory);
                const historyBuffer = Buffer.concat(buffers);
                historyBase64 = historyBuffer.toString('base64');
                historySize = historyBuffer.length;
            }

            // Save history to disk instead of keeping in memory
            try {
                const historyDir = this.getArchivedHistoryDir();
                if (!existsSync(historyDir)) {
                    mkdirSync(historyDir, { recursive: true });
                }
                writeFileSync(this.getArchivedHistoryPath(taskId), historyBase64);
                console.log(`[TaskSpawner] Saved archived task history to disk: ${historySize} bytes`);
            } catch (e) {
                console.error(`[TaskSpawner] Failed to save archived history:`, e);
            }

            // Store only metadata in memory
            const archivedMetadata: ArchivedTaskMetadata = {
                id: task.id,
                prompt: task.prompt,
                workspaceId: task.workspaceId,
                createdAt: task.createdAt.toISOString(),
                lastActivity: task.lastActivity.toISOString(),
                sessionId: task.sessionId,
                gitState: task.gitState,
                systemPrompt: task.systemPrompt,
                historySize,
            };
            this.archivedTasks.set(taskId, archivedMetadata);

            // If task is running, first try to stop it gracefully
            if (task.state === 'busy' || task.state === 'starting' || task.state === 'waiting_input') {
                logger.info(`Task is running, sending interrupt before archive`, { taskId, state: task.state });
                try {
                    task.process.write('\x1b'); // Send ESC to interrupt
                } catch (_e) {
                    // Process might already be dead
                }
            }

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

        // Also check disconnected tasks
        const disconnected = this.disconnectedTasks.get(taskId);
        if (disconnected) {
            // Save history to disk
            if (disconnected.outputHistory) {
                try {
                    const historyDir = this.getArchivedHistoryDir();
                    if (!existsSync(historyDir)) {
                        mkdirSync(historyDir, { recursive: true });
                    }
                    writeFileSync(this.getArchivedHistoryPath(taskId), disconnected.outputHistory);
                    const historySize = Math.floor(disconnected.outputHistory.length * 0.75);
                    console.log(`[TaskSpawner] Saved disconnected task history to disk: ${historySize} bytes`);
                } catch (e) {
                    console.error(`[TaskSpawner] Failed to save archived history:`, e);
                }
            }

            // Store only metadata in memory
            const archivedMetadata: ArchivedTaskMetadata = {
                id: disconnected.id,
                prompt: disconnected.prompt,
                workspaceId: disconnected.workspaceId,
                createdAt: disconnected.createdAt,
                lastActivity: disconnected.lastActivity,
                sessionId: disconnected.sessionId,
                gitState: disconnected.gitState,
                systemPrompt: disconnected.systemPrompt,
                historySize: disconnected.outputHistory ? Math.floor(disconnected.outputHistory.length * 0.75) : 0,
            };
            this.archivedTasks.set(taskId, archivedMetadata);
            this.disconnectedTasks.delete(taskId);
            archived = true;
        }

        // Only emit once, regardless of which map(s) the task was in
        if (archived) {
            this.scheduleSave();
            this.emit('taskDestroyed', taskId);
            console.log(`[TaskSpawner] Archived ${wasLive ? 'live' : 'disconnected'} task ${taskId}`);
        }
    }

    /**
     * Get all archived tasks
     */
    getArchivedTasks(): Task[] {
        return Array.from(this.archivedTasks.values()).map(persisted => ({
            id: persisted.id,
            prompt: persisted.prompt,
            state: 'archived' as TaskState,
            workspaceId: persisted.workspaceId,
            createdAt: new Date(persisted.createdAt),
            lastActivity: new Date(persisted.lastActivity),
            gitState: persisted.gitState,
            systemPrompt: persisted.systemPrompt,
        }));
    }

    /**
     * Restore an archived task back to disconnected state (can then be reconnected)
     */
    restoreArchivedTask(taskId: string): Task | null {
        const archived = this.archivedTasks.get(taskId);
        if (!archived) {
            console.log(`[TaskSpawner] Cannot restore: archived task ${taskId} not found`);
            return null;
        }

        // Load history from disk
        let outputHistory: string | undefined;
        const historyPath = this.getArchivedHistoryPath(taskId);
        if (existsSync(historyPath)) {
            try {
                outputHistory = readFileSync(historyPath, 'utf-8');
                console.log(`[TaskSpawner] Loaded archived history from disk: ${archived.historySize || 0} bytes`);
            } catch (e) {
                console.error(`[TaskSpawner] Failed to load archived history:`, e);
            }
        }

        // Convert metadata to PersistedTask for disconnectedTasks
        const persistedTask: PersistedTask = {
            id: archived.id,
            prompt: archived.prompt,
            workspaceId: archived.workspaceId,
            createdAt: archived.createdAt,
            lastActivity: archived.lastActivity,
            lastState: 'disconnected',
            sessionId: archived.sessionId,
            outputHistory,
            gitState: archived.gitState,
            systemPrompt: archived.systemPrompt,
        };

        // Move from archived to disconnected
        this.disconnectedTasks.set(taskId, persistedTask);
        this.archivedTasks.delete(taskId);

        // Delete history file since it's now in disconnectedTasks
        if (existsSync(historyPath)) {
            try {
                unlinkSync(historyPath);
            } catch (e) {
                console.error(`[TaskSpawner] Failed to delete archived history file:`, e);
            }
        }

        this.scheduleSave();

        console.log(`[TaskSpawner] Restored archived task ${taskId} to disconnected state`);

        // Return the task in disconnected format
        return {
            id: archived.id,
            prompt: archived.prompt,
            state: 'disconnected' as TaskState,
            workspaceId: archived.workspaceId,
            createdAt: new Date(archived.createdAt),
            lastActivity: new Date(archived.lastActivity),
            gitState: archived.gitState,
            systemPrompt: archived.systemPrompt,
        };
    }

    /**
     * Continue an archived task - restores it and immediately reconnects it
     * This is a convenience method that combines restore + reconnect
     */
    continueArchivedTask(taskId: string): Task | null {
        // Use restoreArchivedTask which handles loading history from disk
        const restoredTask = this.restoreArchivedTask(taskId);
        if (!restoredTask) {
            return null;
        }

        console.log(`[TaskSpawner] Continuing archived task ${taskId}`);

        // Now reconnect the task
        const reconnectedTask = this.reconnectTask(taskId);
        if (!reconnectedTask) {
            console.log(`[TaskSpawner] Failed to reconnect archived task ${taskId}`);
            // If reconnection fails, it stays in disconnected state
            return restoredTask;
        }

        return reconnectedTask;
    }

    /**
     * Permanently delete an archived task
     */
    deleteArchivedTask(taskId: string): boolean {
        if (this.archivedTasks.has(taskId)) {
            this.archivedTasks.delete(taskId);

            // Also delete history file from disk
            const historyPath = this.getArchivedHistoryPath(taskId);
            if (existsSync(historyPath)) {
                try {
                    unlinkSync(historyPath);
                    console.log(`[TaskSpawner] Deleted archived history file for ${taskId}`);
                } catch (e) {
                    console.error(`[TaskSpawner] Failed to delete archived history file:`, e);
                }
            }

            this.scheduleSave();
            console.log(`[TaskSpawner] Permanently deleted archived task ${taskId}`);
            return true;
        }
        return false;
    }

    getAllTasks(): Task[] {
        const liveTasks = Array.from(this.tasks.values()).map(task => this.toPublicTask(task));

        const disconnectedTasks = Array.from(this.disconnectedTasks.values()).map(persisted => ({
            id: persisted.id,
            prompt: persisted.prompt,
            // Show 'interrupted' state if task was busy when killed, otherwise show the original state
            // This makes the UI show tasks in their proper state rather than all showing "disconnected"
            state: (persisted.wasInterrupted ? 'interrupted' : persisted.lastState) as TaskState,
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

        const claudeArgs = [...customArgs];

        if (this.configStore?.getSkipPermissions()) {
            claudeArgs.push('--dangerously-skip-permissions');
        }

        if (persisted.sessionId) {
            claudeArgs.push('--resume', persisted.sessionId);
            console.log(`[TaskSpawner] Reconnecting task ${taskId} with session ${persisted.sessionId}`);
        } else {
            console.log(`[TaskSpawner] Reconnecting task ${taskId} (fresh start)`);
        }

        // Get environment with API mode settings
        const taskEnv = this.getTaskEnvironment();

        const ptyProcess = spawn('claude', claudeArgs, {
            name: 'xterm-256color',
            cols: 120,
            rows: 40,
            cwd: persisted.workspaceId,
            env: taskEnv,
        });
        console.log(`[TaskSpawner] Process spawned for task ${taskId}, PID: ${ptyProcess.pid}`);

        const now = new Date();

        // Use lazy loading for history to prevent memory exhaustion during startup
        // History will be loaded from file only when task is selected (setTaskActive)
        // Check if history file exists
        let lazyHistoryBase64: string | undefined;
        try {
            const historyPath = this.getTaskHistoryPath(taskId);
            if (existsSync(historyPath)) {
                // Just flag that we have history, don't read it yet!
                // We'll read it "on demand" in getCombinedHistory or when needed
                // For now, we set a placeholder to indicate history exists
                // BUT wait: logic below expects lazyHistoryBase64 to BE the content.
                // We need to change getCombinedHistory to read from file if this is a "file path" or special marker.
                // Alternatively, read it here? NO, that defeats the purpose of avoiding 30MB load.
                // WE MUST READ IT LAZILY.

                // Let's modify getCombinedHistory to handle reading from file.
                // For this refactor, we'll store a special marker or changed InternalTask interface? 
                // Currently InternalTask has lazyHistoryBase64 as string. 
                // Let's treat it as NULL here, and modify getCombinedHistory to check file.
                lazyHistoryBase64 = undefined;
                console.log(`[TaskSpawner] Task ${taskId} has history file (lazy load enabled)`);
            } else if (persisted.outputHistory) {
                // Fallback for tasks not yet migrated (should happen in loadPersistedTasks though)
                lazyHistoryBase64 = persisted.outputHistory;
            }
        } catch (e) {
            console.error(`[TaskSpawner] Failed to check history file for ${taskId}:`, e);
        }

        // Create a separator message for the live output stream
        const resumeMessage = persisted.sessionId
            ? `\r\n\x1b[90m─── Resuming session ${persisted.sessionId} ───\x1b[0m\r\n\r\n`
            : `\r\n\x1b[90m─── Session reconnected ───\x1b[0m\r\n\r\n`;

        // Check if this task should auto-continue after reconnection
        const shouldContinue = persisted.shouldContinue && persisted.sessionId != null;
        if (shouldContinue) {
            logger.info(`Task was interrupted, will auto-continue`, { taskId });
        }

        const task: InternalTask = {
            id: persisted.id,
            prompt: persisted.prompt,
            workspaceId: persisted.workspaceId,
            process: ptyProcess,
            state: shouldContinue ? 'starting' : 'idle',  // 'starting' if we need to send continuation
            outputHistory: [Buffer.from(resumeMessage)], // Start fresh, only resume message
            lazyHistoryBase64, // Store base64 for lazy loading instead of decoding now
            lastActivity: now,
            createdAt: new Date(persisted.createdAt),
            isActive: false,
            initialPromptSent: !shouldContinue,  // False if we need to send continuation prompt
            pendingPrompt: shouldContinue ? 'continue' : null,  // Trigger continuation
            sessionId: persisted.sessionId,
            lastOutputLength: resumeMessage.length,  // Initialize for state polling
            hasStartedProcessing: !shouldContinue,  // Will be set true when continuation starts
            shouldContinue,
            continuationSent: false,
        };

        this.setupProcessHandlers(task);
        this.tasks.set(task.id, task);

        this.disconnectedTasks.delete(taskId);
        this.scheduleSave();

        this.emit('taskStateChanged', this.toPublicTask(task));
        return this.toPublicTask(task);
    }

    destroy(): void {
        this.saveTasks();

        // Stop state polling
        if (this.statePollingInterval) {
            clearInterval(this.statePollingInterval);
            this.statePollingInterval = null;
        }

        // Clean up all session capture intervals to prevent memory leaks
        for (const taskId of this.sessionCaptureIntervals.keys()) {
            this.clearSessionCapture(taskId);
        }

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
