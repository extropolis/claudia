/**
 * Task Persistence Module
 *
 * Handles saving and loading task data to/from disk.
 * Manages task history files and archived task storage.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, statSync, openSync, readSync, closeSync } from 'fs';
import { dirname, join } from 'path';
import { TaskState, TaskGitState } from '@claudia/shared';

/**
 * Persisted task data (no process, just metadata)
 */
export interface PersistedTask {
    id: string;
    prompt: string;
    workspaceId: string;
    createdAt: string;
    lastActivity: string;
    lastState: TaskState;
    sessionId: string | null;
    outputHistory?: string;
    gitState?: TaskGitState;
    wasInterrupted?: boolean;
    systemPrompt?: string;
    shouldContinue?: boolean;
}

/**
 * Lightweight metadata for archived tasks (no outputHistory - loaded lazily from disk)
 */
export interface ArchivedTaskMetadata {
    id: string;
    prompt: string;
    workspaceId: string;
    createdAt: string;
    lastActivity: string;
    sessionId: string | null;
    gitState?: TaskGitState;
    systemPrompt?: string;
    historySize?: number;
}

/**
 * Structure of the task persistence file
 */
export interface TaskPersistence {
    tasks: PersistedTask[];
    archivedTasks?: ArchivedTaskMetadata[];
}

/**
 * TaskPersistenceManager handles all disk I/O for task data
 */
export class TaskPersistenceManager {
    private persistencePath: string;
    private saveDebounceTimer: NodeJS.Timeout | null = null;

    constructor(persistencePath: string) {
        this.persistencePath = persistencePath;
    }

    /**
     * Get the directory for task histories
     */
    getHistoryDir(): string {
        return join(dirname(this.persistencePath), 'task-histories');
    }

    /**
     * Get the directory for archived task histories
     */
    getArchivedHistoryDir(): string {
        return join(dirname(this.persistencePath), 'archived-histories');
    }

    /**
     * Get the file path for a task's history
     */
    getTaskHistoryPath(taskId: string): string {
        return join(this.getHistoryDir(), `${taskId}.txt`);
    }

    /**
     * Get the file path for an archived task's history
     */
    getArchivedHistoryPath(taskId: string): string {
        return join(this.getArchivedHistoryDir(), `${taskId}.txt`);
    }

    /**
     * Ensure the history directory exists
     */
    ensureHistoryDir(): void {
        const historyDir = this.getHistoryDir();
        if (!existsSync(historyDir)) {
            mkdirSync(historyDir, { recursive: true });
        }
    }

    /**
     * Ensure the archived history directory exists
     */
    ensureArchivedHistoryDir(): void {
        const historyDir = this.getArchivedHistoryDir();
        if (!existsSync(historyDir)) {
            mkdirSync(historyDir, { recursive: true });
        }
    }

    /**
     * Load persisted tasks from disk
     */
    loadPersistedTasks(): {
        tasks: PersistedTask[];
        archivedTasks: ArchivedTaskMetadata[];
        migratedCount: number;
    } {
        const result = {
            tasks: [] as PersistedTask[],
            archivedTasks: [] as ArchivedTaskMetadata[],
            migratedCount: 0
        };

        try {
            if (!existsSync(this.persistencePath)) {
                return result;
            }

            const data = readFileSync(this.persistencePath, 'utf-8');
            const persistence = JSON.parse(data) as { tasks: PersistedTask[]; archivedTasks?: any[] };
            console.log(`[TaskPersistence] Loading ${persistence.tasks.length} persisted tasks`);

            this.ensureHistoryDir();

            // Process active tasks
            for (const persisted of persistence.tasks) {
                // MIGRATION: If task has outputHistory string, move it to file
                if (persisted.outputHistory && typeof persisted.outputHistory === 'string') {
                    try {
                        writeFileSync(this.getTaskHistoryPath(persisted.id), persisted.outputHistory);
                        if (process.env.DEBUG_TASKS) {
                            console.log(`[TaskPersistence] Migrated history for task ${persisted.id} to file`);
                        }
                        delete persisted.outputHistory;
                    } catch (e) {
                        console.error(`[TaskPersistence] Failed to migrate history for task ${persisted.id}:`, e);
                    }
                }

                if (process.env.DEBUG_TASKS) {
                    console.log(`[TaskPersistence] Loading task ${persisted.id}`);
                }
                result.tasks.push(persisted);
            }

            // Process archived tasks
            if (persistence.archivedTasks) {
                console.log(`[TaskPersistence] Loading ${persistence.archivedTasks.length} archived tasks (metadata only)`);

                for (const archived of persistence.archivedTasks) {
                    // Migration: if archived task has embedded outputHistory, save to disk
                    if (archived.outputHistory && typeof archived.outputHistory === 'string') {
                        this.ensureArchivedHistoryDir();
                        try {
                            writeFileSync(this.getArchivedHistoryPath(archived.id), archived.outputHistory);
                            result.migratedCount++;
                        } catch (e) {
                            console.error(`[TaskPersistence] Failed to migrate history for ${archived.id}:`, e);
                        }
                    }

                    // Store only metadata
                    const metadata: ArchivedTaskMetadata = {
                        id: archived.id,
                        prompt: archived.prompt,
                        workspaceId: archived.workspaceId,
                        createdAt: archived.createdAt,
                        lastActivity: archived.lastActivity,
                        sessionId: archived.sessionId,
                        gitState: archived.gitState,
                        systemPrompt: archived.systemPrompt,
                        historySize: archived.outputHistory
                            ? Math.floor(archived.outputHistory.length * 0.75)
                            : archived.historySize || 0,
                    };
                    result.archivedTasks.push(metadata);
                }

                if (result.migratedCount > 0) {
                    console.log(`[TaskPersistence] Migrated ${result.migratedCount} archived tasks to lazy loading format`);
                }
            }
        } catch (error) {
            console.error('[TaskPersistence] Failed to load persisted tasks:', error);
        }

        return result;
    }

