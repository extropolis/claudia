import { useState, useEffect } from 'react';
import { X, Settings, Volume2, Server, ChevronDown, ChevronRight, Plus, Trash2, Power, PowerOff, Shield, FileText, Bot, MousePointer, CheckCircle, AlertCircle, Loader2, Key, Code, Eye, Terminal } from 'lucide-react';
import { VoiceSettingsContent } from './VoiceSettingsContent';
import { getApiBaseUrl } from '../config/api-config';
import { useTaskStore } from '../stores/taskStore';
import './SettingsMenu.css';

interface SettingsMenuProps {
    isOpen: boolean;
    onClose: () => void;
    initialPanel?: string;
}

interface MCPServer {
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    enabled: boolean;
}

interface AICoreCredentials {
    clientId: string;
    clientSecret: string;
    authUrl: string;
    baseUrl: string;
    resourceGroup: string;
    timeoutMs: number;
}

type ApiMode = 'default' | 'custom-anthropic' | 'sap-ai-core';
type BackendType = 'claude-code' | 'opencode';

interface BackendStatus {
    backend: BackendType;
    installed: boolean;
    version?: string;
    error?: string;
    serverRunning?: boolean;
    availableBackends: BackendType[];
}

interface CollapsiblePanelProps {
    title: string;
    icon: React.ReactNode;
    isExpanded: boolean;
    onToggle: () => void;
    children: React.ReactNode;
}

