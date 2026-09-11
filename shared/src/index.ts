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

// ---------------------------------------------------------------------------
// Coding agents
//
// The SINGLE source of truth for "which coding agents exist". Everything that
// used to hand-write `'claude-code' | 'opencode'` (six places, none deriving
// from each other) derives from AGENT_IDS instead. Adding an agent is one
// entry here plus one adapter file under backend/src/agents/adapters/.
// ---------------------------------------------------------------------------

/** Every coding agent Claudia knows how to run, in display order. */
export const AGENT_IDS = ['claude-code', 'opencode'] as const;

/**
 * Which agent created/manages a task.
 * Historical name — kept so the ~200 existing references keep compiling.
 */
export type BackendType = typeof AGENT_IDS[number];

/** Preferred name going forward. Identical to BackendType. */
export type AgentId = BackendType;

/** True if an arbitrary string names a registered agent (narrowing guard). */
export function isAgentId(value: unknown): value is AgentId {
    return typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value);
}

/**
 * How an agent presents itself in the UI. Served by `/api/backend/status` so
 * the frontend renders the agent list from data instead of hardcoded markup.
 */
export interface AgentDisplayInfo {
    id: AgentId;
    /** Settings display name, e.g. "Claude Code". */
    name: string;
    /**
     * Task-row badge text. Short and lowercase — `claude`, `opencode`, `gpt`.
     * A glance-level identifier in a dense sidebar, never a product name.
     */
    shortLabel: string;
    description: string;
    installUrl: string;
    /** Badge/accent colour, CSS hex. */
    colour: string;
}

/**
 * Per-agent feature switches. These replace the `=== 'claude-code'` string
 * checks that used to silently switch subsystems off for any other agent.
 *
 * EVERY FIELD IS REQUIRED ON PURPOSE: an adapter that forgets one is a
 * compile error, not a subsystem that quietly does nothing at runtime.
 */
export interface AgentCapabilities {
    /** Engine polls PTY output length/tail to infer busy/idle. */
    ptyStatePolling: boolean;
    /** Agent writes a session transcript file the engine can watch/parse. */
    sessionFileCapture: boolean;
    /** Idle tasks are reaped after the inactivity window. */
    idleReaper: boolean;
    /** Runaway-memory guard watches this agent's processes. */
    memoryGuard: boolean;
    /** Agent can prompt a human mid-turn (permission dialogs). */
    interactiveApprovals: boolean;
    /** Resume refuses unless the session transcript still exists on disk. */
    resumeRequiresSessionFile: boolean;
    /** CLI accepts a system-prompt flag (Codex does not). */
    supportsSystemPromptFlag: boolean;
    /** How the engine talks to the process. */
    transport: 'pty' | 'json-stream';
    /** Typical resident footprint, MB — tunes the memory guard per agent. */
    expectedMemoryMb: number;
}

/**
 * Normalised event produced by an agent's transport.
 *
 * DESIGN NOTE: this is intended to become the `conversation:event` WebSocket
 * payload (#136), so the structured-transcript view and a future JSON-stream
 * transport share one schema rather than growing two incompatible ones.
 * Deliberately minimal for now — nothing consumes it yet.
 */
export type AgentEvent =
    | { type: 'output'; data: string }
    | { type: 'state'; state: TaskState }
    | { type: 'session'; sessionId: string }
    | {
          type: 'tokens';
          usage: {
              inputTokens?: number;
              outputTokens?: number;
              cacheCreationTokens?: number;
              cacheReadTokens?: number;
          };
      }
    | { type: 'exit'; code: number };

/** Installation/liveness probe result for one agent. */
export interface AgentDetectResult {
    installed: boolean;
    version?: string;
    error?: string;
    /** OpenCode-style agents that also run a background server. */
    serverRunning?: boolean;
}

/** Response body of `GET /api/backend/status`. */
export interface BackendStatusResponse extends AgentDetectResult {
    /** The currently configured agent. */
    backend: AgentId;
    /** Every registered agent's display info, in registry order. */
    availableBackends: AgentDisplayInfo[];
    /** Detection result for every registered agent, keyed by id. */
    statuses: Record<AgentId, AgentDetectResult>;
}

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
    parentTaskId?: string;  // Task that spawned this one via claudia_create_task (MCP)
    // Whether this task's code changes are landed on the default branch or still
    // outstanding on its worktree branch. Undefined/null = nothing to indicate.
    workStatus?: TaskWorkStatus | null;
    // Short sequential identifier (1, 2, 3…) unique per install, rendered as
    // "#48". Stable for the task's lifetime, never reused. Both agents (MCP
    // tools accept "#48"/"48" wherever they take a taskId) and developers
    // ("restart 48") reference tasks by it; the long id stays the primary key.
    taskNumber?: number;
}

