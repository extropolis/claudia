import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { SplitContainer, computeFlatLayout } from '../SplitContainer';
import {
    PaneNode,
    LeafNode,
    SplitNode,
    MIN_PANE_FRACTION,
    resetPaneIdCounter,
    useSplitLayoutStore,
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

/** Percentage values off an absolutely positioned pane/divider. */
function rectOf(el: HTMLElement) {
    const pct = (v: string) => (v.endsWith('%') ? parseFloat(v) : NaN);
    return {
        left: pct(el.style.left),
        top: pct(el.style.top),
        width: pct(el.style.width),
        height: pct(el.style.height),
    };
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
    it('renders a single leaf filling the container, with no dividers', () => {
        renderTree({ root: leaf('a', 'task-1') });
        const pane = screen.getByTestId('split-leaf-a');
        expect(pane).toBeInTheDocument();
        expect(screen.getByTestId('content-a')).toHaveTextContent('task-1');
        expect(rectOf(pane)).toEqual({ left: 0, top: 0, width: 100, height: 100 });
        expect(screen.queryAllByRole('separator')).toHaveLength(0);
    });

    it('renders every leaf as a FLAT sibling of the root container', () => {
        // This is the structural property the whole fix rests on: no leaf is
        // ever nested inside another leaf's subtree, at any tree depth.
        const root = split('s1', 'row', [leaf('a'), split('s2', 'column', [leaf('b'), leaf('c')])]);
        renderTree({ root });

        const container = screen.getByTestId('split-root');
        for (const id of ['a', 'b', 'c']) {
            expect(screen.getByTestId(`split-leaf-${id}`).parentElement).toBe(container);
        }
        // Dividers are flat siblings too.
        for (const divider of screen.getAllByRole('separator')) {
            expect(divider.parentElement).toBe(container);
        }
        // And no leaf contains another.
        expect(screen.getByTestId('split-leaf-a').contains(screen.getByTestId('split-leaf-b'))).toBe(
            false
        );
    });

    it('computes absolute rects for a nested layout', () => {
        const root = split('s1', 'row', [leaf('a'), split('s2', 'column', [leaf('b'), leaf('c')])]);
        renderTree({ root });

        expect(rectOf(screen.getByTestId('split-leaf-a'))).toEqual({
            left: 0,
            top: 0,
            width: 50,
            height: 100,
        });
        expect(rectOf(screen.getByTestId('split-leaf-b'))).toEqual({
            left: 50,
            top: 0,
            width: 50,
            height: 50,
        });
        expect(rectOf(screen.getByTestId('split-leaf-c'))).toEqual({
            left: 50,
            top: 50,
            width: 50,
            height: 50,
        });
    });

    it('renders one divider per gap, centred on the boundary and consuming no space', () => {
        const root = split('s1', 'row', [leaf('a'), split('s2', 'column', [leaf('b'), leaf('c')])]);
        renderTree({ root });

        expect(screen.getAllByRole('separator')).toHaveLength(2);

        const outer = screen.getByTestId('split-divider-s1-0');
        expect(outer).toHaveAttribute('aria-orientation', 'vertical');
        expect(outer.style.left).toBe('50%');
        expect(outer.style.height).toBe('100%');
        // Fixed pixel strip, pulled back by half its width so its CENTRE is on
        // the boundary — the panes themselves stay edge-to-edge.
        expect(outer.style.width).toBe('6px');
        expect(outer.style.marginLeft).toBe('-3px');

        const inner = screen.getByTestId('split-divider-s2-0');
        expect(inner).toHaveAttribute('aria-orientation', 'horizontal');
        expect(inner.style.top).toBe('50%');
        expect(inner.style.left).toBe('50%');
        expect(inner.style.width).toBe('50%');
        expect(inner.style.height).toBe('6px');
        expect(inner.style.marginTop).toBe('-3px');
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

    it('applies sizes from the node as pane widths', () => {
        const root = split('s1', 'row', [leaf('a'), leaf('b')], [0.7, 0.3]);
        renderTree({ root });
        expect(rectOf(screen.getByTestId('split-leaf-a'))).toMatchObject({ left: 0, width: 70 });
        expect(rectOf(screen.getByTestId('split-leaf-b'))).toMatchObject({ left: 70, width: 30 });
        expect(screen.getByTestId('split-divider-s1-0').style.left).toBe('70%');
    });

    it('normalizes sizes that do not sum to 1 instead of drawing a broken layout', () => {
        const root = split('s1', 'row', [leaf('a'), leaf('b')], [3, 1]);
        renderTree({ root });
        expect(rectOf(screen.getByTestId('split-leaf-a'))).toMatchObject({ left: 0, width: 75 });
        expect(rectOf(screen.getByTestId('split-leaf-b'))).toMatchObject({ left: 75, width: 25 });
    });
});

describe('SplitContainer — computeFlatLayout', () => {
    it('flattens a 3-deep tree into leaf rects and divider descriptors', () => {
        const root = split(
            's1',
            'row',
            [leaf('a'), split('s2', 'row', [leaf('b'), leaf('c')])],
            [0.5, 0.5]
        );
        const { leaves, dividers } = computeFlatLayout(root);

        expect(leaves.map((l) => l.leaf.id)).toEqual(['a', 'b', 'c']);
        expect(leaves[1]).toMatchObject({ left: 50, top: 0, width: 25, height: 100 });
        expect(leaves[2]).toMatchObject({ left: 75, top: 0, width: 25, height: 100 });

        expect(dividers.map((d) => `${d.splitId}:${d.index}`)).toEqual(['s1:0', 's2:0']);
        // The nested split only owns half the root along the x axis.
        expect(dividers[0].extent).toBeCloseTo(1, 6);
        expect(dividers[1].extent).toBeCloseTo(0.5, 6);
        expect(dividers[1].left).toBeCloseTo(75, 6);
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

    it('scales the delta by the nested split own extent, not the whole container', () => {
        // Regression for the drift bug: a divider inside a split that occupies
        // half the root must move twice as fast per fraction. 100px of the
        // nested split (500px wide) == 0.2, not 0.1.
        stubRects(1000, 500);
        const root = split('s1', 'row', [leaf('a'), split('s2', 'row', [leaf('b'), leaf('c')])], [0.5, 0.5]);
        const { onSizesChange } = renderTree({ root });

        fireEvent.mouseDown(screen.getByTestId('split-divider-s2-0'), { clientX: 750, clientY: 250 });
        fireEvent.mouseMove(window, { clientX: 850, clientY: 250 });

        const [splitId, sizes] = onSizesChange.mock.calls.at(-1)!;
        expect(splitId).toBe('s2');
        expect(sizes[0]).toBeCloseTo(0.7, 5);
        expect(sizes[1]).toBeCloseTo(0.3, 5);
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

    it('snaps to the min/max of the flanking pair with Home and End', () => {
        const { onSizesChange } = renderTree({ root: split('s1', 'row', [leaf('a'), leaf('b')]) });
        const divider = screen.getByTestId('split-divider-s1-0');

        fireEvent.keyDown(divider, { key: 'Home' });
        let sizes = onSizesChange.mock.calls.at(-1)![1];
        expect(sizes[0]).toBeCloseTo(MIN_PANE_FRACTION, 5);
        expect(sizes[1]).toBeCloseTo(1 - MIN_PANE_FRACTION, 5);

        fireEvent.keyDown(divider, { key: 'End' });
        sizes = onSizesChange.mock.calls.at(-1)![1];
        expect(sizes[0]).toBeCloseTo(1 - MIN_PANE_FRACTION, 5);
        expect(sizes[1]).toBeCloseTo(MIN_PANE_FRACTION, 5);
    });

    it('only touches the flanking pair when Home/End is used on a 3-way split', () => {
        const root = split('s1', 'row', [leaf('a'), leaf('b'), leaf('c')], [0.4, 0.4, 0.2]);
        const { onSizesChange } = renderTree({ root });

        fireEvent.keyDown(screen.getByTestId('split-divider-s1-0'), { key: 'End' });
        const sizes = onSizesChange.mock.calls.at(-1)![1];
        // Pair total 0.8, floor 0.08 → a takes 0.72, b keeps 0.08, c untouched.
        expect(sizes[0]).toBeCloseTo(0.72, 5);
        expect(sizes[1]).toBeCloseTo(0.08, 5);
        expect(sizes[2]).toBeCloseTo(0.2, 5);
    });

    it('exposes valuenow/valuemin/valuemax on the separator', () => {
        renderTree({ root: split('s1', 'row', [leaf('a'), leaf('b')], [0.7, 0.3]) });
        const divider = screen.getByTestId('split-divider-s1-0');
        expect(divider).toHaveAttribute('aria-valuenow', '70');
        expect(divider).toHaveAttribute('aria-valuemin', '8');
        expect(divider).toHaveAttribute('aria-valuemax', '92');
    });

    it('reports valuenow relative to the flanking pair, not the whole split', () => {
        // b/c share 60% of s1; the divider between them sits at 2/3 of that pair.
        const root = split('s1', 'row', [leaf('a'), leaf('b'), leaf('c')], [0.4, 0.4, 0.2]);
        renderTree({ root });
        expect(screen.getByTestId('split-divider-s1-1')).toHaveAttribute('aria-valuenow', '67');
    });
});

// ---------------------------------------------------------------------------
// The regression guard for the whole flat-leaves rewrite.
// ---------------------------------------------------------------------------

describe('SplitContainer — leaf stability (remount regression guard)', () => {
    /** Per-paneId mount counter; a remount bumps it a second time. */
    function makeMountTracker() {
        const mounts = new Map<string, number>();
        function Content({ id }: { id: string }) {
            React.useEffect(() => {
                mounts.set(id, (mounts.get(id) ?? 0) + 1);
                // No cleanup bookkeeping: we care about MOUNT count only.
            }, [id]);
            return <div data-testid={`content-${id}`} />;
        }
        const renderLeaf = (l: LeafNode) => <Content id={l.id} />;
        return { mounts, renderLeaf, count: (id: string) => mounts.get(id) ?? 0 };
    }

    it('does not remount leaf content when sizes change', () => {
        const { renderLeaf, count } = makeMountTracker();
        const props = {
            focusedPaneId: 'a',
            renderLeaf,
            onFocusPane: vi.fn(),
            onSizesChange: vi.fn(),
        };
        const { rerender } = render(
            <SplitContainer root={split('s1', 'row', [leaf('a'), leaf('b')], [0.5, 0.5])} {...props} />
        );
        expect([count('a'), count('b')]).toEqual([1, 1]);

        rerender(
            <SplitContainer root={split('s1', 'row', [leaf('a'), leaf('b')], [0.8, 0.2])} {...props} />
        );
        // No extra mounts → the xterm instances a consumer hangs here survive.
        expect([count('a'), count('b')]).toEqual([1, 1]);
    });

    it('does not remount a surviving leaf when it is SPLIT (leaf -> split at the same slot)', () => {
        // The exact shape of the old bug: root goes leaf(a) -> split(a, b), so
        // a recursive renderer would swap LeafView for SplitView at the root
        // child slot and blow away a's subtree.
        const { renderLeaf, count } = makeMountTracker();
        const props = {
            focusedPaneId: 'a',
            renderLeaf,
            onFocusPane: vi.fn(),
            onSizesChange: vi.fn(),
        };
        const { rerender } = render(<SplitContainer root={leaf('a')} {...props} />);
        expect([count('a'), count('b')]).toEqual([1, 0]);

        rerender(<SplitContainer root={split('s1', 'row', [leaf('a'), leaf('b')])} {...props} />);
        expect(count('a')).toBe(1); // survivor: still mounted exactly once
        expect(count('b')).toBe(1); // genuinely new pane: 0 -> 1

        // Split again, one level deeper on the b side.
        rerender(
            <SplitContainer
                root={split('s1', 'row', [
                    leaf('a'),
                    split('s2', 'column', [leaf('b'), leaf('c')]),
                ])}
                {...props}
            />
        );
        expect([count('a'), count('b'), count('c')]).toEqual([1, 1, 1]);
    });

    it('does not remount a surviving leaf when a split COLLAPSES back to a leaf', () => {
        const { renderLeaf, count } = makeMountTracker();
        const props = {
            focusedPaneId: 'a',
            renderLeaf,
            onFocusPane: vi.fn(),
            onSizesChange: vi.fn(),
        };
        const { rerender } = render(
            <SplitContainer root={split('s1', 'row', [leaf('a'), leaf('b')])} {...props} />
        );
        expect([count('a'), count('b')]).toEqual([1, 1]);

        rerender(<SplitContainer root={leaf('a')} {...props} />);
        expect(screen.queryByTestId('split-leaf-b')).not.toBeInTheDocument();
        expect(count('a')).toBe(1);
    });

    it('survives split/close driven through the real layout store', () => {
        localStorage.clear();
        resetPaneIdCounter(0);
        act(() => useSplitLayoutStore.getState().resetLayout());

        const { renderLeaf, count } = makeMountTracker();
        function Harness() {
            const root = useSplitLayoutStore((s) => s.root);
            const focusedPaneId = useSplitLayoutStore((s) => s.focusedPaneId);
            const focusPane = useSplitLayoutStore((s) => s.focusPane);
            const setSizes = useSplitLayoutStore((s) => s.setSizes);
            return (
                <SplitContainer
                    root={root}
                    focusedPaneId={focusedPaneId}
                    renderLeaf={renderLeaf}
                    onFocusPane={focusPane}
                    onSizesChange={setSizes}
                />
            );
        }
        render(<Harness />);

        const first = useSplitLayoutStore.getState().focusedPaneId;
        expect(count(first)).toBe(1);

        // Split once.
        let second = '';
        act(() => {
            second = useSplitLayoutStore.getState().splitPane(first, 'row')!;
        });
        expect(second).toBeTruthy();
        expect(count(first)).toBe(1);
        expect(count(second)).toBe(1);

        // Split again, in the other direction, nesting a level deeper.
        let third = '';
        act(() => {
            third = useSplitLayoutStore.getState().splitPane(second, 'column')!;
        });
        expect([count(first), count(second), count(third)]).toEqual([1, 1, 1]);

        // Drag-equivalent: change sizes on the outer split.
        act(() => {
            const rootNode = useSplitLayoutStore.getState().root;
            if (rootNode.type === 'split') {
                useSplitLayoutStore.getState().setSizes(rootNode.id, [0.75, 0.25]);
            }
        });
        expect([count(first), count(second), count(third)]).toEqual([1, 1, 1]);

        // Close the deepest pane — the inner split collapses back to a leaf.
        act(() => useSplitLayoutStore.getState().closePane(third));
        expect(screen.queryByTestId(`split-leaf-${third}`)).not.toBeInTheDocument();
        expect([count(first), count(second)]).toEqual([1, 1]);

        // Close again — the outer split collapses, leaving a single root leaf.
        act(() => useSplitLayoutStore.getState().closePane(second));
        expect(useSplitLayoutStore.getState().root).toMatchObject({ type: 'leaf', id: first });
        expect(count(first)).toBe(1);
        expect(rectOf(screen.getByTestId(`split-leaf-${first}`))).toEqual({
            left: 0,
            top: 0,
            width: 100,
            height: 100,
        });
    });
});
