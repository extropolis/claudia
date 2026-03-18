/**
 * CronScheduler - Manages scheduled/recurring prompts for Claudia tasks
 *
 * Provides cron-based scheduling similar to Claude Code's built-in CronCreate/CronList/CronDelete,
 * but managed at the Claudia orchestrator level for visibility, persistence, and UI integration.
 *
 * Features:
 * - Standard 5-field cron expressions (minute hour day-of-month month day-of-week)
 * - Recurring and one-shot tasks
 * - 3-day expiry for recurring tasks
 * - Max 50 scheduled tasks per Claudia task
 * - Persistence to disk
 * - Fires prompts by writing to task PTY when idle
 */

import { EventEmitter } from 'events';
import { ScheduledTask } from '@claudia/shared';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './logger.js';

const logger = createLogger('[CronScheduler]');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Constants
const MAX_SCHEDULED_TASKS_PER_TASK = 50;
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 1000; // Check every second
const PERSISTENCE_PATH = join(__dirname, '..', 'scheduled-tasks.json');

/**
 * Generate an 8-character random ID for scheduled tasks
 */
function generateId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 8; i++) {
        id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
}

/**
 * Parse a 5-field cron expression into its component parts.
 * Supports: *, single values, step (star/N), ranges (a-b), comma-separated lists
 */
interface CronField {
    type: 'any' | 'values';
    values: number[];
}

interface ParsedCron {
    minute: CronField;
    hour: CronField;
    dayOfMonth: CronField;
    month: CronField;
    dayOfWeek: CronField;
}

function parseCronField(field: string, min: number, max: number): CronField {
    if (field === '*') {
        return { type: 'any', values: [] };
    }

    const values = new Set<number>();

    // Split by comma for lists like "1,15,30"
    const parts = field.split(',');
    for (const part of parts) {
        // Check for step: */5 or 1-30/5
        if (part.includes('/')) {
            const [range, stepStr] = part.split('/');
            const step = parseInt(stepStr, 10);
            if (isNaN(step) || step <= 0) throw new Error(`Invalid step value: ${stepStr}`);

            let start = min;
            let end = max;
            if (range !== '*') {
                if (range.includes('-')) {
                    const [s, e] = range.split('-').map(Number);
                    start = s;
                    end = e;
                } else {
                    start = parseInt(range, 10);
                }
            }
            for (let i = start; i <= end; i += step) {
                values.add(i);
            }
        } else if (part.includes('-')) {
            // Range: 1-5
            const [start, end] = part.split('-').map(Number);
            if (isNaN(start) || isNaN(end)) throw new Error(`Invalid range: ${part}`);
            for (let i = start; i <= end; i++) {
                values.add(i);
            }
        } else {
            // Single value
            const val = parseInt(part, 10);
            if (isNaN(val)) throw new Error(`Invalid cron value: ${part}`);
            values.add(val);
        }
    }

    return { type: 'values', values: Array.from(values).sort((a, b) => a - b) };
}

function parseCronExpression(expr: string): ParsedCron {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) {
        throw new Error(`Invalid cron expression: expected 5 fields, got ${fields.length}. Format: "minute hour day-of-month month day-of-week"`);
    }

    return {
        minute: parseCronField(fields[0], 0, 59),
        hour: parseCronField(fields[1], 0, 23),
        dayOfMonth: parseCronField(fields[2], 1, 31),
        month: parseCronField(fields[3], 1, 12),
        dayOfWeek: parseCronField(fields[4], 0, 7), // 0 and 7 both mean Sunday
    };
}

function fieldMatches(field: CronField, value: number, isDow?: boolean): boolean {
    if (field.type === 'any') return true;
    if (isDow) {
        // Normalize: 7 → 0 (both mean Sunday)
        const normalized = field.values.map(v => v === 7 ? 0 : v);
        return normalized.includes(value === 7 ? 0 : value);
    }
    return field.values.includes(value);
}

