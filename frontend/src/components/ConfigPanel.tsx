import { useState, useEffect } from 'react';
import { Settings, X, ChevronDown, ChevronRight, Save, RotateCcw, AlertCircle, Check, Server, Wrench, MessageSquare } from 'lucide-react';
import { getApiBaseUrl } from '../config/api-config';
import './ConfigPanel.css';

interface SystemPrompts {
    planResponse: string;
    conversational: string;
    taskCreated: string;
    taskCompletion: string;
    logAnalysis: string;
}

interface ToolDefinition {
    name: string;
    description: string;
    inputSchema?: Record<string, unknown>;
}

interface MCPServerConfig {
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    enabled: boolean;
}

interface SAPAICoreConfig {
    providerID: string;
    modelID: string;
    authUrl?: string;
    clientId?: string;
    clientSecret?: string;
    resourceGroup?: string;
    baseUrl?: string;
}

interface ClaudeConfig {
    cliPath?: string;
    model?: string;
    apiKey?: string;
    maxTokens?: number;
}

interface OrchestratorConfig {
    systemPrompts: SystemPrompts;
    tools: ToolDefinition[];
    mcpServers: MCPServerConfig[];
    sapAICore?: SAPAICoreConfig;
    claude?: ClaudeConfig;
    aiBackend?: 'opencode' | 'claude';
}

const PROMPT_LABELS: Record<keyof SystemPrompts, string> = {
    planResponse: 'Plan Response',
    conversational: 'Conversational',
    taskCreated: 'Task Created',
    taskCompletion: 'Task Completion',
    logAnalysis: 'Log Analysis'
};

const PROMPT_DESCRIPTIONS: Record<keyof SystemPrompts, string> = {
    planResponse: 'Used when the orchestrator plans how to handle a user task request',
    conversational: 'Used for non-task interactions like greetings and questions',
    taskCreated: 'Used to confirm task creation to the user',
    taskCompletion: 'Used to analyze task output and determine success/failure',
    logAnalysis: 'Used to analyze running task logs for issues needing intervention'
};

interface ConfigPanelProps {
    isOpen: boolean;
    onClose: () => void;
}

