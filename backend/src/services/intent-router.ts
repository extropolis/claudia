import { classifyIntent } from '../intent-classifier.js';
import { IntentResult, ConversationSummary } from '@claudia/shared';

export type ActionType = 'task' | 'command' | 'search' | 'question' | 'conversation' | 'clarification';

export class IntentRouter {
    /**
     * Classify the user's intent from their message (Regex-based action detection)
     */
    determineActionType(message: string): ActionType {
        const lower = message.toLowerCase().trim();

        // Terminal command patterns - direct shell command execution
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
            /^use\s+\w+\s+to\s/i,
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

        // Default heuristic
        if (lower.length < 30) {
            return 'conversation';
        }

        return 'task';
    }

    /**
     * Analyze if user wants to resume a conversation or start new (Smart semantic connection)
     */
    analyzeResumeIntent(message: string, conversations: ConversationSummary[]): IntentResult {
        return classifyIntent(message, conversations);
    }

    /**
     * Extract command from user message
     */
    extractCommand(message: string): string {
        let cmd = message
            .replace(/^(run|execute|shell|terminal)\s+(command\s+)?/i, '')
            .replace(/^\$\s+/, '')
            .trim();
        if ((cmd.startsWith('"') && cmd.endsWith('"')) || (cmd.startsWith("'") && cmd.endsWith("'"))) {
            cmd = cmd.slice(1, -1);
        }
        return cmd;
    }

    /**
     * Extract search query from user message
     */
    extractSearchQuery(message: string): string {
        return message
            .replace(/^(search for|search:|find information|find info|look up|google|what is|what's|search)\s*/i, '')
            .replace(/\?$/, '')
            .trim();
    }

    /**
     * Generate a response for non-task intents
     */
    generateNonTaskResponse(userRequest: string, intent: 'question' | 'conversation' | 'clarification'): string {
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
     * Generate a natural response describing what the orchestrator plans to do
     */
    generatePlanResponse(userRequest: string): string {
        const request = userRequest.toLowerCase();

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

        return `I understand. I'll work on "${userRequest.substring(0, 60)}${userRequest.length > 60 ? '...' : ''}". Spawning a worker now.`;
    }

    private extractTarget(request: string): string {
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
     * Detect if a task involves browser/playwright usage
     */
    isBrowserTask(request: string): boolean {
        const lower = request.toLowerCase();
        const browserPatterns = [
            /playwright/i,
            /puppeteer/i,
            /browser/i,
            /navigate\s+to/i,
            /open\s+(the\s+)?url/i,
            /go\s+to\s+(http|www|\w+\.com)/i,
            /visit\s+(http|www|\w+\.com)/i,
        ];
        return browserPatterns.some(p => p.test(lower));
    }

    /**
     * Detect if a task is a continuation that needs the existing browser session
     */
    isBrowserContinuationTask(request: string): boolean {
        const lower = request.toLowerCase();
        const continuationPatterns = [
            /current\s+page/i,
            /this\s+page/i,
            /the\s+page/i,
            /screenshot/i,
            /click\s+(on\s+)?the/i,
            /type\s+(in|into)/i,
            /fill\s+(in|out)?\s+the/i,
            /scroll/i,
            /wait\s+for/i,
            /check\s+the/i,
            /verify\s+the/i,
        ];
        return continuationPatterns.some(p => p.test(lower));
    }

    /**
     * Detect if request is asking to open a file
     */
    isOpenFileRequest(request: string): boolean {
        const lower = request.toLowerCase();
        return /^(open|show|display|view)\s+(the\s+)?(screenshot|file|image|picture|photo)/i.test(lower);
    }

    /**
     * Find a matching file path from recent outputs
     */
    findRecentFile(hint: string, recentFilePaths: string[]): string | null {
        const lower = hint.toLowerCase();
        // Look for screenshot/image files if mentioned
        if (/screenshot|image|picture|photo/i.test(lower)) {
            const imageFile = recentFilePaths.find(p =>
                /\.(png|jpg|jpeg|gif)$/i.test(p)
            );
            if (imageFile) return imageFile;
        }
        // Return most recent file if any
        return recentFilePaths.length > 0 ? recentFilePaths[recentFilePaths.length - 1] : null;
    }
}
