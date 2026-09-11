import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { backendFetchAt } from '../claudia-mcp-server.js';

/**
 * Regression coverage for the ECONNRESET that killed MCP tool calls:
 *
 *   [Claudia MCP ERROR] Backend request failed: /api/tasks TypeError: fetch failed
 *     [cause]: Error: read ECONNRESET
 *
 * A pooled keep-alive socket died under a request. The request itself was fine,
 * so backendFetchAt must retry rather than fail the whole tool call.
 */

const servers: http.Server[] = [];

// backendFetchAt authenticates every request. Supplying the token through the
// supported CLAUDIA_AUTH_TOKEN override (what a remote backend uses) keeps the
// loopback bootstrap — itself a request — out of these servers' attempt counts,
// so each count below measures exactly the retry behaviour under test.
const TOKEN = 'retry-test-token';
let savedToken: string | undefined;

beforeEach(() => {
    savedToken = process.env.CLAUDIA_AUTH_TOKEN;
    process.env.CLAUDIA_AUTH_TOKEN = TOKEN;
});

afterEach(async () => {
    if (savedToken === undefined) delete process.env.CLAUDIA_AUTH_TOKEN;
    else process.env.CLAUDIA_AUTH_TOKEN = savedToken;
    await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))));
});

/** Start a server; `handler` gets the 1-based request count so it can fail early ones. */
async function startServer(
    handler: (n: number, req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<string> {
    let n = 0;
    const server = http.createServer((req, res) => handler(++n, req, res));
    servers.push(server);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Destroying the socket mid-request is what the client sees as read ECONNRESET. */
function resetSocket(res: http.ServerResponse) {
    res.socket?.destroy();
}

describe('backendFetchAt transient-failure retry', () => {
    it('retries a GET whose socket is reset and returns the eventual success', async () => {
        let served = 0;
        let retryToken: string | string[] | undefined;
        const url = await startServer((n, req, res) => {
            if (n === 1) return resetSocket(res);
            served = n;
            retryToken = req.headers['x-claudia-token'];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify([{ id: 'task-1' }]));
        });

        const response = await backendFetchAt(url, '/api/tasks');

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([{ id: 'task-1' }]);
        expect(served).toBe(2); // the retry, not the first attempt, produced it
        // The retried request still carries the credential.
        expect(retryToken).toBe(TOKEN);
    });

    it('gives up after the retry budget and reports the underlying code', async () => {
        let attempts = 0;
        const url = await startServer((n, _req, res) => {
            attempts = n;
            resetSocket(res);
        });

        // undici reports a socket that died before any response bytes as
        // UND_ERR_SOCKET, and one that died mid-body as ECONNRESET. Both are
        // the same fault and both must reach the caller named, not as a bare
        // "fetch failed".
        await expect(backendFetchAt(url, '/api/tasks')).rejects.toThrow(/UND_ERR_SOCKET|ECONNRESET/);
        expect(attempts).toBe(3);
    });

    it('does NOT retry a reset POST — the write may already have landed', async () => {
        let attempts = 0;
        const url = await startServer((n, _req, res) => {
            attempts = n;
            resetSocket(res);
        });

        await expect(
            backendFetchAt(url, '/api/tasks/t1/cron', { method: 'POST', body: '{}' })
        ).rejects.toThrow(/Failed to connect/);
        expect(attempts).toBe(1);
    });

    it('does retry a POST when the connection was refused outright', async () => {
        // Nothing ever listened here, so the body provably never reached a server.
        const dead = await startServer(() => {});
        await new Promise<void>(r => servers.pop()!.close(() => r()));

        const started = Date.now();
        await expect(
            backendFetchAt(dead, '/api/jira/focus', { method: 'POST', body: '{}' })
        ).rejects.toThrow(/Failed to connect/);
        // Three attempts with 150ms + 300ms backoff cannot finish instantly.
        expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    });

    it('never retries an HTTP error status — 500 is the server answering', async () => {
        let attempts = 0;
        const url = await startServer((n, _req, res) => {
            attempts = n;
            res.writeHead(500);
            res.end('boom');
        });

        const response = await backendFetchAt(url, '/api/tasks');

        expect(response.status).toBe(500);
        expect(attempts).toBe(1);
    });
});
