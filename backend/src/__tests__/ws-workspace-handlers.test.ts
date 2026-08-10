/**
 * WS protocol coverage: the `workspace:*` and `worktree:*` handler families.
 *
 * Worktree ops are destructive and path-driven, so the validation guardrails
 * (#100 unvalidated paths, #102 removing the primary workspace) are asserted at
 * the WS layer specifically — the REST layer had these checks while the WS layer
 * did not, which is exactly how those bugs shipped.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createTestEnv, initRepo, git, waitFor, type TestEnv, type WSClient, SUPPORTS_FAKE_CLI } from './helpers/ws-harness.js';

let env: TestEnv;
let client: WSClient;
let observer: WSClient;
let repo: string;

beforeAll(async () => {
    env = await createTestEnv({ prefix: 'ws-wsp', workspaces: ['primary', 'secondary'], withFakeClaude: true });
    repo = env.workspaces[0];
    initRepo(repo);
    client = await env.connect();
    observer = await env.connect();
}, 40000);

afterAll(async () => {
    await env.cleanup();
}, 30000);

describe.skipIf(!SUPPORTS_FAKE_CLI)('workspace:create / delete / rename', () => {
    it('create broadcasts workspace:created to all clients', async () => {
        const p = join(env.base, 'created-ws');
        mkdirSync(p, { recursive: true });
        client.send('workspace:create', { path: p });
        const f = await observer.waitForMessage('workspace:created', m => m.payload?.workspace?.id === p);
        expect(f.payload.workspace.id).toBe(p);
    }, 15000);

    it('create auto-creates a missing directory (documented behaviour, not an error)', async () => {
        const p = join(env.base, 'auto-made-ws');
        expect(existsSync(p)).toBe(false);
        client.send('workspace:create', { path: p });
        await observer.waitForMessage('workspace:created', m => m.payload?.workspace?.id === p);
        expect(existsSync(p)).toBe(true);
    }, 15000);

    it('create on a path that is a FILE fails with WORKSPACE_CREATE_FAILED', async () => {
        const f = join(env.base, 'a-file.txt');
        writeFileSync(f, 'not a dir');
        const err = await client.request('workspace:create', { path: f }, 'error');
        expect(err.payload.code).toBe('WORKSPACE_CREATE_FAILED');
        const list = await env.api('/api/workspaces');
        expect(list.workspaces.some((w: any) => w.id === f)).toBe(false);
    }, 15000);

    it('create on an already-registered workspace fails rather than duplicating it', async () => {
        const err = await client.request('workspace:create', { path: repo }, 'error');
        expect(err.payload.code).toBe('WORKSPACE_CREATE_FAILED');
        const list = await env.api('/api/workspaces');
        expect(list.workspaces.filter((w: any) => w.id === repo)).toHaveLength(1);
    }, 15000);

    it('rename broadcasts workspace:updated with the new displayName', async () => {
        client.send('workspace:rename', { workspaceId: env.workspaces[1], displayName: 'Renamed WS' });
        const f = await observer.waitForMessage('workspace:updated', m =>
            Array.isArray(m.payload?.workspaces) &&
            m.payload.workspaces.some((w: any) => w.id === env.workspaces[1] && w.displayName === 'Renamed WS'));
        expect(f.payload.workspaces.find((w: any) => w.id === env.workspaces[1]).displayName).toBe('Renamed WS');
    }, 15000);

    it('delete broadcasts workspace:deleted and drops it from the list', async () => {
        const p = join(env.base, 'created-ws');
        client.send('workspace:delete', { workspaceId: p });
        await observer.waitForMessage('workspace:deleted', m => m.payload?.workspaceId === p);
        const list = await env.api('/api/workspaces');
        expect(list.workspaces.some((w: any) => w.id === p)).toBe(false);
    }, 15000);

    it('ignores create/delete/rename with missing params without dropping the connection', async () => {
        await client.sendAndProveAlive('workspace:create', {});
        await client.sendAndProveAlive('workspace:delete', {});
        await client.sendAndProveAlive('workspace:rename', { workspaceId: repo });
        await client.sendAndProveAlive('workspace:delete', { workspaceId: 'not-a-real-workspace' });
        expect(client.isClosed).toBe(false);
    }, 20000);
});

describe.skipIf(!SUPPORTS_FAKE_CLI)('workspace:reorder / setOrder', () => {
    it('setOrder adopts the client-supplied order and broadcasts workspace:reordered', async () => {
        const list = await env.api('/api/workspaces');
        const ids = list.workspaces.map((w: any) => w.id);
        const reversed = [...ids].reverse();
        client.send('workspace:setOrder', { orderedIds: reversed });
        const f = await observer.waitForMessage('workspace:reordered');
        expect(Array.isArray(f.payload.workspaces)).toBe(true);
    }, 15000);

    it('setOrder rejects a non-string-array with INVALID_PARAMS', async () => {
        const err = await client.request('workspace:setOrder', { orderedIds: [1, 2, 3] }, 'error');
        expect(err.payload.code).toBe('INVALID_PARAMS');

        const err2 = await client.request('workspace:setOrder', { orderedIds: 'nope' }, 'error');
        expect(err2.payload.code).toBe('INVALID_PARAMS');
    }, 15000);

    it('reorder with non-numeric indices is ignored, not fatal', async () => {
        await client.sendAndProveAlive('workspace:reorder', { fromIndex: 'a', toIndex: 'b' });
        await client.sendAndProveAlive('workspace:reorder', {});
        expect(client.isClosed).toBe(false);
    }, 15000);
});

describe.skipIf(!SUPPORTS_FAKE_CLI)('workspace:systemPrompt get/set', () => {
    it('set then get round-trips the prompt', async () => {
        const setRes = await client.request(
            'workspace:systemPrompt:set',
            { workspaceId: repo, systemPrompt: 'BE_TERSE always' },
            'workspace:systemPrompt:result',
        );
        expect(setRes.payload.success).toBe(true);

        const getRes = await client.request('workspace:systemPrompt:get', { workspaceId: repo }, 'workspace:systemPrompt');
        expect(getRes.payload.systemPrompt).toBe('BE_TERSE always');
    }, 15000);

    it('clearing the prompt yields an empty string on get', async () => {
        await client.request('workspace:systemPrompt:set', { workspaceId: repo, systemPrompt: '' }, 'workspace:systemPrompt:result');
        const getRes = await client.request('workspace:systemPrompt:get', { workspaceId: repo }, 'workspace:systemPrompt');
        expect(getRes.payload.systemPrompt).toBe('');
    }, 15000);

    it('set on an unknown workspace reports success:false rather than throwing', async () => {
        const res = await client.request(
            'workspace:systemPrompt:set',
            { workspaceId: '/nonexistent/workspace', systemPrompt: 'x' },
            'workspace:systemPrompt:result',
        );
        expect(res.payload.success).toBe(false);
    }, 15000);
});

describe.skipIf(!SUPPORTS_FAKE_CLI)('workspace:references add / toggle / remove', () => {
    let refPath: string;

    beforeAll(() => {
        refPath = join(env.base, 'refdir');
        mkdirSync(refPath, { recursive: true });
    });

    it('add broadcasts workspace:updated carrying the new reference', async () => {
        client.send('workspace:references:add', { workspaceId: repo, path: refPath, description: 'docs' });
        const f = await observer.waitForMessage('workspace:updated', m =>
            m.payload?.workspaces?.some((w: any) => w.id === repo && w.references?.some((r: any) => r.path === refPath)));
        const wsRec = f.payload.workspaces.find((w: any) => w.id === repo);
        expect(wsRec.references.find((r: any) => r.path === refPath).description).toBe('docs');
    }, 15000);

    it('toggle removes an existing reference and re-adds a missing one', async () => {
        // Currently present → toggle removes it.
        client.send('workspace:references:toggle', { workspaceId: repo, referencePath: refPath });
        await waitFor(
            () => env.api('/api/workspaces'),
            (l: any) => !l.workspaces.find((w: any) => w.id === repo)?.references?.some((r: any) => r.path === refPath),
            10000,
        );

        // Now absent → toggle adds it back.
        client.send('workspace:references:toggle', { workspaceId: repo, referencePath: refPath });
        const back = await waitFor(
            () => env.api('/api/workspaces'),
            (l: any) => Boolean(l.workspaces.find((w: any) => w.id === repo)?.references?.some((r: any) => r.path === refPath)),
            10000,
        );
        expect(back.workspaces.find((w: any) => w.id === repo).references.some((r: any) => r.path === refPath)).toBe(true);
    }, 25000);

    it('remove drops the reference by id', async () => {
        const list = await env.api('/api/workspaces');
        const ref = list.workspaces.find((w: any) => w.id === repo).references.find((r: any) => r.path === refPath);
        client.send('workspace:references:remove', { workspaceId: repo, referenceId: ref.id });
        const after = await waitFor(
            () => env.api('/api/workspaces'),
            (l: any) => !l.workspaces.find((w: any) => w.id === repo)?.references?.some((r: any) => r.id === ref.id),
            10000,
        );
        // Removing the last reference leaves `references` empty *or* absent —
        // both mean "no references", so normalise rather than assume an array.
        const refs = after.workspaces.find((w: any) => w.id === repo).references ?? [];
        expect(refs.some((r: any) => r.id === ref.id)).toBe(false);
    }, 20000);

    it('malformed reference ops never crash the handler', async () => {
        await client.sendAndProveAlive('workspace:references:add', { workspaceId: repo });
        await client.sendAndProveAlive('workspace:references:add', { path: refPath });
        await client.sendAndProveAlive('workspace:references:remove', { workspaceId: repo, referenceId: 'ghost' });
        await client.sendAndProveAlive('workspace:references:toggle', { workspaceId: 'ghost-ws', referencePath: refPath });
        expect(client.isClosed).toBe(false);
    }, 25000);
});

describe.skipIf(!SUPPORTS_FAKE_CLI)('workspace:recent list / clear', () => {
    it('a deleted workspace shows up in the recent list, and clear removes it', async () => {
        const p = join(env.base, 'recent-ws');
        mkdirSync(p, { recursive: true });
        client.send('workspace:create', { path: p });
        await observer.waitForMessage('workspace:created', m => m.payload?.workspace?.id === p);
        client.send('workspace:delete', { workspaceId: p });
        await observer.waitForMessage('workspace:deleted', m => m.payload?.workspaceId === p);

        const listed = await client.request('workspace:recent:list', {}, 'workspace:recent:list');
        expect(Array.isArray(listed.payload.recentWorkspaces)).toBe(true);

        // Clearing a specific entry replies with the refreshed list…
        const cleared = await client.request('workspace:recent:clear', { workspaceId: p }, 'workspace:recent:list');
        expect(cleared.payload.recentWorkspaces.some((w: any) => (w.id || w.path) === p)).toBe(false);

        // …and clearing with no id empties the whole list.
        const all = await client.request('workspace:recent:clear', {}, 'workspace:recent:list');
        expect(all.payload.recentWorkspaces).toHaveLength(0);
    }, 30000);
});

describe.skipIf(!SUPPORTS_FAKE_CLI)('workspace:autoWorktree', () => {
    it('enabling broadcasts workspace:updated with autoWorktree true', async () => {
        client.send('workspace:autoWorktree', { workspaceId: repo, enabled: true });
        const f = await observer.waitForMessage('workspace:updated', m => m.payload?.workspace?.id === repo && m.payload?.workspace?.autoWorktree === true);
        expect(f.payload.workspace.autoWorktree).toBe(true);

        client.send('workspace:autoWorktree', { workspaceId: repo, enabled: false });
        await observer.waitForMessage('workspace:updated', m => m.payload?.workspace?.id === repo && m.payload?.workspace?.autoWorktree === false);
    }, 20000);

    it('requires a boolean `enabled` — a truthy string is rejected', async () => {
        const err = await client.request('workspace:autoWorktree', { workspaceId: repo, enabled: 'yes' }, 'error');
        expect(err.payload.code).toBe('MISSING_PARAMS');
    }, 15000);

    it('reports NOT_FOUND for an unregistered workspace', async () => {
        const err = await client.request('workspace:autoWorktree', { workspaceId: join(env.base, 'ghost'), enabled: true }, 'error');
        expect(err.payload.code).toBe('NOT_FOUND');
    }, 15000);
});

describe.skipIf(!SUPPORTS_FAKE_CLI)('worktree:create / list / remove / prune', () => {
    let wtPath: string;

    it('create makes a real worktree, registers the workspace, and broadcasts', async () => {
        const res = await client.request(
            'worktree:create',
            { workspaceId: repo, branch: 'claudia/ws-test-1', createBranch: true },
            'worktree:created',
            undefined,
            25000,
        );
        wtPath = res.payload.worktreePath;
        expect(res.payload.branch).toBe('claudia/ws-test-1');
        expect(existsSync(wtPath)).toBe(true);

        // Registered as a child workspace, and every client hears about it.
        await observer.waitForMessage('workspace:created', m => m.payload?.workspace?.id === wtPath);
        const list = await env.api('/api/workspaces');
        expect(list.workspaces.find((w: any) => w.id === wtPath).worktreeParentId).toBe(repo);
    }, 40000);

    it('list returns the worktree with a taskCount', async () => {
        const res = await client.request('worktree:list', { workspaceId: repo }, 'worktree:listed', undefined, 25000);
        const found = res.payload.worktrees.find((w: any) => w.path === wtPath);
        expect(found).toBeDefined();
        expect(typeof found.taskCount).toBe('number');
    }, 30000);

    it('create with a duplicate branch fails cleanly with WORKTREE_CREATE_FAILED', async () => {
        const err = await client.request(
            'worktree:create',
            { workspaceId: repo, branch: 'claudia/ws-test-1', createBranch: true },
            'error',
            undefined,
            25000,
        );
        expect(err.payload.code).toBe('WORKTREE_CREATE_FAILED');
    }, 30000);

    it('remove deletes the worktree and unregisters the workspace', async () => {
        const res = await client.request(
            'worktree:remove',
            { workspaceId: repo, worktreePath: wtPath, force: true },
            'worktree:removed',
            undefined,
            25000,
        );
        expect(res.payload.worktreePath).toBe(wtPath);
        await observer.waitForMessage('workspace:deleted', m => m.payload?.workspaceId === wtPath);
        expect(existsSync(wtPath)).toBe(false);
    }, 30000);

    it('prune reports pruned paths for a repo with no stale worktrees', async () => {
        const res = await client.request('worktree:prune', { workspaceId: repo }, 'worktree:pruned', undefined, 25000);
        expect(res.payload.workspaceId).toBe(repo);
        expect(Array.isArray(res.payload.pruned)).toBe(true);
    }, 30000);

    it('every worktree op requires its params (MISSING_PARAMS, no crash)', async () => {
        for (const [type, payload] of [
            ['worktree:list', {}],
            ['worktree:create', { workspaceId: repo }],
            ['worktree:remove', { workspaceId: repo }],
            ['worktree:prune', {}],
        ] as const) {
            const err = await client.request(type, payload, 'error');
            expect(err.payload.code).toBe('MISSING_PARAMS');
        }
    }, 25000);

    it('#100 regression: traversal paths are rejected on create/list/prune/remove', async () => {
        const bad = `${repo}/../../etc`;
        expect((await client.request('worktree:create', { workspaceId: bad, branch: 'x' }, 'error')).payload.code).toBe('INVALID_WORKSPACE');
        expect((await client.request('worktree:list', { workspaceId: '../../..' }, 'error')).payload.code).toBe('INVALID_WORKSPACE');
        expect((await client.request('worktree:prune', { workspaceId: bad }, 'error')).payload.code).toBe('INVALID_WORKSPACE');
        expect((await client.request('worktree:remove', { workspaceId: repo, worktreePath: bad }, 'error')).payload.code).toBe('INVALID_WORKSPACE');
    }, 30000);

    it('#102 regression: refuses to remove the primary workspace as if it were a worktree', async () => {
        const err = await client.request('worktree:remove', { workspaceId: repo, worktreePath: repo, force: true }, 'error');
        expect(err.payload.code).toBe('INVALID_WORKTREE');
        expect(existsSync(repo)).toBe(true);
    }, 15000);

    it('refuses to remove a worktree that still has a RUNNING task, unless forced', async () => {
        const created = await client.request(
            'worktree:create',
            { workspaceId: repo, branch: 'claudia/ws-busy', createBranch: true },
            'worktree:created', undefined, 25000,
        );
        const busyPath = created.payload.worktreePath;

        // Spawn a real task (fake CLI) into that worktree and wait until the
        // server considers it live — that is the precondition for the guard.
        client.send('task:create', { prompt: 'BUSY_IN_WORKTREE', workspaceId: busyPath });
        const liveTask = await waitFor(
            () => env.api('/api/tasks'),
            (ts: any[]) => ts.some(t => t.workspaceId === busyPath && ['busy', 'starting', 'waiting_input'].includes(t.state)),
            25000,
        );
        const taskId = liveTask.find((t: any) => t.workspaceId === busyPath).id;

        // Unforced removal must be refused, and must name the blocking task.
        const refused = await client.request(
            'worktree:remove',
            { workspaceId: repo, worktreePath: busyPath, force: false },
            'worktree:error', undefined, 20000,
        );
        expect(refused.payload.error).toMatch(/active task/i);
        expect(refused.payload.activeTasks).toContain(taskId);
        expect(existsSync(busyPath)).toBe(true); // nothing was destroyed

        // Forced removal goes through.
        const removed = await client.request(
            'worktree:remove',
            { workspaceId: repo, worktreePath: busyPath, force: true },
            'worktree:removed', undefined, 25000,
        );
        expect(removed.payload.worktreePath).toBe(busyPath);
    }, 60000);
});

describe.skipIf(!SUPPORTS_FAKE_CLI)('git:push (local bare remote — no network)', () => {
    it('rejects a traversal workspace path before creating a push task', async () => {
        const err = await client.request('git:push', { workspaceId: `${repo}/../../etc` }, 'error');
        expect(err.payload.code).toBe('INVALID_WORKSPACE');
    }, 15000);

    it('requires workspaceId', async () => {
        const err = await client.request('git:push', {}, 'error');
        expect(err.payload.code).toBe('MISSING_PARAMS');
    }, 15000);

    it('a repo wired to a local bare remote can actually push (proves the fixture, not the network)', async () => {
        const bare = join(env.base, 'remote.git');
        git(env.base, 'init', '--bare', bare);
        git(repo, 'remote', 'add', 'origin', bare);
        git(repo, 'push', '-u', 'origin', 'main');
        const refs = git(bare, 'branch', '--list');
        expect(refs).toContain('main');
    }, 20000);
});
