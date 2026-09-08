/**
 * Portable state import — P0 task 11, spec §11.2.
 *
 * ## Why a copied data directory does not work
 *
 * §11 promises that moving Claudia is "stop, copy the files, set
 * CLAUDIA_DATA_DIR, start". Copying alone does not deliver that, because
 * Claudia's state is full of **absolute paths from the machine that wrote it**,
 * and two of them are load-bearing:
 *
 *   1. **A workspace's id IS its absolute path.** `/Users/ana/work/api` on the
 *      laptop is `/home/ana/work/api` on the Sprite. On boot,
 *      `workspace-store.ts` filters its list with `existsSync(w.id)` and
 *      **drops** every workspace whose path is missing — so a naive copy does
 *      not degrade, it deletes. Every task pointing at that workspace is then
 *      orphaned. (PR #256 softens this to "mark unavailable"; this module
 *      assumes the older, destructive behaviour and does not depend on it.)
 *   2. **Agent transcripts are filed under a mangled absolute path.** Claude
 *      Code stores sessions at `~/.claude/projects/<path-with-non-alnum-
 *      replaced-by-dashes>/<sessionId>.jsonl`. The folder name for
 *      `/Users/ana/work/api` simply does not exist on a host where the work
 *      lives at `/home/ana/work/api`, so `--resume` finds nothing and every
 *      task restarts cold.
 *
 * Import therefore does what a copy cannot: it **remaps paths**, then files the
 * transcripts under the names the runtime will actually look for on this
 * machine.
 *
 * ## The remap contract
 *
 * - Mappings are `old → new` prefixes, matched **longest-prefix first** so a
 *   specific rule beats a general one regardless of the order they were given.
 * - A match must land on a path boundary. `/work/api` must not rewrite
 *   `/work/api-v2`, which a bare `startsWith` would happily corrupt.
 * - The manifest's `source.homeDir → os.homedir()` is added implicitly and
 *   sorted in with the rest, so the common "same layout, different user" move
 *   needs no `--map` at all — but an explicit rule for a longer prefix still
 *   wins over it.
 * - **A path that matches nothing is left exactly as it was** and reported in
 *   `warnings`. Guessing at an unmapped path is how you silently point a task
 *   at the wrong directory.
 * - Repo-relative data is never touched. `metadata.filesModified` is a count,
 *   `gitDiff` is a patch — neither is a host path, and rewriting inside them
 *   would corrupt real content.
 *
 * ## What import refuses to do
 *
 * Refusal beats a half-finished merge, so import stops before writing anything
 * if a live backend holds the target data directory, or if the target already
 * has a `tasks.json` and `force` was not passed. An import is a restore, not a
 * merge: there is no sane way to reconcile two divergent task lists, and
 * silently overwriting a working install is the worst of the options.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from 'fs';
import { join, resolve, sep, dirname } from 'path';
import { homedir } from 'os';

import { LEGACY_DATA_DIR } from '../paths.js';
import { isPathInside } from '../validation.js';
import { loadVersioned, saveVersioned } from '../utils/schema-version.js';
import type { ExportManifest } from './export.js';
import { readHandoffMark, restoreWorkingTree, type HandoffRepo, type RestoreResult } from './handoff.js';

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface ImportOptions {
    /** Explicit `old → new` path prefix mappings, in any order. */
    map?: Array<[string, string]>;
    /** Compute and report everything; write nothing. */
    dryRun?: boolean;
    /** Overwrite a target data directory that already has a `tasks.json`. */
    force?: boolean;
    /** Also fetch and restore the working trees a `--handoff` export captured. */
    handoff?: boolean;
}

export interface ImportReport {
    /** Effective mappings, longest-prefix first — the order they were applied. */
    remapTable: Array<[string, string]>;
    /** Every workspace, with its new id and whether that path exists here. */
    workspaces: Array<{ id: string; newId: string; exists: boolean }>;
    /** State files written into the data directory, by name. */
    filesWritten: string[];
    /** Agent transcripts placed under the new mangled folder names. */
    sessionsPlaced: number;
    /** Things deliberately not done, each with its reason. */
    skipped: string[];
    /** Non-fatal problems the operator should read. */
    warnings: string[];
    /** Per-repo outcomes, only when `handoff` was requested. */
    handoff?: RestoreResult[];
    /** True when nothing was written because `dryRun` was set. */
    dryRun: boolean;
}

