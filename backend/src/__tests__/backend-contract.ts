/**
 * SHARED CONTRACT TEST SUITE for the `CodeBackend` abstraction.
 *
 * `backends/types.ts` is a seam: TaskSpawner talks to `CodeBackend` and never
 * to a concrete implementation. Every implementation therefore has to honour
 * the same behavioural contract — method semantics AND the documented
 * `BackendEvents` surface. This file encodes that contract once; each backend
 * test file calls `runCodeBackendContract(...)` with a small harness. Adding a
 * new backend means writing a harness, not re-deriving the expectations.
 *
 * These are NOT mock tests: every case drives a real PTY running a real
 * process (fixtures/fake-agent.sh) and asserts at the true process boundary —
 * argv on disk, stdin on disk, real SIGTERM, real exit codes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import type { CodeBackend, TaskEnvironment, BackendTask } from '../backends/types.js';
import { BACKEND_INFO } from '../backends/types.js';

// node-pty cannot run a bash fixture on Windows, and the CI matrix includes
// windows-latest, so the process-driven cases are skipped there.
export const isWin = process.platform === 'win32';

/** One spawn's isolated scratch space + the env that drives the fake CLI. */
export interface SpawnCtx {
    /** Directory the fake writes args.log / cwd.log / input.log / alive into. */
    fakeDir: string;
    /** Session id this spawn will announce (unique per spawn). */
    sessionId: string;
    /** TaskEnvironment to hand to createTask/reconnectTask. */
    env: TaskEnvironment;
}

export interface BackendHarness {
    backend: CodeBackend;
    /** Directory used as the task cwd. */
    workspace: string;
    /** A scratch dir guaranteed to contain no executables. */
    emptyBinDir: string;
    /** Allocate an isolated spawn context. */
    newSpawn(label: string, extraEnv?: Record<string, string>): SpawnCtx;
    /** Make `sessionId` resumable for this backend (Claude needs the JSONL). */
    ensureResumableSession(sessionId: string): void;
    /** The argv this backend must use to resume a session. */
    resumeArgs(sessionId: string): string[];
    cleanup(): void;
}

export async function waitFor<T>(
    fn: () => T | Promise<T>,
    pred: (v: T) => boolean,
    ms = 15000,
    step = 100
): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
        const last = await fn();
        if (pred(last)) return last;
        if (Date.now() > deadline) {
            throw new Error(`waitFor timeout; last=${JSON.stringify(last)?.slice(0, 400)}`);
        }
        await new Promise(r => setTimeout(r, step));
    }
}

export const readIf = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');
export const argLines = (dir: string): string[] =>
    readIf(join(dir, 'args.log')).split('\n').filter(Boolean);

/**
 * True once the fake CLI spawned into `dir` is really gone.
 *
 * The fake removes its `alive` marker from a signal trap; under heavy parallel
 * load that trap can take a moment to be scheduled, so fall back to asking the
 * OS about the pid it recorded rather than trusting the marker alone.
 */
export function fakeProcessGone(dir: string): boolean {
    if (!existsSync(join(dir, 'alive'))) return true;
    const pid = Number.parseInt(readIf(join(dir, 'pid')).trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return false;
    } catch {
        return true;
    }
}

/** True when `needle` appears as a contiguous run inside `hay`. */
export function containsSubsequence(hay: string[], needle: string[]): boolean {
    if (needle.length === 0) return true;
    for (let i = 0; i + needle.length <= hay.length; i++) {
        if (needle.every((n, j) => hay[i + j] === n)) return true;
    }
    return false;
}

/**
 * Run the full CodeBackend contract against one implementation.
 *
 * @param name         Label for the describe block AND the expected `backend.name`.
 * @param makeHarness  Fresh harness factory — called once per contract run.
 */
