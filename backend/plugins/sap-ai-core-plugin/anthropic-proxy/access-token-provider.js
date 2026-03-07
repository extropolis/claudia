/**
 * AccessTokenProvider handles OAuth token acquisition and caching for SAP AI Core API access.
 */
const TOKEN_BUFFER_SECONDS = 60;
export class AccessTokenProvider {
    tokenCache = { token: null, expiresAt: 0 };
    config;
    constructor(config) {
        this.config = config;
    }
    async getValidToken(now = Date.now) {
        const currentTime = now();
        if (this.hasValidCachedToken(currentTime)) {
            return this.tokenCache.token;
        }
        return await this.obtainFreshToken(currentTime);
    }
    hasValidCachedToken(currentTime) {
        return !!this.tokenCache.token && currentTime < this.tokenCache.expiresAt;
    }
    async obtainFreshToken(currentTime) {
        const credentials = this.encodeClientCredentials();
        const tokenUrl = this.buildTokenEndpoint();
        try {
            const response = await this.requestToken(tokenUrl, credentials);
            // Check if response is OK before parsing
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Auth server returned ${response.status}: ${errorText}`);
            }
            const responseText = await response.text();
            let tokenData;
            try {
                tokenData = JSON.parse(responseText);
            }
            catch (parseError) {
                const message = parseError instanceof Error ? parseError.message : String(parseError);
                throw new Error(`Failed to parse token response as JSON: ${message}. Response: ${responseText}`);
            }
            this.validateTokenData(tokenData);
            this.cacheToken(tokenData, currentTime);
            return this.tokenCache.token;
        }
        catch (error) {
            this.clearCache();
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Token acquisition failed: ${message}`);
        }
    }
    encodeClientCredentials() {
        const { clientId, clientSecret } = this.config;
        return Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    }
    buildTokenEndpoint() {
        return `${this.config.authUrl}/oauth/token?grant_type=client_credentials`;
    }
    async requestToken(url, credentials) {
        const controller = new AbortController();
        const timeoutMs = this.config.requestTimeoutMs;
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            console.log('[AnthropicProxy] Fetching access token from AI Core');
            console.log('[AnthropicProxy] Auth URL:', url);
            return await fetch(url, {
                method: 'POST',
                headers: {
                    Authorization: `Basic ${credentials}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                signal: controller.signal
            });
        }
        catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error(`Token request timed out after ${timeoutMs}ms`);
            }
            // Log detailed error information
            if (error instanceof Error) {
                console.error('[AnthropicProxy] Fetch error details:', {
                    name: error.name,
                    message: error.message,
                    cause: error.cause,
                    code: error.code
                });
            }
            throw error;
        }
        finally {
            clearTimeout(timeoutId);
        }
    }
    validateTokenData(data) {
        if (typeof data !== 'object' || data === null) {
            throw new Error('Invalid token response: not an object');
        }
        const tokenData = data;
        if (typeof tokenData.access_token !== 'string' || typeof tokenData.expires_in !== 'number') {
            throw new Error('Invalid token response structure from auth server.');
        }
    }
    cacheToken(tokenData, currentTime) {
        this.tokenCache.token = tokenData.access_token;
        this.tokenCache.expiresAt = currentTime + (tokenData.expires_in - TOKEN_BUFFER_SECONDS) * 1000;
        console.log('[AnthropicProxy] Token cached, expires in', tokenData.expires_in - TOKEN_BUFFER_SECONDS, 'seconds');
    }
    clearCache() {
        this.tokenCache.token = null;
        this.tokenCache.expiresAt = 0;
    }
    /**
     * Public method to clear the token cache (e.g., when credentials change)
     */
    clearTokenCache() {
        console.log('[AnthropicProxy] Clearing token cache');
        this.clearCache();
    }
    /**
     * Update the config (e.g., when credentials change in settings).
     * This also clears the token cache so the next request uses the new credentials.
     */
    updateConfig(config) {
        console.log('[AnthropicProxy] Updating AccessTokenProvider config and clearing cache');
        // Mutate in place so any closures that captured this.config also see the update
        Object.assign(this.config, config);
        this.clearCache();
    }
    /**
     * Validate credentials by attempting to get a token
     * Returns true if credentials are valid, false otherwise
     */
    async validateCredentials() {
        try {
            console.log('[AnthropicProxy] Validating SAP AI Core credentials...');
            await this.obtainFreshToken(Date.now());
            console.log('[AnthropicProxy] Credentials are valid');
            return { valid: true };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('[AnthropicProxy] Credential validation failed:', message);
            return { valid: false, error: message };
        }
    }
}