/**
 * Check if a Date matches a parsed cron expression.
 * Uses local timezone (matches Claude Code behavior).
 */
function cronMatchesDate(cron: ParsedCron, date: Date): boolean {
    const minute = date.getMinutes();
    const hour = date.getHours();
    const dayOfMonth = date.getDate();
    const month = date.getMonth() + 1; // JS months are 0-based
    const dayOfWeek = date.getDay(); // 0 = Sunday

    if (!fieldMatches(cron.minute, minute)) return false;
    if (!fieldMatches(cron.hour, hour)) return false;
    if (!fieldMatches(cron.month, month)) return false;

    // When both day-of-month and day-of-week are constrained,
    // a date matches if EITHER field matches (vixie-cron semantics)
    const domConstrained = cron.dayOfMonth.type !== 'any';
    const dowConstrained = cron.dayOfWeek.type !== 'any';

    if (domConstrained && dowConstrained) {
        return fieldMatches(cron.dayOfMonth, dayOfMonth) || fieldMatches(cron.dayOfWeek, dayOfWeek, true);
    }

    if (domConstrained && !fieldMatches(cron.dayOfMonth, dayOfMonth)) return false;
    if (dowConstrained && !fieldMatches(cron.dayOfWeek, dayOfWeek, true)) return false;

    return true;
}

/**
 * Calculate the next fire time from a cron expression after a given date.
 * Searches up to 366 days ahead.
 */
function getNextFireTime(cronExpr: string, after: Date): Date | null {
    const cron = parseCronExpression(cronExpr);
    const search = new Date(after);
    // Start from the next minute
    search.setSeconds(0, 0);
    search.setMinutes(search.getMinutes() + 1);

    // Search up to ~366 days
    const maxIterations = 366 * 24 * 60;
    for (let i = 0; i < maxIterations; i++) {
        if (cronMatchesDate(cron, search)) {
            return search;
        }
        search.setMinutes(search.getMinutes() + 1);
    }

    return null;
}

/**
 * Validate a cron expression. Returns null if valid, error message if invalid.
 */
export function validateCronExpression(expr: string): string | null {
    try {
        parseCronExpression(expr);
        return null;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}

/**
 * Describe a cron expression in human-readable form.
 */
export function describeCronExpression(expr: string): string {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) return expr;

    const [minute, hour, dom, month, dow] = fields;

    // Common patterns
    if (minute.startsWith('*/') && hour === '*' && dom === '*' && month === '*' && dow === '*') {
        return `Every ${minute.slice(2)} minutes`;
    }
    if (minute === '0' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
        return 'Every hour on the hour';
    }
    if (minute !== '*' && hour !== '*' && dom === '*' && month === '*' && dow === '*') {
        return `Daily at ${hour}:${minute.padStart(2, '0')}`;
    }
    if (minute !== '*' && hour !== '*' && dom === '*' && month === '*' && dow !== '*') {
        const days = dow === '1-5' ? 'weekdays' : `days ${dow}`;
        return `${days} at ${hour}:${minute.padStart(2, '0')}`;
    }

    return expr;
}

// Callback type for firing a scheduled prompt
export type CronFireCallback = (taskId: string, prompt: string, scheduledTaskId: string) => void;

// Callback type for checking if a task is idle
export type TaskStateChecker = (taskId: string) => 'idle' | 'busy' | 'exited' | 'unknown';

export class CronScheduler extends EventEmitter {
    private scheduledTasks: Map<string, ScheduledTask> = new Map();
    private parsedCrons: Map<string, ParsedCron> = new Map();
    private checkInterval: ReturnType<typeof setInterval> | null = null;
    private lastCheckMinute: string = ''; // Track to avoid duplicate fires in same minute
    private fireCallback: CronFireCallback;
    private taskStateChecker: TaskStateChecker;
    private pendingFires: Map<string, string> = new Map(); // scheduledTaskId → prompt (waiting for task to be idle)
    private saveTimeout: ReturnType<typeof setTimeout> | null = null;

