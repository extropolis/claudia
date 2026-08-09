/**
 * Shared MCP server manager.
 *
 * Historically every Claudia task spawned its own stdio MCP servers. Stdio is
 * inherently 1:1 — one subprocess per client — so N tasks meant N Playwright
 * MCP processes. On a busy machine that dominated memory: 71 tasks produced 71
 * Playwright servers consuming several GB, which pushed the host into swap.
 *
 * Playwright MCP supports Streamable HTTP (`--port`), and one server process
 * multiplexes many independent sessions (each client gets its own
 * mcp-session-id and browser context). So we run exactly one and point every
 * task's MCP config at its URL.
 *
 * Two properties matter for correctness here:
 *
 * 1. The server must OUTLIVE the backend. `tsx watch` restarts the backend on
 *    every source edit; if the shared server were a normal child it would die
 *    with each reload and take every task's browser access with it. We spawn it
 *    detached and unref'd, and record the pid so a later boot can adopt it.
 *
 * 2. Boot must be idempotent. A restarted backend probes the port first and
 *    reuses a healthy server rather than spawning a second one (which would
 *    fail on EADDRINUSE and leave tasks pointing at nothing).
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createLogger } from './logger.js';

const logger = createLogger('[SharedMCP]');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Default port for the shared Playwright MCP server. Deliberately not 4001/5173. */
export const DEFAULT_SHARED_PLAYWRIGHT_PORT = 4022;

/**
 * Playwright MCP rejects requests whose Host header doesn't match what it was
 * bound to, so the URL we hand out must use the same hostname we bind.
 */
const BIND_HOST = 'localhost';

const READY_TIMEOUT_MS = 30_000;
const READY_POLL_INTERVAL_MS = 250;
const HEALTH_CHECK_INTERVAL_MS = 30_000;

export interface SharedMcpStatus {
    running: boolean;
    port: number;
    url: string;
    pid?: number;
    /** True when this backend adopted a server that was already running. */
    adopted: boolean;
}

export class SharedMcpManager {
    private port: number;
    private pid?: number;
    private adopted = false;
    private healthTimer?: NodeJS.Timeout;
    private stopped = false;
    /** Guards against concurrent respawns from overlapping health checks. */
    private starting?: Promise<boolean>;

    constructor(port: number = DEFAULT_SHARED_PLAYWRIGHT_PORT) {
        this.port = port;
    }

    get url(): string {
        return `http://${BIND_HOST}:${this.port}/mcp`;
    }

    private get pidFile(): string {
        return join(__dirname, '..', `.shared-playwright-mcp-${this.port}.pid`);
    }

    private get logFile(): string {
        return join(__dirname, '..', `.shared-playwright-mcp-${this.port}.log`);
    }

    getStatus(): SharedMcpStatus {
        return {
            running: this.pid !== undefined,
            port: this.port,
            url: this.url,
            pid: this.pid,
            adopted: this.adopted,
        };
    }

    /**
     * Resolve the Playwright MCP CLI inside the repo's node_modules.
     * Returns null when the package isn't installed, in which case callers
     * should fall back to per-task stdio servers.
     */
    private resolveCliPath(): string | null {
        const cli = join(__dirname, '..', '..', 'node_modules', '@playwright', 'mcp', 'cli.js');
        return existsSync(cli) ? cli : null;
    }

