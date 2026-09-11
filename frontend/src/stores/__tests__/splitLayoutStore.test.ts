import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    useSplitLayoutStore,
    defaultLayout,
    resetPaneIdCounter,
    collectLeaves,
    countLeaves,
    findLeaf,
    findSplit,
    findParent,
    visibleTaskIds,
    clampSizes,
    sanitizeLayout,
    createLeaf,
    createPaneId,
    MAX_PANES,
    MIN_PANE_FRACTION,
    SPLIT_LAYOUT_KEY,
    SPLIT_LAYOUT_VERSION,
    PaneNode,
    SplitNode,
} from '../splitLayoutStore';

const store = () => useSplitLayoutStore.getState();

const sumsToOne = (sizes: number[]) => expect(sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);

/** Assert every split in the tree has consistent, normalized sizes. */
function assertInvariants(root: PaneNode) {
    if (root.type === 'leaf') return;
    expect(root.children.length).toBeGreaterThanOrEqual(2);
    expect(root.sizes.length).toBe(root.children.length);
    sumsToOne(root.sizes);
    root.children.forEach(assertInvariants);
}

beforeEach(() => {
    localStorage.clear();
    resetPaneIdCounter(0);
    useSplitLayoutStore.setState(defaultLayout());
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('splitLayoutStore — defaults', () => {
    it('starts as a single empty leaf that is focused', () => {
        const { root, focusedPaneId } = store();
        expect(root.type).toBe('leaf');
        expect((root as { taskId: string | null }).taskId).toBeNull();
        expect(focusedPaneId).toBe(root.id);
        expect(countLeaves(root)).toBe(1);
    });

    it('exports a pane cap of 6', () => {
        expect(MAX_PANES).toBe(6);
    });
});

describe('splitLayoutStore — splitPane', () => {
    it('splits a leaf into a row split, 50/50, focusing the new pane', () => {
        const original = store().root.id;
        const newId = store().splitPane(original, 'row');

        const { root, focusedPaneId } = store();
        expect(root.type).toBe('split');
        const split = root as SplitNode;
        expect(split.direction).toBe('row');
        expect(split.children.map((c) => c.id)).toEqual([original, newId]);
        expect(split.sizes).toEqual([0.5, 0.5]);
        expect(focusedPaneId).toBe(newId);
        assertInvariants(root);
    });

    it('splits into a column split', () => {
        store().splitPane(store().root.id, 'column');
        expect((store().root as SplitNode).direction).toBe('column');
    });

    it('keeps the existing task on the original pane and leaves the new one empty', () => {
        const original = store().root.id;
        store().setPaneTask(original, 'task-a');
        const newId = store().splitPane(original, 'row')!;

        expect(findLeaf(store().root, original)!.taskId).toBe('task-a');
        expect(findLeaf(store().root, newId)!.taskId).toBeNull();
    });

    it('flattens into a same-direction parent instead of nesting', () => {
        const a = store().root.id;
        const b = store().splitPane(a, 'row')!;
        const c = store().splitPane(b, 'row')!;

        const root = store().root as SplitNode;
        expect(root.type).toBe('split');
        expect(root.children).toHaveLength(3);
        expect(root.children.every((child) => child.type === 'leaf')).toBe(true);
        expect(root.children.map((child) => child.id)).toEqual([a, b, c]);
        // Existing panes shrank evenly to make room.
        root.sizes.forEach((s) => expect(s).toBeCloseTo(1 / 3, 6));
        assertInvariants(root);
    });

    it('nests when the parent split has the other direction', () => {
        const a = store().root.id;
        const b = store().splitPane(a, 'row')!;
        const c = store().splitPane(b, 'column')!;

        const root = store().root as SplitNode;
        expect(root.direction).toBe('row');
        expect(root.children).toHaveLength(2);
        const nested = root.children[1] as SplitNode;
        expect(nested.type).toBe('split');
        expect(nested.direction).toBe('column');
        expect(nested.children.map((child) => child.id)).toEqual([b, c]);
        assertInvariants(root);
    });

    it('keeps sizes summing to 1 through repeated splits', () => {
        let last = store().root.id;
        for (let i = 0; i < MAX_PANES - 1; i++) {
            last = store().splitPane(last, i % 2 === 0 ? 'row' : 'column')!;
        }
        assertInvariants(store().root);
        expect(countLeaves(store().root)).toBe(MAX_PANES);
    });

    it('refuses to exceed the 6-pane cap and warns', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        let last = store().root.id;
        for (let i = 0; i < MAX_PANES - 1; i++) {
            last = store().splitPane(last, 'row')!;
        }
        expect(countLeaves(store().root)).toBe(MAX_PANES);

        const result = store().splitPane(last, 'row');
        expect(result).toBeNull();
        expect(countLeaves(store().root)).toBe(MAX_PANES);
        expect(warn).toHaveBeenCalled();
    });

    it('is a no-op for an unknown pane id', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const before = store().root;
        expect(store().splitPane('nope', 'row')).toBeNull();
        expect(store().root).toBe(before);
    });
});