function CollapsiblePanel({ title, icon, isExpanded, onToggle, children }: CollapsiblePanelProps) {
    return (
        <div className="collapsible-panel">
            <button className="collapsible-panel-header" onClick={onToggle}>
                <span className="collapsible-panel-icon">{icon}</span>
                <span className="collapsible-panel-title">{title}</span>
                <span className="collapsible-panel-chevron">
                    {isExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                </span>
            </button>
            {isExpanded && (
                <div className="collapsible-panel-content">
                    {children}
                </div>
            )}
        </div>
    );
}

export function SettingsMenu({ isOpen, onClose, initialPanel }: SettingsMenuProps) {
    const { showSystemStats, setShowSystemStats } = useTaskStore();
    const [expandedPanels, setExpandedPanels] = useState<Record<string, boolean>>({
        sound: false,
        behavior: false,
        backend: false,
        api: false,
        mcp: false,
        permissions: false,
        rules: false,
        supervisor: false
    });

    // Handle initial panel expansion when settings opens
    useEffect(() => {
        if (isOpen && initialPanel) {
            setExpandedPanels(prev => ({ ...prev, [initialPanel]: true }));
        }
    }, [isOpen, initialPanel]);

    const [mcpServers, setMcpServers] = useState<MCPServer[]>([]);
    const [isAddingServer, setIsAddingServer] = useState(false);
    const [newServer, setNewServer] = useState({ name: '', command: '', args: '' });

    // JSON editor state
    const [mcpViewMode, setMcpViewMode] = useState<'list' | 'json'>('list');
    const [claudeConfigJson, setClaudeConfigJson] = useState('');
    const [claudeConfigPath, setClaudeConfigPath] = useState('');
    const [jsonEditorSaved, setJsonEditorSaved] = useState(true);
    const [jsonEditorError, setJsonEditorError] = useState<string | null>(null);
    const [skipPermissions, setSkipPermissions] = useState(false);
    const [rules, setRules] = useState('');
    const [rulesSaved, setRulesSaved] = useState(true);
    const [supervisorEnabled, setSupervisorEnabled] = useState(false);
    const [supervisorSystemPrompt, setSupervisorSystemPrompt] = useState('');
    const [supervisorPromptSaved, setSupervisorPromptSaved] = useState(true);
    const [autoFocusOnInput, setAutoFocusOnInput] = useState(false);

    // API Mode state
    const [apiMode, setApiMode] = useState<ApiMode>('default');
    const [customAnthropicApiKey, setCustomAnthropicApiKey] = useState('');
    const [apiModeSaved, setApiModeSaved] = useState(true);

    // AI Core credentials state
    const [aiCoreCredentials, setAiCoreCredentials] = useState<AICoreCredentials>({
        clientId: '',
        clientSecret: '',
        authUrl: '',
        baseUrl: '',
        resourceGroup: 'default',
        timeoutMs: 120000
    });
    const [aiCoreSaved, setAiCoreSaved] = useState(true);
    const [aiCoreTestStatus, setAiCoreTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
    const [aiCoreTestMessage, setAiCoreTestMessage] = useState('');

    // Custom API key test state
    const [customApiKeyTestStatus, setCustomApiKeyTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
    const [customApiKeyTestMessage, setCustomApiKeyTestMessage] = useState('');

    // Backend state
    const [backend, setBackend] = useState<BackendType>('claude-code');
    const [backendSaved, setBackendSaved] = useState(true);
    const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(null);
    const [backendStatusLoading, setBackendStatusLoading] = useState(false);

    useEffect(() => {
        if (isOpen) {
            fetchConfig();
            fetchBackendStatus();
        }
    }, [isOpen]);

    // Fetch backend status when backend panel is expanded
    useEffect(() => {
        if (expandedPanels.backend) {
            fetchBackendStatus();
        }
    }, [expandedPanels.backend]);

    // Fetch Claude config when switching to JSON view mode
    useEffect(() => {
        if (mcpViewMode === 'json' && expandedPanels.mcp) {
            fetchClaudeConfig();
        }
    }, [mcpViewMode, expandedPanels.mcp]);

    const fetchConfig = async () => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/config`);
            if (response.ok) {
                const config = await response.json();
                setMcpServers(config.mcpServers || []);
                setSkipPermissions(config.skipPermissions || false);
                setRules(config.rules || '');
                setRulesSaved(true);
                setSupervisorEnabled(config.supervisorEnabled || false);
                setSupervisorSystemPrompt(config.supervisorSystemPrompt || '');
                setSupervisorPromptSaved(true);
                setAutoFocusOnInput(config.autoFocusOnInput || false);
                setApiMode(config.apiMode || 'default');
                setCustomAnthropicApiKey(config.customAnthropicApiKey || '');
                setApiModeSaved(true);
                if (config.aiCoreCredentials) {
                    setAiCoreCredentials(config.aiCoreCredentials);
                }
                setAiCoreSaved(true);
                setBackend(config.backend || 'claude-code');
                setBackendSaved(true);
            }
        } catch (error) {
            console.error('Failed to fetch config:', error);
        }
    };

    const fetchBackendStatus = async () => {
        setBackendStatusLoading(true);
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/backend/status`);
            if (response.ok) {
                const status = await response.json();
                setBackendStatus(status);
            }
        } catch (error) {
            console.error('Failed to fetch backend status:', error);
        } finally {
            setBackendStatusLoading(false);
        }
    };

    const saveMCPServers = async (servers: MCPServer[]) => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mcpServers: servers })
            });
            if (response.ok) {
                setMcpServers(servers);
            }
        } catch (error) {
            console.error('Failed to save MCP servers:', error);
        }
    };

    const fetchClaudeConfig = async () => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/claude-config/mcp-servers`);
            if (response.ok) {
                const data = await response.json();
                // Pretty-print the JSON for editing
                try {
                    const parsed = JSON.parse(data.content);
                    setClaudeConfigJson(JSON.stringify(parsed, null, 2));
                } catch {
                    setClaudeConfigJson(data.content);
                }
                setClaudeConfigPath(data.path);
                setJsonEditorSaved(true);
                setJsonEditorError(null);
            }
        } catch (error) {
            console.error('Failed to fetch MCP servers config:', error);
            setJsonEditorError('Failed to load MCP servers config');
        }
    };

    const saveClaudeConfig = async () => {
        try {
            // Validate JSON before saving
            const parsed = JSON.parse(claudeConfigJson);
            if (typeof parsed !== 'object' || Array.isArray(parsed)) {
                setJsonEditorError('mcpServers must be an object');
                return;
            }
            setJsonEditorError(null);
        } catch (e) {
            setJsonEditorError(`Invalid JSON: ${e instanceof Error ? e.message : 'Parse error'}`);
            return;
        }

        try {
            const response = await fetch(`${getApiBaseUrl()}/api/claude-config/mcp-servers`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: claudeConfigJson })
            });
            if (response.ok) {
                setJsonEditorSaved(true);
                setJsonEditorError(null);
            } else {
                const error = await response.json();
                setJsonEditorError(error.error || 'Failed to save');
            }
        } catch (error) {
            console.error('Failed to save MCP servers config:', error);
            setJsonEditorError('Failed to save MCP servers config');
        }
    };

    const handleJsonChange = (value: string) => {
        setClaudeConfigJson(value);
        setJsonEditorSaved(false);
        // Validate JSON as user types
        try {
            const parsed = JSON.parse(value);
            if (typeof parsed !== 'object' || Array.isArray(parsed)) {
                setJsonEditorError('mcpServers must be an object');
            } else {
                setJsonEditorError(null);
            }
        } catch (e) {
            setJsonEditorError(`Invalid JSON: ${e instanceof Error ? e.message : 'Parse error'}`);
        }
    };

    const saveSkipPermissions = async (value: boolean) => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ skipPermissions: value })
            });
            if (response.ok) {
                setSkipPermissions(value);
            }
        } catch (error) {
            console.error('Failed to save skip permissions:', error);
        }
    };

    const saveRules = async () => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rules })
            });
            if (response.ok) {
                setRulesSaved(true);
            }
        } catch (error) {
            console.error('Failed to save rules:', error);
        }
    };

    const handleRulesChange = (value: string) => {
        setRules(value);
        setRulesSaved(false);
    };

    const saveSupervisorEnabled = async (value: boolean) => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ supervisorEnabled: value })
            });
            if (response.ok) {
                setSupervisorEnabled(value);
            }
        } catch (error) {
            console.error('Failed to save supervisor enabled:', error);
        }
    };

    const saveSupervisorPrompt = async () => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ supervisorSystemPrompt })
            });
            if (response.ok) {
                setSupervisorPromptSaved(true);
            }
        } catch (error) {
            console.error('Failed to save supervisor prompt:', error);
        }
    };

    const handleSupervisorPromptChange = (value: string) => {
        setSupervisorSystemPrompt(value);
        setSupervisorPromptSaved(false);
    };

    const handleAiCoreChange = (field: keyof AICoreCredentials, value: string | number) => {
        setAiCoreCredentials(prev => ({ ...prev, [field]: value }));
        setAiCoreSaved(false);
        setAiCoreTestStatus('idle');
    };

    const saveAiCoreCredentials = async () => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ aiCoreCredentials })
            });
            if (response.ok) {
                setAiCoreSaved(true);
            }
        } catch (error) {
            console.error('Failed to save AI Core credentials:', error);
        }
    };

    const testAiCoreCredentials = async () => {
        setAiCoreTestStatus('testing');
        setAiCoreTestMessage('Testing credentials...');
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/aicore/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(aiCoreCredentials)
            });
            const result = await response.json();
            if (response.ok && result.success) {
                setAiCoreTestStatus('success');
                setAiCoreTestMessage(result.message || 'Connection successful!');
            } else {
                setAiCoreTestStatus('error');
                setAiCoreTestMessage(result.error || 'Connection failed');
            }
        } catch (error) {
            setAiCoreTestStatus('error');
            setAiCoreTestMessage('Failed to test credentials');
        }
    };

    const clearAiCoreCredentials = async () => {
        const emptyCredentials: AICoreCredentials = {
            clientId: '',
            clientSecret: '',
            authUrl: '',
            baseUrl: '',
            resourceGroup: 'default',
            timeoutMs: 120000
        };
        setAiCoreCredentials(emptyCredentials);
        try {
            await fetch(`${getApiBaseUrl()}/api/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ aiCoreCredentials: undefined })
            });
            setAiCoreSaved(true);
            setAiCoreTestStatus('idle');
            setAiCoreTestMessage('');
        } catch (error) {
            console.error('Failed to clear AI Core credentials:', error);
        }
    };

    const saveAutoFocusOnInput = async (value: boolean) => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ autoFocusOnInput: value })
            });
            if (response.ok) {
                setAutoFocusOnInput(value);
            }
        } catch (error) {
            console.error('Failed to save auto focus setting:', error);
        }
    };

    const handleBackendChange = (newBackend: BackendType) => {
        setBackend(newBackend);
        setBackendSaved(false);
    };

    const saveBackend = async () => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ backend })
            });
            if (response.ok) {
                setBackendSaved(true);
                // Refresh backend status after save
                fetchBackendStatus();
            }
        } catch (error) {
            console.error('Failed to save backend:', error);
        }
    };

    const handleApiModeChange = (mode: ApiMode) => {
        setApiMode(mode);
        setApiModeSaved(false);
        // Reset test statuses when mode changes
        setCustomApiKeyTestStatus('idle');
        setCustomApiKeyTestMessage('');
        setAiCoreTestStatus('idle');
        setAiCoreTestMessage('');
    };

    const handleCustomApiKeyChange = (key: string) => {
        setCustomAnthropicApiKey(key);
        setApiModeSaved(false);
        setCustomApiKeyTestStatus('idle');
    };

    const saveApiMode = async () => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    apiMode,
                    customAnthropicApiKey: apiMode === 'custom-anthropic' ? customAnthropicApiKey : undefined
                })
            });
            if (response.ok) {
                setApiModeSaved(true);
            }
        } catch (error) {
            console.error('Failed to save API mode:', error);
        }
    };

    const testCustomApiKey = async () => {
        if (!customAnthropicApiKey) return;

        setCustomApiKeyTestStatus('testing');
        setCustomApiKeyTestMessage('Testing API key...');

        try {
            // Make a minimal request to Anthropic API to test the key
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': customAnthropicApiKey,
                    'anthropic-version': '2023-06-01',
                    'anthropic-dangerous-direct-browser-access': 'true'
                },
                body: JSON.stringify({
                    model: 'claude-3-haiku-20240307',
                    max_tokens: 1,
                    messages: [{ role: 'user', content: 'Hi' }]
                })
            });

            if (response.ok) {
                setCustomApiKeyTestStatus('success');
                setCustomApiKeyTestMessage('API key is valid!');
            } else {
                const error = await response.json().catch(() => ({}));
                setCustomApiKeyTestStatus('error');
                setCustomApiKeyTestMessage(error.error?.message || `Invalid API key (${response.status})`);
            }
        } catch (error) {
            setCustomApiKeyTestStatus('error');
            setCustomApiKeyTestMessage('Failed to test API key - check your network');
        }
    };

    const togglePanel = (panel: string) => {
        setExpandedPanels(prev => ({ ...prev, [panel]: !prev[panel] }));
    };

    const handleAddServer = () => {
        if (!newServer.name || !newServer.command) return;

        const server: MCPServer = {
            name: newServer.name,
            command: newServer.command,
            args: newServer.args ? newServer.args.split(' ').filter(a => a) : [],
            enabled: true
        };

        const updatedServers = [...mcpServers, server];
        saveMCPServers(updatedServers);
        setNewServer({ name: '', command: '', args: '' });
        setIsAddingServer(false);
    };

    const handleRemoveServer = (index: number) => {
        const updatedServers = mcpServers.filter((_, i) => i !== index);
        saveMCPServers(updatedServers);
    };

    const handleToggleServer = (index: number) => {
        const updatedServers = mcpServers.map((server, i) =>
            i === index ? { ...server, enabled: !server.enabled } : server
        );
        saveMCPServers(updatedServers);
    };

    if (!isOpen) return null;

    return (
        <div className="settings-menu-overlay" onClick={onClose}>
            <div className="settings-menu" onClick={(e) => e.stopPropagation()}>
                <div className="settings-menu-header">
                    <div className="settings-menu-title">
                        <Settings size={20} />
                        <h2>Settings</h2>
                    </div>
                    <button className="settings-menu-close" onClick={onClose}>
                        <X size={20} />
                    </button>
                </div>

                <div className="settings-menu-content">
                    <CollapsiblePanel
                        title="Sound"
                        icon={<Volume2 size={18} />}
                        isExpanded={expandedPanels.sound}
                        onToggle={() => togglePanel('sound')}
                    >
                        <VoiceSettingsContent />
                    </CollapsiblePanel>

                    <CollapsiblePanel
                        title="Behavior"
                        icon={<MousePointer size={18} />}
                        isExpanded={expandedPanels.behavior}
                        onToggle={() => togglePanel('behavior')}
                    >
                        <div className="permissions-content">
                            <div className="permission-item">
                                <div className="permission-info">
                                    <span className="permission-label">Auto-focus on Input</span>
                                    <span className="permission-description">
                                        Automatically switch to a task when it asks a question or needs input.
                                    </span>
                                </div>
                                <label className="toggle-switch">
                                    <input
                                        type="checkbox"
                                        checked={autoFocusOnInput}
                                        onChange={(e) => saveAutoFocusOnInput(e.target.checked)}
                                    />
                                    <span className="toggle-slider"></span>
                                </label>
                            </div>
                            <div className="permission-item">
                                <div className="permission-info">
                                    <span className="permission-label">Show System Stats</span>
                                    <span className="permission-description">
                                        Display CPU and memory usage in the header.
                                    </span>
                                </div>
                                <label className="toggle-switch">
                                    <input
                                        type="checkbox"
                                        checked={showSystemStats}
                                        onChange={(e) => setShowSystemStats(e.target.checked)}
                                    />
                                    <span className="toggle-slider"></span>
                                </label>
                            </div>
                        </div>
                    </CollapsiblePanel>

                    <CollapsiblePanel
                        title="AI Backend"
                        icon={<Terminal size={18} />}
                        isExpanded={expandedPanels.backend}
                        onToggle={() => togglePanel('backend')}
                    >
                        <div className="api-config-content">
                            <p className="api-config-description">
                                Choose which AI coding assistant to use.
                            </p>

                            <div className="api-mode-selector">
                                <label className={`api-mode-option ${backend === 'claude-code' ? 'selected' : ''}`}>
                                    <input
                                        type="radio"
                                        name="backend"
                                        value="claude-code"
                                        checked={backend === 'claude-code'}
                                        onChange={() => handleBackendChange('claude-code')}
                                    />
                                    <div className="api-mode-content">
                                        <span className="api-mode-title">Claude Code</span>
                                        <span className="api-mode-description">
                                            Anthropic's official CLI tool for Claude
                                        </span>
                                    </div>
                                </label>

                                <label className={`api-mode-option ${backend === 'opencode' ? 'selected' : ''}`}>
                                    <input
                                        type="radio"
                                        name="backend"
                                        value="opencode"
                                        checked={backend === 'opencode'}
                                        onChange={() => handleBackendChange('opencode')}
                                    />
                                    <div className="api-mode-content">
                                        <span className="api-mode-title">OpenCode</span>
                                        <span className="api-mode-description">
                                            Open-source AI coding agent by SST
                                        </span>
                                    </div>
                                </label>
                            </div>

                            {/* Backend status */}
                            {backendStatusLoading ? (
                                <div className="backend-status loading">
                                    <Loader2 size={16} className="spinning" />
                                    <span>Checking backend status...</span>
                                </div>
                            ) : backendStatus && (
                                <div className={`backend-status ${backendStatus.installed ? 'installed' : 'not-installed'}`}>
                                    {backendStatus.installed ? (
                                        <>
                                            <CheckCircle size={16} />
                                            <span>
                                                {backendStatus.version}
                                                {backendStatus.serverRunning !== undefined && (
                                                    backendStatus.serverRunning
                                                        ? ' (server running)'
                                                        : ' (server not running)'
                                                )}
                                            </span>
                                        </>
                                    ) : (
                                        <>
                                            <AlertCircle size={16} />
                                            <span>{backendStatus.error}</span>
                                        </>
                                    )}
                                </div>
                            )}

                            <div className="api-mode-actions">
                                <span className={`api-mode-status ${backendSaved ? 'saved' : 'unsaved'}`}>
                                    {backendSaved ? 'Saved' : 'Unsaved changes'}
                                </span>
                                <button
                                    className="aicore-save-btn"
                                    onClick={saveBackend}
                                    disabled={backendSaved}
                                >
                                    Save Backend
                                </button>
                            </div>

                            <p className="api-config-note">
                                Note: Changing backends requires restarting tasks. Existing tasks will continue with their original backend.
                            </p>
                        </div>
                    </CollapsiblePanel>

                    <CollapsiblePanel
                        title="API Configuration"
                        icon={<Key size={18} />}
                        isExpanded={expandedPanels.api}
                        onToggle={() => togglePanel('api')}
                    >
                        <div className="api-config-content">
                            <p className="api-config-description">
                                Choose how Claude Code connects to Claude models.
                            </p>

                            <div className="api-mode-selector">
                                <label className={`api-mode-option ${apiMode === 'default' ? 'selected' : ''}`}>
                                    <input
                                        type="radio"
                                        name="apiMode"
                                        value="default"
                                        checked={apiMode === 'default'}
                                        onChange={() => handleApiModeChange('default')}
                                    />
                                    <div className="api-mode-content">
                                        <span className="api-mode-title">Default Claude Code</span>
                                        <span className="api-mode-description">
                                            Use your existing Claude Code subscription (requires claude login)
                                        </span>
                                    </div>
                                </label>

                                <label className={`api-mode-option ${apiMode === 'custom-anthropic' ? 'selected' : ''}`}>
                                    <input
                                        type="radio"
                                        name="apiMode"
                                        value="custom-anthropic"
                                        checked={apiMode === 'custom-anthropic'}
                                        onChange={() => handleApiModeChange('custom-anthropic')}
                                    />
                                    <div className="api-mode-content">
                                        <span className="api-mode-title">Custom Anthropic API Key</span>
                                        <span className="api-mode-description">
                                            Use your own Anthropic API key (pay per use)
                                        </span>
                                    </div>
                                </label>

                                <label className={`api-mode-option ${apiMode === 'sap-ai-core' ? 'selected' : ''}`}>
                                    <input
                                        type="radio"
                                        name="apiMode"
                                        value="sap-ai-core"
                                        checked={apiMode === 'sap-ai-core'}
                                        onChange={() => handleApiModeChange('sap-ai-core')}
                                    />
                                    <div className="api-mode-content">
                                        <span className="api-mode-title">SAP AI Core</span>
                                        <span className="api-mode-description">
                                            Use Claude models through your SAP AI Core deployment
                                        </span>
                                    </div>
                                </label>
                            </div>

                            {/* Custom Anthropic API Key fields */}
                            {apiMode === 'custom-anthropic' && (
                                <div className="api-mode-fields">
                                    <div className="aicore-field">
                                        <label>Anthropic API Key</label>
                                        <input
                                            type="password"
                                            value={customAnthropicApiKey}
                                            onChange={(e) => handleCustomApiKeyChange(e.target.value)}
                                            placeholder="sk-ant-api03-..."
                                            className="aicore-input"
                                        />
                                    </div>

                                    {customApiKeyTestStatus !== 'idle' && (
                                        <div className={`aicore-test-result ${customApiKeyTestStatus}`}>
                                            {customApiKeyTestStatus === 'testing' && <Loader2 size={16} className="spinning" />}
                                            {customApiKeyTestStatus === 'success' && <CheckCircle size={16} />}
                                            {customApiKeyTestStatus === 'error' && <AlertCircle size={16} />}
                                            <span>{customApiKeyTestMessage}</span>
                                        </div>
                                    )}

                                    <div className="aicore-buttons">
                                        <button
                                            className="aicore-test-btn"
                                            onClick={testCustomApiKey}
                                            disabled={!customAnthropicApiKey || customApiKeyTestStatus === 'testing'}
                                        >
                                            {customApiKeyTestStatus === 'testing' ? 'Testing...' : 'Test API Key'}
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* SAP AI Core fields */}
                            {apiMode === 'sap-ai-core' && (
                                <div className="api-mode-fields">
                                    <div className="aicore-form">
                                        <div className="aicore-field">
                                            <label>Client ID</label>
                                            <input
                                                type="text"
                                                value={aiCoreCredentials.clientId}
                                                onChange={(e) => handleAiCoreChange('clientId', e.target.value)}
                                                placeholder="sb-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx!..."
                                                className="aicore-input"
                                            />
                                        </div>

                                        <div className="aicore-field">
                                            <label>Client Secret</label>
                                            <input
                                                type="password"
                                                value={aiCoreCredentials.clientSecret}
                                                onChange={(e) => handleAiCoreChange('clientSecret', e.target.value)}
                                                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx$..."
                                                className="aicore-input"
                                            />
                                        </div>

                                        <div className="aicore-field">
                                            <label>Auth URL</label>
                                            <input
                                                type="text"
                                                value={aiCoreCredentials.authUrl}
                                                onChange={(e) => handleAiCoreChange('authUrl', e.target.value)}
                                                placeholder="https://xxx.authentication.sap.hana.ondemand.com"
                                                className="aicore-input"
                                            />
                                        </div>

                                        <div className="aicore-field">
                                            <label>Base URL</label>
                                            <input
                                                type="text"
                                                value={aiCoreCredentials.baseUrl}
                                                onChange={(e) => handleAiCoreChange('baseUrl', e.target.value)}
                                                placeholder="https://api.ai.xxx.aws.ml.hana.ondemand.com"
                                                className="aicore-input"
                                            />
                                        </div>

                                        <div className="aicore-row">
                                            <div className="aicore-field aicore-field-half">
                                                <label>Resource Group</label>
                                                <input
                                                    type="text"
                                                    value={aiCoreCredentials.resourceGroup}
                                                    onChange={(e) => handleAiCoreChange('resourceGroup', e.target.value)}
                                                    placeholder="default"
                                                    className="aicore-input"
                                                />
                                            </div>

                                            <div className="aicore-field aicore-field-half">
                                                <label>Timeout (ms)</label>
                                                <input
                                                    type="number"
                                                    value={aiCoreCredentials.timeoutMs}
                                                    onChange={(e) => handleAiCoreChange('timeoutMs', parseInt(e.target.value) || 120000)}
                                                    placeholder="120000"
                                                    className="aicore-input"
                                                />
                                            </div>
                                        </div>
                                    </div>

                                    {aiCoreTestStatus !== 'idle' && (
                                        <div className={`aicore-test-result ${aiCoreTestStatus}`}>
                                            {aiCoreTestStatus === 'testing' && <Loader2 size={16} className="spinning" />}
                                            {aiCoreTestStatus === 'success' && <CheckCircle size={16} />}
                                            {aiCoreTestStatus === 'error' && <AlertCircle size={16} />}
                                            <span>{aiCoreTestMessage}</span>
                                        </div>
                                    )}

                                    <div className="aicore-buttons" style={{ marginBottom: '8px' }}>
                                        <button
                                            className="aicore-clear-btn"
                                            onClick={clearAiCoreCredentials}
                                            disabled={!aiCoreCredentials.clientId && !aiCoreCredentials.clientSecret}
                                        >
                                            Clear
                                        </button>
                                        <button
                                            className="aicore-test-btn"
                                            onClick={testAiCoreCredentials}
                                            disabled={!aiCoreCredentials.clientId || !aiCoreCredentials.clientSecret || aiCoreTestStatus === 'testing'}
                                        >
                                            {aiCoreTestStatus === 'testing' ? 'Testing...' : 'Test Connection'}
                                        </button>
                                        <button
                                            className="aicore-save-btn"
                                            onClick={saveAiCoreCredentials}
                                            disabled={aiCoreSaved}
                                        >
                                            Save Credentials
                                        </button>
                                    </div>
                                </div>
                            )}

                            <div className="api-mode-actions">
                                <span className={`api-mode-status ${apiModeSaved ? 'saved' : 'unsaved'}`}>
                                    {apiModeSaved ? 'Saved' : 'Unsaved changes'}
                                </span>
                                <button
                                    className="aicore-save-btn"
                                    onClick={saveApiMode}
                                    disabled={apiModeSaved}
                                >
                                    Save Mode
                                </button>
                            </div>

                            <p className="api-config-note">
                                Note: The server must be restarted after changing API mode for the changes to take effect on new tasks.
                            </p>
                        </div>
                    </CollapsiblePanel>

                    <CollapsiblePanel
                        title="MCP Servers"
                        icon={<Server size={18} />}
                        isExpanded={expandedPanels.mcp}
                        onToggle={() => togglePanel('mcp')}
                    >
                        <div className="mcp-servers-content">
                            {/* View mode toggle */}
                            <div className="mcp-view-toggle">
                                <button
                                    className={`mcp-view-btn ${mcpViewMode === 'list' ? 'active' : ''}`}
                                    onClick={() => setMcpViewMode('list')}
                                    title="List View"
                                >
                                    <Eye size={14} />
                                    <span>List</span>
                                </button>
                                <button
                                    className={`mcp-view-btn ${mcpViewMode === 'json' ? 'active' : ''}`}
                                    onClick={() => setMcpViewMode('json')}
                                    title="Edit JSON directly"
                                >
                                    <Code size={14} />
                                    <span>JSON</span>
                                </button>
                            </div>

                            {mcpViewMode === 'json' ? (
                                /* JSON Editor View */
                                <div className="mcp-json-editor">
                                    <p className="mcp-json-path">
                                        Editing <code>mcpServers</code> in <code>{claudeConfigPath || '~/.claude.json'}</code>
                                    </p>
                                    <textarea
                                        className={`mcp-json-textarea ${jsonEditorError ? 'error' : ''}`}
                                        value={claudeConfigJson}
                                        onChange={(e) => handleJsonChange(e.target.value)}
                                        placeholder="Loading..."
                                        spellCheck={false}
                                    />
                                    {jsonEditorError && (
                                        <div className="mcp-json-error">
                                            <AlertCircle size={14} />
                                            <span>{jsonEditorError}</span>
                                        </div>
                                    )}
                                    <div className="mcp-json-actions">
                                        <span className={`mcp-json-status ${jsonEditorSaved ? 'saved' : 'unsaved'}`}>
                                            {jsonEditorSaved ? 'Saved' : 'Unsaved changes'}
                                        </span>
                                        <button
                                            className="mcp-json-save-btn"
                                            onClick={saveClaudeConfig}
                                            disabled={jsonEditorSaved || !!jsonEditorError}
                                        >
                                            Save
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                /* List View */
                                <>
                                    {mcpServers.length === 0 ? (
                                        <p className="mcp-empty-state">No MCP servers configured</p>
                                    ) : (
                                        <div className="mcp-server-list">
                                            {mcpServers.map((server, index) => (
                                                <div key={index} className={`mcp-server-item ${!server.enabled ? 'disabled' : ''}`}>
                                                    <div className="mcp-server-info">
                                                        <span className="mcp-server-name">{server.name}</span>
                                                        <span className="mcp-server-command">
                                                            {server.command} {server.args?.join(' ')}
                                                        </span>
                                                    </div>
                                                    <div className="mcp-server-actions">
                                                        <button
                                                            className={`mcp-toggle-btn ${server.enabled ? 'enabled' : ''}`}
                                                            onClick={() => handleToggleServer(index)}
                                                            title={server.enabled ? 'Disable' : 'Enable'}
                                                        >
                                                            {server.enabled ? <Power size={16} /> : <PowerOff size={16} />}
                                                        </button>
                                                        <button
                                                            className="mcp-delete-btn"
                                                            onClick={() => handleRemoveServer(index)}
                                                            title="Remove"
                                                        >
                                                            <Trash2 size={16} />
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}

                                    {isAddingServer ? (
                                        <div className="mcp-add-form">
                                            <input
                                                type="text"
                                                placeholder="Server name"
                                                value={newServer.name}
                                                onChange={(e) => setNewServer(prev => ({ ...prev, name: e.target.value }))}
                                                className="mcp-input"
                                            />
                                            <input
                                                type="text"
                                                placeholder="Command (e.g., npx)"
                                                value={newServer.command}
                                                onChange={(e) => setNewServer(prev => ({ ...prev, command: e.target.value }))}
                                                className="mcp-input"
                                            />
                                            <input
                                                type="text"
                                                placeholder="Arguments (space-separated)"
                                                value={newServer.args}
                                                onChange={(e) => setNewServer(prev => ({ ...prev, args: e.target.value }))}
                                                className="mcp-input"
                                            />
                                            <div className="mcp-add-form-actions">
                                                <button
                                                    className="mcp-cancel-btn"
                                                    onClick={() => {
                                                        setIsAddingServer(false);
                                                        setNewServer({ name: '', command: '', args: '' });
                                                    }}
                                                >
                                                    Cancel
                                                </button>
                                                <button
                                                    className="mcp-save-btn"
                                                    onClick={handleAddServer}
                                                    disabled={!newServer.name || !newServer.command}
                                                >
                                                    Add Server
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <button
                                            className="mcp-add-btn"
                                            onClick={() => setIsAddingServer(true)}
                                        >
                                            <Plus size={16} />
                                            Add MCP Server
                                        </button>
                                    )}
                                </>
                            )}
                        </div>
                    </CollapsiblePanel>

                    <CollapsiblePanel
                        title="Permissions"
                        icon={<Shield size={18} />}
                        isExpanded={expandedPanels.permissions}
                        onToggle={() => togglePanel('permissions')}
                    >
                        <div className="permissions-content">
                            <div className="permission-item">
                                <div className="permission-info">
                                    <span className="permission-label">Skip Permissions</span>
                                    <span className="permission-description">
                                        Automatically approve all Claude actions without prompts.
                                        Use with caution - only enable in trusted environments.
                                    </span>
                                </div>
                                <label className="toggle-switch">
                                    <input
                                        type="checkbox"
                                        checked={skipPermissions}
                                        onChange={(e) => saveSkipPermissions(e.target.checked)}
                                    />
                                    <span className="toggle-slider"></span>
                                </label>
                            </div>
                            {skipPermissions && (
                                <div className="permission-warning">
                                    Warning: Claude can execute any command without confirmation.
                                    Only enable in secure, sandboxed environments.
                                </div>
                            )}
                        </div>
                    </CollapsiblePanel>

                    <CollapsiblePanel
                        title="Rules"
                        icon={<FileText size={18} />}
                        isExpanded={expandedPanels.rules}
                        onToggle={() => togglePanel('rules')}
                    >
                        <div className="rules-content">
                            <p className="rules-description">
                                Add custom rules for Claude. These will be added to CLAUDE.md in all workspaces.
                            </p>
                            <textarea
                                className="rules-textarea"
                                value={rules}
                                onChange={(e) => handleRulesChange(e.target.value)}
                                placeholder="Enter rules in markdown format...&#10;&#10;Example:&#10;- Always use TypeScript&#10;- Prefer functional components&#10;- Add error handling to API calls"
                                rows={8}
                            />
                            <div className="rules-actions">
                                <span className={`rules-status ${rulesSaved ? 'saved' : 'unsaved'}`}>
                                    {rulesSaved ? 'Saved' : 'Unsaved changes'}
                                </span>
                                <button
                                    className="rules-save-btn"
                                    onClick={saveRules}
                                    disabled={rulesSaved}
                                >
                                    Save Rules
                                </button>
                            </div>
                        </div>
                    </CollapsiblePanel>

                    <CollapsiblePanel
                        title="AI Supervisor"
                        icon={<Bot size={18} />}
                        isExpanded={expandedPanels.supervisor}
                        onToggle={() => togglePanel('supervisor')}
                    >
                        <div className="supervisor-content">
                            <div className="supervisor-toggle-item">
                                <div className="supervisor-toggle-info">
                                    <span className="supervisor-toggle-label">Enable AI Supervisor</span>
                                    <span className="supervisor-toggle-description">
                                        When enabled, the AI will automatically analyze tasks when they complete
                                        and provide feedback in the Chat panel.
                                    </span>
                                </div>
                                <label className="toggle-switch">
                                    <input
                                        type="checkbox"
                                        checked={supervisorEnabled}
                                        onChange={(e) => saveSupervisorEnabled(e.target.checked)}
                                    />
                                    <span className="toggle-slider"></span>
                                </label>
                            </div>

                            {supervisorEnabled && (
                                <>
                                    <div className="supervisor-prompt-section">
                                        <p className="supervisor-description">
                                            Configure how the AI supervisor analyzes completed tasks.
                                            This prompt guides the supervisor when tasks finish.
                                        </p>
                                        <textarea
                                            className="supervisor-textarea"
                                            value={supervisorSystemPrompt}
                                            onChange={(e) => handleSupervisorPromptChange(e.target.value)}
                                            placeholder="Enter system prompt for the AI supervisor...&#10;&#10;Example:&#10;Make sure tasks complete without errors and are tested."
                                            rows={10}
                                        />
                                        <div className="supervisor-actions">
                                            <span className={`supervisor-status ${supervisorPromptSaved ? 'saved' : 'unsaved'}`}>
                                                {supervisorPromptSaved ? 'Saved' : 'Unsaved changes'}
                                            </span>
                                            <button
                                                className="supervisor-save-btn"
                                                onClick={saveSupervisorPrompt}
                                                disabled={supervisorPromptSaved}
                                            >
                                                Save Prompt
                                            </button>
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>
                    </CollapsiblePanel>

                </div>
            </div>
        </div>
    );
}
