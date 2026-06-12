# Git Worktree Support in Claudia

**Status**: Draft
**Author**: Claude
**Date**: 2026-04-22

---

## Executive Summary

Git worktrees let you check out multiple branches of the same repo into separate directories simultaneously. This is a natural fit for Claudia's multi-agent model — today, if you spawn 3 tasks in one workspace, they all compete over the same branch and working tree. With worktree support, each task can operate on its own branch in its own directory, with full git isolation, zero conflicts, and clean merges.

This plan designs worktree support **from the user's experience inward**, ensuring the feature feels like a natural extension of Claudia rather than a bolted-on git power tool.

---

## 1. The Problem

### What breaks today without worktrees

| Scenario | What happens | Impact |
|----------|-------------|--------|
| Two tasks edit files in same workspace | Race conditions, overwritten changes | Lost work |
| Task A commits while Task B is mid-edit | Dirty working tree blocks Task B's commit | Task failure |
| User wants to review PR while feature task runs | Must wait or manually stash | Productivity loss |
| User wants parallel feature branches | Must create separate clones | Disk waste, no shared objects |

### Why worktrees (not clones)

- **Shared `.git` object store** — no duplicate downloads, instant creation
- **Branch locking** — git prevents two worktrees from checking out the same branch (safety)
- **First-class git concept** — `git worktree add/remove/list/prune` are built-in
- **Claude Code already supports them** — Claude's `/worktree` command creates worktrees natively

---

## 2. User Experience Design

### 2.1 Core UX Principle

> *"Worktrees are workspaces that know they're siblings."*

A worktree appears as a regular workspace in Claudia's sidebar, but with visual cues linking it to its parent repo. Users who don't know git worktrees can still use them — they just see "isolated branch workspaces."

### 2.2 User Flows

#### Flow A: Create a worktree from workspace menu

```
User right-clicks workspace "my-app" (on branch main)
  -> Menu: "New Worktree..."
  -> Modal:
      Branch name: [feature/auth      ]  <- auto-prefixed, autocomplete from remote
      Base branch: [main v]              <- dropdown: main, develop, etc.
      [ ] Start from clean state (no uncommitted changes)
      [Create Worktree]
  -> New workspace appears: "my-app > feature/auth"
  -> User creates tasks in it normally
```

#### Flow B: Auto-worktree on task creation (opt-in)

```
Workspace "my-app" has setting: "Isolate tasks in worktrees" [toggle]
User creates task: "Add OAuth login"
  -> Claudia auto-creates worktree: .claudia-worktrees/my-app/task-{short-id}/
  -> Branch: claudia/task-{short-id} (auto-named)
  -> Task runs in isolated worktree
  -> When task completes + user archives -> offer to merge/delete worktree
```

#### Flow C: Quick branch-switch via worktree

```
User clicks branch badge "main" on workspace
  -> Popover shows:
      Current: main
      ----------
      Worktrees:
        feature/auth  (2 tasks)  [Open]
        fix/typo      (0 tasks)  [Open] [trash]
      ----------
      [+ New Worktree]
      [Manage Worktrees...]
```

#### Flow D: Worktree cleanup

```
User clicks "Manage Worktrees..." or right-click -> "Worktrees"
  -> Panel shows all worktrees for this repo:
      +----------------------------------------------+
      | Worktrees for my-app                          |
      |                                               |
      | DIR main (primary)           /code/my-app     |
      |    3 tasks - active                           |
      |                                               |
      | BRANCH feature/auth     .claudia-worktrees/   |
      |    2 tasks - last active 2h ago    [Remove]   |
      |                                               |
      | BRANCH fix/typo         .claudia-worktrees/   |
      |    0 tasks - stale              [Remove]      |
      |                                               |
      | WARNING 1 orphaned worktree    [Prune All]    |
      +----------------------------------------------+
```

### 2.3 Visual Design in Sidebar

```
+-- Workspaces --------------------+
|                                   |
| v DIR my-app          main  (3)   |  <- parent repo
|   +- Task: Fix login bug         |
|   +- Task: Update deps           |
|                                   |
| v BRANCH my-app > feature/auth(2)|  <- worktree (badged)
|   +- Task: Add OAuth provider    |
|   +- Task: Write auth tests      |
|                                   |
| > BRANCH my-app > fix/typo  (0)  |  <- collapsed, no tasks
|                                   |
| v DIR other-project  develop (1)  |  <- unrelated workspace
|   +- Task: Refactor API          |
|                                   |
+-----------------------------------+
```

Key visual cues:
- **Branch icon** distinguishes worktrees from regular workspaces
- **"parent > branch"** naming shows the relationship
- **Worktrees grouped near parent** in sidebar (not scattered)
- **Branch badge always visible** (already exists, works naturally)

---

## 3. Data Model Changes

### 3.1 Shared Types (`shared/src/index.ts`)

