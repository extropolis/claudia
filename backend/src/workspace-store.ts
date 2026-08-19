/**
 * Workspace Store - Manages workspace directories
 * Workspaces are simply folder paths - the name comes from the folder name
 */
import { existsSync, statSync, mkdirSync } from 'fs';
import { join, dirname, resolve, basename } from 'path';
import { fileURLToPath } from 'url';
import { Workspace, RecentWorkspace, WorkspaceReference } from '@claudia/shared';
import { randomUUID } from 'crypto';
import { loadVersioned, saveVersioned } from './utils/schema-version.js';
import { isLinkedWorktree, getMainWorktreePath, getCurrentBranch } from './git-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Schema version for workspace-config.json. Bump when WorkspaceConfig shape changes. */
const WORKSPACE_SCHEMA_VERSION = 1;

// Re-export for convenience
export type { RecentWorkspace };

export interface WorkspaceConfig {
    workspaces: Workspace[];
    activeWorkspaceId: string | null;
    recentWorkspaces: RecentWorkspace[];  // Workspaces that have been removed (history)
    lastBrowsedPath?: string;  // Remember last directory used in folder browser
}

const DEFAULT_CONFIG: WorkspaceConfig = {
    workspaces: [],
    activeWorkspaceId: null,
    recentWorkspaces: [],
    lastBrowsedPath: undefined
};

const MAX_RECENT_WORKSPACES = 10;  // Keep only the last 10 recent workspaces

export class WorkspaceStore {
    private config: WorkspaceConfig;
    private workspaceFile: string;
    // In-memory PR info cache keyed by workspace id. The latest value is ALSO
    // persisted onto the workspace record: the periodic refresh only re-polls
    // workspaces whose last-known PR is non-terminal, so a restart that lost
    // prInfo silently dropped every task-less workspace from the refresh loop
    // and froze its badge at the pre-restart state.
    private prInfoCache = new Map<string, Workspace['prInfo']>();

    constructor(basePath?: string) {
        // Use basePath if provided (Electron userData), otherwise use default location
        this.workspaceFile = basePath
            ? join(basePath, 'workspace-config.json')
            : join(__dirname, '..', 'workspace-config.json');

        // Ensure directory exists
        if (basePath && !existsSync(basePath)) {
            mkdirSync(basePath, { recursive: true });
        }

        this.config = this.loadConfig();
    }

    private loadConfig(): WorkspaceConfig {
        try {
            const loaded = loadVersioned<WorkspaceConfig>(this.workspaceFile, {
                currentVersion: WORKSPACE_SCHEMA_VERSION,
                defaultData: { ...DEFAULT_CONFIG },
                // Legacy unversioned format was the raw WorkspaceConfig.
                legacyLoader: (raw) => (raw as WorkspaceConfig) ?? { ...DEFAULT_CONFIG },
            });

            // Filter out workspaces that no longer exist.
            loaded.workspaces = (loaded.workspaces || []).filter(w => existsSync(w.id));

            // Initialize recentWorkspaces if not present.
            if (!loaded.recentWorkspaces) {
                loaded.recentWorkspaces = [];
            }

            return loaded;
        } catch (error) {
            console.error('[WorkspaceStore] Error loading config:', error);
            return { ...DEFAULT_CONFIG };
        }
    }

    private saveConfig(): void {
        try {
            saveVersioned(this.workspaceFile, this.config, WORKSPACE_SCHEMA_VERSION);
            console.log('[WorkspaceStore] Config saved to', this.workspaceFile);
        } catch (error) {
            console.error('[WorkspaceStore] Error saving config:', error);
            throw error;
        }
    }

    getWorkspaces(): Workspace[] {
        return this.config.workspaces.map(w => this.withPrInfo(w));
    }

    /** Merge the in-memory PR info cache onto a workspace for serialization. */
    private withPrInfo(w: Workspace): Workspace {
        const prInfo = this.prInfoCache.get(w.id);
        return prInfo !== undefined ? { ...w, prInfo } : w;
    }

    /**
     * Set (or clear) the cached PR info for a workspace.
     * Returns true if the value changed (so callers can decide whether to broadcast).
     */
    setPrInfo(id: string, prInfo: Workspace['prInfo']): boolean {
        const prev = this.prInfoCache.has(id)
            ? this.prInfoCache.get(id)
            : this.config.workspaces.find(w => w.id === id)?.prInfo;
        const changed = JSON.stringify(prev) !== JSON.stringify(prInfo);
        this.prInfoCache.set(id, prInfo);
        if (changed) {
            // Persist the last-known PR state so the refresh loop's
            // "non-terminal PR ⇒ keep polling" rule survives a backend restart.
            const w = this.config.workspaces.find(w => w.id === id);
            if (w) {
                w.prInfo = prInfo;
                this.saveConfig();
            }
        }
        return changed;
    }

