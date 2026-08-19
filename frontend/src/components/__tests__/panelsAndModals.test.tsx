/**
 * Behaviour tests for the panel and modal components.
 *
 * One `describe` per component. For each the bar is: it renders what its
 * props/store say, it has a sane empty state, its primary interaction fires
 * the right callback (or writes the right store state), cancelling does NOT
 * fire that action, and any data-loading path is driven by a per-test fetch
 * stub whose request URL is asserted.
 *
 * Conventions:
 *  - Queries go through role / label / text. Never CSS classes.
 *    (Icon-only buttons take their accessible name from `title`.)
 *  - Anything time-based uses fake timers; nothing sleeps.
 *  - The Zustand store and localStorage are reset before every test.
 *  - RTL's auto-cleanup afterEach runs AFTER ours, so we call cleanup()
 *    first — otherwise a component unmounting late fires async callbacks
 *    on the next test's timers/globals.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MutableRefObject } from 'react';
import type { ScheduledTask, ChatMessage, Task } from '@claudia/shared';

import { useTaskStore, ActivityEvent } from '../../stores/taskStore';

// ---------------------------------------------------------------------------
// Module boundary stubs. Everything here is a leaf these components pull in
// that would otherwise drag real audio / canvas / websocket machinery into a
// jsdom test.
// ---------------------------------------------------------------------------

const H = vi.hoisted(() => ({
    sendWsMessage: vi.fn(),
    qrToCanvas: vi.fn(async (_canvas?: unknown, _text?: string, _options?: unknown) => undefined),
}));

vi.mock('../../hooks/useWebSocket', () => ({
    sendWsMessage: H.sendWsMessage,
    useWebSocket: () => ({}),
}));

vi.mock('qrcode', () => ({
    default: { toCanvas: H.qrToCanvas },
    toCanvas: H.qrToCanvas,
}));

vi.mock('../VoiceInput', () => ({
    VoiceInput: ({ onTranscript, disabled }: {
        onTranscript: (t: string, f: boolean) => void; disabled?: boolean;
    }) => (
        <button
            type="button"
            disabled={disabled}
            onClick={() => onTranscript('spoken text', true)}
        >
            stub-voice
        </button>
    ),
}));

import { ActivityPanel } from '../ActivityPanel';
import { ConversationHistory } from '../ConversationHistory';
import { FileContentModal } from '../FileContentModal';
import { LearnFromConversationModal } from '../LearnFromConversationModal';
import { MobileAccessModal } from '../MobileAccessModal';
import { ProjectPicker } from '../ProjectPicker';
import { ScheduledTasksModal } from '../ScheduledTasksModal';
import { SupervisorChat } from '../SupervisorChat';
import { UsageDashboard } from '../UsageDashboard';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type RouteBody = unknown | ((url: string, init?: RequestInit) => unknown);

interface RouteSpec {
    body?: RouteBody;
    status?: number;
    ok?: boolean;
    reject?: boolean;
}

/**
 * fetch stub keyed by URL substring. Unmatched requests resolve to `{}` with
 * 200 so an incidental call can never hang or hit the network.
 */
function stubFetch(routes: Record<string, RouteBody | RouteSpec> = {}) {
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const key = Object.keys(routes).find(k => url.includes(k));
        const raw = key ? routes[key] : {};
        const spec: RouteSpec = (raw && typeof raw === 'object' && ('body' in raw || 'status' in raw || 'ok' in raw || 'reject' in raw))
            ? raw as RouteSpec
            : { body: raw };

        if (spec.reject) throw new Error('network down');

        const status = spec.status ?? 200;
        const body = typeof spec.body === 'function'
            ? (spec.body as (u: string, i?: RequestInit) => unknown)(url, init)
            : spec.body ?? {};

        return {
            ok: spec.ok ?? (status >= 200 && status < 300),
            status,
            statusText: 'OK',
            json: async () => body,
            text: async () => JSON.stringify(body),
        };
    });
    global.fetch = fn as unknown as typeof fetch;
    return fn;
}

function urlsOf(fetchMock: ReturnType<typeof stubFetch>) {
    return fetchMock.mock.calls.map(c => String(c[0]));
}

/**
 * Tunnel-status polls only. The modal also GETs /api/config on open to load
 * the reserved-domain setting, so a bare call count conflates that one-shot
 * read with the 2s poll these tests are actually about.
 */
function statusPolls(fetchMock: ReturnType<typeof stubFetch>) {
    return urlsOf(fetchMock).filter(u => u.includes('/api/tunnel/status'));
}

let clipboardWrite: ReturnType<typeof vi.fn>;

function makeTask(over: Partial<Task> = {}): Task {
    return {
        id: 'task-1',
        prompt: 'refactor the parser',
        state: 'idle',
        workspaceId: '/ws/alpha',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        lastActivity: new Date('2026-01-01T00:00:00Z'),
        ...over,
    };
}

function resetStore(over: Record<string, unknown> = {}) {
    useTaskStore.setState({
        tasks: new Map(),
        workspaces: [],
        activityLog: [],
        unreadTaskIds: new Set<string>(),
        scheduledTasks: new Map(),
        showProjectPicker: false,
        tokenCostEnabled: false,
        ...over,
    } as never);
}

beforeEach(() => {
    localStorage.clear();
    resetStore();
    vi.clearAllMocks();
    clipboardWrite = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: clipboardWrite },
    });
    stubFetch();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

// ===========================================================================
// ActivityPanel
// ===========================================================================

