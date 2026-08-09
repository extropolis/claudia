/**
 * useWebSocket — the entire client half of Claudia's wire protocol.
 *
 * The hook owns three things that break in ways users notice:
 *   1. inbound message dispatch → store mutations
 *   2. reconnection with exponential backoff
 *   3. teardown (a leaked reconnect loop resurrects sockets forever)
 *
 * Everything here runs against a hand-rolled fake WebSocket so close/open
 * timing is fully controllable, plus fake timers so backoff is asserted by
 * *delay*, not by sleeping.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

const hoisted = vi.hoisted(() => ({
    tunnel: { enabled: false },
    WS_URL: 'ws://claudia.test:9999',
    API_URL: 'http://claudia.test:9999',
}));

vi.mock('../../config/api-config', () => ({
    getWebSocketUrl: () => hoisted.WS_URL,
    getApiBaseUrl: () => hoisted.API_URL,
    isTunnelAccess: () => hoisted.tunnel.enabled,
    getMobileToken: () => null,
    isElectron: () => false,
}));

vi.mock('../../utils/browserCapabilities', () => ({
    playTaskCompletionSound: vi.fn(),
    sendTaskCompletionNotification: vi.fn(),
    sendTaskWaitingInputNotification: vi.fn(),
}));

import { useWebSocket, sendWsMessage } from '../useWebSocket';

/** Everything the hook hands back to components. */
type ClaudiaWsApi = ReturnType<typeof useWebSocket>;
import { useTaskStore } from '../../stores/taskStore';
import {
    playTaskCompletionSound,
    sendTaskCompletionNotification,
    sendTaskWaitingInputNotification,
} from '../../utils/browserCapabilities';

// ---------------------------------------------------------------------------
// Controllable fake WebSocket
// ---------------------------------------------------------------------------

interface SentFrame {
    type: string;
    payload: unknown;
}

class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    /** Every instance constructed since the last reset, in order. */
    static instances: FakeWebSocket[] = [];

    static reset() {
        FakeWebSocket.instances = [];
    }

    static get last(): FakeWebSocket {
        const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
        if (!ws) throw new Error('no FakeWebSocket has been constructed');
        return ws;
    }

    readyState = FakeWebSocket.CONNECTING;
    url: string;
    /** Raw strings passed to send(). */
    sentRaw: string[] = [];
    closeCount = 0;
    onopen: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;

    constructor(url: string) {
        this.url = url;
        FakeWebSocket.instances.push(this);
    }

    // --- real WebSocket surface -------------------------------------------

    send(data: string) {
        if (this.readyState !== FakeWebSocket.OPEN) {
            // Matches the browser, which throws InvalidStateError.
            throw new Error('InvalidStateError: send() on a non-OPEN socket');
        }
        this.sentRaw.push(data);
    }

    close() {
        this.closeCount++;
        if (this.readyState === FakeWebSocket.CLOSED) return;
        this.readyState = FakeWebSocket.CLOSED;
        // Browsers deliver the close event asynchronously. This is the whole
        // reason the unmount-reconnect bug existed, so the fake must too.
        setTimeout(() => this.fireClose({ code: 1000, wasClean: true }), 0);
    }

    addEventListener() {}
    removeEventListener() {}

    // --- test drivers ------------------------------------------------------

    /** Server accepted the connection. */
    simulateOpen() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event('open'));
    }

    /** Server (or the network) dropped the connection. */
    simulateClose(opts: { code?: number; wasClean?: boolean } = {}) {
        this.readyState = FakeWebSocket.CLOSED;
        this.fireClose({ code: opts.code ?? 1006, wasClean: opts.wasClean ?? false });
    }

    private fireClose({ code, wasClean }: { code: number; wasClean: boolean }) {
        this.onclose?.({ code, reason: '', wasClean } as CloseEvent);
    }

    simulateError() {
        this.onerror?.(new Event('error'));
    }

    /** Deliver an inbound protocol message. */
    simulateMessage(type: string, payload: unknown) {
        this.simulateRaw(JSON.stringify({ type, payload }));
    }

    /** Deliver an arbitrary (possibly invalid) frame body. */
    simulateRaw(data: string) {
        this.onmessage?.({ data } as MessageEvent);
    }

    /** Parsed frames this client sent. */
    get sent(): SentFrame[] {
        return this.sentRaw.map((raw) => JSON.parse(raw) as SentFrame);
    }

    sentOfType(type: string): SentFrame[] {
        return this.sent.filter((f) => f.type === type);
    }
}

// ---------------------------------------------------------------------------
// Store reset
// ---------------------------------------------------------------------------

const pristine = { ...useTaskStore.getState() };

