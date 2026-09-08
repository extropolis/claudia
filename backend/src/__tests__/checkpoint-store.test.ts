import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { CheckpointStore } from '../checkpoint-store.js';

const execAsync = promisify(exec);

describe('CheckpointStore', () => {
  let testDir: string;
  let storeDir: string;
  let store: CheckpointStore;
  let isGitAvailable = true;

  beforeEach(async () => {
    const uniqueId = Date.now() + '-' + Math.random().toString(36).substring(7);
    testDir = join(tmpdir(), '.claudia-checkpoint-test-' + uniqueId);
    storeDir = join(tmpdir(), '.claudia-checkpoint-store-' + uniqueId);
    mkdirSync(testDir, { recursive: true });
    mkdirSync(storeDir, { recursive: true });

    try {
      await execAsync('git --version');
    } catch {
      isGitAvailable = false;
    }

    if (isGitAvailable) {
      await execAsync('git init', { cwd: testDir });
      await execAsync('git config user.email "test@test.com"', { cwd: testDir });
      await execAsync('git config user.name "Test"', { cwd: testDir });
      writeFileSync(join(testDir, 'file.txt'), 'initial content');
      await execAsync('git add . && git commit -m "initial"', { cwd: testDir });
    }

    // Use a separate store directory so checkpoints.json doesn't end up in the git repo
    store = new CheckpointStore(storeDir);
  });

  afterEach(() => {
    try {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
      if (existsSync(storeDir)) {
        rmSync(storeDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('createCheckpoint', () => {
    it('should create a checkpoint with auto-generated name', async () => {
      if (!isGitAvailable) return;

      const checkpoint = await store.createCheckpoint('task-1', testDir);

      expect(checkpoint.id).toBeDefined();
      expect(checkpoint.taskId).toBe('task-1');
      expect(checkpoint.workspaceId).toBe(testDir);
      expect(checkpoint.name).toContain('Checkpoint');
      expect(checkpoint.timestamp).toBeDefined();
      expect(checkpoint.gitRef).toBeDefined();
      expect(checkpoint.gitBranch).toBeDefined();
    });

    it('should create a checkpoint with custom name and description', async () => {
      if (!isGitAvailable) return;

      const checkpoint = await store.createCheckpoint(
        'task-1',
        testDir,
        'Before refactor',
        'State before the big refactoring pass',
      );

      expect(checkpoint.name).toBe('Before refactor');
      expect(checkpoint.description).toBe('State before the big refactoring pass');
    });

    it('should capture git ref and branch', async () => {
      if (!isGitAvailable) return;

      const { stdout: headRef } = await execAsync('git rev-parse HEAD', { cwd: testDir });
      const checkpoint = await store.createCheckpoint('task-1', testDir);

      expect(checkpoint.gitRef).toBe(headRef.trim());
      expect(['main', 'master']).toContain(checkpoint.gitBranch);
    });

    it('should capture uncommitted diff', async () => {
      if (!isGitAvailable) return;

      writeFileSync(join(testDir, 'file.txt'), 'modified content');
      const checkpoint = await store.createCheckpoint('task-1', testDir);

      expect(checkpoint.gitDiff).toBeDefined();
      expect(checkpoint.gitDiff).toContain('modified content');
      expect(checkpoint.metadata?.filesModified).toBe(1);
    });

    it('should record 0 filesModified when no uncommitted changes', async () => {
      if (!isGitAvailable) return;

      const checkpoint = await store.createCheckpoint('task-1', testDir);
      expect(checkpoint.metadata?.filesModified).toBe(0);
      expect(checkpoint.gitDiff).toBeUndefined();
    });

    it('should handle non-git directories gracefully', async () => {
      // Create a dir outside any git repo
      const nonGitDir = join(tmpdir(), '.claudia-non-git-' + Date.now());
      mkdirSync(nonGitDir, { recursive: true });

      try {
        const checkpoint = await store.createCheckpoint('task-1', nonGitDir);

        expect(checkpoint.id).toBeDefined();
        expect(checkpoint.gitRef).toBeUndefined();
        expect(checkpoint.gitBranch).toBeUndefined();
        expect(checkpoint.gitDiff).toBeUndefined();
      } finally {
        rmSync(nonGitDir, { recursive: true, force: true });
      }
    });
  });

  describe('listCheckpoints', () => {
    it('should return empty array for unknown task', () => {
      const checkpoints = store.listCheckpoints('nonexistent');
      expect(checkpoints).toEqual([]);
    });

    it('should list checkpoints for a specific task in descending order', async () => {
      if (!isGitAvailable) return;

      await store.createCheckpoint('task-1', testDir, 'First');
      await new Promise((r) => setTimeout(r, 10));
      await store.createCheckpoint('task-1', testDir, 'Second');

      const checkpoints = store.listCheckpoints('task-1');
      expect(checkpoints).toHaveLength(2);
      expect(checkpoints[0].name).toBe('Second');
      expect(checkpoints[1].name).toBe('First');
    });

    it('should not include checkpoints from other tasks', async () => {
      if (!isGitAvailable) return;

      await store.createCheckpoint('task-1', testDir, 'Task 1 checkpoint');
      await store.createCheckpoint('task-2', testDir, 'Task 2 checkpoint');

      const task1Checkpoints = store.listCheckpoints('task-1');
      expect(task1Checkpoints).toHaveLength(1);
      expect(task1Checkpoints[0].name).toBe('Task 1 checkpoint');
    });
  });

  describe('listCheckpointsByWorkspace', () => {
    it('should list all checkpoints for a workspace across tasks', async () => {
      if (!isGitAvailable) return;

      await store.createCheckpoint('task-1', testDir, 'From task 1');
      await store.createCheckpoint('task-2', testDir, 'From task 2');

      const checkpoints = store.listCheckpointsByWorkspace(testDir);
      expect(checkpoints).toHaveLength(2);
    });

    it('should return empty array for unknown workspace', () => {
      const checkpoints = store.listCheckpointsByWorkspace('/nonexistent');
      expect(checkpoints).toEqual([]);
    });
  });

  describe('getCheckpoint', () => {
    it('should return a specific checkpoint by id', async () => {
      if (!isGitAvailable) return;

      const created = await store.createCheckpoint('task-1', testDir, 'Test');
      const fetched = store.getCheckpoint(created.id);

      expect(fetched).toBeDefined();
      expect(fetched?.id).toBe(created.id);
      expect(fetched?.name).toBe('Test');
    });

    it('should return undefined for unknown id', () => {
      expect(store.getCheckpoint('nonexistent')).toBeUndefined();
    });
  });

  describe('deleteCheckpoint', () => {
    it('should delete a checkpoint and return true', async () => {
      if (!isGitAvailable) return;

      const checkpoint = await store.createCheckpoint('task-1', testDir, 'To delete');
      const result = store.deleteCheckpoint(checkpoint.id);

      expect(result).toBe(true);
      expect(store.getCheckpoint(checkpoint.id)).toBeUndefined();
      expect(store.listCheckpoints('task-1')).toHaveLength(0);
    });

    it('should return false for nonexistent checkpoint', () => {
      expect(store.deleteCheckpoint('nonexistent')).toBe(false);
    });
  });

  describe('deleteCheckpointsForTask', () => {
    it('should delete all checkpoints for a task', async () => {
      if (!isGitAvailable) return;

      await store.createCheckpoint('task-1', testDir, 'First');
      await store.createCheckpoint('task-1', testDir, 'Second');
      await store.createCheckpoint('task-2', testDir, 'Other task');

      const removed = store.deleteCheckpointsForTask('task-1');

      expect(removed).toBe(2);
      expect(store.listCheckpoints('task-1')).toHaveLength(0);
      expect(store.listCheckpoints('task-2')).toHaveLength(1);
    });

    it('should return 0 if task has no checkpoints', () => {
      expect(store.deleteCheckpointsForTask('nonexistent')).toBe(0);
    });
  });

  describe('restoreCheckpoint', () => {
    it('should fail for nonexistent checkpoint', async () => {
      const result = await store.restoreCheckpoint('nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Checkpoint not found');
    });

    it('should fail if checkpoint has no git reference', async () => {
      // Create a non-git workspace checkpoint
      const nonGitDir = join(tmpdir(), '.claudia-non-git-restore-' + Date.now());
      mkdirSync(nonGitDir, { recursive: true });

      try {
        const checkpoint = await store.createCheckpoint('task-1', nonGitDir, 'No git');
        const result = await store.restoreCheckpoint(checkpoint.id);

        // Either "not a git repo" or "no git reference" depending on order of checks
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      } finally {
        rmSync(nonGitDir, { recursive: true, force: true });
      }
    });

    it('should restore to a previous commit state', async () => {
      if (!isGitAvailable) return;

      const checkpoint = await store.createCheckpoint('task-1', testDir, 'Initial');

      // Make a new commit
      writeFileSync(join(testDir, 'new-file.txt'), 'new content');
      await execAsync('git add . && git commit -m "second commit"', { cwd: testDir });

      const result = await store.restoreCheckpoint(checkpoint.id);
      expect(result.success).toBe(true);

      expect(existsSync(join(testDir, 'new-file.txt'))).toBe(false);
    });
  });

  describe('forkFromCheckpoint', () => {
    it('should fail for nonexistent checkpoint', async () => {
      const result = await store.forkFromCheckpoint('nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Checkpoint not found');
    });

    it('should create a new branch from checkpoint', async () => {
      if (!isGitAvailable) return;

      const checkpoint = await store.createCheckpoint('task-1', testDir, 'Fork point');

      // Make another commit on current branch
      writeFileSync(join(testDir, 'extra.txt'), 'extra');
      await execAsync('git add . && git commit -m "extra"', { cwd: testDir });

      const result = await store.forkFromCheckpoint(checkpoint.id, 'my-fork-branch');
      expect(result.success).toBe(true);
      expect(result.branch).toBe('my-fork-branch');

      // Verify we're on the new branch
      const { stdout } = await execAsync('git branch --show-current', { cwd: testDir });
      expect(stdout.trim()).toBe('my-fork-branch');

      // The extra file should not exist on this branch
      expect(existsSync(join(testDir, 'extra.txt'))).toBe(false);
    });

    it('should auto-generate branch name when not provided', async () => {
      if (!isGitAvailable) return;

      const checkpoint = await store.createCheckpoint('task-1', testDir, 'Auto fork');
      const result = await store.forkFromCheckpoint(checkpoint.id);

      expect(result.success).toBe(true);
      expect(result.branch).toContain('checkpoint-fork-');
    });
  });

  describe('persistence', () => {
    it('should persist checkpoints across store instances', async () => {
      if (!isGitAvailable) return;

      await store.createCheckpoint('task-1', testDir, 'Persisted');

      // Create a new store instance pointing to the same file
      const newStore = new CheckpointStore(storeDir);
      const checkpoints = newStore.listCheckpoints('task-1');

      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].name).toBe('Persisted');
    });
  });
});
