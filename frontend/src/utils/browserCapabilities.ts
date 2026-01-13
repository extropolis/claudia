/**
 * Browser capability detection and feature checks
 */

/**
 * Check if running in Electron environment
 */
export function isElectron(): boolean {
    return typeof window !== 'undefined' && window.electronAPI !== undefined;
}

/**
 * Check if File System Access API is available
 * @see https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API
 */
export function hasFileSystemAccess(): boolean {
    return (
        typeof window !== 'undefined' &&
        'showDirectoryPicker' in window &&
        typeof (window as any).showDirectoryPicker === 'function'
    );
}

/**
 * Get available directory selection method
 * Returns the best available method for selecting directories
 */
export function getDirectorySelectionMethod(): 'electron' | 'filesystem-api' | 'none' {
    if (isElectron()) {
        return 'electron';
    }
    if (hasFileSystemAccess()) {
        return 'filesystem-api';
    }
    return 'none';
}

/**
 * Check if browser supports clipboard API
 */
export function hasClipboardAPI(): boolean {
    return (
        typeof navigator !== 'undefined' &&
        navigator.clipboard !== undefined &&
        typeof navigator.clipboard.writeText === 'function'
    );
}

/**
 * Get user-friendly error message for unsupported features
 */
export function getUnsupportedFeatureMessage(feature: string): string {
    const messages: Record<string, string> = {
        'directory-picker':
            'Directory selection is not available in your browser. ' +
            'Please use the Electron app or a modern browser with File System Access API support ' +
            '(Chrome 86+, Edge 86+).',
        'clipboard':
            'Clipboard access is not available. Please copy the text manually.',
    };
    return messages[feature] || `This feature (${feature}) is not supported in your current environment.`;
}

/**
 * Browser compatibility information
 */
export interface BrowserCapabilities {
    isElectron: boolean;
    hasFileSystemAccess: boolean;
    hasClipboardAPI: boolean;
    directorySelectionMethod: 'electron' | 'filesystem-api' | 'none';
}

/**
 * Get all browser capabilities at once
 */
export function getBrowserCapabilities(): BrowserCapabilities {
    return {
        isElectron: isElectron(),
        hasFileSystemAccess: hasFileSystemAccess(),
        hasClipboardAPI: hasClipboardAPI(),
        directorySelectionMethod: getDirectorySelectionMethod(),
    };
}
