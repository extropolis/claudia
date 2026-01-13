/**
 * OpenCode Client - SDK-based service for AI task execution
 * Replaces CLI spawning with OpenCode SDK session management
 * Uses native SAP AI Core integration
 */

import { EventEmitter } from 'events';

// OpenCode SDK types - imported dynamically to handle potential module issues
interface OpenCodeClient {
    session: {
        create: (opts: { body: { title?: string; parentID?: string }; query?: { directory?: string } }) => Promise<Session>;
        get: (opts: { path: { id: string } }) => Promise<Session>;
        list: () => Promise<Session[]>;
        delete: (opts: { path: { id: string } }) => Promise<boolean>;
        abort: (opts: { path: { id: string } }) => Promise<boolean>;
        prompt: (opts: {
            path: { id: string };
            body: {
                model?: { providerID: string; modelID: string };
                parts: Array<{ type: string; text: string }>;
                noReply?: boolean;
            };
        }) => Promise<AssistantMessage>;
        messages: (opts: { path: { id: string } }) => Promise<MessageWithParts[]>;
    };
    event: {
        subscribe: () => Promise<{ stream: AsyncIterable<OpenCodeEvent> }>;
    };
    app: {
        info: () => Promise<AppInfo>;
    };
    config: {
        get: () => Promise<Config>;
    };
}

interface Session {
    id: string;
    title?: string;
    createdAt?: string;
    updatedAt?: string;
    status?: string;
}

interface AssistantMessage {
    id: string;
    role: 'assistant';
    content?: string;
}

interface MessageWithParts {
    info: {
        id: string;
        role: string;
        content?: string;
    };
    parts: Array<{
        type: string;
        text?: string;
    }>;
}

interface OpenCodeEvent {
    type: string;
    properties?: Record<string, unknown>;
}

interface AppInfo {
    version: string;
    name: string;
}

interface Config {
    model?: string;
}

interface OpenCodeServer {
    url: string;
    close: () => void;
}

interface CreateOpencodeResult {
    client: OpenCodeClient;
    server: OpenCodeServer;
}

// Model configuration for SAP AI Core
const DEFAULT_MODEL = {
    providerID: 'sap-ai-core',
    modelID: process.env.OPENCODE_MODEL || 'anthropic--claude-4.5-sonnet'
};

export interface SessionInfo {
    id: string;
    title: string;
    taskId: string;
    status: 'active' | 'complete' | 'error' | 'aborted';
    startedAt: Date;
    completedAt?: Date;
}

export interface PromptResult {
    success: boolean;
    content?: string;
    error?: string;
}

/**
 * OpenCode Client Service
 * Manages OpenCode SDK connections and sessions for task execution
 */
export class OpenCodeClientService extends EventEmitter {
    private client: OpenCodeClient | null = null;
    private server: OpenCodeServer | null = null;
    private sessions: Map<string, SessionInfo> = new Map();
    private eventSubscription: AsyncIterable<OpenCodeEvent> | null = null;
    private isStarted: boolean = false;
    private model = DEFAULT_MODEL;

    // Track pending completion promises for async session handling
    private pendingCompletions: Map<string, {
        resolve: (content: string) => void;
        reject: (error: Error) => void;
        content: string[];
    }> = new Map();

    constructor() {
        super();
    }

    /**
     * Start the OpenCode server and create SDK client
     */
    async start(config?: { model?: { providerID: string; modelID: string } }): Promise<void> {
        if (this.isStarted) {
            console.log('[OpenCodeClient] Already started');
            return;
        }

        try {
            console.log('[OpenCodeClient] Starting OpenCode server...');

            // Dynamic import to handle ESM module
            const { createOpencode } = await import('@opencode-ai/sdk');

            const result = await createOpencode({
                hostname: '127.0.0.1',
                port: 4097, // Use different port than default to avoid conflicts
                timeout: 10000,
            }) as unknown as CreateOpencodeResult;

            this.client = result.client;
            this.server = result.server;
            this.isStarted = true;

            if (config?.model) {
                this.model = config.model;
            }

            console.log(`[OpenCodeClient] Server started at ${this.server.url}`);

            // Start event subscription
            this.subscribeToEvents();

            this.emit('started', { url: this.server.url });
        } catch (error) {
            console.error('[OpenCodeClient] Failed to start:', error);
            throw error;
        }
    }

