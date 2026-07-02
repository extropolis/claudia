import { describe, it, expect } from 'vitest';
import { resolveParentLink, collectOrphanedChildIds } from '../task-links';

describe('resolveParentLink', () => {
    const existing = new Set(['t1', 't2']);
    it('returns the parent id when it exists', () => {
        expect(resolveParentLink('t1', existing)).toBe('t1');
    });
    it('returns undefined for unknown parents (dangling link never stored)', () => {
        expect(resolveParentLink('ghost', existing)).toBeUndefined();
    });
    it('returns undefined when no parent requested', () => {
        expect(resolveParentLink(undefined, existing)).toBeUndefined();
        expect(resolveParentLink('', existing)).toBeUndefined();
    });
});

describe('collectOrphanedChildIds', () => {
    it('finds direct children of the removed task', () => {
        const tasks = [
            { id: 'a' },
            { id: 'b', parentTaskId: 'a' },
            { id: 'c', parentTaskId: 'a' },
            { id: 'd', parentTaskId: 'b' },
        ];
        expect(collectOrphanedChildIds(tasks, 'a').sort()).toEqual(['b', 'c']);
    });
    it('returns empty when nothing links to the removed task', () => {
        expect(collectOrphanedChildIds([{ id: 'x' }], 'a')).toEqual([]);
    });
});
