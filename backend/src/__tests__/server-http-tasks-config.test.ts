/**
 * HTTP integration tests for the read-only task/session routes and the
 * config/usage/MCP routes, against the REAL Express app booted by
 * helpers/server-harness.ts on an ephemeral port.
 *
 * Everything is hermetic:
 *  - $HOME points at the harness temp base, so Claude Code session JSONL files,
 *    ~/.claude.json and ~/.claudia all resolve INSIDE the sandbox. No test here
 *    can read or write the developer's real ~/.claude*.
 *  - Seeded tasks are disconnected + non-interrupted, so the spawner loads them
 *    into its lazy set and never respawns a PTY for them.
 *  - The one live-PTY block uses fixtures/fake-claude.sh (no real CLI, no
 *    network) and waits on observable state instead of sleeping.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import WebSocket from 'ws';
import {
    startHarness,
    makeTaskRecord,
    waitFor,
    type Harness, SUPPORTS_FAKE_CLI } from './helpers/server-harness.js';

/** Claude Code's projects-dir encoding: every non [a-zA-Z0-9-] char becomes '-'. */
const encodeProjectDir = (workspacePath: string) => workspacePath.replace(/[^a-zA-Z0-9-]/g, '-');

/** Path a Claude Code session JSONL lives at, under the sandboxed $HOME. */
const sessionFilePath = (home: string, workspacePath: string, sessionId: string) =>
    join(home, '.claude', 'projects', encodeProjectDir(workspacePath), `${sessionId}.jsonl`);

// ---------------------------------------------------------------------------
// Workspace dirs. These must exist BEFORE the harness boots (the server syncs
// MCP config into workspace roots at various points), and their absolute paths
// must be known up front because a workspace's `id` IS its path. They live
// under homedir() — NOT os.tmpdir(), which resolves under /var on macOS and is
// blocklisted by validateWorkspacePath.
// ---------------------------------------------------------------------------
let wsRoot: string;
let wsAlpha: string;
let wsBeta: string;
let wsGamma: string;

const TASK_A = 'task-http-alpha-1';
const TASK_B = 'task-http-beta-1';
const TASK_NO_USAGE = 'task-http-alpha-2';
const TASK_HIST = 'task-http-history-1';
const SESSION_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const MISSING_SESSION_ID = 'bbbbbbbb-9999-8888-7777-666666666666';

/** Raw-text history fixture: 4-byte ANSI prefix + 100 ASCII bytes = 104 bytes. */
const HISTORY_PREFIX = '\x1b[0m';
const HISTORY_BODY = 'abcdefghij'.repeat(10);
const HISTORY_CONTENT = HISTORY_PREFIX + HISTORY_BODY;

const usage = (
    input: number,
    output: number,
    cacheCreate: number,
    cacheRead: number,
    cost: number,
    modelBreakdown: Record<string, unknown>,
) => ({
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: cacheCreate,
    cacheReadTokens: cacheRead,
    totalCostUsd: cost,
    modelBreakdown,
    lastUpdated: '2026-01-01T00:00:00.000Z',
});

const model = (input: number, output: number, cacheCreate: number, cacheRead: number, cost: number) => ({
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: cacheCreate,
    cacheReadTokens: cacheRead,
    costUsd: cost,
});

let h: Harness;

beforeAll(async () => {
    wsRoot = mkdtempSync(join(homedir(), '.claudia-tasks-test-ws-'));
    wsAlpha = join(wsRoot, 'alpha');
    wsBeta = join(wsRoot, 'beta');
    wsGamma = join(wsRoot, 'gamma');
    for (const d of [wsAlpha, wsBeta, wsGamma]) mkdirSync(d, { recursive: true });

    h = await startHarness({
        prefix: '.claudia-tasks-test-',
        workspaces: [
            { id: wsAlpha, name: 'Alpha' },
            { id: wsBeta, name: 'Beta' },
            { id: wsGamma, name: 'Gamma' },
        ],
        tasks: [
            makeTaskRecord(TASK_A, wsAlpha, {
                sessionId: SESSION_ID,
                displayName: 'Alpha one',
                tokenUsage: usage(100, 20, 5, 7, 0.5, {
                    'claude-sonnet-4-6': model(100, 20, 5, 7, 0.5),
                }),
            }),
            makeTaskRecord(TASK_B, wsBeta, {
                sessionId: MISSING_SESSION_ID,
                tokenUsage: usage(200, 40, 0, 0, 1.25, {
                    'claude-sonnet-4-6': model(100, 20, 0, 0, 0.25),
                    'claude-opus-4-6': model(100, 20, 0, 0, 1.0),
                }),
            }),
            // No sessionId, no tokenUsage — covers both "task has no session"
            // and "task excluded from the usage dashboard".
            makeTaskRecord(TASK_NO_USAGE, wsAlpha),
            makeTaskRecord(TASK_HIST, wsAlpha),
        ],
    });

    // History fixture on disk, at the exact path the spawner reads from
    // (<base>/task-histories/<taskId>.txt).
    const histDir = join(h.base, 'task-histories');
    mkdirSync(histDir, { recursive: true });
    writeFileSync(join(histDir, `${TASK_HIST}.txt`), HISTORY_CONTENT);

    // Claude Code session JSONL fixture under the SANDBOXED $HOME.
    const sessDir = join(h.base, '.claude', 'projects', encodeProjectDir(wsAlpha));
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(join(sessDir, `${SESSION_ID}.jsonl`), [
        JSON.stringify({ type: 'summary', summary: 'Fixture conversation' }),
        JSON.stringify({
            type: 'user', uuid: 'u1', sessionId: SESSION_ID,
            timestamp: '2026-01-01T00:00:00.000Z',
            message: { role: 'user', content: 'first user message' },
        }),
        JSON.stringify({
            type: 'assistant', uuid: 'a1', sessionId: SESSION_ID,
            timestamp: '2026-01-01T00:00:01.000Z',
            message: {
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 'pondering' },
                    { type: 'text', text: 'first assistant reply' },
                ],
            },
        }),
        JSON.stringify({
            type: 'user', uuid: 'u2', sessionId: SESSION_ID,
            timestamp: '2026-01-01T00:00:02.000Z',
            message: { role: 'user', content: 'second user message' },
        }),
        '',
    ].join('\n'));
}, 30000);

