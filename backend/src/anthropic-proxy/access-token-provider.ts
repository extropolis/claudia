/**
 * AccessTokenProvider handles OAuth token acquisition and caching for SAP AI Core API access.
 */

const TOKEN_BUFFER_SECONDS = 60;

export interface AICorConfig {
    clientId: string;
    clientSecret: string;
    authUrl: string;
    baseUrl: string;
    resourceGroup: string;
    requestTimeoutMs: number;
}

interface TokenCache {
    token: string | null;
    expiresAt: number;
}

export class AccessTokenProvider {
    private tokenCache: TokenCache = { token: null, expiresAt: 0 };
    private config: AICorConfig;

    constructor(config: AICorConfig) {
        this.config = config;
    }

    async getValidToken(now: () => number = Date.now): Promise<string> {
        const currentTime = now();
        if (this.hasValidCachedToken(currentTime)) {
            return this.tokenCache.token!;
        }
        return await this.obtainFreshToken(currentTime);
    }

    private hasValidCachedToken(currentTime: number): boolean {
        return !!this.tokenCache.token && currentTime < this.tokenCache.expiresAt;
    }

    private async obtainFreshToken(currentTime: number): Promise<string> {
        const credentials = this.encodeClientCredentials();
        const tokenUrl = this.buildTokenEndpoint();

        try {
            const response = await this.requestToken(tokenUrl, credentials);
            const responseText = await response.text();

            let tokenData;
            try {
                tokenData = JSON.parse(responseText);
            } catch (parseError: any) {
                throw new Error(`Failed to parse token response as JSON: ${parseError.message}. Response: ${responseText}`);
            }

            this.validateTokenData(tokenData);
            this.cacheToken(tokenData, currentTime);

            return this.tokenCache.token!;
        } catch (error: any) {
            this.clearCache();
            throw new Error(`Token acquisition failed: ${error.message}`);
        }
    }

    private encodeClientCredentials(): string {
        const { clientId, clientSecret } = this.config;
        return Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    }

    private buildTokenEndpoint(): string {
        return `${this.config.authUrl}/oauth/token?grant_type=client_credentials`;
    }

    private async requestToken(url: string, credentials: string): Promise<Response> {
        const controller = new AbortController();
        const timeoutMs = this.config.requestTimeoutMs;
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            console.log('[AnthropicProxy] Fetching access token from AI Core');
            return await fetch(url, {
                method: 'POST',
                headers: {
                    Authorization: `Basic ${credentials}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                signal: controller.signal
            });
        } catch (error: any) {
            if (error.name === 'AbortError') {
                throw new Error(`Token request timed out after ${timeoutMs}ms`);
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    private validateTokenData(data: any): void {
        if (!data.access_token || !data.expires_in) {
            throw new Error('Invalid token response structure from auth server.');
        }
    }

    private cacheToken(tokenData: any, currentTime: number): void {
        this.tokenCache.token = tokenData.access_token;
        this.tokenCache.expiresAt = currentTime + (tokenData.expires_in - TOKEN_BUFFER_SECONDS) * 1000;
        console.log('[AnthropicProxy] Token cached, expires in', tokenData.expires_in - TOKEN_BUFFER_SECONDS, 'seconds');
    }

    private clearCache(): void {
        this.tokenCache.token = null;
        this.tokenCache.expiresAt = 0;
    }
}