```typescript
// NEW: Worktree metadata
export interface WorktreeInfo {
    path: string;            // Absolute path to worktree directory
    branch: string;          // Branch checked out in this worktree
    isMain: boolean;         // Is this the primary working tree?
    commitHash: string;      // Current HEAD
    isLocked?: boolean;      // Locked worktrees can't be removed
    lockedReason?: string;   // Why it's locked
    prunable?: boolean;      // Worktree dir deleted but not pruned
    taskCount?: number;      // Number of active Claudia tasks in this worktree
}

// EXTENDED: Workspace gains optional worktree awareness
export interface Workspace {
    id: string;              // Full path (unchanged)
    name: string;            // Folder name (unchanged)
    createdAt: string;
    systemPrompt?: string;
    displayName?: string;
    references?: WorkspaceReference[];

    // NEW: Worktree fields
    worktreeParentId?: string;    // If this workspace IS a worktree, points to parent workspace ID
    worktreeBranch?: string;      // Branch name for this worktree
    autoWorktree?: boolean;       // If true, new tasks auto-create worktrees
    worktreeBasePath?: string;    // Where to create worktrees (default: .claudia-worktrees/)
}
```

### 3.2 WebSocket Messages (new)

```typescript
export type WSMessageType =
    // ... existing ...
    // Worktree management
    | 'worktree:list'           // Request list of worktrees for a workspace
    | 'worktree:listed'         // Response with worktree list
    | 'worktree:create'         // Create a new worktree
    | 'worktree:created'        // Worktree created successfully
    | 'worktree:remove'         // Remove a worktree
    | 'worktree:removed'        // Worktree removed successfully
    | 'worktree:error'          // Error in worktree operation
    | 'worktree:prune'          // Prune stale worktrees
    | 'worktree:pruned'         // Prune completed
```

### 3.3 REST Endpoints (new)

```
GET    /api/workspaces/:id/worktrees          -> List worktrees for repo
POST   /api/workspaces/:id/worktrees          -> Create worktree
DELETE /api/workspaces/:id/worktrees/:branch   -> Remove worktree
POST   /api/workspaces/:id/worktrees/prune     -> Prune orphaned worktrees
```

REST is preferred over WebSocket here because these are request/response operations (not streaming), and REST gives us proper HTTP status codes for error handling.

---

## 4. Backend Implementation

### 4.1 New File: `backend/src/worktree-manager.ts`

Central module for all git worktree operations. Wraps `git worktree` commands with safety checks.

```typescript
export class WorktreeManager {

    // Resolve whether a path is inside a worktree, and find the main repo
    async getWorktreeRoot(cwd: string): Promise<{
        mainWorktree: string;     // Path to primary working tree
        currentWorktree: string;  // Path to cwd's worktree (may equal mainWorktree)
        isWorktree: boolean;      // true if cwd is a linked worktree (not main)
    }>;

    // List all worktrees for a repository
    async listWorktrees(repoPath: string): Promise<WorktreeInfo[]>;

    // Create a new worktree
    async createWorktree(opts: {
        repoPath: string;        // Main repo (or any worktree of it)
        branch: string;          // Branch to create/checkout
        baseBranch?: string;     // Branch to base off (default: current HEAD)
        targetDir?: string;      // Where to put it (default: auto-generated)
        createBranch?: boolean;  // Create new branch (true) or checkout existing (false)
    }): Promise<{ path: string; branch: string }>;

    // Remove a worktree
    async removeWorktree(opts: {
        repoPath: string;
        worktreePath: string;
        force?: boolean;         // Force remove even with changes
    }): Promise<void>;

    // Prune stale worktree references
    async pruneWorktrees(repoPath: string): Promise<string[]>;

    // Lock/unlock a worktree (prevent accidental deletion)
    async lockWorktree(worktreePath: string, reason?: string): Promise<void>;
    async unlockWorktree(worktreePath: string): Promise<void>;

    // Check if a branch is already checked out in any worktree
    async isBranchInWorktree(repoPath: string, branch: string): Promise<string | null>;
}
```

**Key implementation details:**

```typescript
// Parsing `git worktree list --porcelain` output
async listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
    const { stdout } = await execFileAsync('git',
        ['worktree', 'list', '--porcelain'],
        { cwd: repoPath }
    );

    // Output format:
    // worktree /path/to/main
    // HEAD abc123
    // branch refs/heads/main
    //
    // worktree /path/to/feature
    // HEAD def456
    // branch refs/heads/feature
    //

    return parseWorktreeListOutput(stdout);
}
```

**Worktree directory strategy:**

```
# Default location (configurable per workspace):
{repoPath}/.claudia-worktrees/{branch-slug}/

# Example:
/home/user/code/my-app/                                   <- main worktree
/home/user/code/my-app/.claudia-worktrees/feature-auth/    <- linked worktree
/home/user/code/my-app/.claudia-worktrees/fix-typo/        <- linked worktree
```

Add `.claudia-worktrees/` to `.gitignore` automatically on first worktree creation.

### 4.2 Changes to `git-utils.ts`

```typescript
// NEW: Detect if a directory is a linked worktree
export async function isLinkedWorktree(cwd: string): Promise<boolean> {
    try {
        // In a linked worktree, .git is a FILE containing "gitdir: ..."
        // In main worktree, .git is a DIRECTORY
        const gitPath = join(cwd, '.git');
        const stat = await fs.stat(gitPath);
        return stat.isFile(); // file = linked worktree, directory = main
    } catch {
        return false;
    }
}

// NEW: Get the main working tree path from any worktree
export async function getMainWorktreePath(cwd: string): Promise<string> {
    const { stdout } = await execFileAsync('git',
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        { cwd }
    );
    // Returns path to shared .git directory
    // For main worktree: /path/to/repo/.git
    // For linked worktree: /path/to/repo/.git
    // Strip trailing /.git to get main worktree path
    return resolve(stdout.trim().replace(/[\/\\]\.git[\/\\]?$/, ''));
}

// UNCHANGED: getCurrentBranch — works identically in worktrees
// UNCHANGED: getHeadCommit — works identically in worktrees
// UNCHANGED: captureGitStateBefore — works identically (each worktree has own HEAD)
```

