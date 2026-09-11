import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
    CLAUDE_PRIVACY_SETTINGS,
    PRIVACY_SETTINGS_FILENAME,
    buildClaudePrivacyArgs,
    ensurePrivacySettingsFile,
    privacySettingsJson,
} from '../claude-privacy.js';

// Temp dirs must live under homedir(), not os.tmpdir(): on macOS /tmp resolves
// under /var, which validateWorkspacePath blocklists as a system path.
let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(homedir(), 'claudia-privacy-test-'));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('CLAUDE_PRIVACY_SETTINGS', () => {
    // These key names are Claude Code's own settings schema fields. If a rename
    // ever lands upstream this suite keeps passing while the feature silently
    // stops working, so the names are asserted explicitly here as the record of
    // what was verified against the CLI.
    it('pins every cloud-facing Claude Code feature off', () => {
        expect(CLAUDE_PRIVACY_SETTINGS).toEqual({
            disableRemoteControl: true,
            autoUploadSessions: false,
            remoteControlAtStartup: false,
            agentPushNotifEnabled: false,
            inputNeededNotifEnabled: false,
        });
    });

    it('is frozen so a caller cannot weaken it at runtime', () => {
        expect(Object.isFrozen(CLAUDE_PRIVACY_SETTINGS)).toBe(true);
    });

    it('never emits a value that would enable upload', () => {
        // autoUploadSessions is the key that mirrors transcripts to claude.ai.
        expect(CLAUDE_PRIVACY_SETTINGS.autoUploadSessions).toBe(false);
        expect(CLAUDE_PRIVACY_SETTINGS.disableRemoteControl).toBe(true);
    });
});

describe('privacySettingsJson', () => {
    it('produces valid JSON that round-trips to the same settings', () => {
        expect(JSON.parse(privacySettingsJson())).toEqual(CLAUDE_PRIVACY_SETTINGS);
    });

    it('is byte-stable across calls so the file is not rewritten needlessly', () => {
        expect(privacySettingsJson()).toBe(privacySettingsJson());
    });
});

describe('ensurePrivacySettingsFile', () => {
    it('writes the settings file and returns its path', () => {
        const path = ensurePrivacySettingsFile(dir);
        expect(path).toBe(join(dir, PRIVACY_SETTINGS_FILENAME));
        expect(JSON.parse(readFileSync(path!, 'utf8'))).toEqual(CLAUDE_PRIVACY_SETTINGS);
    });

    it('creates the data directory when it does not exist yet', () => {
        const nested = join(dir, 'does', 'not', 'exist');
        const path = ensurePrivacySettingsFile(nested);
        expect(path).not.toBeNull();
        expect(JSON.parse(readFileSync(path!, 'utf8'))).toEqual(CLAUDE_PRIVACY_SETTINGS);
    });

    it('repairs a file that was tampered with to re-enable upload', () => {
        const path = join(dir, PRIVACY_SETTINGS_FILENAME);
        writeFileSync(path, JSON.stringify({ autoUploadSessions: true }));
        ensurePrivacySettingsFile(dir);
        expect(JSON.parse(readFileSync(path, 'utf8')).autoUploadSessions).toBe(false);
    });

    it('repairs a corrupt (non-JSON) file rather than leaving it in place', () => {
        const path = join(dir, PRIVACY_SETTINGS_FILENAME);
        writeFileSync(path, 'not json at all {{{');
        ensurePrivacySettingsFile(dir);
        expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(CLAUDE_PRIVACY_SETTINGS);
    });

    it('is idempotent — a second call leaves identical content', () => {
        const path = ensurePrivacySettingsFile(dir)!;
        const first = readFileSync(path, 'utf8');
        ensurePrivacySettingsFile(dir);
        expect(readFileSync(path, 'utf8')).toBe(first);
    });

    it('returns null instead of throwing when the path is unusable', () => {
        // A file where the directory should be: mkdir and write both fail.
        const blocked = join(dir, 'blocker');
        writeFileSync(blocked, 'i am a file, not a directory');
        expect(ensurePrivacySettingsFile(join(blocked, 'sub'))).toBeNull();
    });
});

describe('buildClaudePrivacyArgs', () => {
    const settingsFilePath = '/data/claude-privacy-settings.json';

    it('passes --settings pointing at the privacy file by default', () => {
        expect(
            buildClaudePrivacyArgs({ cloudSyncEnabled: false, existingArgs: [], settingsFilePath })
        ).toEqual(['--settings', settingsFilePath]);
    });

    it('still applies alongside unrelated args', () => {
        const args = buildClaudePrivacyArgs({
            cloudSyncEnabled: false,
            existingArgs: ['--verbose', '--model', 'opus', '--mcp-config', '/tmp/x.json'],
            settingsFilePath,
        });
        expect(args).toEqual(['--settings', settingsFilePath]);
    });

    it('opts out entirely when the user enabled cloud sync', () => {
        expect(
            buildClaudePrivacyArgs({ cloudSyncEnabled: true, existingArgs: [], settingsFilePath })
        ).toEqual([]);
    });

    it('does not fight an existing --settings arg (space form)', () => {
        expect(
            buildClaudePrivacyArgs({
                cloudSyncEnabled: false,
                existingArgs: ['--settings', '/custom/settings.json'],
                settingsFilePath,
            })
        ).toEqual([]);
    });

    it('does not fight an existing --settings arg (equals form)', () => {
        expect(
            buildClaudePrivacyArgs({
                cloudSyncEnabled: false,
                existingArgs: ['--settings=/custom/settings.json'],
                settingsFilePath,
            })
        ).toEqual([]);
    });

    it('is not fooled by an arg that merely starts with the same letters', () => {
        // --settings-sources is a different flag; it must not suppress pinning.
        expect(
            buildClaudePrivacyArgs({
                cloudSyncEnabled: false,
                existingArgs: ['--setting-sources', 'user'],
                settingsFilePath,
            })
        ).toEqual(['--settings', settingsFilePath]);
    });

    it('degrades to no-args, not a crash, when the file could not be written', () => {
        expect(
            buildClaudePrivacyArgs({ cloudSyncEnabled: false, existingArgs: [], settingsFilePath: null })
        ).toEqual([]);
    });

    it('emits exactly two args so callers can splice it into an argv array', () => {
        const args = buildClaudePrivacyArgs({ cloudSyncEnabled: false, existingArgs: [], settingsFilePath });
        expect(args).toHaveLength(2);
        expect(args[0]).toBe('--settings');
    });
});
