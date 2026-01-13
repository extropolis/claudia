import { EventEmitter } from 'events';
import { ChildProcess, spawn } from 'child_process';
import { ProcessManager } from './process-manager.js';
import { TaskManager } from './task-manager.js';
import { ConversationStore } from './conversation-store.js';
import { ProjectStore } from './project-store.js';
import { ConfigStore } from './config-store.js';
import { WorkspaceStore } from './workspace-store.js';
import { IntentRouter } from './services/intent-router.js';
import { CommandExecutor } from './services/command-executor.js';
import { WebSearcher } from './services/web-searcher.js';
import { ContextManager } from './services/context-manager.js';
import { ChatMessage, Task, IntentResult, StoredConversation, ImageAttachment, TaskResult, Worker } from '@claudia/shared';
import { v4 as uuid } from 'uuid';
import { generateTaskCompletionResponse, analyzeLogsForIssues } from './llm-service.js';

export interface OrchestratorServices {
    intentRouter: IntentRouter;
    commandExecutor: CommandExecutor;
    webSearcher: WebSearcher;
    contextManager: ContextManager;
}

/**
 * Orchestrator manages the main OpenCode agent that coordinates workers
 *
 * ARCHITECTURE:
 * The orchestrator uses OpenCode SDK (just like tasks) for its decision-making.
 * This provides better reasoning, tool access, and consistency with task execution.
 *
 * WORKFLOW:
 * 1. User sends message → sendMessage()
 * 2. Message is forwarded to orchestrator agent → sendToOrchestratorWorker()
 * 3. Orchestrator analyzes and responds with JSON decision → handleOrchestratorOutput()
 * 4. Decision is processed → handleOrchestratorDecision()
 * 5. Tasks are spawned or plans are created based on the decision
 *
 * CONSISTENCY:
 * Both the orchestrator and tasks use the same OpenCode pattern:
 * - Orchestrator: OpenCode session for coordination and decision-making
 * - Tasks: OpenCode session for execution and implementation
 * This ensures consistent behavior and a unified architecture throughout the system.
 */
export class Orchestrator extends EventEmitter {
    private process: ChildProcess | null = null;
    private processManager: ProcessManager;
    private taskManager: TaskManager;
    private conversationStore: ConversationStore;
    private projectStore: ProjectStore;
    private configStore: ConfigStore;
    private messageQueue: string[] = [];
    private isReady = false;
    private pendingWaits: Map<string, { taskIds: string[], resolve: () => void }> = new Map();
    private pendingSelection: ((conversationId: string | null) => void) | null = null;
    // Real-time log monitoring
    private taskOutputBuffers: Map<string, string[]> = new Map();
    private lastAnalysisTime: Map<string, number> = new Map();
    private readonly ANALYSIS_COOLDOWN_MS = 10000; // 10 seconds between analyses
    // Track current user images for passing to LLM
    private currentUserImages: ImageAttachment[] | undefined = undefined;
    // Track tasks that have already been notified to prevent duplicates
    private notifiedTaskIds: Set<string> = new Set();
    // Track recent file paths from task outputs for quick reference
    private recentFilePaths: string[] = [];
    // Orchestrator worker instance
    private orchestratorWorker: Worker | null = null;
    private orchestratorOutputBuffer: string = '';
    private orchestratorSessionId: string | null = null;
    // Stuck task monitoring
    private stuckTaskCheckInterval: NodeJS.Timeout | null = null;
    private notifiedStuckTasks: Set<string> = new Set();


    /**
     * Extract file paths from text (used to track files created by tasks)
     */
    private extractFilePaths(text: string): string[] {
        const paths: string[] = [];
        // Match common file path patterns
        const patterns = [
            /[\w./\-]+\.(?:png|jpg|jpeg|gif|pdf|txt|json|html|css|js|ts|md)\b/gi,
            /\/[\w./\-]+\.[a-z]{2,4}\b/gi,
            /\.playwright-mcp\/[\w.\-]+/gi,
        ];
        for (const pattern of patterns) {
            const matches = text.match(pattern);
            if (matches) {
                paths.push(...matches);
            }
        }
        return [...new Set(paths)]; // dedupe
    }

    /**
     * Detect if request is asking to open a file
     */
    private isOpenFileRequest(request: string): boolean {
        const lower = request.toLowerCase();
        return /^(open|show|display|view)\s+(the\s+)?(screenshot|file|image|picture|photo)/i.test(lower);
    }

    /**
     * Find a matching file path from recent outputs
     */
    private findRecentFile(hint: string): string | null {
        const lower = hint.toLowerCase();
        // Look for screenshot/image files if mentioned
        if (/screenshot|image|picture|photo/i.test(lower)) {
            const imageFile = this.recentFilePaths.find(p =>
                /\.(png|jpg|jpeg|gif)$/i.test(p)
            );
            if (imageFile) return imageFile;
        }
        // Return most recent file if any
        return this.recentFilePaths.length > 0 ? this.recentFilePaths[this.recentFilePaths.length - 1] : null;
    }

    private workspaceStore: WorkspaceStore;
    private currentWorkspaceId: string | null = null;

    // Services
    private intentRouter: IntentRouter;
    private commandExecutor: CommandExecutor;
    private webSearcher: WebSearcher;
    private contextManager: ContextManager;