    /**
     * Probe the MCP endpoint with a real `initialize` call.
     *
     * A plain TCP connect isn't enough — an unrelated process could hold the
     * port, and we'd hand every task a URL that never speaks MCP. Checking for
     * a valid JSON-RPC response is what makes adoption safe.
     */
    private async probe(): Promise<boolean> {
        try {
            const res = await fetch(this.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: {
                        protocolVersion: '2024-11-05',
                        capabilities: {},
                        clientInfo: { name: 'claudia-healthcheck', version: '1' },
                    },
                }),
                signal: AbortSignal.timeout(5_000),
            });
            if (!res.ok) return false;
            const text = await res.text();
            if (!text.includes('"result"')) return false;

            // Verify it's actually Playwright. Any MCP server could be holding
            // this port; adopting one would hand every task the wrong toolset,
            // and the failure would look like Playwright tools silently
            // vanishing rather than a port conflict.
            //
            // The body is SSE-framed ("event: message\ndata: {...}"), so match
            // the serverInfo name textually rather than JSON.parse-ing.
            return /"serverInfo"\s*:\s*\{[^}]*"name"\s*:\s*"Playwright"/.test(text);
        } catch {
            return false;
        }
    }

    private readPidFile(): number | undefined {
        try {
            if (!existsSync(this.pidFile)) return undefined;
            const pid = parseInt(readFileSync(this.pidFile, 'utf-8').trim(), 10);
            return Number.isFinite(pid) ? pid : undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * Start the shared server, or adopt one that's already healthy.
     * Returns false when sharing is unavailable so callers can fall back to
     * per-task stdio servers rather than leaving tasks with no browser tooling.
     */
    async ensureStarted(): Promise<boolean> {
        if (this.starting) return this.starting;
        this.starting = this.doEnsureStarted().finally(() => {
            this.starting = undefined;
        });
        return this.starting;
    }

    private async doEnsureStarted(): Promise<boolean> {
        // Adopt an existing healthy server (the common case across tsx reloads).
        if (await this.probe()) {
            this.pid = this.readPidFile();
            this.adopted = true;
            logger.info('Adopted running shared Playwright MCP server', {
                port: this.port,
                url: this.url,
                pid: this.pid,
            });
            this.startHealthChecks();
            return true;
        }

        const cliPath = this.resolveCliPath();
        if (!cliPath) {
            logger.warn('@playwright/mcp not found; falling back to per-task stdio MCP servers');
            return false;
        }

        // Detached + unref'd so the server survives backend restarts.
        //
        // stdout/stderr go to a log file, not 'ignore': when the server fails
        // to start, the only symptom is a readiness timeout, and with no output
        // captured there is nothing to debug from. A file (rather than a pipe)
        // avoids the unread-pipe buffer filling up and blocking the server
        // mid-request once it is running.
        let stdio: 'ignore' | ['ignore', number, number] = 'ignore';
        let logFd: number | undefined;
        try {
            logFd = openSync(this.logFile, 'a');
            stdio = ['ignore', logFd, logFd];
        } catch (err) {
            logger.warn('Could not open shared MCP log file; output will be discarded', {
                path: this.logFile,
                error: err,
            });
        }

        const child = spawn(
            process.execPath,
            [cliPath, '--port', String(this.port), '--host', BIND_HOST],
            { detached: true, stdio },
        );
        child.unref();
        // The child holds its own dup of the fd; ours would otherwise leak on
        // every respawn.
        if (logFd !== undefined) {
            try { closeSync(logFd); } catch { /* already closed */ }
        }

        if (child.pid === undefined) {
            logger.error('Failed to spawn shared Playwright MCP server (no pid)');
            return false;
        }
        this.pid = child.pid;
        this.adopted = false;

        // NOTE: the pid file is written only after we confirm this child both
        // came up and survived. Writing it eagerly would let a race loser
        // clobber the winner's pid, leaving the file pointing at a dead
        // process that stop() would later "kill" — by then possibly a
        // recycled, unrelated pid.
        const ready = await this.waitUntilReady(child.pid);
        if (!ready) {
            logger.error('Shared Playwright MCP server did not become ready; falling back to stdio', {
                port: this.port,
                timeoutMs: READY_TIMEOUT_MS,
                logFile: this.logFile,
            });
            // Kill only the process we spawned. Deliberately NOT stop(), which
            // is a terminal teardown — a transient startup failure must not
            // permanently disable health-check recovery.
            this.killSpawned();
            return false;
        }

        // Two backends can race to spawn (this codebase has a history of nested
        // instances). The loser's child dies on EADDRINUSE while the port goes
        // healthy anyway, so readiness alone doesn't prove OUR child is the one
        // serving. Recording a dead pid would make stop() later kill an
        // unrelated process that inherited the number.
        if (!this.isAlive(child.pid)) {
            const owner = this.readPidFile();
            logger.info('Lost spawn race for shared MCP port; adopting the winner', {
                port: this.port,
                ourDeadPid: child.pid,
                ownerPid: owner,
            });
            this.pid = owner !== child.pid ? owner : undefined;
            this.adopted = true;
            this.startHealthChecks();
            return true;
        }

        try {
            writeFileSync(this.pidFile, String(child.pid), 'utf-8');
        } catch (err) {
            // Non-fatal: we lose cross-restart pid reporting, not the server.
            logger.warn('Could not write shared MCP pid file', { error: err });
        }

        logger.info('Started shared Playwright MCP server', {
            port: this.port,
            url: this.url,
            pid: child.pid,
        });
        this.startHealthChecks();
        return true;
    }

    private isAlive(pid: number | undefined): boolean {
        if (pid === undefined) return false;
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    }

    /** Kill only a process this instance spawned, without terminal teardown. */
    private killSpawned(): void {
        if (this.pid !== undefined) {
            try {
                process.kill(this.pid, 'SIGTERM');
            } catch {
                // Already gone.
            }
            this.pid = undefined;
        }
    }

    /**
     * Poll until the server answers, the child dies, or we time out.
     *
     * Watching the child matters for startup latency: if the port is already
     * taken (EADDRINUSE) the child exits within milliseconds, and without this
     * check we'd block the backend for the full 30s timeout before falling
     * back to stdio. Callers distinguish "died but port healthy" (lost a spawn
     * race — adopt) from "died and port dead" (genuine failure).
     */
    private async waitUntilReady(childPid?: number): Promise<boolean> {
        const deadline = Date.now() + READY_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (await this.probe()) return true;
            if (childPid !== undefined && !this.isAlive(childPid)) {
                logger.warn('Shared MCP child exited before becoming ready', {
                    port: this.port,
                    pid: childPid,
                    logFile: this.logFile,
                });
                return false;
            }
            await new Promise(r => setTimeout(r, READY_POLL_INTERVAL_MS));
        }
        return false;
    }

    /**
     * Sharing concentrates risk: one crash now affects every task instead of
     * one. Periodic probing restarts the server so a crash degrades into a
     * brief blip rather than permanently broken browser tooling.
     */
    private startHealthChecks(): void {
        if (this.healthTimer) return;
        this.healthTimer = setInterval(async () => {
            if (this.stopped || this.starting) return;
            if (await this.probe()) return;
            logger.warn('Shared Playwright MCP server unhealthy; restarting', { port: this.port });
            this.pid = undefined;
            await this.ensureStarted();
        }, HEALTH_CHECK_INTERVAL_MS);
        // Don't hold the event loop open on shutdown.
        this.healthTimer.unref?.();
    }

    /**
     * Stop the shared server and clear its pid file.
     *
     * NOT called on normal backend shutdown — the server is meant to outlive
     * `tsx watch` reloads. This exists for explicit teardown and tests.
     */
    stop(): void {
        this.stopped = true;
        if (this.healthTimer) {
            clearInterval(this.healthTimer);
            this.healthTimer = undefined;
        }
        const pid = this.pid ?? this.readPidFile();
        if (pid !== undefined) {
            try {
                process.kill(pid, 'SIGTERM');
            } catch {
                // Already gone.
            }
        }
        try {
            if (existsSync(this.pidFile)) unlinkSync(this.pidFile);
        } catch {
            // Best effort.
        }
        this.pid = undefined;
    }
}
