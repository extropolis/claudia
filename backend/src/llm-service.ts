/**
 * LLM Service - resolves the active Anthropic-style endpoint from the
 * proxy plugin / config and exposes a tiny wrapper for plain text completions.
 *
 * The active endpoint depends on `apiMode` from the config store:
 *   • hyperspace-proxy → `${proxyUrl}/anthropic/v1/messages` + Bearer key
 *   • custom-anthropic → api.anthropic.com + x-api-key
 *   • default          → api.anthropic.com + x-api-key (env)
 *
 * `mobile-agent.ts` reuses `resolveLlmEndpoint()` to make tool-use calls
 * against the same upstream so we don't have to keep this URL logic in
 * two places.
 */

import type { ConfigStore } from './config-store.js';

const DEFAULT_LLM_MODEL = 'claude-sonnet-4-5-20250929';

let configStoreRef: ConfigStore | null = null;

/**
 * Initialize the LLM service with a config store so it can read the configured model
 */
export function initializeLLMService(configStore: ConfigStore): void {
  configStoreRef = configStore;
  console.log('[LLM] Service initialized with config store');
}

/**
 * Get the appropriate model to use based on configuration
 */
function getLLMModel(): string {
  // Check environment variable first
  if (process.env.LLM_MODEL) {
    return process.env.LLM_MODEL;
  }

  return DEFAULT_LLM_MODEL;
}

export interface LlmEndpoint {
  url: string;
  headers: Record<string, string>;
  apiMode: string;
}

/**
 * Resolve the upstream Anthropic-style endpoint based on the current
 * `apiMode`. Mirrors the dispatch in autonomous-controller.ts so all
 * server-side LLM callers use one source of truth.
 */
export function resolveLlmEndpoint(): LlmEndpoint {
  const apiMode = configStoreRef?.getApiMode?.() ?? 'default';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };

  if (apiMode === 'hyperspace-proxy') {
    const proxy = configStoreRef!.getHyperspaceProxy();
    if (!proxy?.proxyUrl) {
      throw new Error('hyperspace-proxy mode but no proxyUrl configured');
    }
    headers['Authorization'] = `Bearer ${proxy.apiKey ?? ''}`;
    return {
      url: `${proxy.proxyUrl}/anthropic/v1/messages`,
      headers,
      apiMode,
    };
  }

  if (apiMode === 'custom-anthropic') {
    const apiKey = configStoreRef?.getCustomAnthropicApiKey?.() ?? '';
    headers['x-api-key'] = apiKey;
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers,
      apiMode,
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  headers['x-api-key'] = apiKey;
  return {
    url: 'https://api.anthropic.com/v1/messages',
    headers,
    apiMode: 'default',
  };
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicResponse {
  content: Array<{
    type: string;
    text?: string;
  }>;
  stop_reason?: string;
}

/**
 * Generate a response using the LLM via the built-in Anthropic proxy
 */
export async function generateLLMResponse(
  systemPrompt: string,
  userMessage: string,
  options: { maxTokens?: number; temperature?: number; timeoutMs?: number } = {},
): Promise<string> {
  const { maxTokens = 200, temperature = 0.7, timeoutMs = 60000 } = options;

  const messages: AnthropicMessage[] = [{ role: 'user', content: userMessage }];

  const modelToUse = getLLMModel();
  const endpoint = resolveLlmEndpoint();

  try {
    console.log(
      `[LLM] Calling ${modelToUse} via ${endpoint.apiMode} → ${endpoint.url}`,
    );

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: endpoint.headers,
      body: JSON.stringify({
        model: modelToUse,
        system: systemPrompt,
        messages,
        max_tokens: maxTokens,
        // Note: temperature is not always supported - omit if causing issues
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[LLM] API error: ${response.status} - ${errorText}`);
      throw new Error(`LLM API error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as AnthropicResponse;
    const textContent = data.content?.find((c) => c.type === 'text');
    const content = textContent?.text;

    if (!content) {
      console.error('[LLM] No text content in response:', JSON.stringify(data));
      throw new Error('No text content in LLM response');
    }

    console.log(`[LLM] Response generated successfully: "${content.substring(0, 50)}..."`);
    return content.trim();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.error(`[LLM] Request timed out after ${timeoutMs / 1000} seconds`);
    } else {
      console.error('[LLM] Error generating response:', error);
    }
    throw error;
  }
}

/**
 * Generate a natural plan response for a user's task request
 */
export async function generatePlanResponse(userRequest: string): Promise<string> {
  const systemPrompt = `You are an AI orchestrator that manages coding tasks by spawning worker agents.
When a user requests something, respond with a brief, natural message explaining what you'll do.
Keep responses concise (1-2 sentences max). Be friendly and action-oriented.
Don't say "I'll spawn a worker" - instead describe what you're going to do for them.
Examples:
- "I'll build a todo app with React for you - complete with a modern UI and local storage!"
- "Let me set up that authentication system. I'll handle the login flow and session management."
- "I'll debug that issue and trace through the code to find the root cause."`;

  return generateLLMResponse(systemPrompt, userRequest, { maxTokens: 100 });
}

/**
 * Generate a natural response for non-task interactions
 */
export async function generateConversationalResponse(
  userMessage: string,
  intent: 'question' | 'conversation' | 'clarification',
): Promise<string> {
  const systemPrompt = `You are an AI orchestrator that manages coding tasks.
You're having a conversation with a user. Their intent is: ${intent}

For questions: Be helpful but brief. If they're asking about coding, offer to spawn a task to investigate.
For conversation: Be friendly and natural. Acknowledge greetings warmly.
For clarification: Thank them and ask what specific action they'd like you to take.

Keep responses concise (1-2 sentences max). Be personable and helpful.`;

  return generateLLMResponse(systemPrompt, userMessage, { maxTokens: 100 });
}

/**
 * Generate a task creation confirmation message
 */
export async function generateTaskCreatedResponse(
  taskName: string,
  taskDescription: string,
): Promise<string> {
  const systemPrompt = `You are an AI orchestrator. A task has just been created and a worker is now running.
Give a brief, friendly confirmation message (1 sentence max).
Mention that they can click on the task to see progress.
Don't be overly formal - be natural and helpful.`;

  const message = `Task: "${taskName}"\nDescription: ${taskDescription}`;

  return generateLLMResponse(systemPrompt, message, { maxTokens: 50 });
}
