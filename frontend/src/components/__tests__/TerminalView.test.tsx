/**
 * TerminalView behaviour tests.
 *
 * xterm.js needs a real renderer, so it is replaced at the module boundary by a
 * recording fake. That is deliberate: the interesting logic in TerminalView is
 * the code AROUND xterm — resize-oscillation suppression, the post-resize output
 * buffer, history restore/stripping and chunked scroll-up loading — and all of
 * it is observable through the calls the component makes on the terminal and the
 * frames it pushes onto the WebSocket.
 *
 * Everything time-based uses fake timers; nothing sleeps.
 */
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Task, Workspace } from '@claudia/shared';

// --- xterm fakes -----------------------------------------------------------
// Declared through vi.hoisted so the vi.mock factories (which are hoisted above
// the imports) can reach them.
const xterm = vi.hoisted(() => {
    const instances: FakeTerminal[] = [];

    class FakeTerminal {
        options: Record<string, unknown>;
        cols = 80;
        rows = 24;
        unicode = { activeVersion: '' };
        buffer = { active: { viewportY: 0, length: 24 } };
        element: HTMLElement | null = null;
        container: HTMLElement | null = null;
        /** Screen content, in write order. Cleared by reset() like a real terminal. */
        writes: string[] = [];
        addons: unknown[] = [];
        resetCount = 0;
        scrollToBottomCount = 0;
        scrolledToLines: number[] = [];
        refreshCount = 0;
        disposed = false;
        selection = '';
        pasted: string[] = [];
        keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
        dataCb: ((data: string) => void) | null = null;
        resizeCb: ((d: { cols: number; rows: number }) => void) | null = null;
        scrollCb: ((y: number) => void) | null = null;

        constructor(options: Record<string, unknown>) {
            this.options = options;
            instances.push(this);
        }

        loadAddon(addon: unknown) { this.addons.push(addon); }
        attachCustomKeyEventHandler(h: (e: KeyboardEvent) => boolean) { this.keyHandler = h; }
        onData(cb: (data: string) => void) { this.dataCb = cb; return { dispose() {} }; }
        onResize(cb: (d: { cols: number; rows: number }) => void) { this.resizeCb = cb; return { dispose() {} }; }
        onScroll(cb: (y: number) => void) { this.scrollCb = cb; return { dispose() {} }; }

        open(el: HTMLElement) {
            this.container = el;
            // TerminalView looks up `.xterm-viewport` to attach its scroll
            // listener, so the fake must produce one.
            const viewport = document.createElement('div');
            viewport.className = 'xterm-viewport';
            el.appendChild(viewport);
            const root = document.createElement('div');
            root.className = 'xterm';
            el.appendChild(root);
            this.element = root;
        }

        write(data: string, cb?: () => void) { this.writes.push(data); cb?.(); }
        reset() { this.resetCount += 1; this.writes = []; }
        refresh() { this.refreshCount += 1; }
        scrollToBottom() { this.scrollToBottomCount += 1; }
        scrollToLine(line: number) { this.scrolledToLines.push(line); }
        getSelection() { return this.selection; }
        clearSelection() { this.selection = ''; }
        paste(text: string) { this.pasted.push(text); }
        dispose() { this.disposed = true; }

        /** Everything currently on screen. */
        get screen() { return this.writes.join(''); }
    }

    class FakeFitAddon {
        fitCount = 0;
        fit() { this.fitCount += 1; }
        dispose() {}
    }
    class FakeWebglAddon {
        lossHandler: (() => void) | null = null;
        onContextLoss(cb: () => void) { this.lossHandler = cb; }
        dispose() {}
    }
    class FakeNoopAddon { dispose() {} }

    return { instances, FakeTerminal, FakeFitAddon, FakeWebglAddon, FakeNoopAddon };
});

vi.mock('@xterm/xterm', () => ({ Terminal: xterm.FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: xterm.FakeFitAddon }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: xterm.FakeWebglAddon }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: xterm.FakeNoopAddon }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: xterm.FakeNoopAddon }));

