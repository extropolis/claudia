/**
 * sdk-task-server.ts
 *
 * Bridges the SDK runner into the existing Claudia WebSocket + REST surface.
 * Sits alongside TaskSpawner — does not replace it. Tasks created via this
 * module emit the same WS message kinds the frontend already understands
 * (`task:created`, `task:stateChanged`, `task:conversation:event`,
 * `task:waitingInput`, `task:destroyed`) plus a couple new ones for
 * SDK-specific permission flow.
 *
 * Integration points:
 *   - `attachSdkTaskRoutes(app, broadcast)` mounts REST endpoints on Express.
 *   - `dispatchSdkWsMessage(ws, msg, broadcast)` handles WS messages targeted
 *     at SDK tasks (sdk:task:create, sdk:task:abort, sdk:permission:respond).
 *   - `seedReconnectingClient(ws)` sends pending permission requests + the
 *     conversation snapshot for any active SDK tasks the client may need.
 */
import type { Express, Request, Response } from 'express';
import type { ConversationEvent, Task, WSMessage, WSMessageType } from '@claudia/shared';
import { createLogger } from './logger.js';
import {
  SdkTaskRunner,
  sdkTaskRegistry,
  type SdkRunResultSummary,
} from './sdk-task-runner.js';
import {
  sdkPermissionBroker,
  type ClientPermissionResponse,
  type PendingRequestSummary,
} from './sdk-permission-broker.js';

const logger = createLogger('[SdkTaskServer]');

type Broadcast = (msg: WSMessage) => void;

/**
 * Helper for creating a typed WS message — accepts the new SDK kinds plus
 * the existing ones the frontend already handles.
 */
function ws<T>(type: string, payload: T): WSMessage {
  return { type: type as WSMessageType, payload };
}

/**
 * Minimal Task shape we expose for SDK tasks. Mirrors the structure the
 * frontend taskStore expects so the same UI code works.
 */
function publicTaskFor(runner: SdkTaskRunner, prompt: string, displayName?: string): Task {
  const usage = runner.getTokenUsage();
  // Only attach when we've actually accumulated something — frontend hides
  // the chip on zero-usage tasks.
  const hasUsage =
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.cacheCreationTokens > 0 ||
    usage.cacheReadTokens > 0 ||
    usage.totalCostUsd > 0;
  return {
    id: runner.taskId,
    prompt,
    state: runner.getState(),
    workspaceId: runner.workspaceId,
    createdAt: runner.createdAt,
    lastActivity: new Date(),
    sessionId: runner.getSessionId(),
    backendType: 'claude-code',
    displayName,
    tokenUsage: hasUsage ? usage : undefined,
  };
}

interface SdkTaskCreateInput {
  workspaceId: string;
  cwd: string;
  prompt: string;
  systemPrompt?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  allowedTools?: string[];
  disallowedTools?: string[];
  model?: string;
  resumeSessionId?: string;
  /** Optional explicit task id — used by Claudia's task-spawner integration. */
  taskId?: string;
  /** Optional display name. */
  displayName?: string;
}

/** Stable across the runner's lifetime so we can rebroadcast the prompt. */
const taskMetaById = new Map<string, { prompt: string; displayName?: string }>();

/**
 * Create + start an SDK task. Wires up event listeners that broadcast to all
 * connected clients via the supplied `broadcast` function.
 */