    /**
     * Connect to an existing OpenCode server
     */
    async connect(baseUrl: string): Promise<void> {
        if (this.isStarted) {
            console.log('[OpenCodeClient] Already connected');
            return;
        }

        try {
            console.log(`[OpenCodeClient] Connecting to ${baseUrl}...`);

            const { createOpencodeClient } = await import('@opencode-ai/sdk');

            this.client = createOpencodeClient({ baseUrl }) as unknown as OpenCodeClient;
            this.isStarted = true;

            console.log(`[OpenCodeClient] Connected to ${baseUrl}`);

            // Start event subscription
            this.subscribeToEvents();

            this.emit('connected', { url: baseUrl });
        } catch (error) {
            console.error('[OpenCodeClient] Failed to connect:', error);
            throw error;
        }
    }

    /**
     * Stop the OpenCode server
     */
    async stop(): Promise<void> {
        if (!this.isStarted) {
            return;
        }

        console.log('[OpenCodeClient] Stopping...');

        if (this.server) {
            this.server.close();
            this.server = null;
        }

        this.client = null;
        this.isStarted = false;
        this.sessions.clear();

        this.emit('stopped');
        console.log('[OpenCodeClient] Stopped');
    }

    /**
     * Create a new session for a task
     * @param taskId - The task ID for tracking
     * @param title - Title for the session
     * @param directory - Optional working directory for the session
     */
    async createSession(taskId: string, title: string, directory?: string): Promise<SessionInfo> {
        if (!this.client) {
            throw new Error('OpenCode client not started');
        }

        console.log(`[OpenCodeClient] Creating session for task ${taskId}: "${title}"${directory ? ` in directory: ${directory}` : ''}`);

        // Build the create request - include directory as query param if provided
        const createRequest: any = {
            body: { title }
        };

        if (directory) {
            createRequest.query = { directory };
        }

        console.log(`[OpenCodeClient] Creating session with title: ${title}, directory: ${directory || 'default'}`);
        const response = await this.client.session.create(createRequest) as any;
        const session = response.data || response; // Handle both wrapped and unwrapped cases
        console.log(`[OpenCodeClient] Session created in SDK: ${session.id}`);

        const sessionInfo: SessionInfo = {
            id: session.id,
            title,
            taskId,
            status: 'active',
            startedAt: new Date()
        };

        this.sessions.set(session.id, sessionInfo);
        this.emit('sessionCreated', sessionInfo);

        console.log(`[OpenCodeClient] Session created: ${session.id}`);
        return sessionInfo;
    }

    /**
     * Send a prompt to a session and get the response
     * Uses event-based completion detection - waits for session.idle event
     */
    async sendPrompt(sessionId: string, prompt: string): Promise<PromptResult> {
        if (!this.client) {
            throw new Error('OpenCode client not started');
        }

        const sessionInfo = this.sessions.get(sessionId);
        if (!sessionInfo) {
            return { success: false, error: 'Session not found' };
        }

        console.log(`[OpenCodeClient] Sending prompt to session ${sessionId}...`);

        try {
            // Create a promise that will resolve when we get session.idle event
            const completionPromise = new Promise<string>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    this.pendingCompletions.delete(sessionId);
                    console.warn(`[OpenCodeClient] Session ${sessionId} timed out waiting for completion`);
                    resolve(''); // Resolve with empty content on timeout instead of rejecting
                }, 5 * 60 * 1000); // 5 minute timeout