describe('splitLayoutStore — setPaneTask', () => {
    it('assigns a task to a pane', () => {
        const a = store().root.id;
        store().setPaneTask(a, 'task-1');
        expect(findLeaf(store().root, a)!.taskId).toBe('task-1');
        expect(visibleTaskIds(store().root)).toEqual(['task-1']);
    });

    it('moves a task rather than duplicating it (at most one leaf per task)', () => {
        const a = store().root.id;
        const b = store().splitPane(a, 'row')!;
        store().setPaneTask(a, 'task-1');
        store().setPaneTask(b, 'task-1');

        expect(findLeaf(store().root, a)!.taskId).toBeNull();
        expect(findLeaf(store().root, b)!.taskId).toBe('task-1');
        expect(visibleTaskIds(store().root)).toEqual(['task-1']);
    });

    it('clears a pane with null', () => {
        const a = store().root.id;
        store().setPaneTask(a, 'task-1');
        store().setPaneTask(a, null);
        expect(findLeaf(store().root, a)!.taskId).toBeNull();
        expect(visibleTaskIds(store().root)).toEqual([]);
    });

    it('ignores unknown pane ids', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const before = store().root;
        store().setPaneTask('nope', 'task-1');
        expect(store().root).toBe(before);
    });
});

describe('splitLayoutStore — closePane', () => {
    it('collapses a 1-child split and hoists the survivor', () => {
        const a = store().root.id;
        const b = store().splitPane(a, 'row')!;
        store().closePane(b);

        const { root } = store();
        expect(root.type).toBe('leaf');
        expect(root.id).toBe(a);
    });

    it('gives space back to the remaining siblings proportionally', () => {
        const a = store().root.id;
        const b = store().splitPane(a, 'row')!;
        const c = store().splitPane(b, 'row')!;
        store().closePane(c);

        const root = store().root as SplitNode;
        expect(root.children).toHaveLength(2);
        root.sizes.forEach((s) => expect(s).toBeCloseTo(0.5, 6));
        assertInvariants(root);
    });

    it('resets instead of emptying when closing the last pane', () => {
        const a = store().root.id;
        store().setPaneTask(a, 'task-1');
        store().closePane(a);

        const { root, focusedPaneId } = store();
        expect(countLeaves(root)).toBe(1);
        expect(root.type).toBe('leaf');
        expect((root as { taskId: string | null }).taskId).toBeNull();
        expect(focusedPaneId).toBe(root.id);
    });

    it('moves focus to the previous sibling when the focused pane closes', () => {
        const a = store().root.id;
        const b = store().splitPane(a, 'row')!;
        const c = store().splitPane(b, 'row')!;
        store().focusPane(c);
        store().closePane(c);
        expect(store().focusedPaneId).toBe(b);
    });

    it('falls back to the next sibling when there is no previous one', () => {
        const a = store().root.id;
        const b = store().splitPane(a, 'row')!;
        store().splitPane(b, 'row');
        store().focusPane(a);
        store().closePane(a);
        expect(store().focusedPaneId).toBe(b);
    });

    it('leaves focus alone when a non-focused pane closes', () => {
        const a = store().root.id;
        const b = store().splitPane(a, 'row')!;
        const c = store().splitPane(b, 'row')!;
        store().focusPane(a);
        store().closePane(c);
        expect(store().focusedPaneId).toBe(a);
    });

    it('ignores unknown pane ids', () => {
        const before = store().root;
        store().closePane('nope');
        expect(store().root).toBe(before);
    });
});

describe('splitLayoutStore — focusPane / resetLayout', () => {
    it('focuses an existing pane and ignores unknown ones', () => {
        const a = store().root.id;
        const b = store().splitPane(a, 'row')!;
        store().focusPane(a);
        expect(store().focusedPaneId).toBe(a);
        store().focusPane('nope');
        expect(store().focusedPaneId).toBe(a);
        store().focusPane(b);
        expect(store().focusedPaneId).toBe(b);
    });

    it('resets to a single empty pane', () => {
        const a = store().root.id;
        store().setPaneTask(a, 'task-1');
        store().splitPane(a, 'column');
        store().resetLayout();

        const { root, focusedPaneId } = store();
        expect(root.type).toBe('leaf');
        expect((root as { taskId: string | null }).taskId).toBeNull();
        expect(focusedPaneId).toBe(root.id);
    });
});

