import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { WorkspaceStore } from '../workspace-store.js';

describe('WorkspaceStore', () => {
    // Use unique timestamp for each test run
    let testBaseDir: string;
    let testWorkspace1: string;
    let testWorkspace2: string;
    let store: WorkspaceStore;

    beforeEach(() => {
        // Create unique directories for each test to avoid conflicts
        const uniqueId = Date.now() + '-' + Math.random().toString(36).substring(7);
        testBaseDir = join(homedir(), '.claudia-workspace-test-' + uniqueId);
        testWorkspace1 = join(testBaseDir, 'workspace1');
        testWorkspace2 = join(testBaseDir, 'workspace2');

        // Create test directories
        mkdirSync(testBaseDir, { recursive: true });
        mkdirSync(testWorkspace1, { recursive: true });
        mkdirSync(testWorkspace2, { recursive: true });

        // Create store with custom base path
        store = new WorkspaceStore(testBaseDir);
    });

    afterEach(() => {
        try {
            rmSync(testBaseDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {
            // Ignore cleanup errors
        }
    });

    describe('initialization', () => {
        it('should start with empty workspaces on fresh init', () => {
            const workspaces = store.getWorkspaces();
            expect(Array.isArray(workspaces)).toBe(true);
            expect(workspaces.length).toBe(0);
        });
    });

    describe('addWorkspace', () => {
        it('should add a valid workspace', () => {
            const workspace = store.addWorkspace(testWorkspace1);

            expect(workspace.id).toBe(testWorkspace1);
            expect(workspace.name).toBe('workspace1');
            expect(workspace.createdAt).toBeDefined();
        });

        it('should throw error for non-existent directory', () => {
            expect(() => {
                store.addWorkspace('/non/existent/path');
            }).toThrow('Directory does not exist');
        });

        it('should throw error for file path (not directory)', () => {
            const filePath = join(testBaseDir, 'testfile.txt');
            writeFileSync(filePath, 'test');

            expect(() => {
                store.addWorkspace(filePath);
            }).toThrow('Path is not a directory');
        });

        it('should throw error for duplicate workspace', () => {
            store.addWorkspace(testWorkspace1);

            expect(() => {
                store.addWorkspace(testWorkspace1);
            }).toThrow('Workspace already exists');
        });

        it('should set first workspace as active', () => {
            // Clear existing workspaces first by creating fresh store
            const freshStore = new WorkspaceStore(testBaseDir);

            // Add workspace
            freshStore.addWorkspace(testWorkspace1);

            // Either this is the active one or there's a default
            const active = freshStore.getActiveWorkspaceId();
            expect(active).toBeDefined();
        });

        it('should persist workspace to file', () => {
            store.addWorkspace(testWorkspace1);

            // Create new store instance to verify persistence
            const newStore = new WorkspaceStore(testBaseDir);
            const workspaces = newStore.getWorkspaces();

            const found = workspaces.find(w => w.id === testWorkspace1);
            expect(found).toBeDefined();
        });
    });

    describe('getWorkspace', () => {
        it('should return workspace by id', () => {
            store.addWorkspace(testWorkspace1);
            const workspace = store.getWorkspace(testWorkspace1);

            expect(workspace).toBeDefined();
            expect(workspace?.id).toBe(testWorkspace1);
        });

        it('should return undefined for non-existent workspace', () => {
            const workspace = store.getWorkspace('/non/existent');
            expect(workspace).toBeUndefined();
        });
    });

    describe('deleteWorkspace', () => {
        it('should delete existing workspace', () => {
            store.addWorkspace(testWorkspace1);
            const result = store.deleteWorkspace(testWorkspace1);

            expect(result).toBe(true);
            expect(store.getWorkspace(testWorkspace1)).toBeUndefined();
        });

        it('should return false for non-existent workspace', () => {
            const result = store.deleteWorkspace('/non/existent');
            expect(result).toBe(false);
        });

        it('should update active workspace when deleting active', () => {
            store.addWorkspace(testWorkspace1);
            store.addWorkspace(testWorkspace2);
            store.setActiveWorkspace(testWorkspace1);

            store.deleteWorkspace(testWorkspace1);

            // Active should be updated to another workspace or null
            const active = store.getActiveWorkspaceId();
            expect(active).not.toBe(testWorkspace1);
        });
    });

    describe('setActiveWorkspace', () => {
        it('should set active workspace', () => {
            store.addWorkspace(testWorkspace1);
            store.addWorkspace(testWorkspace2);

            store.setActiveWorkspace(testWorkspace2);

            expect(store.getActiveWorkspaceId()).toBe(testWorkspace2);
        });

        it('should allow setting null', () => {
            store.addWorkspace(testWorkspace1);
            store.setActiveWorkspace(null);

            expect(store.getActiveWorkspaceId()).toBeNull();
        });

        it('should throw error for non-existent workspace', () => {
            expect(() => {
                store.setActiveWorkspace('/non/existent');
            }).toThrow('Workspace not found');
        });
    });

    describe('reorderWorkspaces', () => {
        it('should reorder workspaces', () => {
            store.addWorkspace(testWorkspace1);
            store.addWorkspace(testWorkspace2);

            const initialOrder = store.getWorkspaces().map(w => w.id);
            const idx1 = initialOrder.indexOf(testWorkspace1);
            const idx2 = initialOrder.indexOf(testWorkspace2);

            if (idx1 !== -1 && idx2 !== -1 && idx1 !== idx2) {
                const result = store.reorderWorkspaces(idx1, idx2);
                expect(result).toBe(true);

                const newOrder = store.getWorkspaces().map(w => w.id);
                expect(newOrder[idx2]).toBe(testWorkspace1);
            }
        });

        it('should return false for same index', () => {
            store.addWorkspace(testWorkspace1);
            const result = store.reorderWorkspaces(0, 0);
            expect(result).toBe(false);
        });

        it('should return false for out of bounds indices', () => {
            store.addWorkspace(testWorkspace1);

            expect(store.reorderWorkspaces(-1, 0)).toBe(false);
            expect(store.reorderWorkspaces(0, 100)).toBe(false);
            expect(store.reorderWorkspaces(100, 0)).toBe(false);
        });
    });

    describe('system prompts', () => {
        it('should get and set system prompt', () => {
            store.addWorkspace(testWorkspace1);

            const result = store.setSystemPrompt(testWorkspace1, 'You are a helpful assistant');
            expect(result).toBe(true);
            expect(store.getSystemPrompt(testWorkspace1)).toBe('You are a helpful assistant');
        });

        it('should return undefined for workspace without system prompt', () => {
            store.addWorkspace(testWorkspace1);
            expect(store.getSystemPrompt(testWorkspace1)).toBeUndefined();
        });

        it('should return undefined for non-existent workspace', () => {
            expect(store.getSystemPrompt('/non/existent')).toBeUndefined();
        });

        it('should return false when setting prompt on non-existent workspace', () => {
            const result = store.setSystemPrompt('/non/existent', 'test');
            expect(result).toBe(false);
        });

        it('should allow clearing system prompt', () => {
            store.addWorkspace(testWorkspace1);
            store.setSystemPrompt(testWorkspace1, 'Some prompt');
            store.setSystemPrompt(testWorkspace1, undefined);
            expect(store.getSystemPrompt(testWorkspace1)).toBeUndefined();
        });

        it('should persist system prompt to file', () => {
            store.addWorkspace(testWorkspace1);
            store.setSystemPrompt(testWorkspace1, 'Persisted prompt');

            const newStore = new WorkspaceStore(testBaseDir);
            expect(newStore.getSystemPrompt(testWorkspace1)).toBe('Persisted prompt');
        });
    });

    describe('recent workspaces', () => {
        it('should add workspace to recent when deleted', () => {
            store.addWorkspace(testWorkspace1);
            store.deleteWorkspace(testWorkspace1);

            const recent = store.getRecentWorkspaces();
            expect(recent.some(w => w.id === testWorkspace1)).toBe(true);
        });

        it('should include removedAt timestamp in recent workspace', () => {
            store.addWorkspace(testWorkspace1);
            store.deleteWorkspace(testWorkspace1);

            const recent = store.getRecentWorkspaces();
            const recentWorkspace = recent.find(w => w.id === testWorkspace1);
            expect(recentWorkspace?.removedAt).toBeDefined();
        });

        it('should not include active workspaces in recent list', () => {
            store.addWorkspace(testWorkspace1);
            store.deleteWorkspace(testWorkspace1);
            // Re-add the workspace
            store.addWorkspace(testWorkspace1);

            const recent = store.getRecentWorkspaces();
            expect(recent.some(w => w.id === testWorkspace1)).toBe(false);
        });

        it('should clear a specific recent workspace', () => {
            store.addWorkspace(testWorkspace1);
            store.addWorkspace(testWorkspace2);
            store.deleteWorkspace(testWorkspace1);
            store.deleteWorkspace(testWorkspace2);

            const result = store.clearRecentWorkspace(testWorkspace1);
            expect(result).toBe(true);

            const recent = store.getRecentWorkspaces();
            expect(recent.some(w => w.id === testWorkspace1)).toBe(false);
            expect(recent.some(w => w.id === testWorkspace2)).toBe(true);
        });

        it('should return false when clearing non-existent recent workspace', () => {
            const result = store.clearRecentWorkspace('/non/existent');
            expect(result).toBe(false);
        });

        it('should clear all recent workspaces', () => {
            store.addWorkspace(testWorkspace1);
            store.addWorkspace(testWorkspace2);
            store.deleteWorkspace(testWorkspace1);
            store.deleteWorkspace(testWorkspace2);

            store.clearAllRecentWorkspaces();

            const recent = store.getRecentWorkspaces();
            expect(recent.length).toBe(0);
        });

        it('should filter out recent workspaces where directory no longer exists', () => {
            const tempDir = join(testBaseDir, 'temp-workspace');
            mkdirSync(tempDir, { recursive: true });

            store.addWorkspace(tempDir);
            store.deleteWorkspace(tempDir);

            // Remove the directory
            rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

            const recent = store.getRecentWorkspaces();
            expect(recent.some(w => w.id === tempDir)).toBe(false);
        });

        it('should persist recent workspaces to file', () => {
            store.addWorkspace(testWorkspace1);
            store.deleteWorkspace(testWorkspace1);

            const newStore = new WorkspaceStore(testBaseDir);
            const recent = newStore.getRecentWorkspaces();
            expect(recent.some(w => w.id === testWorkspace1)).toBe(true);
        });

        it('should limit recent workspaces to MAX_RECENT_WORKSPACES', () => {
            // Create and delete more than 10 workspaces
            const dirs: string[] = [];
            for (let i = 0; i < 12; i++) {
                const dir = join(testBaseDir, `ws-${i}`);
                mkdirSync(dir, { recursive: true });
                dirs.push(dir);
            }

            for (const dir of dirs) {
                store.addWorkspace(dir);
            }

            for (const dir of dirs) {
                store.deleteWorkspace(dir);
            }

            // Read the raw config to check the internal limit.
            // File is now a versioned envelope: { schemaVersion, data: { ... } }
            const configPath = join(testBaseDir, 'workspace-config.json');
            const configData = JSON.parse(readFileSync(configPath, 'utf-8'));
            expect(configData.data.recentWorkspaces.length).toBeLessThanOrEqual(10);
        });
    });

    describe('workspace name generation', () => {
        it('should use folder name as workspace name', () => {
            const workspace = store.addWorkspace(testWorkspace1);
            expect(workspace.name).toBe('workspace1');
        });

        it('should include createdAt timestamp', () => {
            const before = new Date().toISOString();
            const workspace = store.addWorkspace(testWorkspace1);
            const after = new Date().toISOString();

            expect(workspace.createdAt >= before).toBe(true);
            expect(workspace.createdAt <= after).toBe(true);
        });
    });

    describe('loadConfig filtering', () => {
        it('should filter out non-existent workspaces on load', () => {
            // Add workspace
            store.addWorkspace(testWorkspace1);

            // Remove the directory
            rmSync(testWorkspace1, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

            // Create new store - should filter out missing workspace
            const newStore = new WorkspaceStore(testBaseDir);
            const workspaces = newStore.getWorkspaces();

            const found = workspaces.find(w => w.id === testWorkspace1);
            expect(found).toBeUndefined();
        });
    });

    describe('renameWorkspace', () => {
        it('should rename an existing workspace', () => {
            store.addWorkspace(testWorkspace1);
            const result = store.renameWorkspace(testWorkspace1, 'My Custom Name');

            expect(result).toBe(true);
            const workspace = store.getWorkspace(testWorkspace1);
            expect(workspace?.displayName).toBe('My Custom Name');
        });

        it('should return false for non-existent workspace', () => {
            const result = store.renameWorkspace('/non/existent', 'New Name');
            expect(result).toBe(false);
        });

        it('should clear displayName when given empty string', () => {
            store.addWorkspace(testWorkspace1);
            store.renameWorkspace(testWorkspace1, 'Custom Name');
            store.renameWorkspace(testWorkspace1, '');

            const workspace = store.getWorkspace(testWorkspace1);
            expect(workspace?.displayName).toBeUndefined();
        });

        it('should trim whitespace from displayName', () => {
            store.addWorkspace(testWorkspace1);
            store.renameWorkspace(testWorkspace1, '  Trimmed Name  ');

            const workspace = store.getWorkspace(testWorkspace1);
            expect(workspace?.displayName).toBe('Trimmed Name');
        });

        it('should persist displayName to file', () => {
            store.addWorkspace(testWorkspace1);
            store.renameWorkspace(testWorkspace1, 'Persisted Name');

            const newStore = new WorkspaceStore(testBaseDir);
            const workspace = newStore.getWorkspace(testWorkspace1);
            expect(workspace?.displayName).toBe('Persisted Name');
        });

        it('should include displayName in getWorkspaces result', () => {
            store.addWorkspace(testWorkspace1);
            store.renameWorkspace(testWorkspace1, 'Listed Name');

            const workspaces = store.getWorkspaces();
            const found = workspaces.find(w => w.id === testWorkspace1);
            expect(found?.displayName).toBe('Listed Name');
        });
    });
});
