/**
 * Portable state export — P0 task 10, spec §11.1
 * (`docs/plans/claudia-portable-backend-and-native-clients.md`).
 *
 * §11 makes migration a first-class operation: "moving is: stop Claudia, copy
 * the files to the new volume, set CLAUDIA_DATA_DIR, start. This should be a
 * documented procedure rather than folklore." Copying the directory wholesale
 * does not actually work, because the data directory is a mix of three things:
 *
 *   1. Portable state — workspaces, tasks, checkpoints, schedules. Moves.
 *   2. Machine-local identity — instance lock, MCP/auth tokens, crash logs,
 *      recovery journals, PID files. Regenerated on the target; carrying it
 *      across makes two installs claim the same identity.
 *   3. Secrets — API keys and MCP credentials. Moving them silently is a
 *      surprise; a copied directory should not spray a user's Anthropic key
 *      onto whatever machine or backup the export lands on.
 *
 * This module separates those three and writes the first, opting into the third
 * only on request. Nothing about live process state is exported: PTY handles,
 * sockets and PIDs describe the running host and are meaningless elsewhere.
 *
 * ## Layout
 *
 * ```
 * <out>/
 *   manifest.json                        provenance, tiers, schema versions
 *   state/                               portable JSON state, secrets removed
 *     config.json workspace-config.json tasks.json archived-tasks.json
 *     checkpoints.json scheduled-tasks.json todos.json learnings.json
 *     chat-history.json
 *   secrets.json                         only with `withSecrets`, mode 0600
 *   histories/                           only with `withHistories`
 *     task-histories/ archived-histories/
 *   agent-sessions/<backend>/<workspace>/<sessionId>.jsonl
 *                                        only with `withAgentSessions`
 * ```
 *
 * ## Tiers
 *
 * The default export is small, safe to attach to an issue, and safe to keep in
 * a backup: state only. The three opt-in tiers each carry a real cost —
 * secrets are dangerous, histories are ~2.2 GB on a working install, and agent
 * sessions are verbatim transcripts — so none of them is on by default. A
 * restore from the default tier alone yields a working Claudia with every
 * workspace and task present; the extra tiers restore fidelity, not function.
 */

import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
    readdirSync,
    copyFileSync,
    chmodSync,
} from 'fs';
import { copyFile as copyFileAsync, stat as statAsync } from 'fs/promises';
import { join, dirname, resolve, basename } from 'path';
import { homedir, hostname } from 'os';
import { fileURLToPath } from 'url';

import { dataPath, LEGACY_DATA_DIR } from '../paths.js';
import { isPathInside } from '../validation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface ExportOptions {
    /** Directory to write the export into. Created if absent. */
    out: string;
    /** Include `secrets.json` (mode 0600) with the values stripped from config. */
    withSecrets?: boolean;
    /** Include `task-histories/` and `archived-histories/` — gigabytes. */
    withHistories?: boolean;
    /** Include agent session JSONL transcripts for non-archived tasks. */
    withAgentSessions?: boolean;
}

export interface ExportManifest {
    formatVersion: 1;
    exportedAt: string;
    claudiaVersion: string;
    source: {
        platform: string;
        hostname: string;
        /** Instance id of the source install, for provenance. Never the file. */
        instanceId: string | null;
        dataDir: string;
        homeDir: string;
    };
    tiers: { secrets: boolean; histories: boolean; agentSessions: boolean };
    /**
     * Per-file on-disk schema version. `null` means the file exists but is in
     * the pre-envelope legacy shape — distinct from the key being absent,
     * which means the file was not present at all.
     */
    schemaVersions: Record<string, number | null>;
    workspaces: Array<{ id: string; name: string; worktreeParentId?: string }>;
}

/** Injectable environment. Exists so tests never read the real `~/.claude`. */
export interface ExportDeps {
    homeDir?: string;
}

// ---------------------------------------------------------------------------
// What moves, and what must never move
// ---------------------------------------------------------------------------