afterAll(async () => {
    if (h) await h.stop();
    if (wsRoot) rmSync(wsRoot, { recursive: true, force: true });
}, 20000);

// ===========================================================================
// Health / status / system / user-id
// ===========================================================================
describe('health, backend status, system stats, user-id', () => {
    it('GET /api/health returns {status:"ok"}', async () => {
        const { status, body } = await h.req<{ status: string }>('/api/health');
        expect(status).toBe(200);
        expect(body).toEqual({ status: 'ok' });
    });

    it('GET /api/backend/status reports the configured backend and the available set', async () => {
        // Shells out to `claude --version` with a 5s timeout; `installed` depends
        // on the developer's machine, so assert the contract, not the value.
        const { status, body } = await h.req<{
            backend: string;
            installed: boolean;
            version?: string;
            error?: string;
            availableBackends: string[];
        }>('/api/backend/status');
        expect(status).toBe(200);
        expect(body.backend).toBe('claude-code');
        expect(body.availableBackends).toEqual(['claude-code', 'opencode']);
        expect(typeof body.installed).toBe('boolean');
        if (body.installed) expect(typeof body.version).toBe('string');
        else expect(typeof body.error).toBe('string');
    }, 20000);

    it('GET /api/system/stats returns clamped cpu percent and memory totals', async () => {
        const { status, body } = await h.req<{
            cpu: number;
            memory: { used: number; total: number; percent: number };
        }>('/api/system/stats');
        expect(status).toBe(200);
        expect(typeof body.cpu).toBe('number');
        expect(body.cpu).toBeGreaterThanOrEqual(0);
        expect(body.cpu).toBeLessThanOrEqual(100);
        expect(body.memory.total).toBeGreaterThan(0);
        expect(body.memory.used).toBeGreaterThan(0);
        expect(body.memory.used).toBeLessThanOrEqual(body.memory.total);
        expect(body.memory.percent).toBeGreaterThanOrEqual(0);
        expect(body.memory.percent).toBeLessThanOrEqual(100);
    });

    it('POST /api/user-id accepts a user id and is lenient about a missing one', async () => {
        const ok = await h.send('POST', '/api/user-id', { userId: 'user-http-test-1' });
        expect(ok.status).toBe(200);
        expect(ok.body).toEqual({ ok: true });

        // Documented lenient contract: an absent/blank userId is ignored, not an error.
        const empty = await h.send('POST', '/api/user-id', {});
        expect(empty.status).toBe(200);
        expect(empty.body).toEqual({ ok: true });

        const blank = await h.send('POST', '/api/user-id', { userId: '' });
        expect(blank.status).toBe(200);
        expect(blank.body).toEqual({ ok: true });
    });

    it('POST /api/user-id with malformed JSON is a 400 from the body parser, not a 500', async () => {
        const { status } = await h.req('/api/user-id', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{ not json',
        });
        expect(status).toBe(400);
    });
});

