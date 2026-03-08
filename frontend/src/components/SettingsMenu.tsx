import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { X, Settings, Volume2, Server, ChevronDown, ChevronRight, Plus, Trash2, Shield, FileText, Bot, MousePointer, CheckCircle, AlertCircle, Loader2, Key, Code, Eye, Terminal, Brain, Zap, Bell } from 'lucide-react';
import { VoiceSettingsContent } from './VoiceSettingsContent';
import { getApiBaseUrl } from '../config/api-config';
import { hasBrowserNotifications, getNotificationPermission, requestNotificationPermission } from '../utils/browserCapabilities';
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

type ApiMode = 'default' | 'custom-anthropic' | 'sap-ai-core' | 'hyperspace-proxy';
type BackendType = 'claude-code' | 'opencode';

interface Plugin {
    name: string;
    displayName: string;
    type: string;
    version: string;
    description: string;
    author?: string;
    enabled: boolean;
    apiMode?: string;
    models?: Array<{ id: string; name: string }>;
    configSchema?: any;
}

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
    const { showSystemStats, setShowSystemStats, browserNotificationsEnabled, setBrowserNotificationsEnabled, notifyOnCompletion, setNotifyOnCompletion, notifyOnWaitingInput, setNotifyOnWaitingInput } = useTaskStore();
    const { showWarning } = useNotification();
    const [expandedPanels, setExpandedPanels] = useState<Record<string, boolean>>({
        sound: false,
        notifications: false,
        behavior: false,
        backend: false,
        api: false,
        mcp: false,
        plugins: false,
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
        appendSystemPrompt: '',
        effortLevel: 'high'
    });
    const cliSwitchesTimerRef = useRef<NodeJS.Timeout | null>(null);

    // Debounce timers
    const rulesTimerRef = useRef<NodeJS.Timeout | null>(null);
    const supervisorPromptTimerRef = useRef<NodeJS.Timeout | null>(null);
    const mcpJsonTimerRef = useRef<NodeJS.Timeout | null>(null);

    // API Mode state
    const [apiMode, setApiMode] = useState<ApiMode>('default');
    const [customAnthropicApiKey, setCustomAnthropicApiKey] = useState('');
    const [plugins, setPlugins] = useState<Plugin[]>([]);

    // SAP AI Core state - load from localStorage on mount
    const [sapAiCoreClientId, setSapAiCoreClientId] = useState(() => {
        try {
            return localStorage.getItem('claudia_sap_ai_core_client_id') || '';
        } catch {
            return '';
        }
    });
    const [sapAiCoreClientSecret, setSapAiCoreClientSecret] = useState(() => {
        try {
            return localStorage.getItem('claudia_sap_ai_core_client_secret') || '';
        } catch {
            return '';
        }
    });
    const [sapAiCoreAuthUrl, setSapAiCoreAuthUrl] = useState(() => {
        try {
            return localStorage.getItem('claudia_sap_ai_core_auth_url') || '';
        } catch {
            return '';
        }
    });
    const [sapAiCoreBaseUrl, setSapAiCoreBaseUrl] = useState(() => {
        try {
            return localStorage.getItem('claudia_sap_ai_core_base_url') || '';
        } catch {
            return '';
        }
    });
    const [sapAiCoreResourceGroup, setSapAiCoreResourceGroup] = useState(() => {
        try {
            return localStorage.getItem('claudia_sap_ai_core_resource_group') || 'default';
        } catch {
            return 'default';
        }
    });
    const [sapAiCoreModel, setSapAiCoreModel] = useState(() => {
        try {
            return localStorage.getItem('claudia_sap_ai_core_model') || 'anthropic--claude-4.5-sonnet';
        } catch {
            return 'anthropic--claude-4.5-sonnet';
        }
    });

    // Hyperspace Proxy state
    const [hyperspaceProxyUrl, setHyperspaceProxyUrl] = useState('http://localhost:6655');
    const [hyperspaceApiKey, setHyperspaceApiKey] = useState('');
    const [hyperspaceModel, setHyperspaceModel] = useState('anthropic--claude-4.5-sonnet');
    const [hyperspaceAlwaysThinking, setHyperspaceAlwaysThinking] = useState(false);

    // Custom API key test state
    const [customApiKeyTestStatus, setCustomApiKeyTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
    const [customApiKeyTestMessage, setCustomApiKeyTestMessage] = useState('');

    // SAP AI Core test state
    const [sapAiCoreTestStatus, setSapAiCoreTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
    const [sapAiCoreTestMessage, setSapAiCoreTestMessage] = useState('');
    const [sapAiCoreModels, setSapAiCoreModels] = useState<Array<{ id: string; name: string }>>([]);

    // Hyperspace Proxy test state
    const [hyperspaceTestStatus, setHyperspaceTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
    const [hyperspaceTestMessage, setHyperspaceTestMessage] = useState('');
    const [hyperspaceModels, setHyperspaceModels] = useState<Array<{ id: string; name: string }>>([]);

    // Hyperspace Proxy control state
    const [hyperspaceProxyStatus, setHyperspaceProxyStatus] = useState<{
        proxyRunning: boolean;
        haiInstalled: boolean;
        loading: boolean;
    }>({ proxyRunning: false, haiInstalled: false, loading: false });

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

    // Fetch Hyperspace proxy status when API mode is hyperspace-proxy
    useEffect(() => {
        if (apiMode === 'hyperspace-proxy') {
            fetchHyperspaceProxyStatus();
        }
    }, [apiMode]);

    // Auto-restore SAP AI Core credentials from localStorage to backend on mount
    useEffect(() => {
        const restoreSapAiCoreCredentials = async () => {
            // Only restore if we have credentials in localStorage and settings menu is open
            if (!isOpen) return;

            const hasCredentials = sapAiCoreClientId && sapAiCoreClientSecret &&
                                  sapAiCoreAuthUrl && sapAiCoreBaseUrl;

            if (hasCredentials) {
                try {
                    // Check if backend already has the config
                    const checkResponse = await fetch(`${getApiBaseUrl()}/api/config`);
                    if (checkResponse.ok) {
                        const config = await checkResponse.json();

                        // Only restore if backend doesn't have SAP AI Core config or it's different
                        const needsRestore = !config.sapAiCore ||
                                            config.sapAiCore.clientId !== sapAiCoreClientId ||
                                            config.sapAiCore.clientSecret !== sapAiCoreClientSecret;

                        if (needsRestore) {
                            console.log('[SettingsMenu] Restoring SAP AI Core credentials from localStorage to backend');
                            const response = await fetch(`${getApiBaseUrl()}/api/config`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    sapAiCore: {
                                        clientId: sapAiCoreClientId,
                                        clientSecret: sapAiCoreClientSecret,
                                        authUrl: sapAiCoreAuthUrl,
                                        baseUrl: sapAiCoreBaseUrl,
                                        resourceGroup: sapAiCoreResourceGroup,
                                        model: sapAiCoreModel
                                    }
                                })
                            });

                            if (response.ok) {
                                console.log('[SettingsMenu] SAP AI Core credentials restored successfully');
                            }
                        }
                    }
                } catch (error) {
                    console.warn('[SettingsMenu] Failed to restore SAP AI Core credentials:', error);
                }
            }
        };

        restoreSapAiCoreCredentials();
    }, [isOpen, sapAiCoreClientId, sapAiCoreClientSecret, sapAiCoreAuthUrl, sapAiCoreBaseUrl, sapAiCoreResourceGroup, sapAiCoreModel]);

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

                // Load SAP AI Core config
                if (config.sapAiCore) {
                    setSapAiCoreClientId(config.sapAiCore.clientId || '');
                    setSapAiCoreClientSecret(config.sapAiCore.clientSecret || '');
                    setSapAiCoreAuthUrl(config.sapAiCore.authUrl || '');
                    setSapAiCoreBaseUrl(config.sapAiCore.baseUrl || '');
                    setSapAiCoreResourceGroup(config.sapAiCore.resourceGroup || 'default');
                    setSapAiCoreModel(config.sapAiCore.model || 'anthropic--claude-4.5-sonnet');
                }

                // Load Hyperspace Proxy config
                if (config.hyperspaceProxy) {
                    setHyperspaceProxyUrl(config.hyperspaceProxy.proxyUrl || 'http://localhost:6655');
                    setHyperspaceApiKey(config.hyperspaceProxy.apiKey || '');
                    setHyperspaceModel(config.hyperspaceProxy.model || 'anthropic--claude-4.5-sonnet');
                    setHyperspaceAlwaysThinking(config.hyperspaceProxy.alwaysThinkingEnabled || false);
                }

                if (config.claudeCodeSwitches) {
                    setCliSwitches({
                        verbose: config.claudeCodeSwitches.verbose || false,
                        maxTurns: config.claudeCodeSwitches.maxTurns ?? null,
                        maxBudgetUsd: config.claudeCodeSwitches.maxBudgetUsd ?? null,
                        permissionMode: config.claudeCodeSwitches.permissionMode ?? null,
                        allowedTools: config.claudeCodeSwitches.allowedTools || '',
                        disallowedTools: config.claudeCodeSwitches.disallowedTools || '',
                        appendSystemPrompt: config.claudeCodeSwitches.appendSystemPrompt || '',
                        effortLevel: config.claudeCodeSwitches.effortLevel || 'high'
                    });
                }
            }

            // Fetch available plugins
            const pluginsResponse = await fetch(`${getApiBaseUrl()}/api/plugins`);
            if (pluginsResponse.ok) {
                const pluginsData = await pluginsResponse.json();
                if (pluginsData.success && pluginsData.plugins) {
                    setPlugins(pluginsData.plugins);
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

    const saveSapAiCoreConfig = async () => {
        try {
            // Save to backend
            const response = await fetch(`${getApiBaseUrl()}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sapAiCore: {
                        clientId: sapAiCoreClientId,
                        clientSecret: sapAiCoreClientSecret,
                        authUrl: sapAiCoreAuthUrl,
                        baseUrl: sapAiCoreBaseUrl,
                        resourceGroup: sapAiCoreResourceGroup,
                        model: sapAiCoreModel
                    }
                })
            });

            if (response.ok) {
                // Save to localStorage for persistence across server restarts
                try {
                    localStorage.setItem('claudia_sap_ai_core_client_id', sapAiCoreClientId);
                    localStorage.setItem('claudia_sap_ai_core_client_secret', sapAiCoreClientSecret);
                    localStorage.setItem('claudia_sap_ai_core_auth_url', sapAiCoreAuthUrl);
                    localStorage.setItem('claudia_sap_ai_core_base_url', sapAiCoreBaseUrl);
                    localStorage.setItem('claudia_sap_ai_core_resource_group', sapAiCoreResourceGroup);
                    localStorage.setItem('claudia_sap_ai_core_model', sapAiCoreModel);
                } catch (storageError) {
                    console.warn('Failed to save SAP AI Core config to localStorage:', storageError);
                }
                showWarning('SAP AI Core configuration saved successfully');
            } else {
                showWarning('Failed to save SAP AI Core configuration');
            }
        } catch (error) {
            showWarning('Failed to save SAP AI Core configuration');
        }
    };

    const saveHyperspaceProxyConfig = async () => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    hyperspaceProxy: {
                        proxyUrl: hyperspaceProxyUrl,
                        apiKey: hyperspaceApiKey,
                        model: hyperspaceModel,
                        alwaysThinkingEnabled: hyperspaceAlwaysThinking
                    }
                })
            });

            if (response.ok) {
                showWarning('Hyperspace Proxy configuration saved successfully');
            } else {
                showWarning('Failed to save Hyperspace Proxy configuration');
            }
        } catch (error) {
            showWarning('Failed to save Hyperspace Proxy configuration');
        }
    };

    const testSapAiCoreConnection = async () => {
        if (!sapAiCoreClientId || !sapAiCoreClientSecret || !sapAiCoreAuthUrl || !sapAiCoreBaseUrl) {
            setSapAiCoreTestStatus('error');
            setSapAiCoreTestMessage('Please fill in all required fields');
            return;
        }

        setSapAiCoreTestStatus('testing');
        setSapAiCoreTestMessage('Testing connection...');

        try {
            const response = await fetch(`${getApiBaseUrl()}/api/sap-ai-core/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    clientId: sapAiCoreClientId,
                    clientSecret: sapAiCoreClientSecret,
                    authUrl: sapAiCoreAuthUrl,
                    baseUrl: sapAiCoreBaseUrl,
                    resourceGroup: sapAiCoreResourceGroup
                })
            });

            const result = await response.json();

            if (response.ok && result.success) {
                setSapAiCoreTestStatus('success');
                setSapAiCoreTestMessage('Connection successful!');
            } else {
                setSapAiCoreTestStatus('error');
                setSapAiCoreTestMessage(result.error || 'Connection failed');
            }
        } catch (error) {
            setSapAiCoreTestStatus('error');
            setSapAiCoreTestMessage('Failed to test connection');
        }
    };

    const refreshSapAiCoreModels = async () => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/sap-ai-core/models`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });

            const result = await response.json();

            if (response.ok && result.success && result.models) {
                setSapAiCoreModels(result.models);
                showWarning(`Refreshed: ${result.models.length} models available`);
            } else {
                showWarning('Failed to fetch models from SAP AI Core plugin');
            }
        } catch (error) {
            showWarning('Failed to fetch models from SAP AI Core plugin');
        }
    };

    const testHyperspaceConnection = async () => {
        if (!hyperspaceProxyUrl || !hyperspaceApiKey) {
            setHyperspaceTestStatus('error');
            setHyperspaceTestMessage('Please fill in Proxy URL and API Key');
            return;
        }

        setHyperspaceTestStatus('testing');
        setHyperspaceTestMessage('Testing connection...');

        try {
            const response = await fetch(`${getApiBaseUrl()}/api/hyperspace-proxy/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    proxyUrl: hyperspaceProxyUrl,
                    apiKey: hyperspaceApiKey
                })
            });

            const result = await response.json();

            if (response.ok && result.success) {
                setHyperspaceTestStatus('success');
                setHyperspaceTestMessage('Connection successful!');
            } else {
                setHyperspaceTestStatus('error');
                setHyperspaceTestMessage(result.error || 'Connection failed');
            }
        } catch (error) {
            setHyperspaceTestStatus('error');
            setHyperspaceTestMessage('Failed to test connection');
        }
    };

    const refreshHyperspaceModels = async () => {
        if (!hyperspaceProxyUrl || !hyperspaceApiKey) {
            showWarning('Please fill in Proxy URL and API Key first');
            return;
        }

        try {
            const response = await fetch(`${getApiBaseUrl()}/api/hyperspace-proxy/models`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    proxyUrl: hyperspaceProxyUrl,
                    apiKey: hyperspaceApiKey
                })
            });

            const result = await response.json();

            if (response.ok && result.success && result.models) {
                setHyperspaceModels(result.models);
                showWarning(`Refreshed: ${result.models.length} models available`);
            } else {
                showWarning('Failed to fetch models');
            }
        } catch (error) {
            showWarning('Failed to fetch models');
        }
    };

    const fetchHyperspaceProxyStatus = async () => {
        try {
            setHyperspaceProxyStatus(prev => ({ ...prev, loading: true }));
            const response = await fetch(`${getApiBaseUrl()}/plugins/hai-proxy-plugin/status`);
            const result = await response.json();

            if (response.ok) {
                setHyperspaceProxyStatus({
                    proxyRunning: result.proxyRunning || false,
                    haiInstalled: result.haiInstalled || false,
                    loading: false
                });

                // Update API key if proxy is running and we have one
                if (result.apiKey && result.proxyRunning) {
                    setHyperspaceApiKey(result.apiKey);
                }
            } else {
                setHyperspaceProxyStatus({ proxyRunning: false, haiInstalled: false, loading: false });
            }
        } catch (error) {
            setHyperspaceProxyStatus({ proxyRunning: false, haiInstalled: false, loading: false });
        }
    };

    const startHyperspaceProxy = async () => {
        try {
            setHyperspaceProxyStatus(prev => ({ ...prev, loading: true }));
            showWarning('Starting HAI proxy...');

            const response = await fetch(`${getApiBaseUrl()}/plugins/hai-proxy-plugin/start`, {
                method: 'POST'
            });
            const result = await response.json();

            if (response.ok && result.success) {
                setHyperspaceApiKey(result.apiKey);
                await fetchHyperspaceProxyStatus();
                showWarning('HAI proxy started successfully!');
            } else {
                setHyperspaceProxyStatus(prev => ({ ...prev, loading: false }));
                showWarning(`Failed to start proxy: ${result.error || 'Unknown error'}`);
            }
        } catch (error) {
            setHyperspaceProxyStatus(prev => ({ ...prev, loading: false }));
            showWarning('Failed to start HAI proxy');
        }
    };

    const stopHyperspaceProxy = async () => {
        try {
            setHyperspaceProxyStatus(prev => ({ ...prev, loading: true }));
            showWarning('Stopping HAI proxy...');

            const response = await fetch(`${getApiBaseUrl()}/plugins/hai-proxy-plugin/stop`, {
                method: 'POST'
            });
            const result = await response.json();

            if (response.ok && result.success) {
                await fetchHyperspaceProxyStatus();
                showWarning('HAI proxy stopped successfully!');
            } else {
                setHyperspaceProxyStatus(prev => ({ ...prev, loading: false }));
                showWarning('Failed to stop HAI proxy');
            }
        } catch (error) {
            setHyperspaceProxyStatus(prev => ({ ...prev, loading: false }));
            showWarning('Failed to stop HAI proxy');
        }
    };

    const togglePanel = (panel: string) => {
        setExpandedPanels(prev => ({ ...prev, [panel]: !prev[panel] }));
    };

    const handlePluginToggle = async (pluginName: string, enabled: boolean) => {
        try {
            const endpoint = enabled ? 'enable' : 'disable';
            const url = `${getApiBaseUrl()}/api/plugins/${pluginName}/${endpoint}`;
            console.log(`[Plugin Toggle] ${enabled ? 'Enabling' : 'Disabling'} plugin:`, pluginName);
            console.log(`[Plugin Toggle] Request URL:`, url);

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });

            console.log(`[Plugin Toggle] Response status:`, response.status);

            if (response.ok) {
                const result = await response.json();
                console.log(`[Plugin Toggle] Result:`, result);

                // Refresh plugin list
                const pluginsResponse = await fetch(`${getApiBaseUrl()}/api/plugins`);
                if (pluginsResponse.ok) {
                    const pluginsData = await pluginsResponse.json();
                    if (pluginsData.success && pluginsData.plugins) {
                        setPlugins(pluginsData.plugins);
                        console.log(`[Plugin Toggle] Plugin list refreshed, total plugins:`, pluginsData.plugins.length);
                    }
                }

                if (result.requiresRestart && !enabled) {
                    showWarning('Plugin disabled. Restart server to fully unload.');
                } else {
                    showWarning(`Plugin ${enabled ? 'enabled' : 'disabled'} successfully!`);
                }
            } else {
                const errorText = await response.text();
                console.error(`[Plugin Toggle] Error response:`, errorText);
                let errorMsg = 'Unknown error';
                try {
                    const errorJson = JSON.parse(errorText);
                    errorMsg = errorJson.error || errorJson.message || errorText;
                } catch {
                    errorMsg = errorText;
                }
                showWarning(`Failed to ${enabled ? 'enable' : 'disable'} plugin: ${errorMsg}`);
            }
        } catch (error) {
            console.error('[Plugin Toggle] Exception:', error);
            const errorMsg = error instanceof Error ? error.message : String(error);
            showWarning(`Failed to toggle plugin: ${errorMsg}`);
        }
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
                        title="Notifications"
                        icon={<Bell size={18} />}
                        isExpanded={expandedPanels.notifications}
                        onToggle={() => togglePanel('notifications')}
                    >
                        <div className="permissions-content">
                            <div className="permission-item">
                                <div className="permission-info">
                                    <span className="permission-label">Browser Notifications</span>
                                    <span className="permission-description">
                                        {!hasBrowserNotifications()
                                            ? 'Browser notifications are not supported in this environment.'
                                            : getNotificationPermission() === 'denied'
                                            ? 'Notifications are blocked. Please enable them in your browser settings.'
                                            : 'Show desktop notifications when tasks complete or need input.'}
                                    </span>
                                </div>
                                <label className="toggle-switch">
                                    <input
                                        type="checkbox"
                                        checked={browserNotificationsEnabled}
                                        disabled={!hasBrowserNotifications() || getNotificationPermission() === 'denied'}
                                        onChange={async (e) => {
                                            if (e.target.checked) {
                                                const permission = await requestNotificationPermission();
                                                if (permission === 'granted') {
                                                    setBrowserNotificationsEnabled(true);
                                                }
                                            } else {
                                                setBrowserNotificationsEnabled(false);
                                            }
                                        }}
                                    />
                                    <span className="toggle-slider"></span>
                                </label>
                            </div>
                            {browserNotificationsEnabled && (
                                <>
                                    <div className="permission-item" style={{ marginTop: 12 }}>
                                        <div className="permission-info">
                                            <span className="permission-label">Task Completion</span>
                                            <span className="permission-description">
                                                Notify when a task finishes executing.
                                            </span>
                                        </div>
                                        <label className="toggle-switch">
                                            <input
                                                type="checkbox"
                                                checked={notifyOnCompletion}
                                                onChange={(e) => setNotifyOnCompletion(e.target.checked)}
                                            />
                                            <span className="toggle-slider"></span>
                                        </label>
                                    </div>
                                    <div className="permission-item" style={{ marginTop: 12 }}>
                                        <div className="permission-info">
                                            <span className="permission-label">Waiting for Input</span>
                                            <span className="permission-description">
                                                Notify when a task needs permission, has a question, or requires input.
                                            </span>
                                        </div>
                                        <label className="toggle-switch">
                                            <input
                                                type="checkbox"
                                                checked={notifyOnWaitingInput}
                                                onChange={(e) => setNotifyOnWaitingInput(e.target.checked)}
                                            />
                                            <span className="toggle-slider"></span>
                                        </label>
                                    </div>
                                </>
                            )}
                        </div>
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

                                {/* Plugin-based API modes */}
                                {plugins.filter(p => p.type === 'ai-provider' && p.enabled).map(plugin => (
                                    <label key={plugin.name} className={`api-mode-option ${apiMode === plugin.apiMode ? 'selected' : ''}`}>
                                        <input
                                            type="radio"
                                            name="apiMode"
                                            value={plugin.apiMode}
                                            checked={apiMode === plugin.apiMode}
                                            onChange={() => handleApiModeChange(plugin.apiMode as ApiMode)}
                                        />
                                        <div className="api-mode-content">
                                            <span className="api-mode-title">{plugin.displayName}</span>
                                            <span className="api-mode-description">
                                                {plugin.name === 'sap-ai-core-plugin' && 'Use SAP AI Core with your own credentials'}
                                                {plugin.name === 'hai-proxy-plugin' && 'Use HAI Proxy for Anthropic Claude models'}
                                            </span>
                                        </div>
                                    </label>
                                ))}
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

                            {/* SAP AI Core Plugin fields */}
                            {apiMode === 'sap-ai-core' && (
                                <div className="api-mode-fields">
                                    <div className="aicore-field">
                                        <label>Client ID</label>
                                        <input
                                            type="text"
                                            value={sapAiCoreClientId}
                                            onChange={(e) => setSapAiCoreClientId(e.target.value)}
                                            placeholder="Client ID"
                                            className="aicore-input"
                                        />
                                    </div>
                                    <div className="aicore-field">
                                        <label>Client Secret</label>
                                        <input
                                            type="password"
                                            value={sapAiCoreClientSecret}
                                            onChange={(e) => setSapAiCoreClientSecret(e.target.value)}
                                            placeholder="Client Secret"
                                            className="aicore-input"
                                        />
                                    </div>
                                    <div className="aicore-field">
                                        <label>Auth URL</label>
                                        <input
                                            type="text"
                                            value={sapAiCoreAuthUrl}
                                            onChange={(e) => setSapAiCoreAuthUrl(e.target.value)}
                                            placeholder="https://..."
                                            className="aicore-input"
                                        />
                                    </div>
                                    <div className="aicore-field">
                                        <label>Base URL</label>
                                        <input
                                            type="text"
                                            value={sapAiCoreBaseUrl}
                                            onChange={(e) => setSapAiCoreBaseUrl(e.target.value)}
                                            placeholder="https://..."
                                            className="aicore-input"
                                        />
                                    </div>
                                    <div className="aicore-field">
                                        <label>Resource Group</label>
                                        <input
                                            type="text"
                                            value={sapAiCoreResourceGroup}
                                            onChange={(e) => setSapAiCoreResourceGroup(e.target.value)}
                                            placeholder="default"
                                            className="aicore-input"
                                        />
                                    </div>
                                    <div className="aicore-field">
                                        <label>Model</label>
                                        <select
                                            value={sapAiCoreModel}
                                            onChange={(e) => setSapAiCoreModel(e.target.value)}
                                            className="aicore-input"
                                        >
                                            {sapAiCoreModels.length > 0 ? (
                                                sapAiCoreModels.map(model => (
                                                    <option key={model.id} value={model.id}>{model.name}</option>
                                                ))
                                            ) : (
                                                <>
                                                    <option value="anthropic--claude-4.5-opus">Claude 4.5 Opus</option>
                                                    <option value="anthropic--claude-opus-4">Claude Opus 4</option>
                                                    <option value="anthropic--claude-sonnet-4">Claude Sonnet 4</option>
                                                    <option value="anthropic--claude-4.5-sonnet">Claude 4.5 Sonnet</option>
                                                    <option value="anthropic--claude-3.7-sonnet">Claude 3.7 Sonnet</option>
                                                    <option value="anthropic--claude-3.5-sonnet">Claude 3.5 Sonnet</option>
                                                    <option value="anthropic--claude-3.5-haiku">Claude 3.5 Haiku</option>
                                                    <option value="anthropic--claude-3-opus">Claude 3 Opus</option>
                                                </>
                                            )}
                                        </select>
                                    </div>

                                    {sapAiCoreTestStatus !== 'idle' && (
                                        <div className={`aicore-test-result ${sapAiCoreTestStatus}`}>
                                            {sapAiCoreTestStatus === 'testing' && <Loader2 size={16} className="spinning" />}
                                            {sapAiCoreTestStatus === 'success' && <CheckCircle size={16} />}
                                            {sapAiCoreTestStatus === 'error' && <AlertCircle size={16} />}
                                            <span>{sapAiCoreTestMessage}</span>
                                        </div>
                                    )}

                                    <div className="aicore-buttons">
                                        <button
                                            className="aicore-test-btn"
                                            onClick={testSapAiCoreConnection}
                                            disabled={sapAiCoreTestStatus === 'testing'}
                                        >
                                            {sapAiCoreTestStatus === 'testing' ? 'Testing...' : 'Test Connection'}
                                        </button>
                                        <button
                                            className="aicore-test-btn"
                                            onClick={refreshSapAiCoreModels}
                                        >
                                            Refresh Models
                                        </button>
                                        <button
                                            className="aicore-test-btn"
                                            onClick={saveSapAiCoreConfig}
                                        >
                                            Save Configuration
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* HAI Proxy Plugin fields */}
                            {apiMode === 'hyperspace-proxy' && (
                                <div className="api-mode-fields">
                                    <div className="aicore-field">
                                        <label>Proxy URL</label>
                                        <input
                                            type="text"
                                            value={hyperspaceProxyUrl}
                                            onChange={(e) => setHyperspaceProxyUrl(e.target.value)}
                                            placeholder="http://localhost:6655"
                                            className="aicore-input"
                                        />
                                    </div>
                                    <div className="aicore-field">
                                        <label>API Key (ANTHROPIC_AUTH_TOKEN)</label>
                                        <input
                                            type="password"
                                            value={hyperspaceApiKey}
                                            onChange={(e) => setHyperspaceApiKey(e.target.value)}
                                            placeholder="API Key"
                                            className="aicore-input"
                                        />
                                    </div>
                                    <div className="aicore-field">
                                        <label>Model</label>
                                        <select
                                            value={hyperspaceModel}
                                            onChange={(e) => setHyperspaceModel(e.target.value)}
                                            className="aicore-input"
                                        >
                                            {hyperspaceModels.length > 0 ? (
                                                hyperspaceModels.map(model => (
                                                    <option key={model.id} value={model.id}>{model.name}</option>
                                                ))
                                            ) : (
                                                <>
                                                    <option value="anthropic--claude-4.6-opus">Claude 4.6 Opus</option>
                                                    <option value="anthropic--claude-4.6-sonnet">Claude 4.6 Sonnet</option>
                                                    <option value="anthropic--claude-4.5-sonnet">Claude 4.5 Sonnet</option>
                                                    <option value="anthropic--claude-3.7-sonnet">Claude 3.7 Sonnet</option>
                                                    <option value="anthropic--claude-3.5-sonnet">Claude 3.5 Sonnet</option>
                                                    <option value="anthropic--claude-3.5-haiku">Claude 3.5 Haiku</option>
                                                </>
                                            )}
                                        </select>
                                    </div>
                                    <div className="aicore-field">
                                        <label className="checkbox-label">
                                            <input
                                                type="checkbox"
                                                checked={hyperspaceAlwaysThinking}
                                                onChange={(e) => setHyperspaceAlwaysThinking(e.target.checked)}
                                            />
                                            <span>Enable Always Thinking Mode</span>
                                        </label>
                                    </div>

                                    {hyperspaceTestStatus !== 'idle' && (
                                        <div className={`aicore-test-result ${hyperspaceTestStatus}`}>
                                            {hyperspaceTestStatus === 'testing' && <Loader2 size={16} className="spinning" />}
                                            {hyperspaceTestStatus === 'success' && <CheckCircle size={16} />}
                                            {hyperspaceTestStatus === 'error' && <AlertCircle size={16} />}
                                            <span>{hyperspaceTestMessage}</span>
                                        </div>
                                    )}

                                    {/* Proxy Status */}
                                    <div className={`aicore-test-result ${hyperspaceProxyStatus.proxyRunning ? 'success' : 'idle'}`}>
                                        <span>
                                            Proxy Status: {hyperspaceProxyStatus.loading ? 'Checking...' :
                                                          hyperspaceProxyStatus.proxyRunning ? '🟢 Running' :
                                                          hyperspaceProxyStatus.haiInstalled ? '🔴 Stopped' : '⚠️ HAI CLI Not Installed'}
                                        </span>
                                    </div>

                                    <div className="aicore-buttons">
                                        <button
                                            className="aicore-test-btn"
                                            onClick={testHyperspaceConnection}
                                            disabled={hyperspaceTestStatus === 'testing'}
                                        >
                                            {hyperspaceTestStatus === 'testing' ? 'Testing...' : 'Test Connection'}
                                        </button>
                                        <button
                                            className="aicore-test-btn"
                                            onClick={refreshHyperspaceModels}
                                        >
                                            Refresh Models
                                        </button>
                                        <button
                                            className={`aicore-test-btn ${hyperspaceProxyStatus.proxyRunning ? 'error' : 'success'}`}
                                            onClick={hyperspaceProxyStatus.proxyRunning ? stopHyperspaceProxy : startHyperspaceProxy}
                                            disabled={hyperspaceProxyStatus.loading || !hyperspaceProxyStatus.haiInstalled}
                                        >
                                            {hyperspaceProxyStatus.loading ? 'Loading...' :
                                             hyperspaceProxyStatus.proxyRunning ? 'Stop Proxy' :
                                             hyperspaceProxyStatus.haiInstalled ? 'Start Proxy' : 'HAI Not Installed'}
                                        </button>
                                        <button
                                            className="aicore-test-btn"
                                            onClick={saveHyperspaceProxyConfig}
                                        >
                                            Save Configuration
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
                        title="Plugins"
                        icon={<Zap size={18} />}
                        isExpanded={expandedPanels.plugins}
                        onToggle={() => togglePanel('plugins')}
                    >
                        <div className="plugins-content">
                            <div className="plugins-description">
                                Enable or disable plugins to extend Claudia's functionality.
                                Plugins are disabled by default for security.
                            </div>
                            {plugins.length === 0 ? (
                                <div className="plugins-empty">
                                    No plugins available. Add plugins to the backend/plugins/ directory.
                                </div>
                            ) : (
                                <div className="plugins-list">
                                    {plugins.map((plugin) => (
                                        <div key={plugin.name} className="plugin-item">
                                            <div className="plugin-info">
                                                <div className="plugin-header">
                                                    <span className="plugin-name">{plugin.displayName}</span>
                                                    <span className="plugin-version">v{plugin.version}</span>
                                                    <span className={`plugin-type plugin-type-${plugin.type}`}>
                                                        {plugin.type}
                                                    </span>
                                                </div>
                                                <span className="plugin-description">
                                                    {plugin.description}
                                                </span>
                                                {plugin.author && (
                                                    <span className="plugin-author">by {plugin.author}</span>
                                                )}
                                            </div>
                                            <label className="toggle-switch">
                                                <input
                                                    type="checkbox"
                                                    checked={plugin.enabled}
                                                    onChange={(e) => handlePluginToggle(plugin.name, e.target.checked)}
                                                />
                                                <span className="toggle-slider"></span>
                                            </label>
                                        </div>
                                    ))}
                                </div>
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

                            {/* Effort Level */}
                            <div className="permission-item">
                                <div className="permission-info">
                                    <span className="permission-label">Effort Level</span>
                                    <span className="permission-description">
                                        Controls how much reasoning Claude invests before responding. Higher = more thinking tokens.
                                    </span>
                                </div>
                                <select
                                    className="cli-switch-select"
                                    value={cliSwitches.effortLevel || 'high'}
                                    onChange={(e) => handleCliSwitchToggle({ effortLevel: e.target.value })}
                                >
                                    <option value="low">Low (faster)</option>
                                    <option value="medium">Medium</option>
                                    <option value="high">High (default)</option>
                                </select>
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
