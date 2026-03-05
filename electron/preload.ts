import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload script - Security bridge between main and renderer processes
 * Exposes safe APIs to the renderer via contextBridge
 */

// Read backend URL from query parameter (passed by main process at load time)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pageUrl: string = (globalThis as any).location?.search || '';
const urlParams = new URLSearchParams(pageUrl);
const backendUrl: string = urlParams.get('backendUrl') || 'http://localhost:3001';
console.log('[Preload] Backend URL:', backendUrl);

// Expose safe APIs to renderer process
contextBridge.exposeInMainWorld('electronAPI', {
    /**
     * Get the backend server URL
     * @returns The backend URL (e.g., "http://localhost:3001")
     */
    getBackendUrl: (): string => {
        return backendUrl;
    },

    /**
     * Open a directory picker dialog
     * @returns Promise<string | null> - Selected directory path or null if cancelled
     */
    selectDirectory: async (): Promise<string | null> => {
        return ipcRenderer.invoke('select-directory');
    },

    /**
     * Check if running in Electron
     * @returns true
     */
    isElectron: (): boolean => {
        return true;
    }
});

console.log('[Preload] Script loaded successfully');
