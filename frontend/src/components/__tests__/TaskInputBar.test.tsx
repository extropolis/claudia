/**
 * TaskInputBar behaviour tests.
 *
 * These assert the ACTIONS the bar produces — the JSON frames pushed onto the
 * WebSocket, the store mutations (draft persistence), and the custom DOM events
 * it emits/consumes — not markup.
 *
 * The bar has no `sendWsMessage` seam: it writes directly through the
 * `wsRef.current.send()` handle it is given, so the spy lives on a fake socket.
 *
 * TIMERS: `userEvent` deadlocks under vitest's fake timers in this environment
 * (its internal `wait()` never settles), so interaction tests run on real timers
 * and the genuinely time-dependent behaviours (the 500ms pending-message poll,
 * the 100ms blur settle, the 3s error auto-dismiss) use `vi.useFakeTimers()`
 * plus `fireEvent`. Nothing sleeps.
 */
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Task } from '@claudia/shared';
import { TaskInputBar } from '../TaskInputBar';
import { useTaskStore } from '../../stores/taskStore';

// The schedule modal loads its own data; stub it so "did the button open it?"
// is observable without pulling that component's network into these tests.
vi.mock('../ScheduledTasksModal', () => ({
    ScheduledTasksModal: ({ onClose }: { onClose: () => void }) => (
        <div role="dialog" aria-label="Scheduled tasks">
            <button onClick={onClose}>Close schedule modal</button>
        </div>
    ),
}));

const TASK_ID = 'task-abc';
const PLACEHOLDER = 'Type a message to Claude...';

function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        id: TASK_ID,
        prompt: 'do the thing',
        state: 'idle',
        workspaceId: '/ws',
        createdAt: new Date(0),
        lastActivity: new Date(0),
        ...overrides,
    } as Task;
}

interface FakeSocket {
    readyState: number;
    send: ReturnType<typeof vi.fn>;
}

function makeWsRef(readyState: number = WebSocket.OPEN) {
    const socket: FakeSocket = { readyState, send: vi.fn() };
    return { ref: { current: socket as unknown as WebSocket }, socket };
}

/** Every `task:input` frame pushed onto the socket, decoded. */
function inputFrames(socket: FakeSocket) {
    return socket.send.mock.calls
        .map(([raw]) => JSON.parse(raw as string))
        .filter(m => m.type === 'task:input');
}

function mockFetch(impl: (url: string, init?: RequestInit) => unknown) {
    const fn = vi.fn(async (url: unknown, init?: unknown) => impl(String(url), init as RequestInit));
    global.fetch = fn as unknown as typeof fetch;
    return fn;
}

const UPLOAD_OK = {
    ok: true,
    json: async () => ({
        filename: 'stored-1.png',
        filePath: '/uploads/stored-1.png',
        originalName: 'shot.png',
    }),
};

function pasteImage(textarea: HTMLElement, type = 'image/png') {
    const file = new File(['binary'], 'shot.png', { type });
    fireEvent.paste(textarea, {
        clipboardData: { items: [{ kind: 'file', type, getAsFile: () => file }] },
    });
}