/** Injectable environment. Exists so tests never touch the real `~/.claude`. */
export interface ImportDeps {
    homeDir?: string;
    /** Liveness probe for the target's instance lock. Injectable for tests. */
    isPidAlive?: (pid: number) => boolean;
}

/** Highest `formatVersion` this importer understands. */
export const SUPPORTED_FORMAT_VERSION = 1;

type Json = unknown;

function isPlainObject(value: Json): value is Record<string, Json> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// The remap engine
// ---------------------------------------------------------------------------

/**
 * An ordered set of `old → new` prefix rules.
 *
 * Held as a class rather than a bare function so that "which rules exist, in
 * what order" is inspectable — `--dry-run` prints exactly this table, and the
 * table is the thing an operator needs to check before trusting the import.
 */
export class PathRemapper {
    /** Rules, longest `from` first. Length order is what makes matching total. */
    readonly rules: Array<[string, string]>;
    /** Paths that matched no rule, deduplicated, in first-seen order. */
    private readonly unmatched = new Set<string>();

    constructor(pairs: Array<[string, string]>) {
        const seen = new Map<string, string>();
        for (const [from, to] of pairs) {
            const f = normalize(from);
            const t = normalize(to);
            // A later rule for the same source wins; duplicates are otherwise
            // silently redundant and a duplicate that *disagrees* is a bug the
            // operator wants resolved deterministically.
            if (f) seen.set(f, t);
        }
        this.rules = [...seen.entries()].sort((a, b) => b[0].length - a[0].length);
    }

    /**
     * Rewrite one path. Returns the input unchanged (and records it) when no
     * rule matches — never a guess.
     */
    apply(value: string): string {
        if (!value) return value;
        const normalized = normalize(value);
        for (const [from, to] of this.rules) {
            if (normalized === from) return to;
            // Boundary check: `/work/api` must not match `/work/api-v2`. The
            // separator has to be part of the comparison, not an afterthought.
            if (normalized.startsWith(from.endsWith(sep) ? from : from + sep)) {
                // Slice the tail off the ORIGINAL, not the normalized copy:
                // normalization case-folds on Windows, and the remainder of the
                // path must come back with the caller's own spelling intact.
                // Both transforms are length-preserving, so the offsets agree.
                const tail = value.slice(from.length);
                return to.replace(/[\\/]+$/, '') + tail;
            }
        }
        this.unmatched.add(value);
        return value;
    }

    /** Paths that no rule covered, for the report's `warnings`. */
    unmatchedPaths(): string[] {
        return [...this.unmatched];
    }
}

/**
 * Normalize a path for prefix comparison: strip trailing separators, and on
 * Windows unify separators and case so `C:\Work` matches `c:/work`.
 *
 * POSIX paths are deliberately left case-sensitive — `/Work` and `/work` are
 * genuinely different directories on Linux, and folding them would let one
 * rule silently capture the other's paths.
 */
function normalize(p: string): string {
    if (!p) return '';
    let out = p.trim().replace(/[\\/]+$/, '');
    if (process.platform === 'win32') out = out.replace(/\//g, '\\').toLowerCase();
    return out;
}

// ---------------------------------------------------------------------------
// Which fields hold host paths
//
// Every entry below was confirmed by reading the store that owns the file, not
// inferred from the field name. The comment on each names that store, because
// the next person to add a path-valued field needs to know where to look to
// keep this list honest.
// ---------------------------------------------------------------------------

/**
 * Rewrite the path-valued fields of `workspace-config.json`.
 * Owner: `workspace-store.ts` (`WorkspaceConfig`). A workspace's `id` is its
 * absolute path; `worktreeParentId` points at another workspace's id.
 */
function remapWorkspaceConfig(data: Json, remap: PathRemapper): void {
    if (!isPlainObject(data)) return;

    for (const key of ['workspaces', 'recentWorkspaces'] as const) {
        const list = data[key];
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
            if (!isPlainObject(entry)) continue;
            if (typeof entry['id'] === 'string') entry['id'] = remap.apply(entry['id']);
            if (typeof entry['worktreeParentId'] === 'string') {
                entry['worktreeParentId'] = remap.apply(entry['worktreeParentId']);
            }
            // `references[]` carry their own absolute paths — a reference is a
            // second directory a workspace can see, so it moves with the rest.
            const refs = entry['references'];
            if (Array.isArray(refs)) {
                for (const ref of refs) {
                    if (isPlainObject(ref) && typeof ref['path'] === 'string') {
                        ref['path'] = remap.apply(ref['path']);
                    }
                }
            }
        }
    }

    if (typeof data['activeWorkspaceId'] === 'string') {
        data['activeWorkspaceId'] = remap.apply(data['activeWorkspaceId']);
    }
    if (typeof data['lastBrowsedPath'] === 'string') {
        data['lastBrowsedPath'] = remap.apply(data['lastBrowsedPath']);
    }
}

