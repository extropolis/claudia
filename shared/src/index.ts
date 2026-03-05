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
    gitState?: TaskGitState; // Git state for revert functionality
    waitingInputType?: WaitingInputType; // Type of input Claude is waiting for
    systemPrompt?: string;   // Custom system prompt for this task
    order?: number;          // Display order within workspace (lower = higher in list)
    sessionId?: string | null;      // Session ID for conversation history (null if not captured yet)
    backendType?: BackendType; // Which backend created this task (for conversation lookup)
}

export interface Workspace {
    id: string;              // Full path
    name: string;            // Folder name
    createdAt: string;
    systemPrompt?: string;   // Custom system prompt for this workspace
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

// Summary Mode action types
export interface SummaryAction {
    id: string;
    label: string;
    action: string;       // The value to send (e.g., text input, command)
    type: 'task_input' | 'new_task' | 'chat';  // What kind of action this is
}

// Supervisor Chat types
export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    taskId?: string;  // Optional: associated task for context
    workspaceId?: string;  // Optional: workspace this message belongs to
    actions?: SummaryAction[];  // Optional: clickable action buttons
    isAlert?: boolean;  // Optional: whether this is a proactive alert (task completed)
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

// WebSocket message types
export type WSMessageType =
    // Task lifecycle
    | 'task:created'
    | 'task:stateChanged'
    | 'task:output'
    | 'task:restore'
    | 'task:destroyed'
    | 'task:waitingInput'
    | 'task:revertResult'
    | 'tasks:updated'
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
    | 'workspace:recent:list'
    // Task reordering
    | 'tasks:reordered'
    // Supervisor/Chat
    | 'task:summary'
    | 'supervisor:chat:response'
    | 'supervisor:chat:history'
    | 'supervisor:chat:typing'
    // Summary Mode
    | 'summary:message'
    | 'summary:history'
    | 'summary:typing'
    | 'summary:chat'
    | 'summary:action'
    // Server status
    | 'server:reloading'
    | 'server:reconnecting'
    | 'init'
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
