import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SplitContainer } from '../SplitContainer';
import {
    PaneNode,
    LeafNode,
    SplitNode,
    MIN_PANE_FRACTION,
    resetPaneIdCounter,
} from '../../stores/splitLayoutStore';

const leaf = (id: string, taskId: string | null = null): LeafNode => ({ type: 'leaf', id, taskId });

const split = (id: string, direction: 'row' | 'column', children: PaneNode[], sizes?: number[]): SplitNode => ({
    type: 'split',
    id,
    direction,
    children,
    sizes: sizes ?? children.map(() => 1 / children.length),
});

/** jsdom gives every element a 0x0 rect; stub a real one so drags compute. */
function stubRects(width = 1000, height = 500) {
    return vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockReturnValue({
            width,
            height,
            top: 0,
            left: 0,
            right: width,
            bottom: height,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        } as DOMRect);
}

type AnyMock = ReturnType<typeof vi.fn>;

interface HarnessProps {
    root: PaneNode;
    focusedPaneId?: string;
    onFocusPane?: AnyMock;
    onSizesChange?: AnyMock;
    renderLeaf?: (l: LeafNode, focused: boolean) => React.ReactNode;
}

function renderTree({
    root,
    focusedPaneId = 'a',
    onFocusPane = vi.fn(),
    onSizesChange = vi.fn(),
    renderLeaf = (l) => <div data-testid={`content-${l.id}`}>{l.taskId ?? 'empty'}</div>,
}: HarnessProps) {
    const utils = render(
        <SplitContainer
            root={root}
            focusedPaneId={focusedPaneId}
            renderLeaf={renderLeaf}
            onFocusPane={onFocusPane}
            onSizesChange={onSizesChange}
        />
    );
    return { ...utils, onFocusPane, onSizesChange, renderLeaf };
}