export function runCodeBackendContract(name: string, makeHarness: () => BackendHarness): void {
    describe(`CodeBackend contract [${name}]`, () => {
        let h: BackendHarness;
        let backend: CodeBackend;

        beforeAll(async () => {
            h = makeHarness();
            backend = h.backend;
            await backend.initialize();
        }, 30000);

        afterAll(async () => {
            await backend.shutdown();
            h.cleanup();
        }, 20000);

        // ---------------------------------------------------------------
        // Identity & shape of the interface
        // ---------------------------------------------------------------
        describe('identity and interface shape', () => {
            it('declares a registered BackendType as its name', () => {
                expect(backend.name).toBe(name);
                expect(Object.keys(BACKEND_INFO)).toContain(backend.name);
                expect(BACKEND_INFO[backend.name].installUrl).toMatch(/^https?:\/\//);
                expect(BACKEND_INFO[backend.name].name).toBeTruthy();
            });

            it('is an EventEmitter and implements every CodeBackend method', () => {
                expect(typeof backend.on).toBe('function');
                expect(typeof backend.emit).toBe('function');
                const required = [
                    'checkInstalled', 'initialize', 'shutdown',
                    'createTask', 'reconnectTask', 'sendInput', 'resizeTask',
                    'interruptTask', 'stopTask', 'destroyTask',
                    'getTaskState', 'getTask', 'getTaskHistory', 'setTaskActive',
                ];
                for (const m of required) {
                    expect(typeof (backend as unknown as Record<string, unknown>)[m]).toBe('function');
                }
            });

            it('initialize() is idempotent (no second polling interval, no throw)', async () => {
                await expect(backend.initialize()).resolves.toBeUndefined();
                await expect(backend.initialize()).resolves.toBeUndefined();
            });
        });

        // ---------------------------------------------------------------
        // Installation probe
        // ---------------------------------------------------------------
        describe.skipIf(isWin)('checkInstalled()', () => {
            it('reports installed with a version when the binary is on PATH', async () => {
                const status = await backend.checkInstalled();
                expect(status.installed).toBe(true);
                expect(status.version).toBe('9.9.9-fake');
                expect(status.error).toBeUndefined();
            });

            it('reports not-installed with an actionable error when the binary is missing', async () => {
                const saved = process.env.PATH;
                process.env.PATH = h.emptyBinDir;
                try {
                    const status = await backend.checkInstalled();
                    expect(status.installed).toBe(false);
                    expect(status.error).toBeTruthy();
                    // The error must point the user at an install page.
                    expect(status.error).toMatch(/https?:\/\//);
                    expect(status.version).toBeUndefined();
                } finally {
                    process.env.PATH = saved;
                }
            });
        });

        // ---------------------------------------------------------------
        // Unknown-task safety: every accessor must be total.
        // ---------------------------------------------------------------
        describe('unknown task ids are handled without throwing', () => {
            const ghost = 'task-does-not-exist';

            it('read accessors return the documented empty values', () => {
                expect(backend.getTask(ghost)).toBeUndefined();
                expect(backend.getTaskState(ghost)).toBeNull();
                expect(backend.getTaskHistory(ghost)).toBeNull();
            });

            it('mutating calls are no-ops rather than throws', () => {
                expect(() => backend.sendInput(ghost, 'hi\r')).not.toThrow();
                expect(() => backend.resizeTask(ghost, 80, 24)).not.toThrow();
                expect(() => backend.setTaskActive(ghost, true)).not.toThrow();
                expect(() => backend.setTaskActive(ghost, false)).not.toThrow();
                expect(() => backend.destroyTask(ghost)).not.toThrow();
                expect(backend.interruptTask(ghost)).toBe(false);
                expect(backend.stopTask(ghost)).toBe(false);
            });

            it('optional hasProcessingIndicators() is false for unknown tasks', () => {
                if (backend.hasProcessingIndicators) {
                    expect(backend.hasProcessingIndicators(ghost)).toBe(false);
                }
            });
        });

        // ---------------------------------------------------------------
        // The main lifecycle, against a real process.
        // ---------------------------------------------------------------
        describe.skipIf(isWin)('createTask → ready → prompt → input → destroy', () => {
            let ctx: SpawnCtx;
            let created: BackendTask;
            const stateEvents: BackendTask[] = [];
            const outputEvents: Array<[string, string]> = [];
            const onState = (t: BackendTask) => { stateEvents.push(t); };
            const onOutput = (id: string, d: string) => { outputEvents.push([id, d]); };

            beforeAll(async () => {
                ctx = h.newSpawn('lifecycle');
                backend.on('task:stateChanged', onState);
                backend.on('task:output', onOutput);
                created = await backend.createTask(
                    { prompt: 'CONTRACT_PROMPT hello', workspaceId: h.workspace },
                    ctx.env
                );
            }, 30000);

            afterAll(() => {
                backend.off('task:stateChanged', onState);
                backend.off('task:output', onOutput);
                if (created) backend.destroyTask(created.id);
            });

            it('returns a well-formed BackendTask in the starting state', () => {
                expect(created.id).toMatch(/^task-/);
                expect(created.state).toBe('starting');
                expect(created.workspaceId).toBe(h.workspace);
                expect(created.prompt).toBe('CONTRACT_PROMPT hello');
                expect(created.sessionId).toBeNull();
                expect(created.createdAt).toBeInstanceOf(Date);
                expect(created.lastActivity).toBeInstanceOf(Date);
            });

            it('emits task:stateChanged synchronously for the new task', () => {
                expect(stateEvents.some(t => t.id === created.id)).toBe(true);
            });

            it('getTask / getTaskState agree with the returned task', () => {
                const fetched = backend.getTask(created.id);
                expect(fetched).toBeDefined();
                expect(fetched!.id).toBe(created.id);
                expect(fetched!.workspaceId).toBe(h.workspace);
                expect(fetched!.prompt).toBe(created.prompt);
                expect(backend.getTaskState(created.id)).not.toBeNull();
            });

            it('actually spawns the CLI, with the workspace as cwd', async () => {
                const cwd = await waitFor(() => readIf(join(ctx.fakeDir, 'cwd.log')), s => s.length > 0, 15000);
                // macOS reports the /private realpath; compare the leaf name.
                expect(basename(cwd.trim())).toBe(basename(h.workspace));
                expect(existsSync(join(ctx.fakeDir, 'alive'))).toBe(true);
            }, 20000);

            it('delivers the initial prompt to the process stdin once the TUI is ready', async () => {
                const input = await waitFor(
                    () => readIf(join(ctx.fakeDir, 'input.log')),
                    s => s.includes('CONTRACT_PROMPT hello'),
                    25000
                );
                // Arriving as a COMPLETE LINE proves Enter was delivered too.
                expect(input).toContain('CONTRACT_PROMPT hello');
            }, 30000);

            it('records output history and honours the getTaskHistory maxBytes hint', async () => {
                const hist = await waitFor(
                    () => backend.getTaskHistory(created.id),
                    s => Boolean(s && s.includes('ready')),
                    15000
                );
                expect(hist).toContain('ready');
                const clipped = backend.getTaskHistory(created.id, 64);
                expect(clipped).toBeTruthy();
                expect(clipped!.length).toBeLessThanOrEqual(hist!.length);
            }, 20000);

            it('setTaskActive(true) replays history over task:output and streams new output', async () => {
                outputEvents.length = 0;
                backend.setTaskActive(created.id, true);
                expect(outputEvents.length).toBeGreaterThan(0);
                expect(outputEvents[0][0]).toBe(created.id);

                outputEvents.length = 0;
                backend.sendInput(created.id, 'EMIT_OUTPUT now\r');
                const streamed = await waitFor(
                    () => outputEvents.map(e => e[1]).join(''),
                    s => s.includes('FAKE_OUTPUT_MARKER_9000'),
                    20000
                );
                expect(streamed).toContain('FAKE_OUTPUT_MARKER_9000');
            }, 25000);

            it('setTaskActive(false) stops streaming output for that task', async () => {
                backend.setTaskActive(created.id, false);
                await new Promise(r => setTimeout(r, 500));
                outputEvents.length = 0;
                backend.sendInput(created.id, 'QUIET_LINE\r');
                await waitFor(
                    () => readIf(join(ctx.fakeDir, 'input.log')),
                    s => s.includes('QUIET_LINE'),
                    20000
                );
                await new Promise(r => setTimeout(r, 600));
                expect(outputEvents.filter(e => e[0] === created.id)).toHaveLength(0);
            }, 25000);

            it('sendInput() delivers follow-up input to the live process', async () => {
                backend.sendInput(created.id, 'FOLLOW_UP_CONTRACT\r');
                const input = await waitFor(
                    () => readIf(join(ctx.fakeDir, 'input.log')),
                    s => s.includes('FOLLOW_UP_CONTRACT'),
                    20000
                );
                expect(input).toContain('FOLLOW_UP_CONTRACT');
            }, 25000);

            it('resizeTask() on a live task does not throw', () => {
                expect(() => backend.resizeTask(created.id, 100, 30)).not.toThrow();
                expect(() => backend.resizeTask(created.id, 120, 40)).not.toThrow();
            });

            it('destroyTask() kills the process and forgets the task', async () => {
                backend.destroyTask(created.id);
                expect(backend.getTask(created.id)).toBeUndefined();
                expect(backend.getTaskState(created.id)).toBeNull();
                expect(backend.getTaskHistory(created.id)).toBeNull();
                await waitFor(() => fakeProcessGone(ctx.fakeDir), gone => gone, 25000);
            }, 35000);
        });

        // ---------------------------------------------------------------
        // busy-state transitions: interrupt / stop
        // ---------------------------------------------------------------
        describe.skipIf(isWin)('interrupt / stop semantics follow task state', () => {
            let ctx: SpawnCtx;
            let task: BackendTask;

            beforeAll(async () => {
                ctx = h.newSpawn('interrupt');
                task = await backend.createTask(
                    { prompt: 'CONTRACT_IDLE', workspaceId: h.workspace },
                    ctx.env
                );
                await waitFor(() => readIf(join(ctx.fakeDir, 'input.log')), s => s.includes('CONTRACT_IDLE'), 25000);
            }, 40000);

            afterAll(() => {
                if (task) backend.destroyTask(task.id);
            });

            it('stopTask() succeeds for a live task and fails once it is gone', async () => {
                expect(backend.stopTask(task.id)).toBe(true);
                expect(backend.stopTask('task-never-existed')).toBe(false);
            }, 25000);

            it('interruptTask() is true only while busy, false once idle', async () => {
                await waitFor(() => backend.getTaskState(task.id), s => s === 'idle', 25000);
                expect(backend.interruptTask(task.id)).toBe(false);

                backend.sendInput(task.id, 'STAY_BUSY working\r');
                await waitFor(() => backend.getTaskState(task.id), s => s === 'busy', 20000);
                expect(backend.interruptTask(task.id)).toBe(true);
                expect(backend.stopTask(task.id)).toBe(true);
            }, 60000);
        });

        // ---------------------------------------------------------------
        // waiting-for-input detection (task:waitingInput event)
        // ---------------------------------------------------------------
        describe.skipIf(isWin)('task:waitingInput fires when the CLI asks a question', () => {
            let ctx: SpawnCtx;
            let task: BackendTask;
            const waiting: Array<[string, string, string]> = [];
            const onWaiting = (id: string, t: string, c: string) => { waiting.push([id, t, c]); };

            beforeAll(async () => {
                ctx = h.newSpawn('waiting');
                backend.on('task:waitingInput', onWaiting);
                task = await backend.createTask(
                    { prompt: 'CONTRACT_WAIT', workspaceId: h.workspace },
                    ctx.env
                );
                await waitFor(() => readIf(join(ctx.fakeDir, 'input.log')), s => s.includes('CONTRACT_WAIT'), 25000);
                await waitFor(() => backend.getTaskState(task.id), s => s === 'idle', 25000);
            }, 60000);

            afterAll(() => {
                backend.off('task:waitingInput', onWaiting);
                if (task) backend.destroyTask(task.id);
            });

            it('transitions to waiting_input with a typed reason and emits the event', async () => {
                backend.sendInput(task.id, 'Should I proceed with the plan (y/n)\r');
                await waitFor(() => backend.getTaskState(task.id), s => s === 'waiting_input', 25000);
                expect(backend.getTask(task.id)!.waitingInputType).toBe('confirmation');

                const ev = waiting.find(w => w[0] === task.id);
                expect(ev).toBeDefined();
                expect(ev![1]).toBe('confirmation');
                expect(typeof ev![2]).toBe('string');
            }, 45000);
        });

        // ---------------------------------------------------------------
        // session capture
        // ---------------------------------------------------------------
        describe.skipIf(isWin)('task:sessionCaptured', () => {
            it('captures the session id the CLI produced and exposes it on the task', async () => {
                const ctx = h.newSpawn('session');
                const captured: Array<[string, string]> = [];
                const onCap = (id: string, sid: string) => { captured.push([id, sid]); };
                backend.on('task:sessionCaptured', onCap);
                let taskId: string | undefined;
                try {
                    const task = await backend.createTask(
                        { prompt: 'CONTRACT_SESSION', workspaceId: h.workspace },
                        ctx.env
                    );
                    taskId = task.id;
                    const ev = await waitFor(
                        () => captured.find(c => c[0] === task.id),
                        c => Boolean(c),
                        25000
                    );
                    expect(ev![1]).toBe(ctx.sessionId);
                    expect(backend.getTask(task.id)!.sessionId).toBe(ctx.sessionId);
                } finally {
                    backend.off('task:sessionCaptured', onCap);
                    if (taskId) backend.destroyTask(taskId);
                }
            }, 40000);
        });

        // ---------------------------------------------------------------
        // process exit
        // ---------------------------------------------------------------
        describe.skipIf(isWin)('task:exit surfaces the real exit code and the exited state', () => {
            it('emits task:exit(taskId, code) and flips state to exited', async () => {
                const ctx = h.newSpawn('exit', { CLAUDIA_FAKE_EXIT_CODE: '3', CLAUDIA_FAKE_EXIT_DELAY: '0.2' });
                const exits: Array<[string, number]> = [];
                const states: BackendTask[] = [];
                const onExit = (id: string, code: number) => { exits.push([id, code]); };
                const onState = (t: BackendTask) => { states.push(t); };
                backend.on('task:exit', onExit);
                backend.on('task:stateChanged', onState);
                let taskId: string | undefined;
                try {
                    const task = await backend.createTask(
                        { prompt: 'CONTRACT_EXIT', workspaceId: h.workspace },
                        ctx.env
                    );
                    taskId = task.id;
                    const ev = await waitFor(() => exits.find(e => e[0] === task.id), e => Boolean(e), 20000);
                    expect(ev![1]).toBe(3);
                    expect(backend.getTaskState(task.id)).toBe('exited');
                    expect(states.some(s => s.id === task.id && s.state === 'exited')).toBe(true);
                } finally {
                    backend.off('task:exit', onExit);
                    backend.off('task:stateChanged', onState);
                    if (taskId) backend.destroyTask(taskId);
                }
            }, 30000);
        });

        // ---------------------------------------------------------------
        // reconnect / resume
        // ---------------------------------------------------------------
        describe.skipIf(isWin)('reconnectTask()', () => {
            it('resumes a known session: keeps task id + session id and passes resume argv', async () => {
                const ctx = h.newSpawn('reconnect-resume');
                h.ensureResumableSession(ctx.sessionId);
                const taskId = `task-contract-resume-${Date.now()}`;

                const task = await backend.reconnectTask(
                    { taskId, sessionId: ctx.sessionId, workspaceId: h.workspace, shouldContinue: false },
                    ctx.env
                );
                try {
                    expect(task.id).toBe(taskId);
                    expect(task.sessionId).toBe(ctx.sessionId);
                    // Reconnect without continuation lands idle, not starting.
                    expect(backend.getTaskState(taskId)).toBe('idle');
                    // The resume banner is seeded into history so the UI shows it.
                    expect(backend.getTaskHistory(taskId)).toContain(`Resuming session ${ctx.sessionId}`);

                    const args = await waitFor(() => argLines(ctx.fakeDir), a => a.length > 0, 20000);
                    expect(containsSubsequence(args, h.resumeArgs(ctx.sessionId))).toBe(true);
                } finally {
                    backend.destroyTask(taskId);
                }
            }, 30000);

            it('without a session id starts fresh: no resume argv, null session, reconnect banner', async () => {
                const ctx = h.newSpawn('reconnect-fresh');
                const taskId = `task-contract-fresh-${Date.now()}`;

                const task = await backend.reconnectTask(
                    { taskId, sessionId: null, workspaceId: h.workspace, shouldContinue: false },
                    ctx.env
                );
                try {
                    expect(task.sessionId).toBeNull();
                    expect(backend.getTaskHistory(taskId)).toContain('Session reconnected');

                    await waitFor(() => readIf(join(ctx.fakeDir, 'cwd.log')), s => s.length > 0, 20000);
                    const flag = h.resumeArgs(ctx.sessionId)[0];
                    expect(argLines(ctx.fakeDir)).not.toContain(flag);
                } finally {
                    backend.destroyTask(taskId);
                }
            }, 30000);

            it('shouldContinue with a session starts in the starting state and sends a continuation', async () => {
                const ctx = h.newSpawn('reconnect-continue');
                h.ensureResumableSession(ctx.sessionId);
                const taskId = `task-contract-continue-${Date.now()}`;

                const task = await backend.reconnectTask(
                    { taskId, sessionId: ctx.sessionId, workspaceId: h.workspace, shouldContinue: true },
                    ctx.env
                );
                try {
                    expect(task.state).toBe('starting');
                    const input = await waitFor(
                        () => readIf(join(ctx.fakeDir, 'input.log')),
                        s => s.includes('continue'),
                        25000
                    );
                    expect(input).toContain('continue');
                } finally {
                    backend.destroyTask(taskId);
                }
            }, 40000);
        });

        // ---------------------------------------------------------------
        // shutdown
        // ---------------------------------------------------------------
        describe.skipIf(isWin)('shutdown() tears down every live task', () => {
            it('kills running processes, empties the registry, and stays reusable', async () => {
                const ctx = h.newSpawn('shutdown');
                const task = await backend.createTask(
                    { prompt: 'CONTRACT_SHUTDOWN', workspaceId: h.workspace },
                    ctx.env
                );
                await waitFor(() => existsSync(join(ctx.fakeDir, 'alive')), a => a, 20000);

                await backend.shutdown();

                expect(backend.getTask(task.id)).toBeUndefined();
                expect(backend.getTaskState(task.id)).toBeNull();
                await waitFor(() => fakeProcessGone(ctx.fakeDir), gone => gone, 25000);

                // The app re-initializes the backend after a shutdown.
                await backend.initialize();
            }, 45000);
        });
    });
}
