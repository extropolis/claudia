/**
 * Memory guard: disconnect the least-recently-used agents before the host
 * starts paging.
 *
 * Each live task holds a Claude CLI process (~300MB measured) plus MCP
 * sidecars. Nothing bounded how many ran at once, so on a 24GB machine ~60
 * concurrent agents demanded ~30GB and the host swapped continuously — load
 * average hit 205 with 0.9% idle while doing no useful work.
 *
 * Disconnecting is not killing: the PTY stops but the task keeps its
 * sessionId, stays in the sidebar, and resumes via --resume when clicked. So
 * shedding the coldest agents costs a few seconds of resume latency rather
 * than any work.
 *
 * Policy is deliberately split from measurement — `selectTasksToDisconnect` is
 * pure, so the eviction rules are unit-testable without spawning processes or
 * depending on the host's memory state.
 */

import { execFileSync } from 'child_process';
import os from 'os';
import { createLogger } from './logger.js';

const logger = createLogger('[MemoryGuard]');

/** Fraction of system RAM that live agents may occupy before shedding. */
export const DEFAULT_BUDGET_PCT = 45;
/** Never shed below this many live agents, however tight memory is. */
export const DEFAULT_MIN_LIVE = 3;

export interface GuardCandidate {
    id: string;
    /** Only 'idle' tasks are eligible; others are doing or awaiting work. */
    state: string;
    lastActivity: Date;
    /** PTY pid, used to attribute memory. Undefined when not running. */
    pid?: number;
}

export interface SelectionInput {
    tasks: GuardCandidate[];
    /** Resident bytes per pid. Missing pids contribute 0. */
    rssByPid: Map<number, number>;
    budgetBytes: number;
    minLive: number;
}

export interface SelectionResult {
    /** Task ids to disconnect, coldest first. */
    toDisconnect: string[];
    usedBytes: number;
    projectedBytes: number;
}

/**
 * Choose the coldest idle agents to shed until projected usage fits the budget.
 *
 * Rules, in order:
 * - Only `idle` tasks are eligible. A busy agent is mid-work and a
 *   `waiting_input` agent holds a question the user hasn't answered yet;
 *   disconnecting either would look like data loss even though it isn't.
 * - Oldest `lastActivity` goes first — least likely to be missed.
 * - Stop once projected usage fits, or once `minLive` agents remain, so the
 *   guard can never empty the workspace.
 *
 * Note the count floor applies to ALL live tasks, not just idle ones: if
 * everything is busy there is nothing to shed and we return empty rather than
 * touching working agents.
 */
export function selectTasksToDisconnect(input: SelectionInput): SelectionResult {
    const { tasks, rssByPid, budgetBytes, minLive } = input;

    const rssOf = (t: GuardCandidate) =>
        t.pid !== undefined ? rssByPid.get(t.pid) ?? 0 : 0;

    const live = tasks.filter(t => t.pid !== undefined);
    const usedBytes = live.reduce((s, t) => s + rssOf(t), 0);

    if (usedBytes <= budgetBytes) {
        return { toDisconnect: [], usedBytes, projectedBytes: usedBytes };
    }

    const coldestFirst = live
        .filter(t => t.state === 'idle')
        .sort((a, b) => a.lastActivity.getTime() - b.lastActivity.getTime());

    const toDisconnect: string[] = [];
    let projectedBytes = usedBytes;
    let liveCount = live.length;

    for (const t of coldestFirst) {
        if (projectedBytes <= budgetBytes) break;
        if (liveCount <= minLive) break;
        toDisconnect.push(t.id);
        projectedBytes -= rssOf(t);
        liveCount--;
    }

    return { toDisconnect, usedBytes, projectedBytes };
}

/**
 * Resident bytes for the given pids.
 *
 * One batched process call rather than per-pid, since this runs on an interval
 * with dozens of pids.
 *
 * CAVEAT: on macOS, RSS excludes pages the compressor or swap already took, so
 * once the host is thrashing this UNDER-reports — exactly when accuracy would
 * matter most. It is therefore a lower bound, which argues for a conservative
 * budget that trips before swapping begins rather than after.
 */
export function measureRssByPid(pids: number[]): Map<number, number> {
    const out = new Map<number, number>();
    if (pids.length === 0) return out;

    try {
        if (process.platform === 'win32') {
            // tasklist reports "Mem Usage" in KB with thousands separators.
            const csv = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
                encoding: 'utf-8',
                timeout: 10_000,
            });
            const wanted = new Set(pids);
            for (const line of csv.split(/\r?\n/)) {
                const cols = line.split('","').map(c => c.replace(/^"|"$/g, ''));
                if (cols.length < 5) continue;
                const pid = parseInt(cols[1], 10);
                if (!wanted.has(pid)) continue;
                const kb = parseInt(cols[4].replace(/[^0-9]/g, ''), 10);
                if (Number.isFinite(kb)) out.set(pid, kb * 1024);
            }
        } else {
            const stdout = execFileSync('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], {
                encoding: 'utf-8',
                timeout: 10_000,
            });
            for (const line of stdout.split('\n')) {
                const m = line.trim().match(/^(\d+)\s+(\d+)$/);
                if (!m) continue;
                out.set(parseInt(m[1], 10), parseInt(m[2], 10) * 1024);
            }
        }
    } catch (err) {
        // A measurement failure must not shed agents: callers treat an empty
        // map as "0 bytes used", which is under any budget, so nothing happens.
        logger.warn('Could not measure task memory; skipping this pass', { error: err });
        return new Map();
    }
    return out;
}

/** Budget in bytes from a percentage of system RAM. */
export function budgetBytesFromPct(pct: number): number {
    return Math.floor((os.totalmem() * pct) / 100);
}

export function formatMB(bytes: number): number {
    return Math.round(bytes / 1048576);
}