/** Portable state files, copied when present. */
export const STATE_FILES = [
    'config.json',
    'workspace-config.json',
    'tasks.json',
    'archived-tasks.json',
    'checkpoints.json',
    'scheduled-tasks.json',
    'todos.json',
    'learnings.json',
    'chat-history.json',
] as const;

/**
 * Files that must never leave the machine, by exact name.
 *
 * - `instance.json` — the single-instance lock. Two installs sharing one id
 *   is exactly the failure the lock exists to prevent.
 * - `mcp-token`, `auth-token` — bearer credentials for this host's API.
 *   Regenerated on the target; exporting them widens their blast radius for
 *   no benefit, since the target mints its own on first boot.
 * - `crash.log` — diagnostics about a process that no longer exists.
 * - `session-recovery.json`(+`.applied`) — a journal describing PTYs on the
 *   source host. Replaying it elsewhere would try to resurrect dead processes.
 * - tunnel state — an ngrok URL bound to the source machine's session.
 */
export const NEVER_EXPORT_NAMES = new Set([
    'instance.json',
    'mcp-token',
    'auth-token',
    'crash.log',
    'session-recovery.json',
    'session-recovery.json.applied',
    'tunnel-state.json',
    'tunnel.json',
]);

/** Volatile or derived siblings: PID files, atomic-write temps, backups. */
const NEVER_EXPORT_SUFFIXES = /\.(pid|tmp|bak)$/i;

