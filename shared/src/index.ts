// Simplified type definitions for task-based Claude Code spawner

// Export shared configuration  
export * from './config.js';

export type TaskState = 'idle' | 'busy' | 'starting' | 'waiting_input' | 'exited' | 'disconnected' | 'interrupted' | 'archived';

// Types of input Claude Code might be waiting for
export type WaitingInputType = 'question' | 'permission' | 'text_input' | 'confirmation';

// Git state tracking for task revert functionality
export interface TaskGitState {
    commitBefore: string;        // Git commit hash before task started
    commitAfter?: string;        // Git commit hash after task completed (if changed)
    uncommittedBefore: boolean;  // Were there uncommitted changes before?
    filesModified: string[];     // Files modified by the task
    canRevert: boolean;          // Can this task be reverted?
    revertedAt?: string;         // ISO timestamp when reverted
}

// File diff for viewing changes
export interface FileDiff {
    filePath: string;
    status: 'added' | 'modified' | 'deleted';
    diff: string;  // unified diff format
}

// Which backend created/manages a task
export type BackendType = 'claude-code' | 'opencode';

export interface Task {
    id: string;
    prompt: string;          // The user's message that created this task
    state: TaskState;
    workspaceId: string;     // Workspace (folder) this task runs in
    createdAt: Date;
    lastActivity: Date;
    processStartedAt?: Date; // When the current process run started (resets on restart/continue)
    gitState?: TaskGitState; // Git state for revert functionality
    waitingInputType?: WaitingInputType; // Type of input Claude is waiting for
    systemPrompt?: string;   // Custom system prompt for this task
    order?: number;          // Display order within workspace (lower = higher in list)
    sessionId?: string | null;      // Session ID for conversation history (null if not captured yet)
    backendType?: BackendType; // Which backend created this task (for conversation lookup)
    displayName?: string;    // User-editable display name (shown instead of prompt when set)
    displayNameEditedByUser?: boolean; // True if the user manually edited the display name (prevents agent auto-title)
    tokenUsage?: TaskTokenUsage; // Token usage data for this task
    // Branch of a git worktree this task's Claude session created/moved onto
    // (detected by diffing the repo's worktree list while the task runs). Used to
    // annotate the task row with a worktree badge. Undefined = no worktree detected.
    sessionWorktreeBranch?: string;
    sessionWorktreePrInfo?: WorkspacePrInfo | null; // PR for that branch (if any)
}

export interface WorkspaceReference {
    id: string;              // UUID
    path: string;            // Absolute path to referenced directory
    name: string;            // Display name (defaults to folder name)
    description?: string;    // Optional user description of what this reference contains
}

export interface Workspace {
    id: string;              // Full path
    name: string;            // Folder name
    createdAt: string;
    systemPrompt?: string;   // Custom system prompt for this workspace
    displayName?: string;    // User-editable display name (shown instead of folder name when set)
    references?: WorkspaceReference[];  // Referenced workspaces/folders for cross-workspace context

    // Worktree fields (optional — only set for worktree workspaces)
    worktreeParentId?: string;   // If this workspace IS a worktree, the parent workspace's id (absolute path)
    worktreeBranch?: string;     // Branch checked out in this worktree
    autoWorktree?: boolean;      // If true, new tasks auto-create an isolated worktree

    // GitHub PR associated with this workspace's branch (resolved via `gh`, cached server-side).
    // null = looked up, no PR found; undefined = not yet looked up.
    prInfo?: WorkspacePrInfo | null;
}

export interface WorkspacePrInfo {
    number: number;
    title: string;
    state: 'draft' | 'open' | 'merged' | 'closed';
    url: string;
    ci?: 'passed' | 'failed' | 'running' | 'none';  // statusCheckRollup summary
}

// Metadata about a single git worktree (from `git worktree list --porcelain`)
export interface WorktreeInfo {
    path: string;            // Absolute path to the worktree directory
    branch: string;          // Branch checked out (e.g. "refs/heads/feature/foo" or detached hash)
    commitHash: string;      // Current HEAD commit hash
    isMain: boolean;         // True for the primary working tree
    isLocked: boolean;       // True if the worktree is locked
    lockedReason?: string;   // Why it's locked (if locked)
    prunable: boolean;       // True if the directory no longer exists (stale)
    taskCount?: number;      // Number of active Claudia tasks in this worktree (enriched by server)
}

export interface RecentWorkspace {
    id: string;              // Full path
    name: string;            // Folder name
    removedAt: string;       // When it was removed from workspaces
}

export interface FileNode {
    id: string;              // Full path (unique identifier)
    name: string;            // File/folder name
    path: string;            // Relative path from workspace root
    type: 'file' | 'directory';
    children?: FileNode[];   // For directories (loaded lazily)
}

// Supervisor Chat types
export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    taskId?: string;  // Optional: associated task for context
    workspaceId?: string;  // Optional: workspace this message belongs to
}

// Task Supervisor types
export interface SuggestedAction {
    id: string;
    label: string;
    description: string;
    type: 'input' | 'command' | 'approve' | 'reject' | 'custom';
    value: string;
}

