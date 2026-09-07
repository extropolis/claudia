import { describe, it, expect } from 'vitest';

import {
    DEFAULT_PREFS,
    applyPrefsPatch,
    canInstallNow,
    compareVersions,
    countBusyTasks,
    detectUpdateSupport,
    feedUrlForVersion,
    isValidVersion,
    normalizePrefs,
    normalizeReleaseNotes,
    releaseIsInstallable,
    resolveFeedUrl,
    shouldAutoDownload,
    shouldCheckNow,
    shouldInstallOnQuit,
    shouldPromptForVersion,
    updatableAssetSuffixes,
    versionFromTag,
    type UpdaterPrefs
} from '../updater-policy.js';

const prefs = (patch: Partial<UpdaterPrefs> = {}): UpdaterPrefs => ({ ...DEFAULT_PREFS, ...patch });

describe('isValidVersion', () => {
    it('accepts release and prerelease versions', () => {
        expect(isValidVersion('0.3.0')).toBe(true);
        expect(isValidVersion('10.20.30')).toBe(true);
        expect(isValidVersion('1.0.0-beta.1')).toBe(true);
        expect(isValidVersion('1.0.0-rc.2')).toBe(true);
    });

    it('rejects anything that is not a bare semver', () => {
        expect(isValidVersion('v1.0.0')).toBe(false);
        expect(isValidVersion('1.0')).toBe(false);
        expect(isValidVersion('')).toBe(false);
        expect(isValidVersion(null)).toBe(false);
        expect(isValidVersion(123)).toBe(false);
    });

    // This is the security guard: a version string is the only user-influenced
    // value that reaches a feed URL, so path traversal must not survive it.
    it('rejects traversal and injection attempts', () => {
        expect(isValidVersion('../../etc/passwd')).toBe(false);
        expect(isValidVersion('1.0.0/../..')).toBe(false);
        expect(isValidVersion('1.0.0@evil.com')).toBe(false);
        expect(isValidVersion('1.0.0 1.0.0')).toBe(false);
        expect(isValidVersion('1.0.0\n')).toBe(false);
        expect(isValidVersion('https://evil.com/')).toBe(false);
    });
});

describe('versionFromTag', () => {
    it('strips a leading v', () => {
        expect(versionFromTag('v1.2.3')).toBe('1.2.3');
        expect(versionFromTag('1.2.3')).toBe('1.2.3');
    });
    it('returns null for junk', () => {
        expect(versionFromTag('nightly')).toBeNull();
        expect(versionFromTag(null)).toBeNull();
        expect(versionFromTag('v1.2')).toBeNull();
    });
});

describe('compareVersions', () => {
    it('orders by major, minor, patch', () => {
        expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
        expect(compareVersions('1.2.0', '1.1.0')).toBe(1);
        expect(compareVersions('1.1.1', '1.1.1')).toBe(0);
        expect(compareVersions('0.2.30', '0.3.0')).toBe(-1);
    });

    it('sorts a prerelease before its own release', () => {
        expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
        expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBe(1);
    });

    it('compares numeric prerelease identifiers numerically, not lexically', () => {
        // The lexical trap: "10" < "9" as strings.
        expect(compareVersions('1.0.0-beta.9', '1.0.0-beta.10')).toBe(-1);
        expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.9')).toBe(1);
    });

    it('treats a shorter prerelease as lower', () => {
        expect(compareVersions('1.0.0-beta', '1.0.0-beta.1')).toBe(-1);
    });

    it('sorts a real release list newest-first', () => {
        const versions = ['0.2.29', '0.3.0', '0.2.30', '0.3.0-beta.1'];
        expect([...versions].sort((a, b) => compareVersions(b, a)))
            .toEqual(['0.3.0', '0.3.0-beta.1', '0.2.30', '0.2.29']);
    });
});

