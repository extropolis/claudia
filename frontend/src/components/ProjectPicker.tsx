import { useEffect, useCallback, useState } from 'react';
import { useTaskStore } from '../stores/taskStore';
import { useNotification } from './NotificationContainer';
import { selectDirectory, getDirectorySelectionInfo } from '../services/filePickerService';
import { getBrowserCapabilities } from '../utils/browserCapabilities';
import { PathInputModal } from './PathInputModal';

interface ProjectPickerProps {
    onSelect: (path: string) => void;
}

export function ProjectPicker({ onSelect }: ProjectPickerProps) {
    const { showProjectPicker, setShowProjectPicker } = useTaskStore();
    const notification = useNotification();
    const [showPathInput, setShowPathInput] = useState(false);

    const handleFolderSelect = useCallback(async () => {
        try {
            console.log('[ProjectPicker] Opening folder selection dialog...');

            // Get browser capabilities
            const capabilities = getBrowserCapabilities();
            console.log('[ProjectPicker] Browser capabilities:', capabilities);

            // Get directory selection info
            const selectionInfo = getDirectorySelectionInfo();
            console.log('[ProjectPicker] Selection method:', selectionInfo);

            // Check if directory selection is available
            if (!selectionInfo.available) {
                console.error('[ProjectPicker] Directory selection not available');
                notification.showError(
                    'Directory Selection Unavailable',
                    selectionInfo.message
                );
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

            // Attempt to select directory
            console.log('[ProjectPicker] Calling selectDirectory...');
            const result = await selectDirectory();
            console.log('[ProjectPicker] Selection result:', result);

            if (result.success && result.path) {
                console.log('[ProjectPicker] Selected path:', result.path);
                notification.showSuccess(
                    'Workspace Selected',
                    `Selected: ${result.path}`
                );
                onSelect(result.path);
            } else if (result.error) {
                // Handle different error types
                switch (result.error.type) {
                    case 'cancelled':
                        console.log('[ProjectPicker] Selection cancelled by user');
                        // Don't show notification for user cancellation
                        break;

                    case 'permission-denied':
                        console.error('[ProjectPicker] Permission denied:', result.error);
                        notification.showError(
                            'Permission Denied',
                            result.error.message
                        );
                        break;

                    case 'unsupported':
                        console.error('[ProjectPicker] Unsupported:', result.error);
                        notification.showError(
                            'Unsupported Feature',
                            result.error.message
                        );
                        break;

                    case 'unknown':
                    default:
                        console.error('[ProjectPicker] Unknown error:', result.error);
                        notification.showError(
                            'Selection Failed',
                            result.error.message || 'An unexpected error occurred'
                        );
                        break;
                }
            }
        } catch (error) {
            console.error('[ProjectPicker] Unexpected error:', error);
            notification.showError(
                'Unexpected Error',
                error instanceof Error ? error.message : 'Failed to select directory'
            );
        } finally {
            setShowProjectPicker(false);
        }
    }, [onSelect, setShowProjectPicker, notification]);

    useEffect(() => {
        if (showProjectPicker) {
            console.log('[ProjectPicker] showProjectPicker triggered');
            handleFolderSelect();
        }
    }, [showProjectPicker, handleFolderSelect]);

    const handlePathSubmit = (path: string) => {
        console.log('[ProjectPicker] Manual path submitted:', path);
        notification.showSuccess(
            'Workspace Selected',
            `Selected: ${path}`
        );
        onSelect(path);
        setShowPathInput(false);
    };

    const handlePathCancel = () => {
        console.log('[ProjectPicker] Path input cancelled');
        setShowPathInput(false);
    };

    return (
        <>
            {showPathInput && (
                <PathInputModal
                    onSubmit={handlePathSubmit}
                    onCancel={handlePathCancel}
                />
            )}
        </>
    );
}
