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

/**
 * Check if browser supports Notification API
 */
export function hasBrowserNotifications(): boolean {
    return typeof window !== 'undefined' && 'Notification' in window;
}

/**
 * Get current notification permission status
 */
export function getNotificationPermission(): NotificationPermission | 'unsupported' {
    if (!hasBrowserNotifications()) return 'unsupported';
    return Notification.permission;
}

/**
 * Request permission to show browser notifications
 * @returns Promise that resolves to the permission status
 */
export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
    if (!hasBrowserNotifications()) return 'unsupported';
    
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') return 'denied';
    
    try {
        const permission = await Notification.requestPermission();
        return permission;
    } catch (error) {
        console.error('Failed to request notification permission:', error);
        return 'denied';
    }
}

/**
 * Send a browser notification
 * @param title - Notification title
 * @param options - Optional notification options (body, icon, etc.)
 * @returns The Notification object if successful, null otherwise
 */
export function sendBrowserNotification(
    title: string,
    options?: NotificationOptions
): Notification | null {
    if (!hasBrowserNotifications()) {
        console.warn('Browser notifications not supported');
        return null;
    }
    
    if (Notification.permission !== 'granted') {
        console.warn('Notification permission not granted');
        return null;
    }
    
    try {
        const notification = new Notification(title, {
            icon: '/claudia-icon.png',
            badge: '/claudia-icon.png',
            ...options,
        });
        
        // Auto-close after 5 seconds
        setTimeout(() => notification.close(), 5000);
        
        // Focus window when notification is clicked
        notification.onclick = () => {
            window.focus();
            notification.close();
        };
        
        return notification;
    } catch (error) {
        console.error('Failed to send notification:', error);
        return null;
    }
}

/**
 * Send a task completion notification if tab is not visible
 * @param taskPrompt - The task prompt/description to include in notification
 * @returns true if notification was sent, false otherwise
 */
export function sendTaskCompletionNotification(taskPrompt?: string): boolean {
    // Only send notification if tab is not visible
    if (!document.hidden) {
        return false;
    }
    
    const body = taskPrompt 
        ? taskPrompt.length > 100 
            ? taskPrompt.substring(0, 100) + '...'
            : taskPrompt
        : 'A task has finished executing';
    
    const notification = sendBrowserNotification('Task Complete', {
        body,
        tag: 'task-complete', // Prevents duplicate notifications
    });
    
    return notification !== null;
}