describe('splitLayoutStore — setSizes', () => {
    it('applies renormalized sizes', () => {
        const a = store().root.id;
        store().splitPane(a, 'row');
        const splitId = store().root.id;

        store().setSizes(splitId, [0.7, 0.3]);
        const split = findSplit(store().root, splitId)!;
        expect(split.sizes[0]).toBeCloseTo(0.7, 6);
        sumsToOne(split.sizes);
    });

    it('renormalizes sizes that do not sum to 1', () => {
        const a = store().root.id;
        store().splitPane(a, 'row');
        const splitId = store().root.id;

        store().setSizes(splitId, [3, 1]);
        const split = findSplit(store().root, splitId)!;
        expect(split.sizes[0]).toBeCloseTo(0.75, 6);
        sumsToOne(split.sizes);
    });

    it('clamps below the minimum fraction', () => {
        const a = store().root.id;
        store().splitPane(a, 'row');
        const splitId = store().root.id;

        store().setSizes(splitId, [0.001, 0.999]);
        const split = findSplit(store().root, splitId)!;
        expect(split.sizes[0]).toBeCloseTo(MIN_PANE_FRACTION, 6);
        sumsToOne(split.sizes);
    });

    it('rejects a wrong-length array and unknown split ids', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const a = store().root.id;
        store().splitPane(a, 'row');
        const splitId = store().root.id;
        const before = store().root;

        store().setSizes(splitId, [1]);
        expect(store().root).toBe(before);
        expect(warn).toHaveBeenCalled();

        store().setSizes('nope', [0.5, 0.5]);
        expect(store().root).toBe(before);
    });
});