export function createSdkTask(input: SdkTaskCreateInput, broadcast: Broadcast): SdkTaskRunner {
  const taskId = input.taskId || `sdk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const runner = new SdkTaskRunner({
    taskId,
    workspaceId: input.workspaceId,
    cwd: input.cwd,
    prompt: input.prompt,
    systemPrompt: input.systemPrompt,
    permissionMode: input.permissionMode,
    allowedTools: input.allowedTools,
    disallowedTools: input.disallowedTools,
    model: input.model,
    resumeSessionId: input.resumeSessionId,
  });
  taskMetaById.set(taskId, { prompt: input.prompt, displayName: input.displayName });

  // Stream conversation events to the live tail channel — same WS message
  // kind the JSONL-streamer pipeline uses, so the frontend doesn't care
  // where the event came from.
  runner.on('event', (ev: ConversationEvent) => {
    broadcast(ws('task:conversation:event', { taskId, event: ev }));
  });

  runner.on('stateChanged', () => {
    const meta = taskMetaById.get(taskId);
    broadcast(ws('task:stateChanged', { task: publicTaskFor(runner, meta?.prompt ?? input.prompt, meta?.displayName) }));
  });

  runner.on('sessionCaptured', (sessionId: string) => {
    logger.info('SDK task captured session', { taskId, sessionId });
    const meta = taskMetaById.get(taskId);
    // Re-broadcast a stateChanged so the frontend sees the new sessionId.
    broadcast(ws('task:stateChanged', { task: publicTaskFor(runner, meta?.prompt ?? input.prompt, meta?.displayName) }));
  });

  runner.on('permissionRequest', (summary: PendingRequestSummary) => {
    // Two channels:
    //   1. `task:waitingInput` — the existing kind the frontend already
    //      understands; surfaces the task in the "waiting" UI state.
    //      Send recentOutput as a short summary so the legacy
    //      WaitingInputBanner has something to display (it tries to
    //      stripAnsi() the field; undefined would crash older clients).
    //   2. `sdk:permission:request` — the rich payload with toolName + input
    //      the new permission dialog will read.
    const inputStr = JSON.stringify(summary.input).slice(0, 400);
    broadcast(
      ws('task:waitingInput', {
        taskId,
        inputType: 'permission',
        recentOutput: `Tool ${summary.toolName} requested. Input: ${inputStr}`,
      }),
    );
    broadcast(ws('sdk:permission:request', summary));
  });

  runner.on('permissionResolved', (requestId: string) => {
    broadcast(ws('sdk:permission:resolved', { taskId, requestId }));
  });

  runner.on('complete', (result: SdkRunResultSummary) => {
    broadcast(ws('sdk:task:complete', { taskId, result }));
  });

  runner.on('aborted', () => {
    broadcast(ws('task:stopped', { taskId, reason: 'aborted' }));
  });

  runner.on('error', (err: Error) => {
    logger.error('SDK task runner errored', { taskId, error: err.message });
    broadcast(ws('error', { taskId, message: err.message, source: 'sdk-task-runner' }));
  });

  sdkTaskRegistry.register(runner);

  // Broadcast initial creation BEFORE start so the UI gets the task in
  // "starting" state, then the SDK kicks events.
  broadcast(ws('task:created', { task: publicTaskFor(runner, input.prompt, input.displayName), source: 'sdk' }));

  // Fire-and-forget — start() returns once the SDK has been kicked off, but
  // the run loop continues in the background driving events.
  runner.start().catch((err) => {
    logger.error('SDK task start failed', { taskId, error: err instanceof Error ? err.message : String(err) });
  });

  return runner;
}

/**
 * Mount REST endpoints for SDK tasks. Convenience for callers that prefer
 * HTTP over WS — the test-cli uses this.
 */
export function attachSdkTaskRoutes(app: Express, broadcast: Broadcast): void {
  // Create an SDK task. Body: SdkTaskCreateInput.
  app.post('/api/sdk-tasks', (req: Request, res: Response) => {
    try {
      const body = req.body as SdkTaskCreateInput;
      if (!body || typeof body.prompt !== 'string' || typeof body.cwd !== 'string') {
        return res.status(400).json({ error: 'prompt and cwd are required' });
      }
      const runner = createSdkTask(body, broadcast);
      const meta = taskMetaById.get(runner.taskId);
      res.status(201).json({ task: publicTaskFor(runner, meta?.prompt ?? body.prompt, meta?.displayName) });
    } catch (err) {
      const e = err as Error;
      logger.error('POST /api/sdk-tasks failed', { error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  // Continue an existing SDK task with a follow-up prompt.
  app.post('/api/sdk-tasks/:id/continue', async (req: Request, res: Response) => {
    const id = req.params.id;
    const runner = sdkTaskRegistry.get(id);
    if (!runner) return res.status(404).json({ error: 'task not found' });
    const prompt = (req.body as { prompt?: string })?.prompt;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    try {
      taskMetaById.set(id, { ...(taskMetaById.get(id) ?? { prompt: '' }), prompt });
      await runner.continueWith(prompt);
      res.json({ ok: true });
    } catch (err) {
      const e = err as Error;
      res.status(400).json({ error: e.message });
    }
  });

  // Abort the in-progress run.
  app.post('/api/sdk-tasks/:id/abort', async (req: Request, res: Response) => {
    const id = req.params.id;
    const runner = sdkTaskRegistry.get(id);
    if (!runner) return res.status(404).json({ error: 'task not found' });
    await runner.abort();
    res.json({ ok: true });
  });

  // Resolve a pending permission request.
  // Body: ClientPermissionResponse.
  app.post('/api/sdk-tasks/:id/permission/:requestId', (req: Request, res: Response) => {
    const { id, requestId } = req.params;
    const body = req.body as ClientPermissionResponse;
    if (!body || typeof body.allow !== 'boolean') {
      return res.status(400).json({ error: 'allow boolean required' });
    }
    if (!sdkTaskRegistry.has(id)) {
      return res.status(404).json({ error: 'task not found' });
    }
    const ok = sdkPermissionBroker.resolveDecision(requestId, body);
    if (!ok) return res.status(404).json({ error: 'permission request not found' });
    res.json({ ok: true });
  });

  // List active SDK tasks (debug / mobile).
  app.get('/api/sdk-tasks', (_req: Request, res: Response) => {
    res.json({
      tasks: sdkTaskRegistry.list().map((r) => {
        const meta = taskMetaById.get(r.taskId);
        return publicTaskFor(r, meta?.prompt ?? '', meta?.displayName);
      }),
    });
  });

  // Get conversation snapshot for a task (cold reconnect).
  app.get('/api/sdk-tasks/:id/snapshot', (req: Request, res: Response) => {
    const r = sdkTaskRegistry.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'task not found' });
    res.json({
      task: publicTaskFor(r, taskMetaById.get(r.taskId)?.prompt ?? ''),
      events: r.getSnapshot(),
      pendingPermissions: sdkPermissionBroker.listForTask(r.taskId),
    });
  });

  // List pending permission requests across all SDK tasks (debug).
  app.get('/api/sdk-tasks/:id/permissions', (req: Request, res: Response) => {
    if (!sdkTaskRegistry.has(req.params.id)) {
      return res.status(404).json({ error: 'task not found' });
    }
    res.json({ pending: sdkPermissionBroker.listForTask(req.params.id) });
  });

  // Quick file search for the @-mention picker. Walks the workspace tree up
  // to a soft limit and returns paths matching the query. Designed to be
  // fast enough to fire on every keystroke; not a full code-search engine.
  app.get('/api/sdk-tasks/file-search', async (req: Request, res: Response) => {
    const cwd = (req.query.cwd as string | undefined) || '';
    const q = ((req.query.q as string | undefined) || '').toLowerCase();
    if (!cwd) return res.status(400).json({ error: 'cwd required' });
    try {
      const matches = await searchFiles(cwd, q, 50);
      res.json({ files: matches });
    } catch (err) {
      const e = err as Error;
      res.status(500).json({ error: e.message });
    }
  });
}

/**
 * Send a reconnecting client the current state of all SDK tasks: the
 * conversation snapshot for each + any pending permission requests so they
 * can rebuild the dialog state.
 */
export function seedReconnectingClient(send: (msg: WSMessage) => void): void {
  for (const r of sdkTaskRegistry.list()) {
    const meta = taskMetaById.get(r.taskId);
    send(ws('task:conversation:restore', { taskId: r.taskId, events: r.getSnapshot() }));
    send(ws('task:stateChanged', { task: publicTaskFor(r, meta?.prompt ?? '', meta?.displayName) }));
    const pending = sdkPermissionBroker.listForTask(r.taskId);
    for (const p of pending) {
      send(ws('sdk:permission:request', p));
    }
  }
}

// ───────────────────── file search (for @-mention picker) ─────────────────────

import * as path from 'path';
import { promises as fsp } from 'fs';

interface FileMatch {
  path: string;
  modifiedAt: string;
}

/**
 * Walk a workspace directory and return up to `limit` files whose path
 * contains `query`. Skips common heavy dirs (node_modules, .git, dist, …).
 *
 * Intentionally simple — no fuzzy match, no relevance ranking, no caching.
 * Phase 6 polish; we can swap in a real search backend later.
 */
async function searchFiles(root: string, query: string, limit: number): Promise<FileMatch[]> {
  const out: FileMatch[] = [];
  const SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    '.next',
    'dist',
    'build',
    'out',
    '.turbo',
    '.cache',
    '.pnpm-store',
    'coverage',
  ]);
  const MAX_VISITED = 5000; // total files inspected, not returned
  let visited = 0;

  async function walk(dir: string): Promise<void> {
    if (out.length >= limit || visited >= MAX_VISITED) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit || visited >= MAX_VISITED) return;
      if (e.name.startsWith('.') && e.name !== '.claude') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(full);
      } else if (e.isFile()) {
        visited++;
        const rel = path.relative(root, full);
        if (!query || rel.toLowerCase().includes(query)) {
          try {
            const stat = await fsp.stat(full);
            out.push({ path: rel, modifiedAt: stat.mtime.toISOString() });
          } catch {
            out.push({ path: rel, modifiedAt: '' });
          }
        }
      }
    }
  }

  await walk(root);
  // Sort: exact-prefix matches first, then by modifiedAt desc.
  out.sort((a, b) => {
    const aStarts = a.path.toLowerCase().startsWith(query) ? 0 : 1;
    const bStarts = b.path.toLowerCase().startsWith(query) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    return b.modifiedAt.localeCompare(a.modifiedAt);
  });
  return out.slice(0, limit);
}
