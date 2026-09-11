import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    PaneNode,
    LeafNode,
    SplitDirection,
    clampSizes,
    findSplit,
    MIN_PANE_FRACTION,
} from '../stores/splitLayoutStore';
import './SplitContainer.css';

/**
 * Generic renderer for a `PaneNode` tree.
 *
 * Knows nothing about tasks, terminals or WebSockets — the consumer supplies
 * `renderLeaf`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LEAVES ARE RENDERED FLAT (do not "simplify" this back to recursion)
 * ---------------------------------------------------------------------------
 * The obvious implementation is a recursive component that renders either a
 * leaf or a nested split at each level. It is also WRONG for our use case.
 *
 * With recursion, splitting leaf A turns
 *
 *     <PaneView><LeafView A/></PaneView>
 * into
 *     <PaneView><SplitView><PaneView><LeafView A/></PaneView>...</SplitView></PaneView>
 *
 * At the outer child slot React sees a DIFFERENT COMPONENT TYPE in the same
 * position, so it unmounts the entire subtree — including A's `TerminalView` —
 * and mounts a fresh one a level deeper. `key={id}` does not save you: type +
 * position wins over key. The same thing happens in reverse when closing a
 * pane collapses a 2-child split back into a single leaf.
 *
 * Each leaf here hosts a live xterm.js instance bound to a real PTY. A remount
 * means: xterm disposed and recreated (black flash), scrollback and selection
 * lost, a fresh `task:select` + full history refetch from the server, and a PTY
 * resize round-trip. Every split and every close would do that to a pane the
 * user was already watching.
 *
 * So instead — the approach VSCode's grid uses — we walk the tree ONCE to
 * compute an absolute rect (in percentages) for every leaf, then render ALL
 * leaves as FLAT SIBLINGS at a single React level, keyed by pane id, plus a
 * flat list of absolutely positioned dividers. A leaf's React position and
 * component type are now completely decoupled from its depth in the tree, so
 * restructuring the tree only changes a leaf's inline `style` — it can never
 * unmount one. See the "does not remount" tests in
 * `__tests__/SplitContainer.test.tsx`, which are the regression guard.
 */

export interface SplitContainerProps {
    root: PaneNode;
    focusedPaneId: string;
    renderLeaf: (leaf: LeafNode, isFocused: boolean) => React.ReactNode;
    onFocusPane: (paneId: string) => void;
    onSizesChange: (splitId: string, sizes: number[]) => void;
}

/** Keyboard nudge per arrow-key press, as a fraction of the parent split. */
const KEYBOARD_STEP = 0.02;

/**
 * Divider hit-strip thickness in px. Dividers are OVERLAYS centred on the
 * boundary between two panes — they consume no layout space at all, which is
 * what makes the drag math exact (see `startDrag`).
 */
const DIVIDER_PX = 6;

// ---------------------------------------------------------------------------
// Geometry: tree -> flat rects
// ---------------------------------------------------------------------------

/** A rect in percentages of the root container. */
interface Rect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface LeafRect extends Rect {
    leaf: LeafNode;
}

export interface DividerRect {
    splitId: string;
    index: number;
    direction: SplitDirection;
    /** Position of the boundary itself (the divider is centred on it). */
    left: number;
    top: number;
    /** Extent across the divider's own axis — how long the strip is, in %. */
    cross: number;
    /**
     * The two flanking fractions (already normalized). The divider can only
     * move within this pair, so it is also the range the aria values describe.
     */
    pair: [number, number];
    /**
     * The parent split's extent ALONG the resize axis, as a fraction of the
     * root container. Drag deltas are divided by this to convert pixels into
     * fractions of the parent, without measuring any nested DOM node.
     */
    extent: number;
}

export interface FlatLayout {
    leaves: LeafRect[];
    dividers: DividerRect[];
}

/**
 * Walk the tree and flatten it into absolute rects. A `row` split divides its
 * rect horizontally by `sizes`; a `column` split divides it vertically.
 */
export function computeFlatLayout(root: PaneNode): FlatLayout {
    const leaves: LeafRect[] = [];
    const dividers: DividerRect[] = [];

    const walk = (node: PaneNode, rect: Rect): void => {
        if (node.type === 'leaf') {
            leaves.push({ leaf: node, ...rect });
            return;
        }

        const isRow = node.direction === 'row';
        const count = node.children.length;
        const axisSpan = isRow ? rect.width : rect.height;
        // Defensive: a hand-rolled or persisted tree could carry sizes that do
        // not sum to 1. Normalize rather than draw a broken layout.
        const rawTotal = node.sizes.reduce(
            (a, b) => a + (Number.isFinite(b) && b > 0 ? b : 0),
            0
        );

        const fracs = node.children.map((_, i) => {
            const raw = node.sizes[i];
            return rawTotal > 0 && Number.isFinite(raw) && raw > 0 ? raw / rawTotal : 1 / count;
        });

        let offset = 0;
        node.children.forEach((child, i) => {
            const span = axisSpan * fracs[i];

            walk(
                child,
                isRow
                    ? { left: rect.left + offset, top: rect.top, width: span, height: rect.height }
                    : { left: rect.left, top: rect.top + offset, width: rect.width, height: span }
            );

            offset += span;

            if (i < count - 1) {
                dividers.push({
                    splitId: node.id,
                    index: i,
                    direction: node.direction,
                    left: isRow ? rect.left + offset : rect.left,
                    top: isRow ? rect.top : rect.top + offset,
                    cross: isRow ? rect.height : rect.width,
                    pair: [fracs[i], fracs[i + 1]],
                    extent: axisSpan / 100,
                });
            }
        });
    };

    walk(root, { left: 0, top: 0, width: 100, height: 100 });
    return { leaves, dividers };
}

