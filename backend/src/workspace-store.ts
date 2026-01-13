/**
 * Workspace Store - Manages workspace directories
 * Workspaces are simply folder paths - the name comes from the folder name
 */
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { Workspace } from '@claudia/shared';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface WorkspaceConfig {
    workspaces: Workspace[];
    activeWorkspaceId: string | null;
}

const DEFAULT_CONFIG: WorkspaceConfig = {
    workspaces: [],
    activeWorkspaceId: null
};

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
            name: resolvedPath.split('/').pop() || resolvedPath,
            projects: [], // Not used in simplified model
            createdAt: new Date().toISOString()
        };

        this.config.workspaces.push(workspace);

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

        this.config.workspaces.splice(index, 1);

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
}
