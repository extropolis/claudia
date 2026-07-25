/**
 * WS-handler integration harness: boots the REAL server via createApp(tmpDir)
 * on an ephemeral port with a real temp git repo + worktree, seeded task/
 * workspace state, and drives it over a real WebSocket — the layer where the
 * workspace:reset and worktree-validation bug classes lived untested.
 *
 * Regression targets:
 *  - workspace:reset skipped tasks in .claudia-worktrees/* (exact-match filter)
 *  - workspace:reset never removed worktrees at all
 *  - worktree WS handlers accepted unvalidated paths (#100)
 *  - worktree:remove could remove the primary workspace (#102)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import WebSocket from 'ws';
import { createApp } from '../server.js';

const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });

let base: string;
let repo: string;
let worktree: string;
let port: number;
let shutdown: (() => Promise<void>) | undefined;

function wsCall(type: string, payload: Record<string, unknown>, expectTypes: string[], timeoutMs = 8000): Promise<{ type: string; payload: any }> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        const timer = setTimeout(() => { ws.close(); reject(new Error(`timeout waiting for ${expectTypes.join('|')}`)); }, timeoutMs);
        ws.on('open', () => ws.send(JSON.stringify({ type, payload })));
        ws.on('message', (data: Buffer) => {
            let msg: any;
            try { msg = JSON.parse(data.toString()); } catch { return; }
            if (expectTypes.includes(msg.type)) {
                clearTimeout(timer);
                ws.close();
                resolve(msg);
            }
        });
        ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
}

beforeAll(async () => {
    // NOT os.tmpdir(): macOS tmp lives under /var, which validateWorkspacePath
    // blocklists as a system path — workspace ops on temp repos would be
    // rejected before reaching the code under test.
    base = mkdtempSync(join(homedir(), '.claudia-int-test-'));

    // Real git repo with a real worktree
    repo = join(base, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.txt'), 'hello');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');
    worktree = join(repo, '.claudia-worktrees', 'claudia-task-test1');
    mkdirSync(join(repo, '.claudia-worktrees'), { recursive: true });
    git(repo, 'worktree', 'add', '-b', 'claudia/task-test1', worktree);

    // Seed workspace records: root + registered worktree child
    writeFileSync(join(base, 'workspace-config.json'), JSON.stringify({
        schemaVersion: 1,
        data: {
            workspaces: [
                { id: repo, name: 'repo', createdAt: new Date().toISOString() },
                { id: worktree, name: 'claudia-task-test1', createdAt: new Date().toISOString(), worktreeParentId: repo, worktreeBranch: 'claudia/task-test1' },
            ],
        },
    }, null, 2));

    // Seed tasks: one in the root workspace, one in the WORKTREE workspace.
    // Disconnected + not interrupted → loaded into the lazy set, never respawned.
    const mkTask = (id: string, workspaceId: string) => ({
        id, prompt: `task ${id}`, workspaceId,
        createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(),
        lastState: 'idle', wasInterrupted: false, shouldContinue: false, backendType: 'claude-code',
    });
    writeFileSync(join(base, 'tasks.json'), JSON.stringify({
        tasks: [mkTask('task-root-1', repo), mkTask('task-wt-1', worktree)],
        archivedTasks: [],
    }, null, 2));

    const appParts = await createApp(base);
    shutdown = appParts.shutdownForTests;
    await new Promise<void>((resolve) => {
        appParts.server.listen(0, '127.0.0.1', () => resolve());
    });
    port = (appParts.server.address() as { port: number }).port;
}, 30000);

afterAll(async () => {
    if (shutdown) await shutdown();
    rmSync(base, { recursive: true, force: true });
}, 20000);

describe('workspace:reset (regression: family archiving + worktree removal)', () => {
    it('archives tasks in the root AND its worktrees, and removes the worktrees', async () => {
        const res = await wsCall('workspace:reset', { workspaceId: repo }, ['workspace:resetResult']);
        // BOTH tasks archived — the old exact-match filter archived only task-root-1
        expect(res.payload.archivedCount).toBe(2);
        // The worktree itself is removed — the old handler had no removal step
        expect(res.payload.worktreesRemoved).toBe(1);
        expect(res.payload.worktreesFailed).toBe(0);
        expect(existsSync(worktree)).toBe(false);

        // Workspace record for the worktree is gone
        const wsList = await fetch(`http://127.0.0.1:${port}/api/workspaces`).then(r => r.json());
        const ids = (wsList.workspaces || []).map((w: { id: string }) => w.id);
        expect(ids).toContain(repo);
        expect(ids).not.toContain(worktree);

        // No live/disconnected tasks remain for the family
        const tasks = await fetch(`http://127.0.0.1:${port}/api/tasks`).then(r => r.json());
        const remaining = tasks.filter((t: { workspaceId: string }) => t.workspaceId === repo || t.workspaceId === worktree);
        expect(remaining).toHaveLength(0);
    }, 20000);
});

describe('worktree WS handler validation (#100/#102 regressions)', () => {
    it('rejects path traversal in worktree:create', async () => {
        const res = await wsCall('worktree:create', { workspaceId: `${repo}/../../etc`, branch: 'x' }, ['error']);
        expect(res.payload.code).toBe('INVALID_WORKSPACE');
    });

    it('rejects path traversal in worktree:list', async () => {
        const res = await wsCall('worktree:list', { workspaceId: '../../..' }, ['error']);
        expect(res.payload.code).toBe('INVALID_WORKSPACE');
    });

    it('refuses to remove the primary workspace via worktree:remove', async () => {
        const res = await wsCall('worktree:remove', { workspaceId: repo, worktreePath: repo, force: true }, ['error']);
        expect(res.payload.code).toBe('INVALID_WORKTREE');
    });
});
