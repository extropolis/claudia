/**
 * Project Store - Manages current project directory and recent projects
 */
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { RecentProject } from '@claudia/shared';

export interface ProjectConfig {
    currentProject: string | null;
    recentProjects: RecentProject[];
}

const DEFAULT_CONFIG: ProjectConfig = {
    currentProject: null,
    recentProjects: []
};

const MAX_RECENT_PROJECTS = 10;

export class ProjectStore {
    private config: ProjectConfig;
    private projectFile: string;

    constructor(basePath?: string) {
        // Use basePath if provided (Electron userData), otherwise use default location
        this.projectFile = basePath
            ? join(basePath, 'project-config.json')
            : join(__dirname, '..', 'project-config.json');

        // Ensure directory exists
        if (basePath && !existsSync(basePath)) {
            mkdirSync(basePath, { recursive: true });
        }

        this.config = this.loadConfig();
    }

    private loadConfig(): ProjectConfig {
        try {
            if (existsSync(this.projectFile)) {
                const data = readFileSync(this.projectFile, 'utf-8');
                const loaded = JSON.parse(data) as ProjectConfig;
                // Validate that current project exists
                if (loaded.currentProject && !existsSync(loaded.currentProject)) {
                    loaded.currentProject = null;
                }
                // Filter out projects that no longer exist
                loaded.recentProjects = (loaded.recentProjects || []).filter(p =>
                    existsSync(p.path)
                );
                return loaded;
            }
        } catch (error) {
            console.error('[ProjectStore] Error loading config:', error);
        }
        return { ...DEFAULT_CONFIG };
    }

    private saveConfig(): void {
        try {
            writeFileSync(this.projectFile, JSON.stringify(this.config, null, 2), 'utf-8');
            console.log('[ProjectStore] Config saved to', this.projectFile);
        } catch (error) {
            console.error('[ProjectStore] Error saving config:', error);
            throw error;
        }
    }

    getCurrentProject(): string | null {
        return this.config.currentProject;
    }

    setCurrentProject(path: string): void {
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

        this.config.currentProject = resolvedPath;
        this.addToRecent(resolvedPath);
        this.saveConfig();
    }

    private addToRecent(path: string): void {
        const resolvedPath = resolve(path);
        const name = resolvedPath.split('/').pop() || resolvedPath;

        // Remove if already exists
        this.config.recentProjects = this.config.recentProjects.filter(
            p => p.path !== resolvedPath
        );

        // Add to front
        this.config.recentProjects.unshift({
            path: resolvedPath,
            name,
            lastAccessed: Date.now()
        });

        // Keep only MAX_RECENT_PROJECTS
        if (this.config.recentProjects.length > MAX_RECENT_PROJECTS) {
            this.config.recentProjects = this.config.recentProjects.slice(0, MAX_RECENT_PROJECTS);
        }
    }

    getRecentProjects(): RecentProject[] {
        return [...this.config.recentProjects];
    }

    removeFromRecent(path: string): void {
        const resolvedPath = resolve(path);
        this.config.recentProjects = this.config.recentProjects.filter(
            p => p.path !== resolvedPath
        );
        this.saveConfig();
    }

    clearRecent(): void {
        this.config.recentProjects = [];
        this.saveConfig();
    }
}
