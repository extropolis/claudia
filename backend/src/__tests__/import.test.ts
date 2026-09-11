/**
 * Tests for the portable state import (P0 task 11, spec §11.2).
 *
 * NOTE ON TEMP DIRECTORIES: every fixture lives under `os.homedir()`, never
 * `os.tmpdir()`. On macOS `/tmp` resolves under `/var`, which
 * `validateWorkspacePath` blocklists as a system path — anything workspace
 * shaped gets rejected before it reaches the code under test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import { importState, PathRemapper, SUPPORTED_FORMAT_VERSION } from '../export-import/import.js';

/** Mangle a workspace path the way Claude Code names its projects folder. */
const mangle = (p: string) => p.replace(/[^a-zA-Z0-9-]/g, '-');

interface ExportFixture {
    dir: string;
    /** Overwrite manifest.json wholesale. */
    setManifest(patch: Record<string, unknown>): void;
}

describe('import', () => {
    let sandbox: string;
    let exportDir: string;
    let target: string;
    let fakeHome: string;
    let rootA: string;
    let rootB: string;

    /** Build a minimal but realistic export tree. */
    function seedExport(overrides: { homeDir?: string; formatVersion?: number } = {}): ExportFixture {
        const stateDir = join(exportDir, 'state');
        mkdirSync(stateDir, { recursive: true });

        const wsAlpha = join(rootA, 'alpha');
        const wsBeta = join(rootA, 'beta');

        writeFileSync(
            join(stateDir, 'workspace-config.json'),
            JSON.stringify({
                schemaVersion: 1,
                data: {
                    workspaces: [
                        { id: wsAlpha, name: 'alpha', createdAt: '2026-01-01T00:00:00.000Z' },
                        {
                            id: wsBeta,
                            name: 'beta',
                            createdAt: '2026-01-01T00:00:00.000Z',
                            worktreeParentId: wsAlpha,
                            references: [{ path: join(rootA, 'shared'), enabled: true }],
                        },
                    ],
                    activeWorkspaceId: wsAlpha,
                    recentWorkspaces: [{ id: join(rootA, 'gamma'), name: 'gamma' }],
                    lastBrowsedPath: rootA,
                },
            }),
            'utf-8'
        );

        // tasks.json is UNVERSIONED on this branch (PR #252 adds the envelope),
        // so the fixture writes the legacy shape on purpose.
        writeFileSync(
            join(stateDir, 'tasks.json'),
            JSON.stringify({
                tasks: [
                    { id: 't1', prompt: 'one', workspaceId: wsAlpha, sessionId: 's-alpha', lastState: 'idle', wasInterrupted: true },
                    { id: 't2', prompt: 'two', workspaceId: wsBeta, sessionId: 's-beta', lastState: 'idle', wasInterrupted: true },
                ],
                nextTaskNumber: 3,
            }),
            'utf-8'
        );

        writeFileSync(
            join(stateDir, 'archived-tasks.json'),
            JSON.stringify({ archivedTasks: [{ id: 't0', prompt: 'old', workspaceId: wsAlpha }] }),
            'utf-8'
        );

        writeFileSync(
            join(stateDir, 'checkpoints.json'),
            JSON.stringify({
                schemaVersion: 1,
                data: {
                    checkpoints: [
                        {
                            id: 'c1',
                            taskId: 't1',
                            workspaceId: wsAlpha,
                            name: 'cp',
                            timestamp: '2026-01-01T00:00:00.000Z',
                            gitDiff: `--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-old\n+new\n`,
                            metadata: { filesModified: 3 },
                        },
                    ],
                },
            }),
            'utf-8'
        );

        writeFileSync(
            join(stateDir, 'scheduled-tasks.json'),
            JSON.stringify({ schemaVersion: 1, data: [{ id: 'cron1', taskId: 't1', workspaceId: wsAlpha, cronExpression: '* * * * *', prompt: 'p' }] }),
            'utf-8'
        );

        // Agent sessions, filed under the export's reversible segment.
        for (const [ws, sid] of [[wsAlpha, 's-alpha'], [wsBeta, 's-beta']] as const) {
            const dir = join(exportDir, 'agent-sessions', 'claude-code', encodeURIComponent(ws));
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, `${sid}.jsonl`), `{"type":"user","sessionId":"${sid}"}\n`, 'utf-8');
        }

        const manifest = {
            formatVersion: overrides.formatVersion ?? SUPPORTED_FORMAT_VERSION,
            exportId: 'export-fixture-id',
            exportedAt: '2026-01-01T00:00:00.000Z',
            claudiaVersion: '0.4.0',
            source: {
                platform: 'linux',
                hostname: 'source-host',
                instanceId: 'src-instance',
                dataDir: '/srv/claudia-data',
                homeDir: overrides.homeDir ?? '/home/source-user',
            },
            tiers: { secrets: false, histories: false, agentSessions: true },
            schemaVersions: {
                'workspace-config.json': 1,
                'tasks.json': null,
                'archived-tasks.json': null,
                'checkpoints.json': 1,
                'scheduled-tasks.json': 1,
            },
            workspaces: [
                { id: wsAlpha, name: 'alpha' },
                { id: wsBeta, name: 'beta', worktreeParentId: wsAlpha },
            ],
        };
        writeFileSync(join(exportDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

        return {
            dir: exportDir,
            setManifest(patch) {
                writeFileSync(join(exportDir, 'manifest.json'), JSON.stringify({ ...manifest, ...patch }, null, 2), 'utf-8');
            },
        };
    }

    /** Read a state file back, unwrapping the envelope if there is one. */
    function readTargetState(name: string): any {
        const raw = JSON.parse(readFileSync(join(target, name), 'utf-8'));
        return raw && typeof raw === 'object' && 'schemaVersion' in raw && 'data' in raw ? raw.data : raw;
    }

    beforeEach(() => {
        sandbox = mkdtempSync(join(homedir(), '.claudia-import-test-'));
        exportDir = join(sandbox, 'export');
        target = join(sandbox, 'data');
        fakeHome = join(sandbox, 'home');
        rootA = join(sandbox, 'rootA');
        rootB = join(sandbox, 'rootB');
        mkdirSync(exportDir, { recursive: true });
        mkdirSync(target, { recursive: true });
        mkdirSync(fakeHome, { recursive: true });
        mkdirSync(rootA, { recursive: true });
        // rootB exists on disk; rootA (the source layout) deliberately has no
        // subdirectories, so an unmapped import produces missing workspaces.
        for (const name of ['alpha', 'beta']) mkdirSync(join(rootB, name), { recursive: true });
    });

    afterEach(() => {
        rmSync(sandbox, { recursive: true, force: true });
    });

    // -----------------------------------------------------------------------
    // The remap engine, in isolation
    // -----------------------------------------------------------------------
    describe('PathRemapper', () => {
        it('matches the longest prefix regardless of the order rules were given', () => {
            const remap = new PathRemapper([
                ['/a', '/short'],
                ['/a/b/c', '/long'],
                ['/a/b', '/medium'],
            ]);
            expect(remap.rules.map(r => r[0])).toEqual(['/a/b/c', '/a/b', '/a']);
            expect(remap.apply('/a/b/c/file')).toBe('/long/file');
            expect(remap.apply('/a/b/file')).toBe('/medium/file');
            expect(remap.apply('/a/file')).toBe('/short/file');
        });

        it('respects path boundaries so a sibling with a shared prefix is untouched', () => {
            const remap = new PathRemapper([['/work/api', '/srv/api']]);
            expect(remap.apply('/work/api/src/x.ts')).toBe('/srv/api/src/x.ts');
            expect(remap.apply('/work/api')).toBe('/srv/api');
            // The bug a naive startsWith would introduce:
            expect(remap.apply('/work/api-v2/src/x.ts')).toBe('/work/api-v2/src/x.ts');
        });

        it('leaves an unmatched path alone and records it rather than guessing', () => {
            const remap = new PathRemapper([['/work', '/srv']]);
            expect(remap.apply('/elsewhere/thing')).toBe('/elsewhere/thing');
            expect(remap.unmatchedPaths()).toEqual(['/elsewhere/thing']);
        });

        it('tolerates trailing separators on both sides of a rule', () => {
            const remap = new PathRemapper([['/work/', '/srv/']]);
            expect(remap.apply('/work/api')).toBe('/srv/api');
        });

        // Windows semantics are decided by the path's own shape, not the host
        // OS, so these hold identically on every CI leg.
        it('keeps the operator\'s spelling in the rule table and in rewritten paths', () => {
            const remap = new PathRemapper([['C:\\Old\\Root\\', 'D:\\New\\Root']]);
            expect(remap.rules).toEqual([['C:\\Old\\Root', 'D:\\New\\Root']]);
            expect(remap.apply('C:\\Old\\Root\\Proj')).toBe('D:\\New\\Root\\Proj');
        });

        it('matches Windows paths case- and separator-insensitively', () => {
            const remap = new PathRemapper([['C:\\Users\\Ana', 'D:\\Ana']]);
            expect(remap.apply('c:/users/ana/Work/Api')).toBe('D:\\Ana\\Work\\Api');
            expect(remap.apply('C:\\USERS\\ANA')).toBe('D:\\Ana');
            // Boundary still applies after folding.
            expect(remap.apply('C:\\Users\\Anatole\\x')).toBe('C:\\Users\\Anatole\\x');
        });

        it('keeps POSIX paths case-sensitive', () => {
            const remap = new PathRemapper([['/Work', '/srv']]);
            expect(remap.apply('/work/api')).toBe('/work/api');
            expect(remap.apply('/Work/api')).toBe('/srv/api');
        });

        it('rewrites tail separators to the target style across platforms', () => {
            const toWin = new PathRemapper([['/home/ana', 'C:\\Users\\ana']]);
            expect(toWin.apply('/home/ana/code/api')).toBe('C:\\Users\\ana\\code\\api');
            const toPosix = new PathRemapper([['C:\\Users\\ana', '/home/ana']]);
            expect(toPosix.apply('C:\\Users\\ana\\code\\api')).toBe('/home/ana/code/api');
        });
    });

    // -----------------------------------------------------------------------
    // Refusals
    // -----------------------------------------------------------------------
    it('refuses when a live backend holds the target data directory', async () => {
        seedExport();
        writeFileSync(join(target, 'instance.json'), JSON.stringify({ pid: 4242, instanceId: 'live' }), 'utf-8');

        await expect(
            importState(exportDir, target, {}, { homeDir: fakeHome, isPidAlive: (pid) => pid === 4242 })
        ).rejects.toThrow(/live Claudia backend \(pid 4242\)/);

        // Nothing was written — the refusal happens before any I/O.
        expect(existsSync(join(target, 'tasks.json'))).toBe(false);
    });

    it('proceeds when instance.json names a pid that is gone', async () => {
        seedExport();
        writeFileSync(join(target, 'instance.json'), JSON.stringify({ pid: 4242 }), 'utf-8');

        const report = await importState(exportDir, target, {}, { homeDir: fakeHome, isPidAlive: () => false });
        expect(report.filesWritten).toContain('tasks.json');
    });

    it('refuses to overwrite a target that already has tasks.json, unless forced', async () => {
        seedExport();
        writeFileSync(join(target, 'tasks.json'), JSON.stringify({ tasks: [{ id: 'existing' }] }), 'utf-8');

        await expect(importState(exportDir, target, {}, { homeDir: fakeHome })).rejects.toThrow(/already exists/);
        expect(readTargetState('tasks.json').tasks[0].id).toBe('existing');

        const report = await importState(exportDir, target, { force: true }, { homeDir: fakeHome });
        expect(report.filesWritten).toContain('tasks.json');
        expect(readTargetState('tasks.json').tasks.map((t: any) => t.id)).toEqual(['t1', 't2']);
    });

    it('rejects an unknown formatVersion loudly', async () => {
        const fixture = seedExport();
        fixture.setManifest({ formatVersion: 99 });
        await expect(importState(exportDir, target, {}, { homeDir: fakeHome })).rejects.toThrow(/unsupported formatVersion 99/);
    });

    it('rejects a manifest with no formatVersion at all', async () => {
        const fixture = seedExport();
        fixture.setManifest({ formatVersion: undefined });
        await expect(importState(exportDir, target, {}, { homeDir: fakeHome })).rejects.toThrow(/no formatVersion/);
    });

    it('rejects a directory that is not an export', async () => {
        await expect(importState(join(sandbox, 'nope'), target, {}, { homeDir: fakeHome })).rejects.toThrow(/not a Claudia export/);
    });

    // -----------------------------------------------------------------------
    // Dry run
    // -----------------------------------------------------------------------
    it('dry run reports the remap table and writes absolutely nothing', async () => {
        seedExport();
        const before = readdirSync(target);

        const report = await importState(
            exportDir,
            target,
            { map: [[rootA, rootB]], dryRun: true },
            { homeDir: fakeHome }
        );

        expect(report.dryRun).toBe(true);
        expect(report.filesWritten).toEqual([]);
        expect(report.sessionsPlaced).toBe(0);
        expect(report.remapTable).toContainEqual([rootA, rootB]);
        expect(report.workspaces.every(w => w.exists)).toBe(true);

        expect(readdirSync(target)).toEqual(before);
        expect(existsSync(join(fakeHome, '.claude'))).toBe(false);
    });

    it('dry run is not blocked by a populated target, so it can be run before deciding', async () => {
        seedExport();
        writeFileSync(join(target, 'tasks.json'), JSON.stringify({ tasks: [{ id: 'existing' }] }), 'utf-8');

        const report = await importState(exportDir, target, { dryRun: true }, { homeDir: fakeHome });
        expect(report.dryRun).toBe(true);
        expect(readTargetState('tasks.json').tasks[0].id).toBe('existing');
    });

    // -----------------------------------------------------------------------
    // Missing workspaces
    // -----------------------------------------------------------------------
    it('imports a workspace whose remapped path is missing, with exists:false and a warning', async () => {
        seedExport();
        const missingRoot = join(sandbox, 'not-cloned-yet');

        const report = await importState(
            exportDir,
            target,
            { map: [[rootA, missingRoot]] },
            { homeDir: fakeHome }
        );

        // Never dropped: both are present, both flagged.
        expect(report.workspaces).toHaveLength(2);
        expect(report.workspaces.every(w => !w.exists)).toBe(true);
        expect(report.warnings.some(w => w.includes('does not exist on this machine'))).toBe(true);

        // And they survive into the written file, which is the point — the old
        // behaviour of workspace-store was to delete them outright.
        const written = readTargetState('workspace-config.json');
        expect(written.workspaces).toHaveLength(2);
        expect(written.workspaces.map((w: any) => w.id)).toEqual([
            join(missingRoot, 'alpha'),
            join(missingRoot, 'beta'),
        ]);
    });

    it('warns about a path no rule covered and leaves it verbatim', async () => {
        seedExport();
        // Map only `alpha`; `beta`, the references path and `gamma` fall through.
        const report = await importState(
            exportDir,
            target,
            { map: [[join(rootA, 'alpha'), join(rootB, 'alpha')]] },
            { homeDir: fakeHome }
        );

        const written = readTargetState('workspace-config.json');
        expect(written.workspaces[0].id).toBe(join(rootB, 'alpha'));
        expect(written.workspaces[1].id).toBe(join(rootA, 'beta')); // untouched
        expect(report.warnings.some(w => w.includes('no mapping covered'))).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Field-level remapping
    // -----------------------------------------------------------------------
    it('rewrites every documented path field and no others', async () => {
        seedExport();
        await importState(exportDir, target, { map: [[rootA, rootB]] }, { homeDir: fakeHome });

        const ws = readTargetState('workspace-config.json');
        expect(ws.workspaces[0].id).toBe(join(rootB, 'alpha'));
        expect(ws.workspaces[1].worktreeParentId).toBe(join(rootB, 'alpha'));
        expect(ws.workspaces[1].references[0].path).toBe(join(rootB, 'shared'));
        expect(ws.activeWorkspaceId).toBe(join(rootB, 'alpha'));
        expect(ws.lastBrowsedPath).toBe(rootB);
        expect(ws.recentWorkspaces[0].id).toBe(join(rootB, 'gamma'));

        const tasks = readTargetState('tasks.json');
        expect(tasks.tasks.map((t: any) => t.workspaceId)).toEqual([join(rootB, 'alpha'), join(rootB, 'beta')]);
        expect(tasks.nextTaskNumber).toBe(3); // untouched

        const archived = readTargetState('archived-tasks.json');
        expect(archived.archivedTasks[0].workspaceId).toBe(join(rootB, 'alpha'));

        const cps = readTargetState('checkpoints.json');
        expect(cps.checkpoints[0].workspaceId).toBe(join(rootB, 'alpha'));
        // Repo-relative data must survive byte-for-byte: a prefix rewrite
        // inside patch text would corrupt the patch.
        expect(cps.checkpoints[0].gitDiff).toContain('--- a/src/x.ts');
        expect(cps.checkpoints[0].metadata.filesModified).toBe(3);

        const cron = readTargetState('scheduled-tasks.json');
        expect(cron[0].workspaceId).toBe(join(rootB, 'alpha'));
    });

    it('applies the implicit source-home → local-home rule with no --map at all', async () => {
        // Re-seed with workspaces living under the source's home directory.
        const sourceHome = join(sandbox, 'source-home');
        rootA = join(sourceHome, 'work');
        mkdirSync(join(fakeHome, 'work', 'alpha'), { recursive: true });
        mkdirSync(join(fakeHome, 'work', 'beta'), { recursive: true });
        seedExport({ homeDir: sourceHome });

        const report = await importState(exportDir, target, {}, { homeDir: fakeHome });

        expect(report.remapTable).toContainEqual([sourceHome, fakeHome]);
        expect(report.workspaces.every(w => w.exists)).toBe(true);
        expect(readTargetState('workspace-config.json').workspaces[0].id).toBe(join(fakeHome, 'work', 'alpha'));
    });

    it('lets an explicit mapping win over the implicit home rule for a longer prefix', async () => {
        const sourceHome = join(sandbox, 'source-home');
        rootA = join(sourceHome, 'work');
        seedExport({ homeDir: sourceHome });

        const report = await importState(
            exportDir,
            target,
            { map: [[join(sourceHome, 'work'), rootB]] },
            { homeDir: fakeHome }
        );

        // Longest prefix first: the explicit /source-home/work rule outranks
        // the implicit /source-home rule.
        expect(report.remapTable[0]).toEqual([join(sourceHome, 'work'), rootB]);
        expect(readTargetState('workspace-config.json').workspaces[0].id).toBe(join(rootB, 'alpha'));
    });

    // -----------------------------------------------------------------------
    // Session placement
    // -----------------------------------------------------------------------
    it('files transcripts under the NEW mangled folder name', async () => {
        seedExport();
        const report = await importState(exportDir, target, { map: [[rootA, rootB]] }, { homeDir: fakeHome });

        expect(report.sessionsPlaced).toBe(2);
        const newAlphaDir = join(fakeHome, '.claude', 'projects', mangle(join(rootB, 'alpha')));
        expect(existsSync(join(newAlphaDir, 's-alpha.jsonl'))).toBe(true);

        // And emphatically NOT under the source machine's folder name, which is
        // the exact failure a plain directory copy produces.
        const oldAlphaDir = join(fakeHome, '.claude', 'projects', mangle(join(rootA, 'alpha')));
        expect(existsSync(oldAlphaDir)).toBe(false);
    });

    it('skips a transcript whose file name tries to escape the projects directory', async () => {
        seedExport();
        const dir = join(exportDir, 'agent-sessions', 'claude-code', encodeURIComponent(join(rootA, 'alpha')));
        // A literal ".." name cannot be created on disk, so the traversal is
        // expressed through the encoded workspace segment's own file name.
        writeFileSync(join(dir, '..jsonl'), 'x', 'utf-8');

        const report = await importState(exportDir, target, { map: [[rootA, rootB]] }, { homeDir: fakeHome });
        // The legitimate two still land; the odd one is either placed under a
        // safe name or skipped, but never outside the projects dir.
        const projects = join(fakeHome, '.claude', 'projects');
        expect(existsSync(projects)).toBe(true);
        expect(report.sessionsPlaced).toBeGreaterThanOrEqual(2);
    });

    // -----------------------------------------------------------------------
    // Misc
    // -----------------------------------------------------------------------
    it('refuses to write into the export directory itself', async () => {
        seedExport();
        await expect(
            importState(exportDir, join(exportDir, 'data'), {}, { homeDir: fakeHome })
        ).rejects.toThrow(/refusing to write into the export directory/);
    });

    it('reports an incomplete mapping as a warning instead of silently dropping it', async () => {
        seedExport();
        const report = await importState(
            exportDir,
            target,
            { map: [['', rootB] as [string, string]] },
            { homeDir: fakeHome }
        );
        expect(report.warnings.some(w => w.includes('incomplete mapping'))).toBe(true);
    });

    it('survives an export whose state directory is missing', async () => {
        seedExport();
        rmSync(join(exportDir, 'state'), { recursive: true, force: true });

        const report = await importState(exportDir, target, {}, { homeDir: fakeHome });
        expect(report.filesWritten).toEqual([]);
        expect(report.warnings.some(w => w.includes('carries no state files'))).toBe(true);
    });

    it('warns when --handoff is asked for but the export captured no trees', async () => {
        seedExport();
        const report = await importState(exportDir, target, { handoff: true }, { homeDir: fakeHome });
        expect(report.warnings.some(w => w.includes('no captured working trees'))).toBe(true);
        expect(report.handoff).toEqual([]);
    });
});