    getWorkspace(id: string): Workspace | undefined {
        const w = this.config.workspaces.find(w => w.id === id);
        return w ? this.withPrInfo(w) : w;
    }

    // Add workspace by path - the id IS the path, name comes from folder
    addWorkspace(path: string): Workspace {
        const resolvedPath = resolve(path);

        // Create directory if it doesn't exist
        if (!existsSync(resolvedPath)) {
            try {
                mkdirSync(resolvedPath, { recursive: true });
                console.log(`[WorkspaceStore] Created directory: ${resolvedPath}`);
            } catch (error) {
                throw new Error(`Failed to create directory: ${resolvedPath}. ${error}`);
            }
        }

        // Validate it's a directory
        const stats = statSync(resolvedPath);
        if (!stats.isDirectory()) {
            throw new Error(`Path is not a directory: ${resolvedPath}`);
        }

        // Check if already exists
        if (this.config.workspaces.some(w => w.id === resolvedPath)) {
            throw new Error(`Workspace already exists: ${resolvedPath}`);
        }

        const workspace: Workspace = {
            id: resolvedPath, // id IS the path
            name: basename(resolvedPath) || resolvedPath,
            createdAt: new Date().toISOString()
        };

        this.config.workspaces.push(workspace);

        // Remove from recent workspaces if it was there (since it's now active again)
        this.config.recentWorkspaces = this.config.recentWorkspaces.filter(w => w.id !== resolvedPath);

        // Auto-set as active if first workspace
        if (this.config.workspaces.length === 1) {
            this.config.activeWorkspaceId = workspace.id;
        }

        this.saveConfig();
        return workspace;
    }

