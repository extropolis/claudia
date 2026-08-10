/**
 * Two things this file covers that nothing else could:
 *
 * 1. The GitHub-backed routes (ci-status, github-issues, notifications,
 *    pr-description). server.ts shells out to `gh` for all of them, so they
 *    were untestable without hitting the real GitHub API. A fake `gh` on PATH
 *    (fixtures/fake-gh.sh) makes the full parse/map path assertable offline —
 *    including the CI check state->status/conclusion mapping table, which is
 *    pure logic that had zero coverage.
 *
 * 2. The VALIDATION GUARDS of the remaining network-dependent routes (tts,
 *    elevenlabs, hyperspace-proxy, sap-ai-core, mcp/test). Every one of them
 *    returns 4xx/5xx *before* it opens a socket, so those branches are real,
 *    deterministic, offline coverage. The network half is deliberately left
 *    alone — see the skip list at the bottom.
 *
 * The `gh`-backed half is POSIX-only: fixtures/fake-gh.sh is a bash script
 * placed on PATH as `gh`, which Windows cannot exec — the routes then fail the
 * shell-out and answer 500 instead of 200. Those four describes are skipped on
 * win32 and stay covered by the Linux leg. The guard describes below them need
 * no `gh` at all, so they keep running on every platform.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, chmodSync, existsSync, readFileSync } from 'fs';
import { join, dirname, delimiter } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { startHarness, makeGitRepo, git, makeTaskRecord, type Harness } from './helpers/server-harness.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** The fake `gh` is a bash script on PATH; Windows cannot exec it. */
const NEEDS_FAKE_GH = process.platform !== 'win32';

let h: Harness;
let ghBin: string;      // dir prepended to PATH, holds the fake `gh`
let ghLogDir: string;   // fake gh records argv / PR body here
let repo: string;       // real git repo with a github.com origin
let plainDir: string;   // exists but is not a git repo
let noRemoteRepo: string;
let otherRemoteRepo: string;
const TASK_ID = 'task-guards-1';

const readIf = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

beforeAll(async () => {
    // The fake `gh` has to be on PATH *before* createApp, and startHarness
    // creates its own base dir, so this scratch dir is made independently.
    // Under homedir(), not os.tmpdir(): /var is blocklisted by validateWorkspacePath.
    ghBin = mkdtempSync(join(homedir(), '.claudia-fakegh-'));
    ghLogDir = join(ghBin, 'log');
    mkdirSync(ghLogDir, { recursive: true });
    const dest = join(ghBin, 'gh');
    copyFileSync(join(FIXTURES, 'fake-gh.sh'), dest);
    chmodSync(dest, 0o755);

    h = await startHarness({
        prefix: '.claudia-gh-test-',
        // Seeded through the harness, NOT written after boot: the spawner
        // snapshots tasks.json at startup and refuses to save if the file
        // changes underneath it ("modified by another process").
        // workspaceId is irrelevant here — /learn 404s on the missing
        // sessionId before it ever looks the workspace up.
        tasks: [makeTaskRecord(TASK_ID, '/nonexistent-workspace')],
        env: {
            PATH: `${ghBin}${delimiter}${process.env.PATH}`,
            CLAUDIA_FAKE_GH_DIR: ghLogDir,
            // Explicitly unset so the "not configured" guards are what we assert,
            // regardless of the developer's real shell env.
            ELEVENLABS_API_KEY: undefined,
        },
    });

    repo = join(h.base, 'repo');
    makeGitRepo(repo);
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');

    noRemoteRepo = join(h.base, 'no-remote');
    makeGitRepo(noRemoteRepo);

    otherRemoteRepo = join(h.base, 'gitlab-repo');
    makeGitRepo(otherRemoteRepo);
    git(otherRemoteRepo, 'remote', 'add', 'origin', 'https://gitlab.com/acme/widgets.git');

    plainDir = join(h.base, 'plain');
    mkdirSync(plainDir, { recursive: true });
}, 60000);