// ===========================================================================
// Task list / status / debug / output
// ===========================================================================
describe('task list and per-task read routes', () => {
    interface ApiTask {
        id: string;
        prompt: string;
        state: string;
        workspaceId: string;
        sessionId?: string;
        displayName?: string;
    }

    it('GET /api/tasks returns every seeded task with its id, workspace and disconnected state', async () => {
        const { status, body } = await h.req<ApiTask[]>('/api/tasks');
        expect(status).toBe(200);
        expect(Array.isArray(body)).toBe(true);

        const byId = new Map(body.map(t => [t.id, t]));
        expect([...byId.keys()].sort()).toEqual(
            [TASK_A, TASK_B, TASK_NO_USAGE, TASK_HIST].sort(),
        );

        const a = byId.get(TASK_A)!;
        expect(a.workspaceId).toBe(wsAlpha);
        expect(a.prompt).toBe(`task ${TASK_A}`);
        expect(a.sessionId).toBe(SESSION_ID);
        expect(a.displayName).toBe('Alpha one');
        // lastState 'idle' + wasInterrupted false => 'disconnected', not 'interrupted'
        expect(a.state).toBe('disconnected');

        expect(byId.get(TASK_B)!.workspaceId).toBe(wsBeta);
        expect(byId.get(TASK_NO_USAGE)!.workspaceId).toBe(wsAlpha);
        expect(byId.get(TASK_NO_USAGE)!.sessionId).toBeUndefined();
    });

    it('GET /api/tasks?includeArchived=true&workspaceId=… filters to that workspace', async () => {
        const { status, body } = await h.req<ApiTask[]>(
            `/api/tasks?includeArchived=true&workspaceId=${encodeURIComponent(wsBeta)}`,
        );
        expect(status).toBe(200);
        expect(body.map(t => t.id)).toEqual([TASK_B]);

        const alpha = await h.req<ApiTask[]>(
            `/api/tasks?includeArchived=true&workspaceId=${encodeURIComponent(wsAlpha)}`,
        );
        expect(alpha.status).toBe(200);
        expect(alpha.body.map(t => t.id).sort()).toEqual([TASK_A, TASK_NO_USAGE, TASK_HIST].sort());

        // No archived tasks seeded, so includeArchived alone == the plain list.
        const all = await h.req<ApiTask[]>('/api/tasks?includeArchived=true');
        expect(all.body).toHaveLength(4);

        // An unknown workspace filter is an empty list, not an error.
        const none = await h.req<ApiTask[]>(
            '/api/tasks?includeArchived=true&workspaceId=/no/such/workspace',
        );
        expect(none.status).toBe(200);
        expect(none.body).toEqual([]);
    });

    it('GET /api/tasks/:taskId/status reports "disconnected" for a seeded task', async () => {
        const { status, body } = await h.req<{ id: string; state: string; lastActivity?: string }>(
            `/api/tasks/${TASK_A}/status`,
        );
        expect(status).toBe(200);
        expect(body.id).toBe(TASK_A);
        expect(body.state).toBe('disconnected');
        // `lastActivity` comes off the LIVE task map, which a disconnected task
        // is not in — so it is undefined here. Documented, not asserted as data.
        expect(body.lastActivity).toBeUndefined();
    });

    it('GET /api/tasks/:taskId/status 404s for an unknown task', async () => {
        const { status, body } = await h.req<{ error: string }>('/api/tasks/task-does-not-exist/status');
        expect(status).toBe(404);
        expect(body.error).toBe('Task not found');
    });

    it('GET /api/tasks/:taskId/debug 404s for unknown AND for disconnected tasks', async () => {
        const unknown = await h.req<{ error: string }>('/api/tasks/task-does-not-exist/debug');
        expect(unknown.status).toBe(404);
        expect(unknown.body.error).toBe('Task not found');

        // NOTE: /debug resolves through taskSpawner.getTask(), which only covers
        // LIVE tasks — a persisted-but-disconnected task 404s here even though
        // /status and /api/tasks both know about it. Asserting the real contract.
        const disconnected = await h.req<{ error: string }>(`/api/tasks/${TASK_A}/debug`);
        expect(disconnected.status).toBe(404);
        expect(disconnected.body.error).toBe('Task not found');
    });

    it('GET /api/tasks/:taskId/output 404s for unknown AND for disconnected tasks', async () => {
        const unknown = await h.req<{ error: string }>('/api/tasks/task-does-not-exist/output');
        expect(unknown.status).toBe(404);
        expect(unknown.body.error).toBe('Task not found');

        // Same live-only lookup as /debug.
        const disconnected = await h.req<{ error: string }>(`/api/tasks/${TASK_A}/output`);
        expect(disconnected.status).toBe(404);
        expect(disconnected.body.error).toBe('Task not found');

        // A junk maxBytes falls back to the 8192 default rather than 500ing.
        const junk = await h.req<{ error: string }>(`/api/tasks/${TASK_A}/output?maxBytes=abc`);
        expect(junk.status).toBe(404);
    });
});