// ---------------------------------------------------------------------------
// Leaf
// ---------------------------------------------------------------------------

interface LeafViewProps {
    leaf: LeafNode;
    isFocused: boolean;
    style: React.CSSProperties;
    renderLeaf: SplitContainerProps['renderLeaf'];
    onFocusPane: SplitContainerProps['onFocusPane'];
}

const LeafView = memo(function LeafView({
    leaf,
    isFocused,
    style,
    renderLeaf,
    onFocusPane,
}: LeafViewProps) {
    // Capture phase: xterm.js stops propagation on its own mousedown handling,
    // so a bubbling listener would never see clicks inside a live terminal.
    const focus = useCallback(() => onFocusPane(leaf.id), [onFocusPane, leaf.id]);

    return (
        <div
            className={`split-leaf${isFocused ? ' split-leaf--focused' : ''}`}
            style={style}
            data-pane-id={leaf.id}
            data-testid={`split-leaf-${leaf.id}`}
            onMouseDownCapture={focus}
            onFocusCapture={focus}
        >
            {renderLeaf(leaf, isFocused)}
        </div>
    );
});

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

interface DragState {
    splitId: string;
    index: number;
    isRow: boolean;
    startPos: number;
    startSizes: number[];
    /** Pixel extent of the PARENT SPLIT along the resize axis. */
    containerSize: number;
}

