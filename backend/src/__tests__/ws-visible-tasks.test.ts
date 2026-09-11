/**
 * WS wiring for the split-screen visible set (`task:setVisible`).
 *
 * The store-level behaviour is covered in visible-tasks.test.ts. What this file
 * proves is the part that unit tests structurally cannot: that the two new
 * message types survive the VALID_WS_MESSAGE_TYPES allowlist in server.ts and
 * reach their handlers. A handler that exists but whose message type was never
 * allowlisted is silently dropped — the frontend would send `task:setVisible`
 * forever and every non-focused pane would sit frozen, with no error anywhere.
 *
 * Temp dirs live under homedir(), not os.tmpdir() — macOS /var is blocklisted
 * by validateWorkspacePath.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import WebSocket from 'ws';
import { createApp } from '../server.js';
import { getAuthToken } from '../auth-token.js';

let base: string;
let port: number;
let token: string;
let shutdown: (() => Promise<void>) | undefined;

/**
 * Send one message and resolve with the first reply of an expected type.
 * Every WS upgrade is authenticated, so the socket presents the API token.
 */
function wsCall(type: string, payload: Record<string, unknown>, expectTypes: string[], timeoutMs = 8000): Promise<{ type: string; payload: any }> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${encodeURIComponent(token)}`);
        const timer = setTimeout(() => { ws.close(); reject(new Error(`timeout waiting for ${expectTypes.join('|')}`)); }, timeoutMs);
        ws.on('open', () => ws.send(JSON.stringify({ type, payload })));
        ws.on('message', (data: Buffer) => {
            let msg: any;
            try { msg = JSON.parse(data.toString()); } catch { return; }
            if (expectTypes.includes(msg.type)) {
                clearTimeout(timer);
                ws.close();
                resolve(msg);
            }
        });
        ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
}

beforeAll(async () => {
    base = mkdtempSync(join(homedir(), '.claudia-vis-ws-test-'));
    const mkTask = (id: string) => ({
        id, prompt: `task ${id}`, workspaceId: join(base, 'ws'),
        createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(),
        lastState: 'idle', wasInterrupted: false, shouldContinue: false, backendType: 'claude-code',
    });
    writeFileSync(join(base, 'tasks.json'), JSON.stringify({
        tasks: [mkTask('task-p1'), mkTask('task-p2'), mkTask('task-p3')],
        archivedTasks: [],
    }, null, 2));

    const appParts = await createApp(base);
    shutdown = appParts.shutdownForTests;
    token = getAuthToken(base);
    await new Promise<void>((resolve) => appParts.server.listen(0, '127.0.0.1', () => resolve()));
    port = (appParts.server.address() as { port: number }).port;
}, 30000);

afterAll(async () => {
    if (shutdown) await shutdown();
    try { rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* best effort */ }
}, 20000);

describe('task:setVisible', () => {
    it('acks with the full set, not just the last id', async () => {
        const reply = await wsCall('task:setVisible', { taskIds: ['task-p1', 'task-p2', 'task-p3'] }, ['task:visibleSet']);
        expect(reply.payload.taskIds).toEqual(['task-p1', 'task-p2', 'task-p3']);
    });

    it('accepts an empty set (last pane closed)', async () => {
        const reply = await wsCall('task:setVisible', { taskIds: [] }, ['task:visibleSet']);
        expect(reply.payload.taskIds).toEqual([]);
    });

    it('rejects a non-array payload instead of throwing', async () => {
        const reply = await wsCall('task:setVisible', { taskIds: 'task-p1' }, ['error', 'task:visibleSet']);
        expect(reply.type).toBe('error');
    });

    it('never reaches the handler on a socket without the API token', async () => {
        // Split-screen traffic rides the same authenticated socket as everything
        // else: an untokened client cannot even open it to declare a layout.
        const outcome = await new Promise<string>((resolve) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}`);
            ws.on('open', () => { ws.close(); resolve('opened'); });
            ws.on('unexpected-response', (_req, res) => resolve(`refused ${res.statusCode}`));
            ws.on('error', () => resolve('error'));
        });
        expect(outcome).toBe('refused 401');
    });

    it('survives junk ids without killing the connection', async () => {
        const reply = await wsCall('task:setVisible', { taskIds: [null, 7, '', 'task-p1'] } as never, ['task:visibleSet', 'error']);
        expect(reply.type).toBe('task:visibleSet');
        expect(reply.payload.taskIds).toEqual(['task-p1']);
    });
});