// ===========================================================================
// History byte-range reads
// ===========================================================================
describe('GET /api/task/:taskId/history', () => {
    interface HistoryRange {
        data: string;
        startOffset: number;
        totalSize: number;
        isBase64Legacy: boolean;
    }
    const total = Buffer.byteLength(HISTORY_CONTENT);

    it('returns metadata only for maxBytes=0', async () => {
        const { status, body } = await h.req<HistoryRange>(
            `/api/task/${TASK_HIST}/history?endBefore=${total}&maxBytes=0`,
        );
        expect(status).toBe(200);
        expect(body.totalSize).toBe(total);
        expect(body.data).toBe('');
        expect(body.startOffset).toBe(total);
        expect(body.isBase64Legacy).toBe(false);
    });

    it('returns the trailing slice [endBefore-maxBytes, endBefore)', async () => {
        const { status, body } = await h.req<HistoryRange>(
            `/api/task/${TASK_HIST}/history?endBefore=${total}&maxBytes=10`,
        );
        expect(status).toBe(200);
        expect(body.startOffset).toBe(total - 10);
        expect(body.data).toBe(HISTORY_CONTENT.slice(-10));
        expect(body.totalSize).toBe(total);
    });

    it('clamps endBefore and maxBytes to the file size', async () => {
        const mid = await h.req<HistoryRange>(
            `/api/task/${TASK_HIST}/history?endBefore=14&maxBytes=10`,
        );
        expect(mid.status).toBe(200);
        expect(mid.body.startOffset).toBe(4);
        expect(mid.body.data).toBe(HISTORY_CONTENT.slice(4, 14));

        const oversized = await h.req<HistoryRange>(
            `/api/task/${TASK_HIST}/history?endBefore=999999&maxBytes=1000000`,
        );
        expect(oversized.status).toBe(200);
        expect(oversized.body.startOffset).toBe(0);
        expect(oversized.body.totalSize).toBe(total);
        expect(oversized.body.data).toBe(HISTORY_CONTENT);
    });

    it('returns an empty zero-size range for a task with no history file', async () => {
        const { status, body } = await h.req<HistoryRange>(
            '/api/task/task-does-not-exist/history?endBefore=100&maxBytes=100',
        );
        expect(status).toBe(200);
        expect(body).toEqual({ data: '', startOffset: 0, totalSize: 0, isBase64Legacy: false });
    });

    it('400s (never 500s) on missing or out-of-range params', async () => {
        const missing = await h.req<{ error: string }>(`/api/task/${TASK_HIST}/history`);
        expect(missing.status).toBe(400);
        expect(missing.body.error).toMatch(/endBefore/);

        const noMax = await h.req<{ error: string }>(`/api/task/${TASK_HIST}/history?endBefore=10`);
        expect(noMax.status).toBe(400);

        const nan = await h.req<{ error: string }>(
            `/api/task/${TASK_HIST}/history?endBefore=abc&maxBytes=10`,
        );
        expect(nan.status).toBe(400);

        const negative = await h.req<{ error: string }>(
            `/api/task/${TASK_HIST}/history?endBefore=-1&maxBytes=10`,
        );
        expect(negative.status).toBe(400);
        expect(negative.body.error).toMatch(/endBefore >= 0/);

        const tooBig = await h.req<{ error: string }>(
            `/api/task/${TASK_HIST}/history?endBefore=10&maxBytes=${2 * 1024 * 1024 + 1}`,
        );
        expect(tooBig.status).toBe(400);
        expect(tooBig.body.error).toMatch(/maxBytes must be/);
    });
});

// ===========================================================================
// Sessions + conversations (all reads resolve under the sandboxed $HOME)
// ===========================================================================
describe('session and conversation routes', () => {
    interface Conversation {
        sessionId: string;
        summary?: string;
        messages: Array<{ role: string; content: string; timestamp: string; uuid: string; thinking?: string }>;
    }

    it('the fixture session file lives under the sandboxed $HOME, not the real one', () => {
        const p = sessionFilePath(h.base, wsAlpha, SESSION_ID);
        expect(existsSync(p)).toBe(true);
        expect(p.startsWith(h.base)).toBe(true);
    });

    it('GET /api/workspaces/:workspaceId/sessions lists the workspace session with its summary', async () => {
        const { status, body } = await h.req<Array<{ sessionId: string; summary?: string; lastModified: string }>>(
            `/api/workspaces/${encodeURIComponent(wsAlpha)}/sessions`,
        );
        expect(status).toBe(200);
        expect(body).toHaveLength(1);
        expect(body[0].sessionId).toBe(SESSION_ID);
        expect(body[0].summary).toBe('Fixture conversation');
        expect(Number.isNaN(Date.parse(body[0].lastModified))).toBe(false);
    });

    it('GET /api/workspaces/:workspaceId/sessions returns [] for a workspace with no sessions', async () => {
        const { status, body } = await h.req<unknown[]>(
            `/api/workspaces/${encodeURIComponent(wsBeta)}/sessions`,
        );
        expect(status).toBe(200);
        expect(body).toEqual([]);
    });

    it('GET /api/workspaces/:workspaceId/sessions 404s for an unknown workspace', async () => {
        const { status, body } = await h.req<{ error: string }>(
            '/api/workspaces/%2Fno%2Fsuch%2Fworkspace/sessions',
        );
        expect(status).toBe(404);
        expect(body.error).toBe('Workspace not found');
    });

    it('GET /api/sessions/:sessionId/conversation parses messages in file order', async () => {
        const { status, body } = await h.req<Conversation>(
            `/api/sessions/${SESSION_ID}/conversation?workspaceId=${encodeURIComponent(wsAlpha)}`,
        );
        expect(status).toBe(200);
        expect(body.sessionId).toBe(SESSION_ID);
        expect(body.summary).toBe('Fixture conversation');
        expect(body.messages.map(m => [m.role, m.content])).toEqual([
            ['user', 'first user message'],
            ['assistant', 'first assistant reply'],
            ['user', 'second user message'],
        ]);
        expect(body.messages[0].uuid).toBe('u1');
        expect(body.messages[1].thinking).toBe('pondering');
        expect(body.messages[1].timestamp).toBe('2026-01-01T00:00:01.000Z');
    });

    it('GET /api/sessions/:sessionId/conversation 400s without workspaceId', async () => {
        const { status, body } = await h.req<{ error: string }>(
            `/api/sessions/${SESSION_ID}/conversation`,
        );
        expect(status).toBe(400);
        expect(body.error).toBe('workspaceId query parameter required');
    });

    it('GET /api/sessions/:sessionId/conversation 404s for unknown workspace or unknown session', async () => {
        const badWorkspace = await h.req<{ error: string }>(
            `/api/sessions/${SESSION_ID}/conversation?workspaceId=%2Fno%2Fsuch%2Fworkspace`,
        );
        expect(badWorkspace.status).toBe(404);
        expect(badWorkspace.body.error).toBe('Workspace not found');

        const badSession = await h.req<{ error: string }>(
            `/api/sessions/${MISSING_SESSION_ID}/conversation?workspaceId=${encodeURIComponent(wsAlpha)}`,
        );
        expect(badSession.status).toBe(404);
        expect(badSession.body.error).toBe('Conversation not found');
    });

    it('GET /api/tasks/:taskId/conversation resolves the task session and returns its messages', async () => {
        const { status, body } = await h.req<Conversation>(`/api/tasks/${TASK_A}/conversation`);
        expect(status).toBe(200);
        expect(body.sessionId).toBe(SESSION_ID);
        expect(body.messages).toHaveLength(3);
        expect(body.messages[0].content).toBe('first user message');
        expect(body.messages[2].content).toBe('second user message');
    });

    it('GET /api/tasks/:taskId/conversation 404s for unknown task, sessionless task, and missing session file', async () => {
        const unknown = await h.req<{ error: string }>('/api/tasks/task-does-not-exist/conversation');
        expect(unknown.status).toBe(404);
        expect(unknown.body.error).toBe('Task not found');

        const sessionless = await h.req<{ error: string }>(`/api/tasks/${TASK_NO_USAGE}/conversation`);
        expect(sessionless.status).toBe(404);
        expect(sessionless.body.error).toBe('Task has no session ID');

        // TASK_B has a sessionId but no JSONL on disk for its workspace.
        const noFile = await h.req<{ error: string }>(`/api/tasks/${TASK_B}/conversation`);
        expect(noFile.status).toBe(404);
        expect(noFile.body.error).toBe('Conversation not found');
    });
});