afterAll(async () => {
    await h.stop();
    try {
        rmSync(ghBin, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
        // Ignore cleanup errors
    }
    delete process.env.CLAUDIA_FAKE_GH_FAIL;
}, 30000);

const q = encodeURIComponent;

describe.skipIf(!NEEDS_FAKE_GH)('GET /api/workspaces/ci-status', () => {
    it('400s on a missing workspace param and 404s on a path that does not exist', async () => {
        expect((await h.req('/api/workspaces/ci-status')).status).toBe(400);
        const missing = await h.req(`/api/workspaces/ci-status?workspace=${q(join(h.base, 'nope'))}`);
        expect(missing.status).toBe(404);
    });

    it('reports isGitRepo:false for a plain directory without shelling out to gh', async () => {
        const r = await h.req<any>(`/api/workspaces/ci-status?workspace=${q(plainDir)}`);
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ isGitRepo: false, checks: [], prNumber: null, prUrl: null });
    });

    it('reports "No remote origin" for a git repo with no remote', async () => {
        const r = await h.req<any>(`/api/workspaces/ci-status?workspace=${q(noRemoteRepo)}`);
        expect(r.status).toBe(200);
        expect(r.body.isGitRepo).toBe(true);
        expect(r.body.error).toBe('No remote origin');
    });

    it('reports "Not a GitHub repository" for a non-github remote', async () => {
        const r = await h.req<any>(`/api/workspaces/ci-status?workspace=${q(otherRemoteRepo)}`);
        expect(r.status).toBe(200);
        expect(r.body.error).toBe('Not a GitHub repository');
    });

    it('parses PR metadata, comments and checks from gh, mapping every check state', async () => {
        const r = await h.req<any>(`/api/workspaces/ci-status?workspace=${q(repo)}`);
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({
            isGitRepo: true,
            branch: 'main',
            owner: 'acme',
            repo: 'widgets',
            prNumber: 42,
            prUrl: 'https://github.com/acme/widgets/pull/42',
            prState: 'OPEN',
            prTitle: 'Add widgets',
            prBody: 'PR body text',
        });

        expect(r.body.prComments).toEqual([{
            author: 'octocat',
            body: 'looks good to me',
            createdAt: '2024-01-02T03:04:05Z',
            url: 'https://github.com/acme/widgets/pull/42#issuecomment-1',
        }]);

        // The state -> {status, conclusion} mapping table is pure logic that
        // had no coverage at all; assert each arm the fixture exercises.
        const byName = Object.fromEntries(r.body.checks.map((c: any) => [c.name, c]));
        expect(byName.build).toMatchObject({ status: 'completed', conclusion: 'success', url: 'https://github.com/acme/widgets/runs/1' });
        expect(byName.lint).toMatchObject({ status: 'completed', conclusion: 'failure' });
        expect(byName.e2e).toMatchObject({ status: 'pending', conclusion: null });
    }, 20000);

    it('degrades to a null PR when gh fails, instead of 500ing', async () => {
        process.env.CLAUDIA_FAKE_GH_FAIL = '1';
        try {
            const r = await h.req<any>(`/api/workspaces/ci-status?workspace=${q(repo)}`);
            expect(r.status).toBe(200);
            expect(r.body.prNumber).toBeNull();
            expect(r.body.checks).toEqual([]);
        } finally {
            delete process.env.CLAUDIA_FAKE_GH_FAIL;
        }
    }, 20000);
});

