import { AccessTokenProvider, AICorConfig } from './access-token-provider.js';

const DEPLOYMENT_STATUS_RUNNING = 'RUNNING';

interface Deployment {
    id: string;
    status: string;
    createdAt?: string;
    details?: {
        resources?: {
            backendDetails?: {
                model?: {
                    name?: string;
                };
            };
        };
    };
}

interface ModelInfo {
    id: string;
    object: string;
    created: number;
    owned_by: string;
}

/**
 * Model name mappings between external (Anthropic API) and internal (SAP AI Core) names.
 */
const MODEL_MAPPINGS: Record<string, string> = {
    // External → Internal
    'claude-3-5-sonnet-20241022': 'anthropic--claude-3.5-sonnet',
    'claude-3-5-sonnet-latest': 'anthropic--claude-3.5-sonnet',
    'claude-sonnet-4-20250514': 'anthropic--claude-sonnet-4',
    'claude-sonnet-4-5-20250929': 'anthropic--claude-4.5-sonnet',
    'claude-3-7-sonnet-20250219': 'anthropic--claude-3.7-sonnet',
    'claude-3-5-haiku-20241022': 'anthropic--claude-3.5-haiku',
    'claude-3-opus-20240229': 'anthropic--claude-3-opus',
    'claude-opus-4-20250514': 'anthropic--claude-opus-4',
    'claude-4-5-opus': 'anthropic--claude-4.5-opus',
};

// Build reverse mapping
const INTERNAL_TO_EXTERNAL: Record<string, string> = {};
for (const [external, internal] of Object.entries(MODEL_MAPPINGS)) {
    // Keep first mapping for each internal name
    if (!INTERNAL_TO_EXTERNAL[internal]) {
        INTERNAL_TO_EXTERNAL[internal] = external;
    }
}

/**
 * DeploymentCatalog manages and caches model deployments from SAP AI Core.
 */
export class DeploymentCatalog {
    private cachedDeployments: Deployment[] = [];
    private config: AICorConfig;
    private tokenProvider: AccessTokenProvider;

    constructor(config: AICorConfig, tokenProvider: AccessTokenProvider) {
        this.config = config;
        this.tokenProvider = tokenProvider;
    }

    /**
     * Convert external model name (Anthropic API) to internal (SAP AI Core).
     */
    toInternalModelName(modelName: string): string {
        return MODEL_MAPPINGS[modelName] || modelName;
    }

    /**
     * Convert internal model name (SAP AI Core) to external (Anthropic API).
     */
    toExternalModelName(modelName: string): string {
        return INTERNAL_TO_EXTERNAL[modelName] || modelName;
    }

    /**
     * Get list of available models in OpenAI-compatible format.
     */
    async getModels(): Promise<{ object: string; data: ModelInfo[] }> {
        const deployments = await this.getAvailableDeployments();
        const listAllModels = process.env.LIST_ALL_MODELS === 'true';

        const models = deployments.map(d => this.createModelFromDeployment(d));
        const processedModels = listAllModels ? models : this.keepLatestPerModel(models);

        return {
            object: 'list',
            data: processedModels.sort((a, b) => a.id.localeCompare(b.id))
        };
    }

    /**
     * Find deployment for a given model name.
     */
    async findDeploymentFor(modelName: string): Promise<Deployment | undefined> {
        const deployments = await this.getAvailableDeployments();
        return deployments.find(d => this.extractModelName(d) === modelName);
    }

    /**
     * Get all available (RUNNING) deployments.
     */
    async getAvailableDeployments(): Promise<Deployment[]> {
        if (this.cachedDeployments.length > 0) {
            return this.cachedDeployments;
        }
        return await this.fetchAndCacheDeployments();
    }

    /**
     * Clear the deployment cache (useful for refreshing).
     */
    clearCache(): void {
        this.cachedDeployments = [];
    }

    private createModelFromDeployment(deployment: Deployment): ModelInfo {
        const modelName = this.extractModelName(deployment);
        const externalModelName = this.toExternalModelName(modelName);
        const createdTimestamp = this.parseCreatedAt(deployment.createdAt);

        return {
            id: externalModelName,
            object: 'model',
            created: createdTimestamp,
            owned_by: 'ai-core'
        };
    }

    private keepLatestPerModel(models: ModelInfo[]): ModelInfo[] {
        const modelMap = new Map<string, ModelInfo>();

        for (const model of models) {
            if (!modelMap.has(model.id) || modelMap.get(model.id)!.created < model.created) {
                modelMap.set(model.id, model);
            }
        }

        return Array.from(modelMap.values());
    }

    private parseCreatedAt(createdAtString?: string): number {
        const defaultTimestamp = Math.floor(Date.now() / 1000);

        if (!createdAtString) {
            return defaultTimestamp;
        }

        try {
            const timestamp = Math.floor(new Date(createdAtString).getTime() / 1000);
            if (isNaN(timestamp)) {
                console.warn(`[DeploymentCatalog] Invalid createdAt format: ${createdAtString}`);
                return defaultTimestamp;
            }
            return timestamp;
        } catch (error) {
            console.warn(`[DeploymentCatalog] Invalid createdAt format: ${createdAtString}`, error);
            return defaultTimestamp;
        }
    }

    private async fetchAndCacheDeployments(): Promise<Deployment[]> {
        const accessToken = await this.tokenProvider.getValidToken();
        const url = `${this.config.baseUrl}/v2/lm/deployments`;
        const headers = {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'AI-Resource-Group': this.config.resourceGroup
        };

        const controller = new AbortController();
        const timeoutMs = this.config.requestTimeoutMs;
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            console.log('[DeploymentCatalog] Fetching deployments from AI Core');
            const response = await fetch(url, {
                method: 'GET',
                headers,
                signal: controller.signal
            });

            const data = await response.json() as { resources: Deployment[] };
            this.cachedDeployments = this.filterRunningDeployments(data.resources || []);
            console.log(`[DeploymentCatalog] Found ${this.cachedDeployments.length} running deployments`);
            return this.cachedDeployments;
        } catch (error: any) {
            if (error.name === 'AbortError') {
                throw new Error(`Failed to get deployments: Request timed out after ${timeoutMs}ms`);
            }
            throw new Error(`Failed to get deployments: ${error.message}`);
        } finally {
            clearTimeout(timeoutId);
        }
    }

    private filterRunningDeployments(resources: Deployment[]): Deployment[] {
        return resources.filter(d =>
            d.status === DEPLOYMENT_STATUS_RUNNING &&
            this.hasValidModelName(d)
        );
    }

    private hasValidModelName(deployment: Deployment): boolean {
        return !!deployment?.details?.resources?.backendDetails?.model?.name;
    }

    private extractModelName(deployment: Deployment): string {
        return deployment.details!.resources!.backendDetails!.model!.name!;
    }
}
