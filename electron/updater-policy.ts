/**
 * Pure policy layer for the app updater.
 *
 * Everything here is deliberately free of any `electron` or `electron-updater`
 * import so it can be unit-tested in a plain Node vitest environment. The
 * Electron-facing shell that consumes these decisions lives in `updater.ts`.
 *
 * See https://github.com/extropolis/claudia/issues/237.
 */

/** Which release stream to follow. */
export type UpdateChannel = 'stable' | 'prerelease';

/**
 * What the app does when an update is found.
 * - notify:          tell the user, download nothing
 * - download:        download in the background, then ask before installing
 * - install-on-quit: download, then apply silently when the user next quits
 */
export type UpdateBehaviour = 'notify' | 'download' | 'install-on-quit';

export interface UpdaterPrefs {
    enabled: boolean;
    channel: UpdateChannel;
    behaviour: UpdateBehaviour;
    checkIntervalHours: number;
    pinnedVersion: string | null;
    skippedVersion: string | null;
    lastCheckedAt: string | null;
}

export type UpdaterPhase =
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'up-to-date'
    | 'error'
    | 'unsupported';

/**
 * The update feed is hard-coded to this repo. Nothing user-supplied is ever
 * interpolated into the host — only a version string, and only after it has
 * passed `isValidVersion`. See the Security section of issue #237.
 */
export const UPDATE_REPO_OWNER = 'extropolis';
export const UPDATE_REPO_NAME = 'claudia';
export const RELEASES_PAGE_URL = `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases`;
export const RELEASES_API_URL = `https://api.github.com/repos/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases`;

/**
 * macOS auto-update is gated off until the app is signed and notarized.
 *
 * Squirrel.Mac verifies the code signature of a downloaded update and refuses
 * to apply an unsigned one, so shipping this enabled against our current
 * unsigned dmg/zip would produce a download that always fails at the last step.
 * Flip to `true` in the same PR that lands code signing (issue #10) — the rest
 * of the pipeline (zip target, latest-mac.yml) is already in place.
 */
export const MAC_UPDATES_ENABLED = false;

export const DEFAULT_PREFS: UpdaterPrefs = {
    enabled: true,
    channel: 'stable',
    behaviour: 'download',
    checkIntervalHours: 6,
    pinnedVersion: null,
    skippedVersion: null,
    lastCheckedAt: null
};

const MIN_CHECK_INTERVAL_HOURS = 1;
const MAX_CHECK_INTERVAL_HOURS = 24 * 7;

const CHANNELS: readonly UpdateChannel[] = ['stable', 'prerelease'];
const BEHAVIOURS: readonly UpdateBehaviour[] = ['notify', 'download', 'install-on-quit'];

/**
 * The exact shape `scripts/release.mjs` enforces for version.txt. Anything that
 * fails this never reaches a URL.
 */
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

/** True for a well-formed bare version like "1.2.3" or "1.2.3-beta.1". */
export function isValidVersion(version: unknown): version is string {
    return typeof version === 'string' && VERSION_RE.test(version);
}

/** Strip a leading "v" from a tag. Returns null if the result is not valid. */
export function versionFromTag(tag: unknown): string | null {
    if (typeof tag !== 'string') return null;
    const bare = tag.startsWith('v') ? tag.slice(1) : tag;
    return isValidVersion(bare) ? bare : null;
}

/**
 * Semver-ish comparison. Returns -1 if a < b, 1 if a > b, 0 if equal.
 * A prerelease sorts before its own release (1.0.0-beta.1 < 1.0.0), matching
 * semver and electron-updater's own ordering.
 */
