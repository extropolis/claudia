/**
 * A deterministic stand-in for node-pty's `IPty`, used by the task-spawner
 * characterization suites.
 *
 * Why not the bash fake-CLI harness (`fixtures/fake-agent.sh`)? Because these
 * suites pin BYTE-LEVEL and TIMING behaviour — which exact string reached the
 * PTY, in what order, and how many milliseconds of fake clock had to pass
 * first. A real process cannot answer that deterministically, and the bash
 * fake is POSIX-only so the assertions would never run on the Windows leg.
 * This fake records every `write()` verbatim and lets the test drive
 * `onData`/`onExit` by hand, so the same assertions hold on all three CI legs.
 *
 * The recorded `writes` array IS the process boundary: whatever the upcoming
 * engine extraction does internally, these strings must keep arriving in this
 * order, or the Claude Code TUI behaves differently.
 */

export interface FakePty {
    pid: number;
    cols: number;
    rows: number;
    /** argv[0] the spawner asked for. */
    file: string;
    /** argv[1..] the spawner asked for. */
    args: string[];
    /** node-pty spawn options (cwd, env, cols, rows, name). */
    opts: Record<string, unknown>;
    /** Every string handed to write(), verbatim and in order. */
    writes: string[];
    resizes: Array<{ cols: number; rows: number }>;
    killed: boolean;

    // ---- IPty surface the spawner actually uses ----
    onData(cb: (data: string) => void): { dispose(): void };
    onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;

    // ---- test-side drivers ----
    /** Push a chunk of terminal output into the spawner's onData handler. */
    emitData(data: string): void;
    /** Fire the spawner's onExit handler. */
    emitExit(exitCode?: number): void;
    /** All writes concatenated — handy for framing assertions. */
    written(): string;
}

let nextPid = 4000;

/** Every PTY handed out by `fakePtySpawn`, in spawn order. */
export const ptys: FakePty[] = [];

/** Call from beforeEach so each test sees a clean spawn log. */
export function resetFakePtys(): void {
    ptys.length = 0;
    nextPid = 4000;
}

/** Build a fake PTY without registering it (for hand-built InternalTask objects). */
export function makeFakePty(
    file = 'claude',
    args: string[] = [],
    opts: Record<string, unknown> = {},
): FakePty {
    const dataCbs: Array<(d: string) => void> = [];
    const exitCbs: Array<(e: { exitCode: number; signal?: number }) => void> = [];

    const pty: FakePty = {
        pid: nextPid++,
        cols: typeof opts.cols === 'number' ? opts.cols : 120,
        rows: typeof opts.rows === 'number' ? opts.rows : 40,
        file,
        args,
        opts,
        writes: [],
        resizes: [],
        killed: false,

        onData(cb) {
            dataCbs.push(cb);
            return {
                dispose() {
                    const i = dataCbs.indexOf(cb);
                    if (i >= 0) dataCbs.splice(i, 1);
                },
            };
        },
        onExit(cb) {
            exitCbs.push(cb);
            return {
                dispose() {
                    const i = exitCbs.indexOf(cb);
                    if (i >= 0) exitCbs.splice(i, 1);
                },
            };
        },
        write(data) {
            pty.writes.push(data);
        },
        resize(cols, rows) {
            pty.cols = cols;
            pty.rows = rows;
            pty.resizes.push({ cols, rows });
        },
        kill() {
            pty.killed = true;
        },

        emitData(data) {
            for (const cb of [...dataCbs]) cb(data);
        },
        emitExit(exitCode = 0) {
            for (const cb of [...exitCbs]) cb({ exitCode });
        },
        written() {
            return pty.writes.join('');
        },
    };
    return pty;
}

/**
 * Drop-in for node-pty's `spawn`. Register with:
 *
 *   vi.mock('node-pty', () => ({ spawn: (f, a, o) => fakePtySpawn(f, a, o) }));
 *
 * The arrow keeps the binding dereference lazy, which is what makes it safe
 * under vitest's `vi.mock` hoisting.
 */
export function fakePtySpawn(
    file: string,
    args: string[],
    opts: Record<string, unknown>,
): FakePty {
    const p = makeFakePty(file, args, opts);
    ptys.push(p);
    return p;
}

/** Bracketed-paste framing the Claude Code TUI expects around a pasted block. */
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

/** `\x1b[200~<body>\x1b[201~` — the exact framing asserted throughout. */
export function paste(body: string): string {
    return `${PASTE_START}${body}${PASTE_END}`;
}
