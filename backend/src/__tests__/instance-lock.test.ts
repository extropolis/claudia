/**
 * Single-instance lock: exactly one backend per data directory.
 *
 * Before this existed, mutual exclusion was three partial guards — start.sh's
 * /tmp lock file, EADDRINUSE in index.ts, and tasks.json mtime checking in the
 * spawner. None was authoritative: two backends on different ports sharing one
 * data dir corrupted each other happily.
 *
 * These tests never spawn a process and never open a socket — the liveness and
 * health probes are injected — so the suite runs identically on the Windows CI
 * leg. Temp dirs live under homedir(), NOT os.tmpdir(): macOS resolves the
 * latter under /var, which validateWorkspacePath blocklists as a system path.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
    acquireInstanceLock,
    readInstanceLock,
    InstanceLockError,
    INSTANCE_LOCK_FILE,
    isPidAlive,
    probeHealth,
    resolveBackendVersion,
    type InstanceInfo,
} from '../instance-lock.js';
import { writeHandoffMark, readHandoffMark, clearHandoffMark } from '../export-import/handoff.js';

const dirs: string[] = [];
const releases: Array<() => void> = [];

function tempDataDir(): string {
    const d = mkdtempSync(join(homedir(), '.claudia-instance-lock-test-'));
    dirs.push(d);
    return d;
}

const lockPath = (dir: string) => join(dir, INSTANCE_LOCK_FILE);

/** A pid that cannot be running. Guarded below so the test is honest. */
const IMPOSSIBLE_PID = 2 ** 31 - 1;

function pidIsActuallyDead(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return false;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ESRCH';
    }
}

/** Write a lock file by hand, as a previous instance would have left it. */
function seedLock(dir: string, overrides: Partial<InstanceInfo> = {}): InstanceInfo {
    const info: InstanceInfo = {
        instanceId: 'seeded-instance-id',
        pid: IMPOSSIBLE_PID,
        port: 4321,
        startedAt: new Date().toISOString(),
        version: '9.9.9',
        ...overrides,
    };
    writeFileSync(lockPath(dir), JSON.stringify(info));
    return info;
}

/** Liveness stub: only the listed pids are "running". */
const alive = (...pids: number[]) => (pid: number) => pids.includes(pid);
const nothingAlive = () => false;

afterEach(() => {
    for (const release of releases.splice(0)) {
        try { release(); } catch { /* best effort */ }
    }
    for (const dir of dirs.splice(0)) {
        try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
    }
});

function acquire(
    dir: string,
    port: number,
    opts: Parameters<typeof acquireInstanceLock>[3] = {},
) {
    const handle = acquireInstanceLock(dir, port, '1.2.3', {
        isPidAlive: nothingAlive,
        probeHealth: () => false,
        ...opts,
    });
    releases.push(handle.release);
    return handle;
}

