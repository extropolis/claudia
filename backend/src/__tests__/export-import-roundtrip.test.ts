/**
 * Export → import round trip, and the handoff (P0 task 11, spec §11.2/§11.3).
 *
 * This is the headline test for the whole feature. The claim under test is the
 * one §11 actually makes — that a Claudia install can move to another machine
 * and keep working — and the only honest way to check it is to run the real
 * exporter, move the bytes, run the real importer against a DIFFERENT directory
 * layout, and then read the target's state back.
 *
 * NOTE ON TEMP DIRECTORIES: every fixture lives under `os.homedir()`, never
 * `os.tmpdir()`. On macOS `/tmp` resolves under `/var`, which
 * `validateWorkspacePath` blocklists as a system path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';

import { exportState } from '../export-import/export.js';
import { importState } from '../export-import/import.js';
import { readHandoffMark, clearHandoffMark, handoffBranchFor } from '../export-import/handoff.js';

/** Mangle a workspace path the way Claude Code names its projects folder. */
const mangle = (p: string) => p.replace(/[^a-zA-Z0-9-]/g, '-');

/**
 * Timeout for the tests that drive real git.
 *
 * `vitest.config.ts` sets a 10s default, which a clone + capture + push +
 * fetch + restore can exceed when the whole 77-file suite is running in
 * parallel — observed at 10.7s. The work is genuinely slow rather than hung,
 * so the right fix is headroom, not a faked-out git.
 */
const GIT_TEST_TIMEOUT_MS = 60_000;

const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    }).trim();

/** A real repo with one commit on `main`, wired to a bare remote. */
function makeRepo(dir: string, remote?: string): string {
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test User');
    git(dir, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'README.md'), '# base\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'init');
    if (remote) {
        git(dir, 'remote', 'add', 'origin', remote);
        git(dir, 'push', '-u', 'origin', 'main');
    }
    return dir;
}

function readState(dir: string, name: string): any {
    const raw = JSON.parse(readFileSync(join(dir, name), 'utf-8'));
    return raw && typeof raw === 'object' && 'schemaVersion' in raw && 'data' in raw ? raw.data : raw;
}

