import { useEffect, useCallback, useState, useRef } from 'react';
import { useTaskStore } from '../stores/taskStore';
import { selectDirectory, getDirectorySelectionInfo } from '../services/filePickerService';
import { getBrowserCapabilities } from '../utils/browserCapabilities';
import { PathInputModal } from './PathInputModal';
import { RecentWorkspace } from '@claudia/shared';
import { getWebSocketUrl } from '../config/api-config';

interface ProjectPickerProps {
    onSelect: (path: string) => void;
}

export function ProjectPicker({ onSelect }: ProjectPickerProps) {
    const { showProjectPicker, setShowProjectPicker } = useTaskStore();
    const [showPathInput, setShowPathInput] = useState(false);
    const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspace[]>([]);
    const wsRef = useRef<WebSocket | null>(null);

    // Set up WebSocket listener for recent workspaces
    useEffect(() => {
        // Only create listener when path input is shown
        if (!showPathInput) return;

        // Connect to existing WebSocket or create a new connection
        const ws = new WebSocket(getWebSocketUrl());

        ws.onopen = () => {
            console.log('[ProjectPicker] Requesting recent workspaces');
            ws.send(JSON.stringify({ type: 'workspace:recent:list', payload: {} }));
        };

        ws.onmessage = (event) => {
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

        wsRef.current = ws;

        return () => {
            ws.close();
            wsRef.current = null;
        };
    }, [showPathInput]);

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
        // Send to server
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
                type: 'workspace:recent:clear',
                payload: { workspaceId }
            }));
        }
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
