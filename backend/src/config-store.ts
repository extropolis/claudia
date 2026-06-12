/**
 * Config Store - Manages application configuration (MCP servers, CLI switches)
 */
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { BackendType } from './backends/types.js';
import { loadVersioned, saveVersioned } from './utils/schema-version.js';
import { ModelPricing } from '@claudia/shared';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Schema version for config.json. Bump when the AppConfig shape changes. */
const CONFIG_SCHEMA_VERSION = 1;

export interface MCPServerConfig {
  name: string;
  type?: 'stdio' | 'http' | 'streamableHttp'; // Default: 'stdio'
  command?: string; // Required for stdio, not for http/streamableHttp
  args?: string[];
  env?: Record<string, string>;
  url?: string; // Required for http/streamableHttp
  enabled: boolean;
  timeout?: number;
  autoApprove?: string[];
  description?: string;
  headers?: Record<string, string>; // For http/streamableHttp
}

// API mode determines how Claude Code connects to Anthropic's API
export type ApiMode = 'default' | 'custom-anthropic' | 'sap-ai-core' | 'hyperspace-proxy';

// Claude Code CLI switches configuration
export interface ClaudeCodeSwitches {
  verbose: boolean; // --verbose
  maxTurns: number | null; // --max-turns N (null = disabled)
  maxBudgetUsd: number | null; // --max-budget-usd N (null = disabled)
  permissionMode: string | null; // --permission-mode MODE (null = not set)
  allowedTools: string; // --allowedTools TOOLS (empty = not set)
  disallowedTools: string; // --disallowedTools TOOLS (empty = not set)
  appendSystemPrompt: string; // --append-system-prompt TEXT (empty = not set)
  effortLevel: string; // CLAUDE_CODE_EFFORT_LEVEL env var ('low' | 'medium' | 'high')
  defaultModel: string; // --model MODEL (empty = use Claude's default)
}

// Hyperspace AI Proxy configuration
export interface HyperspaceProxyConfig {
  proxyUrl: string;
  apiKey: string;
  model: string;
  alwaysThinkingEnabled: boolean;
}

// Model tiering: lets MCP-spawned tasks pick a cheaper model based on a
// complexity hint passed by the spawning agent.
export type ComplexityTier = 'low' | 'medium' | 'high';

export interface ModelTieringConfig {
  enabled: boolean;
  tiers: {
    low: string;
    medium: string;
    high: string;
  };
}

export const DEFAULT_MODEL_TIERING: ModelTieringConfig = {
  enabled: false,
  tiers: { low: 'haiku', medium: 'sonnet', high: 'opus' },
};

export const DEFAULT_CLAUDE_CODE_SWITCHES: ClaudeCodeSwitches = {
  verbose: false,
  maxTurns: null,
  maxBudgetUsd: null,
  permissionMode: null,
  allowedTools: '',
  disallowedTools: '',
  appendSystemPrompt: '',
  effortLevel: 'high',
  defaultModel: '',
};

const DEFAULT_HYPERSPACE_PROXY: HyperspaceProxyConfig = {
  proxyUrl: 'http://localhost:6655',
  apiKey: '',
  model: 'anthropic--claude-4.5-sonnet',
  alwaysThinkingEnabled: false,
};

export interface AppConfig {
  mcpServers: MCPServerConfig[];
  skipPermissions: boolean;
  rules: string;
  autoFocusOnInput: boolean; // Auto-switch to task when it needs input
  apiMode: ApiMode; // Which API connection mode to use
  customAnthropicApiKey?: string; // API key for custom-anthropic mode
  backend: BackendType; // Which AI backend to use (claude-code or opencode)
  opencodePort?: number; // Port for OpenCode server (default: 4096)
  useLearnings: boolean; // Use RAG-based learnings injection for tasks
  claudeCodeSwitches: ClaudeCodeSwitches; // Claude Code CLI switches
  deepgramApiKey?: string; // Deepgram API key for voice recognition (synced from frontend)
  hyperspaceProxy?: HyperspaceProxyConfig; // Hyperspace AI Proxy configuration
  aiCoreCredentials?: {
    // SAP AI Core credentials
    clientId: string;
    clientSecret: string;
    authUrl: string;
    baseUrl: string;
    resourceGroup?: string;
    timeoutMs?: number;
  };
  enabledPlugins?: string[]; // List of enabled plugin names (all disabled by default)
  claudiaMcpServerEnabled: boolean; // Enable Claudia MCP server for Claude Code sessions
  tokenPricing?: Record<string, ModelPricing>; // Custom token pricing per model
  tokenTrackingEnabled?: boolean; // Enable token usage tracking
  tokenCostEnabled?: boolean; // Enable cost calculation display (default: false)
  defaultBaseDirectory?: string; // Default base directory for new workspaces (optional)
  modelTiering?: ModelTieringConfig; // Complexity-based model selection for MCP-spawned tasks
  autoReloadEnabled?: boolean; // Auto-restart backend when src/ files change (read by dev-watcher.mjs)
}


