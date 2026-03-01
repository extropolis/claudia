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
}

export const DEFAULT_NGROK_DOMAIN = 'winning-walleye-neat.ngrok-free.app';

export class TunnelManager extends EventEmitter {
    private ngrokProcess: ChildProcess | null = null;
    private token: string | null = null;
    private url: string | null = null;
    private startedAt: string | null = null;
    private publicIp: string | null = null;
    private retryCount = 0;
    private maxRetries = 3;
    private retryTimeout: NodeJS.Timeout | null = null;
    private stopping = false;
    private port: number;
    private domain: string;

    constructor(port: number, domain?: string) {
        super();
        this.port = port;
        this.domain = domain || DEFAULT_NGROK_DOMAIN;
        logger.info('TunnelManager initialized (ngrok)', { port, domain: this.domain });
    }

    /**
     * Start a new ngrok tunnel
     */
    async start(): Promise<TunnelStatus> {
        if (this.ngrokProcess) {
            logger.info('Tunnel already active', { url: this.url });
            return this.getStatus();
        }

        this.stopping = false;
        this.retryCount = 0;
        this.token = randomUUID();

        logger.info('Starting ngrok tunnel...', { port: this.port });

        // Fetch public IP for reference
        try {
            const ipRes = await fetch('https://api.ipify.org?format=json');
            const ipData = await ipRes.json() as { ip: string };
            this.publicIp = ipData.ip;
            logger.info('Public IP resolved', { ip: this.publicIp });
        } catch (ipErr) {
            logger.warn('Failed to fetch public IP', { error: ipErr instanceof Error ? ipErr.message : String(ipErr) });
            this.publicIp = null;
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
                publicIp: this.publicIp
            };
        }
    }

    /**
     * Start ngrok process and get the public URL via ngrok's local API.
     * The local API at 127.0.0.1:4040 is the most reliable way to get the
     * tunnel URL regardless of ngrok version or log format changes.
     */
    private async startNgrok(): Promise<void> {
        // Kill any stale ngrok processes first (free tier allows only 1 session)
        try {
            execSync('pkill -f ngrok 2>/dev/null || true', { stdio: 'ignore' });
            await new Promise(r => setTimeout(r, 500));
        } catch {
            // ignore
        }

        const ngrokArgs = ['http', '--domain', this.domain, String(this.port)];
        logger.info('Spawning ngrok', { args: ngrokArgs });

        const ngrok = spawn('ngrok', ngrokArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        this.ngrokProcess = ngrok;

        ngrok.stderr?.on('data', (data: Buffer) => {
            const msg = data.toString().trim();
            if (msg) logger.warn('Ngrok stderr', { output: msg });
        });

        ngrok.on('error', (err) => {
            logger.error('Ngrok process error', { error: err.message });
            this.emit('tunnel:error', err.message);
        });

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

        // Poll ngrok's local API to get the tunnel URL
        const url = await this.pollNgrokApi(15000);
        if (!url) {
            ngrok.kill();
            throw new Error('ngrok startup timeout: could not get tunnel URL from local API');
        }

        this.url = url;
        this.startedAt = new Date().toISOString();
        logger.info('Ngrok tunnel started', { url: this.url, token: this.token });
        this.emit('tunnel:ready', { url: this.url, token: this.token });
    }

    /**
     * Poll ngrok's local API at 127.0.0.1:4040 until a tunnel URL is available.
     */
    private async pollNgrokApi(timeoutMs: number): Promise<string | null> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                const res = await fetch('http://127.0.0.1:4040/api/tunnels');
                const data = await res.json() as { tunnels: Array<{ public_url: string; proto: string }> };
                const httpsTunnel = data.tunnels?.find(t => t.proto === 'https');
                if (httpsTunnel?.public_url) {
                    return httpsTunnel.public_url;
                }
            } catch {
                // ngrok API not ready yet
            }
            await new Promise(r => setTimeout(r, 500));
        }
        return null;
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

        if (this.retryTimeout) {
            clearTimeout(this.retryTimeout);
            this.retryTimeout = null;
        }

        if (this.ngrokProcess) {
            try {
                this.ngrokProcess.kill('SIGTERM');
                // Give it a moment to exit gracefully
                await new Promise(resolve => setTimeout(resolve, 1000));
                if (this.ngrokProcess && !this.ngrokProcess.killed) {
                    this.ngrokProcess.kill('SIGKILL');
                }
            } catch (err) {
                logger.error('Error stopping ngrok', { error: err instanceof Error ? err.message : String(err) });
            }
        }

        this.cleanup();
        logger.info('Ngrok tunnel stopped');
    }

    /**
     * Get current tunnel status
     */
    getStatus(): TunnelStatus {
        return {
            active: this.ngrokProcess !== null && this.url !== null,
            url: this.url,
            token: this.token,
            startedAt: this.startedAt,
            error: null,
            publicIp: this.publicIp
        };
    }

    /**
     * Validate a token against the active tunnel token
     */
    validateToken(token: string): boolean {
        if (!this.token || !this.ngrokProcess) return false;
        return token === this.token;
    }

    /**
     * Cleanup internal state
     */
    private cleanup(): void {
        this.ngrokProcess = null;
        this.url = null;
        this.token = null;
        this.startedAt = null;
        this.publicIp = null;
        this.retryCount = 0;
    }
}
