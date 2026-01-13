/**
 * File picker service supporting multiple platforms
 * - Electron native dialog
 * - HTML5 File System Access API (Chrome, Edge)
 */

import { getDirectorySelectionMethod, getUnsupportedFeatureMessage } from '../utils/browserCapabilities';

export interface FilePickerError {
    type: 'unsupported' | 'cancelled' | 'permission-denied' | 'unknown';
    message: string;
    originalError?: Error;
}

export interface FilePickerResult {
    success: boolean;
    path?: string;
    error?: FilePickerError;
}

/**
 * Select a directory using Electron's native dialog
 */
async function selectDirectoryElectron(): Promise<FilePickerResult> {
    try {
        if (!window.electronAPI) {
            return {
                success: false,
                error: {
                    type: 'unsupported',
                    message: 'Electron API is not available',
                },
            };
        }

        const selectedPath = await window.electronAPI.selectDirectory();

        if (!selectedPath) {
            return {
                success: false,
                error: {
                    type: 'cancelled',
                    message: 'Directory selection was cancelled',
                },
            };
        }

        return {
            success: true,
            path: selectedPath,
        };
    } catch (error) {
        console.error('[FilePickerService] Electron directory selection error:', error);
        return {
            success: false,
            error: {
                type: 'unknown',
                message: error instanceof Error ? error.message : 'Failed to select directory',
                originalError: error instanceof Error ? error : undefined,
            },
        };
    }
}

/**
 * Select a directory using HTML5 File System Access API
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker
 */
async function selectDirectoryFileSystemAPI(): Promise<FilePickerResult> {
    try {
        // Check if API is available
        if (!('showDirectoryPicker' in window)) {
            return {
                success: false,
                error: {
                    type: 'unsupported',
                    message: 'File System Access API is not supported in this browser',
                },
            };
        }

        // Request directory access
        const directoryHandle = await (window as any).showDirectoryPicker({
            mode: 'read',
        });

        if (!directoryHandle) {
            return {
                success: false,
                error: {
                    type: 'cancelled',
                    message: 'Directory selection was cancelled',
                },
            };
        }

        // Get the directory name
        // Note: File System Access API doesn't provide full paths for security reasons,
        // but we can use the directory name as the workspace identifier
        const directoryName = directoryHandle.name;

        // Return the directory name as the "path" - in browser mode, workspaces are
        // identified by name only, not full file system paths
        return {
            success: true,
            path: directoryName,
        };
    } catch (error) {
        console.error('[FilePickerService] File System Access API error:', error);

        // Handle specific error types
        if (error instanceof Error) {
            // User cancelled the picker
            if (error.name === 'AbortError') {
                return {
                    success: false,
                    error: {
                        type: 'cancelled',
                        message: 'Directory selection was cancelled',
                        originalError: error,
                    },
                };
            }

            // Permission denied
            if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
                return {
                    success: false,
                    error: {
                        type: 'permission-denied',
                        message: 'Permission to access directories was denied',
                        originalError: error,
                    },
                };
            }
        }

        return {
            success: false,
            error: {
                type: 'unknown',
                message: error instanceof Error ? error.message : 'Failed to select directory',
                originalError: error instanceof Error ? error : undefined,
            },
        };
    }
}

/**
 * Select a directory using the best available method
 * Automatically detects the environment and uses the appropriate API
 */
export async function selectDirectory(): Promise<FilePickerResult> {
    console.log('[FilePickerService] Starting directory selection...');

    const method = getDirectorySelectionMethod();
    console.log('[FilePickerService] Using method:', method);

    switch (method) {
        case 'electron':
            return await selectDirectoryElectron();

        case 'filesystem-api':
            return await selectDirectoryFileSystemAPI();

        case 'none':
            return {
                success: false,
                error: {
                    type: 'unsupported',
                    message: getUnsupportedFeatureMessage('directory-picker'),
                },
            };

        default:
            return {
                success: false,
                error: {
                    type: 'unsupported',
                    message: 'Unknown directory selection method',
                },
            };
    }
}

/**
 * Check if directory selection is available
 */
export function isDirectorySelectionAvailable(): boolean {
    return getDirectorySelectionMethod() !== 'none';
}

/**
 * Get information about the available directory selection method
 */
export function getDirectorySelectionInfo(): {
    available: boolean;
    method: 'electron' | 'filesystem-api' | 'none';
    message: string;
} {
    const method = getDirectorySelectionMethod();

    const messages = {
        electron: 'Using Electron native directory picker',
        'filesystem-api': 'Using HTML5 File System Access API',
        none: getUnsupportedFeatureMessage('directory-picker'),
    };

    return {
        available: method !== 'none',
        method,
        message: messages[method],
    };
}
