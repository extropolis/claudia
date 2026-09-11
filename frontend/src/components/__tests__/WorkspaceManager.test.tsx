/**
 * WorkspaceManager — the "Manage Workspaces" modal.
 *
 * The behaviour under test is the separation between workspaces and worktrees:
 * a worktree is a per-task checkout that the sidebar renders as a task inside
 * its parent repo, so it must never appear in this list. With auto-worktree on,
 * real configs reach ~80 worktree records against a handful of workspaces, and
 * listing them made the modal unusable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Workspace } from '@claudia/shared';
import { WorkspaceManager } from '../WorkspaceManager';

vi.mock('../../config/api-config', () => ({
    getApiBaseUrl: () => 'http://claudia.test:9999',
}));

function makeWorkspace(id: string, extra: Partial<Workspace> = {}): Workspace {
    return {
        id,
        name: id.split(/[\\/]/).pop() ?? id,
        createdAt: new Date().toISOString(),
        ...extra,
    };
}

const repoA = '/work/repo-a';
const repoB = '/work/repo-b';

/** Two repos; repo-a has two worktrees under it. */
function defaultWorkspaces(): Workspace[] {
    return [
        makeWorkspace(repoA),
        makeWorkspace(`${repoA}/.claudia-worktrees/claudia-task-1111`, {
            worktreeParentId: repoA,
            worktreeBranch: 'claudia/task-1111',
            displayName: 'repo-a › task-1111',
        }),
        makeWorkspace(`${repoA}/.claudia-worktrees/claudia-task-2222`, {
            worktreeParentId: repoA,
            worktreeBranch: 'claudia/task-2222',
            displayName: 'repo-a › task-2222',
        }),
        makeWorkspace(repoB),
    ];
}

function renderManager(overrides: {
    workspaces?: Workspace[];
    onSetWorkspaceOrder?: (ids: string[]) => void;
    onDeleteWorkspace?: (id: string) => void;
} = {}) {
    const onSetWorkspaceOrder = overrides.onSetWorkspaceOrder ?? vi.fn();
    const onDeleteWorkspace = overrides.onDeleteWorkspace ?? vi.fn();
    const props = (workspaces: Workspace[]) => ({
        workspaces,
        onClose: vi.fn(),
        onCreateWorkspace: vi.fn(),
        onDeleteWorkspace,
        onSetWorkspaceOrder,
    });
    const initial = overrides.workspaces ?? defaultWorkspaces();
    const view = render(<WorkspaceManager {...props(initial)} />);
    const rerenderWith = (workspaces: Workspace[]) =>
        view.rerender(<WorkspaceManager {...props(workspaces)} />);
    return { onSetWorkspaceOrder, onDeleteWorkspace, rerenderWith };
}

/** The rendered rows, in visual order, identified by their path line. */
function renderedPaths(): string[] {
    return Array.from(document.querySelectorAll('.workspace-item-path')).map(
        el => el.textContent ?? ''
    );
}

/** Drag one rendered row onto another, the way the browser sequences the events. */
function dragRow(from: HTMLElement, to: HTMLElement) {
    fireEvent.dragStart(from, { dataTransfer: { effectAllowed: '' } });
    fireEvent.dragEnter(to);
    fireEvent.dragEnd(from);
}

