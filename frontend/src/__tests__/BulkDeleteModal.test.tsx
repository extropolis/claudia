import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { BulkDeleteModal, buildRows, type BulkDeleteRequest } from '../components/BulkDeleteModal';

const TASKS = [
    { taskId: 't1', taskName: 'PR 2930 CI failure triage' },
    { taskId: 't2', taskName: 'Audit: agent-collapse milestones' },
    { taskId: 't3', taskName: 'Plan: lemond as hub component' },
];
const request: BulkDeleteRequest = { requestId: 'del-1', tasks: TASKS };

/** Rows are <li>; the checkbox is the one input inside each. */
const rowFor = (name: string) =>
    screen.getByText(name).closest('li') as HTMLLIElement;

const boxFor = (name: string) =>
    within(rowFor(name)).getByRole('checkbox') as HTMLInputElement;

const allBoxes = () => screen.getAllByRole('checkbox') as HTMLInputElement[];

const renderModal = (
    requests: BulkDeleteRequest[],
    onResolve: (r: { requestId: string; approvedIds: string[]; rejectedIds: string[] }[]) => void = vi.fn(),
) => render(<BulkDeleteModal requests={requests} onResolve={onResolve} />);

describe('BulkDeleteModal', () => {
    it('starts with every task checked', () => {
        renderModal([request]);
        expect(allBoxes()).toHaveLength(3);
        expect(allBoxes().every(b => b.checked)).toBe(true);
        expect(screen.getByText('3 of 3 selected')).toBeInTheDocument();
    });

    it('approves everything when confirmed untouched', () => {
        const onResolve = vi.fn();
        renderModal([request], onResolve);
        fireEvent.click(screen.getByRole('button', { name: 'Delete 3' }));
        expect(onResolve).toHaveBeenCalledWith([
            { requestId: 'del-1', approvedIds: ['t1', 't2', 't3'], rejectedIds: [] },
        ]);
    });

    it('moves an unchecked task into the kept list', () => {
        const onResolve = vi.fn();
        renderModal([request], onResolve);
        fireEvent.click(allBoxes()[1]);
        expect(screen.getByText('2 of 3 selected')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Delete 2' }));
        expect(onResolve).toHaveBeenCalledWith([
            { requestId: 'del-1', approvedIds: ['t1', 't3'], rejectedIds: ['t2'] },
        ]);
    });

    it('keeps every task when cancelled — never a partial delete', () => {
        const onResolve = vi.fn();
        renderModal([request], onResolve);
        fireEvent.click(allBoxes()[0]);
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onResolve).toHaveBeenCalledWith([
            { requestId: 'del-1', approvedIds: [], rejectedIds: ['t1', 't2', 't3'] },
        ]);
    });

    it('disables confirm when nothing is selected', () => {
        renderModal([request]);
        fireEvent.click(screen.getByRole('button', { name: 'Select none' }));
        const confirm = screen.getByRole('button', { name: 'Delete none' }) as HTMLButtonElement;
        expect(confirm.disabled).toBe(true);
        expect(screen.getByText(/no task will be deleted/)).toBeInTheDocument();
    });

    it('re-checks all after Select none then Select all', () => {
        renderModal([request]);
        fireEvent.click(screen.getByRole('button', { name: 'Select none' }));
        fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
        expect(screen.getByText('3 of 3 selected')).toBeInTheDocument();
    });

    it('does not inherit the previous request selection', () => {
        const { rerender } = renderModal([request]);
        fireEvent.click(allBoxes()[0]);
        expect(screen.getByText('2 of 3 selected')).toBeInTheDocument();

        rerender(<BulkDeleteModal requests={[{ requestId: 'del-2', tasks: TASKS }]} onResolve={vi.fn()} />);
        expect(screen.getByText('3 of 3 selected')).toBeInTheDocument();
    });

    it('uses singular wording and no bulk controls for one task', () => {
        renderModal([{ requestId: 'del-3', tasks: [TASKS[0]] }]);
        expect(screen.getByText('Delete Task')).toBeInTheDocument();
        expect(screen.getByText(/this task/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Select all' })).toBeNull();
    });
});

// ── task hierarchy ──────────────────────────────────────────────────────────

describe('BulkDeleteModal hierarchy', () => {
    const hierarchical: BulkDeleteRequest = {
        requestId: 'del-h',
        tasks: [
            { taskId: 'p', taskName: 'Coordinator' },
            { taskId: 'c1', taskName: 'Child one', parentTaskId: 'p', impliedByParent: true },
            { taskId: 'g', taskName: 'Grandchild', parentTaskId: 'c1', impliedByParent: true },
            { taskId: 'c2', taskName: 'Child two', parentTaskId: 'p', impliedByParent: true },
        ],
    };

    it('nests descendants under their parent and marks them as subtasks', () => {
        renderModal([hierarchical]);
        const names = screen.getAllByRole('listitem').map(li => li.textContent);
        // Depth-first: each parent immediately followed by its own subtree.
        expect(names[0]).toContain('Coordinator');
        expect(names[1]).toContain('Child one');
        expect(names[2]).toContain('Grandchild');
        expect(names[3]).toContain('Child two');

        expect(rowFor('Coordinator').querySelector('.bulk-delete-item.child')).toBeNull();
        expect(rowFor('Grandchild').querySelector('.bulk-delete-item.child')).not.toBeNull();
        expect(within(rowFor('Child one')).getByText('subtask')).toBeInTheDocument();
    });

    /**
     * Deleting a coordinator and silently leaving its fleet behind is the exact
     * surprise this dialog exists to prevent, so a parent takes its whole
     * subtree with it — including grandchildren.
     */
    it('unchecking a parent unchecks its entire subtree', () => {
        renderModal([hierarchical]);
        fireEvent.click(boxFor('Coordinator'));

        expect(boxFor('Coordinator').checked).toBe(false);
        expect(boxFor('Child one').checked).toBe(false);
        expect(boxFor('Grandchild').checked).toBe(false);
        expect(boxFor('Child two').checked).toBe(false);
        expect(screen.getByText('0 of 4 selected')).toBeInTheDocument();
    });

    it('re-checking a parent re-checks its entire subtree', () => {
        renderModal([hierarchical]);
        fireEvent.click(boxFor('Coordinator'));
        fireEvent.click(boxFor('Coordinator'));
        expect(screen.getByText('4 of 4 selected')).toBeInTheDocument();
    });

    it('unchecking a mid-level task spares only that branch', () => {
        const onResolve = vi.fn();
        renderModal([hierarchical], onResolve);
        fireEvent.click(boxFor('Child one'));

        expect(boxFor('Coordinator').checked).toBe(true);
        expect(boxFor('Grandchild').checked).toBe(false);
        expect(boxFor('Child two').checked).toBe(true);

        fireEvent.click(screen.getByRole('button', { name: 'Delete 2' }));
        expect(onResolve).toHaveBeenCalledWith([
            { requestId: 'del-h', approvedIds: ['p', 'c2'], rejectedIds: ['c1', 'g'] },
        ]);
    });

    /**
     * A kept subtask whose parent is deleted does not vanish — the sidebar
     * renders it top-level once the parent row is gone. That is a real change to
     * the user's tree, so the dialog says it out loud instead of letting the
     * hierarchy rearrange itself after the fact.
     */
    it('warns that kept subtasks of a deleted parent move to the top level', () => {
        renderModal([hierarchical]);
        expect(screen.queryByText(/move to the top level/)).toBeNull();

        fireEvent.click(boxFor('Child two'));
        expect(screen.getByText(/1 subtask you are keeping/)).toBeInTheDocument();
        expect(screen.getByText(/move to the top level/)).toBeInTheDocument();
    });

    it('drops the warning once the parent is spared too', () => {
        renderModal([hierarchical]);
        fireEvent.click(boxFor('Child two'));
        expect(screen.getByText(/move to the top level/)).toBeInTheDocument();

        // Unchecking the parent takes the rest with it — nothing is orphaned.
        fireEvent.click(boxFor('Coordinator'));
        expect(screen.queryByText(/move to the top level/)).toBeNull();
    });

    it('renders a cyclic parent link flat instead of hanging', () => {
        const rows = buildRows([{
            requestId: 'del-cycle',
            tasks: [
                { taskId: 'a', taskName: 'A', parentTaskId: 'b' },
                { taskId: 'b', taskName: 'B', parentTaskId: 'a' },
            ],
        }]);
        expect(rows.map(r => r.taskId).sort()).toEqual(['a', 'b']);
    });

    it('does not indent a task whose parent is not part of the request', () => {
        const rows = buildRows([{
            requestId: 'del-x',
            tasks: [{ taskId: 'c', taskName: 'Orphan', parentTaskId: 'elsewhere' }],
        }]);
        expect(rows[0].depth).toBe(0);
    });
});

// ── git worktrees ───────────────────────────────────────────────────────────

describe('BulkDeleteModal worktrees', () => {
    const worktreeRequest: BulkDeleteRequest = {
        requestId: 'del-w',
        tasks: [
            { taskId: 'w1', taskName: 'Isolated task', worktree: 'claudia/task-abc' },
            { taskId: 'w2', taskName: 'Another isolated task', worktree: 'claudia/task-def' },
            { taskId: 'plain', taskName: 'In-place task' },
        ],
    };

    it('tags each row with the worktree branch it runs in', () => {
        renderModal([worktreeRequest]);
        expect(within(rowFor('Isolated task')).getByText('claudia/task-abc')).toBeInTheDocument();
        expect(within(rowFor('In-place task')).queryByText(/claudia\/task-/)).toBeNull();
    });

    /**
     * Archiving kills the task's process but never removes its git worktree —
     * matching the single-task delete path, which has never touched worktrees
     * either. Users read "delete" as reclaiming the branch, so say otherwise.
     */
    it('warns that the git worktrees are left on disk', () => {
        renderModal([worktreeRequest]);
        expect(screen.getByText(/2 git worktrees are left on disk/)).toBeInTheDocument();
    });

    it('names the single worktree when only one is being deleted', () => {
        renderModal([worktreeRequest]);
        fireEvent.click(boxFor('Another isolated task'));
        expect(screen.getByText(/The git worktree claudia\/task-abc is left on disk/)).toBeInTheDocument();
    });

    it('drops the worktree warning when no worktree task is selected', () => {
        renderModal([worktreeRequest]);
        fireEvent.click(boxFor('Isolated task'));
        fireEvent.click(boxFor('Another isolated task'));
        expect(screen.queryByText(/left on disk/)).toBeNull();
    });
});

// ── several agents asking at once ───────────────────────────────────────────

describe('BulkDeleteModal with concurrent requests', () => {
    const a: BulkDeleteRequest = { requestId: 'del-a', tasks: [{ taskId: 't1', taskName: 'Alpha' }] };
    const b: BulkDeleteRequest = { requestId: 'del-b', tasks: [{ taskId: 't2', taskName: 'Beta' }] };

    it('coalesces two agents into one dialog but resolves them separately', () => {
        const onResolve = vi.fn();
        renderModal([a, b], onResolve);

        expect(screen.getByText(/2 agents are requesting/)).toBeInTheDocument();
        fireEvent.click(boxFor('Beta'));
        fireEvent.click(screen.getByRole('button', { name: 'Delete 1' }));

        expect(onResolve).toHaveBeenCalledWith([
            { requestId: 'del-a', approvedIds: ['t1'], rejectedIds: [] },
            { requestId: 'del-b', approvedIds: [], rejectedIds: ['t2'] },
        ]);
    });

    it('renders a task named by two requests once, and answers both', () => {
        const onResolve = vi.fn();
        const dup: BulkDeleteRequest = { requestId: 'del-dup', tasks: [{ taskId: 't1', taskName: 'Alpha' }] };
        renderModal([a, dup], onResolve);

        expect(allBoxes()).toHaveLength(1);
        fireEvent.click(screen.getByRole('button', { name: 'Delete 1' }));
        expect(onResolve).toHaveBeenCalledWith([
            { requestId: 'del-a', approvedIds: ['t1'], rejectedIds: [] },
            { requestId: 'del-dup', approvedIds: ['t1'], rejectedIds: [] },
        ]);
    });

    /**
     * A request arriving while the dialog is open must not reset decisions the
     * user has already made about the requests it joins — nor arrive unchecked
     * and be missed.
     */
    it('keeps existing decisions when a new request joins the open dialog', () => {
        const { rerender } = renderModal([a]);
        fireEvent.click(boxFor('Alpha'));
        expect(boxFor('Alpha').checked).toBe(false);

        rerender(<BulkDeleteModal requests={[a, b]} onResolve={vi.fn()} />);
        expect(boxFor('Alpha').checked).toBe(false);
        expect(boxFor('Beta').checked).toBe(true);
        expect(screen.getByText('1 of 2 selected')).toBeInTheDocument();
    });
});
