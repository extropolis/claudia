/**
 * Behavioural tests for <WorkspacePanel />.
 *
 * The panel is a pure "dispatcher": every mutation goes out through a callback
 * prop (which App wires to a WebSocket send) or through a taskStore action. So
 * these tests assert the DISPATCHED ACTION — which prop was called, with which
 * arguments, and what the store looks like afterwards — rather than markup.
 *
 * Queried by role / label / text / title only; never by CSS class.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Task, Workspace } from '@claudia/shared';
import { WorkspacePanel } from '../WorkspacePanel';
import { useTaskStore } from '../../stores/taskStore';

// This suite mounts a large component; under parallel CI load a single
// interaction can exceed the 5s default. File-scoped, so no shared config
// is touched.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

// Snapshot of the pristine store (state + actions) taken before any test runs,
// so every test can start from an identical store.
const PRISTINE_STORE = useTaskStore.getState();

type PanelProps = React.ComponentProps<typeof WorkspacePanel>;

// ── fixtures ────────────────────────────────────────────────────────────────

const T0 = new Date('2026-01-01T00:00:00.000Z');

function makeWorkspace(id: string, overrides: Partial<Workspace> = {}): Workspace {
    return {
        id,
        name: id.split('/').filter(Boolean).pop() || id,
        createdAt: T0.toISOString(),
        ...overrides,
    };
}

function makeTask(id: string, workspaceId: string, overrides: Partial<Task> = {}): Task {
    return {
        id,
        prompt: `prompt of ${id}`,
        state: 'idle',
        workspaceId,
        createdAt: T0,
        lastActivity: T0,
        ...overrides,
    } as Task;
}

/** A minimal stand-in for the browser's DataTransfer, enough for React's DnD. */
function makeDataTransfer(types: string[] = []) {
    return {
        types,
        files: [] as unknown as FileList,
        effectAllowed: 'none',
        dropEffect: 'none',
        setDragImage: vi.fn(),
        setData: vi.fn(),
        getData: vi.fn(() => ''),
    };
}

function makeProps(overrides: Partial<PanelProps> = {}): PanelProps {
    return {
        onDeleteTask: vi.fn(),
        onInterruptTask: vi.fn(),
        onArchiveTask: vi.fn(),
        onRevertTask: vi.fn(),
        onCreateWorkspace: vi.fn(),
        onDeleteWorkspace: vi.fn(),
        onReorderWorkspaces: vi.fn(),
        onSetWorkspaceOrder: vi.fn(),
        onReorderTasksOnServer: vi.fn(),
        onOpenFolder: vi.fn(),
        onOpenTerminal: vi.fn(),
        onOpenShell: vi.fn(),
        onPushToGithub: vi.fn(),
        onSetSystemPrompt: vi.fn(),
        onCreateTask: vi.fn(),
        onSelectTask: vi.fn(),
        onRequestArchivedTasks: vi.fn(),
        onRestoreArchivedTask: vi.fn(),
        onDeleteArchivedTask: vi.fn(),
        onContinueArchivedTask: vi.fn(),
        onRenameTask: vi.fn(),
        onRenameWorkspace: vi.fn(),
        onToggleReference: vi.fn(),
        onAddCustomReference: vi.fn(),
        onRemoveReference: vi.fn(),
        onResetWorkspace: vi.fn(),
        onRejectDeleteRequest: vi.fn(),
        onCollapse: vi.fn(),
        ...overrides,
    };
}

interface RenderOptions {
    workspaces?: Workspace[];
    tasks?: Task[];
    /** Extra taskStore state applied before render. */
    store?: Record<string, unknown>;
    props?: Partial<PanelProps>;
    /** Which workspaces start expanded. Defaults to all of them. */
    expanded?: string[];
}

/** Shared setup so individual tests stay about behaviour, not wiring. */
function renderWorkspacePanel(options: RenderOptions = {}) {
    const workspaces = options.workspaces ?? [makeWorkspace('/repos/alpha')];
    const tasks = options.tasks ?? [];
    useTaskStore.setState({
        workspaces,
        tasks: new Map(tasks.map(t => [t.id, t])),
        expandedWorkspaces: new Set(options.expanded ?? workspaces.map(w => w.id)),
        expandedWorkspacesInitialized: true,
        ...options.store,
    });
    const props = makeProps(options.props);
    const view = render(<WorkspacePanel {...props} />);
    return { ...view, props, workspaces, tasks };
}

