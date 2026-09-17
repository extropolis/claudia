/**
 * PaneHost — one pane of the split-screen grid.
 *
 * TerminalView is stubbed: PaneHost's job is the pane chrome (split / close),
 * the empty state, and accepting a task dragged from the sidebar. The stub
 * renders the injected `paneControls` so the chrome is exercised exactly where
 * the real header would host it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, createEvent, act } from '@testing-library/react';
import type { Task } from '@claudia/shared';
import { PaneHost } from '../PaneHost';
import { TASK_DRAG_MIME } from '../../config/drag-constants';
import type { LeafNode } from '../../stores/splitLayoutStore';

vi.mock('../TerminalView', () => ({
    TerminalView: ({ task, paneControls }: { task: Task; paneControls?: React.ReactNode }) => (
        <div data-testid="terminal-view">
            <span>terminal:{task.id}</span>
            {paneControls}
        </div>
    ),
}));

const makeTask = (id: string): Task => ({
    id,
    prompt: `prompt ${id}`,
    state: 'idle',
    workspaceId: '/ws/alpha',
    createdAt: new Date(0),
    lastActivity: new Date(0),
} as Task);

type Props = React.ComponentProps<typeof PaneHost>;

function renderPane(over: Partial<Props> = {}) {
    const leaf: LeafNode = { type: 'leaf', id: 'pane-1', taskId: over.task ? over.task.id : null };
    const props: Props = {
        leaf,
        isFocused: true,
        task: undefined,
        workspace: undefined,
        wsRef: { current: null },
        refreshCounter: 0,
        canSplit: true,
        canClose: true,
        isOnlyPane: false,
        onSplit: vi.fn(),
        onClose: vi.fn(),
        onDropTask: vi.fn(),
        ...over,
    };
    const utils = render(<PaneHost {...props} />);
    const host = utils.container.querySelector('.pane-host') as HTMLElement;
    return { ...utils, props, host };
}

/** A drag event init carrying (or not) the sidebar's task payload. */
function drag(taskId: string | null, extra: Record<string, unknown> = {}) {
    return {
        dataTransfer: {
            types: taskId ? [TASK_DRAG_MIME] : ['text/plain'],
            getData: (mime: string) => (mime === TASK_DRAG_MIME && taskId ? taskId : ''),
            dropEffect: 'none',
        },
        ...extra,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('PaneHost — content', () => {
    it('renders the task terminal with the pane controls injected into it', () => {
        renderPane({ task: makeTask('t1') });
        const terminal = screen.getByTestId('terminal-view');
        expect(terminal.textContent).toContain('terminal:t1');
        // Controls live INSIDE the terminal (its header), not overlaid on it.
        expect(terminal.querySelector('[aria-label="Split right"]')).toBeTruthy();
    });

    it('keeps the original single-terminal copy when it is the only pane', () => {
        renderPane({ isOnlyPane: true, canClose: false });
        expect(screen.getByText('Select a task to view its terminal')).toBeTruthy();
        expect(screen.queryByText('Empty pane')).toBeNull();
    });

    it('shows a compact empty state in a split, hinting by focus', () => {
        const { rerender, props } = renderPane({ isFocused: true });
        expect(screen.getByText('Empty pane')).toBeTruthy();
        expect(screen.getByText('Click a task in the sidebar to open it here')).toBeTruthy();

        rerender(<PaneHost {...props} isFocused={false} />);
        expect(screen.getByText('Drag a task here, or click this pane then pick a task')).toBeTruthy();
    });
});

describe('PaneHost — pane controls', () => {
    it('splits right and down with the right direction', () => {
        const { props } = renderPane();
        fireEvent.click(screen.getByLabelText('Split right'));
        fireEvent.click(screen.getByLabelText('Split down'));
        expect(props.onSplit).toHaveBeenNthCalledWith(1, 'pane-1', 'row');
        expect(props.onSplit).toHaveBeenNthCalledWith(2, 'pane-1', 'column');
    });

    it('closes the pane (the task itself is untouched)', () => {
        const { props } = renderPane({ task: makeTask('t1') });
        fireEvent.click(screen.getByLabelText('Close pane'));
        expect(props.onClose).toHaveBeenCalledWith('pane-1');
    });

    it('hides close when this is the last pane', () => {
        renderPane({ canClose: false });
        expect(screen.queryByLabelText('Close pane')).toBeNull();
    });

    it('disables splitting at the pane cap and says why', () => {
        const { props } = renderPane({ canSplit: false });
        const right = screen.getByLabelText('Split right') as HTMLButtonElement;
        expect(right.disabled).toBe(true);
        expect(right.title).toBe('Pane limit reached');
        fireEvent.click(right);
        expect(props.onSplit).not.toHaveBeenCalled();
    });

    it('advertises the keyboard shortcuts in the tooltips', () => {
        renderPane();
        expect((screen.getByLabelText('Split right') as HTMLButtonElement).title).toMatch(/\+\\\)$/);
        expect((screen.getByLabelText('Split down') as HTMLButtonElement).title).toMatch(/Shift\+\\\)$/);
    });
});