### 4.3 Changes to `workspace-store.ts`

```typescript
class WorkspaceStore {
    // NEW: When adding a workspace, detect if it's a worktree
    async addWorkspace(dirPath: string): Promise<Workspace> {
        const resolved = resolve(dirPath);
        // ... existing validation ...

        // Detect worktree status
        let worktreeParentId: string | undefined;
        let worktreeBranch: string | undefined;

        if (await isLinkedWorktree(resolved)) {
            const mainPath = await getMainWorktreePath(resolved);
            worktreeParentId = mainPath; // Points to parent workspace
            worktreeBranch = await getCurrentBranch(resolved) ?? undefined;
        }

        const workspace: Workspace = {
            id: resolved,
            name: basename(resolved),
            createdAt: new Date().toISOString(),
            worktreeParentId,
            worktreeBranch,
        };

        // Auto-set displayName for worktrees: "parent-name > branch"
        if (worktreeParentId) {
            const parentName = this.getWorkspace(worktreeParentId)?.displayName
                ?? basename(worktreeParentId);
            workspace.displayName = `${parentName} > ${worktreeBranch}`;
        }

        this.config.workspaces.push(workspace);
        this.saveConfig();
        return workspace;
    }

    // NEW: Get all worktrees associated with a workspace
    getWorktreeChildren(workspaceId: string): Workspace[] {
        return this.config.workspaces.filter(w => w.worktreeParentId === workspaceId);
    }

    // NEW: Sort workspaces so worktrees appear after their parent
    getSortedWorkspaces(): Workspace[] {
        const result: Workspace[] = [];
        const worktreeMap = new Map<string, Workspace[]>();

        // Group worktrees by parent
        for (const ws of this.config.workspaces) {
            if (ws.worktreeParentId) {
                const children = worktreeMap.get(ws.worktreeParentId) ?? [];
                children.push(ws);
                worktreeMap.set(ws.worktreeParentId, children);
            }
        }

        // Interleave: parent, then its worktrees, then next workspace
        for (const ws of this.config.workspaces) {
            if (!ws.worktreeParentId) {
                result.push(ws);
                const children = worktreeMap.get(ws.id) ?? [];
                result.push(...children);
            }
        }

        return result;
    }

    // NEW: Remove workspace + clean up worktree on disk
    async removeWorktreeWorkspace(workspaceId: string, force = false): Promise<void> {
        const ws = this.getWorkspace(workspaceId);
        if (!ws?.worktreeParentId) throw new Error('Not a worktree workspace');

        // Check for active tasks
        // ... safety checks ...

        // Remove the git worktree
        const manager = new WorktreeManager();
        await manager.removeWorktree({
            repoPath: ws.worktreeParentId,
            worktreePath: ws.id,
            force,
        });

        // Remove from workspace list
        this.deleteWorkspace(workspaceId);
    }
}
```

### 4.4 Changes to `server.ts`

New REST endpoints:

```typescript
// List worktrees for a workspace/repo
app.get('/api/workspaces/:workspaceId/worktrees', async (req, res) => {
    const { workspaceId } = req.params;
    const decodedId = decodeURIComponent(workspaceId);

    try {
        const manager = new WorktreeManager();
        const worktrees = await manager.listWorktrees(decodedId);

        // Enrich with Claudia task counts
        for (const wt of worktrees) {
            wt.taskCount = taskSpawner.getTasksForWorkspace(wt.path).length;
        }

        res.json({ worktrees });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create a worktree
app.post('/api/workspaces/:workspaceId/worktrees', async (req, res) => {
    const { workspaceId } = req.params;
    const { branch, baseBranch, createBranch } = req.body;

    try {
        const manager = new WorktreeManager();
        const result = await manager.createWorktree({
            repoPath: decodeURIComponent(workspaceId),
            branch,
            baseBranch,
            createBranch: createBranch ?? true,
        });

        // Auto-register as workspace
        const workspace = await workspaceStore.addWorkspace(result.path);

        // Broadcast to all clients
        broadcastToAll({
            type: 'workspace:created',
            payload: { workspace }
        });

        res.json({ workspace, worktreePath: result.path });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Remove a worktree
app.delete('/api/workspaces/:workspaceId/worktrees/:branch', async (req, res) => {
    // ... validation, safety checks, removal ...
});
```

New WebSocket message handlers (for real-time UX):

```typescript
case 'worktree:create': {
    // Same logic as REST POST, but via WebSocket for live feedback
    const { workspaceId, branch, baseBranch } = payload;
    // ... create worktree, register workspace, broadcast ...
}

case 'worktree:remove': {
    // Check for active tasks, warn or block
    const { workspaceId, worktreePath, force } = payload;
    const activeTasks = taskSpawner.getTasksForWorkspace(worktreePath);
    if (activeTasks.length > 0 && !force) {
        ws.send(JSON.stringify({
            type: 'worktree:error',
            payload: {
                error: `Cannot remove: ${activeTasks.length} active tasks`,
                activeTasks: activeTasks.map(t => t.id),
            }
        }));
        return;
    }
    // ... proceed with removal ...
}
```