// ===========================================================================
// App config
// ===========================================================================
describe('GET/PUT /api/config', () => {
    interface AppConfigBody {
        backend: string;
        apiMode: string;
        skipPermissions: boolean;
        autoFocusOnInput: boolean;
        tokenTrackingEnabled: boolean;
        mcpServers: unknown[];
        claudeCodeSwitches: Record<string, unknown>;
    }

    it('GET returns the defaulted config shape', async () => {
        const { status, body } = await h.req<AppConfigBody>('/api/config');
        expect(status).toBe(200);
        expect(body.backend).toBe('claude-code');
        expect(body.apiMode).toBe('default');
        expect(body.skipPermissions).toBe(false);
        expect(body.tokenTrackingEnabled).toBe(true);
        expect(Array.isArray(body.mcpServers)).toBe(true);
        expect(body.claudeCodeSwitches).toMatchObject({ verbose: false, maxTurns: null });
    });

    // NOTE: `worktreeRetentionDays` range validation is not on main yet — it
    // ships with the worktree-retention feature. Its test is intentionally
    // omitted here rather than skipped, so this file stays green on main.
    // Restore it alongside that feature.

    it('PUT rejects a bad apiMode enum and a wrong-typed boolean with 400, never 500', async () => {
        const badMode = await h.send<{ error: string }>('PUT', '/api/config', { apiMode: 'not-a-real-mode' });
        expect(badMode.status).toBe(400);
        expect(badMode.body.error).toMatch(/apiMode must be one of/);

        const badBool = await h.send<{ error: string }>('PUT', '/api/config', { skipPermissions: 'yes' });
        expect(badBool.status).toBe(400);
        expect(badBool.body.error).toBe('skipPermissions must be a boolean');

        const badRules = await h.send<{ error: string }>('PUT', '/api/config', { rules: 42 });
        expect(badRules.status).toBe(400);
        expect(badRules.body.error).toBe('rules must be a string');

        const after = await h.req<AppConfigBody>('/api/config');
        expect(after.body.apiMode).toBe('default');
        expect(after.body.skipPermissions).toBe(false);
    });

    it('PUT round-trips a valid update', async () => {
        const put = await h.send<AppConfigBody>('PUT', '/api/config', {
            autoFocusOnInput: true,
            supervisorSystemPrompt: 'http-test supervisor prompt',
        });
        expect(put.status).toBe(200);
        expect(put.body.autoFocusOnInput).toBe(true);

        const get = await h.req<AppConfigBody & { supervisorSystemPrompt: string }>('/api/config');
        expect(get.status).toBe(200);
        expect(get.body.autoFocusOnInput).toBe(true);
        expect(get.body.supervisorSystemPrompt).toBe('http-test supervisor prompt');
        // Untouched fields survive the partial update.
        expect(get.body.backend).toBe('claude-code');
    });
});