/** True if this file name must never appear anywhere in an export. */
export function isExcludedFile(name: string): boolean {
    return NEVER_EXPORT_NAMES.has(name) || NEVER_EXPORT_SUFFIXES.test(name);
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/**
 * Secret locations in `config.json`, as dotted paths into the config object
 * (i.e. inside `data` when the file carries a `{schemaVersion, data}`
 * envelope). Verified against `backend/src/config-store.ts`:
 * `customAnthropicApiKey`, `deepgramApiKey`, `hyperspaceProxy.apiKey`,
 * `aiCoreCredentials.clientId`/`clientSecret`, `jira.apiToken`/`jira.email`.
 *
 * `jira.email` is here alongside the token because the Jira integration uses
 * HTTP Basic auth: the email is half the credential, not just an identifier.
 *
 * `mcpServers[].env` and `mcpServers[].headers` are handled separately below —
 * every value is stripped, not a named subset, because their contents are
 * user-defined and routinely hold tokens under arbitrary names.
 */
export const SECRET_PATHS = [
    'customAnthropicApiKey',
    'deepgramApiKey',
    'hyperspaceProxy.apiKey',
    'aiCoreCredentials.clientId',
    'aiCoreCredentials.clientSecret',
    'jira.apiToken',
    'jira.email',
] as const;

/**
 * Catch-all for secret-shaped keys nobody has enumerated yet.
 *
 * The enumerated list above goes stale the moment someone adds a provider, and
 * the failure mode of a stale list is a silent leak. This heuristic covers the
 * next one for free.
 *
 * It only fires on **string** values, which is what keeps it from eating
 * `tokenPricing` (an object), `tokenTrackingEnabled` and `tokenCostEnabled`
 * (booleans) — all three contain "token" and all three are settings, not
 * credentials. That type check is load-bearing; do not relax it to `truthy`.
 */
const SECRET_KEY_HEURISTIC = /(api[-_]?key|secret|token|password|passphrase|credential)/i;

/** A flat map of dotted path → stripped value, as written to `secrets.json`. */
export type StrippedSecrets = Record<string, string>;

type Json = unknown;

function isPlainObject(value: Json): value is Record<string, Json> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Remove every secret from a parsed config object, in place, returning what
 * was removed keyed by dotted path.
 *
 * Values are **blanked** (`''`) rather than deleted. A deleted key loses the
 * information that the setting exists at all, and an import then cannot tell
 * "never configured" from "configured, secret withheld" — which is the
 * difference between a working restore and a confusing one.
 */
export function stripSecrets(config: Record<string, Json>): StrippedSecrets {
    const stripped: StrippedSecrets = {};

    const take = (holder: Record<string, Json>, key: string, path: string): void => {
        const value = holder[key];
        if (typeof value !== 'string' || value === '') return;
        stripped[path] = value;
        holder[key] = '';
    };

    // 1. Enumerated paths — authoritative, and independent of key spelling
    //    (this is how `jira.email`, which no heuristic would flag, is caught).
    for (const path of SECRET_PATHS) {
        const parts = path.split('.');
        let holder: Json = config;
        for (let i = 0; i < parts.length - 1; i++) {
            if (!isPlainObject(holder)) { holder = undefined; break; }
            holder = holder[parts[i]];
        }
        if (isPlainObject(holder)) take(holder, parts[parts.length - 1], path);
    }

    // 2. MCP server env and headers — every value, whatever it is called.
    const servers = config['mcpServers'];
    if (Array.isArray(servers)) {
        servers.forEach((server, index) => {
            if (!isPlainObject(server)) return;
            for (const bag of ['env', 'headers'] as const) {
                const map = server[bag];
                if (!isPlainObject(map)) continue;
                for (const key of Object.keys(map)) {
                    take(map, key, `mcpServers[${index}].${bag}.${key}`);
                }
            }
        });
    }

    // 3. Heuristic sweep over everything else, so an unknown future key that is
    //    plainly a credential does not ride along.
    const sweep = (node: Json, path: string): void => {
        if (Array.isArray(node)) {
            node.forEach((child, i) => sweep(child, `${path}[${i}]`));
            return;
        }
        if (!isPlainObject(node)) return;
        for (const key of Object.keys(node)) {
            const childPath = path ? `${path}.${key}` : key;
            if (SECRET_KEY_HEURISTIC.test(key)) {
                take(node, key, childPath);
                continue;
            }
            sweep(node[key], childPath);
        }
    };
    sweep(config, '');

    return stripped;
}

// ---------------------------------------------------------------------------
// Defensive state-file reading
//
// Two on-disk shapes coexist right now: `{schemaVersion, data}` envelopes and
// bare legacy objects, and which files have been converted moves under us as
// the versioning work lands. Everything below therefore accepts both and never
// assumes an envelope.
// ---------------------------------------------------------------------------

interface ParsedStateFile {
    /** Raw parsed JSON, envelope included. `undefined` if unreadable. */
    raw: Json;
    /** Payload — `raw.data` for an envelope, `raw` otherwise. */
    data: Json;
    /** Version from the envelope, or `null` for a legacy (unversioned) file. */
    schemaVersion: number | null;
}

function parseStateFile(path: string): ParsedStateFile | null {
    if (!existsSync(path)) return null;
    let raw: Json;
    try {
        raw = JSON.parse(readFileSync(path, 'utf-8'));
    } catch (error) {
        console.warn(`[Export] ${basename(path)} is not valid JSON, copying bytes verbatim:`, error);
        return { raw: undefined, data: undefined, schemaVersion: null };
    }
    if (isPlainObject(raw) && typeof raw['schemaVersion'] === 'number' && 'data' in raw) {
        return { raw, data: raw['data'], schemaVersion: raw['schemaVersion'] as number };
    }
    return { raw, data: raw, schemaVersion: null };
}

/** Re-wrap a payload in whatever envelope the source file used. */
function rewrap(parsed: ParsedStateFile, data: Json): Json {
    return parsed.schemaVersion === null ? data : { schemaVersion: parsed.schemaVersion, data };
}

// ---------------------------------------------------------------------------
// Agent session locations
// ---------------------------------------------------------------------------

/**
 * Directory holding Claude Code session JSONL transcripts for a workspace:
 * `~/.claude/projects/<mangled-workspace-path>/<sessionId>.jsonl`.
 *
 * Duplicated from `token-parser.ts` / `conversation-parser.ts` deliberately and
 * isolated here as the module's single point of contact with that convention.
 *
 * TODO(#255): replace with CodeBackend.sessionFiles once merged
 */
function claudeSessionDirFor(workspacePath: string, homeDirectory: string): string {
    const folderName = workspacePath.replace(/[^a-zA-Z0-9-]/g, '-');
    return join(homeDirectory, '.claude', 'projects', folderName);
}

/**
 * Turn a workspace id (an absolute filesystem path) into one safe, reversible
 * path segment. `decodeURIComponent` on import recovers the id exactly, which
 * a lossy mangle like the Claude projects convention would not.
 */
function workspaceSegment(workspaceId: string): string {
    return encodeURIComponent(workspaceId);
}

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

function readClaudiaVersion(): string {
    for (const candidate of [
        join(__dirname, '..', '..', 'package.json'),
        join(__dirname, '..', '..', '..', 'package.json'),
    ]) {
        try {
            const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as { version?: string };
            if (pkg.version) return pkg.version;
        } catch {
            /* try the next candidate */
        }
    }
    return 'unknown';
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

interface TaskLike {
    id?: string;
    workspaceId?: string;
    sessionId?: string | null;
}

function activeTasksOf(parsed: ParsedStateFile | null): TaskLike[] {
    // Archived tasks live either in `data.archivedTasks` or in the separate
    // archived-tasks.json; neither is read here. Only `tasks[]` is live, and
    // only live tasks get their transcripts exported.
    const data = parsed?.data;
    if (!isPlainObject(data)) return [];
    const tasks = data['tasks'];
    return Array.isArray(tasks) ? (tasks as TaskLike[]) : [];
}

/**
 * Copy a directory's files one at a time, skipping excluded names.
 *
 * Deliberately `copyFileSync` per entry rather than reading a directory into
 * memory: `task-histories/` is ~2.2 GB and ~900 files on a working install, so
 * anything that buffers is an OOM waiting to happen. Progress is logged every
 * 100 files because a silent multi-minute copy looks like a hang.
 */
async function copyDirShallow(from: string, to: string, label: string): Promise<{ files: number; bytes: number }> {
    let files = 0;
    let bytes = 0;
    if (!existsSync(from)) {
        console.log(`[Export] ${label}: nothing to copy (${from} does not exist)`);
        return { files, bytes };
    }
    mkdirSync(to, { recursive: true });
    const entries = readdirSync(from, { withFileTypes: true });
    console.log(`[Export] ${label}: copying ${entries.length} entries from ${from}`);
    for (const entry of entries) {
        if (!entry.isFile() || isExcludedFile(entry.name)) continue;
        const src = join(from, entry.name);
        try {
            // Awaited per file rather than copyFileSync: this loop can run for
            // minutes over gigabytes, and a synchronous copy would wedge the
            // event loop for its whole duration — every WebSocket client and
            // every running task would stall behind an export.
            await copyFileAsync(src, join(to, entry.name));
            bytes += (await statAsync(src)).size;
            files++;
            if (files % 100 === 0) {
                console.log(`[Export] ${label}: ${files} files, ${(bytes / 1e6).toFixed(1)} MB so far`);
            }
        } catch (error) {
            console.warn(`[Export] ${label}: skipped ${entry.name}:`, error);
        }
    }
    console.log(`[Export] ${label}: done — ${files} files, ${(bytes / 1e6).toFixed(1)} MB`);
    return { files, bytes };
}

/**
 * Write a portable export of Claudia's state to `opts.out`.
 *
 * @param dataDir Resolved data directory, or `undefined` for the legacy location.
 * @param opts    Destination and tier selection.
 * @param deps    Injectable environment (home directory). Tests only.
 */
export async function exportState(
    dataDir: string | undefined,
    opts: ExportOptions,
    deps: ExportDeps = {}
): Promise<ExportManifest> {
    const out = opts.out?.trim();
    if (!out) throw new Error('export: "out" is required');

    const sourceDir = dataDir ?? LEGACY_DATA_DIR;
    const outAbs = resolve(out);

    // Writing the export inside the directory being exported is a foot-gun: a
    // second run would then export the first run's output, recursively.
    // isPathInside() compares on a separator boundary and treats an identical
    // path as inside, so this covers `out === dataDir` too.
    if (isPathInside(sourceDir, outAbs)) {
        throw new Error(`export: refusing to write inside the data directory (${sourceDir})`);
    }

    const homeDirectory = deps.homeDir ?? homedir();
    const tiers = {
        secrets: opts.withSecrets === true,
        histories: opts.withHistories === true,
        agentSessions: opts.withAgentSessions === true,
    };

    console.log(
        `[Export] starting: source=${sourceDir} out=${outAbs} ` +
            `tiers=${Object.entries(tiers).filter(([, on]) => on).map(([k]) => k).join(',') || 'state-only'}`
    );

    mkdirSync(outAbs, { recursive: true });

    // --- state tier --------------------------------------------------------
    const stateDir = join(outAbs, 'state');
    const schemaVersions: Record<string, number | null> = {};
    const secrets: Record<string, StrippedSecrets> = {};
    let configParsed: ParsedStateFile | null = null;
    let tasksParsed: ParsedStateFile | null = null;
    let workspacesParsed: ParsedStateFile | null = null;

    for (const name of STATE_FILES) {
        // Belt and braces: none of STATE_FILES is on the never-export list, but
        // the check is here so adding a name to one list cannot defeat the other.
        if (isExcludedFile(name)) continue;
        const src = dataPath(dataDir, name);
        const parsed = parseStateFile(src);
        if (!parsed) continue;

        if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
        schemaVersions[name] = parsed.schemaVersion;

        if (name === 'config.json' && parsed.raw !== undefined) {
            configParsed = parsed;
            const config = isPlainObject(parsed.data) ? (JSON.parse(JSON.stringify(parsed.data)) as Record<string, Json>) : {};
            const strippedValues = stripSecrets(config);
            if (Object.keys(strippedValues).length > 0) secrets[name] = strippedValues;
            writeFileSync(join(stateDir, name), JSON.stringify(rewrap(parsed, config), null, 2), 'utf-8');
            console.log(`[Export] state: config.json copied, ${Object.keys(strippedValues).length} secret value(s) stripped`);
            continue;
        }

        if (name === 'tasks.json') tasksParsed = parsed;
        if (name === 'workspace-config.json') workspacesParsed = parsed;

        // Everything else is copied byte-for-byte, including files that failed
        // to parse — an operator can still salvage a corrupt file by hand, and
        // dropping it silently would be the worse outcome.
        copyFileSync(src, join(stateDir, name));
        console.log(`[Export] state: ${name} copied (schemaVersion=${parsed.schemaVersion ?? 'legacy'})`);
    }

    // --- secrets tier ------------------------------------------------------
    if (tiers.secrets && Object.keys(secrets).length > 0) {
        const secretsPath = join(outAbs, 'secrets.json');
        writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), { encoding: 'utf-8', mode: 0o600 });
        // writeFileSync's `mode` only applies at creation; chmod unconditionally
        // so re-exporting over an existing file cannot leave it world-readable.
        try {
            chmodSync(secretsPath, 0o600);
        } catch (error) {
            console.warn('[Export] could not chmod secrets.json to 0600:', error);
        }
        const count = Object.values(secrets).reduce((n, m) => n + Object.keys(m).length, 0);
        console.log(`[Export] secrets: wrote ${count} value(s) to secrets.json (mode 0600)`);
    } else if (tiers.secrets) {
        console.log('[Export] secrets: nothing to write — no secret values were configured');
    }

    // --- histories tier ----------------------------------------------------
    if (tiers.histories) {
        const historiesDir = join(outAbs, 'histories');
        mkdirSync(historiesDir, { recursive: true });
        let total = 0;
        for (const dir of ['task-histories', 'archived-histories']) {
            const result = await copyDirShallow(join(sourceDir, dir), join(historiesDir, dir), `histories/${dir}`);
            total += result.bytes;
        }
        console.log(`[Export] histories: ${(total / 1e6).toFixed(1)} MB total`);
    }

    // --- agent sessions tier ----------------------------------------------
    if (tiers.agentSessions) {
        const backendName =
            (isPlainObject(configParsed?.data) && typeof configParsed!.data['backend'] === 'string'
                ? (configParsed!.data['backend'] as string)
                : 'claude-code') || 'claude-code';
        const sessionsRoot = join(outAbs, 'agent-sessions', backendName);
        const tasks = activeTasksOf(tasksParsed);
        let copied = 0;

        for (const task of tasks) {
            const { workspaceId, sessionId } = task;
            if (!workspaceId || !sessionId) continue;
            const src = join(claudeSessionDirFor(workspaceId, homeDirectory), `${sessionId}.jsonl`);
            const destDir = join(sessionsRoot, workspaceSegment(workspaceId));
            const dest = join(destDir, `${sessionId}.jsonl`);
            // A session id reaches us from persisted state, so treat it as
            // untrusted path input rather than assuming it is a uuid.
            if (!isPathInside(destDir, dest) || dest === resolve(destDir)) {
                console.warn(`[Export] agent-sessions: rejected suspicious session id for task ${task.id}`);
                continue;
            }
            if (!existsSync(src)) continue;
            mkdirSync(destDir, { recursive: true });
            copyFileSync(src, dest);
            copied++;
        }
        console.log(
            `[Export] agent-sessions: ${copied} transcript(s) for ${tasks.length} live task(s) ` +
                `(archived tasks deliberately excluded)`
        );
    }

    // --- manifest ----------------------------------------------------------
    const workspaces: ExportManifest['workspaces'] = [];
    const wsData = workspacesParsed?.data;
    if (isPlainObject(wsData) && Array.isArray(wsData['workspaces'])) {
        for (const ws of wsData['workspaces'] as Json[]) {
            if (!isPlainObject(ws) || typeof ws['id'] !== 'string') continue;
            const entry: ExportManifest['workspaces'][number] = {
                id: ws['id'],
                name: typeof ws['name'] === 'string' ? ws['name'] : basename(ws['id']),
            };
            if (typeof ws['worktreeParentId'] === 'string') entry.worktreeParentId = ws['worktreeParentId'];
            workspaces.push(entry);
        }
    }

    const manifest: ExportManifest = {
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        claudiaVersion: readClaudiaVersion(),
        source: {
            platform: process.platform,
            hostname: hostname(),
            instanceId: readInstanceId(sourceDir),
            dataDir: sourceDir,
            homeDir: homeDirectory,
        },
        tiers,
        schemaVersions,
        workspaces,
    };

    writeFileSync(join(outAbs, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
    console.log(
        `[Export] complete: ${workspaces.length} workspace(s), ` +
            `${Object.keys(schemaVersions).length} state file(s) → ${outAbs}`
    );

    return manifest;
}

/**
 * Read the source install's instance id for provenance.
 *
 * The id is recorded in the manifest so a restore can be traced back to the
 * machine it came from; `instance.json` itself is never copied, because it is
 * a lock and two installs holding the same one defeats it.
 */
function readInstanceId(sourceDir: string): string | null {
    try {
        const raw = JSON.parse(readFileSync(join(sourceDir, 'instance.json'), 'utf-8')) as Record<string, unknown>;
        const payload = isPlainObject(raw['data']) ? (raw['data'] as Record<string, unknown>) : raw;
        for (const key of ['instanceId', 'id']) {
            if (typeof payload[key] === 'string') return payload[key] as string;
        }
    } catch {
        /* absent or unreadable — provenance is best-effort */
    }
    return null;
}
