import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuid } from 'uuid';
import {
    ConversationSummary,
    StoredConversation,
    ChatMessage,
    Task,
    TaskResult
} from '@claudia/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Persistent store for conversation history
 */
export class ConversationStore {
    private conversations: Map<string, StoredConversation> = new Map();
    private currentConversationId: string | null = null;
    private dataDir: string;
    private dataFile: string;

    constructor(basePath?: string) {
        // Use basePath if provided (Electron userData), otherwise use default location
        this.dataDir = basePath
            ? join(basePath, 'data')
            : join(__dirname, '..', 'data');
        this.dataFile = join(this.dataDir, 'conversations.json');

        // Ensure directory exists
        if (!existsSync(this.dataDir)) {
            mkdirSync(this.dataDir, { recursive: true });
        }

        this.load();
        // Don't auto-load any conversation on startup - user should select explicitly
        this.currentConversationId = null;
    }

    /**
     * Load conversations from disk
     */
    private load(): void {
        try {
            if (existsSync(this.dataFile)) {
                const data = JSON.parse(readFileSync(this.dataFile, 'utf-8'));
                for (const conv of data.conversations || []) {
                    // Restore Date objects
                    conv.createdAt = new Date(conv.createdAt);
                    conv.updatedAt = new Date(conv.updatedAt);
                    conv.chatHistory = conv.chatHistory.map((m: ChatMessage) => ({
                        ...m,
                        timestamp: new Date(m.timestamp)
                    }));
                    this.conversations.set(conv.id, conv);
                }
                console.log(`[ConversationStore] Loaded ${this.conversations.size} conversations`);
            }
        } catch (err) {
            console.error('[ConversationStore] Error loading:', err);
        }
    }

    /**
     * Save conversations to disk
     */
    private save(): void {
        try {
            if (!existsSync(this.dataDir)) {
                mkdirSync(this.dataDir, { recursive: true });
            }
            const data = {
                conversations: Array.from(this.conversations.values())
            };
            writeFileSync(this.dataFile, JSON.stringify(data, null, 2));
        } catch (err) {
            console.error('[ConversationStore] Error saving:', err);
        }
    }

    /**
     * Start a new conversation
     */
    startConversation(title: string): StoredConversation {
        const conversation: StoredConversation = {
            id: uuid(),
            title,
            lastMessage: '',
            taskNames: [],
            chatHistory: [],
            tasks: [],
            taskResults: [],
            createdAt: new Date(),
            updatedAt: new Date()
        };
        this.conversations.set(conversation.id, conversation);
        this.currentConversationId = conversation.id;
        console.log(`[ConversationStore] Started conversation: ${conversation.id} - "${title}"`);
        this.save();
        return conversation;
    }

    /**
     * Get current conversation or start a new one
     */
    getCurrentOrCreate(defaultTitle: string): StoredConversation {
        if (this.currentConversationId) {
            const conv = this.conversations.get(this.currentConversationId);
            if (conv) return conv;
        }
        return this.startConversation(defaultTitle);
    }

    /**
     * Resume a specific conversation
     */
    resumeConversation(id: string): StoredConversation | null {
        const conv = this.conversations.get(id);
        if (conv) {
            this.currentConversationId = id;
            console.log(`[ConversationStore] Resumed conversation: ${id}`);
        }
        return conv || null;
    }

    /**
     * Add a message to the current conversation
     */
    addMessage(message: ChatMessage): void {
        if (!this.currentConversationId) return;
        const conv = this.conversations.get(this.currentConversationId);
        if (!conv) return;

        conv.chatHistory.push(message);
        conv.lastMessage = message.content.substring(0, 100);
        conv.updatedAt = new Date();
        this.save();
    }

    /**
     * Add a task to the current conversation
     */
    addTask(task: Task): void {
        if (!this.currentConversationId) return;
        const conv = this.conversations.get(this.currentConversationId);
        if (!conv) return;

        conv.tasks.push(task);
        if (!conv.taskNames.includes(task.name)) {
            conv.taskNames.push(task.name);
        }
        conv.updatedAt = new Date();
        this.save();
    }

