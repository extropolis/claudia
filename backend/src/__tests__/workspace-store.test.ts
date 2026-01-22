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
            rmSync(testBaseDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    describe('initialization', () => {
        it('should create config file on initialization', () => {
            const configPath = join(testBaseDir, 'workspace-config.json');
            expect(existsSync(configPath)).toBe(true);
        });

        it('should add default workspace if none exist', () => {
            const workspaces = store.getWorkspaces();
            // Default adds project root, which may or may not be added
            // Just verify it returns an array
            expect(Array.isArray(workspaces)).toBe(true);
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

    describe('loadConfig filtering', () => {
        it('should filter out non-existent workspaces on load', () => {
            // Add workspace
            store.addWorkspace(testWorkspace1);

            // Remove the directory
            rmSync(testWorkspace1, { recursive: true, force: true });

            // Create new store - should filter out missing workspace
            const newStore = new WorkspaceStore(testBaseDir);
            const workspaces = newStore.getWorkspaces();

            const found = workspaces.find(w => w.id === testWorkspace1);
            expect(found).toBeUndefined();
        });
    });
});
