import { Router, Request, Response } from 'express';
import { Readable } from 'stream';
import { AccessTokenProvider, AICorConfig } from './access-token-provider.js';
import { DeploymentCatalog } from './deployment-catalog.js';
import { RequestTransformer } from './request-transformer.js';
import { StreamTransformer } from './stream-transformer.js';
import { UsageInterceptor } from './usage-interceptor.js';
import { reportUsage } from '../../../src/usage-reporter.js';

export interface AnthropicProxyConfig {
    clientId: string;
    clientSecret: string;
    authUrl: string;
    baseUrl: string;
    resourceGroup?: string;
    requestTimeoutMs?: number;
}

export interface AnthropicProxyInstance {
    router: Router;
    tokenProvider: AccessTokenProvider;
    deploymentCatalog: DeploymentCatalog;
    updateConfig: (config: AnthropicProxyConfig) => void;
}

/**
 * Creates an Express router that proxies Anthropic Messages API requests
 * to SAP AI Core (AWS Bedrock Claude models).
 * Returns both the router and the tokenProvider for cache management.
 */
export function createAnthropicProxy(config: AnthropicProxyConfig): AnthropicProxyInstance {
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
     * GET /v1/deployments - Debug endpoint to see raw deployments
     */
    router.get('/v1/deployments', async (_req: Request, res: Response) => {
        try {
            const deployments = await deploymentCatalog.getAvailableDeployments();
            res.json(deployments);
        } catch (error: any) {
            console.error('[AnthropicProxy] Failed to list deployments:', error);
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

            // Log SAP AI Core request details
            console.log(`[AnthropicProxy] 🔵 SAP AI CORE REQUEST`);
            console.log(`[AnthropicProxy]   Model: ${model} → ${internalModel}`);
            console.log(`[AnthropicProxy]   Deployment ID: ${deployment.id}`);
            console.log(`[AnthropicProxy]   URL: ${url}`);
            console.log(`[AnthropicProxy]   Resource Group: ${aiCoreConfig.resourceGroup}`);
            console.log(`[AnthropicProxy]   Stream: ${stream}`);

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

                clearTimeout(timeoutId);

                // Only log non-200 responses or non-streaming requests to reduce noise
                if (!response.ok || !stream) {
                    console.log(`[AnthropicProxy] ${response.ok ? '✅' : '❌'} SAP AI CORE RESPONSE: ${response.status} ${response.statusText}`);
                }

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
                    const usageInterceptor = new UsageInterceptor(model);
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

                    usageInterceptor.on('error', (error) => {
                        console.error('[AnthropicProxy] Usage interceptor error:', error);
                    });

                    res.on('close', () => {
                        // Silently clean up streams on client disconnect (normal behavior)
                        sourceStream.destroy();
                        streamTransformer.destroy();
                        usageInterceptor.destroy();
                    });

                    // Pipeline: source → SSE transformer → usage capture → response
                    sourceStream.pipe(streamTransformer).pipe(usageInterceptor).pipe(res);
                } else {
                    // Non-stream response
                    const data = await response.text();
                    try {
                        const json = JSON.parse(data);
                        // Report token usage for non-streaming responses
                        if (json.usage) {
                            reportUsage({
                                tokensInput: json.usage.input_tokens || 0,
                                tokensOutput: json.usage.output_tokens || 0,
                                model,
                            }).catch(() => {}); // fire-and-forget
                        }
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
     * POST /v1/embeddings - OpenAI-compatible embeddings API
     * Routes to SAP AI Core text embedding models (Azure, GCP Gemini, etc.)
     */
    router.post('/v1/embeddings', async (req: Request, res: Response) => {
        try {
            const { model, input } = req.body;

            if (!input) {
                return res.status(400).json({
                    error: { type: 'invalid_request_error', message: 'input is required' }
                });
            }

            // Get OAuth token
            const accessToken = await tokenProvider.getValidToken();

            // Default to gemini-embedding if no model specified
            const embeddingModel = model || 'gemini-embedding';

            // Try multiple model name formats to find deployment
            const modelsToTry = [
                embeddingModel,                          // As provided (e.g., "gemini-embedding")
                `gcp--${embeddingModel}`,                // GCP prefix for Gemini
                `azure--${embeddingModel}`,              // Azure prefix
                `openai--${embeddingModel}`,             // OpenAI prefix
            ];

            console.log(`[AnthropicProxy] Looking for embedding deployment. Model: ${embeddingModel}, trying: ${modelsToTry.join(', ')}`);

            let foundDeployment = null;
            let foundModelName = '';
            for (const modelName of modelsToTry) {
                foundDeployment = await deploymentCatalog.findDeploymentFor(modelName);
                if (foundDeployment) {
                    foundModelName = modelName;
                    console.log(`[AnthropicProxy] Found embedding deployment: ${modelName} (id: ${foundDeployment.id})`);
                    break;
                }
            }

            if (!foundDeployment) {
                return res.status(404).json({
                    error: {
                        type: 'not_found_error',
                        message: `Embedding model not available. Tried: ${modelsToTry.join(', ')}`
                    }
                });
            }

            // Determine endpoint and request format based on model type
            const isGemini = foundModelName.includes('gemini');

            let url: string;
            let requestBody: any;

            if (isGemini) {
                // Gemini embedding - try /text/embeddings path
                url = `${aiCoreConfig.baseUrl}/v2/inference/deployments/${foundDeployment.id}/text/embeddings`;

                // Use OpenAI-compatible format
                requestBody = { input };
                console.log(`[AnthropicProxy] Using Gemini embedding with /text/embeddings path`);
            } else {
                // OpenAI/Azure format
                url = `${aiCoreConfig.baseUrl}/v2/inference/deployments/${foundDeployment.id}/embeddings`;
                requestBody = { input };
                console.log(`[AnthropicProxy] Using OpenAI embedding format`);
            }

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), aiCoreConfig.requestTimeoutMs);

            try {
                console.log(`[AnthropicProxy] Sending embedding request to: ${url}`);
                console.log(`[AnthropicProxy] Request body: ${JSON.stringify(requestBody)}`);
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        'AI-Resource-Group': aiCoreConfig.resourceGroup
                    },
                    body: JSON.stringify(requestBody),
                    signal: controller.signal
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    console.error(`[AnthropicProxy] Embedding error: ${response.status} - ${errorText}`);
                    return res.status(response.status).send(errorText);
                }

                const data = await response.json();
                console.log(`[AnthropicProxy] Raw response keys: ${Object.keys(data).join(', ')}`);

                // Transform Gemini response to OpenAI format
                if (isGemini) {
                    // Gemini returns { embedding: { values: [...] } }
                    const embeddingValues = data.embedding?.values || data.values || [];
                    const transformed = {
                        object: 'list',
                        data: [{
                            object: 'embedding',
                            index: 0,
                            embedding: embeddingValues
                        }],
                        model: embeddingModel,
                        usage: {
                            prompt_tokens: 0,
                            total_tokens: 0
                        }
                    };
                    console.log(`[AnthropicProxy] Transformed Gemini response: ${embeddingValues.length} dimensions`);
                    return res.json(transformed);
                }

                res.json(data);
            } finally {
                clearTimeout(timeoutId);
            }
        } catch (error: any) {
            console.error('[AnthropicProxy] Embedding request failed:', error);

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

    const updateConfig = (newConfig: AnthropicProxyConfig): void => {
        aiCoreConfig.clientId = newConfig.clientId;
        aiCoreConfig.clientSecret = newConfig.clientSecret;
        aiCoreConfig.authUrl = newConfig.authUrl;
        aiCoreConfig.baseUrl = newConfig.baseUrl;
        aiCoreConfig.resourceGroup = newConfig.resourceGroup || 'default';
        aiCoreConfig.requestTimeoutMs = newConfig.requestTimeoutMs || 120000;
        tokenProvider.updateConfig(aiCoreConfig);
        deploymentCatalog.updateConfig(aiCoreConfig);
        console.log('[AnthropicProxy] Config updated, baseUrl:', aiCoreConfig.baseUrl);
    };

    return { router, tokenProvider, deploymentCatalog, updateConfig };
}

export { AccessTokenProvider } from './access-token-provider.js';
export type { AICorConfig } from './access-token-provider.js';
export { DeploymentCatalog } from './deployment-catalog.js';
export { RequestTransformer } from './request-transformer.js';
export { StreamTransformer } from './stream-transformer.js';
