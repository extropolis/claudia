/**
 * RequestTransformer for Bedrock Claude models.
 * Transforms Anthropic API requests to AWS Bedrock format.
 */

// Anthropic API request types
interface ThinkingConfig {
    type: string;
    budget_tokens: number;
}

interface CacheControl {
    type: string;
    scope?: string;
}

interface Tool {
    cache_control?: CacheControl;
    [key: string]: unknown;
}

interface AnthropicRequest {
    model?: string;
    stream?: boolean;
    reasoning_effort?: string;
    max_tokens?: number;
    thinking?: ThinkingConfig;
    tools?: Tool[];
    [key: string]: unknown;
}

interface BedrockRequest {
    anthropic_version: string;
    max_tokens?: number;
    thinking?: ThinkingConfig;
    [key: string]: unknown;
}

export class RequestTransformer {
    transform(input: AnthropicRequest): BedrockRequest {
        // Remove model and stream from the body (they're handled separately)
        // Also remove context_management and other unsupported parameters
        const {
            model: _model,
            stream: _stream,
            reasoning_effort,
            context_management: _contextManagement,
            ...rest
        } = input;

        // Convert reasoning_effort to thinking if present
        let transformed = rest;
        if (reasoning_effort && !rest.thinking) {
            const max_tokens = rest.max_tokens || 4096;
            transformed = {
                ...rest,
                thinking: this.convertReasoningEffort(reasoning_effort, max_tokens)
            };
        }

        const clamped = this.clampThinking(transformed);
        const sanitized = this.sanitizeCacheControl(clamped);
        return {
            anthropic_version: 'bedrock-2023-05-31',
            ...sanitized
        };
    }

    /**
     * Strip the 'scope' field from cache_control on tools and system messages.
     * Claude Code sends cache_control: { type: "ephemeral", scope: "turn" } on MCP tools and system messages,
     * but the Anthropic API schema only accepts cache_control: { type: "ephemeral" }.
     */
    private sanitizeCacheControl(data: Record<string, unknown>): Record<string, unknown> {
        let result = { ...data };

        // Sanitize tools
        if (data.tools && Array.isArray(data.tools)) {
            let strippedCount = 0;
            const sanitizedTools = data.tools.map((tool: Tool) => {
                if (tool.cache_control?.scope) {
                    strippedCount++;
                    const { scope, ...restCacheControl } = tool.cache_control;
                    return {
                        ...tool,
                        cache_control: restCacheControl
                    };
                }
                return tool;
            });

            if (strippedCount > 0) {
                console.log(`[RequestTransformer] Stripped 'scope' from cache_control on ${strippedCount} tools`);
            }
            result.tools = sanitizedTools;
        }

        // Sanitize system messages (can be array of content blocks)
        if (data.system && Array.isArray(data.system)) {
            let strippedCount = 0;
            const sanitizedSystem = data.system.map((block: { cache_control?: CacheControl; [key: string]: unknown }) => {
                if (block.cache_control?.scope) {
                    strippedCount++;
                    const { scope, ...restCacheControl } = block.cache_control;
                    return {
                        ...block,
                        cache_control: restCacheControl
                    };
                }
                return block;
            });

            if (strippedCount > 0) {
                console.log(`[RequestTransformer] Stripped 'scope' from cache_control on ${strippedCount} system blocks`);
            }
            result.system = sanitizedSystem;
        }

        return result;
    }

    private convertReasoningEffort(effort: string, maxTokens: number): ThinkingConfig {
        const budgetMap: Record<string, number> = {
            'low': Math.max(1024, Math.floor(maxTokens * 0.2)),
            'medium': Math.max(1024, Math.floor(maxTokens * 0.5)),
            'high': Math.max(1024, Math.floor(maxTokens * 0.8))
        };

        const budget = budgetMap[effort] || budgetMap['medium'];
        return {
            type: 'enabled',
            budget_tokens: Math.min(budget, maxTokens - 1)
        };
    }

    private clampThinking(data: Omit<AnthropicRequest, 'model' | 'stream' | 'reasoning_effort'>): Omit<AnthropicRequest, 'model' | 'stream' | 'reasoning_effort'> {
        const max_tokens = data.max_tokens;
        const thinking = data.thinking as ThinkingConfig | undefined;

        if (!thinking || thinking.budget_tokens == null) return data;
        if (!max_tokens || typeof max_tokens !== 'number') return data;

        const budget = thinking.budget_tokens;
        const MIN_THINKING_BUDGET = 1024; // SAP AI Core minimum

        // If budget is less than minimum, enforce minimum
        if (budget < MIN_THINKING_BUDGET) {
            return {
                ...data,
                thinking: {
                    ...thinking,
                    budget_tokens: MIN_THINKING_BUDGET
                }
            };
        }

        // If budget >= max_tokens, reduce it to max_tokens - 1 (minimum 1024)
        if (budget >= max_tokens) {
            const newBudget = Math.max(MIN_THINKING_BUDGET, max_tokens - 1);
            return {
                ...data,
                thinking: {
                    ...thinking,
                    budget_tokens: newBudget
                }
            };
        }

        return data;
    }
}