### 4.5 Changes to `task-spawner.ts`

```typescript
// In createTask():
async createTask(prompt, workspaceId, systemPrompt, cols, rows) {
    const workspace = this.workspaceStore.getWorkspace(workspaceId);

    // AUTO-WORKTREE MODE: if workspace has autoWorktree enabled
    if (workspace?.autoWorktree) {
        const manager = new WorktreeManager();
        const taskId = generateId(); // pre-generate task ID for branch name
        const branchSlug = `claudia/${taskId.slice(0, 8)}`;

        try {
            const wt = await manager.createWorktree({
                repoPath: workspaceId,
                branch: branchSlug,
                createBranch: true,
            });

            // Register worktree as workspace
            const wtWorkspace = await this.workspaceStore.addWorkspace(wt.path);

            // Spawn task in worktree instead of parent
            workspaceId = wt.path;

            console.log(`[TaskSpawner] Auto-created worktree ${wt.path} for task`);
        } catch (err) {
            console.warn(`[TaskSpawner] Auto-worktree failed, falling back:`, err);
            // Fall through to normal task creation in parent workspace
        }
    }

    // ... rest of existing createTask logic (unchanged) ...
}
```

### 4.6 Enhanced git-status endpoint

```typescript
// UPDATED: git-status response includes worktree info
export async function getGitStatus(cwd: string): Promise<{
    branch: string | null;
    isGitRepo: boolean;
    isWorktree: boolean;         // NEW
    mainWorktreePath?: string;   // NEW
    worktreeCount?: number;      // NEW
}> {
    const isRepo = await isGitRepo(cwd);
    if (!isRepo) return { branch: null, isGitRepo: false, isWorktree: false };

    const branch = await getCurrentBranch(cwd);
    const isWt = await isLinkedWorktree(cwd);

    let mainWorktreePath: string | undefined;
    let worktreeCount: number | undefined;

    if (isWt) {
        mainWorktreePath = await getMainWorktreePath(cwd);
    }

    // Count worktrees (lightweight)
    try {
        const { stdout } = await execFileAsync('git', ['worktree', 'list'], { cwd });
        worktreeCount = stdout.trim().split('\n').filter(l => l.trim()).length;
    } catch { /* ignore */ }

    return { branch, isGitRepo: true, isWorktree: isWt, mainWorktreePath, worktreeCount };
}
```

---

## 5. Frontend Implementation

### 5.1 Worktree State in Store (`taskStore.ts`)

```typescript
interface TaskStore {
    // ... existing ...

    // NEW: Worktree state
    worktreesCache: Map<string, WorktreeInfo[]>;  // workspaceId -> worktrees
    worktreeLoading: Set<string>;                  // workspaceIds currently loading

    // NEW: Actions
    fetchWorktrees: (workspaceId: string) => Promise<void>;
    createWorktree: (workspaceId: string, branch: string, baseBranch?: string) => Promise<void>;
    removeWorktree: (workspaceId: string, worktreePath: string) => Promise<void>;
}
```

### 5.2 WorkspacePanel Changes

**Workspace sorting** — group worktrees after their parent:

```typescript
// In WorkspacePanel render:
const sortedWorkspaces = useMemo(() => {
    const parents: Workspace[] = [];
    const childMap = new Map<string, Workspace[]>();

    for (const ws of workspaces) {
        if (ws.worktreeParentId) {
            const siblings = childMap.get(ws.worktreeParentId) ?? [];
            siblings.push(ws);
            childMap.set(ws.worktreeParentId, siblings);
        } else {
            parents.push(ws);
        }
    }

    const result: Workspace[] = [];
    for (const parent of parents) {
        result.push(parent);
        result.push(...(childMap.get(parent.id) ?? []));
    }
    return result;
}, [workspaces]);
```

**Workspace header — worktree indicator:**

```tsx
// In WorkspaceSection header:
<div className="workspace-header">
    {workspace.worktreeParentId ? (
        <GitBranch size={16} className="worktree-icon" />
    ) : (
        <Briefcase size={16} />
    )}

    <span className="workspace-name">
        {workspace.displayName ?? workspace.name}
    </span>

    {branchName && (
        <span className="workspace-branch-label">
            <GitBranch size={11} />
            <span>{branchName}</span>
        </span>
    )}

    {/* NEW: Worktree count badge on parent workspaces */}
    {!workspace.worktreeParentId && worktreeCount > 0 && (
        <span
            className="worktree-count-badge"
            title={`${worktreeCount} worktrees`}
            onClick={() => setShowWorktreePopover(true)}
        >
            <GitBranch size={11} />
            {worktreeCount}
        </span>
    )}
</div>
```

**Workspace menu — new worktree actions:**

```tsx
// In workspace context menu, after existing items:
{isGitRepo && !workspace.worktreeParentId && (
    <>
        <MenuDivider />
        <MenuItem onClick={() => setShowWorktreeModal(true)}>
            <GitBranch size={14} />
            New Worktree...
        </MenuItem>
        <MenuItem onClick={() => setShowWorktreeManager(true)}>
            <List size={14} />
            Manage Worktrees
        </MenuItem>
        <MenuItem>
            <ToggleLeft size={14} />
            Auto-isolate tasks
            <Toggle checked={workspace.autoWorktree} />
        </MenuItem>
    </>
)}

{workspace.worktreeParentId && (
    <>
        <MenuDivider />
        <MenuItem onClick={() => navigateToParent()}>
            <ArrowUp size={14} />
            Go to Parent Workspace
        </MenuItem>
        <MenuItem onClick={() => removeWorktree()} danger>
            <Trash size={14} />
            Remove Worktree
        </MenuItem>
    </>
)}
```

