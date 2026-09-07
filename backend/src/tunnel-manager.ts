/**
 * TunnelManager - Manages ngrok tunnel connections for mobile remote access
 *
 * Creates a public HTTPS URL that tunnels to the local backend server,
 * enabling mobile devices to connect via QR code scanning.
 * Uses ngrok which properly supports WebSocket connections (unlike localtunnel
 * whose loca.lt interstitial page blocks browser WebSocket upgrades).
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { spawn, execSync, ChildProcess } from 'child_process';
import { createLogger } from './logger.js';

const logger = createLogger('[TunnelManager]');

export interface TunnelStatus {
    active: boolean;
    url: string | null;
    token: string | null;
    startedAt: string | null;
    error: string | null;
    publicIp: string | null;
    /** The reserved domain the tunnel is pinned to, or null on ngrok's assigned URL. */
    domain: string | null;
    /**
     * Whether the public URL actually answered when this machine fetched it.
     * null = not probed yet. false is the interesting one: the agent is happily
     * connected but the URL is unreachable, which is what a network-level block
     * of the ngrok domain looks like. Without this the UI shows a healthy green
     * tunnel while every phone that scans the QR gets nothing.
     */
    reachable: boolean | null;
    /** Human-readable explanation when `reachable` is false. */
    warning: string | null;
}

// No default domain - use random ngrok URL unless user configures one

/** Shape of one entry in ngrok's local `/api/tunnels` response. */
interface NgrokApiTunnel {
    public_url: string;
    proto: string;
    config?: { addr?: string };
}

/**
 * Pull the port out of an ngrok tunnel's forwarding address.
 * ngrok reports it as a URL ("http://localhost:4001") on modern versions and
 * as a bare host:port ("localhost:4001") on older ones. Returns null when the
 * address carries no port we can trust (e.g. a plain "80" shorthand).
 */