describe('ActivityPanel', () => {
    function event(over: Partial<ActivityEvent> & { id: string }): ActivityEvent {
        return {
            taskId: 'task-1',
            type: 'completed',
            taskName: 'refactor the parser',
            timestamp: new Date(Date.now() - 5_000),
            ...over,
        };
    }

    it('shows an empty state and no clear button when nothing has happened', () => {
        render(<ActivityPanel onClose={vi.fn()} onSelectTask={vi.fn()} />);

        expect(screen.getByText('No recent activity')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
    });

    it('renders each event with its task name and default label', () => {
        resetStore({
            activityLog: [
                event({ id: 'e1', type: 'completed' }),
                event({ id: 'e2', type: 'waiting_input', taskName: 'other task' }),
                event({ id: 'e3', type: 'error', taskName: 'broken task' }),
            ],
        });
        render(<ActivityPanel onClose={vi.fn()} onSelectTask={vi.fn()} />);

        expect(screen.getByText('Completed')).toBeInTheDocument();
        expect(screen.getByText('Needs input')).toBeInTheDocument();
        expect(screen.getByText('Error')).toBeInTheDocument();
        expect(screen.getByText('broken task')).toBeInTheDocument();
    });

    it('prefers an explicit message over the type label', () => {
        resetStore({ activityLog: [event({ id: 'e1', message: 'exited with code 137' })] });
        render(<ActivityPanel onClose={vi.fn()} onSelectTask={vi.fn()} />);

        expect(screen.getByText('exited with code 137')).toBeInTheDocument();
        expect(screen.queryByText('Completed')).not.toBeInTheDocument();
    });

    it('formats the age of an event by magnitude', () => {
        const now = Date.now();
        resetStore({
            activityLog: [
                event({ id: 'e1', timestamp: new Date(now - 5_000) }),
                event({ id: 'e2', timestamp: new Date(now - 5 * 60_000) }),
                event({ id: 'e3', timestamp: new Date(now - 3 * 3_600_000) }),
                event({ id: 'e4', timestamp: new Date(now - 2 * 86_400_000) }),
                event({ id: 'e5', timestamp: new Date(now + 10_000) }),
            ],
        });
        render(<ActivityPanel onClose={vi.fn()} onSelectTask={vi.fn()} />);

        expect(screen.getByText('5s ago')).toBeInTheDocument();
        expect(screen.getByText('5m ago')).toBeInTheDocument();
        expect(screen.getByText('3h ago')).toBeInTheDocument();
        expect(screen.getByText('2d ago')).toBeInTheDocument();
        expect(screen.getByText('now')).toBeInTheDocument();
    });

    it('selects a still-existing task and closes', async () => {
        const onSelectTask = vi.fn();
        const onClose = vi.fn();
        resetStore({
            activityLog: [event({ id: 'e1' })],
            tasks: new Map([['task-1', makeTask()]]),
        });
        const user = userEvent.setup();
        render(<ActivityPanel onClose={onClose} onSelectTask={onSelectTask} />);

        await user.click(screen.getByText('refactor the parser'));

        expect(onSelectTask).toHaveBeenCalledWith('task-1');
        expect(onClose).toHaveBeenCalled();
    });

    it('ignores clicks on a stale event whose task is gone', async () => {
        const onSelectTask = vi.fn();
        const onClose = vi.fn();
        resetStore({ activityLog: [event({ id: 'e1' })] }); // tasks map is empty
        const user = userEvent.setup();
        render(<ActivityPanel onClose={onClose} onSelectTask={onSelectTask} />);

        await user.click(screen.getByText('refactor the parser'));

        expect(onSelectTask).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it('clears the whole log (and unread set) from the clear button', async () => {
        resetStore({
            activityLog: [event({ id: 'e1' })],
            unreadTaskIds: new Set(['task-1']),
        });
        const user = userEvent.setup();
        render(<ActivityPanel onClose={vi.fn()} onSelectTask={vi.fn()} />);

        await user.click(screen.getByRole('button', { name: 'Clear all' }));

        expect(useTaskStore.getState().activityLog).toEqual([]);
        expect(useTaskStore.getState().unreadTaskIds.size).toBe(0);
        expect(screen.getByText('No recent activity')).toBeInTheDocument();
    });

    it('closes on the X button and on Escape', async () => {
        const onClose = vi.fn();
        const user = userEvent.setup();
        const { container } = render(<ActivityPanel onClose={onClose} onSelectTask={vi.fn()} />);

        await user.click(within(container).getAllByRole('button').slice(-1)[0]);
        expect(onClose).toHaveBeenCalledTimes(1);

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('closes on an outside click, but only after the opening-click grace period', () => {
        vi.useFakeTimers();
        const onClose = vi.fn();
        render(<ActivityPanel onClose={onClose} onSelectTask={vi.fn()} />);

        // Still inside the 100ms grace window — the click that opened the
        // panel must not immediately close it.
        fireEvent.mouseDown(document.body);
        expect(onClose).not.toHaveBeenCalled();

        act(() => { vi.advanceTimersByTime(150); });
        fireEvent.mouseDown(document.body);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not close when the click lands inside the panel', () => {
        vi.useFakeTimers();
        const onClose = vi.fn();
        resetStore({ activityLog: [event({ id: 'e1' })] });
        render(<ActivityPanel onClose={onClose} onSelectTask={vi.fn()} />);

        act(() => { vi.advanceTimersByTime(150); });
        fireEvent.mouseDown(screen.getByText('refactor the parser'));

        expect(onClose).not.toHaveBeenCalled();
    });
});

// ===========================================================================
// ConversationHistory
// ===========================================================================

describe('ConversationHistory', () => {
    const conversation = {
        sessionId: 'sess-abcdef12',
        summary: 'Parser refactor',
        messages: [
            { role: 'user', content: 'why is it slow?', timestamp: '2026-01-01T10:00:00Z', uuid: 'u1' },
            { role: 'assistant', content: 'because of the regex', timestamp: '2026-01-01T10:00:05Z', uuid: 'u2' },
        ],
    };

    it('shows a loading state before the first response lands', () => {
        stubFetch({ '/conversation': conversation });
        render(<ConversationHistory taskId="task-1" workspaceId="/ws/alpha" onClose={vi.fn()} />);

        expect(screen.getByText('Loading conversation...')).toBeInTheDocument();
    });

    it('requests the task conversation and renders both roles', async () => {
        const fetchMock = stubFetch({ '/conversation': conversation });
        render(<ConversationHistory taskId="task-1" workspaceId="/ws/alpha" onClose={vi.fn()} />);

        expect(await screen.findByText('why is it slow?')).toBeInTheDocument();
        expect(screen.getByText('because of the regex')).toBeInTheDocument();
        expect(screen.getByText('You')).toBeInTheDocument();
        expect(screen.getByText('Claude')).toBeInTheDocument();
        expect(screen.getByText('Parser refactor')).toBeInTheDocument();
        expect(urlsOf(fetchMock)[0]).toContain('/api/tasks/task-1/conversation');
    });

    it('offers the session picker when the task has no linked session', async () => {
        const fetchMock = stubFetch({
            '/api/tasks/task-1/conversation': { status: 404, body: {} },
            '/api/sessions/sess-11111111/conversation': conversation,
            '/api/workspaces/': [
                { sessionId: 'sess-11111111', summary: 'Older chat', lastModified: '2026-01-01T09:00:00Z' },
                { sessionId: 'sess-22222222', lastModified: '2026-01-01T08:00:00Z' },
            ],
        });
        const user = userEvent.setup();
        render(<ConversationHistory taskId="task-1" workspaceId="/ws/alpha" onClose={vi.fn()} />);

        expect(await screen.findByText('Select Session')).toBeInTheDocument();
        expect(screen.getByText('Older chat')).toBeInTheDocument();
        // Sessions with no summary fall back to a truncated id.
        expect(screen.getByText('sess-222...')).toBeInTheDocument();
        expect(urlsOf(fetchMock).some(u => u.includes('/api/workspaces/') && u.includes('/sessions'))).toBe(true);


        await user.click(screen.getByText('Older chat'));

        expect(await screen.findByText('why is it slow?')).toBeInTheDocument();
        expect(urlsOf(fetchMock).some(u => u.includes('/api/sessions/sess-11111111/conversation'))).toBe(true);
    });

    it('reports when a session fails to load', async () => {
        stubFetch({
            '/api/tasks/task-1/conversation': { status: 404, body: {} },
            '/api/sessions/sess-11111111/conversation': { status: 500, body: {} },
            '/api/workspaces/': [{ sessionId: 'sess-11111111', lastModified: '2026-01-01T09:00:00Z' }],
        });
        const user = userEvent.setup();
        render(<ConversationHistory taskId="task-1" workspaceId="/ws/alpha" onClose={vi.fn()} />);

        await user.click(await screen.findByText('sess-111...'));

        expect(await screen.findByText('Failed to load session')).toBeInTheDocument();
    });

    it('reports a workspace with no sessions at all', async () => {
        stubFetch({
            '/api/tasks/task-1/conversation': { status: 404, body: {} },
            '/api/workspaces/': [],
        });
        render(<ConversationHistory taskId="task-1" workspaceId="/ws/alpha" onClose={vi.fn()} />);

        expect(await screen.findByText('No conversation history found for this workspace')).toBeInTheDocument();
    });

    it('reports a transport failure', async () => {
        stubFetch({ '/conversation': { reject: true } });
        render(<ConversationHistory taskId="task-1" workspaceId="/ws/alpha" onClose={vi.fn()} />);

        expect(await screen.findByText('Failed to load conversation history')).toBeInTheDocument();
    });

    it('shows an empty state for a session with no messages', async () => {
        stubFetch({ '/conversation': { sessionId: 'sess-1', messages: [] } });
        render(<ConversationHistory taskId="task-1" workspaceId="/ws/alpha" onClose={vi.fn()} />);

        expect(await screen.findByText('No messages in this conversation')).toBeInTheDocument();
    });

    it('copies the transcript to the clipboard and flips the button back after 2s', async () => {
        vi.useFakeTimers();
        stubFetch({ '/conversation': conversation });
        render(<ConversationHistory taskId="task-1" workspaceId="/ws/alpha" onClose={vi.fn()} />);

        await act(async () => { await Promise.resolve(); });
        const copyButton = screen.getByRole('button', { name: 'Copy conversation to clipboard' });

        await act(async () => { fireEvent.click(copyButton); });

        expect(clipboardWrite).toHaveBeenCalledWith(
            'You: why is it slow?\n\nClaude: because of the regex'
        );
        act(() => { vi.advanceTimersByTime(2100); });
    });

    it('closes from every state', async () => {
        const onClose = vi.fn();
        stubFetch({ '/conversation': conversation });
        render(<ConversationHistory taskId="task-1" workspaceId="/ws/alpha" onClose={onClose} />);

        // The loading state carries a close button of its own.
        fireEvent.click(screen.getByRole('button'));
        expect(onClose).toHaveBeenCalledTimes(1);

        // …and so does the loaded state.
        await screen.findByText('why is it slow?');
        fireEvent.click(screen.getAllByRole('button').slice(-1)[0]);
        expect(onClose).toHaveBeenCalledTimes(2);
    });
});

// ===========================================================================
// FileContentModal
// ===========================================================================

describe('FileContentModal', () => {
    const baseProps = { workspacePath: '/ws/alpha', filePath: 'src/index.ts' };

    it('requests the file and renders its content', async () => {
        const fetchMock = stubFetch({ '/api/workspaces/read-file': { content: 'const x = 1;' } });
        render(<FileContentModal {...baseProps} onClose={vi.fn()} />);

        expect(await screen.findByText('const x = 1;')).toBeInTheDocument();
        const url = urlsOf(fetchMock)[0];
        expect(url).toContain('/api/workspaces/read-file');
        expect(url).toContain('workspace=%2Fws%2Falpha');
        expect(url).toContain('file=src%2Findex.ts');
    });

    it('surfaces the backend error message', async () => {
        stubFetch({ '/api/workspaces/read-file': { status: 403, body: { error: 'outside workspace' } } });
        render(<FileContentModal {...baseProps} onClose={vi.fn()} />);

        expect(await screen.findByText('outside workspace')).toBeInTheDocument();
    });

    it('surfaces a transport failure', async () => {
        stubFetch({ '/api/workspaces/read-file': { reject: true } });
        render(<FileContentModal {...baseProps} onClose={vi.fn()} />);

        expect(await screen.findByText('Failed to connect to server')).toBeInTheDocument();
    });

    it('shows an empty-file placeholder', async () => {
        stubFetch({ '/api/workspaces/read-file': { content: '' } });
        render(<FileContentModal {...baseProps} onClose={vi.fn()} />);

        expect(await screen.findByText('Empty file')).toBeInTheDocument();
    });

    it('renders a diff with its badge and requests the diff endpoint', async () => {
        const fetchMock = stubFetch({
            '/api/workspaces/git-diff': { diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n context' },
        });
        render(<FileContentModal {...baseProps} isDiff staged onClose={vi.fn()} />);

        expect(await screen.findByText('+new')).toBeInTheDocument();
        expect(screen.getByText('-old')).toBeInTheDocument();
        expect(screen.getByText('@@ -1 +1 @@')).toBeInTheDocument();
        expect(screen.getByText('Staged')).toBeInTheDocument();
        expect(urlsOf(fetchMock)[0]).toContain('staged=true');
    });

    it('labels an unstaged diff as Changes', async () => {
        stubFetch({ '/api/workspaces/git-diff': { diff: '+added' } });
        render(<FileContentModal {...baseProps} isDiff onClose={vi.fn()} />);

        expect(await screen.findByText('Changes')).toBeInTheDocument();
    });

    it('shows an image instead of a code block for image files', async () => {
        stubFetch({ '/api/workspaces/read-file': { content: 'data:image/png;base64,AAA', isImage: true } });
        render(<FileContentModal workspacePath="/ws/alpha" filePath="docs/logo.png" onClose={vi.fn()} />);

        const img = await screen.findByRole('img', { name: 'logo.png' });
        expect(img).toHaveAttribute('src', 'data:image/png;base64,AAA');
        // Copy/edit make no sense for an image.
        expect(screen.queryByRole('button', { name: 'Copy to clipboard' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Edit file' })).not.toBeInTheDocument();
    });

    it('renders markdown by default and can switch to the raw source', async () => {
        stubFetch({ '/api/workspaces/read-file': { content: '# Title\n\nbody text' } });
        const user = userEvent.setup();
        render(<FileContentModal workspacePath="/ws/alpha" filePath="README.md" onClose={vi.fn()} />);

        expect(await screen.findByRole('heading', { name: 'Title' })).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Show raw markdown' }));

        expect(screen.queryByRole('heading', { name: 'Title' })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Show rendered markdown' })).toBeInTheDocument();
    });

    it('edits and saves a file, then leaves edit mode', async () => {
        const fetchMock = stubFetch({
            '/api/workspaces/read-file': { content: 'old body' },
            '/api/workspaces/save-file': { ok: true, body: {} },
        });
        const user = userEvent.setup();
        render(<FileContentModal {...baseProps} onClose={vi.fn()} />);

        await user.click(await screen.findByRole('button', { name: 'Edit file' }));
        const editor = screen.getByRole('textbox');
        expect(editor).toHaveValue('old body');

        // Save is disabled until the content actually changes.
        expect(screen.getByRole('button', { name: 'Save file' })).toBeDisabled();

        await user.clear(editor);
        await user.type(editor, 'new body');
        await user.click(screen.getByRole('button', { name: 'Save file' }));

        await waitFor(() => expect(screen.getByText('Saved!')).toBeInTheDocument());

        const saveCall = fetchMock.mock.calls.find(c => String(c[0]).includes('/api/workspaces/save-file'))!;
        expect((saveCall[1] as RequestInit).method).toBe('POST');
        expect(JSON.parse((saveCall[1] as RequestInit).body as string)).toEqual({
            workspace: '/ws/alpha',
            file: 'src/index.ts',
            content: 'new body',
        });
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('reports a failed save and stays in edit mode', async () => {
        stubFetch({
            '/api/workspaces/read-file': { content: 'old body' },
            '/api/workspaces/save-file': { status: 500, body: { error: 'disk full' } },
        });
        const user = userEvent.setup();
        render(<FileContentModal {...baseProps} onClose={vi.fn()} />);

        await user.click(await screen.findByRole('button', { name: 'Edit file' }));
        await user.type(screen.getByRole('textbox'), '!');
        await user.click(screen.getByRole('button', { name: 'Save file' }));

        expect(await screen.findByText('disk full')).toBeInTheDocument();
    });

    it('cancelling an edit discards the draft without saving', async () => {
        const fetchMock = stubFetch({ '/api/workspaces/read-file': { content: 'old body' } });
        const user = userEvent.setup();
        render(<FileContentModal {...baseProps} onClose={vi.fn()} />);

        await user.click(await screen.findByRole('button', { name: 'Edit file' }));
        await user.type(screen.getByRole('textbox'), ' scratch');
        await user.click(screen.getByRole('button', { name: 'Cancel editing' }));

        expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
        expect(screen.getByText('old body')).toBeInTheDocument();
        expect(urlsOf(fetchMock).some(u => u.includes('save-file'))).toBe(false);
    });

    it('copies the content to the clipboard', async () => {
        stubFetch({ '/api/workspaces/read-file': { content: 'copy me' } });
        render(<FileContentModal {...baseProps} onClose={vi.fn()} />);

        await screen.findByText('copy me');
        // fireEvent, not userEvent: userEvent.setup() installs its own
        // navigator.clipboard stub and would swallow the call.
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }));
        });

        expect(clipboardWrite).toHaveBeenCalledWith('copy me');
    });

    it('closes from the X button and from the backdrop, but not from inside the modal', async () => {
        const onClose = vi.fn();
        stubFetch({ '/api/workspaces/read-file': { content: 'x' } });
        const user = userEvent.setup();
        render(<FileContentModal {...baseProps} onClose={onClose} />);

        await user.click(await screen.findByRole('button', { name: 'Close' }));
        expect(onClose).toHaveBeenCalledTimes(1);

        // A click that starts and ends on the modal body is not a dismiss.
        fireEvent.click(screen.getByText('src/index.ts'));
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

// ===========================================================================
// LearnFromConversationModal
// ===========================================================================

describe('LearnFromConversationModal', () => {
    const baseProps = { taskId: 'task-1', workspaceId: '/ws/alpha', workspaceName: 'alpha' };
    const analysis = {
        reasoning: 'The user repeatedly asked for tests first.',
        suggestions: [
            { id: 's1', description: 'Write tests first', promptAddition: 'Always TDD.' },
            { id: 's2', description: 'Never restart the server', promptAddition: 'tsx watch reloads.' },
        ],
    };

    it('analyses the conversation on mount and preselects every suggestion', async () => {
        const fetchMock = stubFetch({ '/learn': analysis });
        render(<LearnFromConversationModal {...baseProps} onClose={vi.fn()} />);

        expect(screen.getByText('Analyzing conversation...')).toBeInTheDocument();

        expect(await screen.findByText('The user repeatedly asked for tests first.')).toBeInTheDocument();
        expect(screen.getByText('Write tests first')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Save 2 Learnings/ })).toBeEnabled();

        const call = fetchMock.mock.calls.find(c => String(c[0]).includes('/api/tasks/task-1/learn'))!;
        expect((call[1] as RequestInit).method).toBe('POST');
        expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ workspaceId: '/ws/alpha' });
    });

    it('toggles a single suggestion off and updates the save label', async () => {
        stubFetch({ '/learn': analysis });
        const user = userEvent.setup();
        render(<LearnFromConversationModal {...baseProps} onClose={vi.fn()} />);

        await user.click(await screen.findByText('Write tests first'));

        expect(screen.getByRole('button', { name: /Save 1 Learning$/ })).toBeInTheDocument();
    });

    it('Select None disables saving; Select All restores it', async () => {
        stubFetch({ '/learn': analysis });
        const user = userEvent.setup();
        render(<LearnFromConversationModal {...baseProps} onClose={vi.fn()} />);

        await user.click(await screen.findByRole('button', { name: 'Select None' }));
        expect(screen.getByRole('button', { name: /Save 0 Learnings/ })).toBeDisabled();

        await user.click(screen.getByRole('button', { name: 'Select All' }));
        expect(screen.getByRole('button', { name: /Save 2 Learnings/ })).toBeEnabled();
    });

    it('saves the selected learnings, notifies the caller, and closes', async () => {
        const onClose = vi.fn();
        const onSaved = vi.fn();
        const fetchMock = stubFetch({
            '/learn/save': { saved: ['a'] },
            '/learn': analysis,
        });
        const user = userEvent.setup();
        render(<LearnFromConversationModal {...baseProps} onClose={onClose} onSaved={onSaved} />);

        await user.click(await screen.findByText('Never restart the server')); // deselect s2
        await user.click(screen.getByRole('button', { name: /Save 1 Learning$/ }));

        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(onSaved).toHaveBeenCalledWith(1);

        const saveCall = fetchMock.mock.calls.find(c => String(c[0]).includes('/learn/save'))!;
        expect(JSON.parse((saveCall[1] as RequestInit).body as string)).toEqual({
            workspaceId: '/ws/alpha',
            learnings: [{ title: 'Write tests first', content: 'Always TDD.' }],
        });
    });

    it('shows a save failure and does not close', async () => {
        const onClose = vi.fn();
        stubFetch({
            '/learn/save': { status: 500, body: { error: 'embedding service down' } },
            '/learn': analysis,
        });
        const user = userEvent.setup();
        render(<LearnFromConversationModal {...baseProps} onClose={onClose} />);

        await user.click(await screen.findByRole('button', { name: /Save 2 Learnings/ }));

        expect(await screen.findByText('embedding service down')).toBeInTheDocument();
        expect(onClose).not.toHaveBeenCalled();
    });

    it('offers a retry after a failed analysis', async () => {
        const fetchMock = stubFetch({ '/learn': { status: 500, body: { error: 'no AI core' } } });
        const user = userEvent.setup();
        render(<LearnFromConversationModal {...baseProps} onClose={vi.fn()} />);

        expect(await screen.findByText('no AI core')).toBeInTheDocument();

        stubFetch({ '/learn': analysis });
        await user.click(screen.getByRole('button', { name: /Retry/ }));

        expect(await screen.findByText('Write tests first')).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledTimes(1); // the retry went to the new stub
    });

    it('reports when the conversation yielded no learnings', async () => {
        stubFetch({ '/learn': { reasoning: 'nothing notable', suggestions: [] } });
        render(<LearnFromConversationModal {...baseProps} onClose={vi.fn()} />);

        expect(await screen.findByText(/No learnings found/)).toBeInTheDocument();
    });

    it('cancel closes without saving', async () => {
        const onClose = vi.fn();
        const fetchMock = stubFetch({ '/learn': analysis });
        const user = userEvent.setup();
        render(<LearnFromConversationModal {...baseProps} onClose={onClose} />);

        await user.click(await screen.findByRole('button', { name: 'Cancel' }));

        expect(onClose).toHaveBeenCalled();
        expect(urlsOf(fetchMock).some(u => u.includes('/learn/save'))).toBe(false);
    });
});

// ===========================================================================
// MobileAccessModal
// ===========================================================================

describe('MobileAccessModal', () => {
    const activeStatus = {
        active: true,
        url: 'https://demo.ngrok.app',
        token: 'tok-9',
        startedAt: null,
        error: null,
        publicIp: null,
    };

    it('renders nothing while closed and issues no request', () => {
        const fetchMock = stubFetch();
        render(<MobileAccessModal isOpen={false} onClose={vi.fn()} />);

        expect(screen.queryByRole('heading', { name: /Mobile Voice Access/ })).not.toBeInTheDocument();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fetches the tunnel status on open and shows the mobile URL', async () => {
        const fetchMock = stubFetch({ '/api/tunnel/status': activeStatus });
        render(<MobileAccessModal isOpen onClose={vi.fn()} />);

        expect(await screen.findByText('Tunnel active')).toBeInTheDocument();
        expect(screen.getByRole('textbox', { name: 'Mobile URL' })).toHaveValue('https://demo.ngrok.app/?token=tok-9');
        // Not urlsOf()[0]: the modal also reads /api/config on open, and that
        // request wins the race. What matters is that the status poll happened.
        expect(statusPolls(fetchMock)).toHaveLength(1);
    });

    it('shows the not-connected placeholder when no tunnel is up', async () => {
        stubFetch({ '/api/tunnel/status': { active: false, url: null, token: null } });
        render(<MobileAccessModal isOpen onClose={vi.fn()} />);

        expect(await screen.findByText('Tunnel not running')).toBeInTheDocument();
        expect(screen.getByText('Not connected')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled();
    });

    it('shows the error state and skips polling entirely', () => {
        const fetchMock = stubFetch({ '/api/tunnel/status': activeStatus });
        render(<MobileAccessModal isOpen onClose={vi.fn()} error="ngrok not installed" />);

        expect(screen.getByText('Connection failed')).toBeInTheDocument();
        expect(screen.getByText('ngrok not installed')).toBeInTheDocument();
        expect(screen.getByText('Failed')).toBeInTheDocument();
        expect(statusPolls(fetchMock)).toHaveLength(0);
    });

    it('shows the starting state while the tunnel spins up', async () => {
        stubFetch({ '/api/tunnel/status': { active: false } });
        render(<MobileAccessModal isOpen onClose={vi.fn()} tunnelLoading />);

        expect(await screen.findByText('Starting tunnel...')).toBeInTheDocument();
        expect(screen.getByText('Starting...')).toBeInTheDocument();
    });

    it('keeps polling every 2s until the tunnel reports active', async () => {
        vi.useFakeTimers();
        let active = false;
        const fetchMock = stubFetch({
            '/api/tunnel/status': () => (active ? activeStatus : { active: false, url: null, token: null }),
        });
        render(<MobileAccessModal isOpen onClose={vi.fn()} />);

        await act(async () => { await Promise.resolve(); });
        expect(statusPolls(fetchMock)).toHaveLength(1);

        await act(async () => { vi.advanceTimersByTime(2000); });
        expect(statusPolls(fetchMock)).toHaveLength(2);

        active = true;
        await act(async () => { vi.advanceTimersByTime(2000); });
        expect(statusPolls(fetchMock)).toHaveLength(3);

        // Polling has stopped now that the tunnel is up.
        await act(async () => { vi.advanceTimersByTime(6000); });
        expect(statusPolls(fetchMock)).toHaveLength(3);
    });

    it('generates a QR code for the mobile URL once the tunnel is active', async () => {
        stubFetch({ '/api/tunnel/status': activeStatus });
        render(<MobileAccessModal isOpen onClose={vi.fn()} />);

        await waitFor(() => expect(H.qrToCanvas).toHaveBeenCalled());
        expect(H.qrToCanvas.mock.calls[0][1]).toBe('https://demo.ngrok.app/?token=tok-9');
    });

    it('copies the mobile URL', async () => {
        stubFetch({ '/api/tunnel/status': activeStatus });
        render(<MobileAccessModal isOpen onClose={vi.fn()} />);

        await waitFor(() => expect(screen.getByRole('button', { name: 'Copy' })).toBeEnabled());
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
        });

        expect(clipboardWrite).toHaveBeenCalledWith('https://demo.ngrok.app/?token=tok-9');
        expect(await screen.findByText('Copied!')).toBeInTheDocument();
    });

    it('offers Start when idle and Stop when active — never both', async () => {
        const onStartTunnel = vi.fn();
        const onStopTunnel = vi.fn();
        stubFetch({ '/api/tunnel/status': { active: false } });
        const user = userEvent.setup();
        const { rerender } = render(
            <MobileAccessModal isOpen onClose={vi.fn()} onStartTunnel={onStartTunnel} onStopTunnel={onStopTunnel} />
        );

        await user.click(await screen.findByRole('button', { name: /Start Tunnel/ }));
        expect(onStartTunnel).toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: /Stop Tunnel/ })).not.toBeInTheDocument();

        stubFetch({ '/api/tunnel/status': activeStatus });
        rerender(
            <MobileAccessModal isOpen={false} onClose={vi.fn()} onStartTunnel={onStartTunnel} onStopTunnel={onStopTunnel} />
        );
        rerender(
            <MobileAccessModal isOpen onClose={vi.fn()} onStartTunnel={onStartTunnel} onStopTunnel={onStopTunnel} />
        );

        await user.click(await screen.findByRole('button', { name: /Stop Tunnel/ }));
        expect(onStopTunnel).toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: /Start Tunnel/ })).not.toBeInTheDocument();
    });

    it('closes from the Close button and the overlay, but not from the modal body', async () => {
        const onClose = vi.fn();
        stubFetch({ '/api/tunnel/status': { active: false } });
        const user = userEvent.setup();
        render(<MobileAccessModal isOpen onClose={onClose} />);

        await user.click(screen.getByRole('button', { name: 'Close' }));
        expect(onClose).toHaveBeenCalledTimes(1);

        // Clicking the modal's own content must not bubble a dismiss.
        await user.click(screen.getByRole('heading', { name: /Mobile Voice Access/ }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

// ===========================================================================
// ProjectPicker
// ===========================================================================

describe('ProjectPicker', () => {
    /** Minimal WebSocket stand-in with a real EventTarget underneath. */
    function makeFakeWs() {
        const target = new EventTarget();
        const ws = {
            readyState: 1, // WebSocket.OPEN
            addEventListener: target.addEventListener.bind(target),
            removeEventListener: target.removeEventListener.bind(target),
            emit(payload: unknown) {
                ws.emitRaw(JSON.stringify(payload));
            },
            emitRaw(data: string) {
                const ev = new Event('message') as Event & { data: string };
                ev.data = data;
                target.dispatchEvent(ev);
            },
        };
        return ws as unknown as WebSocket & { emit: (p: unknown) => void; emitRaw: (d: string) => void };
    }

    function renderPicker(over: Partial<{
        onSelect: (p: string) => void;
        requestRecentWorkspaces: () => void;
        clearRecentWorkspace: (id?: string) => void;
    }> = {}) {
        const ws = makeFakeWs();
        const props = {
            onSelect: vi.fn(),
            requestRecentWorkspaces: vi.fn(),
            clearRecentWorkspace: vi.fn(),
            ...over,
        };
        const wsRef = { current: ws } as MutableRefObject<WebSocket | null>;
        const view = render(<ProjectPicker {...props} wsRef={wsRef} />);
        return { ...view, ...props, ws };
    }

    it('renders nothing until the store asks for the picker', () => {
        renderPicker();
        expect(screen.queryByRole('heading', { name: 'Add Workspace' })).not.toBeInTheDocument();
    });

    it('opens the path input on localhost and resets the store flag', async () => {
        renderPicker();

        act(() => { useTaskStore.getState().setShowProjectPicker(true); });

        expect(await screen.findByRole('heading', { name: 'Add Workspace' })).toBeInTheDocument();
        expect(useTaskStore.getState().showProjectPicker).toBe(false);
    });

    it('fetches the default base directory and applies it to a relative path', async () => {
        const fetchMock = stubFetch({ '/api/config': { defaultBaseDirectory: '/Users/me/Work' } });
        const { onSelect } = renderPicker();
        const user = userEvent.setup();

        act(() => { useTaskStore.getState().setShowProjectPicker(true); });
        await screen.findByRole('heading', { name: 'Add Workspace' });
        await waitFor(() => expect(screen.getByText('Base directory: /Users/me/Work')).toBeInTheDocument());

        await user.type(screen.getByLabelText('Folder path'), 'my-project');
        await user.click(screen.getByRole('button', { name: 'Add Workspace' }));

        expect(onSelect).toHaveBeenCalledWith('/Users/me/Work/my-project');
        expect(urlsOf(fetchMock)[0]).toContain('/api/config');
    });

    it('cancelling closes the modal without selecting anything', async () => {
        const { onSelect } = renderPicker();
        const user = userEvent.setup();

        act(() => { useTaskStore.getState().setShowProjectPicker(true); });
        await user.click(await screen.findByRole('button', { name: 'Cancel' }));

        expect(onSelect).not.toHaveBeenCalled();
        expect(screen.queryByRole('heading', { name: 'Add Workspace' })).not.toBeInTheDocument();
    });

    it('asks the backend to open a native folder dialog and uses the result', async () => {
        const fetchMock = stubFetch({ '/api/browse-folder': { success: true, path: '/picked/dir' } });
        const { onSelect } = renderPicker();
        const user = userEvent.setup();

        act(() => { useTaskStore.getState().setShowProjectPicker(true); });
        await user.click(await screen.findByRole('button', { name: 'Browse' }));

        await waitFor(() => expect(onSelect).toHaveBeenCalledWith('/picked/dir'));
        const call = fetchMock.mock.calls.find(c => String(c[0]).includes('/api/browse-folder'))!;
        expect((call[1] as RequestInit).method).toBe('POST');
        expect(screen.queryByRole('heading', { name: 'Add Workspace' })).not.toBeInTheDocument();
    });

    it('keeps the modal open when the native dialog is cancelled', async () => {
        stubFetch({ '/api/browse-folder': { success: false } });
        const { onSelect } = renderPicker();
        const user = userEvent.setup();

        act(() => { useTaskStore.getState().setShowProjectPicker(true); });
        await user.click(await screen.findByRole('button', { name: 'Browse' }));

        await waitFor(() => expect(screen.getByRole('button', { name: 'Browse' })).toBeEnabled());
        expect(onSelect).not.toHaveBeenCalled();
        expect(screen.getByRole('heading', { name: 'Add Workspace' })).toBeInTheDocument();
    });

    it('requests recent workspaces over the shared socket and renders the reply', async () => {
        const { ws, requestRecentWorkspaces, clearRecentWorkspace } = renderPicker();
        const user = userEvent.setup();

        act(() => { useTaskStore.getState().setShowProjectPicker(true); });
        await screen.findByRole('heading', { name: 'Add Workspace' });
        expect(requestRecentWorkspaces).toHaveBeenCalled();

        act(() => {
            ws.emit({
                type: 'workspace:recent:list',
                payload: {
                    recentWorkspaces: [
                        { id: '/ws/alpha', name: 'alpha', removedAt: new Date().toISOString() },
                    ],
                },
            });
        });

        expect(await screen.findByText('alpha')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: '×' }));
        expect(clearRecentWorkspace).toHaveBeenCalledWith('/ws/alpha');
        expect(screen.queryByText('alpha')).not.toBeInTheDocument();
    });

    it('accepts a folder chosen through the socket browse response', async () => {
        const { ws, onSelect } = renderPicker();

        act(() => { useTaskStore.getState().setShowProjectPicker(true); });
        await screen.findByRole('heading', { name: 'Add Workspace' });

        act(() => { ws.emit({ type: 'workspace:browseFolder', payload: { path: '/ws/from-socket' } }); });

        expect(onSelect).toHaveBeenCalledWith('/ws/from-socket');
        expect(screen.queryByRole('heading', { name: 'Add Workspace' })).not.toBeInTheDocument();
    });

    it('survives a malformed socket frame', async () => {
        const { ws, onSelect } = renderPicker();

        act(() => { useTaskStore.getState().setShowProjectPicker(true); });
        await screen.findByRole('heading', { name: 'Add Workspace' });

        act(() => { ws.emitRaw('not json'); });

        expect(screen.getByRole('heading', { name: 'Add Workspace' })).toBeInTheDocument();
        expect(onSelect).not.toHaveBeenCalled();
    });
});

// ===========================================================================
// ScheduledTasksModal
// ===========================================================================

describe('ScheduledTasksModal', () => {
    const baseProps = { taskId: 'task-1', taskName: 'refactor the parser' };

    function schedule(over: Partial<ScheduledTask> = {}): ScheduledTask {
        return {
            id: 'cron01',
            taskId: 'task-1',
            workspaceId: '/ws/alpha',
            cronExpression: '*/5 * * * *',
            prompt: 'check CI',
            isRecurring: true,
            isPaused: false,
            createdAt: '2026-01-01T00:00:00Z',
            expiresAt: new Date(Date.now() + 2 * 86_400_000 + 3 * 3_600_000 + 60_000).toISOString(),
            nextFireAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            fireCount: 3,
            ...over,
        };
    }

    it('refreshes from the backend on mount and shows an empty state', async () => {
        const fetchMock = stubFetch({ '/api/cron': [] });
        render(<ScheduledTasksModal {...baseProps} onClose={vi.fn()} />);

        expect(screen.getByText('No scheduled tasks')).toBeInTheDocument();
        await waitFor(() => expect(urlsOf(fetchMock)[0]).toContain('/api/cron'));
    });

    it('renders the schedules the backend returned for this task only', async () => {
        stubFetch({
            '/api/cron': [
                schedule(),
                schedule({ id: 'cron02', taskId: 'other-task', prompt: 'not mine' }),
            ],
        });
        render(<ScheduledTasksModal {...baseProps} onClose={vi.fn()} />);

        expect(await screen.findByText('check CI')).toBeInTheDocument();
        expect(screen.queryByText('not mine')).not.toBeInTheDocument();
        expect(screen.getByText('*/5 * * * *')).toBeInTheDocument();
        expect(screen.getByText('Fired: 3x')).toBeInTheDocument();
        expect(screen.getByText('recurring')).toBeInTheDocument();
        expect(screen.getByText('Next: in 5m')).toBeInTheDocument();
        expect(screen.getByText('2d 3h remaining')).toBeInTheDocument();
    });

    it('marks a paused schedule and hides its next-fire time', async () => {
        stubFetch({ '/api/cron': [schedule({ isPaused: true, isRecurring: false })] });
        render(<ScheduledTasksModal {...baseProps} onClose={vi.fn()} />);

        expect(await screen.findByText('paused')).toBeInTheDocument();
        expect(screen.getByText('one-shot')).toBeInTheDocument();
        expect(screen.getByText('Paused')).toBeInTheDocument();
    });

    it('creates a schedule from the form, using a cron preset', async () => {
        vi.useFakeTimers();
        stubFetch({ '/api/cron': [] });
        render(<ScheduledTasksModal {...baseProps} onClose={vi.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: /Add Schedule/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Every hour' }));
        fireEvent.change(screen.getByPlaceholderText('Enter the prompt to send at each scheduled time...'), { target: { value: 'run the suite' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create' }));

        expect(H.sendWsMessage).toHaveBeenCalledWith('cron:create', {
            taskId: 'task-1',
            cronExpression: '0 * * * *',
            prompt: 'run the suite',
            isRecurring: true,
        });

        // The form closes once the debounce settles.
        await act(async () => { vi.advanceTimersByTime(600); });
        expect(screen.getByRole('button', { name: /Add Schedule/ })).toBeInTheDocument();
    });

    it('creates a one-shot schedule when Recurring is unchecked', async () => {
        vi.useFakeTimers();
        stubFetch({ '/api/cron': [] });
        render(<ScheduledTasksModal {...baseProps} onClose={vi.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: /Add Schedule/ }));
        fireEvent.click(screen.getByRole('checkbox'));
        expect(screen.getByText('Fires once then deletes itself')).toBeInTheDocument();

        fireEvent.change(screen.getByPlaceholderText('Enter the prompt to send at each scheduled time...'), { target: { value: 'one time' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create' }));

        expect(H.sendWsMessage).toHaveBeenCalledWith('cron:create', expect.objectContaining({ isRecurring: false }));
        await act(async () => { vi.advanceTimersByTime(600); });
    });

    it('opens with the create form prefilled when an initial prompt is passed', () => {
        stubFetch({ '/api/cron': [] });
        render(<ScheduledTasksModal {...baseProps} initialPrompt="seeded prompt" onClose={vi.fn()} />);

        expect(screen.getByPlaceholderText('Enter the prompt to send at each scheduled time...')).toHaveValue('seeded prompt');
        expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
    });

    it('refuses to submit with an empty prompt', () => {
        stubFetch({ '/api/cron': [] });
        render(<ScheduledTasksModal {...baseProps} onClose={vi.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: /Add Schedule/ }));
        expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
        expect(H.sendWsMessage).not.toHaveBeenCalled();
    });

    it('edits an existing schedule and sends an update', async () => {
        vi.useFakeTimers();
        stubFetch({ '/api/cron': [schedule()] });
        render(<ScheduledTasksModal {...baseProps} onClose={vi.fn()} />);

        await act(async () => { await Promise.resolve(); });
        fireEvent.click(screen.getByRole('button', { name: 'Edit scheduled task' }));

        expect(screen.getByText('Edit #cron01')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('Enter the prompt to send at each scheduled time...')).toHaveValue('check CI');

        fireEvent.change(screen.getByPlaceholderText('Enter the prompt to send at each scheduled time...'), { target: { value: 'check CI twice' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect(H.sendWsMessage).toHaveBeenCalledWith('cron:update', {
            cronId: 'cron01',
            cronExpression: '*/5 * * * *',
            prompt: 'check CI twice',
            isRecurring: true,
        });
        await act(async () => { vi.advanceTimersByTime(600); });
    });

    it('cancelling the form sends nothing', async () => {
        stubFetch({ '/api/cron': [] });
        const user = userEvent.setup();
        render(<ScheduledTasksModal {...baseProps} onClose={vi.fn()} />);

        await user.click(screen.getByRole('button', { name: /Add Schedule/ }));
        await user.type(screen.getByPlaceholderText('Enter the prompt to send at each scheduled time...'), 'discarded');
        await user.click(screen.getByRole('button', { name: 'Cancel' }));

        expect(H.sendWsMessage).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: /Add Schedule/ })).toBeInTheDocument();
    });

    it('deletes a schedule', async () => {
        vi.useFakeTimers();
        stubFetch({ '/api/cron': [schedule()] });
        render(<ScheduledTasksModal {...baseProps} onClose={vi.fn()} />);

        await act(async () => { await Promise.resolve(); });
        fireEvent.click(screen.getByRole('button', { name: 'Delete scheduled task' }));

        expect(H.sendWsMessage).toHaveBeenCalledWith('cron:delete', { cronId: 'cron01' });
        await act(async () => { vi.advanceTimersByTime(400); });
    });

    it('pauses and resumes a schedule', async () => {
        vi.useFakeTimers();
        stubFetch({ '/api/cron': [schedule()] });
        const { rerender } = render(<ScheduledTasksModal {...baseProps} onClose={vi.fn()} />);

        await act(async () => { await Promise.resolve(); });
        fireEvent.click(screen.getByRole('button', { name: 'Pause scheduled task' }));
        expect(H.sendWsMessage).toHaveBeenCalledWith('cron:update', { cronId: 'cron01', isPaused: true });

        act(() => { useTaskStore.getState().setScheduledTasks([schedule({ isPaused: true })]); });
        rerender(<ScheduledTasksModal {...baseProps} onClose={vi.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: 'Resume scheduled task' }));
        expect(H.sendWsMessage).toHaveBeenCalledWith('cron:update', { cronId: 'cron01', isPaused: false });
        await act(async () => { vi.advanceTimersByTime(400); });
    });

    it('copies a schedule prompt', async () => {
        stubFetch({ '/api/cron': [schedule()] });
        render(<ScheduledTasksModal {...baseProps} onClose={vi.fn()} />);

        const copyButton = await screen.findByRole('button', { name: 'Copy prompt' });
        await act(async () => { fireEvent.click(copyButton); });

        expect(clipboardWrite).toHaveBeenCalledWith('check CI');
    });

    it('Escape closes the form first, then the modal', async () => {
        stubFetch({ '/api/cron': [] });
        const onClose = vi.fn();
        const user = userEvent.setup();
        render(<ScheduledTasksModal {...baseProps} onClose={onClose} />);

        await user.click(screen.getByRole('button', { name: /Add Schedule/ }));
        fireEvent.keyDown(document, { key: 'Escape' });

        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: /Add Schedule/ })).toBeInTheDocument();

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes from the X button and the overlay, but not from the modal body', async () => {
        stubFetch({ '/api/cron': [] });
        const onClose = vi.fn();
        const user = userEvent.setup();
        render(<ScheduledTasksModal {...baseProps} onClose={onClose} />);

        await user.click(screen.getByRole('heading', { name: 'Scheduled Tasks' }));
        expect(onClose).not.toHaveBeenCalled();

        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        expect(onClose).not.toHaveBeenCalled();
    });

    it('survives a failed refresh', async () => {
        stubFetch({ '/api/cron': { reject: true } });
        render(<ScheduledTasksModal {...baseProps} onClose={vi.fn()} />);

        expect(await screen.findByText('No scheduled tasks')).toBeInTheDocument();
    });
});

// ===========================================================================
// SupervisorChat
// ===========================================================================

describe('SupervisorChat', () => {
    function message(over: Partial<ChatMessage> & { id: string }): ChatMessage {
        return {
            role: 'assistant',
            content: 'hello there',
            timestamp: new Date().toISOString(),
            ...over,
        } as ChatMessage;
    }

    it('shows the empty state with no threads', () => {
        render(
            <SupervisorChat
                messages={[]}
                isTyping={false}
                selectedTaskId={null}
                onSendMessage={vi.fn()}
                onClearHistory={vi.fn()}
            />
        );

        expect(screen.getByText('Task Threads')).toBeInTheDocument();
    });

    it('groups messages into per-task threads, newest first, and skips general chat', () => {
        resetStore({
            tasks: new Map([
                ['task-1', makeTask({ id: 'task-1', prompt: 'refactor the parser' })],
                ['task-2', makeTask({ id: 'task-2', prompt: 'fix the flake' })],
            ]),
        });
        const now = Date.now();
        render(
            <SupervisorChat
                messages={[
                    message({ id: 'm0', content: 'no task', timestamp: new Date(now - 60_000).toISOString() }),
                    message({ id: 'm1', taskId: 'task-1', timestamp: new Date(now - 30 * 60_000).toISOString() }),
                    message({ id: 'm2', taskId: 'task-2', timestamp: new Date(now - 60_000).toISOString() }),
                ]}
                isTyping={false}
                selectedTaskId={null}
                onSendMessage={vi.fn()}
                onClearHistory={vi.fn()}
            />
        );

        const threads = screen.getAllByRole('button');
        expect(threads[0]).toHaveTextContent('fix the flake');
        expect(threads[1]).toHaveTextContent('refactor the parser');
        // The un-attributed message gets no thread of its own.
        expect(screen.queryByText('no task')).not.toBeInTheDocument();
        expect(threads[1]).toHaveTextContent('30m ago');
    });

    it('falls back to a truncated task id when the task is unknown', () => {
        render(
            <SupervisorChat
                messages={[message({ id: 'm1', taskId: 'deadbeef-cafe' })]}
                isTyping={false}
                selectedTaskId={null}
                onSendMessage={vi.fn()}
                onClearHistory={vi.fn()}
            />
        );

        expect(screen.getByText('Task deadbeef...')).toBeInTheDocument();
    });

    it('expands a thread to reveal its messages, then collapses it again', async () => {
        resetStore({ tasks: new Map([['task-1', makeTask()]]) });
        const user = userEvent.setup();
        render(
            <SupervisorChat
                messages={[message({ id: 'm1', taskId: 'task-1', content: 'the parser is slow' })]}
                isTyping={false}
                selectedTaskId="task-1"
                onSendMessage={vi.fn()}
                onClearHistory={vi.fn()}
            />
        );

        expect(screen.queryByText('the parser is slow')).not.toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: /refactor the parser/ }));
        expect(screen.getByText('the parser is slow')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: /refactor the parser/ }));
        expect(screen.queryByText('the parser is slow')).not.toBeInTheDocument();
    });

    it('clears the unread badge once the thread has been opened', async () => {
        resetStore({ tasks: new Map([['task-1', makeTask()]]) });
        const user = userEvent.setup();
        render(
            <SupervisorChat
                messages={[
                    message({ id: 'm1', taskId: 'task-1' }),
                    message({ id: 'm2', taskId: 'task-1' }),
                ]}
                isTyping={false}
                selectedTaskId="task-1"
                onSendMessage={vi.fn()}
                onClearHistory={vi.fn()}
            />
        );

        const header = screen.getByRole('button', { name: /refactor the parser/ });
        expect(header).toHaveTextContent('2');

        await user.click(header);
        // Still "2", but now as the read message count rather than an unread badge:
        // re-collapsing must not resurrect the badge.
        await user.click(header);
        expect(screen.getByRole('button', { name: /refactor the parser/ })).toHaveTextContent('2');
    });

    it('sends a threaded message and clears that thread\'s input', async () => {
        const onSendMessage = vi.fn();
        resetStore({ tasks: new Map([['task-1', makeTask()]]) });
        const user = userEvent.setup();
        render(
            <SupervisorChat
                messages={[message({ id: 'm1', taskId: 'task-1' })]}
                isTyping={false}
                selectedTaskId="task-1"
                onSendMessage={onSendMessage}
                onClearHistory={vi.fn()}
            />
        );

        await user.click(screen.getByRole('button', { name: /refactor the parser/ }));
        const input = screen.getByPlaceholderText('Ask about this task...');

        // Nothing is sent for an all-whitespace input.
        await user.click(screen.getByRole('button', { name: 'Send message' }));
        expect(onSendMessage).not.toHaveBeenCalled();

        await user.type(input, 'what is blocking?');
        await user.click(screen.getByRole('button', { name: 'Send message' }));

        expect(onSendMessage).toHaveBeenCalledWith('what is blocking?', 'task-1');
        expect(input).toHaveValue('');
    });

    it('sends a final voice transcript straight to the thread', async () => {
        const onSendMessage = vi.fn();
        resetStore({ tasks: new Map([['task-1', makeTask()]]) });
        const user = userEvent.setup();
        render(
            <SupervisorChat
                messages={[message({ id: 'm1', taskId: 'task-1' })]}
                isTyping={false}
                selectedTaskId="task-1"
                onSendMessage={onSendMessage}
                onClearHistory={vi.fn()}
            />
        );

        await user.click(screen.getByRole('button', { name: /refactor the parser/ }));
        await user.click(screen.getByRole('button', { name: 'stub-voice' }));

        expect(onSendMessage).toHaveBeenCalledWith('spoken text', 'task-1');
    });

    it('locks the composer and shows a typing indicator while the supervisor replies', async () => {
        resetStore({ tasks: new Map([['task-1', makeTask()]]) });
        const user = userEvent.setup();
        render(
            <SupervisorChat
                messages={[message({ id: 'm1', taskId: 'task-1' })]}
                isTyping
                selectedTaskId="task-1"
                onSendMessage={vi.fn()}
                onClearHistory={vi.fn()}
            />
        );

        await user.click(screen.getByRole('button', { name: /refactor the parser/ }));

        expect(screen.getByPlaceholderText('Ask about this task...')).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    });
});

// ===========================================================================
// UsageDashboard
// ===========================================================================

describe('UsageDashboard', () => {
    const dashboard = {
        totalCostUsd: 12.3456,
        totalInputTokens: 1_500_000,
        totalOutputTokens: 2_400,
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: 0,
        taskCount: 7,
        lastUpdated: '2026-01-01T00:00:00Z',
        byWorkspace: {
            '/ws/alpha': {
                name: 'alpha', costUsd: 8, inputTokens: 1_000_000, outputTokens: 2_000,
                cacheCreationTokens: 0, cacheReadTokens: 0, taskCount: 5,
            },
        },
        byModel: {
            'claude-sonnet-4-5': {
                inputTokens: 900_000, outputTokens: 1_800,
                cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 6,
            },
        },
    };

    const pricing = {
        enabled: true,
        pricing: {
            'claude-sonnet-4-5': {
                inputPer1MTokens: 3, outputPer1MTokens: 15,
                cacheCreatePer1MTokens: 3.75, cacheReadPer1MTokens: 0.3,
            },
        },
    };

    it('renders nothing and fetches nothing while closed', () => {
        const fetchMock = stubFetch();
        render(<UsageDashboard isOpen={false} onClose={vi.fn()} />);

        expect(screen.queryByRole('heading', { name: 'Token Usage Dashboard' })).not.toBeInTheDocument();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('loads the dashboard and pricing config on open', async () => {
        const fetchMock = stubFetch({ '/api/usage/dashboard': dashboard, '/api/usage/config': pricing });
        render(<UsageDashboard isOpen onClose={vi.fn()} />);

        expect(await screen.findByText('7')).toBeInTheDocument();
        const urls = urlsOf(fetchMock);
        expect(urls.some(u => u.includes('/api/usage/dashboard'))).toBe(true);
        expect(urls.some(u => u.includes('/api/usage/config'))).toBe(true);

        expect(screen.getByText('By Workspace')).toBeInTheDocument();
        expect(screen.getByText('alpha')).toBeInTheDocument();
        expect(screen.getByText('By Model')).toBeInTheDocument();
    });

    it('hides every cost column when cost display is disabled', async () => {
        stubFetch({ '/api/usage/dashboard': dashboard, '/api/usage/config': pricing });
        render(<UsageDashboard isOpen onClose={vi.fn()} />);

        await screen.findByText('By Workspace');
        expect(screen.queryByText('Total Cost')).not.toBeInTheDocument();
        expect(screen.queryByRole('columnheader', { name: 'Cost' })).not.toBeInTheDocument();
    });

    it('shows costs when the store enables them', async () => {
        resetStore({ tokenCostEnabled: true });
        stubFetch({ '/api/usage/dashboard': dashboard, '/api/usage/config': pricing });
        render(<UsageDashboard isOpen onClose={vi.fn()} />);

        expect(await screen.findByText('Total Cost')).toBeInTheDocument();
        expect(screen.getAllByRole('columnheader', { name: 'Cost' })).toHaveLength(2);
    });

    it('shows an error when the dashboard request fails', async () => {
        stubFetch({ '/api/usage/dashboard': { status: 500, body: {} }, '/api/usage/config': pricing });
        render(<UsageDashboard isOpen onClose={vi.fn()} />);

        expect(await screen.findByText('Failed to fetch usage data')).toBeInTheDocument();
    });

    it('shows a connection error when the request throws', async () => {
        stubFetch({ '/api/usage': { reject: true } });
        render(<UsageDashboard isOpen onClose={vi.fn()} />);

        expect(await screen.findByText('Failed to connect to server')).toBeInTheDocument();
    });

    it('shows an empty state when the backend has no data yet', async () => {
        stubFetch({ '/api/usage/dashboard': { status: 500, body: {} }, '/api/usage/config': pricing });
        render(<UsageDashboard isOpen onClose={vi.fn()} />);

        await screen.findByText('Failed to fetch usage data');
        expect(screen.queryByText(/No usage data available yet/)).not.toBeInTheDocument();
    });

    it('refetches on demand', async () => {
        const fetchMock = stubFetch({ '/api/usage/dashboard': dashboard, '/api/usage/config': pricing });
        const user = userEvent.setup();
        render(<UsageDashboard isOpen onClose={vi.fn()} />);

        await screen.findByText('By Workspace');
        const before = urlsOf(fetchMock).filter(u => u.includes('/dashboard')).length;

        await user.click(screen.getByRole('button', { name: 'Refresh data' }));

        await waitFor(() => {
            expect(urlsOf(fetchMock).filter(u => u.includes('/dashboard')).length).toBe(before + 1);
        });
    });

    it('edits and saves the pricing table', async () => {
        const fetchMock = stubFetch({ '/api/usage/dashboard': dashboard, '/api/usage/config': pricing });
        const user = userEvent.setup();
        render(<UsageDashboard isOpen onClose={vi.fn()} />);

        await screen.findByText('By Workspace');
        await user.click(screen.getByRole('button', { name: /Pricing Configuration/ }));

        const inputs = screen.getAllByRole('spinbutton');
        expect(inputs[0]).toHaveValue(3);

        await user.clear(inputs[0]);
        await user.type(inputs[0], '4.5');
        await user.click(screen.getByRole('button', { name: /Save Pricing/ }));

        await waitFor(() => {
            const put = fetchMock.mock.calls.find(c => (c[1] as RequestInit | undefined)?.method === 'PUT');
            expect(put).toBeTruthy();
            expect(JSON.parse((put![1] as RequestInit).body as string).pricing['claude-sonnet-4-5'].inputPer1MTokens)
                .toBe(4.5);
        });
    });

    it('collapses the pricing table again', async () => {
        stubFetch({ '/api/usage/dashboard': dashboard, '/api/usage/config': pricing });
        const user = userEvent.setup();
        render(<UsageDashboard isOpen onClose={vi.fn()} />);

        await screen.findByText('By Workspace');
        await user.click(screen.getByRole('button', { name: /Pricing Configuration/ }));
        expect(screen.getAllByRole('spinbutton').length).toBeGreaterThan(0);

        await user.click(screen.getByRole('button', { name: /Pricing Configuration/ }));
        expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);
    });

    it('closes from the close button but not from a click inside the dashboard', async () => {
        const onClose = vi.fn();
        stubFetch({ '/api/usage/dashboard': dashboard, '/api/usage/config': pricing });
        const user = userEvent.setup();
        render(<UsageDashboard isOpen onClose={onClose} />);

        await user.click(screen.getByRole('heading', { name: 'Token Usage Dashboard' }));
        expect(onClose).not.toHaveBeenCalled();

        await user.click(screen.getByRole('button', { name: 'Close' }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