    constructor(
        processManager: ProcessManager,
        taskManager: TaskManager,
        conversationStore: ConversationStore,
        projectStore: ProjectStore,
        configStore: ConfigStore,
        workspaceStore: WorkspaceStore,
        services: OrchestratorServices
    ) {
        super();
        this.processManager = processManager;
        this.taskManager = taskManager;
        this.conversationStore = conversationStore;
        this.projectStore = projectStore;
        this.configStore = configStore;
        this.workspaceStore = workspaceStore;

        this.intentRouter = services.intentRouter;
        this.commandExecutor = services.commandExecutor;
        this.webSearcher = services.webSearcher;
        this.contextManager = services.contextManager;

        // Initialize with active workspace
        this.currentWorkspaceId = workspaceStore.getActiveWorkspaceId();

        // Listen for task completions to resolve pending waits
        this.taskManager.on('complete', (task: Task) => {
            this.checkPendingWaits();
            // Notify the orchestrator about task completion
            this.notifyTaskComplete(task);
            // Clean up buffers
            this.taskOutputBuffers.delete(task.id);
            this.lastAnalysisTime.delete(task.id);
        });

        // Listen for real-time task output to detect issues
        this.processManager.on('output', ({ workerId, taskId, data }: { workerId: string, taskId: string, data: string }) => {
            this.handleTaskOutput(taskId, workerId, data);
        });

        // Listen for task blocking events
        this.taskManager.on('blocked', (task: Task) => {
            this.handleTaskBlocked(task);
        });

        // Wire service events to orchestrator
        this.commandExecutor.on('chat', (msg) => this.emit('chat', msg));
        this.commandExecutor.on('output', (payload) => this.emit('output', payload));

        this.webSearcher.on('chat', (msg) => this.emit('chat', msg));
    }

    /**
     * Start the orchestrator (now uses on-demand spawning)
     */
    async start(): Promise<void> {
        console.log('[Orchestrator] Starting orchestrator (on-demand mode)...');

        // Listen to orchestrator output
        this.processManager.on('output', this.handleOrchestratorOutput.bind(this));

        // Start stuck task monitoring (check every 30 seconds)
        this.stuckTaskCheckInterval = setInterval(() => {
            this.checkForStuckTasks();
        }, 30000);

        this.isReady = true;
        this.emit('ready');
        console.log('[Orchestrator] Ready - orchestrator will spawn on-demand for each request');
    }



    /**
     * Handle output from the orchestrator worker
     */

    private handleOrchestratorOutput(data: { workerId: string, taskId: string, data: string }): void {
        console.log(`[Orchestrator] handleOutput called for worker ${data.workerId}`);

        if (!this.orchestratorWorker || data.workerId !== this.orchestratorWorker.id) {
            return;
        }

        this.orchestratorOutputBuffer += data.data;

        // Create a persistent session ID for streaming updates
        if (!this.orchestratorSessionId) {
            this.orchestratorSessionId = uuid();
        }

        // Stream the output directly to the user as a chat message
        // Frontend handles updating the same message via the persistent ID
        const message: ChatMessage = {
            id: this.orchestratorSessionId,
            role: 'assistant',
            content: this.orchestratorOutputBuffer,
            timestamp: new Date()
        };
        this.emit('chat', message);
    }


    /**
     * Send a user message to the orchestrator
     */
    /**
     * Send a user message to the orchestrator
     */
    async sendMessage(content: string, images?: ImageAttachment[]): Promise<void> {
        console.log(`[Orchestrator] User message: ${content}${images ? ` (with ${images.length} images)` : ''}`);

        // Store images for tracking
        this.currentUserImages = images;

        // Emit the user message to the chat
        const userMessage: ChatMessage = {
            id: uuid(),
            role: 'user',
            content,
            timestamp: new Date(),
            images
        };
        this.emit('chat', userMessage);

        // Session-based conversations: Always use or create a session conversation
        if (!this.conversationStore.getCurrentId()) {
            const title = content.substring(0, 50) + (content.length > 50 ? '...' : '');
            this.conversationStore.startConversation(title);
        }

        this.conversationStore.addMessage(userMessage);

        // High priority: check for simple regex-based intents first (search, command)
        const actionType = this.intentRouter.determineActionType(content);

        if (actionType === 'command') {
            const command = this.intentRouter.extractCommand(content);
            const cwd = this.currentWorkspaceId || this.projectStore.getCurrentProject() || process.cwd();
            await this.commandExecutor.execute(command, cwd);
            this.currentUserImages = undefined;
            return;
        }

        if (actionType === 'search') {
            const query = this.intentRouter.extractSearchQuery(content);
            await this.webSearcher.search(query);
            this.currentUserImages = undefined;
            return;
        }

        // Handle open file requests locally if we have recent files
        if (this.intentRouter.isOpenFileRequest(content)) {
            const filePath = this.intentRouter.findRecentFile(content, this.recentFilePaths);
            if (filePath) {
                const openMessage: ChatMessage = {
                    id: uuid(),
                    role: 'assistant',
                    content: `Opening ${filePath}... [CLICK TO VIEW](${filePath})`,
                    timestamp: new Date()
                };
                this.emit('chat', openMessage);
                this.currentUserImages = undefined;
                return;
            }
        }

        // Send to orchestrator worker for complex requests
        await this.sendToOrchestratorWorker(content, images);

        // Clear images after processing
        this.currentUserImages = undefined;
    }