    constructor(fireCallback: CronFireCallback, taskStateChecker: TaskStateChecker) {
        super();
        this.fireCallback = fireCallback;
        this.taskStateChecker = taskStateChecker;
        this.load();
    }

    /**
     * Start the scheduler. Checks every second for due tasks.
     */
    start(): void {
        if (this.checkInterval) return;
        this.checkInterval = setInterval(() => this.check(), CHECK_INTERVAL_MS);
        logger.info('Cron scheduler started', { scheduledTasks: this.scheduledTasks.size });
    }

    /**
     * Stop the scheduler.
     */
    stop(): void {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }
        logger.info('Cron scheduler stopped');
    }

    /**
     * Create a new scheduled task.
     */
    create(
        taskId: string,
        workspaceId: string,
        cronExpression: string,
        prompt: string,
        isRecurring: boolean = true
    ): ScheduledTask {
        // Validate cron expression
        const error = validateCronExpression(cronExpression);
        if (error) {
            throw new Error(`Invalid cron expression: ${error}`);
        }

        // Check max limit per task
        const taskScheduled = this.getForTask(taskId);
        if (taskScheduled.length >= MAX_SCHEDULED_TASKS_PER_TASK) {
            throw new Error(`Maximum ${MAX_SCHEDULED_TASKS_PER_TASK} scheduled tasks per task reached`);
        }

        const now = new Date();
        const id = generateId();
        const expiresAt = isRecurring
            ? new Date(now.getTime() + THREE_DAYS_MS).toISOString()
            : new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(); // 1 day for one-shot

        const nextFire = getNextFireTime(cronExpression, now);

        const scheduled: ScheduledTask = {
            id,
            taskId,
            workspaceId,
            cronExpression,
            prompt,
            isRecurring,
            createdAt: now.toISOString(),
            expiresAt,
            nextFireAt: nextFire?.toISOString(),
            fireCount: 0,
        };

        this.scheduledTasks.set(id, scheduled);
        this.parsedCrons.set(id, parseCronExpression(cronExpression));
        this.debouncedSave();

        logger.info('Scheduled task created', {
            id,
            taskId,
            cronExpression,
            isRecurring,
            nextFireAt: scheduled.nextFireAt,
            description: describeCronExpression(cronExpression),
        });

        this.emit('created', scheduled);
        return scheduled;
    }

    /**
     * Delete a scheduled task by ID.
     */
    delete(id: string): boolean {
        const task = this.scheduledTasks.get(id);
        if (!task) return false;

        this.scheduledTasks.delete(id);
        this.parsedCrons.delete(id);
        this.pendingFires.delete(id);
        this.debouncedSave();

        logger.info('Scheduled task deleted', { id, taskId: task.taskId });
        this.emit('deleted', task);
        return true;
    }

    /**
     * Update an existing scheduled task. Supports changing cronExpression, prompt, and isRecurring.
     */
    update(id: string, updates: { cronExpression?: string; prompt?: string; isRecurring?: boolean }): ScheduledTask | null {
        const task = this.scheduledTasks.get(id);
        if (!task) return null;

        // Validate new cron expression if provided
        if (updates.cronExpression) {
            const error = validateCronExpression(updates.cronExpression);
            if (error) {
                throw new Error(`Invalid cron expression: ${error}`);
            }
        }

        const now = new Date();

        if (updates.cronExpression) {
            task.cronExpression = updates.cronExpression;
            this.parsedCrons.set(id, parseCronExpression(updates.cronExpression));
            const nextFire = getNextFireTime(updates.cronExpression, now);
            task.nextFireAt = nextFire?.toISOString();
        }
        if (updates.prompt !== undefined) {
            task.prompt = updates.prompt;
        }
        if (updates.isRecurring !== undefined) {
            task.isRecurring = updates.isRecurring;
            // Recalculate expiry based on new recurring status
            task.expiresAt = updates.isRecurring
                ? new Date(new Date(task.createdAt).getTime() + THREE_DAYS_MS).toISOString()
                : new Date(new Date(task.createdAt).getTime() + 24 * 60 * 60 * 1000).toISOString();
        }

        // Clear any pending fire if prompt changed
        if (updates.prompt !== undefined) {
            this.pendingFires.delete(id);
        }

        this.debouncedSave();

        logger.info('Scheduled task updated', { id, updates: Object.keys(updates) });
        this.emit('updated', task);
        return task;
    }

    /**
     * List all scheduled tasks, optionally filtered by Claudia task ID.
     */
    list(taskId?: string): ScheduledTask[] {
        const all = Array.from(this.scheduledTasks.values());
        if (taskId) {
            return all.filter(t => t.taskId === taskId);
        }
        return all;
    }

    /**
     * Get all scheduled tasks for a specific Claudia task.
     */
    getForTask(taskId: string): ScheduledTask[] {
        return this.list(taskId);
    }

    /**
     * Get a specific scheduled task by ID.
     */
    get(id: string): ScheduledTask | undefined {
        return this.scheduledTasks.get(id);
    }

    /**
     * Force-fire a scheduled task immediately, regardless of cron schedule.
     * Returns true if fired, false if not found.
     */
    fireNow(id: string): boolean {
        const scheduled = this.scheduledTasks.get(id);
        if (!scheduled) return false;

        const now = new Date();
        scheduled.lastFiredAt = now.toISOString();
        scheduled.fireCount++;
        const nextFire = getNextFireTime(scheduled.cronExpression, now);
        scheduled.nextFireAt = nextFire?.toISOString();

        const taskState = this.taskStateChecker(scheduled.taskId);
        if (taskState === 'idle') {
            this.fireCallback(scheduled.taskId, scheduled.prompt, id);
        } else {
            this.pendingFires.set(id, scheduled.prompt);
        }

        this.emit('fired', scheduled);
        this.debouncedSave();

        // Delete one-shot tasks after firing
        if (!scheduled.isRecurring) {
            this.scheduledTasks.delete(id);
            this.parsedCrons.delete(id);
            this.pendingFires.delete(id);
            this.emit('deleted', scheduled);
        }

        logger.info('Force-fired scheduled task', { id, taskId: scheduled.taskId });
        return true;
    }

    /**
     * Remove all scheduled tasks for a given Claudia task (e.g., when task is destroyed).
     */
    removeAllForTask(taskId: string): number {
        const toRemove = this.getForTask(taskId);
        for (const task of toRemove) {
            this.scheduledTasks.delete(task.id);
            this.parsedCrons.delete(task.id);
            this.pendingFires.delete(task.id);
        }
        if (toRemove.length > 0) {
            this.debouncedSave();
            logger.info('Removed all scheduled tasks for task', { taskId, count: toRemove.length });
        }
        return toRemove.length;
    }

    /**
     * Notify the scheduler that a task has become idle.
     * Fires any pending scheduled prompts for it.
     */
    onTaskIdle(taskId: string): void {
        for (const [scheduledId, prompt] of this.pendingFires.entries()) {
            const scheduled = this.scheduledTasks.get(scheduledId);
            if (scheduled && scheduled.taskId === taskId) {
                logger.info('Firing pending scheduled prompt (task now idle)', { scheduledId, taskId });
                this.pendingFires.delete(scheduledId);
                this.fireCallback(taskId, prompt, scheduledId);
            }
        }
    }

    /**
     * Get the total count of scheduled tasks.
     */
    get size(): number {
        return this.scheduledTasks.size;
    }

    /**
     * Main check loop - runs every second.
     */
    private check(): void {
        const now = new Date();
        const currentMinute = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;

        // Only check once per minute (cron has minute granularity)
        if (currentMinute === this.lastCheckMinute) return;
        this.lastCheckMinute = currentMinute;

        const toDelete: string[] = [];

        for (const [id, scheduled] of this.scheduledTasks.entries()) {
            // Check expiry
            if (new Date(scheduled.expiresAt) <= now) {
                logger.info('Scheduled task expired', { id, taskId: scheduled.taskId });
                toDelete.push(id);
                continue;
            }

            // Check if the parent task still exists
            const taskState = this.taskStateChecker(scheduled.taskId);
            if (taskState === 'exited') {
                logger.info('Removing scheduled task (parent task exited)', { id, taskId: scheduled.taskId });
                toDelete.push(id);
                continue;
            }
            // Skip this cycle if task state is unknown (may be reconnecting)
            if (taskState === 'unknown') {
                logger.debug('Skipping scheduled task check (task state unknown, may be reconnecting)', { id, taskId: scheduled.taskId });
                continue;
            }

            // Check if cron matches current time
            const cron = this.parsedCrons.get(id);
            if (!cron) continue;

            if (cronMatchesDate(cron, now)) {
                logger.info('Scheduled task due', { id, taskId: scheduled.taskId, prompt: scheduled.prompt.substring(0, 80) });

                // Update fire tracking
                scheduled.lastFiredAt = now.toISOString();
                scheduled.fireCount++;
                const nextFire = getNextFireTime(scheduled.cronExpression, now);
                scheduled.nextFireAt = nextFire?.toISOString();

                // Check if target task is idle
                if (taskState === 'idle') {
                    this.fireCallback(scheduled.taskId, scheduled.prompt, id);
                } else {
                    // Queue for when task becomes idle
                    logger.info('Task busy, queuing scheduled prompt', { id, taskId: scheduled.taskId });
                    this.pendingFires.set(id, scheduled.prompt);
                }

                this.emit('fired', scheduled);

                // Delete one-shot tasks after firing
                if (!scheduled.isRecurring) {
                    toDelete.push(id);
                }
            }
        }

        // Clean up expired/fired tasks
        for (const id of toDelete) {
            const task = this.scheduledTasks.get(id);
            this.scheduledTasks.delete(id);
            this.parsedCrons.delete(id);
            this.pendingFires.delete(id);
            if (task) this.emit('deleted', task);
        }

        if (toDelete.length > 0) {
            this.debouncedSave();
        }
    }

    /**
     * Debounced save to disk.
     */
    private debouncedSave(): void {
        if (this.saveTimeout) clearTimeout(this.saveTimeout);
        this.saveTimeout = setTimeout(() => this.save(), 1000);
    }

    /**
     * Save scheduled tasks to disk.
     */
    private save(): void {
        try {
            const data = Array.from(this.scheduledTasks.values());
            writeFileSync(PERSISTENCE_PATH, JSON.stringify(data, null, 2), 'utf8');
            logger.debug('Saved scheduled tasks', { count: data.length });
        } catch (error) {
            logger.error('Failed to save scheduled tasks', { error });
        }
    }

    /**
     * Load scheduled tasks from disk.
     */
    private load(): void {
        try {
            if (!existsSync(PERSISTENCE_PATH)) return;

            const raw = readFileSync(PERSISTENCE_PATH, 'utf8');
            const data: ScheduledTask[] = JSON.parse(raw);

            for (const task of data) {
                try {
                    const cron = parseCronExpression(task.cronExpression);
                    this.scheduledTasks.set(task.id, task);
                    this.parsedCrons.set(task.id, cron);
                } catch (e) {
                    logger.warn('Skipping invalid persisted scheduled task', { id: task.id, error: e });
                }
            }

            logger.info('Loaded scheduled tasks from disk', { count: this.scheduledTasks.size });
        } catch (error) {
            logger.error('Failed to load scheduled tasks', { error });
        }
    }
}
