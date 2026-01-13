/**
 * Config Store - Manages orchestrator configuration including system prompts, tools, and MCP servers
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface SystemPrompts {

    taskCompletion: string;
    logAnalysis: string;
}

export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema?: Record<string, unknown>;
}

export interface MCPServerConfig {
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    enabled: boolean;
}

export interface SAPAICoreConfig {
    providerID: string;
    modelID: string;
    authUrl?: string;
    clientId?: string;
    clientSecret?: string;
    resourceGroup?: string;
    baseUrl?: string;
}

export interface ClaudeConfig {
    cliPath?: string;
    model?: string;
    apiKey?: string;
    maxTokens?: number;
}

export interface OrchestratorConfig {
    systemPrompts: SystemPrompts;
    tools: ToolDefinition[];
    mcpServers: MCPServerConfig[];
    sapAICore?: SAPAICoreConfig;
    claude?: ClaudeConfig;
    aiBackend: 'claude' | 'claude';
}

// Default system prompts (matching llm-service.ts)
const DEFAULT_PROMPTS: SystemPrompts = {

    taskCompletion: `You are an AI orchestrator analyzing task completion results.
Analyze the following task output and determine:
1. Was the task truly successful? (even if exit code is 0, check for errors in output)
2. Does this need further action or debugging?
3. What should you tell the user?

Respond with a JSON object containing:
- "message": A brief, natural message (1-2 sentences) summarizing what happened. Use emoji if appropriate.
- "needsContinuation": boolean - true if errors need fixing, tests failed, or something isn't working
- "suggestedAction": optional string - if continuation needed, what should be done next

Be concise and helpful. Examples of good messages:
- "✅ Todo app created successfully! It's ready to use with local storage and a modern UI."
- "❌ Build failed due to a TypeScript error in AuthService. Let me fix that for you."
- "⚠️ Tests passed but there's a deprecation warning we should address."

IMPORTANT: Output ONLY valid JSON, nothing else.`,

    logAnalysis: `You are an AI assistant analyzing logs from a running Claude Code task.
Your job is to detect issues that need intervention and suggest what instruction to send.

Analyze the output and determine:
1. Is there a real issue that needs intervention? (Not just normal progress/verbose output)
2. What type of issue is it?
3. What instruction should be sent to the Claude Code instance to fix it?

Respond with JSON only:
{
  "hasIssue": boolean,
  "issueType": "error" | "stuck" | "permission" | "dependency" | "other" (if hasIssue),
  "issueDescription": "brief description" (if hasIssue),
  "suggestedIntervention": "the exact instruction to send to Claude Code" (if hasIssue)
}

Examples of good interventions:
- "Try a different approach - use XYZ instead"
- "The error is caused by ABC, fix it by doing DEF"
- "Skip this step and move on to the next part of the task"
- "Install the missing dependency first: npm install xyz"

IMPORTANT: Only set hasIssue to true for REAL problems that block progress, not just warnings or verbose output.`
};

const DEFAULT_CONFIG: OrchestratorConfig = {
    systemPrompts: DEFAULT_PROMPTS,
    tools: [],
    mcpServers: [],
    aiBackend: 'claude'
};

export class ConfigStore {
    private config: OrchestratorConfig;
    private configFile: string;

    constructor(basePath?: string) {
        // Use basePath if provided (Electron userData), otherwise use default location
        this.configFile = basePath
            ? join(basePath, 'orchestrator-config.json')
            : join(__dirname, '..', 'orchestrator-config.json');

        // Ensure directory exists
        if (basePath && !existsSync(basePath)) {
            mkdirSync(basePath, { recursive: true });
        }

        this.config = this.loadConfig();
    }

    private loadConfig(): OrchestratorConfig {
        try {
            if (existsSync(this.configFile)) {
                const data = readFileSync(this.configFile, 'utf-8');
                const loaded = JSON.parse(data) as Partial<OrchestratorConfig>;
                // Merge with defaults to ensure all fields exist
                return {
                    systemPrompts: { ...DEFAULT_PROMPTS, ...loaded.systemPrompts },
                    tools: loaded.tools || [],
                    mcpServers: loaded.mcpServers || [],
                    aiBackend: loaded.aiBackend || 'claude'
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

    getConfig(): OrchestratorConfig {
        return { ...this.config };
    }

    updateConfig(updates: Partial<OrchestratorConfig>): OrchestratorConfig {
        if (updates.systemPrompts) {
            this.config.systemPrompts = { ...this.config.systemPrompts, ...updates.systemPrompts };
        }
        if (updates.tools !== undefined) {
            this.config.tools = updates.tools;
        }
        if (updates.mcpServers !== undefined) {
            this.config.mcpServers = updates.mcpServers;
        }
        if (updates.aiBackend !== undefined) {
            this.config.aiBackend = updates.aiBackend;
        }
        if (updates.sapAICore !== undefined) {
            this.config.sapAICore = updates.sapAICore;
        }
        if (updates.claude !== undefined) {
            this.config.claude = updates.claude;
        }
        this.saveConfig();
        return this.getConfig();
    }

    getSystemPrompts(): SystemPrompts {
        return { ...this.config.systemPrompts };
    }

    updateSystemPrompts(prompts: Partial<SystemPrompts>): SystemPrompts {
        this.config.systemPrompts = { ...this.config.systemPrompts, ...prompts };
        this.saveConfig();
        return this.getSystemPrompts();
    }

    getTools(): ToolDefinition[] {
        return [...this.config.tools];
    }

    getMCPServers(): MCPServerConfig[] {
        return [...this.config.mcpServers];
    }

    resetToDefaults(): OrchestratorConfig {
        this.config = { ...DEFAULT_CONFIG };
        this.saveConfig();
        return this.getConfig();
    }
}