describe('acquireInstanceLock', () => {
    it('writes instance.json describing this process', () => {
        const dir = tempDataDir();
        const { info } = acquire(dir, 4599);

        expect(existsSync(lockPath(dir))).toBe(true);
        const onDisk = JSON.parse(readFileSync(lockPath(dir), 'utf8'));
        expect(onDisk).toEqual(info);
        expect(onDisk.pid).toBe(process.pid);
        expect(onDisk.port).toBe(4599);
        expect(onDisk.version).toBe('1.2.3');
        expect(typeof onDisk.instanceId).toBe('string');
        expect(onDisk.instanceId.length).toBeGreaterThan(8);
        expect(Number.isNaN(Date.parse(onDisk.startedAt))).toBe(false);
    });

    it('creates the data directory if it does not exist yet', () => {
        const dir = join(tempDataDir(), 'nested', 'state');
        const { info } = acquire(dir, 4600);
        expect(JSON.parse(readFileSync(lockPath(dir), 'utf8')).instanceId).toBe(info.instanceId);
    });

    it('throws InstanceLockError carrying the holder when a live backend answers health', () => {
        const dir = tempDataDir();
        const held = seedLock(dir, { pid: 424242, port: 4777, instanceId: 'holder-1' });

        let thrown: unknown;
        try {
            acquire(dir, 4888, { isPidAlive: alive(424242), probeHealth: () => true });
        } catch (err) {
            thrown = err;
        }

        expect(thrown).toBeInstanceOf(InstanceLockError);
        const e = thrown as InstanceLockError;
        // The caller needs the holder's URL to tell the user where to attach.
        expect(e.existing.port).toBe(4777);
        expect(e.existing.pid).toBe(424242);
        expect(e.existing.instanceId).toBe('holder-1');
        expect(e.message).toContain('4777');
        // The refused acquire must not have touched the holder's file.
        expect(JSON.parse(readFileSync(lockPath(dir), 'utf8'))).toEqual(held);
    });

    it('a second acquire against the same dir throws, carrying the first instance port', () => {
        const dir = tempDataDir();
        const first = acquire(dir, 4611, { isPidAlive: alive(process.pid), probeHealth: () => true });

        // A genuinely separate process: same dir, different pid, health answers.
        expect(() =>
            acquireInstanceLock(dir, 4612, '1.2.3', {
                isPidAlive: alive(process.pid),
                probeHealth: () => true,
                // Pretend we are a different process so the "our own lock" path
                // does not short-circuit the conflict.
                pid: process.pid + 1,
            }),
        ).toThrowError(InstanceLockError);

        try {
            acquireInstanceLock(dir, 4612, '1.2.3', {
                isPidAlive: alive(process.pid),
                probeHealth: () => true,
                pid: process.pid + 1,
            });
        } catch (err) {
            expect((err as InstanceLockError).existing.port).toBe(4611);
            expect((err as InstanceLockError).existing.instanceId).toBe(first.info.instanceId);
        }
    });

    it('treats a lock naming a dead pid as stale and takes it over', () => {
        // Honesty guard: if this pid somehow exists, the test proves nothing.
        expect(pidIsActuallyDead(IMPOSSIBLE_PID)).toBe(true);

        const dir = tempDataDir();
        seedLock(dir, { instanceId: 'dead-holder' });

        // Real liveness check here — the pid genuinely does not exist.
        const handle = acquireInstanceLock(dir, 4650, '1.2.3', { probeHealth: () => false });
        releases.push(handle.release);
        const { info } = handle;

        expect(info.instanceId).not.toBe('dead-holder');
        expect(JSON.parse(readFileSync(lockPath(dir), 'utf8')).pid).toBe(process.pid);
    });

    it('takes over when the pid is alive but health does not answer (tsx watch restart)', () => {
        const dir = tempDataDir();
        seedLock(dir, { pid: 424242, port: 4700, instanceId: 'dying-holder' });

        // The outgoing tsx-watch process is still alive for a moment but has
        // already stopped serving: the lock must NOT block the incoming one.
        const { info } = acquire(dir, 4700, { isPidAlive: alive(424242), probeHealth: () => false });

        expect(info.instanceId).not.toBe('dying-holder');
        expect(JSON.parse(readFileSync(lockPath(dir), 'utf8')).instanceId).toBe(info.instanceId);
    });

    it('probes the holder port, not our own, when resolving an ambiguous lock', () => {
        const dir = tempDataDir();
        seedLock(dir, { pid: 424242, port: 4700 });
        const probed: number[] = [];

        acquire(dir, 4999, {
            isPidAlive: alive(424242),
            probeHealth: (port) => { probed.push(port); return false; },
        });

        expect(probed).toEqual([4700]);
    });

    it('does not probe at all when the holder pid is dead', () => {
        const dir = tempDataDir();
        seedLock(dir);
        let probes = 0;

        acquire(dir, 4998, { isPidAlive: nothingAlive, probeHealth: () => { probes++; return true; } });

        expect(probes).toBe(0);
    });

    it('takes over a lock left by this same process without probing', () => {
        // A re-acquire inside one process (an embedder booting the app twice)
        // is never a rival instance — it is our own leftover.
        const dir = tempDataDir();
        seedLock(dir, { pid: process.pid, instanceId: 'our-own-leftover' });
        let probes = 0;

        const { info } = acquire(dir, 4680, {
            isPidAlive: alive(process.pid),
            probeHealth: () => { probes++; return true; },
        });

        expect(probes).toBe(0);
        expect(info.instanceId).not.toBe('our-own-leftover');
        expect(JSON.parse(readFileSync(lockPath(dir), 'utf8')).instanceId).toBe(info.instanceId);
    });

    it('overwrites a corrupt lock file instead of wedging startup', () => {
        const dir = tempDataDir();
        writeFileSync(lockPath(dir), '{not json at all');

        const { info } = acquire(dir, 4655);

        expect(JSON.parse(readFileSync(lockPath(dir), 'utf8')).instanceId).toBe(info.instanceId);
    });
});

