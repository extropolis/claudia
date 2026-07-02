import { describe, it, expect } from 'vitest';
import { buildTaskTree } from '../utils/taskTree';
import type { Task } from '@claudia/shared';

function makeTask(id: string, parentTaskId?: string): Task {
    return { id, prompt: id, state: 'idle', workspaceId: '/ws', createdAt: new Date(), lastActivity: new Date(), parentTaskId } as Task;
}

describe('buildTaskTree', () => {
    it('splits roots from children and groups children by parent', () => {
        const tree = buildTaskTree([makeTask('a'), makeTask('b', 'a'), makeTask('c', 'a'), makeTask('d')]);
        expect(tree.roots.map(t => t.id)).toEqual(['a', 'd']);
        expect(tree.childrenByParent.get('a')?.map(t => t.id)).toEqual(['b', 'c']);
        expect(tree.childrenByParent.has('d')).toBe(false);
    });
    it('treats children of missing parents as roots (orphans)', () => {
        const tree = buildTaskTree([makeTask('b', 'ghost')]);
        expect(tree.roots.map(t => t.id)).toEqual(['b']);
    });
    it('handles grandchildren (nested one level per lookup)', () => {
        const tree = buildTaskTree([makeTask('a'), makeTask('b', 'a'), makeTask('c', 'b')]);
        expect(tree.roots.map(t => t.id)).toEqual(['a']);
        expect(tree.childrenByParent.get('b')?.map(t => t.id)).toEqual(['c']);
    });
});
