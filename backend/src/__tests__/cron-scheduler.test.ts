/**
 * Unit tests for CronScheduler (src/cron-scheduler.ts).
 *
 * Scope: the scheduler unit itself — expression parsing/validation, human
 * description, next-fire computation, the once-per-minute check loop,
 * one-shot vs recurring, expiry, the per-task cap, pending-fire queueing,
 * persistence and restart/catch-up behaviour.
 *
 * The WebSocket-level CRUD surface (cron:create / list / update / run /
 * delete) is covered separately by ws-cron-shell-protocol.test.ts; this file
 * deliberately does not re-test that plumbing.
 *
 * No real time passes here. Everything runs on vi.useFakeTimers(), and dates
 * are built with the local-time Date constructor so assertions hold in any
 * timezone (the scheduler matches in local time on purpose).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { ScheduledTask } from '@claudia/shared';

// ---------------------------------------------------------------------------
// Isolation: keep persistence entirely in memory.
//
// cron-scheduler.ts persists to `<backend>/scheduled-tasks.json` via a module
// constant that cannot be injected. Stubbing schema-version + fs.existsSync
// keeps the suite from reading or writing the real file while still exercising
// the save()/load() code paths for real.
// ---------------------------------------------------------------------------
const disk = vi.hoisted(() => ({ files: new Map<string, unknown>() }));

vi.mock('../utils/schema-version.js', () => ({
    saveVersioned: (path: string, data: unknown) => {
        disk.files.set(path, JSON.parse(JSON.stringify(data)));
    },
    loadVersioned: (path: string, opts: { defaultData: unknown }) =>
        disk.files.has(path) ? disk.files.get(path) : opts.defaultData,
}));

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    const existsSync = (p: Parameters<typeof actual.existsSync>[0]) =>
        typeof p === 'string' && p.endsWith('scheduled-tasks.json')
            ? disk.files.has(p)
            : actual.existsSync(p);
    return { ...actual, existsSync, default: { ...actual, existsSync } };
});

const { CronScheduler, validateCronExpression, describeCronExpression } =
    await import('../cron-scheduler.js');
type Scheduler = InstanceType<typeof CronScheduler>;

/** Same path the module computes: `<backend>/scheduled-tasks.json`. */
const PERSISTENCE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scheduled-tasks.json');

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

// A fixed reference instant, built in local time so the cron fields below are
// unambiguous: Thursday 2026-01-01, 10:34:30 local.
const T0 = new Date(2026, 0, 1, 10, 34, 30);

type State = 'idle' | 'busy' | 'exited' | 'unknown';

interface Fire {
    taskId: string;
    prompt: string;
    scheduledTaskId: string;
}

interface Rig {
    scheduler: Scheduler;
    fires: Fire[];
    states: Map<string, State>;
    events: Array<{ event: string; task: ScheduledTask }>;
}

let rigs: Rig[] = [];

function makeRig(defaultState: State = 'idle'): Rig {
    const fires: Fire[] = [];
    const states = new Map<string, State>();
    const events: Array<{ event: string; task: ScheduledTask }> = [];

    const scheduler = new CronScheduler(
        (taskId, prompt, scheduledTaskId) => fires.push({ taskId, prompt, scheduledTaskId }),
        (taskId) => states.get(taskId) ?? defaultState,
    );

    for (const name of ['created', 'deleted', 'fired', 'updated'] as const) {
        scheduler.on(name, (task: ScheduledTask) => events.push({ event: name, task }));
    }

    const rig: Rig = { scheduler, fires, states, events };
    rigs.push(rig);
    return rig;
}

/**
 * Run exactly one check() pass with the wall clock at `when`.
 *
 * Restarting the interval around the clock jump keeps this deterministic: a
 * bare setSystemTime() + advanceTimersByTime() can make the fake clock replay
 * every missed interval tick, which for a multi-day jump is hundreds of
 * thousands of callbacks.
 */
function tickAt(scheduler: Scheduler, when: Date): void {
    scheduler.stop();
    vi.setSystemTime(when);
    scheduler.start();
    vi.advanceTimersByTime(1000);
}

/** Flush the 1s debounced save. */
function flushSave(): void {
    vi.advanceTimersByTime(1000);
}

beforeEach(() => {
    disk.files.clear();
    rigs = [];
    vi.useFakeTimers();
    vi.setSystemTime(T0);
});

afterEach(() => {
    for (const rig of rigs) {
        rig.scheduler.stop();
        rig.scheduler.removeAllListeners();
    }
    rigs = [];
    vi.clearAllTimers();
    vi.useRealTimers();
    disk.files.clear();
});