describe('release', () => {
    it('removes the lock file it wrote', () => {
        const dir = tempDataDir();
        const { release } = acquire(dir, 4660);
        expect(existsSync(lockPath(dir))).toBe(true);

        release();

        expect(existsSync(lockPath(dir))).toBe(false);
    });

    it('is idempotent', () => {
        const dir = tempDataDir();
        const { release } = acquire(dir, 4661);
        release();
        expect(() => release()).not.toThrow();
        expect(existsSync(lockPath(dir))).toBe(false);
    });

    it('does NOT remove a lock file another instance has since claimed', () => {
        const dir = tempDataDir();
        const { release } = acquire(dir, 4662);

        // Someone else took the lock after us (we were the stale one).
        const successor = seedLock(dir, { instanceId: 'successor', pid: 777, port: 4663 });

        release();

        expect(existsSync(lockPath(dir))).toBe(true);
        expect(JSON.parse(readFileSync(lockPath(dir), 'utf8'))).toEqual(successor);
    });
});

// instance.json also carries keys other modules own — today the handoff mark,
// which must freeze a handed-off host across restarts until a human reclaims it.
describe('keys that are not the lock\'s', () => {
    it('release keeps non-lock keys instead of deleting the file', () => {
        const dir = tempDataDir();
        const { release } = acquire(dir, 4670);
        const onDisk = JSON.parse(readFileSync(lockPath(dir), 'utf8'));
        writeFileSync(lockPath(dir), JSON.stringify({ ...onDisk, handedOffAt: '2026-01-01T00:00:00.000Z' }));

        release();

        expect(JSON.parse(readFileSync(lockPath(dir), 'utf8'))).toEqual({ handedOffAt: '2026-01-01T00:00:00.000Z' });
        expect(readInstanceLock(dir)).toBeNull();
    });

    it('carries non-lock keys forward when taking over a stale lock', () => {
        const dir = tempDataDir();
        const stale = seedLock(dir);
        writeFileSync(lockPath(dir), JSON.stringify({ ...stale, handedOffAt: 'x', handoffExportId: 'e-1' }));

        const { info } = acquire(dir, 4671);

        const onDisk = JSON.parse(readFileSync(lockPath(dir), 'utf8'));
        expect(onDisk).toEqual({ ...info, handedOffAt: 'x', handoffExportId: 'e-1' });
    });

    it('claims a file holding only non-lock keys, keeping them', () => {
        const dir = tempDataDir();
        writeFileSync(lockPath(dir), JSON.stringify({ handedOffAt: 'x' }));

        const { info } = acquire(dir, 4672);

        expect(readInstanceLock(dir)).toEqual(info);
        expect(JSON.parse(readFileSync(lockPath(dir), 'utf8')).handedOffAt).toBe('x');
    });

    it('a handoff mark survives shutdown and the next boot, until it is cleared', () => {
        const dir = tempDataDir();
        const first = acquire(dir, 4673);
        writeHandoffMark(dir, { handedOffAt: '2026-01-01T00:00:00.000Z', exportId: 'e-7' });
        first.release();

        const second = acquire(dir, 4674);
        expect(readHandoffMark(dir)?.exportId).toBe('e-7');
        expect(readInstanceLock(dir)).toEqual(second.info);

        // After a reclaim there is nothing foreign left, so release deletes again.
        clearHandoffMark(dir);
        second.release();
        expect(existsSync(lockPath(dir))).toBe(false);
    });
});

