import { spawn, IPty } from 'node-pty';
import { EventEmitter } from 'events';
import { Task, TaskState, TaskGitState, WaitingInputType, BackendType, PORTS } from '@claudia/shared';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, appendFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { ConfigStore, ClaudeCodeSwitches } from './config-store.js';
import { captureGitStateBefore, captureGitStateAfter, revertTaskChanges } from './git-utils.js';
import { sanitizePrompt } from './validation.js';
import { createLogger } from './logger.js';
import { CodeBackend, BackendTask, createBackend } from './backends/index.js';
import { LearningsStore, LearningSearchResult } from './learnings-store.js';
import { getConversationHistory } from './conversation-parser.js';

const logger = createLogger('[TaskSpawner]');

/**
 * Map legacy permission mode values to actual Claude Code CLI values.
 * Claude CLI --permission-mode accepts: acceptEdits, bypassPermissions, default, dontAsk, plan
 * Old Claudia UI used: plan, safe, dangerous, auto
 */
const PERMISSION_MODE_MAP: Record<string, string> = {
    // Legacy values → actual CLI values
    'safe': 'acceptEdits',
    'dangerous': 'bypassPermissions',
    'auto': 'dontAsk',
    // These are already valid CLI values (pass through)
    'plan': 'plan',
    'default': 'default',
    'acceptEdits': 'acceptEdits',
    'bypassPermissions': 'bypassPermissions',
    'dontAsk': 'dontAsk',
};

/**
 * Build CLI args from ClaudeCodeSwitches config.
 * Returns args to push into the claudeArgs array.
 */
function buildClaudeCodeSwitchArgs(switches: ClaudeCodeSwitches): string[] {
    const args: string[] = [];

    if (switches.verbose) {
        args.push('--verbose');
    }

    if (switches.maxTurns != null && switches.maxTurns > 0) {
        args.push('--max-turns', String(switches.maxTurns));
    }

    if (switches.maxBudgetUsd != null && switches.maxBudgetUsd > 0) {
        args.push('--max-budget-usd', String(switches.maxBudgetUsd));
    }

    if (switches.permissionMode) {
        const cliMode = PERMISSION_MODE_MAP[switches.permissionMode] || switches.permissionMode;
        args.push('--permission-mode', cliMode);
        logger.info(`Permission mode: "${switches.permissionMode}" → CLI: "${cliMode}"`);
    }

    if (switches.allowedTools && switches.allowedTools.trim()) {
        args.push('--allowedTools', switches.allowedTools.trim());
    }

    if (switches.disallowedTools && switches.disallowedTools.trim()) {
        args.push('--disallowedTools', switches.disallowedTools.trim());
    }

    if (switches.appendSystemPrompt && switches.appendSystemPrompt.trim()) {
        args.push('--append-system-prompt', switches.appendSystemPrompt.trim());
    }

    return args;
}

