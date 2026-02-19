import { Router, Request, Response } from 'express';
import { ConfigStore } from '../config-store.js';
import { appendFileSync } from 'fs';

const LOG_FILE = '/tmp/hyperspace-requests.log';

function logToFile(message: string): void {
    const timestamp = new Date().toISOString();
    appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`);
}

export interface HyperspaceProxyInstance {
    router: Router;
}

/**
 * Creates an Express router that proxies Anthropic API requests to the Hyperspace AI Proxy
 * while transforming responses to inject the correct model information.
 */
export function createHyperspaceProxy(configStore: ConfigStore): HyperspaceProxyInstance {
    const router = Router();

    /**
     * POST /v1/messages - Anthropic Messages API
     */
    router.post('/v1/messages', async (req: Request, res: Response) => {
        const requestId = Math.random().toString(36).substr(2, 9);

        // Intercept Claude Code warmup/bookkeeping requests locally.
        // These are tiny requests (max_tokens=1) with content like "quota" or "count"
        // that Claude Code fires on startup (one per task). Forwarding them to
        // Hyperspace wastes quota and triggers rate limits.
        const firstContent = req.body.messages?.[0]?.content;
        if (req.body.max_tokens === 1 && typeof firstContent === 'string' &&
            (firstContent === 'count' || firstContent === 'quota')) {
            logToFile(`[${requestId}] INTERCEPTED warmup request (${firstContent}), returning stub`);
            return res.json({
                id: `msg_stub_${requestId}`,
                type: 'message',
                role: 'assistant',
                model: req.body.model,
                content: [{ type: 'text', text: '' }],
                stop_reason: 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 }
            });
        }

        // Log to file for debugging
        logToFile(`========== NEW REQUEST ${requestId} ==========`);
        logToFile(`Model: ${req.body.model}`);
        logToFile(`Stream: ${req.body.stream}`);
        logToFile(`Messages count: ${req.body.messages?.length || 0}`);
        logToFile(`Max tokens: ${req.body.max_tokens}`);
        logToFile(`First message preview: ${JSON.stringify(req.body.messages?.[0])?.substring(0, 200)}`);

        console.log(`[HyperspaceProxy ${requestId}] Request: model=${req.body.model}, stream=${req.body.stream}, messages=${req.body.messages?.length || 0}`);

        try {
            const hyperspaceConfig = configStore.getHyperspaceProxy();

            if (!hyperspaceConfig || !hyperspaceConfig.apiKey || !hyperspaceConfig.proxyUrl) {
                console.error(`[HyperspaceProxy ${requestId}] Configuration error`);
                return res.status(500).json({
                    error: {
                        type: 'configuration_error',
                        message: 'Hyperspace proxy not configured'
                    }
                });
            }

            // Build the proxy URL
            let proxyUrl = hyperspaceConfig.proxyUrl;
            if (!proxyUrl.endsWith('/')) {
                proxyUrl += '/';
            }
            if (!proxyUrl.endsWith('anthropic/')) {
                proxyUrl += 'anthropic/';
            }
            proxyUrl += 'v1/messages';

            const { stream = false } = req.body;

            // Strip request to only known Anthropic Messages API fields.
            // Claude Code may send extra fields (metadata, etc.) that
            // the Hyperspace proxy rejects with "Extra inputs are not permitted".
            const allowedFields = [
                'model', 'messages', 'max_tokens', 'stream',
                'system', 'temperature', 'top_p', 'top_k',
                'stop_sequences', 'tools', 'tool_choice',
                'thinking', 'betas',
            ];
            const cleanBody: Record<string, unknown> = {};
            for (const key of allowedFields) {
                if (req.body[key] !== undefined) {
                    cleanBody[key] = req.body[key];
                }
            }

            // Forward headers that Anthropic expects
            const forwardHeaders: Record<string, string> = {
                'Content-Type': 'application/json',
                'anthropic-version': req.headers['anthropic-version'] as string || '2023-06-01',
                'x-api-key': hyperspaceConfig.apiKey,
            };
            // Forward anthropic-beta header if present (needed for extended thinking etc.)
            if (req.headers['anthropic-beta']) {
                forwardHeaders['anthropic-beta'] = req.headers['anthropic-beta'] as string;
            }

            console.log(`[HyperspaceProxy ${requestId}] Forwarding request: model=${cleanBody.model}, stream=${stream}, to ${proxyUrl}`);

            // Forward the request to Hyperspace proxy
            const fetchStartTime = Date.now();
            const proxyResponse = await fetch(proxyUrl, {
                method: 'POST',
                headers: forwardHeaders,
                body: JSON.stringify(cleanBody),
            });
            const fetchDuration = Date.now() - fetchStartTime;
            console.log(`[HyperspaceProxy ${requestId}] Hyperspace responded in ${fetchDuration}ms with status ${proxyResponse.status}`);

            if (!proxyResponse.ok) {
                const errorText = await proxyResponse.text();
                console.error(`[HyperspaceProxy ${requestId}] Proxy request failed:`, proxyResponse.status, errorText);
                return res.status(proxyResponse.status).json({
                    error: {
                        type: 'proxy_error',
                        message: `Hyperspace proxy returned ${proxyResponse.status}: ${errorText}`
                    }
                });
            }

            if (stream) {
                console.log(`[HyperspaceProxy ${requestId}] Starting streaming response`);
                // For streaming, we need to transform the response to inject model info
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');

                if (!proxyResponse.body) {
                    throw new Error('No response body from Hyperspace proxy');
                }

                const reader = proxyResponse.body.getReader();
                const decoder = new TextDecoder();

                try {
                    let chunkCount = 0;
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            console.log(`[HyperspaceProxy ${requestId}] Stream complete after ${chunkCount} chunks`);
                            break;
                        }

                        chunkCount++;
                        const chunk = decoder.decode(value, { stream: true });
                        const lines = chunk.split('\n');

                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                const data = line.slice(6);
                                if (data === '[DONE]') {
                                    res.write('data: [DONE]\n\n');
                                    continue;
                                }

                                try {
                                    const event = JSON.parse(data);

                                    // Inject the configured model name into message_start events
                                    if (event.type === 'message_start' && hyperspaceConfig.model) {
                                        event.message.model = hyperspaceConfig.model;
                                    }

                                    res.write(`data: ${JSON.stringify(event)}\n\n`);
                                } catch (e) {
                                    // If not valid JSON, pass through as-is
                                    res.write(line + '\n');
                                }
                            } else if (line.trim()) {
                                res.write(line + '\n');
                            }
                        }
                    }
                    res.end();
                } catch (error) {
                    console.error(`[HyperspaceProxy ${requestId}] Stream processing error:`, error);
                    res.end();
                }
            } else {
                console.log(`[HyperspaceProxy ${requestId}] Processing non-streaming response`);
                // Non-streaming response - inject model info
                const responseData = await proxyResponse.json();

                // Inject the configured model name
                if (hyperspaceConfig.model) {
                    responseData.model = hyperspaceConfig.model;
                }

                console.log(`[HyperspaceProxy ${requestId}] Returning response with model: ${responseData.model}`);
                res.json(responseData);
            }

        } catch (error: any) {
            console.error(`[HyperspaceProxy ${requestId}] Error:`, error);
            res.status(500).json({
                error: {
                    type: 'server_error',
                    message: error.message || 'Internal server error'
                }
            });
        }
    });

    /**
     * GET /v1/models - List available models
     */
    router.get('/v1/models', async (_req: Request, res: Response) => {
        try {
            const hyperspaceConfig = configStore.getHyperspaceProxy();

            if (!hyperspaceConfig || !hyperspaceConfig.apiKey || !hyperspaceConfig.proxyUrl) {
                return res.status(500).json({
                    error: { message: 'Hyperspace proxy not configured' }
                });
            }

            // Build the proxy URL
            let proxyUrl = hyperspaceConfig.proxyUrl;
            if (!proxyUrl.endsWith('/')) {
                proxyUrl += '/';
            }
            if (!proxyUrl.endsWith('anthropic/')) {
                proxyUrl += 'anthropic/';
            }
            proxyUrl += 'v1/models';

            const proxyResponse = await fetch(proxyUrl, {
                method: 'GET',
                headers: {
                    'x-api-key': hyperspaceConfig.apiKey,
                },
            });

            if (!proxyResponse.ok) {
                throw new Error(`Hyperspace proxy returned ${proxyResponse.status}`);
            }

            const data = await proxyResponse.json();
            res.json(data);

        } catch (error: any) {
            console.error('[HyperspaceProxy] Failed to list models:', error);
            res.status(500).json({ error: { message: error.message } });
        }
    });

    return { router };
}
