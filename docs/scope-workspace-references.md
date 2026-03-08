# Feature Scope: Workspace References

## Problem

When working in Workspace B, Claude Code only has visibility into Workspace B's files. If you want Claude to reference content from Workspace A (e.g., a terms of service document, code patterns, configuration examples), there's no way to give it that cross-workspace visibility.

**Use cases:**
- Derive a new terms of service / privacy policy based on one from another project
- Follow code patterns or architectural conventions from a reference project
- Share configuration templates, API schemas, or design docs across projects
- Use one project's implementation as an example when building similar functionality in another

## Solution

Add a "References" concept to workspaces. A workspace can reference one or more other directories (which may or may not be Claudia workspaces). When a task is created, the system prompt is augmented with context about the referenced paths so Claude can read files from them.

**Why this works:** Claude Code can already read files from any absolute path via its Read tool. It just needs to *know* about the paths and what they contain. The system prompt injection gives Claude that awareness.

## Data Model

### Shared Types (`shared/src/index.ts`)

```typescript
export interface WorkspaceReference {
    id: string;              // UUID
    path: string;            // Absolute path to referenced directory
    name: string;            // Display name (defaults to folder name)
    description?: string;    // Optional user description of what this reference contains
    paths?: string[];        // Optional: specific subdirectories/files to reference (empty = entire directory)
}

// Updated Workspace interface
export interface Workspace {
    id: string;
    name: string;
    createdAt: string;
    systemPrompt?: string;
    displayName?: string;
    references?: WorkspaceReference[];  // NEW
}
```

## Architecture

### Layer 1: Storage (workspace-store.ts)

Add CRUD methods for workspace references:

- `getReferences(workspaceId): WorkspaceReference[]`
- `addReference(workspaceId, path, description?, paths?): WorkspaceReference`
- `updateReference(workspaceId, referenceId, updates): boolean`
- `removeReference(workspaceId, referenceId): boolean`

References are persisted as part of the `Workspace` object in `workspace-config.json`.

### Layer 2: Context Injection (task-spawner.ts)

When creating a task, build reference context and inject it into the system prompt:

```
You have access to the following reference workspaces. Use these as examples
or context when relevant to the task:

## Reference: "Legal Templates" (/Users/me/projects/legal-templates)
Contains terms of service and privacy policy templates.
You can read files from this directory using absolute paths.

## Reference: "API Service" (/Users/me/projects/api-service)
Paths: src/middleware/, src/routes/
Reference implementation of API patterns.
You can read files from these directories using absolute paths.
```

**Injection point:** In `createTask()` (line ~1389), after learnings injection but before spawning. Append to the system prompt string alongside existing learnings context.

### Layer 3: WebSocket API (server.ts)

New WebSocket messages:

| Message | Direction | Payload |
|---------|-----------|---------|
| `workspace:references:add` | Client -> Server | `{ workspaceId, path, description? }` |
| `workspace:references:remove` | Client -> Server | `{ workspaceId, referenceId }` |
| `workspace:references:browse` | Client -> Server | `{ workspaceId }` (open folder picker for custom dirs) |

References are included in the existing `Workspace` object sent on `workspace:created`, `workspace:updated`, and `init`, so no separate list endpoint is needed.

### Layer 4: Frontend UI (WorkspacePanel.tsx)

**Context menu submenu approach** — the `...` dropdown on each workspace gets a "References" flyout:

```
  ...  (workspace context menu)
  ├── Copy Path
  ├── Rename
  ├── Push to GitHub
  ├── ──────────────
  ├── System Prompt
  ├── References ►  ┌─────────────────────────┐
  │                 │ ☑ legal-templates        │  <- other workspace (checked = referenced)
  │                 │ ☐ api-service            │  <- other workspace (unchecked)
  │                 │ ☐ design-system          │  <- other workspace
  │                 │ ──────────────────────── │
  │                 │ 📁 /shared/configs       │  <- custom folder reference
  │                 │    ✕                      │  <- remove custom folder
  │                 │ ──────────────────────── │
  │                 │ + Add Custom Folder...   │  <- opens folder picker
  │                 └─────────────────────────┘
  ├── Code Review
  ├── ──────────────
  └── Remove Workspace
```

**Behavior:**
- Other Claudia workspaces appear as toggleable checkboxes (one click to add/remove)
- The current workspace is excluded from the list
- Custom (non-workspace) folders appear below a divider with a remove (✕) button
- "Add Custom Folder..." opens the native folder picker
- A link icon + count indicator on the workspace row shows active references; hovering reveals a tooltip listing them

### Layer 5: CLI Support (test-cli.ts)

Add CLI commands for testing:

```bash
npx tsx test-cli.ts --add-reference <workspaceId> <path> [--description "..."]
npx tsx test-cli.ts --list-references <workspaceId>
npx tsx test-cli.ts --remove-reference <workspaceId> <referenceId>
```

## User Experience

### Adding a Workspace Reference (1 click)

1. Click `...` on "my-saas-project" workspace
2. Hover "References" → submenu appears showing all other workspaces as checkboxes
3. Check "legal-templates" → done. It's now a reference.

### Adding a Custom Folder Reference (2 clicks)

1. Click `...` → "References" → "Add Custom Folder..."
2. Pick a folder from the native file picker → done.

### Removing a Reference

- **Workspace reference:** Uncheck it in the submenu
- **Custom folder:** Click the ✕ next to it in the submenu

### What Happens When Creating a Task

Nothing changes. The user writes their prompt as usual. Behind the scenes, the system prompt is augmented so Claude knows about the referenced paths and reads from them on-demand.

### Visual Indicator

When a workspace has references, a small link icon (or similar) with a count badge appears on the workspace row. Hovering over the indicator shows a tooltip listing the referenced workspaces/folders:

```
  🔗 2  ← indicator on workspace row
       ┌──────────────────────────┐
       │ References:              │  ← tooltip on hover
       │  • legal-templates       │
       │  • /shared/configs       │
       └──────────────────────────┘
```

This gives at-a-glance visibility without needing to open the context menu.

## Implementation Plan

### Phase 1: Data + Backend (Core)
1. Add `WorkspaceReference` type to `shared/src/index.ts`
2. Add `references` field to `Workspace` interface
3. Add CRUD methods to `workspace-store.ts`
4. Add WebSocket handlers to `server.ts`
5. Add reference context injection to `task-spawner.ts` `createTask()`
6. Add CLI commands to `test-cli.ts`
7. Test with CLI

### Phase 2: Frontend UI
8. Add references submenu to workspace context menu in `WorkspacePanel.tsx`
9. Wire up WebSocket messages for toggle/add/remove
10. Add folder picker integration for custom folders
11. Add reference count badge to workspace row
12. Test end-to-end through the UI

## Edge Cases

- **Referenced directory deleted:** Validate at task creation time; warn but don't block. Filter out non-existent references.
- **Circular references:** Not an issue since references only affect system prompt context, not execution.
- **Large referenced directories:** The system prompt only contains *paths*, not file contents. Claude reads files on-demand. No token bloat.
- **Path filters:** Optional `paths[]` field lets users scope references to specific subdirectories (e.g., only `src/` or `docs/`), keeping the context focused.

## Non-Goals (v1)

- Automatic file content indexing or embedding
- Bidirectional references
- Reference-specific permissions or access control
- Syncing or copying files between workspaces
- File watching on referenced directories
