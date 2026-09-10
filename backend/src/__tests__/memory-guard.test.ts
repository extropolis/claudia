/**
 * Memory guard eviction policy.
 *
 * The selection function is pure, so these assert the actual eviction rules
 * without spawning agents or depending on the host's memory state.
 */

import { describe, it, expect } from 'vitest';
import type { CpuInfo } from 'os';
import {
    selectTasksToDisconnect,
    budgetBytesFromPct,
    measureRssByPid,
    computeCpuBusyPct,
    GuardCandidate,
} from '../memory-guard.js';

const MB = 1048576;

/** Build a candidate; `agoMin` is how long ago it was last active. */
function task(id: string, state: string, agoMin: number, pid?: number): GuardCandidate {
    return {
        id,
        state,
        lastActivity: new Date(Date.now() - agoMin * 60_000),
        pid,
    };
}

function rss(pairs: Array<[number, number]>): Map<number, number> {
    return new Map(pairs.map(([pid, mb]) => [pid, mb * MB]));
}

describe('selectTasksToDisconnect', () => {
    it('does nothing while under budget', () => {
        const r = selectTasksToDisconnect({
            tasks: [task('a', 'idle', 600, 1), task('b', 'idle', 500, 2)],
            rssByPid: rss([[1, 100], [2, 100]]),
            budgetBytes: 500 * MB,
            minLive: 1,
        });
        expect(r.toDisconnect).toEqual([]);
        expect(r.usedBytes).toBe(200 * MB);
    });

    it('sheds the coldest first, and only as many as needed', () => {
        const r = selectTasksToDisconnect({
            tasks: [
                task('warm', 'idle', 10, 1),
                task('coldest', 'idle', 900, 2),
                task('cold', 'idle', 300, 3),
            ],
            rssByPid: rss([[1, 100], [2, 100], [3, 100]]),
            budgetBytes: 250 * MB, // 300 used → shedding one 100MB agent suffices
            minLive: 1,
        });
        expect(r.toDisconnect).toEqual(['coldest']);
        expect(r.projectedBytes).toBe(200 * MB);
    });

    it('sheds multiple when one is not enough', () => {
        const r = selectTasksToDisconnect({
            tasks: [
                task('a', 'idle', 900, 1),
                task('b', 'idle', 800, 2),
                task('c', 'idle', 700, 3),
                task('d', 'idle', 10, 4),
            ],
            rssByPid: rss([[1, 100], [2, 100], [3, 100], [4, 100]]),
            budgetBytes: 150 * MB,
            minLive: 1,
        });
        expect(r.toDisconnect).toEqual(['a', 'b', 'c']);
    });

    it('never touches busy agents, however tight the budget', () => {
        // Busy agents are mid-work; disconnecting one would drop real progress.
        const r = selectTasksToDisconnect({
            tasks: [
                task('busy', 'busy', 999, 1),
                task('idle', 'idle', 5, 2),
            ],
            rssByPid: rss([[1, 500], [2, 100]]),
            budgetBytes: 100 * MB,
            minLive: 0,
        });
        // Only the idle one is eligible even though it is by far the newest.
        expect(r.toDisconnect).toEqual(['idle']);
    });

    it('sheds waiting_input agents too, coldest first alongside idle ones', () => {
        // waiting_input holds an unanswered prompt — not busy, and disconnecting
        // only kills the PTY; sessionId and history survive for the next click.
        const r = selectTasksToDisconnect({
            tasks: [
                task('busy', 'busy', 999, 1),
                task('waiting', 'waiting_input', 998, 2),
                task('idle', 'idle', 5, 3),
            ],
            rssByPid: rss([[1, 500], [2, 500], [3, 100]]),
            budgetBytes: 100 * MB,
            minLive: 1,
        });
        // busy is still never touched; waiting_input sheds before idle since it's colder.
        expect(r.toDisconnect).toEqual(['waiting', 'idle']);
    });

    it('respects the minimum-live floor even when far over budget', () => {
        const r = selectTasksToDisconnect({
            tasks: [
                task('a', 'idle', 900, 1),
                task('b', 'idle', 800, 2),
                task('c', 'idle', 700, 3),
            ],
            rssByPid: rss([[1, 500], [2, 500], [3, 500]]),
            budgetBytes: 1 * MB,
            minLive: 2, // 3 live → may shed exactly 1
        });
        expect(r.toDisconnect).toEqual(['a']);
    });

    it('sheds nothing when everything is busy, however tight memory is', () => {
        const r = selectTasksToDisconnect({
            tasks: [task('a', 'busy', 900, 1), task('b', 'busy', 800, 2)],
            rssByPid: rss([[1, 900], [2, 900]]),
            budgetBytes: 1 * MB,
            minLive: 0,
        });
        expect(r.toDisconnect).toEqual([]);
    });

    it('ignores tasks with no pid (already disconnected)', () => {
        const r = selectTasksToDisconnect({
            tasks: [task('gone', 'idle', 999, undefined), task('live', 'idle', 5, 1)],
            rssByPid: rss([[1, 100]]),
            budgetBytes: 50 * MB,
            minLive: 0,
        });
        expect(r.toDisconnect).toEqual(['live']);
    });

    it('treats an unmeasurable pid as zero rather than shedding blindly', () => {
        // measureRssByPid returns an empty map on failure; that must read as
        // "under budget" so a broken measurement never evicts anyone.
        const r = selectTasksToDisconnect({
            tasks: [task('a', 'idle', 900, 1)],
            rssByPid: new Map(),
            budgetBytes: 1,
            minLive: 0,
        });
        expect(r.toDisconnect).toEqual([]);
        expect(r.usedBytes).toBe(0);
    });

    it('does nothing when live count is within maxLive, regardless of budget slack', () => {
        const r = selectTasksToDisconnect({
            tasks: [task('a', 'idle', 10, 1), task('b', 'idle', 10, 2)],
            rssByPid: rss([[1, 10], [2, 10]]),
            budgetBytes: 1000 * MB,
            minLive: 0,
            maxLive: 5,
        });
        expect(r.toDisconnect).toEqual([]);
    });

    it('sheds the coldest down to maxLive even when well under the memory budget', () => {
        const r = selectTasksToDisconnect({
            tasks: [
                task('warm', 'idle', 10, 1),
                task('coldest', 'idle', 900, 2),
                task('cold', 'idle', 300, 3),
            ],
            rssByPid: rss([[1, 10], [2, 10], [3, 10]]),
            budgetBytes: 1000 * MB, // nowhere close
            minLive: 1,
            maxLive: 2, // 3 live -> shed the single coldest
        });
        expect(r.toDisconnect).toEqual(['coldest']);
    });

    it('respects minLive even when maxLive demands shedding further', () => {
        const r = selectTasksToDisconnect({
            tasks: [
                task('a', 'idle', 900, 1),
                task('b', 'idle', 800, 2),
                task('c', 'idle', 700, 3),
            ],
            rssByPid: rss([[1, 10], [2, 10], [3, 10]]),
            budgetBytes: 1000 * MB,
            minLive: 2,
            maxLive: 1, // would want to shed to 1 live, but the floor is 2
        });
        expect(r.toDisconnect).toEqual(['a']);
    });

    it('sheds enough to satisfy whichever of budget or maxLive demands more', () => {
        const r = selectTasksToDisconnect({
            tasks: [
                task('a', 'idle', 900, 1),
                task('b', 'idle', 800, 2),
                task('c', 'idle', 10, 3),
            ],
            rssByPid: rss([[1, 50], [2, 50], [3, 50]]), // 150MB used
            budgetBytes: 120 * MB, // shedding 'a' alone satisfies the budget
            minLive: 0,
            maxLive: 1, // but the session cap wants live count down to 1
        });
        expect(r.toDisconnect).toEqual(['a', 'b']);
    });
});