export function ConfigPanel({ isOpen, onClose }: ConfigPanelProps) {
    const [config, setConfig] = useState<OrchestratorConfig | null>(null);
    const [originalConfig, setOriginalConfig] = useState<OrchestratorConfig | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
        prompts: true,
        tools: false,
        mcpServers: false
    });
    const [testingBackend, setTestingBackend] = useState<'opencode' | 'claude' | null>(null);
    const [testResult, setTestResult] = useState<{ backend: string; success: boolean; message: string } | null>(null);

    useEffect(() => {
        if (isOpen) {
            fetchConfig();
        }
    }, [isOpen]);

    const fetchConfig = async () => {
        setLoading(true);
        setError(null);
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/config`);
            if (!response.ok) throw new Error('Failed to fetch config');
            const data = await response.json();
            setConfig(data);
            setOriginalConfig(JSON.parse(JSON.stringify(data)));
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load config');
        } finally {
            setLoading(false);
        }
    };

    const saveConfig = async () => {
        if (!config) return;
        setSaving(true);
        setError(null);
        setSuccess(null);

        // Check if backend is changing
        const backendChanged = config.aiBackend !== originalConfig?.aiBackend;

        try {
            const response = await fetch(`${getApiBaseUrl()}/api/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });
            if (!response.ok) throw new Error('Failed to save config');
            const data = await response.json();
            setConfig(data);
            setOriginalConfig(JSON.parse(JSON.stringify(data)));

            // Show appropriate success message
            if (backendChanged) {
                setSuccess('Config saved and backend switched! New tasks will use the selected backend.');
            } else {
                setSuccess('Config saved successfully!');
            }
            setTimeout(() => setSuccess(null), 5000);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to save config');
        } finally {
            setSaving(false);
        }
    };

    const testBackend = async (backend: 'opencode' | 'claude') => {
        setTestingBackend(backend);
        setTestResult(null);
        setError(null);
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/config/test-backend`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ backend })
            });
            const data = await response.json();
            setTestResult({
                backend,
                success: data.success,
                message: data.message || data.error || 'Test completed'
            });
            setTimeout(() => setTestResult(null), 5000);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to test backend');
            setTimeout(() => setError(null), 5000);
        } finally {
            setTestingBackend(null);
        }
    };

    const resetConfig = async () => {
        if (!confirm('Reset all config to defaults? This cannot be undone.')) return;
        setSaving(true);
        setError(null);
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/config/reset`, {
                method: 'POST'
            });
            if (!response.ok) throw new Error('Failed to reset config');
            const data = await response.json();
            setConfig(data);
            setOriginalConfig(JSON.parse(JSON.stringify(data)));
            setSuccess('Config reset to defaults!');
            setTimeout(() => setSuccess(null), 3000);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to reset config');
        } finally {
            setSaving(false);
        }
    };

    const toggleSection = (section: string) => {
        setExpandedSections(prev => ({
            ...prev,
            [section]: !prev[section]
        }));
    };

    const updatePrompt = (key: keyof SystemPrompts, value: string) => {
        if (!config) return;
        setConfig({
            ...config,
            systemPrompts: {
                ...config.systemPrompts,
                [key]: value
            }
        });
    };

    const hasChanges = () => {
        if (!config || !originalConfig) return false;
        return JSON.stringify(config) !== JSON.stringify(originalConfig);
    };

    if (!isOpen) return null;

    return (
        <div className="config-panel-overlay" onClick={onClose}>
            <div className="config-panel" onClick={(e) => e.stopPropagation()}>
                <div className="config-header">
                    <div className="config-title">
                        <Settings size={20} />
                        <h2>Orchestrator Settings</h2>
                    </div>
                    <div className="config-header-actions">
                        {hasChanges() && (
                            <span className="unsaved-badge">Unsaved changes</span>
                        )}
                        <button className="config-close-btn" onClick={onClose}>
                            <X size={20} />
                        </button>
                    </div>
                </div>

                <div className="config-content">
                    {loading ? (
                        <div className="config-loading">Loading configuration...</div>
                    ) : error ? (
                        <div className="config-error">
                            <AlertCircle size={20} />
                            {error}
                        </div>
                    ) : config ? (
                        <>
                            {success && (
                                <div className="config-success">
                                    <Check size={16} />
                                    {success}
                                </div>
                            )}

                            {/* System Prompts Section */}
                            <div className="config-section">
                                <button
                                    className="config-section-header"
                                    onClick={() => toggleSection('prompts')}
                                >
                                    {expandedSections.prompts ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                                    <MessageSquare size={18} />
                                    <span>System Prompts</span>
                                    <span className="section-count">{Object.keys(config.systemPrompts).length}</span>
                                </button>
                                {expandedSections.prompts && (
                                    <div className="config-section-content">
                                        {(Object.keys(config.systemPrompts) as Array<keyof SystemPrompts>).map(key => (
                                            <div key={key} className="prompt-item">
                                                <div className="prompt-header">
                                                    <label>{PROMPT_LABELS[key]}</label>
                                                    <span className="prompt-description">{PROMPT_DESCRIPTIONS[key]}</span>
                                                </div>
                                                <textarea
                                                    value={config.systemPrompts[key]}
                                                    onChange={(e) => updatePrompt(key, e.target.value)}
                                                    rows={6}
                                                    spellCheck={false}
                                                />
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* Tools Section */}
                            <div className="config-section">
                                <button
                                    className="config-section-header"
                                    onClick={() => toggleSection('tools')}
                                >
                                    {expandedSections.tools ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                                    <Wrench size={18} />
                                    <span>Tools</span>
                                    <span className="section-count">{config.tools.length}</span>
                                </button>
                                {expandedSections.tools && (
                                    <div className="config-section-content">
                                        {config.tools.length === 0 ? (
                                            <div className="empty-section">
                                                No tools configured. Tools will appear here when added.
                                            </div>
                                        ) : (
                                            config.tools.map((tool, idx) => (
                                                <div key={idx} className="tool-item">
                                                    <strong>{tool.name}</strong>
                                                    <span>{tool.description}</span>
                                                </div>
                                            ))
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* MCP Servers Section */}
                            <div className="config-section">
                                <button
                                    className="config-section-header"
                                    onClick={() => toggleSection('mcpServers')}
                                >
                                    {expandedSections.mcpServers ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                                    <Server size={18} />
                                    <span>MCP Servers</span>
                                    <span className="section-count">{config.mcpServers.length}</span>
                                </button>
                                {expandedSections.mcpServers && (
                                    <div className="config-section-content">
                                        {config.mcpServers.length === 0 ? (
                                            <div className="empty-section">
                                                No MCP servers configured. Servers will appear here when added.
                                            </div>
                                        ) : (
                                            config.mcpServers.map((server, idx) => (
                                                <div key={idx} className="mcp-item">
                                                    <div className="mcp-header">
                                                        <strong>{server.name}</strong>
                                                        <span className={`mcp-status ${server.enabled ? 'enabled' : 'disabled'}`}>
                                                            {server.enabled ? 'Enabled' : 'Disabled'}
                                                        </span>
                                                    </div>
                                                    <code>{server.command} {server.args?.join(' ')}</code>
                                                </div>
                                            ))
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* AI Backend Section */}
                            <div className="config-section">
                                <div className="config-section-header no-cursor">
                                    <Server size={18} />
                                    <span>AI Backend</span>
                                </div>
                                <div className="config-section-content">
                                    <div className="backend-selector">
                                        <select
                                            value={config.aiBackend || 'opencode'}
                                            onChange={(e) => setConfig({ ...config, aiBackend: e.target.value as 'opencode' | 'claude' })}
                                            className="search-input"
                                            style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                                        >
                                            <option value="opencode">OpenCode SDK (Default)</option>
                                            <option value="claude">Claude Code CLI</option>
                                        </select>

                                        {/* Status Badge */}
                                        <div style={{
                                            marginTop: '12px',
                                            padding: '8px 12px',
                                            borderRadius: '6px',
                                            backgroundColor: 'var(--bg-tertiary)',
                                            border: '1px solid var(--border-color)',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '8px'
                                        }}>
                                            <span style={{
                                                width: '8px',
                                                height: '8px',
                                                borderRadius: '50%',
                                                backgroundColor: '#10b981',
                                                display: 'inline-block'
                                            }}></span>
                                            <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                                                Currently Active: <strong style={{ color: 'var(--text-primary)' }}>
                                                    {originalConfig?.aiBackend === 'claude' ? 'Claude Code CLI' : 'OpenCode SDK'}
                                                </strong>
                                                {config.aiBackend !== originalConfig?.aiBackend && (
                                                    <span style={{ color: '#f59e0b', marginLeft: '8px' }}>
                                                        (will change after save)
                                                    </span>
                                                )}
                                            </span>
                                        </div>

                                        <div style={{ marginTop: '12px', fontSize: '13px', lineHeight: '1.6' }}>
                                            <div style={{
                                                padding: '12px',
                                                backgroundColor: 'var(--bg-tertiary)',
                                                borderRadius: '6px',
                                                border: '1px solid var(--border-color)'
                                            }}>
                                                <div style={{ marginBottom: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                    <div>
                                                        <strong style={{ color: 'var(--text-primary)' }}>OpenCode SDK</strong>
                                                        <span style={{ color: 'var(--text-secondary)', marginLeft: '8px', fontSize: '11px', backgroundColor: 'var(--bg-secondary)', padding: '2px 6px', borderRadius: '3px' }}>Default</span>
                                                    </div>
                                                    <button
                                                        onClick={() => testBackend('opencode')}
                                                        disabled={testingBackend === 'opencode'}
                                                        style={{
                                                            padding: '4px 10px',
                                                            fontSize: '12px',
                                                            borderRadius: '4px',
                                                            border: '1px solid var(--border-color)',
                                                            backgroundColor: 'var(--bg-secondary)',
                                                            color: 'var(--text-primary)',
                                                            cursor: testingBackend === 'opencode' ? 'not-allowed' : 'pointer'
                                                        }}
                                                    >
                                                        {testingBackend === 'opencode' ? 'Testing...' : 'Test Connection'}
                                                    </button>
                                                </div>
                                                <ul style={{ margin: '0', paddingLeft: '20px', color: 'var(--text-secondary)' }}>
                                                    <li>Integrated with SAP AI Core</li>
                                                    <li>Built-in MCP server support</li>
                                                    <li>Programmatic API with event streaming</li>
                                                    <li>Model: anthropic--claude-4.5-sonnet</li>
                                                </ul>
                                                {testResult && testResult.backend === 'opencode' && (
                                                    <div style={{
                                                        marginTop: '8px',
                                                        padding: '6px 10px',
                                                        borderRadius: '4px',
                                                        backgroundColor: testResult.success ? '#10b98120' : '#ef444420',
                                                        border: `1px solid ${testResult.success ? '#10b981' : '#ef4444'}`,
                                                        color: testResult.success ? '#10b981' : '#ef4444',
                                                        fontSize: '12px'
                                                    }}>
                                                        {testResult.success ? '✓' : '✗'} {testResult.message}
                                                    </div>
                                                )}
                                            </div>

                                            <div style={{
                                                padding: '12px',
                                                backgroundColor: 'var(--bg-tertiary)',
                                                borderRadius: '6px',
                                                border: '1px solid var(--border-color)',
                                                marginTop: '8px'
                                            }}>
                                                <div style={{ marginBottom: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                    <div>
                                                        <strong style={{ color: 'var(--text-primary)' }}>Claude Code CLI</strong>
                                                    </div>
                                                    <button
                                                        onClick={() => testBackend('claude')}
                                                        disabled={testingBackend === 'claude'}
                                                        style={{
                                                            padding: '4px 10px',
                                                            fontSize: '12px',
                                                            borderRadius: '4px',
                                                            border: '1px solid var(--border-color)',
                                                            backgroundColor: 'var(--bg-secondary)',
                                                            color: 'var(--text-primary)',
                                                            cursor: testingBackend === 'claude' ? 'not-allowed' : 'pointer'
                                                        }}
                                                    >
                                                        {testingBackend === 'claude' ? 'Testing...' : 'Test Connection'}
                                                    </button>
                                                </div>
                                                <ul style={{ margin: '0', paddingLeft: '20px', color: 'var(--text-secondary)' }}>
                                                    <li>Official Anthropic CLI tool</li>
                                                    <li>Direct terminal interaction via node-pty</li>
                                                    <li>REPL-style interface</li>
                                                    <li>Uses your Anthropic API key</li>
                                                </ul>
                                                {testResult && testResult.backend === 'claude' && (
                                                    <div style={{
                                                        marginTop: '8px',
                                                        padding: '6px 10px',
                                                        borderRadius: '4px',
                                                        backgroundColor: testResult.success ? '#10b98120' : '#ef444420',
                                                        border: `1px solid ${testResult.success ? '#10b981' : '#ef4444'}`,
                                                        color: testResult.success ? '#10b981' : '#ef4444',
                                                        fontSize: '12px'
                                                    }}>
                                                        {testResult.success ? '✓' : '✗'} {testResult.message}
                                                    </div>
                                                )}
                                            </div>

                                            <p style={{ marginTop: '12px', color: 'var(--text-secondary)', fontSize: '12px', fontStyle: 'italic' }}>
                                                Note: Backend changes are applied immediately. Currently running tasks will continue with the old backend, but new tasks will use the selected backend.
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* OpenCode SDK Configuration */}
                            {config.aiBackend === 'opencode' && (
                                <div className="config-section" style={{ marginTop: '16px' }}>
                                    <div
                                        className="config-section-header"
                                        onClick={() => setExpandedSections({ ...expandedSections, opencodeConfig: !expandedSections.opencodeConfig })}
                                    >
                                        <Server size={18} />
                                        <span>OpenCode SDK Settings</span>
                                        {expandedSections.opencodeConfig ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                                    </div>
                                    {expandedSections.opencodeConfig && (
                                        <div className="config-section-content">
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                                <div>
                                                    <label style={{ fontSize: '13px', color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>
                                                        Model ID
                                                    </label>
                                                    <input
                                                        type="text"
                                                        value={config.sapAICore?.modelID || 'anthropic--claude-4.5-sonnet'}
                                                        onChange={(e) => setConfig({
                                                            ...config,
                                                            sapAICore: { ...config.sapAICore, providerID: 'sap-ai-core', modelID: e.target.value }
                                                        })}
                                                        className="search-input"
                                                        style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                                                    />
                                                </div>
                                                <div>
                                                    <label style={{ fontSize: '13px', color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>
                                                        Base URL (optional)
                                                    </label>
                                                    <input
                                                        type="text"
                                                        value={config.sapAICore?.baseUrl || ''}
                                                        onChange={(e) => setConfig({
                                                            ...config,
                                                            sapAICore: { ...config.sapAICore, providerID: 'sap-ai-core', modelID: config.sapAICore?.modelID || '', baseUrl: e.target.value }
                                                        })}
                                                        placeholder="https://api.ai.sap.com"
                                                        className="search-input"
                                                        style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Claude Code CLI Configuration */}
                            {config.aiBackend === 'claude' && (
                                <div className="config-section" style={{ marginTop: '16px' }}>
                                    <div
                                        className="config-section-header"
                                        onClick={() => setExpandedSections({ ...expandedSections, claudeConfig: !expandedSections.claudeConfig })}
                                    >
                                        <Server size={18} />
                                        <span>Claude Code CLI Settings</span>
                                        {expandedSections.claudeConfig ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                                    </div>
                                    {expandedSections.claudeConfig && (
                                        <div className="config-section-content">
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                                <div>
                                                    <label style={{ fontSize: '13px', color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>
                                                        CLI Path (optional)
                                                    </label>
                                                    <input
                                                        type="text"
                                                        value={config.claude?.cliPath || ''}
                                                        onChange={(e) => setConfig({
                                                            ...config,
                                                            claude: { ...config.claude, cliPath: e.target.value }
                                                        })}
                                                        placeholder="claude (default)"
                                                        className="search-input"
                                                        style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                                                    />
                                                    <p style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                                                        Leave empty to use the default 'claude' command in PATH
                                                    </p>
                                                </div>
                                                <div>
                                                    <label style={{ fontSize: '13px', color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>
                                                        Model (optional)
                                                    </label>
                                                    <input
                                                        type="text"
                                                        value={config.claude?.model || ''}
                                                        onChange={(e) => setConfig({
                                                            ...config,
                                                            claude: { ...config.claude, model: e.target.value }
                                                        })}
                                                        placeholder="claude-sonnet-4.5-20250929 (default)"
                                                        className="search-input"
                                                        style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                                                    />
                                                </div>
                                                <div>
                                                    <label style={{ fontSize: '13px', color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>
                                                        Max Tokens (optional)
                                                    </label>
                                                    <input
                                                        type="number"
                                                        value={config.claude?.maxTokens || ''}
                                                        onChange={(e) => setConfig({
                                                            ...config,
                                                            claude: { ...config.claude, maxTokens: parseInt(e.target.value) || undefined }
                                                        })}
                                                        placeholder="8192 (default)"
                                                        className="search-input"
                                                        style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </>
                    ) : null}
                </div>

                <div className="config-footer">
                    <button
                        className="config-reset-btn"
                        onClick={resetConfig}
                        disabled={saving}
                    >
                        <RotateCcw size={16} />
                        Reset to Defaults
                    </button>
                    <button
                        className="config-save-btn"
                        onClick={saveConfig}
                        disabled={saving || !hasChanges()}
                    >
                        <Save size={16} />
                        {saving ? 'Saving...' : 'Save Changes'}
                    </button>
                </div>
            </div>
        </div>
    );
}
