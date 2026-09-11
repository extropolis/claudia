/**
 * Handoff primitives — P0 task 11, spec §11.3.
 *
 * ## The user story
 *
 * Work is running on a Sprite, the budget runs out, and it has to continue on
 * a laptop — and, later that evening, back the other way. §11.3 asks for the
 * cheapest possible version of that: transfer as little as we can get away
 * with, and recreate the processes on the target through the resume path that
 * already exists, rather than inventing a second one.
 *
 * So a handoff carries three things and nothing else:
 *
 *   1. **State** — the ordinary export (§11.1). Workspaces, tasks, checkpoints.
 *   2. **Working trees** — as git commits on a throwaway branch, pushed to the
 *      remote both hosts can already reach. Not as a tarball: the repo is
 *      already on the target (or one `git clone` away), and only the delta —
 *      the dirty tree — is actually unique to the source machine.
 *   3. **Agent sessions** — the JSONL transcripts, so `claude --resume` on the
 *      target picks up the conversation rather than starting cold.
 *
 * ## The single-writer guard
 *
 * The dangerous failure is not a lost file, it is *two hosts resuming the same
 * agent session*. Both would append to the same session id, both would push to
 * the same branch, and the transcript would interleave two divergent futures.
 *
 * The guard is deliberately crude, because a crude guard that always holds
 * beats a clever one that sometimes does not: once a host has handed off, it
 * writes `handedOffAt` into its own `instance.json` and **refuses to start or
 * resume any task** until someone explicitly reclaims it. There is no
 * negotiation, no lease, no clock comparison — the source simply stops being a
 * writer, and stays stopped until a human says otherwise.
 *
 * `--reclaim` (test-cli, or `POST /api/handoff/reclaim`) clears the mark. It
 * exists for the case where the handoff was a mistake, or the target never came
 * up. It is a human decision on purpose: nothing here can tell "the target
 * never started" apart from "the target is running right now", and guessing
 * wrong re-creates exactly the double-writer this whole mechanism prevents.
 *
 * ## Documented limits
 *
 * - **A mid-tool-call turn loses that call.** The transcript resumes from the
 *   last completed turn, so an in-flight Edit or Bash is dropped and the agent
 *   re-reasons from before it. This is not new behaviour: it is precisely what
 *   Ctrl-C followed by a resume does today.
 * - **Only runtimes with a resume primitive can be handed off.** Claude Code
 *   has `--resume <sessionId>`; a backend without an equivalent is out of
 *   scope here — its tasks arrive on the target as interrupted and start over.
 * - **Dependencies are not transferred.** `node_modules`, virtualenvs, build
 *   caches and `.git` objects that were never pushed all stay behind, so the
 *   first run on the target is slow and may need an install step. Shipping
 *   them would defeat the "transfer as little as possible" goal that makes a
 *   handoff take seconds instead of an hour.
 * - **Staged-vs-unstaged is flattened.** The tree is restored with its content
 *   intact but every change unstaged; git's index state is not carried across.
 */

import { existsSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { join, isAbsolute } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';

import { atomicWriteFileSync } from '../utils/atomic-write.js';

const execFileAsync = promisify(execFile);

/** Name of the machine-local file carrying the handoff mark. */
export const INSTANCE_FILE = 'instance.json';

/** Prefix for the throwaway branches a handoff pushes. */
export const HANDOFF_BRANCH_PREFIX = 'claudia/handoff/';

/**
 * The handoff mark, as stored inside `instance.json`.
 *
 * `instance.json` is owned by the single-instance lock (PR #259) and may not
 * exist at all on an older install, so everything here reads and writes it
 * defensively: unknown keys are preserved, a missing file is created, and an
 * unparseable one is replaced rather than throwing.
 */
export interface HandoffMark {
    /** ISO timestamp the handoff was taken. Presence == this host is frozen. */
    handedOffAt: string;
    /** Id of the export the handoff produced, for tracing which one won. */
    exportId: string;
    /** Where the export was written, purely as a breadcrumb for the operator. */
    exportDir?: string;
}

interface InstanceFile {
    handedOffAt?: string;
    handoffExportId?: string;
    handoffExportDir?: string;
    [key: string]: unknown;
}

function instancePath(dataDir: string): string {
    return join(dataDir, INSTANCE_FILE);
}

/**
 * Read `instance.json`, tolerating absence, corruption and the versioned
 * envelope that the lock may or may not use depending on which PRs have landed.
 *
 * Returns the payload object plus a flag saying whether it was enveloped, so a
 * later write can put it back the way it found it rather than silently
 * converting a lock file from one shape to the other under the lock's feet.
 */
function readInstanceFile(dataDir: string): { payload: InstanceFile; enveloped: boolean; schemaVersion: number } {
    const path = instancePath(dataDir);
    if (!existsSync(path)) return { payload: {}, enveloped: false, schemaVersion: 1 };
    try {
        const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
        if (raw && typeof raw === 'object' && typeof raw['schemaVersion'] === 'number' && 'data' in raw) {
            const data = raw['data'];
            return {
                payload: (data && typeof data === 'object' ? data : {}) as InstanceFile,
                enveloped: true,
                schemaVersion: raw['schemaVersion'] as number,
            };
        }
        return { payload: (raw ?? {}) as InstanceFile, enveloped: false, schemaVersion: 1 };
    } catch (error) {
        console.warn(`[Handoff] ${path} is unreadable, treating as empty:`, error);
        return { payload: {}, enveloped: false, schemaVersion: 1 };
    }
}

function writeInstanceFile(dataDir: string, payload: InstanceFile, enveloped: boolean, schemaVersion: number): void {
    mkdirSync(dataDir, { recursive: true });
    const body = enveloped ? { schemaVersion, data: payload } : payload;
    atomicWriteFileSync(instancePath(dataDir), JSON.stringify(body, null, 2));
}

/**
 * Read the handoff mark for a data directory, or `null` if this host is free
 * to run tasks.
 */
export function readHandoffMark(dataDir: string): HandoffMark | null {
    const { payload } = readInstanceFile(dataDir);
    if (typeof payload.handedOffAt !== 'string' || payload.handedOffAt === '') return null;
    return {
        handedOffAt: payload.handedOffAt,
        exportId: typeof payload.handoffExportId === 'string' ? payload.handoffExportId : '',
        exportDir: typeof payload.handoffExportDir === 'string' ? payload.handoffExportDir : undefined,
    };
}

/** Freeze this host: record that its work has been handed off elsewhere. */
export function writeHandoffMark(dataDir: string, mark: HandoffMark): void {
    const { payload, enveloped, schemaVersion } = readInstanceFile(dataDir);
    payload.handedOffAt = mark.handedOffAt;
    payload.handoffExportId = mark.exportId;
    if (mark.exportDir) payload.handoffExportDir = mark.exportDir;
    writeInstanceFile(dataDir, payload, enveloped, schemaVersion);
    console.log(`[Handoff] marked ${dataDir} as handed off at ${mark.handedOffAt} (export ${mark.exportId})`);
}

/**
 * Un-freeze this host. Returns whether a mark was actually present, so a
 * caller can tell "reclaimed" from "there was nothing to reclaim" instead of
 * reporting success either way.
 */
export function clearHandoffMark(dataDir: string): boolean {
    const { payload, enveloped, schemaVersion } = readInstanceFile(dataDir);
    const had = typeof payload.handedOffAt === 'string' && payload.handedOffAt !== '';
    delete payload.handedOffAt;
    delete payload.handoffExportId;
    delete payload.handoffExportDir;
    // Written even when there was no mark: an absent instance.json is created
    // empty, which is harmless, and the alternative is a silent no-op that
    // leaves the operator unsure whether the reclaim landed.
    writeInstanceFile(dataDir, payload, enveloped, schemaVersion);
    console.log(`[Handoff] reclaim on ${dataDir}: ${had ? 'mark cleared' : 'no mark was set'}`);
    return had;
}

// ---------------------------------------------------------------------------
// Git plumbing
//
// Every command below is plumbing (`commit-tree`, `write-tree`, `read-tree`,
// `update-ref`) rather than porcelain, for one reason: a handoff must not
// disturb the checkout it is capturing. The user may be mid-rebase, mid-merge,
// or simply looking at a branch they care about; `git checkout -b` and
// `git stash` both move HEAD or the index and are therefore off the table.
// `GIT_INDEX_FILE` gives us a scratch index to stage into, and `commit-tree`
// writes an object without touching any ref at all.
// ---------------------------------------------------------------------------

/**
 * Environment for git calls.
 *
 * The user's real environment is passed through deliberately, unlike in the
 * test helpers which blank `GIT_CONFIG_GLOBAL`. A handoff pushes to the user's
 * own remote, so it needs their credential helper, their SSH agent and their
 * `url.*.insteadOf` rewrites. Stripping their config here would turn every
 * private-repo handoff into an authentication failure.
 */
function gitEnv(): NodeJS.ProcessEnv {
    return { ...process.env };
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
        cwd,
        env: env ?? gitEnv(),
        maxBuffer: 32 * 1024 * 1024,
    });
    return stdout.trim();
}