// Rendered as a child; it owns its own WebSocket frames and store reads, which
// would otherwise pollute the frame assertions here.
vi.mock('../TaskInputBar', () => ({ TaskInputBar: () => <div data-testid="task-input-bar" /> }));
vi.mock('../TaskTokenStats', () => ({ TaskTokenStats: () => null }));

import { TerminalView } from '../TerminalView';
import { useTaskStore } from '../../stores/taskStore';
import { getApiBaseUrl } from '../../config/api-config';
import { DARK_TERMINAL_THEME, LIGHT_TERMINAL_THEME } from '../../types/theme';

const TASK_ID = 'task-1';
const RESIZE_BUFFER_MS = 250;
const CHUNK_SIZE = 256 * 1024;

function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        id: TASK_ID,
        prompt: 'run the build',
        state: 'busy',
        workspaceId: '/ws',
        createdAt: new Date(0),
        lastActivity: new Date(0),
        ...overrides,
    } as Task;
}

class FakeSocket extends EventTarget {
    readyState = WebSocket.OPEN;
    send = vi.fn();
}

/** Decoded frames of a given type pushed onto the socket. */
function frames(socket: FakeSocket, type?: string) {
    return socket.send.mock.calls
        .map(([raw]) => JSON.parse(raw as string))
        .filter(m => !type || m.type === type);
}

function emit(socket: FakeSocket, message: unknown) {
    act(() => {
        socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
    });
}

function output(socket: FakeSocket, data: string, taskId = TASK_ID) {
    emit(socket, { type: 'task:output', payload: { taskId, data } });
}

/** Let queued promise callbacks run (fetch chains) without touching timers. */
async function flushPromises(rounds = 8) {
    for (let i = 0; i < rounds; i++) {
        // eslint-disable-next-line no-await-in-loop
        await act(async () => { await Promise.resolve(); });
    }
}

function mountTerminal(props: { task?: Partial<Task>; workspace?: Workspace; isMobile?: boolean } = {}) {
    const socket = new FakeSocket();
    const ref = { current: socket as unknown as WebSocket };
    const task = makeTask(props.task);
    const view = render(
        <TerminalView task={task} wsRef={ref} workspace={props.workspace} isMobile={props.isMobile} />
    );
    const term = xterm.instances[xterm.instances.length - 1];
    const viewport = view.container.querySelector('.xterm-viewport') as HTMLElement;
    return { socket, ref, task, view, term, viewport };
}

beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    xterm.instances.length = 0;
    useTaskStore.setState({ themePreference: 'dark' });

    // The mount path is gated behind a double requestAnimationFrame. Running it
    // synchronously keeps the tests deterministic without faking rAF timing.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => {});

    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: vi.fn(async () => {}), readText: vi.fn(async () => 'pasted') },
    });

    global.fetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({ totalSize: 0, isBase64Legacy: false }),
    })) as unknown as typeof fetch;
});

