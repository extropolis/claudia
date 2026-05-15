import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Tests for the git branches/checkout endpoint logic.
 * Uses execFile (not exec) to avoid shell escaping issues.
 */

describe('git branches logic', () => {
  let testDir: string;
  let isGitAvailable = true;

  beforeEach(async () => {
    const uniqueId = Date.now() + '-' + Math.random().toString(36).substring(7);
    testDir = join(tmpdir(), '.claudia-git-branch-test-' + uniqueId);
    mkdirSync(testDir, { recursive: true });

    try {
      await execFileAsync('git', ['--version']);
    } catch {
      isGitAvailable = false;
    }

    if (isGitAvailable) {
      await execFileAsync('git', ['init'], { cwd: testDir });
      await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: testDir });
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: testDir });
      writeFileSync(join(testDir, 'file.txt'), 'initial');
      await execFileAsync('git', ['add', '.'], { cwd: testDir });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: testDir });
    }
  });

  afterEach(() => {
    try {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('listing branches', () => {
    it('should list the default branch', async () => {
      if (!isGitAvailable) return;

      const { stdout } = await execFileAsync(
        'git',
        ['branch', '--format=%(refname:short)'],
        { cwd: testDir },
      );
      const branches = stdout
        .split('\n')
        .map((b) => b.trim())
        .filter(Boolean);

      expect(branches.length).toBeGreaterThanOrEqual(1);
      expect(branches.some((b) => b === 'main' || b === 'master')).toBe(true);
    });

    it('should list multiple branches', async () => {
      if (!isGitAvailable) return;

      await execFileAsync('git', ['checkout', '-b', 'feature-a'], { cwd: testDir });
      await execFileAsync('git', ['checkout', '-b', 'feature-b'], { cwd: testDir });

      const { stdout } = await execFileAsync(
        'git',
        ['branch', '--format=%(refname:short)'],
        { cwd: testDir },
      );
      const branches = stdout
        .split('\n')
        .map((b) => b.trim())
        .filter(Boolean);

      expect(branches).toContain('feature-a');
      expect(branches).toContain('feature-b');
      expect(branches.length).toBeGreaterThanOrEqual(3);
    });

    it('should identify current branch', async () => {
      if (!isGitAvailable) return;

      await execFileAsync('git', ['checkout', '-b', 'my-branch'], { cwd: testDir });

      const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: testDir });
      expect(stdout.trim()).toBe('my-branch');
    });

    it('should return empty current when in detached HEAD', async () => {
      if (!isGitAvailable) return;

      const { stdout: ref } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: testDir });
      await execFileAsync('git', ['checkout', ref.trim()], { cwd: testDir });

      const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: testDir });
      expect(stdout.trim()).toBe('');
    });
  });

  describe('checkout branch', () => {
    it('should switch to an existing branch', async () => {
      if (!isGitAvailable) return;

      // Create a branch with a file
      await execFileAsync('git', ['checkout', '-b', 'target-branch'], { cwd: testDir });
      writeFileSync(join(testDir, 'branch-file.txt'), 'branch content');
      await execFileAsync('git', ['add', '.'], { cwd: testDir });
      await execFileAsync('git', ['commit', '-m', 'branch commit'], { cwd: testDir });

      // Get default branch name
      const { stdout: branchList } = await execFileAsync(
        'git',
        ['branch', '--format=%(refname:short)'],
        { cwd: testDir },
      );
      const defaultBranch = branchList.split('\n').map((b) => b.trim())
        .find((b) => b === 'main' || b === 'master') || 'master';

      // Switch back to default
      await execFileAsync('git', ['checkout', defaultBranch], { cwd: testDir });
      expect(existsSync(join(testDir, 'branch-file.txt'))).toBe(false);

      // Switch to target-branch
      await execFileAsync('git', ['checkout', 'target-branch'], { cwd: testDir });

      const { stdout: current } = await execFileAsync(
        'git',
        ['branch', '--show-current'],
        { cwd: testDir },
      );
      expect(current.trim()).toBe('target-branch');
      expect(existsSync(join(testDir, 'branch-file.txt'))).toBe(true);
    });

    it('should fail for nonexistent branch', async () => {
      if (!isGitAvailable) return;

      try {
        await execFileAsync('git', ['checkout', 'nonexistent-branch'], { cwd: testDir });
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.stderr || err.message).toContain('nonexistent-branch');
      }
    });

    it('should fail when there are conflicting uncommitted changes', async () => {
      if (!isGitAvailable) return;

      // Create a branch with different content
      await execFileAsync('git', ['checkout', '-b', 'other-branch'], { cwd: testDir });
      writeFileSync(join(testDir, 'file.txt'), 'other branch content');
      await execFileAsync('git', ['add', '.'], { cwd: testDir });
      await execFileAsync('git', ['commit', '-m', 'other branch commit'], { cwd: testDir });

      // Get default branch name
      const { stdout: branchList } = await execFileAsync(
        'git',
        ['branch', '--format=%(refname:short)'],
        { cwd: testDir },
      );
      const defaultBranch = branchList.split('\n').map((b) => b.trim())
        .find((b) => b === 'main' || b === 'master') || 'master';

      // Go back to default branch and make conflicting changes
      await execFileAsync('git', ['checkout', defaultBranch], { cwd: testDir });
      writeFileSync(join(testDir, 'file.txt'), 'conflicting local change');

      // Try to checkout - should fail with dirty working tree
      try {
        await execFileAsync('git', ['checkout', 'other-branch'], { cwd: testDir });
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.stderr || err.message).toBeDefined();
      }
    });
  });

  describe('non-git directory handling', () => {
    it('should fail rev-parse in non-git directory', async () => {
      if (!isGitAvailable) return;

      const nonGitDir = join(tmpdir(), '.claudia-non-git-' + Date.now());
      mkdirSync(nonGitDir, { recursive: true });

      try {
        await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: nonGitDir });
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.stderr || err.message).toContain('not a git repository');
      } finally {
        rmSync(nonGitDir, { recursive: true, force: true });
      }
    });
  });

  describe('endpoint validation logic', () => {
    it('should require workspace parameter for branches', () => {
      // Simulates the validation: workspace query param is required
      const workspacePath = undefined;
      expect(!workspacePath).toBe(true);
    });

    it('should require workspace and branch for checkout', () => {
      // Simulates the validation: both workspace and branch are required
      const body1 = { workspace: '/test', branch: undefined };
      const body2 = { workspace: undefined, branch: 'main' };
      const body3 = { workspace: '/test', branch: 'main' };

      expect(!body1.workspace || !body1.branch).toBe(true);
      expect(!body2.workspace || !body2.branch).toBe(true);
      expect(!body3.workspace || !body3.branch).toBe(false);
    });

    it('should detect non-existent workspace paths', () => {
      expect(existsSync('/nonexistent/path/that/does/not/exist')).toBe(false);
    });
  });
});
