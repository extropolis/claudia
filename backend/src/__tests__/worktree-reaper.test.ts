import { describe, it, expect } from 'vitest';
import { classifyWorktree, type TaskRef, type WorktreeRecord } from '../worktree-reaper.js';

const WT: WorktreeRecord = { id: '/repo/.claudia-worktrees/wt-1', worktreeParentId: '/repo' };
const NOW = new Date('2026-07-24T12:00:00Z').getTime();
const daysAgo = (d: number) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();
const task = (workspaceId: string, lastActivity: string, id = 't1'): TaskRef => ({ id, workspaceId, lastActivity });

describe('classifyWorktree (retention spec rules)', () => {
    it('NEVER removes a worktree referenced by a live/disconnected task', () => {
        const d = classifyWorktree(WT, [task(WT.id, daysAgo(100))], [task(WT.id, daysAgo(100), 'a1')], NOW, 30);
        expect(d).toEqual({ action: 'skip', reason: 'referenced by a live/disconnected task' });
    });

    it('removes orphans (no owning task anywhere) immediately', () => {
        const d = classifyWorktree(WT, [task('/repo', daysAgo(1))], [], NOW, 30);
        expect(d).toEqual({ action: 'remove', reason: 'orphan', archivedTaskIds: [] });
    });

    it('orphan removal runs even when the archived sweep is disabled', () => {
        const d = classifyWorktree(WT, [], [], NOW, 0);
        expect(d.action).toBe('remove');
    });

    it('retains archived-owner worktrees inside the retention window', () => {
        const d = classifyWorktree(WT, [], [task(WT.id, daysAgo(3), 'a1')], NOW, 30);
        expect(d.action).toBe('skip');
        expect((d as { reason: string }).reason).toContain('retained');
    });

    it('removes archived-owner worktrees past the retention window, listing owner task ids', () => {
        const d = classifyWorktree(WT, [], [task(WT.id, daysAgo(31), 'a1'), task(WT.id, daysAgo(45), 'a2')], NOW, 30);
        expect(d).toEqual({ action: 'remove', reason: 'retention-expired', archivedTaskIds: ['a1', 'a2'] });
    });

    it('uses the NEWEST owning task for the age check', () => {
        // one owner 45d old, another 5d old → newest wins → retained
        const d = classifyWorktree(WT, [], [task(WT.id, daysAgo(45), 'a1'), task(WT.id, daysAgo(5), 'a2')], NOW, 30);
        expect(d.action).toBe('skip');
    });

    it('retentionDays=0 disables the archived sweep (but not orphans)', () => {
        const d = classifyWorktree(WT, [], [task(WT.id, daysAgo(400), 'a1')], NOW, 0);
        expect(d).toEqual({ action: 'skip', reason: 'archived sweep disabled (retentionDays=0)' });
    });

    it('ignores tasks belonging to OTHER worktrees', () => {
        const d = classifyWorktree(WT, [task('/repo/.claudia-worktrees/wt-2', daysAgo(1))], [], NOW, 30);
        expect(d.action).toBe('remove'); // still an orphan — the active task is elsewhere
    });
});