/**
 * Rewrite every task's `workspaceId`, in both `tasks.json` and
 * `archived-tasks.json`.
 *
 * Owner: `task-spawner.ts` (`PersistedTask`). `workspaceId` is the only host
 * path on the record: `gitState.filesModified` is repo-relative and
 * `outputHistory` is terminal bytes, so both are left alone.
 */
function remapTasks(data: Json, remap: PathRemapper): void {
    if (!isPlainObject(data)) return;
    for (const key of ['tasks', 'archivedTasks'] as const) {
        const list = data[key];
        if (!Array.isArray(list)) continue;
        for (const task of list) {
            if (isPlainObject(task) && typeof task['workspaceId'] === 'string') {
                task['workspaceId'] = remap.apply(task['workspaceId']);
            }
        }
    }
}

/**
 * Rewrite `checkpoints.json`. Owner: `checkpoint-store.ts` — the payload is
 * `{ checkpoints: Checkpoint[] }` and `Checkpoint.workspaceId` is a path.
 * `gitDiff` is a unified diff of repo-relative paths and must NOT be rewritten:
 * a prefix match inside patch text would corrupt the patch.
 */
function remapCheckpoints(data: Json, remap: PathRemapper): void {
    if (!isPlainObject(data)) return;
    const list = data['checkpoints'];
    if (!Array.isArray(list)) return;
    for (const cp of list) {
        if (isPlainObject(cp) && typeof cp['workspaceId'] === 'string') {
            cp['workspaceId'] = remap.apply(cp['workspaceId']);
        }
    }
}

/**
 * Rewrite `scheduled-tasks.json`. Owner: `cron-scheduler.ts` — the payload is a
 * bare `ScheduledTask[]` and each carries a `workspaceId` path.
 *
 * Not named in §11.2's list, which enumerates workspace-config, tasks,
 * archived-tasks and checkpoints. It is included because leaving it out is a
 * live bug rather than a scope question: a cron entry pointing at the source
 * machine's path fires against a workspace that does not exist here.
 */
function remapScheduledTasks(data: Json, remap: PathRemapper): void {
    const list = Array.isArray(data) ? data : isPlainObject(data) && Array.isArray(data['tasks']) ? data['tasks'] : null;
    if (!list) return;
    for (const entry of list) {
        if (isPlainObject(entry) && typeof entry['workspaceId'] === 'string') {
            entry['workspaceId'] = remap.apply(entry['workspaceId']);
        }
    }
}

/**
 * Target on-disk schema version per file, read from the store that owns it.
 *
 * A file absent from this map is written back in whatever envelope the export
 * carried, untouched. That is the correct handling for `tasks.json` today: it
 * has no envelope on this branch (PR #252 adds one), and inventing a version
 * number for it here would make this importer disagree with the reader.
 */
const TARGET_SCHEMA_VERSIONS: Record<string, number> = {
    'config.json': 1, // config-store.ts        CONFIG_SCHEMA_VERSION
    'workspace-config.json': 1, // workspace-store.ts     WORKSPACE_SCHEMA_VERSION
    'checkpoints.json': 1, // checkpoint-store.ts    CHECKPOINT_SCHEMA_VERSION
    'scheduled-tasks.json': 1, // cron-scheduler.ts      CRON_SCHEMA_VERSION
    'todos.json': 1, // todo-store.ts          TODOS_SCHEMA_VERSION
    'learnings.json': 1, // learnings-store.ts     LEARNINGS_SCHEMA_VERSION
};

