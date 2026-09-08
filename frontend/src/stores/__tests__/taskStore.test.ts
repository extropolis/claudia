import { describe, it, expect, beforeEach } from 'vitest';
import { useTaskStore } from '../taskStore';
import type { Workspace } from '@claudia/shared';

const ws = (id: string): Workspace => ({
    id,
    name: id.split('/').pop() || id,
    createdAt: '2026-01-01T00:00:00.000Z',
});

const A = ws('/Users/test/work/alpha');
const B = ws('/Users/test/work/beta');
const C = ws('/Users/test/work/gamma');

describe('taskStore workspace expand/collapse persistence', () => {
    beforeEach(() => {
        // Reset to a pristine pre-load state between tests
        useTaskStore.setState({
            workspaces: [],
            expandedWorkspaces: new Set<string>(),
            expandedWorkspacesInitialized: false,
        });
    });

    it('expands all workspaces on true first-ever load (no persisted state)', () => {
        useTaskStore.getState().setWorkspaces([A, B]);
        const { expandedWorkspaces } = useTaskStore.getState();
        expect(expandedWorkspaces.has(A.id)).toBe(true);
        expect(expandedWorkspaces.has(B.id)).toBe(true);
    });

    it('respects persisted collapsed state on page reload (regression: sleep/reload expanded everything)', () => {
        // Simulate rehydrated persisted state: user had collapsed B, only A expanded
        useTaskStore.setState({
            workspaces: [], // fresh load — server hasn't sent workspaces yet
            expandedWorkspaces: new Set([A.id]),
            expandedWorkspacesInitialized: true,
        });

        // WS init delivers the workspace list
        useTaskStore.getState().setWorkspaces([A, B]);

        const { expandedWorkspaces } = useTaskStore.getState();
        expect(expandedWorkspaces.has(A.id)).toBe(true);
        expect(expandedWorkspaces.has(B.id)).toBe(false); // stayed collapsed
    });

    it('keeps everything collapsed on reload when user had collapsed all', () => {
        useTaskStore.setState({
            workspaces: [],
            expandedWorkspaces: new Set<string>(),
            expandedWorkspacesInitialized: true,
        });

        useTaskStore.getState().setWorkspaces([A, B]);

        expect(useTaskStore.getState().expandedWorkspaces.size).toBe(0);
    });

    it('auto-expands only genuinely new workspaces mid-session', () => {
        useTaskStore.setState({
            workspaces: [A, B],
            expandedWorkspaces: new Set([A.id]), // B collapsed by user
            expandedWorkspacesInitialized: true,
        });

        // Server pushes an update including a brand-new workspace C
        useTaskStore.getState().setWorkspaces([A, B, C]);

        const { expandedWorkspaces } = useTaskStore.getState();
        expect(expandedWorkspaces.has(A.id)).toBe(true);
        expect(expandedWorkspaces.has(B.id)).toBe(false); // untouched
        expect(expandedWorkspaces.has(C.id)).toBe(true);  // new → expanded
    });

    it('stores per-workspace task-list heights independently', () => {
        useTaskStore.setState({ workspaceTaskListHeights: {} });
        useTaskStore.getState().setWorkspaceTaskListHeight(A.id, 220);
        useTaskStore.getState().setWorkspaceTaskListHeight(B.id, 340);
        const heights = useTaskStore.getState().workspaceTaskListHeights;
        expect(heights[A.id]).toBe(220);
        expect(heights[B.id]).toBe(340);
        // updating one leaves the other untouched
        useTaskStore.getState().setWorkspaceTaskListHeight(A.id, 180);
        expect(useTaskStore.getState().workspaceTaskListHeights[B.id]).toBe(340);
    });

    it('drops expanded entries for workspaces that no longer exist', () => {
        useTaskStore.setState({
            workspaces: [A, B],
            expandedWorkspaces: new Set([A.id, B.id]),
            expandedWorkspacesInitialized: true,
        });

        useTaskStore.getState().setWorkspaces([A]);

        const { expandedWorkspaces } = useTaskStore.getState();
        expect(expandedWorkspaces.has(A.id)).toBe(true);
        expect(expandedWorkspaces.has(B.id)).toBe(false);
    });
});
