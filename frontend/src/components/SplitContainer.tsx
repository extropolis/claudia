import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { PaneNode, LeafNode, SplitNode, clampSizes, MIN_PANE_FRACTION } from '../stores/splitLayoutStore';
import './SplitContainer.css';

/**
 * Generic recursive renderer for a `PaneNode` tree.
 *
 * Knows nothing about tasks, terminals or WebSockets — the consumer supplies
 * `renderLeaf`. Leaves are keyed by their stable pane id and wrapped in a
 * memoized component so a divider drag re-renders sizes WITHOUT remounting
 * leaf content (a remount would destroy an xterm.js instance's scrollback).
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

// ---------------------------------------------------------------------------
// Leaf
// ---------------------------------------------------------------------------

interface LeafViewProps {
    leaf: LeafNode;
    isFocused: boolean;
    renderLeaf: SplitContainerProps['renderLeaf'];
    onFocusPane: SplitContainerProps['onFocusPane'];
}

const LeafView = memo(function LeafView({ leaf, isFocused, renderLeaf, onFocusPane }: LeafViewProps) {
    // Capture phase: xterm.js stops propagation on its own mousedown handling,
    // so a bubbling listener would never see clicks inside a live terminal.
    const focus = useCallback(() => onFocusPane(leaf.id), [onFocusPane, leaf.id]);

    return (
        <div
            className={`split-leaf${isFocused ? ' split-leaf--focused' : ''}`}
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
// Split
// ---------------------------------------------------------------------------

interface SplitViewProps extends Omit<SplitContainerProps, 'root'> {
    node: SplitNode;
}

interface DragState {
    index: number;
    startPos: number;
    startSizes: number[];
    containerSize: number;
}

function SplitView({ node, focusedPaneId, renderLeaf, onFocusPane, onSizesChange }: SplitViewProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [drag, setDrag] = useState<DragState | null>(null);
    const isRow = node.direction === 'row';

    // Keep the live sizes/id in a ref so the drag effect does not need to
    // re-subscribe (and thus tear down listeners) on every size update.
    const nodeRef = useRef(node);
    nodeRef.current = node;
    const onSizesChangeRef = useRef(onSizesChange);
    onSizesChangeRef.current = onSizesChange;

    const applyDelta = useCallback((state: DragState, deltaPx: number) => {
        const { index, startSizes, containerSize } = state;
        if (containerSize <= 0) return;
        const deltaFrac = deltaPx / containerSize;
        const a = startSizes[index];
        const b = startSizes[index + 1];
        const pairTotal = a + b;
        // Only the two panes flanking the divider move; everything else holds.
        const min = Math.min(MIN_PANE_FRACTION, pairTotal / 2);
        const nextA = Math.min(pairTotal - min, Math.max(min, a + deltaFrac));
        const next = [...startSizes];
        next[index] = nextA;
        next[index + 1] = pairTotal - nextA;
        onSizesChangeRef.current(nodeRef.current.id, clampSizes(next));
    }, []);

    // Track on `window`, not the divider, so the drag keeps up when the cursor
    // outruns the element. The effect's cleanup guarantees no leaked listeners
    // on unmount mid-drag.
    useEffect(() => {
        if (!drag) return;
        const onMove = (e: MouseEvent) => {
            e.preventDefault();
            const pos = isRow ? e.clientX : e.clientY;
            applyDelta(drag, pos - drag.startPos);
        };
        const onUp = () => setDrag(null);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [drag, isRow, applyDelta]);

    const startDrag = useCallback(
        (index: number) => (e: React.MouseEvent<HTMLDivElement>) => {
            e.preventDefault();
            e.stopPropagation();
            const rect = containerRef.current?.getBoundingClientRect();
            const containerSize = rect ? (isRow ? rect.width : rect.height) : 0;
            setDrag({
                index,
                startPos: isRow ? e.clientX : e.clientY,
                startSizes: [...nodeRef.current.sizes],
                containerSize,
            });
        },
        [isRow]
    );

    const onDividerKeyDown = useCallback(
        (index: number) => (e: React.KeyboardEvent<HTMLDivElement>) => {
            const decrease = isRow ? 'ArrowLeft' : 'ArrowUp';
            const increase = isRow ? 'ArrowRight' : 'ArrowDown';
            if (e.key !== decrease && e.key !== increase) return;
            e.preventDefault();
            const sizes = nodeRef.current.sizes;
            const step = e.key === increase ? KEYBOARD_STEP : -KEYBOARD_STEP;
            const pairTotal = sizes[index] + sizes[index + 1];
            const min = Math.min(MIN_PANE_FRACTION, pairTotal / 2);
            const nextA = Math.min(pairTotal - min, Math.max(min, sizes[index] + step));
            const next = [...sizes];
            next[index] = nextA;
            next[index + 1] = pairTotal - nextA;
            onSizesChangeRef.current(nodeRef.current.id, clampSizes(next));
        },
        [isRow]
    );

    return (
        <div
            ref={containerRef}
            className={`split-container split-container--${node.direction}${drag ? ' split-container--dragging' : ''}`}
            data-split-id={node.id}
            data-testid={`split-node-${node.id}`}
        >
            {node.children.map((child, i) => (
                <React.Fragment key={child.id}>
                    <div
                        className="split-pane"
                        style={{ flex: `${node.sizes[i] ?? 1 / node.children.length} 1 0%` }}
                        data-pane-slot={child.id}
                    >
                        <PaneView
                            node={child}
                            focusedPaneId={focusedPaneId}
                            renderLeaf={renderLeaf}
                            onFocusPane={onFocusPane}
                            onSizesChange={onSizesChange}
                        />
                    </div>
                    {i < node.children.length - 1 && (
                        <div
                            className={`split-divider split-divider--${node.direction}`}
                            role="separator"
                            aria-orientation={isRow ? 'vertical' : 'horizontal'}
                            aria-label={`Resize panes (${isRow ? 'horizontal' : 'vertical'})`}
                            tabIndex={0}
                            data-testid={`split-divider-${node.id}-${i}`}
                            data-divider-index={i}
                            onMouseDown={startDrag(i)}
                            onKeyDown={onDividerKeyDown(i)}
                        >
                            <div className="split-divider__line" />
                        </div>
                    )}
                </React.Fragment>
            ))}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

interface PaneViewProps extends Omit<SplitContainerProps, 'root'> {
    node: PaneNode;
}

function PaneView({ node, focusedPaneId, renderLeaf, onFocusPane, onSizesChange }: PaneViewProps) {
    if (node.type === 'leaf') {
        return (
            <LeafView
                leaf={node}
                isFocused={node.id === focusedPaneId}
                renderLeaf={renderLeaf}
                onFocusPane={onFocusPane}
            />
        );
    }
    return (
        <SplitView
            node={node}
            focusedPaneId={focusedPaneId}
            renderLeaf={renderLeaf}
            onFocusPane={onFocusPane}
            onSizesChange={onSizesChange}
        />
    );
}

export function SplitContainer({
    root,
    focusedPaneId,
    renderLeaf,
    onFocusPane,
    onSizesChange,
}: SplitContainerProps) {
    return (
        <div className="split-root" data-testid="split-root">
            <PaneView
                node={root}
                focusedPaneId={focusedPaneId}
                renderLeaf={renderLeaf}
                onFocusPane={onFocusPane}
                onSizesChange={onSizesChange}
            />
        </div>
    );
}

export default SplitContainer;
