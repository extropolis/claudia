import { Router, Request, Response } from 'express';
import { Readable } from 'stream';
import { AccessTokenProvider, AICorConfig } from './access-token-provider.js';
import { DeploymentCatalog } from './deployment-catalog.js';
import { RequestTransformer } from './request-transformer.js';
import { StreamTransformer } from './stream-transformer.js';

export interface AnthropicProxyConfig {
    clientId: string;
    clientSecret: string;
    authUrl: string;
    baseUrl: string;
    resourceGroup?: string;
    requestTimeoutMs?: number;
}

/**
 * Creates an Express router that proxies Anthropic Messages API requests
 * to SAP AI Core (AWS Bedrock Claude models).
 */
export function createAnthropicProxy(config: AnthropicProxyConfig): Router {
    const router = Router();

    const aiCoreConfig: AICorConfig = {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        authUrl: config.authUrl,
        baseUrl: config.baseUrl,
        resourceGroup: config.resourceGroup || 'default',
        requestTimeoutMs: config.requestTimeoutMs || 120000
    };

    const tokenProvider = new AccessTokenProvider(aiCoreConfig);
    const deploymentCatalog = new DeploymentCatalog(aiCoreConfig, tokenProvider);
    const requestTransformer = new RequestTransformer();

    /**
     * GET /v1/models - List available models
     */
    router.get('/v1/models', async (_req: Request, res: Response) => {
        try {
            const models = await deploymentCatalog.getModels();
            res.json(models);
        } catch (error: any) {
            console.error('[AnthropicProxy] Failed to list models:', error);
            res.status(500).json({ error: { message: error.message } });
        }
    });

    /**
     * POST /v1/messages - Anthropic Messages API
     */
    router.post('/v1/messages', async (req: Request, res: Response) => {
        try {
            const { model, stream = false } = req.body;

            if (!model) {
                return res.status(400).json({
                    error: { type: 'invalid_request_error', message: 'model is required' }
                });
            }

            // Map external model name to internal
            const internalModel = deploymentCatalog.toInternalModelName(model);
            console.log(`[AnthropicProxy] Messages request: ${model} → ${internalModel}, stream=${stream}`);

            // Get OAuth token
            const accessToken = await tokenProvider.getValidToken();

            // Find deployment
            const deployment = await deploymentCatalog.findDeploymentFor(internalModel);
            if (!deployment) {
                return res.status(404).json({
                    error: {
                        type: 'not_found_error',
                        message: `Model ${model} is not available. Internal: ${internalModel}`
                    }
                });
            }

            // Build inference URL
            const endpoint = stream ? 'invoke-with-response-stream' : 'invoke';
            const url = `${aiCoreConfig.baseUrl}/v2/inference/deployments/${deployment.id}/${endpoint}`;

            // Transform request body for Bedrock
            const transformedBody = requestTransformer.transform(req.body);

            // Make request to SAP AI Core
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), aiCoreConfig.requestTimeoutMs);

            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        'AI-Resource-Group': aiCoreConfig.resourceGroup
                    },
                    body: JSON.stringify(transformedBody),
                    signal: controller.signal
                });

                // Copy response headers (except transfer-encoding)
                for (const [key, value] of response.headers.entries()) {
                    if (key.toLowerCase() !== 'transfer-encoding') {
                        res.setHeader(key, value);
                    }
                }
                res.status(response.status);

                if (!response.ok) {
                    // For errors, just pass through
                    const errorText = await response.text();
                    return res.send(errorText);
                }

                if (stream) {
                    // Stream response with transformation
                    res.setHeader('Content-Type', 'text/event-stream');
                    res.setHeader('Cache-Control', 'no-cache');
                    res.setHeader('Connection', 'keep-alive');

                    const streamTransformer = new StreamTransformer();
                    const sourceStream = Readable.fromWeb(response.body as any);

                    // Error handling
                    sourceStream.on('error', (error) => {
                        console.error('[AnthropicProxy] Source stream error:', error);
                        if (!res.headersSent) {
                            res.status(500).json({ error: 'Stream error occurred' });
                        }
                    });

                    streamTransformer.on('error', (error) => {
                        console.error('[AnthropicProxy] Stream transformer error:', error);
                        if (!res.headersSent) {
                            res.status(500).json({ error: 'Stream transformation error' });
                        }
                    });

                    res.on('close', () => {
                        console.log('[AnthropicProxy] Client disconnected, cleaning up streams');
                        sourceStream.destroy();
                        streamTransformer.destroy();
                    });

                    sourceStream.pipe(streamTransformer).pipe(res);
                } else {
                    // Non-stream response
                    const data = await response.text();
                    try {
                        const json = JSON.parse(data);
                        res.json(json);
                    } catch {
                        res.send(data);
                    }
                }
            } finally {
                clearTimeout(timeoutId);
            }
        } catch (error: any) {
            console.error('[AnthropicProxy] Request failed:', error);

            if (error.name === 'AbortError') {
                return res.status(504).json({
                    error: { type: 'timeout_error', message: 'Request timed out' }
                });
            }

            res.status(500).json({
                error: { type: 'api_error', message: error.message }
            });
        }
    });

    /**
     * POST /v1/complete - Legacy completions API (redirect to messages)
     */
    router.post('/v1/complete', async (req: Request, res: Response) => {
        // Claude Code shouldn't use this, but just in case
        res.status(400).json({
            error: {
                type: 'invalid_request_error',
                message: 'Legacy completions API is not supported. Use /v1/messages instead.'
            }
        });
    });

    /**
     * Health check
     */
    router.get('/health', (_req: Request, res: Response) => {
        res.json({ status: 'ok', proxy: 'anthropic' });
    });

    return router;
}

export { AccessTokenProvider } from './access-token-provider.js';
export type { AICorConfig } from './access-token-provider.js';
export { DeploymentCatalog } from './deployment-catalog.js';
export { RequestTransformer } from './request-transformer.js';
export { StreamTransformer } from './stream-transformer.js';