beforeEach(() => {
    resetPaneIdCounter(0);
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('SplitContainer — rendering', () => {
    it('renders a single leaf with no dividers', () => {
        renderTree({ root: leaf('a', 'task-1') });
        expect(screen.getByTestId('split-leaf-a')).toBeInTheDocument();
        expect(screen.getByTestId('content-a')).toHaveTextContent('task-1');
        expect(screen.queryAllByRole('separator')).toHaveLength(0);
    });

    it('renders nested layouts with the right structure and one divider per gap', () => {
        const root = split('s1', 'row', [
            leaf('a'),
            split('s2', 'column', [leaf('b'), leaf('c')]),
        ]);
        renderTree({ root });

        const outer = screen.getByTestId('split-node-s1');
        expect(outer).toHaveClass('split-container--row');
        const inner = screen.getByTestId('split-node-s2');
        expect(inner).toHaveClass('split-container--column');
        // The nested split really is inside the outer one.
        expect(outer.contains(inner)).toBe(true);
        expect(inner.contains(screen.getByTestId('split-leaf-b'))).toBe(true);
        expect(inner.contains(screen.getByTestId('split-leaf-a'))).toBe(false);

        // 2 children per split → 1 divider each.
        expect(screen.getAllByRole('separator')).toHaveLength(2);
        expect(screen.getByTestId('split-divider-s1-0')).toHaveAttribute('aria-orientation', 'vertical');
        expect(screen.getByTestId('split-divider-s2-0')).toHaveAttribute('aria-orientation', 'horizontal');
    });

    it('calls renderLeaf exactly once per leaf, with the focused flag', () => {
        const renderLeaf = vi.fn((l: LeafNode, _focused: boolean) => <div data-testid={`content-${l.id}`} />);
        const root = split('s1', 'row', [leaf('a'), split('s2', 'column', [leaf('b'), leaf('c')])]);
        renderTree({ root, focusedPaneId: 'b', renderLeaf });

        expect(renderLeaf).toHaveBeenCalledTimes(3);
        const calls = Object.fromEntries(renderLeaf.mock.calls.map(([l, focused]) => [l.id, focused]));
        expect(calls).toEqual({ a: false, b: true, c: false });
    });

    it('marks only the focused leaf with the accent class', () => {
        renderTree({ root: split('s1', 'row', [leaf('a'), leaf('b')]), focusedPaneId: 'b' });
        expect(screen.getByTestId('split-leaf-a')).not.toHaveClass('split-leaf--focused');
        expect(screen.getByTestId('split-leaf-b')).toHaveClass('split-leaf--focused');
    });

    it('applies flex sizes from the node', () => {
        const root = split('s1', 'row', [leaf('a'), leaf('b')], [0.7, 0.3]);
        const { container } = renderTree({ root });
        const slots = container.querySelectorAll<HTMLElement>('.split-pane');
        expect(slots[0].style.flex).toContain('0.7');
        expect(slots[1].style.flex).toContain('0.3');
    });
});

describe('SplitContainer — focus', () => {
    it('fires onFocusPane when a leaf is clicked', () => {
        const { onFocusPane } = renderTree({
            root: split('s1', 'row', [leaf('a'), leaf('b')]),
        });
        fireEvent.mouseDown(screen.getByTestId('content-b'));
        expect(onFocusPane).toHaveBeenCalledWith('b');
        expect(onFocusPane).toHaveBeenCalledTimes(1);
    });

    it('fires onFocusPane when a leaf receives keyboard focus', () => {
        const { onFocusPane } = renderTree({
            root: split('s1', 'row', [leaf('a'), leaf('b')]),
            renderLeaf: (l) => <button data-testid={`content-${l.id}`}>{l.id}</button>,
        });
        fireEvent.focus(screen.getByTestId('content-a'));
        expect(onFocusPane).toHaveBeenCalledWith('a');
    });

    it('does not fire onFocusPane when a divider is grabbed', () => {
        const { onFocusPane } = renderTree({ root: split('s1', 'row', [leaf('a'), leaf('b')]) });
        fireEvent.mouseDown(screen.getByTestId('split-divider-s1-0'), { clientX: 500, clientY: 250 });
        expect(onFocusPane).not.toHaveBeenCalled();
    });
});

describe('SplitContainer — divider drag', () => {
    it('emits renormalized sizes while dragging a row divider', () => {
        stubRects(1000, 500);
        const { onSizesChange } = renderTree({ root: split('s1', 'row', [leaf('a'), leaf('b')]) });

        const divider = screen.getByTestId('split-divider-s1-0');
        fireEvent.mouseDown(divider, { clientX: 500, clientY: 250 });
        // +200px of a 1000px container == +0.2 for the left pane.
        fireEvent.mouseMove(window, { clientX: 700, clientY: 250 });

        expect(onSizesChange).toHaveBeenCalled();
        const [splitId, sizes] = onSizesChange.mock.calls.at(-1)!;
        expect(splitId).toBe('s1');
        expect(sizes[0]).toBeCloseTo(0.7, 5);
        expect(sizes[1]).toBeCloseTo(0.3, 5);
        expect(sizes.reduce((x: number, y: number) => x + y, 0)).toBeCloseTo(1, 6);
    });

    it('uses the vertical axis for a column split', () => {
        stubRects(1000, 500);
        const { onSizesChange } = renderTree({ root: split('s1', 'column', [leaf('a'), leaf('b')]) });

        fireEvent.mouseDown(screen.getByTestId('split-divider-s1-0'), { clientX: 500, clientY: 250 });
        // Horizontal movement must be ignored; -50px of 500 == -0.1.
        fireEvent.mouseMove(window, { clientX: 900, clientY: 200 });

        const [, sizes] = onSizesChange.mock.calls.at(-1)!;
        expect(sizes[0]).toBeCloseTo(0.4, 5);
        expect(sizes[1]).toBeCloseTo(0.6, 5);
    });

    it('clamps to the minimum pane fraction when dragged past the edge', () => {
        stubRects(1000, 500);
        const { onSizesChange } = renderTree({ root: split('s1', 'row', [leaf('a'), leaf('b')]) });

        fireEvent.mouseDown(screen.getByTestId('split-divider-s1-0'), { clientX: 500, clientY: 250 });
        fireEvent.mouseMove(window, { clientX: -5000, clientY: 250 });

        const [, sizes] = onSizesChange.mock.calls.at(-1)!;
        expect(sizes[0]).toBeCloseTo(MIN_PANE_FRACTION, 5);
        expect(sizes[1]).toBeCloseTo(1 - MIN_PANE_FRACTION, 5);
    });

    it('only moves the two panes flanking the dragged divider', () => {
        stubRects(1000, 500);
        const root = split('s1', 'row', [leaf('a'), leaf('b'), leaf('c')], [1 / 3, 1 / 3, 1 / 3]);
        const { onSizesChange } = renderTree({ root });

        fireEvent.mouseDown(screen.getByTestId('split-divider-s1-1'), { clientX: 660, clientY: 250 });
        fireEvent.mouseMove(window, { clientX: 760, clientY: 250 });

        const [, sizes] = onSizesChange.mock.calls.at(-1)!;
        expect(sizes[0]).toBeCloseTo(1 / 3, 5);
        expect(sizes[1]).toBeCloseTo(1 / 3 + 0.1, 5);
        expect(sizes[2]).toBeCloseTo(1 / 3 - 0.1, 5);
    });

    it('stops emitting after mouseup', () => {
        stubRects(1000, 500);
        const { onSizesChange } = renderTree({ root: split('s1', 'row', [leaf('a'), leaf('b')]) });

        fireEvent.mouseDown(screen.getByTestId('split-divider-s1-0'), { clientX: 500, clientY: 250 });
        fireEvent.mouseMove(window, { clientX: 600, clientY: 250 });
        const afterDrag = onSizesChange.mock.calls.length;
        fireEvent.mouseUp(window);
        fireEvent.mouseMove(window, { clientX: 900, clientY: 250 });
        expect(onSizesChange.mock.calls.length).toBe(afterDrag);
    });

    it('does nothing when the container has no measurable size', () => {
        // No rect stub → jsdom reports 0x0.
        const { onSizesChange } = renderTree({ root: split('s1', 'row', [leaf('a'), leaf('b')]) });
        fireEvent.mouseDown(screen.getByTestId('split-divider-s1-0'), { clientX: 500, clientY: 250 });
        fireEvent.mouseMove(window, { clientX: 700, clientY: 250 });
        expect(onSizesChange).not.toHaveBeenCalled();
    });

    it('removes window listeners on unmount mid-drag', () => {
        stubRects(1000, 500);
        const add = vi.spyOn(window, 'addEventListener');
        const remove = vi.spyOn(window, 'removeEventListener');
        const { unmount, onSizesChange } = renderTree({ root: split('s1', 'row', [leaf('a'), leaf('b')]) });

        fireEvent.mouseDown(screen.getByTestId('split-divider-s1-0'), { clientX: 500, clientY: 250 });
        expect(add.mock.calls.some(([type]) => type === 'mousemove')).toBe(true);

        unmount();
        expect(remove.mock.calls.some(([type]) => type === 'mousemove')).toBe(true);
        expect(remove.mock.calls.some(([type]) => type === 'mouseup')).toBe(true);

        onSizesChange.mockClear();
        fireEvent.mouseMove(window, { clientX: 900, clientY: 250 });
        expect(onSizesChange).not.toHaveBeenCalled();
    });
});

describe('SplitContainer — keyboard a11y', () => {
    it('nudges sizes with arrow keys on a row divider', () => {
        const { onSizesChange } = renderTree({ root: split('s1', 'row', [leaf('a'), leaf('b')]) });
        const divider = screen.getByTestId('split-divider-s1-0');
        expect(divider).toHaveAttribute('tabindex', '0');

        fireEvent.keyDown(divider, { key: 'ArrowRight' });
        expect(onSizesChange.mock.calls.at(-1)![1][0]).toBeCloseTo(0.52, 5);

        fireEvent.keyDown(divider, { key: 'ArrowLeft' });
        expect(onSizesChange.mock.calls.at(-1)![1][0]).toBeCloseTo(0.48, 5);
    });

    it('uses up/down on a column divider and ignores unrelated keys', () => {
        const { onSizesChange } = renderTree({ root: split('s1', 'column', [leaf('a'), leaf('b')]) });
        const divider = screen.getByTestId('split-divider-s1-0');

        fireEvent.keyDown(divider, { key: 'ArrowRight' });
        expect(onSizesChange).not.toHaveBeenCalled();

        fireEvent.keyDown(divider, { key: 'ArrowDown' });
        expect(onSizesChange.mock.calls.at(-1)![1][0]).toBeCloseTo(0.52, 5);
    });
});

describe('SplitContainer — stability', () => {
    it('does not remount leaf content when sizes change', () => {
        const mounts: string[] = [];
        function Content({ id }: { id: string }) {
            React.useEffect(() => {
                mounts.push(id);
            }, [id]);
            return <div data-testid={`content-${id}`} />;
        }
        const renderLeaf = (l: LeafNode) => <Content id={l.id} />;
        const root = split('s1', 'row', [leaf('a'), leaf('b')], [0.5, 0.5]);
        const { rerender } = render(
            <SplitContainer
                root={root}
                focusedPaneId="a"
                renderLeaf={renderLeaf}
                onFocusPane={vi.fn()}
                onSizesChange={vi.fn()}
            />
        );
        expect(mounts).toEqual(['a', 'b']);

        rerender(
            <SplitContainer
                root={split('s1', 'row', [leaf('a'), leaf('b')], [0.8, 0.2])}
                focusedPaneId="a"
                renderLeaf={renderLeaf}
                onFocusPane={vi.fn()}
                onSizesChange={vi.fn()}
            />
        );
        // No extra mounts → the xterm instances a consumer hangs here survive.
        expect(mounts).toEqual(['a', 'b']);
    });
});