// Default MCP servers that are included out-of-the-box
const DEFAULT_MCP_SERVERS: MCPServerConfig[] = [
  {
    name: 'playwright',
    command: 'npx',
    args: ['@playwright/mcp'],
    enabled: true,
    description: 'Browser automation and testing',
  },
  {
    name: 'iphone',
    command: 'npx',
    args: ['@blitzdev/iphone-mcp'],
    enabled: false, // Disabled by default - requires macOS, Xcode, and device setup
    description: 'Control real iPhones and simulators (macOS only)',
  },
  {
    name: 'xcodebuild',
    command: 'npx',
    args: ['-y', 'xcodebuildmcp@latest', 'mcp'],
    enabled: false, // Disabled by default - requires macOS and Xcode
    description: 'Xcode build tools for iOS and macOS projects',
  },
];

// Default pricing per Anthropic's current (2026) API rates:
// https://platform.claude.com/docs/en/about-claude/pricing
// Cache write = 1.25x input, Cache read = 0.1x input
export const DEFAULT_TOKEN_PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-6': {
    inputPer1MTokens: 3.0,
    outputPer1MTokens: 15.0,
    cacheCreatePer1MTokens: 3.75,
    cacheReadPer1MTokens: 0.3,
  },
  'claude-opus-4-6': {
    inputPer1MTokens: 5.0,
    outputPer1MTokens: 25.0,
    cacheCreatePer1MTokens: 6.25,
    cacheReadPer1MTokens: 0.5,
  },
  'claude-haiku-4-5': {
    inputPer1MTokens: 1.0,
    outputPer1MTokens: 5.0,
    cacheCreatePer1MTokens: 1.25,
    cacheReadPer1MTokens: 0.1,
  },
};