// ---------------------------------------------------------------------------
// Expression validation
// ---------------------------------------------------------------------------
describe('validateCronExpression', () => {
    it.each([
        ['* * * * *', 'every minute'],
        ['*/5 * * * *', 'step'],
        ['0 * * * *', 'top of every hour'],
        ['30 14 * * *', 'daily at a time'],
        ['0 9 * * 1-5', 'weekday range'],
        ['0 0 1,15 * *', 'comma list'],
        ['0 */2 * * *', 'step in the hour field'],
        ['0 0 1-9/2 * *', 'stepped range'],
        ['0 0 * * 7', 'day-of-week 7 (Sunday alias)'],
        ['59 23 31 12 6', 'all fields at their maximum'],
        ['   0   9   *   *   1   ', 'irregular whitespace is tolerated'],
    ])('accepts %s (%s)', (expr) => {
        expect(validateCronExpression(expr)).toBeNull();
    });

    it.each([
        ['', 'empty string'],
        ['   ', 'whitespace only'],
        ['* * * *', 'four fields'],
        ['* * * * * *', 'six fields'],
        ['@hourly', 'named shorthand is not supported'],
    ])('rejects %s (%s) with a field-count message', (expr) => {
        const err = validateCronExpression(expr);
        expect(err).toMatch(/expected 5 fields/);
    });

    it('rejects a non-numeric value', () => {
        expect(validateCronExpression('abc * * * *')).toMatch(/Invalid cron value: abc/);
    });

    it('rejects a non-numeric range bound', () => {
        expect(validateCronExpression('1-x * * * *')).toMatch(/Invalid range: 1-x/);
    });

    it.each([
        ['*/0 * * * *', '0'],
        ['*/x * * * *', 'x'],
        ['*/-2 * * * *', '-2'],
    ])('rejects a bad step in %s', (expr, step) => {
        expect(validateCronExpression(expr)).toBe(`Invalid step value: ${step}`);
    });

    it('reports the failing field for each of the five positions', () => {
        for (const expr of ['x * * * *', '* x * * *', '* * x * *', '* * * x *', '* * * * x']) {
            expect(validateCronExpression(expr)).toMatch(/Invalid cron value: x/);
        }
    });

    // Documented gap, not an assertion of desired behaviour: the parser has no
    // range check, so out-of-domain numbers validate and then simply never
    // match. ws-cron-shell-protocol.test.ts asserts the user-visible effect at
    // the API boundary; this pins the unit-level cause.
    it('accepts out-of-range numbers (no domain check in the parser)', () => {
        expect(validateCronExpression('99 * * * *')).toBeNull();
        expect(validateCronExpression('0 99 * * *')).toBeNull();
        expect(validateCronExpression('0 0 32 * *')).toBeNull();
        expect(validateCronExpression('0 0 * 13 *')).toBeNull();
    });

    // Also documented rather than endorsed: a leading '-' is parsed as a range
    // with an empty lower bound, so '-1' silently means '0-1'.
    it('treats a negative value as a range starting at 0 instead of rejecting it', () => {
        expect(validateCronExpression('-1 * * * *')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Human-readable description
// ---------------------------------------------------------------------------
describe('describeCronExpression', () => {
    it.each([
        ['*/5 * * * *', 'Every 5 minutes'],
        ['*/15 * * * *', 'Every 15 minutes'],
        ['0 * * * *', 'Every hour on the hour'],
        ['30 14 * * *', 'Daily at 14:30'],
        ['0 9 * * *', 'Daily at 9:00'],
        ['0 9 * * 1-5', 'weekdays at 9:00'],
        ['0 9 * * 6', 'days 6 at 9:00'],
    ])('describes %s as "%s"', (expr, expected) => {
        expect(describeCronExpression(expr)).toBe(expected);
    });

    it.each([
        ['* * * * *', 'no pattern matches "every minute"'],
        ['0 0 1,15 * *', 'day-of-month lists have no phrasing'],
        ['0 0 2 1 *', 'yearly has no phrasing'],
    ])('falls back to the raw expression for %s (%s)', (expr) => {
        expect(describeCronExpression(expr)).toBe(expr);
    });

    it('returns the input unchanged when the field count is wrong', () => {
        expect(describeCronExpression('not a cron')).toBe('not a cron');
        expect(describeCronExpression('* * * *')).toBe('* * * *');
    });
});

// ---------------------------------------------------------------------------
// Next-fire computation (observed through create().nextFireAt)
// ---------------------------------------------------------------------------
describe('next-fire computation', () => {
    function nextFire(expr: string, from: Date): string | undefined {
        vi.setSystemTime(from);
        const { scheduler } = makeRig();
        return scheduler.create('task-1', 'ws-1', expr, 'p').nextFireAt;
    }

    const iso = (...args: [number, number, number, number, number]) =>
        new Date(args[0], args[1], args[2], args[3], args[4], 0, 0).toISOString();

    it.each<[string, Date, string]>([
        // Thu 2026-01-01 10:34:30 → next 5-minute boundary.
        ['*/5 * * * *', new Date(2026, 0, 1, 10, 34, 30), iso(2026, 0, 1, 10, 35)],
        // From 10:35:30 the 10:35 slot has passed.
        ['*/5 * * * *', new Date(2026, 0, 1, 10, 35, 30), iso(2026, 0, 1, 10, 40)],
        ['0 * * * *', new Date(2026, 0, 1, 10, 34, 30), iso(2026, 0, 1, 11, 0)],
        ['30 14 * * *', new Date(2026, 0, 1, 10, 0, 0), iso(2026, 0, 1, 14, 30)],
        // Already past today's 14:30 → tomorrow.
        ['30 14 * * *', new Date(2026, 0, 1, 15, 0, 0), iso(2026, 0, 2, 14, 30)],
        // Sat 2026-01-03 → next weekday slot is Mon 2026-01-05.
        ['0 9 * * 1-5', new Date(2026, 0, 3, 10, 0, 0), iso(2026, 0, 5, 9, 0)],
        // Monthly rollover.
        ['0 0 1 * *', new Date(2026, 0, 15, 12, 0, 0), iso(2026, 1, 1, 0, 0)],
        // Day-of-month list picks the nearest entry.
        ['0 0 1,15 * *', new Date(2026, 0, 2, 12, 0, 0), iso(2026, 0, 15, 0, 0)],
        // Leap day exists in 2028.
        ['0 0 29 2 *', new Date(2028, 1, 1, 0, 0, 0), iso(2028, 1, 29, 0, 0)],
        // Sunday as 0 and as 7 are the same day. 2026-01-04 is a Sunday.
        ['0 12 * * 0', new Date(2026, 0, 1, 0, 0, 0), iso(2026, 0, 4, 12, 0)],
        ['0 12 * * 7', new Date(2026, 0, 1, 0, 0, 0), iso(2026, 0, 4, 12, 0)],
    ])('%s from %s', (expr, from, expected) => {
        expect(nextFire(expr, from)).toBe(expected);
    });

    it('starts the search at the next minute, never the current one', () => {
        // Exactly on a matching minute: the *next* fire is one interval later.
        expect(nextFire('*/5 * * * *', new Date(2026, 0, 1, 10, 35, 0)))
            .toBe(iso(2026, 0, 1, 10, 40));
    });

    it('uses OR semantics when both day-of-month and day-of-week are constrained', () => {
        // "midnight on the 13th OR on a Friday". From Thu 2026-01-01 the next
        // hit is Fri 2026-01-02, not the 13th.
        expect(nextFire('0 0 13 * 5', new Date(2026, 0, 1, 10, 0, 0)))
            .toBe(iso(2026, 0, 2, 0, 0));
    });

    it('uses only day-of-month when day-of-week is unconstrained', () => {
        expect(nextFire('0 0 13 * *', new Date(2026, 0, 1, 10, 0, 0)))
            .toBe(iso(2026, 0, 13, 0, 0));
    });

    it('honours a stepped range in the day-of-month field', () => {
        // Days 1, 3, 5, 7, 9 — from the 2nd the next is the 3rd.
        expect(nextFire('0 0 1-9/2 * *', new Date(2026, 0, 2, 0, 0, 0)))
            .toBe(iso(2026, 0, 3, 0, 0));
    });

    it('leaves nextFireAt undefined for an expression that can never match', () => {
        // 30 February: valid syntax, unsatisfiable, so the 366-day search
        // exhausts and returns null.
        expect(nextFire('0 0 30 2 *', new Date(2026, 0, 1, 0, 0, 0))).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// create / update / delete / query surface
// ---------------------------------------------------------------------------
describe('create', () => {
    it('returns a fully populated schedule and emits "created"', () => {
        const { scheduler, events } = makeRig();
        const s = scheduler.create('task-1', 'ws-1', '*/5 * * * *', 'do the thing');

        expect(s.id).toMatch(/^[a-z0-9]{8}$/);
        expect(s).toMatchObject({
            taskId: 'task-1',
            workspaceId: 'ws-1',
            cronExpression: '*/5 * * * *',
            prompt: 'do the thing',
            isRecurring: true,
            isPaused: false,
            fireCount: 0,
        });
        expect(s.createdAt).toBe(T0.toISOString());
        expect(s.lastFiredAt).toBeUndefined();
        expect(events).toEqual([{ event: 'created', task: s }]);
        expect(scheduler.size).toBe(1);
    });

    it('defaults to recurring', () => {
        const { scheduler } = makeRig();
        expect(scheduler.create('task-1', 'ws-1', '* * * * *', 'p').isRecurring).toBe(true);
    });

    it('mints distinct ids', () => {
        const { scheduler } = makeRig();
        const ids = new Set(
            Array.from({ length: 25 }, () => scheduler.create('task-1', 'ws-1', '* * * * *', 'p').id),
        );
        expect(ids.size).toBe(25);
    });

    it('rejects an invalid expression without storing anything', () => {
        const { scheduler, events } = makeRig();
        expect(() => scheduler.create('task-1', 'ws-1', 'nope', 'p'))
            .toThrow(/Invalid cron expression/);
        expect(scheduler.size).toBe(0);
        expect(events).toEqual([]);
    });
});

describe('update', () => {
    it('changes the expression and recomputes nextFireAt', () => {
        const { scheduler, events } = makeRig();
        const s = scheduler.create('task-1', 'ws-1', '0 0 2 1 *', 'p');
        const updated = scheduler.update(s.id, { cronExpression: '30 14 * * *' });

        expect(updated?.cronExpression).toBe('30 14 * * *');
        expect(updated?.nextFireAt).toBe(new Date(2026, 0, 1, 14, 30, 0, 0).toISOString());
        expect(events.map(e => e.event)).toEqual(['created', 'updated']);
    });

    it('rejects an invalid expression and leaves the schedule untouched', () => {
        const { scheduler } = makeRig();
        const s = scheduler.create('task-1', 'ws-1', '30 14 * * *', 'p');
        expect(() => scheduler.update(s.id, { cronExpression: 'x * * * *' })).toThrow();
        expect(scheduler.get(s.id)?.cronExpression).toBe('30 14 * * *');
    });

    it('recomputes expiry when isRecurring flips, anchored on createdAt', () => {
        const { scheduler } = makeRig();
        const s = scheduler.create('task-1', 'ws-1', '30 14 * * *', 'p');
        expect(s.expiresAt).toBe(new Date(T0.getTime() + 3 * DAY).toISOString());

        // Time moves on; expiry must still be measured from createdAt.
        vi.setSystemTime(new Date(T0.getTime() + 5 * MINUTE));
        expect(scheduler.update(s.id, { isRecurring: false })?.expiresAt)
            .toBe(new Date(T0.getTime() + DAY).toISOString());
        expect(scheduler.update(s.id, { isRecurring: true })?.expiresAt)
            .toBe(new Date(T0.getTime() + 3 * DAY).toISOString());
    });

    it('returns null for an unknown id', () => {
        const { scheduler } = makeRig();
        expect(scheduler.update('missing0', { prompt: 'p' })).toBeNull();
    });
});

describe('query helpers', () => {
    it('lists all, filters by task, and looks up by id', () => {
        const { scheduler } = makeRig();
        const a = scheduler.create('task-1', 'ws-1', '* * * * *', 'a');
        const b = scheduler.create('task-1', 'ws-1', '* * * * *', 'b');
        const c = scheduler.create('task-2', 'ws-1', '* * * * *', 'c');

        expect(scheduler.list()).toHaveLength(3);
        expect(scheduler.list('task-1').map(s => s.id).sort()).toEqual([a.id, b.id].sort());
        expect(scheduler.getForTask('task-2')).toEqual([c]);
        expect(scheduler.getForTask('task-nope')).toEqual([]);
        expect(scheduler.get(a.id)).toBe(a);
        expect(scheduler.get('missing0')).toBeUndefined();
        expect(scheduler.size).toBe(3);
    });

    it('delete removes only the targeted schedule and reports unknown ids', () => {
        const { scheduler, events } = makeRig();
        const a = scheduler.create('task-1', 'ws-1', '* * * * *', 'a');
        const b = scheduler.create('task-1', 'ws-1', '* * * * *', 'b');

        expect(scheduler.delete(a.id)).toBe(true);
        expect(scheduler.delete(a.id)).toBe(false);
        expect(scheduler.delete('missing0')).toBe(false);
        expect(scheduler.list().map(s => s.id)).toEqual([b.id]);
        expect(events.filter(e => e.event === 'deleted')).toHaveLength(1);
    });

    it('removeAllForTask drops that task\'s schedules and returns the count', () => {
        const { scheduler } = makeRig();
        scheduler.create('task-1', 'ws-1', '* * * * *', 'a');
        scheduler.create('task-1', 'ws-1', '* * * * *', 'b');
        scheduler.create('task-2', 'ws-1', '* * * * *', 'c');

        expect(scheduler.removeAllForTask('task-1')).toBe(2);
        expect(scheduler.removeAllForTask('task-1')).toBe(0);
        expect(scheduler.list().map(s => s.prompt)).toEqual(['c']);
    });
});

// ---------------------------------------------------------------------------
// Per-task cap
// ---------------------------------------------------------------------------
describe('per-task cap of 50 schedules', () => {
    const fill = (scheduler: Scheduler, taskId: string, n: number) =>
        Array.from({ length: n }, (_, i) => scheduler.create(taskId, 'ws-1', '* * * * *', `p${i}`));

    it('allows exactly 50 and rejects the 51st', () => {
        const { scheduler } = makeRig();
        const created = fill(scheduler, 'task-1', 50);
        expect(created).toHaveLength(50);
        expect(scheduler.getForTask('task-1')).toHaveLength(50);

        expect(() => scheduler.create('task-1', 'ws-1', '* * * * *', 'one too many'))
            .toThrow('Maximum 50 scheduled tasks per task reached');
        expect(scheduler.getForTask('task-1')).toHaveLength(50);
    });

    it('counts per task, not globally', () => {
        const { scheduler } = makeRig();
        fill(scheduler, 'task-1', 50);
        expect(() => scheduler.create('task-2', 'ws-1', '* * * * *', 'fine')).not.toThrow();
        expect(scheduler.size).toBe(51);
    });

    it('frees a slot when a schedule is deleted', () => {
        const { scheduler } = makeRig();
        const created = fill(scheduler, 'task-1', 50);
        scheduler.delete(created[0].id);
        expect(() => scheduler.create('task-1', 'ws-1', '* * * * *', 'replacement')).not.toThrow();
        expect(scheduler.getForTask('task-1')).toHaveLength(50);
    });

    it('frees all slots when the parent task is removed', () => {
        const { scheduler } = makeRig();
        fill(scheduler, 'task-1', 50);
        scheduler.removeAllForTask('task-1');
        expect(() => fill(scheduler, 'task-1', 50)).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// The check loop
// ---------------------------------------------------------------------------
describe('check loop', () => {
    it('fires a due schedule and updates its bookkeeping', () => {
        const rig = makeRig('idle');
        const s = rig.scheduler.create('task-1', 'ws-1', '*/5 * * * *', 'run me');
        expect(s.nextFireAt).toBe(new Date(2026, 0, 1, 10, 35, 0, 0).toISOString());

        tickAt(rig.scheduler, new Date(2026, 0, 1, 10, 35, 0));

        expect(rig.fires).toEqual([
            { taskId: 'task-1', prompt: 'run me', scheduledTaskId: s.id },
        ]);
        const after = rig.scheduler.get(s.id);
        expect(after?.fireCount).toBe(1);
        expect(after?.lastFiredAt).toBe(new Date(2026, 0, 1, 10, 35, 1).toISOString());
        expect(after?.nextFireAt).toBe(new Date(2026, 0, 1, 10, 40, 0, 0).toISOString());
        expect(rig.events.some(e => e.event === 'fired')).toBe(true);
    });

    it('does not fire on a non-matching minute', () => {
        const rig = makeRig('idle');
        rig.scheduler.create('task-1', 'ws-1', '*/5 * * * *', 'run me');
        tickAt(rig.scheduler, new Date(2026, 0, 1, 10, 36, 0));
        expect(rig.fires).toEqual([]);
    });

    it('fires at most once per minute even though it checks every second', () => {
        const rig = makeRig('idle');
        rig.scheduler.create('task-1', 'ws-1', '* * * * *', 'run me');

        vi.setSystemTime(new Date(2026, 0, 1, 10, 35, 0));
        rig.scheduler.start();
        vi.advanceTimersByTime(30_000); // 30 ticks, all inside 10:35

        expect(rig.fires).toHaveLength(1);
        expect(rig.scheduler.get(rig.fires[0].scheduledTaskId)?.fireCount).toBe(1);

        vi.advanceTimersByTime(30_000); // crosses into 10:36
        expect(rig.fires).toHaveLength(2);
    });

    it('skips paused schedules and keeps them alive', () => {
        const rig = makeRig('idle');
        const s = rig.scheduler.create('task-1', 'ws-1', '* * * * *', 'run me');
        rig.scheduler.update(s.id, { isPaused: true });

        tickAt(rig.scheduler, new Date(2026, 0, 1, 10, 35, 0));
        expect(rig.fires).toEqual([]);
        expect(rig.scheduler.get(s.id)?.fireCount).toBe(0);

        rig.scheduler.update(s.id, { isPaused: false });
        tickAt(rig.scheduler, new Date(2026, 0, 1, 10, 36, 0));
        expect(rig.fires).toHaveLength(1);
    });

    it('drops schedules whose parent task has exited', () => {
        const rig = makeRig('idle');
        const s = rig.scheduler.create('task-1', 'ws-1', '* * * * *', 'run me');
        rig.states.set('task-1', 'exited');

        tickAt(rig.scheduler, new Date(2026, 0, 1, 10, 35, 0));

        expect(rig.scheduler.get(s.id)).toBeUndefined();
        expect(rig.fires).toEqual([]);
        expect(rig.events.filter(e => e.event === 'deleted').map(e => e.task.id)).toEqual([s.id]);
    });

    it('skips — but does not delete — schedules whose task state is unknown', () => {
        const rig = makeRig('idle');
        const s = rig.scheduler.create('task-1', 'ws-1', '* * * * *', 'run me');
        rig.states.set('task-1', 'unknown');

        tickAt(rig.scheduler, new Date(2026, 0, 1, 10, 35, 0));
        expect(rig.scheduler.get(s.id)).toBeDefined();
        expect(rig.fires).toEqual([]);

        // Once the task reappears, firing resumes.
        rig.states.set('task-1', 'idle');
        tickAt(rig.scheduler, new Date(2026, 0, 1, 10, 36, 0));
        expect(rig.fires).toHaveLength(1);
    });

    it('start() is idempotent — a second call does not leak a second interval', () => {
        const rig = makeRig('idle');
        rig.scheduler.create('task-1', 'ws-1', '* * * * *', 'run me');
        vi.setSystemTime(new Date(2026, 0, 1, 10, 35, 0));
        rig.scheduler.start();
        rig.scheduler.start();
        vi.advanceTimersByTime(120_000); // ticks through 10:35, 10:36, 10:37
        expect(rig.fires).toHaveLength(3);

        // A single stop() must silence it; a leaked second interval would keep
        // firing here.
        rig.scheduler.stop();
        vi.advanceTimersByTime(120_000);
        expect(rig.fires).toHaveLength(3);
    });

    it('stop() halts checking', () => {
        const rig = makeRig('idle');
        rig.scheduler.create('task-1', 'ws-1', '* * * * *', 'run me');
        vi.setSystemTime(new Date(2026, 0, 1, 10, 35, 0));
        rig.scheduler.start();
        rig.scheduler.stop();
        vi.advanceTimersByTime(120_000);
        expect(rig.fires).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Busy tasks: fires are queued, not dropped
// ---------------------------------------------------------------------------
describe('pending fires while the task is busy', () => {
    it('queues the prompt and delivers it when the task goes idle', () => {
        const rig = makeRig('busy');
        const s = rig.scheduler.create('task-1', 'ws-1', '* * * * *', 'run me');

        tickAt(rig.scheduler, new Date(2026, 0, 1, 10, 35, 0));
        expect(rig.fires).toEqual([]);
        // Bookkeeping still advances — the fire counts as having happened.
        expect(rig.scheduler.get(s.id)?.fireCount).toBe(1);

        rig.scheduler.onTaskIdle('task-1');
        expect(rig.fires).toEqual([
            { taskId: 'task-1', prompt: 'run me', scheduledTaskId: s.id },
        ]);

        // Delivered once only.
        rig.scheduler.onTaskIdle('task-1');
        expect(rig.fires).toHaveLength(1);
    });

    it('ignores onTaskIdle for an unrelated task', () => {
        const rig = makeRig('busy');
        rig.scheduler.create('task-1', 'ws-1', '* * * * *', 'run me');
        tickAt(rig.scheduler, new Date(2026, 0, 1, 10, 35, 0));

        rig.scheduler.onTaskIdle('task-2');
        expect(rig.fires).toEqual([]);
    });

    it('discards a queued fire if the schedule is paused before the task frees up', () => {
        const rig = makeRig('busy');
        const s = rig.scheduler.create('task-1', 'ws-1', '* * * * *', 'run me');
        tickAt(rig.scheduler, new Date(2026, 0, 1, 10, 35, 0));

        rig.scheduler.update(s.id, { isPaused: true });
        rig.scheduler.onTaskIdle('task-1');
        expect(rig.fires).toEqual([]);
    });

    it('discards a queued fire when the prompt is edited', () => {
        const rig = makeRig('busy');
        const s = rig.scheduler.create('task-1', 'ws-1', '* * * * *', 'stale prompt');
        tickAt(rig.scheduler, new Date(2026, 0, 1, 10, 35, 0));

        rig.scheduler.update(s.id, { prompt: 'fresh prompt' });
        rig.scheduler.onTaskIdle('task-1');
        expect(rig.fires).toEqual([]);
    });

    it('discards a queued fire when the schedule is deleted', () => {
        const rig = makeRig('busy');
        const s = rig.scheduler.create('task-1', 'ws-1', '* * * * *', 'run me');
        tickAt(rig.scheduler, new Date(2026, 0, 1, 10, 35, 0));

        rig.scheduler.delete(s.id);
        rig.scheduler.onTaskIdle('task-1');
        expect(rig.fires).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// One-shot vs recurring
// ---------------------------------------------------------------------------
describe('one-shot vs recurring', () => {
    it('a one-shot fires once and then deletes itself', () => {
        const rig = makeRig('idle');
        const s = rig.scheduler.create('task-1', 'ws-1', '* * * * *', 'once', false);
        expect(s.isRecurring).toBe(false);

        tickAt(rig.scheduler, new Date(2026, 0, 1, 10, 35, 0));
        expect(rig.fires).toHaveLength(1);
        expect(rig.scheduler.get(s.id)).toBeUndefined();
        expect(rig.scheduler.size).toBe(0);
        expect(rig.events.filter(e => e.event === 'deleted').map(e => e.task.id)).toEqual([s.id]);

        // The next matching minute must not resurrect it.
        tickAt(rig.scheduler, new Date(2026, 0, 1, 10, 36, 0));
        expect(rig.fires).toHaveLength(1);
    });

    it('a recurring schedule survives firing and fires again', () => {
        const rig = makeRig('idle');
        const s = rig.scheduler.create('task-1', 'ws-1', '* * * * *', 'again', true);

        tickAt(rig.scheduler, new Date(2026, 0, 1, 10, 35, 0));
        tickAt(rig.scheduler, new Date(2026, 0, 1, 10, 36, 0));

        expect(rig.fires).toHaveLength(2);
        expect(rig.scheduler.get(s.id)?.fireCount).toBe(2);
    });

    it('a one-shot queued behind a busy task still deletes itself immediately', () => {
        const rig = makeRig('busy');
        const s = rig.scheduler.create('task-1', 'ws-1', '* * * * *', 'once', false);
        tickAt(rig.scheduler, new Date(2026, 0, 1, 10, 35, 0));

        expect(rig.scheduler.get(s.id)).toBeUndefined();
        // The pending fire is dropped along with the schedule, so the prompt is
        // never delivered. Documenting current behaviour: a one-shot scheduled
        // while its task is busy is silently lost.
        rig.scheduler.onTaskIdle('task-1');
        expect(rig.fires).toEqual([]);
    });

    it('gives a one-shot a 1-day expiry and a recurring schedule 3 days', () => {
        const { scheduler } = makeRig();
        const once = scheduler.create('task-1', 'ws-1', '* * * * *', 'p', false);
        const repeat = scheduler.create('task-1', 'ws-1', '* * * * *', 'p', true);

        expect(once.expiresAt).toBe(new Date(T0.getTime() + DAY).toISOString());
        expect(repeat.expiresAt).toBe(new Date(T0.getTime() + 3 * DAY).toISOString());
    });
});

describe('fireNow', () => {
    it('fires immediately regardless of the schedule and advances bookkeeping', () => {
        const rig = makeRig('idle');
        const s = rig.scheduler.create('task-1', 'ws-1', '0 0 2 1 *', 'manual');

        expect(rig.scheduler.fireNow(s.id)).toBe(true);
        expect(rig.fires).toEqual([
            { taskId: 'task-1', prompt: 'manual', scheduledTaskId: s.id },
        ]);
        expect(rig.scheduler.get(s.id)?.fireCount).toBe(1);
        expect(rig.scheduler.get(s.id)?.lastFiredAt).toBe(T0.toISOString());
    });

    it('queues instead of firing when the task is busy', () => {
        const rig = makeRig('busy');
        const s = rig.scheduler.create('task-1', 'ws-1', '0 0 2 1 *', 'manual');

        rig.scheduler.fireNow(s.id);
        expect(rig.fires).toEqual([]);
        rig.scheduler.onTaskIdle('task-1');
        expect(rig.fires).toHaveLength(1);
    });

    it('deletes a one-shot after a manual fire', () => {
        const rig = makeRig('idle');
        const s = rig.scheduler.create('task-1', 'ws-1', '0 0 2 1 *', 'manual', false);

        expect(rig.scheduler.fireNow(s.id)).toBe(true);
        expect(rig.fires).toHaveLength(1);
        expect(rig.scheduler.get(s.id)).toBeUndefined();
    });

    it('fires a paused schedule when asked explicitly', () => {
        const rig = makeRig('idle');
        const s = rig.scheduler.create('task-1', 'ws-1', '0 0 2 1 *', 'manual');
        rig.scheduler.update(s.id, { isPaused: true });

        expect(rig.scheduler.fireNow(s.id)).toBe(true);
        expect(rig.fires).toHaveLength(1);
    });

    it('reports false for an unknown id', () => {
        const rig = makeRig('idle');
        expect(rig.scheduler.fireNow('missing0')).toBe(false);
        expect(rig.fires).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------
describe('auto-expiry', () => {
    it('removes a recurring schedule once 3 days have elapsed', () => {
        const rig = makeRig('idle');
        const s = rig.scheduler.create('task-1', 'ws-1', '0 0 2 1 *', 'p');

        tickAt(rig.scheduler, new Date(T0.getTime() + 3 * DAY - MINUTE));
        expect(rig.scheduler.get(s.id)).toBeDefined();

        tickAt(rig.scheduler, new Date(T0.getTime() + 3 * DAY));
        expect(rig.scheduler.get(s.id)).toBeUndefined();
        expect(rig.events.filter(e => e.event === 'deleted').map(e => e.task.id)).toEqual([s.id]);
    });

    it('removes a one-shot once 1 day has elapsed, even if it never fired', () => {
        const rig = makeRig('idle');
        const s = rig.scheduler.create('task-1', 'ws-1', '0 0 2 1 *', 'p', false);

        tickAt(rig.scheduler, new Date(T0.getTime() + DAY - MINUTE));
        expect(rig.scheduler.get(s.id)).toBeDefined();

        tickAt(rig.scheduler, new Date(T0.getTime() + DAY));
        expect(rig.scheduler.get(s.id)).toBeUndefined();
        expect(rig.fires).toEqual([]);
    });

    it('expiry wins over a fire due in the same minute', () => {
        const rig = makeRig('idle');
        const s = rig.scheduler.create('task-1', 'ws-1', '* * * * *', 'p');

        // Every minute matches, so the expiry instant is also a due instant.
        tickAt(rig.scheduler, new Date(T0.getTime() + 3 * DAY));
        expect(rig.fires).toEqual([]);
        expect(rig.scheduler.get(s.id)).toBeUndefined();
    });

    it('keeps firing right up to the expiry boundary', () => {
        const rig = makeRig('idle');
        rig.scheduler.create('task-1', 'ws-1', '* * * * *', 'p');
        tickAt(rig.scheduler, new Date(T0.getTime() + 3 * DAY - MINUTE));
        expect(rig.fires).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Persistence, restart and missed fires
// ---------------------------------------------------------------------------
describe('persistence and restart', () => {
    it('writes schedules to disk on a 1s debounce', () => {
        const { scheduler } = makeRig();
        const s = scheduler.create('task-1', 'ws-1', '30 14 * * *', 'p');

        expect(disk.files.has(PERSISTENCE_PATH)).toBe(false);
        flushSave();

        const saved = disk.files.get(PERSISTENCE_PATH) as ScheduledTask[];
        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({ id: s.id, taskId: 'task-1', cronExpression: '30 14 * * *' });
    });

    it('coalesces a burst of mutations into a single write', () => {
        const { scheduler } = makeRig();
        for (let i = 0; i < 5; i++) scheduler.create('task-1', 'ws-1', '* * * * *', `p${i}`);
        vi.advanceTimersByTime(500);
        expect(disk.files.has(PERSISTENCE_PATH)).toBe(false);
        flushSave();
        expect((disk.files.get(PERSISTENCE_PATH) as ScheduledTask[])).toHaveLength(5);
    });

    it('stop() cancels an in-flight debounced save', () => {
        const { scheduler } = makeRig();
        scheduler.create('task-1', 'ws-1', '* * * * *', 'p');
        scheduler.stop();
        flushSave();
        expect(disk.files.has(PERSISTENCE_PATH)).toBe(false);
    });

    it('a fresh scheduler reloads what the previous one persisted', () => {
        const first = makeRig();
        const s = first.scheduler.create('task-1', 'ws-1', '30 14 * * *', 'survive me');
        flushSave();
        first.scheduler.stop();

        const second = makeRig();
        expect(second.scheduler.size).toBe(1);
        expect(second.scheduler.get(s.id)).toMatchObject({
            taskId: 'task-1',
            cronExpression: '30 14 * * *',
            prompt: 'survive me',
        });
        // The reloaded schedule is armed, not inert.
        tickAt(second.scheduler, new Date(2026, 0, 1, 14, 30, 0));
        expect(second.fires).toHaveLength(1);
    });

    it('backfills isPaused for records persisted before the field existed', () => {
        const legacy = {
            id: 'legacy01',
            taskId: 'task-1',
            workspaceId: 'ws-1',
            cronExpression: '* * * * *',
            prompt: 'p',
            isRecurring: true,
            createdAt: T0.toISOString(),
            expiresAt: new Date(T0.getTime() + 3 * DAY).toISOString(),
            fireCount: 0,
        };
        disk.files.set(PERSISTENCE_PATH, [legacy]);

        const rig = makeRig('idle');
        expect(rig.scheduler.get('legacy01')?.isPaused).toBe(false);
        tickAt(rig.scheduler, new Date(2026, 0, 1, 10, 35, 0));
        expect(rig.fires).toHaveLength(1);
    });

    it('skips a corrupt record instead of failing the whole load', () => {
        disk.files.set(PERSISTENCE_PATH, [
            { ...baseRecord('bad00001'), cronExpression: 'not a cron' },
            baseRecord('good0001'),
        ]);

        const rig = makeRig('idle');
        expect(rig.scheduler.get('bad00001')).toBeUndefined();
        expect(rig.scheduler.get('good0001')).toBeDefined();
        expect(rig.scheduler.size).toBe(1);
    });

    // --- catch-up / missed fires -------------------------------------------

    it('does not replay fires that were missed while the process was down', () => {
        const first = makeRig('idle');
        const s = first.scheduler.create('task-1', 'ws-1', '*/5 * * * *', 'p');
        flushSave();
        first.scheduler.stop();

        // Process is down across 10:35, 10:40, 10:45, 10:50 — comes back at 10:52.
        const second = makeRig('idle');
        tickAt(second.scheduler, new Date(2026, 0, 1, 10, 52, 0));
        expect(second.fires).toEqual([]);
        expect(second.scheduler.get(s.id)?.fireCount).toBe(0);

        // It resumes normally at the next real boundary.
        tickAt(second.scheduler, new Date(2026, 0, 1, 10, 55, 0));
        expect(second.fires).toHaveLength(1);
    });

    // Documents current behaviour rather than endorsing it: a reloaded
    // schedule keeps the nextFireAt it was persisted with, so after a restart
    // that spans the scheduled time the stored value points into the past
    // until the schedule next actually fires. Nothing recomputes it on load.
    it('leaves a stale nextFireAt in place after a restart that spanned it', () => {
        const first = makeRig('idle');
        const s = first.scheduler.create('task-1', 'ws-1', '*/5 * * * *', 'p');
        const staleNextFire = s.nextFireAt;
        flushSave();
        first.scheduler.stop();

        vi.setSystemTime(new Date(2026, 0, 1, 10, 52, 0));
        const second = makeRig('idle');
        expect(second.scheduler.get(s.id)?.nextFireAt).toBe(staleNextFire);
        expect(new Date(staleNextFire!).getTime()).toBeLessThan(Date.now());
    });

    it('drops schedules that expired while the process was down, on the first check', () => {
        const first = makeRig('idle');
        const s = first.scheduler.create('task-1', 'ws-1', '0 0 2 1 *', 'p');
        flushSave();
        first.scheduler.stop();

        vi.setSystemTime(new Date(T0.getTime() + 4 * DAY));
        const second = makeRig('idle');
        // load() is not an expiry gate — the record comes back...
        expect(second.scheduler.get(s.id)).toBeDefined();
        // ...and the first check sweeps it.
        tickAt(second.scheduler, new Date(T0.getTime() + 4 * DAY));
        expect(second.scheduler.get(s.id)).toBeUndefined();
    });

    it('a long stall inside a running process loses the fires it slept through', () => {
        const rig = makeRig('idle');
        rig.scheduler.create('task-1', 'ws-1', '*/5 * * * *', 'p');

        // The host suspends at 10:34 and resumes at 11:07: 10:35..11:05 are gone.
        tickAt(rig.scheduler, new Date(2026, 0, 1, 11, 7, 0));
        expect(rig.fires).toEqual([]);

        tickAt(rig.scheduler, new Date(2026, 0, 1, 11, 10, 0));
        expect(rig.fires).toHaveLength(1);
    });
});

function baseRecord(id: string): ScheduledTask {
    return {
        id,
        taskId: 'task-1',
        workspaceId: 'ws-1',
        cronExpression: '* * * * *',
        prompt: 'p',
        isRecurring: true,
        isPaused: false,
        createdAt: T0.toISOString(),
        expiresAt: new Date(T0.getTime() + 3 * DAY).toISOString(),
        fireCount: 0,
    };
}
