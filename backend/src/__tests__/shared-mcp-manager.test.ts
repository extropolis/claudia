/**
 * Tests for the shared Playwright MCP server.
 *
 * These spawn the real @playwright/mcp binary rather than mocking it — the
 * whole premise of this change is that one process multiplexes many sessions,
 * and a mock would happily "confirm" that without proving anything.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { SharedMcpManager } from '../shared-mcp-manager.js';
import { existsSync } from 'fs';
import { join } from 'path';

// Ports well away from 4001/5173 and from the production default (4022).
let nextPort = 4531;
const allocPort = () => nextPort++;

const playwrightInstalled = existsSync(
    join(__dirname, '..', '..', '..', 'node_modules', '@playwright', 'mcp', 'cli.js'),
);

const managers: SharedMcpManager[] = [];
const track = (m: SharedMcpManager) => {
    managers.push(m);
    return m;
};

afterEach(() => {
    while (managers.length) managers.pop()!.stop();
});

async function initSession(url: string, clientName: string) {
    const res = await fetch(url, {
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
                clientInfo: { name: clientName, version: '1' },
            },
        }),
    });
    return {
        ok: res.ok,
        sessionId: res.headers.get('mcp-session-id'),
        body: await res.text(),
    };
}

describe.skipIf(!playwrightInstalled)('SharedMcpManager', () => {
    it('starts a server that answers MCP initialize', async () => {
        const m = track(new SharedMcpManager(allocPort()));
        expect(await m.ensureStarted()).toBe(true);

        const status = m.getStatus();
        expect(status.running).toBe(true);
        expect(status.adopted).toBe(false);
        expect(status.pid).toBeGreaterThan(0);

        const s = await initSession(status.url, 'test');
        expect(s.ok).toBe(true);
        expect(s.body).toContain('serverInfo');
    }, 60_000);

    it('multiplexes concurrent sessions on a single process', async () => {
        const m = track(new SharedMcpManager(allocPort()));
        expect(await m.ensureStarted()).toBe(true);
        const { url, pid } = m.getStatus();

        const [a, b] = await Promise.all([
            initSession(url, 'client-a'),
            initSession(url, 'client-b'),
        ]);

        expect(a.sessionId).toBeTruthy();
        expect(b.sessionId).toBeTruthy();
        // Distinct sessions are what make one process safe to share.
        expect(a.sessionId).not.toBe(b.sessionId);
        // ...and it must still be the same single process serving both.
        expect(m.getStatus().pid).toBe(pid);
    }, 60_000);

    it('adopts an already-running server instead of spawning a second one', async () => {
        const port = allocPort();
        const first = track(new SharedMcpManager(port));
        expect(await first.ensureStarted()).toBe(true);
        const firstPid = first.getStatus().pid;

        // Simulates a tsx watch reload: a fresh backend on the same port.
        const second = new SharedMcpManager(port);
        expect(await second.ensureStarted()).toBe(true);
        expect(second.getStatus().adopted).toBe(true);
        expect(second.getStatus().pid).toBe(firstPid);

        // The adopting instance must not have killed the original.
        const s = await initSession(second.getStatus().url, 'after-adopt');
        expect(s.ok).toBe(true);
    }, 90_000);

    it('reports not-running before start, and stops cleanly', async () => {
        const m = new SharedMcpManager(allocPort());
        expect(m.getStatus().running).toBe(false);

        expect(await m.ensureStarted()).toBe(true);
        const { pid, url } = m.getStatus();
        expect(pid).toBeGreaterThan(0);

        m.stop();
        expect(m.getStatus().running).toBe(false);

        // Give the process a moment to actually exit, then confirm it's gone.
        await new Promise(r => setTimeout(r, 2000));
        await expect(
            fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
                body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
                signal: AbortSignal.timeout(3000),
            }),
        ).rejects.toThrow();
    }, 60_000);
});

describe('SharedMcpManager (no external process)', () => {
    it('exposes a URL whose host matches the bind host', () => {
        // Playwright MCP enforces a Host check; a mismatch yields 403 and every
        // task silently loses browser tooling.
        const m = new SharedMcpManager(4599);
        expect(m.getStatus().url).toBe('http://localhost:4599/mcp');
    });
});