const DEFAULT_CONFIG: AppConfig = {
  mcpServers: DEFAULT_MCP_SERVERS,
  skipPermissions: false,
  rules: '',
  autoFocusOnInput: false,
  apiMode: 'default',
  backend: 'claude-code',
  opencodePort: 4096,
  useLearnings: false,
  claudeCodeSwitches: { ...DEFAULT_CLAUDE_CODE_SWITCHES },
  hyperspaceProxy: DEFAULT_HYPERSPACE_PROXY,
  enabledPlugins: [], // All plugins disabled by default
  claudiaMcpServerEnabled: true, // Enabled by default
  tokenTrackingEnabled: true, // Token usage tracking enabled by default
  defaultBaseDirectory: undefined, // No default base directory set
  modelTiering: { ...DEFAULT_MODEL_TIERING, tiers: { ...DEFAULT_MODEL_TIERING.tiers } },
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

  /** Apply defaults to a partial config. Used after load to guarantee every field. */
  private normalize(loaded: Partial<AppConfig>): AppConfig {
    return {
      // Use defaults if mcpServers is undefined or empty array
      mcpServers:
        loaded.mcpServers && loaded.mcpServers.length > 0 ? loaded.mcpServers : DEFAULT_MCP_SERVERS,
      skipPermissions: loaded.skipPermissions ?? false,
      rules: loaded.rules ?? '',
      autoFocusOnInput: loaded.autoFocusOnInput ?? false,
      apiMode: loaded.apiMode ?? 'default',
      customAnthropicApiKey: loaded.customAnthropicApiKey,
      deepgramApiKey: loaded.deepgramApiKey,
      backend: loaded.backend ?? 'claude-code',
      opencodePort: loaded.opencodePort ?? 4096,
      useLearnings: loaded.useLearnings ?? false,
      claudeCodeSwitches: (() => {
        const sw = loaded.claudeCodeSwitches || ({} as any);
        // Migrate old 'model' field to 'defaultModel' if present
        const defaultModel =
          sw.defaultModel || (sw as any).model || DEFAULT_CLAUDE_CODE_SWITCHES.defaultModel;
        return { ...DEFAULT_CLAUDE_CODE_SWITCHES, ...sw, defaultModel };
      })(),
      hyperspaceProxy: loaded.hyperspaceProxy ?? DEFAULT_HYPERSPACE_PROXY,
      aiCoreCredentials: loaded.aiCoreCredentials,
      enabledPlugins: loaded.enabledPlugins ?? [],
      claudiaMcpServerEnabled: loaded.claudiaMcpServerEnabled ?? true,
      tokenTrackingEnabled: loaded.tokenTrackingEnabled ?? true,
      tokenCostEnabled: loaded.tokenCostEnabled ?? false,
      tokenPricing: loaded.tokenPricing,
      defaultBaseDirectory: loaded.defaultBaseDirectory,
      modelTiering: {
        enabled: loaded.modelTiering?.enabled ?? DEFAULT_MODEL_TIERING.enabled,
        tiers: { ...DEFAULT_MODEL_TIERING.tiers, ...(loaded.modelTiering?.tiers || {}) },
      },
      autoReloadEnabled: loaded.autoReloadEnabled ?? true,
    };
  }

  private defaultConfig(): AppConfig {
    return this.normalize({});
  }

  private loadConfig(): AppConfig {
    try {
      // loadVersioned handles: missing file → defaultData; legacy unversioned
      // file → legacyLoader; future versioned files → migrations (none yet).
      // We run normalize() over the result so newly-added fields always have
      // a default, regardless of the on-disk version.
      const data = loadVersioned<Partial<AppConfig>>(this.configFile, {
        currentVersion: CONFIG_SCHEMA_VERSION,
        defaultData: this.defaultConfig(),
        legacyLoader: (raw) => raw as Partial<AppConfig>,
      });
      return this.normalize(data);
    } catch (error) {
      console.error('[ConfigStore] Error loading config:', error);
      return this.defaultConfig();
    }
  }

  private saveConfig(): void {
    try {
      saveVersioned(this.configFile, this.config, CONFIG_SCHEMA_VERSION);
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
    if (updates.autoFocusOnInput !== undefined) {
      this.config.autoFocusOnInput = updates.autoFocusOnInput;
    }
    if (updates.apiMode !== undefined) {
      this.config.apiMode = updates.apiMode;
    }
    if (updates.customAnthropicApiKey !== undefined) {
      this.config.customAnthropicApiKey = updates.customAnthropicApiKey;
    }
    if (updates.deepgramApiKey !== undefined) {
      this.config.deepgramApiKey = updates.deepgramApiKey;
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
    if (updates.claudeCodeSwitches !== undefined) {
      this.config.claudeCodeSwitches = {
        ...DEFAULT_CLAUDE_CODE_SWITCHES,
        ...updates.claudeCodeSwitches,
      };
    }
    if (updates.hyperspaceProxy !== undefined) {
      this.config.hyperspaceProxy = updates.hyperspaceProxy;
    }
    if (updates.aiCoreCredentials !== undefined) {
      this.config.aiCoreCredentials = updates.aiCoreCredentials;
    }
    if (updates.claudiaMcpServerEnabled !== undefined) {
      this.config.claudiaMcpServerEnabled = updates.claudiaMcpServerEnabled;
    }
    if (updates.tokenTrackingEnabled !== undefined) {
      this.config.tokenTrackingEnabled = updates.tokenTrackingEnabled;
    }
    if (updates.tokenCostEnabled !== undefined) {
      this.config.tokenCostEnabled = updates.tokenCostEnabled;
    }
    if (updates.tokenPricing !== undefined) {
      this.config.tokenPricing = updates.tokenPricing;
    }
    if (updates.defaultBaseDirectory !== undefined) {
      this.config.defaultBaseDirectory = updates.defaultBaseDirectory;
    }
    if (updates.modelTiering !== undefined) {
      // Merge against existing config (not just defaults) so partial updates
      // — e.g., flipping only `enabled` — don't blow away custom tier mappings.
      const existing = this.config.modelTiering ?? DEFAULT_MODEL_TIERING;
      this.config.modelTiering = {
        enabled: updates.modelTiering.enabled ?? existing.enabled,
        tiers: { ...existing.tiers, ...(updates.modelTiering.tiers || {}) },
      };
    }
    if (updates.autoReloadEnabled !== undefined) {
      this.config.autoReloadEnabled = updates.autoReloadEnabled;
    }
    this.saveConfig();
    return this.getConfig();
  }

  getApiMode(): ApiMode {
    return this.config.apiMode;
  }

  getCustomAnthropicApiKey(): string | undefined {
    return this.config.customAnthropicApiKey;
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
    this.config = {
      mcpServers: [...DEFAULT_MCP_SERVERS],
      skipPermissions: false,
      rules: '',
      autoFocusOnInput: false,
      apiMode: 'default',
      backend: 'claude-code',
      opencodePort: 4096,
      useLearnings: false,
      claudeCodeSwitches: { ...DEFAULT_CLAUDE_CODE_SWITCHES },
      hyperspaceProxy: { ...DEFAULT_HYPERSPACE_PROXY },
      claudiaMcpServerEnabled: true,
      tokenTrackingEnabled: true,
      tokenCostEnabled: false,
      tokenPricing: { ...DEFAULT_TOKEN_PRICING },
      defaultBaseDirectory: undefined,
      modelTiering: { ...DEFAULT_MODEL_TIERING, tiers: { ...DEFAULT_MODEL_TIERING.tiers } },
    };
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

  getClaudeCodeSwitches(): ClaudeCodeSwitches {
    return { ...DEFAULT_CLAUDE_CODE_SWITCHES, ...(this.config.claudeCodeSwitches || {}) };
  }

  setClaudeCodeSwitches(switches: ClaudeCodeSwitches): void {
    this.config.claudeCodeSwitches = switches;
    this.saveConfig();
  }

  getHyperspaceProxy(): HyperspaceProxyConfig {
    return this.config.hyperspaceProxy ?? DEFAULT_HYPERSPACE_PROXY;
  }

  setHyperspaceProxy(config: HyperspaceProxyConfig): void {
    this.config.hyperspaceProxy = config;
    this.saveConfig();
  }

  getModelTiering(): ModelTieringConfig {
    return {
      enabled: this.config.modelTiering?.enabled ?? DEFAULT_MODEL_TIERING.enabled,
      tiers: { ...DEFAULT_MODEL_TIERING.tiers, ...(this.config.modelTiering?.tiers || {}) },
    };
  }

  setModelTiering(config: ModelTieringConfig): void {
    this.config.modelTiering = {
      enabled: config.enabled,
      tiers: { ...DEFAULT_MODEL_TIERING.tiers, ...config.tiers },
    };
    this.saveConfig();
  }

  /**
   * Resolve a complexity tier to a concrete model string for `--model`.
   * Returns undefined if tiering is disabled, no complexity was provided,
   * or the configured tier maps to an empty string (caller falls back to default).
   */
  resolveModelForComplexity(complexity: ComplexityTier | undefined): string | undefined {
    if (!complexity) return undefined;
    const cfg = this.getModelTiering();
    if (!cfg.enabled) return undefined;
    const model = cfg.tiers[complexity];
    if (!model || !model.trim()) return undefined;
    return model.trim();
  }

  getEnabledPlugins(): string[] {
    return this.config.enabledPlugins ?? [];
  }

  isPluginEnabled(pluginName: string): boolean {
    return this.getEnabledPlugins().includes(pluginName);
  }

  setPluginEnabled(pluginName: string, enabled: boolean): void {
    const currentPlugins = this.getEnabledPlugins();
    if (enabled) {
      // Add plugin if not already enabled
      if (!currentPlugins.includes(pluginName)) {
        this.config.enabledPlugins = [...currentPlugins, pluginName];
        this.saveConfig();
      }
    } else {
      // Remove plugin if enabled
      if (currentPlugins.includes(pluginName)) {
        this.config.enabledPlugins = currentPlugins.filter((p) => p !== pluginName);
        this.saveConfig();
      }
    }
  }

  getClaudioMcpServerEnabled(): boolean {
    return this.config.claudiaMcpServerEnabled;
  }

  setClaudioMcpServerEnabled(enabled: boolean): void {
    this.config.claudiaMcpServerEnabled = enabled;
    this.saveConfig();
  }

  getTokenTrackingEnabled(): boolean {
    return this.config.tokenTrackingEnabled ?? true;
  }

  setTokenTrackingEnabled(enabled: boolean): void {
    this.config.tokenTrackingEnabled = enabled;
    this.saveConfig();
  }

  getTokenCostEnabled(): boolean {
    return this.config.tokenCostEnabled ?? false;
  }

  setTokenCostEnabled(enabled: boolean): void {
    this.config.tokenCostEnabled = enabled;
    this.saveConfig();
  }

  getTokenPricing(): Record<string, ModelPricing> {
    return this.config.tokenPricing ?? DEFAULT_TOKEN_PRICING;
  }

  setTokenPricing(pricing: Record<string, ModelPricing>): void {
    this.config.tokenPricing = pricing;
    this.saveConfig();
  }

  getDefaultBaseDirectory(): string | undefined {
    return this.config.defaultBaseDirectory;
  }

  setDefaultBaseDirectory(directory: string | undefined): void {
    this.config.defaultBaseDirectory = directory;
    this.saveConfig();
  }
}