describe('readInstanceLock', () => {
    it('returns null when there is no lock file', () => {
        expect(readInstanceLock(tempDataDir())).toBeNull();
    });

    it('returns null for corrupt JSON', () => {
        const dir = tempDataDir();
        writeFileSync(lockPath(dir), '{"instanceId": ');
        expect(readInstanceLock(dir)).toBeNull();
    });

    it('returns null for JSON that is not a valid InstanceInfo', () => {
        const dir = tempDataDir();
        writeFileSync(lockPath(dir), JSON.stringify({ instanceId: 'x', pid: 'not-a-number' }));
        expect(readInstanceLock(dir)).toBeNull();
    });

    it('round-trips what acquire wrote', () => {
        const dir = tempDataDir();
        const { info } = acquire(dir, 4670);
        expect(readInstanceLock(dir)).toEqual(info);
    });
});

describe('isPidAlive', () => {
    it('sees this very process', () => {
        expect(isPidAlive(process.pid)).toBe(true);
    });

    it('does not see a pid that cannot exist', () => {
        expect(isPidAlive(IMPOSSIBLE_PID)).toBe(false);
    });

    it('rejects nonsense pids without throwing', () => {
        expect(isPidAlive(0)).toBe(false);
        expect(isPidAlive(-1)).toBe(false);
        expect(isPidAlive(NaN)).toBe(false);
    });
});

// The real probe spawns a short-lived node child, so it is the one part of this
// module that touches the OS. It is exercised against a real listener rather
// than a mock, because "does a blocking HTTP GET actually work" is the point.
//
// The listener MUST live in a separate process: probeHealth() is synchronous
// and blocks this process's event loop for its whole duration, so an
// in-process http server could never accept the connection and every probe
// would time out. That is a property of the test harness, not of the probe —
// in production the holder is always another process.
describe('probeHealth (real HTTP)', () => {
    let child: import('child_process').ChildProcess | undefined;

    afterEach(() => {
        child?.kill();
        child = undefined;
    });

    /** Boot a throwaway node HTTP server in a child process; resolve its port. */
    async function startHealthServer(status: number): Promise<number> {
        const { spawn } = await import('child_process');
        const script = `
            const http = require('http');
            const s = http.createServer((req, res) => {
                res.writeHead(req.url === '/api/health' ? ${status} : 404);
                res.end('{}');
            });
            s.listen(0, '127.0.0.1', () => console.log(s.address().port));
        `;
        child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
        return new Promise<number>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('health server did not start')), 8000);
            child!.stdout!.on('data', (buf: Buffer) => {
                const port = parseInt(buf.toString().trim(), 10);
                if (Number.isFinite(port)) { clearTimeout(timer); resolve(port); }
            });
        });
    }

    it('returns true when /api/health answers 200', async () => {
        expect(probeHealth(await startHealthServer(200))).toBe(true);
    });

    it('returns false when the holder answers with a non-200', async () => {
        expect(probeHealth(await startHealthServer(503))).toBe(false);
    });

    it('returns false when nothing is listening', async () => {
        // Bind, learn the port, release it — nothing is there when we probe.
        const http = await import('http');
        const throwaway = http.createServer();
        const port = await new Promise<number>(resolve => {
            throwaway.listen(0, '127.0.0.1', () =>
                resolve((throwaway.address() as import('net').AddressInfo).port));
        });
        await new Promise<void>(resolve => throwaway.close(() => resolve()));

        expect(probeHealth(port, 300)).toBe(false);
    });

    it('returns false for a nonsense port instead of throwing', () => {
        expect(probeHealth(0)).toBe(false);
        expect(probeHealth(-5)).toBe(false);
    });
});

describe('resolveBackendVersion', () => {
    it('returns the version the release script syncs into package.json', () => {
        expect(resolveBackendVersion()).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
    });
});