                this.pendingCompletions.set(sessionId, {
                    resolve: (content: string) => {
                        clearTimeout(timeout);
                        resolve(content);
                    },
                    reject: (error: Error) => {
                        clearTimeout(timeout);
                        reject(error);
                    },
                    content: []
                });
            });

            // Send the prompt - this initiates the AI processing asynchronously
            console.log(`[OpenCodeClient] Calling session.prompt for ${sessionId}...`);
            await this.client.session.prompt({
                path: { id: sessionId },
                body: {
                    model: this.model,
                    parts: [{ type: 'text', text: prompt }]
                }
            });

            console.log(`[OpenCodeClient] Prompt sent to ${sessionId}, waiting for session.idle event...`);

            // Wait for completion via event (or timeout)
            const accumulatedContent = await completionPromise;

            // Fetch messages to get the final response content
            const messages = await this.client.session.messages({
                path: { id: sessionId }
            }) as any;

            // Get the last assistant message
            const messageList = Array.isArray(messages) ? messages : (messages?.data || []);
            const assistantMessage = [...messageList].reverse()
                .find((m: MessageWithParts) => m.info?.role === 'assistant');

            // Extract text content from message parts
            let content = '';
            if (assistantMessage?.parts) {
                for (const part of assistantMessage.parts) {
                    if (part.type === 'text' && part.text) {
                        content += part.text;
                    }
                }
            }

            // If we accumulated content from events, use that; otherwise use fetched content
            const finalContent = accumulatedContent || content;

            console.log(`[OpenCodeClient] Prompt completed for session ${sessionId}, content length: ${finalContent.length}`);

            return {
                success: true,
                content: finalContent
            };
        } catch (error) {
            console.error(`[OpenCodeClient] Prompt failed for session ${sessionId}:`, error);
            this.pendingCompletions.delete(sessionId);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    /**
     * Inject context into a session without triggering AI response
     */
    async injectContext(sessionId: string, context: string): Promise<boolean> {
        if (!this.client) {
            throw new Error('OpenCode client not started');
        }

        try {
            await this.client.session.prompt({
                path: { id: sessionId },
                body: {
                    parts: [{ type: 'text', text: context }],
                    noReply: true
                }
            });
            return true;
        } catch (error) {
            console.error(`[OpenCodeClient] Failed to inject context:`, error);
            return false;
        }
    }

    /**
     * Abort a running session
     */
    async abortSession(sessionId: string): Promise<boolean> {
        if (!this.client) {
            throw new Error('OpenCode client not started');
        }

        const sessionInfo = this.sessions.get(sessionId);
        if (!sessionInfo) {
            console.log(`[OpenCodeClient] Session ${sessionId} not found`);
            return false;
        }

        console.log(`[OpenCodeClient] Aborting session ${sessionId}...`);

        try {
            await this.client.session.abort({ path: { id: sessionId } });
            sessionInfo.status = 'aborted';
            sessionInfo.completedAt = new Date();
            this.emit('sessionAborted', sessionInfo);
            console.log(`[OpenCodeClient] Session ${sessionId} aborted`);
            return true;
        } catch (error) {
            console.error(`[OpenCodeClient] Failed to abort session ${sessionId}:`, error);
            return false;
        }
    }

    /**
     * Get session info
     */
    getSession(sessionId: string): SessionInfo | undefined {
        return this.sessions.get(sessionId);
    }

    /**
     * Get session by task ID
     */
    getSessionByTaskId(taskId: string): SessionInfo | undefined {
        for (const session of this.sessions.values()) {
            if (session.taskId === taskId) {
                return session;
            }
        }
        return undefined;
    }

    /**
     * Mark a session as complete
     */
    completeSession(sessionId: string, status: 'complete' | 'error' = 'complete'): void {
        const sessionInfo = this.sessions.get(sessionId);
        if (sessionInfo) {
            sessionInfo.status = status;
            sessionInfo.completedAt = new Date();
            this.emit('sessionCompleted', sessionInfo);
        }
    }

    /**
     * Get all active sessions
     */
    getActiveSessions(): SessionInfo[] {
        return Array.from(this.sessions.values()).filter(s => s.status === 'active');
    }

    /**
     * Subscribe to OpenCode events for real-time updates
     */
    private async subscribeToEvents(): Promise<void> {
        if (!this.client) {
            return;
        }

        try {
            console.log('[OpenCodeClient] Subscribing to events...');
            const subscription = await this.client.event.subscribe();
            this.eventSubscription = subscription.stream;

            // Process events in background
            this.processEvents();
        } catch (error) {
            console.error('[OpenCodeClient] Failed to subscribe to events:', error);
        }
    }

    /**
     * Process incoming events
     */
    private async processEvents(): Promise<void> {
        if (!this.eventSubscription) {
            return;
        }

        try {
            for await (const event of this.eventSubscription) {
                this.handleEvent(event);
            }
        } catch (error) {
            console.error('[OpenCodeClient] Event stream error:', error);
        }
    }

    /**
     * Handle an incoming event
     */
    private messageRoles = new Map<string, string>();
    private lastMessagePartText = new Map<string, string>();

    /**
     * Handle an incoming event
     */
    private handleEvent(event: OpenCodeEvent): void {
        const props = event.properties as any;

        // Check for heartbeats to suppress noise, but log everything else for debugging
        if (event.type !== 'server.heartbeat') {
            console.log(`[OpenCodeClient] Event: ${event.type}`, JSON.stringify(props).substring(0, 300));
        }

        switch (event.type) {
            case 'message.created':
            case 'message.updated': {
                // Track message role to filter output
                const rawMsg = props?.message || props;
                // Handle nested info structure often sent by OpenCode
                const msgInfo = rawMsg?.info || rawMsg;

                if (msgInfo?.id && msgInfo?.role) {
                    this.messageRoles.set(msgInfo.id, msgInfo.role);
                }
                this.emit('message', props);
                break;
            }

            case 'message.part.created':
            case 'message.part.updated':
                // Emit text output for streaming
                const part = props?.part;
                if (part?.text && part.sessionID) {
                    // Check role if available via messageID
                    // If we don't know the role yet, we might assume it's assistant or check if we can infer it
                    // Usually message.created comes before part updates
                    const role = part.messageID ? this.messageRoles.get(part.messageID) : undefined;

                    // Relaxed filter: Allow if role is assistant OR undefined (to handle cases where role arrives late or message event is delayed)
                    if (role && role !== 'assistant') {
                        console.log(`[OpenCodeClient] Skipping output for ${part.sessionID} (role=${role}, msgID=${part.messageID})`);
                        return;
                    } else {
                        console.log(`[OpenCodeClient] Processing output for ${part.sessionID} (role=${role}, type=${part.type})`);
                    }

                    // Calculate delta (assuming part.text is cumulative)
                    // Each message part sends cumulative text updates (full content so far).
                    // We need to track the last text per MESSAGE, not per session, to compute the delta.

                    // Use a composite key of sessionID:messageID to track each message's cumulative text separately
                    // This prevents duplication when a new message starts (its text won't match the previous message's)
                    const trackingKey = part.messageID
                        ? `${part.sessionID}:${part.messageID}`
                        : part.sessionID; // Fallback to sessionID if no messageID

                    const pending = this.pendingCompletions.get(part.sessionID);
                    let delta = part.text;

                    // Compute delta from cumulative text updates
                    const validText = part.text || '';
                    const lastText = this.lastMessagePartText.get(trackingKey) || '';

                    if (validText.startsWith(lastText)) {
                        // Cumulative update - extract only the new portion
                        delta = validText.substring(lastText.length);
                        this.lastMessagePartText.set(trackingKey, validText);
                    } else if (validText.length > 0 && lastText.length > 0 && validText !== lastText) {
                        // Text doesn't start with last text - this is a new message or a reset
                        // Only emit if it's genuinely different content
                        this.lastMessagePartText.set(trackingKey, validText);
                        delta = validText;
                    } else if (validText.length > 0 && lastText.length === 0) {
                        // First update for this message part
                        this.lastMessagePartText.set(trackingKey, validText);
                        delta = validText;
                    } else {
                        // Same text as before - no delta to emit
                        delta = '';
                    }

                    if (delta.length > 0) {
                        // Accumulate content for pending completions
                        if (pending && part.type === 'text') {
                            pending.content.push(delta);
                        }

                        this.emit('output', {
                            sessionId: part.sessionID,
                            text: delta,
                            type: part.type
                        });
                    }
                }
                break;

            case 'session.idle': {
                // Session finished processing - resolve pending completion
                const sessionId = props?.session?.id || props?.sessionID || props?.id;
                console.log(`[OpenCodeClient] Session ${sessionId} is now idle, resolving completion...`);

                if (sessionId) {
                    const pending = this.pendingCompletions.get(sessionId);
                    if (pending) {
                        const content = pending.content.join('');
                        console.log(`[OpenCodeClient] Resolving completion for ${sessionId}, content length: ${content.length}`);
                        this.pendingCompletions.delete(sessionId);
                        pending.resolve(content);
                    }
                }
                break;
            }

            case 'session.updated':
            case 'session.created':
            case 'session.status':
                // Log session lifecycle for debugging
                const sid = props?.session?.id || props?.sessionID;
                if (sid) {
                    console.log(`[OpenCodeClient] Session ${sid} lifecycle: ${event.type}`);
                }
                break;

            case 'server.connected':
            case 'server.heartbeat':
                // Ignore silently
                break;

            case 'tool.start':
            case 'tool.end':
                this.emit('tool', props);
                break;

            case 'permission.asked':
            case 'permission.updated': {
                // Auto-grant permissions when tools request file access
                const permissionId = props?.id;
                const sessionId = props?.sessionID;
                const permissionType = props?.type;
                const permissionTitle = props?.title;

                console.log(`[OpenCodeClient] Permission requested: ${permissionTitle} (type=${permissionType}, id=${permissionId}, session=${sessionId})`);

                if (permissionId && sessionId && this.client) {
                    // Auto-grant the permission
                    console.log(`[OpenCodeClient] Auto-granting permission ${permissionId}...`);
                    this.grantPermission(sessionId, permissionId);
                }
                break;
            }

            default:
                console.log(`[OpenCodeClient] Unhandled event type: ${event.type}`);
        }
    }

    /**
     * Check if the client is started
     */
    isRunning(): boolean {
        return this.isStarted;
    }

    /**
     * Get the server URL
     */
    getServerUrl(): string | null {
        return this.server?.url || null;
    }

    /**
     * Set the model to use for prompts
     */
    setModel(providerID: string, modelID: string): void {
        this.model = { providerID, modelID };
        console.log(`[OpenCodeClient] Model set to ${providerID}/${modelID}`);
    }

    /**
     * Grant a permission request
     * Called when permission.asked event is received to auto-approve tool operations
     */
    private async grantPermission(sessionId: string, permissionId: string): Promise<void> {
        if (!this.client) {
            console.error('[OpenCodeClient] Cannot grant permission - client not started');
            return;
        }

        try {
            // Use the SDK's permission response method
            // The response should be 'always' to permanently grant, 'allow' for once, 'deny' to reject
            const response = await (this.client as any).session.postSessionIdPermissionsPermissionId({
                path: {
                    id: sessionId,
                    permissionId: permissionId
                },
                body: {
                    response: 'always'  // Grant permission permanently for this session
                }
            });

            console.log(`[OpenCodeClient] Permission ${permissionId} granted for session ${sessionId}`);
        } catch (error) {
            console.error(`[OpenCodeClient] Failed to grant permission ${permissionId}:`, error);

            // Try alternative API path structure if the above fails
            try {
                const altResponse = await fetch(`http://127.0.0.1:4097/session/${sessionId}/permissions/${permissionId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ response: 'always' })
                });

                if (altResponse.ok) {
                    console.log(`[OpenCodeClient] Permission ${permissionId} granted via fallback API`);
                } else {
                    console.error(`[OpenCodeClient] Fallback permission grant failed:`, await altResponse.text());
                }
            } catch (fallbackError) {
                console.error(`[OpenCodeClient] Fallback permission grant also failed:`, fallbackError);
            }
        }
    }

    // Track registered MCP servers to avoid re-registering
    private registeredMcpServers: Set<string> = new Set();

    /**
     * Add an MCP server to the OpenCode instance
     * Uses the /mcp API endpoint to dynamically register MCP servers
     */
    async addMcpServer(name: string, config: {
        command: string;
        args?: string[];
        env?: Record<string, string>;
        enabled?: boolean;
    }): Promise<boolean> {
        if (!this.isStarted) {
            console.error('[OpenCodeClient] Cannot add MCP server - client not started');
            return false;
        }

        // Skip if already registered
        if (this.registeredMcpServers.has(name)) {
            console.log(`[OpenCodeClient] MCP server "${name}" already registered, skipping`);
            return true;
        }

        const serverUrl = this.getServerUrl() || 'http://127.0.0.1:4097';

        // Convert our config format to OpenCode SDK's McpLocalConfig format
        const mcpConfig = {
            type: 'local' as const,
            command: [config.command, ...(config.args || [])],
            environment: config.env,
            enabled: config.enabled !== false,
            timeout: 10000 // 10 second timeout for MCP server startup
        };

        console.log(`[OpenCodeClient] Adding MCP server "${name}":`, JSON.stringify(mcpConfig));

        try {
            const response = await fetch(`${serverUrl}/mcp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name,
                    config: mcpConfig
                })
            });

            if (response.ok) {
                const result = await response.json();
                console.log(`[OpenCodeClient] MCP server "${name}" added successfully:`, JSON.stringify(result));
                this.registeredMcpServers.add(name);
                return true;
            } else {
                const errorText = await response.text();
                console.error(`[OpenCodeClient] Failed to add MCP server "${name}":`, errorText);
                return false;
            }
        } catch (error) {
            console.error(`[OpenCodeClient] Error adding MCP server "${name}":`, error);
            return false;
        }
    }

    /**
     * Get the status of all configured MCP servers
     */
    async getMcpStatus(): Promise<Record<string, { status: string }> | null> {
        if (!this.isStarted) {
            console.error('[OpenCodeClient] Cannot get MCP status - client not started');
            return null;
        }

        const serverUrl = this.getServerUrl() || 'http://127.0.0.1:4097';

        try {
            const response = await fetch(`${serverUrl}/mcp`);
            if (response.ok) {
                return await response.json();
            } else {
                console.error(`[OpenCodeClient] Failed to get MCP status:`, await response.text());
                return null;
            }
        } catch (error) {
            console.error(`[OpenCodeClient] Error getting MCP status:`, error);
            return null;
        }
    }

    /**
     * Register multiple MCP servers from config
     */
    async registerMcpServers(servers: Array<{
        name: string;
        command: string;
        args?: string[];
        env?: Record<string, string>;
        enabled: boolean;
    }>): Promise<void> {
        console.log(`[OpenCodeClient] Registering ${servers.length} MCP server(s)...`);

        for (const server of servers) {
            if (!server.enabled) {
                console.log(`[OpenCodeClient] Skipping disabled MCP server "${server.name}"`);
                continue;
            }

            await this.addMcpServer(server.name, {
                command: server.command,
                args: server.args,
                env: server.env,
                enabled: server.enabled
            });
        }

        // Log final status
        const status = await this.getMcpStatus();
        console.log(`[OpenCodeClient] MCP servers status:`, JSON.stringify(status));
    }
}

// Singleton instance
let instance: OpenCodeClientService | null = null;

export function getOpenCodeClient(): OpenCodeClientService {
    if (!instance) {
        instance = new OpenCodeClientService();
    }
    return instance;
}

export default OpenCodeClientService;
