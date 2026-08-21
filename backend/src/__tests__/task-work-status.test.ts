/**
 * Landed vs outstanding work per task (getTaskWorkStatus).
 *
 * Drives real git repos in a temp dir: a task's worktree branch is committed,
 * merged, rebased and dirtied, and the verdict is checked at each step. The
 * point of the helper is that the sidebar can say "this task still holds work"
 * or "everything is on main, archive it" without the user opening a terminal.
 *
 * Temp dirs live under homedir(), not os.tmpdir() — macOS /var is blocklisted
 * by validateWorkspacePath, and the rest of the suite follows the same rule.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getTaskWorkStatus } from '../git-utils.js';

const execAsync = promisify(exec);

let repo: string;
let gitAvailable = true;

const git = (args: string, cwd = repo) => execAsync(`git ${args}`, { cwd });

async function commit(message: string, file = `f-${Math.random().toString(36).slice(2)}.txt`, cwd = repo) {
    writeFileSync(join(cwd, file), `${message}\n`);
    await git(`add ${file}`, cwd);
    await git(`commit -m "${message}"`, cwd);
}

beforeEach(async () => {
    try { await execAsync('git --version'); } catch { gitAvailable = false; return; }
    repo = join(homedir(), `.claudia-workstatus-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(repo, { recursive: true });
    await git('init -b main');
    await git('config user.email "t@t.com"');
    await git('config user.name "T"');
    await git('config commit.gpgsign false');
    await commit('init');
});

afterEach(() => {
    try { rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
});

describe('getTaskWorkStatus', () => {
    it('says nothing for a task sitting on the default branch', async () => {
        if (!gitAvailable) return;
        expect(await getTaskWorkStatus(repo)).toBeNull();
    });

    it('says nothing for a branch that made no commits and edited nothing', async () => {
        if (!gitAvailable) return;
        await git('checkout -b feature/quiet');
        // A task that only answered a question must not grow a git badge.
        expect(await getTaskWorkStatus(repo)).toBeNull();
    });

    it('reports commits that never reached the default branch', async () => {
        if (!gitAvailable) return;
        await git('checkout -b feature/work');
        await commit('one');
        await commit('two');

        const status = await getTaskWorkStatus(repo);
        expect(status).not.toBeNull();
        expect(status!.branch).toBe('feature/work');
        expect(status!.outstandingCommits).toBe(2);
        expect(status!.landedCommits).toBe(0);
        expect(status!.dirtyFiles).toBe(0);
        expect(status!.baseRef).toBe('main');
    });

    it('reports uncommitted edits, including untracked files', async () => {
        if (!gitAvailable) return;
        await git('checkout -b feature/dirty');
        writeFileSync(join(repo, 'tracked-later.txt'), 'scratch');
        await commit('a commit so the branch exists');
        writeFileSync(join(repo, 'edited.txt'), 'new file');

        const status = await getTaskWorkStatus(repo);
        expect(status!.dirtyFiles).toBeGreaterThan(0);
        expect(status!.outstandingCommits).toBe(1);
    });

    it('flips to landed once the branch is merged into the default branch', async () => {
        if (!gitAvailable) return;
        await git('checkout -b feature/merged');
        await commit('the work');
        await git('checkout main');
        await git('merge --no-ff --no-edit feature/merged');
        await git('checkout feature/merged');

        const status = await getTaskWorkStatus(repo);
        expect(status).not.toBeNull();
        expect(status!.outstandingCommits).toBe(0);
        expect(status!.landedCommits).toBe(1);
        expect(status!.dirtyFiles).toBe(0);
    });

    it('still reads as landed after a rebase rewrote the shas', async () => {
        if (!gitAvailable) return;
        // sha-based counting (main..HEAD) calls this outstanding forever; patch
        // ids see that the same change is already on main.
        await git('checkout -b feature/rebased');
        await commit('the work', 'work.txt');
        await git('checkout main');
        await commit('unrelated main commit', 'other.txt');
        await git('cherry-pick feature/rebased');
        await git('checkout feature/rebased');

        const status = await getTaskWorkStatus(repo);
        expect(status!.outstandingCommits).toBe(0);
        expect(status!.landedCommits).toBe(1);
    });

    it('a merged branch with new edits is outstanding again', async () => {
        if (!gitAvailable) return;
        await git('checkout -b feature/more');
        await commit('landed work', 'landed.txt');
        await git('checkout main');
        await git('merge --no-ff --no-edit feature/more');
        await git('checkout feature/more');
        await commit('follow-up work', 'followup.txt');

        // `git cherry` cannot see the merged commit any more (it is reachable
        // from main), so only the follow-up counts — which is the verdict that
        // matters: this task still holds work.
        const status = await getTaskWorkStatus(repo);
        expect(status!.outstandingCommits).toBe(1);
        expect(status!.landedCommits).toBe(0);
    });

    it('prefers the pushed default branch as the base ref when one exists', async () => {
        if (!gitAvailable) return;
        // A bare "remote" so origin/main exists: "is it on main" has to mean the
        // main everyone else sees, not a local one that may be days behind.
        const remote = `${repo}-remote`;
        mkdirSync(remote, { recursive: true });
        try {
            await execAsync('git init --bare -b main', { cwd: remote });
            await git(`remote add origin "${remote}"`);
            await git('push -u origin main');
            await git('checkout -b feature/pushed');
            await commit('local only');

            const status = await getTaskWorkStatus(repo);
            expect(status!.baseRef).toBe('origin/main');
            expect(status!.outstandingCommits).toBe(1);
        } finally {
            try { rmSync(remote, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
        }
    });

    it('returns null rather than throwing outside a git repo', async () => {
        if (!gitAvailable) return;
        const plain = join(homedir(), `.claudia-workstatus-plain-${Date.now()}`);
        mkdirSync(plain, { recursive: true });
        try {
            expect(await getTaskWorkStatus(plain)).toBeNull();
        } finally {
            try { rmSync(plain, { recursive: true, force: true }); } catch { /* best effort */ }
        }
    });
});