// ===========================================================================
// Usage config + dashboard
// ===========================================================================
describe('usage config and dashboard', () => {
    interface UsageConfig {
        pricing: Record<string, {
            inputPer1MTokens: number;
            outputPer1MTokens: number;
            cacheCreatePer1MTokens: number;
            cacheReadPer1MTokens: number;
        }>;
        enabled: boolean;
    }

    it('GET /api/usage/config returns the default pricing table and the enabled flag', async () => {
        const { status, body } = await h.req<UsageConfig>('/api/usage/config');
        expect(status).toBe(200);
        expect(body.enabled).toBe(true);
        expect(body.pricing['claude-sonnet-4-6']).toEqual({
            inputPer1MTokens: 3.0,
            outputPer1MTokens: 15.0,
            cacheCreatePer1MTokens: 3.75,
            cacheReadPer1MTokens: 0.3,
        });
    });

    it('PUT /api/usage/config round-trips a pricing table', async () => {
        const pricing = {
            'claude-sonnet-4-6': {
                inputPer1MTokens: 1.5,
                outputPer1MTokens: 7.5,
                cacheCreatePer1MTokens: 1.875,
                cacheReadPer1MTokens: 0.15,
            },
        };
        const put = await h.send<{ ok: boolean }>('PUT', '/api/usage/config', { pricing });
        expect(put.status).toBe(200);
        expect(put.body).toEqual({ ok: true });

        const get = await h.req<UsageConfig>('/api/usage/config');
        expect(get.status).toBe(200);
        expect(get.body.pricing).toEqual(pricing);
        expect(get.body.enabled).toBe(true);
        // The replacement is wholesale — models absent from the PUT are dropped.
        expect(get.body.pricing['claude-opus-4-6']).toBeUndefined();
    });

    it('PUT /api/usage/config ignores a body with no pricing key', async () => {
        const before = await h.req<UsageConfig>('/api/usage/config');
        const put = await h.send<{ ok: boolean }>('PUT', '/api/usage/config', {});
        expect(put.status).toBe(200);
        expect(put.body).toEqual({ ok: true });
        const after = await h.req<UsageConfig>('/api/usage/config');
        expect(after.body.pricing).toEqual(before.body.pricing);
    });

    it('GET /api/usage/dashboard aggregates seeded task token usage by workspace and model', async () => {
        const { status, body } = await h.req<{
            totalCostUsd: number;
            totalInputTokens: number;
            totalOutputTokens: number;
            totalCacheCreationTokens: number;
            totalCacheReadTokens: number;
            byWorkspace: Record<string, { name: string; costUsd: number; inputTokens: number; taskCount: number }>;
            byModel: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>;
            taskCount: number;
            lastUpdated: string;
        }>('/api/usage/dashboard');

        expect(status).toBe(200);
        // Only the two tasks carrying tokenUsage are counted.
        expect(body.taskCount).toBe(2);
        expect(body.totalInputTokens).toBe(300);
        expect(body.totalOutputTokens).toBe(60);
        expect(body.totalCacheCreationTokens).toBe(5);
        expect(body.totalCacheReadTokens).toBe(7);
        expect(body.totalCostUsd).toBeCloseTo(1.75, 6);

        expect(Object.keys(body.byWorkspace).sort()).toEqual([wsAlpha, wsBeta].sort());
        expect(body.byWorkspace[wsAlpha]).toMatchObject({ name: 'Alpha', inputTokens: 100, taskCount: 1 });
        expect(body.byWorkspace[wsAlpha].costUsd).toBeCloseTo(0.5, 6);
        expect(body.byWorkspace[wsBeta]).toMatchObject({ name: 'Beta', inputTokens: 200, taskCount: 1 });
        // A workspace with no tokened tasks never appears.
        expect(body.byWorkspace[wsGamma]).toBeUndefined();

        expect(Object.keys(body.byModel).sort()).toEqual(['claude-opus-4-6', 'claude-sonnet-4-6']);
        expect(body.byModel['claude-sonnet-4-6']).toMatchObject({ inputTokens: 200, outputTokens: 40 });
        expect(body.byModel['claude-sonnet-4-6'].costUsd).toBeCloseTo(0.75, 6);
        expect(body.byModel['claude-opus-4-6'].costUsd).toBeCloseTo(1.0, 6);

        expect(Number.isNaN(Date.parse(body.lastUpdated))).toBe(false);
    });

    // Runs LAST in this block: it deliberately corrupts the stored pricing.
    it('PUT /api/usage/config does not 500 on a non-object pricing value', async () => {
        // GAP: the route has no validation — `pricing` is written straight to
        // config.json whatever its type, and the next GET reflects it verbatim.
        // Asserted loosely so a future 400-validating fix does not break this.
        const { status } = await h.send('PUT', '/api/usage/config', { pricing: 'not-a-pricing-table' });
        expect(status).toBeLessThan(500);
        expect([200, 400]).toContain(status);
    });
});

