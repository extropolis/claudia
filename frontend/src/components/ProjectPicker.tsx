import { useEffect, useCallback, useState, MutableRefObject } from 'react';
import { useTaskStore } from '../stores/taskStore';
import { selectDirectory, getDirectorySelectionInfo } from '../services/filePickerService';
import { getBrowserCapabilities } from '../utils/browserCapabilities';
import { PathInputModal } from './PathInputModal';
import { RecentWorkspace } from '@claudia/shared';

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

    // Listen for recent workspaces response on the shared WebSocket
    useEffect(() => {
        if (!showPathInput) return;

        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.warn('[ProjectPicker] WebSocket not ready, cannot fetch recent workspaces');
            return;
        }

        // Listen for the response on the shared WebSocket
        const handler = (event: MessageEvent) => {
            try {
                const message = JSON.parse(event.data);
                if (message.type === 'workspace:recent:list') {
                    console.log('[ProjectPicker] Received recent workspaces:', message.payload.recentWorkspaces);
                    setRecentWorkspaces(message.payload.recentWorkspaces || []);
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
    }, [showPathInput, wsRef, requestRecentWorkspaces]);

    const handleFolderSelect = useCallback(async () => {
        try {
            console.log('[ProjectPicker] Opening folder selection dialog...');

            const capabilities = getBrowserCapabilities();
            const selectionInfo = getDirectorySelectionInfo();

            if (!selectionInfo.available) {
                console.error('[ProjectPicker] Directory selection not available');
                alert(selectionInfo.message);
                setShowProjectPicker(false);
                return;
            }

            // In browser mode, show path input modal instead
            if (capabilities.directorySelectionMethod === 'filesystem-api') {
                console.log('[ProjectPicker] Browser mode detected, showing path input modal');
                setShowPathInput(true);
                setShowProjectPicker(false);
                return;
            }

            const result = await selectDirectory();

            if (result.success && result.path) {
                console.log('[ProjectPicker] Selected path:', result.path);
                onSelect(result.path);
            } else if (result.error && result.error.type !== 'cancelled') {
                alert(result.error.message || 'Failed to select directory');
            }
        } catch (error) {
            console.error('[ProjectPicker] Unexpected error:', error);
            alert(error instanceof Error ? error.message : 'Failed to select directory');
        } finally {
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
                />
            )}
        </>
    );
}
