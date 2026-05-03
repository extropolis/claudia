/**
 * Checkpoint Store - Manages checkpoint/timeline snapshots for tasks.
 * Captures git state (commit SHA, branch, uncommitted diff) and allows
 * restoring or forking from a previous checkpoint.
 */
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Checkpoint } from '@claudia/shared';
import { loadVersioned, saveVersioned } from './utils/schema-version.js';
import { isGitRepo, getHeadCommit, getCurrentBranch } from './git-utils.js';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Schema version for checkpoints.json */
const CHECKPOINT_SCHEMA_VERSION = 1;

interface CheckpointData {
    checkpoints: Checkpoint[];
}

const DEFAULT_DATA: CheckpointData = {
    checkpoints: [],
};

export class CheckpointStore {
    private data: CheckpointData;
    private filePath: string;

    constructor(basePath?: string) {
        this.filePath = basePath
            ? join(basePath, 'checkpoints.json')
            : join(__dirname, '..', 'checkpoints.json');

        // Ensure directory exists
        const dir = dirname(this.filePath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        this.data = this.loadData();
        console.log(`[CheckpointStore] Loaded ${this.data.checkpoints.length} checkpoints from ${this.filePath}`);
    }

    private loadData(): CheckpointData {
        try {
            return loadVersioned<CheckpointData>(this.filePath, {
                currentVersion: CHECKPOINT_SCHEMA_VERSION,
                defaultData: { ...DEFAULT_DATA },
                legacyLoader: (raw) => (raw as CheckpointData) ?? { ...DEFAULT_DATA },
            });
        } catch (error) {
            console.error('[CheckpointStore] Error loading data:', error);
            return { ...DEFAULT_DATA };
        }
    }

    private save(): void {
        try {
            saveVersioned(this.filePath, this.data, CHECKPOINT_SCHEMA_VERSION);
        } catch (error) {
            console.error('[CheckpointStore] Error saving data:', error);
            throw error;
        }
    }

    /**
     * Create a checkpoint for a task by capturing the current git state.
     */
    async createCheckpoint(
        taskId: string,
        workspaceId: string,
        name?: string,
        description?: string
    ): Promise<Checkpoint> {
        const cwd = workspaceId; // workspaceId IS the directory path

        let gitRef: string | undefined;
        let gitBranch: string | undefined;
        let gitDiff: string | undefined;
        let filesModified = 0;

        const isRepo = await isGitRepo(cwd);
        if (isRepo) {
            gitRef = (await getHeadCommit(cwd)) || undefined;
            gitBranch = (await getCurrentBranch(cwd)) || undefined;

            // Capture uncommitted diff (both staged and unstaged)
            try {
                const { stdout: diffOut } = await execAsync('git diff HEAD', { cwd, maxBuffer: 1024 * 1024 });
                if (diffOut.trim()) {
                    gitDiff = diffOut;
                }
            } catch {
                // No diff or error - that's fine
            }

            // Count modified files
            try {
                const { stdout: statusOut } = await execAsync('git status --porcelain', { cwd });
                filesModified = statusOut.trim().split('\n').filter(l => l.length > 0).length;
            } catch {
                // Ignore
            }
        }

        const autoName = name || `Checkpoint ${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;

        const checkpoint: Checkpoint = {
            id: randomUUID(),
            taskId,
            workspaceId,
            name: autoName,
            description,
            timestamp: new Date().toISOString(),
            gitRef,
            gitBranch,
            gitDiff,
            metadata: {
                filesModified,
                isCurrent: false,
            },
        };

        this.data.checkpoints.push(checkpoint);
        this.save();

        console.log(`[CheckpointStore] Created checkpoint "${checkpoint.name}" for task ${taskId} (git: ${gitRef?.substring(0, 7) || 'n/a'}, branch: ${gitBranch || 'n/a'})`);
        return checkpoint;
    }

    /**
     * List all checkpoints for a task, ordered by timestamp descending.
     */
    listCheckpoints(taskId: string): Checkpoint[] {
        return this.data.checkpoints
            .filter(c => c.taskId === taskId)
            .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    }

    /**
     * List all checkpoints for a workspace.
     */
    listCheckpointsByWorkspace(workspaceId: string): Checkpoint[] {
        return this.data.checkpoints
            .filter(c => c.workspaceId === workspaceId)
            .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    }

    /**
     * Get a single checkpoint by ID.
     */
    getCheckpoint(checkpointId: string): Checkpoint | undefined {
        return this.data.checkpoints.find(c => c.id === checkpointId);
    }

    /**
     * Restore git state to a checkpoint.
     * Stashes current changes, checks out the checkpoint's commit, and applies the saved diff.
     */
    async restoreCheckpoint(checkpointId: string): Promise<{ success: boolean; error?: string }> {
        const checkpoint = this.getCheckpoint(checkpointId);
        if (!checkpoint) {
            return { success: false, error: 'Checkpoint not found' };
        }

        const cwd = checkpoint.workspaceId;
        const isRepo = await isGitRepo(cwd);
        if (!isRepo) {
            return { success: false, error: 'Workspace is not a git repository' };
        }

        if (!checkpoint.gitRef) {
            return { success: false, error: 'Checkpoint has no git reference to restore' };
        }

        try {
            // Step 1: Stash current changes (if any)
            console.log(`[CheckpointStore] Restoring checkpoint "${checkpoint.name}" - stashing current changes...`);
            try {
                await execAsync('git stash push -m "claudia-checkpoint-restore-autostash"', { cwd });
            } catch {
                // Stash may fail if nothing to stash - that's OK
            }

            // Step 2: Checkout the checkpoint's commit
            console.log(`[CheckpointStore] Checking out ${checkpoint.gitRef.substring(0, 7)}...`);
            if (checkpoint.gitBranch) {
                // Try to checkout the branch first (cleaner state)
                try {
                    await execAsync(`git checkout ${checkpoint.gitBranch}`, { cwd });
                } catch {
                    // Branch might not exist anymore, checkout commit directly
                    await execAsync(`git checkout ${checkpoint.gitRef}`, { cwd });
                }
            }

            // Reset to the exact commit
            await execAsync(`git reset --hard ${checkpoint.gitRef}`, { cwd });

            // Step 3: Apply saved diff (if any)
            if (checkpoint.gitDiff) {
                console.log(`[CheckpointStore] Applying saved diff...`);
                try {
                    const { exec: execCb } = await import('child_process');
                    await new Promise<void>((resolve, reject) => {
                        const proc = execCb('git apply --allow-empty -', { cwd }, (err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                        proc.stdin?.write(checkpoint.gitDiff);
                        proc.stdin?.end();
                    });
                } catch (applyErr) {
                    console.warn('[CheckpointStore] Could not apply saved diff (may have conflicts):', applyErr);
                    // Not a fatal error - the commit restore still succeeded
                }
            }

            console.log(`[CheckpointStore] Successfully restored to checkpoint "${checkpoint.name}"`);
            return { success: true };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[CheckpointStore] Restore failed:', msg);
            return { success: false, error: msg };
        }
    }

    /**
     * Delete a checkpoint.
     */
    deleteCheckpoint(checkpointId: string): boolean {
        const idx = this.data.checkpoints.findIndex(c => c.id === checkpointId);
        if (idx === -1) return false;

        const removed = this.data.checkpoints.splice(idx, 1)[0];
        this.save();
        console.log(`[CheckpointStore] Deleted checkpoint "${removed.name}" (${checkpointId})`);
        return true;
    }

    /**
     * Fork from a checkpoint: creates a new git branch from the checkpoint's commit
     * and applies the saved diff. Returns the new branch name.
     */
    async forkFromCheckpoint(
        checkpointId: string,
        newBranchName?: string
    ): Promise<{ success: boolean; branch?: string; error?: string }> {
        const checkpoint = this.getCheckpoint(checkpointId);
        if (!checkpoint) {
            return { success: false, error: 'Checkpoint not found' };
        }

        const cwd = checkpoint.workspaceId;
        const isRepo = await isGitRepo(cwd);
        if (!isRepo) {
            return { success: false, error: 'Workspace is not a git repository' };
        }

        if (!checkpoint.gitRef) {
            return { success: false, error: 'Checkpoint has no git reference to fork from' };
        }

        const branch = newBranchName || `checkpoint-fork-${checkpoint.id.substring(0, 8)}`;

        try {
            // Step 1: Create and checkout new branch from the checkpoint's commit
            console.log(`[CheckpointStore] Forking from checkpoint "${checkpoint.name}" to branch "${branch}"...`);
            await execAsync(`git checkout -b ${branch} ${checkpoint.gitRef}`, { cwd });

            // Step 2: Apply saved diff (if any)
            if (checkpoint.gitDiff) {
                console.log(`[CheckpointStore] Applying saved diff to fork...`);
                try {
                    const { exec: execCb } = await import('child_process');
                    await new Promise<void>((resolve, reject) => {
                        const proc = execCb('git apply --allow-empty -', { cwd }, (err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                        proc.stdin?.write(checkpoint.gitDiff);
                        proc.stdin?.end();
                    });
                } catch (applyErr) {
                    console.warn('[CheckpointStore] Could not apply diff to fork:', applyErr);
                }
            }

            console.log(`[CheckpointStore] Successfully forked to branch "${branch}"`);
            return { success: true, branch };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[CheckpointStore] Fork failed:', msg);
            return { success: false, error: msg };
        }
    }

    /**
     * Delete all checkpoints for a task.
     */
    deleteCheckpointsForTask(taskId: string): number {
        const before = this.data.checkpoints.length;
        this.data.checkpoints = this.data.checkpoints.filter(c => c.taskId !== taskId);
        const removed = before - this.data.checkpoints.length;
        if (removed > 0) {
            this.save();
            console.log(`[CheckpointStore] Deleted ${removed} checkpoints for task ${taskId}`);
        }
        return removed;
    }

    /**
     * Parse a unified diff to extract the file paths it touches.
     */
    private parseDiffFiles(diff: string): string[] {
        const files: string[] = [];
        for (const line of diff.split('\n')) {
            // Match "diff --git a/path b/path" or "+++ b/path" lines
            const gitDiffMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
            if (gitDiffMatch) {
                files.push(gitDiffMatch[2]);
            }
        }
        return [...new Set(files)];
    }

    /**
     * Extract the hunks for specific files from a unified diff.
     */
    private extractDiffForFiles(fullDiff: string, files: string[]): string {
        const fileSet = new Set(files);
        const lines = fullDiff.split('\n');
        const result: string[] = [];
        let include = false;

        for (const line of lines) {
            const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
            if (match) {
                include = fileSet.has(match[2]);
            }
            if (include) {
                result.push(line);
            }
        }
        return result.join('\n');
    }

    /**
     * Selective restore: only revert files that were part of this checkpoint's diff.
     * Detects conflicts (files modified by other tasks since checkpoint) and returns them separately.
     */
    async restoreCheckpointSelective(checkpointId: string): Promise<{
        success: boolean;
        restoredFiles: string[];
        conflictingFiles: string[];
        error?: string;
    }> {
        const checkpoint = this.getCheckpoint(checkpointId);
        if (!checkpoint) {
            return { success: false, restoredFiles: [], conflictingFiles: [], error: 'Checkpoint not found' };
        }

        const cwd = checkpoint.workspaceId;
        const isRepo = await isGitRepo(cwd);
        if (!isRepo) {
            return { success: false, restoredFiles: [], conflictingFiles: [], error: 'Not a git repository' };
        }

        if (!checkpoint.gitRef) {
            return { success: false, restoredFiles: [], conflictingFiles: [], error: 'Checkpoint has no git reference' };
        }

        // If no diff was saved, there's nothing task-specific to restore
        if (!checkpoint.gitDiff) {
            return { success: true, restoredFiles: [], conflictingFiles: [] };
        }

        const checkpointFiles = this.parseDiffFiles(checkpoint.gitDiff);
        if (checkpointFiles.length === 0) {
            return { success: true, restoredFiles: [], conflictingFiles: [] };
        }

        // Get current diff for these files to detect conflicts
        const conflictingFiles: string[] = [];
        const safeFiles: string[] = [];

        try {
            const { stdout: currentDiff } = await execAsync('git diff HEAD', { cwd, maxBuffer: 1024 * 1024 });
            const currentlyModifiedFiles = this.parseDiffFiles(currentDiff);

            for (const file of checkpointFiles) {
                // A file is "conflicting" if it's currently modified AND the current diff
                // for that file differs from what's in the checkpoint diff
                if (currentlyModifiedFiles.includes(file)) {
                    const currentFileHunks = this.extractDiffForFiles(currentDiff, [file]);
                    const checkpointFileHunks = this.extractDiffForFiles(checkpoint.gitDiff!, [file]);
                    if (currentFileHunks !== checkpointFileHunks) {
                        conflictingFiles.push(file);
                        continue;
                    }
                }
                safeFiles.push(file);
            }

            // Restore safe files: reset to committed state then apply checkpoint diff
            const restoredFiles: string[] = [];
            for (const file of safeFiles) {
                try {
                    await execAsync(`git checkout ${checkpoint.gitRef} -- "${file}"`, { cwd });
                    restoredFiles.push(file);
                } catch (e) {
                    console.warn(`[CheckpointStore] Could not checkout file "${file}":`, e);
                }
            }

            // Apply the checkpoint's diff for just these files
            if (restoredFiles.length > 0 && checkpoint.gitDiff) {
                const partialDiff = this.extractDiffForFiles(checkpoint.gitDiff, restoredFiles);
                if (partialDiff.trim()) {
                    try {
                        const { exec: execCb } = await import('child_process');
                        await new Promise<void>((resolve, reject) => {
                            const proc = execCb('git apply --allow-empty -', { cwd }, (err) => {
                                if (err) reject(err);
                                else resolve();
                            });
                            proc.stdin?.write(partialDiff);
                            proc.stdin?.end();
                        });
                    } catch {
                        console.warn('[CheckpointStore] Partial diff apply had issues (non-fatal)');
                    }
                }
            }

            console.log(`[CheckpointStore] Selective restore: ${restoredFiles.length} restored, ${conflictingFiles.length} conflicts`);
            return { success: true, restoredFiles, conflictingFiles };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[CheckpointStore] Selective restore failed:', msg);
            return { success: false, restoredFiles: [], conflictingFiles: [], error: msg };
        }
    }

    /**
     * Force-restore specific files from a checkpoint, ignoring conflicts.
     */
    async forceRestoreFiles(checkpointId: string, files: string[]): Promise<{
        success: boolean;
        restoredFiles: string[];
        error?: string;
    }> {
        const checkpoint = this.getCheckpoint(checkpointId);
        if (!checkpoint) {
            return { success: false, restoredFiles: [], error: 'Checkpoint not found' };
        }

        const cwd = checkpoint.workspaceId;
        if (!checkpoint.gitRef) {
            return { success: false, restoredFiles: [], error: 'Checkpoint has no git reference' };
        }

        const restoredFiles: string[] = [];
        try {
            for (const file of files) {
                try {
                    await execAsync(`git checkout ${checkpoint.gitRef} -- "${file}"`, { cwd });
                    restoredFiles.push(file);
                } catch (e) {
                    console.warn(`[CheckpointStore] Force restore failed for "${file}":`, e);
                }
            }

            // Apply checkpoint diff for these files
            if (restoredFiles.length > 0 && checkpoint.gitDiff) {
                const partialDiff = this.extractDiffForFiles(checkpoint.gitDiff, restoredFiles);
                if (partialDiff.trim()) {
                    try {
                        const { exec: execCb } = await import('child_process');
                        await new Promise<void>((resolve, reject) => {
                            const proc = execCb('git apply --allow-empty -', { cwd }, (err) => {
                                if (err) reject(err);
                                else resolve();
                            });
                            proc.stdin?.write(partialDiff);
                            proc.stdin?.end();
                        });
                    } catch {
                        console.warn('[CheckpointStore] Force restore diff apply had issues');
                    }
                }
            }

            console.log(`[CheckpointStore] Force-restored ${restoredFiles.length} files`);
            return { success: true, restoredFiles };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return { success: false, restoredFiles: [], error: msg };
        }
    }
}
