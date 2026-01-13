import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import { Task, TaskStatus, CodeFile } from '@claudia/shared';
import { parseCodeFromOutput } from './code-parser.js';
import { extractStructuredResult, cleanOutputFromMarkers } from './result-parser.js';
import { basename } from 'path';

export class TaskManager extends EventEmitter {
    private tasks: Map<string, Task> = new Map();

    /**
     * Create a new task
     */
    createTask(name: string, description: string, parentId?: string, projectPath?: string): Task {
        const task: Task = {
            id: uuid(),
            name,
            description,
            status: 'pending',
            parentId,
            output: [],
            createdAt: new Date()
        };

        if (projectPath) {
            task.projectPath = projectPath;
            task.projectName = basename(projectPath);
        }

        this.tasks.set(task.id, task);
        this.emit('created', task);
        console.log(`[TaskManager] Created task ${task.id}: ${name}${projectPath ? ` in ${projectPath}` : ''}`);
        return task;
    }

    /**
     * Update task status
     */
    updateStatus(taskId: string, status: TaskStatus, error?: string): Task | undefined {
        const task = this.tasks.get(taskId);
        if (!task) return undefined;

        task.status = status;

        if (status === 'running' && !task.startedAt) {
            task.startedAt = new Date();
        }

        if (status === 'complete' || status === 'error') {
            task.completedAt = new Date();
        }

        if (error) {
            task.error = error;
        }

        this.emit('updated', task);
        console.log(`[TaskManager] Task ${taskId} status: ${status}`);
        return task;
    }

    /**
     * Assign a worker to a task
     */
    assignWorker(taskId: string, workerId: string): Task | undefined {
        const task = this.tasks.get(taskId);
        if (!task) return undefined;

        task.workerId = workerId;
        task.status = 'running';
        task.startedAt = new Date();

        this.emit('updated', task);
        return task;
    }

    /**
     * Append output to a task
     */
    appendOutput(taskId: string, data: string): void {
        const task = this.tasks.get(taskId);
        if (!task) return;

        task.output.push(data);
        task.lastProgressTime = new Date(); // Update progress timestamp
        this.emit('output', { taskId, data });
    }

    /**
     * Complete a task
     */
    completeTask(taskId: string, exitCode: number): Task | undefined {
        const task = this.tasks.get(taskId);
        if (!task) return undefined;

        task.status = exitCode === 0 ? 'complete' : 'error';
        task.exitCode = exitCode;
        task.completedAt = new Date();

        // Extract structured result if present
        const structuredResult = extractStructuredResult(task.output);
        if (structuredResult) {
            task.structuredResult = structuredResult;
            console.log(`[TaskManager] Extracted structured result for task ${taskId}`);
        }

        this.emit('complete', task);
        console.log(`[TaskManager] Task ${taskId} completed with code ${exitCode}`);
        return task;
    }

    /**
     * Get a task by ID
     */
    getTask(taskId: string): Task | undefined {
        return this.tasks.get(taskId);
    }

    /**
     * Get parsed code files from a task's output
     */
    getTaskFiles(taskId: string): CodeFile[] {
        const task = this.tasks.get(taskId);
        if (!task) return [];

        // Parse on demand and cache
        if (!task.files) {
            task.files = parseCodeFromOutput(task.output);
        }
        return task.files;
    }

    /**
     * Get task by worker ID
     */
    getTaskByWorkerId(workerId: string): Task | undefined {
        for (const task of this.tasks.values()) {
            if (task.workerId === workerId) {
                return task;
            }
        }
        return undefined;
    }

    /**
     * Get all tasks
     */
    getAllTasks(): Task[] {
        return Array.from(this.tasks.values());
    }

    /**
     * Get child tasks of a parent
     */
    getChildTasks(parentId: string): Task[] {
        return Array.from(this.tasks.values()).filter(t => t.parentId === parentId);
    }

    /**
     * Check if all specified tasks are complete
     */
    areTasksComplete(taskIds: string[]): boolean {
        return taskIds.every(id => {
            const task = this.tasks.get(id);
            return task && (task.status === 'complete' || task.status === 'error');
        });
    }

    /**
     * Delete a task by ID
     */
    deleteTask(taskId: string): boolean {
        const task = this.tasks.get(taskId);
        if (!task) return false;

        // Also delete child tasks
        const children = this.getChildTasks(taskId);
        for (const child of children) {
            this.deleteTask(child.id);
        }

        this.tasks.delete(taskId);
        this.emit('deleted', taskId);
        console.log(`[TaskManager] Deleted task ${taskId}`);
        return true;
    }

    /**
     * Clear all tasks
     */
    clearTasks(): void {
        const taskIds = Array.from(this.tasks.keys());
        this.tasks.clear();
        this.emit('cleared', taskIds);
        console.log(`[TaskManager] Cleared all ${taskIds.length} tasks`);
    }

    /**
     * Mark a task as blocked with a reason
     */
    markTaskBlocked(taskId: string, reason: string, blockedBy?: string[]): Task | undefined {
        const task = this.tasks.get(taskId);
        if (!task) return undefined;

        task.status = 'blocked';
        task.blockReason = reason;
        task.blockedBy = blockedBy;

        this.emit('blocked', task);
        console.log(`[TaskManager] Task ${taskId} marked as blocked: ${reason}`);
        return task;
    }

    /**
     * Unblock a task
     */
    unblockTask(taskId: string): Task | undefined {
        const task = this.tasks.get(taskId);
        if (!task || task.status !== 'blocked') return undefined;

        task.status = 'running';
        task.blockReason = undefined;
        task.blockedBy = undefined;

        this.emit('unblocked', task);
        console.log(`[TaskManager] Task ${taskId} unblocked`);
        return task;
    }

    /**
     * Detect tasks that might be stuck (no output for a while)
     * Returns tasks that haven't shown progress in the specified timeout
     */
    detectStuckTasks(timeoutMs: number = 120000): Task[] {
        const now = Date.now();
        const stuckTasks: Task[] = [];

        for (const task of this.tasks.values()) {
            if (task.status !== 'running') continue;

            const lastProgress = task.lastProgressTime || task.startedAt;
            if (!lastProgress) continue;

            const timeSinceProgress = now - lastProgress.getTime();
            if (timeSinceProgress > timeoutMs) {
                stuckTasks.push(task);
            }
        }

        return stuckTasks;
    }

    /**
     * Check if dependencies are met for a task
     */
    areDependenciesMet(taskId: string): boolean {
        const task = this.tasks.get(taskId);
        if (!task || !task.dependsOn || task.dependsOn.length === 0) {
            return true;
        }

        return task.dependsOn.every(depId => {
            const depTask = this.tasks.get(depId);
            return depTask && depTask.status === 'complete';
        });
    }

    /**
     * Get tasks that are blocked by incomplete dependencies
     */
    getBlockedTasks(): Task[] {
        const blockedTasks: Task[] = [];

        for (const task of this.tasks.values()) {
            if (task.status === 'blocked') {
                blockedTasks.push(task);
            } else if (task.status === 'pending' && task.dependsOn && task.dependsOn.length > 0) {
                if (!this.areDependenciesMet(task.id)) {
                    blockedTasks.push(task);
                }
            }
        }

        return blockedTasks;
    }
    /**
     * Cleanup resources
     */
    cleanup(): void {
        this.tasks.clear();
        this.removeAllListeners();
        console.log('[TaskManager] Cleanup complete');
    }
}
