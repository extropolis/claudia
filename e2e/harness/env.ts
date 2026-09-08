/**
 * E2E harness environment.
 *
 * Single source of truth for the sandboxed ports and directories the browser
 * suite runs against. Everything here is computed at Playwright *config load*
 * time (see playwright.config.ts) so the isolated state exists before any
 * server or test starts, whatever order Playwright chooses internally.
 *
 * ── Port safety ────────────────────────────────────────────────────────────
 * The developer's live Claudia runs on 4001 (backend) / 5173 (frontend). The
 * E2E stack must NEVER touch those. `assertSafePort` hard-fails if anything
 * ever tries, and `assertPortFree` fails loudly rather than silently attaching
 * to somebody else's server.
 */
import {
    chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync,
} from 'fs';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');

/** Ports the developer's real dev servers own. Touching these is a hard error. */
const FORBIDDEN_PORTS = [4001, 5173];

function readPort(envVar: string, fallback: number): number {
    const raw = process.env[envVar];
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const BACKEND_PORT = readPort('CLAUDIA_E2E_BACKEND_PORT', 4801);
export const FRONTEND_PORT = readPort('CLAUDIA_E2E_FRONTEND_PORT', 5801);

export const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
export const FRONTEND_URL = `http://127.0.0.1:${FRONTEND_PORT}`;

/**
 * Root of all E2E scratch state.
 *
 * Deliberately under $HOME and NOT os.tmpdir(): on macOS tmpdir resolves under
 * /var, which `validateWorkspacePath` blocklists — workspace creation would be
 * rejected by the backend and every workspace test would fail.
 */
export const RUN_ROOT = join(homedir(), '.claudia-e2e');

export const STATE_DIR = join(RUN_ROOT, 'state');   // config.json / tasks.json / workspace-config.json
export const FAKE_HOME = join(RUN_ROOT, 'home');    // backend's $HOME → ~/.claude session files land here
export const BIN_DIR = join(RUN_ROOT, 'bin');       // fake `claude` goes on PATH from here
export const FAKE_DIR = join(RUN_ROOT, 'fake');     // fake CLI writes args.log / input.log / alive
export const WORKSPACES_DIR = join(RUN_ROOT, 'workspaces'); // temp git repos created by tests

/**
 * Desktop viewport every spec starts from. Claudia renders a mobile layout at
 * <= 768px with no main panel, terminal or file explorer; the resize spec also
 * assumes exactly this size as its baseline.
 */
export const VIEWPORT = { width: 1440, height: 900 };

/** Session id the fake CLI reports, so session-capture assertions are deterministic. */
export const FAKE_SESSION_ID = 'e2e0b0b0-1111-2222-3333-444455556666';

export function assertSafePort(port: number, label: string): void {
    if (FORBIDDEN_PORTS.includes(port)) {
        throw new Error(
            `[e2e] REFUSING TO START: ${label} port ${port} belongs to the developer's live dev server. ` +
            `Set CLAUDIA_E2E_BACKEND_PORT / CLAUDIA_E2E_FRONTEND_PORT to something else.`,
        );
    }
}

/**
 * Fail loudly if `port` already has a listener. Better a clear error than
 * silently running the suite against a stranger's server (or, worse, the
 * developer's).
 */
export function assertPortFree(port: number, label: string): void {
    if (process.platform === 'win32') return; // lsof unavailable; webServer's own check covers us
    let out = '';
    try {
        out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return; // non-zero exit from lsof means "nothing listening"
    }
    if (out) {
        throw new Error(
            `[e2e] Port ${port} (${label}) is already in use by pid(s) ${out.split('\n').join(', ')}. ` +
            `Free it or pick another port; the suite will not attach to an existing server.`,
        );
    }
}

/**
 * Wipe and recreate the isolated state tree, and install the fake Claude CLI.
 *
 * Called once at config load. The wipe is what makes "run the suite twice in a
 * row" deterministic — no workspace, task, or config leaks between runs.
 */
export function prepareHarness(): void {
    assertSafePort(BACKEND_PORT, 'backend');
    assertSafePort(FRONTEND_PORT, 'frontend');

    rmSync(RUN_ROOT, { recursive: true, force: true });
    for (const d of [STATE_DIR, FAKE_HOME, BIN_DIR, FAKE_DIR, WORKSPACES_DIR]) {
        mkdirSync(d, { recursive: true });
    }

    // Seed empty state so the backend starts from a known-clean slate rather
    // than whatever shape a previous schema left behind.
    writeFileSync(join(STATE_DIR, 'tasks.json'), JSON.stringify({ tasks: [], archivedTasks: [] }));
    writeFileSync(join(STATE_DIR, 'workspace-config.json'), JSON.stringify({
        schemaVersion: 1,
        data: { workspaces: [], activeWorkspaceId: null, recentWorkspaces: [] },
    }));
    // On a genuinely fresh install the app auto-opens Settings on the AI Core
    // panel (App.tsx: aiCoreConfigured === false). That modal covers the whole
    // UI and would block every flow. Seeding dummy credentials marks AI Core as
    // "configured" so the suite lands on the normal, post-onboarding app. The
    // values are never used — the Anthropic backend is never contacted, because
    // the only CLI on PATH is the fake one.
    writeFileSync(join(STATE_DIR, 'config.json'), JSON.stringify({
        schemaVersion: 1,
        data: {
            aiCoreCredentials: {
                clientId: 'e2e-not-a-real-client',
                clientSecret: 'e2e-not-a-real-secret',
                authUrl: 'https://e2e.invalid/oauth/token',
                baseUrl: 'https://e2e.invalid/v2',
            },
        },
    }));

    // Fake Claude CLI on PATH — no real Claude session is ever spawned.
    // Reuses the backend integration fixture so both layers test the same
    // contract (ready banner, stdin echo, session JSONL, SIGTERM exit).
    const fixture = join(REPO_ROOT, 'backend', 'src', '__tests__', 'fixtures', 'fake-claude.sh');
    if (!existsSync(fixture)) {
        throw new Error(`[e2e] fake claude fixture missing at ${fixture}`);
    }
    const fakeClaude = join(BIN_DIR, 'claude');
    copyFileSync(fixture, fakeClaude);
    chmodSync(fakeClaude, 0o755);
}

/**
 * Where the backend writes its state when CLAUDIA_DATA_DIR is *absent*.
 *
 * WorkspaceStore/ConfigStore fall back to `backend/<file>` (i.e. `__dirname/..`
 * from backend/dist). If the sandboxed server ever ignored our env, its writes
 * would land here instead — so the isolation spec asserts these stay untouched.
 */
export const DEFAULT_STATE_FILES = [
    join(REPO_ROOT, 'backend', 'workspace-config.json'),
    join(REPO_ROOT, 'backend', 'config.json'),
    join(REPO_ROOT, 'backend', 'tasks.json'),
    // Written only if the backend spawned a shared Playwright MCP server, which
    // backendEnv() disables (CLAUDIA_SHARED_MCP=0). Its presence would mean the
    // sandbox started a detached process that outlives the run.
    join(REPO_ROOT, 'backend', '.shared-playwright-mcp-4022.pid'),
];

/** Env handed to the sandboxed backend process. */
export function backendEnv(): Record<string, string> {
    // Defence in depth: the values below are what keeps the server off the
    // developer's port and out of the developer's state files. Verify them here
    // rather than trusting that nobody edited the constants above.
    assertSafePort(BACKEND_PORT, 'backend');
    if (!STATE_DIR.startsWith(RUN_ROOT)) {
        throw new Error(`[e2e] state dir ${STATE_DIR} escapes the sandbox root ${RUN_ROOT}`);
    }
    if (!FAKE_HOME.startsWith(RUN_ROOT)) {
        throw new Error(`[e2e] fake HOME ${FAKE_HOME} escapes the sandbox root ${RUN_ROOT}`);
    }
    return {
        PATH: `${BIN_DIR}:${process.env.PATH ?? ''}`,
        HOME: FAKE_HOME,
        CLAUDIA_BACKEND_PORT: String(BACKEND_PORT),
        CLAUDIA_DATA_DIR: STATE_DIR,
        CLAUDIA_FAKE_DIR: FAKE_DIR,
        CLAUDIA_FAKE_SID: FAKE_SESSION_ID,
        // Never adopt (or spawn) the shared Playwright MCP server. Its default
        // port 4022 is owned by the developer's live instance, and the backend
        // probes-and-adopts whatever answers there — a quiet way for the
        // sandbox to reach into a process it does not own. The fake CLI never
        // speaks MCP, so per-task stdio config is all the suite needs.
        CLAUDIA_SHARED_MCP: '0',
        // Faster state transitions so busy/idle assertions don't crawl.
        STATE_POLLING_MS: '400',
        NODE_ENV: 'production',
    };
}
