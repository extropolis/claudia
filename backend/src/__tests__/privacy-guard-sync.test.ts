/**
 * Keeps the two hand-maintained lists of per-user runtime files in sync:
 *
 *   1. the "Runtime data (persisted state)" block in `.gitignore`
 *   2. `FORBIDDEN_PATTERNS` in `.github/workflows/privacy-guard.yml`
 *
 * They drifted once already: `archived-tasks.json` (8 MB of task history),
 * `checkpoints.json`, `session-recovery.json`, `learnings.json` and
 * `todos.json` were all being written to `backend/` at runtime while being
 * absent from one or both lists. A stray `git add -A` would have committed
 * per-user terminal history to a public repo, and the Privacy Guard job that
 * exists to catch exactly that would have stayed green.
 *
 * The gitignore block is the source of truth; the workflow must cover it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const GITIGNORE = join(REPO_ROOT, '.gitignore');
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'privacy-guard.yml');

/** Entries under the "Runtime data (persisted state)" heading in .gitignore. */
function runtimeDataEntries(): string[] {
    const lines = readFileSync(GITIGNORE, 'utf-8').split('\n');
    const start = lines.findIndex((l) => l.startsWith('# Runtime data'));
    expect(start, 'the "# Runtime data" section disappeared from .gitignore').toBeGreaterThan(-1);

    const entries: string[] = [];
    for (const raw of lines.slice(start + 1)) {
        const line = raw.trim();
        if (line === '') break; // section ends at the first blank line
        if (line.startsWith('#')) continue;
        entries.push(line);
    }
    return entries;
}

/** Quoted patterns inside the workflow's FORBIDDEN_PATTERNS=( ... ) array. */
function forbiddenPatterns(): string[] {
    const yml = readFileSync(WORKFLOW, 'utf-8');
    const block = yml.match(/FORBIDDEN_PATTERNS=\(([\s\S]*?)\)/);
    expect(block, 'FORBIDDEN_PATTERNS array not found in privacy-guard.yml').not.toBeNull();
    return [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('privacy guard / .gitignore sync', () => {
    it('every runtime-data path in .gitignore is covered by the Privacy Guard workflow', () => {
        const guarded = new Set(forbiddenPatterns());

        // `.bak` and `.{pid}.tmp` siblings are transient artifacts of
        // atomic-write; guarding the base path is what matters, since
        // `git ls-files -- 'backend/foo.json'` is what the workflow runs.
        const meaningful = runtimeDataEntries().filter(
            (e) => !e.endsWith('.bak') && !e.endsWith('.tmp') && !e.includes('mcp-token'),
        );

        const missing = meaningful.filter((e) => !guarded.has(e));
        expect(
            missing,
            `these are gitignored as per-user runtime data but the Privacy Guard job would not ` +
                `catch them if they were force-added: ${missing.join(', ')}`,
        ).toEqual([]);
    });

    it('the Privacy Guard workflow does not guard paths that .gitignore forgot', () => {
        const ignored = new Set(runtimeDataEntries());
        const stale = forbiddenPatterns().filter((p) => !ignored.has(p));
        expect(
            stale,
            `these are guarded by CI but absent from .gitignore's runtime-data block, so they ` +
                `are one 'git add' away from being committed locally: ${stale.join(', ')}`,
        ).toEqual([]);
    });
});
