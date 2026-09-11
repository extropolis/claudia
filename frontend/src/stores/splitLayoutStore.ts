import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Generic split-pane layout engine (VSCode-style editor splits).
 *
 * Deliberately knows NOTHING about tasks, terminals or WebSockets beyond an
 * opaque `taskId: string | null` slot on each leaf. The renderer
 * (`SplitContainer`) is equally generic — integration lives in App.tsx, owned
 * elsewhere.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LeafNode = { type: 'leaf'; id: string; taskId: string | null };
export type SplitNode = {
    type: 'split';
    id: string;
    direction: 'row' | 'column';
    children: PaneNode[];
    sizes: number[];
};
export type PaneNode = LeafNode | SplitNode;

export type SplitDirection = 'row' | 'column';

export interface SplitLayoutState {
    root: PaneNode;
    focusedPaneId: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** localStorage key. Mirrors the `claudia-sidebar-width` naming in App.tsx. */
export const SPLIT_LAYOUT_KEY = 'claudia-split-layout';

/** Persisted schema version — bump when the shape changes so old blobs are dropped. */
export const SPLIT_LAYOUT_VERSION = 1;

/**
 * Hard cap on simultaneously visible panes. Each leaf eventually hosts a live
 * xterm.js instance backed by a real PTY, so this is a resource ceiling, not a
 * cosmetic one.
 */
export const MAX_PANES = 6;

/**
 * Minimum pane size, as a fraction of its parent split.
 *
 * Chosen as a FRACTION (8%) rather than a pixel floor (e.g. 120px) because the
 * store must clamp sizes without knowing anything about the DOM — the same
 * clamp then applies identically in `setSizes` and in the divider drag, so a
 * layout can never be persisted in a state the renderer would refuse to draw.
 */
export const MIN_PANE_FRACTION = 0.08;

// ---------------------------------------------------------------------------
// Id generation
// ---------------------------------------------------------------------------

let paneIdCounter = 0;

/** Deterministic, monotonic node ids. No Math.random() — tests depend on this. */
export function createPaneId(prefix: 'pane' | 'split' = 'pane'): string {
    paneIdCounter += 1;
    return `${prefix}-${paneIdCounter}`;
}

/** Test hook: reset (or seed) the id counter. */
export function resetPaneIdCounter(value = 0): void {
    paneIdCounter = value;
}

/**
 * After rehydrating persisted ids, push the counter past anything already in
 * the tree so freshly created panes can never collide with restored ones.
 */
function seedPaneIdCounterFrom(root: PaneNode): void {
    let max = paneIdCounter;
    const walk = (node: PaneNode) => {
        const m = /-(\d+)$/.exec(node.id);
        if (m) max = Math.max(max, Number(m[1]));
        if (node.type === 'split') node.children.forEach(walk);
    };
    walk(root);
    paneIdCounter = max;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported so they are unit-testable without React)
// ---------------------------------------------------------------------------

export function createLeaf(taskId: string | null = null): LeafNode {
    return { type: 'leaf', id: createPaneId('pane'), taskId };
}

export function defaultLayout(): SplitLayoutState {
    const leaf = createLeaf(null);
    return { root: leaf, focusedPaneId: leaf.id };
}

/** Every leaf, in visual (left-to-right / top-to-bottom) order. */
export function collectLeaves(root: PaneNode): LeafNode[] {
    if (root.type === 'leaf') return [root];
    return root.children.flatMap(collectLeaves);
}

export function countLeaves(root: PaneNode): number {
    if (root.type === 'leaf') return 1;
    return root.children.reduce((sum, child) => sum + countLeaves(child), 0);
}

export function findLeaf(root: PaneNode, paneId: string): LeafNode | null {
    if (root.type === 'leaf') return root.id === paneId ? root : null;
    for (const child of root.children) {
        const hit = findLeaf(child, paneId);
        if (hit) return hit;
    }
    return null;
}

export function findSplit(root: PaneNode, splitId: string): SplitNode | null {
    if (root.type === 'leaf') return null;
    if (root.id === splitId) return root;
    for (const child of root.children) {
        const hit = findSplit(child, splitId);
        if (hit) return hit;
    }
    return null;
}

/** The split node that directly contains `nodeId`, or null if it is the root. */
export function findParent(root: PaneNode, nodeId: string): SplitNode | null {
    if (root.type === 'leaf') return null;
    if (root.children.some((c) => c.id === nodeId)) return root;
    for (const child of root.children) {
        const hit = findParent(child, nodeId);
        if (hit) return hit;
    }
    return null;
}

/** Ordered, de-duplicated, non-null task ids currently on screen. */
export function visibleTaskIds(root: PaneNode): string[] {
    const out: string[] = [];
    for (const leaf of collectLeaves(root)) {
        if (leaf.taskId && !out.includes(leaf.taskId)) out.push(leaf.taskId);
    }
    return out;
}

/**
 * Clamp every entry to at least `min` and renormalize so the array sums to 1.
 *
 * Runs a few relaxation passes because lifting one entry to the floor steals
 * from the others, which can push a second entry below the floor.
 */
export function clampSizes(sizes: number[], min = MIN_PANE_FRACTION): number[] {
    const n = sizes.length;
    if (n === 0) return [];
    // With enough panes the floor becomes unsatisfiable; degrade to even split.
    const floor = Math.min(min, 1 / n);

    let vals = sizes.map((s) => (Number.isFinite(s) && s > 0 ? s : 0));
    let total = vals.reduce((a, b) => a + b, 0);
    vals = total > 0 ? vals.map((v) => v / total) : new Array(n).fill(1 / n);

    for (let pass = 0; pass < n; pass++) {
        const below = new Set<number>();
        vals.forEach((v, i) => {
            if (v < floor - 1e-9) below.add(i);
        });
        if (below.size === 0) break;
        const freeIdx = vals.map((_, i) => i).filter((i) => !below.has(i));
        const freeTotal = freeIdx.reduce((sum, i) => sum + vals[i], 0);
        const remaining = Math.max(0, 1 - below.size * floor);
        vals = vals.map((v, i) => {
            if (below.has(i)) return floor;
            if (freeTotal > 0) return (v / freeTotal) * remaining;
            return remaining / Math.max(1, freeIdx.length);
        });
    }

    total = vals.reduce((a, b) => a + b, 0);
    return total > 0 ? vals.map((v) => v / total) : new Array(n).fill(1 / n);
}

// ---------------------------------------------------------------------------
// Immutable tree transforms
// ---------------------------------------------------------------------------

/** Replace the node with `targetId` by `replacement` (structurally shared). */
function replaceNode(node: PaneNode, targetId: string, replacement: PaneNode | null): PaneNode | null {
    if (node.id === targetId) return replacement;
    if (node.type === 'leaf') return node;

    let changed = false;
    const nextChildren: PaneNode[] = [];
    const nextSizes: number[] = [];
    node.children.forEach((child, i) => {
        const next = replaceNode(child, targetId, replacement);
        if (next !== child) changed = true;
        if (next) {
            nextChildren.push(next);
            nextSizes.push(node.sizes[i] ?? 1 / node.children.length);
        }
    });
    if (!changed) return node;

    if (nextChildren.length === 0) return null;
    // Collapse a split left holding a single child — no dangling 1-child splits.
    if (nextChildren.length === 1) return nextChildren[0];
    return { ...node, children: nextChildren, sizes: clampSizes(nextSizes) };
}

/** Map every leaf through `fn`, sharing structure where nothing changed. */
function mapLeaves(node: PaneNode, fn: (leaf: LeafNode) => LeafNode): PaneNode {
    if (node.type === 'leaf') return fn(node);
    let changed = false;
    const children = node.children.map((child) => {
        const next = mapLeaves(child, fn);
        if (next !== child) changed = true;
        return next;
    });
    return changed ? { ...node, children } : node;
}

/** First leaf under a node — used to pick a focus target. */
function firstLeafOf(node: PaneNode): LeafNode {
    return collectLeaves(node)[0];
}

// ---------------------------------------------------------------------------
// Persisted-shape validation
// ---------------------------------------------------------------------------

function isValidNode(value: unknown, seen: Set<string>): value is PaneNode {
    if (!value || typeof value !== 'object') return false;
    const node = value as Record<string, unknown>;
    if (typeof node.id !== 'string' || node.id.length === 0) return false;
    if (seen.has(node.id)) return false;
    seen.add(node.id);

    if (node.type === 'leaf') {
        return node.taskId === null || typeof node.taskId === 'string';
    }
    if (node.type !== 'split') return false;
    if (node.direction !== 'row' && node.direction !== 'column') return false;
    if (!Array.isArray(node.children) || node.children.length < 2) return false;
    if (!Array.isArray(node.sizes) || node.sizes.length !== node.children.length) return false;
    if (!node.sizes.every((s) => typeof s === 'number' && Number.isFinite(s) && s > 0)) return false;
    const sum = (node.sizes as number[]).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 0.01) return false;
    return node.children.every((child) => isValidNode(child, seen));
}