describe.skipIf(!NEEDS_FAKE_GH)('GET/POST/PATCH /api/workspaces/github-issues', () => {
    it('enforces the error contract before touching gh', async () => {
        expect((await h.req('/api/workspaces/github-issues')).status).toBe(400);
        expect((await h.req(`/api/workspaces/github-issues?workspace=${q(join(h.base, 'nope'))}`)).status).toBe(404);

        expect((await h.send('POST', '/api/workspaces/github-issues', { title: 'x' })).status).toBe(400);
        expect((await h.send('POST', '/api/workspaces/github-issues', { workspace: repo })).status).toBe(400);
        expect((await h.send('POST', '/api/workspaces/github-issues', { workspace: repo, title: '   ' })).status).toBe(400);
        expect((await h.send('POST', '/api/workspaces/github-issues', { workspace: join(h.base, 'nope'), title: 'x' })).status).toBe(404);

        expect((await h.send('PATCH', '/api/workspaces/github-issues/7', { state: 'closed' })).status).toBe(400);
        expect((await h.send('PATCH', '/api/workspaces/github-issues/abc', { workspace: repo, state: 'closed' })).status).toBe(400);
        expect((await h.send('PATCH', '/api/workspaces/github-issues/7', { workspace: repo, state: 'sideways' })).status).toBe(400);
        expect((await h.send('PATCH', '/api/workspaces/github-issues/7', { workspace: repo })).status).toBe(400);
    });

    it('returns isGitRepo:false for a plain directory', async () => {
        const r = await h.req<any>(`/api/workspaces/github-issues?workspace=${q(plainDir)}`);
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ isGitRepo: false, issues: [] });
    });

    it('lists issues parsed from gh', async () => {
        const r = await h.req<any>(`/api/workspaces/github-issues?workspace=${q(repo)}`);
        expect(r.status).toBe(200);
        expect(r.body.issues).toHaveLength(1);
        expect(r.body.issues[0]).toMatchObject({ number: 7, title: 'Widget falls over', state: 'OPEN' });
    }, 20000);

    it('surfaces a friendly error (not a 500) when the gh CLI is unusable', async () => {
        process.env.CLAUDIA_FAKE_GH_FAIL = '1';
        try {
            const r = await h.req<any>(`/api/workspaces/github-issues?workspace=${q(repo)}`);
            expect(r.status).toBe(200);
            expect(r.body.issues).toEqual([]);
            expect(String(r.body.error)).toContain('gh CLI');
        } finally {
            delete process.env.CLAUDIA_FAKE_GH_FAIL;
        }
    }, 20000);

    it('creates an issue and closes one through gh', async () => {
        const created = await h.send<any>('POST', '/api/workspaces/github-issues', { workspace: repo, title: 'New bug', body: 'details' });
        expect(created.status).toBe(200);

        const patched = await h.send<any>('PATCH', '/api/workspaces/github-issues/7', { workspace: repo, state: 'closed' });
        expect(patched.status).toBe(200);

        const log = readIf(join(ghLogDir, 'gh-args.log'));
        expect(log).toContain('issue create');
        expect(log).toContain('issue close');
    }, 20000);
});

describe.skipIf(!NEEDS_FAKE_GH)('/api/github/notifications', () => {
    it('400s without a valid workspace on both the list and the mark-read routes', async () => {
        expect((await h.req('/api/github/notifications')).status).toBe(400);
        expect((await h.req(`/api/github/notifications?workspace=${q(join(h.base, 'nope'))}`)).status).toBe(404);
        expect((await h.send('PATCH', '/api/github/notifications/1', {})).status).toBe(400);
        expect((await h.send('PATCH', '/api/github/notifications/1', { workspace: join(h.base, 'nope') })).status).toBe(400);
    });

    it('lists notifications from gh and marks a thread read', async () => {
        const r = await h.req<any>(`/api/github/notifications?workspace=${q(repo)}`);
        expect(r.status).toBe(200);
        expect(Array.isArray(r.body.notifications)).toBe(true);

        const patched = await h.send<any>('PATCH', '/api/github/notifications/1', { workspace: repo });
        expect(patched.status).toBe(200);
        expect(patched.body).toMatchObject({ success: true });
        expect(readIf(join(ghLogDir, 'gh-args.log'))).toContain('notifications/threads/1');
    }, 20000);

    it('reports the gh CLI as unavailable instead of 500ing', async () => {
        process.env.CLAUDIA_FAKE_GH_FAIL = '1';
        try {
            const r = await h.req<any>(`/api/github/notifications?workspace=${q(repo)}`);
            expect(r.status).toBe(200);
            expect(r.body.notifications).toEqual([]);
            expect(String(r.body.error)).toContain('gh CLI');
        } finally {
            delete process.env.CLAUDIA_FAKE_GH_FAIL;
        }
    }, 20000);
});

