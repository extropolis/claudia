import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from './logger.js';

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
 * `'max'` → `'Max (20x)'`, `'pro'` → `'Pro'`, otherwise `'Unknown'`.
 */
export function planLabelFromSubscription(sub?: string): string {
    switch ((sub ?? '').toLowerCase()) {
        case 'max':
            return 'Max (20x)';
        case 'pro':
            return 'Pro';
        default:
            return 'Unknown';
    }
}

/**
 * Read the Claude Code OAuth credentials from the OS credential store.
 * - macOS: reads the "Claude Code-credentials" generic password from Keychain.
 * - Linux/Windows: reads `~/.claude/.credentials.json`.
 * Returns null when no token is found or the platform is unsupported.
 * Never logs the token.
 */
export async function readOAuthCredentials(): Promise<OAuthCredentials | null> {
    // Only the *source* and whether a token was found are logged — never the
    // blob or the token itself.
    const source = process.platform === 'darwin' ? 'macos-keychain' : 'credentials-file';
    try {
        if (process.platform === 'darwin') {
            const { stdout } = await execFileAsync('security', [
                'find-generic-password',
                '-s',
                'Claude Code-credentials',
                '-a',
                os.userInfo().username,
                '-w',
            ]);
            const creds = parseCredentialsBlob(stdout);
            if (!creds) logger.warn('Keychain entry found but no accessToken could be parsed', { source });
            else logger.debug('Read OAuth credentials', { source, subscriptionType: creds.subscriptionType ?? null });
            return creds;
        }
        const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
        const contents = await readFile(credPath, 'utf8');
        const creds = parseCredentialsBlob(contents);
        if (!creds) logger.warn('Credentials file found but no accessToken could be parsed', { source, credPath });
        else logger.debug('Read OAuth credentials', { source, subscriptionType: creds.subscriptionType ?? null });
        return creds;
    } catch (err) {
        // Missing keychain entry / missing file / unsupported: treat as no token.
        logger.debug('No OAuth credentials available', {
            source,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}
