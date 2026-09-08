/**
 * Memory guard eviction policy.
 *
 * The selection function is pure, so these assert the actual eviction rules
 * without spawning agents or depending on the host's memory state.
 */

import { describe, it, expect } from 'vitest';
import {
    selectTasksToDisconnect,
    budgetBytesFromPct,
    measureRssByPid,
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

    it('never touches busy or waiting_input agents', () => {
        // Busy agents are mid-work; waiting_input holds an unanswered question.
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
        // Only the idle one is eligible even though it is by far the newest.
        expect(r.toDisconnect).toEqual(['idle']);
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
