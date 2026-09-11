/**
 * Single-instance lock: at most one backend may own a data directory.
 *
 * Claudia's state — tasks.json, workspace-config.json, task-histories/, cron
 * schedules — has no concurrency control. Two backends sharing one data
 * directory do not merge; they overwrite each other, and the loser's tasks
 * vanish.
 *
 * Historically three partial guards stood in for mutual exclusion:
 *
 *   1. `start.sh` wrote /tmp/claudia-server.lock. Only covers processes started
 *      through that one script, and only on the same machine's /tmp — Electron,
 *      `npm run dev`, containers and CI all bypassed it.
 *   2. `EADDRINUSE` on listen. Only catches a collision on the SAME port; two
 *      backends on 4001 and 4002 against one data dir bind happily.
 *   3. `TaskSpawner.saveTasks()` refusing to write when tasks.json's mtime moved.
 *      Detects the damage after both processes are already running, protects
 *      exactly one file out of a dozen, and silently stops persisting instead of
 *      telling anyone.
 *
 * None is authoritative. This module is: the lock lives NEXT TO the state it
 * protects, so it is keyed on the thing that actually must not be shared.
 *
 * The lock file is `<dataDir>/instance.json`, holding an {@link InstanceInfo}.
 * Any launcher can read it (or ask a running backend via `/api/server-info`) to
 * find out who is holding the directory and where to attach.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { dataPath } from './paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Lock file name, inside the data directory. */
export const INSTANCE_LOCK_FILE = 'instance.json';

/** Default budget for the "is the holder actually serving?" health probe. */
export const HEALTH_PROBE_TIMEOUT_MS = 500;

/**
 * Who owns a data directory. Also the payload of `GET /api/server-info`, so it
 * must never grow a secret-bearing field.
 */
export interface InstanceInfo {
    /** Random per-boot id. Identifies THIS run, not the install. */
    instanceId: string;
    pid: number;
    port: number;
    /** ISO-8601. */
    startedAt: string;
    version: string;
}

/** Thrown when another live backend already owns the data directory. */
export class InstanceLockError extends Error {
    constructor(public readonly existing: InstanceInfo) {
        super(
            `Claudia is already running (pid ${existing.pid}) at http://localhost:${existing.port}`,
        );
        this.name = 'InstanceLockError';
    }
}

export interface AcquireOptions {
    /**
     * Liveness check for the pid named in an existing lock. Injectable so tests
     * can describe a scenario without spawning processes.
     */
    isPidAlive?: (pid: number) => boolean;
    /** "Is a backend actually serving on this port?" Injectable for tests. */
    probeHealth?: (port: number) => boolean;
    /** This process's pid. Injectable for tests. */
    pid?: number;
    /** Health-probe budget in ms. */
    probeTimeoutMs?: number;
}

/**
 * Is a pid running?
 *
 * `process.kill(pid, 0)` sends no signal; it only asks the kernel to resolve
 * the pid. ESRCH means no such process — dead. EPERM means the process exists
 * but belongs to another user — alive, and emphatically not ours to reap.
 */
export function isPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/**
 * Ask `http://127.0.0.1:<port>/api/health` whether anybody is home.
 *
 * Synchronous on purpose: acquisition happens before `server.listen()` and
 * before any store is constructed, and making it async would mean every caller
 * (index.ts, the Electron backend worker, future launchers) has to remember to
 * await it before touching state. A short-lived `node -e` child is the portable
 * way to do a blocking HTTP request — it costs one process spawn, and only in
 * the rare ambiguous case where a lock file names a pid that is still alive.
 */
export function probeHealth(port: number, timeoutMs = HEALTH_PROBE_TIMEOUT_MS): boolean {
    if (!Number.isInteger(port) || port <= 0) return false;
    const script = `
        const http = require('http');
        const req = http.get(
            { host: '127.0.0.1', port: ${port}, path: '/api/health', timeout: ${timeoutMs} },
            (res) => { res.resume(); process.exit(res.statusCode === 200 ? 0 : 1); },
        );
        req.on('timeout', () => { req.destroy(); process.exit(1); });
        req.on('error', () => process.exit(1));
    `;
    try {
        const result = spawnSync(process.execPath, ['-e', script], {
            // Hard ceiling in case the child itself wedges: the in-child timeout
            // should always fire first, this is the backstop.
            timeout: timeoutMs + 2000,
            stdio: 'ignore',
        });
        return result.status === 0;
    } catch {
        // Cannot probe (spawn blocked, no exec permission) — report "not
        // responding". The caller then treats the lock as stale, which favours
        // being able to start over refusing to start; the pid check already
        // handled the common case.
        return false;
    }
}

/**
 * Create the lock file only if it does not already exist.
 *
 * `wx` is O_CREAT|O_EXCL: the check and the create are one syscall, which is
 * what makes this usable as a lock at all. Returns false when somebody else
 * holds it, and only then.
 */
function tryCreateExclusive(file: string, info: InstanceInfo): boolean {
    try {
        writeFileSync(file, JSON.stringify(info, null, 2), { flag: 'wx' });
        return true;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw err;
    }
}

/** Parse an on-disk lock. Returns null for missing, corrupt or malformed files. */
export function readInstanceLock(dataDir: string | undefined): InstanceInfo | null {
    const file = dataPath(dataDir, INSTANCE_LOCK_FILE);
    try {
        if (!existsSync(file)) return null;
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object') return null;
        const { instanceId, pid, port, startedAt, version } = parsed as Record<string, unknown>;
        if (typeof instanceId !== 'string' || !instanceId) return null;
        if (typeof pid !== 'number' || !Number.isInteger(pid)) return null;
        if (typeof port !== 'number' || !Number.isInteger(port)) return null;
        if (typeof startedAt !== 'string') return null;
        if (typeof version !== 'string') return null;
        return { instanceId, pid, port, startedAt, version };
    } catch {
        return null;
    }
}

