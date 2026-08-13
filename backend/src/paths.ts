/**
 * Data directory resolution.
 *
 * Every piece of mutable Claudia state — tasks, config, workspaces, learnings,
 * cron schedules, chat history, PTY histories — historically resolved to
 * `join(__dirname, '..')`, i.e. the `backend/` directory inside the source tree.
 *
 * That is fine when Claudia is started from a checkout on a developer's machine,
 * and fatal when it runs from a container image: state written inside the image
 * layer is destroyed on every image update. Making the location configurable is
 * the prerequisite for running the backend as a deployable service.
 *
 * Resolution order (first match wins):
 *   1. An explicit path — Electron passes `app.getPath('userData')`.
 *   2. `CLAUDIA_DATA_DIR` — containers, home server, Fly Sprite.
 *   3. Legacy: `backend/`, preserving existing single-user behavior byte-for-byte.
 *
 * The legacy fallback is deliberate. An existing install that sets nothing must
 * keep finding its data exactly where it left it; migration is opt-in by setting
 * the variable and moving the files.
 */

import { join, dirname, isAbsolute, resolve } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** `backend/` — where state lived before the data directory was configurable. */
export const LEGACY_DATA_DIR = join(__dirname, '..');

/** Environment variable naming the data directory. */
export const DATA_DIR_ENV = 'CLAUDIA_DATA_DIR';

/**
 * Resolve the directory holding all mutable state.
 *
 * Returns `undefined` when neither an explicit path nor the environment
 * variable is set, which callers pass straight through to stores that already
 * treat `undefined` as "use the legacy location". Keeping the tri-state means
 * this function can be dropped into existing `basePath?: string` call sites
 * without changing their semantics.
 *
 * @param explicit Caller-supplied path, e.g. Electron's userData directory.
 * @param env Environment to read from. Injectable for testing.
 */
export function resolveDataDir(
    explicit?: string,
    env: NodeJS.ProcessEnv = process.env
): string | undefined {
    const candidate = explicit ?? env[DATA_DIR_ENV];
    if (!candidate || candidate.trim() === '') return undefined;

    // Relative paths are resolved against cwd rather than the source tree —
    // a relative CLAUDIA_DATA_DIR should follow the operator's shell, not the
    // location Claudia happens to be installed in.
    return isAbsolute(candidate) ? candidate : resolve(candidate);
}

/**
 * Resolve the data directory and guarantee it exists.
 *
 * Use at startup, before any store is constructed. Stores create their own
 * directory lazily, but a container's mounted volume should be validated
 * eagerly so a bad mount fails loudly at boot rather than on first write.
 */
export function ensureDataDir(
    explicit?: string,
    env: NodeJS.ProcessEnv = process.env
): string | undefined {
    const dir = resolveDataDir(explicit, env);
    if (dir && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    return dir;
}

/**
 * Absolute path for a state file.
 *
 * @param dataDir Resolved data directory, or `undefined` for the legacy location.
 * @param filename File name, e.g. `tasks.json`.
 */
export function dataPath(dataDir: string | undefined, filename: string): string {
    return join(dataDir ?? LEGACY_DATA_DIR, filename);
}

/**
 * Directory holding per-task PTY history files.
 *
 * Kept as a sibling of `tasks.json` because `TaskSpawner.getHistoryDir()`
 * derives it from `dirname(persistencePath)` — this function exists so callers
 * that need the path without a spawner agree with that derivation.
 */
export function historyDirFor(dataDir: string | undefined): string {
    return join(dataDir ?? LEGACY_DATA_DIR, 'task-histories');
}

/**
 * Describe the resolved location for startup logging.
 *
 * Operators deploying a container need to see, in the first lines of output,
 * whether their volume mount actually took effect.
 */
export function describeDataDir(dataDir: string | undefined): string {
    return dataDir
        ? `data directory: ${dataDir}`
        : `data directory: ${LEGACY_DATA_DIR} (legacy — set ${DATA_DIR_ENV} to relocate)`;
}
