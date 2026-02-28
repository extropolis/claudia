/**
 * Config Store - Manages application configuration (MCP servers)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { BackendType } from './backends/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface MCPServerConfig {
    name: string;
    type?: 'stdio' | 'http' | 'streamableHttp';  // Default: 'stdio'
    command?: string;  // Required for stdio, not for http/streamableHttp
    args?: string[];
    env?: Record<string, string>;
    url?: string;  // Required for http/streamableHttp
    enabled: boolean;
    timeout?: number;
    autoApprove?: string[];
    description?: string;
    headers?: Record<string, string>;  // For http/streamableHttp
}

export interface AICoreCredentials {
    clientId: string;
    clientSecret: string;
    authUrl: string;
    baseUrl: string;
    resourceGroup: string;
    timeoutMs: number;
}

// Available SAP AI Core models
export type SapAiCoreModel =
    | 'anthropic--claude-4.6-opus'
    | 'anthropic--claude-4.6-sonnet'
    | 'anthropic--claude-4.5-opus'
    | 'anthropic--claude-opus-4'
    | 'anthropic--claude-sonnet-4'
    | 'anthropic--claude-4.5-sonnet'
    | 'anthropic--claude-3.7-sonnet'
    | 'anthropic--claude-3.5-sonnet'
    | 'anthropic--claude-3.5-haiku'
    | 'anthropic--claude-3-opus';

export const SAP_AI_CORE_MODELS: { value: SapAiCoreModel; label: string }[] = [
    { value: 'anthropic--claude-4.6-opus', label: 'Claude 4.6 Opus' },
    { value: 'anthropic--claude-4.6-sonnet', label: 'Claude 4.6 Sonnet' },
    { value: 'anthropic--claude-4.5-opus', label: 'Claude 4.5 Opus' },
    { value: 'anthropic--claude-opus-4', label: 'Claude Opus 4' },
    { value: 'anthropic--claude-sonnet-4', label: 'Claude Sonnet 4' },
    { value: 'anthropic--claude-4.5-sonnet', label: 'Claude 4.5 Sonnet' },
    { value: 'anthropic--claude-3.7-sonnet', label: 'Claude 3.7 Sonnet' },
    { value: 'anthropic--claude-3.5-sonnet', label: 'Claude 3.5 Sonnet' },
    { value: 'anthropic--claude-3.5-haiku', label: 'Claude 3.5 Haiku' },
    { value: 'anthropic--claude-3-opus', label: 'Claude 3 Opus' },
];

// API mode determines how Claude Code connects to Anthropic's API
export type ApiMode = 'default' | 'custom-anthropic' | 'sap-ai-core' | 'hyperspace-proxy';

// Hyperspace AI Proxy configuration
export interface HyperspaceProxyConfig {
    proxyUrl: string;  // Default: http://localhost:6655
    apiKey: string;    // ANTHROPIC_AUTH_TOKEN
    model: string;     // Custom model name (e.g., anthropic--claude-4.5-sonnet)
    alwaysThinkingEnabled: boolean;
}

// Default Hyperspace proxy models
export const HYPERSPACE_PROXY_MODELS: { value: string; label: string }[] = [
    { value: 'anthropic--claude-4.5-opus', label: 'Claude 4.5 Opus' },
    { value: 'anthropic--claude-opus-4', label: 'Claude Opus 4' },
    { value: 'anthropic--claude-sonnet-4', label: 'Claude Sonnet 4' },
    { value: 'anthropic--claude-4.5-sonnet', label: 'Claude 4.5 Sonnet' },
    { value: 'anthropic--claude-3.7-sonnet', label: 'Claude 3.7 Sonnet' },
    { value: 'anthropic--claude-3.5-sonnet', label: 'Claude 3.5 Sonnet' },
    { value: 'anthropic--claude-4.5-haiku', label: 'Claude 4.5 Haiku' },
    { value: 'anthropic--claude-3.5-haiku', label: 'Claude 3.5 Haiku' },
    { value: 'anthropic--claude-3-opus', label: 'Claude 3 Opus' },
];

export interface AppConfig {
    mcpServers: MCPServerConfig[];
    skipPermissions: boolean;
    rules: string;
    supervisorEnabled: boolean;
    supervisorSystemPrompt: string;
    autoFocusOnInput: boolean;  // Auto-switch to task when it needs input
    aiCoreCredentials?: AICoreCredentials;  // SAP AI Core credentials for Anthropic proxy
    sapAiCoreModel: SapAiCoreModel;  // Which model to use with SAP AI Core
    apiMode: ApiMode;  // Which API connection mode to use
    customAnthropicApiKey?: string;  // API key for custom-anthropic mode
    backend: BackendType;  // Which AI backend to use (claude-code or opencode)
    opencodePort?: number;  // Port for OpenCode server (default: 4096)
    useLearnings: boolean;  // Use RAG-based learnings injection for tasks
    hyperspaceProxy?: HyperspaceProxyConfig;  // Hyperspace AI Proxy configuration
}

const DEFAULT_SUPERVISOR_PROMPT = `You are a concise, witty AI supervisor for a voice-first coding environment. Keep all responses SHORT and spoken-friendly — no bullet lists, no markdown headers, no walls of text.

When a task finishes: give a 1-2 sentence summary of what was done with a touch of humor. If there are issues, briefly say what went wrong. Occasionally suggest a next step if it's obvious.

Always end by asking what to do next.

Be funny but not forced — dry wit, light sarcasm, the occasional pun. Think "clever coworker" not "stand-up comedian." Never let the jokes get in the way of being useful.

Examples of good responses:
- "Done — login form's in with validation. Users can no longer just vibe their way past authentication. Want me to add tests?"
- "So that dependency doesn't want to cooperate. Version conflict. Want me to try sweet-talking a different version?"
- "API endpoint's live and tests pass. We're basically shipping. What's next?"
- "Task crashed. Looks like a null pointer — the code equivalent of stepping on a LEGO. Want me to dig into it?"

Keep it natural, like you're the funniest person on the engineering team.`;

// Default MCP servers that are included out-of-the-box
const DEFAULT_MCP_SERVERS: MCPServerConfig[] = [
    {
        name: 'playwright',
        command: 'npx',
        args: ['@playwright/mcp'],
        enabled: true
    }
];

const DEFAULT_SAP_AI_CORE_MODEL: SapAiCoreModel = 'anthropic--claude-4.6-opus';

const DEFAULT_HYPERSPACE_PROXY: HyperspaceProxyConfig = {
    proxyUrl: 'http://localhost:6655',
    apiKey: '',
    model: 'anthropic--claude-4.5-sonnet',
    alwaysThinkingEnabled: false
};

const DEFAULT_CONFIG: AppConfig = {
    mcpServers: DEFAULT_MCP_SERVERS,
    skipPermissions: false,
    rules: '',
    supervisorEnabled: false,
    supervisorSystemPrompt: DEFAULT_SUPERVISOR_PROMPT,
    autoFocusOnInput: false,
    apiMode: 'sap-ai-core',
    sapAiCoreModel: DEFAULT_SAP_AI_CORE_MODEL,
    backend: 'claude-code',
    opencodePort: 4096,
    useLearnings: false,
    hyperspaceProxy: DEFAULT_HYPERSPACE_PROXY
};

export class ConfigStore {
    private config: AppConfig;
    private configFile: string;

    constructor(basePath?: string) {
        this.configFile = basePath
            ? join(basePath, 'config.json')
            : join(__dirname, '..', 'config.json');

        if (basePath && !existsSync(basePath)) {
            mkdirSync(basePath, { recursive: true });
        }

        this.config = this.loadConfig();
    }

    private loadConfig(): AppConfig {
        try {
            if (existsSync(this.configFile)) {
                const data = readFileSync(this.configFile, 'utf-8');
                const loaded = JSON.parse(data) as Partial<AppConfig>;
                return {
                    // Use defaults if mcpServers is undefined or empty array
                    mcpServers: (loaded.mcpServers && loaded.mcpServers.length > 0) ? loaded.mcpServers : DEFAULT_MCP_SERVERS,
                    skipPermissions: loaded.skipPermissions ?? false,
                    rules: loaded.rules ?? '',
                    supervisorEnabled: loaded.supervisorEnabled ?? false,
                    supervisorSystemPrompt: loaded.supervisorSystemPrompt ?? DEFAULT_SUPERVISOR_PROMPT,
                    autoFocusOnInput: loaded.autoFocusOnInput ?? false,
                    aiCoreCredentials: loaded.aiCoreCredentials,
                    sapAiCoreModel: loaded.sapAiCoreModel ?? DEFAULT_SAP_AI_CORE_MODEL,
                    apiMode: loaded.apiMode ?? 'default',
                    customAnthropicApiKey: loaded.customAnthropicApiKey,
                    backend: loaded.backend ?? 'claude-code',
                    opencodePort: loaded.opencodePort ?? 4096,
                    useLearnings: loaded.useLearnings ?? false,
                    hyperspaceProxy: loaded.hyperspaceProxy ?? DEFAULT_HYPERSPACE_PROXY
                };
            }
        } catch (error) {
            console.error('[ConfigStore] Error loading config:', error);
        }
        return { ...DEFAULT_CONFIG };
    }

    private saveConfig(): void {
        try {
            writeFileSync(this.configFile, JSON.stringify(this.config, null, 2), 'utf-8');
            console.log('[ConfigStore] Config saved to', this.configFile);
        } catch (error) {
            console.error('[ConfigStore] Error saving config:', error);
            throw error;
        }
    }

    getConfig(): AppConfig {
        return { ...this.config };
    }

    updateConfig(updates: Partial<AppConfig>): AppConfig {
        if (updates.mcpServers !== undefined) {
            this.config.mcpServers = updates.mcpServers;
        }
        if (updates.skipPermissions !== undefined) {
            this.config.skipPermissions = updates.skipPermissions;
        }
        if (updates.rules !== undefined) {
            this.config.rules = updates.rules;
        }
        if (updates.supervisorEnabled !== undefined) {
            this.config.supervisorEnabled = updates.supervisorEnabled;
        }
        if (updates.supervisorSystemPrompt !== undefined) {
            this.config.supervisorSystemPrompt = updates.supervisorSystemPrompt;
        }
        if (updates.autoFocusOnInput !== undefined) {
            this.config.autoFocusOnInput = updates.autoFocusOnInput;
        }
        if (updates.aiCoreCredentials !== undefined) {
            this.config.aiCoreCredentials = updates.aiCoreCredentials;
        }
        if (updates.sapAiCoreModel !== undefined) {
            this.config.sapAiCoreModel = updates.sapAiCoreModel;
        }
        if (updates.apiMode !== undefined) {
            this.config.apiMode = updates.apiMode;
        }
        if (updates.customAnthropicApiKey !== undefined) {
            this.config.customAnthropicApiKey = updates.customAnthropicApiKey;
        }
        if (updates.backend !== undefined) {
            this.config.backend = updates.backend;
        }
        if (updates.opencodePort !== undefined) {
            this.config.opencodePort = updates.opencodePort;
        }
        if (updates.useLearnings !== undefined) {
            this.config.useLearnings = updates.useLearnings;
        }
        if (updates.hyperspaceProxy !== undefined) {
            this.config.hyperspaceProxy = updates.hyperspaceProxy;
        }
        this.saveConfig();
        return this.getConfig();
    }

    getAICoreCredentials(): AICoreCredentials | undefined {
        return this.config.aiCoreCredentials;
    }

    setAICoreCredentials(credentials: AICoreCredentials | undefined): void {
        if (credentials) {
            // Sanitize URLs - strip leading '=' that can come from pasting
            credentials.authUrl = credentials.authUrl?.replace(/^=+/, '') || '';
            credentials.baseUrl = credentials.baseUrl?.replace(/^=+/, '') || '';
        }
        this.config.aiCoreCredentials = credentials;
        this.saveConfig();
    }

    getApiMode(): ApiMode {
        return this.config.apiMode;
    }

    getSapAiCoreModel(): SapAiCoreModel {
        return this.config.sapAiCoreModel;
    }

    setSapAiCoreModel(model: SapAiCoreModel): void {
        this.config.sapAiCoreModel = model;
        this.saveConfig();
    }

    getCustomAnthropicApiKey(): string | undefined {
        return this.config.customAnthropicApiKey;
    }

    isSupervisorEnabled(): boolean {
        return this.config.supervisorEnabled;
    }

    getSupervisorSystemPrompt(): string {
        return this.config.supervisorSystemPrompt;
    }

    setSupervisorSystemPrompt(prompt: string): void {
        this.config.supervisorSystemPrompt = prompt;
        this.saveConfig();
    }

    getSkipPermissions(): boolean {
        return this.config.skipPermissions;
    }

    getRules(): string {
        return this.config.rules;
    }

    setRules(rules: string): void {
        this.config.rules = rules;
        this.saveConfig();
    }

    getMCPServers(): MCPServerConfig[] {
        return [...this.config.mcpServers];
    }

    resetToDefaults(): AppConfig {
        this.config = { ...DEFAULT_CONFIG };
        this.saveConfig();
        return this.getConfig();
    }

    getBackend(): BackendType {
        return this.config.backend;
    }

    setBackend(backend: BackendType): void {
        this.config.backend = backend;
        this.saveConfig();
    }

    getOpencodePort(): number {
        return this.config.opencodePort ?? 4096;
    }

    setOpencodePort(port: number): void {
        this.config.opencodePort = port;
        this.saveConfig();
    }

    getUseLearnings(): boolean {
        return this.config.useLearnings;
    }

    setUseLearnings(useLearnings: boolean): void {
        this.config.useLearnings = useLearnings;
        this.saveConfig();
    }

    getHyperspaceProxy(): HyperspaceProxyConfig {
        return this.config.hyperspaceProxy ?? DEFAULT_HYPERSPACE_PROXY;
    }

    setHyperspaceProxy(config: HyperspaceProxyConfig): void {
        this.config.hyperspaceProxy = config;
        this.saveConfig();
    }
}