describe('helpers', () => {
    it('countLeaves / findLeaf / findParent / collectLeaves walk the tree', () => {
        const a = store().root.id;
        const b = store().splitPane(a, 'row')!;
        const c = store().splitPane(b, 'column')!;
        const { root } = store();

        expect(countLeaves(root)).toBe(3);
        expect(collectLeaves(root).map((l) => l.id)).toEqual([a, b, c]);
        expect(findLeaf(root, b)!.id).toBe(b);
        expect(findLeaf(root, 'nope')).toBeNull();
        expect(findParent(root, c)!.direction).toBe('column');
        expect(findParent(root, root.id)).toBeNull();
        expect(findSplit(root, 'nope')).toBeNull();
    });

    it('visibleTaskIds is ordered, de-duplicated and non-null', () => {
        const a = store().root.id;
        const b = store().splitPane(a, 'row')!;
        const c = store().splitPane(b, 'row')!;
        store().setPaneTask(a, 'task-a');
        store().setPaneTask(c, 'task-c');
        expect(visibleTaskIds(store().root)).toEqual(['task-a', 'task-c']);
    });

    it('clampSizes handles degenerate input', () => {
        expect(clampSizes([])).toEqual([]);
        sumsToOne(clampSizes([0, 0]));
        sumsToOne(clampSizes([NaN, 1]));
        // Floor unsatisfiable for many panes → even split.
        const many = clampSizes(new Array(20).fill(1), 0.2);
        many.forEach((s) => expect(s).toBeCloseTo(1 / 20, 6));
        sumsToOne(many);
    });

    it('createLeaf / createPaneId produce unique deterministic ids', () => {
        resetPaneIdCounter(0);
        expect(createLeaf().id).toBe('pane-1');
        expect(createPaneId('split')).toBe('split-2');
    });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const persistBlob = (state: unknown, version = SPLIT_LAYOUT_VERSION) =>
    JSON.stringify({ state, version });

describe('splitLayoutStore — persistence', () => {
    it('persists to the claudia-split-layout key', () => {
        store().splitPane(store().root.id, 'row');
        const raw = localStorage.getItem(SPLIT_LAYOUT_KEY);
        expect(raw).toBeTruthy();
        const parsed = JSON.parse(raw!);
        expect(parsed.version).toBe(SPLIT_LAYOUT_VERSION);
        expect(parsed.state.root.type).toBe('split');
    });

    it('restores a valid persisted layout', async () => {
        const layout = {
            root: {
                type: 'split',
                id: 'split-9',
                direction: 'row',
                sizes: [0.4, 0.6],
                children: [
                    { type: 'leaf', id: 'pane-7', taskId: 'task-x' },
                    { type: 'leaf', id: 'pane-8', taskId: null },
                ],
            },
            focusedPaneId: 'pane-8',
        };
        localStorage.setItem(SPLIT_LAYOUT_KEY, persistBlob(layout));
        await useSplitLayoutStore.persist.rehydrate();

        expect(store().root.id).toBe('split-9');
        expect(store().focusedPaneId).toBe('pane-8');
        expect(visibleTaskIds(store().root)).toEqual(['task-x']);
        // Counter seeded past restored ids so new panes cannot collide.
        expect(createPaneId('pane')).toBe('pane-10');
    });

    const corrupt: Array<[string, string]> = [
        ['not JSON at all', '{{{not json'],
        ['null root', persistBlob({ root: null, focusedPaneId: 'x' })],
        ['unknown node type', persistBlob({ root: { type: 'weird', id: 'a' }, focusedPaneId: 'a' })],
        [
            'split with one child',
            persistBlob({
                root: {
                    type: 'split',
                    id: 's',
                    direction: 'row',
                    sizes: [1],
                    children: [{ type: 'leaf', id: 'p', taskId: null }],
                },
                focusedPaneId: 'p',
            }),
        ],
        [
            'sizes/children length mismatch',
            persistBlob({
                root: {
                    type: 'split',
                    id: 's',
                    direction: 'row',
                    sizes: [0.5],
                    children: [
                        { type: 'leaf', id: 'p1', taskId: null },
                        { type: 'leaf', id: 'p2', taskId: null },
                    ],
                },
                focusedPaneId: 'p1',
            }),
        ],
        [
            'sizes not summing to 1',
            persistBlob({
                root: {
                    type: 'split',
                    id: 's',
                    direction: 'row',
                    sizes: [0.9, 0.9],
                    children: [
                        { type: 'leaf', id: 'p1', taskId: null },
                        { type: 'leaf', id: 'p2', taskId: null },
                    ],
                },
                focusedPaneId: 'p1',
            }),
        ],
        [
            'duplicate node ids',
            persistBlob({
                root: {
                    type: 'split',
                    id: 's',
                    direction: 'row',
                    sizes: [0.5, 0.5],
                    children: [
                        { type: 'leaf', id: 'dup', taskId: null },
                        { type: 'leaf', id: 'dup', taskId: null },
                    ],
                },
                focusedPaneId: 'dup',
            }),
        ],
        [
            'same task in two panes',
            persistBlob({
                root: {
                    type: 'split',
                    id: 's',
                    direction: 'row',
                    sizes: [0.5, 0.5],
                    children: [
                        { type: 'leaf', id: 'p1', taskId: 'task-dup' },
                        { type: 'leaf', id: 'p2', taskId: 'task-dup' },
                    ],
                },
                focusedPaneId: 'p1',
            }),
        ],
        [
            'wrong version',
            persistBlob({ root: { type: 'leaf', id: 'p', taskId: null }, focusedPaneId: 'p' }, 999),
        ],
    ];

    it.each(corrupt)('falls back to a single empty pane for %s', async (_name, raw) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        localStorage.setItem(SPLIT_LAYOUT_KEY, raw);

        // Must not throw — a bad blob may never white-screen the app.
        await useSplitLayoutStore.persist.rehydrate();

        const { root, focusedPaneId } = store();
        expect(countLeaves(root)).toBe(1);
        expect(root.type).toBe('leaf');
        expect((root as { taskId: string | null }).taskId).toBeNull();
        expect(focusedPaneId).toBe(root.id);
    });

    it('sanitizeLayout rejects garbage and repairs a bad focus id', () => {
        expect(sanitizeLayout(null)).toBeNull();
        expect(sanitizeLayout('nope')).toBeNull();
        expect(sanitizeLayout({ root: { type: 'leaf', id: '', taskId: null } })).toBeNull();
        expect(sanitizeLayout({ root: { type: 'leaf', id: 'p', taskId: 3 } })).toBeNull();

        const repaired = sanitizeLayout({
            root: { type: 'leaf', id: 'p', taskId: null },
            focusedPaneId: 'gone',
        });
        expect(repaired!.focusedPaneId).toBe('p');
    });

    it('sanitizeLayout rejects a tree over the pane cap', () => {
        const children = Array.from({ length: MAX_PANES + 1 }, (_, i) => ({
            type: 'leaf',
            id: `p${i}`,
            taskId: null,
        }));
        const sizes = children.map(() => 1 / children.length);
        expect(
            sanitizeLayout({
                root: { type: 'split', id: 's', direction: 'row', children, sizes },
                focusedPaneId: 'p0',
            })
        ).toBeNull();
    });
});