export function parseNgrokAddrPort(addr: string): number | null {
    const m = /:(\d{1,5})(?:\/|$)/.exec(addr.trim());
    if (!m) return null;
    const port = Number(m[1]);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/**
 * Injectable side-effecting dependencies.
 *
 * Production always uses the node defaults below; the seam exists purely so
 * tests can drive the state machine (adopt / spawn / retry / stop) without
 * touching the network or launching a real ngrok process.
 */
/**
 * The subset of a `Response` this module actually reads. `status` and
 * `headers` are optional so the many existing fakes that return only `json()`
 * keep compiling; the reachability probe treats an absent header lookup as
 * "no ngrok error", which is the same verdict it reached before.
 */
export interface TunnelFetchResponse {
    json(): Promise<unknown>;
    status?: number;
    headers?: { get(name: string): string | null };
}

export interface TunnelManagerDeps {
    spawn: typeof spawn;
    execSync: typeof execSync;
    fetch: (input: string, init?: { signal?: AbortSignal }) => Promise<TunnelFetchResponse>;
}

const defaultDeps: TunnelManagerDeps = {
    spawn,
    execSync,
    fetch: (input, init) => fetch(input, init),
};

export class TunnelManager extends EventEmitter {
    private ngrokProcess: ChildProcess | null = null;
    private token: string | null = null;
    private _url: string | null = null;
    /**
     * The tunnel's public URL. Wrapped in an accessor purely so that every
     * assignment — start, stop, retry, adopt, auto-recover — bumps
     * `tunnelGeneration` without each call site having to remember to.
     */
    private get url(): string | null { return this._url; }
    private set url(next: string | null) {
        if (next !== this._url) this.tunnelGeneration++;
        this._url = next;
    }
    private startedAt: string | null = null;
    private publicIp: string | null = null;
    private reachable: boolean | null = null;
    private warning: string | null = null;
    /**
     * Bumped every time `url` changes. An in-flight reachability probe captures
     * it and refuses to publish its verdict if the tunnel moved on meanwhile,
     * so a slow probe from a torn-down tunnel cannot mark a fresh one dead.
     */
    private tunnelGeneration = 0;
    private retryCount = 0;
    private maxRetries = 3;
    private retryTimeout: NodeJS.Timeout | null = null;
    private stopping = false;
    private port: number;
    private domain: string | null;
    /**
     * Non-null when tracking an orphaned ngrok we didn't spawn
     * (e.g. left behind by a previous server instance after tsx watch reload).
     * Its presence is the single source of truth for "adopted mode".
     */
    private adoptedMonitor: NodeJS.Timeout | null = null;
    private deps: TunnelManagerDeps;

    constructor(port: number, domain?: string, deps?: Partial<TunnelManagerDeps>) {
        super();
        this.port = port;
        this.domain = domain || null;
        this.deps = { ...defaultDeps, ...deps };
        logger.info('TunnelManager initialized (ngrok)', { port, domain: this.domain || '(random)' });
    }

    /**
     * Update the port (needed when the server uses a dynamic port)
     */
    setPort(port: number): void {
        this.port = port;
    }

    /** The port tunnels are opened against — exposed for logging/diagnostics. */
    getPort(): number {
        return this.port;
    }

    /**
     * Pin future tunnels to a reserved domain (paid ngrok), or pass an empty
     * value to go back to ngrok's assigned URL (free). Takes effect on the next
     * start(); an already-running tunnel is left alone so changing the setting
     * never yanks a URL out from under a connected phone.
     */
    setDomain(domain: string | null | undefined): void {
        const next = domain && domain.trim() ? domain.trim() : null;
        if (next === this.domain) return;
        logger.info('Tunnel domain changed', { from: this.domain || '(assigned)', to: next || '(assigned)' });
        this.domain = next;
    }

    getDomain(): string | null {
        return this.domain;
    }

    /**
     * Start a new ngrok tunnel.
     * If an orphaned ngrok process is already running (e.g. after a tsx watch reload),
     * we adopt it and keep the same public URL so mobile clients don't need to re-scan.
     */
    async start(): Promise<TunnelStatus> {
        if (this.ngrokProcess || this.adoptedMonitor) {
            logger.info('Tunnel already active', { url: this.url, adopted: this.adoptedMonitor !== null });
            return this.getStatus();
        }

        this.stopping = false;
        this.retryCount = 0;
        this.token = randomUUID();

        logger.info('Starting ngrok tunnel...', { port: this.port });

        // Fetch public IP for reference
        try {
            const ipRes = await this.deps.fetch('https://api.ipify.org?format=json');
            const ipData = await ipRes.json() as { ip: string };
            this.publicIp = ipData.ip;
            logger.info('Public IP resolved', { ip: this.publicIp });
        } catch (ipErr) {
            logger.warn('Failed to fetch public IP', { error: ipErr instanceof Error ? ipErr.message : String(ipErr) });
            this.publicIp = null;
        }

        // Check if there's already a running ngrok we can adopt (e.g. orphan from tsx watch reload).
        // Connection refused returns immediately, so this adds no latency in the normal case.
        const existingUrl = await this.checkNgrokRunning();
        if (existingUrl) {
            logger.info('Found existing ngrok tunnel — adopting it (keeps same URL, no re-scan needed)', { url: existingUrl });
            this.url = existingUrl;
            this.startedAt = new Date().toISOString();
            this.startAdoptedMonitor();
            this.emit('tunnel:ready', { url: this.url, token: this.token });
            return this.getStatus();
        }

        try {
            await this.startNgrok();
            return this.getStatus();
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            logger.error('Failed to start ngrok tunnel', { error: errorMsg });
            this.cleanup();
            this.emit('tunnel:error', errorMsg);
            return {
                active: false,
                url: null,
                token: null,
                startedAt: null,
                error: errorMsg,
                publicIp: this.publicIp,
                domain: this.domain,
                reachable: null,
                warning: null
            };
        }
    }

    /**
     * Start ngrok process and get the public URL via ngrok's local API.
     * The local API at 127.0.0.1:4040 is the most reliable way to get the
     * tunnel URL regardless of ngrok version or log format changes.
     */
    private async startNgrok(): Promise<void> {
        // Use 'ngrok' (not 'ngrok.exe') because npm installs it as ngrok.cmd on Windows
        const ngrokExe = 'ngrok';
        try {
            this.deps.execSync(`${process.platform === 'win32' ? 'where' : 'which'} ${ngrokExe}`, { stdio: 'ignore' });
        } catch {
            throw new Error(`ngrok is not installed. Install it from https://ngrok.com/download and ensure it's in your PATH.`);
        }

        // Kill any stale ngrok processes first (free tier allows only 1 session).
        // On Windows, taskkill by name catches orphaned grandchild processes that
        // survived after their cmd.exe parent was killed.
        try {
            const killCmd = process.platform === 'win32'
                ? 'taskkill /f /im ngrok.exe 2>nul || exit /b 0'
                : 'pkill -f ngrok 2>/dev/null || true';
            this.deps.execSync(killCmd, { stdio: 'ignore' });
            await new Promise(r => setTimeout(r, 500));
        } catch {
            // ignore
        }

        // `--url`, not `--domain`: ngrok 3.x still accepts --domain but logs
        // "Flag --domain has been deprecated, use --url instead" (verified on
        // ngrok 3.37.1), and it will eventually be removed.
        const ngrokArgs = this.domain
            ? ['http', '--url', this.domain, String(this.port)]
            : ['http', String(this.port)];
        logger.info('Spawning ngrok', { args: ngrokArgs });

        const ngrok = this.deps.spawn(ngrokExe, ngrokArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: process.platform === 'win32', // Required on Windows to find .cmd files
        });

        this.ngrokProcess = ngrok;

        // Collect stderr + stdout output during startup so we can surface actual ngrok errors
        const startupOutput: string[] = [];

        ngrok.stderr?.on('data', (data: Buffer) => {
            const msg = data.toString().trim();
            if (msg) {
                logger.warn('Ngrok stderr', { output: msg });
                startupOutput.push(msg);
            }
        });

        ngrok.stdout?.on('data', (data: Buffer) => {
            const msg = data.toString().trim();
            if (msg) {
                logger.info('Ngrok stdout', { output: msg });
                startupOutput.push(msg);
            }
        });

        ngrok.on('error', (err) => {
            logger.error('Ngrok process error', { error: err.message });
            startupOutput.push(err.message);
            this.emit('tunnel:error', err.message);
        });

        // Create a promise that rejects if ngrok exits early (before we get a URL)
        const earlyExitPromise = new Promise<never>((_resolve, reject) => {
            ngrok.on('close', (code) => {
                logger.info('Ngrok process exited during startup', { code, output: startupOutput.join('\n') });
                this.ngrokProcess = null;
                this.url = null;

                if (!this.stopping) {
                    const errorDetail = startupOutput.length > 0
                        ? startupOutput.join(' | ')
                        : `exit code ${code}`;
                    reject(new Error(`ngrok failed to start: ${errorDetail}`));
                }
            });
        });

        // Race: poll for URL vs. early process exit
        let url: string | null;
        try {
            url = await Promise.race([
                this.pollNgrokApi(15000),
                earlyExitPromise,
            ]);
        } catch (err) {
            ngrok.kill();
            throw err;
        }

        if (!url) {
            ngrok.kill();
            const errorDetail = startupOutput.length > 0
                ? startupOutput.join(' | ')
                : 'no response from ngrok local API';
            throw new Error(`ngrok startup timeout: ${errorDetail}`);
        }

        // Success — install the long-running close handler for reconnection
        ngrok.removeAllListeners('close');
        ngrok.on('close', (code) => {
            logger.info('Ngrok process exited', { code });
            this.ngrokProcess = null;
            this.url = null;

            if (!this.stopping && this.retryCount < this.maxRetries) {
                this.retryCount++;
                logger.info(`Ngrok disconnected, retrying... (${this.retryCount}/${this.maxRetries})`);
                this.retryTimeout = setTimeout(() => this.reconnect(), 2000 * this.retryCount);
                this.emit('tunnel:closed');
            } else if (!this.stopping) {
                this.cleanup();
                this.emit('tunnel:closed');
            }
        });

        this.url = url;
        this.startedAt = new Date().toISOString();
        logger.info('Ngrok tunnel started', { url: this.url, token: this.token });
        this.emit('tunnel:ready', { url: this.url, token: this.token });
    }

    /**
     * Single HTTP call to the ngrok local API.
     * Shared by checkNgrokRunning() and pollNgrokApi() to avoid duplicate parse logic.
     */
    private async fetchNgrokUrl(signal?: AbortSignal): Promise<string | null> {
        const res = await this.deps.fetch('http://127.0.0.1:4040/api/tunnels', signal ? { signal } : undefined);
        const data = await res.json() as { tunnels: Array<NgrokApiTunnel> };
        const match = data.tunnels?.find(t => t.proto === 'https' && this.tunnelTargetsOurPort(t));
        return match?.public_url ?? null;
    }

    /**
     * Does this ngrok tunnel forward to the port THIS manager is serving?
     *
     * Without the check, every extra process that calls createApp() — the
     * integration-test harness on an ephemeral port, a second backend
     * instance — adopted whatever ngrok happened to be running, and its
     * teardown then ran `taskkill /f /im ngrok.exe` and killed the real
     * tunnel out from under the live server. Running `npm test` took the
     * user's mobile access down.
     *
     * A tunnel whose addr we cannot parse is treated as ours: the field is
     * advisory, and refusing to adopt on a parse miss would regress the
     * tsx-watch orphan recovery this whole path exists for.
     */
    private tunnelTargetsOurPort(t: NgrokApiTunnel): boolean {
        const addr = t.config?.addr;
        if (!addr) return true;
        const port = parseNgrokAddrPort(addr);
        if (port === null) return true;
        return port === this.port;
    }

    /**
     * One-shot check: is there already a running ngrok at 127.0.0.1:4040?
     * Times out quickly so it doesn't block tunnel startup in the normal (no orphan) case.
     */
    private async checkNgrokRunning(): Promise<string | null> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        try {
            return await this.fetchNgrokUrl(controller.signal);
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Poll ngrok's local API at 127.0.0.1:4040 until a tunnel URL is available.
     */
    private async pollNgrokApi(timeoutMs: number): Promise<string | null> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                const url = await this.fetchNgrokUrl();
                if (url) return url;
            } catch {
                // ngrok API not ready yet
            }
            await new Promise(r => setTimeout(r, 500));
        }
        return null;
    }

    /**
     * While in adopted mode, poll the ngrok API every 5 s to detect if the
     * orphaned process has died so we can mark the tunnel as closed.
     *
     * Uses a captured handle for identity and a `checking` flag to prevent
     * overlapping async executions if checkNgrokRunning() ever takes >5 s.
     */
    private startAdoptedMonitor(): void {
        let checking = false;
        const handle = setInterval(async () => {
            // Stop if this interval has been superseded (stop() or cleanup() ran)
            if (this.adoptedMonitor !== handle || this.stopping) {
                clearInterval(handle);
                return;
            }
            if (checking) return;
            checking = true;
            try {
                const url = await this.checkNgrokRunning();
                if (this.adoptedMonitor !== handle) return; // cleared while we were awaiting
                if (!url) {
                    logger.info('Adopted ngrok tunnel has disconnected');
                    clearInterval(handle);
                    this.adoptedMonitor = null;
                    this.url = null;
                    this.token = null;
                    this.emit('tunnel:closed');
                }
            } finally {
                checking = false;
            }
        }, 5000);
        this.adoptedMonitor = handle;
    }

    /**
     * Reconnect after disconnection
     */
    private async reconnect(): Promise<void> {
        if (this.stopping) return;

        logger.info('Attempting ngrok reconnection...', { attempt: this.retryCount });

        try {
            await this.startNgrok();
            this.retryCount = 0;
            this.emit('tunnel:ready', { url: this.url, token: this.token });
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            logger.error('Reconnection failed', { error: errorMsg, attempt: this.retryCount });

            if (this.retryCount < this.maxRetries) {
                this.retryCount++;
                this.retryTimeout = setTimeout(() => this.reconnect(), 2000 * this.retryCount);
            } else {
                logger.error('Max retries reached, giving up');
                this.cleanup();
                this.emit('tunnel:error', 'Max retries reached');
            }
        }
    }

    /**
     * Stop the tunnel
     */
    async stop(): Promise<void> {
        logger.info('Stopping ngrok tunnel...');
        this.stopping = true;
        const wasAdopted = this.adoptedMonitor !== null;

        if (this.adoptedMonitor) {
            clearInterval(this.adoptedMonitor);
            this.adoptedMonitor = null;
        }

        if (this.retryTimeout) {
            clearTimeout(this.retryTimeout);
            this.retryTimeout = null;
        }

        if (this.ngrokProcess) {
            try {
                if (process.platform === 'win32' && this.ngrokProcess.pid) {
                    // On Windows, kill('SIGTERM') only kills the cmd.exe shell wrapper —
                    // ngrok.exe (the grandchild) survives as an orphan.
                    // /T kills the entire process tree.
                    this.deps.execSync(`taskkill /F /T /PID ${this.ngrokProcess.pid} 2>nul || exit /b 0`, { stdio: 'ignore' });
                } else {
                    this.ngrokProcess.kill('SIGTERM');
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    if (this.ngrokProcess && !this.ngrokProcess.killed) {
                        this.ngrokProcess.kill('SIGKILL');
                    }
                }
            } catch (err) {
                logger.error('Error stopping ngrok', { error: err instanceof Error ? err.message : String(err) });
            }
        }

        // In adopted mode we had no PID, so kill ngrok by name instead
        if (process.platform === 'win32' && wasAdopted) {
            try {
                this.deps.execSync('taskkill /f /im ngrok.exe 2>nul || exit /b 0', { stdio: 'ignore' });
            } catch { /* ignore */ }
        }

        this.cleanup();
        logger.info('Ngrok tunnel stopped');
    }

    /**
     * Get current tunnel status
     */
    getStatus(): TunnelStatus {
        return {
            active: this.url !== null,
            url: this.url,
            token: this.token,
            startedAt: this.startedAt,
            error: null,
            publicIp: this.publicIp,
            domain: this.domain,
            reachable: this.reachable,
            warning: this.warning
        };
    }

    /**
     * Fetch the tunnel's own public URL from this machine to confirm the edge
     * is really serving it.
     *
     * Diagnoses the failure that is otherwise invisible: the ngrok agent stays
     * connected and reports the tunnel as up, but the public hostname is
     * blocked on the network — the TLS handshake is refused before any HTTP is
     * exchanged, so phones and browsers get "nothing" while every local health
     * check stays green. Observed with `*.ngrok-free.dev`, which some networks
     * and mobile carriers drop by SNI while every other ngrok zone works.
     *
     * Best-effort and non-fatal: a failure here downgrades status, never the
     * tunnel itself.
     */
    async checkReachable(): Promise<boolean | null> {
        // Pin the URL and the tunnel generation for the whole probe. The fetch
        // below runs for up to 15s, and the tunnel can be stopped or restarted
        // underneath it: re-reading `this.url` in the catch used to throw a
        // TypeError when it had become null, and on a restart it would write a
        // stale "unreachable" verdict over a healthy new tunnel.
        const probedUrl = this.url;
        const generation = this.tunnelGeneration;
        if (!probedUrl) {
            this.reachable = null;
            this.warning = null;
            return null;
        }

        // Applies a probe result only if this generation is still the live one.
        const commit = (reachable: boolean, warning: string | null): boolean | null => {
            if (generation !== this.tunnelGeneration) {
                logger.info('Discarding stale tunnel reachability result', { probedUrl });
                return this.reachable;
            }
            this.reachable = reachable;
            this.warning = warning;
            return this.reachable;
        };

        const host = (() => {
            try { return new URL(probedUrl).hostname; } catch { return probedUrl; }
        })();
        const zone = host.split('.').slice(-2).join('.');
        const blockedAdvice =
            `This usually means the network is blocking the ${zone} domain rather than anything being wrong ` +
            `with Claudia — phones on such a network get a blank page. Set a reserved ngrok domain on another ` +
            `zone (Settings -> ngrok domain) to work around it.`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
            const res = await this.deps.fetch(probedUrl, { signal: controller.signal });

            // A response from ngrok's own edge error page (agent offline, tunnel
            // not found, ...) proves the hostname resolves but NOT that our
            // server is behind it — which is exactly the state this probe
            // exists to surface. ngrok stamps those with `ngrok-error-code`.
            const ngrokError = res.headers?.get?.('ngrok-error-code');
            if (ngrokError) {
                logger.warn('Tunnel host served an ngrok error page', { url: probedUrl, ngrokError });
                return commit(
                    false,
                    `The tunnel hostname ${host} is reachable but ngrok is not forwarding to Claudia ` +
                    `(${ngrokError}). The agent may have disconnected — try turning the tunnel off and on again.`,
                );
            }

            logger.info('Tunnel URL is reachable', { url: probedUrl, status: res.status });
            return commit(true, null);
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            logger.warn('Tunnel URL is NOT reachable from this machine', { url: probedUrl, error: detail });
            return commit(
                false,
                `The tunnel is running but ${host} could not be reached from this machine (${detail}). ` +
                blockedAdvice,
            );
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Check for an orphaned ngrok on startup and auto-adopt it.
     * Called once after construction so the tunnel survives tsx watch restarts
     * without requiring the user to manually re-enable it.
     */
    async autoRecover(): Promise<void> {
        if (this.ngrokProcess || this.adoptedMonitor) return;

        const existingUrl = await this.checkNgrokRunning();
        if (!existingUrl) return;

        logger.info('Auto-recovering orphaned ngrok tunnel on server startup', { url: existingUrl });
        this.url = existingUrl;
        this.token = randomUUID();
        this.startedAt = new Date().toISOString();
        this.startAdoptedMonitor();
        this.emit('tunnel:ready', { url: this.url, token: this.token });
    }

    /**
     * Validate a token against the active tunnel token
     */
    validateToken(token: string): boolean {
        if (!this.token) return false;
        if (!this.ngrokProcess && !this.adoptedMonitor) return false;
        return token === this.token;
    }

    /**
     * Cleanup internal state
     */
    private cleanup(): void {
        if (this.adoptedMonitor) {
            clearInterval(this.adoptedMonitor);
            this.adoptedMonitor = null;
        }
        this.ngrokProcess = null;
        this.url = null;
        this.token = null;
        this.startedAt = null;
        this.publicIp = null;
        this.reachable = null;
        this.warning = null;
        this.retryCount = 0;
    }
}
