/**
 * Workspace Store - Manages workspace directories
 * Workspaces are simply folder paths - the name comes from the folder name
 */
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'fs';
import { join, dirname, resolve, basename } from 'path';
import { fileURLToPath } from 'url';
import { Workspace, RecentWorkspace } from '@claudia/shared';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Re-export for convenience
export type { RecentWorkspace };

export interface WorkspaceConfig {
    workspaces: Workspace[];
    activeWorkspaceId: string | null;
    recentWorkspaces: RecentWorkspace[];  // Workspaces that have been removed (history)
}

const DEFAULT_CONFIG: WorkspaceConfig = {
    workspaces: [],
    activeWorkspaceId: null,
    recentWorkspaces: []
};

const MAX_RECENT_WORKSPACES = 10;  // Keep only the last 10 recent workspaces

export class WorkspaceStore {
    private config: WorkspaceConfig;
    private workspaceFile: string;

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

        // Add default workspace if none exist (project root - parent of backend/src)
        if (this.config.workspaces.length === 0) {
            const projectRoot = resolve(__dirname, '..', '..');
            this.addWorkspace(projectRoot);
        }
    }

    private loadConfig(): WorkspaceConfig {
        try {
            if (existsSync(this.workspaceFile)) {
                const data = readFileSync(this.workspaceFile, 'utf-8');
                const loaded = JSON.parse(data) as WorkspaceConfig;

                // Filter out workspaces that no longer exist
                loaded.workspaces = (loaded.workspaces || []).filter(w =>
                    existsSync(w.id)
                );

                // Initialize recentWorkspaces if not present
                if (!loaded.recentWorkspaces) {
                    loaded.recentWorkspaces = [];
                }

                return loaded;
            }
        } catch (error) {
            console.error('[WorkspaceStore] Error loading config:', error);
        }
        return { ...DEFAULT_CONFIG };
    }

    private saveConfig(): void {
        try {
            writeFileSync(this.workspaceFile, JSON.stringify(this.config, null, 2), 'utf-8');
            console.log('[WorkspaceStore] Config saved to', this.workspaceFile);
        } catch (error) {
            console.error('[WorkspaceStore] Error saving config:', error);
            throw error;
        }
    }

    getWorkspaces(): Workspace[] {
        return [...this.config.workspaces];
    }

    getWorkspace(id: string): Workspace | undefined {
        return this.config.workspaces.find(w => w.id === id);
    }

    // Add workspace by path - the id IS the path, name comes from folder
    addWorkspace(path: string): Workspace {
        const resolvedPath = resolve(path);

        // Validate directory exists
        if (!existsSync(resolvedPath)) {
            throw new Error(`Directory does not exist: ${resolvedPath}`);
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

    deleteWorkspace(id: string): boolean {
        const index = this.config.workspaces.findIndex(w => w.id === id);
        if (index === -1) return false;

        const workspace = this.config.workspaces[index];
        this.config.workspaces.splice(index, 1);

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
}
