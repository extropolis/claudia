// Type definitions for the orchestrator system

export type TaskStatus = 'pending' | 'running' | 'complete' | 'error' | 'cancelled' | 'stopped' | 'blocked';

export type FileOperation = 'created' | 'modified' | 'deleted';

export interface CodeFile {
    filename: string;
    language: string;
    content: string;
    operation: FileOperation;
}

export interface Task {
    id: string;
    name: string;
    description: string;
    status: TaskStatus;
    parentId?: string;
    workerId?: string;
    output: string[];
    files?: CodeFile[];
    projectPath?: string;
    projectName?: string;
    createdAt: Date;
    startedAt?: Date;
    completedAt?: Date;
    error?: string;
    exitCode?: number;
    structuredResult?: StructuredTaskResult;
    // Task dependency and blocking support
    dependsOn?: string[];       // Task IDs this task depends on
    blockedBy?: string[];        // Task IDs that are blocking this task
    blockReason?: string;        // Why is this task blocked?
    lastProgressTime?: Date;     // Last time task showed progress
}

// Structured result format for workers to output
export interface StructuredTaskResult {
    result?: string;          // The main result/answer (e.g., news content, analysis)
    artifacts?: string[];     // File paths, URLs, IDs produced
    summary?: string;         // Brief summary of what was done
    logs?: string[];          // Diagnostic/debug logs (optional)
}

// Plan types for plan mode
export type PlanStatus = 'pending' | 'approved' | 'rejected' | 'executing';

export interface PlanItem {
    id: string;
    name: string;
    description: string;
    testingStrategy: string;
    dependsOn?: string[];  // IDs of other PlanItems this depends on
}

export interface Plan {
    id: string;
    status: PlanStatus;
    items: PlanItem[];
    userRequest: string;
    createdAt: Date;
}

export interface Worker {
    id: string;
    taskId: string;
    status: 'running' | 'complete' | 'error';
    pid?: number;          // Legacy - may be undefined with SDK
    sessionId?: string;    // OpenCode session ID
}

export interface SuggestedAction {
    label: string;
    action: string;
}

export interface ImageAttachment {
    name: string;
    data: string; // base64 encoded
    mimeType: string;
}

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: Date;
    suggestedActions?: SuggestedAction[];
    images?: ImageAttachment[];
}

export type WSMessageType =
    | 'task:created'
    | 'task:deleted'
    | 'task:cleared'
    | 'task:updated'
    | 'task:output'
    | 'task:complete'
    | 'chat:message'
    | 'chat:cleared'
    | 'orchestrator:status'
    | 'conversation:select'
    | 'conversation:resumed'
    | 'plan:created'
    | 'plan:approved'
    | 'plan:rejected'
    | 'project:changed'
    | 'project:error'
    | 'workspace:list'
    | 'workspace:created'
    | 'workspace:deleted'
    | 'workspace:projectAdded'
    | 'workspace:projectRemoved'
    | 'workspace:setActive'
    | 'init';

export interface WSMessage {
    type: WSMessageType;
    payload: unknown;
}

export interface TaskCreatedPayload {
    task: Task;
}

export interface TaskOutputPayload {
    taskId: string;
    data: string;
}

export interface TaskCompletePayload {
    taskId: string;
    status: 'complete' | 'error';
    exitCode: number;
}

export interface ChatMessagePayload {
    message: ChatMessage;
}

// Task result storage for worker context
export interface TaskResult {
    taskId: string;
    taskName: string;
    status: 'complete' | 'error';
    summary: string;          // Human-readable summary
    artifacts: string[];      // Extracted file paths, URLs, etc.
    completedAt: Date;
}

// Conversation history types
export interface ConversationSummary {
    id: string;
    title: string;
    lastMessage: string;
    taskNames: string[];
    createdAt: Date;
    updatedAt: Date;
}

export interface StoredConversation extends ConversationSummary {
    chatHistory: ChatMessage[];
    tasks: Task[];
    taskResults: TaskResult[];
}

// Intent classification types
export type IntentType = 'resume' | 'new';

export interface IntentResult {
    intent: IntentType;
    conversationId?: string;
    confidence: number;
    candidates?: ConversationSummary[];
}

// Todo types
export interface Todo {
    id: string;
    title: string;
    description?: string;
    completed: boolean;
    createdAt: Date;
    updatedAt: Date;
}

// Authentication types
export interface User {
    id: string;
    email: string;
    passwordHash: string;
    name?: string;
    createdAt: Date;
    updatedAt: Date;
}

export interface UserDTO {
    id: string;
    email: string;
    name?: string;
    createdAt: Date;
}

export interface AuthTokens {
    accessToken: string;
    refreshToken: string;
}

export interface TokenPayload {
    userId: string;
    email: string;
    type: 'access' | 'refresh';
}

export interface LoginRequest {
    email: string;
    password: string;
    name?: string;
}

export interface RegisterRequest {
    email: string;
    password: string;
    name?: string;
}

export interface RefreshTokenRequest {
    refreshToken: string;
}

export interface AuthResponse {
    user: UserDTO;
    tokens: AuthTokens;
}

// Workspace types
export interface WorkspaceProject {
    path: string;
    name: string;
    addedAt: number;
}

export interface Workspace {
    id: string;
    name: string;
    projects: WorkspaceProject[];
    createdAt: string;
}

export interface RecentProject {
    path: string;
    name: string;
    lastAccessed: number;
}