beforeEach(() => {
    localStorage.clear();
    useTaskStore.setState({
        taskDraftInputs: new Map(),
        scheduledTasks: new Map(),
        focusedInputId: null,
        voiceTranscript: '',
        voiceInterimTranscript: '',
        globalVoiceEnabled: false,
    });
    // jsdom ships no object-URL implementation; the bar creates/revokes them
    // for image previews.
    Object.defineProperty(URL, 'createObjectURL', {
        writable: true, configurable: true, value: vi.fn(() => 'blob:preview'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
        writable: true, configurable: true, value: vi.fn(),
    });
});

afterEach(() => {
    cleanup();
    if (vi.isFakeTimers()) {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
    }
    vi.restoreAllMocks();
});

function setup(taskOverrides: Partial<Task> = {}, readyState: number = WebSocket.OPEN) {
    const user = userEvent.setup();
    const { ref, socket } = makeWsRef(readyState);
    const task = makeTask(taskOverrides);
    const view = render(<TaskInputBar task={task} wsRef={ref} />);
    const textarea = screen.getByPlaceholderText(PLACEHOLDER);
    return { user, socket, ref, task, textarea, view };
}

describe('TaskInputBar — sending', () => {
    it('sends the typed message with a trailing carriage return on Enter', async () => {
        const { user, socket, textarea } = setup();

        await user.type(textarea, 'hello claude');
        await user.keyboard('{Enter}');

        expect(inputFrames(socket)).toEqual([
            { type: 'task:input', payload: { taskId: TASK_ID, input: 'hello claude\r' } },
        ]);
    });

    it('sends via the send button', async () => {
        const { user, socket, textarea } = setup();

        await user.type(textarea, 'via button');
        await user.click(screen.getByRole('button', { name: 'Send message (Enter)' }));

        expect(inputFrames(socket)).toHaveLength(1);
        expect(inputFrames(socket)[0].payload.input).toBe('via button\r');
    });

    it('keeps the send button disabled until there is content', async () => {
        const { user, textarea } = setup();
        const send = screen.getByRole('button', { name: 'Send message (Enter)' });

        expect(send).toBeDisabled();
        await user.type(textarea, 'x');
        expect(send).toBeEnabled();
    });

    it('ignores Enter on whitespace-only input', async () => {
        const { user, socket, textarea } = setup();

        await user.type(textarea, '   ');
        await user.keyboard('{Enter}');

        expect(inputFrames(socket)).toHaveLength(0);
    });

    it('Shift+Enter inserts a newline instead of sending', async () => {
        const { user, socket, textarea } = setup();

        await user.type(textarea, 'line one');
        await user.keyboard('{Shift>}{Enter}{/Shift}');
        await user.type(textarea, 'line two');

        expect(inputFrames(socket)).toHaveLength(0);
        expect(textarea).toHaveValue('line one\nline two');

        await user.keyboard('{Enter}');
        expect(inputFrames(socket)[0].payload.input).toBe('line one\nline two\r');
    });

    it('passes slash commands straight through as terminal input', async () => {
        // There is deliberately NO client-side slash parsing: the bar is a thin
        // pipe to the PTY, so `/learn` must reach the terminal verbatim.
        const { user, socket, textarea } = setup();

        await user.type(textarea, '/learn');
        await user.keyboard('{Enter}');

        expect(inputFrames(socket)[0].payload.input).toBe('/learn\r');
    });

    it('emits terminal:scrollToBottom for this task when sending', async () => {
        const { user, textarea, task } = setup();
        const seen: string[] = [];
        const listener = (e: Event) => seen.push((e as CustomEvent<{ taskId: string }>).detail.taskId);
        window.addEventListener('terminal:scrollToBottom', listener);

        await user.type(textarea, 'scroll me');
        await user.keyboard('{Enter}');
        window.removeEventListener('terminal:scrollToBottom', listener);

        expect(seen).toEqual([task.id]);
    });

    it('queues the message while the socket is closed and flushes it once on reconnect', () => {
        vi.useFakeTimers();
        const { socket, textarea } = setup({}, WebSocket.CLOSED);

        fireEvent.change(textarea, { target: { value: 'offline msg' } });
        fireEvent.keyDown(textarea, { key: 'Enter' });

        expect(socket.send).not.toHaveBeenCalled();
        // The draft is cleared regardless — the text now lives in the pending slot.
        expect(textarea).toHaveValue('');

        socket.readyState = WebSocket.OPEN;
        // Pending messages are retried on a 500ms poll.
        act(() => { vi.advanceTimersByTime(500); });

        expect(inputFrames(socket)).toEqual([
            { type: 'task:input', payload: { taskId: TASK_ID, input: 'offline msg\r' } },
        ]);

        // ...and exactly once, not again on every subsequent tick.
        act(() => { vi.advanceTimersByTime(2000); });
        expect(inputFrames(socket)).toHaveLength(1);
    });
});

describe('TaskInputBar — draft persistence', () => {
    it('stores the draft per task id in the store', async () => {
        const { user, textarea, task } = setup();

        await user.type(textarea, 'unsent draft');

        expect(useTaskStore.getState().getTaskDraftInput(task.id)).toBe('unsent draft');
    });

    it('restores the draft when the bar is remounted', async () => {
        const { user, textarea, view, ref, task } = setup();

        await user.type(textarea, 'survives unmount');
        view.unmount();

        render(<TaskInputBar task={task} wsRef={ref} />);
        expect(screen.getByPlaceholderText(PLACEHOLDER)).toHaveValue('survives unmount');
    });

    it('clears the draft after a successful send', async () => {
        const { user, textarea, task } = setup();

        await user.type(textarea, 'bye');
        await user.keyboard('{Enter}');

        expect(useTaskStore.getState().getTaskDraftInput(task.id)).toBe('');
        expect(textarea).toHaveValue('');
    });

    it('does not leak drafts between tasks', async () => {
        const { user, textarea } = setup();

        await user.type(textarea, 'task A draft');
        cleanup();

        const { ref } = makeWsRef();
        render(<TaskInputBar task={makeTask({ id: 'other-task' })} wsRef={ref} />);
        expect(screen.getByPlaceholderText(PLACEHOLDER)).toHaveValue('');
    });
});

describe('TaskInputBar — focus and voice events', () => {
    it('focuses the textarea on a taskInput:focus event for this task', () => {
        const { textarea } = setup();
        expect(textarea).not.toHaveFocus();

        act(() => {
            window.dispatchEvent(new CustomEvent('taskInput:focus', { detail: { taskId: TASK_ID } }));
        });

        expect(textarea).toHaveFocus();
    });

    it('ignores taskInput:focus aimed at a different task', () => {
        const { textarea } = setup();

        act(() => {
            window.dispatchEvent(new CustomEvent('taskInput:focus', { detail: { taskId: 'someone-else' } }));
        });

        expect(textarea).not.toHaveFocus();
    });

    it('refocuses the textarea when the window regains focus', () => {
        const { textarea } = setup();

        act(() => { window.dispatchEvent(new Event('focus')); });

        expect(textarea).toHaveFocus();
    });

    it('claims and releases the focused-input slot in the store', () => {
        vi.useFakeTimers();
        const { textarea } = setup();

        fireEvent.focus(textarea);
        expect(useTaskStore.getState().focusedInputId).toBe(`task-${TASK_ID}`);

        // Blur is deferred 100ms so a click on a sibling button lands first.
        fireEvent.blur(textarea);
        expect(useTaskStore.getState().focusedInputId).toBe(`task-${TASK_ID}`);
        act(() => { vi.advanceTimersByTime(100); });
        expect(useTaskStore.getState().focusedInputId).toBeNull();
    });

    it('appends a voice transcript to the draft while focused', async () => {
        useTaskStore.setState({ globalVoiceEnabled: true });
        const { user, textarea } = setup();

        await user.type(textarea, 'prefix');
        await act(async () => {
            useTaskStore.setState({ voiceTranscript: 'dictated words' });
        });

        expect(textarea).toHaveValue('prefix dictated words');
        // The transcript is consumed so it cannot be appended twice.
        expect(useTaskStore.getState().voiceTranscript).toBe('');
    });

    it('sends on the voice:autoSend event for this input', async () => {
        const { user, socket, textarea } = setup();
        await user.type(textarea, 'auto sent');

        await act(async () => {
            window.dispatchEvent(new CustomEvent('voice:autoSend', { detail: { inputId: `task-${TASK_ID}` } }));
        });

        expect(inputFrames(socket)[0].payload.input).toBe('auto sent\r');
    });

    it('ignores voice:autoSend aimed at another input', async () => {
        const { user, socket, textarea } = setup();
        await user.type(textarea, 'not mine');

        await act(async () => {
            window.dispatchEvent(new CustomEvent('voice:autoSend', { detail: { inputId: 'task-other' } }));
        });

        expect(inputFrames(socket)).toHaveLength(0);
    });
});

describe('TaskInputBar — images', () => {
    it('uploads a pasted image and attaches its server path to the next message', async () => {
        const fetchMock = mockFetch(() => UPLOAD_OK);
        const { user, socket, textarea } = setup();

        await act(async () => { pasteImage(textarea); });

        const preview = await screen.findByAltText('shot.png');
        expect(preview).toHaveAttribute('src', 'blob:preview');
        expect(String(fetchMock.mock.calls[0][0])).toContain('/api/upload/image');

        await user.type(textarea, 'look at this');
        await user.keyboard('{Enter}');

        expect(inputFrames(socket)[0].payload.input).toBe(
            'look at this\n\n[Attached image: /uploads/stored-1.png]\r'
        );
        // Previews are dropped after send.
        expect(screen.queryByAltText('shot.png')).not.toBeInTheDocument();
    });

    it('lets an image be sent with no accompanying text', async () => {
        mockFetch(() => UPLOAD_OK);
        const { user, textarea, socket } = setup();

        await act(async () => { pasteImage(textarea); });
        await screen.findByAltText('shot.png');

        await user.click(screen.getByRole('button', { name: 'Send message (Enter)' }));
        expect(inputFrames(socket)[0].payload.input).toBe('\n\n[Attached image: /uploads/stored-1.png]\r');
    });

    it('lists multiple attachments in one block', async () => {
        let n = 0;
        mockFetch(() => ({
            ok: true,
            json: async () => {
                n += 1;
                return { filename: `f${n}.png`, filePath: `/uploads/f${n}.png`, originalName: `img${n}.png` };
            },
        }));
        const { user, textarea, socket } = setup();

        await act(async () => { pasteImage(textarea); });
        await screen.findByAltText('img1.png');
        await act(async () => { pasteImage(textarea); });
        await screen.findByAltText('img2.png');

        await user.click(screen.getByRole('button', { name: 'Send message (Enter)' }));
        expect(inputFrames(socket)[0].payload.input).toBe(
            '\n\n[Attached images:\n/uploads/f1.png\n/uploads/f2.png]\r'
        );
    });

    it('ignores a paste that carries no image', async () => {
        const fetchMock = mockFetch(() => UPLOAD_OK);
        const { textarea } = setup();

        await act(async () => {
            fireEvent.paste(textarea, {
                clipboardData: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] },
            });
        });

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('surfaces an upload failure and clears it after 3s', async () => {
        mockFetch(() => ({ ok: false, json: async () => ({ error: 'file too large' }) }));
        vi.useFakeTimers();
        const { textarea } = setup();

        await act(async () => { pasteImage(textarea); });

        expect(screen.getByText('file too large')).toBeInTheDocument();
        expect(screen.queryByAltText('shot.png')).not.toBeInTheDocument();

        act(() => { vi.advanceTimersByTime(3000); });
        expect(screen.queryByText('file too large')).not.toBeInTheDocument();
    });

    it('removes an attached image and tells the server to delete it', async () => {
        const fetchMock = mockFetch(() => UPLOAD_OK);
        const { user, textarea } = setup();

        await act(async () => { pasteImage(textarea); });
        await screen.findByAltText('shot.png');

        await user.click(screen.getByRole('button', { name: 'Remove image' }));

        await waitFor(() => expect(screen.queryByAltText('shot.png')).not.toBeInTheDocument());
        const deleteCall = fetchMock.mock.calls.find(
            ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'
        );
        expect(String(deleteCall?.[0])).toContain('/api/upload/image/stored-1.png');
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
    });

    it('uploads only image files chosen through the attach button', async () => {
        const fetchMock = mockFetch(() => UPLOAD_OK);
        const { view } = setup();

        // The file input is deliberately hidden (the visible affordance is the
        // "Attach image" button), so there is no semantic query for it.
        const fileInput = view.container.querySelector('input[type="file"]') as HTMLInputElement;
        const image = new File(['x'], 'a.png', { type: 'image/png' });
        const notImage = new File(['x'], 'notes.txt', { type: 'text/plain' });

        await act(async () => {
            fireEvent.change(fileInput, { target: { files: [image, notImage] } });
        });

        await screen.findByAltText('shot.png');
        expect(fetchMock.mock.calls).toHaveLength(1);
    });
});

describe('TaskInputBar — scheduling', () => {
    it('opens and closes the schedule modal', async () => {
        const { user } = setup();

        await user.click(screen.getByRole('button', { name: 'Schedule recurring prompts' }));
        expect(screen.getByRole('dialog', { name: 'Scheduled tasks' })).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Close schedule modal' }));
        expect(screen.queryByRole('dialog', { name: 'Scheduled tasks' })).not.toBeInTheDocument();
    });

    it('counts only this task’s schedules on the schedule button', () => {
        useTaskStore.setState({
            scheduledTasks: new Map([
                ['s1', { id: 's1', taskId: TASK_ID } as never],
                ['s2', { id: 's2', taskId: TASK_ID } as never],
                ['s3', { id: 's3', taskId: 'another' } as never],
            ]),
        });

        setup();
        // Once it has a count the button's accessible name becomes that count.
        const scheduleButton = screen.getByRole('button', { name: '2' });
        expect(scheduleButton).toHaveAttribute('title', '2 scheduled tasks - click to manage');
    });
});