/** Remap functions by file name. Files with no host paths are simply absent. */
const REMAPPERS: Record<string, (data: Json, remap: PathRemapper) => void> = {
    'workspace-config.json': remapWorkspaceConfig,
    'tasks.json': remapTasks,
    'archived-tasks.json': remapTasks,
    'checkpoints.json': remapCheckpoints,
    'scheduled-tasks.json': remapScheduledTasks,
};

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/** Default liveness probe: signal 0 tests for the process without signalling it. */
function defaultIsPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM means the pid exists but belongs to another user — still alive,
        // and still a reason to refuse. Only ESRCH means "no such process".
        return (error as NodeJS.ErrnoException)?.code === 'EPERM';
    }
}

/**
 * Refuse to import into a data directory a live backend is holding.
 *
 * `instance.json` is the single-instance lock (PR #259); it may not exist at
 * all on an older install, so this reads it defensively and treats anything
 * unparseable as "no lock" rather than throwing. The cost of a false negative
 * is a race that the operator can see; the cost of a false positive is an
 * import that can never run.
 */
function assertNoLiveInstance(dataDir: string, isPidAlive: (pid: number) => boolean): void {
    const lockPath = join(dataDir, 'instance.json');
    if (!existsSync(lockPath)) return;

    let payload: Record<string, unknown>;
    try {
        const raw = JSON.parse(readFileSync(lockPath, 'utf-8')) as Record<string, unknown>;
        payload = (raw && typeof raw['data'] === 'object' && raw['data'] !== null
            ? (raw['data'] as Record<string, unknown>)
            : raw) ?? {};
    } catch {
        console.warn(`[Import] ${lockPath} is unreadable; proceeding as if unlocked`);
        return;
    }

    const pid = typeof payload['pid'] === 'number' ? payload['pid'] : null;
    if (pid !== null && pid > 0 && isPidAlive(pid)) {
        throw new Error(
            `import: a live Claudia backend (pid ${pid}) holds ${dataDir}. ` +
                `Stop it before importing — writing state under a running backend would be ` +
                `overwritten by its next save, and would corrupt any task it is currently running.`
        );
    }
}

/**
 * Refuse to overwrite a working install.
 *
 * `tasks.json` is the marker because it is the file whose loss actually hurts:
 * a data directory holding one has real task history, and an import is a
 * restore rather than a merge — there is no defined way to reconcile two task
 * lists, so the safe move is to make the operator say so explicitly.
 */
function assertTargetEmpty(dataDir: string, force: boolean): void {
    const tasksPath = join(dataDir, 'tasks.json');
    if (!existsSync(tasksPath) || force) return;
    throw new Error(
        `import: ${tasksPath} already exists. Importing would replace this install's tasks, ` +
            `workspaces and checkpoints. Move the directory aside, point CLAUDIA_DATA_DIR ` +
            `somewhere new, or pass --force if you really mean to overwrite it.`
    );
}

/** Read and validate the export's manifest. Throws loudly on anything unknown. */
function readManifest(exportDir: string): ExportManifest {
    const manifestPath = join(exportDir, 'manifest.json');
    if (!existsSync(manifestPath)) {
        throw new Error(`import: ${manifestPath} not found — ${exportDir} is not a Claudia export`);
    }

    let manifest: ExportManifest;
    try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ExportManifest;
    } catch (error) {
        throw new Error(`import: ${manifestPath} is not valid JSON: ${(error as Error).message}`);
    }

    const version = (manifest as { formatVersion?: unknown })?.formatVersion;
    if (typeof version !== 'number') {
        throw new Error(`import: ${manifestPath} has no formatVersion — refusing to guess at its layout`);
    }
    if (version !== SUPPORTED_FORMAT_VERSION) {
        // Deliberately fatal in BOTH directions. A newer export may carry files
        // this build would drop on write-back, which is data loss disguised as
        // a successful import.
        throw new Error(
            `import: unsupported formatVersion ${version} (this build understands ` +
                `${SUPPORTED_FORMAT_VERSION}). Import with a Claudia build matching the export.`
        );
    }
    return manifest;
}

