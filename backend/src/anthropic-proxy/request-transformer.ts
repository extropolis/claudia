/**
 * RequestTransformer for Bedrock Claude models.
 * Transforms Anthropic API requests to AWS Bedrock format.
 */
export class RequestTransformer {
    transform(input: any): any {
        // Remove model and stream from the body (they're handled separately)
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { model, stream, reasoning_effort, ...rest } = input;

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
        return {
            anthropic_version: 'bedrock-2023-05-31',
            ...clamped
        };
    }

    private convertReasoningEffort(effort: string, maxTokens: number): { type: string; budget_tokens: number } {
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

    private clampThinking(data: any): any {
        const { max_tokens, thinking } = data;
        if (!thinking || typeof thinking !== 'object' || thinking.budget_tokens == null) return data;
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