/** On Windows, node-pty requires the .exe extension to find executables */
const isWindows = process.platform === 'win32';
function exe(name: string): string {
    return isWindows ? `${name}.exe` : name;
}

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
    backendType?: BackendType; // Which backend created this task (for reconnection)
    displayName?: string;      // User-editable display name
    displayNameEditedByUser?: boolean; // True if the user manually edited the display name
    processStartedAt?: string; // When the current processing run started (preserved across reconnect)
    order?: number;            // Display order within workspace (lower = higher in list)
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
    displayName?: string;      // User-editable display name
    displayNameEditedByUser?: boolean; // True if the user manually edited the display name
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
    inactiveOutputLogged?: boolean; // True if we've already logged the "dropping output" message for this inactive state
    lastRefKey?: string; // Tracks which workspace references were last injected (sorted ref IDs)
    pendingRefNotification?: boolean; // True if workspace references changed while task was busy
    pendingMcpNotification?: boolean; // True if MCP server config changed while task was busy
    processStartedAt?: Date; // When the current busy/starting state began (for elapsed timer)
    readyFallbackTimer?: ReturnType<typeof setTimeout>; // Fallback timer to send prompt if ready signal is never detected
    titleInstructionInjected?: boolean; // True if auto-title instruction has been injected into this session
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

    // Backend abstraction for multi-backend support (Claude Code, OpenCode, etc.)
    private backend: CodeBackend | null = null;
    private backendType: BackendType = 'claude-code';
    /** Track which tasks use which backend (for mixed-backend scenarios during transition) */
    private taskBackends: Map<string, BackendType> = new Map();

    // Learnings store for RAG-based context injection
    private learningsStore: LearningsStore | null = null;
    /** Track which learnings were injected into which tasks (for utility updates) */
    private taskLearnings: Map<string, string[]> = new Map();

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

        // Initialize backend based on config
        this.backendType = configStore?.getBackend() || 'claude-code';
        this.initializeBackend();

        // Initialize learnings store for RAG
        this.learningsStore = new LearningsStore(undefined, configStore || undefined);

        this.loadPersistedTasks();

        // Start state polling (only for claude-code backend which uses PTY)
        // OpenCode backend handles its own state management via HTTP API
        if (this.backendType === 'claude-code') {
            this.startStatePolling();
        }

        if (autoReconnect && this.disconnectedTasks.size > 0) {
            // Start auto-reconnect immediately but track the promise
            this.autoReconnectPromise = this.autoReconnectTasks();
        }
    }

    /**
     * Initialize or reinitialize the backend
     */
    private initializeBackend(): void {
        // Shutdown existing backend if any
        if (this.backend) {
            // Remove all event listeners before shutting down to prevent
            // stale handlers from firing on the old backend instance
            this.backend.removeAllListeners();
            this.backend.shutdown().catch(err => {
                logger.error('Failed to shutdown previous backend', { error: err });
            });
        }

        // Create new backend based on config
        this.backendType = this.configStore?.getBackend() || 'claude-code';
        this.backend = createBackend(this.backendType, this.configStore || undefined, this.getHistoryDir());

        // Wire up backend events
        this.backend.on('task:output', (taskId: string, data: string) => {
            const task = this.tasks.get(taskId);
            const taskBackendType = this.taskBackends.get(taskId);

            logger.debug('Backend task:output event received', {
                taskId,
                taskExists: !!task,
                isActive: task?.isActive,
                taskBackendType,
                dataLength: data.length
            });

            // For OpenCode tasks, always emit output (they don't use PTY streaming like Claude Code)
            // For Claude Code tasks, only emit if task is active (to avoid duplicate output)
            if (task && (taskBackendType === 'opencode' || task.isActive)) {
                logger.debug('Emitting taskOutput', { taskId, dataLength: data.length });
                this.emit('taskOutput', taskId, data);
            }
        });

        this.backend.on('task:stateChanged', (backendTask: BackendTask) => {
            const task = this.tasks.get(backendTask.id);
            if (task) {
                const oldState = task.state;
                task.state = backendTask.state;
                task.waitingInputType = backendTask.waitingInputType;
                task.lastActivity = backendTask.lastActivity;

                // Reset processStartedAt when transitioning into busy/starting from a non-active state
                if (oldState !== task.state && (task.state === 'busy' || task.state === 'starting')) {
                    if (oldState !== 'busy' && oldState !== 'starting') {
                        task.processStartedAt = new Date();
                    }
                }

                if (oldState !== task.state) {
                    logger.debug('Task state changed via backend', { taskId: task.id, oldState, newState: task.state });
                    this.emit('taskStateChanged', this.toPublicTask(task));
                    this.scheduleSave();
                }
            }
        });

        this.backend.on('task:waitingInput', (taskId: string, inputType: WaitingInputType, context: string) => {
            this.emit('taskWaitingInput', taskId, inputType, context);
        });

        this.backend.on('task:sessionCaptured', (taskId: string, sessionId: string) => {
            const task = this.tasks.get(taskId);
            if (task && !task.sessionId) {
                task.sessionId = sessionId;
                this.sessionToTaskId.set(sessionId, taskId);
                // Save immediately - session IDs are critical state that must survive
                // tsx watch restarts on Windows (TerminateProcess skips all handlers)
                this.saveTasks();
            }
        });

        this.backend.on('task:exit', (taskId: string, exitCode: number) => {
            const task = this.tasks.get(taskId);
            if (task) {
                task.state = 'exited';
                this.emit('taskStateChanged', this.toPublicTask(task));
                this.scheduleSave();
            }
        });

        // Initialize the backend
        this.backend.initialize().then(() => {
            logger.info('Backend initialized', { type: this.backendType });
        }).catch(err => {
            logger.error('Failed to initialize backend', { type: this.backendType, error: err });
        });
    }

    /**
     * Build the MCP config object from the current config store settings.
     * Returns null if no enabled MCP servers are found.
     */
    private buildMcpConfig(workspaceId?: string, taskId?: string): { mcpConfig: Record<string, Record<string, unknown>>; enabledMcpServers: { name: string }[] } | null {
        const mcpServers = this.configStore?.getMCPServers() || [];
        const enabledMcpServers = mcpServers.filter(s => s.enabled);

        // Check if Claudia MCP server should be injected
        const claudiaMcpEnabled = this.configStore?.getClaudioMcpServerEnabled() ?? false;

        if (enabledMcpServers.length === 0 && !claudiaMcpEnabled) return null;

        const mcpConfig: Record<string, Record<string, unknown>> = {};
        for (const server of enabledMcpServers) {
            const serverType = server.type || 'stdio';

            if (serverType === 'streamableHttp' || serverType === 'http') {
                const config: Record<string, unknown> = {
                    type: 'http',
                    url: server.url
                };
                if (server.timeout !== undefined) config.timeout = server.timeout;
                if (server.autoApprove && server.autoApprove.length > 0) config.autoApprove = server.autoApprove;
                if (server.description) config.description = server.description;
                if (server.headers) config.headers = server.headers;
                mcpConfig[server.name] = config;
            } else {
                const config: Record<string, unknown> = {
                    command: server.command,
                    args: server.args
                };
                if (server.env && Object.keys(server.env).length > 0) config.env = server.env;
                if (server.description) config.description = server.description;
                mcpConfig[server.name] = config;
            }
        }

        // Inject the Claudia MCP server if enabled
        // Scoped to the task's workspace via CLAUDIA_WORKSPACE_ID env var
        if (claudiaMcpEnabled) {
            const mcpServerPath = join(__dirname, 'claudia-mcp-server.ts');
            const claudiaConfig: Record<string, unknown> = {
                command: 'npx',
                args: ['tsx', mcpServerPath]
            };
            // Pass workspace ID and task ID so the MCP server is scoped appropriately
            const mcpEnv: Record<string, string> = {};
            if (workspaceId) mcpEnv.CLAUDIA_WORKSPACE_ID = workspaceId;
            if (taskId) mcpEnv.CLAUDIA_TASK_ID = taskId;
            if (Object.keys(mcpEnv).length > 0) {
                claudiaConfig.env = mcpEnv;
            }
            mcpConfig['claudia'] = claudiaConfig;
            enabledMcpServers.push({ name: 'claudia', enabled: true });
            logger.info('Injected Claudia MCP server into MCP config', { path: mcpServerPath, workspaceId: workspaceId || '(global)' });
        }

        return { mcpConfig, enabledMcpServers };
    }

    /**
     * Sync MCP config files (.mcp.json and .claude/settings.local.json) to workspace directories.
     * Call this on server startup and when MCP config is updated to prevent stale files.
     * @param workspaceIds - List of workspace directory paths to sync. All must exist on disk.
     */
    syncWorkspaceMcpConfigs(workspaceIds: string[]): void {
        const result = this.buildMcpConfig();
        if (!result) {
            logger.info('No enabled MCP servers, skipping workspace sync');
            return;
        }

        const { mcpConfig, enabledMcpServers } = result;
        const mcpConfigJson = JSON.stringify({ mcpServers: mcpConfig }, null, 2);
        const serverNames = enabledMcpServers.map(s => s.name);

        const settingsContent = {
            permissions: {
                allow: ['mcp__*'],
                deny: []
            },
            enableAllProjectMcpServers: true,
            enabledMcpjsonServers: serverNames
        };

        for (const workspaceId of workspaceIds) {
            if (!existsSync(workspaceId)) {
                logger.warn('Workspace does not exist, skipping MCP sync', { workspaceId });
                continue;
            }

            // Write .mcp.json
            const workspaceMcpFile = `${workspaceId}/.mcp.json`;
            try {
                writeFileSync(workspaceMcpFile, mcpConfigJson);
                logger.info('Synced .mcp.json', { workspaceId });
            } catch (err) {
                logger.error('Failed to write .mcp.json', { workspaceId, error: err });
            }

            // Write .claude/settings.local.json
            const claudeSettingsDir = `${workspaceId}/.claude`;
            const claudeSettingsFile = `${claudeSettingsDir}/settings.local.json`;
            try {
                if (!existsSync(claudeSettingsDir)) {
                    mkdirSync(claudeSettingsDir, { recursive: true });
                }
                writeFileSync(claudeSettingsFile, JSON.stringify(settingsContent, null, 2));
                logger.info('Synced settings.local.json', { workspaceId });
            } catch (err) {
                logger.error('Failed to write settings.local.json', { workspaceId, error: err });
            }
        }

        logger.info(`Synced MCP config to ${workspaceIds.length} workspace(s)`, { servers: serverNames });
    }

    /**
     * Get the current backend type
     */
    getBackendType(): BackendType {
        return this.backendType;
    }

    /**
     * Switch to a different backend
     * Called when the backend config is changed via API
     */
    async switchBackend(newBackendType: BackendType): Promise<void> {
        if (newBackendType === this.backendType) {
            logger.debug('Backend unchanged, skipping switch', { type: newBackendType });
            return;
        }

        logger.info('Switching backend', { from: this.backendType, to: newBackendType });

        // Stop state polling for claude-code
        if (this.backendType === 'claude-code' && this.statePollingInterval) {
            clearInterval(this.statePollingInterval);
            this.statePollingInterval = null;
        }

        // Update the config store if we have one
        if (this.configStore) {
            this.configStore.setBackend(newBackendType);
        }

        // Reinitialize the backend
        this.initializeBackend();

        // Start state polling if switching to claude-code
        if (this.backendType === 'claude-code') {
            this.startStatePolling();
        }
    }

    /**
     * Check if a specific backend is available
     */
    async checkBackendStatus(backendType?: BackendType): Promise<{ installed: boolean; version?: string; error?: string }> {
        const type = backendType || this.backendType;
        const tempBackend = createBackend(type, this.configStore || undefined);
        const status = await tempBackend.checkInstalled();
        return status;
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
                        this.captureGitStateAfterTask(task.id).catch(err => {
                            logger.error('Unhandled error in captureGitStateAfterTask', { taskId: task.id, error: err instanceof Error ? err.message : String(err) });
                        });
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

            // Reset processStartedAt when transitioning into busy/starting from a non-active state
            if ((newState === 'busy' || newState === 'starting') && oldState !== 'busy' && oldState !== 'starting') {
                task.processStartedAt = new Date();
                console.log(`[TaskSpawner] Reset processStartedAt for task ${task.id} to ${task.processStartedAt.toISOString()} (transition: ${oldState} → ${newState})`);
            }

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

            // Log memory BEFORE reconnecting this task
            const memBefore = process.memoryUsage();
            console.log(`[TaskSpawner] Auto-reconnecting task ${i + 1}/${tasksToReconnect.length}: ${taskId}`);
            console.log(`[TaskSpawner]   Prompt: ${persisted.prompt?.substring(0, 80) || 'No prompt'}...`);
            console.log(`[TaskSpawner]   Memory BEFORE: RSS=${(memBefore.rss / 1024 / 1024).toFixed(2)}MB Heap=${(memBefore.heapUsed / 1024 / 1024).toFixed(2)}MB`);

            let success = false;
            for (let attempt = 1; attempt <= MAX_RETRIES && !success; attempt++) {
                try {
                    const task = this.reconnectTask(taskId);
                    if (task) {
                        // Log memory AFTER successful reconnection
                        const memAfter = process.memoryUsage();
                        console.log(`[TaskSpawner] Successfully reconnected task ${taskId}`);
                        console.log(`[TaskSpawner]   Memory AFTER: RSS=${(memAfter.rss / 1024 / 1024).toFixed(2)}MB Heap=${(memAfter.heapUsed / 1024 / 1024).toFixed(2)}MB (Δ RSS: ${((memAfter.rss - memBefore.rss) / 1024 / 1024).toFixed(2)}MB)`);
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
                            // outputHistory is likely raw text from older versions. Convert to Base64 to match new file format.
                            // If it's already Base64, this might double-encode, but we can't easily tell without heuristics.
                            // Given this is a migration from older version, assuming raw text is safer.
                            let contentToWrite = persisted.outputHistory;
                            // Heuristic: If it contains ESC char, it's definitely raw text.
                            // Most tasks have ESC chars for colors/TUI.
                            if (contentToWrite.includes('\x1b') || contentToWrite.includes(' ')) {
                                contentToWrite = Buffer.from(contentToWrite, 'utf8').toString('base64');
                            }
                            writeFileSync(this.getTaskHistoryPath(persisted.id), contentToWrite);
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

                    // Restore the taskBackends map from persisted backendType
                    if (persisted.backendType) {
                        this.taskBackends.set(persisted.id, persisted.backendType);
                    }
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
                                let contentToWrite = archived.outputHistory;
                                if (contentToWrite.includes('\x1b') || contentToWrite.includes(' ')) {
                                    contentToWrite = Buffer.from(contentToWrite, 'utf8').toString('base64');
                                }
                                writeFileSync(this.getArchivedHistoryPath(archived.id), contentToWrite);
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
                            displayName: archived.displayName,
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

            // Ensure history directory exists
            const historyDir = this.getHistoryDir();
            if (!existsSync(historyDir)) {
                mkdirSync(historyDir, { recursive: true });
            }

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
                    // File exists but previousHistory was freed (memory cleanup).
                    // Append current session output so it isn't silently lost.
                    else if (task.outputHistory.length > 0) {
                        try {
                            const existingBase64 = readFileSync(historyPath, 'utf-8');
                            const existingBuf = Buffer.from(existingBase64, 'base64');
                            const currentBuf = Buffer.concat(task.outputHistory);
                            const combined = Buffer.concat([existingBuf, currentBuf]);
                            writeFileSync(historyPath, combined.toString('base64'));
                        } catch (appendErr) {
                            console.error(`[TaskSpawner] Failed to append history for task ${task.id}:`, appendErr);
                        }
                    }
                } catch (e) {
                    console.error(`[TaskSpawner] Failed to save history for task ${task.id}:`, e);
                }

                // Track if task was busy when being saved (will be interrupted)
                const wasInterrupted = task.state === 'busy' || task.state === 'starting';
                // Tasks that were busy should auto-continue on restart
                const shouldContinue = wasInterrupted && task.sessionId != null;

                // Get the backend type for this task (needed for correct reconnection)
                const taskBackendType = this.taskBackends.get(task.id);

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
                    backendType: taskBackendType,
                    displayName: task.displayName,
                    displayNameEditedByUser: task.displayNameEditedByUser,
                    processStartedAt: task.processStartedAt?.toISOString(),
                    order: task.order,
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
        // Claude Code converts workspace paths to folder names by replacing
        // every non-alphanumeric character (except dashes) with a dash individually
        return workspacePath.replace(/[^a-zA-Z0-9-]/g, '-');
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

        // Store the interval IMMEDIATELY to prevent leaks if code between
        // setInterval and set() were to throw (defensive programming)
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
                            // Save immediately (not debounced) - session IDs are critical state
                            // that must survive tsx watch restarts on Windows where TerminateProcess
                            // skips all signal/exit handlers
                            this.saveTasks();
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

    /**
     * Clean up MCP temporary config files for a task.
     * These are written to tmpdir() on task creation and reconnection.
     */
    private cleanupMcpTempFiles(taskId: string): void {
        const filesToClean = [
            join(tmpdir(), `claudia-mcp-${taskId}.json`),
            join(tmpdir(), `claudia-mcp-${taskId}-reconnect.json`),
        ];
        for (const filePath of filesToClean) {
            try {
                if (existsSync(filePath)) {
                    unlinkSync(filePath);
                    logger.debug('Cleaned up MCP temp file', { filePath });
                }
            } catch (e) {
                logger.warn('Failed to clean up MCP temp file', { filePath, error: e instanceof Error ? e.message : String(e) });
            }
        }
    }

    /**
     * Filter out the Claude Code auth conflict warning from PTY output.
     * This warning appears when ANTHROPIC_API_KEY is set alongside a claude.ai login token,
     * which is expected in custom API key modes (we set the API key explicitly).
     */
    private filterAuthConflictWarning(data: string): string {
        const cleanData = this.stripAnsi(data);

        const warningPhrases = [
            'Auth conflict',
            'Both a token (claude.ai) and an API key (ANTHROPIC_API_KEY) are set',
            'Both a token',
            'CLAUDE_CODE_OAUTH_TOKEN',
            'ANTHROPIC_AUTH_TOKEN',
            'This may lead to unexpected behavior',
            'Trying to use claude.ai? Unset the ANTHROPIC_API_KEY',
            'Trying to use ANTHROPIC_API_KEY?',
            'Trying to use ANTHROPIC_AUTH_TOKEN?',
            'sign out of claude.ai',
        ];

        for (const phrase of warningPhrases) {
            if (cleanData.includes(phrase)) {
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
     * Start a fallback timer that sends the prompt if the ready signal is never detected.
     * This prevents tasks from hanging forever when:
     * - Claude Code changes its startup text and our patterns don't match
     * - PTY data chunks split the ready signal in a way accumulated output check can't reassemble
     * - Any other unexpected startup behavior
     */
    private startReadyFallbackTimer(task: InternalTask): void {
        const READY_FALLBACK_MS = 15000;
        task.readyFallbackTimer = setTimeout(() => {
            if (!task.initialPromptSent && task.pendingPrompt) {
                console.log(`[TaskSpawner] FALLBACK: Ready signal not detected after ${READY_FALLBACK_MS}ms for task ${task.id}, sending prompt anyway`);
                console.log(`[TaskSpawner] FALLBACK: Recent output: ${JSON.stringify(this.getRecentOutput(task, 512))}`);
                task.initialPromptSent = true;
                const prompt = task.pendingPrompt;
                task.pendingPrompt = null;
                task.promptSubmitAttempts = 0;
                setTimeout(() => this.sendPromptWithRetry(task, prompt), 500);
            }
            task.readyFallbackTimer = undefined;
        }, READY_FALLBACK_MS);
    }

    /**
     * Get environment variables for spawning tasks based on API mode
     * - default: Use Claude's default settings from ~/.claude.json
     * - custom-anthropic: Use custom API key with Anthropic's API directly
     */
    private getTaskEnvironment(): { [key: string]: string } {
        const taskEnv = { ...process.env } as { [key: string]: string };
        console.log(`[TaskSpawner] Task environment PATH: ${taskEnv['PATH']?.substring(0, 200)}`);

        // Remove CLAUDECODE env var to prevent "nested session" detection in Claude Code CLI
        delete taskEnv['CLAUDECODE'];

        if (!this.configStore) return taskEnv;

        const apiMode = this.configStore.getApiMode();
        console.log(`[TaskSpawner] API mode: ${apiMode}, backend: ${this.backendType}`);

        if (apiMode === 'custom-anthropic') {
            const apiKey = this.configStore.getCustomAnthropicApiKey();
            if (apiKey) {
                taskEnv['ANTHROPIC_API_KEY'] = apiKey;
                console.log(`[TaskSpawner] Using custom Anthropic API key`);
            }
        }
        // 'default' mode: don't set any env vars, let the backend use its own settings

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

        // Numbered selection menu (like "Exit plan mode?" dialog)
        // Looks for pattern like: "❯ 1. Yes" or "  2. No" indicating a numbered choice menu
        if (str.match(/❯\s*\d+\.\s+\w/) && str.match(/\s+\d+\.\s+\w/)) {
            console.log(`[TaskSpawner] Numbered selection menu detected`);
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

        // Filter out empty sections and sections that are just the input prompt or TUI chrome
        const meaningfulSections = sections.filter(s => {
            const trimmed = s.trim();
            // Skip empty sections or sections that are just the input prompt marker
            if (!trimmed || trimmed === '❯' || /^❯\s*$/.test(trimmed)) {
                return false;
            }
            // Skip sections that are only TUI chrome (shortcuts, model info, etc.)
            // These can have prefixes like ⏵⏵ or other symbols
            if (/(?:\? for shortcuts|Try "|\/model to try|bypass permissions|shift\+tab to cycle)/i.test(trimmed) && trimmed.length < 100) {
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
            task.processStartedAt = new Date();
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
     * Creates a new AI coding task
     * @param prompt - The user's prompt for the task
     * @param workspaceId - The workspace directory path
     * @param systemPrompt - Optional system prompt override
     * @returns The created task object
     */
    async createTask(prompt: string, workspaceId: string, systemPrompt?: string, initialCols?: number, initialRows?: number): Promise<Task> {
        // Sanitize prompt to prevent command injection and other issues
        const sanitizedPrompt = sanitizePrompt(prompt);
        let sanitizedSystemPrompt = systemPrompt ? sanitizePrompt(systemPrompt) : undefined;

        const gitStateBefore = await captureGitStateBefore(workspaceId);

        // Search for relevant learnings and inject if enabled
        let injectedLearnings: LearningSearchResult[] = [];
        if (this.configStore?.getUseLearnings() && this.learningsStore) {
            try {
                // Add a timeout to prevent learnings search from blocking task creation
                const learningsPromise = this.learningsStore.searchLearnings({
                    query: sanitizedPrompt,
                    workspaceId,
                    topK: 5,
                    minScore: 0.3
                });
                const timeoutPromise = new Promise<LearningSearchResult[]>((_, reject) =>
                    setTimeout(() => reject(new Error('Learnings search timed out')), 5000)
                );
                injectedLearnings = await Promise.race([learningsPromise, timeoutPromise]);

                if (injectedLearnings.length > 0) {
                    const learningsContext = this.learningsStore.formatForContext(injectedLearnings);
                    logger.info('Injecting learnings into task', {
                        count: injectedLearnings.length,
                        scores: injectedLearnings.map(l => l.score.toFixed(3))
                    });

                    // Prepend learnings to system prompt
                    if (sanitizedSystemPrompt) {
                        sanitizedSystemPrompt = `${learningsContext}\n\n${sanitizedSystemPrompt}`;
                    } else {
                        sanitizedSystemPrompt = learningsContext;
                    }
                }
            } catch (err) {
                logger.error('Failed to search learnings', { error: err instanceof Error ? err.message : String(err) });
            }
        }

        // Log which backend we're using for debugging
        logger.info('createTask called', {
            backendType: this.backendType,
            hasBackend: !!this.backend,
            configBackend: this.configStore?.getBackend(),
            learningsInjected: injectedLearnings.length,
            initialDims: initialCols && initialRows ? `${initialCols}x${initialRows}` : 'default'
        });

        // Use OpenCode backend if configured
        let task: Task;
        if (this.backendType === 'opencode' && this.backend) {
            logger.info('Using OpenCode backend for task creation');
            task = await this.createTaskWithOpenCode(sanitizedPrompt, workspaceId, sanitizedSystemPrompt, gitStateBefore);
        } else {
            // Default: Use Claude Code with PTY (existing logic)
            logger.info('Using Claude Code backend for task creation');
            task = await this.createTaskWithClaudeCode(sanitizedPrompt, workspaceId, sanitizedSystemPrompt, gitStateBefore, initialCols, initialRows);
        }

        // Track which learnings were injected for this task (for utility updates later)
        if (injectedLearnings.length > 0) {
            this.taskLearnings.set(task.id, injectedLearnings.map(l => l.learning.id));
        }

        return task;
    }

    /**
     * Create task using OpenCode backend (HTTP API based)
     */
    private async createTaskWithOpenCode(
        prompt: string,
        workspaceId: string,
        systemPrompt: string | undefined,
        gitStateBefore: Partial<TaskGitState> | null
    ): Promise<Task> {
        if (!this.backend) {
            throw new Error('OpenCode backend not initialized');
        }

        logger.info('Creating task with OpenCode backend', { workspaceId });

        const taskEnv = this.getTaskEnvironment();

        const backendTask = await this.backend.createTask({
            prompt,
            workspaceId,
            systemPrompt,
            skipPermissions: this.configStore?.getSkipPermissions(),
        }, taskEnv);

        // Create a placeholder PTY process (not used for OpenCode, but needed for type compatibility)
        // In a full refactor, InternalTask would be made backend-agnostic
        const dummyProcess = {
            onData: () => { },
            onExit: () => { },
            write: (data: string) => {
                // Forward writes to the backend
                this.backend?.sendInput(backendTask.id, data);
            },
            resize: () => { },
            kill: () => {
                this.backend?.destroyTask(backendTask.id);
            },
            pid: 0,
            cols: 120,
            rows: 40,
            process: 'opencode'
        } as unknown as IPty;

        const now = new Date();
        const task: InternalTask = {
            id: backendTask.id,
            prompt,
            workspaceId,
            process: dummyProcess,
            state: backendTask.state,
            outputHistory: [],
            lastActivity: now,
            createdAt: now,
            isActive: false,
            initialPromptSent: true,  // OpenCode handles prompt submission
            pendingPrompt: null,
            sessionId: backendTask.sessionId,
            gitStateBefore: gitStateBefore || undefined,
            systemPrompt: systemPrompt?.trim() || undefined,
            lastOutputLength: 0,
            hasStartedProcessing: true,
        };

        this.tasks.set(task.id, task);
        this.taskBackends.set(task.id, 'opencode');
        this.scheduleSave();
        this.emit('taskCreated', this.toPublicTask(task));

        if (gitStateBefore) {
            logger.info('Captured git state before task', { taskId: task.id, commit: gitStateBefore.commitBefore?.substring(0, 7) });
        }

        return this.toPublicTask(task);
    }

    /**
     * Create task using Claude Code with PTY (existing behavior)
     */
    private async createTaskWithClaudeCode(
        prompt: string,
        workspaceId: string,
        systemPrompt: string | undefined,
        gitStateBefore: Partial<TaskGitState> | null,
        initialCols?: number,
        initialRows?: number
    ): Promise<Task> {
        console.log(`[TaskSpawner] createTaskWithClaudeCode called with workspaceId: "${workspaceId}"`);
        const id = `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

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

        // Inject Claudia MCP orchestration guidance into system prompt when enabled
        const claudiaMcpEnabled = this.configStore?.getClaudioMcpServerEnabled() ?? false;
        if (claudiaMcpEnabled) {
            const orchestrationGuidance = `
## Claudia Multi-Agent Orchestration

You are running as an agent inside Claudia, a multi-agent orchestrator. You have access to Claudia MCP tools (claudia_*) that let you collaborate with other agents.

**IMPORTANT — Avoid duplicate work:**
- Before starting any implementation, ALWAYS call \`claudia_list_tasks\` to see what other agents are already working on in this workspace
- If another task is already handling a piece of work, do NOT implement it yourself — wait for that task to finish and read its output instead
- After spawning tasks, your role shifts to **coordinator**: monitor, unblock, and integrate — do NOT start implementing the same work in parallel

**When to spawn parallel tasks:**
- When your work can be naturally decomposed into independent pieces (e.g., backend + frontend + tests)
- When you need to research multiple topics simultaneously
- When building a feature that has separable components

**How to orchestrate:**
1. Check existing tasks first — call \`claudia_list_tasks\` to see what's already running
2. Plan — break remaining work into independent, parallelizable pieces
3. Spawn — use \`claudia_create_task\` for each piece with a clear, self-contained prompt that includes all necessary context
4. Wait and monitor — poll \`claudia_get_task_status\` periodically (every 30-60s) until tasks complete. Handle any that need input via \`claudia_send_input\`
5. Review — use \`claudia_get_task_output\` to read results from completed tasks
6. Integrate — review the combined changes for conflicts or integration issues, then fix any problems yourself

**Task naming:**
- When creating tasks, always provide a short \`displayName\` (e.g., "Build API endpoint", "Write unit tests") so tasks are easy to identify in the sidebar
- Use \`claudia_rename_task\` to update your own task name if your work evolves beyond the original prompt

**Auto-title your task:**
- Early in your work (after understanding the task), use \`claudia_rename_task\` to give YOUR OWN task a short, descriptive title (3-6 words) that reflects what you're actually doing
- Your task ID is provided in the \`claudia_rename_task\` tool description — use it to rename yourself
- If the user has manually edited your task title, the rename will be rejected — do NOT retry
- If your work evolves significantly, update your title to reflect the new focus (unless user-edited)

**Guidelines:**
- Prefer 2-4 parallel tasks — don't over-decompose simple work
- Only spawn tasks when parallelization provides real value; do simple work yourself
- Each spawned task prompt should be fully self-contained — include file paths, context, and constraints so it can work independently
- While waiting for spawned tasks, do NOT start implementing features that overlap with what they're doing
- **NEVER delete or archive completed tasks** — the user wants to review their outputs. After a task completes, just report its status and read its output. Do NOT call \`claudia_delete_task\` or \`claudia_archive_task\` on finished tasks.
`;
            systemPrompt = systemPrompt
                ? `${systemPrompt}\n\n${orchestrationGuidance}`
                : orchestrationGuidance;
            logger.info('Injected Claudia MCP orchestration guidance into system prompt');
        }

        // Add custom system prompt if provided
        if (systemPrompt && systemPrompt.trim()) {
            claudeArgs.push('--system-prompt', systemPrompt.trim());
            logger.info(`Using custom system prompt`);
        }

        // Add MCP server configurations
        // IMPORTANT: Claude doesn't automatically load MCP servers from ~/.claude.json in non-interactive mode
        // We must explicitly pass --mcp-config to load MCP servers
        const mcpResult = this.buildMcpConfig(workspaceId, id);
        if (mcpResult) {
            const { mcpConfig, enabledMcpServers } = mcpResult;
            const mcpConfigJson = JSON.stringify({ mcpServers: mcpConfig }, null, 2);

            // Write to temp file for --mcp-config
            const mcpConfigFile = join(tmpdir(), `claudia-mcp-${id}.json`);
            writeFileSync(mcpConfigFile, mcpConfigJson);
            logger.info(`MCP config written to: ${mcpConfigFile}`);
            logger.debug(`MCP config contents: ${mcpConfigJson}`);
            claudeArgs.push('--mcp-config', mcpConfigFile);

            // Also write .mcp.json and .claude/settings.local.json to workspace for interactive mode
            // This is a workaround for Claude Code bug where --mcp-config doesn't work in interactive mode
            // See: https://github.com/anthropics/claude-code/issues/22404
            this.syncWorkspaceMcpConfigs([workspaceId]);

            logger.info(`Added ${enabledMcpServers.length} MCP server(s)`, { servers: enabledMcpServers.map(s => s.name) });
        } else {
            logger.warn('No enabled MCP servers found!');
        }

        // Explicitly allow all MCP tools to avoid deferred loading issues
        claudeArgs.push('--allowedTools', 'mcp__*');

        // Add Claude Code CLI switches from settings
        if (this.configStore) {
            const switches = this.configStore.getClaudeCodeSwitches();
            const switchArgs = buildClaudeCodeSwitchArgs(switches);
            if (switchArgs.length > 0) {
                claudeArgs.push(...switchArgs);
                logger.info('Applied CLI switches', { switchArgs });
            }
        }

        // Add -- to terminate argument parsing (workaround for Claude CLI bug with --mcp-config)
        // See: https://github.com/anthropics/claude-code/issues/22404
        claudeArgs.push('--');


        logger.info(`Creating task with Claude Code`, { taskId: id, workspaceId, cols: initialCols, rows: initialRows });
        logger.debug(`Command args`, { args: claudeArgs });

        // Get environment with API mode settings
        const taskEnv = this.getTaskEnvironment();
        logger.info('Task environment', {
            ANTHROPIC_BASE_URL: taskEnv['ANTHROPIC_BASE_URL'],
            HOME: taskEnv['HOME'],
            apiMode: this.configStore?.getApiMode()
        });

        const ptyProcess = spawn(exe('claude'), claudeArgs, {
            name: 'xterm-256color',
            cols: initialCols || 120, // Use provided cols or default 120 (increased from 80)
            rows: initialRows || 40,  // Use provided rows or default 40 (increased from 24)
            cwd: workspaceId,
            env: taskEnv,
        });

        const now = new Date();
        const task: InternalTask = {
            id,
            prompt,
            workspaceId,
            process: ptyProcess,
            state: 'starting',  // Start in 'starting' state until Claude actually begins processing
            processStartedAt: now,
            outputHistory: [],
            lastActivity: now,
            createdAt: now,
            isActive: false,
            initialPromptSent: false,
            pendingPrompt: prompt,
            sessionId: null,
            gitStateBefore: gitStateBefore || undefined,
            systemPrompt: systemPrompt?.trim() || undefined,
            lastOutputLength: 0,  // Initialize for state polling
            hasStartedProcessing: false,  // Will be true once output changes after prompt sent
        };





        this.setupProcessHandlers(task);
        this.tasks.set(id, task);
        this.taskBackends.set(id, 'claude-code');
        this.scheduleSave();
        this.emit('taskCreated', this.toPublicTask(task));
        this.startSessionCapture(id, workspaceId);

        // Fallback: if the ready signal is never detected (e.g., Claude Code changed its
        // startup text, or PTY chunks split the signal in a way we can't reassemble),
        // send the prompt anyway after 15 seconds to prevent the task from hanging forever.
        this.startReadyFallbackTimer(task);

        return this.toPublicTask(task);
    }

    private setupProcessHandlers(task: InternalTask): void {
        console.log(`[TaskSpawner] setupProcessHandlers: Setting up onData for task ${task.id}, pid=${task.process.pid}`);

        task.process.onData((rawData: string) => {
            // Filter out auth conflict warning (appears when ANTHROPIC_API_KEY + claude.ai token coexist)
            const data = this.filterAuthConflictWarning(rawData);
            if (!data) return;

            if (process.env.DEBUG_PTY === 'true') { // Force verbose for debug
                console.log(`[TaskSpawner] PTY Output from ${task.id} (PID ${task.process.pid}): ${JSON.stringify(data.substring(0, 50))}`);
            }

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
            // Check BOTH the current chunk AND the accumulated output to handle
            // the race condition where the ready signal is split across PTY data chunks
            if (!task.initialPromptSent && task.pendingPrompt &&
                (this.isReadyForInitialInput(cleanData) || this.isReadyForInitialInput(this.getRecentOutput(task, 4096)))) {
                console.log(`[TaskSpawner] Claude ready, sending prompt (detected in ${this.isReadyForInitialInput(cleanData) ? 'current chunk' : 'accumulated output'})`);
                task.initialPromptSent = true;
                const prompt = task.pendingPrompt;
                task.pendingPrompt = null;
                task.promptSubmitAttempts = 0;

                // Clear fallback timer since we detected the ready signal normally
                if (task.readyFallbackTimer) {
                    clearTimeout(task.readyFallbackTimer);
                    task.readyFallbackTimer = undefined;
                }

                setTimeout(() => this.sendPromptWithRetry(task, prompt), 1200);
            }

            // Note: State detection is now handled by polling in checkTaskStates()

            // Stream output to active task
            if (task.isActive) {
                this.emit('taskOutput', task.id, data);
                // Reset the flag when task becomes active again
                task.inactiveOutputLogged = false;
            } else {
                // Only log once per inactive period to avoid log spam
                if (!task.inactiveOutputLogged) {
                    console.log(`[TaskSpawner] Output received for ${task.id} but isActive=false, dropping output (subsequent drops will be silent)`);
                    task.inactiveOutputLogged = true;
                }
            }
        });

        task.process.onExit(({ exitCode }) => {
            console.log(`[TaskSpawner] Task ${task.id} exited with code ${exitCode}`);

            // Clean up ready fallback timer to prevent writing to dead PTY
            if (task.readyFallbackTimer) {
                clearTimeout(task.readyFallbackTimer);
                task.readyFallbackTimer = undefined;
            }

            // Clean up session capture interval to prevent memory leak
            this.clearSessionCapture(task.id);

            // Clean up MCP temp config files to prevent disk space leak
            this.cleanupMcpTempFiles(task.id);

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
        // Get the backend type for this task (defaults to current backend if not tracked)
        const backendType = this.taskBackends.get(task.id) || this.backendType;

        return {
            id: task.id,
            prompt: task.prompt,
            state: task.state,
            workspaceId: task.workspaceId,
            lastActivity: task.lastActivity,
            createdAt: task.createdAt,
            processStartedAt: task.processStartedAt,
            gitState: task.gitState,
            waitingInputType: task.waitingInputType,
            systemPrompt: task.systemPrompt,
            sessionId: task.sessionId || undefined,
            backendType,
            displayName: task.displayName,
            displayNameEditedByUser: task.displayNameEditedByUser,
            order: task.order,
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

    /**
     * Get all active (live) internal tasks across all workspaces.
     */
    getAllActiveTasks(): InternalTask[] {
        return Array.from(this.tasks.values());
    }

    /**
     * Get all active (live) internal tasks for a given workspace.
     */
    getActiveTasksForWorkspace(workspaceId: string): InternalTask[] {
        const results: InternalTask[] = [];
        for (const task of this.tasks.values()) {
            if (task.workspaceId === workspaceId) {
                results.push(task);
            }
        }
        return results;
    }

    /**
     * Rename a task by setting its displayName
     * Works for both active and disconnected tasks
     * @param source - 'user' if renamed by user in UI (locks title from agent edits), 'agent' if renamed by MCP agent
     */
    renameTask(taskId: string, displayName: string, source: 'user' | 'agent' = 'user'): boolean {
        const trimmed = displayName.trim();

        // Try active tasks first
        const task = this.tasks.get(taskId);
        if (task) {
            // If user edited, block agent renames
            if (source === 'agent' && task.displayNameEditedByUser) {
                console.log(`[TaskSpawner] Agent rename blocked for task ${taskId} — title was edited by user`);
                return false;
            }
            task.displayName = trimmed || undefined; // Clear if empty
            // Track whether user explicitly edited the name
            if (source === 'user') {
                task.displayNameEditedByUser = trimmed ? true : false; // Clearing resets the flag
            }
            this.scheduleSave();
            console.log(`[TaskSpawner] Renamed task ${taskId} to "${trimmed}" (source: ${source})`);
            this.emit('taskStateChanged', this.toPublicTask(task));
            return true;
        }

        // Try disconnected tasks
        const persisted = this.disconnectedTasks.get(taskId);
        if (persisted) {
            if (source === 'agent' && persisted.displayNameEditedByUser) {
                console.log(`[TaskSpawner] Agent rename blocked for disconnected task ${taskId} — title was edited by user`);
                return false;
            }
            persisted.displayName = trimmed || undefined;
            if (source === 'user') {
                persisted.displayNameEditedByUser = trimmed ? true : false;
            }
            this.scheduleSave();
            console.log(`[TaskSpawner] Renamed disconnected task ${taskId} to "${trimmed}" (source: ${source})`);
            return true;
        }

        // Try archived tasks
        const archived = this.archivedTasks.get(taskId);
        if (archived) {
            if (source === 'agent' && archived.displayNameEditedByUser) {
                console.log(`[TaskSpawner] Agent rename blocked for archived task ${taskId} — title was edited by user`);
                return false;
            }
            archived.displayName = trimmed || undefined;
            if (source === 'user') {
                archived.displayNameEditedByUser = trimmed ? true : false;
            }
            this.scheduleSave();
            console.log(`[TaskSpawner] Renamed archived task ${taskId} to "${trimmed}" (source: ${source})`);
            return true;
        }

        console.log(`[TaskSpawner] Cannot rename: task ${taskId} not found`);
        return false;
    }

    /**
     * Reorder tasks within a workspace by updating their order values.
     * Takes a map of taskId -> order value.
     */
    reorderTasks(taskOrders: { taskId: string; order: number }[]): boolean {
        let changed = false;
        for (const { taskId, order } of taskOrders) {
            // Try active tasks
            const task = this.tasks.get(taskId);
            if (task) {
                task.order = order;
                changed = true;
                continue;
            }
            // Try disconnected tasks
            const persisted = this.disconnectedTasks.get(taskId);
            if (persisted) {
                persisted.order = order;
                changed = true;
            }
        }
        if (changed) {
            this.scheduleSave();
            console.log(`[TaskSpawner] Reordered ${taskOrders.length} tasks`);
        }
        return changed;
    }

    getDisconnectedTask(taskId: string): { id: string; workspaceId: string; sessionId: string | null; prompt: string; backendType?: BackendType } | undefined {
        const persisted = this.disconnectedTasks.get(taskId);
        if (persisted) {
            return {
                id: persisted.id,
                workspaceId: persisted.workspaceId,
                sessionId: persisted.sessionId,
                prompt: persisted.prompt,
                backendType: persisted.backendType
            };
        }
        return undefined;
    }

    /**
     * Get the learning IDs that were injected into a task
     */
    getTaskLearnings(taskId: string): string[] {
        return this.taskLearnings.get(taskId) || [];
    }

    /**
     * Update utility scores for learnings used in a task based on outcome
     */
    updateTaskLearningsUtility(taskId: string, success: boolean): void {
        const learningIds = this.taskLearnings.get(taskId);
        if (!learningIds || !this.learningsStore) return;

        for (const id of learningIds) {
            this.learningsStore.updateUtility(id, success);
        }

        logger.info('Updated learning utilities', { taskId, success, count: learningIds.length });
    }

    setTaskActive(taskId: string, active: boolean): void {
        if (active) {
            // Clear decoded history from all other tasks to free memory
            // This prevents memory buildup when rapidly switching between tasks
            // Use a longer delay (30 seconds) to avoid clearing history for tasks the user is actively working with
            setTimeout(() => {
                for (const task of this.tasks.values()) {
                    // Only clear if task is still inactive AND hasn't been recently active
                    // This prevents clearing history for tasks you're switching between
                    const timeSinceLastActivity = Date.now() - task.lastActivity.getTime();
                    const isRecentlyActive = timeSinceLastActivity < 60000; // 60 seconds

                    if (task.id !== taskId && !task.isActive && !isRecentlyActive && task.previousHistory) {
                        task.previousHistory = undefined;
                        // Also clear lazyHistoryBase64 if it exists (legacy)
                        task.lazyHistoryBase64 = undefined;
                        console.log(`[TaskSpawner] Freed memory for inactive task ${task.id} (last active ${Math.round(timeSinceLastActivity / 1000)}s ago)`);
                    }
                }
            }, 30000); // 30 second delay - long enough for active task switching

            // Mark all other tasks as inactive immediately (don't wait for the timeout)
            for (const task of this.tasks.values()) {
                if (task.id !== taskId) {
                    task.isActive = false;
                }
            }
        }

        console.log(`[TaskSpawner] setTaskActive called: taskId=${taskId}, active=${active}, inTasks=${this.tasks.has(taskId)}, inDisconnected=${this.disconnectedTasks.has(taskId)}`);
        if (active && this.disconnectedTasks.has(taskId)) {
            // Don't auto-reconnect on click - just show the stored history.
            // The task will be reconnected when the user actually sends input (via writeToTask).
            console.log(`[TaskSpawner] Showing history for disconnected task ${taskId} (no auto-reconnect)`);

            // Try loading history from disk file first (primary storage), then fall back to in-memory
            let historyRestored = false;
            const historyPath = this.getTaskHistoryPath(taskId);
            if (existsSync(historyPath)) {
                try {
                    const base64 = readFileSync(historyPath, 'utf-8');
                    const history = Buffer.from(base64, 'base64').toString('utf8');
                    this.emit('taskRestore', taskId, history);
                    historyRestored = true;
                } catch (e) {
                    console.error(`[TaskSpawner] Failed to read history file for ${taskId}:`, e);
                }
            } else {
                // Fallback: check in-memory outputHistory (older tasks or migration edge cases)
                const persisted = this.disconnectedTasks.get(taskId)!;
                if (persisted.outputHistory) {
                    const history = Buffer.from(persisted.outputHistory, 'base64').toString('utf8');
                    this.emit('taskRestore', taskId, history);
                    historyRestored = true;
                }
            }

            // Always emit taskRestore so the frontend clears loading state (prevents blank screen)
            if (!historyRestored) {
                console.warn(`[TaskSpawner] No history found for disconnected task ${taskId}, sending empty restore`);
                this.emit('taskRestore', taskId, '');
            }
            return;
        }

        const task = this.tasks.get(taskId);
        console.log(`[TaskSpawner] setTaskActive: taskId=${taskId}, active=${active}, taskFound=${!!task}, currentIsActive=${task?.isActive}, ptyPid=${task?.process?.pid}`);
        if (task) {
            task.isActive = active;
            console.log(`[TaskSpawner] Set task.isActive to ${active} for ${taskId}`);

            if (active) {
                // Notify backend if using OpenCode
                const taskBackend = this.taskBackends.get(taskId);
                if (taskBackend === 'opencode' && this.backend) {
                    this.backend.setTaskActive(taskId, true);
                }

                // Send combined history (PTY output) first, then enhance with JSONL if needed
                this.sendTaskHistory(task);
            } else {
                // Notify backend if using OpenCode
                const taskBackend = this.taskBackends.get(taskId);
                if (taskBackend === 'opencode' && this.backend) {
                    this.backend.setTaskActive(taskId, false);
                }
            }
        } else if (active) {
            // Task not found in active or disconnected maps - still notify frontend
            // so it can clear the loading spinner (prevents blank screen)
            console.warn(`[TaskSpawner] Task ${taskId} not found in tasks or disconnectedTasks, sending empty restore`);
            this.emit('taskRestore', taskId, '');
        }
    }

    /**
     * Send task history to the client.
     * Always emits taskRestore (even with empty string) so the frontend
     * knows history loading is complete and can clear the loading spinner.
     */
    private sendTaskHistory(task: InternalTask): void {
        const history = this.getCombinedHistory(task);
        this.emit('taskRestore', task.id, history || '');
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

                    // Check file format (Base64 vs Raw Text) by reading a small sample
                    const fdCheck = openSync(historyPath, 'r');
                    const checkBuf = Buffer.alloc(Math.min(100, fileSize));
                    const bytesReadCheck = readSync(fdCheck, checkBuf, 0, checkBuf.length, 0);
                    closeSync(fdCheck);

                    const sample = checkBuf.subarray(0, bytesReadCheck).toString('utf8');
                    // Heuristic: Raw terminal output contains ESC or spaces.
                    // Base64 does not contain spaces (usually) and definitely no ESC.
                    const isRawText = sample.includes('\x1b') || sample.includes(' ') || sample.includes('[') || sample.includes(']');

                    let base64Content: string;
                    // Base64 encoding inflates size by ~33%, so calculate raw max size
                    const maxBase64Size = Math.floor(MAX_HISTORY_TO_SEND * 1.33);

                    if (isRawText) {
                        // Raw text file - read strictly the last portion as utf8
                        if (fileSize > MAX_HISTORY_TO_SEND) {
                            const fd = openSync(historyPath, 'r');
                            const buffer = Buffer.alloc(MAX_HISTORY_TO_SEND);
                            const offset = fileSize - MAX_HISTORY_TO_SEND;
                            readSync(fd, buffer, 0, MAX_HISTORY_TO_SEND, offset);
                            closeSync(fd);
                            // Since it's raw text, we treat it as the decoded content directly
                            // But we need to pretend it was base64 for the logic below, OR change logic below.
                            // Changing logic below is better.
                            // Actually, let's just encode it to base64 here so the rest of the function works as is
                            base64Content = buffer.toString('base64');
                            console.log(`[TaskSpawner] Loaded tail of RAW history: ${fileSize} bytes -> ${MAX_HISTORY_TO_SEND} bytes`);
                        } else {
                            const rawContent = readFileSync(historyPath, 'utf8');
                            base64Content = Buffer.from(rawContent, 'utf8').toString('base64');
                            console.log(`[TaskSpawner] Loaded complete RAW history: ${fileSize} bytes`);
                        }
                    } else {
                        // Base64 file (standard path)
                        // If file is larger than MAX_HISTORY_TO_SEND, only read the tail

                        if (fileSize > maxBase64Size) {
                            // Only read the last portion of the file
                            const fd = openSync(historyPath, 'r');
                            const buffer = Buffer.alloc(maxBase64Size);
                            const offset = fileSize - maxBase64Size;
                            readSync(fd, buffer, 0, maxBase64Size, offset);
                            closeSync(fd);
                            base64Content = buffer.toString('utf-8');
                            console.log(`[TaskSpawner] Loaded tail of Base64 history from file for ${task.id}: ${fileSize} bytes (file) -> ${maxBase64Size} bytes (loaded)`);
                        } else {
                            // File is small enough, read it all
                            base64Content = readFileSync(historyPath, 'utf-8');
                            console.log(`[TaskSpawner] Loaded complete Base64 history from file for ${task.id}: ${fileSize} bytes`);
                        }
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

    /**
     * Render JSONL conversation history as terminal-like output
     * This provides accurate history from Claude's perspective, including plan approvals
     */
    /**
     * Convert basic markdown formatting to ANSI terminal escape codes.
     * Handles bold, italic, inline code, code blocks, and headings.
     */
    private markdownToAnsi(text: string): string {
        // Remove code blocks entirely (they don't render well in this context)
        let result = text.replace(/```[\s\S]*?```/g, (match) => {
            const lines = match.split('\n');
            // Strip the opening/closing ``` lines, dim the content
            const codeLines = lines.slice(1, -1);
            return codeLines.map(l => `\x1b[90m  ${l}\x1b[0m`).join('\n');
        });

        // Bold: **text** or __text__
        result = result.replace(/\*\*(.+?)\*\*/g, '\x1b[1m$1\x1b[22m');
        result = result.replace(/__(.+?)__/g, '\x1b[1m$1\x1b[22m');

        // Italic: *text* or _text_ (but not inside words for underscore)
        result = result.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, '\x1b[3m$1\x1b[23m');
        result = result.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, '\x1b[3m$1\x1b[23m');

        // Inline code: `text`
        result = result.replace(/`([^`\n]+?)`/g, '\x1b[36m$1\x1b[0m');

        // Headings: # text (at start of line)
        result = result.replace(/^(#{1,4})\s+(.+)$/gm, (_match, _hashes: string, heading: string) => {
            return `\x1b[1;4m${heading}\x1b[0m`;
        });

        return result;
    }

    private async renderConversationAsTerminal(workspaceId: string, sessionId: string): Promise<string | null> {
        try {
            const conversation = await getConversationHistory(workspaceId, sessionId);
            if (!conversation || conversation.messages.length === 0) {
                return null;
            }

            const lines: string[] = [];
            lines.push('\x1b[90m─── Conversation History (from session file) ───\x1b[0m\r\n');

            for (const msg of conversation.messages) {
                if (msg.role === 'user') {
                    // User messages in cyan
                    lines.push(`\x1b[36m┌─ User\x1b[0m\r\n`);
                    // Truncate very long messages for display
                    const content = msg.content.length > 2000
                        ? msg.content.substring(0, 2000) + '... (truncated)'
                        : msg.content;
                    const formatted = this.markdownToAnsi(content);
                    for (const line of formatted.split('\n')) {
                        lines.push(`\x1b[36m│\x1b[0m ${line}\r\n`);
                    }
                    lines.push(`\x1b[36m└─\x1b[0m\r\n\r\n`);
                } else {
                    // Assistant messages in green
                    lines.push(`\x1b[32m┌─ Claude\x1b[0m\r\n`);
                    // Truncate very long messages for display
                    const content = msg.content.length > 3000
                        ? msg.content.substring(0, 3000) + '... (truncated)'
                        : msg.content;
                    const formatted = this.markdownToAnsi(content);
                    for (const line of formatted.split('\n')) {
                        lines.push(`\x1b[32m│\x1b[0m ${line}\r\n`);
                    }
                    lines.push(`\x1b[32m└─\x1b[0m\r\n\r\n`);
                }
            }

            lines.push('\x1b[90m─── End of Conversation History ───\x1b[0m\r\n\r\n');

            return lines.join('');
        } catch (e) {
            logger.error('Failed to render conversation history', { error: e, workspaceId, sessionId });
            return null;
        }
    }

    writeToTask(taskId: string, data: string): void {
        let task = this.tasks.get(taskId);
        console.log(`[TaskSpawner] writeToTask: taskId=${taskId}, taskFound=${!!task}, ptyPid=${task?.process?.pid}, isActive=${task?.isActive}`);

        // If task not found in active tasks, check if it's disconnected and needs reconnecting
        if (!task) {
            if (this.disconnectedTasks.has(taskId)) {
                console.log(`[TaskSpawner] Task ${taskId} is disconnected, auto-reconnecting before write`);
                console.log(`[TaskSpawner] Input length: ${data.length}, Data preview: ${JSON.stringify(data.substring(0, 50))}`);
                const reconnectedTask = this.reconnectTask(taskId);
                if (reconnectedTask) {
                    task = this.tasks.get(taskId);
                    if (task) {
                        task.isActive = true;
                        this.emit('tasksUpdated');
                        // Give the PTY a moment to initialize before writing
                        setTimeout(() => this.writeToTask(taskId, data), 500);
                        return;
                    }
                }
                console.log(`[TaskSpawner] Failed to reconnect task ${taskId} for write`);
            } else {
                console.log(`[TaskSpawner] Cannot write to task ${taskId}: task not found`);
            }
            return;
        }

        // Check if this task uses the OpenCode backend
        const taskBackend = this.taskBackends.get(taskId);
        if (taskBackend === 'opencode' && this.backend) {
            console.log(`[TaskSpawner] Writing to OpenCode backend for task ${taskId}`);
            this.backend.sendInput(taskId, data);
            return;
        }

        console.log(`[TaskSpawner] Writing to Claude Code PTY for task ${taskId} (PID: ${task.process.pid})`);
        console.log(`[TaskSpawner] Data to write: ${JSON.stringify(data)}`);

        // Claude Code PTY-based input handling
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

    resizeTask(taskId: string, cols: number, rows: number): void {
        const task = this.tasks.get(taskId);
        if (!task) {
            // Silently ignore resize for disconnected tasks (will reconnect on select)
            return;
        }

        // Check if this task uses the OpenCode backend
        const taskBackend = this.taskBackends.get(taskId);
        if (taskBackend === 'opencode' && this.backend) {
            try {
                this.backend.resizeTask(taskId, cols, rows);
            } catch (error) {
                logger.warn('Ignoring backend resize failure', {
                    taskId,
                    cols,
                    rows,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
            return;
        }

        try {
            task.process.resize(cols, rows);
        } catch (error) {
            // PTY can exit between task lookup and resize; ignore noisy race.
            logger.warn('Ignoring PTY resize failure', {
                taskId,
                cols,
                rows,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    interruptTask(taskId: string): boolean {
        const task = this.tasks.get(taskId);
        if (!task || task.state !== 'busy') return false;

        // Check if this task uses the OpenCode backend
        const taskBackend = this.taskBackends.get(taskId);
        if (taskBackend === 'opencode' && this.backend) {
            return this.backend.interruptTask(taskId);
        }

        console.log(`[TaskSpawner] Interrupting task ${taskId}`);
        task.process.write('\x1b');
        return true;
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
            // Check if this task uses the OpenCode backend
            const taskBackend = this.taskBackends.get(taskId);
            if (taskBackend === 'opencode' && this.backend) {
                return this.backend.stopTask(taskId);
            }

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

        // Clean up MCP temp config files
        this.cleanupMcpTempFiles(taskId);

        // Check if this task uses the OpenCode backend
        const taskBackend = this.taskBackends.get(taskId);

        const task = this.tasks.get(taskId);
        if (task) {
            logger.info(`Found task in live tasks`, { taskId, state: task.state });

            // If using OpenCode backend, use backend's destroy method
            if (taskBackend === 'opencode' && this.backend) {
                this.backend.destroyTask(taskId);
                this.tasks.delete(taskId);
                this.taskBackends.delete(taskId);
                destroyed = true;
                source = 'live (opencode)';
            } else {
                // Claude Code: If task is running, first try to stop it gracefully
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
                this.taskBackends.delete(taskId);
                try {
                    task.process.kill();
                } catch (_e) {
                    // Process might already be dead
                }
                destroyed = true;
                source = 'live';
            }
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
            // Save immediately — destructive operations must not be lost to debounce
            this.saveTasks();
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
                displayName: task.displayName,
                displayNameEditedByUser: task.displayNameEditedByUser,
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
                displayName: disconnected.displayName,
                displayNameEditedByUser: disconnected.displayNameEditedByUser,
            };
            this.archivedTasks.set(taskId, archivedMetadata);
            this.disconnectedTasks.delete(taskId);
            archived = true;
        }

        // Only emit once, regardless of which map(s) the task was in
        if (archived) {
            // Save immediately — destructive operations must not be lost to debounce
            this.saveTasks();
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
            displayName: persisted.displayName,
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
            displayName: archived.displayName,
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
            displayName: archived.displayName,
            sessionId: archived.sessionId || undefined,
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
            displayName: persisted.displayName,
            displayNameEditedByUser: persisted.displayNameEditedByUser,
            sessionId: persisted.sessionId || undefined,
            gitState: persisted.gitState,
            systemPrompt: persisted.systemPrompt,
            backendType: this.taskBackends.get(persisted.id) || 'claude-code' as const,
            order: persisted.order,
        }));

        return [...liveTasks, ...disconnectedTasks];
    }

    reconnectTask(taskId: string): Task | null {
        const persisted = this.disconnectedTasks.get(taskId);
        if (!persisted) {
            console.log(`[TaskSpawner] Cannot reconnect: task ${taskId} not found`);
            return null;
        }

        // Determine which backend was used to create this task
        // Use persisted backendType, fallback to 'claude-code' for backwards compatibility
        const taskBackendType = persisted.backendType || 'claude-code';

        console.log(`[TaskSpawner] Reconnecting task ${taskId} using ${taskBackendType} backend`);
        console.log(`[TaskSpawner] Persisted session ID: ${persisted.sessionId}`);


        // Get environment with API mode settings
        const taskEnv = this.getTaskEnvironment();

        let ptyProcess: IPty;

        // Check if session file exists before trying to resume
        let sessionIdToUse = persisted.sessionId;
        if (sessionIdToUse) {
            const claudeDir = this.getClaudeProjectsDir(persisted.workspaceId);
            const sessionFilePath = join(claudeDir, `${sessionIdToUse}.jsonl`);
            if (!existsSync(sessionFilePath)) {
                console.log(`[TaskSpawner] Session file not found for ${taskId}: ${sessionFilePath}`);
                console.log(`[TaskSpawner] Will start fresh session instead of resuming`);
                sessionIdToUse = null;
                // Clear the invalid session ID from persisted data
                persisted.sessionId = null;
                this.scheduleSave();
            }
        }


        if (taskBackendType === 'opencode') {
            // Use OpenCode backend for reconnection
            const opencodeArgs: string[] = [];

            if (sessionIdToUse) {
                opencodeArgs.push('--session', sessionIdToUse);
                console.log(`[TaskSpawner] Reconnecting OpenCode task ${taskId} with session ${sessionIdToUse}`);
            } else {
                console.log(`[TaskSpawner] Reconnecting OpenCode task ${taskId} (fresh start)`);
            }

            ptyProcess = spawn(exe('opencode'), opencodeArgs, {
                name: 'xterm-256color',
                cols: 120,
                rows: 40,
                cwd: persisted.workspaceId,
                env: taskEnv,
            });
        } else {
            // Use Claude Code backend for reconnection (default)
            const customArgs = process.env['CC_CLAUDE_ARGS']
                ? process.env['CC_CLAUDE_ARGS'].split(' ')
                : [];

            const claudeArgs = [...customArgs];

            if (this.configStore?.getSkipPermissions()) {
                claudeArgs.push('--dangerously-skip-permissions');
            }

            // Explicitly allow all MCP tools to avoid deferred loading issues
            claudeArgs.push('--allowedTools', 'mcp__*');

            // Add Claude Code CLI switches from settings
            if (this.configStore) {
                const switches = this.configStore.getClaudeCodeSwitches();
                const switchArgs = buildClaudeCodeSwitchArgs(switches);
                if (switchArgs.length > 0) {
                    claudeArgs.push(...switchArgs);
                    console.log(`[TaskSpawner] Applied CLI switches for reconnect`, { switchArgs });
                }
            }

            // Add MCP server configurations for reconnection
            const mcpResult = this.buildMcpConfig(persisted.workspaceId, taskId);
            if (mcpResult) {
                const mcpConfigJson = JSON.stringify({ mcpServers: mcpResult.mcpConfig }, null, 2);
                const mcpConfigFile = join(tmpdir(), `claudia-mcp-${taskId}-reconnect.json`);
                writeFileSync(mcpConfigFile, mcpConfigJson);
                claudeArgs.push('--mcp-config', mcpConfigFile);
                console.log(`[TaskSpawner] Added ${mcpResult.enabledMcpServers.length} MCP server(s) for reconnection via ${mcpConfigFile}`);
            }

            if (sessionIdToUse) {
                claudeArgs.push('--resume', sessionIdToUse);
                console.log(`[TaskSpawner] Reconnecting Claude Code task ${taskId} with session ${sessionIdToUse}`);
            } else {
                console.log(`[TaskSpawner] Reconnecting Claude Code task ${taskId} (fresh start)`);
            }

            ptyProcess = spawn(exe('claude'), claudeArgs, {
                name: 'xterm-256color',
                cols: 120,
                rows: 40,
                cwd: persisted.workspaceId,
                env: taskEnv,
            });
        }

        console.log(`[TaskSpawner] Process spawned for task ${taskId}, PID: ${ptyProcess.pid}`);
        console.log(`[TaskSpawner] PTY Details: cols=${ptyProcess.cols}, rows=${ptyProcess.rows}`);


        const now = new Date();

        // Preserve previous history so it can be shown when the task is selected.
        // Load from disk file (primary) or in-memory persisted data (fallback).
        let previousHistory: Buffer | undefined;
        try {
            const historyPath = this.getTaskHistoryPath(taskId);
            if (existsSync(historyPath)) {
                const fileContent = readFileSync(historyPath, 'utf-8');
                // Detect format (base64 vs raw text) using same heuristic as getCombinedHistory
                const sample = fileContent.substring(0, 100);
                const isRawText = sample.includes('\x1b') || sample.includes(' ') || sample.includes('[') || sample.includes(']');
                if (isRawText) {
                    previousHistory = Buffer.from(fileContent, 'utf-8');
                } else {
                    previousHistory = Buffer.from(fileContent, 'base64');
                }
                // Keep the file on disk until saveTasks() overwrites it.
                // Deleting here creates a data loss window if the server crashes
                // before saveTasks() runs.
                console.log(`[TaskSpawner] Preserved ${previousHistory.length} bytes of history for ${taskId} on reconnect`);
            }
        } catch (e) {
            console.error(`[TaskSpawner] Failed to load history file for ${taskId} on reconnect:`, e);
        }
        // Fallback: check in-memory persisted outputHistory
        if (!previousHistory && persisted.outputHistory) {
            try {
                previousHistory = Buffer.from(persisted.outputHistory, 'base64');
                console.log(`[TaskSpawner] Preserved ${previousHistory.length} bytes of in-memory history for ${taskId}`);
            } catch (e) {
                console.error(`[TaskSpawner] Failed to decode in-memory history for ${taskId}:`, e);
            }
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
            processStartedAt: shouldContinue
                ? (persisted.processStartedAt ? new Date(persisted.processStartedAt) : now)
                : undefined,  // Preserve original start time across reconnect, or use now as fallback
            outputHistory: [Buffer.from(resumeMessage)], // Start fresh, only resume message
            previousHistory, // Historical output from before reconnect (loaded from file or in-memory)
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
            displayName: persisted.displayName,  // Preserve user-set display name across reconnection
            displayNameEditedByUser: persisted.displayNameEditedByUser,  // Preserve user-edit flag
            systemPrompt: persisted.systemPrompt,  // Preserve custom system prompt
            gitStateBefore: persisted.gitState ? persisted.gitState : undefined,  // Preserve git state
        };

        console.log(`[TaskSpawner] reconnectTask: Setting up process handlers for ${task.id}, ptyPid=${ptyProcess.pid}`);
        this.setupProcessHandlers(task);
        this.tasks.set(task.id, task);
        this.taskBackends.set(task.id, taskBackendType);
        console.log(`[TaskSpawner] reconnectTask: Task ${task.id} added to tasks map (backend: ${taskBackendType})`);

        // Start fallback timer for shouldContinue tasks (same race condition as new tasks)
        if (shouldContinue && taskBackendType === 'claude-code') {
            this.startReadyFallbackTimer(task);
        }

        this.disconnectedTasks.delete(taskId);
        this.scheduleSave();

        // Start session capture so we detect the new/resumed session file
        // This is critical for fresh starts (no sessionId) and also covers cases where
        // Claude Code creates a new session file even when resuming
        if (taskBackendType === 'claude-code') {
            this.startSessionCapture(taskId, persisted.workspaceId);
        }

        this.emit('taskStateChanged', this.toPublicTask(task));
        return this.toPublicTask(task);
    }

    destroy(): void {
        // Cancel any pending debounced save FIRST to prevent it from firing
        // after tasks.clear() — which would overwrite valid data with an empty list
        if (this.saveDebounceTimer) {
            clearTimeout(this.saveDebounceTimer);
            this.saveDebounceTimer = null;
        }
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
            // Clean up MCP temp files
            this.cleanupMcpTempFiles(task.id);
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

    /**
     * Disconnect a task (simulate server restart or connection loss)
     * Kills the process but keeps the task state as 'disconnected'
     */
    disconnectTask(taskId: string): boolean {
        const task = this.tasks.get(taskId);
        if (!task) {
            // Already disconnected or doesn't exist?
            if (this.disconnectedTasks.has(taskId)) return true;
            return false;
        }

        console.log(`[TaskSpawner] Disconnecting task ${taskId} (simulating restart)`);

        // Kill the process
        try {
            task.process.kill();
        } catch (e) {
            console.error(`[TaskSpawner] Failed to kill process for ${taskId}:`, e);
        }

        // Create persisted task entry - preserve all metadata from the active task
        const persisted: PersistedTask = {
            id: task.id,
            prompt: task.prompt,
            workspaceId: task.workspaceId,
            createdAt: task.createdAt.toISOString(),
            lastActivity: task.lastActivity.toISOString(),
            lastState: task.state,
            sessionId: task.sessionId,
            // We don't save full history to memory here, it's already on disk/in memory
            backendType: this.taskBackends.get(task.id) || 'claude-code',
            outputHistory: undefined, // Will be lazy loaded
            gitState: task.gitState,
            systemPrompt: task.systemPrompt,
            displayName: task.displayName,
            wasInterrupted: true, // Mark as interrupted so it shows correct state on resume
            shouldContinue: false,
        };

        this.disconnectedTasks.set(taskId, persisted);
        this.tasks.delete(taskId);

        this.scheduleSave();
        this.emit('taskStateChanged', { ...this.toPublicTask(task), state: 'disconnected' });
        this.emit('tasksUpdated');

        return true;
    }

    /**
     * Clear all tasks (active, disconnected, archived) and delete their data
     */
    clearAllTasks(): void {
        console.log('[TaskSpawner] Clearing ALL tasks');

        // 1. Kill all active tasks
        for (const task of this.tasks.values()) {
            try {
                task.process.kill();
            } catch (e) { }
        }
        this.tasks.clear();

        // 2. Clear persisted maps
        this.disconnectedTasks.clear();
        this.archivedTasks.clear();

        // 3. Delete tasks.json
        try {
            if (existsSync(this.persistencePath)) {
                unlinkSync(this.persistencePath);
            }
        } catch (e) {
            console.error('[TaskSpawner] Failed to delete tasks.json', e);
        }

        // 4. Delete all history files in task-histories
        try {
            const historyDir = this.getHistoryDir();
            if (existsSync(historyDir)) {
                const files = readdirSync(historyDir);
                for (const file of files) {
                    unlinkSync(join(historyDir, file));
                }
            }
        } catch (e) {
            console.error('[TaskSpawner] Failed to clear history directory', e);
        }

        this.emit('tasksUpdated');
    }
}
