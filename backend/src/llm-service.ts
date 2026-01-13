/**
 * LLM Service - Uses Claude via SAP AI Proxy for generating dynamic responses
 */

const LLM_API_URL = process.env.LLM_API_URL || 'http://localhost:3030/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || 'claude-sonnet-4-5-20250929';
const LLM_API_KEY = process.env.LLM_API_KEY || 'test-key-1';

interface ImageContent {
    type: 'image';
    source: {
        type: 'base64';
        media_type: string;
        data: string;
    };
}

interface TextContent {
    type: 'text';
    text: string;
}

type ContentPart = TextContent | ImageContent;

interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string | ContentPart[];
}

interface LLMResponse {
    choices: Array<{
        message: {
            content: string;
        };
    }>;
}

export interface ImageAttachment {
    name: string;
    data: string;
    mimeType: string;
}

/**
 * Generate a response using the LLM
 */
export async function generateLLMResponse(
    systemPrompt: string,
    userMessage: string,
    options: { maxTokens?: number; temperature?: number; images?: ImageAttachment[] } = {}
): Promise<string> {
    const { maxTokens = 200, temperature = 0.7, images } = options;

    // Build user message content with images if provided
    let userContent: string | ContentPart[];
    if (images && images.length > 0) {
        const contentParts: ContentPart[] = [];

        // Add images first
        for (const img of images) {
            contentParts.push({
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: img.mimeType,
                    data: img.data
                }
            });
        }

        // Add text content
        if (userMessage.trim()) {
            contentParts.push({
                type: 'text',
                text: userMessage
            });
        }

        userContent = contentParts;
    } else {
        userContent = userMessage;
    }

    const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
    ];

    try {
        console.log(`[LLM] Calling ${LLM_MODEL} at ${LLM_API_URL}...`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

        const response = await fetch(LLM_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${LLM_API_KEY}`,
            },
            body: JSON.stringify({
                model: LLM_MODEL,
                messages,
                max_tokens: maxTokens,
                temperature,
            }),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[LLM] API error: ${response.status} - ${errorText}`);
            throw new Error(`LLM API error: ${response.status}`);
        }

        const data = await response.json() as LLMResponse;
        const content = data.choices?.[0]?.message?.content;

        if (!content) {
            throw new Error('No content in LLM response');
        }

        console.log(`[LLM] Response generated successfully: "${content.substring(0, 50)}..."`);
        return content.trim();
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            console.error('[LLM] Request timed out after 10 seconds');
        } else {
            console.error('[LLM] Error generating response:', error);
        }
        throw error;
    }
}



export interface SuggestedAction {
    label: string;
    action: string;
}

export interface TaskCompletionAnalysis {
    message: string;
    needsContinuation: boolean;
    suggestedAction?: string;
    suggestedActions?: SuggestedAction[];
    summary?: string;          // Concise summary of what was done
    artifacts?: string[];      // Extracted file paths, URLs, important values
}

/**
 * Generate a task completion response by analyzing the task output
 * This determines if the task truly succeeded, failed, or needs continuation
 */
