/**
 * Keeps Claudia-spawned Claude Code sessions off Anthropic's cloud surfaces.
 *
 * Claude Code ships three separate features that push a *local* session outward,
 * and recent builds turn them on by default (the CLI records the disclosure as
 * `seenNotifications["remote-control-auto-on"]` in `~/.claude.json`):
 *
 *   - `autoUploadSessions`     mirrors the session transcript to claude.ai as
 *                              view-only. This is the one that makes Claudia
 *                              tasks show up in the web app.
 *   - `remoteControlAtStartup` starts the Remote Control bridge each session so
 *                              claude.ai / the mobile app can drive it.
 *   - `disableRemoteControl`   the hard kill switch for Remote Control as a
 *                              whole (`claude remote-control`, `--rc`,
 *                              auto-start, and the in-session toggle).
 *
 * plus two notification channels (`agentPushNotifEnabled`,
 * `inputNeededNotifEnabled`) that push to the user's phone.
 *
 * A Claudia task is a background agent the user is already watching in the
 * Claudia UI. Mirroring it to a second surface is pure downside: the transcript
 * leaves the machine, and the phone buzzes for a task nobody asked to be paged
 * about. So Claudia pins all five OFF for every session it spawns.
 *
 * ## Why --settings and not a settings file
 *
 * Claude Code merges settings from five sources. Precedence, lowest to highest
 * (this is the CLI's own source-order array):
 *
 *     userSettings < projectSettings < localSettings < flagSettings < policySettings
 *
 * `--settings <file-or-json>` is `flagSettings`. That placement is exactly what
 * we want:
 *
 *   - It beats `~/.claude/settings.json`, so a machine that already had the
 *     cloud features switched on still spawns private tasks.
 *   - It beats the workspace's `.claude/settings.json`, so a checked-in repo
 *     file cannot opt the user's sessions into upload behind their back.
 *   - It loses to `policySettings`, so an enterprise admin's managed policy
 *     still wins. Claudia should not be able to override org policy.
 *
 * Writing these keys into the workspace's `.claude/settings.local.json` (which
 * Claudia already syncs — see settings-local.ts) would be the wrong layer: that
 * is `localSettings`, it writes privacy config into the user's repo, and it is
 * ignored outright when the workspace is untrusted.
 *
 * We pass a file path rather than inline JSON because these args cross a PTY on
 * Windows, where node-pty re-serializes argv into a single command line and
 * embedded quotes are a known source of corruption.
 */

import { join } from 'path';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { atomicWriteFileSync } from './utils/atomic-write.js';
import { createLogger } from './logger.js';

const logger = createLogger('claude-privacy');

/** File written into Claudia's data dir and handed to `claude --settings`. */
export const PRIVACY_SETTINGS_FILENAME = 'claude-privacy-settings.json';

/**
 * The settings pinned for every Claudia-spawned session.
 *
 * Key names are not guesses — they are the CLI's own schema field names, whose
 * self-descriptions read:
 *   disableRemoteControl     "Disable Remote Control (claude.ai/code,
 *                             `claude remote-control`, `--remote-control`/`--rc`,
 *                             auto-start, and the in-session toggle)."
 *   autoUploadSessions       "Mirror local sessions to claude.ai as view-only
 *                             (no remote control)"
 *   remoteControlAtStartup   "Start Remote Control bridge automatically each session"
 *   agentPushNotifEnabled    "Allow Claude to push proactive mobile notifications"
 *   inputNeededNotifEnabled  "Push to mobile when a permission prompt or question
 *                             is waiting"
 *
 * `disableRemoteControl` and `remoteControlAtStartup` overlap on purpose. The
 * first is the deployment-level kill switch, the second the per-session
 * auto-start. Setting only one leaves a path open if either key is renamed or
 * gated differently in a future build.
 */
export const CLAUDE_PRIVACY_SETTINGS: Readonly<Record<string, boolean>> = Object.freeze({
    // Nothing leaves the machine.
    disableRemoteControl: true,
    autoUploadSessions: false,
    remoteControlAtStartup: false,
    // Nothing buzzes the user's phone for a background task.
    agentPushNotifEnabled: false,
    inputNeededNotifEnabled: false,
});

/** Serialized form written to disk. Stable key order keeps the file diff-quiet. */
export function privacySettingsJson(): string {
    return JSON.stringify(CLAUDE_PRIVACY_SETTINGS, Object.keys(CLAUDE_PRIVACY_SETTINGS).sort(), 2);
}

/**
 * Write (or refresh) the privacy settings file and return its absolute path.
 *
 * Rewrites only when the content differs, so the common case is a single read.
 * Never throws: a failure here must not stop a task from spawning — it only
 * means that task falls back to the user's own settings. The caller decides
 * what to do with `null`.
 */
export function ensurePrivacySettingsFile(dataDir: string): string | null {
    try {
        if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
        const path = join(dataDir, PRIVACY_SETTINGS_FILENAME);
        const desired = privacySettingsJson();

        let current: string | null = null;
        try {
            current = readFileSync(path, 'utf8');
        } catch {
            current = null;
        }

        if (current !== desired) {
            atomicWriteFileSync(path, desired);
            logger.info('Wrote Claude privacy settings file', { path });
        }
        return path;
    } catch (err) {
        logger.error('Failed to write Claude privacy settings file — sessions fall back to user settings', {
            dataDir,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

export interface PrivacyArgsParams {
    /**
     * Explicit opt-in to Anthropic's cloud surfaces. `false` (the default) keeps
     * sessions local. Only a deliberate user toggle should ever set this true.
     */
    cloudSyncEnabled: boolean;
    /** Args already assembled for this spawn — inspected for a conflicting `--settings`. */
    existingArgs: string[];
    /** Path from {@link ensurePrivacySettingsFile}, or null if it could not be written. */
    settingsFilePath: string | null;
}

/**
 * Build the `--settings` args that pin the privacy defaults, or `[]` when they
 * should not be applied.
 *
 * Returns `[]` in three cases, each of which is logged:
 *  1. The user explicitly enabled cloud sync.
 *  2. The settings file could not be written.
 *  3. Something upstream (`CC_CLAUDE_ARGS`, a switch) already passes
 *     `--settings`. Commander does not accumulate repeats, so adding a second
 *     one would silently drop whichever the CLI discards. An operator who set
 *     `--settings` by hand keeps it; we warn loudly instead of guessing.
 */
export function buildClaudePrivacyArgs(params: PrivacyArgsParams): string[] {
    const { cloudSyncEnabled, existingArgs, settingsFilePath } = params;

    if (cloudSyncEnabled) {
        logger.warn('Claude cloud sync is ENABLED by config — sessions mirror to claude.ai and may be remote-controlled');
        return [];
    }

    if (!settingsFilePath) {
        logger.warn('No privacy settings file available — spawning without privacy pinning');
        return [];
    }

    if (existingArgs.some((a) => a === '--settings' || a.startsWith('--settings='))) {
        logger.warn(
            'A --settings arg is already present (likely CC_CLAUDE_ARGS); skipping Claudia privacy pinning. ' +
            'Add the privacy keys to that settings file to keep sessions off claude.ai.',
            { privacyKeys: Object.keys(CLAUDE_PRIVACY_SETTINGS) }
        );
        return [];
    }

    return ['--settings', settingsFilePath];
}
