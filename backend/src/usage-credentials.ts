import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from './logger.js';
import { redactSecrets } from './redact.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('[UsageCredentials]');

export interface OAuthCredentials {
    accessToken: string;
    subscriptionType?: string;
}

/**
 * Parse the OAuth credentials JSON blob. Handles both the nested
 * `{ claudeAiOauth: {...} }` shape (as stored by Claude Code) and a bare
 * `{ accessToken, subscriptionType }` shape. Returns null on any parse failure
 * or when no access token is present. Pure — no I/O.
 */
export function parseCredentialsBlob(json: string): OAuthCredentials | null {
    if (!json || !json.trim()) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    const inner = (obj.claudeAiOauth ?? obj) as Record<string, unknown>;
    const accessToken = inner.accessToken;
    if (typeof accessToken !== 'string' || accessToken.length === 0) return null;
    const result: OAuthCredentials = { accessToken };
    if (typeof inner.subscriptionType === 'string') {
        result.subscriptionType = inner.subscriptionType;
    }
    return result;
}

/**
 * Human-facing plan label from a subscription type.
 *
 * `subscriptionType` is one of `max` | `pro` | `team` | `enterprise` | null —
 * derived by Claude Code from `organization.organization_type` and stored in
 * the credentials blob. It carries NO 5x/20x information: that lives in a
 * separate `rateLimitTier` field (`default_claude_max_5x` /
 * `default_claude_max_20x`). Labelling every `max` account "Max (20x)" was
 * therefore wrong for every Max 5x subscriber. Claude Code's own
 * `getSubscriptionName()` does not surface the tier either, so neither do we.
 */
export function planLabelFromSubscription(sub?: string): string {
    switch ((sub ?? '').toLowerCase()) {
        case 'max':
            return 'Max';
        case 'pro':
            return 'Pro';
        case 'team':
            return 'Team';
        case 'enterprise':
            return 'Enterprise';
        default:
            return 'Unknown';
    }
}

/**
 * The Claude Code config home. `CLAUDE_CONFIG_DIR` relocates it, which changes
 * BOTH the credentials file path and the Keychain service name.
 */
function claudeConfigDir(): string {
    return process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
}

/**
 * The macOS Keychain generic-password service Claude Code stores the OAuth
 * blob under.
 *
 * Claude Code composes it as `Claude Code` + `-credentials`, plus — when and
 * only when `CLAUDE_CONFIG_DIR` is set — a `-<first 8 hex of sha256(configDir)>`
 * suffix. Hardcoding the unsuffixed name silently returned "no token" for every
 * user with a relocated config dir.
 */
export function keychainServiceName(): string {
    const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
    if (!configDir) return 'Claude Code-credentials';
    const hash = createHash('sha256').update(configDir).digest('hex').slice(0, 8);
    return `Claude Code-credentials-${hash}`;
}

/** The account name Claude Code stores the item under. */
function keychainAccount(): string {
    try {
        return process.env.USER || os.userInfo().username;
    } catch {
        return 'claude-code-user';
    }
}

/** Read + parse `<configDir>/.credentials.json`, or null if unusable. */
async function readCredentialsFile(): Promise<OAuthCredentials | null> {
    const credPath = path.join(claudeConfigDir(), '.credentials.json');
    try {
        const creds = parseCredentialsBlob(await readFile(credPath, 'utf8'));
        if (!creds) logger.debug('Credentials file present but holds no accessToken', { credPath });
        return creds;
    } catch (err) {
        logger.debug('No credentials file', {
            credPath,
            error: redactSecrets(err instanceof Error ? err.message : String(err)),
        });
        return null;
    }
}

/**
 * Read the Claude Code OAuth credentials from the OS credential store.
 * - macOS: the Keychain generic password, falling back to the credentials file.
 * - Linux/Windows: `<configDir>/.credentials.json`.
 *
 * Returns null when no token is found. Never throws, and never logs the token.
 */
export async function readOAuthCredentials(): Promise<OAuthCredentials | null> {
    if (process.platform === 'darwin') {
        const service = keychainServiceName();
        try {
            const { stdout } = await execFileAsync('security', [
                'find-generic-password',
                '-s',
                service,
                '-a',
                keychainAccount(),
                '-w',
            ], { timeout: 5000 });
            const creds = parseCredentialsBlob(stdout);
            if (creds) {
                logger.debug('Read OAuth credentials', {
                    source: 'macos-keychain',
                    subscriptionType: creds.subscriptionType ?? null,
                });
                return creds;
            }
            // An item exists but carries no claudeAiOauth block — e.g. only
            // `mcpOAuth`, which is the normal "not signed in" state on 2.1.x.
            logger.debug('Keychain item holds no claudeAiOauth accessToken', { source: 'macos-keychain', service });
        } catch (err) {
            // `security`'s stderr is echoed into err.message by execFile. It
            // does not carry the secret today, but this is the one place in the
            // codebase where a token is a single shell-out away from a log line.
            logger.debug('Keychain lookup failed', {
                source: 'macos-keychain',
                service,
                error: redactSecrets(err instanceof Error ? err.message : String(err)),
            });
        }
        // Keychain is unreachable over SSH and inside some tmux/launchd
        // contexts, where Claude Code itself falls back to the file. Do the
        // same rather than reporting "no token" to a signed-in user.
        const fromFile = await readCredentialsFile();
        if (fromFile) {
            logger.debug('Read OAuth credentials', {
                source: 'credentials-file-fallback',
                subscriptionType: fromFile.subscriptionType ?? null,
            });
        }
        return fromFile;
    }

    const creds = await readCredentialsFile();
    if (creds) {
        logger.debug('Read OAuth credentials', {
            source: 'credentials-file',
            subscriptionType: creds.subscriptionType ?? null,
        });
    }
    return creds;
}
