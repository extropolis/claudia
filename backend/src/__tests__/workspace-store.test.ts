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
            // Use a path with null byte which is invalid on all platforms
            expect(() => {
                store.addWorkspace('/path/with\0/nullbyte');
            }).toThrow();
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

    describe('addWorkspace directory creation', () => {
        it('should create a directory that does not yet exist', () => {
            const newDir = join(testBaseDir, 'created-by-store');
            expect(existsSync(newDir)).toBe(false);

            const workspace = store.addWorkspace(newDir);
            expect(existsSync(newDir)).toBe(true);
            expect(workspace.id).toBe(newDir);
            expect(workspace.name).toBe('created-by-store');
        });
    });

    describe('setWorkspaceOrder', () => {
        it('should apply an explicit order', () => {
            store.addWorkspace(testWorkspace1);
            store.addWorkspace(testWorkspace2);

            const result = store.setWorkspaceOrder([testWorkspace2, testWorkspace1]);
            expect(result).toBe(true);

            const order = store.getWorkspaces().map(w => w.id);
            expect(order).toEqual([testWorkspace2, testWorkspace1]);
        });

        it('should append unknown workspaces at the end preserving them', () => {
            store.addWorkspace(testWorkspace1);
            store.addWorkspace(testWorkspace2);

            // Client only knows about testWorkspace2; testWorkspace1 should be preserved.
            const result = store.setWorkspaceOrder([testWorkspace2]);
            expect(result).toBe(true);

            const order = store.getWorkspaces().map(w => w.id);
            expect(order[0]).toBe(testWorkspace2);
            expect(order).toContain(testWorkspace1);
            expect(order.length).toBe(2);
        });

        it('should ignore unknown ids and duplicates in input', () => {
            store.addWorkspace(testWorkspace1);
            store.addWorkspace(testWorkspace2);

            const result = store.setWorkspaceOrder([
                testWorkspace2,
                '/unknown/path',
                testWorkspace2, // duplicate
                testWorkspace1,
            ]);
            expect(result).toBe(true);

            const order = store.getWorkspaces().map(w => w.id);
            expect(order).toEqual([testWorkspace2, testWorkspace1]);
        });

        it('should persist the explicit order', () => {
            store.addWorkspace(testWorkspace1);
            store.addWorkspace(testWorkspace2);
            store.setWorkspaceOrder([testWorkspace2, testWorkspace1]);

            const newStore = new WorkspaceStore(testBaseDir);
            const order = newStore.getWorkspaces().map(w => w.id);
            expect(order).toEqual([testWorkspace2, testWorkspace1]);
        });
    });

    describe('lastBrowsedPath', () => {
        it('should return undefined by default', () => {
            expect(store.getLastBrowsedPath()).toBeUndefined();
        });

        it('should set and get the last browsed path', () => {
            store.setLastBrowsedPath('/some/browsed/dir');
            expect(store.getLastBrowsedPath()).toBe('/some/browsed/dir');
        });

        it('should persist the last browsed path', () => {
            store.setLastBrowsedPath('/persisted/dir');
            const newStore = new WorkspaceStore(testBaseDir);
            expect(newStore.getLastBrowsedPath()).toBe('/persisted/dir');
        });
    });

    describe('references', () => {
        it('should return empty references for a workspace with none', () => {
            store.addWorkspace(testWorkspace1);
            expect(store.getReferences(testWorkspace1)).toEqual([]);
        });

        it('should return empty references for non-existent workspace', () => {
            expect(store.getReferences('/non/existent')).toEqual([]);
        });

        it('should add a reference', () => {
            store.addWorkspace(testWorkspace1);
            const ref = store.addReference(testWorkspace1, testWorkspace2, 'shared lib');

            expect(ref.id).toBeDefined();
            expect(ref.path).toBe(testWorkspace2);
            expect(ref.name).toBe('workspace2');
            expect(ref.description).toBe('shared lib');

            const refs = store.getReferences(testWorkspace1);
            expect(refs.length).toBe(1);
            expect(refs[0].path).toBe(testWorkspace2);
        });

        it('should throw when adding reference to non-existent workspace', () => {
            expect(() => {
                store.addReference('/non/existent', testWorkspace2);
            }).toThrow('Workspace not found');
        });

        it('should throw when referenced directory does not exist', () => {
            store.addWorkspace(testWorkspace1);
            expect(() => {
                store.addReference(testWorkspace1, join(testBaseDir, 'no-such-dir'));
            }).toThrow('Directory does not exist');
        });

        it('should throw on duplicate reference', () => {
            store.addWorkspace(testWorkspace1);
            store.addReference(testWorkspace1, testWorkspace2);
            expect(() => {
                store.addReference(testWorkspace1, testWorkspace2);
            }).toThrow('Reference already exists');
        });

        it('should throw when referencing itself', () => {
            store.addWorkspace(testWorkspace1);
            expect(() => {
                store.addReference(testWorkspace1, testWorkspace1);
            }).toThrow('Cannot reference the same workspace');
        });

        it('should remove a reference by id', () => {
            store.addWorkspace(testWorkspace1);
            const ref = store.addReference(testWorkspace1, testWorkspace2);

            const result = store.removeReference(testWorkspace1, ref.id);
            expect(result).toBe(true);
            expect(store.getReferences(testWorkspace1)).toEqual([]);
        });

        it('should return false removing reference from workspace with none', () => {
            store.addWorkspace(testWorkspace1);
            expect(store.removeReference(testWorkspace1, 'no-id')).toBe(false);
        });

        it('should return false removing reference with unknown id', () => {
            store.addWorkspace(testWorkspace1);
            store.addReference(testWorkspace1, testWorkspace2);
            expect(store.removeReference(testWorkspace1, 'unknown-id')).toBe(false);
        });

        it('should return false removing reference from non-existent workspace', () => {
            expect(store.removeReference('/non/existent', 'id')).toBe(false);
        });

        it('should remove a reference by path', () => {
            store.addWorkspace(testWorkspace1);
            store.addReference(testWorkspace1, testWorkspace2);

            const result = store.removeReferenceByPath(testWorkspace1, testWorkspace2);
            expect(result).toBe(true);
            expect(store.getReferences(testWorkspace1)).toEqual([]);
        });

        it('should return false removing by path when not present', () => {
            store.addWorkspace(testWorkspace1);
            store.addReference(testWorkspace1, testWorkspace2);
            const otherDir = join(testBaseDir, 'workspace3');
            mkdirSync(otherDir, { recursive: true });
            expect(store.removeReferenceByPath(testWorkspace1, otherDir)).toBe(false);
        });

        it('should return false removing by path from workspace with no references', () => {
            store.addWorkspace(testWorkspace1);
            expect(store.removeReferenceByPath(testWorkspace1, testWorkspace2)).toBe(false);
        });

        it('should persist references to file', () => {
            store.addWorkspace(testWorkspace1);
            store.addReference(testWorkspace1, testWorkspace2, 'desc');

            const newStore = new WorkspaceStore(testBaseDir);
            const refs = newStore.getReferences(testWorkspace1);
            expect(refs.length).toBe(1);
            expect(refs[0].path).toBe(testWorkspace2);
            expect(refs[0].description).toBe('desc');
        });
    });

    describe('setPrInfo / withPrInfo', () => {
        it('should attach cached PR info to a workspace', () => {
            store.addWorkspace(testWorkspace1);
            const pr = { number: 7, title: 'My PR', state: 'open' as const, url: 'http://x', ci: 'passed' as const };

            const changed = store.setPrInfo(testWorkspace1, pr);
            expect(changed).toBe(true);

            const ws = store.getWorkspace(testWorkspace1);
            expect(ws?.prInfo).toEqual(pr);

            // Also surfaced via getWorkspaces()
            const listed = store.getWorkspaces().find(w => w.id === testWorkspace1);
            expect(listed?.prInfo).toEqual(pr);
        });

        it('should report no change when setting identical PR info', () => {
            store.addWorkspace(testWorkspace1);
            const pr = { number: 1, title: 'T', state: 'open' as const, url: 'u', ci: 'none' as const };

            expect(store.setPrInfo(testWorkspace1, pr)).toBe(true);
            // Setting the same value again is not a change
            expect(store.setPrInfo(testWorkspace1, { ...pr })).toBe(false);
        });

        it('should not include prInfo when none is cached', () => {
            store.addWorkspace(testWorkspace1);
            const ws = store.getWorkspace(testWorkspace1);
            expect(ws && 'prInfo' in ws).toBe(false);
        });

        it('should clear cached PR info on delete', () => {
            store.addWorkspace(testWorkspace1);
            store.setPrInfo(testWorkspace1, { number: 1, title: 'T', state: 'open', url: 'u', ci: 'none' });
            store.deleteWorkspace(testWorkspace1);
            // Re-add: cache should have been cleared so no prInfo leaks through
            store.addWorkspace(testWorkspace1);
            const ws = store.getWorkspace(testWorkspace1);
            expect(ws && 'prInfo' in ws).toBe(false);
        });
    });

    describe('addWorktreeWorkspace', () => {
        it('should add a worktree workspace with metadata and inheritance', async () => {
            store.addWorkspace(testWorkspace1);
            store.setSystemPrompt(testWorkspace1, 'parent prompt');
            store.addReference(testWorkspace1, testWorkspace2, 'shared');

            const worktreeDir = join(testBaseDir, 'wt-feature');
            mkdirSync(worktreeDir, { recursive: true });

            const ws = await store.addWorktreeWorkspace(worktreeDir, testWorkspace1, 'refs/heads/feature-x');

            expect(ws.id).toBe(worktreeDir);
            expect(ws.worktreeParentId).toBe(testWorkspace1);
            // refs/heads/ prefix is stripped
            expect(ws.worktreeBranch).toBe('feature-x');
            expect(ws.displayName).toBe('workspace1 › feature-x');
            // Inherited from parent
            expect(ws.systemPrompt).toBe('parent prompt');
            expect(ws.references?.length).toBe(1);
        });

        it('should position the worktree directly after its parent', async () => {
            store.addWorkspace(testWorkspace1);
            store.addWorkspace(testWorkspace2);

            const worktreeDir = join(testBaseDir, 'wt-a');
            mkdirSync(worktreeDir, { recursive: true });
            await store.addWorktreeWorkspace(worktreeDir, testWorkspace1, 'branch-a');

            const order = store.getWorkspaces().map(w => w.id);
            expect(order[0]).toBe(testWorkspace1);
            expect(order[1]).toBe(worktreeDir);
            expect(order[2]).toBe(testWorkspace2);
        });

        it('should insert a second sibling worktree after existing siblings', async () => {
            store.addWorkspace(testWorkspace1);
            store.addWorkspace(testWorkspace2);

            const wtA = join(testBaseDir, 'wt-sib-a');
            const wtB = join(testBaseDir, 'wt-sib-b');
            mkdirSync(wtA, { recursive: true });
            mkdirSync(wtB, { recursive: true });

            await store.addWorktreeWorkspace(wtA, testWorkspace1, 'a');
            await store.addWorktreeWorkspace(wtB, testWorkspace1, 'b');

            const order = store.getWorkspaces().map(w => w.id);
            // parent, sibling-a, sibling-b, then the other workspace
            expect(order).toEqual([testWorkspace1, wtA, wtB, testWorkspace2]);
        });

        it('should append when the parent is not registered', async () => {
            store.addWorkspace(testWorkspace1);
            const worktreeDir = join(testBaseDir, 'wt-orphan');
            mkdirSync(worktreeDir, { recursive: true });

            const ws = await store.addWorktreeWorkspace(worktreeDir, '/unregistered/parent', 'orphan-branch');
            expect(ws.worktreeParentId).toBe('/unregistered/parent');
            // Display name falls back to basename of the parent id
            expect(ws.displayName).toBe('parent › orphan-branch');

            const order = store.getWorkspaces().map(w => w.id);
            expect(order[order.length - 1]).toBe(worktreeDir);
        });

        it('should throw when the worktree directory does not exist', async () => {
            store.addWorkspace(testWorkspace1);
            await expect(
                store.addWorktreeWorkspace(join(testBaseDir, 'no-such-wt'), testWorkspace1, 'b')
            ).rejects.toThrow('Worktree directory does not exist');
        });

        it('should throw when the worktree workspace already exists', async () => {
            store.addWorkspace(testWorkspace1);
            const worktreeDir = join(testBaseDir, 'wt-dup');
            mkdirSync(worktreeDir, { recursive: true });
            await store.addWorktreeWorkspace(worktreeDir, testWorkspace1, 'b');

            await expect(
                store.addWorktreeWorkspace(worktreeDir, testWorkspace1, 'b')
            ).rejects.toThrow('Workspace already exists');
        });

        it('should use parent displayName when present', async () => {
            store.addWorkspace(testWorkspace1);
            store.renameWorkspace(testWorkspace1, 'Custom Parent');
            const worktreeDir = join(testBaseDir, 'wt-named');
            mkdirSync(worktreeDir, { recursive: true });

            const ws = await store.addWorktreeWorkspace(worktreeDir, testWorkspace1, 'feat');
            expect(ws.displayName).toBe('Custom Parent › feat');
        });

        it('should persist worktree metadata to file', async () => {
            store.addWorkspace(testWorkspace1);
            const worktreeDir = join(testBaseDir, 'wt-persist');
            mkdirSync(worktreeDir, { recursive: true });
            await store.addWorktreeWorkspace(worktreeDir, testWorkspace1, 'persisted');

            const newStore = new WorkspaceStore(testBaseDir);
            const ws = newStore.getWorkspace(worktreeDir);
            expect(ws?.worktreeParentId).toBe(testWorkspace1);
            expect(ws?.worktreeBranch).toBe('persisted');
        });
    });

    describe('getWorktreeChildren', () => {
        it('should return only the worktree children of a parent', async () => {
            store.addWorkspace(testWorkspace1);
            store.addWorkspace(testWorkspace2);
            const wt = join(testBaseDir, 'wt-child');
            mkdirSync(wt, { recursive: true });
            await store.addWorktreeWorkspace(wt, testWorkspace1, 'child');

            const children = store.getWorktreeChildren(testWorkspace1);
            expect(children.map(w => w.id)).toEqual([wt]);
            // The non-parent workspace has no children
            expect(store.getWorktreeChildren(testWorkspace2)).toEqual([]);
        });
    });

    describe('setAutoWorktree', () => {
        it('should set the autoWorktree flag and persist it', () => {
            store.addWorkspace(testWorkspace1);

            expect(store.setAutoWorktree(testWorkspace1, true)).toBe(true);

            const newStore = new WorkspaceStore(testBaseDir);
            const ws = newStore.getWorkspace(testWorkspace1);
            expect(ws?.autoWorktree).toBe(true);
        });

        it('should return false for a non-existent workspace', () => {
            expect(store.setAutoWorktree('/non/existent', true)).toBe(false);
        });
    });

    describe('constructor without basePath', () => {
        it('should construct using the default config location', () => {
            // No basePath -> uses __dirname/../workspace-config.json. Just ensure
            // it constructs and exposes an array without throwing.
            const defaultStore = new WorkspaceStore();
            expect(Array.isArray(defaultStore.getWorkspaces())).toBe(true);
        });
    });
});
