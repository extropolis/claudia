import { contextBridge, ipcRenderer } from 'electron';
/**
 * Preload script - Security bridge between main and renderer processes
 * Exposes safe APIs to the renderer via contextBridge
 */
// The backend URL will be sent from main process after server starts
let backendUrl = 'http://localhost:3001'; // Default fallback
// Listen for backend URL from main process
ipcRenderer.on('backend-url', (_event, url) => {
    backendUrl = url;
    console.log('[Preload] Backend URL received:', url);
});
// Expose safe APIs to renderer process
contextBridge.exposeInMainWorld('electronAPI', {
    /**
     * Get the backend server URL
     * @returns The backend URL (e.g., "http://localhost:3001")
     */
    getBackendUrl: () => {
        return backendUrl;
    },
    /**
     * Open a directory picker dialog
     * @returns Promise<string | null> - Selected directory path or null if cancelled
     */
    selectDirectory: async () => {
        return ipcRenderer.invoke('select-directory');
    },
    /**
     * Check if running in Electron
     * @returns true
     */
    isElectron: () => {
        return true;
    }
});
console.log('[Preload] Script loaded successfully');