describe.skipIf(!NEEDS_FAKE_GH)('PATCH /api/workspaces/pr-description', () => {
    it('requires workspace and a string body', async () => {
        expect((await h.send('PATCH', '/api/workspaces/pr-description', { body: 'x' })).status).toBe(400);
        expect((await h.send('PATCH', '/api/workspaces/pr-description', { workspace: repo })).status).toBe(400);
        expect((await h.send('PATCH', '/api/workspaces/pr-description', { workspace: repo, body: 42 })).status).toBe(400);
    });

    it('writes the description through to the gh CLI boundary', async () => {
        rmSync(join(ghLogDir, 'pr-body.txt'), { force: true });
        const r = await h.send<any>('PATCH', '/api/workspaces/pr-description', { workspace: repo, body: 'NEW_PR_BODY_MARKER' });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ success: true });
        // Proves the body survived the temp-file round trip into `gh pr edit --body-file`.
        expect(readIf(join(ghLogDir, 'pr-body.txt'))).toContain('NEW_PR_BODY_MARKER');
    }, 20000);
});

describe('network-route guards (all return before any socket is opened)', () => {
    it('POST /api/tts refuses when ELEVENLABS_API_KEY is unset', async () => {
        const r = await h.send<any>('POST', '/api/tts', { text: 'hello' });
        // BUG (reported, not fixed here): a missing *server* config is a 500,
        // so the client cannot distinguish "TTS not set up" from "TTS crashed".
        // 501/503 would be the honest code. Pinned so a fix is a deliberate change.
        expect(r.status).toBe(500);
        expect(String(r.body.error)).toContain('ELEVENLABS_API_KEY');
    });

    it('POST /api/tts validates text and voice once a key is present', async () => {
        process.env.ELEVENLABS_API_KEY = 'fake-key-not-used';
        try {
            expect((await h.send('POST', '/api/tts', {})).status).toBe(400);
            expect((await h.send('POST', '/api/tts', { text: 42 })).status).toBe(400);
            const badVoice = await h.send<any>('POST', '/api/tts', { text: 'hi', voice: 'not-a-voice' });
            expect(badVoice.status).toBe(400);
            expect(String(badVoice.body.error)).toContain('Unknown voice');
        } finally {
            delete process.env.ELEVENLABS_API_KEY;
        }
    });

    it('elevenlabs voice routes refuse without a key', async () => {
        expect((await h.req('/api/elevenlabs/voices')).status).toBe(500);
        expect((await h.req('/api/elevenlabs/voices/abc/preview')).status).toBe(500);
    });

    it('hyperspace-proxy routes require proxyUrl and apiKey', async () => {
        for (const path of ['/api/hyperspace-proxy/test', '/api/hyperspace-proxy/models']) {
            const r = await h.send<any>('POST', path, { proxyUrl: 'https://example.invalid' });
            expect(r.status).toBe(400);
            expect(r.body).toMatchObject({ success: false });
            expect((await h.send(path === '/api/hyperspace-proxy/test' ? 'POST' : 'POST', path, {})).status).toBe(400);
        }
    });

    it('sap-ai-core/test requires clientId, clientSecret and authUrl', async () => {
        const r = await h.send<any>('POST', '/api/sap-ai-core/test', { clientId: 'a', clientSecret: 'b' });
        expect(r.status).toBe(400);
        expect(String(r.body.error)).toContain('Missing required credentials');
        expect((await h.send('POST', '/api/sap-ai-core/test', {})).status).toBe(400);
    });

    it('mcp/test requires a named server, and rejects an HTTP server with no url', async () => {
        expect((await h.send('POST', '/api/mcp/test', {})).status).toBe(400);
        expect((await h.send('POST', '/api/mcp/test', { server: {} })).status).toBe(400);
        const noUrl = await h.send<any>('POST', '/api/mcp/test', { server: { name: 'x', type: 'http' } });
        // NOTE: 200 with success:false, not 4xx — the route reports transport
        // problems in the body rather than the status line.
        expect(noUrl.status).toBe(200);
        expect(noUrl.body).toMatchObject({ success: false });
    });
});

