/**
 * Electron-facing updater shell.
 *
 * All decision-making lives in `updater-policy.ts` (pure, unit-tested). This
 * file is the thin, hard-to-test layer: electron-updater wiring, prefs on
 * disk, IPC, and pushing status to the renderer.
 *
 * Two invariants worth stating explicitly, both from issue #237:
 *
 * 1. Update state lives HERE, not in the backend config store. The backend is
 *    reachable over the ngrok tunnel (`tunnel-manager.ts`), and a remote phone
 *    must never be able to downgrade someone's desktop app.
 *
 * 2. Nothing in this file calls `app.quit()` on its own. The only restart is
 *    the user pressing "Restart now", and even that is gated on no tasks being
 *    in flight — quitting tears down the backend utility process and every PTY
 *    with it.
 */

import { app, ipcMain, BrowserWindow, shell } from 'electron';
import { join } from 'path';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import electronUpdater, { type UpdateInfo } from 'electron-updater';

import {
    DEFAULT_PREFS,
    normalizeReleaseNotes,
    RELEASES_API_URL,
    RELEASES_PAGE_URL,
    applyPrefsPatch,
    compareVersions,
    countBusyTasks,
    detectUpdateSupport,
    feedUrlForVersion,
    isValidVersion,
    normalizePrefs,
    releaseIsInstallable,
    resolveFeedUrl,
    shouldAutoDownload,
    shouldCheckNow,
    shouldInstallOnQuit,
    shouldPromptForVersion,
    versionFromTag,
    type UpdaterPhase,
    type UpdaterPrefs,
    type UpdateSupport
} from './updater-policy.js';

// electron-updater is CJS; this is the interop-safe way to reach autoUpdater
// from an ESM module (electron/tsconfig.json compiles to ESNext modules).
const { autoUpdater } = electronUpdater;

export interface UpdaterStatus {
    phase: UpdaterPhase;
    currentVersion: string;
    availableVersion: string | null;
    releaseNotes: string | null;
    releaseName: string | null;
    percent: number | null;
    bytesPerSecond: number | null;
    error: string | null;
    unsupportedReason: string | null;
    busyTaskCount: number;
    canInstallNow: boolean;
    lastCheckedAt: string | null;
    pinnedVersion: string | null;
}

export interface ReleaseSummary {
    version: string;
    tag: string;
    name: string;
    publishedAt: string;
    prerelease: boolean;
    notes: string;
    installable: boolean;
    current: boolean;
}

interface InitOptions {
    getWindow: () => BrowserWindow | null;
    /** Backend base URL, used to count in-flight tasks before a restart. */
    getBackendUrl: () => string | null;
    /** Stop the backend utility process gracefully before an install restart. */
    stopBackend: () => Promise<void>;
}

const LOG_PREFIX = '[Updater]';

let prefs: UpdaterPrefs = { ...DEFAULT_PREFS };
let support: UpdateSupport = { supported: false, reason: null };
let options: InitOptions | null = null;
let prefsPath = '';
let checkTimer: NodeJS.Timeout | null = null;
let initialised = false;

/** Guards against overlapping checks/downloads triggered from the UI. */
let inFlight: Promise<UpdaterStatus> | null = null;

/**
 * Set while an explicit downgrade is running so the `update-downloaded`
 * handler knows to write the pin.
 */
let pendingPinVersion: string | null = null;

const state = {
    phase: 'idle' as UpdaterPhase,
    availableVersion: null as string | null,
    releaseNotes: null as string | null,
    releaseName: null as string | null,
    percent: null as number | null,
    bytesPerSecond: null as number | null,
    error: null as string | null,
    busyTaskCount: 0
};

// ---------------------------------------------------------------------------
// Prefs persistence
// ---------------------------------------------------------------------------

function loadPrefs(): UpdaterPrefs {
    try {
        const raw = JSON.parse(readFileSync(prefsPath, 'utf-8'));
        return normalizePrefs(raw);
    } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT') {
            console.warn(`${LOG_PREFIX} Could not read ${prefsPath}, using defaults:`, String(err));
        }
        return { ...DEFAULT_PREFS };
    }
}

