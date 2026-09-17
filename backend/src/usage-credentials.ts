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
    /**
     * Claude Code's rate-limit tier, e.g. `default_claude_max_20x`. Not a
     * secret — it is the only place the Max 5x / 20x multiplier is recorded
     * (`subscriptionType` just says `max`).
     */
    rateLimitTier?: string;
}

/**
 * Parse the OAuth credentials JSON blob. Handles both the nested
 * `{ claudeAiOauth: {...} }` shape (as stored by Claude Code) and a bare
 * `{ accessToken, subscriptionType, rateLimitTier }` shape. Returns null on any
 * parse failure or when no access token is present. Pure — no I/O.
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
    if (typeof inner.rateLimitTier === 'string' && inner.rateLimitTier.length > 0) {
        result.rateLimitTier = inner.rateLimitTier;
    }
    return result;
}

/**
 * The Max multiplier encoded in `rateLimitTier`: `default_claude_max_5x` →
 * "5", `default_claude_max_20x` → "20". Deliberately strict — only the two
 * multipliers Anthropic sells are recognized, so an unfamiliar tier string
 * degrades to a plain "Max" instead of a made-up label.
 */
const MAX_TIER_RE = /(?:^|_)max_(5|20)x$/i;

/**
 * Human-facing plan label from a subscription type and rate-limit tier.
 *
 * `subscriptionType` is one of `max` | `pro` | `team` | `enterprise` | null —
 * derived by Claude Code from `organization.organization_type` and stored in
 * the credentials blob. It carries NO 5x/20x information: that lives in the
 * sibling `rateLimitTier` field (`default_claude_max_5x` /
 * `default_claude_max_20x`, verified in `~/.claude/.credentials.json` on
 * Windows). A `max` account is labelled "Max (5x)" / "Max (20x)" from that
 * field, and plain "Max" when it is absent or unrecognized.
 */
export function planLabelFromSubscription(sub?: string, rateLimitTier?: string): string {
    switch ((sub ?? '').toLowerCase()) {
        case 'max': {
            const tier = MAX_TIER_RE.exec(rateLimitTier ?? '');
            return tier ? `Max (${tier[1]}x)` : 'Max';
        }
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
 * Claude Code's `be()` — the string it hashes into the Keychain service name.
 *
 * Verified against the shipped binary (2.1.263):
 *
 *   var be = rs(() => (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"))
 *                       .normalize("NFC"), s);
 *
 * Two details matter and both are load-bearing, because the result is hashed:
 * the value is NFC-normalized, and it is NOT trimmed. Getting either wrong
 * changes the sha256 input, which changes the service name, which means the
 * lookup silently finds nothing — exactly the "no token" failure the suffix
 * was added to prevent.
 */
function configDirForHash(): string {
    return (process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')).normalize('NFC');
}

/**
 * The Claude Code config home used for the credentials FILE.
 *
 * Mirrors Claude Code's `A_()`: `CLAUDE_SECURESTORAGE_CONFIG_DIR` wins whenever
 * it is *defined* (an empty value means "the default", not "the cwd"), else
 * `CLAUDE_CONFIG_DIR`, else `~/.claude`.
 */
function claudeConfigDir(): string {
    const secure = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    if (secure !== undefined) {
        return (secure || path.join(os.homedir(), '.claude')).normalize('NFC');
    }
    // An empty CLAUDE_CONFIG_DIR would resolve `.credentials.json` relative to
    // the server's cwd; fall back to the default instead.
    return (process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')).normalize('NFC');
}

/**
 * The macOS Keychain generic-password service Claude Code stores the OAuth
 * blob under.
 *
 * Claude Code's `Sx()` (2.1.263), with `OAUTH_FILE_SUFFIX: ""` in prod and the
 * caller passing `"-credentials"`:
 *
 *   Sx(n) {
 *     let e = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
 *         t = e !== undefined ? !e : !process.env.CLAUDE_CONFIG_DIR,
 *         r = e !== undefined ? e.normalize("NFC") : be(),
 *         c = t ? "" : `-${sha256(r).hex.substring(0, 8)}`;
 *     return `Claude Code${OAUTH_FILE_SUFFIX}${n}${c}`;
 *   }
 *
 * Confirmed empirically on an unrelocated install: the login keychain holds
 * svce="Claude Code-credentials", acct=$USER.
 */
export function keychainServiceName(): string {
    const secure = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    const suffixed = secure !== undefined ? !!secure : !!process.env.CLAUDE_CONFIG_DIR;
    if (!suffixed) return 'Claude Code-credentials';
    const dir = secure !== undefined ? secure.normalize('NFC') : configDirForHash();
    const hash = createHash('sha256').update(dir).digest('hex').slice(0, 8);
    return `Claude Code-credentials-${hash}`;
}

/**
 * The account name Claude Code stores the item under — its `tv()`:
 *
 *   var s = /^[a-zA-Z0-9._-]+$/;
 *   function tv() {
 *     let n; try { n = process.env.USER || userInfo().username } catch { n = "claude-code-user" }
 *     if (!s.test(n)) return "claude-code-user";
 *     return n;
 *   }
 *
 * The regex guard is not cosmetic: a username carrying a space or a non-ASCII
 * character makes Claude Code store the item under the literal
 * `claude-code-user`, so asking for the raw name finds nothing.
 */
const KEYCHAIN_ACCOUNT_RE = /^[a-zA-Z0-9._-]+$/;

function keychainAccount(): string {
    let name: string;
    try {
        name = process.env.USER || os.userInfo().username;
    } catch {
        return 'claude-code-user';
    }
    return KEYCHAIN_ACCOUNT_RE.test(name) ? name : 'claude-code-user';
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