### 5.3 New Component: `WorktreeCreateModal.tsx`

```tsx
function WorktreeCreateModal({ workspace, onClose, onCreate }) {
    const [branchName, setBranchName] = useState('');
    const [baseBranch, setBaseBranch] = useState('main');
    const [createNew, setCreateNew] = useState(true);
    const [remoteBranches, setRemoteBranches] = useState<string[]>([]);

    // Fetch remote branches for autocomplete
    useEffect(() => { fetchBranches(workspace.id); }, []);

    return (
        <Modal title="Create Worktree" onClose={onClose}>
            <div className="worktree-create-form">
                <RadioGroup value={createNew} onChange={setCreateNew}>
                    <Radio value={true}>Create new branch</Radio>
                    <Radio value={false}>Checkout existing branch</Radio>
                </RadioGroup>

                <Field label="Branch name">
                    <Input
                        value={branchName}
                        onChange={setBranchName}
                        placeholder="feature/my-feature"
                        autoComplete={remoteBranches}
                    />
                </Field>

                {createNew && (
                    <Field label="Base branch">
                        <Select value={baseBranch} options={remoteBranches} />
                    </Field>
                )}

                <div className="modal-actions">
                    <Button variant="secondary" onClick={onClose}>Cancel</Button>
                    <Button variant="primary" onClick={() => onCreate(branchName, baseBranch)}>
                        Create Worktree
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
```

### 5.4 New Component: `WorktreeManagerPanel.tsx`

A slide-over panel (or modal) showing all worktrees for a repo:

```tsx
function WorktreeManagerPanel({ workspace, onClose }) {
    const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);

    return (
        <Panel title={`Worktrees - ${workspace.displayName ?? workspace.name}`}>
            {worktrees.map(wt => (
                <WorktreeRow key={wt.path} worktree={wt}>
                    <span className={wt.isMain ? 'badge-primary' : 'badge-branch'}>
                        {wt.branch}
                    </span>
                    <span className="task-count">{wt.taskCount} tasks</span>
                    {!wt.isMain && (
                        <Button
                            size="sm"
                            variant="danger"
                            disabled={wt.taskCount > 0}
                            title={wt.taskCount > 0 ? 'Archive tasks first' : 'Remove worktree'}
                            onClick={() => handleRemove(wt)}
                        >
                            Remove
                        </Button>
                    )}
                </WorktreeRow>
            ))}

            {orphanedCount > 0 && (
                <div className="orphaned-warning">
                    WARNING: {orphanedCount} orphaned worktree(s)
                    <Button onClick={handlePrune}>Prune All</Button>
                </div>
            )}
        </Panel>
    );
}
```

### 5.5 Branch Popover Enhancement

When clicking the branch badge, show a popover with worktree quick-actions:

```tsx
function BranchPopover({ workspace, branchName, worktrees }) {
    return (
        <Popover>
            <div className="branch-popover">
                <div className="current-branch">
                    <GitBranch size={14} />
                    <strong>{branchName}</strong>
                    {workspace.worktreeParentId && (
                        <span className="badge-worktree">worktree</span>
                    )}
                </div>

                {worktrees.length > 1 && (
                    <>
                        <Divider />
                        <div className="worktree-list-header">Other worktrees</div>
                        {worktrees
                            .filter(wt => wt.path !== workspace.id)
                            .map(wt => (
                                <div className="worktree-item" key={wt.path}>
                                    <GitBranch size={12} />
                                    <span>{wt.branch}</span>
                                    <span className="muted">({wt.taskCount} tasks)</span>
                                    <Button size="xs" onClick={() => openWorktree(wt.path)}>
                                        Open
                                    </Button>
                                </div>
                            ))
                        }
                    </>
                )}

                <Divider />
                <Button size="sm" onClick={() => setShowCreateModal(true)}>
                    + New Worktree
                </Button>
            </div>
        </Popover>
    );
}
```

---

## 6. Safety and Edge Cases

### 6.1 Branch Conflicts

Git prevents two worktrees from having the same branch checked out. We handle this gracefully:

```typescript
async createWorktree(opts) {
    // Check if branch already in use
    const existing = await this.isBranchInWorktree(opts.repoPath, opts.branch);
    if (existing) {
        throw new Error(
            `Branch "${opts.branch}" is already checked out in worktree at ${existing}. ` +
            `Choose a different branch name or remove the existing worktree first.`
        );
    }
    // ... proceed ...
}
```

### 6.2 Preventing Removal of Active Worktrees