describe('WorkspaceManager', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        cleanup();
    });

    it('lists only real workspaces, never worktree children', () => {
        renderManager();

        expect(renderedPaths()).toEqual([repoA, repoB]);
        expect(screen.queryByText(/claudia-task-1111/)).not.toBeInTheDocument();
        expect(screen.queryByText(/claudia-task-2222/)).not.toBeInTheDocument();
    });

    it('reports the hidden worktrees in the footer count', () => {
        renderManager();

        expect(screen.getByText(/2 workspaces/)).toBeInTheDocument();
        expect(screen.getByText(/2 worktrees hidden/)).toBeInTheDocument();
    });

    it('badges a workspace with the number of worktrees living under it', () => {
        renderManager();

        const badge = screen.getByTitle(
            '2 worktrees — shown as tasks under this workspace in the sidebar'
        );
        expect(badge).toHaveTextContent('2');
        // repo-b has none, so exactly one badge exists overall
        expect(document.querySelectorAll('.workspace-item-worktree-badge')).toHaveLength(1);
    });

    it('searching never surfaces a worktree, even by its own path', async () => {
        const user = userEvent.setup();
        renderManager();

        await user.type(screen.getByPlaceholderText('Search workspaces...'), 'claudia-task');

        expect(renderedPaths()).toEqual([]);
        expect(screen.getByText(/No workspaces match/)).toBeInTheDocument();
    });

    it('still lists an orphaned worktree so it can be deleted', () => {
        // Parent repo deleted out from under it: the sidebar renders this record
        // nowhere, so the manager is the only place it can be cleaned up.
        const orphan = makeWorkspace('/work/gone/.claudia-worktrees/claudia-task-9999', {
            worktreeParentId: '/work/gone',
            worktreeBranch: 'claudia/task-9999',
        });
        renderManager({ workspaces: [...defaultWorkspaces(), orphan] });

        expect(renderedPaths()).toContain(orphan.id);
        expect(
            screen.getByTitle('Worktree whose parent workspace no longer exists — safe to delete')
        ).toBeInTheDocument();
    });

    it('persists a drag as a full id order with worktrees kept behind their parent', () => {
        const { onSetWorkspaceOrder } = renderManager();

        const rows = document.querySelectorAll('.workspace-manager-item');
        expect(rows).toHaveLength(2);

        // Drag repo-b (row 1) above repo-a (row 0).
        dragRow(rows[1] as HTMLElement, rows[0] as HTMLElement);

        // The visible rows are a subset of the store, so an index-based move would
        // have swapped whatever worktree sat at that index. The full order is sent
        // instead, with each worktree following its parent.
        expect(onSetWorkspaceOrder).toHaveBeenCalledWith([
            repoB,
            repoA,
            `${repoA}/.claudia-worktrees/claudia-task-1111`,
            `${repoA}/.claudia-worktrees/claudia-task-2222`,
        ]);
    });

    it('does not reorder while a search is filtering the list', async () => {
        const user = userEvent.setup();
        const { onSetWorkspaceOrder } = renderManager({
            workspaces: [...defaultWorkspaces(), makeWorkspace('/work/repo-c')],
        });

        await user.type(screen.getByPlaceholderText('Search workspaces...'), 'repo-');
        const rows = document.querySelectorAll('.workspace-manager-item');
        expect(rows).toHaveLength(3);
        expect((rows[0] as HTMLElement).getAttribute('draggable')).toBe('false');

        dragRow(rows[2] as HTMLElement, rows[0] as HTMLElement);

        expect(onSetWorkspaceOrder).not.toHaveBeenCalled();
    });

    it('keeps the Add Workspace dialog open when a task spawns a worktree', async () => {
        // The dialog auto-closes on a successful add, detected by the list growing.
        // Counting the raw store made any background worktree creation close it
        // mid-typing, since tasks create those continuously.
        const user = userEvent.setup();
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
        const { rerenderWith } = renderManager();

        await user.click(screen.getByRole('button', { name: 'Add Workspace' }));
        expect(screen.getByRole('heading', { name: 'Add Workspace' })).toBeInTheDocument();

        rerenderWith([
            ...defaultWorkspaces(),
            makeWorkspace(`${repoA}/.claudia-worktrees/claudia-task-3333`, {
                worktreeParentId: repoA,
                worktreeBranch: 'claudia/task-3333',
            }),
        ]);

        expect(screen.getByRole('heading', { name: 'Add Workspace' })).toBeInTheDocument();

        // A real workspace appearing still closes it.
        rerenderWith([...defaultWorkspaces(), makeWorkspace('/work/repo-c')]);
        expect(screen.queryByRole('heading', { name: 'Add Workspace' })).not.toBeInTheDocument();
    });

    it('warns that deleting a workspace orphans the worktrees under it', async () => {
        // Those worktree rows used to be visible in this list; now that they are
        // not, the confirm is the only place the consequence can be seen.
        const user = userEvent.setup();
        const confirm = vi.fn(() => false);
        vi.stubGlobal('confirm', confirm);
        const { onDeleteWorkspace } = renderManager();

        const repoARow = document.querySelectorAll('.workspace-manager-item')[0];
        await user.click(within(repoARow as HTMLElement).getByTitle('Delete workspace'));

        expect(confirm).toHaveBeenCalledWith(
            expect.stringContaining('2 worktrees will be left without a parent workspace')
        );
        expect(onDeleteWorkspace).not.toHaveBeenCalled();
    });

    it('does not mention worktrees when the workspace has none', async () => {
        const user = userEvent.setup();
        const confirm = vi.fn(() => true);
        vi.stubGlobal('confirm', confirm);
        const { onDeleteWorkspace } = renderManager();

        const repoBRow = document.querySelectorAll('.workspace-manager-item')[1];
        await user.click(within(repoBRow as HTMLElement).getByTitle('Delete workspace'));

        expect(confirm).toHaveBeenCalledWith(expect.not.stringContaining('worktree'));
        expect(onDeleteWorkspace).toHaveBeenCalledWith(repoB);
    });

    it('select-all covers only the listed workspaces', async () => {
        const user = userEvent.setup();
        renderManager();

        await user.click(screen.getByRole('button', { name: /Select All/ }));

        expect(screen.getByText('2 of 2 selected')).toBeInTheDocument();
        const deleteBtn = screen.getByRole('button', { name: /Delete 2 Selected/ });
        expect(within(deleteBtn).queryByText(/worktree/)).not.toBeInTheDocument();
    });
});
