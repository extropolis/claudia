/**
 * Sleep/wake recovery: PTY children die while the OS is suspended, and the
 * task must come back with its session intact rather than sitting dead until
 * the user notices.
 *
 * The PTY is genuinely SIGKILLed out from under the spawner (no trap runs, so
 * this is as abrupt as a suspend-kill), then the wake path is driven and the
 * respawn is asserted at the true process boundary: the fake CLI logs its argv,
 * so `--resume <sid>` either is there or it is not.
 *
 * POSIX-only: the fake CLI is a bash script and Windows resolves the CLI via
 * APPDATA rather than PATH, so the premise does not hold there. Guarded with
 * describe.skipIf(!SUPPORTS_FAKE_CLI) — the platform-neutral contract stays
 * covered by the Linux leg.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { startHarness, waitFor, SUPPORTS_FAKE_CLI, type Harness } from './helpers/server-harness.js';

const SID = 'sleep000-1111-2222-3333-444455556666';

let workspace: string;
const harnesses: Harness[] = [];

const readIf = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const argvOf = (fakeDir: string) => readIf(join(fakeDir, 'args.log')).trim().split('\n').filter(Boolean);

async function boot(): Promise<Harness> {
    const h = await startHarness({
        prefix: '.claudia-sleepwake-test-',
        fakeClaude: true,
        workspaces: [{ id: workspace, name: 'ws' }],
        env: { CLAUDIA_FAKE_SID: SID, STATE_POLLING_MS: '500' },
    });
    harnesses.push(h);
    return h;
}

beforeAll(() => {
    if (!SUPPORTS_FAKE_CLI) return;
    workspace = mkdtempSync(join(homedir(), '.claudia-sleepwake-ws-'));
});

afterEach(async () => {
    for (const h of harnesses.splice(0)) {
        try { await h.stop(); } catch { /* best effort */ }
    }
});

afterAll(() => {
    if (!SUPPORTS_FAKE_CLI) return;
    try { rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* best effort */ }
}, 20000);

describe.skipIf(!SUPPORTS_FAKE_CLI)('sleep/wake PTY recovery', () => {
    it('respawns a task whose PTY was killed during suspend, resuming its session', async () => {
        const h = await boot();
        const spawner = h.server.taskSpawner;

        const task = await spawner.createTask('SLEEP_WAKE_PROMPT', workspace);
        await waitFor(() => argvOf(h.fakeDir).length, n => n > 0, 20000);
        // The session must be captured before a resume is even possible.
        await waitFor(() => spawner.getTask(task.id)?.sessionId, sid => sid === SID, 20000);

        const pid = Number(readIf(join(h.fakeDir, 'alive')).trim());
        expect(pid).toBeGreaterThan(0);

        // Wipe the argv log so the NEXT spawn is unambiguous, then kill the
        // child the way a suspend does: no signal handler gets to run.
        rmSync(join(h.fakeDir, 'args.log'), { force: true });
        process.kill(pid, 'SIGKILL');

        await waitFor(() => spawner.getTask(task.id)?.state, s => s === 'exited', 20000);

        // Drive the wake path (the real trigger is a >30s gap between polls).
        await (spawner as unknown as { reconnectAfterSleep(): Promise<void> }).reconnectAfterSleep();

        const argv = await waitFor(() => argvOf(h.fakeDir), a => a.length > 0, 20000);
        expect(argv).toContain('--resume');
        expect(argv[argv.indexOf('--resume') + 1]).toBe(SID);

        // And the task is live again, not stranded in 'exited'.
        const revived = await waitFor(() => spawner.getTask(task.id)?.state, s => s !== undefined && s !== 'exited', 20000);
        expect(revived).not.toBe('exited');
    }, 90000);

    it('reconnects the killed task with a real, different PTY process', async () => {
        const h = await boot();
        const spawner = h.server.taskSpawner;

        const task = await spawner.createTask('SLEEP_WAKE_PID_PROMPT', workspace);
        await waitFor(() => spawner.getTask(task.id)?.sessionId, sid => sid === SID, 20000);
        const firstPid = Number(readIf(join(h.fakeDir, 'alive')).trim());

        rmSync(join(h.fakeDir, 'args.log'), { force: true });
        process.kill(firstPid, 'SIGKILL');
        await waitFor(() => spawner.getTask(task.id)?.state, s => s === 'exited', 20000);

        await (spawner as unknown as { reconnectAfterSleep(): Promise<void> }).reconnectAfterSleep();
        await waitFor(() => argvOf(h.fakeDir).length, n => n > 0, 20000);

        const secondPid = await waitFor(
            () => Number(readIf(join(h.fakeDir, 'alive')).trim()),
            p => p > 0 && p !== firstPid,
            20000,
        );
        expect(secondPid).not.toBe(firstPid);
    }, 90000);

    it('leaves healthy tasks alone — waking does not churn a live PTY', async () => {
        const h = await boot();
        const spawner = h.server.taskSpawner;

        const task = await spawner.createTask('HEALTHY_PROMPT', workspace);
        await waitFor(() => spawner.getTask(task.id)?.sessionId, sid => sid === SID, 20000);
        const pidBefore = Number(readIf(join(h.fakeDir, 'alive')).trim());

        await (spawner as unknown as { reconnectAfterSleep(): Promise<void> }).reconnectAfterSleep();

        // Same process still serving the task: no respawn, no lost scrollback.
        expect(Number(readIf(join(h.fakeDir, 'alive')).trim())).toBe(pidBefore);
        expect(spawner.getTask(task.id)?.state).not.toBe('exited');
    }, 60000);
});