/**
 * Validate a persisted blob. Returns null for anything corrupt, wrong-shaped,
 * or invariant-violating so the caller can fall back to a single empty pane.
 * A bad localStorage value must never white-screen the app.
 */
export function sanitizeLayout(value: unknown): SplitLayoutState | null {
    try {
        if (!value || typeof value !== 'object') return null;
        const candidate = value as Record<string, unknown>;
        const root = candidate.root;
        if (!isValidNode(root, new Set<string>())) return null;

        const leaves = collectLeaves(root);
        if (leaves.length === 0 || leaves.length > MAX_PANES) return null;

        // At-most-one-pane-per-task invariant.
        const taskIds = leaves.map((l) => l.taskId).filter((t): t is string => !!t);
        if (new Set(taskIds).size !== taskIds.length) return null;

        const focusedPaneId =
            typeof candidate.focusedPaneId === 'string' && leaves.some((l) => l.id === candidate.focusedPaneId)
                ? candidate.focusedPaneId
                : leaves[0].id;

        return { root, focusedPaneId };
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface SplitLayoutStore extends SplitLayoutState {
    /** Split a leaf in two. Returns the new pane's id, or null if it was a no-op. */
    splitPane: (paneId: string, direction: SplitDirection) => string | null;
    closePane: (paneId: string) => void;
    setPaneTask: (paneId: string, taskId: string | null) => void;
    focusPane: (paneId: string) => void;
    setSizes: (splitId: string, sizes: number[]) => void;
    resetLayout: () => void;
}

export const useSplitLayoutStore = create<SplitLayoutStore>()(
    persist(
        (set, get) => ({
            ...defaultLayout(),

            splitPane: (paneId, direction) => {
                const { root } = get();
                if (countLeaves(root) >= MAX_PANES) {
                    console.warn(
                        `[splitLayout] refusing to split ${paneId}: pane cap of ${MAX_PANES} reached`
                    );
                    return null;
                }
                const target = findLeaf(root, paneId);
                if (!target) {
                    console.warn(`[splitLayout] splitPane: no leaf with id ${paneId}`);
                    return null;
                }

                const newLeaf = createLeaf(null);
                const parent = findParent(root, paneId);

                let nextRoot: PaneNode;
                if (parent && parent.direction === direction) {
                    // Flatten: same-direction parent gains a sibling instead of
                    // nesting a redundant split. Existing panes shrink
                    // proportionally to make room.
                    const index = parent.children.findIndex((c) => c.id === paneId);
                    const n = parent.children.length;
                    const share = 1 / (n + 1);
                    const children = [...parent.children];
                    children.splice(index + 1, 0, newLeaf);
                    const sizes = [...parent.sizes];
                    sizes.splice(index + 1, 0, share);
                    const scaled = sizes.map((s, i) => (i === index + 1 ? share : s * (n / (n + 1))));
                    const nextParent: SplitNode = {
                        ...parent,
                        children,
                        sizes: clampSizes(scaled),
                    };
                    nextRoot = replaceNode(root, parent.id, nextParent) ?? nextParent;
                } else {
                    const split: SplitNode = {
                        type: 'split',
                        id: createPaneId('split'),
                        direction,
                        children: [target, newLeaf],
                        sizes: [0.5, 0.5],
                    };
                    nextRoot = replaceNode(root, paneId, split) ?? split;
                }

                set({ root: nextRoot, focusedPaneId: newLeaf.id });
                return newLeaf.id;
            },

            closePane: (paneId) => {
                const { root, focusedPaneId } = get();
                const target = findLeaf(root, paneId);
                if (!target) return;

                const leaves = collectLeaves(root);
                if (leaves.length <= 1) {
                    // Never leave zero panes: reset to a single empty one.
                    const cleared: LeafNode = { ...target, taskId: null };
                    set({ root: cleared, focusedPaneId: cleared.id });
                    return;
                }

                const parent = findParent(root, paneId);
                const index = parent ? parent.children.findIndex((c) => c.id === paneId) : -1;
                const neighbour =
                    parent && index >= 0
                        ? parent.children[index - 1] ?? parent.children[index + 1] ?? null
                        : null;

                const nextRoot = replaceNode(root, paneId, null);
                if (!nextRoot) {
                    set(defaultLayout());
                    return;
                }

                const remaining = collectLeaves(nextRoot);
                let nextFocus = focusedPaneId;
                if (focusedPaneId === paneId || !remaining.some((l) => l.id === focusedPaneId)) {
                    const preferred = neighbour ? firstLeafOf(neighbour) : null;
                    nextFocus =
                        preferred && remaining.some((l) => l.id === preferred.id)
                            ? preferred.id
                            : remaining[0].id;
                }

                set({ root: nextRoot, focusedPaneId: nextFocus });
            },

            setPaneTask: (paneId, taskId) => {
                const { root } = get();
                if (!findLeaf(root, paneId)) {
                    console.warn(`[splitLayout] setPaneTask: no leaf with id ${paneId}`);
                    return;
                }
                // A task is ONE pty with one cols/rows. Showing it in two
                // differently sized panes would make them fight over resize and
                // corrupt both terminals — so it moves, it never duplicates.
                const nextRoot = mapLeaves(root, (leaf) => {
                    if (leaf.id === paneId) return leaf.taskId === taskId ? leaf : { ...leaf, taskId };
                    if (taskId !== null && leaf.taskId === taskId) return { ...leaf, taskId: null };
                    return leaf;
                });
                set({ root: nextRoot });
            },

            focusPane: (paneId) => {
                const { root, focusedPaneId } = get();
                if (paneId === focusedPaneId) return;
                if (!findLeaf(root, paneId)) return;
                set({ focusedPaneId: paneId });
            },

            setSizes: (splitId, sizes) => {
                const { root } = get();
                const split = findSplit(root, splitId);
                if (!split) return;
                if (!Array.isArray(sizes) || sizes.length !== split.children.length) {
                    console.warn(
                        `[splitLayout] setSizes: expected ${split.children.length} sizes for ${splitId}, got ${sizes?.length}`
                    );
                    return;
                }
                const next: SplitNode = { ...split, sizes: clampSizes(sizes) };
                const nextRoot = replaceNode(root, splitId, next) ?? next;
                set({ root: nextRoot });
            },

            resetLayout: () => set(defaultLayout()),
        }),
        {
            name: SPLIT_LAYOUT_KEY,
            version: SPLIT_LAYOUT_VERSION,
            storage: createJSONStorage(() => localStorage),
            partialize: (state): SplitLayoutState => ({
                root: state.root,
                focusedPaneId: state.focusedPaneId,
            }),
            // Any older/unknown version is discarded rather than guessed at; the
            // null falls through to merge(), which swaps in the default layout.
            migrate: (persisted, version) =>
                (version === SPLIT_LAYOUT_VERSION ? persisted : null) as SplitLayoutState,
            merge: (persisted, current) => {
                const valid = sanitizeLayout(persisted);
                if (!valid) {
                    if (persisted) {
                        console.warn('[splitLayout] discarding invalid persisted layout; using default');
                    }
                    return { ...current, ...defaultLayout() };
                }
                seedPaneIdCounterFrom(valid.root);
                return { ...current, ...valid };
            },
            onRehydrateStorage: () => (_state, error) => {
                if (error) {
                    console.warn('[splitLayout] rehydrate failed; using default layout', error);
                }
            },
        }
    )
);