export function compareVersions(a: string, b: string): number {
    const split = (v: string) => {
        const [core, pre] = v.split('-', 2);
        const nums = core.split('.').map(n => parseInt(n, 10) || 0);
        return { nums, pre: pre ?? null };
    };
    const av = split(a);
    const bv = split(b);

    for (let i = 0; i < 3; i++) {
        const d = (av.nums[i] ?? 0) - (bv.nums[i] ?? 0);
        if (d !== 0) return d > 0 ? 1 : -1;
    }

    // Equal cores: absence of a prerelease tag outranks presence of one.
    if (av.pre === null && bv.pre === null) return 0;
    if (av.pre === null) return 1;
    if (bv.pre === null) return -1;

    // Both prerelease: compare dot-separated identifiers, numeric parts
    // numerically so beta.9 < beta.10 rather than lexically.
    const ap = av.pre.split('.');
    const bp = bv.pre.split('.');
    for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
        const x = ap[i];
        const y = bp[i];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        const xn = /^\d+$/.test(x);
        const yn = /^\d+$/.test(y);
        if (xn && yn) {
            const d = parseInt(x, 10) - parseInt(y, 10);
            if (d !== 0) return d > 0 ? 1 : -1;
        } else if (x !== y) {
            return x > y ? 1 : -1;
        }
    }
    return 0;
}

/**
 * Coerce whatever was on disk into a valid prefs object. Never throws — a
 * corrupt or hand-edited updater.json must degrade to defaults rather than
 * prevent the app from starting.
 */
function clampInterval(hours: number): number {
    return Math.min(MAX_CHECK_INTERVAL_HOURS, Math.max(MIN_CHECK_INTERVAL_HOURS, Math.round(hours)));
}

function isParsableDate(value: unknown): value is string {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

export function normalizePrefs(raw: unknown): UpdaterPrefs {
    const src = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};

    const interval = typeof src.checkIntervalHours === 'number' && Number.isFinite(src.checkIntervalHours)
        ? clampInterval(src.checkIntervalHours)
        : DEFAULT_PREFS.checkIntervalHours;

    return {
        enabled: typeof src.enabled === 'boolean' ? src.enabled : DEFAULT_PREFS.enabled,
        channel: CHANNELS.includes(src.channel as UpdateChannel)
            ? src.channel as UpdateChannel
            : DEFAULT_PREFS.channel,
        behaviour: BEHAVIOURS.includes(src.behaviour as UpdateBehaviour)
            ? src.behaviour as UpdateBehaviour
            : DEFAULT_PREFS.behaviour,
        checkIntervalHours: interval,
        pinnedVersion: isValidVersion(src.pinnedVersion) ? src.pinnedVersion : null,
        skippedVersion: isValidVersion(src.skippedVersion) ? src.skippedVersion : null,
        lastCheckedAt: typeof src.lastCheckedAt === 'string' && !Number.isNaN(Date.parse(src.lastCheckedAt))
            ? src.lastCheckedAt
            : null
    };
}

/**
 * Merge a partial patch from the renderer.
 *
 * Each field is validated independently and an invalid value leaves the
 * *current* setting untouched. Routing this through `normalizePrefs` instead
 * would be wrong: that resets bad input to the factory default, so one
 * malformed field in an IPC message would silently revert a user's unrelated
 * choice (e.g. patching a bad channel would knock behaviour back to default).
 */
export function applyPrefsPatch(current: UpdaterPrefs, patch: unknown): UpdaterPrefs {
    const src = (patch && typeof patch === 'object') ? patch as Record<string, unknown> : {};
    const next: UpdaterPrefs = { ...current };

    if (typeof src.enabled === 'boolean') {
        next.enabled = src.enabled;
    }
    if (CHANNELS.includes(src.channel as UpdateChannel)) {
        next.channel = src.channel as UpdateChannel;
    }
    if (BEHAVIOURS.includes(src.behaviour as UpdateBehaviour)) {
        next.behaviour = src.behaviour as UpdateBehaviour;
    }
    if (typeof src.checkIntervalHours === 'number' && Number.isFinite(src.checkIntervalHours)) {
        next.checkIntervalHours = clampInterval(src.checkIntervalHours);
    }
    // Nullable fields: an explicit null clears them, a valid value sets them,
    // anything else is ignored.
    if ('pinnedVersion' in src) {
        if (src.pinnedVersion === null) next.pinnedVersion = null;
        else if (isValidVersion(src.pinnedVersion)) next.pinnedVersion = src.pinnedVersion;
    }
    if ('skippedVersion' in src) {
        if (src.skippedVersion === null) next.skippedVersion = null;
        else if (isValidVersion(src.skippedVersion)) next.skippedVersion = src.skippedVersion;
    }
    if ('lastCheckedAt' in src) {
        if (src.lastCheckedAt === null) next.lastCheckedAt = null;
        else if (isParsableDate(src.lastCheckedAt)) next.lastCheckedAt = src.lastCheckedAt;
    }

    return next;
}