export async function generateTaskCompletionResponse(
    taskName: string,
    taskDescription: string,
    exitCode: number,
    output: string[],
    structuredResult?: { result?: string; artifacts?: string[]; summary?: string }
): Promise<TaskCompletionAnalysis> {
    // If we have a structured result, prioritize it
    let contextOutput: string;
    if (structuredResult?.result) {
        // Use the structured result as primary content
        contextOutput = `=== TASK RESULT ===
${structuredResult.result}

=== SUMMARY ===
${structuredResult.summary || 'Task completed'}

=== ARTIFACTS ===
${structuredResult.artifacts?.join(', ') || 'None'}`;
    } else {
        // Fall back to last portion of output (increased from 50 to 200 lines)
        const recentOutput = output.slice(-200).join('\n');
        contextOutput = recentOutput.length > 8000
            ? recentOutput.substring(recentOutput.length - 8000)
            : recentOutput;
    }

    const systemPrompt = `You are an AI orchestrator analyzing task completion results.
Analyze the following task output and determine:
1. Was the task truly successful? (even if exit code is 0, check for errors in output)
2. Does this need further action or debugging?
3. What should you tell the user?
4. What are 2-3 helpful next actions the user might want to take?
5. What artifacts (file paths, URLs, important values) were produced?

Respond with a JSON object containing:
- "message": A brief, natural message summarizing what happened. Use emoji if appropriate.
  - IMPORTANT: If there is a TASK RESULT section above, INCLUDE the key information from it in your message.
  - For data retrieval tasks (news, weather, search results), show the actual data to the user, not just "task complete".
  - Example: "📰 Here's the latest news: [actual news headlines]" NOT just "✅ Task complete"
- "summary": A one-line technical summary for context (e.g., "Retrieved 5 news articles")
- "artifacts": Array of strings - extracted file paths, URLs, port numbers, or other important outputs from the task
  - IMPORTANT: Look for file paths (anything with / or .), URLs (http://, https://), port numbers, generated IDs, etc.
  - Examples: [".playwright-mcp/page-2026-01-11.png"], ["http://localhost:3000"], ["user-id-12345"]
- "needsContinuation": boolean - true if errors need fixing, tests failed, or something isn't working
- "suggestedAction": optional string - if continuation needed, what should be done next
- "suggestedActions": array of 2-3 objects with {"label": "button text", "action": "command to execute"}
  - These are clickable buttons for the user. Make them contextual to the completed task.
  - Examples: {"label": "Run tests", "action": "run the tests"}, {"label": "Create another file", "action": "create another file"}
  - Keep labels short (2-4 words) and actions natural language commands

Be concise and helpful. Examples of good messages:
- "✅ Todo app created successfully! It's ready to use with local storage and a modern UI."
- "❌ Build failed due to a TypeScript error in AuthService. Let me fix that for you."
- "📰 Here are today's top headlines: 1) Mars rover discovers water 2) New AI breakthrough..."
- "⚠️ Tests passed but there's a deprecation warning we should address."

IMPORTANT: Output ONLY valid JSON, nothing else.`;

    const userMessage = `Task: "${taskName}"
Description: ${taskDescription}
Exit Code: ${exitCode}

${structuredResult?.result ? 'Output:' : 'Recent Output:'}
${contextOutput}`;

    try {
        let response = await generateLLMResponse(systemPrompt, userMessage, { maxTokens: 800, temperature: 0.3 });

        // Strip markdown code blocks if present (LLM sometimes wraps JSON in ```json ... ```)
        response = response.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        console.log(`[LLM] Cleaned response for parsing: ${response.substring(0, 100)}...`);

        // Parse the JSON response
        const parsed = JSON.parse(response) as TaskCompletionAnalysis;
        return {
            message: parsed.message || (exitCode === 0 ? `✅ Task "${taskName}" completed successfully.` : `❌ Task "${taskName}" failed.`),
            needsContinuation: parsed.needsContinuation || false,
            suggestedAction: parsed.suggestedAction,
            suggestedActions: parsed.suggestedActions,
            summary: parsed.summary || parsed.message,
            artifacts: parsed.artifacts || []
        };
    } catch (error) {
        console.error('[LLM] Failed to parse task completion response:', error);
        // Fallback to basic message - no hardcoded actions
        return {
            message: exitCode === 0
                ? `✅ Task "${taskName}" completed.`
                : `❌ Task "${taskName}" failed with exit code ${exitCode}.`,
            needsContinuation: exitCode !== 0,
            suggestedAction: exitCode !== 0 ? 'Review the error and fix the issue' : undefined,
            summary: `Task ${exitCode === 0 ? 'completed' : 'failed'}`,
            artifacts: []
        };
    }
}

export interface LogAnalysis {
    hasIssue: boolean;
    issueType?: 'error' | 'stuck' | 'permission' | 'dependency' | 'other';
    issueDescription?: string;
    suggestedIntervention?: string;
}

/**
 * Analyze running task logs to detect issues in real-time
 * This is called periodically or when error patterns are detected
 */
export async function analyzeLogsForIssues(
    taskName: string,
    taskDescription: string,
    recentOutput: string[]
): Promise<LogAnalysis> {
    // Quick pattern check to avoid unnecessary LLM calls
    const output = recentOutput.join('\n');
    const lowerOutput = output.toLowerCase();

    // Skip if no obvious issue patterns
    const hasErrorIndicator =
        lowerOutput.includes('error') ||
        lowerOutput.includes('failed') ||
        lowerOutput.includes('exception') ||
        lowerOutput.includes('permission denied') ||
        lowerOutput.includes('not found') ||
        lowerOutput.includes('cannot') ||
        lowerOutput.includes('stuck') ||
        lowerOutput.includes('timeout');

    if (!hasErrorIndicator) {
        return { hasIssue: false };
    }

    const systemPrompt = `You are an AI assistant analyzing logs from a running task.
Your job is to detect issues that need intervention and suggest what instruction to send.

Analyze the output and determine:
            1. Is there a real issue that needs intervention ? (Not just normal progress / verbose output)
        2. What type of issue is it ?
            3. What instruction should be sent to the instance to fix it ?

                Respond with JSON only:
                {
                    "hasIssue": boolean,
                        "issueType": "error" | "stuck" | "permission" | "dependency" | "other"(if hasIssue),
                            "issueDescription": "brief description"(if hasIssue),
                                "suggestedIntervention": "the exact instruction to send to the instance"(if hasIssue)
}

Examples of good interventions:
        - "Try a different approach - use XYZ instead"
            - "The error is caused by ABC, fix it by doing DEF"
            - "Skip this step and move on to the next part of the task"
            - "Install the missing dependency first: npm install xyz"

        IMPORTANT: Only set hasIssue to true for REAL problems that block progress, not just warnings or verbose output.`;

    const userMessage = `Task: "${taskName}"
        Description: ${taskDescription}

Recent output:
${output.substring(output.length - 2000)} `;

    try {
        let response = await generateLLMResponse(systemPrompt, userMessage, { maxTokens: 300, temperature: 0.2 });

        // Strip markdown code blocks if present
        response = response.replace(/^```(?: json) ?\s * /i, '').replace(/\s * ```$/i, '').trim();
        console.log(`[LLM] Log analysis response: ${response.substring(0, 100)}...`);

        const parsed = JSON.parse(response) as LogAnalysis;
        return {
            hasIssue: parsed.hasIssue || false,
            issueType: parsed.issueType,
            issueDescription: parsed.issueDescription,
            suggestedIntervention: parsed.suggestedIntervention
        };
    } catch (error) {
        console.error('[LLM] Failed to analyze logs:', error);
        return { hasIssue: false };
    }
}