describe('computeCpuBusyPct', () => {
    function cpu(idle: number, other: number): CpuInfo {
        return { model: 'test', speed: 0, times: { user: other, nice: 0, sys: 0, idle, irq: 0 } };
    }

    it('reports 0% when the two samples have not advanced', () => {
        const sample = [cpu(1000, 0)];
        expect(computeCpuBusyPct(sample, sample)).toBe(0);
    });

    it('reports 100% busy when idle ticks never advance but total ticks do', () => {
        const prev = [cpu(1000, 0)];
        const curr = [cpu(1000, 100)]; // all 100 new ticks went to "user", none to idle
        expect(computeCpuBusyPct(prev, curr)).toBe(100);
    });

    it('reports a proportional busy percentage', () => {
        const prev = [cpu(1000, 0)];
        const curr = [cpu(1050, 50)]; // 100 new ticks total, half idle
        expect(computeCpuBusyPct(prev, curr)).toBe(50);
    });

    it('sums across cores rather than averaging per-core percentages', () => {
        const prev = [cpu(1000, 0), cpu(1000, 0)];
        // core 0 fully busy (100 new ticks, 0 idle), core 1 fully idle (100 new ticks, all idle)
        const curr = [cpu(1000, 100), cpu(1100, 0)];
        expect(computeCpuBusyPct(prev, curr)).toBe(50);
    });

    it('treats a missing previous sample (new core coming online) as a zero baseline', () => {
        const prev: CpuInfo[] = [];
        const curr = [cpu(1000, 0)];
        // No prior sample for this core -> prev falls back to curr, so the
        // diff is zero and it must not be misread as "fully busy".
        expect(computeCpuBusyPct(prev, curr)).toBe(0);
    });
});

describe('measurement helpers', () => {
    it('measures this process and reports a plausible size', () => {
        const m = measureRssByPid([process.pid]);
        const bytes = m.get(process.pid);
        expect(bytes).toBeGreaterThan(1 * MB);
        expect(bytes).toBeLessThan(8000 * MB);
    });

    it('returns an empty map for no pids', () => {
        expect(measureRssByPid([]).size).toBe(0);
    });

    it('derives a budget as a share of system RAM', () => {
        const half = budgetBytesFromPct(50);
        const quarter = budgetBytesFromPct(25);
        expect(half).toBeGreaterThan(0);
        expect(Math.abs(half - quarter * 2)).toBeLessThan(4);
    });
});