describe('export → import round trip', () => {
    let sandbox: string;
    let dataA: string;
    let dataB: string;
    let rootA: string;
    let rootB: string;
    let homeA: string;
    let homeB: string;
    let out: string;

    /** Seed data dir A with two workspaces under one root and three tasks. */
    function seedSourceInstall(): { wsAlpha: string; wsBeta: string } {
        const wsAlpha = join(rootA, 'alpha');
        const wsBeta = join(rootA, 'beta');
        mkdirSync(wsAlpha, { recursive: true });
        mkdirSync(wsBeta, { recursive: true });

        writeFileSync(
            join(dataA, 'workspace-config.json'),
            JSON.stringify({
                schemaVersion: 1,
                data: {
                    workspaces: [
                        { id: wsAlpha, name: 'alpha', createdAt: '2026-01-01T00:00:00.000Z' },
                        { id: wsBeta, name: 'beta', createdAt: '2026-01-01T00:00:00.000Z' },
                    ],
                    activeWorkspaceId: wsAlpha,
                    recentWorkspaces: [],
                    lastBrowsedPath: rootA,
                },
            }, null, 2),
            'utf-8'
        );

        writeFileSync(
            join(dataA, 'tasks.json'),
            JSON.stringify({
                tasks: [
                    { id: 't1', prompt: 'alpha one', workspaceId: wsAlpha, sessionId: 'sess-a1', lastState: 'idle', wasInterrupted: true },
                    { id: 't2', prompt: 'alpha two', workspaceId: wsAlpha, sessionId: 'sess-a2', lastState: 'idle', wasInterrupted: true },
                    { id: 't3', prompt: 'beta one', workspaceId: wsBeta, sessionId: 'sess-b1', lastState: 'idle', wasInterrupted: true },
                ],
                nextTaskNumber: 4,
            }, null, 2),
            'utf-8'
        );

        writeFileSync(
            join(dataA, 'checkpoints.json'),
            JSON.stringify({
                schemaVersion: 1,
                data: { checkpoints: [{ id: 'c1', taskId: 't1', workspaceId: wsAlpha, name: 'cp', timestamp: '2026-01-01T00:00:00.000Z' }] },
            }, null, 2),
            'utf-8'
        );

        // Transcripts, filed under the SOURCE machine's mangled folder names.
        for (const [ws, sids] of [[wsAlpha, ['sess-a1', 'sess-a2']], [wsBeta, ['sess-b1']]] as const) {
            const dir = join(homeA, '.claude', 'projects', mangle(ws));
            mkdirSync(dir, { recursive: true });
            for (const sid of sids) {
                writeFileSync(join(dir, `${sid}.jsonl`), `{"type":"user","sessionId":"${sid}"}\n`, 'utf-8');
            }
        }

        return { wsAlpha, wsBeta };
    }

    beforeEach(() => {
        sandbox = mkdtempSync(join(homedir(), '.claudia-roundtrip-test-'));
        dataA = join(sandbox, 'dataA');
        dataB = join(sandbox, 'dataB');
        rootA = join(sandbox, 'machineA', 'projects');
        rootB = join(sandbox, 'machineB', 'code');
        homeA = join(sandbox, 'homeA');
        homeB = join(sandbox, 'homeB');
        out = join(sandbox, 'export');
        for (const d of [dataA, dataB, rootA, rootB, homeA, homeB]) mkdirSync(d, { recursive: true });
        // The target layout exists on disk — this is the "I already cloned my
        // repos on the new machine" case.
        for (const name of ['alpha', 'beta']) mkdirSync(join(rootB, name), { recursive: true });
    });

    afterEach(() => {
        rmSync(sandbox, { recursive: true, force: true });
    });

    // -----------------------------------------------------------------------
    // The headline: a full move between two different directory layouts
    // -----------------------------------------------------------------------
    it('moves an install to a different layout: ids rewritten, tasks intact, transcripts refiled', async () => {
        const { wsAlpha, wsBeta } = seedSourceInstall();

        const manifest = await exportState(
            dataA,
            { out, withAgentSessions: true },
            { homeDir: homeA }
        );
        expect(manifest.formatVersion).toBe(1);
        expect(manifest.workspaces.map(w => w.id)).toEqual([wsAlpha, wsBeta]);

        const report = await importState(
            out,
            dataB,
            { map: [[rootA, rootB]] },
            { homeDir: homeB }
        );

        // 1. Every workspace id rewritten, and every one of them present here.
        expect(report.workspaces).toHaveLength(2);
        expect(report.workspaces.map(w => w.newId)).toEqual([join(rootB, 'alpha'), join(rootB, 'beta')]);
        expect(report.workspaces.every(w => w.exists)).toBe(true);
        expect(report.warnings.filter(w => w.includes('does not exist'))).toHaveLength(0);

        const ws = readState(dataB, 'workspace-config.json');
        expect(ws.workspaces.map((w: any) => w.id)).toEqual([join(rootB, 'alpha'), join(rootB, 'beta')]);
        expect(ws.activeWorkspaceId).toBe(join(rootB, 'alpha'));
        expect(ws.lastBrowsedPath).toBe(rootB);

        // 2. Tasks still reference their workspace — the join that a naive copy
        //    breaks, because workspace-store deletes the workspace and orphans
        //    every task pointing at it.
        const tasks = readState(dataB, 'tasks.json');
        expect(tasks.tasks).toHaveLength(3);
        expect(tasks.tasks.map((t: any) => t.workspaceId)).toEqual([
            join(rootB, 'alpha'),
            join(rootB, 'alpha'),
            join(rootB, 'beta'),
        ]);
        const workspaceIds = new Set(ws.workspaces.map((w: any) => w.id));
        for (const t of tasks.tasks) expect(workspaceIds.has(t.workspaceId)).toBe(true);
        expect(tasks.nextTaskNumber).toBe(4);

        // Checkpoints follow their workspace too.
        expect(readState(dataB, 'checkpoints.json').checkpoints[0].workspaceId).toBe(join(rootB, 'alpha'));

        // 3. Transcripts landed under the NEW mangled folder name, which is what
        //    makes `--resume` find them on this machine.
        expect(report.sessionsPlaced).toBe(3);
        const newAlphaDir = join(homeB, '.claude', 'projects', mangle(join(rootB, 'alpha')));
        const newBetaDir = join(homeB, '.claude', 'projects', mangle(join(rootB, 'beta')));
        expect(existsSync(join(newAlphaDir, 'sess-a1.jsonl'))).toBe(true);
        expect(existsSync(join(newAlphaDir, 'sess-a2.jsonl'))).toBe(true);
        expect(existsSync(join(newBetaDir, 'sess-b1.jsonl'))).toBe(true);
        expect(readFileSync(join(newBetaDir, 'sess-b1.jsonl'), 'utf-8')).toContain('sess-b1');

        // …and NOT under the source's folder name, which is exactly what a
        // plain `cp -r` of the data directory would have produced.
        expect(existsSync(join(homeB, '.claude', 'projects', mangle(join(rootA, 'alpha'))))).toBe(false);
    }, GIT_TEST_TIMEOUT_MS);

    it('carries tasks through even when the target layout is not on disk yet', async () => {
        seedSourceInstall();
        await exportState(dataA, { out, withAgentSessions: true }, { homeDir: homeA });

        const notCloned = join(sandbox, 'machineC', 'src');
        const report = await importState(out, dataB, { map: [[rootA, notCloned]] }, { homeDir: homeB });

        expect(report.workspaces.every(w => !w.exists)).toBe(true);
        expect(readState(dataB, 'workspace-config.json').workspaces).toHaveLength(2);
        expect(readState(dataB, 'tasks.json').tasks).toHaveLength(3);
    });

    it('preserves the schema envelope of every state file it round-trips', async () => {
        seedSourceInstall();
        await exportState(dataA, { out }, { homeDir: homeA });
        await importState(out, dataB, { map: [[rootA, rootB]] }, { homeDir: homeB });

        // Versioned files keep their envelope…
        const wsRaw = JSON.parse(readFileSync(join(dataB, 'workspace-config.json'), 'utf-8'));
        expect(wsRaw.schemaVersion).toBe(1);
        expect(wsRaw.data.workspaces).toBeDefined();

        // …and tasks.json, which has no envelope on this branch, must NOT gain
        // one, or TaskSpawner's reader would stop finding `tasks`.
        const tasksRaw = JSON.parse(readFileSync(join(dataB, 'tasks.json'), 'utf-8'));
        expect(tasksRaw.schemaVersion).toBeUndefined();
        expect(Array.isArray(tasksRaw.tasks)).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Handoff
    // -----------------------------------------------------------------------
    describe('handoff', () => {
        let bare: string;
        let repoA: string;
        let repoB: string;

        beforeEach(() => {
            bare = join(sandbox, 'remote.git');
            mkdirSync(bare, { recursive: true });
            git(bare, 'init', '--bare', '-b', 'main');

            // Source machine's checkout, and the target machine's clone of the
            // same repo — two real working trees sharing one remote.
            repoA = makeRepo(join(rootA, 'alpha'), bare);
            repoB = join(rootB, 'alpha');
            rmSync(repoB, { recursive: true, force: true });
            git(rootB, 'clone', bare, repoB);
            git(repoB, 'config', 'user.email', 'test@example.com');
            git(repoB, 'config', 'user.name', 'Test User');
            git(repoB, 'config', 'commit.gpgsign', 'false');

            writeFileSync(
                join(dataA, 'workspace-config.json'),
                JSON.stringify({
                    schemaVersion: 1,
                    data: { workspaces: [{ id: repoA, name: 'alpha' }], activeWorkspaceId: repoA, recentWorkspaces: [] },
                }, null, 2),
                'utf-8'
            );
            writeFileSync(
                join(dataA, 'tasks.json'),
                JSON.stringify({ tasks: [{ id: 't1', prompt: 'wip', workspaceId: repoA, sessionId: 'sess-1', lastState: 'idle' }] }, null, 2),
                'utf-8'
            );
            const sdir = join(homeA, '.claude', 'projects', mangle(repoA));
            mkdirSync(sdir, { recursive: true });
            writeFileSync(join(sdir, 'sess-1.jsonl'), '{"type":"user"}\n', 'utf-8');
        });

        it('pushes the WIP commit, leaves the source branch untouched, and restores the tree on the target', async () => {
            // Dirty the source tree: a modification, a new file, a deletion.
            writeFileSync(join(repoA, 'README.md'), '# base\nlocal edit\n');
            writeFileSync(join(repoA, 'new-file.txt'), 'brand new\n');
            rmSync(join(repoA, 'README.md.orig'), { force: true });
            writeFileSync(join(repoA, 'scratch.txt'), 'scratch\n');

            const headBefore = git(repoA, 'rev-parse', 'HEAD');
            const branchBefore = git(repoA, 'rev-parse', '--abbrev-ref', 'HEAD');
            const statusBefore = git(repoA, 'status', '--porcelain');

            let stopped = 0;
            const manifest = await exportState(
                dataA,
                { out, handoff: true },
                { homeDir: homeA, stopTasks: async () => { stopped++; } }
            );

            // --- the export side ------------------------------------------
            expect(stopped).toBe(1);
            expect(manifest.tiers.agentSessions).toBe(true); // forced on by handoff
            expect(manifest.handoff?.repos).toHaveLength(1);

            const repo = manifest.handoff!.repos[0];
            expect(repo.clean).toBe(false);
            expect(repo.parent).toBe(headBefore);
            expect(repo.sourceBranch).toBe('main');
            expect(repo.branch).toBe(handoffBranchFor(repoA));

            // The WIP commit really is on the remote.
            expect(git(bare, 'rev-parse', `refs/heads/${repo.branch}`)).toBe(repo.commit);

            // The user's checkout is EXACTLY as they left it: same branch, same
            // HEAD, same dirty files. This is the property that makes a handoff
            // safe to take without asking.
            expect(git(repoA, 'rev-parse', 'HEAD')).toBe(headBefore);
            expect(git(repoA, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branchBefore);
            expect(git(repoA, 'status', '--porcelain')).toBe(statusBefore);
            expect(readFileSync(join(repoA, 'README.md'), 'utf-8')).toBe('# base\nlocal edit\n');

            // The source is now frozen.
            expect(readHandoffMark(dataA)?.exportId).toBe(manifest.exportId);

            // --- the import side ------------------------------------------
            const report = await importState(
                out,
                dataB,
                { map: [[rootA, rootB]], handoff: true },
                { homeDir: homeB }
            );

            expect(report.handoff).toHaveLength(1);
            expect(report.handoff![0].restored).toBe(true);
            expect(report.handoff![0].workspaceId).toBe(repoB);

            // The target tree now has the same dirty content…
            expect(readFileSync(join(repoB, 'README.md'), 'utf-8')).toBe('# base\nlocal edit\n');
            expect(readFileSync(join(repoB, 'new-file.txt'), 'utf-8')).toBe('brand new\n');
            expect(readFileSync(join(repoB, 'scratch.txt'), 'utf-8')).toBe('scratch\n');

            // …and it is UNCOMMITTED, on the user's own branch, exactly as it
            // was on the source. A handoff must not commit someone's WIP for them.
            expect(git(repoB, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
            expect(git(repoB, 'rev-parse', 'HEAD')).toBe(headBefore);
            expect(git(repoB, 'status', '--porcelain')).not.toBe('');
        }, GIT_TEST_TIMEOUT_MS);

        it('captures a clean tree as a ref without inventing a commit', async () => {
            const headBefore = git(repoA, 'rev-parse', 'HEAD');
            const manifest = await exportState(dataA, { out, handoff: true }, { homeDir: homeA, stopTasks: async () => {} });

            const repo = manifest.handoff!.repos[0];
            expect(repo.clean).toBe(true);
            expect(repo.commit).toBe(headBefore); // no empty WIP commit was made

            const report = await importState(out, dataB, { map: [[rootA, rootB]], handoff: true }, { homeDir: homeB });
            expect(report.handoff![0].restored).toBe(false);
            expect(report.handoff![0].skipped).toMatch(/clean/);
        }, GIT_TEST_TIMEOUT_MS);

        it('refuses a handoff of a repo with no remote unless allowNoRemote is set', async () => {
            git(repoA, 'remote', 'remove', 'origin');
            writeFileSync(join(repoA, 'README.md'), '# base\nedit\n');

            await expect(
                exportState(dataA, { out, handoff: true }, { homeDir: homeA, stopTasks: async () => {} })
            ).rejects.toThrow(/no git remote/);

            // And crucially, the refusal happens BEFORE the host is frozen.
            expect(readHandoffMark(dataA)).toBeNull();
        }, GIT_TEST_TIMEOUT_MS);

        it('carries a bundle instead when allowNoRemote is set, and restores from it', async () => {
            git(repoA, 'remote', 'remove', 'origin');
            writeFileSync(join(repoA, 'README.md'), '# base\nbundled edit\n');

            const manifest = await exportState(
                dataA,
                { out, handoff: true, allowNoRemote: true },
                { homeDir: homeA, stopTasks: async () => {} }
            );
            const repo = manifest.handoff!.repos[0];
            expect(repo.remote).toBeNull();
            expect(repo.bundle).toBeTruthy();
            expect(existsSync(join(out, repo.bundle!))).toBe(true);

            // The target clone has no path to the source's objects except the
            // bundle, so this exercises the fallback end to end.
            git(repoB, 'remote', 'remove', 'origin');
            const report = await importState(out, dataB, { map: [[rootA, rootB]], handoff: true }, { homeDir: homeB });
            expect(report.handoff![0].restored).toBe(true);
            expect(readFileSync(join(repoB, 'README.md'), 'utf-8')).toBe('# base\nbundled edit\n');
        }, GIT_TEST_TIMEOUT_MS);

        it('refuses to clobber a target tree that already has uncommitted work', async () => {
            writeFileSync(join(repoA, 'README.md'), '# base\nsource edit\n');
            await exportState(dataA, { out, handoff: true }, { homeDir: homeA, stopTasks: async () => {} });

            // The user was already mid-edit on the target machine.
            writeFileSync(join(repoB, 'README.md'), '# base\nTARGET EDIT I CARE ABOUT\n');

            const report = await importState(out, dataB, { map: [[rootA, rootB]], handoff: true }, { homeDir: homeB });
            expect(report.handoff![0].restored).toBe(false);
            expect(report.handoff![0].skipped).toMatch(/uncommitted changes/);
            // Their work is still there.
            expect(readFileSync(join(repoB, 'README.md'), 'utf-8')).toContain('TARGET EDIT I CARE ABOUT');
        }, GIT_TEST_TIMEOUT_MS);

        it('warns when the target sits on a different base commit', async () => {
            writeFileSync(join(repoA, 'README.md'), '# base\nsource edit\n');
            await exportState(dataA, { out, handoff: true }, { homeDir: homeA, stopTasks: async () => {} });

            // Target has moved on.
            writeFileSync(join(repoB, 'other.txt'), 'later work\n');
            git(repoB, 'add', '.');
            git(repoB, 'commit', '-m', 'target moved on');

            const report = await importState(out, dataB, { map: [[rootA, rootB]], handoff: true }, { homeDir: homeB });
            expect(report.warnings.some(w => w.includes('different base'))).toBe(true);
        }, GIT_TEST_TIMEOUT_MS);

        it('reclaim clears the freeze', async () => {
            await exportState(dataA, { out, handoff: true }, { homeDir: homeA, stopTasks: async () => {} });
            expect(readHandoffMark(dataA)).not.toBeNull();

            expect(clearHandoffMark(dataA)).toBe(true);
            expect(readHandoffMark(dataA)).toBeNull();
            // Idempotent: reclaiming twice reports "nothing to do" rather than failing.
            expect(clearHandoffMark(dataA)).toBe(false);
        }, GIT_TEST_TIMEOUT_MS);

        it('gives two workspaces with the same basename distinct handoff branches', () => {
            expect(handoffBranchFor('/a/b/project')).not.toBe(handoffBranchFor('/c/d/project'));
            expect(handoffBranchFor('/a/b/project')).toMatch(/^claudia\/handoff\//);
        });
    });
});