    /**
     * Spawn a new orchestrator worker and send it a message
     */
    private async sendToOrchestratorWorker(content: string, images?: ImageAttachment[]): Promise<void> {
        // Get workspace context
        let workspaceContext = '';
        if (this.currentWorkspaceId) {
            const workspace = this.workspaceStore.getWorkspace(this.currentWorkspaceId);
            if (workspace) {
                workspaceContext = `\n\n**Current Workspace**: ${workspace.name} (${workspace.id})\nAll tasks will be executed in this workspace unless otherwise specified.`;
            }
        }

        const systemPrompt = this.contextManager.getOrchestratorSystemPrompt(workspaceContext);

        // Build the full prompt with context
        const context = this.conversationStore.getContextForWorker();
        const contextPrefix = context ? `${context}\n\n` : '';
        const fullPrompt = `${systemPrompt}\n\n${contextPrefix}User request: ${content}`;

        // Spawn a new orchestrator worker for this request
        const cwd = this.currentWorkspaceId || this.projectStore.getCurrentProject() || process.cwd();
        const mcpServers = this.configStore.getMCPServers();
        const workerId = `orchestrator-${Date.now()}`;

        console.log(`[Orchestrator] Spawning orchestrator worker for request: "${content.substring(0, 50)}..."`);

        this.orchestratorOutputBuffer = '';
        this.orchestratorSessionId = null;

        // Use 'print' mode for orchestrator - clean output, no terminal UI leak
        this.orchestratorWorker = await this.processManager.spawn(
            workerId,
            fullPrompt,
            cwd,
            mcpServers,
            'print'  // Orchestrator uses print mode for clean output
        );
    }

    /**
     * Handle resume intent - either auto-resume or ask user to select
     */
    private async handleResumeIntent(content: string, result: IntentResult): Promise<void> {
        // High confidence single match - auto resume
        if (result.conversationId && result.confidence > 0.75) {
            const resumed = this.conversationStore.resumeConversation(result.conversationId);
            if (resumed) {
                this.emitResumeMessage(resumed);
                // Continue with the request in resumed context
                await this.sendToOrchestratorWorker(content);
                return;
            }
        }

        // Multiple candidates or lower confidence - ask user to select
        if (result.candidates && result.candidates.length > 0) {
            const selectMessage: ChatMessage = {
                id: uuid(),
                role: 'assistant',
                content: `I found ${result.candidates.length} conversation(s) you might want to resume. Which one?`,
                timestamp: new Date()
            };
            this.emit('chat', selectMessage);
            this.emit('conversation:select', { candidates: result.candidates, originalMessage: content });
            return;
        }

        // No matches - start new
        const title = content.substring(0, 50) + (content.length > 50 ? '...' : '');
        this.conversationStore.startConversation(title);
        await this.sendToOrchestratorWorker(content);
    }

    /**
     * Handle user's conversation selection
     */
    async selectConversation(conversationId: string | null, originalMessage: string): Promise<void> {
        if (conversationId) {
            const resumed = this.conversationStore.resumeConversation(conversationId);
            if (resumed) {
                this.emitResumeMessage(resumed);
                await this.sendToOrchestratorWorker(originalMessage);
                return;
            }
        }

        // Start new if selection was null or failed
        const title = originalMessage.substring(0, 50) + (originalMessage.length > 50 ? '...' : '');
        this.conversationStore.startConversation(title);
        await this.sendToOrchestratorWorker(originalMessage);
    }

    /**
     * Emit a message about resuming conversation
     */
    private emitResumeMessage(conversation: StoredConversation): void {
        const tasksSummary = conversation.taskNames.length > 0
            ? ` Previous tasks: ${conversation.taskNames.join(', ')}.`
            : '';
        const resumeMessage: ChatMessage = {
            id: uuid(),
            role: 'assistant',
            content: `📂 Resuming conversation: "${conversation.title}".${tasksSummary}`,
            timestamp: new Date()
        };
        this.emit('chat', resumeMessage);
        this.emit('conversation:resumed', { conversation });
    }

    /**
     * Generate a natural response describing what the orchestrator plans to do
     */
    private generatePlanResponse(userRequest: string): string {
        const request = userRequest.toLowerCase();

        // Extract key action verbs and context
        if (request.includes('create') || request.includes('build') || request.includes('make')) {
            const target = this.extractTarget(userRequest);
            return `I'll create ${target} for you. Let me spawn a worker to handle this.`;
        }

        if (request.includes('fix') || request.includes('debug') || request.includes('solve')) {
            return `I'll investigate and fix this issue. Spawning a worker to analyze and resolve the problem.`;
        }

        if (request.includes('refactor') || request.includes('improve') || request.includes('optimize')) {
            return `I'll refactor this code for you. Let me spawn a worker to make the improvements.`;
        }

        if (request.includes('test') || request.includes('verify')) {
            return `I'll run the tests and verify everything is working. Spawning a worker now.`;
        }

        if (request.includes('add') || request.includes('implement')) {
            const target = this.extractTarget(userRequest);
            return `I'll implement ${target}. Spawning a worker to handle this task.`;
        }

        if (request.includes('update') || request.includes('change') || request.includes('modify')) {
            return `I'll make those changes for you. Let me spawn a worker to update the code.`;
        }

        if (request.includes('remove') || request.includes('delete')) {
            return `I'll remove that for you. Spawning a worker to handle the cleanup.`;
        }

        // Default natural response
        return `I understand. I'll work on "${userRequest.substring(0, 60)}${userRequest.length > 60 ? '...' : ''}". Spawning a worker now.`;
    }

