/**
 * TypeScript definitions for Electron API exposed via preload script
 */

/** Which release stream to follow. */
type UpdateChannel = 'stable' | 'prerelease';

/**
 * What the app does when an update is found.
 * - notify:          tell the user, download nothing
 * - download:        download in the background, then ask before installing
 * - install-on-quit: download, then apply silently when the user next quits
 */
type UpdateBehaviour = 'notify' | 'download' | 'install-on-quit';

/** Persisted updater preferences (owned by Electron main, never the backend). */
interface UpdaterPrefs {
    /** Master switch. When false, no update check ever runs. */
    enabled: boolean;
    channel: UpdateChannel;
    behaviour: UpdateBehaviour;
    checkIntervalHours: number;
    /** Set when the user rolled back; freezes updates at this version. */
    pinnedVersion: string | null;
    /** Suppress prompts for this one version, without freezing everything. */
    skippedVersion: string | null;
    /** ISO timestamp of the last completed check. */
    lastCheckedAt: string | null;
}

type UpdaterPhase =
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'up-to-date'
    | 'error'
    /** This build can never self-update (deb, unsigned macOS, npx, dev). */
    | 'unsupported';

interface UpdaterStatus {
    phase: UpdaterPhase;
    /** Version of the running app, e.g. "0.3.0". */
    currentVersion: string;
    /** Version being offered/downloaded, if any. */
    availableVersion: string | null;
    releaseNotes: string | null;
    releaseName: string | null;
    /** Download progress 0-100, only during phase === 'downloading'. */
    percent: number | null;
    bytesPerSecond: number | null;
    error: string | null;
    /** Human-readable reason when phase === 'unsupported'. */
    unsupportedReason: string | null;
    /** Tasks currently busy or awaiting input; a restart would interrupt these. */
    busyTaskCount: number;
    /** False while tasks are running — "Restart now" must be gated on this. */
    canInstallNow: boolean;
    lastCheckedAt: string | null;
    pinnedVersion: string | null;
}

/** One entry in the rollback/version-history list. */
interface ReleaseSummary {
    /** Bare version, e.g. "0.2.30". */
    version: string;
    /** Tag as published, e.g. "v0.2.30". */
    tag: string;
    name: string;
    publishedAt: string;
    prerelease: boolean;
    notes: string;
    /** False when this release has no updatable asset for the current platform. */
    installable: boolean;
    /** True when this is the version currently running. */
    current: boolean;
}

interface UpdaterAPI {
    getStatus: () => Promise<UpdaterStatus>;
    getPrefs: () => Promise<UpdaterPrefs>;
    setPrefs: (patch: Partial<UpdaterPrefs>) => Promise<UpdaterPrefs>;
    /** Manual "check now". Resolves once the check settles. */
    check: () => Promise<UpdaterStatus>;
    /** Begin downloading the currently offered update. */
    download: () => Promise<UpdaterStatus>;
    /**
     * Quit and apply a downloaded update. Refuses (ok:false) while tasks are
     * busy unless force is true.
     */
    installNow: (force?: boolean) => Promise<{ ok: boolean; reason?: string }>;
    /** Releases available for rollback, newest first. */
    listReleases: () => Promise<ReleaseSummary[]>;
    /** Download+pin a specific version (used for downgrade). */
    installVersion: (version: string) => Promise<UpdaterStatus>;
    /** Clear pinnedVersion and resume normal updates. */
    clearPin: () => Promise<UpdaterPrefs>;
    skipVersion: (version: string) => Promise<UpdaterPrefs>;
    /**
     * Open the GitHub releases page in the user's real browser. Use this rather
     * than a bare <a href>, which would navigate the Electron window itself.
     */
    openReleasesPage: () => Promise<void>;
    /** Subscribe to status pushes. Returns an unsubscribe function. */
    onEvent: (callback: (status: UpdaterStatus) => void) => () => void;
}

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

    /**
     * App auto-update control. Absent on older preload builds, so always
     * access via `window.electronAPI?.updater?.`.
     */
    updater?: UpdaterAPI;
}

interface Window {
    /**
     * Electron API exposed via contextBridge in preload script
     * Only available when running in Electron
     */
    electronAPI?: ElectronAPI;
}