describe('voice-agent config + tunnel status (local, no network)', () => {
    it('round-trips the voice agent system prompt', async () => {
        const before = await h.req<any>('/api/voice-agent/system-prompt');
        expect(before.status).toBe(200);
        expect(typeof before.body.systemPrompt).toBe('string');

        expect((await h.send('POST', '/api/voice-agent/system-prompt', {})).status).toBe(400);
        expect((await h.send('POST', '/api/voice-agent/system-prompt', { systemPrompt: 123 })).status).toBe(400);

        const set = await h.send<any>('POST', '/api/voice-agent/system-prompt', { systemPrompt: 'VOICE_PROMPT_MARKER' });
        expect(set.status).toBe(200);
        const after = await h.req<any>('/api/voice-agent/system-prompt');
        expect(after.body.systemPrompt).toBe('VOICE_PROMPT_MARKER');
    });

    it('lists voice agent tools', async () => {
        const r = await h.req<any>('/api/voice-agent/tools');
        expect(r.status).toBe(200);
        expect(Array.isArray(r.body.tools)).toBe(true);
    });

    it('reports an inactive tunnel', async () => {
        const r = await h.req<any>('/api/tunnel/status');
        expect(r.status).toBe(200);
        expect(r.body.active).toBe(false);
    });

    it('GET /voice denies access without a token', async () => {
        const res = await h.fetch('/voice');
        expect(res.status).toBe(401);
        expect(await res.text()).toContain('Access denied');
    });
});

describe('learn routes: 4xx guards (the LLM half is out of scope)', () => {
    it('404s for an unknown task and for a task with no session', async () => {
        expect((await h.send('POST', '/api/tasks/does-not-exist/learn', {})).status).toBe(404);
        const noSession = await h.send<any>('POST', `/api/tasks/${TASK_ID}/learn`, {});
        expect(noSession.status).toBe(404);
        expect(String(noSession.body.error)).toContain('no session');
    });

    it('learn/save rejects an empty or missing learnings array', async () => {
        expect((await h.send('POST', `/api/tasks/${TASK_ID}/learn/save`, {})).status).toBe(400);
        expect((await h.send('POST', `/api/tasks/${TASK_ID}/learn/save`, { learnings: [] })).status).toBe(400);
        expect((await h.send('POST', `/api/tasks/${TASK_ID}/learn/save`, { learnings: 'nope' })).status).toBe(400);
    });
});

/**
 * DELIBERATELY NOT COVERED HERE:
 *  - POST /api/browse-folder     opens a native OS folder picker; would hang CI.
 *  - POST /api/server/restart    calls gracefulShutdown -> process.exit.
 *  - POST /api/tunnel/start|stop start binds a real ngrok tunnel (network + auth).
 *  - GET  /api/voice/message/stream, POST /api/voice/message  real Anthropic + TTS calls.
 *  - the success half of tts / elevenlabs / hyperspace-proxy / sap-ai-core / mcp-test,
 *    all of which require a live third-party endpoint. Their guards are covered above.
 */