function savePrefs(next: UpdaterPrefs): void {
    prefs = next;
    try {
        mkdirSync(join(prefsPath, '..'), { recursive: true });
        writeFileSync(prefsPath, JSON.stringify(next, null, 2), 'utf-8');
    } catch (err) {
        console.error(`${LOG_PREFIX} Failed to persist prefs:`, String(err));
    }
    applyPrefsToUpdater();
    scheduleNextCheck();
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function currentVersion(): string {
    try {
        return app.getVersion();
    } catch {
        return '0.0.0';
    }
}

function buildStatus(): UpdaterStatus {
    return {
        phase: support.supported ? state.phase : 'unsupported',
        currentVersion: currentVersion(),
        availableVersion: state.availableVersion,
        releaseNotes: state.releaseNotes,
        releaseName: state.releaseName,
        percent: state.percent,
        bytesPerSecond: state.bytesPerSecond,
        error: state.error,
        unsupportedReason: support.supported ? null : support.reason,
        busyTaskCount: state.busyTaskCount,
        canInstallNow: state.busyTaskCount === 0,
        lastCheckedAt: prefs.lastCheckedAt,
        pinnedVersion: prefs.pinnedVersion
    };
}

function broadcast(): void {
    const status = buildStatus();
    try {
        options?.getWindow()?.webContents.send('updater:event', status);
    } catch {
        // Window torn down mid-broadcast; nothing to do.
    }
}

function setPhase(phase: UpdaterPhase, patch: Partial<typeof state> = {}): void {
    state.phase = phase;
    Object.assign(state, patch);
    console.log(`${LOG_PREFIX} phase=${phase}${state.availableVersion ? ` version=${state.availableVersion}` : ''}${state.error ? ` error=${state.error}` : ''}`);
    broadcast();
}

/**
 * Refresh the in-flight task count from the backend.
 *
 * A failed fetch is treated as "nothing running": if the backend is
 * unreachable its PTYs are already gone, so there is nothing left for a
 * restart to interrupt.
 */
async function refreshBusyCount(): Promise<number> {
    const base = options?.getBackendUrl?.() ?? null;
    if (!base) {
        state.busyTaskCount = 0;
        return 0;
    }
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(`${base}/api/tasks`, { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const tasks = Array.isArray(body) ? body : [];
        state.busyTaskCount = countBusyTasks(tasks);
    } catch (err) {
        console.warn(`${LOG_PREFIX} Could not read task states (${String(err)}); assuming none are running.`);
        state.busyTaskCount = 0;
    }
    return state.busyTaskCount;
}

// ---------------------------------------------------------------------------
// electron-updater configuration
// ---------------------------------------------------------------------------

/** Set by the sim harness to point at a local fake feed. */
const simFeed = process.env.CLAUDIA_UPDATER_SIM_FEED;

function applyPrefsToUpdater(): void {
    autoUpdater.autoDownload = false;              // we drive downloads explicitly
    autoUpdater.autoInstallOnAppQuit = shouldInstallOnQuit(prefs);
    autoUpdater.allowPrerelease = prefs.channel === 'prerelease';
    // Don't clobber an in-flight downgrade: the pin is only written once the
    // download succeeds, so between "user asked for v0.2.30" and
    // "update-downloaded", prefs.pinnedVersion is still null. Recomputing
    // allowDowngrade from prefs here would flip it back to false mid-rollback
    // and the check would reject the older version.
    autoUpdater.allowDowngrade = pendingPinVersion !== null || Boolean(prefs.pinnedVersion);

    // A pinned feed must also survive an unrelated prefs write (e.g. the
    // lastCheckedAt bump), which is why the feed is recomputed from prefs
    // rather than left at whatever the last operation set.
    if (simFeed) {
        // In an unpackaged build electron-updater re-reads its provider config
        // from disk when downloading, so the sim harness writes a
        // dev-app-update.yml and points us at it. Without this the check
        // succeeds but the download fails with ENOENT.
        autoUpdater.forceDevUpdateConfig = true;
        const simConfig = process.env.CLAUDIA_UPDATER_SIM_CONFIG;
        if (simConfig) autoUpdater.updateConfigPath = simConfig;
        autoUpdater.setFeedURL({ provider: 'generic', url: simFeed });
        return;
    }

    // Same reasoning as allowDowngrade above: while a specific-version install
    // is in flight the feed points at that one release's directory, and a
    // prefs write (from the user changing a setting mid-download) must not
    // yank it back to the "newest release" feed.
    const feed = pendingPinVersion !== null
        ? feedUrlForVersion(pendingPinVersion)
        : resolveFeedUrl(prefs);
    autoUpdater.setFeedURL(feed as Parameters<typeof autoUpdater.setFeedURL>[0]);
}

function wireUpdaterEvents(): void {
    autoUpdater.on('checking-for-update', () => {
        setPhase('checking', { error: null });
    });

    autoUpdater.on('update-available', (info: UpdateInfo) => {
        const version = String(info?.version ?? '');
        // Can be an array when the user is several versions behind.
        const notes = normalizeReleaseNotes(info?.releaseNotes);

        // A pinned/downgrade flow bypasses the "is it newer?" gate on purpose.
        const forced = pendingPinVersion !== null;
        if (!forced && !shouldPromptForVersion(prefs, currentVersion(), version)) {
            console.log(`${LOG_PREFIX} Ignoring ${version} (skipped or not newer than ${currentVersion()}).`);
            setPhase('up-to-date', { availableVersion: null, releaseNotes: null, releaseName: null });
            return;
        }

        setPhase('available', {
            availableVersion: version,
            releaseNotes: notes,
            releaseName: info?.releaseName ? String(info.releaseName) : null,
            error: null
        });

        if (forced || shouldAutoDownload(prefs)) {
            void startDownload();
        }
    });

    autoUpdater.on('update-not-available', () => {
        setPhase('up-to-date', { availableVersion: null, releaseNotes: null, releaseName: null, error: null });
    });

    autoUpdater.on('download-progress', (p: { percent?: number; bytesPerSecond?: number }) => {
        state.percent = typeof p?.percent === 'number' ? Math.max(0, Math.min(100, p.percent)) : null;
        state.bytesPerSecond = typeof p?.bytesPerSecond === 'number' ? p.bytesPerSecond : null;
        state.phase = 'downloading';
        broadcast();
    });

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
        const version = String(info?.version ?? state.availableVersion ?? '');

        // A completed downgrade is what actually writes the pin — pinning any
        // earlier would strand the user if the download failed.
        if (pendingPinVersion && pendingPinVersion === version) {
            console.log(`${LOG_PREFIX} Pinning to ${version} after successful downgrade download.`);
            savePrefs({ ...prefs, pinnedVersion: version });
        }
        pendingPinVersion = null;

        void refreshBusyCount().then(() => {
            setPhase('downloaded', { availableVersion: version, percent: 100 });
        });
    });

    autoUpdater.on('error', (err: Error) => {
        pendingPinVersion = null;
        setPhase('error', { error: err?.message ? String(err.message) : String(err) });
    });
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Wait for the updater to settle into a terminal phase.
 *
 * electron-updater's promises resolve when the *request* completes, not when
 * the resulting state transition has happened, so the IPC callers await this
 * instead to get a status the UI can render immediately.
 */
function settle(timeoutMs = 60_000): Promise<UpdaterStatus> {
    const terminal: UpdaterPhase[] = ['available', 'up-to-date', 'downloaded', 'error', 'unsupported'];
    return new Promise(resolve => {
        const started = Date.now();
        const tick = () => {
            if (terminal.includes(state.phase) || Date.now() - started > timeoutMs) {
                resolve(buildStatus());
                return;
            }
            setTimeout(tick, 150);
        };
        tick();
    });
}

async function runCheck(manual: boolean): Promise<UpdaterStatus> {
    if (!support.supported) return buildStatus();
    if (!manual && !shouldCheckNow(prefs)) {
        console.log(`${LOG_PREFIX} Scheduled check skipped (enabled=${prefs.enabled} pinned=${prefs.pinnedVersion ?? 'none'}).`);
        return buildStatus();
    }
    if (!manual && !prefs.enabled) return buildStatus();
    if (inFlight) return inFlight;

    const run = (async () => {
        try {
            applyPrefsToUpdater();
            console.log(`${LOG_PREFIX} Checking for updates (manual=${manual}, channel=${prefs.channel})...`);
            await autoUpdater.checkForUpdates();
            savePrefs({ ...prefs, lastCheckedAt: new Date().toISOString() });
            return await settle();
        } catch (err) {
            setPhase('error', { error: String((err as Error)?.message ?? err) });
            return buildStatus();
        } finally {
            inFlight = null;
        }
    })();

    inFlight = run;
    return run;
}

async function startDownload(): Promise<UpdaterStatus> {
    if (!support.supported) return buildStatus();
    try {
        setPhase('downloading', { percent: 0, error: null });
        await autoUpdater.downloadUpdate();
        return await settle(30 * 60_000);
    } catch (err) {
        setPhase('error', { error: String((err as Error)?.message ?? err) });
        return buildStatus();
    }
}

/**
 * Download and pin a specific version. This is the rollback path; it is also
 * how a user reinstalls a version they previously skipped.
 */
async function installVersion(version: string): Promise<UpdaterStatus> {
    if (!support.supported) return buildStatus();
    if (!isValidVersion(version)) {
        setPhase('error', { error: `Invalid version: ${String(version)}` });
        return buildStatus();
    }

    const isDowngrade = compareVersions(version, currentVersion()) < 0;
    console.log(`${LOG_PREFIX} Installing specific version ${version} (downgrade=${isDowngrade}).`);

    try {
        pendingPinVersion = version;
        // A specific-version install must be allowed to move backwards.
        autoUpdater.allowDowngrade = true;
        autoUpdater.setFeedURL(feedUrlForVersion(version) as Parameters<typeof autoUpdater.setFeedURL>[0]);
        setPhase('checking', { error: null });
        await autoUpdater.checkForUpdates();
        return await settle(30 * 60_000);
    } catch (err) {
        pendingPinVersion = null;
        setPhase('error', { error: String((err as Error)?.message ?? err) });
        // Restore the normal feed so a failed rollback doesn't strand the app
        // pointed at a dead URL.
        applyPrefsToUpdater();
        return buildStatus();
    }
}

async function listReleases(): Promise<ReleaseSummary[]> {
    const res = await fetch(RELEASES_API_URL, {
        headers: {
            'Accept': 'application/vnd.github+json',
            'User-Agent': `Claudia/${currentVersion()}`
        }
    });
    if (!res.ok) {
        const hint = res.status === 403
            ? 'GitHub API rate limit reached. Try again in a few minutes.'
            : `GitHub API returned ${res.status}.`;
        throw new Error(hint);
    }
    const body = await res.json() as Array<Record<string, unknown>>;
    const here = currentVersion();

    return (Array.isArray(body) ? body : [])
        .map(r => {
            const tag = String(r.tag_name ?? '');
            const version = versionFromTag(tag);
            if (!version) return null;
            const assetNames = Array.isArray(r.assets)
                ? (r.assets as Array<Record<string, unknown>>).map(a => String(a?.name ?? ''))
                : [];
            return {
                version,
                tag,
                name: String(r.name ?? tag),
                publishedAt: String(r.published_at ?? ''),
                prerelease: Boolean(r.prerelease),
                notes: String(r.body ?? ''),
                installable: !r.draft && releaseIsInstallable(assetNames, process.platform),
                current: version === here
            } satisfies ReleaseSummary;
        })
        .filter((r): r is ReleaseSummary => r !== null)
        .sort((a, b) => compareVersions(b.version, a.version));
}

async function performInstall(force: boolean): Promise<{ ok: boolean; reason?: string }> {
    if (!support.supported) {
        return { ok: false, reason: support.reason ?? 'Updates are not supported on this build.' };
    }
    if (state.phase !== 'downloaded') {
        return { ok: false, reason: 'No downloaded update is ready to install.' };
    }

    const busy = await refreshBusyCount();
    if (!force && busy > 0) {
        broadcast();
        return {
            ok: false,
            reason: `${state.busyTaskCount} task${state.busyTaskCount === 1 ? ' is' : 's are'} still running. The update will install when you next quit Claudia.`
        };
    }

    console.log(`${LOG_PREFIX} Installing update and restarting (force=${force}, busy=${state.busyTaskCount}).`);

    // Electron does not await async `before-quit` handlers, so stop the backend
    // utility process (and its PTYs) explicitly before handing over to Squirrel.
    try {
        await options?.stopBackend();
    } catch (err) {
        console.error(`${LOG_PREFIX} Backend shutdown failed before install:`, String(err));
    }

    autoUpdater.quitAndInstall(true, true);
    return { ok: true };
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

function scheduleNextCheck(): void {
    if (checkTimer) {
        clearInterval(checkTimer);
        checkTimer = null;
    }
    if (!support.supported || !prefs.enabled || prefs.pinnedVersion) return;

    const everyMs = Math.max(1, prefs.checkIntervalHours) * 3600_000;
    checkTimer = setInterval(() => {
        void runCheck(false);
    }, everyMs);
    // Don't hold the event loop open purely for update polling.
    checkTimer.unref?.();
}

// ---------------------------------------------------------------------------
// Programmatic API
//
// The IPC handlers below are thin wrappers over these. They are exported so
// `npm run test:updater-sim` can drive the real module end-to-end against a
// fake feed, rather than testing a reimplementation of it.
// ---------------------------------------------------------------------------

/** Force an update check regardless of the interval (the "Check now" button). */
export const checkForUpdates = (): Promise<UpdaterStatus> => runCheck(true);
/**
 * Run a check only if one is due — the same path the background timer takes.
 * Exported so the sim can prove that a disabled updater makes no feed request.
 */
export const checkIfDue = (): Promise<UpdaterStatus> => runCheck(false);
/** Download the currently offered update. */
export const downloadUpdate = (): Promise<UpdaterStatus> => startDownload();
/** Download and pin a specific version (the rollback path). */
export const installSpecificVersion = (version: string): Promise<UpdaterStatus> => installVersion(version);
export const getStatus = (): UpdaterStatus => buildStatus();
export const getPrefs = (): UpdaterPrefs => prefs;
export const setPrefs = (patch: unknown): UpdaterPrefs => {
    savePrefs(applyPrefsPatch(prefs, patch));
    broadcast();
    return prefs;
};

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc(): void {
    ipcMain.handle('updater:get-status', async () => {
        await refreshBusyCount();
        return buildStatus();
    });

    ipcMain.handle('updater:get-prefs', () => prefs);

    ipcMain.handle('updater:set-prefs', (_e, patch: unknown) => {
        const next = setPrefs(patch);
        console.log(`${LOG_PREFIX} Prefs updated: enabled=${next.enabled} channel=${next.channel} behaviour=${next.behaviour}`);
        return next;
    });

    ipcMain.handle('updater:check', () => runCheck(true));

    ipcMain.handle('updater:download', () => startDownload());

    ipcMain.handle('updater:install-now', (_e, force: unknown) => performInstall(force === true));

    ipcMain.handle('updater:list-releases', async () => {
        try {
            return await listReleases();
        } catch (err) {
            console.warn(`${LOG_PREFIX} listReleases failed:`, String(err));
            throw new Error(String((err as Error)?.message ?? err));
        }
    });

    ipcMain.handle('updater:install-version', (_e, version: unknown) => installVersion(String(version)));

    ipcMain.handle('updater:clear-pin', () => {
        console.log(`${LOG_PREFIX} Clearing version pin (was ${prefs.pinnedVersion ?? 'none'}).`);
        savePrefs({ ...prefs, pinnedVersion: null });
        broadcast();
        return prefs;
    });

    ipcMain.handle('updater:skip-version', (_e, version: unknown) => {
        const v = String(version);
        if (isValidVersion(v)) {
            savePrefs({ ...prefs, skippedVersion: v });
            setPhase('up-to-date', { availableVersion: null, releaseNotes: null, releaseName: null });
        }
        return prefs;
    });

    ipcMain.handle('updater:open-releases-page', () => shell.openExternal(RELEASES_PAGE_URL));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Wire up the updater. Safe to call on every platform and in dev — when the
 * build cannot self-update this registers the IPC surface (so Settings can
 * explain why) and does nothing else.
 */
export function initUpdater(opts: InitOptions): void {
    if (initialised) return;
    initialised = true;
    options = opts;

    prefsPath = join(app.getPath('userData'), 'updater.json');
    prefs = loadPrefs();

    support = simFeed
        ? { supported: true, reason: null }
        : detectUpdateSupport({
            platform: process.platform,
            isPackaged: app.isPackaged,
            appImagePath: process.env.APPIMAGE,
            disabledByEnv: process.env.CLAUDIA_DISABLE_UPDATER
        });

    registerIpc();

    if (!support.supported) {
        console.log(`${LOG_PREFIX} Disabled: ${support.reason}`);
        return;
    }

    // Route electron-updater's own logging through the console interceptor in
    // main.ts so it lands in userData/logs/main.log. Without this, updater
    // failures in a packaged build are invisible.
    autoUpdater.logger = {
        info: (m: unknown) => console.log(`${LOG_PREFIX} ${String(m)}`),
        warn: (m: unknown) => console.warn(`${LOG_PREFIX} ${String(m)}`),
        error: (m: unknown) => console.error(`${LOG_PREFIX} ${String(m)}`),
        debug: () => { /* too chatty for the shared log */ }
    };

    wireUpdaterEvents();
    applyPrefsToUpdater();

    console.log(`${LOG_PREFIX} Ready. version=${currentVersion()} enabled=${prefs.enabled} channel=${prefs.channel} behaviour=${prefs.behaviour} pinned=${prefs.pinnedVersion ?? 'none'}`);

    if (prefs.enabled && !prefs.pinnedVersion) {
        // Delay the first check so it doesn't compete with backend startup.
        const initial = setTimeout(() => { void runCheck(false); }, 30_000);
        initial.unref?.();
    }
    scheduleNextCheck();
}

/** Stop timers. Called on quit so a pending interval can't fire mid-teardown. */
export function disposeUpdater(): void {
    if (checkTimer) {
        clearInterval(checkTimer);
        checkTimer = null;
    }
}