    /**
     * Extract the main target/subject from the request
     */
    private extractTarget(request: string): string {
        // Try to extract what comes after action verbs
        const patterns = [
            /create\s+(?:a\s+)?(.+?)(?:\s+for|\s+that|\s+with|$)/i,
            /build\s+(?:a\s+)?(.+?)(?:\s+for|\s+that|\s+with|$)/i,
            /add\s+(?:a\s+)?(.+?)(?:\s+to|\s+for|\s+that|$)/i,
            /implement\s+(?:a\s+)?(.+?)(?:\s+for|\s+that|\s+with|$)/i,
        ];

        for (const pattern of patterns) {
            const match = request.match(pattern);
            if (match && match[1]) {
                const target = match[1].trim();
                if (target.length > 0 && target.length < 50) {
                    return target;
                }
            }
        }

        return 'that';
    }

    /**
     * Classify the user's intent from their message
     * Returns: 'task' | 'command' | 'search' | 'question' | 'conversation' | 'clarification'
     */
    private classifyIntent(message: string): 'task' | 'command' | 'search' | 'question' | 'conversation' | 'clarification' {
        const lower = message.toLowerCase().trim();

        // Terminal command patterns - direct shell command execution
        // Format: "run <command>" or "execute <command>" or "$ <command>"
        const commandPatterns = [
            /^(run|execute)\s+(command\s+)?['"`]?\w+/i,    // "run ls -la", "execute npm install"
            /^\$\s+\w+/i,                                    // "$ ls -la"
            /^shell\s+/i,                                    // "shell npm install"
            /^terminal\s+/i,                                 // "terminal ls"
        ];

        // Web search patterns - search the web
        const searchPatterns = [
            /^(search|search for|look up|google|find info|find information)\s+/i,
            /^(what is|what's)\s+.+\?$/i,  // Simple fact questions
            /^search:\s*/i,                // "search: query"
        ];

        // Check for command patterns first (highest priority)
        for (const pattern of commandPatterns) {
            if (pattern.test(lower)) {
                return 'command';
            }
        }

        // Check for search patterns
        for (const pattern of searchPatterns) {
            if (pattern.test(lower)) {
                return 'search';
            }
        }

        // Question patterns - asking for information/explanation
        const questionPatterns = [
            /^(what|how|why|when|where|who|which|can you explain|could you explain|explain)/i,
            /\?$/,
            /^(is|are|do|does|did|was|were|has|have|will|would|could|should|can)\s/i,
            /^tell me (about|more)/i,
            /^describe/i,
            /^show me (the|how|what)/i,
        ];

        // Conversational patterns - greetings, acknowledgments, etc.
        const conversationPatterns = [
            /^(hi|hello|hey|thanks|thank you|ok|okay|sure|got it|understood|i see|nice|great|cool|awesome)/i,
            /^(yes|no|yeah|nope|yep|nah)$/i,
        ];

        // Clarification patterns - user is responding to a question
        const clarificationPatterns = [
            /^(i want|i need|i meant|i'd like|the one|that one|this one|for the|in the|at the)/i,
            /^(use|with|using|via|through)/i,
        ];

        // Action patterns - explicit task requests
        const actionPatterns = [
            /^(create|build|make|add|implement|fix|debug|refactor|optimize|update|change|modify|remove|delete|write|generate|set up|configure|install|deploy|test|verify)/i,
            /^(can you|could you|please|would you)\s+(create|build|make|add|implement|fix|debug|refactor|optimize|update|change|modify|remove|delete|write|generate|set up|configure|install|deploy|test|verify)/i,
            /^use\s+\w+\s+to\s/i,  // "use playwright to...", "use puppeteer to...", etc.
        ];

        // Check for explicit action patterns first
        for (const pattern of actionPatterns) {
            if (pattern.test(lower)) {
                return 'task';
            }
        }

        // Check for questions
        for (const pattern of questionPatterns) {
            if (pattern.test(lower)) {
                return 'question';
            }
        }

        // Check for conversational patterns
        for (const pattern of conversationPatterns) {
            if (pattern.test(lower)) {
                return 'conversation';
            }
        }

        // Check for clarification patterns
        for (const pattern of clarificationPatterns) {
            if (pattern.test(lower)) {
                return 'clarification';
            }
        }

        // Default: if the message is short and doesn't match action patterns, treat as conversation
        // If it's longer and substantive, treat as a task
        if (lower.length < 30) {
            return 'conversation';
        }

        return 'task';
    }

    /**
     * Execute a terminal command and stream output to chat
     */
    private async runCommand(command: string): Promise<void> {
        console.log(`[Orchestrator] Running command: ${command}`);

        const cwd = this.projectStore.getCurrentProject() || process.cwd();

        // Notify user that command is starting
        const startMessage: ChatMessage = {
            id: uuid(),
            role: 'assistant',
            content: `⚡ Running: \`${command}\``,
            timestamp: new Date()
        };
        this.emit('chat', startMessage);

        return new Promise((resolve) => {
            const proc = spawn('bash', ['-l', '-c', command], {
                cwd,
                env: { ...process.env, FORCE_COLOR: '0' },
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let output = '';
            let outputLines: string[] = [];

            const handleData = (data: Buffer) => {
                const text = data.toString();
                output += text;
                outputLines.push(text);
                // Stream output as chat messages (batched)
                this.emit('output', { type: 'command', data: text });
            };

            proc.stdout?.on('data', handleData);
            proc.stderr?.on('data', handleData);

            proc.on('close', (code: number) => {
                console.log(`[Orchestrator] Command exited with code ${code}`);

                // Send final result
                const emoji = code === 0 ? '✅' : '❌';
                const resultMessage: ChatMessage = {
                    id: uuid(),
                    role: 'assistant',
                    content: `${emoji} Command completed (exit code: ${code})\n\n\`\`\`\n${output.slice(-2000)}\n\`\`\``,
                    timestamp: new Date()
                };
                this.emit('chat', resultMessage);
                resolve();
            });

            proc.on('error', (err: Error) => {
                console.error('[Orchestrator] Command error:', err);
                const errorMessage: ChatMessage = {
                    id: uuid(),
                    role: 'assistant',
                    content: `❌ Command failed: ${err.message}`,
                    timestamp: new Date()
                };
                this.emit('chat', errorMessage);
                resolve();
            });
        });
    }

    /**
     * Perform a web search and return results
     */
    private async webSearch(query: string): Promise<void> {
        console.log(`[Orchestrator] Searching for: ${query}`);

        // Notify user that search is starting
        const startMessage: ChatMessage = {
            id: uuid(),
            role: 'assistant',
            content: `🔍 Searching for: "${query}"...`,
            timestamp: new Date()
        };
        this.emit('chat', startMessage);

        try {
            // Use DuckDuckGo instant answer API (simple, no API key needed)
            const encodedQuery = encodeURIComponent(query);
            const response = await fetch(`https://api.duckduckgo.com/?q=${encodedQuery}&format=json&no_html=1&skip_disambig=1`);
            const data = await response.json() as {
                AbstractText?: string;
                AbstractSource?: string;
                AbstractURL?: string;
                Heading?: string;
                RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
            };

            let resultContent = '';

            if (data.AbstractText) {
                resultContent = `📖 **${data.Heading || query}**\n\n${data.AbstractText}`;
                if (data.AbstractSource) {
                    resultContent += `\n\n*Source: ${data.AbstractSource}*`;
                }
                if (data.AbstractURL) {
                    resultContent += `\n[Read more](${data.AbstractURL})`;
                }
            } else if (data.RelatedTopics && data.RelatedTopics.length > 0) {
                resultContent = `📚 **Related topics for "${query}":**\n\n`;
                const topics = data.RelatedTopics.slice(0, 5);
                for (const topic of topics) {
                    if (topic.Text) {
                        resultContent += `• ${topic.Text}\n`;
                        if (topic.FirstURL) {
                            resultContent += `  [Link](${topic.FirstURL})\n`;
                        }
                    }
                }
            } else {
                resultContent = `🔍 No instant results found for "${query}". Try spawning a research task for more detailed information.`;
            }

            const resultMessage: ChatMessage = {
                id: uuid(),
                role: 'assistant',
                content: resultContent,
                timestamp: new Date()
            };
            this.emit('chat', resultMessage);
        } catch (error) {
            console.error('[Orchestrator] Search error:', error);
            const errorMessage: ChatMessage = {
                id: uuid(),
                role: 'assistant',
                content: `❌ Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
                timestamp: new Date()
            };
            this.emit('chat', errorMessage);
        }
    }

    /**
     * Extract command from user message
     */
    private extractCommand(message: string): string {
        // Remove common prefixes
        let cmd = message
            .replace(/^(run|execute|shell|terminal)\s+(command\s+)?/i, '')
            .replace(/^\$\s+/, '')
            .trim();
        // Remove surrounding quotes if present
        if ((cmd.startsWith('"') && cmd.endsWith('"')) || (cmd.startsWith("'") && cmd.endsWith("'"))) {
            cmd = cmd.slice(1, -1);
        }
        return cmd;
    }

    /**
     * Extract search query from user message
     */
    private extractSearchQuery(message: string): string {
        return message
            // Match longer patterns first to avoid partial matches
            .replace(/^(search for|search:|find information|find info|look up|google|what is|what's|search)\s*/i, '')
            .replace(/\?$/, '')
            .trim();
    }

    /**
     * Generate a response for non-task intents
     */
    private generateNonTaskResponse(userRequest: string, intent: 'question' | 'conversation' | 'clarification'): string {
        const lower = userRequest.toLowerCase();

        if (intent === 'conversation') {
            if (/^(hi|hello|hey)/i.test(lower)) {
                return "Hello! I'm the orchestrator agent. I can help you manage coding tasks by spawning Claude workers. What would you like me to work on?";
            }
            if (/^(thanks|thank you)/i.test(lower)) {
                return "You're welcome! Let me know if there's anything else you'd like me to help with.";
            }
            return "I understand. What would you like me to do next?";
        }

        if (intent === 'question') {
            return `That's a great question! However, I'm an orchestrator agent - I specialize in breaking down coding tasks and managing workers to execute them. If you'd like me to investigate or analyze something, just let me know what you'd like me to look into, and I'll spawn a worker to help.`;
        }

        if (intent === 'clarification') {
            return `Thanks for clarifying. Could you tell me more about what specific action you'd like me to take? For example: create, fix, add, update, or test something?`;
        }

        return "I'm here to help! What task would you like me to work on?";
    }



    /**
     * Set the workspace that the orchestrator should focus on
     */
    setWorkspace(workspaceId: string | null): void {
        if (workspaceId !== null) {
            const workspace = this.workspaceStore.getWorkspace(workspaceId);
            if (!workspace) {
                throw new Error(`Workspace not found: ${workspaceId}`);
            }
        }
        this.currentWorkspaceId = workspaceId;
        // Also update the workspace store's active workspace
        this.workspaceStore.setActiveWorkspace(workspaceId);
        console.log(`[Orchestrator] Workspace focus set to: ${workspaceId || 'none'}`);
    }

    /**
     * Get the current workspace ID
     */
    getCurrentWorkspaceId(): string | null {
        return this.currentWorkspaceId;
    }

    /**
     * Sanitize LLM content to remove any XML/formatting artifacts
     */
    private sanitizeContent(content: string): string {
        // Check if content looks like malformed agent output (contains XML tags or agent artifact patterns)
        const hasXmlTags = /<[a-z_]+[^>]*>/i.test(content);
        const hasAgentPattern = /CodeWriterAgent|spawn_agent|agent_id|agent_type|context_message/i.test(content);
        const hasNumberedAgentList = /^\s*\d+\s*\n\s*(Code|Test|Debug|Build)/m.test(content);

        // If the content is severely malformed (mostly XML/agent artifacts), return a generic message
        if (hasXmlTags && hasAgentPattern) {
            console.log('[Orchestrator] Detected malformed LLM output, using fallback');
            return "I'll work on this task for you!";
        }

        // Remove specific XML-style tags that might appear in LLM output
        let sanitized = content
            .replace(/<\/?spawn_agent[^>]*>/gi, '')
            .replace(/<\/?agent_id[^>]*>/gi, '')
            .replace(/<\/?agent_type[^>]*>/gi, '')
            .replace(/<\/?system_prompt[^>]*>/gi, '')
            .replace(/<\/?prompt[^>]*>/gi, '')
            .replace(/<\/?context_message[^>]*>/gi, '')
            .replace(/<\/?task[^>]*>/gi, '')
            .replace(/<[a-z_]+[^>]*>[^<]*<\/[a-z_]+>/gi, '') // Generic tag pairs with content
            .replace(/<[a-z_]+[^>]*>/gi, '') // Opening tags
            .replace(/<\/[a-z_]+>/gi, '') // Closing tags
            .trim();

        // Remove standalone agent type names and numbered list artifacts
        sanitized = sanitized
            .replace(/^\s*\d+\s*$/gm, '') // Standalone numbers
            .replace(/^(CodeWriterAgent|TestAgent|DebugAgent|BuildAgent)\s*$/gmi, '')
            .replace(/\n{3,}/g, '\n\n') // Collapse excessive newlines
            .trim();

        // If content was truncated or looks incomplete (ends mid-sentence), clean up
        const incompletePatterns = [
            /\d+\.\s*[A-Z][a-z]{0,15}$/,  // "1. Navig" or "2. Creat"
            /\d+\.\s*$/,                    // Just "1. "
            /[a-z]{1,5}$/,                  // Word cut off
        ];

        for (const pattern of incompletePatterns) {
            if (pattern.test(sanitized)) {
                // Remove the truncated portion
                sanitized = sanitized.replace(pattern, '').trim();
                break;
            }
        }

        // If sanitization removed too much content, use fallback
        if (sanitized.length < 10) {
            return "I'll work on this task for you!";
        }

        return sanitized;
    }

    /**
     * Notify orchestrator about task completion
     */
    private async notifyTaskComplete(task: Task): Promise<void> {
        // Prevent duplicate notifications
        if (this.notifiedTaskIds.has(task.id)) {
            console.log(`[Orchestrator] Task ${task.id} already notified, skipping duplicate`);
            return;
        }
        this.notifiedTaskIds.add(task.id);

        // Extract and track any file paths from task output
        if (task.output && task.output.length > 0) {
            const extractedPaths = this.extractFilePaths(task.output.join('\n'));
            if (extractedPaths.length > 0) {
                console.log(`[Orchestrator] Tracked file paths from task: ${extractedPaths.join(', ')}`);
                this.recentFilePaths.push(...extractedPaths);
                // Keep only last 20 paths
                if (this.recentFilePaths.length > 20) {
                    this.recentFilePaths = this.recentFilePaths.slice(-20);
                }
            }
        }

        try {
            // Use LLM to analyze the task output and generate a dynamic response
            const analysis = await generateTaskCompletionResponse(
                task.name,
                task.description,
                task.exitCode ?? (task.status === 'complete' ? 0 : 1),
                task.output,
                task.structuredResult
            );

            // Store task result with artifacts for follow-up context
            const taskResult: TaskResult = {
                taskId: task.id,
                taskName: task.name,
                status: task.status === 'complete' ? 'complete' : 'error',
                summary: analysis.summary || analysis.message,
                artifacts: analysis.artifacts || [],
                completedAt: new Date()
            };
            this.conversationStore.addTaskResult(taskResult);

            // Sanitize the message content
            const sanitizedMessage = this.sanitizeContent(analysis.message);

            // Build the complete message including structured result if present
            let completeMessage = sanitizedMessage;

            // If we have a structured result with actual content, append it to the message
            if (task.structuredResult?.result) {
                completeMessage += '\n\n--- Output ---\n\n' + task.structuredResult.result;
            } else if (task.output && task.output.length > 0) {
                // For tasks without structured results, include the last 100 lines of actual output
                // This ensures the orchestrator shows the full results instead of just "task complete"
                const recentOutput = task.output.slice(-100).join('\n');
                const outputToShow = recentOutput.length > 4000
                    ? '...\n' + recentOutput.substring(recentOutput.length - 4000)
                    : recentOutput;

                if (outputToShow.trim()) {
                    console.log(`[Orchestrator] Including ${task.output.length} lines of task output (showing last ${Math.min(100, task.output.length)} lines, ${outputToShow.length} chars)`);
                    completeMessage += '\n\n--- Task Output ---\n\n' + outputToShow;
                }
            }

            const message: ChatMessage = {
                id: uuid(),
                role: 'assistant',
                content: completeMessage,
                timestamp: new Date(),
                suggestedActions: analysis.suggestedActions
            };
            this.emit('chat', message);

            // If the task needs continuation, suggest action
            if (analysis.needsContinuation && analysis.suggestedAction) {
                console.log(`[Orchestrator] Task needs continuation: ${analysis.suggestedAction}`);
                // Could spawn a follow-up task here in the future
                const followUpMessage: ChatMessage = {
                    id: uuid(),
                    role: 'assistant',
                    content: `🔄 I'll ${analysis.suggestedAction.toLowerCase()}.`,
                    timestamp: new Date()
                };
                this.emit('chat', followUpMessage);
            }
        } catch (error) {
            console.error('[Orchestrator] Failed to generate task completion message:', error);
            // Fallback to simple message
            const statusEmoji = task.status === 'complete' ? '✅' : '❌';
            const message: ChatMessage = {
                id: uuid(),
                role: 'system',
                content: `${statusEmoji} Task "${task.name}" ${task.status}${task.exitCode !== undefined ? ` (exit code: ${task.exitCode})` : ''}`,
                timestamp: new Date()
            };
            this.emit('chat', message);
        }
    }

    /**
     * Handle real-time task output to detect issues and intervene
     */
    private async handleTaskOutput(taskId: string, workerId: string, data: string): Promise<void> {
        const task = this.taskManager.getTask(taskId);
        if (!task || task.status !== 'running') return;

        // Buffer output for this task
        if (!this.taskOutputBuffers.has(taskId)) {
            this.taskOutputBuffers.set(taskId, []);
        }
        const buffer = this.taskOutputBuffers.get(taskId)!;
        buffer.push(data);

        // NOTE: We do NOT call taskManager.appendOutput here.
        // The server.ts already listens for processManager 'output' events
        // and calls taskManager.appendOutput. Calling it again here would 
        // cause duplicate output.

        // Keep only last 100 lines
        if (buffer.length > 100) {
            buffer.splice(0, buffer.length - 100);
        }

        // Check if we should analyze (cooldown to avoid spamming LLM)
        const lastAnalysis = this.lastAnalysisTime.get(taskId) || 0;
        const now = Date.now();
        if (now - lastAnalysis < this.ANALYSIS_COOLDOWN_MS) {
            return;
        }

        // Quick check for error indicators before calling LLM
        const recentText = buffer.slice(-20).join('\n').toLowerCase();
        const hasErrorIndicator =
            recentText.includes('error') ||
            recentText.includes('failed') ||
            recentText.includes('exception') ||
            recentText.includes('permission denied');

        if (!hasErrorIndicator) {
            return;
        }

        // Update last analysis time
        this.lastAnalysisTime.set(taskId, now);
        console.log(`[Orchestrator] Analyzing logs for task ${taskId}...`);

        try {
            const analysis = await analyzeLogsForIssues(
                task.name,
                task.description,
                buffer.slice(-50)
            );

            if (analysis.hasIssue && analysis.suggestedIntervention) {
                console.log(`[Orchestrator] Issue detected: ${analysis.issueDescription}`);
                console.log(`[Orchestrator] Sending intervention: ${analysis.suggestedIntervention}`);

                // Send intervention to the worker
                const sent = await this.processManager.sendInput(workerId, analysis.suggestedIntervention);

                if (sent) {
                    // Notify user about the intervention
                    const interventionMessage: ChatMessage = {
                        id: uuid(),
                        role: 'assistant',
                        content: `🔧 **Auto-intervention:** Detected ${analysis.issueType || 'issue'} in task "${task.name}". Sent instruction: "${analysis.suggestedIntervention}"`,
                        timestamp: new Date()
                    };
                    this.emit('chat', interventionMessage);
                }
            }
        } catch (error) {
            console.error('[Orchestrator] Error during log analysis:', error);
        }
    }

    /**
     * Wait for specific tasks to complete
     */
    async waitForTasks(taskIds: string[]): Promise<void> {
        if (this.taskManager.areTasksComplete(taskIds)) {
            return;
        }

        return new Promise((resolve) => {
            const waitId = uuid();
            this.pendingWaits.set(waitId, { taskIds, resolve });
        });
    }

    /**
     * Check if any pending waits can be resolved
     */
    private checkPendingWaits(): void {
        for (const [waitId, { taskIds, resolve }] of this.pendingWaits) {
            if (this.taskManager.areTasksComplete(taskIds)) {
                this.pendingWaits.delete(waitId);
                resolve();
            }
        }
    }

    /**
     * Manually spawn a task (for API use)
     */
    async spawnTask(name: string, description: string, parentId?: string, projectPath?: string): Promise<Task> {
        // Use provided project path, or fall back to stored current project
        console.log(`[Orchestrator] spawnTask called: name=${name}, projectPath=${projectPath}, currentProject=${this.projectStore.getCurrentProject()}, currentWorkspaceId=${this.currentWorkspaceId}`);
        const cwd = projectPath || this.projectStore.getCurrentProject() || undefined;
        console.log(`[Orchestrator] spawnTask using cwd=${cwd}`);
        const task = this.taskManager.createTask(name, description, parentId, cwd);
        const mcpServers = this.configStore.getMCPServers();
        const workerPrompt = this.contextManager.buildWorkerPrompt(description);
        const worker = await this.processManager.spawn(task.id, workerPrompt, cwd, mcpServers);
        this.taskManager.assignWorker(task.id, worker.id);
        return task;
    }

    /**
     * Stop a running task by killing its worker process
     */
    async stopTask(taskId: string): Promise<boolean> {
        const task = this.taskManager.getTask(taskId);
        if (!task) {
            console.log(`[Orchestrator] stopTask: Task ${taskId} not found`);
            return false;
        }

        if (task.status !== 'running') {
            console.log(`[Orchestrator] stopTask: Task ${taskId} is not running (status: ${task.status})`);
            return false;
        }

        if (!task.workerId) {
            console.log(`[Orchestrator] stopTask: Task ${taskId} has no worker assigned`);
            return false;
        }

        // Kill the worker process
        const killed = await this.processManager.kill(task.workerId);
        if (killed) {
            // Update task status to stopped
            this.taskManager.updateStatus(taskId, 'stopped');
            console.log(`[Orchestrator] Task ${taskId} stopped successfully`);
        } else {
            console.log(`[Orchestrator] Failed to kill worker for task ${taskId}`);
        }

        return killed;
    }

    /**
     * Check for stuck tasks and notify the user
     */
    private async checkForStuckTasks(): Promise<void> {
        const stuckTasks = this.taskManager.detectStuckTasks(120000); // 2 minutes

        for (const task of stuckTasks) {
            // Skip if we've already notified about this task
            if (this.notifiedStuckTasks.has(task.id)) {
                continue;
            }

            this.notifiedStuckTasks.add(task.id);
            console.log(`[Orchestrator] Detected stuck task: ${task.name} (${task.id})`);

            // Notify the user
            const stuckMessage: ChatMessage = {
                id: uuid(),
                role: 'assistant',
                content: `⚠️ **Task "${task.name}" appears to be stuck** (no output for 2+ minutes).\n\nWhat would you like to do?`,
                timestamp: new Date(),
                suggestedActions: [
                    { label: 'Wait longer', action: `wait-${task.id}` },
                    { label: 'Stop task', action: `stop-${task.id}` },
                    { label: 'Restart task', action: `restart-${task.id}` }
                ]
            };
            this.emit('chat', stuckMessage);
        }
    }

    /**
     * Handle a blocked task notification
     */
    private async handleTaskBlocked(task: Task): Promise<void> {
        console.log(`[Orchestrator] Task blocked: ${task.name} - ${task.blockReason}`);

        const blockedByNames = task.blockedBy
            ? task.blockedBy.map(id => {
                const blockingTask = this.taskManager.getTask(id);
                return blockingTask ? blockingTask.name : id;
            }).join(', ')
            : 'unknown tasks';

        const blockMessage: ChatMessage = {
            id: uuid(),
            role: 'assistant',
            content: `🚧 **Task "${task.name}" is blocked**\n\nReason: ${task.blockReason}\nBlocked by: ${blockedByNames}\n\nWhat would you like to do?`,
            timestamp: new Date(),
            suggestedActions: [
                { label: 'Skip this task', action: `skip-${task.id}` },
                { label: 'Modify approach', action: `modify-${task.id}` },
                { label: 'Cancel plan', action: `cancel-plan` }
            ]
        };
        this.emit('chat', blockMessage);
    }

    /**
     * Stop the orchestrator
     */
    async stop(): Promise<void> {
        // Stop stuck task monitoring
        if (this.stuckTaskCheckInterval) {
            clearInterval(this.stuckTaskCheckInterval);
            this.stuckTaskCheckInterval = null;
        }

        // Stop the Claude Code orchestrator worker
        if (this.orchestratorWorker) {
            await this.processManager.kill(this.orchestratorWorker.id);
            this.orchestratorWorker = null;
        }

        if (this.process) {
            this.process.kill('SIGTERM');
            this.process = null;
        }
        this.isReady = false;
        console.log('[Orchestrator] Stopped');
    }
}
