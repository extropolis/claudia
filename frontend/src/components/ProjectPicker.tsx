import { useEffect, useCallback, useState, MutableRefObject } from 'react';
import { useTaskStore } from '../stores/taskStore';
import { selectDirectory } from '../services/filePickerService';
import { getBrowserCapabilities } from '../utils/browserCapabilities';
import { PathInputModal } from './PathInputModal';
import { RecentWorkspace } from '@claudia/shared';
import { getApiBaseUrl } from '../config/api-config';

interface ProjectPickerProps {
    onSelect: (path: string) => void;
    wsRef: MutableRefObject<WebSocket | null>;
    requestRecentWorkspaces: () => void;
    clearRecentWorkspace: (workspaceId?: string) => void;
}

export function ProjectPicker({ onSelect, wsRef, requestRecentWorkspaces, clearRecentWorkspace }: ProjectPickerProps) {
    const { showProjectPicker, setShowProjectPicker } = useTaskStore();
    const [showPathInput, setShowPathInput] = useState(false);
    const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspace[]>([]);
    const [isBrowsing, setIsBrowsing] = useState(false);
    const [defaultBaseDirectory, setDefaultBaseDirectory] = useState<string | undefined>(undefined);

    // Fetch default base directory from config when modal opens
    useEffect(() => {
        if (!showPathInput) return;

        const fetchConfig = async () => {
            try {
                const response = await fetch(`${getApiBaseUrl()}/api/config`);
                if (response.ok) {
                    const config = await response.json();
                    setDefaultBaseDirectory(config.defaultBaseDirectory);
                }
            } catch (err) {
                console.error('[ProjectPicker] Failed to fetch config:', err);
            }
        };

        fetchConfig();
    }, [showPathInput]);

    // Listen for recent workspaces and browse folder responses on the shared WebSocket
    useEffect(() => {
        if (!showPathInput) return;

        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.warn('[ProjectPicker] WebSocket not ready, cannot fetch recent workspaces');
            return;
        }

        // Listen for responses on the shared WebSocket
        const handler = (event: MessageEvent) => {
            try {
                const message = JSON.parse(event.data);
                if (message.type === 'workspace:recent:list') {
                    console.log('[ProjectPicker] Received recent workspaces:', message.payload.recentWorkspaces);
                    setRecentWorkspaces(message.payload.recentWorkspaces || []);
                } else if (message.type === 'workspace:browseFolder') {
                    setIsBrowsing(false);
                    const selectedPath = message.payload?.path;
                    if (selectedPath) {
                        console.log('[ProjectPicker] Browse selected path:', selectedPath);
                        onSelect(selectedPath);
                        setShowPathInput(false);
                    } else {
                        console.log('[ProjectPicker] Browse cancelled');
                    }
                }
            } catch (err) {
                console.error('[ProjectPicker] Error parsing message:', err);
            }
        };

        ws.addEventListener('message', handler);

        // Request recent workspaces through the shared connection
        console.log('[ProjectPicker] Requesting recent workspaces via shared WebSocket');
        requestRecentWorkspaces();

        return () => {
            ws.removeEventListener('message', handler);
        };
    }, [showPathInput, wsRef, requestRecentWorkspaces, onSelect]);

    const handleFolderSelect = useCallback(async () => {
        try {
            console.log('[ProjectPicker] Opening folder selection dialog...');

            const capabilities = getBrowserCapabilities();
            const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

            // In Electron mode, always use native dialog
            if (capabilities.directorySelectionMethod === 'electron') {
                console.log('[ProjectPicker] Using Electron native picker');
                const result = await selectDirectory();
                if (result.success && result.path) {
                    console.log('[ProjectPicker] Selected path:', result.path);
                    onSelect(result.path);
                } else if (result.error && result.error.type !== 'cancelled') {
                    alert(result.error.message || 'Failed to select directory');
                }
                setShowProjectPicker(false);
                return;
            }

            // On localhost, use path input modal with backend browse button
            // (File System Access API doesn't work for localhost because it only returns directory names, not full paths)
            if (isLocalhost) {
                console.log('[ProjectPicker] Localhost detected, showing path input modal with backend browse option');
                setShowPathInput(true);
                setShowProjectPicker(false);
                return;
            }

            // For remote/tunnel access in modern browsers, use File System Access API
            if (capabilities.directorySelectionMethod === 'filesystem-api') {
                console.log('[ProjectPicker] Using File System Access API for remote browser');
                const result = await selectDirectory();
                if (result.success && result.path) {
                    console.log('[ProjectPicker] Selected directory:', result.path);
                    onSelect(result.path);
                } else if (result.error && result.error.type !== 'cancelled') {
                    alert(result.error.message || 'Failed to select directory');
                }
                setShowProjectPicker(false);
                return;
            }

            // Fallback: show path input modal (for unsupported browsers)
            console.log('[ProjectPicker] No native picker available, showing path input modal');
            setShowPathInput(true);
            setShowProjectPicker(false);
        } catch (error) {
            console.error('[ProjectPicker] Unexpected error:', error);
            alert(error instanceof Error ? error.message : 'Failed to select directory');
            setShowProjectPicker(false);
        }
    }, [onSelect, setShowProjectPicker]);

    useEffect(() => {
        if (showProjectPicker) {
            console.log('[ProjectPicker] showProjectPicker triggered');
            handleFolderSelect();
        }
    }, [showProjectPicker, handleFolderSelect]);

    const handlePathSubmit = (path: string) => {
        console.log('[ProjectPicker] Manual path submitted:', path);
        onSelect(path);
        setShowPathInput(false);
    };

    const handlePathCancel = () => {
        console.log('[ProjectPicker] Path input cancelled');
        setShowPathInput(false);
    };

    const handleBrowse = useCallback(async () => {
        console.log('[ProjectPicker] Requesting native folder picker via REST endpoint');
        setIsBrowsing(true);
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/browse-folder`, { method: 'POST' });
            const data = await res.json();
            if (data.success && data.path) {
                console.log('[ProjectPicker] Browse selected path:', data.path);
                onSelect(data.path);
                setShowPathInput(false);
            } else {
                console.log('[ProjectPicker] Browse cancelled');
            }
        } catch (err) {
            console.error('[ProjectPicker] Browse failed:', err);
        } finally {
            setIsBrowsing(false);
        }
    }, [onSelect]);

    const handleRemoveRecent = (workspaceId: string) => {
        console.log('[ProjectPicker] Removing recent workspace:', workspaceId);
        // Remove from local state immediately for responsive UI
        setRecentWorkspaces(prev => prev.filter(w => w.id !== workspaceId));
        // Send to server via shared WebSocket
        clearRecentWorkspace(workspaceId);
    };

    return (
        <>
            {showPathInput && (
                <PathInputModal
                    onSubmit={handlePathSubmit}
                    onCancel={handlePathCancel}
                    recentWorkspaces={recentWorkspaces}
                    onRemoveRecent={handleRemoveRecent}
                    onBrowse={handleBrowse}
                    isBrowsing={isBrowsing}
                    showBrowseButton={!!window.electronAPI}
                    defaultBaseDirectory={defaultBaseDirectory}
                />
            )}
        </>
    );
}