describe.skipIf(!SUPPORTS_FAKE_CLI)('disconnect / reconnect round-trip', () => {
    it('disconnectTask kills the PTY and reconnectTask brings it back with --resume', async () => {
        const h = await boot();
        const spawner = h.server.taskSpawner;

        const task = await spawner.createTask('ROUNDTRIP_PROMPT', workspace);
        await waitFor(() => spawner.getTask(task.id)?.sessionId, sid => sid === SID, 20000);

        rmSync(join(h.fakeDir, 'args.log'), { force: true });
        expect(spawner.disconnectTask(task.id)).toBe(true);

        // PTY is gone and the task left the live map.
        await waitFor(() => existsSync(join(h.fakeDir, 'alive')), alive => !alive, 20000);
        expect(spawner.getTask(task.id)).toBeUndefined();
        expect(spawner.getDisconnectedTask(task.id)).toBeDefined();

        const reconnected = spawner.reconnectTask(task.id);
        expect(reconnected).not.toBeNull();

        const argv = await waitFor(() => argvOf(h.fakeDir), a => a.length > 0, 20000);
        expect(argv).toContain('--resume');
        expect(argv[argv.indexOf('--resume') + 1]).toBe(SID);
    }, 90000);

    it('refuses to reconnect into a workspace directory that no longer exists', async () => {
        const h = await boot();
        const spawner = h.server.taskSpawner;

        const gone = mkdtempSync(join(homedir(), '.claudia-sleepwake-gone-'));
        const task = await spawner.createTask('DOOMED_PROMPT', gone);
        await waitFor(() => spawner.getTask(task.id)?.sessionId, sid => sid === SID, 20000);

        spawner.disconnectTask(task.id);
        await waitFor(() => existsSync(join(h.fakeDir, 'alive')), alive => !alive, 20000);

        // The worktree is removed after its PR merges; spawning into it would
        // throw ENOENT and silently swallow the user's input.
        rmSync(gone, { recursive: true, force: true });
        rmSync(join(h.fakeDir, 'args.log'), { force: true });

        expect(spawner.reconnectTask(task.id)).toBeNull();
        expect(argvOf(h.fakeDir)).toHaveLength(0);
    }, 90000);

    it('loads only the 512KB tail of a huge history file back into memory', async () => {
        const h = await boot();
        const spawner = h.server.taskSpawner;

        const task = await spawner.createTask('BIG_HISTORY_PROMPT', workspace);
        await waitFor(() => spawner.getTask(task.id)?.sessionId, sid => sid === SID, 20000);

        spawner.disconnectTask(task.id);
        await waitFor(() => existsSync(join(h.fakeDir, 'alive')), alive => !alive, 20000);

        // A 1MB history on disk. Loading it whole is what caused OOM with many
        // active tasks, so reconnect must take a bounded tail.
        const historyDir = join(h.base, 'task-histories');
        mkdirSync(historyDir, { recursive: true });
        let big = '';
        let i = 0;
        while (big.length < 1024 * 1024) {
            big += `HIST_LINE_${String(i).padStart(7, '0')} [x] ${'y'.repeat(40)}\n`;
            i++;
        }
        big += 'HIST_TAIL_MARKER\n';
        writeFileSync(join(historyDir, `${task.id}.txt`), big);

        expect(spawner.reconnectTask(task.id)).not.toBeNull();

        const prev = spawner.getTask(task.id)?.previousHistory;
        expect(prev).toBeDefined();
        // Bounded at the 512KB cap, not the full 1MB file...
        expect(prev!.length).toBe(512 * 1024);
        expect(prev!.length).toBeLessThan(big.length);
        // ...and it is the TAIL that survived, so the user sees the newest output.
        expect(prev!.toString('utf8')).toContain('HIST_TAIL_MARKER');
        expect(prev!.toString('utf8')).not.toContain('HIST_LINE_0000000');
    }, 90000);

    it('loads a small history file whole (no needless truncation)', async () => {
        const h = await boot();
        const spawner = h.server.taskSpawner;

        const task = await spawner.createTask('SMALL_HISTORY_PROMPT', workspace);
        await waitFor(() => spawner.getTask(task.id)?.sessionId, sid => sid === SID, 20000);

        spawner.disconnectTask(task.id);
        await waitFor(() => existsSync(join(h.fakeDir, 'alive')), alive => !alive, 20000);

        const historyDir = join(h.base, 'task-histories');
        mkdirSync(historyDir, { recursive: true });
        const small = 'SMALL_HISTORY [ok] all of it\n';
        writeFileSync(join(historyDir, `${task.id}.txt`), small);

        expect(spawner.reconnectTask(task.id)).not.toBeNull();

        const prev = spawner.getTask(task.id)?.previousHistory;
        expect(prev?.toString('utf8')).toBe(small);
    }, 90000);

    it('does not spawn a second process when reconnecting an already-live task', async () => {
        const h = await boot();
        const spawner = h.server.taskSpawner;

        const task = await spawner.createTask('ALREADY_LIVE_PROMPT', workspace);
        await waitFor(() => spawner.getTask(task.id)?.sessionId, sid => sid === SID, 20000);
        const pidBefore = Number(readIf(join(h.fakeDir, 'alive')).trim());

        const again = spawner.reconnectTask(task.id);
        expect(again).not.toBeNull();
        expect(Number(readIf(join(h.fakeDir, 'alive')).trim())).toBe(pidBefore);
    }, 60000);
});