    /**
     * Add a structured task result with extracted artifacts
     */
    addTaskResult(result: TaskResult): void {
        if (!this.currentConversationId) return;
        const conv = this.conversations.get(this.currentConversationId);
        if (!conv) return;

        // Initialize taskResults if needed (for older conversations)
        if (!conv.taskResults) {
            conv.taskResults = [];
        }

        conv.taskResults.push(result);
        // Keep only the last 20 task results to avoid bloat
        if (conv.taskResults.length > 20) {
            conv.taskResults = conv.taskResults.slice(-20);
        }
        conv.updatedAt = new Date();
        this.save();
        console.log(`[ConversationStore] Added task result: ${result.taskName} with ${result.artifacts.length} artifacts`);
    }

    /**
     * Get a conversation by ID
     */
    getConversation(id: string): StoredConversation | null {
        return this.conversations.get(id) || null;
    }

    /**
     * List all conversation summaries (for matching)
     */
    listConversations(): ConversationSummary[] {
        return Array.from(this.conversations.values())
            .map(({ id, title, lastMessage, taskNames, createdAt, updatedAt }) => ({
                id, title, lastMessage, taskNames, createdAt, updatedAt
            }))
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    }

    /**
     * Get current conversation ID
     */
    getCurrentId(): string | null {
        return this.currentConversationId;
    }

    /**
     * Clear current conversation (for starting fresh)
     */
    clearCurrent(): void {
        this.currentConversationId = null;
    }

    /**
     * Clear the current conversation's chat history
     */
    clearCurrentConversation(): void {
        if (!this.currentConversationId) return;
        const conv = this.conversations.get(this.currentConversationId);
        if (!conv) return;

        conv.chatHistory = [];
        conv.lastMessage = '';
        conv.updatedAt = new Date();
        this.save();
        console.log(`[ConversationStore] Cleared conversation: ${this.currentConversationId}`);
    }

    /**
     * Build a context string from the current conversation for worker agents
     * This helps workers understand the context of previous interactions
     */
    getContextForWorker(maxMessages: number = 10): string | null {
        if (!this.currentConversationId) return null;
        const conv = this.conversations.get(this.currentConversationId);
        if (!conv || conv.chatHistory.length === 0) return null;

        // Get recent messages (user and assistant only)
        const relevantMessages = conv.chatHistory
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .slice(-maxMessages);

        if (relevantMessages.length === 0) return null;

        // Build context string - avoid dashes at start which look like CLI options
        const contextLines: string[] = [
            '[CONTEXT START]',
            `Orchestrator conversation: "${conv.title}"`,
            ''
        ];

        // Add previous tasks info
        if (conv.taskNames.length > 0) {
            contextLines.push(`Previous tasks completed: ${conv.taskNames.join(', ')}`);
            contextLines.push('');
        }

        // Add recent task results with artifacts (IMPORTANT for follow-up requests)
        if (conv.taskResults && conv.taskResults.length > 0) {
            const recentResults = conv.taskResults.slice(-5); // Last 5 results
            contextLines.push('Recent task results (use these for follow-up requests):');
            for (const result of recentResults) {
                const statusEmoji = result.status === 'complete' ? '✅' : '❌';
                contextLines.push(`${statusEmoji} ${result.taskName}: ${result.summary}`);
                if (result.artifacts.length > 0) {
                    contextLines.push(`   Artifacts: ${result.artifacts.join(', ')}`);
                }
            }
            contextLines.push('');
        }

        // Add recent messages
        contextLines.push('Recent conversation history:');
        for (const msg of relevantMessages) {
            const role = msg.role === 'user' ? 'USER' : 'ORCHESTRATOR';
            // Truncate long messages
            const content = msg.content.length > 500
                ? msg.content.substring(0, 500) + '...'
                : msg.content;
            contextLines.push(`${role}: ${content}`);
        }

        contextLines.push('');
        contextLines.push('[CONTEXT END]');
        contextLines.push('');
        contextLines.push('Based on the above context, here is your current task:');
        contextLines.push('');

        return contextLines.join('\n');
    }
}
