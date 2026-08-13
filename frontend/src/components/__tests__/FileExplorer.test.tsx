/**
 * Behavioural tests for <FileExplorer />.
 *
 * Everything the panel does is a request to the backend, so each test installs
 * a tiny fake API router and then asserts on (a) what the user sees and (b)
 * which requests were actually issued — method, endpoint and payload.
 *
 * Queried by role / label / text / title only; never by CSS class.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileExplorer } from '../FileExplorer';
import { useTaskStore } from '../../stores/taskStore';

// This suite mounts a large component; under parallel CI load a single
// interaction can exceed the 5s default. File-scoped, so no shared config
// is touched.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const PRISTINE_STORE = useTaskStore.getState();
const WORKSPACE = '/repos/alpha';

// ── fake API ────────────────────────────────────────────────────────────────

interface ApiRequest {
    url: string;
    path: string;
    params: URLSearchParams;
    method: string;
    body: Record<string, unknown> | undefined;
}

interface ApiReply {
    ok?: boolean;
    status?: number;
    json?: unknown;
}

/**
 * Replace global.fetch with a router. `respond` returns the reply for a
 * request, or undefined for a generic empty 200. Returns the recorded calls so
 * tests can assert on exactly what was sent (and how many times).
 */
function installApi(respond: (req: ApiRequest) => ApiReply | undefined) {
    const calls: ApiRequest[] = [];
    const fetchMock = vi.fn(async (input: unknown, init: RequestInit = {}) => {
        const url = String(input);
        const parsed = new URL(url, 'http://localhost');
        let body: Record<string, unknown> | undefined;
        if (typeof init.body === 'string') {
            try { body = JSON.parse(init.body); } catch { body = undefined; }
        }
        const req: ApiRequest = {
            url,
            path: parsed.pathname,
            params: parsed.searchParams,
            method: (init.method || 'GET').toUpperCase(),
            body,
        };
        calls.push(req);
        const reply = respond(req) ?? {};
        const ok = reply.ok !== false;
        return {
            ok,
            status: reply.status ?? (ok ? 200 : 500),
            statusText: ok ? 'OK' : 'Error',
            json: async () => reply.json ?? {},
            text: async () => JSON.stringify(reply.json ?? {}),
        };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return { calls, fetchMock };
}

const ROOT_ITEMS = [
    { name: 'src', type: 'directory' as const, path: 'src', childCount: 2 },
    { name: 'README.md', type: 'file' as const, path: 'README.md', size: 2048 },
    { name: 'notes.txt', type: 'file' as const, path: 'notes.txt', size: 12 },
];

const SRC_CHILDREN = [
    { name: 'index.ts', type: 'file' as const, path: 'src/index.ts', size: 100 },
    { name: 'nested', type: 'directory' as const, path: 'src/nested', childCount: 0 },
];

/** Default router: a small file tree plus empty answers for everything else. */
function defaultRespond(req: ApiRequest): ApiReply | undefined {
    if (req.path === '/api/workspaces/files' && req.method === 'GET') {
        const sub = req.params.get('path');
        if (!sub) return { json: { items: ROOT_ITEMS } };
        if (sub === 'src') return { json: { items: SRC_CHILDREN } };
        return { json: { items: [] } };
    }
    return undefined;
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Testing Library only advances fake timers when a global `jest` object is
 * visible; without this shim its async wrapper awaits a `setTimeout` the fake
 * clock never fires and every `waitFor` deadlocks. Vitest interop shim only.
 */
const jestTimerShim = { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) };

function renderFileExplorer(
    { workspacePath = WORKSPACE, workspaceName = 'alpha', connected = true } = {},
) {
    useTaskStore.setState({ isConnected: connected });
    return render(<FileExplorer workspacePath={workspacePath} workspaceName={workspaceName} />);
}

/** Expand the collapsed rail so the tabbed panel is visible. */
function expandPanel() {
    fireEvent.click(screen.getByTitle('Expand file explorer'));
}

async function renderExpandedFilesTab(respond = defaultRespond) {
    const api = installApi(respond);
    renderFileExplorer();
    expandPanel();
    await screen.findByText('README.md');
    return api;
}

function requestsFor(calls: ApiRequest[], path: string, method = 'GET') {
    return calls.filter(c => c.path === path && c.method === method);
}

// ── suite ───────────────────────────────────────────────────────────────────

const spyOnConfirm = () => vi.spyOn(window, 'confirm').mockReturnValue(true);
const spyOnPrompt = () => vi.spyOn(window, 'prompt').mockReturnValue(null);
const spyOnAlert = () => vi.spyOn(window, 'alert').mockImplementation(() => {});

describe('FileExplorer', () => {
    let confirmSpy: ReturnType<typeof spyOnConfirm>;
    let promptSpy: ReturnType<typeof spyOnPrompt>;
    let alertSpy: ReturnType<typeof spyOnAlert>;

    beforeEach(() => {
        localStorage.clear();
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
        });
        (globalThis as Record<string, unknown>).jest = jestTimerShim;
        vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
        useTaskStore.setState({ ...PRISTINE_STORE, isConnected: true }, true);
        confirmSpy = spyOnConfirm();
        promptSpy = spyOnPrompt();
        alertSpy = spyOnAlert();
    });

    afterEach(() => {
        confirmSpy.mockRestore();
        promptSpy.mockRestore();
        alertSpy.mockRestore();
        vi.useRealTimers();
        delete (globalThis as Record<string, unknown>).jest;
        vi.restoreAllMocks();
    });

    // ── shell ───────────────────────────────────────────────────────────────

    it('renders nothing when no workspace is selected', () => {
        installApi(defaultRespond);
        const { container } = render(
            <FileExplorer workspacePath={undefined} workspaceName={undefined} />,
        );

        expect(container).toBeEmptyDOMElement();
    });

    it('starts collapsed and expands into the tabbed panel', async () => {
        installApi(defaultRespond);
        renderFileExplorer();

        expect(screen.getByTitle('Expand file explorer')).toBeInTheDocument();
        expect(screen.queryByTitle('Project Files')).not.toBeInTheDocument();

        expandPanel();

        expect(screen.getByText('alpha')).toBeInTheDocument();
        for (const tab of ['Project Files', 'Git Changes', 'Pull Request', 'GitHub Issues', 'GitHub Notifications']) {
            expect(screen.getByTitle(tab)).toBeInTheDocument();
        }

        fireEvent.click(screen.getByTitle('Collapse'));
        expect(screen.getByTitle('Expand file explorer')).toBeInTheDocument();
    });

    it('does not fetch anything while the websocket is disconnected', async () => {
        const { calls } = installApi(defaultRespond);
        renderFileExplorer({ connected: false });
        expandPanel();

        await Promise.resolve();
        expect(calls).toHaveLength(0);
    });

    // ── files tab ───────────────────────────────────────────────────────────

    it('lists the workspace root once expanded', async () => {
        const { calls } = await renderExpandedFilesTab();

        expect(screen.getByText('src')).toBeInTheDocument();
        expect(screen.getByText('README.md')).toBeInTheDocument();
        expect(screen.getByText('notes.txt')).toBeInTheDocument();
        // Sizes are humanised.
        expect(screen.getByText('2.0 KB')).toBeInTheDocument();

        const listings = requestsFor(calls, '/api/workspaces/files');
        expect(listings[0].params.get('workspace')).toBe(WORKSPACE);
        expect(listings[0].params.has('path')).toBe(false);
    });

    /**
     * Characterisation test for a live defect: FilesTab has two mount effects
     * that can each call loadRootFiles(). Both run in the same commit, so the
     * second still sees `loading === false` / `hasLoaded === false` and fires a
     * duplicate request. Every mount (and every workspace switch) therefore
     * issues the root listing twice. Locked in here so a fix is visible.
     */
    it('issues the root listing twice on mount (known duplicate-request defect)', async () => {
        const { calls } = await renderExpandedFilesTab();

        expect(requestsFor(calls, '/api/workspaces/files')).toHaveLength(2);
    });

    it('lazily loads a directory once and reuses the cached children', async () => {
        const { calls } = await renderExpandedFilesTab();

        expect(screen.queryByText('index.ts')).not.toBeInTheDocument();

        fireEvent.click(screen.getByText('src'));
        await screen.findByText('index.ts');
        expect(screen.getByText('nested')).toBeInTheDocument();

        const childLoads = () =>
            requestsFor(calls, '/api/workspaces/files').filter(c => c.params.get('path') === 'src');
        expect(childLoads()).toHaveLength(1);

        // Collapse then re-expand: children come back with no second request.
        fireEvent.click(screen.getByText('src'));
        expect(screen.queryByText('index.ts')).not.toBeInTheDocument();

        fireEvent.click(screen.getByText('src'));
        expect(screen.getByText('index.ts')).toBeInTheDocument();
        expect(childLoads()).toHaveLength(1);
    });

    it('shows an "empty directory" hint for a folder with no children', async () => {
        await renderExpandedFilesTab(req => {
            if (req.path === '/api/workspaces/files') {
                return req.params.get('path')
                    ? { json: { items: [] } }
                    : { json: { items: ROOT_ITEMS } };
            }
            return undefined;
        });

        fireEvent.click(screen.getByText('src'));
        await screen.findByText('Empty directory');
    });

    it('opens a file in the content modal on double click', async () => {
        await renderExpandedFilesTab(req => {
            if (req.path === '/api/workspaces/read-file') {
                return { json: { content: 'the file body' } };
            }
            return defaultRespond(req);
        });

        const file = screen.getByText('notes.txt');
        fireEvent.click(file);
        fireEvent.click(file);

        await screen.findByText('the file body');
        // The modal owns these controls; the tree does not.
        expect(screen.getByTitle('Copy to clipboard')).toBeInTheDocument();

        fireEvent.click(screen.getByTitle('Close'));
        expect(screen.queryByText('the file body')).not.toBeInTheDocument();
    });

    it('surfaces a listing error from the backend', async () => {
        installApi(req => {
            if (req.path === '/api/workspaces/files') {
                return { ok: false, json: { error: 'permission denied' } };
            }
            return undefined;
        });
        renderFileExplorer();
        expandPanel();

        await screen.findByText('permission denied');
    });

    it('reloads the listing when refresh is pressed', async () => {
        const { calls } = await renderExpandedFilesTab();
        const before = requestsFor(calls, '/api/workspaces/files').length;

        fireEvent.click(screen.getAllByTitle('Refresh')[0]);

        await waitFor(() =>
            expect(requestsFor(calls, '/api/workspaces/files')).toHaveLength(before + 1),
        );
    });

    // ── files tab: context menu ─────────────────────────────────────────────

    it('opens a context menu with the file actions on right click', async () => {
        await renderExpandedFilesTab();

        fireEvent.contextMenu(screen.getByText('notes.txt'));

        for (const label of ['Show in Finder', 'Copy', 'Move/Rename', 'Delete']) {
            expect(screen.getByText(label)).toBeInTheDocument();
        }
    });

    it('reveals a file in the OS file manager', async () => {
        const { calls } = await renderExpandedFilesTab();

        fireEvent.contextMenu(screen.getByText('notes.txt'));
        fireEvent.click(screen.getByText('Show in Finder'));

        await waitFor(() => {
            const reveals = requestsFor(calls, '/api/workspaces/files/reveal', 'POST');
            expect(reveals).toHaveLength(1);
            expect(reveals[0].body).toEqual({ workspace: WORKSPACE, path: 'notes.txt' });
        });
    });

    it('renames a file only when the rename prompt is answered', async () => {
        const { calls } = await renderExpandedFilesTab();
        const listingsBefore = requestsFor(calls, '/api/workspaces/files').length;

        // Cancelled prompt: nothing is sent.
        promptSpy.mockReturnValue(null);
        fireEvent.contextMenu(screen.getByText('notes.txt'));
        fireEvent.click(screen.getByText('Move/Rename'));
        await waitFor(() =>
            expect(requestsFor(calls, '/api/workspaces/files/move', 'POST')).toHaveLength(0),
        );

        // Confirmed prompt: the move request carries the new destination.
        promptSpy.mockReturnValue('renamed.txt');
        fireEvent.contextMenu(screen.getByText('notes.txt'));
        fireEvent.click(screen.getByText('Move/Rename'));

        await waitFor(() => {
            const moves = requestsFor(calls, '/api/workspaces/files/move', 'POST');
            expect(moves).toHaveLength(1);
            expect(moves[0].body).toEqual({
                workspace: WORKSPACE,
                sourcePath: 'notes.txt',
                destinationPath: 'renamed.txt',
            });
        });
        // A successful move re-lists the directory.
        await waitFor(() =>
            expect(requestsFor(calls, '/api/workspaces/files'))
                .toHaveLength(listingsBefore + 1),
        );
    });

    it('keeps a nested file in its own directory when renaming', async () => {
        const { calls } = await renderExpandedFilesTab();

        fireEvent.click(screen.getByText('src'));
        await screen.findByText('index.ts');
        const listingsBefore = requestsFor(calls, '/api/workspaces/files').length;

        promptSpy.mockReturnValue('main.ts');
        fireEvent.contextMenu(screen.getByText('index.ts'));
        fireEvent.click(screen.getByText('Move/Rename'));

        await waitFor(() => {
            const moves = requestsFor(calls, '/api/workspaces/files/move', 'POST');
            expect(moves[0].body).toMatchObject({
                sourcePath: 'src/index.ts',
                destinationPath: 'src/main.ts',
            });
        });
        await waitFor(() =>
            expect(requestsFor(calls, '/api/workspaces/files'))
                .toHaveLength(listingsBefore + 1),
        );
    });

    it('copies a file to the name given in the prompt', async () => {
        const { calls } = await renderExpandedFilesTab();
        const listingsBefore = requestsFor(calls, '/api/workspaces/files').length;

        promptSpy.mockReturnValue('notes-copy.txt');
        fireEvent.contextMenu(screen.getByText('notes.txt'));
        fireEvent.click(screen.getByText('Copy'));

        await waitFor(() => {
            const copies = requestsFor(calls, '/api/workspaces/files/copy', 'POST');
            expect(copies).toHaveLength(1);
            expect(copies[0].body).toEqual({
                workspace: WORKSPACE,
                sourcePath: 'notes.txt',
                destinationPath: 'notes-copy.txt',
            });
        });
        await waitFor(() =>
            expect(requestsFor(calls, '/api/workspaces/files'))
                .toHaveLength(listingsBefore + 1),
        );
    });

    it('deletes a file only after the confirmation is accepted', async () => {
        const { calls } = await renderExpandedFilesTab();
        const listingsBefore = requestsFor(calls, '/api/workspaces/files').length;

        confirmSpy.mockReturnValue(false);
        fireEvent.contextMenu(screen.getByText('notes.txt'));
        fireEvent.click(screen.getByText('Delete'));
        await waitFor(() =>
            expect(requestsFor(calls, '/api/workspaces/files', 'DELETE')).toHaveLength(0),
        );

        confirmSpy.mockReturnValue(true);
        fireEvent.contextMenu(screen.getByText('notes.txt'));
        fireEvent.click(screen.getByText('Delete'));

        await waitFor(() => {
            const deletes = requestsFor(calls, '/api/workspaces/files', 'DELETE');
            expect(deletes).toHaveLength(1);
            expect(deletes[0].body).toEqual({ workspace: WORKSPACE, path: 'notes.txt' });
        });
        // A successful delete refreshes the listing.
        await waitFor(() =>
            expect(requestsFor(calls, '/api/workspaces/files'))
                .toHaveLength(listingsBefore + 1),
        );
    });

    it('reports a failed delete instead of silently refreshing', async () => {
        const { calls } = await renderExpandedFilesTab(req => {
            if (req.path === '/api/workspaces/files' && req.method === 'DELETE') {
                return { ok: false, json: { error: 'file is locked' } };
            }
            return defaultRespond(req);
        });

        const listingsBefore = requestsFor(calls, '/api/workspaces/files').length;
        fireEvent.contextMenu(screen.getByText('notes.txt'));
        fireEvent.click(screen.getByText('Delete'));

        await waitFor(() =>
            expect(alertSpy).toHaveBeenCalledWith('Failed to delete: file is locked'),
        );
        expect(requestsFor(calls, '/api/workspaces/files')).toHaveLength(listingsBefore);
    });

    // ── changes tab ─────────────────────────────────────────────────────────

    const GIT_STATUS = {
        isGitRepo: true,
        branch: 'feature/login',
        ahead: 2,
        behind: 1,
        changes: [
            { path: 'src/index.ts', status: 'modified', staged: true },
            { path: 'src/new.ts', status: 'added', staged: false },
            { path: 'src/gone.ts', status: 'deleted', staged: false },
        ],
    };

    const GIT_LOG = {
        commits: [
            {
                hash: 'abc123def', shortHash: 'abc123', author: 'Kalin',
                date: '2026-01-01T12:00:00.000Z', message: 'add the login flow',
            },
        ],
    };

    function gitRespond(req: ApiRequest): ApiReply | undefined {
        if (req.path === '/api/workspaces/git-status') return { json: GIT_STATUS };
        if (req.path === '/api/workspaces/git-log') return { json: GIT_LOG };
        if (req.path === '/api/workspaces/git-diff') return { json: { diff: '@@ -1 +1 @@\n+new line' } };
        return defaultRespond(req);
    }

    it('shows branch, staged/unstaged changes and history on the Changes tab', async () => {
        installApi(gitRespond);
        renderFileExplorer();
        expandPanel();
        fireEvent.click(screen.getByTitle('Git Changes'));

        await screen.findByText('feature/login');
        // One staged section, and the two unstaged entries below it. ("Changes"
        // is not asserted by name because the tab button carries the same text.)
        expect(screen.getByText('Staged')).toBeInTheDocument();
        expect(screen.getByText('History')).toBeInTheDocument();
        expect(screen.getByText('src/index.ts')).toBeInTheDocument();
        expect(screen.getByText('src/new.ts')).toBeInTheDocument();
        expect(screen.getByText('src/gone.ts')).toBeInTheDocument();
        await screen.findByText('add the login flow');
    });

    it('collapses a section of the Changes tab', async () => {
        installApi(gitRespond);
        renderFileExplorer();
        expandPanel();
        fireEvent.click(screen.getByTitle('Git Changes'));
        await screen.findByText('src/index.ts');

        fireEvent.click(screen.getByText('Staged'));
        expect(screen.queryByText('src/index.ts')).not.toBeInTheDocument();
        expect(screen.getByText('src/new.ts')).toBeInTheDocument();
    });

    it('opens a diff for a tracked change but not for a deleted file', async () => {
        installApi(gitRespond);
        renderFileExplorer();
        expandPanel();
        fireEvent.click(screen.getByTitle('Git Changes'));
        await screen.findByText('src/index.ts');

        fireEvent.click(screen.getByText('src/gone.ts'));
        expect(screen.queryByTitle('Close')).not.toBeInTheDocument();

        fireEvent.click(screen.getByText('src/index.ts'));
        await screen.findByText('+new line');
        expect(screen.getByTitle('Close')).toBeInTheDocument();
    });

    it('reports a repository that is not a git checkout', async () => {
        installApi(req => {
            if (req.path === '/api/workspaces/git-status') {
                return { json: { isGitRepo: false, branch: null, changes: [], ahead: 0, behind: 0 } };
            }
            return defaultRespond(req);
        });
        renderFileExplorer();
        expandPanel();
        fireEvent.click(screen.getByTitle('Git Changes'));

        await screen.findByText('Not a git repository');
    });

    // ── PR tab ──────────────────────────────────────────────────────────────

    it('shows the PR summary and its checks', async () => {
        installApi(req => {
            if (req.path === '/api/workspaces/ci-status') {
                return {
                    json: {
                        isGitRepo: true,
                        branch: 'feature/login',
                        prNumber: 42,
                        prUrl: 'https://github.com/o/r/pull/42',
                        prState: 'OPEN',
                        prTitle: 'Add the login flow',
                        prBody: 'Body text',
                        prComments: [],
                        checks: [
                            { name: 'build', status: 'completed', conclusion: 'success', startedAt: null, completedAt: null, url: null },
                            { name: 'lint', status: 'completed', conclusion: 'failure', startedAt: null, completedAt: null, url: 'https://ci/lint' },
                            { name: 'e2e', status: 'in_progress', conclusion: null, startedAt: null, completedAt: null, url: null },
                        ],
                    },
                };
            }
            return defaultRespond(req);
        });
        renderFileExplorer();
        expandPanel();
        fireEvent.click(screen.getByTitle('Pull Request'));

        await screen.findByText('PR #42');
        expect(screen.getByText('Add the login flow')).toBeInTheDocument();
        expect(screen.getByText('1 passed')).toBeInTheDocument();
        expect(screen.getByText('1 failed')).toBeInTheDocument();
        expect(screen.getByText('1 running')).toBeInTheDocument();
    });

    it('says so when the branch has no pull request', async () => {
        installApi(req => {
            if (req.path === '/api/workspaces/ci-status') {
                return { json: { isGitRepo: true, branch: 'main', prNumber: null, prUrl: null, checks: [] } };
            }
            return defaultRespond(req);
        });
        renderFileExplorer();
        expandPanel();
        fireEvent.click(screen.getByTitle('Pull Request'));

        await screen.findByText('No PR found for this branch');
    });

    // ── issues tab ──────────────────────────────────────────────────────────

    const ISSUES = {
        isGitRepo: true,
        owner: 'extropolis',
        repo: 'claudia',
        issues: [
            {
                number: 7, title: 'Terminal flickers on resize', state: 'OPEN',
                url: 'https://github.com/extropolis/claudia/issues/7',
                createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T06:00:00.000Z',
                closedAt: null, author: { login: 'kalin' }, assignees: [],
                labels: [{ name: 'bug', color: 'ff0000' }], comments: 3, body: '',
            },
        ],
    };

    it('lists GitHub issues and refetches when the state filter changes', async () => {
        const { calls } = installApi(req => {
            if (req.path === '/api/workspaces/github-issues') return { json: ISSUES };
            return defaultRespond(req);
        });
        renderFileExplorer();
        expandPanel();
        fireEvent.click(screen.getByTitle('GitHub Issues'));

        await screen.findByText('Terminal flickers on resize');
        expect(screen.getByText('extropolis/claudia')).toBeInTheDocument();
        expect(screen.getByText('bug')).toBeInTheDocument();

        const before = requestsFor(calls, '/api/workspaces/github-issues').length;
        fireEvent.click(screen.getByTitle('Closed issues'));

        await waitFor(() => {
            const after = requestsFor(calls, '/api/workspaces/github-issues');
            expect(after.length).toBeGreaterThan(before);
            expect(after[after.length - 1].params.get('state')).toBe('closed');
        });
    });

    it('creates an issue from the inline composer', async () => {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime, delay: null });
        const { calls } = installApi(req => {
            if (req.path === '/api/workspaces/github-issues') {
                return req.method === 'POST' ? { json: { number: 8 } } : { json: ISSUES };
            }
            return defaultRespond(req);
        });
        renderFileExplorer();
        expandPanel();
        fireEvent.click(screen.getByTitle('GitHub Issues'));
        await screen.findByText('Terminal flickers on resize');

        await user.type(
            screen.getByPlaceholderText(/create new issue/i),
            'Add keyboard shortcuts{Enter}',
        );

        await waitFor(() => {
            const posts = requestsFor(calls, '/api/workspaces/github-issues', 'POST');
            expect(posts).toHaveLength(1);
            expect(posts[0].body).toMatchObject({
                workspace: WORKSPACE,
                title: 'Add keyboard shortcuts',
            });
        });
    });

    it('closes an issue from its checkbox', async () => {
        const { calls } = installApi(req => {
            if (req.path.startsWith('/api/workspaces/github-issues/')) return { json: { ok: true } };
            if (req.path === '/api/workspaces/github-issues') return { json: ISSUES };
            return defaultRespond(req);
        });
        renderFileExplorer();
        expandPanel();
        fireEvent.click(screen.getByTitle('GitHub Issues'));
        await screen.findByText('Terminal flickers on resize');

        fireEvent.click(screen.getByTitle('Close issue'));

        await waitFor(() => {
            const patches = calls.filter(c => c.path === '/api/workspaces/github-issues/7');
            expect(patches).toHaveLength(1);
            expect(patches[0].body).toMatchObject({ state: 'closed' });
        });
    });

    // ── inbox tab ───────────────────────────────────────────────────────────

    const NOTIFICATIONS = {
        notifications: [
            {
                id: 'n1', reason: 'review_requested', unread: true,
                updatedAt: '2026-01-01T18:00:00.000Z', lastReadAt: null,
                subject: {
                    title: 'Review claudia#42', type: 'PullRequest',
                    url: 'https://api/x', htmlUrl: 'https://github.com/o/r/pull/42',
                },
                repository: { fullName: 'extropolis/claudia', htmlUrl: 'https://github.com/o/r' },
            },
        ],
    };

    it('lists notifications, badges the tab and marks one as read', async () => {
        const { calls } = installApi(req => {
            if (req.path.startsWith('/api/github/notifications')) return { json: NOTIFICATIONS };
            return defaultRespond(req);
        });
        renderFileExplorer();
        expandPanel();
        fireEvent.click(screen.getByTitle('GitHub Notifications'));

        await screen.findByText('Review claudia#42');
        expect(screen.getByText('1 unread')).toBeInTheDocument();
        expect(screen.getByText('review')).toBeInTheDocument();
        // Unread count is mirrored onto the tab itself.
        expect(within(screen.getByTitle('GitHub Notifications')).getByText('1')).toBeInTheDocument();

        fireEvent.click(screen.getByTitle('Mark as read'));

        await waitFor(() => {
            const patches = calls.filter(c => c.path === '/api/github/notifications/n1');
            expect(patches).toHaveLength(1);
            expect(patches[0].method).toBe('PATCH');
        });
        await waitFor(() => expect(screen.getByText('0 unread')).toBeInTheDocument());
    });

    it('shows the backend error when notifications cannot be fetched', async () => {
        installApi(req => {
            if (req.path.startsWith('/api/github/notifications')) {
                return { json: { notifications: [], error: 'gh not authenticated' } };
            }
            return defaultRespond(req);
        });
        renderFileExplorer();
        expandPanel();
        fireEvent.click(screen.getByTitle('GitHub Notifications'));

        await screen.findByText('gh not authenticated');
    });
});
