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

  /**
   * Read text from clipboard
   */
  readClipboard: () => string;

  /**
   * Write text to clipboard
   */
  writeClipboard: (text: string) => void;

  /**
   * Exit fullscreen mode
   */
  exitFullscreen: () => Promise<void>;

  /**
   * Listen for fullscreen state changes
   * @returns Cleanup function to remove listener
   */
  onFullscreenChanged: (callback: (isFullscreen: boolean) => void) => () => void;
}

interface Window {
  /**
   * Electron API exposed via contextBridge in preload script
   * Only available when running in Electron
   */
  electronAPI?: ElectronAPI;
}
