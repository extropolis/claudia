/**
 * TypeScript definitions for Electron API exposed via preload script
 */

interface ElectronAPI {
    /**
     * Get the backend server URL
     * @returns Backend URL (e.g., "http://localhost:3001")
     */
    getBackendUrl: () => string;

    /**
     * Open a directory picker dialog
     * @returns Promise resolving to selected directory path or null if cancelled
     */
    selectDirectory: () => Promise<string | null>;

    /**
     * Check if running in Electron
     * @returns true
     */
    isElectron: () => boolean;
}

interface Window {
    /**
     * Electron API exposed via contextBridge in preload script
     * Only available when running in Electron
     */
    electronAPI?: ElectronAPI;
}