afterEach(() => {
    cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('TerminalView — mount handshake', () => {
    it('fits, then sends exactly one resize before requesting history', () => {
        const { socket, term } = mountTerminal();

        expect(term.container).not.toBeNull();
        expect(frames(socket)).toEqual([
            { type: 'task:resize', payload: { taskId: TASK_ID, cols: 80, rows: 24 } },
            { type: 'task:select', payload: { taskId: TASK_ID } },
        ]);
    });

    it('forwards terminal keystrokes as task:input', () => {
        const { socket, term } = mountTerminal();

        act(() => { term.dataCb?.('ls\r'); });

        expect(frames(socket, 'task:input')).toEqual([
            { type: 'task:input', payload: { taskId: TASK_ID, input: 'ls\r' } },
        ]);
    });

    it('disposes the terminal on unmount', () => {
        const { view, term } = mountTerminal();

        view.unmount();

        expect(term.disposed).toBe(true);
    });
});

describe('TerminalView — resize oscillation suppression', () => {
    // A scrollbar appearing/disappearing flips cols by 1-2 and used to ping-pong
    // the PTY between two widths, garbling the TUI. Changes of <= 2 cols at the
    // same row count must never reach the backend.
    it.each([1, 2])('suppresses a %i-column change at unchanged rows', (delta) => {
        const { socket, term } = mountTerminal();
        socket.send.mockClear();

        act(() => { term.resizeCb?.({ cols: 80 + delta, rows: 24 }); });

        expect(frames(socket, 'task:resize')).toHaveLength(0);
    });

    it('forwards a 3-column change', () => {
        const { socket, term } = mountTerminal();
        socket.send.mockClear();

        act(() => { term.resizeCb?.({ cols: 83, rows: 24 }); });

        expect(frames(socket, 'task:resize')).toEqual([
            { type: 'task:resize', payload: { taskId: TASK_ID, cols: 83, rows: 24 } },
        ]);
    });

    it('forwards a 1-column change when the row count also changed', () => {
        const { socket, term } = mountTerminal();
        socket.send.mockClear();

        act(() => { term.resizeCb?.({ cols: 81, rows: 30 }); });

        expect(frames(socket, 'task:resize')).toHaveLength(1);
    });

    it('measures suppression against the last SENT size, not the last seen one', () => {
        const { socket, term } = mountTerminal();
        socket.send.mockClear();

        // 80 -> 81 -> 82: each is within 2 of the last sent width (80), so the
        // whole drift is suppressed rather than accumulating into a resize.
        act(() => { term.resizeCb?.({ cols: 81, rows: 24 }); });
        act(() => { term.resizeCb?.({ cols: 82, rows: 24 }); });
        expect(frames(socket, 'task:resize')).toHaveLength(0);

        act(() => { term.resizeCb?.({ cols: 84, rows: 24 }); });
        expect(frames(socket, 'task:resize')).toHaveLength(1);
    });
});

describe('TerminalView — post-resize output buffering', () => {
    function resizeTo(term: typeof xterm.instances[number], cols: number) {
        act(() => { term.resizeCb?.({ cols, rows: 24 }); });
    }

    it('holds output for 250ms after a resize and flushes it in order', () => {
        const { socket, term } = mountTerminal();
        resizeTo(term, 90);
        term.writes = [];

        output(socket, 'first');
        output(socket, 'second');
        expect(term.writes).toEqual([]);

        act(() => { vi.advanceTimersByTime(RESIZE_BUFFER_MS - 1); });
        expect(term.writes).toEqual([]);

        act(() => { vi.advanceTimersByTime(1); });
        expect(term.writes).toEqual(['firstsecond']);
    });

    it('writes output immediately once the buffer window has elapsed', () => {
        const { socket, term } = mountTerminal();
        resizeTo(term, 90);
        act(() => { vi.advanceTimersByTime(RESIZE_BUFFER_MS); });
        term.writes = [];

        output(socket, 'live');

        expect(term.writes).toEqual(['live']);
    });

    it('restarts the window when a second resize lands inside it', () => {
        const { socket, term } = mountTerminal();
        resizeTo(term, 90);
        act(() => { vi.advanceTimersByTime(200); });
        resizeTo(term, 100);
        term.writes = [];

        output(socket, 'held');
        act(() => { vi.advanceTimersByTime(200) });
        expect(term.writes).toEqual([]);

        act(() => { vi.advanceTimersByTime(50); });
        expect(term.writes).toEqual(['held']);
    });

    it('does not buffer when the resize was suppressed', () => {
        const { socket, term } = mountTerminal();
        resizeTo(term, 81); // suppressed: <= 2 cols
        term.writes = [];

        output(socket, 'straight through');

        expect(term.writes).toEqual(['straight through']);
    });

    it('ignores output addressed to a different task', () => {
        const { socket, term } = mountTerminal();
        term.writes = [];

        output(socket, 'not mine', 'some-other-task');

        expect(term.writes).toEqual([]);
    });
});

describe('TerminalView — history restore', () => {
    it('resets and replays history with screen-clears and queries stripped', () => {
        const { socket, term } = mountTerminal();

        emit(socket, {
            type: 'task:restore',
            payload: { taskId: TASK_ID, history: '\x1b[2J\x1b[Hhello\x1b[6n world\x1bc!' },
        });

        expect(term.resetCount).toBe(1);
        expect(term.screen).toBe('hello world!');
        expect(term.scrollToBottomCount).toBeGreaterThan(0);
    });

    it('shows a placeholder when there is no history', () => {
        const { socket, term } = mountTerminal();

        emit(socket, { type: 'task:restore', payload: { taskId: TASK_ID, history: '' } });

        expect(term.screen).toContain('Session history not available');
    });

    it('shows the loading overlay after 300ms and hides it once history arrives', () => {
        const { socket } = mountTerminal();

        expect(screen.queryByText('Loading session history…')).not.toBeInTheDocument();
        act(() => { vi.advanceTimersByTime(300); });
        expect(screen.getByText('Loading session history…')).toBeInTheDocument();

        emit(socket, { type: 'task:restore', payload: { taskId: TASK_ID, history: 'x' } });
        expect(screen.queryByText('Loading session history…')).not.toBeInTheDocument();
    });

    it('gives up on the overlay after the 5s safety timeout', () => {
        mountTerminal();

        act(() => { vi.advanceTimersByTime(300); });
        expect(screen.getByText('Loading session history…')).toBeInTheDocument();

        act(() => { vi.advanceTimersByTime(5000); });
        expect(screen.queryByText('Loading session history…')).not.toBeInTheDocument();
    });

    it('clears the overlay on the first live output too', () => {
        const { socket } = mountTerminal();
        act(() => { vi.advanceTimersByTime(300); });
        expect(screen.getByText('Loading session history…')).toBeInTheDocument();

        output(socket, 'live output');

        expect(screen.queryByText('Loading session history…')).not.toBeInTheDocument();
    });
});

describe('TerminalView — chunked scroll-up history loading', () => {
    /**
     * Wires a fetch double that answers the metadata probe (maxBytes=0) and the
     * chunk requests, and returns the recorded calls.
     */
    function stubHistoryApi(opts: {
        totalSize?: number;
        isBase64Legacy?: boolean;
        chunk?: () => { data: string; startOffset: number };
    } = {}) {
        const { totalSize = 1000, isBase64Legacy = false } = opts;
        const fetchMock = vi.fn(async (url: unknown) => {
            const u = String(url);
            if (u.includes('maxBytes=0')) {
                return { ok: true, json: async () => ({ totalSize, isBase64Legacy }) };
            }
            const chunk = opts.chunk ? opts.chunk() : { data: 'older-', startOffset: 0 };
            return {
                ok: true,
                json: async () => ({ ...chunk, totalSize, isBase64Legacy: false }),
            };
        });
        global.fetch = fetchMock as unknown as typeof fetch;
        return fetchMock;
    }

    /** Restore history, then settle the metadata fetch and the scroll guard. */
    async function restoreAndSettle(socket: FakeSocket, history: string) {
        emit(socket, { type: 'task:restore', payload: { taskId: TASK_ID, history } });
        await flushPromises();
        act(() => { vi.advanceTimersByTime(100); });
    }

    function scroll(viewport: HTMLElement) {
        act(() => { viewport.dispatchEvent(new Event('scroll')); });
    }

    function chunkCalls(fetchMock: ReturnType<typeof vi.fn>) {
        return fetchMock.mock.calls.map(c => String(c[0])).filter(u => !u.includes('maxBytes=0'));
    }

    it('requests the previous chunk when the user scrolls to the top', async () => {
        const fetchMock = stubHistoryApi({ totalSize: 1000 });
        const { socket, viewport, term } = mountTerminal();
        await restoreAndSettle(socket, 'tail');

        scroll(viewport);
        await flushPromises();

        // topOffset = totalSize - raw history length = 1000 - 4
        expect(chunkCalls(fetchMock)).toEqual([
            `${getApiBaseUrl()}/api/task/${TASK_ID}/history?endBefore=996&maxBytes=${CHUNK_SIZE}`,
        ]);
        // The chunk is prepended and the whole buffer rewritten (xterm has no
        // insert-at-top API), so the earlier text now precedes the tail.
        expect(term.screen).toBe('older-tail');
    });

    it('does not re-request a chunk it has already loaded', async () => {
        const fetchMock = stubHistoryApi({ totalSize: 1000 });
        const { socket, viewport } = mountTerminal();
        await restoreAndSettle(socket, 'tail');

        scroll(viewport);
        await flushPromises();
        act(() => { vi.advanceTimersByTime(100) }); // clear the programmatic-scroll guard
        expect(chunkCalls(fetchMock)).toHaveLength(1);

        // startOffset 0 means the whole file is loaded — further scrolls are no-ops.
        scroll(viewport);
        await flushPromises();
        expect(chunkCalls(fetchMock)).toHaveLength(1);
    });

    it('does not fire a second request while one is in flight', async () => {
        let release!: (v: unknown) => void;
        const gate = new Promise(resolve => { release = resolve; });
        const fetchMock = vi.fn(async (url: unknown) => {
            const u = String(url);
            if (u.includes('maxBytes=0')) {
                return { ok: true, json: async () => ({ totalSize: 1000, isBase64Legacy: false }) };
            }
            await gate;
            return { ok: true, json: async () => ({ data: 'older-', startOffset: 500, totalSize: 1000, isBase64Legacy: false }) };
        });
        global.fetch = fetchMock as unknown as typeof fetch;

        const { socket, viewport } = mountTerminal();
        await restoreAndSettle(socket, 'tail');

        scroll(viewport);
        await flushPromises(2);
        scroll(viewport);
        scroll(viewport);
        await flushPromises(2);

        expect(chunkCalls(fetchMock)).toHaveLength(1);

        release(null);
        await flushPromises();
    });

    it('stays quiet when the viewport is not near the top', async () => {
        const fetchMock = stubHistoryApi({ totalSize: 1000 });
        const { socket, viewport } = mountTerminal();
        await restoreAndSettle(socket, 'tail');
        Object.defineProperty(viewport, 'scrollTop', { configurable: true, value: 500 });

        scroll(viewport);
        await flushPromises();

        expect(chunkCalls(fetchMock)).toHaveLength(0);
    });

    it('stays quiet for legacy base64 histories that cannot be chunked', async () => {
        const fetchMock = stubHistoryApi({ totalSize: 1000, isBase64Legacy: true });
        const { socket, viewport } = mountTerminal();
        await restoreAndSettle(socket, 'tail');

        scroll(viewport);
        await flushPromises();

        expect(chunkCalls(fetchMock)).toHaveLength(0);
    });

    it('marks the file fully loaded when the server returns an empty chunk', async () => {
        const fetchMock = stubHistoryApi({
            totalSize: 1000,
            chunk: () => ({ data: '', startOffset: 0 }),
        });
        const { socket, viewport, term } = mountTerminal();
        await restoreAndSettle(socket, 'tail');

        scroll(viewport);
        await flushPromises();
        expect(chunkCalls(fetchMock)).toHaveLength(1);
        expect(term.screen).toBe('tail'); // nothing prepended

        scroll(viewport);
        await flushPromises();
        expect(chunkCalls(fetchMock)).toHaveLength(1);
    });

    it('keeps live output that arrived after the restore when rewriting the buffer', async () => {
        const fetchMock = stubHistoryApi({ totalSize: 1000 });
        const { socket, viewport, term } = mountTerminal();
        await restoreAndSettle(socket, 'tail');

        output(socket, '+live');
        expect(term.screen).toBe('tail+live');
        // The auto-scroll that follows live output flags the next scroll event
        // as programmatic for 100ms; let that lapse so ours counts as a user scroll.
        act(() => { vi.advanceTimersByTime(100); });

        scroll(viewport);
        await flushPromises();

        expect(chunkCalls(fetchMock)).toHaveLength(1);
        expect(term.screen).toBe('older-tail+live');
    });
});

describe('TerminalView — scroll position handling', () => {
    it('auto-scrolls on new output while the user is at the bottom', () => {
        const { socket, term } = mountTerminal();
        term.buffer.active = { viewportY: 0, length: 24 };
        const before = term.scrollToBottomCount;

        output(socket, 'more');

        expect(term.scrollToBottomCount).toBe(before + 1);
        expect(term.scrolledToLines).toEqual([]);
    });

    it('holds the viewport still when the user has scrolled up', () => {
        const { socket, term } = mountTerminal();
        term.buffer.active = { viewportY: 10, length: 1000 };
        const before = term.scrollToBottomCount;

        output(socket, 'more');

        expect(term.scrollToBottomCount).toBe(before);
        expect(term.scrolledToLines).toEqual([10]);
    });

    it('scrolls to the bottom on a terminal:scrollToBottom event for this task', () => {
        const { term } = mountTerminal();
        const before = term.scrollToBottomCount;

        act(() => {
            window.dispatchEvent(new CustomEvent('terminal:scrollToBottom', { detail: { taskId: TASK_ID } }));
        });
        expect(term.scrollToBottomCount).toBe(before + 1);

        act(() => {
            window.dispatchEvent(new CustomEvent('terminal:scrollToBottom', { detail: { taskId: 'elsewhere' } }));
        });
        expect(term.scrollToBottomCount).toBe(before + 1);
    });
});

describe('TerminalView — header and mobile controls', () => {
    it('copies the prompt to the clipboard', async () => {
        const { task } = mountTerminal();

        fireEvent.click(screen.getByRole('button', { name: 'Copy prompt to clipboard' }));
        await flushPromises(2);

        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(task.prompt);
    });

    it('sends /learn only when a workspace is attached', () => {
        mountTerminal();
        expect(screen.queryByRole('button', { name: 'Learn' })).not.toBeInTheDocument();
        cleanup();

        const { socket } = mountTerminal({ workspace: { id: '/ws', name: 'ws', createdAt: '' } as Workspace });
        fireEvent.click(screen.getByRole('button', { name: 'Learn' }));

        expect(frames(socket, 'task:input')).toEqual([
            { type: 'task:input', payload: { taskId: TASK_ID, input: '/learn\r' } },
        ]);
    });

    it.each(['interrupted', 'disconnected'] as const)('offers Resume for a %s task', (state) => {
        const { socket } = mountTerminal({ task: { state } });

        fireEvent.click(screen.getByRole('button', { name: 'Resume' }));

        expect(frames(socket, 'task:reconnect')).toEqual([
            { type: 'task:reconnect', payload: { taskId: TASK_ID } },
        ]);
    });

    it('labels an interrupted task and hides Resume while it is busy', () => {
        mountTerminal({ task: { state: 'interrupted' } });
        expect(screen.getByText('INTERRUPTED')).toBeInTheDocument();
        cleanup();

        mountTerminal({ task: { state: 'busy' } });
        expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
    });

    it('sends ESC and scrolls to bottom from the mobile controls', () => {
        const { socket, term } = mountTerminal({ isMobile: true });
        const before = term.scrollToBottomCount;

        fireEvent.click(screen.getByRole('button', { name: 'ESC' }));
        expect(frames(socket, 'task:input')).toEqual([
            { type: 'task:input', payload: { taskId: TASK_ID, input: '\x1b' } },
        ]);

        fireEvent.click(screen.getByRole('button', { name: 'Scroll to bottom' }));
        expect(term.scrollToBottomCount).toBe(before + 1);
    });

    it('hides the mobile controls on desktop', () => {
        mountTerminal();
        expect(screen.queryByRole('button', { name: 'ESC' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Scroll to bottom' })).not.toBeInTheDocument();
    });
});

describe('TerminalView — clipboard integration', () => {
    function press(term: typeof xterm.instances[number], event: Partial<KeyboardEvent>) {
        const preventDefault = vi.fn();
        const handled = term.keyHandler?.({
            type: 'keydown', ctrlKey: false, metaKey: false, shiftKey: false,
            preventDefault, ...event,
        } as unknown as KeyboardEvent) ?? true;
        return { handled, preventDefault };
    }

    it('pastes clipboard text on Ctrl+V instead of letting xterm handle the key', async () => {
        const { term } = mountTerminal();

        const { handled, preventDefault } = press(term, { key: 'v', ctrlKey: true });
        await flushPromises(2);

        expect(handled).toBe(false);
        expect(preventDefault).toHaveBeenCalled();
        expect(navigator.clipboard.readText).toHaveBeenCalled();
        expect(term.pasted).toEqual(['pasted']);
    });

    it('copies the selection on Ctrl+C and lets an empty Ctrl+C through as SIGINT', () => {
        const { term } = mountTerminal();
        term.selection = 'selected output';

        expect(press(term, { key: 'c', ctrlKey: true }).handled).toBe(false);
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('selected output');

        term.selection = '';
        expect(press(term, { key: 'c', ctrlKey: true }).handled).toBe(true);
    });

    it('leaves ordinary keystrokes alone', () => {
        const { term } = mountTerminal();
        expect(press(term, { key: 'a' }).handled).toBe(true);
    });

    it('right-click copies a selection, or pastes when there is none', async () => {
        const { term } = mountTerminal();
        term.selection = 'right click me';

        act(() => { term.element?.dispatchEvent(new MouseEvent('contextmenu')); });
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('right click me');
        expect(term.selection).toBe(''); // cleared after copying

        act(() => { term.element?.dispatchEvent(new MouseEvent('contextmenu')); });
        await flushPromises(2);
        expect(term.pasted).toEqual(['pasted']);
    });
});

describe('TerminalView — refit on container/window resize', () => {
    it('refits and refreshes 150ms after a window resize', () => {
        const { view, term } = mountTerminal();
        const fitAddon = term.addons[0] as { fitCount: number };
        // jsdom reports zero-size elements; fitTerminal bails out on those.
        const container = view.container.querySelector('.terminal-container') as HTMLElement;
        Object.defineProperty(container, 'clientWidth', { configurable: true, value: 800 });
        Object.defineProperty(container, 'clientHeight', { configurable: true, value: 600 });
        const fitsBefore = fitAddon.fitCount;

        act(() => { window.dispatchEvent(new Event('resize')); });
        expect(fitAddon.fitCount).toBe(fitsBefore); // debounced

        act(() => { vi.advanceTimersByTime(150); });
        expect(fitAddon.fitCount).toBe(fitsBefore + 1);
        expect(term.refreshCount).toBe(1);
    });

    it('skips the refit while the container has no dimensions', () => {
        const { term } = mountTerminal();
        const fitAddon = term.addons[0] as { fitCount: number };
        const fitsBefore = fitAddon.fitCount;

        act(() => { window.dispatchEvent(new Event('resize')); });
        act(() => { vi.advanceTimersByTime(150); });

        expect(fitAddon.fitCount).toBe(fitsBefore);
        expect(term.refreshCount).toBe(0);
    });
});

describe('TerminalView — malformed traffic', () => {
    it('survives a non-JSON WebSocket frame', () => {
        const { socket, term } = mountTerminal();
        term.writes = [];

        act(() => { socket.dispatchEvent(new MessageEvent('message', { data: 'not json{' })); });

        expect(term.writes).toEqual([]);
        expect(term.disposed).toBe(false);
    });
});

describe('TerminalView — theming', () => {
    it('starts on the dark palette and swaps when the preference changes', () => {
        const { term } = mountTerminal();
        expect(term.options.theme).toEqual(DARK_TERMINAL_THEME);

        act(() => { useTaskStore.setState({ themePreference: 'light' }); });

        expect(term.options.theme).toEqual(LIGHT_TERMINAL_THEME);
    });
});
