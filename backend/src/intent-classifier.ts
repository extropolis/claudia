import { ConversationSummary, IntentResult } from '@claudia/shared';

// Resume intent patterns - weighted by specificity
const RESUME_PATTERNS = [
    { pattern: /continue\s+(working\s+on|with|the)/i, weight: 0.9 },
    { pattern: /resume\s+(the|my|our|work|a\s+previous|previous)/i, weight: 0.95 },
    { pattern: /pick\s+up\s+where/i, weight: 0.9 },
    { pattern: /back\s+to\s+(the|my|that)/i, weight: 0.8 },
    { pattern: /what('s| is| was)\s+(the\s+)?status/i, weight: 0.85 },
    { pattern: /how('s| is| did)\s+(the|my|that)/i, weight: 0.7 },
    { pattern: /keep\s+working\s+on/i, weight: 0.9 },
    { pattern: /let('s| us)\s+continue/i, weight: 0.85 },
    { pattern: /where\s+were\s+we/i, weight: 0.9 },
    { pattern: /finish\s+(the|that|my)/i, weight: 0.75 },
    { pattern: /^continue$/i, weight: 0.95 },
    { pattern: /^resume$/i, weight: 0.95 },
    { pattern: /go\s+back\s+to/i, weight: 0.8 },
    { pattern: /previous\s+(conversation|task|work)/i, weight: 0.9 },
];

// Stop words to ignore when extracting keywords
const STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
    'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
    'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above',
    'below', 'between', 'under', 'again', 'further', 'then', 'once', 'here',
    'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few', 'more',
    'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
    'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or',
    'because', 'until', 'while', 'although', 'my', 'your', 'our', 'their',
    'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom',
    'i', 'me', 'we', 'us', 'you', 'he', 'him', 'she', 'her', 'it', 'they', 'them',
    'work', 'working', 'continue', 'resume', 'back', 'status', 'progress'
]);

/**
 * Extract meaningful keywords from text
 */
function extractKeywords(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 2 && !STOP_WORDS.has(word));
}

/**
 * Calculate similarity between two sets of keywords
 */
function calculateSimilarity(keywords1: string[], keywords2: string[]): number {
    if (keywords1.length === 0 || keywords2.length === 0) return 0;

    const set1 = new Set(keywords1);
    const set2 = new Set(keywords2);

    let matches = 0;
    for (const word of set1) {
        if (set2.has(word)) {
            matches++;
        } else {
            // Partial match (substring)
            for (const word2 of set2) {
                if (word2.includes(word) || word.includes(word2)) {
                    matches += 0.5;
                    break;
                }
            }
        }
    }

    return matches / Math.max(set1.size, set2.size);
}

/**
 * Classify user intent - resume previous conversation or start new
 */
export function classifyIntent(
    userMessage: string,
    conversations: ConversationSummary[]
): IntentResult {
    console.log(`[IntentClassifier] Analyzing: "${userMessage}"`);

    // Check for resume patterns
    let maxPatternWeight = 0;
    for (const { pattern, weight } of RESUME_PATTERNS) {
        if (pattern.test(userMessage)) {
            maxPatternWeight = Math.max(maxPatternWeight, weight);
            console.log(`[IntentClassifier] Matched pattern: ${pattern} (weight: ${weight})`);
        }
    }

    // If no resume patterns found, it's likely a new conversation
    if (maxPatternWeight === 0) {
        console.log('[IntentClassifier] No resume patterns found -> new conversation');
        return { intent: 'new', confidence: 0.8 };
    }

    // No previous conversations to resume
    if (conversations.length === 0) {
        console.log('[IntentClassifier] No previous conversations to resume');
        return { intent: 'new', confidence: 0.9 };
    }

    // Extract keywords from user message for topic matching
    const userKeywords = extractKeywords(userMessage);
    console.log(`[IntentClassifier] User keywords: [${userKeywords.join(', ')}]`);

    // Score each conversation by similarity
    const scoredConversations = conversations.map(conv => {
        const convKeywords = [
            ...extractKeywords(conv.title),
            ...extractKeywords(conv.lastMessage),
            ...conv.taskNames.flatMap(name => extractKeywords(name))
        ];

        const similarity = calculateSimilarity(userKeywords, convKeywords);
        const recencyBonus = Math.max(0, 0.1 - (Date.now() - conv.updatedAt.getTime()) / (7 * 24 * 60 * 60 * 1000)); // Decay over 1 week
        const score = similarity + recencyBonus;

        console.log(`[IntentClassifier] Conversation "${conv.title}": similarity=${similarity.toFixed(2)}, recency=${recencyBonus.toFixed(2)}, total=${score.toFixed(2)}`);

        return { ...conv, score };
    }).filter(c => c.score > 0.1);

    // Sort by score descending
    scoredConversations.sort((a, b) => b.score - a.score);

    if (scoredConversations.length === 0) {
        // Resume pattern detected but no matching conversations by keyword
        // Return most recent conversation as candidate with higher confidence
        // This way user can confirm or deny
        const mostRecent = conversations[0];
        console.log(`[IntentClassifier] No keyword match, suggesting most recent: "${mostRecent.title}"`);
        return {
            intent: 'resume',
            confidence: Math.max(0.65, maxPatternWeight * 0.7), // Ensure it passes threshold
            candidates: conversations.slice(0, 3) // Show top 3 most recent
        };
    }

    const bestMatch = scoredConversations[0];
    const confidence = Math.min(0.95, maxPatternWeight * (0.5 + bestMatch.score));

    // If multiple good matches or low confidence, return candidates for user selection
    if (scoredConversations.length > 1 && scoredConversations[1].score > bestMatch.score * 0.7) {
        console.log(`[IntentClassifier] Multiple candidates found, asking user to select`);
        return {
            intent: 'resume',
            confidence: confidence * 0.8,
            candidates: scoredConversations.slice(0, 5).map(({ score, ...conv }) => conv)
        };
    }

    console.log(`[IntentClassifier] Best match: "${bestMatch.title}" (confidence: ${confidence.toFixed(2)})`);
    return {
        intent: 'resume',
        conversationId: bestMatch.id,
        confidence,
        candidates: [bestMatch]
    };
}
