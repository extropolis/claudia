/**
 * On-disk history caps and the byte-range history reader.
 *
 * Why these matter: history files are the only unbounded thing the spawner
 * writes. Before the cap they grew to 50+ MB each (3.6 GB across 354 files),
 * and the reader that feeds the frontend's lazy scroll-up is the one place a
 * bad offset silently corrupts what the user sees.
 *
 * These drive the REAL TaskSpawner but never spawn a CLI: rotation runs from
 * the constructor's startup sweep, and readTaskHistoryRange is public. That
 * keeps the whole file in a plain `describe` so the Windows CI leg runs it too.
 *
 * Temp dirs live under homedir(), NOT os.tmpdir() — on macOS os.tmpdir()
 * resolves under /var, which validateWorkspacePath blocklists as a system path.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { TaskSpawner } from '../task-spawner.js';

const TASK_ID = 'task-history-cap-1';

interface Ctx {
    base: string;
    tasksFile: string;
    historyDir: string;
    spawner?: TaskSpawner;
}

const active: Ctx[] = [];
const savedEnv: Record<string, string | undefined> = {};

function setEnv(k: string, v: string | undefined): void {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
}

/** Seed a base dir with tasks.json (legacy envelope) + a task-histories dir. */
function makeCtx(taskIds: string[] = [TASK_ID]): Ctx {
    const base = mkdtempSync(join(homedir(), '.claudia-histcap-test-'));
    const tasksFile = join(base, 'tasks.json');
    writeFileSync(tasksFile, JSON.stringify({
        tasks: taskIds.map(id => ({
            id,
            prompt: `task ${id}`,
            workspaceId: base,
            createdAt: new Date().toISOString(),
            lastActivity: new Date().toISOString(),
            lastState: 'idle',
            wasInterrupted: false,
            shouldContinue: false,
            backendType: 'claude-code',
        })),
        archivedTasks: [],
    }));
    const historyDir = join(base, 'task-histories');
    mkdirSync(historyDir, { recursive: true });
    const ctx: Ctx = { base, tasksFile, historyDir };
    active.push(ctx);
    return ctx;
}

/** Build `bytes`-ish of numbered lines; the final line is TAIL_MARKER_LAST. */
function makeHistory(bytes: number): string {
    let out = '';
    let i = 0;
    while (out.length < bytes) {
        out += `LINE_${String(i).padStart(6, '0')} ${'x'.repeat(40)}\n`;
        i++;
    }
    return out + 'TAIL_MARKER_LAST\n';
}

/** Construct the real spawner with autoReconnect disabled (never respawns). */
function startSpawner(ctx: Ctx): TaskSpawner {
    const s = new TaskSpawner(ctx.tasksFile, false);
    ctx.spawner = s;
    return s;
}