export function SplitContainer({
    root,
    focusedPaneId,
    renderLeaf,
    onFocusPane,
    onSizesChange,
}: SplitContainerProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [drag, setDrag] = useState<DragState | null>(null);

    const { leaves, dividers } = useMemo(() => computeFlatLayout(root), [root]);

    // Keep the live tree / callback in refs so the drag effect does not need to
    // re-subscribe (and thus tear down listeners) on every size update.
    const rootRef = useRef(root);
    rootRef.current = root;
    const onSizesChangeRef = useRef(onSizesChange);
    onSizesChangeRef.current = onSizesChange;

    /**
     * Move the boundary between `index` and `index + 1` so the first pane of
     * the pair becomes `nextA`. Only the two flanking panes move — their pair
     * sum is preserved — and neither may fall below MIN_PANE_FRACTION of the
     * parent (relaxed if the pair itself is smaller than 2x the floor).
     */
    const commitPair = useCallback(
        (splitId: string, index: number, sizes: number[], nextA: number) => {
            const a = sizes[index];
            const b = sizes[index + 1];
            if (!Number.isFinite(a) || !Number.isFinite(b)) return;
            const pairTotal = a + b;
            const min = Math.min(MIN_PANE_FRACTION, pairTotal / 2);
            const clampedA = Math.min(pairTotal - min, Math.max(min, nextA));
            const next = [...sizes];
            next[index] = clampedA;
            next[index + 1] = pairTotal - clampedA;
            onSizesChangeRef.current(splitId, clampSizes(next));
        },
        []
    );

    const applyDelta = useCallback(
        (state: DragState, deltaPx: number) => {
            if (state.containerSize <= 0) return;
            const deltaFrac = deltaPx / state.containerSize;
            commitPair(
                state.splitId,
                state.index,
                state.startSizes,
                state.startSizes[state.index] + deltaFrac
            );
        },
        [commitPair]
    );

    // Track on `window`, not the divider, so the drag keeps up when the cursor
    // outruns the element. The effect's cleanup guarantees no leaked listeners
    // on unmount mid-drag.
    useEffect(() => {
        if (!drag) return;
        const onMove = (e: MouseEvent) => {
            e.preventDefault();
            const pos = drag.isRow ? e.clientX : e.clientY;
            applyDelta(drag, pos - drag.startPos);
        };
        const onUp = () => setDrag(null);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [drag, applyDelta]);

    const startDrag = useCallback(
        (divider: DividerRect) => (e: React.MouseEvent<HTMLDivElement>) => {
            e.preventDefault();
            e.stopPropagation();
            const isRow = divider.direction === 'row';
            const rect = containerRef.current?.getBoundingClientRect();
            const rootSize = rect ? (isRow ? rect.width : rect.height) : 0;
            // Exact: panes are absolutely positioned, so the parent split owns
            // `extent` of the root along this axis with NO fixed-width divider
            // strips eating into it. (The old flex layout applied the fractions
            // to the space LEFT OVER after the strips while the drag measured
            // the whole rect, so the divider drifted behind the cursor.)
            const containerSize = rootSize * divider.extent;
            const split = findSplit(rootRef.current, divider.splitId);
            if (!split) return;
            setDrag({
                splitId: divider.splitId,
                index: divider.index,
                isRow,
                startPos: isRow ? e.clientX : e.clientY,
                startSizes: [...split.sizes],
                containerSize,
            });
        },
        []
    );

    const onDividerKeyDown = useCallback(
        (divider: DividerRect) => (e: React.KeyboardEvent<HTMLDivElement>) => {
            const isRow = divider.direction === 'row';
            const decrease = isRow ? 'ArrowLeft' : 'ArrowUp';
            const increase = isRow ? 'ArrowRight' : 'ArrowDown';
            if (e.key !== decrease && e.key !== increase && e.key !== 'Home' && e.key !== 'End') {
                return;
            }
            const split = findSplit(rootRef.current, divider.splitId);
            if (!split) return;
            e.preventDefault();

            const { index } = divider;
            const sizes = split.sizes;
            const pairTotal = sizes[index] + sizes[index + 1];
            let nextA: number;
            if (e.key === 'Home') {
                // Snap to the minimum; commitPair clamps it up to the real floor.
                nextA = 0;
            } else if (e.key === 'End') {
                nextA = pairTotal;
            } else {
                nextA = sizes[index] + (e.key === increase ? KEYBOARD_STEP : -KEYBOARD_STEP);
            }
            commitPair(divider.splitId, index, sizes, nextA);
        },
        [commitPair]
    );

    return (
        <div
            ref={containerRef}
            className={`split-root${drag ? ' split-root--dragging' : ''}`}
            data-testid="split-root"
        >
            {/*
             * FLAT: every leaf in the tree is a direct child here, keyed by its
             * stable pane id and positioned by inline percentages. Restructuring
             * the tree changes these styles, never the element identity — that
             * is what keeps xterm instances alive across split/close.
             */}
            {leaves.map(({ leaf, left, top, width, height }) => (
                <LeafView
                    key={leaf.id}
                    leaf={leaf}
                    isFocused={leaf.id === focusedPaneId}
                    style={{
                        left: `${left}%`,
                        top: `${top}%`,
                        width: `${width}%`,
                        height: `${height}%`,
                    }}
                    renderLeaf={renderLeaf}
                    onFocusPane={onFocusPane}
                />
            ))}

            {dividers.map((divider) => {
                const isRow = divider.direction === 'row';
                // Express the divider's travel as a percentage of the PAIR it
                // separates, which is exactly the range it is allowed to move in.
                const [firstOfPair, secondOfPair] = divider.pair;
                const pairTotal = firstOfPair + secondOfPair;
                const min = pairTotal > 0 ? Math.min(MIN_PANE_FRACTION, pairTotal / 2) : 0;
                const valueMin = pairTotal > 0 ? Math.round((min / pairTotal) * 100) : 0;
                const valueNow = pairTotal > 0 ? Math.round((firstOfPair / pairTotal) * 100) : 50;

                return (
                    <div
                        key={`${divider.splitId}:${divider.index}`}
                        className={`split-divider split-divider--${divider.direction}`}
                        style={
                            isRow
                                ? {
                                      left: `${divider.left}%`,
                                      top: `${divider.top}%`,
                                      height: `${divider.cross}%`,
                                      width: `${DIVIDER_PX}px`,
                                      marginLeft: `${-DIVIDER_PX / 2}px`,
                                  }
                                : {
                                      left: `${divider.left}%`,
                                      top: `${divider.top}%`,
                                      width: `${divider.cross}%`,
                                      height: `${DIVIDER_PX}px`,
                                      marginTop: `${-DIVIDER_PX / 2}px`,
                                  }
                        }
                        role="separator"
                        aria-orientation={isRow ? 'vertical' : 'horizontal'}
                        aria-label={`Resize panes (${isRow ? 'horizontal' : 'vertical'})`}
                        aria-valuenow={valueNow}
                        aria-valuemin={valueMin}
                        aria-valuemax={100 - valueMin}
                        tabIndex={0}
                        data-testid={`split-divider-${divider.splitId}-${divider.index}`}
                        data-divider-index={divider.index}
                        onMouseDown={startDrag(divider)}
                        onKeyDown={onDividerKeyDown(divider)}
                    >
                        <div className="split-divider__line" />
                    </div>
                );
            })}
        </div>
    );
}

export default SplitContainer;