describe('PaneHost — dropping a task from the sidebar', () => {
    it('highlights while a task is dragged over and opens it on drop', () => {
        const { host, props } = renderPane();
        fireEvent.dragOver(host, drag('t9'));
        expect(host.className).toContain('pane-host--drop-target');
        expect(screen.getByText('Drop to open here')).toBeTruthy();

        fireEvent.drop(host, drag('t9'));
        expect(props.onDropTask).toHaveBeenCalledWith('pane-1', 't9');
        expect(host.className).not.toContain('pane-host--drop-target');
    });

    it('ignores drags that do not carry a task (files, text, sidebar reorder of something else)', () => {
        const { host, props } = renderPane();
        fireEvent.dragOver(host, drag(null));
        expect(host.className).not.toContain('pane-host--drop-target');
        fireEvent.drop(host, drag(null));
        expect(props.onDropTask).not.toHaveBeenCalled();
    });

    it('does not open anything when the drop payload is empty', () => {
        const { host, props } = renderPane();
        fireEvent.dragOver(host, drag('t9'));
        fireEvent.drop(host, {
            dataTransfer: { types: [TASK_DRAG_MIME], getData: () => '', dropEffect: 'none' },
        });
        expect(props.onDropTask).not.toHaveBeenCalled();
    });

    /**
     * jsdom has no DragEvent, so fireEvent's init silently drops
     * `relatedTarget`. Build the event and pin the property explicitly.
     */
    function dragLeaveTo(host: HTMLElement, relatedTarget: Node) {
        const ev = createEvent.dragLeave(host, drag('t9'));
        Object.defineProperty(ev, 'relatedTarget', { value: relatedTarget });
        fireEvent(host, ev);
    }

    it('keeps the highlight while the cursor moves between its own children', () => {
        const { host } = renderPane({ task: makeTask('t1') });
        fireEvent.dragOver(host, drag('t9'));
        dragLeaveTo(host, screen.getByTestId('terminal-view'));
        expect(host.className).toContain('pane-host--drop-target');
    });

    it('clears the highlight when the drag leaves the pane', () => {
        const { host } = renderPane();
        fireEvent.dragOver(host, drag('t9'));
        dragLeaveTo(host, document.body);
        expect(host.className).not.toContain('pane-host--drop-target');
    });

    it('clears a stuck highlight when the drag is cancelled elsewhere', () => {
        // Escape (or a drop outside any pane) fires no dragleave on this pane.
        const { host } = renderPane();
        fireEvent.dragOver(host, drag('t9'));
        expect(host.className).toContain('pane-host--drop-target');

        act(() => { document.dispatchEvent(new Event('dragend')); });
        expect(host.className).not.toContain('pane-host--drop-target');
    });
});