    /**
     * Save tasks to disk
     */
    saveTasks(
        tasks: PersistedTask[],
        archivedTasks: ArchivedTaskMetadata[]
    ): void {
        try {
            const persistence: TaskPersistence = {
                tasks,
                archivedTasks
            };

            const dir = dirname(this.persistencePath);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }

            writeFileSync(this.persistencePath, JSON.stringify(persistence, null, 2));
            console.log(`[TaskPersistence] Saved ${tasks.length} tasks, ${archivedTasks.length} archived (metadata only)`);
        } catch (error) {
            console.error('[TaskPersistence] Failed to save tasks:', error);
        }
    }

    /**
     * Schedule a debounced save
     */
    scheduleSave(callback: () => void): void {
        if (this.saveDebounceTimer) {
            clearTimeout(this.saveDebounceTimer);
        }
        this.saveDebounceTimer = setTimeout(callback, 500);
    }

    /**
     * Clear the debounce timer (for immediate saves)
     */
    clearDebounceTimer(): void {
        if (this.saveDebounceTimer) {
            clearTimeout(this.saveDebounceTimer);
            this.saveDebounceTimer = null;
        }
    }

    /**
     * Save task history to file
     */
    saveTaskHistory(taskId: string, buffers: Buffer[], previousHistory?: Buffer): void {
        const historyPath = this.getTaskHistoryPath(taskId);
        try {
            const parts: Buffer[] = [];
            if (previousHistory) {
                parts.push(previousHistory);
            }
            if (buffers.length > 0) {
                parts.push(...buffers);
            }

            if (parts.length > 0 || !existsSync(historyPath)) {
                const fullHistory = Buffer.concat(parts);
                writeFileSync(historyPath, fullHistory.toString('base64'));
            }
        } catch (e) {
            console.error(`[TaskPersistence] Failed to save history for task ${taskId}:`, e);
        }
    }

    /**
     * Load task history from file with optional size limit
     * @param taskId The task ID
     * @param maxSize Maximum size to load (loads from tail if file is larger)
     * @returns The history buffer and whether it was truncated
     */
    loadTaskHistory(taskId: string, maxSize?: number): { buffer: Buffer | null; truncated: boolean } {
        const historyPath = this.getTaskHistoryPath(taskId);

        if (!existsSync(historyPath)) {
            return { buffer: null, truncated: false };
        }

        try {
            const stat = statSync(historyPath);
            const fileSize = stat.size;

            // If no max size or file is small enough, read it all
            if (!maxSize || fileSize <= maxSize) {
                const base64Content = readFileSync(historyPath, 'utf-8');
                const decoded = Buffer.from(base64Content, 'base64');
                console.log(`[TaskPersistence] Loaded complete history for ${taskId}: ${fileSize} bytes`);
                return { buffer: decoded, truncated: false };
            }

            // File is larger than max, only read the tail
            const fd = openSync(historyPath, 'r');
            const buffer = Buffer.alloc(maxSize);
            const offset = fileSize - maxSize;
            readSync(fd, buffer, 0, maxSize, offset);
            closeSync(fd);

            const base64Content = buffer.toString('utf-8');
            const decoded = Buffer.from(base64Content, 'base64');
            console.log(`[TaskPersistence] Loaded tail of history for ${taskId}: ${fileSize} bytes (file) -> ${maxSize} bytes (loaded)`);
            return { buffer: decoded, truncated: true };
        } catch (e) {
            console.error(`[TaskPersistence] Failed to load history for ${taskId}:`, e);
            return { buffer: null, truncated: false };
        }
    }

    /**
     * Check if a task has a history file
     */
    hasHistoryFile(taskId: string): boolean {
        return existsSync(this.getTaskHistoryPath(taskId));
    }

    /**
     * Save archived task history to file
     */
    saveArchivedHistory(taskId: string, base64Content: string): void {
        this.ensureArchivedHistoryDir();
        try {
            writeFileSync(this.getArchivedHistoryPath(taskId), base64Content);
        } catch (e) {
            console.error(`[TaskPersistence] Failed to save archived history for ${taskId}:`, e);
        }
    }

    /**
     * Load archived task history from file
     */
    loadArchivedHistory(taskId: string): string | null {
        const historyPath = this.getArchivedHistoryPath(taskId);
        if (!existsSync(historyPath)) {
            return null;
        }

        try {
            return readFileSync(historyPath, 'utf-8');
        } catch (e) {
            console.error(`[TaskPersistence] Failed to load archived history for ${taskId}:`, e);
            return null;
        }
    }

    /**
     * Delete archived task history file
     */
    deleteArchivedHistory(taskId: string): boolean {
        const historyPath = this.getArchivedHistoryPath(taskId);
        if (!existsSync(historyPath)) {
            return false;
        }

        try {
            unlinkSync(historyPath);
            console.log(`[TaskPersistence] Deleted archived history file for ${taskId}`);
            return true;
        } catch (e) {
            console.error(`[TaskPersistence] Failed to delete archived history file for ${taskId}:`, e);
            return false;
        }
    }
}