// ---------------------------------------------------------------------------
// Agent session placement
// ---------------------------------------------------------------------------

/**
 * Directory Claude Code reads session transcripts from for a workspace:
 * `~/.claude/projects/<mangled-absolute-path>/`.
 *
 * The mangle is lossy and one-way (`token-parser.ts` ~L17-24 has the original),
 * which is exactly why the export files transcripts under a reversible
 * `encodeURIComponent` segment instead and this function is only ever used on
 * the OUTPUT side — to compute the folder name for the NEW path.
 *
 * This is the module's single point of contact with that convention.
 * TODO(#255): replace with CodeBackend.sessionFiles() once merged.
 */
function claudeSessionDirFor(workspacePath: string, homeDirectory: string): string {
    const folderName = workspacePath.replace(/[^a-zA-Z0-9-]/g, '-');
    return join(homeDirectory, '.claude', 'projects', folderName);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** Read an export's state file, accepting both enveloped and legacy shapes. */
function readExportedState(path: string): { data: Json; schemaVersion: number | null } | null {
    if (!existsSync(path)) return null;
    let raw: Json;
    try {
        raw = JSON.parse(readFileSync(path, 'utf-8'));
    } catch (error) {
        console.warn(`[Import] ${path} is not valid JSON:`, error);
        return null;
    }
    if (isPlainObject(raw) && typeof raw['schemaVersion'] === 'number' && 'data' in raw) {
        return { data: raw['data'], schemaVersion: raw['schemaVersion'] as number };
    }
    return { data: raw, schemaVersion: null };
}

/**
 * Restore a portable export into a data directory, remapping host paths.
 *
 * @param exportDir Directory produced by `exportState`.
 * @param dataDir   Target data directory, or `undefined` for the legacy location.
 * @param opts      Mappings and mode.
 * @param deps      Injectable environment. Tests only.
 */
export async function importState(
    exportDir: string,
    dataDir: string | undefined,
    opts: ImportOptions = {},
    deps: ImportDeps = {}
): Promise<ImportReport> {
    const source = resolve(exportDir?.trim() || '');
    if (!source) throw new Error('import: an export directory is required');
    const target = dataDir ?? LEGACY_DATA_DIR;
    const dryRun = opts.dryRun === true;
    const homeDirectory = deps.homeDir ?? homedir();
    const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;

    const warnings: string[] = [];
    const skipped: string[] = [];
    const filesWritten: string[] = [];

    // Writing into the directory being read is the same foot-gun the export
    // guards against, in reverse: the import would rewrite its own input.
    if (isPathInside(source, resolve(target))) {
        throw new Error(`import: refusing to write into the export directory itself (${source})`);
    }

    // --- 1. refuse before touching anything -------------------------------
    assertNoLiveInstance(target, isPidAlive);
    if (!dryRun) assertTargetEmpty(target, opts.force === true);

    // A target that was itself handed off is frozen. Importing into it is a
    // legitimate way to un-freeze it (the work is coming back), so this warns
    // rather than refuses — but silence would leave the operator wondering why
    // tasks refuse to start afterwards.
    const targetMark = readHandoffMark(target);
    if (targetMark) {
        warnings.push(
            `target ${target} is marked handed-off (at ${targetMark.handedOffAt}); ` +
                `run --reclaim after the import to let it run tasks again`
        );
    }

    // --- 2. manifest -------------------------------------------------------
    const manifest = readManifest(source);
    console.log(
        `[Import] ${source} → ${target}${dryRun ? ' (DRY RUN)' : ''}: ` +
            `format v${manifest.formatVersion}, from ${manifest.source.hostname} ` +
            `(${manifest.source.platform}), ${manifest.workspaces.length} workspace(s)`
    );

    // --- 3. remap table ----------------------------------------------------
    // The implicit home-directory rule goes in FIRST so an explicit --map of
    // the same prefix overrides it, and longest-prefix sorting then means a
    // more specific explicit rule wins regardless of what the user typed first.
    const pairs: Array<[string, string]> = [];
    if (manifest.source.homeDir && normalize(manifest.source.homeDir) !== normalize(homeDirectory)) {
        pairs.push([manifest.source.homeDir, homeDirectory]);
    }
    for (const [from, to] of opts.map ?? []) {
        if (!from || !to) {
            warnings.push(`ignored an incomplete mapping (${from || '<empty>'} → ${to || '<empty>'})`);
            continue;
        }
        pairs.push([from, to]);
    }
    const remap = new PathRemapper(pairs);
    console.log(`[Import] remap table (${remap.rules.length} rule(s), longest prefix first):`);
    for (const [from, to] of remap.rules) console.log(`[Import]   ${from}  →  ${to}`);
    if (remap.rules.length === 0) {
        console.log('[Import]   (none — paths are carried across verbatim)');
    }

    // --- 4. state files ----------------------------------------------------
    const stateDir = join(source, 'state');
    const pendingWrites: Array<{ name: string; data: Json; schemaVersion: number | null }> = [];

    if (!existsSync(stateDir)) {
        warnings.push(`${stateDir} is missing — the export carries no state files`);
    } else {
        for (const entry of readdirSync(stateDir, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
            const parsed = readExportedState(join(stateDir, entry.name));
            if (!parsed) {
                skipped.push(`${entry.name} (unreadable in the export)`);
                continue;
            }
            REMAPPERS[entry.name]?.(parsed.data, remap);
            pendingWrites.push({ name: entry.name, data: parsed.data, schemaVersion: parsed.schemaVersion });
        }
    }

    // --- 5. workspaces: what exists here? ----------------------------------
    const workspaceRows: ImportReport['workspaces'] = [];
    for (const ws of manifest.workspaces) {
        const newId = remap.apply(ws.id);
        const exists = existsSync(newId);
        workspaceRows.push({ id: ws.id, newId, exists });
        if (!exists) {
            // Imported anyway, never dropped. A workspace whose directory is
            // not here yet is a directory the user has not cloned yet — losing
            // its tasks and checkpoints because the clone came second would be
            // a far worse outcome than an entry that reads "unavailable".
            warnings.push(
                `workspace "${ws.name}" → ${newId} does not exist on this machine; ` +
                    `imported anyway (clone or mount it, then restart)`
            );
        }
    }

    for (const unmatched of remap.unmatchedPaths()) {
        warnings.push(`no mapping covered ${unmatched}; left unchanged`);
    }

    // --- 6. dry run stops here --------------------------------------------
    if (dryRun) {
        console.log(`[Import] DRY RUN — nothing written. Would write ${pendingWrites.length} state file(s):`);
        for (const w of pendingWrites) console.log(`[Import]   ${w.name}`);
        const unavailable = workspaceRows.filter((w) => !w.exists);
        console.log(`[Import] would-be-unavailable workspaces (${unavailable.length}):`);
        for (const w of unavailable) console.log(`[Import]   ${w.newId}`);
        return {
            remapTable: remap.rules,
            workspaces: workspaceRows,
            filesWritten: [],
            sessionsPlaced: 0,
            skipped,
            warnings,
            dryRun: true,
        };
    }

    // --- 7. write state, migrating to this build's schema ------------------
    mkdirSync(target, { recursive: true });
    for (const write of pendingWrites) {
        const dest = join(target, write.name);
        const targetVersion = TARGET_SCHEMA_VERSIONS[write.name];

        if (targetVersion === undefined) {
            // No envelope is defined for this file in this build. Write the
            // payload back in the shape the export carried it — inventing a
            // version here would make the file unreadable to its own store.
            const body = write.schemaVersion === null
                ? write.data
                : { schemaVersion: write.schemaVersion, data: write.data };
            writeFileSync(dest, JSON.stringify(body, null, 2), 'utf-8');
            console.log(`[Import] wrote ${write.name} (unversioned in this build)`);
        } else {
            // Land the file in the export's own envelope first, then let
            // loadVersioned run the target build's migration chain over it and
            // persist the result. Reusing the store's own migration path is the
            // point: a second copy of those migrations here would drift.
            saveVersioned(dest, write.data, write.schemaVersion ?? 0);
            const migrated = loadVersioned<Json>(dest, {
                currentVersion: targetVersion,
                defaultData: write.data,
                legacyLoader: (raw) => raw,
            });
            saveVersioned(dest, migrated, targetVersion);
            console.log(
                `[Import] wrote ${write.name} (v${write.schemaVersion ?? 0} → v${targetVersion})`
            );
        }
        filesWritten.push(write.name);
    }

    // --- 8. agent sessions -------------------------------------------------
    // Filed under the NEW mangled folder name, which is the whole point: the
    // runtime looks up transcripts by the mangled path it is running in, so a
    // transcript left under the source machine's name is invisible to --resume.
    let sessionsPlaced = 0;
    const sessionsRoot = join(source, 'agent-sessions');
    if (existsSync(sessionsRoot)) {
        for (const backendEntry of readdirSync(sessionsRoot, { withFileTypes: true })) {
            if (!backendEntry.isDirectory()) continue;
            const backendDir = join(sessionsRoot, backendEntry.name);
            for (const wsEntry of readdirSync(backendDir, { withFileTypes: true })) {
                if (!wsEntry.isDirectory()) continue;

                // The export encodes the workspace id with encodeURIComponent
                // precisely so it round-trips; the Claude mangle does not.
                let oldWorkspaceId: string;
                try {
                    oldWorkspaceId = decodeURIComponent(wsEntry.name);
                } catch {
                    skipped.push(`agent-sessions/${backendEntry.name}/${wsEntry.name} (undecodable segment)`);
                    continue;
                }
                const newWorkspaceId = remap.apply(oldWorkspaceId);
                const destDir = claudeSessionDirFor(newWorkspaceId, homeDirectory);

                const srcDir = join(backendDir, wsEntry.name);
                for (const file of readdirSync(srcDir, { withFileTypes: true })) {
                    if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
                    const dest = join(destDir, file.name);
                    // Session ids come from persisted state; treat them as
                    // untrusted path input rather than assuming a uuid.
                    if (!isPathInside(destDir, dest) || resolve(dest) === resolve(destDir)) {
                        skipped.push(`session ${file.name} (suspicious name)`);
                        continue;
                    }
                    mkdirSync(dirname(dest), { recursive: true });
                    copyFileSync(join(srcDir, file.name), dest);
                    sessionsPlaced++;
                }
                if (existsSync(destDir)) {
                    console.log(`[Import] sessions for ${newWorkspaceId} → ${destDir}`);
                }
            }
        }
    }
    console.log(`[Import] placed ${sessionsPlaced} agent session transcript(s)`);

    // --- 9. handoff: restore the working trees -----------------------------
    let handoffResults: RestoreResult[] | undefined;
    if (opts.handoff) {
        const repos = (manifest as { handoff?: { repos?: HandoffRepo[] } }).handoff?.repos ?? [];
        if (repos.length === 0) {
            warnings.push('--handoff was requested but this export carries no captured working trees');
        }
        handoffResults = [];
        for (const repo of repos) {
            const newPath = remap.apply(repo.workspaceId);
            const result = await restoreWorkingTree(newPath, repo, source);
            // Report against the path we actually acted on, not the source's.
            handoffResults.push({ ...result, workspaceId: newPath });
            if (result.skipped) skipped.push(`handoff ${newPath}: ${result.skipped}`);
            warnings.push(...result.warnings);
        }
        const restored = handoffResults.filter((r) => r.restored).length;
        console.log(`[Import] handoff: restored ${restored}/${repos.length} working tree(s)`);
    }

    console.log(
        `[Import] complete: ${filesWritten.length} state file(s), ` +
            `${workspaceRows.length} workspace(s) (${workspaceRows.filter((w) => !w.exists).length} unavailable), ` +
            `${sessionsPlaced} session(s), ${warnings.length} warning(s)`
    );
    for (const w of warnings) console.warn(`[Import] warning: ${w}`);

    return {
        remapTable: remap.rules,
        workspaces: workspaceRows,
        filesWritten,
        sessionsPlaced,
        skipped,
        warnings,
        handoff: handoffResults,
        dryRun: false,
    };
}