// ===========================================================================
// Claude Code MCP server config (~/.claude.json, sandboxed)
// ===========================================================================
describe('claude MCP server config routes', () => {
    const claudeJson = () => join(h.base, '.claude.json');

    // Ordered on purpose: the "no file yet" assertions must run before the PUT.
    it('GET routes report an empty config when ~/.claude.json does not exist yet', async () => {
        expect(existsSync(claudeJson())).toBe(false);

        const raw = await h.req<{ mcpServers: string; path: string; exists: boolean }>(
            '/api/claude-config/mcp-servers',
        );
        expect(raw.status).toBe(200);
        expect(raw.body.exists).toBe(false);
        expect(JSON.parse(raw.body.mcpServers)).toEqual({});
        // Sandboxed: the route must resolve under the harness $HOME.
        expect(raw.body.path).toBe(claudeJson());
        expect(raw.body.path.startsWith(h.base)).toBe(true);

        const parsed = await h.req<{ global: unknown[]; project: unknown[] }>('/api/claude-mcp-servers');
        expect(parsed.status).toBe(200);
        expect(parsed.body).toEqual({ global: [], project: [] });
    });

    it('PUT /api/claude-config/mcp-servers 400s on bad input before writing anything', async () => {
        const notString = await h.send<{ error: string }>('PUT', '/api/claude-config/mcp-servers', {
            mcpServers: { foo: {} },
        });
        expect(notString.status).toBe(400);
        expect(notString.body.error).toBe('mcpServers must be a string');

        const badJson = await h.send<{ error: string; details?: string }>('PUT', '/api/claude-config/mcp-servers', {
            mcpServers: '{ "unterminated": ',
        });
        expect(badJson.status).toBe(400);
        expect(badJson.body.error).toBe('Invalid JSON syntax');
        expect(typeof badJson.body.details).toBe('string');

        const notObject = await h.send<{ error: string }>('PUT', '/api/claude-config/mcp-servers', {
            mcpServers: '["a"]',
        });
        expect(notObject.status).toBe(400);
        expect(notObject.body.error).toBe('mcpServers must be an object');

        const missing = await h.send<{ error: string }>('PUT', '/api/claude-config/mcp-servers', {});
        expect(missing.status).toBe(400);
        expect(missing.body.error).toBe('mcpServers must be a string');

        // None of the rejected calls may create the file.
        expect(existsSync(claudeJson())).toBe(false);
    });

    it('PUT round-trips through the follow-up GET and shows up in /api/claude-mcp-servers', async () => {
        const servers = {
            'test-stdio': { command: 'echo', args: ['hi'], description: 'stdio fixture' },
            'test-http': { type: 'streamableHttp', url: 'https://example.invalid/mcp' },
        };
        const put = await h.send<{ success: boolean; path: string }>('PUT', '/api/claude-config/mcp-servers', {
            mcpServers: JSON.stringify(servers, null, 2),
        });
        expect(put.status).toBe(200);
        expect(put.body.success).toBe(true);
        expect(put.body.path).toBe(claudeJson());

        // Written inside the sandbox, nowhere near the real ~/.claude.json.
        expect(existsSync(claudeJson())).toBe(true);
        expect(JSON.parse(readFileSync(claudeJson(), 'utf8')).mcpServers).toEqual(servers);

        const get = await h.req<{ mcpServers: string; exists: boolean; path: string }>(
            '/api/claude-config/mcp-servers',
        );
        expect(get.status).toBe(200);
        expect(get.body.exists).toBe(true);
        expect(JSON.parse(get.body.mcpServers)).toEqual(servers);

        const parsed = await h.req<{
            global: Array<Record<string, unknown>>;
            project: Array<Record<string, unknown>>;
        }>('/api/claude-mcp-servers');
        expect(parsed.status).toBe(200);
        expect(parsed.body.project).toEqual([]);
        const byName = new Map(parsed.body.global.map(s => [s.name as string, s]));
        expect([...byName.keys()].sort()).toEqual(['test-http', 'test-stdio']);
        expect(byName.get('test-stdio')).toEqual({
            name: 'test-stdio',
            type: 'stdio',
            command: 'echo',
            args: ['hi'],
            env: undefined,
            description: 'stdio fixture',
            scope: 'global',
        });
        expect(byName.get('test-http')).toMatchObject({
            name: 'test-http',
            type: 'streamableHttp',
            url: 'https://example.invalid/mcp',
            scope: 'global',
        });
    });

    it('GET /api/claude-mcp-servers surfaces project-scoped servers and honours ?workspace=', async () => {
        const config = JSON.parse(readFileSync(claudeJson(), 'utf8'));
        config.projects = {
            [wsAlpha]: { mcpServers: { 'alpha-only': { command: 'alpha-cmd' } } },
            [wsBeta]: { mcpServers: { 'beta-only': { command: 'beta-cmd' } } },
        };
        writeFileSync(claudeJson(), JSON.stringify(config, null, 2));

        const all = await h.req<{ project: Array<{ name: string; projectPath: string }> }>(
            '/api/claude-mcp-servers',
        );
        expect(all.status).toBe(200);
        expect(all.body.project.map(p => p.name).sort()).toEqual(['alpha-only', 'beta-only']);

        const filtered = await h.req<{ project: Array<{ name: string; projectPath: string; scope: string }> }>(
            `/api/claude-mcp-servers?workspace=${encodeURIComponent(wsAlpha)}`,
        );
        expect(filtered.status).toBe(200);
        expect(filtered.body.project).toHaveLength(1);
        expect(filtered.body.project[0]).toMatchObject({
            name: 'alpha-only',
            projectPath: wsAlpha,
            scope: 'project',
        });
    });

    it('GET /api/claude-mcp-servers 500s cleanly on a corrupt ~/.claude.json (and recovers)', async () => {
        const good = readFileSync(claudeJson(), 'utf8');
        writeFileSync(claudeJson(), '{ this is not json');
        try {
            const parsed = await h.req<{ error: string }>('/api/claude-mcp-servers');
            expect(parsed.status).toBe(500);
            expect(parsed.body.error).toBe('Failed to read Claude MCP servers');

            const raw = await h.req<{ error: string }>('/api/claude-config/mcp-servers');
            expect(raw.status).toBe(500);
            expect(raw.body.error).toBe('Failed to read MCP servers config');
        } finally {
            writeFileSync(claudeJson(), good);
        }

        const recovered = await h.req<{ exists: boolean }>('/api/claude-config/mcp-servers');
        expect(recovered.status).toBe(200);
        expect(recovered.body.exists).toBe(true);
    });
});