/** Run a git command, returning `null` instead of throwing on failure. */
async function gitOrNull(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
    try {
        return await git(cwd, args, env);
    } catch {
        return null;
    }
}

/** True if `dir` is the top level of (or inside) a git working tree. */
export async function isGitWorkTree(dir: string): Promise<boolean> {
    if (!existsSync(dir)) return false;
    return (await gitOrNull(dir, ['rev-parse', '--is-inside-work-tree'])) === 'true';
}

/**
 * Branch name for a workspace's handoff.
 *
 * A slug alone is not enough: `/a/b/project` and `/c/d/project` slugify to the
 * same thing and would then fight over one branch. The 8-char digest of the
 * full path is what actually makes the name unique; the slug is there so a
 * human scanning `git branch -r` can tell which repo a ref belongs to.
 *
 * Only `[a-z0-9-]` survives into the slug, which sidesteps every git ref-name
 * rule at once (no `..`, no `~^:?*[`, no trailing `.lock`, no leading dash).
 */
export function handoffBranchFor(workspacePath: string): string {
    const slug =
        workspacePath
            .replace(/[^a-zA-Z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .toLowerCase()
            .slice(-40)
            .replace(/^-+/, '') || 'workspace';
    const digest = createHash('sha1').update(workspacePath).digest('hex').slice(0, 8);
    return `${HANDOFF_BRANCH_PREFIX}${slug}-${digest}`;
}

/** What a handoff recorded for one workspace. Serialized into the manifest. */
export interface HandoffRepo {
    /** Workspace id (its absolute path on the source machine). */
    workspaceId: string;
    /** Throwaway branch holding the WIP commit. */
    branch: string;
    /** The WIP commit sha. */
    commit: string;
    /** Commit the WIP was built on — where the user's branch actually sits. */
    parent: string;
    /** Branch the user had checked out, restored onto verbatim. */
    sourceBranch: string | null;
    /** Remote the branch was pushed to, or `null` when bundled instead. */
    remote: string | null;
    /** Bundle path relative to the export root, when there was no remote. */
    bundle?: string;
    /** True when the working tree had nothing uncommitted to carry. */
    clean: boolean;
}

/**
 * Capture a working tree as a commit on a throwaway branch, without touching
 * the user's checkout.
 *
 * Returns `null` when `dir` is not a git work tree. A clean tree still gets a
 * ref (pointing at HEAD, `clean: true`) so the target has something to fetch
 * and can verify it is on the same commit — the alternative, silently skipping
 * clean repos, hides the far more interesting failure where the target is on a
 * completely different branch.
 */
export async function captureWorkingTree(dir: string): Promise<HandoffRepo | null> {
    if (!(await isGitWorkTree(dir))) return null;

    const head = await gitOrNull(dir, ['rev-parse', 'HEAD']);
    if (!head) {
        console.warn(`[Handoff] ${dir} has no commits yet; nothing to capture`);
        return null;
    }
    const sourceBranch = await gitOrNull(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = handoffBranchFor(dir);

    // Stage into a scratch index so the user's `.git/index` is untouched. The
    // file must not exist yet — git populates it from read-tree.
    // `rev-parse --git-dir` answers relatively (`.git`) from the work-tree root
    // and absolutely from elsewhere, so resolve it rather than assuming either.
    // isAbsolute(), not a leading-slash test: `C:\repo\.git` is absolute too.
    const gitDirRaw = await git(dir, ['rev-parse', '--git-dir']);
    const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : join(dir, gitDirRaw);
    const scratchIndex = join(gitDir, `claudia-handoff-index-${process.pid}`);
    const env = { ...gitEnv(), GIT_INDEX_FILE: scratchIndex };

    let commit = head;
    let clean = true;
    try {
        await git(dir, ['read-tree', 'HEAD'], env);
        // `-A` picks up modifications, deletions and untracked files, while
        // still honouring .gitignore — which is what keeps node_modules out of
        // a handoff. The `-- .` pathspec scopes it to the workspace directory:
        // when a workspace is a SUBDIRECTORY of a larger repo, only that
        // subtree is captured and the rest of the index stays at HEAD, which is
        // the correct reading of "this workspace's working tree".
        await git(dir, ['add', '-A', '--', '.'], env);
        const tree = await git(dir, ['write-tree'], env);
        const headTree = await git(dir, ['rev-parse', 'HEAD^{tree}']);
        if (tree !== headTree) {
            clean = false;
            commit = await git(dir, [
                'commit-tree',
                tree,
                '-p',
                head,
                '-m',
                `claudia handoff WIP (${sourceBranch ?? 'detached'})`,
            ]);
        }
    } finally {
        try {
            if (existsSync(scratchIndex)) rmSync(scratchIndex, { force: true });
        } catch {
            /* a leftover scratch index is inert; it is not in .git/index */
        }
    }

    // update-ref, not `branch -f`: it is the same operation with none of
    // porcelain's opinions about checked-out branches.
    await git(dir, ['update-ref', `refs/heads/${branch}`, commit]);

    const remote = (await gitOrNull(dir, ['remote'])) || '';
    const firstRemote = remote.split('\n').map((r) => r.trim()).filter(Boolean)[0] ?? null;

    console.log(
        `[Handoff] captured ${dir}: ${clean ? 'clean tree' : 'WIP commit'} ${commit.slice(0, 8)} ` +
            `on ${branch} (parent ${head.slice(0, 8)}, branch ${sourceBranch ?? 'detached'})`
    );

    return { workspaceId: dir, branch, commit, parent: head, sourceBranch, remote: firstRemote, clean };
}

/** Push a captured handoff branch. Throws with the git error on failure. */
export async function pushHandoffBranch(dir: string, repo: HandoffRepo): Promise<void> {
    if (!repo.remote) throw new Error(`no remote configured for ${dir}`);
    // --force because the branch is throwaway and a previous handoff from this
    // same machine will legitimately be sitting on it.
    await git(dir, ['push', '--force', repo.remote, `${repo.commit}:refs/heads/${repo.branch}`]);
    console.log(`[Handoff] pushed ${repo.branch} → ${repo.remote}`);
}

/**
 * Write a `git bundle` for a repo that has no remote.
 *
 * A bundle is a single file holding the objects the target lacks, so it
 * restores the same content the push would have. It is the fallback, not the
 * default, because it re-introduces exactly the "carry a big opaque file
 * around" problem that pushing to a shared remote avoids.
 */
export async function bundleHandoff(dir: string, repo: HandoffRepo, bundlePath: string): Promise<void> {
    mkdirSync(join(bundlePath, '..'), { recursive: true });
    await git(dir, ['bundle', 'create', bundlePath, repo.branch]);
    console.log(`[Handoff] bundled ${repo.branch} → ${bundlePath}`);
}

/** Outcome of restoring one repo on the target. */
export interface RestoreResult {
    workspaceId: string;
    branch: string;
    /** Whether the working tree was actually modified. */
    restored: boolean;
    /** Human-readable reason when `restored` is false. */
    skipped?: string;
    warnings: string[];
}

/**
 * True if the work tree has anything uncommitted (tracked or untracked).
 * `--porcelain` output is empty exactly when the tree is clean.
 */
async function isDirty(dir: string): Promise<boolean> {
    const status = await gitOrNull(dir, ['status', '--porcelain']);
    return status !== null && status !== '';
}

/**
 * Restore a captured working tree on the target machine.
 *
 * The result the user wants is: same files as the source had, same branch they
 * were on, and the changes still *uncommitted* — because they were uncommitted
 * before, and a handoff that silently commits someone's work-in-progress has
 * changed the meaning of their repo.
 *
 * The mechanism is `read-tree -u --reset` to the WIP tree followed by a mixed
 * `reset` back to HEAD. §11.3 sketches this as "check out the WIP commit then
 * `git reset --soft` to its parent", which reaches the same place; the plumbing
 * version is used instead because it never moves a ref. Moving the user's
 * branch to the WIP commit — even for the instant before resetting it back —
 * is a window in which an interrupted import leaves their branch pointing at a
 * commit they never made.
 *
 * Refuses outright if the target tree is already dirty. Overwriting local work
 * with imported work is not a tradeoff worth making automatically.
 */
export async function restoreWorkingTree(
    dir: string,
    repo: HandoffRepo,
    exportDir: string
): Promise<RestoreResult> {
    const warnings: string[] = [];
    const base: RestoreResult = { workspaceId: repo.workspaceId, branch: repo.branch, restored: false, warnings };

    if (!(await isGitWorkTree(dir))) {
        return { ...base, skipped: `${dir} is not a git work tree on this machine` };
    }
    if (await isDirty(dir)) {
        return {
            ...base,
            skipped: `${dir} has uncommitted changes; refusing to overwrite them. Commit or stash, then re-run the import.`,
        };
    }

    // --- get the objects -------------------------------------------------
    // Prefer the remote both hosts share; fall back to the bundle the export
    // wrote for a remote-less repo.
    let fetched = false;
    const remotes = ((await gitOrNull(dir, ['remote'])) || '').split('\n').map((r) => r.trim()).filter(Boolean);
    const remote = repo.remote && remotes.includes(repo.remote) ? repo.remote : remotes[0] ?? null;
    if (remote) {
        const out = await gitOrNull(dir, ['fetch', remote, `+refs/heads/${repo.branch}:refs/heads/${repo.branch}`]);
        fetched = out !== null;
        if (!fetched) warnings.push(`git fetch of ${repo.branch} from ${remote} failed in ${dir}`);
    }
    if (!fetched && repo.bundle) {
        const bundlePath = join(exportDir, repo.bundle);
        if (existsSync(bundlePath)) {
            const out = await gitOrNull(dir, ['fetch', bundlePath, `+refs/heads/${repo.branch}:refs/heads/${repo.branch}`]);
            fetched = out !== null;
            if (!fetched) warnings.push(`git fetch from bundle ${bundlePath} failed in ${dir}`);
        } else {
            warnings.push(`bundle ${repo.bundle} named in the manifest is missing from the export`);
        }
    }

    // The commit may already be present — a re-run of the same import, or a
    // repo the user fetched by hand. Having it locally is what matters, not
    // where it came from.
    const haveCommit = (await gitOrNull(dir, ['cat-file', '-e', `${repo.commit}^{commit}`])) !== null;
    if (!haveCommit) {
        return {
            ...base,
            skipped: `WIP commit ${repo.commit.slice(0, 8)} is not reachable in ${dir} (no remote copy and no bundle)`,
        };
    }

    if (repo.clean) {
        console.log(`[Handoff] ${dir}: source tree was clean, nothing to restore`);
        return { ...base, skipped: 'source working tree was clean' };
    }

    // --- sanity: are we on the same base commit? --------------------------
    const head = await gitOrNull(dir, ['rev-parse', 'HEAD']);
    if (head !== repo.parent) {
        warnings.push(
            `${dir} is at ${head?.slice(0, 8) ?? 'unknown'} but the handoff was taken from ${repo.parent.slice(0, 8)}; ` +
                `restored changes will be diffed against a different base`
        );
    }
    const currentBranch = await gitOrNull(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (repo.sourceBranch && currentBranch && repo.sourceBranch !== currentBranch) {
        warnings.push(
            `${dir} is on branch ${currentBranch} but the handoff was taken on ${repo.sourceBranch}; ` +
                `the changes are being applied to ${currentBranch}`
        );
    }

    // --- restore ----------------------------------------------------------
    // 1. index + work tree := the WIP tree.
    await git(dir, ['read-tree', '-u', '--reset', `${repo.commit}^{tree}`]);
    // 2. index := HEAD, work tree untouched. Every carried change is now an
    //    ordinary uncommitted modification, exactly as it was on the source.
    //    Staged-vs-unstaged is deliberately flattened; see the module header.
    await git(dir, ['reset', '--mixed', 'HEAD']);

    console.log(`[Handoff] restored working tree in ${dir} from ${repo.commit.slice(0, 8)}`);
    return { ...base, restored: true };
}
