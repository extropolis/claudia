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
    },

    /**
     * Read text from clipboard
     */
    readClipboard: (): string => {
        return ipcRenderer.sendSync('clipboard-read');
    },

    /**
     * Write text to clipboard
     */
    writeClipboard: (text: string): void => {
        ipcRenderer.send('clipboard-write', text);
    },

    /**
     * Exit fullscreen mode
     */
    exitFullscreen: (): Promise<void> => {
        return ipcRenderer.invoke('exit-fullscreen');
    },

    /**
     * Listen for fullscreen state changes
     */
    onFullscreenChanged: (callback: (isFullscreen: boolean) => void): (() => void) => {
        const handler = (_event: Electron.IpcRendererEvent, isFullscreen: boolean) => callback(isFullscreen);
        ipcRenderer.on('fullscreen-changed', handler);
        return () => ipcRenderer.removeListener('fullscreen-changed', handler);
    },

    /**
     * App auto-update control.
     *
     * Deliberately an IPC bridge rather than a backend REST route: the backend
     * is reachable over the ngrok tunnel, and a remote client must never be
     * able to downgrade or restart the desktop app. See issue #237.
     */
    updater: {
        getStatus: () => ipcRenderer.invoke('updater:get-status'),
        getPrefs: () => ipcRenderer.invoke('updater:get-prefs'),
        setPrefs: (patch: unknown) => ipcRenderer.invoke('updater:set-prefs', patch),
        check: () => ipcRenderer.invoke('updater:check'),
        download: () => ipcRenderer.invoke('updater:download'),
        installNow: (force?: boolean) => ipcRenderer.invoke('updater:install-now', force === true),
        listReleases: () => ipcRenderer.invoke('updater:list-releases'),
        installVersion: (version: string) => ipcRenderer.invoke('updater:install-version', version),
        clearPin: () => ipcRenderer.invoke('updater:clear-pin'),
        skipVersion: (version: string) => ipcRenderer.invoke('updater:skip-version', version),
        openReleasesPage: () => ipcRenderer.invoke('updater:open-releases-page'),
        onEvent: (callback: (status: unknown) => void): (() => void) => {
            const handler = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
            ipcRenderer.on('updater:event', handler);
            return () => ipcRenderer.removeListener('updater:event', handler);
        }
    }
});

console.log('[Preload] Script loaded successfully');
