# Claudia Feature Plan

## Feature 1: Embedded Terminal Tab per Workspace
**Priority:** High | **Effort:** Low-Medium | **Status:** Not started

Add a "Shell" tab alongside task terminals in the workspace view. Users can open an interactive terminal scoped to the workspace directory without leaving Claudia.

### Why
- Infrastructure already exists (node-pty, xterm.js, WebSocket I/O)
- General purpose — clone repos, run builds, manage git, check logs
- Keeps users in context vs. the current `workspace:openTerminal` which opens an external terminal

### Implementation
- Backend: Add WebSocket handlers for `terminal:create`, `terminal:input`, `terminal:resize`, `terminal:close`
- Backend: Spawn a PTY shell process (bash/zsh/powershell) scoped to the workspace directory
- Backend: Track shell terminals separately from task terminals
- Frontend: Add a "Shell" tab/button in the workspace terminal area
- Frontend: Reuse existing `TerminalView` / xterm.js setup for the shell session
- Cleanup: Destroy shell PTY when workspace is closed or terminal is explicitly closed

---

## Feature 2: Notifications (Browser/Desktop)
**Priority:** High | **Effort:** Low | **Status:** Not started

Send browser/desktop notifications when a task completes or needs user input. Critical for multi-task workflows where users tab away.

### Implementation
- Request browser notification permissions on first use
- Detect task state transitions: running → waiting for input, running → completed, running → errored
- Send browser `Notification` with task name, workspace, and status
- Add a settings toggle to enable/disable notifications
- Optional: sound alerts for different states
- Electron: Use Electron's native notification API when running as desktop app

---

## Feature 3: Task Templates / Saved Prompts
**Priority:** High | **Effort:** Low | **Status:** Not started

Allow users to save and reuse common prompts as templates for quick task creation.

### Implementation
- Backend: Store templates in workspace config or a global config file
- Backend: WebSocket handlers for `template:list`, `template:create`, `template:delete`
- Frontend: "Save as template" option when creating a task
- Frontend: Template picker dropdown/list when creating a new task
- Suggested defaults: "Review this PR", "Add tests for recent changes", "Fix failing CI", "Explain this codebase"

---

## Feature 4: Bulk Actions
**Priority:** Medium-High | **Effort:** Low | **Status:** Not started

Add bulk operations for managing multiple tasks at once.

### Implementation
- "Approve all" — approve all tasks waiting for input in a workspace
- "Cancel all" — cancel all running tasks in a workspace
- "Clear completed" — remove all completed/errored tasks from the UI
- Add buttons to workspace header in WorkspacePanel
- Backend: Add WebSocket handlers for bulk operations or iterate client-side

---

## Feature 5: Task Chaining / Workflows
**Priority:** Medium | **Effort:** Medium | **Status:** Not started

Allow users to define follow-up tasks that auto-start when a previous task completes.

### Implementation
- UI: "On completion, run..." option when creating a task
- Backend: Monitor task completion events and auto-create follow-up tasks
- Support simple linear chains (A → B → C)
- Pass context from previous task (success/failure, summary) to next task's prompt
- Example workflow: clone repo → install deps → run tests → report results

---

## Feature 6: Quick Open from GitHub URL
**Priority:** Medium | **Effort:** Medium | **Status:** Not started

Paste a GitHub repo URL to auto-clone and open as a workspace.

### Implementation
- Detect GitHub URLs in the path input modal
- Parse owner/repo from URL
- Clone to a configurable default directory (e.g., `~/Projects/`)
- Show clone progress in UI
- Auto-create workspace pointing to cloned directory
- Handle auth via system git credentials (don't reinvent auth)

---

## Feature 7: Enhanced Diff Review
**Priority:** Medium | **Effort:** Medium | **Status:** Not started

Show a proper side-by-side diff view before approving Claude's changes.

### Implementation
- Leverage existing git integration in FileExplorer
- Add a "Review Changes" button/mode that shows full diff
- Side-by-side or unified diff view (consider using a library like `react-diff-viewer`)
- Allow approving/rejecting individual file changes
- Show diff summary (files changed, insertions, deletions)

---

## Feature 8: Multi-Workspace Broadcast
**Priority:** Low | **Effort:** Medium | **Status:** Not started

Send the same prompt to multiple workspaces simultaneously.

### Implementation
- UI: Multi-select workspaces, enter a shared prompt
- Backend: Create tasks in parallel across selected workspaces
- Show aggregated progress/results
- Use case: "update all repos to use new API version"

---

## Feature 9: Task Conversation Export
**Priority:** Low | **Effort:** Low | **Status:** Not started

Export a task's full terminal output / conversation as markdown.

### Implementation
- Add "Export" button to task view
- Capture terminal output history (already stored for persistence)
- Format as markdown with timestamps
- Download as `.md` file or copy to clipboard

---

## Feature 10: Dashboard / Overview
**Priority:** Low | **Effort:** Medium | **Status:** Not started

Bird's-eye view showing all workspaces and task statuses on one screen.

### Implementation
- New dashboard route/view
- Cards or table showing each workspace with task counts by status
- Quick stats: total running, waiting, completed, errored
- Click to jump to specific workspace/task
- Optional: activity timeline showing recent task events