export interface ReleaseNoteEntry {
    version?: string;
    note?: string | null;
}

/**
 * Flatten electron-updater's release notes into displayable text.
 *
 * When the user is more than one version behind, `UpdateInfo.releaseNotes` is
 * an ARRAY of per-version entries rather than a string. Rendering that
 * directly yields "[object Object]", so collapse it into a single annotated
 * block, newest entry first as electron-updater supplies it.
 */
export function normalizeReleaseNotes(notes: unknown): string | null {
    if (typeof notes === 'string') {
        return notes.trim() || null;
    }
    if (Array.isArray(notes)) {
        const parts = notes
            .map(entry => {
                if (typeof entry === 'string') return entry.trim();
                const e = entry as ReleaseNoteEntry;
                const body = typeof e?.note === 'string' ? e.note.trim() : '';
                if (!body) return '';
                return e?.version ? `## ${e.version}\n${body}` : body;
            })
            .filter(part => part.length > 0);
        return parts.length > 0 ? parts.join('\n\n') : null;
    }
    return null;
}

export interface UpdateSupport {
    supported: boolean;
    /** Human-readable, shown verbatim in Settings when unsupported. */
    reason: string | null;
}

export interface SupportInput {
    platform: NodeJS.Platform | string;
    isPackaged: boolean;
    /** process.env.APPIMAGE — only set when running from an AppImage. */
    appImagePath?: string | undefined;
    /** process.env.CLAUDIA_DISABLE_UPDATER */
    disabledByEnv?: string | undefined;
    /** Escape hatch for tests / a future signed macOS build. */
    macUpdatesEnabled?: boolean;
}

/**
 * Decide whether this particular build can self-update at all.
 *
 * This is the gate that keeps the updater inert for `npx @extropolis/claudia`
 * users, dev runs, .deb installs and (for now) macOS.
 */
export function detectUpdateSupport(input: SupportInput): UpdateSupport {
    const { platform, isPackaged, appImagePath, disabledByEnv } = input;
    const macEnabled = input.macUpdatesEnabled ?? MAC_UPDATES_ENABLED;

    if (disabledByEnv) {
        return { supported: false, reason: 'Updates are disabled by the CLAUDIA_DISABLE_UPDATER environment variable.' };
    }
    if (!isPackaged) {
        return { supported: false, reason: 'This is a development build. Updates apply only to installed copies of Claudia.' };
    }
    if (platform === 'darwin' && !macEnabled) {
        return {
            supported: false,
            reason: 'Automatic updates on macOS need a signed build (tracked in issue #10). You can still download new versions manually.'
        };
    }
    if (platform === 'linux' && !appImagePath) {
        return {
            supported: false,
            reason: 'In-app updates are supported for the AppImage build only. Update this installation with your package manager.'
        };
    }
    if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
        return { supported: false, reason: `Updates are not supported on ${String(platform)}.` };
    }
    return { supported: true, reason: null };
}

export type FeedConfig =
    | { provider: 'github'; owner: string; repo: string }
    | { provider: 'generic'; url: string };

/**
 * Where to point electron-updater.
 *
 * Normally the GitHub provider, which resolves to the newest release. When the
 * user has pinned a version (i.e. rolled back), point at that one release's
 * asset directory instead — it contains that release's own latest*.yml, so the
 * updater treats the pinned version as "the newest thing available" and stops
 * dragging the user forward.
 */
export function resolveFeedUrl(prefs: Pick<UpdaterPrefs, 'pinnedVersion'>): FeedConfig {
    const pinned = prefs.pinnedVersion;
    if (isValidVersion(pinned)) {
        return {
            provider: 'generic',
            url: `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases/download/v${pinned}`
        };
    }
    return { provider: 'github', owner: UPDATE_REPO_OWNER, repo: UPDATE_REPO_NAME };
}

/** Feed for a one-off install of a specific version (the downgrade path). */
export function feedUrlForVersion(version: string): FeedConfig {
    if (!isValidVersion(version)) {
        throw new Error(`Refusing to build an update feed URL for invalid version: ${String(version)}`);
    }
    return {
        provider: 'generic',
        url: `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases/download/v${version}`
    };
}