describe('normalizePrefs', () => {
    it('returns defaults for missing or non-object input', () => {
        expect(normalizePrefs(undefined)).toEqual(DEFAULT_PREFS);
        expect(normalizePrefs(null)).toEqual(DEFAULT_PREFS);
        expect(normalizePrefs('nope')).toEqual(DEFAULT_PREFS);
        expect(normalizePrefs(42)).toEqual(DEFAULT_PREFS);
    });

    it('keeps valid values', () => {
        const out = normalizePrefs({
            enabled: false,
            channel: 'prerelease',
            behaviour: 'notify',
            checkIntervalHours: 12,
            pinnedVersion: '0.2.30',
            skippedVersion: '0.3.0',
            lastCheckedAt: '2026-01-01T00:00:00.000Z'
        });
        expect(out).toEqual({
            enabled: false,
            channel: 'prerelease',
            behaviour: 'notify',
            checkIntervalHours: 12,
            pinnedVersion: '0.2.30',
            skippedVersion: '0.3.0',
            lastCheckedAt: '2026-01-01T00:00:00.000Z'
        });
    });

    it('discards invalid enum values rather than trusting them', () => {
        const out = normalizePrefs({ channel: 'nightly', behaviour: 'yolo' });
        expect(out.channel).toBe('stable');
        expect(out.behaviour).toBe('download');
    });

    it('refuses a pinned version that is not a valid version', () => {
        // A hand-edited updater.json must not be able to inject a feed path.
        expect(normalizePrefs({ pinnedVersion: '../../../evil' }).pinnedVersion).toBeNull();
        expect(normalizePrefs({ skippedVersion: 'latest' }).skippedVersion).toBeNull();
    });

    it('clamps the check interval into a sane range', () => {
        expect(normalizePrefs({ checkIntervalHours: 0 }).checkIntervalHours).toBe(1);
        expect(normalizePrefs({ checkIntervalHours: -50 }).checkIntervalHours).toBe(1);
        expect(normalizePrefs({ checkIntervalHours: 100000 }).checkIntervalHours).toBe(168);
        expect(normalizePrefs({ checkIntervalHours: 6.7 }).checkIntervalHours).toBe(7);
        expect(normalizePrefs({ checkIntervalHours: NaN }).checkIntervalHours).toBe(DEFAULT_PREFS.checkIntervalHours);
    });

    it('drops an unparseable lastCheckedAt', () => {
        expect(normalizePrefs({ lastCheckedAt: 'not a date' }).lastCheckedAt).toBeNull();
        expect(normalizePrefs({ lastCheckedAt: 12345 }).lastCheckedAt).toBeNull();
    });
});

describe('applyPrefsPatch', () => {
    it('applies only the fields present in the patch', () => {
        const out = applyPrefsPatch(prefs({ enabled: true, channel: 'stable' }), { enabled: false });
        expect(out.enabled).toBe(false);
        expect(out.channel).toBe('stable');
    });

    it('clears nullable fields when explicitly given null', () => {
        const out = applyPrefsPatch(prefs({ pinnedVersion: '0.2.30' }), { pinnedVersion: null });
        expect(out.pinnedVersion).toBeNull();
    });

    it('falls back to the current value, not the default, on invalid input', () => {
        const current = prefs({ channel: 'prerelease', checkIntervalHours: 12 });
        const out = applyPrefsPatch(current, { channel: 'garbage', checkIntervalHours: 'soon' });
        expect(out.channel).toBe('prerelease');
        expect(out.checkIntervalHours).toBe(12);
    });

    it('ignores junk patches entirely', () => {
        expect(applyPrefsPatch(DEFAULT_PREFS, null)).toEqual(DEFAULT_PREFS);
        expect(applyPrefsPatch(DEFAULT_PREFS, 'nope')).toEqual(DEFAULT_PREFS);
    });

    it('ignores unknown keys', () => {
        const out = applyPrefsPatch(DEFAULT_PREFS, { evil: true } as unknown);
        expect(out).toEqual(DEFAULT_PREFS);
        expect('evil' in out).toBe(false);
    });
});