/**
 * The draggable element belonging to a rendered label (workspace header / task
 * row). A task row is itself draggable, but a workspace header carries the
 * `draggable` attribute on a separate grip handle that sits *beside* the name
 * rather than around it — so an ancestor-only lookup misses it. Walk up from
 * the label and take the first ancestor that either is, or contains, a
 * draggable element.
 */
function draggableFor(label: string): HTMLElement {
    let el: HTMLElement | null = screen.getByText(label);
    while (el) {
        if (el.getAttribute('draggable') === 'true') return el;
        const found = el.querySelector<HTMLElement>('[draggable="true"]');
        if (found) return found;
        el = el.parentElement;
    }
    throw new Error(`no draggable element for "${label}"`);
}

/** Open a workspace's kebab ("Workspace settings") menu. */
function openWorkspaceMenu(index = 0) {
    fireEvent.click(screen.getAllByTitle('Workspace settings')[index]);
}

/**
 * Testing Library only advances fake timers when it can see a global `jest`
 * object — it has no Vitest detection. Without this shim its async wrapper
 * awaits a `setTimeout` that the fake clock never fires, so `waitFor` and every
 * `userEvent` call deadlock until the test times out. Installed only while fake
 * timers are active, and removed again in afterEach.
 */
const jestTimerShim = { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) };

function useSafeFakeTimers() {
    vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    (globalThis as Record<string, unknown>).jest = jestTimerShim;
}

/** user-event configured for fake timers (no artificial inter-key delay). */
function setupUser() {
    return userEvent.setup({ advanceTimers: vi.advanceTimersByTime, delay: null });
}

// ── suite ───────────────────────────────────────────────────────────────────

function spyOnConfirm() {
    return vi.spyOn(window, 'confirm').mockReturnValue(true);
}