/**
 * Whether a scheduled (background) check is due.
 *
 * Returns false when updates are switched off, so "off" genuinely means zero
 * network traffic to the feed rather than merely "don't install".
 */
export function shouldCheckNow(
    prefs: UpdaterPrefs,
    now: number = Date.now()
): boolean {
    if (!prefs.enabled) return false;
    // A pin is an explicit "stay here"; polling would only produce noise.
    if (prefs.pinnedVersion) return false;
    if (!prefs.lastCheckedAt) return true;

    const last = Date.parse(prefs.lastCheckedAt);
    if (Number.isNaN(last)) return true;

    const elapsed = now - last;
    // Negative elapsed means the clock moved backwards; re-check once rather
    // than waiting out a bogus future timestamp.
    if (elapsed < 0) return true;

    return elapsed >= prefs.checkIntervalHours * 3600_000;
}

/** A task is "in flight" if it is running or blocking on the user. */
export interface TaskLike {
    state?: string;
    waitingInputType?: string | null;
}

const BUSY_STATES = new Set(['busy', 'starting', 'running']);

/** How many tasks a restart right now would interrupt. */
export function countBusyTasks(tasks: readonly TaskLike[] | null | undefined): number {
    if (!Array.isArray(tasks)) return 0;
    return tasks.filter(t =>
        BUSY_STATES.has(String(t?.state ?? '')) || Boolean(t?.waitingInputType)
    ).length;
}

/**
 * Restarting kills the backend utility process and every PTY with it, so an
 * install is only safe when nothing is mid-flight.
 */
export function canInstallNow(tasks: readonly TaskLike[] | null | undefined): boolean {
    return countBusyTasks(tasks) === 0;
}

/**
 * Whether to surface a found version to the user.
 *
 * Honours "skip this version" without freezing the update stream the way a pin
 * does, and never re-offers something at or below what is already installed.
 */
export function shouldPromptForVersion(
    prefs: UpdaterPrefs,
    currentVersion: string,
    candidateVersion: string
): boolean {
    if (!isValidVersion(candidateVersion)) return false;
    if (prefs.skippedVersion === candidateVersion) return false;
    if (!isValidVersion(currentVersion)) return true;
    return compareVersions(candidateVersion, currentVersion) > 0;
}

/**
 * Should electron-updater download without asking?
 * Only in the two behaviours that explicitly opt into it.
 */
export function shouldAutoDownload(prefs: UpdaterPrefs): boolean {
    return prefs.enabled && (prefs.behaviour === 'download' || prefs.behaviour === 'install-on-quit');
}

/** Should a downloaded update be applied silently on the user's next quit? */
export function shouldInstallOnQuit(prefs: UpdaterPrefs): boolean {
    return prefs.enabled && prefs.behaviour === 'install-on-quit';
}

/** Asset-name suffixes electron-updater can actually apply, per platform. */
export function updatableAssetSuffixes(platform: NodeJS.Platform | string): string[] {
    if (platform === 'win32') return ['.exe'];
    if (platform === 'darwin') return ['.zip'];
    if (platform === 'linux') return ['.AppImage'];
    return [];
}

/**
 * True when a release carries something this platform could actually install.
 * Drives the disabled state of each row in the rollback list.
 */
export function releaseIsInstallable(
    assetNames: readonly string[] | null | undefined,
    platform: NodeJS.Platform | string
): boolean {
    if (!Array.isArray(assetNames)) return false;
    const suffixes = updatableAssetSuffixes(platform);
    if (suffixes.length === 0) return false;
    const hasBinary = assetNames.some(name =>
        suffixes.some(sfx => typeof name === 'string' && name.toLowerCase().endsWith(sfx.toLowerCase()))
    );
    // Without the metadata file electron-updater cannot resolve the download,
    // so a release predating the auto-update pipeline is not installable even
    // though it has a binary attached.
    const hasMetadata = assetNames.some(name => typeof name === 'string' && /^latest(-mac|-linux)?\.yml$/i.test(name));
    return hasBinary && hasMetadata;
}