function resetStore() {
    useTaskStore.setState(
        {
            ...pristine,
            tasks: new Map(),
            archivedTasks: [],
            showArchivedTasks: false,
            selectedTaskId: null,
            lastSelectedTaskByWorkspace: new Map(),
            isConnected: false,
            isServerReloading: false,
            isOffline: false,
            errorNotification: null,
            workspaces: [],
            expandedWorkspaces: new Set(),
            expandedWorkspacesInitialized: false,
            taskSummaries: new Map(),
            chatMessages: [],
            chatTyping: false,
            waitingInputNotifications: new Map(),
            taskDraftInputs: new Map(),
            scheduledTasks: new Map(),
            unreadTaskIds: new Set(),
            activityLog: [],
            pendingDeleteRequest: null,
            autoFocusOnInput: false,
            browserNotificationsEnabled: false,
            notifyOnCompletion: true,
            notifyOnWaitingInput: true,
        },
        true,
    );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTask(id: string, overrides: Record<string, unknown> = {}) {
    return {
        id,
        prompt: `prompt for ${id}`,
        workspaceId: '/ws/alpha',
        state: 'idle',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        lastActivity: new Date('2026-01-01T00:00:00Z'),
        ...overrides,
    } as never;
}

function makeWorkspace(id: string, overrides: Record<string, unknown> = {}) {
    return {
        id,
        path: id,
        name: id.split('/').pop(),
        ...overrides,
    } as never;
}

/**
 * Route-aware fetch stub. `routes` maps a URL substring → the JSON body.
 * Anything unmatched resolves ok:false so an unexpected call is visible.
 */
function stubFetch(routes: Record<string, unknown>) {
    const fn = vi.fn(async (url: string) => {
        const hit = Object.keys(routes).find((k) => String(url).includes(k));
        if (hit === undefined) {
            return { ok: false, status: 404, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => routes[hit] };
    });
    global.fetch = fn as unknown as typeof fetch;
    return fn;
}

/** Mount the hook and bring the socket to OPEN. */
function mountConnected() {
    const view = renderHook(() => useWebSocket());
    act(() => {
        FakeWebSocket.last.simulateOpen();
    });
    return { ...view, ws: FakeWebSocket.last };
}

/**
 * Mount, open, and deliver `init` so `initializedRef` is set (the hook
 * suppresses completion sounds/notifications before init).
 */
function mountInitialized(tasks: unknown[] = [], workspaces: unknown[] = []) {
    const view = mountConnected();
    act(() => {
        view.ws.simulateMessage('init', { tasks, workspaces });
    });
    return view;
}

let realWebSocket: typeof WebSocket;

beforeEach(() => {
    vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    realWebSocket = global.WebSocket;
    global.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    FakeWebSocket.reset();
    hoisted.tunnel.enabled = false;
    resetStore();
    localStorage.clear();
    stubFetch({});
    vi.mocked(playTaskCompletionSound).mockClear();
    vi.mocked(sendTaskCompletionNotification).mockClear();
    vi.mocked(sendTaskWaitingInputNotification).mockClear();
    // Console noise from a very chatty hook.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    // Unmount NOW, while fake timers are still installed. RTL's own auto-cleanup
    // afterEach is registered at import time so it runs *after* this hook — late
    // enough that the socket's async close event would land on real timers in
    // the middle of the *next* test and flip isConnected back to false there.
    cleanup();
    act(() => {
        vi.advanceTimersByTime(1);
    });
    global.WebSocket = realWebSocket;
    vi.useRealTimers();
    vi.restoreAllMocks();
});

// ===========================================================================

describe('useWebSocket — connection lifecycle', () => {
    it('opens exactly one socket to the configured URL on mount', () => {
        renderHook(() => useWebSocket());

        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(FakeWebSocket.last.url).toBe(hoisted.WS_URL);
    });

    it('reports connected only once the socket is actually open', () => {
        renderHook(() => useWebSocket());
        expect(useTaskStore.getState().isConnected).toBe(false);

        act(() => {
            FakeWebSocket.last.simulateOpen();
        });
        expect(useTaskStore.getState().isConnected).toBe(true);
    });

    it('marks disconnected when the socket drops', () => {
        const { ws } = mountConnected();

        act(() => {
            ws.simulateClose();
        });

        expect(useTaskStore.getState().isConnected).toBe(false);
    });

    it('does not open a second socket while one is already connecting', () => {
        renderHook(() => useWebSocket());
        expect(FakeWebSocket.instances).toHaveLength(1);

        // An `online` event re-enters connect() while the first socket is
        // still CONNECTING — it must be a no-op, not a duplicate connection.
        act(() => {
            window.dispatchEvent(new Event('online'));
        });

        expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it('survives an error event without tearing down the socket', () => {
        const { ws } = mountConnected();

        act(() => {
            ws.simulateError();
        });

        expect(useTaskStore.getState().isConnected).toBe(true);
        expect(ws.closeCount).toBe(0);
    });
});

// ===========================================================================

describe('useWebSocket — outbound messages', () => {
    it('serializes each action into a {type, payload} frame', () => {
        const { result, ws } = mountConnected();

        act(() => {
            result.current.createTask('do the thing', '/ws/alpha', 120, 40);
        });

        expect(ws.sent).toEqual([
            {
                type: 'task:create',
                payload: { prompt: 'do the thing', workspaceId: '/ws/alpha', initialCols: 120, initialRows: 40 },
            },
        ]);
    });

    it('only includes isolate when worktree isolation was requested', () => {
        const { result, ws } = mountConnected();

        act(() => {
            result.current.createTask('a', '/ws/alpha', 80, 24, false);
            result.current.createTask('b', '/ws/alpha', 80, 24, true);
        });

        expect(ws.sent[0].payload).not.toHaveProperty('isolate');
        expect(ws.sent[1].payload).toMatchObject({ isolate: true });
    });

    /**
     * Every thin action wrapper is a one-line mapping from a function call to a
     * wire frame. A table keeps them honest without 35 near-identical tests.
     */
    interface FrameCase {
        name: string;
        invoke: (api: ClaudiaWsApi) => void;
        type: string;
        payload: unknown;
    }

    const FRAME_CASES: FrameCase[] = [
        { name: 'selectTaskOnServer', invoke: (api) => api.selectTaskOnServer('t1'), type: 'task:select', payload: { taskId: 't1' } },
        { name: 'sendTaskInput', invoke: (api) => api.sendTaskInput('t1', 'hi'), type: 'task:input', payload: { taskId: 't1', input: 'hi' } },
        { name: 'resizeTask', invoke: (api) => api.resizeTask('t1', 100, 30), type: 'task:resize', payload: { taskId: 't1', cols: 100, rows: 30 } },
        { name: 'destroyTask', invoke: (api) => api.destroyTask('t1'), type: 'task:destroy', payload: { taskId: 't1' } },
        { name: 'interruptTask', invoke: (api) => api.interruptTask('t1'), type: 'task:interrupt', payload: { taskId: 't1' } },
        { name: 'archiveTask', invoke: (api) => api.archiveTask('t1'), type: 'task:archive', payload: { taskId: 't1' } },
        { name: 'reconnectTask', invoke: (api) => api.reconnectTask('t1'), type: 'task:reconnect', payload: { taskId: 't1' } },
        { name: 'restoreTask', invoke: (api) => api.restoreTask('t1'), type: 'task:restore', payload: { taskId: 't1' } },
        { name: 'createWorkspace', invoke: (api) => api.createWorkspace('/ws/new'), type: 'workspace:create', payload: { path: '/ws/new' } },
        { name: 'deleteWorkspace', invoke: (api) => api.deleteWorkspace('/ws/alpha'), type: 'workspace:delete', payload: { workspaceId: '/ws/alpha' } },
        { name: 'reorderWorkspaces', invoke: (api) => api.reorderWorkspaces(0, 2), type: 'workspace:reorder', payload: { fromIndex: 0, toIndex: 2 } },
        { name: 'setWorkspaceOrder', invoke: (api) => api.setWorkspaceOrder(['b', 'a']), type: 'workspace:setOrder', payload: { orderedIds: ['b', 'a'] } },
        { name: 'reorderTasks', invoke: (api) => api.reorderTasks([{ taskId: 't1', order: 3 }]), type: 'task:reorder', payload: { taskOrders: [{ taskId: 't1', order: 3 }] } },
        { name: 'openFolder', invoke: (api) => api.openFolder('/ws/alpha'), type: 'workspace:openFolder', payload: { workspaceId: '/ws/alpha' } },
        { name: 'openTerminal', invoke: (api) => api.openTerminal('/ws/alpha'), type: 'workspace:openTerminal', payload: { workspaceId: '/ws/alpha' } },
        { name: 'setSystemPrompt', invoke: (api) => api.setSystemPrompt('/ws/alpha', 'be terse'), type: 'workspace:systemPrompt:set', payload: { workspaceId: '/ws/alpha', systemPrompt: 'be terse' } },
        { name: 'requestRecentWorkspaces', invoke: (api) => api.requestRecentWorkspaces(), type: 'workspace:recent:list', payload: {} },
        { name: 'clearRecentWorkspace', invoke: (api) => api.clearRecentWorkspace('/ws/alpha'), type: 'workspace:recent:clear', payload: { workspaceId: '/ws/alpha' } },
        { name: 'requestArchivedTasks', invoke: (api) => api.requestArchivedTasks(), type: 'task:archived:list', payload: {} },
        { name: 'restoreArchivedTask', invoke: (api) => api.restoreArchivedTask('t1'), type: 'task:archived:restore', payload: { taskId: 't1' } },
        { name: 'deleteArchivedTask', invoke: (api) => api.deleteArchivedTask('t1'), type: 'task:archived:delete', payload: { taskId: 't1' } },
        { name: 'continueArchivedTask', invoke: (api) => api.continueArchivedTask('t1'), type: 'task:archived:continue', payload: { taskId: 't1' } },
        { name: 'pushToGithub', invoke: (api) => api.pushToGithub('/ws/alpha'), type: 'git:push', payload: { workspaceId: '/ws/alpha' } },
        { name: 'resetWorkspace', invoke: (api) => api.resetWorkspace('/ws/alpha'), type: 'workspace:reset', payload: { workspaceId: '/ws/alpha' } },
        { name: 'renameWorkspace', invoke: (api) => api.renameWorkspace('/ws/alpha', 'Alpha'), type: 'workspace:rename', payload: { workspaceId: '/ws/alpha', displayName: 'Alpha' } },
        { name: 'requestChatHistory', invoke: (api) => api.requestChatHistory(), type: 'supervisor:chat:history', payload: {} },
        { name: 'clearChatHistory', invoke: (api) => api.clearChatHistory(), type: 'supervisor:chat:clear', payload: {} },
        { name: 'requestTaskAnalysis', invoke: (api) => api.requestTaskAnalysis('t1'), type: 'supervisor:analyze', payload: { taskId: 't1' } },
        { name: 'sendChatMessage', invoke: (api) => api.sendChatMessage('yo', 't1'), type: 'supervisor:chat:message', payload: { content: 'yo', taskId: 't1' } },
        { name: 'executeSupervisorAction', invoke: (api) => api.executeSupervisorAction('t1', { type: 'retry' } as never), type: 'supervisor:action', payload: { taskId: 't1', action: { type: 'retry' } } },
        { name: 'toggleReference', invoke: (api) => api.toggleReference('/ws/alpha', 'docs/'), type: 'workspace:references:toggle', payload: { workspaceId: '/ws/alpha', referencePath: 'docs/' } },
        { name: 'addCustomReference', invoke: (api) => api.addCustomReference('/ws/alpha', 'docs/x.md', 'notes'), type: 'workspace:references:add', payload: { workspaceId: '/ws/alpha', path: 'docs/x.md', description: 'notes' } },
        { name: 'removeReference', invoke: (api) => api.removeReference('/ws/alpha', 'ref1'), type: 'workspace:references:remove', payload: { workspaceId: '/ws/alpha', referenceId: 'ref1' } },
        { name: 'deleteScheduledTask', invoke: (api) => api.deleteScheduledTask('c1'), type: 'cron:delete', payload: { cronId: 'c1' } },
        { name: 'rejectDeleteRequest', invoke: (api) => api.rejectDeleteRequest('t1', 'req1'), type: 'task:deleteRejected', payload: { taskId: 't1', requestId: 'req1' } },
    ];

    it.each(FRAME_CASES)('$name sends the right frame', ({ invoke, type, payload }) => {
        const { result, ws } = mountConnected();

        act(() => {
            invoke(result.current);
        });

        expect(ws.sent).toEqual([{ type, payload }]);
    });

    it('defaults revertTask to leaving untracked files alone', () => {
        const { result, ws } = mountConnected();

        act(() => {
            result.current.revertTask('t1');
        });

        expect(ws.sent[0].payload).toEqual({ taskId: 't1', cleanUntracked: false });
    });

    it('tags user-initiated renames so the backend can distinguish them from agent renames', () => {
        const { result, ws } = mountConnected();

        act(() => {
            result.current.renameTask('t1', 'My Task');
        });

        expect(ws.sent[0].payload).toEqual({ taskId: 't1', displayName: 'My Task', source: 'user' });
    });

    it('defaults scheduled tasks to recurring and collapses pause into an update', () => {
        const { result, ws } = mountConnected();

        act(() => {
            result.current.createScheduledTask('t1', '*/5 * * * *', 'check');
            result.current.pauseScheduledTask('c1', true);
            result.current.updateScheduledTask('c1', { prompt: 'new' });
        });

        expect(ws.sent[0]).toEqual({
            type: 'cron:create',
            payload: { taskId: 't1', cronExpression: '*/5 * * * *', prompt: 'check', isRecurring: true },
        });
        expect(ws.sent[1]).toEqual({ type: 'cron:update', payload: { cronId: 'c1', isPaused: true } });
        expect(ws.sent[2]).toEqual({ type: 'cron:update', payload: { cronId: 'c1', prompt: 'new' } });
    });

    it('drops (and warns about) messages sent while the socket is not open', () => {
        // Documents current behavior: there is NO outbound queue. Anything sent
        // before open or during a reconnect gap is lost, not replayed.
        const { result } = renderHook(() => useWebSocket());
        const ws = FakeWebSocket.last;

        act(() => {
            result.current.sendTaskInput('t1', 'lost input');
        });

        expect(ws.sentRaw).toHaveLength(0);
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Cannot send task:input'));
    });

    it('does not replay messages dropped during a disconnect once reconnected', () => {
        const { result, ws } = mountConnected();

        act(() => {
            ws.simulateClose();
        });
        act(() => {
            result.current.sendTaskInput('t1', 'lost input');
        });
        act(() => {
            vi.advanceTimersByTime(1000);
        });
        act(() => {
            FakeWebSocket.last.simulateOpen();
        });

        // Regression guard: if an outbound queue is ever added, this assertion
        // is the one to flip.
        expect(FakeWebSocket.last.sentRaw).toHaveLength(0);
    });
});

// ===========================================================================

describe('sendWsMessage — module singleton', () => {
    it('sends through the live socket without opening a second connection', () => {
        const { ws } = mountConnected();

        act(() => {
            sendWsMessage('shell:input', { data: 'ls\n' });
        });

        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(ws.sent).toEqual([{ type: 'shell:input', payload: { data: 'ls\n' } }]);
    });

    it('warns instead of throwing when no socket is open', () => {
        const { unmount } = mountConnected();
        unmount();

        expect(() => sendWsMessage('shell:input', { data: 'x' })).not.toThrow();
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('cannot send shell:input'));
    });

    it('stops routing to a socket that has closed', () => {
        const { ws } = mountConnected();

        act(() => {
            ws.simulateClose();
        });
        act(() => {
            sendWsMessage('shell:input', { data: 'x' });
        });

        expect(ws.sentRaw).toHaveLength(0);
    });
});

// ===========================================================================

describe('useWebSocket — inbound dispatch', () => {
    it('init seeds tasks and workspaces and clears the reloading banner', () => {
        useTaskStore.setState({ isServerReloading: true });
        const { ws } = mountConnected();

        act(() => {
            ws.simulateMessage('init', {
                tasks: [makeTask('t1'), makeTask('t2')],
                workspaces: [makeWorkspace('/ws/alpha'), makeWorkspace('/ws/beta')],
            });
        });

        const state = useTaskStore.getState();
        expect([...state.tasks.keys()]).toEqual(['t1', 't2']);
        expect(state.workspaces.map((w) => w.id)).toEqual(['/ws/alpha', '/ws/beta']);
        expect(state.isServerReloading).toBe(false);
    });

    it('init tolerates a payload with no workspaces', () => {
        const { ws } = mountConnected();

        act(() => {
            ws.simulateMessage('init', { tasks: [makeTask('t1')] });
        });

        expect(useTaskStore.getState().tasks.size).toBe(1);
        expect(useTaskStore.getState().workspaces).toEqual([]);
    });

    it('init pulls settings from /api/config into the store', async () => {
        stubFetch({
            '/api/config': {
                autoFocusOnInput: true,
                supervisorEnabled: true,
                tokenCostEnabled: true,
                deepgramApiKey: 'dg-key',
                aiCoreCredentials: {
                    clientId: 'id',
                    clientSecret: 'secret',
                    authUrl: 'https://auth',
                    baseUrl: 'https://base',
                },
            },
            '/api/cron': [],
        });
        const { ws } = mountConnected();

        await act(async () => {
            ws.simulateMessage('init', { tasks: [], workspaces: [] });
            await vi.runAllTicks?.();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        const state = useTaskStore.getState();
        expect(state.autoFocusOnInput).toBe(true);
        expect(state.supervisorEnabled).toBe(true);
        expect(state.tokenCostEnabled).toBe(true);
        expect(state.aiCoreConfigured).toBe(true);
        expect(state.deepgramApiKey).toBe('dg-key');
    });

    it('treats env-provided AI Core credentials as configured', async () => {
        stubFetch({ '/api/config': { aiCoreConfiguredFromEnv: true }, '/api/cron': [] });
        const { ws } = mountConnected();

        await act(async () => {
            ws.simulateMessage('init', { tasks: [], workspaces: [] });
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(useTaskStore.getState().aiCoreConfigured).toBe(true);
    });

    it('treats partial AI Core credentials as NOT configured', async () => {
        stubFetch({ '/api/config': { aiCoreCredentials: { clientId: 'id' } }, '/api/cron': [] });
        const { ws } = mountConnected();

        await act(async () => {
            ws.simulateMessage('init', { tasks: [], workspaces: [] });
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(useTaskStore.getState().aiCoreConfigured).toBe(false);
    });

    it('a failing /api/config does not break init', async () => {
        global.fetch = vi.fn(async () => {
            throw new Error('network down');
        }) as unknown as typeof fetch;
        const { ws } = mountConnected();

        await act(async () => {
            ws.simulateMessage('init', { tasks: [makeTask('t1')], workspaces: [] });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(useTaskStore.getState().tasks.size).toBe(1);
        expect(useTaskStore.getState().isConnected).toBe(true);
    });

    it('task:created from the UI adds, selects, and tells the server it is active', () => {
        const { ws } = mountConnected();

        act(() => {
            ws.simulateMessage('task:created', { task: makeTask('t1') });
        });

        expect(useTaskStore.getState().tasks.has('t1')).toBe(true);
        expect(useTaskStore.getState().selectedTaskId).toBe('t1');
        expect(ws.sentOfType('task:select')).toEqual([{ type: 'task:select', payload: { taskId: 't1' } }]);
    });

    it('task:created from MCP adds the task but must NOT steal focus', () => {
        // Agent-spawned tasks yanking the user's view was a real regression.
        useTaskStore.setState({ selectedTaskId: 'existing' });
        const { ws } = mountConnected();

        act(() => {
            ws.simulateMessage('task:created', { task: makeTask('t9'), source: 'mcp' });
        });

        expect(useTaskStore.getState().tasks.has('t9')).toBe(true);
        expect(useTaskStore.getState().selectedTaskId).toBe('existing');
        expect(ws.sentOfType('task:select')).toEqual([]);
    });

    it('tasks:updated replaces the task list and clears the reloading banner', () => {
        useTaskStore.setState({ isServerReloading: true });
        const { ws } = mountConnected();

        act(() => {
            ws.simulateMessage('tasks:updated', { tasks: [makeTask('t1'), makeTask('t2')] });
        });

        expect(useTaskStore.getState().tasks.size).toBe(2);
        expect(useTaskStore.getState().isServerReloading).toBe(false);
    });

    it('tasks:updated with no tasks array still clears the reloading banner', () => {
        useTaskStore.setState({ isServerReloading: true, tasks: new Map([['t1', makeTask('t1')]]) as never });
        const { ws } = mountConnected();

        act(() => {
            ws.simulateMessage('tasks:updated', {});
        });

        expect(useTaskStore.getState().tasks.size).toBe(1);
        expect(useTaskStore.getState().isServerReloading).toBe(false);
    });

    it('task:destroyed removes the task', () => {
        const { ws } = mountInitialized([makeTask('t1'), makeTask('t2')]);

        act(() => {
            ws.simulateMessage('task:destroyed', { taskId: 't1' });
        });

        expect([...useTaskStore.getState().tasks.keys()]).toEqual(['t2']);
    });

    it('task:deleteRequest parks the agent request for user confirmation', () => {
        const { ws } = mountConnected();
        const request = { taskId: 't1', requestId: 'req1', taskName: 'Cleanup' };

        act(() => {
            ws.simulateMessage('task:deleteRequest', request);
        });

        expect(useTaskStore.getState().pendingDeleteRequest).toEqual(request);
    });

    it('workspace:created / workspace:deleted add and remove a workspace', () => {
        const { ws } = mountConnected();

        act(() => {
            ws.simulateMessage('workspace:created', { workspace: makeWorkspace('/ws/alpha') });
        });
        expect(useTaskStore.getState().workspaces.map((w) => w.id)).toEqual(['/ws/alpha']);

        act(() => {
            ws.simulateMessage('workspace:deleted', { workspaceId: '/ws/alpha' });
        });
        expect(useTaskStore.getState().workspaces).toEqual([]);
    });

    it('workspace:reordered and tasks:reordered apply the server ordering verbatim', () => {
        const { ws } = mountConnected();

        act(() => {
            ws.simulateMessage('workspace:reordered', {
                workspaces: [makeWorkspace('/ws/beta'), makeWorkspace('/ws/alpha')],
            });
            ws.simulateMessage('tasks:reordered', { tasks: [makeTask('t2'), makeTask('t1')] });
        });

        expect(useTaskStore.getState().workspaces.map((w) => w.id)).toEqual(['/ws/beta', '/ws/alpha']);
        expect([...useTaskStore.getState().tasks.keys()]).toEqual(['t2', 't1']);
    });

    it('workspace:updated handles both the singular and the whole-list form', () => {
        const { ws } = mountConnected();

        act(() => {
            ws.simulateMessage('workspace:updated', {
                workspaces: [makeWorkspace('/ws/alpha'), makeWorkspace('/ws/beta')],
            });
        });
        expect(useTaskStore.getState().workspaces).toHaveLength(2);

        act(() => {
            ws.simulateMessage('workspace:updated', {
                workspace: makeWorkspace('/ws/alpha', { autoWorktree: true }),
            });
        });
        const alpha = useTaskStore.getState().workspaces.find((w) => w.id === '/ws/alpha');
        expect(alpha).toMatchObject({ autoWorktree: true });
        expect(useTaskStore.getState().workspaces).toHaveLength(2);
    });

    it('task:summary stores the summary against its task', () => {
        const { ws } = mountConnected();
        const summary = { taskId: 't1', summary: 'did stuff', suggestedActions: [], timestamp: new Date() };

        act(() => {
            ws.simulateMessage('task:summary', { summary });
        });

        expect(useTaskStore.getState().taskSummaries.get('t1')).toMatchObject({ summary: 'did stuff' });
    });

    it('supervisor chat messages, history and typing land in the store', () => {
        const { ws } = mountConnected();

        act(() => {
            ws.simulateMessage('supervisor:chat:history', {
                messages: [
                    { id: 'm1', role: 'user', content: 'hi' },
                    { id: 'm2', role: 'assistant', content: 'hello' },
                ],
            });
        });
        expect(useTaskStore.getState().chatMessages).toHaveLength(2);

        act(() => {
            ws.simulateMessage('supervisor:chat:response', {
                message: { id: 'm3', role: 'assistant', content: 'more' },
            });
        });
        expect(useTaskStore.getState().chatMessages.map((m) => m.content)).toEqual(['hi', 'hello', 'more']);

        act(() => {
            ws.simulateMessage('supervisor:chat:typing', { isTyping: true });
        });
        expect(useTaskStore.getState().chatTyping).toBe(true);
    });

    it('a re-delivered chat message is not duplicated', () => {
        const { ws } = mountConnected();

        act(() => {
            ws.simulateMessage('supervisor:chat:response', { message: { id: 'm1', role: 'assistant', content: 'x' } });
            ws.simulateMessage('supervisor:chat:response', { message: { id: 'm1', role: 'assistant', content: 'x' } });
        });

        expect(useTaskStore.getState().chatMessages).toHaveLength(1);
    });

    it('SHARP EDGE: chat messages with no id collapse into one', () => {
        // addChatMessage dedupes on `m.id === message.id`, so two id-less
        // messages both compare undefined === undefined and the second is
        // silently dropped. Documented, not desired — see final report.
        const { ws } = mountConnected();

        act(() => {
            ws.simulateMessage('supervisor:chat:response', { message: { role: 'assistant', content: 'first' } });
            ws.simulateMessage('supervisor:chat:response', { message: { role: 'assistant', content: 'second' } });
        });

        expect(useTaskStore.getState().chatMessages).toHaveLength(1);
    });

    it('task:tokenUsage updates usage for the task', () => {
        const { ws } = mountInitialized([makeTask('t1')]);

        act(() => {
            ws.simulateMessage('task:tokenUsage', {
                taskId: 't1',
                tokenUsage: { inputTokens: 10, outputTokens: 20, totalCostUsd: 0.5 },
            });
        });

        expect(useTaskStore.getState().tasks.get('t1')?.tokenUsage).toMatchObject({ inputTokens: 10 });
    });

    it('server:reloading and server:reconnecting both raise the reloading banner', () => {
        const { ws } = mountConnected();

        act(() => {
            ws.simulateMessage('server:reloading', {});
        });
        expect(useTaskStore.getState().isServerReloading).toBe(true);

        useTaskStore.setState({ isServerReloading: false });
        act(() => {
            ws.simulateMessage('server:reconnecting', { message: 'restoring 3 tasks' });
        });
        expect(useTaskStore.getState().isServerReloading).toBe(true);
    });

    it('tunnel:status is re-broadcast as a DOM event for App to pick up', () => {
        const { ws } = mountConnected();
        const listener = vi.fn();
        window.addEventListener('claudia:tunnelStatus', listener);

        act(() => {
            ws.simulateMessage('tunnel:status', { active: true, url: 'https://x.loca.lt' });
        });

        window.removeEventListener('claudia:tunnelStatus', listener);
        expect(listener).toHaveBeenCalledTimes(1);
        expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
            active: true,
            url: 'https://x.loca.lt',
        });
    });

    it('error surfaces the server message to the user', () => {
        const { ws } = mountConnected();

        act(() => {
            ws.simulateMessage('error', { message: 'workspace is not a git repo', code: 'NOT_GIT' });
        });

        expect(useTaskStore.getState().errorNotification).toMatchObject({
            message: 'workspace is not a git repo',
            code: 'NOT_GIT',
        });
    });

    it('ignores unknown message types without disturbing state or the socket', () => {
        const { ws } = mountInitialized([makeTask('t1')]);

        act(() => {
            ws.simulateMessage('some:future:message', { anything: true });
        });

        expect(useTaskStore.getState().tasks.size).toBe(1);
        expect(useTaskStore.getState().isConnected).toBe(true);
        expect(ws.closeCount).toBe(0);
    });
});

// ===========================================================================

describe('useWebSocket — archived tasks', () => {
    it('task:archived:list replaces the archived list', () => {
        const { ws } = mountConnected();

        act(() => {
            ws.simulateMessage('task:archived:list', { tasks: [makeTask('a1'), makeTask('a2')] });
        });

        expect(useTaskStore.getState().archivedTasks.map((t) => t.id)).toEqual(['a1', 'a2']);
    });

    it('restoring moves a task out of the archive and back into the live list', () => {
        const { ws } = mountConnected();

        act(() => {
            ws.simulateMessage('task:archived:list', { tasks: [makeTask('a1'), makeTask('a2')] });
        });
        act(() => {
            ws.simulateMessage('task:archived:restored', { task: makeTask('a1') });
        });

        const state = useTaskStore.getState();
        expect(state.archivedTasks.map((t) => t.id)).toEqual(['a2']);
        expect(state.tasks.has('a1')).toBe(true);
        // Restore must not change what the user is looking at.
        expect(state.selectedTaskId).toBeNull();
    });

    it('continuing an archived task also selects it', () => {
        const { ws } = mountConnected();

        act(() => {
            ws.simulateMessage('task:archived:list', { tasks: [makeTask('a1')] });
        });
        act(() => {
            ws.simulateMessage('task:archived:continued', { task: makeTask('a1') });
        });

        const state = useTaskStore.getState();
        expect(state.archivedTasks).toEqual([]);
        expect(state.tasks.has('a1')).toBe(true);
        expect(state.selectedTaskId).toBe('a1');
    });

    it('a failed archive delete leaves the entry in place', () => {
        const { ws } = mountConnected();

        act(() => {
            ws.simulateMessage('task:archived:list', { tasks: [makeTask('a1')] });
        });

        act(() => {
            ws.simulateMessage('task:archived:deleted', { taskId: 'a1', success: false });
        });
        expect(useTaskStore.getState().archivedTasks).toHaveLength(1);

        act(() => {
            ws.simulateMessage('task:archived:deleted', { taskId: 'a1', success: true });
        });
        expect(useTaskStore.getState().archivedTasks).toHaveLength(0);
    });
});

// ===========================================================================

describe('useWebSocket — scheduled tasks (cron)', () => {
    it('cron:created and cron:deleted add and remove a schedule', () => {
        const { ws } = mountConnected();
        const scheduledTask = { id: 'c1', taskId: 't1', cronExpression: '* * * * *', prompt: 'x' };

        act(() => {
            ws.simulateMessage('cron:created', { scheduledTask });
        });
        expect(useTaskStore.getState().scheduledTasks.get('c1')).toMatchObject({ id: 'c1' });

        act(() => {
            ws.simulateMessage('cron:deleted', { cronId: 'c1' });
        });
        expect(useTaskStore.getState().scheduledTasks.size).toBe(0);
    });

    it('ignores cron:created with no schedule and cron:deleted with no id', () => {
        const { ws } = mountConnected();

        act(() => {
            ws.simulateMessage('cron:created', {});
            ws.simulateMessage('cron:deleted', {});
        });

        expect(useTaskStore.getState().scheduledTasks.size).toBe(0);
    });

    it('cron:updated refetches the whole schedule list from the backend', async () => {
        const fetchMock = stubFetch({
            '/api/cron': [{ id: 'c1', taskId: 't1', cronExpression: '* * * * *', prompt: 'refreshed' }],
        });
        const { ws } = mountConnected();

        await act(async () => {
            ws.simulateMessage('cron:updated', {});
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/cron'));
        expect(useTaskStore.getState().scheduledTasks.get('c1')).toMatchObject({ prompt: 'refreshed' });
    });

    it('cron:fired is informational only', () => {
        const { ws } = mountConnected();

        act(() => {
            ws.simulateMessage('cron:fired', { scheduledTaskId: 'c1', taskId: 't1', prompt: 'x' });
        });

        expect(useTaskStore.getState().errorNotification).toBeNull();
    });
});

// ===========================================================================

describe('useWebSocket — workspace:resetResult', () => {
    it('reports a partial reset as an error when branch checkout failed', () => {
        const { ws } = mountConnected();

        act(() => {
            ws.simulateMessage('workspace:resetResult', {
                workspaceId: '/ws/alpha',
                archivedCount: 3,
                totalTasks: 5,
                branchCheckout: false,
                checkedOutBranch: null,
                branchError: 'local changes would be overwritten',
                isGitRepo: true,
            });
        });

        const notification = useTaskStore.getState().errorNotification;
        expect(notification?.code).toBe('WORKSPACE_RESET_PARTIAL');
        expect(notification?.message).toContain('3 task(s) archived');
        // NOTE: the reset notification also summarising removed/failed worktrees
        // ("N worktree(s) removed" / "N worktree(s) failed") ships with PR #179.
        // Those two assertions are omitted here so this file stays green on main;
        // restore them together with that feature.
        expect(notification?.message).toContain('local changes would be overwritten');
    });

    it('stays silent on a fully successful reset', () => {
        const { ws } = mountConnected();

        act(() => {
            ws.simulateMessage('workspace:resetResult', {
                workspaceId: '/ws/alpha',
                archivedCount: 1,
                totalTasks: 1,
                branchCheckout: true,
                checkedOutBranch: 'main',
                branchError: null,
                isGitRepo: true,
            });
        });

        expect(useTaskStore.getState().errorNotification).toBeNull();
    });

    it('stays silent for a non-git workspace, which can never check out a branch', () => {
        const { ws } = mountConnected();

        act(() => {
            ws.simulateMessage('workspace:resetResult', {
                workspaceId: '/ws/alpha',
                archivedCount: 1,
                totalTasks: 1,
                branchCheckout: false,
                checkedOutBranch: null,
                branchError: null,
                isGitRepo: false,
            });
        });

        expect(useTaskStore.getState().errorNotification).toBeNull();
    });
});

// ===========================================================================

describe('useWebSocket — task:waitingInput', () => {
    it('records the prompt and logs an unread activity event when not viewing', () => {
        const { ws } = mountInitialized([makeTask('t1', { displayName: 'Alpha task' })]);

        act(() => {
            ws.simulateMessage('task:waitingInput', {
                taskId: 't1',
                inputType: 'permission',
                recentOutput: 'Allow write to file?',
            });
        });

        const state = useTaskStore.getState();
        expect(state.waitingInputNotifications.get('t1')).toMatchObject({
            taskId: 't1',
            inputType: 'permission',
            recentOutput: 'Allow write to file?',
        });
        expect(state.activityLog[0]).toMatchObject({
            taskId: 't1',
            type: 'waiting_input',
            taskName: 'Alpha task',
            message: 'Needs permission',
        });
        expect(state.unreadTaskIds.has('t1')).toBe(true);
    });

    it('does not mark unread when the user is already looking at that task', () => {
        const { ws } = mountInitialized([makeTask('t1')]);
        act(() => {
            useTaskStore.getState().selectTask('t1');
        });

        act(() => {
            ws.simulateMessage('task:waitingInput', { taskId: 't1', inputType: 'question', recentOutput: '?' });
        });

        expect(useTaskStore.getState().unreadTaskIds.has('t1')).toBe(false);
        expect(useTaskStore.getState().activityLog[0]).toMatchObject({ message: 'Has a question' });
    });

    it.each([
        ['permission', 'Needs permission'],
        ['question', 'Has a question'],
        ['confirmation', 'Needs confirmation'],
    ])('labels a %s prompt as "%s"', (inputType, label) => {
        const { ws } = mountInitialized([makeTask('t1')]);

        act(() => {
            ws.simulateMessage('task:waitingInput', { taskId: 't1', inputType, recentOutput: '' });
        });

        expect(useTaskStore.getState().activityLog[0]).toMatchObject({ message: label });
    });

    it('falls back to the prompt text when a task has no display name', () => {
        const { ws } = mountInitialized([makeTask('t1', { prompt: 'raw prompt text' })]);

        act(() => {
            ws.simulateMessage('task:waitingInput', { taskId: 't1', inputType: 'question', recentOutput: '' });
        });

        expect(useTaskStore.getState().activityLog[0]).toMatchObject({ taskName: 'raw prompt text' });
    });

    it('labels an unknown task rather than crashing', () => {
        const { ws } = mountInitialized([]);

        act(() => {
            ws.simulateMessage('task:waitingInput', { taskId: 'ghost', inputType: 'question', recentOutput: '' });
        });

        expect(useTaskStore.getState().activityLog[0]).toMatchObject({ taskName: 'Unknown' });
    });

    it('sends a browser notification only when enabled and not viewing the task', () => {
        useTaskStore.setState({ browserNotificationsEnabled: true, notifyOnWaitingInput: true });
        const { ws } = mountInitialized([makeTask('t1', { displayName: 'Alpha' })]);

        act(() => {
            ws.simulateMessage('task:waitingInput', { taskId: 't1', inputType: 'permission', recentOutput: 'out' });
        });
        expect(sendTaskWaitingInputNotification).toHaveBeenCalledWith({
            taskName: 'Alpha',
            recentOutput: 'out',
            inputType: 'permission',
            taskId: 't1',
        });

        vi.mocked(sendTaskWaitingInputNotification).mockClear();
        act(() => {
            useTaskStore.getState().selectTask('t1');
        });
        act(() => {
            ws.simulateMessage('task:waitingInput', { taskId: 't1', inputType: 'permission', recentOutput: 'out' });
        });
        expect(sendTaskWaitingInputNotification).not.toHaveBeenCalled();
    });

    it('sends no notification when notifications are switched off', () => {
        useTaskStore.setState({ browserNotificationsEnabled: false, notifyOnWaitingInput: true });
        const { ws } = mountInitialized([makeTask('t1')]);

        act(() => {
            ws.simulateMessage('task:waitingInput', { taskId: 't1', inputType: 'question', recentOutput: '' });
        });

        expect(sendTaskWaitingInputNotification).not.toHaveBeenCalled();
    });

    it('auto-focuses the waiting task and scrolls its terminal when the setting is on', () => {
        useTaskStore.setState({ autoFocusOnInput: true });
        const { ws } = mountInitialized([makeTask('t1')]);
        const scrollListener = vi.fn();
        const focusListener = vi.fn();
        window.addEventListener('terminal:scrollToBottom', scrollListener);
        window.addEventListener('taskInput:focus', focusListener);

        act(() => {
            ws.simulateMessage('task:waitingInput', { taskId: 't1', inputType: 'question', recentOutput: '' });
        });
        expect(useTaskStore.getState().selectedTaskId).toBe('t1');

        act(() => {
            vi.advanceTimersByTime(200);
        });
        window.removeEventListener('terminal:scrollToBottom', scrollListener);
        window.removeEventListener('taskInput:focus', focusListener);

        expect(scrollListener).toHaveBeenCalledTimes(1);
        expect(focusListener).toHaveBeenCalledTimes(1);
    });

    it('does not auto-focus when the setting is off', () => {
        useTaskStore.setState({ autoFocusOnInput: false, selectedTaskId: 'other' });
        const { ws } = mountInitialized([makeTask('t1'), makeTask('other')]);

        act(() => {
            ws.simulateMessage('task:waitingInput', { taskId: 't1', inputType: 'question', recentOutput: '' });
        });

        expect(useTaskStore.getState().selectedTaskId).toBe('other');
    });
});

// ===========================================================================

describe('useWebSocket — task:stateChanged', () => {
    it('applies the new task state', () => {
        const { ws } = mountInitialized([makeTask('t1', { state: 'idle' })]);

        act(() => {
            ws.simulateMessage('task:stateChanged', {
                task: makeTask('t1', { state: 'busy', lastActivity: new Date('2026-02-01T00:00:00Z') }),
            });
        });

        expect(useTaskStore.getState().tasks.get('t1')?.state).toBe('busy');
    });

    it.each(['busy', 'idle'])('clears a pending input prompt when the task goes %s', (state) => {
        const { ws } = mountInitialized([makeTask('t1', { state: 'busy' })]);
        act(() => {
            ws.simulateMessage('task:waitingInput', { taskId: 't1', inputType: 'question', recentOutput: '' });
        });
        expect(useTaskStore.getState().waitingInputNotifications.has('t1')).toBe(true);

        act(() => {
            ws.simulateMessage('task:stateChanged', {
                task: makeTask('t1', { state, lastActivity: new Date('2026-02-01T00:00:00Z') }),
            });
        });

        expect(useTaskStore.getState().waitingInputNotifications.has('t1')).toBe(false);
    });

    it('plays the completion sound and logs an event on busy → idle', () => {
        const { ws } = mountInitialized([makeTask('t1', { state: 'busy', displayName: 'Alpha' })]);

        act(() => {
            ws.simulateMessage('task:stateChanged', {
                task: makeTask('t1', { state: 'idle', displayName: 'Alpha', lastActivity: new Date('2026-02-01T00:00:00Z') }),
            });
        });

        expect(playTaskCompletionSound).toHaveBeenCalledTimes(1);
        expect(useTaskStore.getState().activityLog[0]).toMatchObject({
            taskId: 't1',
            type: 'completed',
            taskName: 'Alpha',
        });
        expect(useTaskStore.getState().unreadTaskIds.has('t1')).toBe(true);
    });

    it('does NOT chime for tasks that were already idle at page load', () => {
        // The init seed exists precisely so a reload does not blast a sound for
        // every historical task.
        const { ws } = mountInitialized([makeTask('t1', { state: 'idle' })]);

        act(() => {
            ws.simulateMessage('task:stateChanged', {
                task: makeTask('t1', { state: 'idle', lastActivity: new Date('2026-02-01T00:00:00Z') }),
            });
        });

        expect(playTaskCompletionSound).not.toHaveBeenCalled();
    });

    it('does NOT chime before init has been received', () => {
        const { ws } = mountConnected();

        act(() => {
            ws.simulateMessage('task:stateChanged', { task: makeTask('t1', { state: 'busy' }) });
        });
        act(() => {
            ws.simulateMessage('task:stateChanged', {
                task: makeTask('t1', { state: 'idle', lastActivity: new Date('2026-02-01T00:00:00Z') }),
            });
        });

        expect(playTaskCompletionSound).not.toHaveBeenCalled();
    });

    it('does not mark unread for the task the user is currently watching', () => {
        const { ws } = mountInitialized([makeTask('t1', { state: 'busy' })]);
        act(() => {
            useTaskStore.getState().selectTask('t1');
        });

        act(() => {
            ws.simulateMessage('task:stateChanged', {
                task: makeTask('t1', { state: 'idle', lastActivity: new Date('2026-02-01T00:00:00Z') }),
            });
        });

        expect(useTaskStore.getState().unreadTaskIds.has('t1')).toBe(false);
        expect(useTaskStore.getState().activityLog[0]).toMatchObject({ type: 'completed' });
    });

    it('puts the last assistant message in the completion notification', async () => {
        stubFetch({
            '/conversation': {
                messages: [
                    { role: 'user', content: 'go' },
                    { role: 'assistant', content: 'first' },
                    { role: 'assistant', content: 'final answer' },
                ],
            },
        });
        useTaskStore.setState({ browserNotificationsEnabled: true, notifyOnCompletion: true });
        const { ws } = mountInitialized([makeTask('t1', { state: 'busy', displayName: 'Alpha' })]);

        await act(async () => {
            ws.simulateMessage('task:stateChanged', {
                task: makeTask('t1', { state: 'idle', displayName: 'Alpha', lastActivity: new Date('2026-02-01T00:00:00Z') }),
            });
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(sendTaskCompletionNotification).toHaveBeenCalledWith({
            taskName: 'Alpha',
            lastMessage: 'final answer',
            taskId: 't1',
        });
    });

    it('still notifies when the conversation fetch fails', async () => {
        global.fetch = vi.fn(async () => {
            throw new Error('boom');
        }) as unknown as typeof fetch;
        useTaskStore.setState({ browserNotificationsEnabled: true, notifyOnCompletion: true });
        const { ws } = mountInitialized([makeTask('t1', { state: 'busy', displayName: 'Alpha' })]);

        await act(async () => {
            ws.simulateMessage('task:stateChanged', {
                task: makeTask('t1', { state: 'idle', displayName: 'Alpha', lastActivity: new Date('2026-02-01T00:00:00Z') }),
            });
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(sendTaskCompletionNotification).toHaveBeenCalledWith({ taskName: 'Alpha', taskId: 't1' });
    });

    it('does not notify for the task the user is already watching', async () => {
        useTaskStore.setState({ browserNotificationsEnabled: true, notifyOnCompletion: true });
        const { ws } = mountInitialized([makeTask('t1', { state: 'busy' })]);
        act(() => {
            useTaskStore.getState().selectTask('t1');
        });

        await act(async () => {
            ws.simulateMessage('task:stateChanged', {
                task: makeTask('t1', { state: 'idle', lastActivity: new Date('2026-02-01T00:00:00Z') }),
            });
            await Promise.resolve();
        });

        expect(sendTaskCompletionNotification).not.toHaveBeenCalled();
    });

    it('auto-focuses a completed task and fires all three scroll nudges', () => {
        useTaskStore.setState({ autoFocusOnInput: true });
        const { ws } = mountInitialized([makeTask('t1', { state: 'busy' })]);
        const scrollListener = vi.fn();
        window.addEventListener('terminal:scrollToBottom', scrollListener);

        act(() => {
            ws.simulateMessage('task:stateChanged', {
                task: makeTask('t1', { state: 'idle', lastActivity: new Date('2026-02-01T00:00:00Z') }),
            });
        });
        expect(useTaskStore.getState().selectedTaskId).toBe('t1');

        act(() => {
            vi.advanceTimersByTime(700);
        });
        window.removeEventListener('terminal:scrollToBottom', scrollListener);

        // 100ms / 300ms / 600ms — three retries because the terminal may not
        // have mounted yet.
        expect(scrollListener).toHaveBeenCalledTimes(3);
    });

    it('accepts a bulk task list on stateChanged', () => {
        const { ws } = mountInitialized([]);

        act(() => {
            ws.simulateMessage('task:stateChanged', { tasks: [makeTask('t1'), makeTask('t2')] });
        });

        expect(useTaskStore.getState().tasks.size).toBe(2);
    });
});

// ===========================================================================

describe('useWebSocket — malformed input', () => {
    it('survives unparseable JSON without closing the socket', () => {
        const { ws } = mountInitialized([makeTask('t1')]);

        act(() => {
            ws.simulateRaw('this is not json {{{');
        });

        expect(console.error).toHaveBeenCalledWith('[WebSocket] Error parsing message:', expect.anything());
        expect(useTaskStore.getState().isConnected).toBe(true);
        expect(useTaskStore.getState().tasks.size).toBe(1);
        expect(ws.closeCount).toBe(0);
    });

    it('keeps processing messages after a malformed one', () => {
        const { ws } = mountConnected();

        act(() => {
            ws.simulateRaw('<html>gateway error</html>');
            ws.simulateMessage('tasks:updated', { tasks: [makeTask('t1')] });
        });

        expect(useTaskStore.getState().tasks.size).toBe(1);
    });

    it('survives a well-formed frame whose payload is missing', () => {
        const { ws } = mountConnected();

        act(() => {
            ws.simulateRaw(JSON.stringify({ type: 'task:created' }));
        });

        expect(useTaskStore.getState().isConnected).toBe(true);
        expect(ws.closeCount).toBe(0);
    });

    it('survives a frame with no type at all', () => {
        const { ws } = mountConnected();

        act(() => {
            ws.simulateRaw(JSON.stringify({ payload: { nope: true } }));
        });

        expect(useTaskStore.getState().isConnected).toBe(true);
    });
});

// ===========================================================================

describe('useWebSocket — reconnection with exponential backoff', () => {
    it('reconnects 1s after an unexpected drop', () => {
        const { ws } = mountConnected();

        act(() => {
            ws.simulateClose({ code: 1006, wasClean: false });
        });

        act(() => {
            vi.advanceTimersByTime(999);
        });
        expect(FakeWebSocket.instances).toHaveLength(1);

        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(FakeWebSocket.instances).toHaveLength(2);
    });

    it('doubles the delay on each consecutive failure', () => {
        mountConnected();
        const observed: number[] = [];

        // Each attempt fails without ever opening, so attempts keep climbing.
        for (let i = 0; i < 5; i++) {
            const before = FakeWebSocket.instances.length;
            act(() => {
                FakeWebSocket.last.simulateClose();
            });

            // Find the delay by stepping until a new socket appears.
            let waited = 0;
            const step = 1;
            while (FakeWebSocket.instances.length === before && waited < 120_000) {
                act(() => {
                    vi.advanceTimersByTime(step);
                });
                waited += step;
            }
            observed.push(waited);
        }

        expect(observed).toEqual([1000, 2000, 4000, 8000, 16000]);
    });

    it('caps the delay at 30s no matter how long the server stays down', () => {
        mountConnected();

        // Burn through enough attempts that 1000 * 2^n far exceeds the cap.
        for (let i = 0; i < 6; i++) {
            act(() => {
                FakeWebSocket.last.simulateClose();
            });
            act(() => {
                vi.advanceTimersByTime(60_000);
            });
        }

        const before = FakeWebSocket.instances.length;
        act(() => {
            FakeWebSocket.last.simulateClose();
        });
        act(() => {
            vi.advanceTimersByTime(29_999);
        });
        expect(FakeWebSocket.instances).toHaveLength(before);

        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(FakeWebSocket.instances).toHaveLength(before + 1);
    });

    it('resets the backoff after a successful reconnect', () => {
        mountConnected();

        // Two failures push the delay to 4s...
        act(() => {
            FakeWebSocket.last.simulateClose();
        });
        act(() => {
            vi.advanceTimersByTime(1000);
        });
        act(() => {
            FakeWebSocket.last.simulateClose();
        });
        act(() => {
            vi.advanceTimersByTime(2000);
        });

        // ...then the socket actually opens, which must clear the counter.
        act(() => {
            FakeWebSocket.last.simulateOpen();
        });
        expect(useTaskStore.getState().isConnected).toBe(true);

        const before = FakeWebSocket.instances.length;
        act(() => {
            FakeWebSocket.last.simulateClose();
        });
        act(() => {
            vi.advanceTimersByTime(999);
        });
        expect(FakeWebSocket.instances).toHaveLength(before);

        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(FakeWebSocket.instances).toHaveLength(before + 1);
    });

    it('reconnects after a CLEAN server-side close too (tsx watch restarts)', () => {
        // Deliberate: the dev server closes sockets normally on reload and the
        // UI must come back by itself. Only client-initiated teardown stops.
        const { ws } = mountConnected();

        act(() => {
            ws.simulateClose({ code: 1000, wasClean: true });
        });
        act(() => {
            vi.advanceTimersByTime(1000);
        });

        expect(FakeWebSocket.instances).toHaveLength(2);
    });

    it('ignores a late close from a socket that has already been replaced', () => {
        // REGRESSION: a superseded socket's close event used to flip
        // isConnected to false — flashing the offline banner while the new
        // socket was healthy — and queue a reconnect for a dead connection.
        const { ws: wsA } = mountConnected();

        act(() => {
            wsA.simulateClose();
        });
        act(() => {
            vi.advanceTimersByTime(1000);
        });
        const wsB = FakeWebSocket.last;
        expect(wsB).not.toBe(wsA);
        act(() => {
            wsB.simulateOpen();
        });
        expect(useTaskStore.getState().isConnected).toBe(true);

        // The old socket finally reports its close.
        act(() => {
            wsA.simulateClose();
        });

        expect(useTaskStore.getState().isConnected).toBe(true);
        act(() => {
            vi.advanceTimersByTime(120_000);
        });
        expect(FakeWebSocket.instances).toHaveLength(2);
    });

    it('does not stack duplicate reconnect timers when `online` races a pending retry', () => {
        const { ws } = mountConnected();

        act(() => {
            ws.simulateClose();
        });
        // Reconnect is pending; the browser comes back online and connects now.
        act(() => {
            window.dispatchEvent(new Event('online'));
        });
        expect(FakeWebSocket.instances).toHaveLength(2);

        // The superseded timer must have been cancelled, not left to fire.
        act(() => {
            vi.advanceTimersByTime(60_000);
        });
        expect(FakeWebSocket.instances).toHaveLength(2);
    });
});

// ===========================================================================

describe('useWebSocket — teardown', () => {
    it('closes the socket on unmount', () => {
        const { unmount, ws } = mountConnected();

        unmount();

        expect(ws.closeCount).toBe(1);
    });

    it('does NOT reconnect after unmount, even though close fires asynchronously', () => {
        // REGRESSION: cleanup cleared the pending timer and *then* called
        // close(); the async close event scheduled a fresh reconnect that
        // outlived the component and looped forever.
        const { unmount } = mountConnected();

        unmount();

        act(() => {
            vi.advanceTimersByTime(0); // deliver the close event
        });
        expect(FakeWebSocket.instances).toHaveLength(1);

        act(() => {
            vi.advanceTimersByTime(120_000);
        });
        expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it('leaves no timers pending after unmount', () => {
        const { unmount, ws } = mountConnected();

        // A reconnect is already queued when we tear down.
        act(() => {
            ws.simulateClose();
        });
        expect(vi.getTimerCount()).toBeGreaterThan(0);

        unmount();
        act(() => {
            vi.advanceTimersByTime(0);
        });

        expect(vi.getTimerCount()).toBe(0);
    });

    it('removes its window listeners on unmount', () => {
        const addSpy = vi.spyOn(window, 'addEventListener');
        const removeSpy = vi.spyOn(window, 'removeEventListener');

        const { unmount } = mountConnected();
        const added = addSpy.mock.calls.map(([type]) => type);
        expect(added).toEqual(expect.arrayContaining(['online', 'offline', 'notification:taskClick']));

        unmount();

        const removed = removeSpy.mock.calls.map(([type]) => type);
        for (const type of ['online', 'offline', 'notification:taskClick']) {
            expect(removed).toContain(type);
        }
    });

    it('an unmounted hook no longer reacts to online events', () => {
        const { unmount } = mountConnected();
        unmount();
        act(() => {
            vi.advanceTimersByTime(0);
        });

        act(() => {
            window.dispatchEvent(new Event('online'));
        });

        expect(FakeWebSocket.instances).toHaveLength(1);
    });
});

// ===========================================================================

describe('useWebSocket — network status', () => {
    it('tracks offline and online transitions and reconnects when back', () => {
        const { ws } = mountConnected();
        act(() => {
            ws.simulateClose();
        });

        act(() => {
            window.dispatchEvent(new Event('offline'));
        });
        expect(useTaskStore.getState().isOffline).toBe(true);

        act(() => {
            window.dispatchEvent(new Event('online'));
        });
        expect(useTaskStore.getState().isOffline).toBe(false);
        expect(FakeWebSocket.instances).toHaveLength(2);
    });

    it('an online event while already connected does not churn the socket', () => {
        mountConnected();

        act(() => {
            window.dispatchEvent(new Event('online'));
        });

        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(useTaskStore.getState().isConnected).toBe(true);
    });
});

// ===========================================================================

describe('useWebSocket — notification click', () => {
    it('selects the task, tells the server, and scrolls its terminal', () => {
        const { ws } = mountInitialized([makeTask('t1')]);
        const scrollListener = vi.fn();
        window.addEventListener('terminal:scrollToBottom', scrollListener);

        act(() => {
            window.dispatchEvent(new CustomEvent('notification:taskClick', { detail: { taskId: 't1' } }));
        });
        act(() => {
            vi.advanceTimersByTime(100);
        });
        window.removeEventListener('terminal:scrollToBottom', scrollListener);

        expect(useTaskStore.getState().selectedTaskId).toBe('t1');
        expect(ws.sentOfType('task:select')).toEqual([{ type: 'task:select', payload: { taskId: 't1' } }]);
        expect(scrollListener).toHaveBeenCalledTimes(1);
    });

    it('ignores a notification click with no task id', () => {
        const { ws } = mountInitialized([makeTask('t1')]);

        act(() => {
            window.dispatchEvent(new CustomEvent('notification:taskClick', { detail: {} }));
        });

        expect(useTaskStore.getState().selectedTaskId).toBeNull();
        expect(ws.sentOfType('task:select')).toEqual([]);
    });
});

// ===========================================================================

describe('useWebSocket — tunnel warmup', () => {
    beforeEach(() => {
        hoisted.tunnel.enabled = true;
    });

    it('warms the tunnel over HTTP before opening the socket', async () => {
        const fetchMock = stubFetch({ '/api/tunnel/status': { ok: true } });

        const view = renderHook(() => useWebSocket());
        // No socket yet — we are awaiting the warmup request.
        expect(FakeWebSocket.instances).toHaveLength(0);

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('/api/tunnel/status'),
            expect.objectContaining({ credentials: 'include' }),
        );
        expect(FakeWebSocket.instances).toHaveLength(1);
        view.unmount();
    });

    it('retries the warmup every 2s while the tunnel returns non-OK', async () => {
        global.fetch = vi.fn(async () => ({ ok: false, status: 502, statusText: 'Bad Gateway', json: async () => ({}) })) as unknown as typeof fetch;

        const view = renderHook(() => useWebSocket());
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(FakeWebSocket.instances).toHaveLength(0);

        // Warmup now succeeds; the queued retry should get through.
        stubFetch({ '/api/tunnel/status': { ok: true } });
        await act(async () => {
            vi.advanceTimersByTime(2000);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(FakeWebSocket.instances).toHaveLength(1);
        view.unmount();
    });

    it('retries the warmup when the request throws outright', async () => {
        global.fetch = vi.fn(async () => {
            throw new Error('tunnel unreachable');
        }) as unknown as typeof fetch;

        const view = renderHook(() => useWebSocket());
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(FakeWebSocket.instances).toHaveLength(0);
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        view.unmount();
    });

    it('abandons the warmup retry when the hook unmounts mid-flight', async () => {
        global.fetch = vi.fn(async () => {
            throw new Error('tunnel unreachable');
        }) as unknown as typeof fetch;

        const view = renderHook(() => useWebSocket());
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        view.unmount();
        act(() => {
            vi.advanceTimersByTime(120_000);
        });

        expect(FakeWebSocket.instances).toHaveLength(0);
    });
});