    /**
     * Add a worktree workspace — like addWorkspace but also sets worktree metadata
     * (worktreeParentId, worktreeBranch, displayName) and positions it after its parent.
     */
    async addWorktreeWorkspace(worktreePath: string, parentId: string, branch: string): Promise<Workspace> {
        const resolvedPath = resolve(worktreePath);

        if (!existsSync(resolvedPath)) {
            throw new Error(`Worktree directory does not exist: ${resolvedPath}`);
        }
        if (this.config.workspaces.some(w => w.id === resolvedPath)) {
            throw new Error(`Workspace already exists: ${resolvedPath}`);
        }

        // Worktrees must nest under a top-level (repo) workspace, never under another
        // worktree. When a task running inside a worktree spawns a new worktree, the
        // passed parentId is itself a worktree — walk up to the root repo so the sidebar
        // can group it. A worktree parented to another worktree renders nowhere in the
        // toolbar (the grouping only handles one level under a top-level workspace).
        // Guard against a cyclic or self-referential worktreeParentId chain (corrupted
        // config) — a bare `while (walk?.worktreeParentId)` would spin forever. Track the
        // ids we've visited and stop if we'd revisit one; cap the hops as a backstop.
        const visited = new Set<string>([parentId]);
        let walk = this.getWorkspace(parentId);
        let hops = 0;
        while (walk?.worktreeParentId && !visited.has(walk.worktreeParentId) && hops < 50) {
            parentId = walk.worktreeParentId;
            visited.add(parentId);
            walk = this.getWorkspace(parentId);
            hops++;
        }
        if (walk?.worktreeParentId && visited.has(walk.worktreeParentId)) {
            console.warn(`[WorkspaceStore] Cyclic worktreeParentId detected while resolving root for ${resolvedPath}; stopping walk at ${parentId}`);
        }


        const parentWorkspace = this.getWorkspace(parentId);
        const parentDisplayName = parentWorkspace?.displayName ?? parentWorkspace?.name ?? basename(parentId);
        const shortBranch = branch.replace(/^refs\/heads\//, '');

        const workspace: Workspace = {
            id: resolvedPath,
            name: basename(resolvedPath),
            createdAt: new Date().toISOString(),
            displayName: `${parentDisplayName} › ${shortBranch}`,
            worktreeParentId: parentId,
            worktreeBranch: shortBranch,
            // Inherit parent's system prompt and references
            systemPrompt: parentWorkspace?.systemPrompt,
            references: parentWorkspace?.references ? [...parentWorkspace.references] : undefined,
        };

        // Insert worktree after its parent (or after the last sibling worktree)
        const parentIdx = this.config.workspaces.findIndex(w => w.id === parentId);
        if (parentIdx === -1) {
            // Parent not registered — append at end
            this.config.workspaces.push(workspace);
            this.config.recentWorkspaces = this.config.recentWorkspaces.filter(w => w.id !== resolvedPath);
            this.saveConfig();
            console.log(`[WorkspaceStore] Added worktree workspace ${resolvedPath} (parent not found, appended)`);
            return workspace;
        }
        // Find the last sibling worktree already under this parent
        let insertAt = parentIdx + 1;
        while (insertAt < this.config.workspaces.length &&
               this.config.workspaces[insertAt].worktreeParentId === parentId) {
            insertAt++;
        }
        this.config.workspaces.splice(insertAt, 0, workspace);

        this.config.recentWorkspaces = this.config.recentWorkspaces.filter(w => w.id !== resolvedPath);
        this.saveConfig();
        console.log(`[WorkspaceStore] Added worktree workspace ${resolvedPath} (parent=${parentId}, branch=${shortBranch})`);
        return workspace;
    }

    /**
     * Return all worktree child workspaces for a given parent workspace ID.
     */
    getWorktreeChildren(parentId: string): Workspace[] {
        return this.config.workspaces.filter(w => w.worktreeParentId === parentId);
    }

    /**
     * Set the autoWorktree flag on a workspace.
     */
    setAutoWorktree(workspaceId: string, enabled: boolean): boolean {
        const workspace = this.config.workspaces.find(w => w.id === workspaceId);
        if (!workspace) return false;
        workspace.autoWorktree = enabled;
        this.saveConfig();
        console.log(`[WorkspaceStore] Set autoWorktree=${enabled} for ${workspaceId}`);
        return true;
    }

    deleteWorkspace(id: string): boolean {
        const index = this.config.workspaces.findIndex(w => w.id === id);
        if (index === -1) return false;

        const workspace = this.config.workspaces[index];
        this.config.workspaces.splice(index, 1);
        this.prInfoCache.delete(id);

        // Add to recent workspaces (only if it still exists on disk)
        if (existsSync(id)) {
            // Remove if already in recent (to avoid duplicates)
            this.config.recentWorkspaces = this.config.recentWorkspaces.filter(w => w.id !== id);

            // Add to the beginning of the list
            this.config.recentWorkspaces.unshift({
                id: workspace.id,
                name: workspace.name,
                removedAt: new Date().toISOString()
            });

            // Keep only the last N recent workspaces
            if (this.config.recentWorkspaces.length > MAX_RECENT_WORKSPACES) {
                this.config.recentWorkspaces = this.config.recentWorkspaces.slice(0, MAX_RECENT_WORKSPACES);
            }
        }

        // Clear active if deleted
        if (this.config.activeWorkspaceId === id) {
            this.config.activeWorkspaceId = this.config.workspaces[0]?.id || null;
        }

        this.saveConfig();
        return true;
    }

    // Active workspace
    getActiveWorkspaceId(): string | null {
        return this.config.activeWorkspaceId;
    }

    setActiveWorkspace(id: string | null): void {
        if (id !== null && !this.config.workspaces.some(w => w.id === id)) {
            throw new Error(`Workspace not found: ${id}`);
        }
        this.config.activeWorkspaceId = id;
        this.saveConfig();
    }

    // Reorder workspaces by moving item from one index to another
    reorderWorkspaces(fromIndex: number, toIndex: number): boolean {
        if (fromIndex === toIndex) return false;
        if (fromIndex < 0 || fromIndex >= this.config.workspaces.length) return false;
        if (toIndex < 0 || toIndex >= this.config.workspaces.length) return false;

        const [removed] = this.config.workspaces.splice(fromIndex, 1);
        this.config.workspaces.splice(toIndex, 0, removed);
        this.saveConfig();
        console.log(`[WorkspaceStore] Reordered workspace from ${fromIndex} to ${toIndex}`);
        return true;
    }

    // Replace the workspace order to match the given list of IDs.
    // Used by drag-drop in non-manual sort modes: the client sends the
    // visually-rendered order (which may differ from stored order) and we
    // adopt it wholesale. IDs not in the input are preserved at the end in
    // their existing relative order, so a stale client cannot lose workspaces.
    setWorkspaceOrder(orderedIds: string[]): boolean {
        const byId = new Map(this.config.workspaces.map(w => [w.id, w]));
        const reordered: typeof this.config.workspaces = [];
        const seen = new Set<string>();
        for (const id of orderedIds) {
            const ws = byId.get(id);
            if (ws && !seen.has(id)) {
                reordered.push(ws);
                seen.add(id);
            }
        }
        // Append any workspaces the client didn't know about (e.g. just-created on another client)
        for (const ws of this.config.workspaces) {
            if (!seen.has(ws.id)) reordered.push(ws);
        }
        if (reordered.length !== this.config.workspaces.length) return false;
        this.config.workspaces = reordered;
        this.saveConfig();
        console.log(`[WorkspaceStore] Set explicit workspace order (${reordered.length} items)`);
        return true;
    }

    // Rename a workspace (set displayName)
    renameWorkspace(id: string, displayName: string): boolean {
        const workspace = this.config.workspaces.find(w => w.id === id);
        if (!workspace) return false;

        workspace.displayName = displayName.trim() || undefined; // Clear if empty
        this.saveConfig();
        console.log(`[WorkspaceStore] Renamed workspace ${id} to "${displayName}"`);
        return true;
    }

    // Get workspace system prompt
    getSystemPrompt(workspaceId: string): string | undefined {
        const workspace = this.config.workspaces.find(w => w.id === workspaceId);
        return workspace?.systemPrompt;
    }

    // Set workspace system prompt
    setSystemPrompt(workspaceId: string, systemPrompt: string | undefined): boolean {
        const workspace = this.config.workspaces.find(w => w.id === workspaceId);
        if (!workspace) return false;

        workspace.systemPrompt = systemPrompt;
        this.saveConfig();
        console.log(`[WorkspaceStore] Updated system prompt for ${workspaceId}`);
        return true;
    }

    // Get recent workspaces (ones that were removed but still exist on disk)
    // Filters out any that are currently in the active workspaces list
    getRecentWorkspaces(): RecentWorkspace[] {
        const currentIds = new Set(this.config.workspaces.map(w => w.id));
        return this.config.recentWorkspaces
            .filter(w => !currentIds.has(w.id) && existsSync(w.id));
    }

    // Clear a specific recent workspace from history
    clearRecentWorkspace(id: string): boolean {
        const index = this.config.recentWorkspaces.findIndex(w => w.id === id);
        if (index === -1) return false;
        this.config.recentWorkspaces.splice(index, 1);
        this.saveConfig();
        return true;
    }

    // Clear all recent workspaces
    clearAllRecentWorkspaces(): void {
        this.config.recentWorkspaces = [];
        this.saveConfig();
    }

    // --- Workspace References ---

    getReferences(workspaceId: string): WorkspaceReference[] {
        const workspace = this.config.workspaces.find(w => w.id === workspaceId);
        return workspace?.references || [];
    }

    addReference(workspaceId: string, path: string, description?: string): WorkspaceReference {
        const workspace = this.config.workspaces.find(w => w.id === workspaceId);
        if (!workspace) {
            throw new Error(`Workspace not found: ${workspaceId}`);
        }

        const resolvedPath = resolve(path);

        // Validate directory exists
        if (!existsSync(resolvedPath)) {
            throw new Error(`Directory does not exist: ${resolvedPath}`);
        }

        if (!workspace.references) {
            workspace.references = [];
        }

        // Check for duplicates
        if (workspace.references.some(r => r.path === resolvedPath)) {
            throw new Error(`Reference already exists: ${resolvedPath}`);
        }

        // Don't allow self-reference
        if (resolvedPath === workspaceId) {
            throw new Error('Cannot reference the same workspace');
        }

        const reference: WorkspaceReference = {
            id: randomUUID(),
            path: resolvedPath,
            name: basename(resolvedPath) || resolvedPath,
            description,
        };

        workspace.references.push(reference);
        this.saveConfig();
        console.log(`[WorkspaceStore] Added reference ${reference.name} to workspace ${workspaceId}`);
        return reference;
    }

    removeReference(workspaceId: string, referenceId: string): boolean {
        const workspace = this.config.workspaces.find(w => w.id === workspaceId);
        if (!workspace || !workspace.references) return false;

        const index = workspace.references.findIndex(r => r.id === referenceId);
        if (index === -1) return false;

        const removed = workspace.references.splice(index, 1)[0];
        if (workspace.references.length === 0) {
            delete workspace.references;
        }
        this.saveConfig();
        console.log(`[WorkspaceStore] Removed reference ${removed.name} from workspace ${workspaceId}`);
        return true;
    }

    // Remove reference by path (convenience for toggling workspace references)
    removeReferenceByPath(workspaceId: string, path: string): boolean {
        const workspace = this.config.workspaces.find(w => w.id === workspaceId);
        if (!workspace || !workspace.references) return false;

        const resolvedPath = resolve(path);
        const index = workspace.references.findIndex(r => r.path === resolvedPath);
        if (index === -1) return false;

        const removed = workspace.references.splice(index, 1)[0];
        if (workspace.references.length === 0) {
            delete workspace.references;
        }
        this.saveConfig();
        console.log(`[WorkspaceStore] Removed reference ${removed.name} from workspace ${workspaceId}`);
        return true;
    }

    // --- Last Browsed Path ---

    getLastBrowsedPath(): string | undefined {
        return this.config.lastBrowsedPath;
    }

    setLastBrowsedPath(path: string): void {
        this.config.lastBrowsedPath = path;
        this.saveConfig();
    }
}