/**
 * Claim the data directory for this process.
 *
 * @throws {InstanceLockError} when another backend genuinely holds it. The
 * error carries the holder's {@link InstanceInfo} so the caller can print a
 * URL to attach to instead of a bare failure.
 *
 * ## Why a live pid is not enough to refuse
 *
 * In development the backend runs under `tsx watch`: on every edit the old
 * process is signalled and a new one starts IMMEDIATELY, well before the old
 * one has finished exiting. A naive "lock file names a live pid → refuse"
 * would therefore fail almost every dev reload, which is exactly the kind of
 * flakiness that gets a safety mechanism ripped out again.
 *
 * The disambiguator is that a backend on its way out has already stopped
 * serving HTTP even though its pid lingers. So an existing lock naming a LIVE
 * pid is ambiguous, and is resolved by a second, independent question — does
 * anything answer `/api/health` on the holder's port within
 * {@link HEALTH_PROBE_TIMEOUT_MS}?
 *
 *   live pid + health answers  → genuinely running: refuse.
 *   live pid + health silent   → dying, wedged, or a recycled pid: take over.
 *   dead pid                   → stale lock: take over.
 *
 * Both signals must agree before we refuse to start, and the two failure modes
 * are asymmetric on purpose: refusing to start when the holder is actually gone
 * is a wedged install a user cannot fix, while taking over from a process that
 * no longer answers is the case the old guards were trying to reach anyway.
 */
export function acquireInstanceLock(
    dataDir: string | undefined,
    port: number,
    version: string,
    options: AcquireOptions = {},
): { info: InstanceInfo; release: () => void } {
    const alive = options.isPidAlive ?? isPidAlive;
    const probeTimeoutMs = options.probeTimeoutMs ?? HEALTH_PROBE_TIMEOUT_MS;
    const probe = options.probeHealth ?? ((p: number) => probeHealth(p, probeTimeoutMs));
    const ourPid = options.pid ?? process.pid;

    const file = dataPath(dataDir, INSTANCE_LOCK_FILE);
    const info: InstanceInfo = {
        instanceId: randomUUID(),
        pid: ourPid,
        port,
        startedAt: new Date().toISOString(),
        version,
    };

    mkdirSync(dirname(file), { recursive: true });

    // Fast path, and the only path that is safe against two backends starting
    // in the same instant: O_EXCL makes "create the lock" a single atomic
    // filesystem operation, so exactly one of them can win it. A read-then-write
    // would let both see an empty directory and both believe they own it.
    if (!tryCreateExclusive(file, info)) {
        const existing = readInstanceLock(dataDir);

        if (existing && existing.pid !== ourPid && alive(existing.pid)) {
            // Ambiguous — see the doc comment above. Only a holder that BOTH
            // exists and answers HTTP blocks this boot.
            if (probe(existing.port)) {
                throw new InstanceLockError(existing);
            }
            console.warn(
                `[InstanceLock] Stale lock: pid ${existing.pid} is alive but nothing answered ` +
                `http://127.0.0.1:${existing.port}/api/health within ${probeTimeoutMs}ms — taking over.`,
            );
        } else if (existing) {
            console.warn(`[InstanceLock] Replacing stale lock from pid ${existing.pid} (not running).`);
        } else {
            // Present but unreadable — a truncated write from a process that
            // died mid-save. Nothing to defer to.
            console.warn('[InstanceLock] Replacing unreadable lock file.');
        }

        // Clear the stale lock and re-race for it. If someone else claimed the
        // directory in the gap, they are by definition newer than the holder we
        // just judged dead, so defer to them rather than stomping.
        try { unlinkSync(file); } catch { /* already gone */ }
        if (!tryCreateExclusive(file, info)) {
            const winner = readInstanceLock(dataDir);
            throw new InstanceLockError(winner ?? { ...info, instanceId: 'unknown', pid: -1 });
        }
    }

    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        try {
            // NEVER delete somebody else's lock. If we were the stale instance
            // and a successor already took the directory, its lock outlives us.
            const current = readInstanceLock(dataDir);
            if (current && current.instanceId !== info.instanceId) return;
            if (existsSync(file)) unlinkSync(file);
        } catch (err) {
            console.warn('[InstanceLock] Failed to release lock:', err);
        }
    };

    return { info, release };
}

/**
 * The running backend's version.
 *
 * `scripts/release.mjs` treats `version.txt` as the source of truth and syncs
 * it into every package.json, so the backend's own package.json is the same
 * number and is the copy that actually ships next to the code (dist/ and src/
 * are both one level below it). version.txt is the fallback for a checkout
 * where package.json is unreadable.
 */
export function resolveBackendVersion(): string {
    const candidates: Array<[string, (raw: string) => string | undefined]> = [
        [join(__dirname, '..', 'package.json'), (raw) => JSON.parse(raw).version],
        [join(__dirname, '..', '..', 'version.txt'), (raw) => raw.trim() || undefined],
    ];
    for (const [file, extract] of candidates) {
        try {
            if (!existsSync(file)) continue;
            const value = extract(readFileSync(file, 'utf8'));
            if (typeof value === 'string' && value) return value;
        } catch {
            // Try the next candidate.
        }
    }
    return '0.0.0';
}