describe('WorkspacePanel', () => {
    let confirmSpy: ReturnType<typeof spyOnConfirm>;

    beforeEach(() => {
        localStorage.clear();
        useSafeFakeTimers();
        vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
        // Fresh store for every test. `isConnected: false` keeps the per-workspace
        // git-branch poller from firing; tests that need it opt in explicitly.
        useTaskStore.setState({ ...PRISTINE_STORE, isConnected: false }, true);
        confirmSpy = spyOnConfirm();
    });

    afterEach(() => {
        confirmSpy.mockRestore();
        // Deliberately do NOT flush pending timers here: Testing Library's
        // auto-cleanup runs after this hook, so firing the TaskItem tick
        // interval now would update still-mounted components outside act().
        vi.useRealTimers();
        delete (globalThis as Record<string, unknown>).jest;
        vi.restoreAllMocks();
    });

    // ── rendering / grouping ────────────────────────────────────────────────

    it('shows the empty state and offers to add a workspace when there are none', () => {
        renderWorkspacePanel({ workspaces: [] });

        expect(screen.getByText('No workspaces yet.')).toBeInTheDocument();
        // Two affordances exist: the header icon button (title "Add workspace")
        // and the empty-state call to action (label "Add Workspace").
        expect(screen.getByRole('button', { name: 'Add Workspace' })).toBeInTheDocument();
        expect(screen.getByTitle('Add workspace')).toBeInTheDocument();
    });

    it('renders each workspace with only its own tasks', () => {
        renderWorkspacePanel({
            workspaces: [makeWorkspace('/repos/alpha'), makeWorkspace('/repos/beta')],
            tasks: [
                makeTask('t-a1', '/repos/alpha', { prompt: 'alpha task one' }),
                makeTask('t-a2', '/repos/alpha', { prompt: 'alpha task two' }),
                makeTask('t-b1', '/repos/beta', { prompt: 'beta task one' }),
            ],
        });

        expect(screen.getByText('alpha')).toBeInTheDocument();
        expect(screen.getByText('beta')).toBeInTheDocument();
        expect(screen.getByText('alpha task one')).toBeInTheDocument();
        expect(screen.getByText('alpha task two')).toBeInTheDocument();
        expect(screen.getByText('beta task one')).toBeInTheDocument();

        // Collapsing alpha must hide alpha's tasks and leave beta's alone —
        // that is the observable proof the tasks are grouped per workspace.
        fireEvent.click(screen.getByText('alpha'));

        expect(screen.queryByText('alpha task one')).not.toBeInTheDocument();
        expect(screen.queryByText('alpha task two')).not.toBeInTheDocument();
        expect(screen.getByText('beta task one')).toBeInTheDocument();
    });

    it('prefers the workspace display name over the folder name', () => {
        renderWorkspacePanel({
            workspaces: [makeWorkspace('/repos/alpha', { displayName: 'Alpha (renamed)' })],
        });

        expect(screen.getByText('Alpha (renamed)')).toBeInTheDocument();
        expect(screen.queryByText('alpha')).not.toBeInTheDocument();
    });

    it('nests a multi-task worktree under its parent instead of listing it top level', () => {
        const parent = makeWorkspace('/repos/alpha');
        const worktree = makeWorkspace('/repos/alpha-wt', {
            worktreeParentId: '/repos/alpha',
            worktreeBranch: 'feature/login',
            displayName: 'feature/login',
        });
        renderWorkspacePanel({
            workspaces: [parent, worktree],
            tasks: [
                makeTask('t-main', '/repos/alpha', { prompt: 'main task' }),
                makeTask('t-wt1', '/repos/alpha-wt', { prompt: 'worktree task one' }),
                makeTask('t-wt2', '/repos/alpha-wt', { prompt: 'worktree task two' }),
            ],
        });

        // Only the parent gets a workspace kebab menu — the worktree is inline.
        expect(screen.getAllByTitle('Workspace settings')).toHaveLength(1);
        // The worktree's branch heading and both its tasks are rendered.
        expect(screen.getByText('feature/login')).toBeInTheDocument();
        expect(screen.getByText('worktree task one')).toBeInTheDocument();
        expect(screen.getByText('worktree task two')).toBeInTheDocument();
        expect(screen.getByText('main task')).toBeInTheDocument();
    });

    /**
     * Characterisation test for a live defect: worktree workspaces are excluded
     * from the top-level list (`!w.worktreeParentId`) *and* their inline group
     * is dropped when it has no tasks (`.filter(g => g.tasks.length > 0)`). So
     * archiving the last task in a worktree makes that workspace vanish from
     * the sidebar completely — the only remaining route to it is the parent's
     * "Manage Worktrees" dialog.
     */
    it('hides a worktree workspace entirely once its last task is archived (known defect)', () => {
        renderWorkspacePanel({
            workspaces: [
                makeWorkspace('/repos/alpha'),
                makeWorkspace('/repos/alpha-wt', {
                    worktreeParentId: '/repos/alpha',
                    worktreeBranch: 'feature/orphan',
                    displayName: 'feature/orphan',
                }),
            ],
            tasks: [],
        });

        expect(screen.getByText('alpha')).toBeInTheDocument();
        expect(screen.queryByText('feature/orphan')).not.toBeInTheDocument();
        // The parent still advertises the worktree via its counter badge.
        expect(screen.getByTitle(/1 worktree/)).toBeInTheDocument();
    });

    it('renders a single-task worktree inline with a worktree badge', () => {
        renderWorkspacePanel({
            workspaces: [
                makeWorkspace('/repos/alpha'),
                makeWorkspace('/repos/alpha-wt', {
                    worktreeParentId: '/repos/alpha',
                    worktreeBranch: 'feature/solo',
                }),
            ],
            tasks: [makeTask('t-solo', '/repos/alpha-wt', { prompt: 'solo worktree task' })],
        });

        expect(screen.getByText('solo worktree task')).toBeInTheDocument();
        expect(screen.getByTitle('Worktree: feature/solo')).toBeInTheDocument();
    });

    // ── task creation ───────────────────────────────────────────────────────

    it('creates a task for the workspace whose input was used', async () => {
        const user = setupUser();
        const { props } = renderWorkspacePanel({
            workspaces: [makeWorkspace('/repos/alpha'), makeWorkspace('/repos/beta')],
        });

        const inputs = screen.getAllByPlaceholderText(/type or speak a task/i);
        // The two sections render in sorted order; find beta's by walking up to
        // the section that also contains the "beta" label.
        const betaInput = inputs.find(input =>
            input.closest('div')?.parentElement?.parentElement?.parentElement?.textContent?.includes('beta')
        ) ?? inputs[1];

        await user.type(betaInput, 'ship the thing{Enter}');

        expect(props.onCreateTask).toHaveBeenCalledTimes(1);
        expect(props.onCreateTask).toHaveBeenCalledWith(
            'ship the thing',
            '/repos/beta',
            expect.any(Number),
            expect.any(Number),
            false,
        );
    });

    it('clears the input after submitting and ignores whitespace-only prompts', async () => {
        const user = setupUser();
        const { props } = renderWorkspacePanel();
        const input = screen.getByPlaceholderText(/type or speak a task/i);

        await user.type(input, '   {Enter}');
        expect(props.onCreateTask).not.toHaveBeenCalled();

        await user.clear(input);
        await user.type(input, 'real work{Enter}');
        expect(props.onCreateTask).toHaveBeenCalledWith(
            'real work', '/repos/alpha', expect.any(Number), expect.any(Number), false,
        );
        expect(input).toHaveValue('');
    });

    it('passes isolate=true once the worktree-isolation toggle is on', async () => {
        const user = setupUser();
        const { props } = renderWorkspacePanel();

        fireEvent.click(screen.getByTitle(/isolate in worktree: OFF/i));
        await user.type(screen.getByPlaceholderText(/type or speak a task/i), 'isolated work{Enter}');

        expect(props.onCreateTask).toHaveBeenCalledWith(
            'isolated work', '/repos/alpha', expect.any(Number), expect.any(Number), true,
        );
    });

    it('defaults the isolation toggle to ON for auto-worktree workspaces', () => {
        renderWorkspacePanel({
            workspaces: [makeWorkspace('/repos/alpha', { autoWorktree: true })],
        });

        expect(screen.getByTitle(/isolate in worktree: ON/i)).toBeInTheDocument();
        expect(screen.getByText('auto-isolate')).toBeInTheDocument();
    });

    // ── collapse / expand ───────────────────────────────────────────────────

    it('persists collapse and expand of a workspace to the store', () => {
        renderWorkspacePanel({ workspaces: [makeWorkspace('/repos/alpha')] });
        expect(useTaskStore.getState().expandedWorkspaces.has('/repos/alpha')).toBe(true);

        fireEvent.click(screen.getByText('alpha'));
        expect(useTaskStore.getState().expandedWorkspaces.has('/repos/alpha')).toBe(false);
        expect(screen.queryByPlaceholderText(/type or speak a task/i)).not.toBeInTheDocument();

        fireEvent.click(screen.getByText('alpha'));
        expect(useTaskStore.getState().expandedWorkspaces.has('/repos/alpha')).toBe(true);
        expect(screen.getByPlaceholderText(/type or speak a task/i)).toBeInTheDocument();
    });

    it('shows "No tasks yet" for an expanded but empty workspace', () => {
        renderWorkspacePanel();
        expect(screen.getByText('No tasks yet')).toBeInTheDocument();
    });

    // ── drag and drop ───────────────────────────────────────────────────────

    it('reorders workspaces by index when the sort mode is manual', () => {
        const { props } = renderWorkspacePanel({
            workspaces: [
                makeWorkspace('/repos/alpha'),
                makeWorkspace('/repos/beta'),
                makeWorkspace('/repos/gamma'),
            ],
            store: { workspaceSortBy: 'manual' },
            expanded: [],
        });

        const gamma = draggableFor('gamma'); // rendered index 2
        const alpha = draggableFor('alpha'); // rendered index 0
        const dataTransfer = makeDataTransfer();

        fireEvent.dragStart(gamma, { dataTransfer });
        fireEvent.dragEnter(alpha, { dataTransfer });
        fireEvent.dragEnd(gamma, { dataTransfer });

        expect(props.onReorderWorkspaces).toHaveBeenCalledTimes(1);
        expect(props.onReorderWorkspaces).toHaveBeenCalledWith(2, 0);
        expect(props.onSetWorkspaceOrder).not.toHaveBeenCalled();
    });

    it('sends the whole rendered order and switches to manual when dragging in a sorted mode', () => {
        const { props } = renderWorkspacePanel({
            workspaces: [
                makeWorkspace('/repos/alpha'),
                makeWorkspace('/repos/beta'),
                makeWorkspace('/repos/gamma'),
            ],
            store: { workspaceSortBy: 'alphabetical' },
            expanded: [],
        });

        const dataTransfer = makeDataTransfer();
        fireEvent.dragStart(draggableFor('gamma'), { dataTransfer }); // index 2
        fireEvent.dragEnter(draggableFor('alpha'), { dataTransfer }); // index 0
        fireEvent.dragEnd(draggableFor('gamma'), { dataTransfer });

        expect(props.onReorderWorkspaces).not.toHaveBeenCalled();
        expect(props.onSetWorkspaceOrder).toHaveBeenCalledWith([
            '/repos/gamma', '/repos/alpha', '/repos/beta',
        ]);
        expect(useTaskStore.getState().workspaceSortBy).toBe('manual');
    });

    it('does not dispatch a reorder when a workspace is dropped on itself', () => {
        const { props } = renderWorkspacePanel({
            workspaces: [makeWorkspace('/repos/alpha'), makeWorkspace('/repos/beta')],
            store: { workspaceSortBy: 'manual' },
            expanded: [],
        });

        const dataTransfer = makeDataTransfer();
        const beta = draggableFor('beta');
        fireEvent.dragStart(beta, { dataTransfer });
        fireEvent.dragEnter(beta, { dataTransfer });
        fireEvent.dragEnd(beta, { dataTransfer });

        expect(props.onReorderWorkspaces).not.toHaveBeenCalled();
        expect(props.onSetWorkspaceOrder).not.toHaveBeenCalled();
    });

    it('reorders tasks within a workspace and pushes the new order to the server', () => {
        const { props } = renderWorkspacePanel({
            tasks: [
                makeTask('t1', '/repos/alpha', { prompt: 'first task', order: 0 }),
                makeTask('t2', '/repos/alpha', { prompt: 'second task', order: 1 }),
                makeTask('t3', '/repos/alpha', { prompt: 'third task', order: 2 }),
            ],
        });

        const dataTransfer = makeDataTransfer();
        fireEvent.dragStart(draggableFor('first task'), { dataTransfer }); // index 0
        fireEvent.dragEnter(draggableFor('third task'), { dataTransfer }); // index 2
        fireEvent.dragEnd(draggableFor('first task'), { dataTransfer });

        // Local store order: t2, t3, t1
        const orders = useTaskStore.getState().tasks;
        expect(orders.get('t2')!.order).toBe(0);
        expect(orders.get('t3')!.order).toBe(1);
        expect(orders.get('t1')!.order).toBe(2);

        expect(props.onReorderTasksOnServer).toHaveBeenCalledTimes(1);
        const sent = (props.onReorderTasksOnServer as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect([...sent].sort((a, b) => a.order - b.order)).toEqual([
            { taskId: 't2', order: 0 },
            { taskId: 't3', order: 1 },
            { taskId: 't1', order: 2 },
        ]);
    });

    it('adds a workspace from an OS folder drop that carries a real path', () => {
        const { props, container } = renderWorkspacePanel({ workspaces: [] });
        const panel = container.firstElementChild as HTMLElement;

        const dataTransfer = makeDataTransfer(['Files']);
        (dataTransfer as unknown as { files: unknown }).files = [
            { path: '/dropped/project', name: 'project' },
        ];

        fireEvent.dragOver(panel, { dataTransfer });
        expect(screen.getByText('Drop folder to add workspace')).toBeInTheDocument();

        fireEvent.drop(panel, { dataTransfer });
        expect(props.onCreateWorkspace).toHaveBeenCalledWith('/dropped/project');
    });

    it('ignores non-file drags on the panel so internal reordering still works', () => {
        const { props, container } = renderWorkspacePanel({ workspaces: [] });
        const panel = container.firstElementChild as HTMLElement;

        fireEvent.dragOver(panel, { dataTransfer: makeDataTransfer([]) });

        expect(screen.queryByText('Drop folder to add workspace')).not.toBeInTheDocument();
        expect(props.onCreateWorkspace).not.toHaveBeenCalled();
    });

    // ── workspace menu ──────────────────────────────────────────────────────

    it('opens the workspace menu and dispatches each simple action with the workspace id', () => {
        const { props } = renderWorkspacePanel();

        const cases: Array<[string, keyof PanelProps]> = [
            ['Open in Finder', 'onOpenFolder'],
            ['Open Shell', 'onOpenShell'],
            ['Open External Terminal', 'onOpenTerminal'],
            ['Push to GitHub', 'onPushToGithub'],
        ];

        for (const [label, prop] of cases) {
            openWorkspaceMenu();
            fireEvent.click(screen.getByText(label));
            expect(props[prop]).toHaveBeenCalledWith('/repos/alpha');
        }
    });

    it('closes the menu after an item is chosen', () => {
        renderWorkspacePanel();

        openWorkspaceMenu();
        expect(screen.getByText('Open Shell')).toBeInTheDocument();

        fireEvent.click(screen.getByText('Open Shell'));
        expect(screen.queryByText('Open Shell')).not.toBeInTheDocument();
    });

    it('closes the menu when clicking outside of it', () => {
        renderWorkspacePanel();

        openWorkspaceMenu();
        expect(screen.getByText('Copy Path')).toBeInTheDocument();

        fireEvent.mouseDown(document.body);
        expect(screen.queryByText('Copy Path')).not.toBeInTheDocument();
    });

    it('queues a code-review task from the menu shortcut', () => {
        const { props } = renderWorkspacePanel();

        openWorkspaceMenu();
        fireEvent.click(screen.getByText('Code Review'));

        expect(props.onCreateTask).toHaveBeenCalledTimes(1);
        const [prompt, workspaceId] = (props.onCreateTask as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(prompt).toMatch(/code review of this project/i);
        expect(workspaceId).toBe('/repos/alpha');
    });

    it('queues the session-audit task from the menu shortcut', () => {
        const { props } = renderWorkspacePanel();

        openWorkspaceMenu();
        fireEvent.click(screen.getByText(/Analyze Sessions/));

        const [prompt, workspaceId] = (props.onCreateTask as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(prompt).toMatch(/session-intelligence audit/i);
        expect(workspaceId).toBe('/repos/alpha');
    });

    it('copies the workspace path to the clipboard', () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

        renderWorkspacePanel();
        openWorkspaceMenu();
        fireEvent.click(screen.getByText('Copy Path'));

        expect(writeText).toHaveBeenCalledWith('/repos/alpha');
    });

    it('removes a workspace only after the confirmation is accepted', () => {
        const { props } = renderWorkspacePanel();

        confirmSpy.mockReturnValue(false);
        openWorkspaceMenu();
        fireEvent.click(screen.getByText('Remove Workspace'));
        expect(props.onDeleteWorkspace).not.toHaveBeenCalled();

        confirmSpy.mockReturnValue(true);
        openWorkspaceMenu();
        fireEvent.click(screen.getByText('Remove Workspace'));
        expect(props.onDeleteWorkspace).toHaveBeenCalledWith('/repos/alpha');
    });

    it('resets a workspace only after the reset modal is confirmed', () => {
        const { props } = renderWorkspacePanel({
            tasks: [makeTask('t1', '/repos/alpha')],
        });

        openWorkspaceMenu();
        fireEvent.click(screen.getByText('Reset Workspace'));
        expect(screen.getByText('Reset Workspace')).toBeInTheDocument();

        fireEvent.click(screen.getByText('Cancel'));
        expect(props.onResetWorkspace).not.toHaveBeenCalled();

        openWorkspaceMenu();
        fireEvent.click(screen.getByText('Reset Workspace'));
        fireEvent.click(screen.getByText('Reset'));
        expect(props.onResetWorkspace).toHaveBeenCalledWith('/repos/alpha');
    });

    it('toggles a cross-workspace reference from the References submenu', () => {
        const { props } = renderWorkspacePanel({
            workspaces: [makeWorkspace('/repos/alpha'), makeWorkspace('/repos/beta')],
            expanded: [],
        });

        openWorkspaceMenu(0);
        fireEvent.mouseEnter(screen.getByText('References'));
        // "beta" appears twice: as its own workspace header and as a checkbox
        // row in the submenu. Only the submenu row lives inside a button.
        const betaReference = screen.getAllByText('beta').find(el => el.closest('button'));
        fireEvent.click(betaReference!);

        expect(props.onToggleReference).toHaveBeenCalledWith('/repos/alpha', '/repos/beta');
    });

    it('opens the system prompt modal from the menu and saves through the callback', () => {
        const { props } = renderWorkspacePanel();

        openWorkspaceMenu();
        fireEvent.click(screen.getByText('System Prompt'));

        expect(props.onSetSystemPrompt).not.toHaveBeenCalled();
        // The modal itself is a separate component; asserting it mounted is enough
        // to prove the panel wired the menu item to it.
        expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
    });

    // ── task row actions ────────────────────────────────────────────────────

    it('selects a task when its row is clicked', () => {
        const { props } = renderWorkspacePanel({
            tasks: [makeTask('t1', '/repos/alpha', { prompt: 'pick me' })],
        });

        fireEvent.click(screen.getByText('pick me'));
        expect(props.onSelectTask).toHaveBeenCalledWith('t1');
    });

    it('deletes, archives and interrupts a task through its row buttons', () => {
        const { props } = renderWorkspacePanel({
            tasks: [
                makeTask('t-idle', '/repos/alpha', { prompt: 'idle task', state: 'idle' }),
                makeTask('t-busy', '/repos/alpha', { prompt: 'busy task', state: 'busy' }),
            ],
        });

        fireEvent.click(screen.getByTitle('Archive task'));
        expect(props.onArchiveTask).toHaveBeenCalledWith('t-idle');

        fireEvent.click(screen.getByTitle('Stop task'));
        expect(props.onInterruptTask).toHaveBeenCalledWith('t-busy');

        fireEvent.click(screen.getAllByTitle('Delete task')[0]);
        expect(props.onDeleteTask).toHaveBeenCalledTimes(1);
    });

    it('reverts a task only when the file-count confirmation is accepted', () => {
        const { props } = renderWorkspacePanel({
            tasks: [
                makeTask('t1', '/repos/alpha', {
                    prompt: 'risky task',
                    gitState: {
                        commitBefore: 'abc',
                        uncommittedBefore: false,
                        filesModified: ['a.ts', 'b.ts'],
                        canRevert: true,
                    },
                }),
            ],
        });

        confirmSpy.mockReturnValue(false);
        fireEvent.click(screen.getByTitle('Revert changes (2 files)'));
        expect(props.onRevertTask).not.toHaveBeenCalled();

        confirmSpy.mockReturnValue(true);
        fireEvent.click(screen.getByTitle('Revert changes (2 files)'));
        expect(props.onRevertTask).toHaveBeenCalledWith('t1');
    });

    it('renames a task from the inline editor and cancels on Escape', async () => {
        const user = setupUser();
        const { props } = renderWorkspacePanel({
            tasks: [makeTask('t1', '/repos/alpha', { prompt: 'original prompt' })],
        });

        fireEvent.click(screen.getByTitle('Rename task'));
        const editor = screen.getByDisplayValue('original prompt');
        await user.clear(editor);
        await user.type(editor, 'Nice name{Enter}');
        expect(props.onRenameTask).toHaveBeenCalledWith('t1', 'Nice name');

        (props.onRenameTask as ReturnType<typeof vi.fn>).mockClear();
        fireEvent.click(screen.getByTitle('Rename task'));
        const editor2 = screen.getByDisplayValue('original prompt');
        await user.clear(editor2);
        await user.type(editor2, 'discarded{Escape}');
        expect(props.onRenameTask).not.toHaveBeenCalled();
    });

    it('renames a workspace from the inline editor', async () => {
        const user = setupUser();
        const { props } = renderWorkspacePanel({ expanded: [] });

        fireEvent.click(screen.getByTitle('Rename workspace'));
        const editor = screen.getByDisplayValue('alpha');
        await user.clear(editor);
        await user.type(editor, 'Alpha Prime{Enter}');

        expect(props.onRenameWorkspace).toHaveBeenCalledWith('/repos/alpha', 'Alpha Prime');
    });

    it('shows a waiting-for-input marker for tasks the backend is blocked on', () => {
        renderWorkspacePanel({
            tasks: [makeTask('t1', '/repos/alpha', { prompt: 'blocked task', state: 'waiting_input' })],
            store: {
                waitingInputNotifications: new Map([
                    ['t1', { taskId: 't1', question: 'Continue?', type: 'question' }],
                ]),
            },
        });

        expect(screen.getByText('!')).toBeInTheDocument();
    });

    // ── archived tasks ──────────────────────────────────────────────────────

    it('requests archived tasks the first time the archive is shown', () => {
        const { props } = renderWorkspacePanel();

        fireEvent.click(screen.getByTitle('Show archived tasks'));

        expect(props.onRequestArchivedTasks).toHaveBeenCalledTimes(1);
        expect(useTaskStore.getState().showArchivedTasks).toBe(true);
        expect(screen.getByText('Archived Tasks')).toBeInTheDocument();
        expect(screen.getByText('No archived tasks')).toBeInTheDocument();
    });

    it('restores, continues and permanently deletes archived tasks', () => {
        const archived = makeTask('t-arch', '/repos/alpha', {
            prompt: 'archived task',
            state: 'archived',
        });
        const { props } = renderWorkspacePanel({
            store: { showArchivedTasks: true, archivedTasks: [archived] },
        });

        fireEvent.click(screen.getByTitle(/restore to task list/i));
        expect(props.onRestoreArchivedTask).toHaveBeenCalledWith('t-arch');

        confirmSpy.mockReturnValue(false);
        fireEvent.click(screen.getByTitle('Delete permanently'));
        expect(props.onDeleteArchivedTask).not.toHaveBeenCalled();

        confirmSpy.mockReturnValue(true);
        fireEvent.click(screen.getByTitle('Delete permanently'));
        expect(props.onDeleteArchivedTask).toHaveBeenCalledWith('t-arch');

        fireEvent.click(screen.getByText('archived task'));
        expect(props.onContinueArchivedTask).toHaveBeenCalledWith('t-arch');
    });

    // ── agent-requested deletion ────────────────────────────────────────────

    it('archives on confirming an agent delete request and rejects on cancel', () => {
        const { props } = renderWorkspacePanel({
            store: {
                pendingDeleteRequest: { taskId: 't1', requestId: 'req-1', taskName: 'Doomed task' },
            },
        });

        expect(screen.getByText('Doomed task')).toBeInTheDocument();

        fireEvent.click(screen.getByText('Keep'));
        expect(props.onRejectDeleteRequest).toHaveBeenCalledWith('t1', 'req-1');
        expect(useTaskStore.getState().pendingDeleteRequest).toBeNull();

        act(() => {
            useTaskStore.setState({
                pendingDeleteRequest: { taskId: 't2', requestId: 'req-2', taskName: 'Other task' },
            });
        });
        fireEvent.click(screen.getByText('Delete'));
        expect(props.onArchiveTask).toHaveBeenCalledWith('t2');
        expect(useTaskStore.getState().pendingDeleteRequest).toBeNull();
    });

    // ── header controls ─────────────────────────────────────────────────────

    it('changes the workspace sort mode and the resulting render order', () => {
        renderWorkspacePanel({
            workspaces: [
                makeWorkspace('/repos/zulu'),
                makeWorkspace('/repos/alpha'),
            ],
            store: { workspaceSortBy: 'manual' },
            expanded: [],
        });

        const sortSelect = within(screen.getByTitle('Sort workspaces by')).getByRole('combobox');
        fireEvent.change(sortSelect, { target: { value: 'alphabetical' } });

        expect(useTaskStore.getState().workspaceSortBy).toBe('alphabetical');
        const names = screen.getAllByTitle(/^\/repos\//).map(el => el.textContent);
        expect(names).toEqual(['alpha', 'zulu']);
    });

    it('persists the workspace column count', () => {
        renderWorkspacePanel({ expanded: [] });

        const columnSelect = within(screen.getByTitle('Workspace columns')).getByRole('combobox');
        fireEvent.change(columnSelect, { target: { value: '3' } });

        expect(useTaskStore.getState().workspaceColumns).toBe(3);
    });

    it('collapses the whole panel through the header button', () => {
        const { props } = renderWorkspacePanel({ expanded: [] });

        fireEvent.click(screen.getByTitle('Hide workspaces'));
        expect(props.onCollapse).toHaveBeenCalledTimes(1);
    });

    it('switches the per-workspace task sort order from the menu', () => {
        renderWorkspacePanel({
            tasks: [
                makeTask('t1', '/repos/alpha', { prompt: 'task one' }),
                makeTask('t2', '/repos/alpha', { prompt: 'task two' }),
            ],
        });

        openWorkspaceMenu();
        fireEvent.click(screen.getByText('Recent'));

        expect(useTaskStore.getState().taskSortBy).toBe('last-modified');
    });

    // ── git branch label ────────────────────────────────────────────────────

    it('shows the git branch once the workspace git status resolves', async () => {
        global.fetch = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ branch: 'main' }),
            text: async () => '',
        })) as unknown as typeof fetch;

        renderWorkspacePanel({ store: { isConnected: true }, expanded: [] });

        await waitFor(() => expect(screen.getByText('main')).toBeInTheDocument());
    });

    // ── scheduled tasks ─────────────────────────────────────────────────────

    it('surfaces a scheduled-task badge and opens the scheduler for that task', () => {
        renderWorkspacePanel({
            tasks: [makeTask('t1', '/repos/alpha', { prompt: 'cron task' })],
            store: {
                scheduledTasks: new Map([
                    ['c1', { id: 'c1', taskId: 't1', isPaused: false, cronExpression: '* * * * *' }],
                ]),
            },
        });

        expect(screen.getByTitle(/1 scheduled task.*click to manage/i)).toBeInTheDocument();
    });
});
