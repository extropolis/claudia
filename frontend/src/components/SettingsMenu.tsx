import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { X, Settings, Volume2, Server, ChevronDown, ChevronRight, Plus, Trash2, Shield, FileText, Bot, MousePointer, CheckCircle, AlertCircle, Loader2, Key, Code, Eye, Terminal, Brain, Zap } from 'lucide-react';
import { VoiceSettingsContent } from './VoiceSettingsContent';
import { getApiBaseUrl } from '../config/api-config';
import { useTaskStore } from '../stores/taskStore';
import { useNotification } from './NotificationContainer';
import './SettingsMenu.css';

interface SettingsMenuProps {
    isOpen: boolean;
    onClose: () => void;
    initialPanel?: string;
}

interface MCPServerListItem {
    name: string;
    type?: 'stdio' | 'http' | 'streamableHttp';
    command?: string;
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
}

type ApiMode = 'default' | 'custom-anthropic';
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
    const { showWarning } = useNotification();
    const [expandedPanels, setExpandedPanels] = useState<Record<string, boolean>>({
        sound: false,
        behavior: false,
        backend: false,
        api: false,
        mcp: false,
        permissions: false,
        cliSwitches: false,
        rules: false,
        supervisor: false,
        learnings: false
    });

    // Handle initial panel expansion when settings opens
    useEffect(() => {
        if (isOpen && initialPanel) {
            setExpandedPanels(prev => ({ ...prev, [initialPanel]: true }));
        }
    }, [isOpen, initialPanel]);

    const [isAddingServer, setIsAddingServer] = useState(false);
    const [newServer, setNewServer] = useState({ name: '', type: 'stdio' as 'stdio' | 'http' | 'streamableHttp', command: '', args: '', url: '', headers: '' });

    // MCP test connection state
    const [mcpTestStatus, setMcpTestStatus] = useState<Record<string, 'idle' | 'testing' | 'success' | 'error'>>({});
    const [mcpTestMessages, setMcpTestMessages] = useState<Record<string, string>>({});

    // JSON editor state
    const [mcpViewMode, setMcpViewMode] = useState<'list' | 'json'>('list');
    const [mcpJson, setMcpJson] = useState('');
    const [claudeConfigPath, setClaudeConfigPath] = useState('');
    const [jsonEditorError, setJsonEditorError] = useState<string | null>(null);
    const [skipPermissions, setSkipPermissions] = useState(false);
    const [rules, setRules] = useState('');
    const [supervisorEnabled, setSupervisorEnabled] = useState(false);
    const [supervisorSystemPrompt, setSupervisorSystemPrompt] = useState('');
    const [autoFocusOnInput, setAutoFocusOnInput] = useState(false);
    const [useLearnings, setUseLearnings] = useState(false);

    // CLI Switches state
    const [cliSwitches, setCliSwitches] = useState({
        verbose: false,
        maxTurns: null as number | null,
        maxBudgetUsd: null as number | null,
        permissionMode: null as string | null,
        allowedTools: '',
        disallowedTools: '',
        appendSystemPrompt: ''
    });
    const cliSwitchesTimerRef = useRef<NodeJS.Timeout | null>(null);

    // Debounce timers
    const rulesTimerRef = useRef<NodeJS.Timeout | null>(null);
    const supervisorPromptTimerRef = useRef<NodeJS.Timeout | null>(null);
    const mcpJsonTimerRef = useRef<NodeJS.Timeout | null>(null);

    // API Mode state
    const [apiMode, setApiMode] = useState<ApiMode>('default');
    const [customAnthropicApiKey, setCustomAnthropicApiKey] = useState('');

    // Custom API key test state
    const [customApiKeyTestStatus, setCustomApiKeyTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
    const [customApiKeyTestMessage, setCustomApiKeyTestMessage] = useState('');

    // Backend state
    const [backend, setBackend] = useState<BackendType>('claude-code');
    const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(null);
    const [backendStatusLoading, setBackendStatusLoading] = useState(false);

    // Debounce timers for API settings
    const apiModeTimerRef = useRef<NodeJS.Timeout | null>(null);

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

    // Fetch Claude config when MCP panel is expanded (needed for both list and JSON view)
    useEffect(() => {
        if (expandedPanels.mcp) {
            fetchClaudeConfig();
        }
    }, [expandedPanels.mcp]);

    const fetchConfig = async () => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/config`);
            if (response.ok) {
                const config = await response.json();
                setSkipPermissions(config.skipPermissions || false);
                setRules(config.rules || '');
                setSupervisorEnabled(config.supervisorEnabled || false);
                setSupervisorSystemPrompt(config.supervisorSystemPrompt || '');
                setAutoFocusOnInput(config.autoFocusOnInput || false);
                setApiMode(config.apiMode || 'default');
                setCustomAnthropicApiKey(config.customAnthropicApiKey || '');
                setBackend(config.backend || 'claude-code');
                setUseLearnings(config.useLearnings || false);
                if (config.claudeCodeSwitches) {
                    setCliSwitches({
                        verbose: config.claudeCodeSwitches.verbose || false,
                        maxTurns: config.claudeCodeSwitches.maxTurns ?? null,
                        maxBudgetUsd: config.claudeCodeSwitches.maxBudgetUsd ?? null,
                        permissionMode: config.claudeCodeSwitches.permissionMode ?? null,
                        allowedTools: config.claudeCodeSwitches.allowedTools || '',
                        disallowedTools: config.claudeCodeSwitches.disallowedTools || '',
                        appendSystemPrompt: config.claudeCodeSwitches.appendSystemPrompt || ''
                    });
                }
            }
        } catch (error) {
            console.error('Failed to fetch config:', error);
        }
    };

    const fetchBackendStatus = useCallback(async () => {
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
    }, []);

    // Backend config uses array format, but we display as object format in JSON view
    // Convert between formats as needed
    const arrayToObjectFormat = useCallback((servers: Array<{ name: string; type?: string; command?: string; args?: string[]; url?: string; env?: Record<string, string>; enabled?: boolean; timeout?: number; autoApprove?: string[]; description?: string }>) => {
        const obj: Record<string, unknown> = {};
        for (const server of servers) {
            const { name, enabled, ...rest } = server;
            obj[name] = rest;
        }
        return obj;
    }, []);

    const objectToArrayFormat = useCallback((obj: Record<string, unknown>) => {
        const servers: Array<{ name: string; type?: 'stdio' | 'http' | 'streamableHttp'; command?: string; args?: string[]; url?: string; env?: Record<string, string>; enabled: boolean; timeout?: number; autoApprove?: string[]; description?: string; headers?: Record<string, string> }> = [];
        for (const [name, config] of Object.entries(obj)) {
            const serverConfig = config as Record<string, unknown>;
            servers.push({
                name,
                enabled: true, // Default to enabled
                type: (serverConfig.type as 'stdio' | 'http' | 'streamableHttp') || 'stdio',
                command: serverConfig.command as string | undefined,
                args: serverConfig.args as string[] | undefined,
                url: serverConfig.url as string | undefined,
                env: serverConfig.env as Record<string, string> | undefined,
                timeout: serverConfig.timeout as number | undefined,
                autoApprove: serverConfig.autoApprove as string[] | undefined,
                description: serverConfig.description as string | undefined
            });
        }
        return servers;
    }, []);

    // Compute MCP servers list from JSON state (for list view)
    const mcpServersList: MCPServerListItem[] = useMemo(() => {
        const servers: MCPServerListItem[] = [];

        try {
            const parsedServers = JSON.parse(mcpJson || '{}');
            for (const [name, config] of Object.entries(parsedServers)) {
                const serverConfig = config as { type?: 'stdio' | 'http' | 'streamableHttp'; command?: string; args?: string[]; url?: string; headers?: Record<string, string> };
                servers.push({
                    name,
                    type: serverConfig.type || 'stdio',
                    command: serverConfig.command || '',
                    args: serverConfig.args || [],
                    url: serverConfig.url || ''
                });
            }
        } catch {
            // Invalid JSON, ignore
        }

        return servers;
    }, [mcpJson]);

    const fetchClaudeConfig = useCallback(async () => {
        try {
            // Fetch from Claudia's config (backend/config.json) - this is what tasks actually use
            const response = await fetch(`${getApiBaseUrl()}/api/config`);
            if (response.ok) {
                const config = await response.json();
                const mcpServers = config.mcpServers || [];
                // Convert array format to object format for display
                const obj = arrayToObjectFormat(mcpServers);
                setMcpJson(JSON.stringify(obj, null, 2));
                setClaudeConfigPath('Claudia config (used by tasks)');
                setJsonEditorError(null);
            }
        } catch (error) {
            console.error('Failed to fetch MCP servers config:', error);
            setJsonEditorError('Failed to load MCP servers config');
        }
    }, [arrayToObjectFormat]);

    const saveClaudeConfig = useCallback(async (jsonStr: string) => {
        // Validate JSON config before saving
        let parsed;
        try {
            parsed = JSON.parse(jsonStr);
            if (typeof parsed !== 'object' || Array.isArray(parsed)) {
                setJsonEditorError('mcpServers must be an object');
                return;
            }
        } catch (e) {
            setJsonEditorError(`Invalid JSON: ${e instanceof Error ? e.message : 'Parse error'}`);
            return;
        }

        setJsonEditorError(null);

        // Convert object format back to array format for backend
        const serversArray = objectToArrayFormat(parsed);

        try {
            const response = await fetch(`${getApiBaseUrl()}/api/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mcpServers: serversArray })
            });
            if (response.ok) {
                setJsonEditorError(null);
            } else {
                const error = await response.json();
                setJsonEditorError(error.error || 'Failed to save');
            }
        } catch (error) {
            console.error('Failed to save MCP servers config:', error);
            setJsonEditorError('Failed to save MCP servers config');
        }
    }, [objectToArrayFormat]);

    const handleJsonChange = (value: string) => {
        setMcpJson(value);

        // Validate JSON as user types
        try {
            const parsed = JSON.parse(value);
            if (typeof parsed !== 'object' || Array.isArray(parsed)) {
                setJsonEditorError('mcpServers must be an object');
                return; // Don't save if invalid
            } else {
                setJsonEditorError(null);
            }
        } catch (e) {
            setJsonEditorError(`Invalid JSON: ${e instanceof Error ? e.message : 'Parse error'}`);
            return; // Don't save if invalid
        }

        // Auto-save with debounce (only if valid JSON)
        if (mcpJsonTimerRef.current) {
            clearTimeout(mcpJsonTimerRef.current);
        }
        mcpJsonTimerRef.current = setTimeout(() => {
            saveClaudeConfig(value);
        }, 1000);
    };

    const testMcpConnection = useCallback(async (server: MCPServerListItem) => {
        setMcpTestStatus(prev => ({ ...prev, [server.name]: 'testing' }));
        setMcpTestMessages(prev => ({ ...prev, [server.name]: '' }));

        try {
            const serverConfig = {
                name: server.name,
                type: server.type || 'stdio',
                command: server.command,
                args: server.args,
                url: server.url,
                headers: server.headers
            };

            const response = await fetch(`${getApiBaseUrl()}/api/mcp/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ server: serverConfig })
            });

            const result = await response.json();

            if (result.success) {
                setMcpTestStatus(prev => ({ ...prev, [server.name]: 'success' }));
                setMcpTestMessages(prev => ({ ...prev, [server.name]: result.message || 'Connected' }));
                // Reset status after 5 seconds
                setTimeout(() => {
                    setMcpTestStatus(prev => ({ ...prev, [server.name]: 'idle' }));
                }, 5000);
            } else {
                setMcpTestStatus(prev => ({ ...prev, [server.name]: 'error' }));
                setMcpTestMessages(prev => ({ ...prev, [server.name]: result.error || 'Connection failed' }));
                // Reset status after 8 seconds
                setTimeout(() => {
                    setMcpTestStatus(prev => ({ ...prev, [server.name]: 'idle' }));
                }, 8000);
            }
        } catch (error) {
            console.error('Failed to test MCP connection:', error);
            setMcpTestStatus(prev => ({ ...prev, [server.name]: 'error' }));
            setMcpTestMessages(prev => ({ ...prev, [server.name]: 'Failed to test connection' }));
            setTimeout(() => {
                setMcpTestStatus(prev => ({ ...prev, [server.name]: 'idle' }));
            }, 8000);
        }
    }, []);

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

    const saveRules = useCallback(async (rulesText: string) => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rules: rulesText })
            });
            if (!response.ok) {
                console.error('Failed to save rules');
            }
        } catch (error) {
            console.error('Failed to save rules:', error);
        }
    }, []);

    const handleRulesChange = (value: string) => {
        setRules(value);

        // Auto-save with debounce
        if (rulesTimerRef.current) {
            clearTimeout(rulesTimerRef.current);
        }
        rulesTimerRef.current = setTimeout(() => {
            saveRules(value);
        }, 1000);
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

    const saveSupervisorPrompt = useCallback(async (promptText: string) => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ supervisorSystemPrompt: promptText })
            });
            if (!response.ok) {
                console.error('Failed to save supervisor prompt');
            }
        } catch (error) {
            console.error('Failed to save supervisor prompt:', error);
        }
    }, []);

    const handleSupervisorPromptChange = (value: string) => {
        setSupervisorSystemPrompt(value);

        // Auto-save with debounce
        if (supervisorPromptTimerRef.current) {
            clearTimeout(supervisorPromptTimerRef.current);
        }
        supervisorPromptTimerRef.current = setTimeout(() => {
            saveSupervisorPrompt(value);
        }, 1000);
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

    const saveUseLearnings = async (value: boolean) => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ useLearnings: value })
            });
            if (response.ok) {
                setUseLearnings(value);
            }
        } catch (error) {
            console.error('Failed to save use learnings setting:', error);
        }
    };

    const saveCliSwitches = useCallback(async (switches: typeof cliSwitches) => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ claudeCodeSwitches: switches })
            });
            if (!response.ok) {
                console.error('Failed to save CLI switches');
            }
        } catch (error) {
            console.error('Failed to save CLI switches:', error);
        }
    }, []);

    const handleCliSwitchChange = useCallback((updates: Partial<typeof cliSwitches>) => {
        setCliSwitches(prev => {
            const updated = { ...prev, ...updates };
            // Debounce the save for text fields
            if (cliSwitchesTimerRef.current) {
                clearTimeout(cliSwitchesTimerRef.current);
            }
            cliSwitchesTimerRef.current = setTimeout(() => {
                saveCliSwitches(updated);
            }, 500);
            return updated;
        });
    }, [saveCliSwitches]);

    const handleCliSwitchToggle = useCallback((updates: Partial<typeof cliSwitches>) => {
        setCliSwitches(prev => {
            const updated = { ...prev, ...updates };
            // Save immediately for toggles
            saveCliSwitches(updated);
            return updated;
        });
    }, [saveCliSwitches]);

    const saveBackend = useCallback(async (backendType: BackendType) => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ backend: backendType })
            });
            if (response.ok) {
                // Refresh backend status after save
                fetchBackendStatus();
            }
        } catch (error) {
            console.error('Failed to save backend:', error);
        }
    }, [fetchBackendStatus]);

    const handleBackendChange = (newBackend: BackendType) => {
        setBackend(newBackend);
        // Save immediately for radio buttons
        saveBackend(newBackend);
    };

    const saveApiMode = useCallback(async (mode: ApiMode, apiKey: string) => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    apiMode: mode,
                    customAnthropicApiKey: mode === 'custom-anthropic' ? apiKey : undefined
                })
            });
            if (!response.ok) {
                console.error('Failed to save API mode');
            } else {
                showWarning('API Configuration Changed', 'This change only applies to new tasks. Running tasks will continue using their original configuration.');
            }
        } catch (error) {
            console.error('Failed to save API mode:', error);
        }
    }, [showWarning]);

    const handleApiModeChange = (mode: ApiMode) => {
        setApiMode(mode);
        // Reset test statuses when mode changes
        setCustomApiKeyTestStatus('idle');
        setCustomApiKeyTestMessage('');

        // Save immediately for radio buttons
        saveApiMode(mode, customAnthropicApiKey);
    };

    const handleCustomApiKeyChange = (key: string) => {
        setCustomAnthropicApiKey(key);
        setCustomApiKeyTestStatus('idle');

        // Auto-save with debounce
        if (apiModeTimerRef.current) {
            clearTimeout(apiModeTimerRef.current);
        }
        apiModeTimerRef.current = setTimeout(() => {
            saveApiMode(apiMode, key);
        }, 1000);
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

    const handleAddServer = async () => {
        // Validate based on server type
        if (!newServer.name) return;
        if (newServer.type === 'streamableHttp' && !newServer.url) return;
        if (newServer.type === 'stdio' && !newServer.command) return;

        try {
            const servers = JSON.parse(mcpJson || '{}');

            // Add the new server based on type
            if (newServer.type === 'streamableHttp') {
                servers[newServer.name] = {
                    type: 'streamableHttp',
                    url: newServer.url
                };
            } else {
                servers[newServer.name] = {
                    command: newServer.command,
                    args: newServer.args ? newServer.args.split(' ').filter(a => a) : []
                };
            }

            const newJson = JSON.stringify(servers, null, 2);
            setMcpJson(newJson);

            // Convert to array format and save to Claudia config
            const serversArray = objectToArrayFormat(servers);
            const response = await fetch(`${getApiBaseUrl()}/api/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mcpServers: serversArray })
            });

            if (response.ok) {
                setNewServer({ name: '', type: 'stdio', command: '', args: '', url: '', headers: '' });
                setIsAddingServer(false);
            } else {
                const error = await response.json();
                setJsonEditorError(error.error || 'Failed to save');
            }
        } catch (error) {
            console.error('Failed to add MCP server:', error);
            setJsonEditorError('Failed to add MCP server');
        }
    };

    const handleRemoveServer = async (serverName: string) => {
        try {
            const servers = JSON.parse(mcpJson || '{}');

            // Remove the server
            delete servers[serverName];

            const newJson = JSON.stringify(servers, null, 2);
            setMcpJson(newJson);

            // Convert to array format and save to Claudia config
            const serversArray = objectToArrayFormat(servers);
            const response = await fetch(`${getApiBaseUrl()}/api/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mcpServers: serversArray })
            });

            if (!response.ok) {
                const error = await response.json();
                setJsonEditorError(error.error || 'Failed to save');
            }
        } catch (error) {
            console.error('Failed to remove MCP server:', error);
            setJsonEditorError('Failed to remove MCP server');
        }
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
                                        Editing MCP servers in <code>{claudeConfigPath || '~/.claude.json'}</code>
                                    </p>

                                    <div className="mcp-json-section">
                                        <textarea
                                            className={`mcp-json-textarea ${jsonEditorError ? 'error' : ''}`}
                                            value={mcpJson}
                                            onChange={(e) => handleJsonChange(e.target.value)}
                                            placeholder="Loading..."
                                            spellCheck={false}
                                        />
                                    </div>

                                    {jsonEditorError && (
                                        <div className="mcp-json-error">
                                            <AlertCircle size={14} />
                                            <span>{jsonEditorError}</span>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                /* List View */
                                <>
                                    <p className="mcp-json-path" style={{ marginBottom: '12px' }}>
                                        MCP servers from <code>{claudeConfigPath || '~/.claude.json'}</code>
                                    </p>
                                    {mcpServersList.length === 0 ? (
                                        <p className="mcp-empty-state">No MCP servers configured</p>
                                    ) : (
                                        <div className="mcp-server-list">
                                            {mcpServersList.map((server) => {
                                                const testStatus = mcpTestStatus[server.name] || 'idle';
                                                const testMessage = mcpTestMessages[server.name] || '';

                                                return (
                                                    <div key={server.name} className="mcp-server-item">
                                                        <div className="mcp-server-info">
                                                            <div className="mcp-server-name-row">
                                                                <span className="mcp-server-name">{server.name}</span>
                                                                <span className={`mcp-server-type ${server.type === 'streamableHttp' ? 'http' : 'stdio'}`}>
                                                                    {server.type === 'streamableHttp' ? 'HTTP' : 'stdio'}
                                                                </span>
                                                            </div>
                                                            <span className="mcp-server-command">
                                                                {server.type === 'streamableHttp'
                                                                    ? server.url
                                                                    : `${server.command} ${server.args?.join(' ')}`}
                                                            </span>
                                                            {testMessage && (
                                                                <span className={`mcp-test-message ${testStatus}`}>
                                                                    {testMessage}
                                                                </span>
                                                            )}
                                                        </div>
                                                        <div className="mcp-server-actions">
                                                            <button
                                                                className={`mcp-test-btn ${testStatus}`}
                                                                onClick={() => testMcpConnection(server)}
                                                                title="Test Connection"
                                                                disabled={testStatus === 'testing'}
                                                            >
                                                                {testStatus === 'testing' ? (
                                                                    <Loader2 size={16} className="animate-spin" />
                                                                ) : testStatus === 'success' ? (
                                                                    <CheckCircle size={16} />
                                                                ) : testStatus === 'error' ? (
                                                                    <AlertCircle size={16} />
                                                                ) : (
                                                                    <Zap size={16} />
                                                                )}
                                                            </button>
                                                            <button
                                                                className="mcp-delete-btn"
                                                                onClick={() => handleRemoveServer(server.name)}
                                                                title="Remove"
                                                            >
                                                                <Trash2 size={16} />
                                                            </button>
                                                        </div>
                                                    </div>
                                                );
                                            })}
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
                                            <div className="mcp-type-selector">
                                                <label className={`mcp-type-option ${newServer.type === 'stdio' ? 'selected' : ''}`}>
                                                    <input
                                                        type="radio"
                                                        name="serverType"
                                                        value="stdio"
                                                        checked={newServer.type === 'stdio'}
                                                        onChange={() => setNewServer(prev => ({ ...prev, type: 'stdio' }))}
                                                    />
                                                    <span>stdio (command)</span>
                                                </label>
                                                <label className={`mcp-type-option ${newServer.type === 'streamableHttp' ? 'selected' : ''}`}>
                                                    <input
                                                        type="radio"
                                                        name="serverType"
                                                        value="streamableHttp"
                                                        checked={newServer.type === 'streamableHttp'}
                                                        onChange={() => setNewServer(prev => ({ ...prev, type: 'streamableHttp' }))}
                                                    />
                                                    <span>HTTP (URL)</span>
                                                </label>
                                            </div>
                                            {newServer.type === 'stdio' ? (
                                                <>
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
                                                </>
                                            ) : (
                                                <input
                                                    type="text"
                                                    placeholder="URL (e.g., http://localhost:8080/mcp)"
                                                    value={newServer.url}
                                                    onChange={(e) => setNewServer(prev => ({ ...prev, url: e.target.value }))}
                                                    className="mcp-input"
                                                />
                                            )}
                                            <div className="mcp-add-form-actions">
                                                <button
                                                    className="mcp-cancel-btn"
                                                    onClick={() => {
                                                        setIsAddingServer(false);
                                                        setNewServer({ name: '', type: 'stdio', command: '', args: '', url: '', headers: '' });
                                                    }}
                                                >
                                                    Cancel
                                                </button>
                                                <button
                                                    className="mcp-save-btn"
                                                    onClick={handleAddServer}
                                                    disabled={!newServer.name || (newServer.type === 'stdio' ? !newServer.command : !newServer.url)}
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
                                    {jsonEditorError && (
                                        <div className="mcp-json-error" style={{ marginTop: '12px' }}>
                                            <AlertCircle size={14} />
                                            <span>{jsonEditorError}</span>
                                        </div>
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
                        title="Claude Code CLI Switches"
                        icon={<Code size={18} />}
                        isExpanded={expandedPanels.cliSwitches}
                        onToggle={() => togglePanel('cliSwitches')}
                    >
                        <div className="permissions-content cli-switches-content">
                            {/* Verbose */}
                            <div className="permission-item">
                                <div className="permission-info">
                                    <span className="permission-label">Verbose</span>
                                    <span className="permission-description">
                                        Enable verbose logging with full turn-by-turn output for debugging.
                                    </span>
                                </div>
                                <label className="toggle-switch">
                                    <input
                                        type="checkbox"
                                        checked={cliSwitches.verbose}
                                        onChange={(e) => handleCliSwitchToggle({ verbose: e.target.checked })}
                                    />
                                    <span className="toggle-slider"></span>
                                </label>
                            </div>

                            {/* Max Turns */}
                            <div className="permission-item">
                                <div className="permission-info">
                                    <span className="permission-label">Max Turns</span>
                                    <span className="permission-description">
                                        Limit the number of agentic turns to prevent runaway loops.
                                    </span>
                                </div>
                                <div className="cli-switch-input-group">
                                    <label className="toggle-switch">
                                        <input
                                            type="checkbox"
                                            checked={cliSwitches.maxTurns !== null}
                                            onChange={(e) => handleCliSwitchToggle({ maxTurns: e.target.checked ? 50 : null })}
                                        />
                                        <span className="toggle-slider"></span>
                                    </label>
                                    {cliSwitches.maxTurns !== null && (
                                        <input
                                            type="number"
                                            className="cli-switch-number-input"
                                            value={cliSwitches.maxTurns}
                                            min={1}
                                            max={1000}
                                            onChange={(e) => handleCliSwitchChange({ maxTurns: parseInt(e.target.value) || 1 })}
                                        />
                                    )}
                                </div>
                            </div>

                            {/* Max Budget */}
                            <div className="permission-item">
                                <div className="permission-info">
                                    <span className="permission-label">Max Budget (USD)</span>
                                    <span className="permission-description">
                                        Set a cost ceiling per task to control API spending.
                                    </span>
                                </div>
                                <div className="cli-switch-input-group">
                                    <label className="toggle-switch">
                                        <input
                                            type="checkbox"
                                            checked={cliSwitches.maxBudgetUsd !== null}
                                            onChange={(e) => handleCliSwitchToggle({ maxBudgetUsd: e.target.checked ? 5.0 : null })}
                                        />
                                        <span className="toggle-slider"></span>
                                    </label>
                                    {cliSwitches.maxBudgetUsd !== null && (
                                        <input
                                            type="number"
                                            className="cli-switch-number-input"
                                            value={cliSwitches.maxBudgetUsd}
                                            min={0}
                                            step={0.5}
                                            onChange={(e) => handleCliSwitchChange({ maxBudgetUsd: parseFloat(e.target.value) || 0 })}
                                        />
                                    )}
                                </div>
                            </div>

                            {/* Permission Mode */}
                            <div className="permission-item">
                                <div className="permission-info">
                                    <span className="permission-label">Permission Mode</span>
                                    <span className="permission-description">
                                        Set permission mode: plan (read-only), acceptEdits (auto-approve edits), dontAsk (auto-approve all).
                                    </span>
                                </div>
                                <div className="cli-switch-input-group">
                                    <label className="toggle-switch">
                                        <input
                                            type="checkbox"
                                            checked={cliSwitches.permissionMode !== null}
                                            onChange={(e) => handleCliSwitchToggle({ permissionMode: e.target.checked ? 'dontAsk' : null })}
                                        />
                                        <span className="toggle-slider"></span>
                                    </label>
                                    {cliSwitches.permissionMode !== null && (
                                        <select
                                            className="cli-switch-select"
                                            value={cliSwitches.permissionMode}
                                            onChange={(e) => handleCliSwitchToggle({ permissionMode: e.target.value })}
                                        >
                                            <option value="default">default</option>
                                            <option value="plan">plan (read-only)</option>
                                            <option value="acceptEdits">acceptEdits (auto-approve edits)</option>
                                            <option value="dontAsk">dontAsk (auto-approve all)</option>
                                        </select>
                                    )}
                                </div>
                            </div>

                            {/* Allowed Tools */}
                            <div className="permission-item">
                                <div className="permission-info">
                                    <span className="permission-label">Allowed Tools</span>
                                    <span className="permission-description">
                                        Comma-separated list of additional tools that run without permission prompts.
                                    </span>
                                </div>
                            </div>
                            <div className="cli-switch-text-row">
                                <input
                                    type="text"
                                    className="cli-switch-text-input"
                                    value={cliSwitches.allowedTools}
                                    placeholder="e.g. Bash, Read, Write (leave empty to disable)"
                                    onChange={(e) => handleCliSwitchChange({ allowedTools: e.target.value })}
                                />
                            </div>

                            {/* Disallowed Tools */}
                            <div className="permission-item">
                                <div className="permission-info">
                                    <span className="permission-label">Disallowed Tools</span>
                                    <span className="permission-description">
                                        Comma-separated list of tools to completely disable.
                                    </span>
                                </div>
                            </div>
                            <div className="cli-switch-text-row">
                                <input
                                    type="text"
                                    className="cli-switch-text-input"
                                    value={cliSwitches.disallowedTools}
                                    placeholder="e.g. Write, Bash (leave empty to disable)"
                                    onChange={(e) => handleCliSwitchChange({ disallowedTools: e.target.value })}
                                />
                            </div>

                            {/* Append System Prompt */}
                            <div className="permission-item">
                                <div className="permission-info">
                                    <span className="permission-label">Append System Prompt</span>
                                    <span className="permission-description">
                                        Append custom instructions to Claude's default system prompt.
                                    </span>
                                </div>
                            </div>
                            <div className="cli-switch-text-row">
                                <textarea
                                    className="cli-switch-textarea"
                                    value={cliSwitches.appendSystemPrompt}
                                    placeholder="Enter custom system prompt text... (leave empty to disable)"
                                    rows={3}
                                    onChange={(e) => handleCliSwitchChange({ appendSystemPrompt: e.target.value })}
                                />
                            </div>

                            <p className="cli-switches-note">
                                Changes apply to new tasks only. Existing tasks keep their original settings.
                            </p>
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
                                    </div>
                                </>
                            )}
                        </div>
                    </CollapsiblePanel>

                    <CollapsiblePanel
                        title="Learnings (RAG)"
                        icon={<Brain size={18} />}
                        isExpanded={expandedPanels.learnings}
                        onToggle={() => togglePanel('learnings')}
                    >
                        <div className="permissions-content">
                            <div className="permission-item">
                                <div className="permission-info">
                                    <span className="permission-label">Use Learnings</span>
                                    <span className="permission-description">
                                        When enabled, relevant learnings from past conversations will be
                                        automatically retrieved and injected into new task contexts using
                                        semantic search (RAG).
                                    </span>
                                </div>
                                <label className="toggle-switch">
                                    <input
                                        type="checkbox"
                                        checked={useLearnings}
                                        onChange={(e) => saveUseLearnings(e.target.checked)}
                                    />
                                    <span className="toggle-slider"></span>
                                </label>
                            </div>
                            <p className="api-config-note" style={{ marginTop: '12px' }}>
                                To add learnings, click the "Learn" button on a completed task.
                                Learnings are stored with embeddings and matched based on semantic
                                similarity to new task prompts.
                            </p>
                        </div>
                    </CollapsiblePanel>

                </div>

                <div className="settings-menu-footer">
                    <button className="settings-done-btn" onClick={() => {
                        // Flush any pending debounced saves before closing
                        if (apiModeTimerRef.current) {
                            clearTimeout(apiModeTimerRef.current);
                            saveApiMode(apiMode, customAnthropicApiKey);
                        }
                        if (rulesTimerRef.current) {
                            clearTimeout(rulesTimerRef.current);
                            saveRules(rules);
                        }
                        if (supervisorPromptTimerRef.current) {
                            clearTimeout(supervisorPromptTimerRef.current);
                            saveSupervisorPrompt(supervisorSystemPrompt);
                        }
                        if (mcpJsonTimerRef.current) {
                            clearTimeout(mcpJsonTimerRef.current);
                            saveClaudeConfig(mcpJson);
                        }
                        onClose();
                    }}>
                        Done
                    </button>
                </div>
            </div>
        </div>
    );
}