// ===========================================================================
// Live-PTY happy paths for /debug and /output.
//
// These two routes only resolve LIVE tasks, so they cannot be covered by the
// seeded (disconnected) fixtures above. This block boots a SECOND harness with
// fixtures/fake-claude.sh on PATH and creates one task over the WebSocket API
// (task creation has no HTTP route). No real CLI, no network.
// ===========================================================================
// Needs a spawned fake `claude`, which is a bash fixture — skipped on the
// Windows CI leg rather than failed there. Everything above this point runs
// on both platforms.
describe.skipIf(!SUPPORTS_FAKE_CLI)('live task /debug and /output', () => {
    let live: Harness;
    let liveWs: string;
    let taskId: string;

    const wsSend = (port: number, type: string, payload: Record<string, unknown>) =>
        new Promise<void>((resolve, reject) => {
            const sock = new WebSocket(`ws://127.0.0.1:${port}`);
            sock.on('open', () => {
                sock.send(JSON.stringify({ type, payload }));
                setTimeout(() => { sock.close(); resolve(); }, 300);
            });
            sock.on('error', reject);
        });

    beforeAll(async () => {
        liveWs = join(wsRoot, 'live');
        mkdirSync(liveWs, { recursive: true });
        live = await startHarness({
            prefix: '.claudia-tasks-live-',
            workspaces: [{ id: liveWs, name: 'Live' }],
            fakeClaude: true,
            env: {
                CLAUDIA_FAKE_SID: 'cccccccc-1111-2222-3333-444444444444',
                STATE_POLLING_MS: '500',
            },
        });

        await wsSend(live.port, 'task:create', {
            prompt: 'LIVE_PROBE_MARKER inspect me',
            workspaceId: liveWs,
        });

        const tasks = await waitFor(
            () => live.req<Array<{ id: string }>>('/api/tasks').then(r => r.body),
            ts => Array.isArray(ts) && ts.length === 1,
            20000,
            200,
        );
        taskId = tasks[0].id;
    }, 45000);

    afterAll(async () => {
        if (live) await live.stop();
    }, 20000);

    it('GET /api/tasks/:taskId/output returns the live task envelope with terminal output', async () => {
        const body = await waitFor(
            () => live.req<{
                taskId: string;
                state: string;
                prompt: string;
                workspaceId: string;
                output: string;
                lastActivity: string;
            }>(`/api/tasks/${taskId}/output`).then(r => r.body),
            b => typeof b?.output === 'string' && b.output.includes('LIVE_PROBE_MARKER'),
            30000,
            250,
        );

        expect(body.taskId).toBe(taskId);
        expect(body.prompt).toBe('LIVE_PROBE_MARKER inspect me');
        expect(body.workspaceId).toBe(liveWs);
        expect(typeof body.state).toBe('string');
        expect(Number.isNaN(Date.parse(body.lastActivity))).toBe(false);
    }, 40000);

    it('GET /api/tasks/:taskId/output caps maxBytes at 32768', async () => {
        const { status, body } = await live.req<{ output: string }>(
            `/api/tasks/${taskId}/output?maxBytes=999999`,
        );
        expect(status).toBe(200);
        expect(Buffer.byteLength(body.output)).toBeLessThanOrEqual(32768);
    });

    it('GET /api/tasks/:taskId/debug returns state, output length and the last 200 chars', async () => {
        const { status, body } = await live.req<{
            taskId: string;
            state: string;
            outputLength: number;
            last200Chars: string;
            lastActivity: string;
        }>(`/api/tasks/${taskId}/debug`);

        expect(status).toBe(200);
        expect(body.taskId).toBe(taskId);
        expect(typeof body.state).toBe('string');
        expect(body.outputLength).toBeGreaterThan(0);
        expect(body.last200Chars.length).toBeLessThanOrEqual(200);
        expect(Number.isNaN(Date.parse(body.lastActivity))).toBe(false);
    });

    it('GET /api/tasks/:taskId/status returns a live (non-disconnected) state', async () => {
        const { status, body } = await live.req<{ id: string; state: string; lastActivity: string }>(
            `/api/tasks/${taskId}/status`,
        );
        expect(status).toBe(200);
        expect(body.id).toBe(taskId);
        expect(body.state).not.toBe('disconnected');
        expect(Number.isNaN(Date.parse(body.lastActivity))).toBe(false);
    });
});