/**
 * Where a task's code changes currently live: still on its branch/worktree, or
 * already in the default branch.
 *
 * The sidebar fills up with idle tasks from previous days and nothing says
 * which of them still hold work. Counting is deliberately patch-based
 * (`git cherry`) rather than sha-based, so a rebased or cherry-picked branch
 * still reads as landed instead of looking outstanding forever.
 *
 * Absent/null means "nothing to say" — the task never touched code, or it is
 * not working in a worktree — and the UI shows no indicator at all.
 */
export interface TaskWorkStatus {
    branch: string;              // Branch the work lives on
    dirtyFiles: number;          // Uncommitted files (modified, staged or untracked)
    outstandingCommits: number;  // Commits on the branch with no equivalent in the default branch
    landedCommits: number;       // Commits whose patch is already in the default branch
    baseRef: string;             // What it was compared against (e.g. "origin/main")
    checkedAt: string;           // ISO timestamp of the check
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
    // Whether the workspace path currently exists on disk. Computed server-side
    // on every read (never persisted) so an unmounted drive or a config imported
    // from another machine shows as 'unavailable' instead of being dropped, and
    // flips back to 'available' as soon as the path reappears.
    status?: 'available' | 'unavailable';
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

// TODO taxonomy — a live, ordered work-plan managed by the task's Claude session.
export type TodoStatus = 'pending' | 'active' | 'completed';
export type TodoPriority = 'high' | 'normal' | 'low';
export type TodoSource = 'user' | 'claude' | 'github';
export type TodoKind = 'manual' | 'action' | 'github-issue' | 'github-pr';

// Per-task TODO items. Claude seeds and continuously manages the list; the user
// can complete/reorder too. New fields are optional for back-compat with v1 rows.
export interface TodoItem {
    id: string;
    taskId: string;
    title: string;
    description?: string;
    completed: boolean;             // kept in sync with status === 'completed'
    status?: TodoStatus;            // pending | active (working now) | completed
    priority?: TodoPriority;        // high | normal | low
    order?: number;                 // execution sequence (lower = earlier)
    source?: TodoSource;            // who created it
    kind?: TodoKind;                // manual | action | github-issue | github-pr
    url?: string;                   // external link (GitHub issue/PR) — opened externally
    externalRef?: string;           // e.g. "amd/gaia#1859"
    parentId?: string;              // one-level subtask hierarchy (parents have no parentId)
    createdAt: string;
    completedAt?: string;
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
    | 'task:deleteRejected'
    | 'tasks:updated'
    | 'task:renamed'
    // Multi-client viewer model (P0 §5.6 "Multi-client viewer model")
    | 'task:focus'
    | 'task:viewers'
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
    // Per-task TODOs
    | 'todo:created'
    | 'todo:updated'
    | 'todo:deleted'
    | 'todos:reordered'
    // Checkpoints / Timeline
    | 'checkpoint:created'
    | 'checkpoint:list'
    | 'checkpoint:restored'
    | 'checkpoint:deleted'
    | 'checkpoint:forked'
    | 'checkpoint:error'
    // Token usage
    | 'task:tokenUsage'
    // Jira integration
    | 'jira:focusTicket'
    | 'jira:writeRequest'
    | 'jira:writeApproved'
    | 'jira:writeRejected'
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
 * Inbound: the sending client declares that `taskId` is the task it is
 * currently displaying. The most recent client to focus a task becomes its
 * OWNER, and only the owner's `task:resize` frames are applied to the PTY.
 */
export interface TaskFocusPayload {
    taskId: string;
}

/**
 * Outbound: broadcast whenever a task's viewer set or owner changes (focus,
 * an owner resize that changed the size, or a client disconnecting).
 *
 * `count` is the number of CONNECTED CLIENTS CURRENTLY FOCUSED ON THIS TASK —
 * not the number of sockets connected to the server. The UI renders exactly one
 * terminal at a time, so "focused" and "viewing" are the same thing, which makes
 * this both the useful definition and one we can compute exactly.
 *
 * `cols`/`rows` are the OWNER's terminal dimensions, i.e. the size the PTY is
 * actually running at. Non-owner clients render at these dimensions inside
 * their own viewport instead of reflowing to their local width.
 */
export interface TaskViewersPayload {
    taskId: string;
    count: number;
    ownerClientId: string | null;
    cols?: number;
    rows?: number;
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
// NOTE: the .js extension is REQUIRED. This package is ESM ("type": "module")
// and Node's ESM resolver does not add extensions, so an extensionless
// specifier crashes `node backend/dist/index.js` with ERR_MODULE_NOT_FOUND —
// i.e. the published `claudia` CLI and the packaged Electron app. `tsx watch`
// resolves it fine, which is why the dev loop never caught it.
export * from './terminal.js';