export interface TaskSummary {
    taskId: string;
    status: 'completed' | 'needs_input' | 'error' | 'waiting_permission' | 'asking_question';
    summary: string;
    lastAction?: string;
    suggestedActions: SuggestedAction[];
    timestamp: Date;
}

// Checkpoint/Timeline types
export interface Checkpoint {
    id: string;                    // Unique identifier
    taskId: string;                // Which task this checkpoint belongs to
    workspaceId: string;           // Which workspace
    name: string;                  // User-provided or auto-generated name
    description?: string;          // Optional description
    timestamp: string;             // ISO timestamp when created
    gitRef?: string;               // Git commit SHA at checkpoint time
    gitBranch?: string;            // Current branch at checkpoint time
    gitDiff?: string;              // Uncommitted changes (unified diff) at checkpoint time
    metadata?: {
        filesModified?: number;
        isCurrent?: boolean;
    };
}

// Scheduled task (cron) for recurring/one-shot prompts
export interface ScheduledTask {
    id: string;                    // 8-char unique ID
    taskId: string;                // Claudia task this scheduled job belongs to
    workspaceId: string;           // Workspace context
    cronExpression: string;        // 5-field cron expression (minute hour day-of-month month day-of-week)
    prompt: string;                // The prompt to run when fired
    isRecurring: boolean;          // true = recurring, false = one-shot
    isPaused: boolean;             // true = paused (won't fire until resumed)
    createdAt: string;             // ISO timestamp
    expiresAt: string;             // ISO timestamp (createdAt + 3 days for recurring)
    lastFiredAt?: string;          // ISO timestamp of last fire
    nextFireAt?: string;           // ISO timestamp of next computed fire time
    fireCount: number;             // How many times it has fired
}

// WebSocket message types
export type WSMessageType =
    // Task lifecycle
    | 'task:created'
    | 'task:stateChanged'
    | 'task:output'
    | 'task:restore'
    | 'task:destroyed'
    | 'task:stopped'
    | 'task:stopAll:result'
    | 'task:waitingInput'
    | 'task:revertResult'
    | 'task:deleteRequest'
    | 'task:deleteResolved'
    | 'tasks:updated'
    | 'task:renamed'
    // Archived tasks
    | 'task:archived'
    | 'task:archived:list'
    | 'task:archived:restored'
    | 'task:archived:restoreError'
    | 'task:archived:deleted'
    | 'task:archived:continued'
    | 'task:archived:continueError'
    | 'archive:updated'
    // Workspace management
    | 'workspace:created'
    | 'workspace:deleted'
    | 'workspace:reordered'
    | 'workspace:updated'
    | 'workspace:renamed'
    | 'workspace:recent:list'
    | 'workspace:resetResult'
    // Worktree management
    | 'worktree:list'
    | 'worktree:listed'
    | 'worktree:create'
    | 'worktree:created'
    | 'worktree:remove'
    | 'worktree:removed'
    | 'worktree:prune'
    | 'worktree:pruned'
    | 'worktree:error'
    // Task reordering
    | 'tasks:reordered'
    // Embedded shell terminals
    | 'shell:created'
    | 'shell:output'
    | 'shell:exited'
    | 'shell:closed'
    // Supervisor/Chat
    | 'task:summary'
    | 'supervisor:chat:response'
    | 'supervisor:chat:history'
    | 'supervisor:chat:typing'
    // Scheduled tasks (cron)
    | 'cron:created'
    | 'cron:deleted'
    | 'cron:list'
    | 'cron:fired'
    | 'cron:ran'
    | 'cron:updated'
    // Checkpoints / Timeline
    | 'checkpoint:created'
    | 'checkpoint:list'
    | 'checkpoint:restored'
    | 'checkpoint:deleted'
    | 'checkpoint:forked'
    | 'checkpoint:error'
    // Token usage
    | 'task:tokenUsage'
    // Server status
    | 'server:reloading'
    | 'server:reconnecting'
    | 'init'
    // Tunnel status
    | 'tunnel:status'
    // Error handling
    | 'error';

export interface WSMessage {
    type: WSMessageType;
    payload: unknown;
}

/**
 * Error payload structure for WebSocket error messages
 */
export interface WSErrorPayload {
    message: string;
    code?: string;
    originalType?: string;
}

// Token usage tracking types
export interface ModelPricing {
    inputPer1MTokens: number;
    outputPer1MTokens: number;
    cacheCreatePer1MTokens: number;
    cacheReadPer1MTokens: number;
}

export interface ModelTokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    costUsd: number;
}

export interface TaskTokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    totalCostUsd: number;
    modelBreakdown: Record<string, ModelTokenUsage>;
    lastUpdated: string;
}

export interface UsageDashboardData {
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheCreationTokens: number;
    totalCacheReadTokens: number;
    byWorkspace: Record<string, {
        name: string;
        costUsd: number;
        inputTokens: number;
        outputTokens: number;
        cacheCreationTokens: number;
        cacheReadTokens: number;
        taskCount: number;
    }>;
    byModel: Record<string, ModelTokenUsage>;
    taskCount: number;
    lastUpdated: string;
}