```typescript
async removeWorktree(opts) {
    // 1. Check for running Claudia tasks
    const tasks = taskSpawner.getTasksForWorkspace(opts.worktreePath);
    const activeTasks = tasks.filter(t =>
        ['busy', 'starting', 'waiting_input'].includes(t.state)
    );

    if (activeTasks.length > 0 && !opts.force) {
        throw new Error(
            `Cannot remove worktree: ${activeTasks.length} active task(s). ` +
            `Stop or archive them first, or use force=true.`
        );
    }

    // 2. Check for uncommitted changes
    const hasChanges = await hasUncommittedChanges(opts.worktreePath);
    if (hasChanges && !opts.force) {
        throw new Error(
            `Worktree has uncommitted changes. Commit or discard them first, or use force=true.`
        );
    }

    // 3. Archive any idle tasks before removal
    for (const task of tasks) {
        await taskSpawner.archiveTask(task.id);
    }

    // 4. Remove git worktree
    await execFileAsync('git', [
        'worktree', 'remove', opts.worktreePath,
        ...(opts.force ? ['--force'] : [])
    ], { cwd: opts.repoPath });

    // 5. Remove from workspace store
    workspaceStore.deleteWorkspace(opts.worktreePath);
}
```

### 6.3 Worktree Directory Naming

Sanitize branch names for filesystem safety:

```typescript
function branchToDirectoryName(branch: string): string {
    return branch
        .replace(/^refs\/heads\//, '')
        .replace(/[\/\\:*?"<>|]/g, '-')  // Replace filesystem-unsafe chars
        .replace(/\.{2,}/g, '-')          // No ".." sequences
        .replace(/^\./, '_')              // No leading dots
        .slice(0, 100);                   // Reasonable length limit
}
```

### 6.4 Session Storage Isolation

Claude Code stores sessions in `~/.claude/projects/{path-hash}/`. Worktrees get different hashes automatically because they have different absolute paths. No special handling needed — each worktree gets its own conversation history.

### 6.5 `.gitignore` Auto-management

