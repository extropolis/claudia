import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
    isGitRepo,
    getHeadCommit,
    hasUncommittedChanges,
    getModifiedFiles,
    getFilesBetweenCommits,
    countCommitsBetween,
    commitExists,
    captureGitStateBefore,
    captureGitStateAfter,
    revertTaskChanges,
} from '../git-utils.js';

const execAsync = promisify(exec);

describe('git-utils', () => {
    let testDir: string;
    let isGitAvailable = true;

    beforeEach(async () => {
        // Use unique directory for each test
        const uniqueId = Date.now() + '-' + Math.random().toString(36).substring(7);
        testDir = join(homedir(), '.claudia-git-test-' + uniqueId);
        mkdirSync(testDir, { recursive: true });

        // Check if git is available
        try {
            await execAsync('git --version');
        } catch {
            isGitAvailable = false;
        }
    });

    afterEach(() => {
        try {
            rmSync(testDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    // Helper to init git repo
    async function initGitRepo(): Promise<void> {
        await execAsync('git init', { cwd: testDir });
        await execAsync('git config user.email "test@test.com"', { cwd: testDir });
        await execAsync('git config user.name "Test User"', { cwd: testDir });
    }

    // Helper to create a commit
    async function createCommit(message: string): Promise<string> {
        const filename = `file-${Date.now()}.txt`;
        writeFileSync(join(testDir, filename), `Content for ${message}`);
        await execAsync(`git add ${filename}`, { cwd: testDir });
        await execAsync(`git commit -m "${message}"`, { cwd: testDir });
        const { stdout } = await execAsync('git rev-parse HEAD', { cwd: testDir });
        return stdout.trim();
    }

    describe('isGitRepo', () => {
        it('should return false for non-git directory', async () => {
            if (!isGitAvailable) return;
            const result = await isGitRepo(testDir);
            expect(result).toBe(false);
        });

        it('should return true for git directory', async () => {
            if (!isGitAvailable) return;
            await initGitRepo();
            const result = await isGitRepo(testDir);
            expect(result).toBe(true);
        });

        it('should return false for non-existent directory', async () => {
            const result = await isGitRepo('/non/existent/path');
            expect(result).toBe(false);
        });
    });

    describe('getHeadCommit', () => {
        it('should return null for non-git directory', async () => {
            if (!isGitAvailable) return;
            const result = await getHeadCommit(testDir);
            expect(result).toBeNull();
        });

        it('should return null for empty git repo (no commits)', async () => {
            if (!isGitAvailable) return;
            await initGitRepo();
            const result = await getHeadCommit(testDir);
            expect(result).toBeNull();
        });

        it('should return commit hash', async () => {
            if (!isGitAvailable) return;
            await initGitRepo();
            const commitHash = await createCommit('Initial commit');

            const result = await getHeadCommit(testDir);
            expect(result).toBe(commitHash);
        });
    });

    describe('hasUncommittedChanges', () => {
        it('should return false for clean repo', async () => {
            if (!isGitAvailable) return;
            await initGitRepo();
            await createCommit('Initial commit');

            const result = await hasUncommittedChanges(testDir);
            expect(result).toBe(false);
        });

        it('should return true for modified files', async () => {
            if (!isGitAvailable) return;
            await initGitRepo();
            await createCommit('Initial commit');

            // Modify a file
            writeFileSync(join(testDir, 'new-file.txt'), 'new content');

            const result = await hasUncommittedChanges(testDir);
            expect(result).toBe(true);
        });

        it('should return false for non-git directory', async () => {
            if (!isGitAvailable) return;
            const result = await hasUncommittedChanges(testDir);
            expect(result).toBe(false);
        });
    });

    describe('getModifiedFiles', () => {
        it('should return empty array for clean repo', async () => {
            if (!isGitAvailable) return;
            await initGitRepo();
            await createCommit('Initial commit');

            const result = await getModifiedFiles(testDir);
            expect(result).toEqual([]);
        });

        it('should return modified files', async () => {
            if (!isGitAvailable) return;
            await initGitRepo();
            await createCommit('Initial commit');

            // Create untracked file
            writeFileSync(join(testDir, 'untracked.txt'), 'content');

            const result = await getModifiedFiles(testDir);
            expect(result).toContain('untracked.txt');
        });
    });

    describe('getFilesBetweenCommits', () => {
        it('should return changed files between commits', async () => {
            if (!isGitAvailable) return;
            await initGitRepo();
            const commit1 = await createCommit('First commit');
            const commit2 = await createCommit('Second commit');

            const result = await getFilesBetweenCommits(testDir, commit1, commit2);
            expect(result.length).toBeGreaterThan(0);
        });

        it('should return empty array for same commit', async () => {
            if (!isGitAvailable) return;
            await initGitRepo();
            const commit1 = await createCommit('First commit');

            const result = await getFilesBetweenCommits(testDir, commit1, commit1);
            expect(result).toEqual([]);
        });
    });

    describe('countCommitsBetween', () => {
        it('should count commits between two commits', async () => {
            if (!isGitAvailable) return;
            await initGitRepo();
            const commit1 = await createCommit('First commit');
            await createCommit('Second commit');
            const commit3 = await createCommit('Third commit');

            const result = await countCommitsBetween(testDir, commit1, commit3);
            expect(result).toBe(2);
        });

        it('should return 0 for same commit', async () => {
            if (!isGitAvailable) return;
            await initGitRepo();
            const commit1 = await createCommit('First commit');

            const result = await countCommitsBetween(testDir, commit1, commit1);
            expect(result).toBe(0);
        });

        it('should return -1 for invalid commits', async () => {
            if (!isGitAvailable) return;
            await initGitRepo();
            await createCommit('First commit');

            const result = await countCommitsBetween(testDir, 'invalid', 'also-invalid');
            expect(result).toBe(-1);
        });
    });

    describe('commitExists', () => {
        it('should return true for existing commit', async () => {
            if (!isGitAvailable) return;
            await initGitRepo();
            const commit = await createCommit('Test commit');

            const result = await commitExists(testDir, commit);
            expect(result).toBe(true);
        });

        it('should return false for non-existent commit', async () => {
            if (!isGitAvailable) return;
            await initGitRepo();
            await createCommit('Test commit');

            const result = await commitExists(testDir, 'nonexistent123456');
            expect(result).toBe(false);
        });
    });

    describe('captureGitStateBefore', () => {
        it('should return null for non-git directory', async () => {
            if (!isGitAvailable) return;
            const result = await captureGitStateBefore(testDir);
            expect(result).toBeNull();
        });

        it('should return null for empty git repo', async () => {
            if (!isGitAvailable) return;
            await initGitRepo();
            const result = await captureGitStateBefore(testDir);
            expect(result).toBeNull();
        });

        it('should capture git state with commit', async () => {
            if (!isGitAvailable) return;
            await initGitRepo();
            const commit = await createCommit('Initial commit');

            const result = await captureGitStateBefore(testDir);
            expect(result).not.toBeNull();
            expect(result?.commitBefore).toBe(commit);
            expect(result?.uncommittedBefore).toBe(false);
            expect(result?.canRevert).toBe(true);
        });

        it('should detect uncommitted changes', async () => {
            if (!isGitAvailable) return;
            await initGitRepo();
            await createCommit('Initial commit');
            writeFileSync(join(testDir, 'uncommitted.txt'), 'content');

            const result = await captureGitStateBefore(testDir);
            expect(result?.uncommittedBefore).toBe(true);
        });
    });

    describe('captureGitStateAfter', () => {
        it('should capture after state', async () => {
            if (!isGitAvailable) return;
            await initGitRepo();
            const beforeCommit = await createCommit('Before commit');
            const beforeState = { commitBefore: beforeCommit, uncommittedBefore: false };

            // Make changes
            const afterCommit = await createCommit('After commit');

            const result = await captureGitStateAfter(testDir, beforeState);
            expect(result.commitBefore).toBe(beforeCommit);
            expect(result.commitAfter).toBe(afterCommit);
            expect(result.filesModified.length).toBeGreaterThan(0);
            expect(result.canRevert).toBe(true);
        });

        it('should detect cannot revert when uncommitted before', async () => {
            if (!isGitAvailable) return;
            await initGitRepo();
            const beforeCommit = await createCommit('Before commit');

            // Simulate there were uncommitted changes before
            const beforeState = { commitBefore: beforeCommit, uncommittedBefore: true };

            // Make new commit
            await createCommit('After commit');

            const result = await captureGitStateAfter(testDir, beforeState);
            // canRevert should be false because uncommittedBefore was true AND commit changed
            expect(result.canRevert).toBe(false);
        });
    });

    describe('revertTaskChanges', () => {
        it('should refuse to revert when canRevert is false', async () => {
            if (!isGitAvailable) return;
            const gitState = {
                commitBefore: 'abc123',
                uncommittedBefore: true,
                filesModified: [],
                canRevert: false,
            };

            const result = await revertTaskChanges(testDir, gitState);
            expect(result.success).toBe(false);
            expect(result.error).toContain('uncommitted changes before');
        });

        it('should revert commits successfully', async () => {
            if (!isGitAvailable) return;
            await initGitRepo();
            const beforeCommit = await createCommit('Before commit');
            await createCommit('After commit 1');
            await createCommit('After commit 2');

            const gitState = {
                commitBefore: beforeCommit,
                uncommittedBefore: false,
                filesModified: ['file1.txt', 'file2.txt'],
                canRevert: true,
            };

            const result = await revertTaskChanges(testDir, gitState);
            expect(result.success).toBe(true);

            // Verify HEAD is now at beforeCommit
            const currentHead = await getHeadCommit(testDir);
            expect(currentHead).toBe(beforeCommit);
        });

        it('should refuse to revert too many commits', async () => {
            if (!isGitAvailable) return;
            await initGitRepo();
            const beforeCommit = await createCommit('Before commit');

            // Create many commits
            for (let i = 0; i < 10; i++) {
                await createCommit(`Commit ${i}`);
            }

            const gitState = {
                commitBefore: beforeCommit,
                uncommittedBefore: false,
                filesModified: [],
                canRevert: true,
            };

            const result = await revertTaskChanges(testDir, gitState);
            expect(result.success).toBe(false);
            expect(result.error).toContain('would undo');
        });

        it('should refuse if commit no longer exists', async () => {
            if (!isGitAvailable) return;
            await initGitRepo();
            await createCommit('Commit');

            const gitState = {
                commitBefore: 'nonexistent123456789',
                uncommittedBefore: false,
                filesModified: [],
                canRevert: true,
            };

            const result = await revertTaskChanges(testDir, gitState);
            expect(result.success).toBe(false);
            expect(result.error).toContain('no longer exists');
        });
    });
});