afterEach(() => {
    for (const ctx of active.splice(0)) {
        try { ctx.spawner?.destroy(); } catch { /* best effort */ }
        try { rmSync(ctx.base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
    }
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    for (const k of Object.keys(savedEnv)) delete savedEnv[k];
});

describe('on-disk history file rotation (the 10MB cap)', () => {
    it('rotates a file over the cap down to the keep-tail, preserving the newest output', () => {
        setEnv('HISTORY_FILE_MAX_BYTES', '4096');
        setEnv('HISTORY_FILE_KEEP_BYTES', '2048');

        const ctx = makeCtx();
        const histPath = join(ctx.historyDir, `${TASK_ID}.txt`);
        const original = makeHistory(20_000);
        writeFileSync(histPath, original);
        const originalSize = statSync(histPath).size;
        expect(originalSize).toBeGreaterThan(4096);

        // The startup sweep rotates already-oversized files.
        startSpawner(ctx);

        const after = readFileSync(histPath, 'utf8');
        // Truncation actually happened on disk...
        expect(statSync(histPath).size).toBeLessThan(originalSize);
        // ...to roughly the keep window (marker + newline realignment slack).
        expect(statSync(histPath).size).toBeLessThan(2048 + 512);
        // The NEWEST output survives — that is the whole point of keeping a tail.
        expect(after).toContain('TAIL_MARKER_LAST');
        // The oldest lines are gone.
        expect(after).not.toContain('LINE_000000');
        // And the user is told the file was trimmed rather than silently losing it.
        expect(after).toContain('history trimmed');
    });

    it('leaves a file UNDER the cap completely untouched', () => {
        setEnv('HISTORY_FILE_MAX_BYTES', '100000');
        setEnv('HISTORY_FILE_KEEP_BYTES', '2048');

        const ctx = makeCtx();
        const histPath = join(ctx.historyDir, `${TASK_ID}.txt`);
        const original = makeHistory(5_000);
        writeFileSync(histPath, original);

        startSpawner(ctx);

        expect(readFileSync(histPath, 'utf8')).toBe(original);
    });

    it('disables rotation entirely when the cap is 0 (opt-out is honoured)', () => {
        setEnv('HISTORY_FILE_MAX_BYTES', '0');
        setEnv('HISTORY_FILE_KEEP_BYTES', '1024');

        const ctx = makeCtx();
        const histPath = join(ctx.historyDir, `${TASK_ID}.txt`);
        const original = makeHistory(20_000);
        writeFileSync(histPath, original);

        startSpawner(ctx);

        expect(readFileSync(histPath, 'utf8')).toBe(original);
    });

    it('cuts at a line boundary so the first surviving line is not a partial line', () => {
        setEnv('HISTORY_FILE_MAX_BYTES', '4096');
        setEnv('HISTORY_FILE_KEEP_BYTES', '2048');

        const ctx = makeCtx();
        const histPath = join(ctx.historyDir, `${TASK_ID}.txt`);
        writeFileSync(histPath, makeHistory(20_000));

        startSpawner(ctx);

        const after = readFileSync(histPath, 'utf8');
        // Drop the injected marker line; every remaining line must be whole.
        const lines = after.split('\n').slice(1).filter(l => l.length > 0);
        for (const line of lines) {
            if (line === 'TAIL_MARKER_LAST') continue;
            expect(line).toMatch(/^LINE_\d{6} x{40}$/);
        }
    });
});

describe('orphan history sweep', () => {
    it('deletes history files whose task no longer exists, keeps known ones', () => {
        setEnv('HISTORY_FILE_MAX_BYTES', '100000');

        const ctx = makeCtx([TASK_ID]);
        const known = join(ctx.historyDir, `${TASK_ID}.txt`);
        const orphan = join(ctx.historyDir, 'task-long-gone.txt');
        writeFileSync(known, 'keep me\n');
        writeFileSync(orphan, 'delete me\n');

        startSpawner(ctx);

        expect(existsSync(known)).toBe(true);
        expect(existsSync(orphan)).toBe(false);
    });

    it('does not touch in-flight .tmp files from a concurrent atomic write', () => {
        setEnv('HISTORY_FILE_MAX_BYTES', '100000');

        const ctx = makeCtx([TASK_ID]);
        const tmp = join(ctx.historyDir, 'task-other.12345.tmp.txt');
        writeFileSync(tmp, 'mid-rename\n');

        startSpawner(ctx);

        expect(existsSync(tmp)).toBe(true);
    });
});

describe('readTaskHistoryRange (lazy scroll-up byte reader)', () => {
    it('returns empty metadata for a task with no history file', () => {
        const ctx = makeCtx();
        const s = startSpawner(ctx);

        const r = s.readTaskHistoryRange(TASK_ID, 1000, 500);
        expect(r).toEqual({ data: '', startOffset: 0, totalSize: 0, isBase64Legacy: false });
    });

    it('reports total size without reading data when maxBytes is 0', () => {
        const ctx = makeCtx();
        const body = 'hello [world] and more\n';
        writeFileSync(join(ctx.historyDir, `${TASK_ID}.txt`), body);
        const s = startSpawner(ctx);

        const r = s.readTaskHistoryRange(TASK_ID, body.length, 0);
        expect(r.totalSize).toBe(body.length);
        expect(r.data).toBe('');
        expect(r.isBase64Legacy).toBe(false);
    });

    it('returns exactly the [endBefore - maxBytes, endBefore) window', () => {
        const ctx = makeCtx();
        // Leading space keeps the raw-text heuristic happy.
        const body = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        writeFileSync(join(ctx.historyDir, `${TASK_ID}.txt`), body);
        const s = startSpawner(ctx);

        const r = s.readTaskHistoryRange(TASK_ID, 11, 5);
        expect(r.startOffset).toBe(6);
        expect(r.data).toBe(body.slice(6, 11));
        expect(r.totalSize).toBe(body.length);
    });

    it('clamps a range that runs past EOF instead of over-reading', () => {
        const ctx = makeCtx();
        const body = ' short body\n';
        writeFileSync(join(ctx.historyDir, `${TASK_ID}.txt`), body);
        const s = startSpawner(ctx);

        const r = s.readTaskHistoryRange(TASK_ID, 99_999, 99_999);
        expect(r.startOffset).toBe(0);
        expect(r.data).toBe(body);
        expect(r.totalSize).toBe(body.length);
    });

    it('returns no data when the requested window is empty or before the start', () => {
        const ctx = makeCtx();
        writeFileSync(join(ctx.historyDir, `${TASK_ID}.txt`), ' abcdef\n');
        const s = startSpawner(ctx);

        expect(s.readTaskHistoryRange(TASK_ID, 0, 100).data).toBe('');
    });

    it('skips leading continuation bytes and reports the corrected startOffset', () => {
        const ctx = makeCtx();
        // '─' is 3 bytes (E2 94 80) starting at offset 1.
        const body = ' ─── done\n';
        writeFileSync(join(ctx.historyDir, `${TASK_ID}.txt`), body);
        const s = startSpawner(ctx);

        // A window whose raw start lands on byte 2 of '─' (a continuation byte)
        // must advance to the next character start rather than decode a partial.
        const r = s.readTaskHistoryRange(TASK_ID, 7, 5);
        expect(r.startOffset).toBe(4);        // advanced past E2 94 80's tail
        expect(r.data).not.toContain('�');
        expect(r.data).toBe('─');
    });

    it('reconstructs the file exactly when walked backwards like the scroll-up UI', () => {
        const ctx = makeCtx();
        const body = ' ─── done ─── more ───\n';
        writeFileSync(join(ctx.historyDir, `${TASK_ID}.txt`), body);
        const s = startSpawner(ctx);

        // This is the real lazy-scroll contract: each returned startOffset
        // becomes the next endBefore, so every boundary is character-aligned by
        // induction. Chunk sizes deliberately do not divide the 3-byte chars.
        //
        // NOTE: windows smaller than a single multi-byte character (maxBytes <= 3
        // here) cannot make progress — every byte in the window is a continuation
        // byte, so the reader returns '' with startOffset unchanged and a caller
        // looping on it would stall. The frontend always requests KB-sized
        // chunks, so this is unreachable in practice; it is called out in the PR
        // rather than encoded here as if it were intended behaviour.
        for (const chunk of [8, 16, 32]) {
            let end = Buffer.byteLength(body);
            let out = '';
            let guard = 0;
            while (end > 0 && guard++ < 500) {
                const r = s.readTaskHistoryRange(TASK_ID, end, chunk);
                if (r.data === '') break;
                expect(r.data).not.toContain('�');
                out = r.data + out;
                end = r.startOffset;
            }
            expect(out).toBe(body);
        }
    });

    it('flags a legacy base64 history instead of returning garbled bytes', () => {
        const ctx = makeCtx();
        // base64: no ESC, no space, no brackets — the legacy-format heuristic.
        const b64 = Buffer.from('some old history content that is long enough').toString('base64');
        writeFileSync(join(ctx.historyDir, `${TASK_ID}.txt`), b64);
        const s = startSpawner(ctx);

        const r = s.readTaskHistoryRange(TASK_ID, b64.length, 100);
        expect(r.isBase64Legacy).toBe(true);
        expect(r.data).toBe('');
        expect(r.totalSize).toBe(b64.length);
    });

    it('treats a file containing ANSI escapes as raw text, not legacy base64', () => {
        const ctx = makeCtx();
        const body = '\x1b[90mdim\x1b[0m\n';
        writeFileSync(join(ctx.historyDir, `${TASK_ID}.txt`), body);
        const s = startSpawner(ctx);

        const r = s.readTaskHistoryRange(TASK_ID, body.length, 1000);
        expect(r.isBase64Legacy).toBe(false);
        expect(r.data).toBe(body);
    });
});
