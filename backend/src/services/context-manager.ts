import { ConversationStore } from '../conversation-store.js';

export class ContextManager {
    constructor(private conversationStore: ConversationStore) { }

    /**
     * Build a worker prompt with conversation context
     */
    buildWorkerPrompt(taskPrompt: string): string {
        const context = this.conversationStore.getContextForWorker();
        return context ? `${context}\n\n${taskPrompt}` : taskPrompt;
    }

    /**
     * Get system prompt for the orchestrator - simple and natural
     */
    getOrchestratorSystemPrompt(workspaceContext: string): string {
        return `You are a helpful coding assistant.${workspaceContext}

Respond naturally to the user. Help them with coding tasks, answer questions, and have natural conversations.

When you need to execute code, make changes, or perform tasks - just do them directly using your available tools.`;
    }
}