describe('detectUpdateSupport', () => {
    const base = { platform: 'win32', isPackaged: true };

    it('supports a packaged Windows build', () => {
        expect(detectUpdateSupport(base)).toEqual({ supported: true, reason: null });
    });

    it('refuses a development build', () => {
        const out = detectUpdateSupport({ ...base, isPackaged: false });
        expect(out.supported).toBe(false);
        expect(out.reason).toMatch(/development build/i);
    });

    it('honours the environment kill switch above everything else', () => {
        const out = detectUpdateSupport({ ...base, disabledByEnv: '1' });
        expect(out.supported).toBe(false);
        expect(out.reason).toMatch(/CLAUDIA_DISABLE_UPDATER/);
    });

    it('refuses unsigned macOS and points at the signing issue', () => {
        const out = detectUpdateSupport({ platform: 'darwin', isPackaged: true });
        expect(out.supported).toBe(false);
        expect(out.reason).toMatch(/signed build/i);
        expect(out.reason).toMatch(/#10/);
    });

    it('supports macOS once signing lands', () => {
        const out = detectUpdateSupport({ platform: 'darwin', isPackaged: true, macUpdatesEnabled: true });
        expect(out.supported).toBe(true);
    });

    it('supports Linux only from an AppImage', () => {
        expect(detectUpdateSupport({ platform: 'linux', isPackaged: true, appImagePath: '/tmp/Claudia.AppImage' }).supported).toBe(true);

        const deb = detectUpdateSupport({ platform: 'linux', isPackaged: true });
        expect(deb.supported).toBe(false);
        expect(deb.reason).toMatch(/AppImage/);
    });

    it('refuses unknown platforms', () => {
        const out = detectUpdateSupport({ platform: 'aix', isPackaged: true });
        expect(out.supported).toBe(false);
        expect(out.reason).toMatch(/aix/);
    });
});

describe('resolveFeedUrl / feedUrlForVersion', () => {
    it('uses the GitHub provider when nothing is pinned', () => {
        expect(resolveFeedUrl({ pinnedVersion: null }))
            .toEqual({ provider: 'github', owner: 'extropolis', repo: 'claudia' });
    });

    it('points at one release directory when pinned', () => {
        expect(resolveFeedUrl({ pinnedVersion: '0.2.30' })).toEqual({
            provider: 'generic',
            url: 'https://github.com/extropolis/claudia/releases/download/v0.2.30'
        });
    });

    it('falls back to the GitHub provider if the pin is somehow invalid', () => {
        expect(resolveFeedUrl({ pinnedVersion: '../../evil' }))
            .toEqual({ provider: 'github', owner: 'extropolis', repo: 'claudia' });
    });

    it('throws rather than build a URL from an invalid version', () => {
        expect(() => feedUrlForVersion('../../evil')).toThrow(/invalid version/i);
        expect(() => feedUrlForVersion('')).toThrow();
        expect(() => feedUrlForVersion('v1.0.0')).toThrow();
    });

    it('always produces a URL on the hard-coded host', () => {
        expect(feedUrlForVersion('1.2.3'))
            .toEqual({ provider: 'generic', url: 'https://github.com/extropolis/claudia/releases/download/v1.2.3' });
    });
});

describe('shouldCheckNow', () => {
    const now = Date.parse('2026-06-01T12:00:00.000Z');

    it('never checks when updates are disabled', () => {
        // The headline guarantee: "off" means zero feed traffic.
        expect(shouldCheckNow(prefs({ enabled: false }), now)).toBe(false);
        expect(shouldCheckNow(prefs({ enabled: false, lastCheckedAt: null }), now)).toBe(false);
        expect(shouldCheckNow(prefs({ enabled: false, lastCheckedAt: '1999-01-01T00:00:00.000Z' }), now)).toBe(false);
    });

    it('never checks while pinned to a version', () => {
        expect(shouldCheckNow(prefs({ pinnedVersion: '0.2.30' }), now)).toBe(false);
    });

    it('checks when it has never checked before', () => {
        expect(shouldCheckNow(prefs({ lastCheckedAt: null }), now)).toBe(true);
    });

    it('respects the interval', () => {
        const p = prefs({ checkIntervalHours: 6, lastCheckedAt: '2026-06-01T09:00:00.000Z' });
        expect(shouldCheckNow(p, now)).toBe(false);                  // 3h elapsed
        expect(shouldCheckNow(p, now + 3 * 3600_000)).toBe(true);    // 6h elapsed
    });

    it('re-checks after a backwards clock jump instead of waiting out a future timestamp', () => {
        expect(shouldCheckNow(prefs({ lastCheckedAt: '2030-01-01T00:00:00.000Z' }), now)).toBe(true);
    });

    it('re-checks when the stored timestamp is unparseable', () => {
        expect(shouldCheckNow({ ...DEFAULT_PREFS, lastCheckedAt: 'garbage' }, now)).toBe(true);
    });
});

describe('countBusyTasks / canInstallNow', () => {
    it('counts running states', () => {
        expect(countBusyTasks([{ state: 'busy' }, { state: 'idle' }, { state: 'starting' }])).toBe(2);
    });

    it('counts a task blocking on user input as in-flight', () => {
        expect(countBusyTasks([{ state: 'idle', waitingInputType: 'permission' }])).toBe(1);
    });

    it('ignores finished and disconnected tasks', () => {
        expect(countBusyTasks([
            { state: 'idle' },
            { state: 'disconnected' },
            { state: 'interrupted' },
            { state: 'archived' }
        ])).toBe(0);
    });

    it('treats a missing or malformed list as nothing running', () => {
        expect(countBusyTasks(null)).toBe(0);
        expect(countBusyTasks(undefined)).toBe(0);
        expect(countBusyTasks([{}])).toBe(0);
    });

    it('blocks install exactly when something is in flight', () => {
        expect(canInstallNow([])).toBe(true);
        expect(canInstallNow([{ state: 'idle' }])).toBe(true);
        expect(canInstallNow([{ state: 'busy' }])).toBe(false);
        expect(canInstallNow([{ state: 'idle', waitingInputType: 'plan' }])).toBe(false);
    });
});

describe('shouldPromptForVersion', () => {
    it('offers a newer version', () => {
        expect(shouldPromptForVersion(DEFAULT_PREFS, '0.3.0', '0.4.0')).toBe(true);
    });

    it('does not offer the same or an older version', () => {
        expect(shouldPromptForVersion(DEFAULT_PREFS, '0.3.0', '0.3.0')).toBe(false);
        expect(shouldPromptForVersion(DEFAULT_PREFS, '0.3.0', '0.2.30')).toBe(false);
    });

    it('honours a skipped version without freezing later ones', () => {
        const p = prefs({ skippedVersion: '0.4.0' });
        expect(shouldPromptForVersion(p, '0.3.0', '0.4.0')).toBe(false);
        expect(shouldPromptForVersion(p, '0.3.0', '0.4.1')).toBe(true);
    });

    it('rejects a malformed candidate', () => {
        expect(shouldPromptForVersion(DEFAULT_PREFS, '0.3.0', 'latest')).toBe(false);
    });
});

describe('download / install behaviour flags', () => {
    it('only auto-downloads in the behaviours that opt in', () => {
        expect(shouldAutoDownload(prefs({ behaviour: 'notify' }))).toBe(false);
        expect(shouldAutoDownload(prefs({ behaviour: 'download' }))).toBe(true);
        expect(shouldAutoDownload(prefs({ behaviour: 'install-on-quit' }))).toBe(true);
    });

    it('never downloads or installs while disabled', () => {
        expect(shouldAutoDownload(prefs({ enabled: false, behaviour: 'download' }))).toBe(false);
        expect(shouldInstallOnQuit(prefs({ enabled: false, behaviour: 'install-on-quit' }))).toBe(false);
    });

    it('only installs on quit in that one behaviour', () => {
        expect(shouldInstallOnQuit(prefs({ behaviour: 'download' }))).toBe(false);
        expect(shouldInstallOnQuit(prefs({ behaviour: 'install-on-quit' }))).toBe(true);
    });
});

describe('normalizeReleaseNotes', () => {
    it('passes a plain string through', () => {
        expect(normalizeReleaseNotes('Fixed a bug')).toBe('Fixed a bug');
    });

    it('treats blank notes as absent', () => {
        expect(normalizeReleaseNotes('')).toBeNull();
        expect(normalizeReleaseNotes('   ')).toBeNull();
        expect(normalizeReleaseNotes(null)).toBeNull();
        expect(normalizeReleaseNotes(undefined)).toBeNull();
        expect(normalizeReleaseNotes(42)).toBeNull();
    });

    // electron-updater hands back an ARRAY when the user is more than one
    // version behind; rendering that raw would print "[object Object]".
    it('flattens the multi-version array form', () => {
        const out = normalizeReleaseNotes([
            { version: '0.5.0', note: 'Newest thing' },
            { version: '0.4.0', note: 'Older thing' }
        ]);
        expect(out).toBe('## 0.5.0\nNewest thing\n\n## 0.4.0\nOlder thing');
        expect(out).not.toContain('object Object');
    });

    it('skips entries with no body and handles bare strings in the array', () => {
        expect(normalizeReleaseNotes([
            { version: '0.5.0', note: '' },
            { version: '0.4.0', note: null },
            'a loose string'
        ])).toBe('a loose string');
    });

    it('returns null when every entry is empty', () => {
        expect(normalizeReleaseNotes([{ version: '1.0.0', note: '' }])).toBeNull();
        expect(normalizeReleaseNotes([])).toBeNull();
    });
});

describe('releaseIsInstallable', () => {
    it('knows the per-platform artifact type', () => {
        expect(updatableAssetSuffixes('win32')).toEqual(['.exe']);
        expect(updatableAssetSuffixes('darwin')).toEqual(['.zip']);
        expect(updatableAssetSuffixes('linux')).toEqual(['.AppImage']);
        expect(updatableAssetSuffixes('aix')).toEqual([]);
    });

    it('accepts a release with both a binary and its metadata', () => {
        expect(releaseIsInstallable(['Claudia-1.0.0.exe', 'latest.yml'], 'win32')).toBe(true);
        expect(releaseIsInstallable(['Claudia-1.0.0-mac.zip', 'latest-mac.yml'], 'darwin')).toBe(true);
        expect(releaseIsInstallable(['Claudia-1.0.0.AppImage', 'latest-linux.yml'], 'linux')).toBe(true);
    });

    // Every release before this feature shipped has binaries but no latest.yml,
    // so the rollback list must show them as not installable rather than
    // offering a download that cannot resolve.
    it('rejects a pre-auto-update release that has binaries but no metadata', () => {
        expect(releaseIsInstallable(
            ['Claudia-0.3.0.dmg', 'Claudia-0.3.0-x86_64.AppImage', 'Claudia-0.3.0-amd64.deb'],
            'linux'
        )).toBe(false);
    });

    it('rejects a release with metadata but no binary for this platform', () => {
        expect(releaseIsInstallable(['latest.yml'], 'win32')).toBe(false);
        expect(releaseIsInstallable(['Claudia-1.0.0.exe', 'latest.yml'], 'linux')).toBe(false);
    });

    it('handles junk input safely', () => {
        expect(releaseIsInstallable(null, 'win32')).toBe(false);
        expect(releaseIsInstallable(undefined, 'win32')).toBe(false);
        expect(releaseIsInstallable([], 'win32')).toBe(false);
        expect(releaseIsInstallable(['latest.yml', 'Claudia.exe'], 'aix')).toBe(false);
    });
});