```typescript
async ensureWorktreeIgnored(repoPath: string): Promise<void> {
    const gitignorePath = join(repoPath, '.gitignore');
    const entry = '.claudia-worktrees/';

    if (existsSync(gitignorePath)) {
        const content = readFileSync(gitignorePath, 'utf-8');
        if (content.includes(entry)) return; // Already ignored

        // Append to existing .gitignore
        appendFileSync(gitignorePath, `\n# Claudia worktrees\n${entry}\n`);
    } else {
        writeFileSync(gitignorePath, `# Claudia worktrees\n${entry}\n`);
    }
}
```

### 6.6 Cross-Platform Path Handling

```typescript
// Windows: use forward slashes in git commands, backslashes for filesystem
// Already handled by existing path normalization in workspace-store.ts
// Worktree paths use path.resolve() which returns OS-native separators
```

### 6.7 Stale Worktree Detection

On server startup and periodically, detect worktrees whose directories were manually deleted:

```typescript
async detectStaleWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
    const worktrees = await this.listWorktrees(repoPath);
    return worktrees.filter(wt => wt.prunable);
}
```

---

## 7. Claudia MCP Integration

Tasks spawned via `claudia_create_task()` should be worktree-aware:

```typescript
// In MCP tool: claudia_create_task
// Add optional worktree parameter
{
    name: 'claudia_create_task',
    parameters: {
        prompt: { type: 'string', required: true },
        workspaceId: { type: 'string' },       // existing
        branch: { type: 'string' },             // NEW: auto-create worktree for this branch
        isolate: { type: 'boolean' },           // NEW: auto-create worktree (auto branch name)
    }
}
```

This lets orchestrator agents say: *"Create a task on branch `feature/auth` in an isolated worktree"* — powerful for parallel development workflows.

---

## 8. Implementation Phases

### Phase 1: Core Infrastructure (Backend) — ~2-3 days

1. Create `worktree-manager.ts` with `listWorktrees`, `createWorktree`, `removeWorktree`, `pruneWorktrees`
2. Add `isLinkedWorktree()` and `getMainWorktreePath()` to `git-utils.ts`
3. Extend `Workspace` type with `worktreeParentId`, `worktreeBranch`, `autoWorktree`
4. Auto-detect worktree status when adding workspace in `workspace-store.ts`
5. Add REST endpoints for worktree CRUD
6. Add comprehensive logging throughout
7. **Test**: CLI tests via `test-cli.ts` — list/create/remove worktrees

### Phase 2: Frontend — Worktree Visibility (~2 days)

1. Sort workspaces to group worktrees after parents
2. Add worktree icon differentiation in sidebar
3. Show worktree count badge on parent workspaces
4. Display "parent > branch" naming for worktree workspaces
5. Enhance branch badge popover to show sibling worktrees
6. **Test**: Visual verification in browser

### Phase 3: Frontend — Worktree Management (~2 days)

1. Build `WorktreeCreateModal` (branch name, base branch, create/checkout)
2. Build `WorktreeManagerPanel` (list, remove, prune)
3. Add menu items to workspace context menu
4. Add "Go to Parent" navigation for worktree workspaces
5. Confirmation dialogs for removal (with task/change warnings)
6. **Test**: Full user flow in browser

### Phase 4: Auto-Worktree and MCP (~1-2 days)

1. Implement `autoWorktree` toggle per workspace
2. Auto-create worktree in `TaskSpawner.createTask()` when enabled
3. Auto-cleanup offer when task is archived (merge/delete prompt)
4. Extend Claudia MCP with `branch` and `isolate` parameters
5. `.gitignore` auto-management for `.claudia-worktrees/`
6. **Test**: MCP integration via test-cli, auto-worktree via task creation

### Phase 5: Polish and Edge Cases (~1 day)

1. Stale worktree detection and pruning on startup
2. Worktree lock/unlock support
3. Error handling for all edge cases (missing dirs, branch conflicts, permissions)
4. Cross-platform testing (Windows + macOS/Linux)
5. Final review pass for gaps

---

## 9. Files Changed Summary

| File | Change Type | Description |
|------|------------|-------------|
| `shared/src/index.ts` | Modified | Add `WorktreeInfo`, extend `Workspace` type, new WS message types |
| `backend/src/worktree-manager.ts` | **New** | Core worktree operations (list/create/remove/prune) |
| `backend/src/git-utils.ts` | Modified | Add `isLinkedWorktree()`, `getMainWorktreePath()`, enhanced `getGitStatus()` |
| `backend/src/workspace-store.ts` | Modified | Auto-detect worktrees, `getWorktreeChildren()`, `getSortedWorkspaces()` |
| `backend/src/server.ts` | Modified | REST endpoints for worktree CRUD, enhanced git-status response |
| `backend/src/task-spawner.ts` | Modified | Auto-worktree mode in `createTask()` |
| `frontend/src/components/WorkspacePanel.tsx` | Modified | Worktree icons, grouping, menu items, count badges |
| `frontend/src/components/WorktreeCreateModal.tsx` | **New** | Create worktree modal |
| `frontend/src/components/WorktreeManagerPanel.tsx` | **New** | Manage/list/remove worktrees panel |
| `frontend/src/components/BranchPopover.tsx` | **New** | Enhanced branch badge with worktree quick-nav |
| `frontend/src/stores/taskStore.ts` | Modified | Worktree cache, fetch/create/remove actions |

---

## 10. Open Design Questions

| # | Question | Options | Recommendation |
|---|----------|---------|----------------|
| 1 | Where to store worktree directories? | `.claudia-worktrees/` in repo root vs external path | **In repo root** — discoverable, `.gitignore`'d, simple |
| 2 | Should auto-worktree be opt-in or opt-out? | Per-workspace toggle vs global setting | **Per-workspace toggle, off by default** — progressive disclosure |
| 3 | What happens to worktree when all tasks are archived? | Auto-remove, prompt user, or keep forever | **Prompt user** — "No active tasks. Remove worktree?" toast |
| 4 | Should worktrees show as indented children or flat? | Indented tree vs flat with badges | **Flat with badges** initially, consider tree later — simpler |
| 5 | Branch naming for auto-worktree tasks? | `claudia/task-{id}` vs `claudia/{prompt-slug}` | **`claudia/task-{short-id}`** — predictable, no collision |
| 6 | Merge workflow after worktree task completes? | Built-in merge UI vs leave to user | **Leave to user** in v1 — merge UX is complex, can add later |
| 7 | How to handle manually-created worktrees? | Detect + adopt vs ignore | **Detect + show** — if user manually `git worktree add`'d, show in manager but don't register as workspace unless user clicks "Open" |
| 8 | Should removing parent workspace cascade? | Remove children, orphan children, or block removal | **Block removal** if worktree children exist — force user to clean up first |

---

## 11. Critical Review: Gaps and Risks

### 11.1 Windows Path Encoding in REST URLs

The plan uses workspace IDs (absolute paths) as URL path parameters:
```
GET /api/workspaces/C%3A%5CUsers%5Ckovtchar%5CWork%5Cmy-app/worktrees
```

The colon in `C:` will encode as `%3A`, which some HTTP servers interpret as a port separator. The existing codebase uses query parameters for the git-status endpoint (`?workspace=...`), which is safer.

**Fix**: Use query parameters instead of path params for workspace-scoped worktree endpoints:
```
GET  /api/worktrees?workspace={encoded-path}
POST /api/worktrees?workspace={encoded-path}
DELETE /api/worktrees?workspace={encoded-path}&branch={branch}
POST /api/worktrees/prune?workspace={encoded-path}
```

This matches the existing `git-status` pattern and avoids Windows path encoding issues.

### 11.2 Workspace Existence Check on Load

`WorkspaceStore.loadConfig()` currently filters out workspaces whose directories don't exist:
```typescript
loaded.workspaces = (loaded.workspaces || []).filter(w => existsSync(w.id));
```

If a worktree is removed externally (e.g., `git worktree remove` from terminal), the workspace silently disappears on next server load. This is confusing.

**Fix**: For worktree workspaces, don't silently drop — instead mark them as `stale` and show a visual indicator in the UI. Let the user acknowledge and remove them explicitly, or auto-prune on the parent workspace.

### 11.3 Manually-Created Worktrees

Users may create worktrees outside Claudia (via terminal `git worktree add`). The plan only covers Claudia-created worktrees in `.claudia-worktrees/`. These external worktrees should still appear in the "Manage Worktrees" panel (from `git worktree list`), but only become Claudia workspaces when the user explicitly opens them.

### 11.4 Race Conditions in Auto-Worktree

If a user rapidly creates two tasks while `autoWorktree` is enabled, both hit `createTask()` concurrently. Two worktrees get created from the same base branch. This is fine for independent work, but could surprise users.

**Fix**: Add a mutex/queue in `TaskSpawner` for worktree creation per workspace:
```typescript
private worktreeCreationLocks = new Map<string, Promise<void>>();
```

### 11.5 Parent Workspace Removal

If the user removes a parent workspace from Claudia (not deleting files, just unlinking), its worktree children become orphaned in the workspace list — their `worktreeParentId` points to a workspace that no longer exists.

**Fix**: Block removal of a parent workspace if it has worktree children. Show a message: "Remove N worktrees first, or use 'Remove All' to clean up."

### 11.6 `.gitignore` Modification is a Tracked File Change

Auto-appending to `.gitignore` modifies a tracked file, which creates a diff that could confuse users or interfere with tasks. This is especially surprising if a task is actively running.

**Fix**:
- Only modify `.gitignore` if the user confirms (show a toast: "Add `.claudia-worktrees/` to .gitignore?")
- Alternatively, use `.git/info/exclude` instead — this is a local-only gitignore that doesn't require a commit. Safer for automated tools.

**Recommendation**: Use `.git/info/exclude` by default. Offer a menu option "Add to .gitignore" for users who want it tracked.

### 11.7 Submodules in Worktrees

Git submodules require special handling in worktrees. By default, `git worktree add` doesn't initialize submodules in the new worktree. If the project uses submodules, tasks in worktrees will see empty submodule directories.

**Fix**: After creating a worktree, check if `.gitmodules` exists and run `git submodule update --init --recursive` in the new worktree. Add a timeout and make it non-blocking (don't delay task creation for large submodule clones).

### 11.8 Performance: Worktree Count in git-status Polling

The enhanced `getGitStatus()` runs `git worktree list` on every 30-second poll for every workspace. For repos with many workspaces, this adds overhead.

**Fix**: Cache worktree count per repo path with a 60-second TTL. The count rarely changes, and stale data is acceptable for a badge.

### 11.9 Workspace Reset Interaction

The existing "Reset Workspace" feature archives all tasks and checks out the default branch. In a worktree:
- You can't switch branches in a worktree (the branch is fixed to the worktree)
- `git checkout main` would fail if `main` is checked out in the primary worktree

**Fix**: For worktree workspaces, "Reset Workspace" should archive tasks + offer to remove the worktree entirely (returning user to the parent). Don't attempt branch checkout.

### 11.10 System Prompt Inheritance

When a worktree workspace is created from a parent, should it inherit the parent's system prompt?

**Recommendation**: Yes — copy the parent's system prompt to the worktree workspace at creation time. The user can then modify it independently. This ensures tasks in worktrees have the same context as the parent.

### 11.11 Workspace References in Worktrees

The parent workspace may have `references` (linked directories). Worktree workspaces should inherit these references automatically, since the project context doesn't change just because you're on a different branch.

---

## 12. Revised Architecture Decisions

Based on the critical review, these changes should be made to the original plan:

| Section | Original | Revised |
|---------|----------|---------|
| 3.3 REST Endpoints | Path params (`/workspaces/:id/worktrees`) | Query params (`/worktrees?workspace=...`) |
| 6.5 `.gitignore` | Auto-append to `.gitignore` | Use `.git/info/exclude` by default |
| 4.5 Auto-worktree | No concurrency control | Add per-workspace mutex for worktree creation |
| Workspace removal | Not addressed | Block parent removal if children exist |
| Workspace reset | Not addressed | Worktree reset = archive tasks + offer removal |
| Submodules | Not addressed | Auto-init submodules after worktree creation |
| System prompt | Not addressed | Inherit parent's system prompt on creation |
| References | Not addressed | Inherit parent's references on creation |

---

## 13. Testing Strategy

### 13.1 Unit Tests (backend)

Add to `backend/src/__tests__/`:

- **`worktree-manager.test.ts`**
  - `listWorktrees()` parsing with various `git worktree list --porcelain` outputs
  - `branchToDirectoryName()` sanitization edge cases (slashes, dots, Unicode, max length)
  - `isBranchInWorktree()` detection
  - Error handling for non-git directories

- **`git-utils-worktree.test.ts`**
  - `isLinkedWorktree()` — .git file vs directory detection
  - `getMainWorktreePath()` — resolving from linked worktree back to main

### 13.2 Integration Tests (CLI)

Add to `backend/test-cli.ts`:

```bash
# List worktrees for a workspace
npx tsx test-cli.ts --worktrees /path/to/repo

# Create worktree
npx tsx test-cli.ts --create-worktree /path/to/repo --branch feature/test

# Remove worktree
npx tsx test-cli.ts --remove-worktree /path/to/repo --branch feature/test

# Create task with auto-worktree isolation
npx tsx test-cli.ts -m "test task" -w /path/to/repo --isolate
```

### 13.3 Manual Tests (Playwright or browser)

- Create worktree from workspace menu, verify it appears in sidebar
- Create task in worktree, verify it runs in correct directory
- Remove worktree with no tasks, verify cleanup
- Attempt to remove worktree with active tasks, verify warning
- Auto-worktree mode: create task, verify branch created
- Branch popover: verify sibling worktrees listed
- Manage Worktrees panel: verify list, remove, prune operations
- Cross-platform: verify on Windows (backslash paths) and macOS/Linux

### 13.4 Edge Case Tests

- Create worktree when workspace has uncommitted changes
- Create worktree with branch name containing special characters
- Remove worktree that was already deleted from filesystem
- Server restart with worktree workspaces persisted
- Two concurrent auto-worktree task creations
- Repo with submodules: verify submodule init in worktree
- Workspace with 10+ worktrees: verify performance
- Manually-created worktree (outside Claudia): verify detection in manager panel
