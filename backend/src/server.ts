import express from 'express';
import { createServer, request as httpRequest } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import os from 'os';
import { spawn, ChildProcess } from 'child_process';
import { spawn as ptySpawn, IPty } from 'node-pty';
import {
  writeFileSync,
  existsSync,
  readFileSync,
  mkdirSync,
  unlinkSync,
  readdirSync,
  statSync,
  rmdirSync,
} from 'fs';
import { readFile, readdir } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { TaskSpawner } from './task-spawner.js';
import { WorkspaceStore } from './workspace-store.js';
import { ConfigStore } from './config-store.js';
import { getConversationHistory, getWorkspaceSessions, parseConversationEvents } from './conversation-parser.js';
import { setUserId } from './usage-reporter.js';
import {
  Task,
  TaskState,
  Workspace,
  WorkspaceReference,
  WSMessage,
  WSMessageType,
  WSErrorPayload,
  WaitingInputType,
  ScheduledTask,
  PORTS,
  TaskTokenUsage,
  UsageDashboardData,
} from '@claudia/shared';
import { CronScheduler, validateCronExpression, describeCronExpression } from './cron-scheduler.js';
import { UsageStore } from './usage-store.js';
import { CheckpointStore } from './checkpoint-store.js';
import { validateConfigUpdate, validateWorkspacePath } from './validation.js';
import { isGitRepo, getDefaultBranch, getCurrentBranch, checkoutBranch } from './git-utils.js';
import { LearningsStore } from './learnings-store.js';
import { TunnelManager } from './tunnel-manager.js';
import { getMobilePageHtml } from './mobile-page.js';
import { registerDevice, unregisterDevice, listDevices, sendPush } from './mobile-push.js';
import { generateMobileSummary, buildSimulatedSummary } from './task-summary.js';
import { MobileChatStore } from './mobile-chat-store.js';
import { MobileAgent } from './mobile-agent.js';
import { ConversationStreamer } from './conversation-streamer.js';
import { attachSdkTaskRoutes, seedReconnectingClient as seedSdkClient } from './sdk-task-server.js';
// import { ElevenLabsTTS } from './elevenlabs-tts.js'; // TODO: Implement ElevenLabs TTS
import { createLogger } from './logger.js';
import { PluginManager, PluginContext } from './plugin-system/index.js';

// Note: Route modules available in ./routes/ for reference and future refactoring
// - config-routes.ts: Config API routes template
// - task-routes.ts: Task REST API routes template
// - ws-handlers.ts: WebSocket handlers template

const logger = createLogger('[Server]');

// ES module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Valid WebSocket message types for validation
const VALID_WS_MESSAGE_TYPES = new Set([
  'task:create',
  'task:select',
  'task:input',
  'task:resize',
  'task:destroy',
  'task:stop',
  'task:stopAll',
  'task:interrupt',
  'task:archive',
  'task:reconnect',
  'task:revert',
  'task:restore',
  'task:rename',
  'task:reorder',
  'task:archived:list',
  'task:archived:restore',
  'task:archived:continue',
  'task:archived:delete',
  'workspace:create',
  'workspace:delete',
  'workspace:reorder',
  'workspace:setOrder',
  'workspace:rename',
  'workspace:browseFolder',
  'workspace:openFolder',
  'workspace:openTerminal',
  'workspace:systemPrompt:get',
  'workspace:systemPrompt:set',
  'workspace:references:add',
  'workspace:references:remove',
  'workspace:references:toggle',
  'workspace:previewPort:set',
  'workspace:recent:list',
  'workspace:recent:clear',
  'workspace:reset',
  'shell:create',
  'shell:input',
  'shell:resize',
  'shell:close',
  'git:push',
  'task:disconnect',
  'task:clear',
  'tunnel:status',
  'cron:create',
  'cron:delete',
  'cron:update',
  'cron:list',
  'cron:run',
  'usage:get',
  'usage:clear',
  'checkpoint:create',
  'checkpoint:list',
  'checkpoint:restore',
  'checkpoint:restore-selective',
  'checkpoint:restore-force',
  'checkpoint:delete',
  'checkpoint:fork',
]);

// WebSocket message validation
interface WSClientMessage {
  type: string;
  payload?: Record<string, unknown>;
}

function isValidWSMessage(data: unknown): data is WSClientMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (typeof msg.type !== 'string') return false;
  if (!VALID_WS_MESSAGE_TYPES.has(msg.type)) return false;
  if (msg.payload !== undefined && (typeof msg.payload !== 'object' || msg.payload === null))
    return false;
  return true;
}

/**
 * Send an error response to a WebSocket client
 */
function sendWSError(ws: WebSocket, message: string, originalType?: string, code?: string): void {
  const errorPayload: WSErrorPayload = { message, originalType, code };
  ws.send(
    JSON.stringify({
      type: 'error' as WSMessageType,
      payload: errorPayload,
    }),
  );
}

/**
 * Build system prompt context for workspace references.
 * Tells Claude about referenced directories so it can read files from them.
 */
function buildReferenceContext(references: WorkspaceReference[]): string {
  const lines = [
    'You have access to the following reference directories. Use them as examples or context when relevant to the task. You can read files from these directories using their absolute paths.',
    '',
  ];
  for (const ref of references) {
    lines.push(`## Reference: "${ref.name}" (${ref.path})`);
    if (ref.description) {
      lines.push(ref.description);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

/**
 * Strip ANSI escape sequences from a string (for pattern detection in PTY output).
 */
function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[PX^_].*?\x1b\\/g, '')
    .replace(/\x1b\[\?[0-9;]*[hl]/g, '')
    .replace(/\x1b[>=]/g, '');
}

/**
 * Filter context update injections from terminal output data.
 * Handles ANSI escape sequences by stripping them for detection,
 * then removing the matched region from the raw data.
 */
function filterContextUpdateFromOutput(data: string): string {
  const clean = stripAnsi(data);
  // Quick check: does the stripped text contain the pattern at all?
  if (!clean.includes('CONTEXT UPDATE:') && !clean.includes('acknowledge this update briefly')) {
    return data;
  }

  // Try direct regex on raw data first (works when ANSI codes aren't interspersed within the text)
  let filtered = data
    .replace(/\[CONTEXT UPDATE:[^\]]*\]/g, '')
    .replace(/ ?acknowledge this update briefly\r?/g, '');
  if (filtered !== data) {
    return filtered;
  }

  // Fallback: ANSI codes are interspersed within the context update text.
  // Build a mapping from clean-text positions to raw-data positions,
  // find the pattern in clean text, and remove the corresponding raw region.
  const mapping: number[] = []; // mapping[cleanIdx] = rawIdx
  const ci = 0;
  const ansiPattern =
    /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[PX^_].*?\x1b\\|\x1b\[\?[0-9;]*[hl]|\x1b[>=]/g;
  const lastRaw = 0;
  let match: RegExpExecArray | null;
  // Identify which raw positions correspond to visible characters
  const rawToClean = new Array(data.length).fill(-1);
  let rawIdx = 0;
  let cleanIdx = 0;
  while (rawIdx < data.length) {
    // Check if current position starts an ANSI sequence
    ansiPattern.lastIndex = rawIdx;
    match = ansiPattern.exec(data);
    if (match && match.index === rawIdx) {
      // Skip ANSI sequence
      rawIdx += match[0].length;
    } else {
      rawToClean[rawIdx] = cleanIdx;
      mapping.push(rawIdx);
      cleanIdx++;
      rawIdx++;
    }
  }

  // Find context update pattern in clean text
  const ctxMatch = clean.match(/\[CONTEXT UPDATE:[^\]]*\]/);
  if (ctxMatch && ctxMatch.index !== undefined) {
    const startClean = ctxMatch.index;
    const endClean = startClean + ctxMatch[0].length;
    const startRaw = mapping[startClean];
    // endRaw: the raw position AFTER the last matched clean char
    const endRaw = endClean < mapping.length ? mapping[endClean] : data.length;
    filtered = data.slice(0, startRaw) + data.slice(endRaw);
    // Also strip "acknowledge this update briefly" from the result
    filtered = filtered.replace(/ ?acknowledge this update briefly\r?/g, '');
    return filtered;
  }

  // Also handle just the acknowledge portion
  filtered = data;
  const ackClean = clean.match(/ ?acknowledge this update briefly\r?/);
  if (ackClean && ackClean.index !== undefined) {
    const startClean = ackClean.index;
    const endClean = startClean + ackClean[0].length;
    const startRaw = mapping[startClean];
    const endRaw = endClean < mapping.length ? mapping[endClean] : data.length;
    filtered = data.slice(0, startRaw) + data.slice(endRaw);
  }
  return filtered;
}

// Tracks tasks with a context-update write in-flight, so the output handler
// can start buffering BEFORE the echo arrives (handles arbitrary chunk splits).
const ctxUpdateInFlight = new Set<string>();

// Tracks INLINE context-update injections (context prefix prepended to the user's
// own message). Unlike standalone injections (e.g. workspace ref updates which end
// with "acknowledge this update briefly\r"), inline injections produce a PTY echo
// whose cursor-movement sequences are too complex to surgically filter — the
// result is garbled display. Instead we discard the entire input-echo buffer for
// inline injections; Claude Code's response comes through cleanly afterwards.
const ctxInlineInFlight = new Set<string>();

// Buffer for terminal keystrokes per task (for auto-checkpoint on Enter)
const terminalInputBuffer = new Map<string, string>();

/**
 * Notify running tasks in a workspace that references have changed.
 * - Idle tasks: immediately receive a context update message
 * - Busy/other tasks: flagged for notification when they next become idle
 */
function notifyTasksOfReferenceChange(
  workspaceId: string,
  taskSpawner: InstanceType<typeof import('./task-spawner.js').TaskSpawner>,
  workspaceStore: InstanceType<typeof import('./workspace-store.js').WorkspaceStore>,
): void {
  const tasks = taskSpawner.getActiveTasksForWorkspace(workspaceId);
  if (tasks.length === 0) return;

  const currentRefs = workspaceStore.getReferences(workspaceId);
  const validRefs = currentRefs.filter((r) => existsSync(r.path));
  const currentRefKey = validRefs
    .map((r) => r.id)
    .sort()
    .join(',');

  for (const task of tasks) {
    // Skip tasks that already have the current ref key (no change for them)
    if (currentRefKey === (task.lastRefKey ?? '')) continue;

    if (task.state === 'idle') {
      // Idle tasks: send context update immediately
      if (validRefs.length > 0) {
        const refList = validRefs
          .map((r) => {
            let s = `"${r.name}" (${r.path})`;
            if (r.description) s += ` - ${r.description}`;
            return s;
          })
          .join('; ');
        const msg = `[CONTEXT UPDATE: Workspace references updated. Available reference directories (read files using absolute paths): ${refList}] acknowledge this update briefly\r`;
        ctxUpdateInFlight.add(task.id);
        taskSpawner.writeToTask(task.id, msg);
      } else {
        const msg = `[CONTEXT UPDATE: All workspace references have been removed.] acknowledge this update briefly\r`;
        ctxUpdateInFlight.add(task.id);
        taskSpawner.writeToTask(task.id, msg);
      }
      task.lastRefKey = currentRefKey;
      task.pendingRefNotification = false;
      logger.info('Sent immediate reference update to idle task', {
        taskId: task.id,
        refCount: validRefs.length,
      });
    } else {
      // Busy/starting/waiting_input tasks: flag for delivery when idle
      task.pendingRefNotification = true;
      logger.info('Queued reference update for busy task', { taskId: task.id, state: task.state });
    }
  }
}

/**
 * Build the context update message for an MCP server config change.
 */
function buildMcpChangeMessage(
  configStore: InstanceType<typeof import('./config-store.js').ConfigStore>,
): { msg: string; serverNames: string[] } {
  const mcpServers = configStore.getMCPServers() || [];
  const enabledServers = mcpServers.filter((s) => s.enabled);
  const serverNames = enabledServers.map((s) => s.name);

  const msg =
    serverNames.length > 0
      ? `[CONTEXT UPDATE: MCP server configuration has changed. Currently enabled MCP servers: ${serverNames.join(', ')}. New MCP tools are available via the updated .mcp.json in your workspace. You may need to use /mcp to reload MCP servers to pick up the changes.] acknowledge this update briefly\r`
      : `[CONTEXT UPDATE: All MCP servers have been disabled or removed. The .mcp.json in your workspace has been updated.] acknowledge this update briefly\r`;

  return { msg, serverNames };
}

/**
 * Notify all running tasks that MCP server configuration has changed.
 * - Idle tasks: immediately receive a context update message
 * - Busy/other tasks: flagged for notification when they next become idle
 */
function notifyTasksOfMcpChange(
  taskSpawner: InstanceType<typeof import('./task-spawner.js').TaskSpawner>,
  configStore: InstanceType<typeof import('./config-store.js').ConfigStore>,
): void {
  const tasks = taskSpawner.getAllActiveTasks();
  if (tasks.length === 0) return;

  const { msg, serverNames } = buildMcpChangeMessage(configStore);

  for (const task of tasks) {
    if (task.state === 'idle') {
      ctxUpdateInFlight.add(task.id);
      taskSpawner.writeToTask(task.id, msg);
      task.pendingMcpNotification = false;
      logger.info('Sent immediate MCP config update to idle task', {
        taskId: task.id,
        servers: serverNames,
      });
    } else {
      task.pendingMcpNotification = true;
      logger.info('Queued MCP config update for busy task', { taskId: task.id, state: task.state });
    }
  }
}

export async function createApp(basePath?: string) {
  const app = express();
  const server = createServer(app);
  // Use noServer mode so we can manually route WebSocket upgrade requests.
  // This is critical for tunnel access: Vite HMR WebSocket connections need
  // to be proxied to the Vite dev server, not handled by our app's WSS.
  const wss = new WebSocketServer({ noServer: true });

  // Middleware
  // Restrict CORS to localhost and active tunnel origins
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (same-origin, curl, native apps)
        if (!origin) return callback(null, true);
        try {
          const url = new URL(origin);
          if (
            url.hostname === 'localhost' ||
            url.hostname === '127.0.0.1' ||
            url.hostname === '::1'
          ) {
            return callback(null, true);
          }
          if (isTunnelHost(url.hostname)) {
            return callback(null, true);
          }
        } catch {
          /* invalid origin */
        }
        callback(new Error('CORS: origin not allowed'));
      },
    }),
  );
  app.use(express.json({ limit: '50mb' })); // Increased limit for large AI requests

  // TunnelManager for mobile remote access (ngrok-based, created early for middleware use)
  const tunnelManager = new TunnelManager(PORTS.BACKEND);
  logger.info('TunnelManager created (ngrok)');
  // Auto-recover any orphaned ngrok left by a previous server instance (tsx watch restart).
  // Fire-and-forget: completes quickly (2 s timeout) well before any client connects.
  tunnelManager
    .autoRecover()
    .catch((err) =>
      logger.warn('Tunnel auto-recover failed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    );

  // ===== Tunnel → React Frontend Proxy =====
  // When accessed through the tunnel, proxy non-API requests to the Vite
  // dev server (development) or fall through to the static server (production).
  // Instead of relying on env vars, we try Vite first and fall back to static
  // if Vite isn't running (connection refused = production mode).

  function isTunnelHost(host: string): boolean {
    return (
      host.includes('.loca.lt') ||
      host.includes('localtunnel') ||
      host.includes('.ngrok-free.app') ||
      host.includes('.ngrok.io') ||
      host.includes('ngrok')
    );
  }

  app.use((req, res, next) => {
    const host = req.headers.host || '';
    if (!isTunnelHost(host)) {
      return next();
    }

    // Tunnel visitor at root: redirect with the current token if missing or stale.
    // This handles server restarts (tsx watch) where the token changes — mobile
    // browsers that still have the old URL/token get seamlessly refreshed.
    if (req.path === '/') {
      const status = tunnelManager.getStatus();
      if (status.active && status.token) {
        const requestToken = req.query.token as string | undefined;
        if (!requestToken || !tunnelManager.validateToken(requestToken)) {
          logger.info('Tunnel visitor at root with missing/stale token, redirecting', { host });
          return res.redirect(`/?token=${status.token}`);
        }
      }
    }

    // Let API routes pass through
    if (req.path.startsWith('/api/')) {
      return next();
    }

    // Let /assets/ requests fall through to static file server directly.
    // These are hashed production build files that Vite dev server won't
    // know about — proxying them to Vite results in HTML error pages
    // being served with wrong MIME types (causing white-screen on mobile).
    if (req.path.startsWith('/assets/')) {
      return next();
    }

    // Try proxying to the Vite dev server first. If Vite isn't running
    // (production), the connection is refused and we fall through to the
    // static file server registered later in the middleware chain.
    const proxyReq = httpRequest(
      {
        hostname: 'localhost',
        port: PORTS.FRONTEND,
        path: req.originalUrl,
        method: req.method,
        headers: { ...req.headers, host: `localhost:${PORTS.FRONTEND}` },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on('error', (err) => {
      // Connection refused → Vite not running → fall through to static files
      if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
        logger.info('Vite dev server not running, falling through to static files', {
          path: req.path,
        });
        return next();
      }
      logger.error('Vite proxy error', { error: err.message, path: req.path });
      res.status(502).send('Frontend proxy error');
    });
    req.pipe(proxyReq);
  });

  // Initialize configStore first to determine API mode
  const configStore = new ConfigStore(basePath);

  // Initialize Plugin System
  logger.info('Initializing plugin system...');
  const pluginContext: PluginContext = {
    configStore,
    logger: createLogger('[Plugin]'),
    express,
    utils: { spawn, fetch },
  };

  const pluginManager = new PluginManager(pluginContext);

  // Discover and load plugins from backend/plugins directory
  const pluginsDir = join(__dirname, '..', 'plugins');
  await pluginManager.discoverPlugins(pluginsDir);

  // Initialize LLM service with config store so it can use the correct model
  const { initializeLLMService } = await import('./llm-service.js');
  initializeLLMService(configStore);

  // Register plugin routes (handles both SAP AI Core and HAI Proxy)
  pluginManager.registerRoutes(app);

  // Initialize remaining services
  const persistencePath = basePath ? join(basePath, 'tasks.json') : undefined;
  const taskSpawner = new TaskSpawner(persistencePath, true, configStore);
  const workspaceStore = new WorkspaceStore(basePath);
  // LearningsStore for RAG-based learnings
  const learningsStore = new LearningsStore(basePath, configStore);

  // Mobile companion: per-workspace chat transcript + agent
  const mobileChatStore = new MobileChatStore(basePath);
  const mobileAgent = new MobileAgent({
    taskSpawner,
    workspaceStore,
    chatStore: mobileChatStore,
  });

  // CronScheduler for scheduled/recurring prompts
  const cronScheduler = new CronScheduler(
    // Fire callback: send prompt to task PTY
    (taskId: string, prompt: string, scheduledTaskId: string) => {
      logger.info('Cron firing prompt to task', {
        taskId,
        scheduledTaskId,
        prompt: prompt.substring(0, 80),
      });
      taskSpawner.writeToTask(taskId, prompt + '\r');
      broadcast({
        type: 'cron:fired' as WSMessageType,
        payload: { scheduledTaskId, taskId, prompt },
      });
    },
    // Task state checker - must check both live and disconnected tasks
    (taskId: string) => {
      const internal = taskSpawner.getTask(taskId);
      if (internal) {
        if (internal.state === 'exited' || internal.state === 'archived') return 'exited';
        if (internal.state === 'idle') return 'idle';
        return 'busy';
      }
      // Check disconnected tasks - they're still valid targets for scheduling
      const found = taskSpawner.getAllTasks().find((t) => t.id === taskId);
      if (!found) return 'unknown';
      if (found.state === 'exited' || found.state === 'archived') return 'exited';
      // Disconnected/interrupted tasks should be treated as idle for scheduling
      // so the cron fires immediately, which triggers auto-reconnect via writeToTask
      if (found.state === 'disconnected' || found.state === 'interrupted') return 'idle';
      return 'busy';
    },
  );
  cronScheduler.start();

  // Usage and Checkpoint stores
  const usageStore = new UsageStore(basePath);
  const checkpointStore = new CheckpointStore(basePath);

  // Wire up tunnel events for broadcasting
  tunnelManager.on('tunnel:ready', (data: { url: string; token: string }) => {
    logger.info('Tunnel ready, broadcasting status', { url: data.url });
    broadcast({ type: 'tunnel:status' as WSMessageType, payload: tunnelManager.getStatus() });
  });
  tunnelManager.on('tunnel:error', (error: string) => {
    logger.error('Tunnel error', { error });
    broadcast({
      type: 'tunnel:status' as WSMessageType,
      payload: { ...tunnelManager.getStatus(), error },
    });
  });
  tunnelManager.on('tunnel:closed', () => {
    logger.info('Tunnel closed, broadcasting status');
    broadcast({ type: 'tunnel:status' as WSMessageType, payload: tunnelManager.getStatus() });
  });

  // Helper to extract rules from CLAUDE.md (reverse sync) - async version
  async function extractRulesFromClaudeMd(workspacePath: string): Promise<string | null> {
    const claudeMdPath = join(workspacePath, 'CLAUDE.md');
    const marker = '<!-- CODEUI-RULES -->';
    const endMarker = '<!-- /CODEUI-RULES -->';

    if (!existsSync(claudeMdPath)) {
      return null;
    }

    try {
      const content = await readFile(claudeMdPath, 'utf-8');
      const startIdx = content.indexOf(marker);
      const endIdx = content.indexOf(endMarker);

      if (startIdx === -1 || endIdx === -1) {
        return null;
      }

      // Extract content between markers, removing the "## Custom Rules" header
      const rulesContent = content.slice(startIdx + marker.length, endIdx);
      const lines = rulesContent.split('\n');

      // Filter out the "## Custom Rules" header and leading/trailing empty lines
      const filteredLines = lines.filter((line) => {
        const trimmed = line.trim();
        if (trimmed === '## Custom Rules') return false;
        return true;
      });

      return filteredLines.join('\n').trim();
    } catch (error) {
      console.error(`[Server] Error reading CLAUDE.md from ${workspacePath}:`, error);
      return null;
    }
  }

  // On startup, sync rules FROM CLAUDE.md if config.rules is empty
  (async function initRulesFromClaudeMd() {
    try {
      const config = configStore.getConfig();
      if (!config.rules) {
        const workspaces = workspaceStore.getWorkspaces();
        for (const workspace of workspaces) {
          const rules = await extractRulesFromClaudeMd(workspace.id);
          if (rules) {
            console.log(
              `[Server] Found existing rules in ${workspace.id}/CLAUDE.md, syncing to config`,
            );
            configStore.updateConfig({ rules });
            break; // Use rules from first workspace that has them
          }
        }
      }
    } catch (error) {
      logger.error('Failed to initialize rules from CLAUDE.md', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  // On startup, sync MCP config files to all workspaces
  // This ensures .mcp.json and .claude/settings.local.json are always up-to-date
  // (prevents stale files from overriding global config, e.g. missing headers for HTTP servers)
  try {
    const workspaces = workspaceStore.getWorkspaces();
    if (workspaces.length > 0) {
      const workspaceIds = workspaces.map((w) => w.id);
      taskSpawner.syncWorkspaceMcpConfigs(workspaceIds);
      logger.info('Synced MCP config to all workspaces on startup', { count: workspaceIds.length });
    }
  } catch (error) {
    logger.error('Failed to sync MCP configs on startup', { error });
  }

  // Track connected clients with their alive status for heartbeat
  const clients = new Set<WebSocket>();
  const voiceClients = new Set<WebSocket>(); // Voice clients - don't send task:output
  const clientAliveMap = new WeakMap<WebSocket, boolean>();

  // Heartbeat interval to keep WebSocket connections alive
  const HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds
  // Track missed pongs - only terminate after multiple missed heartbeats
  const clientMissedPongs = new WeakMap<WebSocket, number>();

  const heartbeatInterval = setInterval(() => {
    for (const client of clients) {
      if (clientAliveMap.get(client) === false) {
        // Client didn't respond to last ping
        const missed = (clientMissedPongs.get(client) || 0) + 1;
        clientMissedPongs.set(client, missed);
        console.log(`[Server] Client missed heartbeat (${missed}/3)`);

        if (missed >= 3) {
          // Only terminate after 3 missed pongs (90 seconds of no response)
          console.log('[Server] Client failed 3 heartbeats, terminating connection');
          client.terminate();
          clients.delete(client);
          continue;
        }
      } else {
        // Reset missed count on successful pong
        clientMissedPongs.set(client, 0);
      }
      // Mark as not alive, will be set to true when pong received
      clientAliveMap.set(client, false);
      client.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Batched broadcast state - accumulate state changes and send periodically
  const BROADCAST_BATCH_INTERVAL_MS = 150; // Batch broadcasts every 150ms
  const pendingTaskStateChanges: Map<string, Task> = new Map();
  let pendingTasksUpdated = false;
  let batchBroadcastTimer: NodeJS.Timeout | null = null;

  // Broadcast to all connected clients
  function broadcast(message: WSMessage): void {
    const data = JSON.stringify(message);
    const isTaskOutput = message.type === 'task:output';
    for (const client of clients) {
      try {
        if (client.readyState === WebSocket.OPEN) {
          if (isTaskOutput && voiceClients.has(client)) continue;
          client.send(data);
        }
      } catch (err) {
        console.error('[Server] Error sending to client:', err);
        clients.delete(client);
      }
    }
  }

  // ── SDK task path (Claude Agent SDK, no PTY) ──
  // Mounted right after broadcast() is defined so routes can broadcast to all
  // connected clients. Lives alongside the existing TaskSpawner — does NOT
  // replace it. SDK tasks emit the same `task:conversation:event` /
  // `task:stateChanged` etc. WS kinds the frontend already understands, plus
  // a couple of new sdk:* kinds for permission prompts.
  attachSdkTaskRoutes(app, broadcast);

  // Flush batched broadcasts
  function flushBatchedBroadcasts(): void {
    // Send individual task state changes (deduplicated - only latest state per task)
    for (const task of pendingTaskStateChanges.values()) {
      broadcast({ type: 'task:stateChanged', payload: { task } });
    }
    pendingTaskStateChanges.clear();

    // Send tasks:updated only once if flagged
    if (pendingTasksUpdated) {
      broadcast({ type: 'tasks:updated', payload: { tasks: taskSpawner.getAllTasks() } });
      pendingTasksUpdated = false;
    }

    batchBroadcastTimer = null;
  }

  // Schedule a batched broadcast
  function scheduleBatchedBroadcast(): void {
    if (!batchBroadcastTimer) {
      batchBroadcastTimer = setTimeout(flushBatchedBroadcasts, BROADCAST_BATCH_INTERVAL_MS);
    }
  }

  // Track last-seen task state so we can detect transitions across batched
  // broadcast windows. Used by the mobile companion to fire `task:summary`
  // exactly once when a task settles from busy/starting/waiting_input → idle.
  const lastTaskState = new Map<string, TaskState>();

  // Queue a task state change for batched broadcast
  function queueTaskStateChange(task: Task): void {
    const prevState = lastTaskState.get(task.id);
    pendingTaskStateChanges.set(task.id, task);
    scheduleBatchedBroadcast();

    const wasActive =
      prevState === 'busy' ||
      prevState === 'starting' ||
      prevState === 'waiting_input';
    if (task.state === 'idle' && wasActive) {
      // Mobile idle summaries can be turned off in the conversation settings
      // popover. Default is on (undefined treated as true).
      const summariesEnabled =
        configStore.getConfig().mobileSummariesEnabled !== false;
      if (summariesEnabled) {
        void emitMobileTaskSummary(task).catch((err) =>
          console.error('[mobile-push] summary emit failed:', err),
        );
      }
    }
    lastTaskState.set(task.id, task.state);
  }

  async function emitMobileTaskSummary(task: Task): Promise<void> {
    // New mobile chat path: have the per-workspace agent generate a chat-style
    // summary message + dynamic quick actions. The store appends durably; we
    // broadcast over WS so any paired devices update immediately.
    let chatMessage: Awaited<ReturnType<typeof mobileAgent.summarizeIdleTask>> | undefined;
    try {
      chatMessage = await mobileAgent.summarizeIdleTask(task);
      broadcast({
        type: 'chat:message' as WSMessageType,
        payload: { workspaceId: task.workspaceId, message: chatMessage },
      });
    } catch (err) {
      console.error('[mobile-chat] summarizeIdleTask failed:', err);
    }

    // Legacy `task:summary` (used by the old card-based mobile UI and by any
    // other consumers) — keep emitting for back-compat. Built from the same
    // chat message when available; otherwise fall back to the old generator.
    let legacy;
    if (chatMessage) {
      legacy = {
        taskId: task.id,
        workspaceId: task.workspaceId,
        workspaceName: workspaceStore
          .getWorkspaces()
          .find((w) => w.id === task.workspaceId)?.displayName,
        taskName: task.displayName ?? task.prompt,
        state: task.state,
        summary: chatMessage.text,
        spendUsd: task.tokenUsage?.totalCostUsd,
        nextActions: chatMessage.quickActions ?? [],
        timestamp: chatMessage.createdAt,
      };
    } else {
      const ws = workspaceStore.getWorkspaces().find((w) => w.id === task.workspaceId);
      legacy = await generateMobileSummary({
        task,
        workspaceName: ws?.displayName ?? ws?.name,
        spendUsd: task.tokenUsage?.totalCostUsd,
      });
    }
    broadcast({ type: 'task:summary' as WSMessageType, payload: legacy });

    await sendPush({
      title: legacy.taskName ?? 'Task complete',
      body: legacy.summary,
      data: { kind: 'task:summary', taskId: legacy.taskId },
    });
  }

  // Queue a tasks:updated broadcast (will be deduplicated)
  function queueTasksUpdated(): void {
    pendingTasksUpdated = true;
    scheduleBatchedBroadcast();
  }

  // ===== Embedded Shell Terminal Management =====
  const isWindows = process.platform === 'win32';
  const shellProcesses: Map<string, IPty> = new Map(); // workspaceId → PTY

  function createShellTerminal(
    workspaceId: string,
    ws: WebSocket,
    cols?: number,
    rows?: number,
  ): void {
    // If shell already exists for this workspace, just notify
    if (shellProcesses.has(workspaceId)) {
      logger.info('Shell already exists for workspace, reusing', { workspaceId });
      ws.send(
        JSON.stringify({
          type: 'shell:created',
          payload: { workspaceId },
        }),
      );
      return;
    }

    const shellCmd = isWindows ? 'powershell.exe' : process.env.SHELL || '/bin/bash';

    logger.info('Creating embedded shell', { workspaceId, shell: shellCmd, cols, rows });

    const pty = ptySpawn(shellCmd, [], {
      name: 'xterm-256color',
      cols: cols || 120,
      rows: rows || 40,
      cwd: workspaceId,
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
    });

    shellProcesses.set(workspaceId, pty);

    pty.onData((data: string) => {
      // Send to all connected clients (the frontend filters by workspaceId)
      const msg = JSON.stringify({
        type: 'shell:output',
        payload: { workspaceId, data },
      });
      for (const client of clients) {
        try {
          if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
          }
        } catch (err) {
          logger.error('Error sending shell output', { error: err });
        }
      }
    });

    pty.onExit(({ exitCode, signal }) => {
      logger.info('Shell exited', { workspaceId, exitCode, signal });
      shellProcesses.delete(workspaceId);
      broadcast({
        type: 'shell:exited' as WSMessageType,
        payload: { workspaceId, exitCode, signal },
      });
    });

    ws.send(
      JSON.stringify({
        type: 'shell:created',
        payload: { workspaceId },
      }),
    );
  }

  function closeShellTerminal(workspaceId: string): void {
    const pty = shellProcesses.get(workspaceId);
    if (pty) {
      logger.info('Closing shell', { workspaceId });
      pty.kill();
      shellProcesses.delete(workspaceId);
      broadcast({
        type: 'shell:closed' as WSMessageType,
        payload: { workspaceId },
      });
    }
  }

  // Wire up TaskSpawner events
  // Note: task:created broadcast is handled directly in the task:create WS handler
  // (not here) so the source field is always correct even with concurrent creates.
  // The taskCreated event is still emitted for other listeners.
  taskSpawner.on('taskCreated', () => {
    queueTasksUpdated(); // Batched
  });

  taskSpawner.on('taskStateChanged', (task: Task) => {
    console.log(`[Server] taskStateChanged event: task=${task.id} state=${task.state}`);
    queueTaskStateChange(task); // Batched - deduplicates rapid state changes

    // Deliver pending reference notifications when a task becomes idle
    if (task.state === 'idle') {
      const internalTask = taskSpawner.getTask(task.id);
      if (internalTask?.pendingRefNotification) {
        internalTask.pendingRefNotification = false;
        const currentRefs = workspaceStore.getReferences(task.workspaceId);
        const validRefs = currentRefs.filter((r) => existsSync(r.path));
        const currentRefKey = validRefs
          .map((r) => r.id)
          .sort()
          .join(',');

        if (currentRefKey !== (internalTask.lastRefKey ?? '')) {
          if (validRefs.length > 0) {
            const refList = validRefs
              .map((r) => {
                let s = `"${r.name}" (${r.path})`;
                if (r.description) s += ` - ${r.description}`;
                return s;
              })
              .join('; ');
            const msg = `[CONTEXT UPDATE: Workspace references updated. Available reference directories (read files using absolute paths): ${refList}] acknowledge this update briefly\r`;
            ctxUpdateInFlight.add(task.id);
            taskSpawner.writeToTask(task.id, msg);
          } else {
            const msg = `[CONTEXT UPDATE: All workspace references have been removed.] acknowledge this update briefly\r`;
            ctxUpdateInFlight.add(task.id);
            taskSpawner.writeToTask(task.id, msg);
          }
          internalTask.lastRefKey = currentRefKey;
          logger.info('Delivered pending reference update to now-idle task', {
            taskId: task.id,
            refCount: validRefs.length,
          });
        }
      }

      // Deliver pending MCP config notifications when a task becomes idle
      if (internalTask?.pendingMcpNotification) {
        internalTask.pendingMcpNotification = false;
        const { msg, serverNames } = buildMcpChangeMessage(configStore);
        ctxUpdateInFlight.add(task.id);
        taskSpawner.writeToTask(task.id, msg);
        logger.info('Delivered pending MCP config update to now-idle task', {
          taskId: task.id,
          servers: serverNames,
        });
      }

      // Fire any pending scheduled prompts for this task
      cronScheduler.onTaskIdle(task.id);
    }
  });

  // Per-task buffer for filtering context update echoes that may span multiple PTY output chunks
  const ctxUpdateBuffers = new Map<
    string,
    { data: string; timer: ReturnType<typeof setTimeout> }
  >();

  // ─── Rich React conversation view: per-task streamers ────────────────────
  // The streamer emits the full ConversationEvent timeline (assistant text,
  // tool calls, tool results, thinking) for each task. Frontend renders
  // these directly with React components, bypassing xterm.js entirely.
  const convStreamers = new Map<string, ConversationStreamer>();

  function ensureConvStreamer(taskId: string): ConversationStreamer {
    let s = convStreamers.get(taskId);
    if (!s) {
      s = new ConversationStreamer({
        taskId,
        onEvent: (ev) => {
          broadcast({
            type: 'task:conversation:event' as WSMessageType,
            payload: { taskId, event: ev },
          });
        },
      });
      convStreamers.set(taskId, s);
    }
    return s;
  }

  function attachConvStreamerToSession(taskId: string, sessionId: string): void {
    const task = taskSpawner.getTask(taskId);
    if (!task) return;
    void ensureConvStreamer(taskId).attach(task.workspaceId, sessionId);
  }

  function disposeConvStreamer(taskId: string): void {
    const s = convStreamers.get(taskId);
    if (s) {
      s.dispose();
      convStreamers.delete(taskId);
    }
  }

  const stripAnsiForDetection = (s: string) =>
    s
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\x1b[PX^_].*?\x1b\\/g, '')
      .replace(/\x1b\[\?[0-9;]*[hl]/g, '')
      .replace(/\x1b[>=]/g, '');

  const contextUpdateRegex = /\[CONTEXT UPDATE:[^\]]*\]/g;
  const ackRegex = / ?acknowledge this update briefly\r?/g;

  function emitFilteredOutput(taskId: string, raw: string) {
    // Use the robust ANSI-aware filter (handles escape sequences interspersed in text)
    const filtered = filterContextUpdateFromOutput(raw);
    if (filtered) {
      broadcast({ type: 'task:output', payload: { taskId, data: filtered } });
    }
  }

  function flushCtxBuffer(taskId: string) {
    const entry = ctxUpdateBuffers.get(taskId);
    if (entry) {
      clearTimeout(entry.timer);
      ctxUpdateBuffers.delete(taskId);
      if (ctxInlineInFlight.has(taskId)) {
        // Inline injection: the echo has cursor-movement sequences interspersed
        // that survive text-only filtering and corrupt the display. Discard the
        // entire buffer — Claude's response arrives in subsequent chunks and
        // renders cleanly without any of the echo noise.
        ctxInlineInFlight.delete(taskId);
      } else {
        // Standalone injection (e.g. workspace ref / MCP config updates that
        // end with "acknowledge this update briefly\r"): filter and emit.
        emitFilteredOutput(taskId, entry.data);
      }
    }
  }

  taskSpawner.on('taskOutput', (taskId: string, data: string) => {
    const existing = ctxUpdateBuffers.get(taskId);
    const inFlight = ctxUpdateInFlight.has(taskId);

    if (existing || inFlight) {
      // Accumulating chunks for a context update (either already buffering or flag-triggered)
      if (existing) {
        clearTimeout(existing.timer);
        existing.data += data;
      } else {
        // First chunk after in-flight flag was set - start buffer
        ctxUpdateBuffers.set(taskId, {
          data,
          timer: setTimeout(() => {
            ctxUpdateInFlight.delete(taskId);
            flushCtxBuffer(taskId);
          }, 3000),
        });
      }

      const buf = ctxUpdateBuffers.get(taskId)!;
      const cleanBuf = stripAnsiForDetection(buf.data);

      // Check if we now have the complete context update pattern
      const openIdx = cleanBuf.indexOf('[CONTEXT UPDATE:');
      if (openIdx !== -1) {
        const closeIdx = cleanBuf.indexOf(']', openIdx + 16);
        if (closeIdx !== -1) {
          // Full pattern received - filter and emit
          ctxUpdateInFlight.delete(taskId);
          flushCtxBuffer(taskId);
          return;
        }
      }

      // Still waiting - reset timeout
      clearTimeout(buf.timer);
      buf.timer = setTimeout(() => {
        ctxUpdateInFlight.delete(taskId);
        flushCtxBuffer(taskId);
      }, 3000);
      return;
    }

    // Not in-flight: still check for unexpected context update echoes (safety net)
    const clean = stripAnsiForDetection(data);
    if (clean.includes('[CONTEXT UPDATE:')) {
      const openIdx = clean.indexOf('[CONTEXT UPDATE:');
      const closeIdx = clean.indexOf(']', openIdx + 16);
      if (closeIdx !== -1) {
        // Complete pattern in a single chunk - filter immediately
        emitFilteredOutput(taskId, data);
      } else {
        // Partial pattern - start buffering
        const timer = setTimeout(() => flushCtxBuffer(taskId), 3000);
        ctxUpdateBuffers.set(taskId, { data, timer });
      }
    } else {
      // No context update, pass through
      broadcast({ type: 'task:output', payload: { taskId, data } });
    }

    // Try to parse usage/token info from output for cost tracking
    const task = taskSpawner.getAllTasks().find((t) => t.id === taskId);
    if (task) {
      const lines = data.split('\n');
      for (const line of lines) {
        if (/token|input|output|cost/i.test(line)) {
          usageStore.parseAndRecord(taskId, task.workspaceId, line);
        }
      }
    }
  });

  taskSpawner.on('taskRestore', (taskId: string, history: string) => {
    broadcast({ type: 'task:restore', payload: { taskId, history } });
  });

  taskSpawner.on('taskDestroyed', (taskId: string) => {
    broadcast({ type: 'task:destroyed', payload: { taskId } });
    disposeConvStreamer(taskId);
    // Clean up any scheduled tasks for this task
    const removed = cronScheduler.removeAllForTask(taskId);
    if (removed > 0) {
      broadcast({ type: 'cron:updated' as WSMessageType, payload: { taskId, removed } });
    }
    queueTasksUpdated(); // Batched
  });

  taskSpawner.on('tasksUpdated', () => {
    queueTasksUpdated(); // Batched
  });

  taskSpawner.on(
    'taskWaitingInput',
    (taskId: string, inputType: WaitingInputType, recentOutput: string) => {
      console.log(`[Server] Task ${taskId} waiting for input: ${inputType}`);
      broadcast({
        type: 'task:waitingInput',
        payload: { taskId, inputType, recentOutput },
      });
    },
  );

  // Reconnection events - notify clients about reconnection progress
  taskSpawner.on('reconnectStart', (count: number) => {
    console.log(`[Server] Reconnection started for ${count} tasks`);
    broadcast({
      type: 'server:reconnecting' as WSMessageType,
      payload: { message: `Reconnecting ${count} task(s)...`, count },
    });
  });

  taskSpawner.on(
    'reconnectComplete',
    (result: { total: number; failed: number; failedIds: string[] }) => {
      console.log(
        `[Server] Reconnection complete: ${result.total - result.failed}/${result.total} tasks`,
      );
      // Send updated task list after reconnection (immediate, not batched - important for startup)
      broadcast({ type: 'tasks:updated', payload: { tasks: taskSpawner.getAllTasks() } });
    },
  );

  taskSpawner.on('taskTokenUsage', (taskId: string, tokenUsage: TaskTokenUsage) => {
    broadcast({ type: 'task:tokenUsage' as WSMessageType, payload: { taskId, tokenUsage } });
  });

  // When a session id is captured (or updated on reconnect), attach the
  // conversation streamer to its JSONL file so we can stream the structured
  // event timeline to the React conversation view.
  taskSpawner.on('taskSessionCaptured', (taskId: string, sessionId: string) => {
    attachConvStreamerToSession(taskId, sessionId);
  });

  // For tasks that already have a sessionId on startup (e.g. survived a tsx
  // watch reload), attach the streamer eagerly so the conversation view is
  // populated for anyone who reconnects.
  for (const t of taskSpawner.getAllTasks()) {
    if (t.sessionId) {
      attachConvStreamerToSession(t.id, t.sessionId);
    }
  }

  // ===== WebSocket Upgrade Routing =====
  // Using noServer mode so we can selectively handle upgrades.
  // Through the tunnel, Vite's HMR client also tries to connect a WebSocket
  // (because the frontend is served from the same origin). We reject those
  // non-app connections so they don't create noise or compete with the real WS.
  server.on('upgrade', (req, socket, head) => {
    const host = req.headers.host || '';
    const isTunnel =
      host.includes('.loca.lt') ||
      host.includes('localtunnel') ||
      host.includes('.ngrok-free.app') ||
      host.includes('.ngrok.io') ||
      host.includes('ngrok');
    const url = new URL(req.url || '/', `http://${host || 'localhost'}`);

    logger.info('WebSocket upgrade request', {
      url: req.url,
      host,
      isTunnel,
      hasToken: url.searchParams.has('token'),
      mobile: url.searchParams.get('mobile'),
    });

    if (isTunnel) {
      const hasToken = url.searchParams.has('token');
      const isMobile = url.searchParams.get('mobile') === '1';

      if (!hasToken && !isMobile) {
        // Vite HMR or other non-app WebSocket — silently reject.
        // HMR isn't needed through the tunnel (mobile users don't need it).
        logger.info('Tunnel WebSocket: rejecting non-app upgrade (likely Vite HMR)', {
          path: req.url,
        });
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }

      logger.info('Tunnel WebSocket: routing to app WSS');
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  // WebSocket connection handling
  wss.on('connection', async (ws: WebSocket, req) => {
    // Check for mobile token auth on query string
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const mobileToken = url.searchParams.get('token');
    const isMobile = url.searchParams.get('mobile') === '1';
    const isVoice = url.searchParams.get('voice') === '1';

    if (isMobile) {
      if (!mobileToken || !tunnelManager.validateToken(mobileToken)) {
        logger.error('Mobile WebSocket rejected: invalid token');
        ws.close(4001, 'Invalid token');
        return;
      }
      logger.info('Mobile client connected via tunnel');
    }

    console.log(
      '[Server] Client connected' + (isMobile ? ' (mobile)' : '') + (isVoice ? ' (voice)' : ''),
    );
    clients.add(ws);
    if (isVoice) {
      voiceClients.add(ws);
    }
    clientAliveMap.set(ws, true); // Mark as alive on connection

    // Handle pong responses to keep connection alive
    ws.on('pong', () => {
      clientAliveMap.set(ws, true);
    });

    // If reconnection is in progress, send a status message and wait
    if (taskSpawner.isReconnectInProgress()) {
      console.log('[Server] Reconnection in progress, notifying client...');
      ws.send(
        JSON.stringify({
          type: 'server:reconnecting',
          payload: { message: 'Reconnecting tasks...' },
        }),
      );
      // Wait for reconnection to complete before sending init
      await taskSpawner.waitForReconnect();
    }

    // Send current state to new client (after reconnection completes)
    const tasks = taskSpawner.getAllTasks();
    const workspaces = workspaceStore.getWorkspaces();
    ws.send(
      JSON.stringify({
        type: 'init',
        payload: { tasks, workspaces },
      }),
    );
    // Send tunnel status so reconnecting clients (e.g. after tsx watch restart) know
    // the tunnel is still active without waiting for a user action to trigger it.
    const tunnelStatus = tunnelManager.getStatus();
    if (tunnelStatus.active) {
      ws.send(JSON.stringify({ type: 'tunnel:status' as WSMessageType, payload: tunnelStatus }));
    }

    // Seed reconnecting clients with SDK task state (snapshots + pending
    // permission requests). Safe no-op when no SDK tasks exist.
    seedSdkClient((msg) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    });

    ws.on('message', async (data: Buffer) => {
      let messageTypeForError: string | undefined;
      try {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          logger.error('Invalid JSON in WebSocket message');
          sendWSError(ws, 'Invalid JSON format', undefined, 'INVALID_JSON');
          return;
        }

        if (!isValidWSMessage(parsed)) {
          logger.error('Invalid WebSocket message format or unknown type', { parsed });
          sendWSError(
            ws,
            'Invalid message format or unknown type',
            (parsed as Record<string, unknown>)?.type as string,
            'INVALID_MESSAGE',
          );
          return;
        }

        const message = parsed;
        messageTypeForError = message.type;
        // Only log non-frequent message types to avoid spam
        if (message.type !== 'task:input' && message.type !== 'task:resize') {
          logger.info(`Received message`, { type: message.type });
        }

        const payload = message.payload || {};

        switch (message.type) {
          case 'task:create': {
            // Create a new Claude Code CLI instance
            const { prompt, workspaceId, initialCols, initialRows, source, complexity } =
              payload as {
                prompt?: string;
                workspaceId?: string;
                initialCols?: number;
                initialRows?: number;
                source?: string;
                complexity?: string;
              };
            if (!prompt || !workspaceId) {
              logger.error('task:create requires prompt and workspaceId');
              sendWSError(
                ws,
                'task:create requires prompt and workspaceId',
                message.type,
                'MISSING_PARAMS',
              );
              return;
            }
            // Validate complexity if provided (defense in depth — MCP layer also enforces).
            if (complexity !== undefined && !['low', 'medium', 'high'].includes(complexity)) {
              logger.error('task:create rejected: invalid complexity', { complexity });
              sendWSError(
                ws,
                `Invalid complexity '${complexity}'. Expected one of: low, medium, high.`,
                message.type,
                'INVALID_COMPLEXITY',
              );
              return;
            }
            // Validate workspace path
            const workspaceValidation = validateWorkspacePath(workspaceId);
            if (!workspaceValidation.valid) {
              logger.error('Invalid workspace path', { error: workspaceValidation.error });
              sendWSError(
                ws,
                workspaceValidation.error || 'Invalid workspace path',
                message.type,
                'INVALID_WORKSPACE',
              );
              return;
            }

            // Auto-add workspace if it doesn't exist yet
            const validatedPath = workspaceValidation.data!;
            if (!workspaceStore.getWorkspace(validatedPath)) {
              try {
                const workspace = workspaceStore.addWorkspace(validatedPath);
                logger.info('Auto-added workspace for new task', { workspaceId: validatedPath });
                broadcast({ type: 'workspace:created' as WSMessageType, payload: { workspace } });
              } catch (error) {
                logger.error('Failed to auto-add workspace', { error });
                // Continue anyway - task creation shouldn't fail if workspace can't be added
              }
            }

            // Use workspace system prompt if set, otherwise fall back to global rules
            const workspaceSystemPrompt = workspaceStore.getSystemPrompt(workspaceId);
            const rules = configStore.getRules();
            let systemPrompt = workspaceSystemPrompt?.trim() || rules?.trim() || undefined;

            // Inject workspace reference context into system prompt
            const references = workspaceStore.getReferences(workspaceId);
            const validRefs = references.filter((r) => existsSync(r.path));
            if (validRefs.length > 0) {
              const refContext = buildReferenceContext(validRefs);
              systemPrompt = systemPrompt ? `${systemPrompt}\n\n${refContext}` : refContext;
              logger.info('Injected workspace references', {
                count: validRefs.length,
                names: validRefs.map((r) => r.name),
              });
            }

            logger.info(`Creating task with system prompt`, {
              hasSystemPrompt: !!systemPrompt,
              source: workspaceSystemPrompt ? 'workspace' : rules ? 'rules' : 'none',
              references: validRefs.length,
            });

            // Resolve complexity → concrete model string (undefined if disabled or omitted).
            const modelOverride = configStore.resolveModelForComplexity(
              complexity as 'low' | 'medium' | 'high' | undefined,
            );
            if (complexity && !modelOverride) {
              const cfg = configStore.getModelTiering();
              if (!cfg.enabled) {
                logger.debug('complexity ignored (model tiering disabled)', { complexity });
              } else {
                logger.warn('complexity has empty mapping; using default model', { complexity });
              }
            } else if (modelOverride) {
              logger.info('complexity → model resolved', {
                complexity,
                model: modelOverride,
                workspaceId: validatedPath,
              });
            }

            // Pass initial dimensions if provided
            try {
              const newTask = await taskSpawner.createTask(
                prompt,
                validatedPath,
                systemPrompt,
                initialCols,
                initialRows,
                modelOverride,
              );
              // Broadcast task:created to all clients (UI sidebar update).
              // Done here (not in the taskCreated event handler) so the source
              // field is always correct even with concurrent creates.
              broadcast({ type: 'task:created', payload: { task: newTask, source } });
              // Create initial checkpoint capturing state before any changes
              checkpointStore
                .createCheckpoint(newTask.id, validatedPath, 'Initial state')
                .then((cp) => {
                  logger.info('Initial checkpoint created for new task', {
                    taskId: newTask.id,
                    checkpointId: cp.id,
                  });
                  broadcast({ type: 'checkpoint:created', payload: cp });
                })
                .catch((err) => {
                  logger.warn('Failed to create initial checkpoint', {
                    taskId: newTask.id,
                    error: String(err),
                  });
                });
              // Track which references were injected so we can detect changes on follow-ups
              const internalTask = taskSpawner.getTask(newTask.id);
              if (internalTask) {
                internalTask.lastRefKey = validRefs
                  .map((r) => r.id)
                  .sort()
                  .join(',');
              }
            } catch (err) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              logger.error('Failed to create task', { error: errorMessage });
              if (errorMessage.includes('posix_spawnp')) {
                sendWSError(
                  ws,
                  'Failed to spawn process: posix_spawnp failed. This usually means node-pty is incompatible with your Node.js version. ' +
                    'If you are using Node.js v25+, run: npm install node-pty@1.2.0-beta.11 && npm install',
                  message.type,
                  'SPAWN_FAILED',
                );
              } else {
                sendWSError(
                  ws,
                  `Failed to create task: ${errorMessage}`,
                  message.type,
                  'TASK_CREATE_FAILED',
                );
              }
            }
            break;
          }

          case 'task:select': {
            // Switch active task (for terminal viewing)
            // Context injections (references, auto-title) are deferred to task:input
            // so that merely clicking a task doesn't cause Claude to act
            const { taskId } = payload as { taskId?: string };
            if (taskId) {
              try {
                taskSpawner.setTaskActive(taskId, true);
              } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger.error('Failed to activate task', { taskId, error: errorMessage });
                sendWSError(
                  ws,
                  `Failed to activate task: ${errorMessage}`,
                  message.type,
                  'TASK_SELECT_FAILED',
                );
              }
            }
            break;
          }

          case 'task:input': {
            // Send input to a task's terminal
            const { taskId, input } = payload as { taskId?: string; input?: string };
            if (!taskId || !input) break;
            // Filter out focus events (ESC [ I and ESC [ O) that confuse Claude's TUI
            // Also filter device attribute responses (DA1/DA2/DA3) that xterm.js
            // auto-generates — if echoed back they appear as garbled text
            let filteredInput = input
              .replace(/\x1b\[I/g, '') // Focus in
              .replace(/\x1b\[O/g, '') // Focus out
              .replace(/\x1b\[\?[\d;]*c/g, '') // DA1 response
              .replace(/\x1b\[>[\d;]*c/g, '') // DA2 response
              .replace(/\x1b\[=[\d;]*c/g, ''); // DA3 response
            if (filteredInput) {
              // Auto-create checkpoint on each new user input (works for active and disconnected tasks)
              const endsWithEnterForCp =
                filteredInput.endsWith('\r') || filteredInput.endsWith('\n');
              if (filteredInput.length > 1 && endsWithEnterForCp) {
                // Full message sent at once (e.g. from TaskInputBar)
                const cpWorkspaceId = taskSpawner.getTask(taskId)?.workspaceId;
                const checkpointName = filteredInput.slice(0, -1).trim();
                if (checkpointName && cpWorkspaceId) {
                  terminalInputBuffer.delete(taskId);
                  checkpointStore
                    .createCheckpoint(taskId, cpWorkspaceId, checkpointName)
                    .then((cp) => {
                      logger.info('Auto-checkpoint created on input', {
                        taskId,
                        checkpointId: cp.id,
                        name: checkpointName.slice(0, 60),
                      });
                      broadcast({ type: 'checkpoint:created', payload: cp });
                    })
                    .catch((err) => {
                      logger.warn('Auto-checkpoint failed', { taskId, error: String(err) });
                    });
                }
              } else if (endsWithEnterForCp && filteredInput.length === 1) {
                // Enter pressed alone (terminal keystroke mode) — flush buffer
                const buffered = (terminalInputBuffer.get(taskId) || '').trim();
                terminalInputBuffer.delete(taskId);
                if (buffered) {
                  const cpWorkspaceId = taskSpawner.getTask(taskId)?.workspaceId;
                  if (cpWorkspaceId) {
                    checkpointStore
                      .createCheckpoint(taskId, cpWorkspaceId, buffered)
                      .then((cp) => {
                        logger.info('Auto-checkpoint created on terminal input', {
                          taskId,
                          checkpointId: cp.id,
                          name: buffered.slice(0, 60),
                        });
                        broadcast({ type: 'checkpoint:created', payload: cp });
                      })
                      .catch((err) => {
                        logger.warn('Auto-checkpoint failed', { taskId, error: String(err) });
                      });
                  }
                }
              } else if (!endsWithEnterForCp && filteredInput.length > 0) {
                // Regular keystroke — accumulate in buffer (ignore control sequences)
                const isPrintable =
                  !filteredInput.startsWith('\x1b') && filteredInput.charCodeAt(0) >= 32;
                if (filteredInput === '\x7f' || filteredInput === '\b') {
                  // Backspace — remove last char from buffer
                  const current = terminalInputBuffer.get(taskId) || '';
                  terminalInputBuffer.set(taskId, current.slice(0, -1));
                } else if (isPrintable) {
                  const current = terminalInputBuffer.get(taskId) || '';
                  terminalInputBuffer.set(taskId, current + filteredInput);
                }
              }

              // Check if workspace references changed since last injection
              // If so, prepend updated reference context to the user's message
              const inputTask = taskSpawner.getTask(taskId);
              if (inputTask) {
                const endsWithEnter = filteredInput.endsWith('\r') || filteredInput.endsWith('\n');
                const hasMessageContent = filteredInput.length > 1 && endsWithEnter;
                if (
                  hasMessageContent &&
                  (inputTask.state === 'idle' || inputTask.state === 'waiting_input')
                ) {
                  const currentRefs = workspaceStore.getReferences(inputTask.workspaceId);
                  const currentValidRefs = currentRefs.filter((r) => existsSync(r.path));
                  const currentRefKey = currentValidRefs
                    .map((r) => r.id)
                    .sort()
                    .join(',');

                  if (currentRefKey !== (inputTask.lastRefKey ?? '')) {
                    // References changed - prepend context to the user's message
                    if (currentValidRefs.length > 0) {
                      const refList = currentValidRefs
                        .map((r) => {
                          let s = `"${r.name}" (${r.path})`;
                          if (r.description) s += ` - ${r.description}`;
                          return s;
                        })
                        .join('; ');
                      const refPrefix = `[CONTEXT UPDATE: Workspace references updated. Available reference directories (read files using absolute paths): ${refList}] `;
                      const msgContent = filteredInput.slice(0, -1);
                      const enterKey = filteredInput.slice(-1);
                      filteredInput = refPrefix + msgContent + enterKey;
                      ctxUpdateInFlight.add(taskId);
                      ctxInlineInFlight.add(taskId);
                      logger.info('Injected updated references into follow-up message', {
                        taskId,
                        refCount: currentValidRefs.length,
                      });
                    } else {
                      logger.info('References cleared for task', { taskId });
                    }
                    inputTask.lastRefKey = currentRefKey;
                  }

                  // One-time auto-title instruction injection for existing sessions
                  // (new sessions get this in the orchestration guidance system prompt)
                  const claudiaMcpEnabled = configStore.getClaudioMcpServerEnabled();
                  if (claudiaMcpEnabled && !inputTask.titleInstructionInjected) {
                    inputTask.titleInstructionInjected = true;
                    const titleInstruction = `[CONTEXT UPDATE: You can update your task title using claudia_rename_task. Call it with your own task ID and a \`displayName\` parameter (string, 3-6 words) describing what you're working on. The parameter is named \`displayName\`, NOT \`title\`. Do NOT rename if the user has manually edited the title (the tool will reject it).] `;
                    const msgContent =
                      filteredInput.endsWith('\r') || filteredInput.endsWith('\n')
                        ? filteredInput.slice(0, -1)
                        : filteredInput;
                    const enterKey =
                      filteredInput.endsWith('\r') || filteredInput.endsWith('\n')
                        ? filteredInput.slice(-1)
                        : '';
                    filteredInput = titleInstruction + msgContent + enterKey;
                    ctxUpdateInFlight.add(taskId);
                    ctxInlineInFlight.add(taskId);
                    logger.info('Injected auto-title instruction into existing session', {
                      taskId,
                    });
                  }
                }
              }
              taskSpawner.writeToTask(taskId, filteredInput);
            }
            break;
          }

          case 'task:resize': {
            // Resize a task's terminal
            const { taskId, cols, rows } = payload as {
              taskId?: string;
              cols?: number;
              rows?: number;
            };
            if (taskId && cols && rows) taskSpawner.resizeTask(taskId, cols, rows);
            break;
          }

          case 'task:destroy': {
            // Kill and remove a task
            const { taskId } = payload as { taskId?: string };
            console.log(`[Server] task:destroy received for taskId: ${taskId}`);
            if (taskId) {
              taskSpawner.destroyTask(taskId);
            } else {
              console.error('[Server] task:destroy missing taskId');
            }

            break;
          }

          case 'task:stop': {
            // Gracefully stop a running task (send ESC to interrupt Claude)
            const { taskId } = payload as { taskId?: string };
            if (taskId) {
              const stopped = taskSpawner.stopTask(taskId);
              logger.info('task:stop', { taskId, stopped });
              ws.send(
                JSON.stringify({
                  type: 'task:stopped' as WSMessageType,
                  payload: { taskId, stopped },
                }),
              );
            }
            break;
          }

          case 'task:stopAll': {
            // Stop all running tasks in a workspace
            const { workspaceId, excludeTaskId } = payload as {
              workspaceId?: string;
              excludeTaskId?: string;
            };
            if (workspaceId) {
              const tasks = taskSpawner.getActiveTasksForWorkspace(workspaceId);
              let stoppedCount = 0;
              const stoppedIds: string[] = [];
              for (const task of tasks) {
                // Skip the calling task (orchestrator) to avoid race condition
                // where the orchestrator stops its own Claude Code session
                if (excludeTaskId && task.id === excludeTaskId) {
                  logger.info('task:stopAll - skipping caller task', { taskId: task.id });
                  continue;
                }
                if (
                  task.state === 'busy' ||
                  task.state === 'starting' ||
                  task.state === 'waiting_input'
                ) {
                  const stopped = taskSpawner.stopTask(task.id);
                  if (stopped) {
                    stoppedCount++;
                    stoppedIds.push(task.id);
                  }
                }
              }
              logger.info('task:stopAll', { workspaceId, stoppedCount, stoppedIds });
              // Send result back to the requesting client
              ws.send(
                JSON.stringify({
                  type: 'task:stopAll:result' as WSMessageType,
                  payload: { workspaceId, stoppedCount, stoppedIds },
                }),
              );
            }
            break;
          }

          case 'task:disconnect': {
            // Disconnect a task (simulate server restart)
            const { taskId } = payload as { taskId?: string };
            if (taskId) {
              taskSpawner.disconnectTask(taskId);
            }
            break;
          }

          case 'task:clear': {
            // Clear all tasks
            taskSpawner.clearAllTasks();
            break;
          }

          case 'task:interrupt': {
            // Interrupt a running task (send ESC to cancel current operation)
            const { taskId } = payload as { taskId?: string };
            if (taskId) taskSpawner.interruptTask(taskId);
            break;
          }

          case 'task:archive': {
            // Archive a completed task (removes from view)
            const { taskId } = payload as { taskId?: string };
            if (taskId) taskSpawner.archiveTask(taskId);
            break;
          }

          case 'task:rename': {
            // Rename a task (set displayName)
            // source: 'user' (UI edit) locks title from agent auto-rename; 'agent' (MCP) is blocked if user-edited
            const { taskId, displayName, source } = payload as {
              taskId?: string;
              displayName?: string;
              source?: 'user' | 'agent';
            };
            if (!taskId || displayName === undefined) break;
            const renamed = taskSpawner.renameTask(taskId, displayName, source || 'user');
            if (renamed) {
              broadcast({
                type: 'tasks:updated' as WSMessageType,
                payload: { tasks: taskSpawner.getAllTasks() },
              });
            }
            break;
          }

          case 'task:reorder': {
            // Reorder tasks within a workspace
            const { taskOrders } = payload as { taskOrders?: { taskId: string; order: number }[] };
            if (!taskOrders || !Array.isArray(taskOrders)) break;
            const reordered = taskSpawner.reorderTasks(taskOrders);
            if (reordered) {
              // Broadcast updated task list to all clients (including sender)
              broadcast({
                type: 'tasks:reordered' as WSMessageType,
                payload: { tasks: taskSpawner.getAllTasks() },
              });
            }
            break;
          }

          case 'task:reconnect': {
            // Reconnect to a disconnected task
            const { taskId } = payload as { taskId?: string };
            if (!taskId) break;
            try {
              const task = taskSpawner.reconnectTask(taskId);
              if (task) {
                // Ensure reconnected task becomes active so output is streamed
                // and history is restored immediately.
                taskSpawner.setTaskActive(taskId, true);
                broadcast({ type: 'tasks:updated', payload: { tasks: taskSpawner.getAllTasks() } });
              }
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              logger.error('Failed to reconnect task', { taskId, error: errorMessage });
              sendWSError(
                ws,
                `Failed to reconnect task: ${errorMessage}`,
                message.type,
                'TASK_RECONNECT_FAILED',
              );
            }
            break;
          }

          case 'task:revert': {
            // Revert changes made by a task
            const { taskId, cleanUntracked } = payload as {
              taskId?: string;
              cleanUntracked?: boolean;
            };
            if (!taskId) break;
            const result = await taskSpawner.revertTask(taskId, cleanUntracked || false);
            // Send result back to client
            ws.send(
              JSON.stringify({
                type: 'task:revertResult',
                payload: { taskId, ...result },
              }),
            );
            if (result.success) {
              broadcast({ type: 'tasks:updated', payload: { tasks: taskSpawner.getAllTasks() } });
            }
            break;
          }

          case 'task:restore': {
            // Request terminal history restore
            const { taskId } = payload as { taskId?: string };
            if (!taskId) break;
            const task = taskSpawner.getTask(taskId);
            if (task && task.outputHistory.length > 0) {
              const history = task.outputHistory.map((buf) => buf.toString('utf8')).join('');
              ws.send(
                JSON.stringify({
                  type: 'task:restore',
                  payload: { taskId, history },
                }),
              );
            }
            // Replay the rich ConversationEvent snapshot for the React
            // conversation view (full structured events: tool calls/results,
            // thinking, assistant text).
            const convStreamer = convStreamers.get(taskId);
            if (convStreamer) {
              const events = convStreamer.getSnapshot();
              if (events.length > 0) {
                ws.send(
                  JSON.stringify({
                    type: 'task:conversation:restore',
                    payload: { taskId, events },
                  }),
                );
              }
            }
            break;
          }

          case 'task:archived:list': {
            // Get list of archived tasks
            const archivedTasks = taskSpawner.getArchivedTasks();
            ws.send(
              JSON.stringify({
                type: 'task:archived:list',
                payload: { tasks: archivedTasks },
              }),
            );
            break;
          }

          case 'task:archived:restore': {
            // Restore an archived task back to active state
            const { taskId } = payload as { taskId?: string };
            if (!taskId) break;
            const restoredTask = taskSpawner.restoreArchivedTask(taskId);
            if (restoredTask) {
              ws.send(
                JSON.stringify({
                  type: 'task:archived:restored',
                  payload: { task: restoredTask },
                }),
              );
              broadcast({ type: 'tasks:updated', payload: { tasks: taskSpawner.getAllTasks() } });
            } else {
              ws.send(
                JSON.stringify({
                  type: 'task:archived:restoreError',
                  payload: { taskId, error: 'Task not found in archive' },
                }),
              );
            }
            break;
          }

          case 'task:archived:continue': {
            // Continue an archived task - restores and reconnects it
            const { taskId } = payload as { taskId?: string };
            if (!taskId) break;
            const continuedTask = taskSpawner.continueArchivedTask(taskId);
            if (continuedTask) {
              ws.send(
                JSON.stringify({
                  type: 'task:archived:continued',
                  payload: { task: continuedTask },
                }),
              );
              broadcast({ type: 'tasks:updated', payload: { tasks: taskSpawner.getAllTasks() } });
            } else {
              ws.send(
                JSON.stringify({
                  type: 'task:archived:continueError',
                  payload: { taskId, error: 'Task not found in archive' },
                }),
              );
            }
            break;
          }

          case 'task:archived:delete': {
            // Permanently delete an archived task
            const { taskId } = payload as { taskId?: string };
            if (!taskId) break;
            const deleted = taskSpawner.deleteArchivedTask(taskId);
            ws.send(
              JSON.stringify({
                type: 'task:archived:deleted',
                payload: { taskId, success: deleted },
              }),
            );
            if (deleted) {
              broadcast({
                type: 'tasks:updated' as WSMessageType,
                payload: { tasks: taskSpawner.getAllTasks() },
              });
            }
            break;
          }

          case 'workspace:create': {
            // Add a workspace
            const { path } = payload as { path?: string };
            if (!path) break;
            try {
              const workspace = workspaceStore.addWorkspace(path);
              broadcast({ type: 'workspace:created' as WSMessageType, payload: { workspace } });
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : 'Failed to create workspace';
              logger.error('Failed to create workspace', { error: errorMessage, path });
              sendWSError(ws, errorMessage, message.type, 'WORKSPACE_CREATE_FAILED');
            }
            break;
          }

          case 'workspace:delete': {
            // Remove a workspace
            const { workspaceId } = payload as { workspaceId?: string };
            if (!workspaceId) break;
            // Close any embedded shell for this workspace
            closeShellTerminal(workspaceId);
            if (workspaceStore.deleteWorkspace(workspaceId)) {
              broadcast({ type: 'workspace:deleted' as WSMessageType, payload: { workspaceId } });
            }
            break;
          }

          case 'workspace:reorder': {
            // Reorder workspaces
            const { fromIndex, toIndex } = payload as { fromIndex?: number; toIndex?: number };
            if (typeof fromIndex !== 'number' || typeof toIndex !== 'number') break;
            if (workspaceStore.reorderWorkspaces(fromIndex, toIndex)) {
              // Broadcast updated workspace list to all clients
              const workspaces = workspaceStore.getWorkspaces();
              broadcast({ type: 'workspace:reordered' as WSMessageType, payload: { workspaces } });
            }
            break;
          }

          case 'workspace:setOrder': {
            // Set explicit workspace order from a client's rendered (sorted) view.
            // Used when a user drags-to-reorder while in a non-manual sort mode —
            // the client sends the visible order, we adopt it, and the client
            // switches its local sort mode to 'manual' on receipt.
            const { orderedIds } = payload as { orderedIds?: unknown };
            if (!Array.isArray(orderedIds) || !orderedIds.every((id) => typeof id === 'string')) {
              sendWSError(
                ws,
                'workspace:setOrder requires orderedIds: string[]',
                message.type,
                'INVALID_PARAMS',
              );
              break;
            }
            if (workspaceStore.setWorkspaceOrder(orderedIds as string[])) {
              const workspaces = workspaceStore.getWorkspaces();
              broadcast({ type: 'workspace:reordered' as WSMessageType, payload: { workspaces } });
            }
            break;
          }

          case 'workspace:rename': {
            // Rename a workspace (set displayName)
            const { workspaceId, displayName } = payload as {
              workspaceId?: string;
              displayName?: string;
            };
            if (!workspaceId || displayName === undefined) break;
            if (workspaceStore.renameWorkspace(workspaceId, displayName)) {
              const workspaces = workspaceStore.getWorkspaces();
              broadcast({ type: 'workspace:updated' as WSMessageType, payload: { workspaces } });
            }
            break;
          }

          case 'workspace:browseFolder': {
            // Open native OS folder picker dialog and return selected path
            // Use async spawn to avoid blocking the event loop during dialog
            const { spawn: spawnChild } = await import('child_process');
            const platform = process.platform;
            const lastBrowsed = workspaceStore.getLastBrowsedPath();

            let cmd: string;
            let args: string[];

            if (platform === 'darwin') {
              cmd = 'osascript';
              const scriptParts = [
                'POSIX path of (choose folder with prompt "Select a workspace folder"',
              ];
              if (lastBrowsed) {
                const safe = lastBrowsed.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                scriptParts.push(` default location POSIX file "${safe}"`);
              }
              scriptParts.push(')');
              args = ['-e', scriptParts.join('')];
            } else if (platform === 'win32') {
              cmd = 'powershell';
              const initialDirLine = lastBrowsed
                ? `$dialog.SelectedPath = [System.IO.Path]::GetFullPath("${lastBrowsed.replace(/"/g, '')}")`
                : '';
              const psScript = [
                'Add-Type -AssemblyName System.Windows.Forms',
                '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
                '$dialog.Description = "Select a workspace folder"',
                '$dialog.ShowNewFolderButton = $true',
                ...(initialDirLine ? [initialDirLine] : []),
                'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }',
              ].join('\n');
              const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
              args = ['-NoProfile', '-EncodedCommand', encoded];
            } else {
              // Linux - try zenity
              cmd = 'zenity';
              args = ['--file-selection', '--directory', '--title=Select a workspace folder'];
              if (lastBrowsed) args.push(`--filename=${lastBrowsed}/`);
            }

            logger.info('Opening folder browse dialog', { cmd, platform });

            const child = spawnChild(cmd, args);
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (data: Buffer) => {
              stdout += data.toString();
            });
            child.stderr.on('data', (data: Buffer) => {
              stderr += data.toString();
            });
            child.on('close', (code: number | null) => {
              const selectedPath = stdout.trim().replace(/\/$/, '') || null;
              logger.info('Folder browse dialog closed', {
                code,
                selectedPath,
                stderr: stderr.trim(),
              });

              if (code === 0 && selectedPath) {
                workspaceStore.setLastBrowsedPath(selectedPath);
              }

              ws.send(
                JSON.stringify({
                  type: 'workspace:browseFolder',
                  payload: { path: selectedPath },
                }),
              );
            });
            child.on('error', (err: Error) => {
              logger.error('Failed to open folder browse dialog', { error: err.message });
              ws.send(
                JSON.stringify({
                  type: 'workspace:browseFolder',
                  payload: { path: null },
                }),
              );
            });
            break;
          }

          case 'workspace:openFolder': {
            // Open workspace folder in native file explorer
            const { workspaceId } = payload as { workspaceId?: string };
            if (!workspaceId) break;
            const { execFile } = await import('child_process');
            const platform = process.platform;
            // Use execFile with argument arrays — no shell, no injection risk
            if (platform === 'darwin') {
              execFile('open', [workspaceId], (error) => {
                if (error)
                  logger.error('Failed to open folder', { workspaceId, error: error.message });
              });
            } else if (platform === 'win32') {
              execFile('explorer.exe', [workspaceId], (error) => {
                if (error)
                  logger.error('Failed to open folder', { workspaceId, error: error.message });
              });
            } else {
              execFile('xdg-open', [workspaceId], (error) => {
                if (error)
                  logger.error('Failed to open folder', { workspaceId, error: error.message });
              });
            }
            break;
          }

          case 'workspace:openTerminal': {
            // Open terminal at workspace folder
            const { workspaceId } = payload as { workspaceId?: string };
            if (!workspaceId) break;
            const { execFile } = await import('child_process');
            const platform = process.platform;
            if (platform === 'darwin') {
              // Use osascript with the path set via cwd — quoted form of handles all special chars
              // We pass two -e args: the cd script and the activate command
              const safeId = workspaceId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
              execFile(
                'osascript',
                [
                  '-e',
                  `tell application "Terminal" to do script "cd \\"${safeId}\\""`,
                  '-e',
                  'tell application "Terminal" to activate',
                ],
                (error) => {
                  if (error)
                    logger.error('Failed to open terminal', { workspaceId, error: error.message });
                },
              );
            } else if (platform === 'win32') {
              // Use cwd option instead of interpolating the path into the command
              execFile('cmd.exe', ['/C', 'start', 'cmd.exe'], { cwd: workspaceId }, (error) => {
                if (error)
                  logger.error('Failed to open terminal', { workspaceId, error: error.message });
              });
            } else {
              // Try common Linux terminal emulators in order
              execFile('x-terminal-emulator', [`--working-directory=${workspaceId}`], (error) => {
                if (error) {
                  execFile('gnome-terminal', [`--working-directory=${workspaceId}`], (error2) => {
                    if (error2) {
                      execFile(
                        'xterm',
                        ['-e', `cd '${workspaceId.replace(/'/g, "'\\''")}' && bash`],
                        (error3) => {
                          if (error3)
                            logger.error('Failed to open terminal', {
                              workspaceId,
                              error: error3.message,
                            });
                        },
                      );
                    }
                  });
                }
              });
            }
            break;
          }

          case 'workspace:systemPrompt:get': {
            // Get system prompt for a workspace
            const { workspaceId } = payload as { workspaceId?: string };
            if (!workspaceId) break;
            const systemPrompt = workspaceStore.getSystemPrompt(workspaceId);
            ws.send(
              JSON.stringify({
                type: 'workspace:systemPrompt',
                payload: { workspaceId, systemPrompt: systemPrompt || '' },
              }),
            );
            break;
          }

          case 'workspace:systemPrompt:set': {
            // Set system prompt for a workspace
            const { workspaceId, systemPrompt } = payload as {
              workspaceId?: string;
              systemPrompt?: string;
            };
            if (!workspaceId) break;
            const success = workspaceStore.setSystemPrompt(workspaceId, systemPrompt || undefined);
            if (success) {
              // Broadcast updated workspace list to all clients
              const workspaces = workspaceStore.getWorkspaces();
              broadcast({ type: 'workspace:updated' as WSMessageType, payload: { workspaces } });
            }
            ws.send(
              JSON.stringify({
                type: 'workspace:systemPrompt:result',
                payload: { workspaceId, success },
              }),
            );
            break;
          }

          case 'workspace:references:add': {
            const { workspaceId, path, description } = payload as {
              workspaceId?: string;
              path?: string;
              description?: string;
            };
            if (!workspaceId || !path) break;
            try {
              workspaceStore.addReference(workspaceId, path, description);
              const workspaces = workspaceStore.getWorkspaces();
              broadcast({ type: 'workspace:updated' as WSMessageType, payload: { workspaces } });
              notifyTasksOfReferenceChange(workspaceId, taskSpawner, workspaceStore);
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              logger.error('Failed to add reference', { workspaceId, path, error: errorMessage });
            }
            break;
          }

          case 'workspace:references:remove': {
            const { workspaceId, referenceId } = payload as {
              workspaceId?: string;
              referenceId?: string;
            };
            if (!workspaceId || !referenceId) break;
            if (workspaceStore.removeReference(workspaceId, referenceId)) {
              const workspaces = workspaceStore.getWorkspaces();
              broadcast({ type: 'workspace:updated' as WSMessageType, payload: { workspaces } });
              notifyTasksOfReferenceChange(workspaceId, taskSpawner, workspaceStore);
            }
            break;
          }

          case 'workspace:references:toggle': {
            // Toggle a workspace reference on/off (for the checkbox UX)
            const { workspaceId, referencePath } = payload as {
              workspaceId?: string;
              referencePath?: string;
            };
            if (!workspaceId || !referencePath) break;
            try {
              const refs = workspaceStore.getReferences(workspaceId);
              const existing = refs.find((r) => r.path === referencePath);
              if (existing) {
                workspaceStore.removeReference(workspaceId, existing.id);
              } else {
                workspaceStore.addReference(workspaceId, referencePath);
              }
              const workspaces = workspaceStore.getWorkspaces();
              broadcast({ type: 'workspace:updated' as WSMessageType, payload: { workspaces } });
              notifyTasksOfReferenceChange(workspaceId, taskSpawner, workspaceStore);
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              logger.error('Failed to toggle reference', {
                workspaceId,
                referencePath,
                error: errorMessage,
              });
            }
            break;
          }

          case 'workspace:previewPort:set': {
            const { workspaceId, port } = payload as { workspaceId?: string; port?: number };
            if (!workspaceId) break;
            const parsedPort = port ? Number(port) : undefined;
            if (workspaceStore.setPreviewPort(workspaceId, parsedPort)) {
              const workspaces = workspaceStore.getWorkspaces();
              broadcast({ type: 'workspace:updated' as WSMessageType, payload: { workspaces } });
            }
            break;
          }

          case 'workspace:recent:list': {
            // Get list of recent workspaces (removed but still exist on disk)
            const recentWorkspaces = workspaceStore.getRecentWorkspaces();
            ws.send(
              JSON.stringify({
                type: 'workspace:recent:list',
                payload: { recentWorkspaces },
              }),
            );
            break;
          }

          case 'workspace:recent:clear': {
            // Clear a specific recent workspace or all recent workspaces
            const { workspaceId } = payload as { workspaceId?: string };
            if (workspaceId) {
              workspaceStore.clearRecentWorkspace(workspaceId);
            } else {
              workspaceStore.clearAllRecentWorkspaces();
            }
            // Send updated list back
            const recentWorkspaces = workspaceStore.getRecentWorkspaces();
            ws.send(
              JSON.stringify({
                type: 'workspace:recent:list',
                payload: { recentWorkspaces },
              }),
            );
            break;
          }

          case 'workspace:reset': {
            // Reset workspace: archive all tasks and checkout main branch
            const { workspaceId } = payload as { workspaceId?: string };
            if (!workspaceId) {
              logger.error('workspace:reset requires workspaceId');
              sendWSError(
                ws,
                'workspace:reset requires workspaceId',
                message.type,
                'MISSING_PARAMS',
              );
              break;
            }

            logger.info('Resetting workspace', { workspaceId });

            // Step 1: Archive all tasks for this workspace
            const allTasks = taskSpawner.getAllTasks();
            const workspaceTasks = allTasks.filter((t) => t.workspaceId === workspaceId);
            let archivedCount = 0;
            for (const task of workspaceTasks) {
              try {
                taskSpawner.archiveTask(task.id);
                archivedCount++;
                logger.info('Archived task during workspace reset', { taskId: task.id });
              } catch (e) {
                logger.error('Failed to archive task during reset', { taskId: task.id, error: e });
              }
            }

            // Step 2: Checkout the main/default branch
            let branchResult: { success: boolean; error?: string } = {
              success: false,
              error: 'Not a git repository',
            };
            let checkedOutBranch: string | null = null;
            const isRepo = await isGitRepo(workspaceId);
            if (isRepo) {
              const currentBranch = await getCurrentBranch(workspaceId);
              const defaultBranch = await getDefaultBranch(workspaceId);
              logger.info('Git branch info for reset', {
                currentBranch,
                defaultBranch,
                workspaceId,
              });

              if (defaultBranch) {
                if (currentBranch === defaultBranch) {
                  branchResult = { success: true };
                  checkedOutBranch = defaultBranch;
                  logger.info('Already on default branch', { branch: defaultBranch });
                } else {
                  branchResult = await checkoutBranch(workspaceId, defaultBranch);
                  if (branchResult.success) {
                    checkedOutBranch = defaultBranch;
                    logger.info('Checked out default branch', { branch: defaultBranch });
                  } else {
                    logger.error('Failed to checkout default branch', {
                      branch: defaultBranch,
                      error: branchResult.error,
                    });
                  }
                }
              } else {
                branchResult = {
                  success: false,
                  error: 'Could not determine default branch (main/master)',
                };
                logger.warn('Could not determine default branch for workspace', { workspaceId });
              }
            } else {
              // Not a git repo - that's OK, just report it
              branchResult = { success: true };
              logger.info('Workspace is not a git repo, skipping branch checkout', { workspaceId });
            }

            // Broadcast updated tasks to all clients
            broadcast({ type: 'tasks:updated', payload: { tasks: taskSpawner.getAllTasks() } });

            // Send result back to requesting client
            ws.send(
              JSON.stringify({
                type: 'workspace:resetResult',
                payload: {
                  workspaceId,
                  archivedCount,
                  totalTasks: workspaceTasks.length,
                  branchCheckout: branchResult.success,
                  checkedOutBranch,
                  branchError: branchResult.error || null,
                  isGitRepo: isRepo,
                },
              }),
            );

            logger.info('Workspace reset complete', {
              workspaceId,
              archivedCount,
              totalTasks: workspaceTasks.length,
              branchCheckout: branchResult.success,
              checkedOutBranch,
            });
            break;
          }

          case 'git:push': {
            // Create a task to push changes to GitHub
            const { workspaceId } = payload as { workspaceId?: string };
            if (!workspaceId) {
              logger.error('git:push requires workspaceId');
              sendWSError(ws, 'git:push requires workspaceId', message.type, 'MISSING_PARAMS');
              return;
            }
            // Validate workspace path
            const workspaceValidation = validateWorkspacePath(workspaceId);
            if (!workspaceValidation.valid) {
              logger.error('Invalid workspace path', { error: workspaceValidation.error });
              sendWSError(
                ws,
                workspaceValidation.error || 'Invalid workspace path',
                message.type,
                'INVALID_WORKSPACE',
              );
              return;
            }

            // Auto-add workspace if it doesn't exist yet
            const validatedPath = workspaceValidation.data!;
            if (!workspaceStore.getWorkspace(validatedPath)) {
              try {
                const workspace = workspaceStore.addWorkspace(validatedPath);
                logger.info('Auto-added workspace for git push task', {
                  workspaceId: validatedPath,
                });
                broadcast({ type: 'workspace:created' as WSMessageType, payload: { workspace } });
              } catch (error) {
                logger.error('Failed to auto-add workspace', { error });
              }
            }

            // Create a task to push to GitHub
            const pushPrompt =
              'Push the latest changes to GitHub. First check git status to see what needs to be committed. If there are uncommitted changes, create a commit with an appropriate message, then push to the remote repository. If there are no changes, just confirm that everything is already up to date.';
            const rules = configStore.getRules();
            const systemPrompt = rules?.trim() || undefined;
            logger.info('Creating git push task', { workspaceId });
            taskSpawner.createTask(pushPrompt, validatedPath, systemPrompt).then((pushTask) => {
              checkpointStore
                .createCheckpoint(pushTask.id, validatedPath, 'Initial state')
                .then((cp) => {
                  logger.info('Initial checkpoint created for git push task', {
                    taskId: pushTask.id,
                    checkpointId: cp.id,
                  });
                  broadcast({ type: 'checkpoint:created', payload: cp });
                })
                .catch((err) => {
                  logger.warn('Failed to create initial checkpoint for git push task', {
                    taskId: pushTask.id,
                    error: String(err),
                  });
                });
            });
            break;
          }

          case 'shell:create': {
            const { workspaceId, cols, rows } = payload as {
              workspaceId?: string;
              cols?: number;
              rows?: number;
            };
            if (!workspaceId) break;
            createShellTerminal(workspaceId, ws, cols, rows);
            break;
          }

          case 'shell:input': {
            const { workspaceId, input } = payload as { workspaceId?: string; input?: string };
            if (!workspaceId || input === undefined) break;
            const shellPty = shellProcesses.get(workspaceId);
            if (shellPty) {
              shellPty.write(input);
            }
            break;
          }

          case 'shell:resize': {
            const { workspaceId, cols, rows } = payload as {
              workspaceId?: string;
              cols?: number;
              rows?: number;
            };
            if (!workspaceId || !cols || !rows) break;
            const shellPtyResize = shellProcesses.get(workspaceId);
            if (shellPtyResize) {
              shellPtyResize.resize(cols, rows);
            }
            break;
          }

          case 'shell:close': {
            const { workspaceId } = payload as { workspaceId?: string };
            if (!workspaceId) break;
            closeShellTerminal(workspaceId);
            break;
          }

          case 'tunnel:status': {
            // Request tunnel status
            ws.send(
              JSON.stringify({
                type: 'tunnel:status',
                payload: tunnelManager.getStatus(),
              }),
            );
            break;
          }

          // ===== Scheduled Tasks (Cron) =====

          case 'cron:create': {
            const { taskId, cronExpression, prompt, isRecurring } = payload as {
              taskId?: string;
              cronExpression?: string;
              prompt?: string;
              isRecurring?: boolean;
            };
            if (!taskId || !cronExpression || !prompt) {
              sendWSError(
                ws,
                'cron:create requires taskId, cronExpression, and prompt',
                message.type,
                'MISSING_PARAMS',
              );
              break;
            }
            const task =
              taskSpawner.getTask(taskId) || taskSpawner.getAllTasks().find((t) => t.id === taskId);
            if (!task) {
              sendWSError(ws, `Task '${taskId}' not found`, message.type, 'TASK_NOT_FOUND');
              break;
            }
            try {
              const scheduled = cronScheduler.create(
                taskId,
                task.workspaceId,
                cronExpression,
                prompt,
                isRecurring !== false, // default to recurring
              );
              ws.send(
                JSON.stringify({
                  type: 'cron:created',
                  payload: {
                    scheduledTask: scheduled,
                    description: describeCronExpression(cronExpression),
                  },
                }),
              );
              broadcast({ type: 'cron:updated' as WSMessageType, payload: { taskId } });
            } catch (error) {
              sendWSError(
                ws,
                error instanceof Error ? error.message : String(error),
                message.type,
                'CRON_CREATE_FAILED',
              );
            }
            break;
          }

          case 'cron:list': {
            const { taskId } = payload as { taskId?: string };
            const scheduled = cronScheduler.list(taskId || undefined);
            ws.send(
              JSON.stringify({
                type: 'cron:list',
                payload: { scheduledTasks: scheduled },
              }),
            );
            break;
          }

          case 'cron:delete': {
            const { cronId } = payload as { cronId?: string };
            if (!cronId) {
              sendWSError(ws, 'cron:delete requires cronId', message.type, 'MISSING_PARAMS');
              break;
            }
            const scheduledTask = cronScheduler.get(cronId);
            const deleted = cronScheduler.delete(cronId);
            if (deleted) {
              ws.send(
                JSON.stringify({
                  type: 'cron:deleted',
                  payload: { cronId, taskId: scheduledTask?.taskId },
                }),
              );
              broadcast({
                type: 'cron:updated' as WSMessageType,
                payload: { cronId, taskId: scheduledTask?.taskId },
              });
            } else {
              sendWSError(
                ws,
                `Scheduled task '${cronId}' not found`,
                message.type,
                'CRON_NOT_FOUND',
              );
            }
            break;
          }

          case 'cron:update': {
            const { cronId, cronExpression, prompt, isRecurring, isPaused } = payload as {
              cronId?: string;
              cronExpression?: string;
              prompt?: string;
              isRecurring?: boolean;
              isPaused?: boolean;
            };
            if (!cronId) {
              sendWSError(ws, 'cron:update requires cronId', message.type, 'MISSING_PARAMS');
              break;
            }
            try {
              const updated = cronScheduler.update(cronId, {
                cronExpression,
                prompt,
                isRecurring,
                isPaused,
              });
              if (updated) {
                ws.send(
                  JSON.stringify({
                    type: 'cron:updated',
                    payload: {
                      scheduledTask: {
                        ...updated,
                        description: describeCronExpression(updated.cronExpression),
                      },
                    },
                  }),
                );
                broadcast({
                  type: 'cron:updated' as WSMessageType,
                  payload: { cronId, taskId: updated.taskId },
                });
              } else {
                sendWSError(
                  ws,
                  `Scheduled task '${cronId}' not found`,
                  message.type,
                  'CRON_NOT_FOUND',
                );
              }
            } catch (err) {
              sendWSError(
                ws,
                err instanceof Error ? err.message : String(err),
                message.type,
                'CRON_UPDATE_FAILED',
              );
            }
            break;
          }

          case 'cron:run': {
            const { cronId } = payload as { cronId?: string };
            if (!cronId) {
              sendWSError(ws, 'cron:run requires cronId', message.type, 'MISSING_PARAMS');
              break;
            }
            const scheduled = cronScheduler.get(cronId);
            if (!scheduled) {
              sendWSError(
                ws,
                `Scheduled task '${cronId}' not found`,
                message.type,
                'CRON_NOT_FOUND',
              );
              break;
            }
            logger.info('Manual trigger requested for scheduled task', {
              cronId,
              taskId: scheduled.taskId,
            });
            const fired = cronScheduler.fireNow(cronId);
            if (fired) {
              const refreshed = cronScheduler.get(cronId);
              ws.send(
                JSON.stringify({
                  type: 'cron:ran',
                  payload: {
                    cronId,
                    taskId: scheduled.taskId,
                    scheduledTask: refreshed
                      ? {
                          ...refreshed,
                          description: describeCronExpression(refreshed.cronExpression),
                        }
                      : null,
                  },
                }),
              );
              broadcast({
                type: 'cron:updated' as WSMessageType,
                payload: { cronId, taskId: scheduled.taskId },
              });
            } else {
              sendWSError(
                ws,
                `Failed to fire scheduled task '${cronId}'`,
                message.type,
                'CRON_FIRE_FAILED',
              );
            }
            break;
          }

          // ===== Usage Tracking =====

          case 'usage:get': {
            const { period, workspaceId: usageWsId } = payload as {
              period?: 'today' | '7d' | '30d' | 'all';
              workspaceId?: string;
            };
            const summary = usageStore.getSummary(period || 'all', usageWsId);
            ws.send(JSON.stringify({ type: 'usage:summary', payload: summary }));
            break;
          }

          case 'usage:clear': {
            usageStore.clearAll();
            ws.send(JSON.stringify({ type: 'usage:summary', payload: usageStore.getSummary() }));
            break;
          }

          // ===== Checkpoints/Timeline =====

          case 'checkpoint:create': {
            const {
              taskId: cpTaskId,
              workspaceId: cpWsId,
              name: cpName,
              description: cpDesc,
            } = payload as {
              taskId?: string;
              workspaceId?: string;
              name?: string;
              description?: string;
            };
            if (!cpTaskId || !cpWsId) {
              sendWSError(
                ws,
                'checkpoint:create requires taskId and workspaceId',
                message.type,
                'MISSING_PARAMS',
              );
              break;
            }
            try {
              const checkpoint = await checkpointStore.createCheckpoint(
                cpTaskId,
                cpWsId,
                cpName,
                cpDesc,
              );
              ws.send(JSON.stringify({ type: 'checkpoint:created', payload: checkpoint }));
            } catch (err) {
              sendWSError(
                ws,
                `Failed to create checkpoint: ${err}`,
                message.type,
                'CHECKPOINT_ERROR',
              );
            }
            break;
          }

          case 'checkpoint:list': {
            const { taskId: cpListTaskId, workspaceId: cpListWsId } = payload as {
              taskId?: string;
              workspaceId?: string;
            };
            let checkpoints: import('@claudia/shared').Checkpoint[] = [];
            if (cpListTaskId) {
              checkpoints = checkpointStore.listCheckpoints(cpListTaskId);
            } else if (cpListWsId) {
              checkpoints = checkpointStore.listCheckpointsByWorkspace(cpListWsId);
            }
            ws.send(JSON.stringify({ type: 'checkpoint:list', payload: { checkpoints } }));
            break;
          }

          case 'checkpoint:restore': {
            const { checkpointId: restoreId } = payload as { checkpointId?: string };
            if (!restoreId) {
              sendWSError(
                ws,
                'checkpoint:restore requires checkpointId',
                message.type,
                'MISSING_PARAMS',
              );
              break;
            }
            const result = await checkpointStore.restoreCheckpoint(restoreId);
            if (result.success) {
              ws.send(
                JSON.stringify({
                  type: 'checkpoint:restored',
                  payload: { checkpointId: restoreId },
                }),
              );
            } else {
              ws.send(
                JSON.stringify({
                  type: 'checkpoint:error',
                  payload: { error: result.error, checkpointId: restoreId },
                }),
              );
            }
            break;
          }

          case 'checkpoint:restore-selective': {
            const { checkpointId: selRestoreId } = payload as { checkpointId?: string };
            if (!selRestoreId) {
              sendWSError(
                ws,
                'checkpoint:restore-selective requires checkpointId',
                message.type,
                'MISSING_PARAMS',
              );
              break;
            }
            const selResult = await checkpointStore.restoreCheckpointSelective(selRestoreId);
            ws.send(
              JSON.stringify({
                type: 'checkpoint:restore-selective-result',
                payload: {
                  checkpointId: selRestoreId,
                  success: selResult.success,
                  restoredFiles: selResult.restoredFiles,
                  conflictingFiles: selResult.conflictingFiles,
                  error: selResult.error,
                },
              }),
            );
            break;
          }

          case 'checkpoint:restore-force': {
            const { checkpointId: forceId, files: forceFiles } = payload as {
              checkpointId?: string;
              files?: string[];
            };
            if (!forceId || !forceFiles || forceFiles.length === 0) {
              sendWSError(
                ws,
                'checkpoint:restore-force requires checkpointId and files[]',
                message.type,
                'MISSING_PARAMS',
              );
              break;
            }
            const forceResult = await checkpointStore.forceRestoreFiles(forceId, forceFiles);
            ws.send(
              JSON.stringify({
                type: 'checkpoint:restore-force-result',
                payload: {
                  checkpointId: forceId,
                  success: forceResult.success,
                  restoredFiles: forceResult.restoredFiles,
                  error: forceResult.error,
                },
              }),
            );
            break;
          }

          case 'checkpoint:delete': {
            const { checkpointId: deleteId } = payload as { checkpointId?: string };
            if (!deleteId) {
              sendWSError(
                ws,
                'checkpoint:delete requires checkpointId',
                message.type,
                'MISSING_PARAMS',
              );
              break;
            }
            const deleted = checkpointStore.deleteCheckpoint(deleteId);
            if (deleted) {
              ws.send(
                JSON.stringify({ type: 'checkpoint:deleted', payload: { checkpointId: deleteId } }),
              );
            } else {
              sendWSError(ws, 'Checkpoint not found', message.type, 'CHECKPOINT_NOT_FOUND');
            }
            break;
          }

          case 'checkpoint:fork': {
            const { checkpointId: forkId, branchName } = payload as {
              checkpointId?: string;
              branchName?: string;
            };
            if (!forkId) {
              sendWSError(
                ws,
                'checkpoint:fork requires checkpointId',
                message.type,
                'MISSING_PARAMS',
              );
              break;
            }
            const forkResult = await checkpointStore.forkFromCheckpoint(forkId, branchName);
            if (forkResult.success) {
              ws.send(
                JSON.stringify({
                  type: 'checkpoint:forked',
                  payload: { checkpointId: forkId, branch: forkResult.branch },
                }),
              );
            } else {
              ws.send(
                JSON.stringify({
                  type: 'checkpoint:error',
                  payload: { error: forkResult.error, checkpointId: forkId },
                }),
              );
            }
            break;
          }
        }
      } catch (err) {
        logger.error('Error handling message', {
          type: messageTypeForError,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        sendWSError(
          ws,
          'Internal server error processing request',
          messageTypeForError,
          'INTERNAL_ERROR',
        );
      }
    });

    ws.on('close', (code: number, reason: Buffer) => {
      const reasonStr = reason.toString() || 'no reason';
      console.log(`[Server] Client disconnected - code: ${code}, reason: ${reasonStr}`);
      clients.delete(ws);
      if (voiceClients.has(ws)) {
        voiceClients.delete(ws);
      }
    });

    ws.on('error', (error: Error) => {
      console.error('[Server] WebSocket error:', error.message);
    });
  });

  // REST API routes
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // ─── Mobile companion app routes ───────────────────────────────────────
  // Token-gated when accessed via tunnel (the global tunnel auth middleware
  // handles that). Locally these are open so the RN web build on
  // http://localhost can hit them without ceremony.

  // Bridge metadata for the mobile app to display after connecting.
  app.get('/api/mobile/bridge-info', (_req, res) => {
    const tunnelStatus = tunnelManager.getStatus();
    const dgKey =
      configStore.getConfig().deepgramApiKey ?? process.env.DEEPGRAM_API_KEY;
    res.json({
      success: true,
      version: '0.1.0',
      tunnel: { active: tunnelStatus.active, url: tunnelStatus.url },
      voiceConfigured: Boolean(dgKey),
      pushSupported: true,
    });
  });

  // Register an Expo push token (called by the RN app on first launch).
  app.post('/api/mobile/register-push', (req, res) => {
    const { deviceId, pushToken, platform, label } = req.body ?? {};
    if (typeof deviceId !== 'string' || typeof pushToken !== 'string') {
      return res
        .status(400)
        .json({ success: false, error: 'deviceId and pushToken are required strings' });
    }
    const plat: 'ios' | 'android' | 'web' =
      platform === 'ios' || platform === 'android' || platform === 'web' ? platform : 'web';
    const device = registerDevice({ deviceId, pushToken, platform: plat, label });
    res.json({ success: true, device });
  });

  app.delete('/api/mobile/register-push/:deviceId', (req, res) => {
    const ok = unregisterDevice(req.params.deviceId);
    res.json({ success: ok });
  });

  app.get('/api/mobile/devices', (_req, res) => {
    res.json({ success: true, devices: listDevices() });
  });

  // Send a test push (used by the mobile app's "Send test" button and by
  // the test-cli's --simulate-mobile-event flag).
  app.post('/api/mobile/test-push', async (req, res) => {
    const title = (req.body?.title as string) ?? 'Claudia';
    const body = (req.body?.body as string) ?? 'Test notification from your bridge.';
    const result = await sendPush({ title, body, data: { kind: 'test' } });
    res.json({ success: true, result });
  });

  // Simulate a `task:summary` event end-to-end. Used by --simulate-mobile-event
  // to verify the mobile feed without spawning a real task.
  app.post('/api/mobile/simulate-summary', async (req, res) => {
    const taskId = (req.body?.taskId as string) ?? 'sim-task';
    const summary = buildSimulatedSummary(taskId);
    broadcast({ type: 'task:summary' as WSMessageType, payload: summary });
    // Also push so phones registered to this bridge see it on lock screen.
    await sendPush({
      title: summary.taskName ?? 'Task complete',
      body: summary.summary,
      data: { kind: 'task:summary', taskId: summary.taskId },
    });
    res.json({ success: true, summary });
  });

  // Dev-only: simulate a `task:waitingInput` broadcast for an existing task,
  // so the conversation view's WaitingInputBanner + status-bar question chip
  // can be exercised without waiting for Claude Code to genuinely park at a
  // permission gate. Used by Playwright to verify the picker-rendering fix.
  // Body: { taskId, inputType?, recentOutput? }.
  app.post('/api/dev/simulate-waiting-input', (req, res) => {
    const taskId = (req.body?.taskId as string) ?? '';
    if (!taskId) {
      res.status(400).json({ error: 'taskId is required' });
      return;
    }
    const inputType = (req.body?.inputType as WaitingInputType) ?? 'permission';
    const fallbackOutput =
      "Bash command\n  cd /tmp && npm install react-native-webview\n\nDo you want to proceed?\n[34m❯[0m 1. Yes\n  2. Yes, and don't ask again for npm install\n  3. No, and tell Claude what to do differently";
    const recentOutput =
      typeof req.body?.recentOutput === 'string'
        ? req.body.recentOutput
        : fallbackOutput;
    broadcast({
      type: 'task:waitingInput',
      payload: { taskId, inputType, recentOutput },
    });
    res.json({ success: true, taskId, inputType });
  });

  // ─── Mobile single-agent chat ───────────────────────────────────────────
  // Per-workspace chat transcript between the user and the mobile agent.
  // The agent decides what to do (spawn task, send input, just reply) via
  // tool calls — see backend/src/mobile-agent.ts. Transcripts are persisted
  // server-side so multiple paired devices stay in sync.
  //
  // Workspace IDs are filesystem paths (containing slashes), so we pass them
  // as `?workspaceId=...` query/body args rather than as URL path params —
  // Express path matching strips embedded slashes even when URL-encoded.

  // Fetch the transcript for a workspace.
  app.get('/api/mobile/chat', (req, res) => {
    const workspaceId = (req.query.workspaceId as string) ?? '';
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId query param is required' });
      return;
    }
    const messages = mobileChatStore.getTranscript(workspaceId);
    res.json({ workspaceId, messages });
  });

  // Send a user message into the workspace chat. Runs the agent loop,
  // appends both the user message and any agent/system messages it
  // produces, broadcasts each new message over WS, and returns them so the
  // device can update its UI immediately even before the WS event lands.
  app.post('/api/mobile/chat', async (req, res) => {
    const workspaceId =
      (typeof req.body?.workspaceId === 'string' ? req.body.workspaceId : '') ||
      (req.query.workspaceId as string | undefined) ||
      '';
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId is required' });
      return;
    }
    if (!text) {
      res.status(400).json({ error: 'text is required and must be non-empty' });
      return;
    }
    const ws = workspaceStore.getWorkspaces().find((w) => w.id === workspaceId);
    if (!ws) {
      res.status(404).json({ error: `Workspace '${workspaceId}' not found` });
      return;
    }

    try {
      const beforeCount = mobileChatStore.getTranscript(workspaceId).length;
      const newMessages = await mobileAgent.runAgentTurn(workspaceId, text);
      const afterAll = mobileChatStore.getTranscript(workspaceId);
      const fresh = afterAll.slice(beforeCount);
      for (const m of fresh) {
        broadcast({
          type: 'chat:message' as WSMessageType,
          payload: { workspaceId, message: m },
        });
      }
      res.json({ success: true, messages: fresh, agentMessages: newMessages });
    } catch (err) {
      console.error('[mobile-chat] runAgentTurn failed:', err);
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : 'agent turn failed' });
    }
  });

  // Wipe a workspace's transcript.
  app.delete('/api/mobile/chat', (req, res) => {
    const workspaceId =
      (typeof req.body?.workspaceId === 'string' ? req.body.workspaceId : '') ||
      (req.query.workspaceId as string | undefined) ||
      '';
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId is required' });
      return;
    }
    const removed = mobileChatStore.clear(workspaceId);
    res.json({ success: true, removed });
  });

  // Run the idle-task summary path on demand (test/debug). Bypasses the
  // need to wait for a real busy→idle transition — handy for `test-cli
  // --mobile-summary --task-id <id>` when iterating on the LLM prompt.
  app.post('/api/mobile/chat/summarize-task', async (req, res) => {
    const taskId = typeof req.body?.taskId === 'string' ? req.body.taskId : '';
    if (!taskId) {
      res.status(400).json({ error: 'body.taskId is required' });
      return;
    }
    const task = taskSpawner.getTask(taskId);
    if (!task) {
      res.status(404).json({ error: `Task '${taskId}' not found` });
      return;
    }
    try {
      const message = await mobileAgent.summarizeIdleTask(task);
      broadcast({
        type: 'chat:message' as WSMessageType,
        payload: { workspaceId: task.workspaceId, message },
      });
      res.json({ success: true, message });
    } catch (err) {
      console.error('[mobile-chat] summarizeIdleTask (manual) failed:', err);
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : 'summary failed' });
    }
  });

  // ─── Voice (Deepgram) ────────────────────────────────────────────────
  // The RN app uses Deepgram's streaming WebSocket directly. We serve the
  // user's saved Deepgram key (stored via the desktop Settings → Voice
  // panel, persisted to config.json by `setDeepgramApiKey`) so the device
  // never has to hold it long-term — it just opens a WS, streams a clip,
  // and discards. If no key is configured we return configured:false and
  // the mobile app falls back to text-only input.
  //
  // For production tunnel deployments we should mint a short-lived member
  // key via Deepgram's Management API instead of forwarding the long-lived
  // one. That's a v2 hardening pass.
  app.get('/api/voice/deepgram-token', async (_req, res) => {
    const apiKey =
      configStore.getConfig().deepgramApiKey || process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      return res.json({ success: true, configured: false });
    }
    res.json({ success: true, configured: true, key: apiKey, expiresIn: 30 });
  });

  // Byte-range read of a task's history file. Used by the terminal's
  // scroll-up handler to lazy-load earlier output beyond the initial
  // 512KB sent with `task:restore`. Returns { data, startOffset, totalSize,
  // isBase64Legacy }. Pass `maxBytes=0` to fetch only the metadata.
  app.get('/api/task/:taskId/history', (req, res) => {
    const { taskId } = req.params;
    const endBefore = parseInt(req.query.endBefore as string, 10);
    const maxBytes = parseInt(req.query.maxBytes as string, 10);
    // 2 MB hard cap so a misbehaving client can't request gigabytes per scroll
    const MAX_CHUNK = 2 * 1024 * 1024;
    if (!taskId || !Number.isFinite(endBefore) || !Number.isFinite(maxBytes)) {
      res.status(400).json({ error: 'taskId, endBefore (int), maxBytes (int) required' });
      return;
    }
    if (endBefore < 0 || maxBytes < 0 || maxBytes > MAX_CHUNK) {
      res.status(400).json({ error: `maxBytes must be 0..${MAX_CHUNK}, endBefore >= 0` });
      return;
    }
    try {
      const result = taskSpawner.readTaskHistoryRange(taskId, endBefore, maxBytes);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('history read failed', { taskId, error: msg });
      res.status(500).json({ error: msg });
    }
  });

  // Native folder picker dialog
  app.post('/api/browse-folder', async (_req, res) => {
    try {
      const platform = process.platform;
      const storedLastBrowsed = workspaceStore.getLastBrowsedPath();
      // Validate the stored path still exists — a stale path can break the
      // native dialog (on macOS, AppleScript's `default location POSIX file
      // "..."` errors with "-1700 Can't make file ... into type alias" if the
      // path is gone, which manifested as the Browse button doing nothing).
      let lastBrowsed: string | undefined;
      if (storedLastBrowsed) {
        try {
          const stat = fs.statSync(storedLastBrowsed);
          if (stat.isDirectory()) lastBrowsed = storedLastBrowsed;
        } catch {
          // path is gone — drop it from the store so we don't keep tripping
          console.log(
            '[browse-folder] Clearing stale lastBrowsedPath:',
            storedLastBrowsed,
          );
          workspaceStore.setLastBrowsedPath('');
        }
      }
      console.log(
        '[browse-folder] Request received, platform:',
        platform,
        'lastBrowsed:',
        lastBrowsed,
      );

      const buildArgs = (useLastBrowsed: boolean): { cmd: string; args: string[] } => {
        const seed = useLastBrowsed ? lastBrowsed : undefined;
        if (platform === 'darwin') {
          const scriptParts = [
            'POSIX path of (choose folder with prompt "Select a workspace folder"',
          ];
          if (seed) {
            const safe = seed.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            scriptParts.push(` default location POSIX file "${safe}"`);
          }
          scriptParts.push(')');
          return { cmd: 'osascript', args: ['-e', scriptParts.join('')] };
        } else if (platform === 'win32') {
          const initialDir = seed
            ? `$f.SelectedPath = [System.IO.Path]::GetFullPath("${seed.replace(/"/g, '')}"); `
            : '';
          return {
            cmd: 'powershell',
            args: [
              '-STA',
              '-NoProfile',
              '-Command',
              `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::EnableVisualStyles(); $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select a workspace folder'; $f.ShowNewFolderButton = $true; ${initialDir}if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath } else { '' }`,
            ],
          };
        } else {
          // Linux - try zenity first, fall back to kdialog
          try {
            require('child_process').execFileSync('which', ['zenity'], { stdio: 'ignore' });
            const args = ['--file-selection', '--directory', '--title=Select a workspace folder'];
            if (seed) args.push(`--filename=${seed}/`);
            return { cmd: 'zenity', args };
          } catch {
            return {
              cmd: 'kdialog',
              args: [
                '--getexistingdirectory',
                seed || process.env['HOME'] || '/',
                '--title',
                'Select a workspace folder',
              ],
            };
          }
        }
      };

      const runDialog = (
        useLastBrowsed: boolean,
      ): Promise<{ code: number | null; stdout: string; stderr: string }> => {
        return new Promise((resolve, reject) => {
          const { cmd, args } = buildArgs(useLastBrowsed);
          console.log('[browse-folder] Spawning:', cmd, JSON.stringify(args));
          const child = spawn(cmd, args);
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (data: Buffer) => {
            stdout += data.toString();
          });
          child.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
          });
          child.on('close', (code: number | null) => {
            resolve({ code, stdout, stderr });
          });
          child.on('error', (err: Error) => {
            reject(err);
          });
        });
      };

      let result = await runDialog(true);
      console.log(
        '[browse-folder] Child closed. code=',
        result.code,
        'stdout=',
        JSON.stringify(result.stdout),
        'stderr=',
        JSON.stringify(result.stderr),
      );

      // If the dialog failed (non-zero exit with no path) AND we used a seed
      // path, retry once without the seed — protects against broken
      // `default location` references we couldn't detect with statSync.
      if (
        (result.code !== 0 || !result.stdout.trim()) &&
        result.stderr &&
        lastBrowsed &&
        !result.stdout.trim()
      ) {
        console.log('[browse-folder] Retrying without lastBrowsed seed');
        workspaceStore.setLastBrowsedPath('');
        result = await runDialog(false);
        console.log(
          '[browse-folder] Retry closed. code=',
          result.code,
          'stdout=',
          JSON.stringify(result.stdout),
          'stderr=',
          JSON.stringify(result.stderr),
        );
      }

      const path = result.stdout.trim();
      if (result.code === 0 && path) {
        workspaceStore.setLastBrowsedPath(path);
        res.json({ success: true, path });
      } else {
        res.json({
          success: false,
          cancelled: true,
          code: result.code,
          stderr: result.stderr.trim(),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[browse-folder] Failed to open folder dialog:', message);
      res.status(500).json({ success: false, error: message });
    }
  });

  // Plugin API routes
  app.get('/api/plugins', (_req, res) => {
    try {
      const plugins = pluginManager.getAllAvailablePlugins(pluginsDir);
      res.json({ success: true, plugins });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    }
  });

  // Enable a plugin
  app.post('/api/plugins/:name/enable', async (req, res) => {
    try {
      const { name } = req.params;
      logger.info(`[API] Enabling plugin: ${name}`);

      configStore.setPluginEnabled(name, true);

      // Reload plugins to activate the newly enabled plugin
      await pluginManager.discoverPlugins(pluginsDir);
      pluginManager.registerRoutes(app);

      res.json({ success: true, message: `Plugin ${name} enabled successfully` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[API] Error enabling plugin:`, { error });
      res.status(500).json({ success: false, error: message });
    }
  });

  // Disable a plugin
  app.post('/api/plugins/:name/disable', async (req, res) => {
    try {
      const { name } = req.params;
      logger.info(`[API] Disabling plugin: ${name}`);

      configStore.setPluginEnabled(name, false);

      // Note: Disabling requires a server restart to fully unload the plugin
      // For now, we just update the config
      res.json({
        success: true,
        message: `Plugin ${name} disabled. Restart server to fully unload.`,
        requiresRestart: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[API] Error disabling plugin:`, { error });
      res.status(500).json({ success: false, error: message });
    }
  });

  // HAI Proxy Plugin API routes (for frontend Settings)
  app.post('/api/hyperspace-proxy/test', async (req, res) => {
    try {
      const { proxyUrl, apiKey } = req.body;
      if (!proxyUrl || !apiKey) {
        return res.status(400).json({
          success: false,
          error: 'proxyUrl and apiKey are required',
        });
      }

      // Test connection by hitting the models endpoint
      let modelsUrl = proxyUrl;
      if (!modelsUrl.endsWith('/')) {
        modelsUrl += '/';
      }
      if (!modelsUrl.endsWith('anthropic/')) {
        modelsUrl += 'anthropic/';
      }
      modelsUrl += 'v1/models';

      const response = await fetch(modelsUrl, {
        method: 'GET',
        headers: { 'x-api-key': apiKey },
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        res.json({ success: true });
      } else {
        res.status(500).json({
          success: false,
          error: 'HAI proxy is not responding or credentials are invalid',
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to test HAI proxy connection', { error: message });
      res.status(500).json({ success: false, error: message });
    }
  });

  app.post('/api/hyperspace-proxy/models', async (req, res) => {
    try {
      const { proxyUrl, apiKey } = req.body;
      if (!proxyUrl || !apiKey) {
        return res.status(400).json({
          success: false,
          error: 'proxyUrl and apiKey are required',
        });
      }

      // Fetch models from the HAI proxy
      let modelsUrl = proxyUrl;
      if (!modelsUrl.endsWith('/')) {
        modelsUrl += '/';
      }
      if (!modelsUrl.endsWith('anthropic/')) {
        modelsUrl += 'anthropic/';
      }
      modelsUrl += 'v1/models';

      const response = await fetch(modelsUrl, {
        method: 'GET',
        headers: { 'x-api-key': apiKey },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return res.status(500).json({
          success: false,
          error: `Failed to fetch models: ${response.status} ${errorText}`,
        });
      }

      const data = await response.json();

      // Transform the response to match frontend expectations
      // Anthropic API returns { data: [...models...] }
      const models =
        data.data?.map((model: any) => ({
          id: model.id,
          name: model.display_name || model.id,
        })) || [];

      res.json({ success: true, models });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to fetch HAI proxy models', { error: message });
      res.status(500).json({ success: false, error: message });
    }
  });

  // SAP AI Core Plugin API routes (for frontend Settings)
  app.post('/api/sap-ai-core/test', async (req, res) => {
    try {
      const { clientId, clientSecret, authUrl, baseUrl, resourceGroup, timeoutMs } = req.body;

      if (!clientId || !clientSecret || !authUrl) {
        return res.status(400).json({
          success: false,
          error: 'Missing required credentials (clientId, clientSecret, authUrl)',
        });
      }

      logger.info('Testing SAP AI Core connection', {
        authUrl,
        baseUrl: baseUrl || 'not provided',
      });

      // Test by obtaining an access token
      const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const tokenUrl = `${authUrl}/oauth/token?grant_type=client_credentials`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs || 30000);

      try {
        const tokenResponse = await fetch(tokenUrl, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!tokenResponse.ok) {
          const errorText = await tokenResponse.text();
          logger.error('SAP AI Core auth failed', {
            status: tokenResponse.status,
            error: errorText,
          });
          return res.json({
            success: false,
            error: `Authentication failed: ${tokenResponse.status} - ${errorText}`,
          });
        }

        const tokenData = await tokenResponse.json();
        if (!tokenData.access_token) {
          logger.error('Invalid token response from SAP AI Core');
          return res.json({
            success: false,
            error: 'Invalid token response from auth server',
          });
        }

        // If baseUrl is provided, also test the AI Core API endpoint
        if (baseUrl) {
          const apiUrl = `${baseUrl}/v2/lm/deployments?$top=1`;
          const apiResponse = await fetch(apiUrl, {
            headers: {
              Authorization: `Bearer ${tokenData.access_token}`,
              'AI-Resource-Group': resourceGroup || 'default',
            },
          });

          if (!apiResponse.ok) {
            logger.error('SAP AI Core API access failed', { status: apiResponse.status });
            return res.json({
              success: false,
              error: `API access failed: ${apiResponse.status} - Unable to access AI Core API`,
            });
          }
        }

        logger.info('SAP AI Core connection test successful');
        res.json({
          success: true,
          message: baseUrl
            ? 'Successfully authenticated and connected to AI Core API'
            : 'Successfully authenticated with SAP AI Core',
        });
      } catch (fetchError: unknown) {
        clearTimeout(timeout);
        if (fetchError instanceof Error && fetchError.name === 'AbortError') {
          logger.error('SAP AI Core connection timeout');
          return res.json({
            success: false,
            error: 'Connection timeout - unable to reach auth server',
          });
        }
        const message = fetchError instanceof Error ? fetchError.message : String(fetchError);
        logger.error('SAP AI Core connection error', { error: message });
        return res.json({
          success: false,
          error: `Connection error: ${message}`,
        });
      }
    } catch (error: unknown) {
      logger.error('Error testing SAP AI Core credentials', { error });
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({
        success: false,
        error: `Server error: ${message}`,
      });
    }
  });

  // ===== Tunnel Management Routes =====
  app.post('/api/tunnel/start', async (_req, res) => {
    try {
      logger.info('Starting tunnel via API');
      const status = await tunnelManager.start();
      res.json(status);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to start tunnel', { error: errorMsg });
      res.status(500).json({ error: errorMsg });
    }
  });

  app.post('/api/tunnel/stop', async (_req, res) => {
    try {
      logger.info('Stopping tunnel via API');
      await tunnelManager.stop();
      res.json({ active: false });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to stop tunnel', { error: errorMsg });
      res.status(500).json({ error: errorMsg });
    }
  });

  app.get('/api/tunnel/status', (_req, res) => {
    res.json(tunnelManager.getStatus());
  });

  // ===== Mobile Route (legacy redirect) =====
  // Old /mobile route now redirects to the React app root with the token.
  // The responsive React frontend handles mobile layout automatically.
  app.get('/mobile', (req, res) => {
    let token = req.query.token as string;

    if (!token) {
      const host = req.headers.host || '';
      const tunnelStatus = tunnelManager.getStatus();

      if (isTunnelHost(host) && tunnelStatus.active && tunnelStatus.token) {
        token = tunnelStatus.token;
      } else {
        res.status(401).send('Access denied: Missing token');
        return;
      }
    }

    if (!tunnelManager.validateToken(token)) {
      res.status(401).send('Access denied: Invalid or expired token');
      return;
    }

    // Redirect to the React app with the auth token
    logger.info('Redirecting /mobile to React app', { hasToken: !!token });
    res.redirect(`/?token=${token}`);
  });

  // ===== ElevenLabs TTS Route =====
  const ELEVENLABS_VOICES: Record<string, string> = {
    charlotte: 'XB0fDUnXU5powFXDhCwa',
    verity: 'oW8bn5YtBB89X2nJ0DT9',
    george: 'JBFqnCBsd6RMkjVDRZzb',
    brian: 'nPczCjzI2devNBz1zQrb',
    jessica: 'cgSgspJ2msm6clMCkdEp',
    daisy: 'DYAWdnlYLnZyj3yWpS75',
  };

  function sanitizeTtsText(text: string): string {
    return (
      text
        // Remove markdown headings
        .replace(/#{1,6}\s/g, '')
        // Remove bold/italic markers
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        // Remove inline code
        .replace(/`(.+?)`/g, '$1')
        // Remove code blocks
        .replace(/```[\s\S]*?```/g, '')
        // Remove links, keep text
        .replace(/\[(.+?)\]\(.+?\)/g, '$1')
        // Remove common emojis/symbols that sound odd when spoken
        .replace(
          /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,
          '',
        )
        // Collapse multiple newlines
        .replace(/\n{2,}/g, '. ')
        .replace(/\n/g, ' ')
        // Collapse whitespace
        .replace(/\s{2,}/g, ' ')
        .trim()
    );
  }

  app.post('/api/tts', async (req, res) => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      logger.error('ElevenLabs API key not configured');
      res.status(500).json({ error: 'TTS not configured: missing ELEVENLABS_API_KEY' });
      return;
    }

    const { text, voice } = req.body as { text?: string; voice?: string };
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "text" field' });
      return;
    }

    const voiceName = (voice || 'charlotte').toLowerCase();
    const voiceId = ELEVENLABS_VOICES[voiceName];
    if (!voiceId) {
      res
        .status(400)
        .json({
          error: `Unknown voice "${voice}". Available: ${Object.keys(ELEVENLABS_VOICES).join(', ')}`,
        });
      return;
    }

    const cleanText = sanitizeTtsText(text);
    if (!cleanText) {
      res.status(400).json({ error: 'Text is empty after sanitization' });
      return;
    }

    logger.info('TTS request', { voice: voiceName, textLength: cleanText.length });

    try {
      const elevenLabsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text: cleanText,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      });

      if (!elevenLabsRes.ok) {
        const errBody = await elevenLabsRes.text();
        logger.error('ElevenLabs API error', { status: elevenLabsRes.status, body: errBody });
        res
          .status(elevenLabsRes.status)
          .json({ error: `ElevenLabs API error: ${elevenLabsRes.status}`, detail: errBody });
        return;
      }

      const audioBuffer = Buffer.from(await elevenLabsRes.arrayBuffer());
      logger.info('TTS response', { audioBytes: audioBuffer.length });

      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', audioBuffer.length);
      res.send(audioBuffer);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('TTS fetch failed', { error: errorMsg });
      res.status(500).json({ error: 'TTS request failed', detail: errorMsg });
    }
  });

  // Get available ElevenLabs voices
  app.get('/api/elevenlabs/voices', async (req, res) => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      logger.error('ElevenLabs API key not configured');
      res.status(500).json({ error: 'TTS not configured: missing ELEVENLABS_API_KEY' });
      return;
    }

    try {
      // @ts-ignore - ElevenLabs TTS module is optional
      const { ElevenLabsTTS } = await import('./elevenlabs-tts.js').catch(() => {
        throw new Error('ElevenLabs TTS module not available');
      });
      const tts = new ElevenLabsTTS(apiKey);
      const voices = await tts.getVoices();

      logger.info('Fetched ElevenLabs voices', { count: voices.length });
      res.json({ voices });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to fetch voices', { error: errorMsg });
      res.status(500).json({ error: 'Failed to fetch voices', detail: errorMsg });
    }
  });

  // Get preview audio for a specific voice
  app.get('/api/elevenlabs/voices/:voiceId/preview', async (req, res) => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      logger.error('ElevenLabs API key not configured');
      res.status(500).json({ error: 'TTS not configured: missing ELEVENLABS_API_KEY' });
      return;
    }

    const { voiceId } = req.params;
    const { sampleId } = req.query;

    if (!voiceId) {
      res.status(400).json({ error: 'Missing voiceId parameter' });
      return;
    }

    try {
      // @ts-ignore - ElevenLabs TTS module is optional
      const { ElevenLabsTTS } = await import('./elevenlabs-tts.js').catch(() => {
        throw new Error('ElevenLabs TTS module not available');
      });
      const tts = new ElevenLabsTTS(apiKey);
      const audioBuffer = await tts.getVoicePreview(voiceId, sampleId as string | undefined);

      logger.info('Voice preview generated', { voiceId, audioBytes: audioBuffer.length });

      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', audioBuffer.length);
      res.send(audioBuffer);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to generate voice preview', { voiceId, error: errorMsg });
      res.status(500).json({ error: 'Failed to generate voice preview', detail: errorMsg });
    }
  });

  // Usage tracking — receives the unique user ID from the frontend
  app.post('/api/user-id', (req, res) => {
    const { userId } = req.body as { userId?: string };
    if (userId && typeof userId === 'string' && userId.length > 0) {
      setUserId(userId);
    }
    res.json({ ok: true });
  });

  // Image upload configuration - store in ~/.claudia/cache/images/
  const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const claudiaCacheDir = join(homeDir, '.claudia', 'cache', 'images');
  const uploadsDir = claudiaCacheDir;
  if (!existsSync(uploadsDir)) {
    mkdirSync(uploadsDir, { recursive: true });
  }
  logger.info(`Image cache directory: ${uploadsDir}`);

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, uploadsDir);
    },
    filename: (_req, file, cb) => {
      // Generate unique filename with timestamp
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      const ext = file.originalname.split('.').pop() || 'png';
      cb(null, `image-${uniqueSuffix}.${ext}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB limit
    fileFilter: (_req, file, cb) => {
      // Allow common image types
      const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
      if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error(`Invalid file type: ${file.mimetype}. Only images are allowed.`));
      }
    },
  });

  // Image upload endpoint
  app.post('/api/upload/image', upload.single('image'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }
    const filePath = join(uploadsDir, req.file.filename);
    console.log(`[Server] Image uploaded: ${filePath}`);
    res.json({
      success: true,
      filePath,
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
    });
  });

  // Mobile-scoped image upload — same handler as /api/upload/image, but
  // gated by the tunnel auth token. Mobile clients call this when the user
  // attaches a photo to a task message; we save the bytes to the cache
  // dir and return the absolute filePath so the client can reference it
  // with "[Attached image: <filePath>]" — Claude Code reads that marker
  // and ingests the file as an image attachment, same as the desktop.
  app.post(
    '/api/mobile/upload/image',
    (req, res, next) => {
      const token =
        (req.query.token as string | undefined) ??
        (req.headers['x-mobile-token'] as string | undefined);
      if (!token || !tunnelManager.validateToken(token)) {
        return res.status(401).json({ error: 'Invalid or missing mobile token' });
      }
      return next();
    },
    upload.single('image'),
    (req, res) => {
      if (!req.file) {
        return res.status(400).json({ error: 'No image file provided' });
      }
      const filePath = join(uploadsDir, req.file.filename);
      logger.info('Mobile image uploaded', {
        filePath,
        size: req.file.size,
        mimetype: req.file.mimetype,
      });
      res.json({
        success: true,
        filePath,
        filename: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
      });
    },
  );

  // Delete uploaded image endpoint
  app.delete('/api/upload/image/:filename', (req, res) => {
    const { filename } = req.params;
    // Validate filename to prevent directory traversal
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const filePath = join(uploadsDir, filename);
    if (existsSync(filePath)) {
      try {
        unlinkSync(filePath);
        console.log(`[Server] Image deleted: ${filePath}`);
        res.json({ success: true });
      } catch (error) {
        console.error(`[Server] Error deleting image: ${error}`);
        res.status(500).json({ error: 'Failed to delete image' });
      }
    } else {
      res.status(404).json({ error: 'Image not found' });
    }
  });

  // Cleanup old uploads (files older than 24 hours)
  const cleanupOldUploads = () => {
    try {
      const files = readdirSync(uploadsDir);
      const now = Date.now();
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours
      for (const file of files) {
        const filePath = join(uploadsDir, file);
        try {
          const timestamp = parseInt(file.split('-')[1] || '0', 10);
          if (timestamp && now - timestamp > maxAge) {
            unlinkSync(filePath);
            console.log(`[Server] Cleaned up old upload: ${file}`);
          }
        } catch {
          // Ignore files that can't be parsed
        }
      }
    } catch (error) {
      console.error('[Server] Error cleaning up uploads:', error);
    }
  };
  // Run cleanup on startup and every hour
  cleanupOldUploads();
  setInterval(cleanupOldUploads, 60 * 60 * 1000);

  // One-time migration: clean up old uploads from previous {basePath}/uploads/ location
  const oldUploadsDir = join(basePath || process.cwd(), 'uploads');
  if (oldUploadsDir !== uploadsDir && existsSync(oldUploadsDir)) {
    try {
      const oldFiles = readdirSync(oldUploadsDir);
      for (const file of oldFiles) {
        try {
          unlinkSync(join(oldUploadsDir, file));
        } catch {
          /* ignore */
        }
      }
      // Try to remove the directory if empty
      try {
        rmdirSync(oldUploadsDir);
        logger.info(`Migrated: removed old uploads directory ${oldUploadsDir}`);
      } catch {
        /* directory may not be empty */
      }
    } catch (error) {
      logger.warn(`Could not clean up old uploads dir: ${error}`);
    }
  }

  // Serve cached images for frontend preview
  app.get('/api/cache/images/:filename', (req, res) => {
    const { filename } = req.params;
    // Validate filename to prevent directory traversal
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const filePath = join(uploadsDir, filename);
    if (existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      res.status(404).json({ error: 'Image not found' });
    }
  });

  // Backend status endpoint - check which backend is configured and its status
  app.get('/api/backend/status', async (_req, res) => {
    const currentBackend = configStore.getBackend();
    let status: { installed: boolean; version?: string; error?: string; serverRunning?: boolean };

    try {
      if (currentBackend === 'opencode') {
        // Check OpenCode installation
        const { execSync } = await import('child_process');
        try {
          const version = execSync('opencode --version', {
            encoding: 'utf8',
            timeout: 5000,
          }).trim();

          // Check if server is running
          let serverRunning = false;
          const port = configStore.getOpencodePort();
          try {
            const response = await fetch(`http://127.0.0.1:${port}/global/health`, {
              signal: AbortSignal.timeout(2000),
            });
            serverRunning = response.ok;
          } catch {
            serverRunning = false;
          }

          status = { installed: true, version, serverRunning };
        } catch {
          status = {
            installed: false,
            error: 'OpenCode is not installed. Install from: https://opencode.ai',
          };
        }
      } else {
        // Check Claude Code installation
        const { execSync } = await import('child_process');
        try {
          const version = execSync('claude --version', { encoding: 'utf8', timeout: 5000 }).trim();
          status = { installed: true, version };
        } catch {
          status = {
            installed: false,
            error: 'Claude Code is not installed. Install from: https://claude.ai/code',
          };
        }
      }
    } catch (error) {
      status = { installed: false, error: 'Failed to check backend status' };
    }

    res.json({
      backend: currentBackend,
      ...status,
      availableBackends: ['claude-code', 'opencode'],
    });
  });

  // System stats endpoint for CPU and memory monitoring
  let lastCpuInfo = os.cpus();
  let lastCpuTime = Date.now();

  app.get('/api/system/stats', (_req, res) => {
    const currentCpuInfo = os.cpus();
    const currentTime = Date.now();

    // Calculate CPU usage since last call
    let totalIdleDiff = 0;
    let totalTickDiff = 0;

    for (let i = 0; i < currentCpuInfo.length; i++) {
      const currentCpu = currentCpuInfo[i];
      const lastCpu = lastCpuInfo[i] || currentCpu;

      const currentTotal =
        currentCpu.times.user +
        currentCpu.times.nice +
        currentCpu.times.sys +
        currentCpu.times.idle +
        currentCpu.times.irq;
      const lastTotal =
        lastCpu.times.user +
        lastCpu.times.nice +
        lastCpu.times.sys +
        lastCpu.times.idle +
        lastCpu.times.irq;

      totalIdleDiff += currentCpu.times.idle - lastCpu.times.idle;
      totalTickDiff += currentTotal - lastTotal;
    }

    // Update for next call
    lastCpuInfo = currentCpuInfo;
    lastCpuTime = currentTime;

    // Calculate CPU percentage
    const cpuUsage =
      totalTickDiff > 0 ? Math.round(100 - (totalIdleDiff / totalTickDiff) * 100) : 0;

    // Get memory info
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;

    res.json({
      cpu: Math.max(0, Math.min(100, cpuUsage)),
      memory: {
        used: usedMemory,
        total: totalMemory,
        percent: Math.round((usedMemory / totalMemory) * 100),
      },
    });
  });

  app.get('/api/tasks', (req, res) => {
    const includeArchived = req.query.includeArchived === 'true';
    const workspaceId = req.query.workspaceId as string | undefined;

    if (includeArchived && workspaceId) {
      // Get all tasks (active + disconnected) for this workspace
      const allTasks = taskSpawner.getAllTasks().filter((t) => t.workspaceId === workspaceId);
      // Get archived tasks for this workspace
      const archivedTasks = taskSpawner
        .getArchivedTasks()
        .filter((t) => t.workspaceId === workspaceId);
      res.json([...allTasks, ...archivedTasks]);
    } else if (includeArchived) {
      // Get all tasks including archived
      const allTasks = taskSpawner.getAllTasks();
      const archivedTasks = taskSpawner.getArchivedTasks();
      res.json([...allTasks, ...archivedTasks]);
    } else {
      // Original behavior - only active + disconnected tasks
      res.json(taskSpawner.getAllTasks());
    }
  });

  // Poll endpoint for task status - returns stored state (Stop hook manages transitions)
  app.get('/api/tasks/:taskId/status', (req, res) => {
    const { taskId } = req.params;

    const state = taskSpawner.getTaskState(taskId);

    if (!state) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = taskSpawner.getTask(taskId);

    res.json({
      id: taskId,
      state,
      lastActivity: task?.lastActivity,
    });
  });

  // Debug endpoint for task output analysis
  app.get('/api/tasks/:taskId/debug', (req, res) => {
    const { taskId } = req.params;
    const task = taskSpawner.getTask(taskId);

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Get the raw output for debugging
    const recentOutput = taskSpawner.getRecentOutputForDebug(taskId, 2048);

    res.json({
      taskId,
      state: task.state,
      outputLength: recentOutput.length,
      last200Chars: recentOutput.slice(-200),
      lastActivity: task.lastActivity,
    });
  });

  // Get task output - returns recent terminal output for a task
  // Used by the Claudia MCP server to let agents read sibling task output
  app.get('/api/tasks/:taskId/output', (req, res) => {
    const { taskId } = req.params;
    const maxBytes = Math.min(parseInt(req.query.maxBytes as string) || 8192, 32768);
    const task = taskSpawner.getTask(taskId);

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const output = taskSpawner.getRecentOutputForDebug(taskId, maxBytes);

    res.json({
      taskId,
      state: task.state,
      prompt: task.prompt,
      workspaceId: task.workspaceId,
      output,
      lastActivity: task.lastActivity,
    });
  });

  // ===== Scheduled Tasks (Cron) REST API =====

  // List scheduled tasks for a specific task (or all if no taskId)
  app.get('/api/tasks/:taskId/cron', (req, res) => {
    const { taskId } = req.params;
    const scheduled = cronScheduler.list(taskId);
    res.json(
      scheduled.map((s) => ({
        ...s,
        description: describeCronExpression(s.cronExpression),
      })),
    );
  });

  // List all scheduled tasks
  app.get('/api/cron', (_req, res) => {
    const scheduled = cronScheduler.list();
    res.json(
      scheduled.map((s) => ({
        ...s,
        description: describeCronExpression(s.cronExpression),
      })),
    );
  });

  // Create a scheduled task
  app.post('/api/tasks/:taskId/cron', (req, res) => {
    const { taskId } = req.params;
    const { cronExpression, prompt, isRecurring } = req.body;

    if (!cronExpression || !prompt) {
      return res.status(400).json({ error: 'cronExpression and prompt are required' });
    }

    const task =
      taskSpawner.getTask(taskId) || taskSpawner.getAllTasks().find((t) => t.id === taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    try {
      const scheduled = cronScheduler.create(
        taskId,
        task.workspaceId,
        cronExpression,
        prompt,
        isRecurring !== false,
      );
      res.json({
        ...scheduled,
        description: describeCronExpression(cronExpression),
      });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Delete a scheduled task
  app.delete('/api/cron/:cronId', (req, res) => {
    const { cronId } = req.params;
    const deleted = cronScheduler.delete(cronId);
    if (deleted) {
      res.json({ success: true, cronId });
    } else {
      res.status(404).json({ error: 'Scheduled task not found' });
    }
  });

  // Update a scheduled task
  app.put('/api/cron/:cronId', (req, res) => {
    const { cronId } = req.params;
    const { cronExpression, prompt, isRecurring, isPaused } = req.body;

    try {
      const updated = cronScheduler.update(cronId, {
        cronExpression,
        prompt,
        isRecurring,
        isPaused,
      });
      if (updated) {
        res.json({
          ...updated,
          description: describeCronExpression(updated.cronExpression),
        });
      } else {
        res.status(404).json({ error: 'Scheduled task not found' });
      }
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Preview proxy — forward requests to a workspace's dev server port
  app.use('/api/preview/:port', (req, res) => {
    const port = parseInt(req.params.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      return res.status(400).send('Invalid port');
    }
    if (port === PORTS.BACKEND) {
      return res.status(403).send('Cannot proxy to Claudia backend port');
    }

    const targetPath = req.url || '/';
    const proxyReq = httpRequest(
      {
        hostname: 'localhost',
        port,
        path: targetPath,
        method: req.method,
        headers: { ...req.headers, host: `localhost:${port}` },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ECONNREFUSED') {
        return res.status(502).send(`Dev server not running on port ${port}`);
      }
      logger.error('Preview proxy error', { error: err.message, port, path: targetPath });
      res.status(502).send('Preview proxy error');
    });
    req.pipe(proxyReq);
  });

  app.get('/api/workspaces', (_req, res) => {
    res.json({ workspaces: workspaceStore.getWorkspaces() });
  });

  // File explorer endpoint - list files and directories for a workspace
  app.get('/api/workspaces/files', async (req, res) => {
    const workspacePath = req.query.workspace as string;
    const subPath = (req.query.path as string) || '';

    if (!workspacePath) {
      return res.status(400).json({ error: 'workspace query parameter is required' });
    }

    // Resolve the target directory
    const targetDir = subPath ? join(workspacePath, subPath) : workspacePath;

    // Security: ensure the resolved path is within the workspace
    const resolvedTarget = resolve(targetDir);
    const resolvedWorkspace = resolve(workspacePath);
    if (!resolvedTarget.startsWith(resolvedWorkspace)) {
      return res.status(403).json({ error: 'Path traversal not allowed' });
    }

    if (!existsSync(resolvedTarget)) {
      return res.status(404).json({ error: 'Directory not found' });
    }

    // Directories to skip entirely
    const IGNORED_DIRS = new Set([
      'node_modules',
      '.git',
      '.svn',
      '.hg',
      '__pycache__',
      '.next',
      '.nuxt',
      'dist',
      'build',
      '.cache',
      '.parcel-cache',
      'coverage',
      '.nyc_output',
      '.tox',
      '.venv',
      'venv',
      '.idea',
      '.vscode',
      '.vs',
      'vendor',
      'target',
      '.terraform',
      '.serverless',
      '.angular',
    ]);

    // Files to skip
    const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

    try {
      const entries = await readdir(resolvedTarget, { withFileTypes: true });
      const items: Array<{
        name: string;
        type: 'file' | 'directory';
        path: string;
        size?: number;
        childCount?: number;
      }> = [];

      for (const entry of entries) {
        // Skip hidden files/dirs (starting with .) except important config files
        const isHiddenButImportant = [
          '.env',
          '.gitignore',
          '.npmrc',
          '.eslintrc',
          '.prettierrc',
          '.editorconfig',
          '.claude',
        ].includes(entry.name);
        if (entry.name.startsWith('.') && !isHiddenButImportant) {
          continue;
        }

        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue;
          const dirRelPath = subPath ? `${subPath}/${entry.name}` : entry.name;
          // Count children for the directory (shallow)
          let childCount = 0;
          try {
            const children = readdirSync(join(resolvedTarget, entry.name));
            childCount = children.filter((c) => !IGNORED_FILES.has(c)).length;
          } catch {
            // Permission denied or other error
          }
          items.push({
            name: entry.name,
            type: 'directory',
            path: dirRelPath,
            childCount,
          });
        } else if (entry.isFile()) {
          if (IGNORED_FILES.has(entry.name)) continue;
          const fileRelPath = subPath ? `${subPath}/${entry.name}` : entry.name;
          let size = 0;
          try {
            const stat = statSync(join(resolvedTarget, entry.name));
            size = stat.size;
          } catch {
            // Permission denied
          }
          items.push({
            name: entry.name,
            type: 'file',
            path: fileRelPath,
            size,
          });
        }
      }

      // Sort: directories first, then files, both alphabetically
      items.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });

      res.json({
        path: subPath || '.',
        workspace: workspacePath,
        items,
      });
    } catch (err) {
      logger.error('Failed to list files', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to list directory contents' });
    }
  });

  // File operations endpoints
  app.post('/api/workspaces/files/copy', async (req, res) => {
    const { workspace, sourcePath, destinationPath } = req.body;

    if (!workspace || !sourcePath || !destinationPath) {
      return res
        .status(400)
        .json({ error: 'workspace, sourcePath, and destinationPath are required' });
    }

    const resolvedWorkspace = resolve(workspace);
    const resolvedSource = resolve(workspace, sourcePath);
    const resolvedDest = resolve(workspace, destinationPath);

    // Security: ensure paths are within workspace
    if (
      !resolvedSource.startsWith(resolvedWorkspace) ||
      !resolvedDest.startsWith(resolvedWorkspace)
    ) {
      return res.status(403).json({ error: 'Path traversal not allowed' });
    }

    if (!existsSync(resolvedSource)) {
      return res.status(404).json({ error: 'Source file not found' });
    }

    try {
      const fs = await import('fs/promises');
      const stat = await fs.stat(resolvedSource);

      if (stat.isDirectory()) {
        // Copy directory recursively
        await fs.cp(resolvedSource, resolvedDest, { recursive: true });
      } else {
        // Copy file
        await fs.copyFile(resolvedSource, resolvedDest);
      }

      logger.info('File/directory copied', { source: sourcePath, destination: destinationPath });
      res.json({ success: true, message: 'File/directory copied successfully' });
    } catch (err) {
      logger.error('Failed to copy file/directory', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to copy file/directory' });
    }
  });

  app.post('/api/workspaces/files/move', async (req, res) => {
    const { workspace, sourcePath, destinationPath } = req.body;

    if (!workspace || !sourcePath || !destinationPath) {
      return res
        .status(400)
        .json({ error: 'workspace, sourcePath, and destinationPath are required' });
    }

    const resolvedWorkspace = resolve(workspace);
    const resolvedSource = resolve(workspace, sourcePath);
    const resolvedDest = resolve(workspace, destinationPath);

    // Security: ensure paths are within workspace
    if (
      !resolvedSource.startsWith(resolvedWorkspace) ||
      !resolvedDest.startsWith(resolvedWorkspace)
    ) {
      return res.status(403).json({ error: 'Path traversal not allowed' });
    }

    if (!existsSync(resolvedSource)) {
      return res.status(404).json({ error: 'Source file not found' });
    }

    try {
      const fs = await import('fs/promises');
      await fs.rename(resolvedSource, resolvedDest);

      logger.info('File/directory moved', { source: sourcePath, destination: destinationPath });
      res.json({ success: true, message: 'File/directory moved successfully' });
    } catch (err) {
      logger.error('Failed to move file/directory', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to move file/directory' });
    }
  });

  app.post('/api/workspaces/files/copy', async (req, res) => {
    const { workspace, sourcePath, destinationPath } = req.body;

    if (!workspace || !sourcePath || !destinationPath) {
      return res
        .status(400)
        .json({ error: 'workspace, sourcePath, and destinationPath are required' });
    }

    const resolvedWorkspace = resolve(workspace);
    const resolvedSource = resolve(workspace, sourcePath);
    const resolvedDest = resolve(workspace, destinationPath);

    // Security: ensure paths are within workspace
    if (
      !resolvedSource.startsWith(resolvedWorkspace) ||
      !resolvedDest.startsWith(resolvedWorkspace)
    ) {
      return res.status(403).json({ error: 'Path traversal not allowed' });
    }

    if (!existsSync(resolvedSource)) {
      return res.status(404).json({ error: 'Source file not found' });
    }

    try {
      const fs = await import('fs/promises');
      const stat = await fs.stat(resolvedSource);

      if (stat.isDirectory()) {
        // Copy directory recursively
        await fs.cp(resolvedSource, resolvedDest, { recursive: true });
      } else {
        // Copy file
        await fs.copyFile(resolvedSource, resolvedDest);
      }

      logger.info('File/directory copied', { source: sourcePath, destination: destinationPath });
      res.json({ success: true, message: 'File/directory copied successfully' });
    } catch (err) {
      logger.error('Failed to copy file/directory', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to copy file/directory' });
    }
  });

  app.delete('/api/workspaces/files', async (req, res) => {
    const { workspace, path } = req.body;

    if (!workspace || !path) {
      return res.status(400).json({ error: 'workspace and path are required' });
    }

    const resolvedWorkspace = resolve(workspace);
    const resolvedPath = resolve(workspace, path);

    // Security: ensure path is within workspace
    if (!resolvedPath.startsWith(resolvedWorkspace)) {
      return res.status(403).json({ error: 'Path traversal not allowed' });
    }

    if (!existsSync(resolvedPath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    try {
      const fs = await import('fs/promises');
      const stat = await fs.stat(resolvedPath);

      if (stat.isDirectory()) {
        // Delete directory recursively
        await fs.rm(resolvedPath, { recursive: true, force: true });
      } else {
        // Delete file
        await fs.unlink(resolvedPath);
      }

      logger.info('File/directory deleted', { path });
      res.json({ success: true, message: 'File/directory deleted successfully' });
    } catch (err) {
      logger.error('Failed to delete file/directory', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to delete file/directory' });
    }
  });

  app.post('/api/workspaces/files/reveal', async (req, res) => {
    const { workspace, path } = req.body;

    if (!workspace || !path) {
      return res.status(400).json({ error: 'workspace and path are required' });
    }

    const resolvedWorkspace = resolve(workspace);
    const resolvedPath = resolve(workspace, path);

    // Security: ensure path is within workspace
    if (!resolvedPath.startsWith(resolvedWorkspace)) {
      return res.status(403).json({ error: 'Path traversal not allowed' });
    }

    if (!existsSync(resolvedPath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);

      const platform = process.platform;

      if (platform === 'darwin') {
        // macOS: reveal in Finder — -R flag with path as separate arg
        await execFileAsync('open', ['-R', resolvedPath]);
      } else if (platform === 'win32') {
        // Windows: reveal in Explorer — /select with backslash path
        await execFileAsync('explorer.exe', [`/select,${resolvedPath.replace(/\//g, '\\')}`]);
      } else {
        // Linux: open parent directory in file manager
        const parentDir = dirname(resolvedPath);
        await execFileAsync('xdg-open', [parentDir]);
      }

      logger.info('File revealed in file manager', { path });
      res.json({ success: true, message: 'File revealed successfully' });
    } catch (err) {
      logger.error('Failed to reveal file', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to reveal file' });
    }
  });

  // Git status endpoint — uncommitted changes for a workspace
  app.get('/api/workspaces/git-status', async (req, res) => {
    const workspacePath = req.query.workspace as string;
    if (!workspacePath) {
      return res.status(400).json({ error: 'workspace query parameter is required' });
    }
    if (!existsSync(workspacePath)) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    try {
      const { execFile: execFileGit } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFileGit);
      // Prevent git from hanging on auth prompts or credential helpers
      const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' };
      const gitOpts = { cwd: workspacePath, env: gitEnv, timeout: 5000 };

      // Check if it's a git repo
      try {
        await execFileAsync('git', ['rev-parse', '--git-dir'], gitOpts);
      } catch {
        return res.json({ isGitRepo: false, branch: null, changes: [] });
      }

      // Get current branch
      let branch = '';
      try {
        const { stdout } = await execFileAsync('git', ['branch', '--show-current'], gitOpts);
        branch = stdout.trim();
      } catch {
        branch = 'HEAD';
      }

      // Get status with porcelain format
      const { stdout: statusOutput } = await execFileAsync(
        'git',
        ['status', '--porcelain'],
        gitOpts,
      );
      // Split on newlines WITHOUT trimming the full output first — trim() would strip the
      // leading space from the first porcelain line (e.g. " M path") shifting all indices
      // by one, which corrupts the XY status codes and drops the first path character.
      const changes = statusOutput
        .split('\n')
        .map((line) => line.replace(/\r$/, '')) // strip Windows CR if present
        .filter((line) => line.length > 2)
        .map((line) => {
          const staged = line[0];
          const unstaged = line[1];
          const filePath = line.substring(3);
          // Determine status
          let status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' = 'modified';
          let isStaged = false;
          if (staged === '?' && unstaged === '?') {
            status = 'untracked';
          } else if (staged === 'A') {
            status = 'added';
            isStaged = true;
          } else if (staged === 'D' || unstaged === 'D') {
            status = 'deleted';
            isStaged = staged === 'D';
          } else if (staged === 'R') {
            status = 'renamed';
            isStaged = true;
          } else if (staged === 'M') {
            status = 'modified';
            isStaged = true;
          } else if (unstaged === 'M') {
            status = 'modified';
            isStaged = false;
          }
          return { path: filePath, status, staged: isStaged };
        });

      // Get ahead/behind counts from local tracking data only — no network calls
      let ahead = 0;
      let behind = 0;
      try {
        const { stdout: abOutput } = await execFileAsync(
          'git',
          ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
          gitOpts,
        );
        const parts = abOutput.trim().split(/\s+/);
        ahead = parseInt(parts[0], 10) || 0;
        behind = parseInt(parts[1], 10) || 0;
      } catch {
        // No upstream configured or upstream not reachable
      }

      res.json({ isGitRepo: true, branch, changes, ahead, behind });
    } catch (err) {
      logger.error('Failed to get git status', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to get git status' });
    }
  });

  // Git branches endpoint - list local branches
  app.get('/api/workspaces/git-branches', async (req, res) => {
    const workspacePath = req.query.workspace as string;
    if (!workspacePath) {
      return res.status(400).json({ error: 'workspace query parameter is required' });
    }
    if (!existsSync(workspacePath)) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    try {
      const { execFile: execFileGit } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFileGit);
      const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' };
      const gitOpts = { cwd: workspacePath, env: gitEnv, timeout: 5000 };

      // Check if it's a git repo
      try {
        await execFileAsync('git', ['rev-parse', '--git-dir'], gitOpts);
      } catch {
        return res.json({ branches: [], current: null });
      }

      // Get current branch
      let current = '';
      try {
        const { stdout } = await execFileAsync('git', ['branch', '--show-current'], gitOpts);
        current = stdout.trim();
      } catch {
        current = 'HEAD';
      }

      // Get all local branches
      const { stdout: branchOutput } = await execFileAsync(
        'git',
        ['branch', '--format=%(refname:short)'],
        gitOpts,
      );
      const branches = branchOutput
        .split('\n')
        .map((b) => b.trim())
        .filter(Boolean);

      res.json({ branches, current });
    } catch (err) {
      logger.error('Failed to list git branches', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to list git branches' });
    }
  });

  // Git checkout endpoint - switch branch
  app.post('/api/workspaces/git-checkout', async (req, res) => {
    const { workspace: workspacePath, branch } = req.body;
    if (!workspacePath || !branch) {
      return res.status(400).json({ error: 'workspace and branch are required' });
    }
    if (!existsSync(workspacePath)) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    try {
      const { execFile: execFileGit } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFileGit);
      const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' };
      const gitOpts = { cwd: workspacePath, env: gitEnv, timeout: 10000 };

      await execFileAsync('git', ['checkout', branch], gitOpts);

      // Return the new current branch
      const { stdout } = await execFileAsync('git', ['branch', '--show-current'], gitOpts);
      res.json({ success: true, branch: stdout.trim() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Failed to checkout branch', { error: message });
      res.status(500).json({ error: message });
    }
  });

  // Git log endpoint - get commit history
  app.get('/api/workspaces/git-log', async (req, res) => {
    const workspacePath = req.query.workspace as string;
    const count = parseInt(req.query.count as string, 10) || 50;
    if (!workspacePath) {
      return res.status(400).json({ error: 'workspace query parameter is required' });
    }
    if (!existsSync(workspacePath)) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    try {
      const execAsync = (await import('util')).promisify((await import('child_process')).exec);

      // Check if it's a git repo
      try {
        await execAsync('git rev-parse --git-dir', { cwd: workspacePath });
      } catch {
        return res.json({ commits: [] });
      }

      const separator = '---COMMIT_SEP---';
      const format = `%H${separator}%h${separator}%an${separator}%aI${separator}%s`;
      const { stdout } = await execAsync(
        `git log --pretty=format:"${format}" -n ${Math.min(count, 200)}`,
        { cwd: workspacePath, maxBuffer: 1024 * 1024 },
      );

      const commits = stdout
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => {
          const parts = line.split(separator);
          return {
            hash: parts[0] || '',
            shortHash: parts[1] || '',
            author: parts[2] || '',
            date: parts[3] || '',
            message: parts[4] || '',
          };
        });

      res.json({ commits });
    } catch (err) {
      logger.error('Failed to get git log', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to get git log' });
    }
  });

  // CI/CD checks endpoint - get PR check status from GitHub
  app.get('/api/workspaces/ci-status', async (req, res) => {
    const workspacePath = req.query.workspace as string;
    if (!workspacePath) {
      return res.status(400).json({ error: 'workspace query parameter is required' });
    }
    if (!existsSync(workspacePath)) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    try {
      const execAsync = (await import('util')).promisify((await import('child_process')).exec);

      // Check if it's a git repo
      try {
        await execAsync('git rev-parse --git-dir', { cwd: workspacePath });
      } catch {
        return res.json({ isGitRepo: false, checks: [], prNumber: null, prUrl: null });
      }

      // Get current branch
      let branch = '';
      try {
        const { stdout } = await execAsync('git branch --show-current', { cwd: workspacePath });
        branch = stdout.trim();
      } catch {
        return res.json({
          isGitRepo: true,
          checks: [],
          prNumber: null,
          prUrl: null,
          error: 'Cannot determine branch',
        });
      }

      // Get remote URL to determine owner/repo
      let owner = '';
      let repo = '';
      try {
        const { stdout } = await execAsync('git remote get-url origin', { cwd: workspacePath });
        const url = stdout.trim();
        // Parse GitHub URL: https://github.com/owner/repo.git or git@github.com:owner/repo.git
        const httpsMatch = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
        if (httpsMatch) {
          owner = httpsMatch[1];
          repo = httpsMatch[2];
        }
      } catch {
        return res.json({
          isGitRepo: true,
          checks: [],
          prNumber: null,
          prUrl: null,
          error: 'No remote origin',
        });
      }

      if (!owner || !repo) {
        return res.json({
          isGitRepo: true,
          checks: [],
          prNumber: null,
          prUrl: null,
          error: 'Not a GitHub repository',
        });
      }

      // Use gh CLI to get PR info and checks
      let prNumber: number | null = null;
      let prUrl: string | null = null;
      let prState: string | null = null;
      let prTitle: string | null = null;
      let prBody: string | null = null;
      interface PRComment {
        author: string;
        body: string;
        createdAt: string;
        url: string;
      }
      let prComments: PRComment[] = [];

      try {
        const { stdout: prOutput } = await execAsync(
          `gh pr view --json number,url,state,title,body`,
          { cwd: workspacePath },
        );
        const prData = JSON.parse(prOutput.trim());
        prNumber = prData.number;
        prUrl = prData.url;
        prState = prData.state;
        prTitle = prData.title || null;
        prBody = prData.body || null;
      } catch {
        // No PR for this branch
      }

      // Get PR comments if PR exists
      if (prNumber) {
        try {
          const { stdout: commentsOutput } = await execAsync(
            `gh pr view --json comments --jq '.comments'`,
            { cwd: workspacePath },
          );
          const commentsData = JSON.parse(commentsOutput.trim());
          prComments = (commentsData || []).map(
            (c: { author: { login: string }; body: string; createdAt: string; url?: string }) => ({
              author: c.author?.login || 'unknown',
              body: c.body || '',
              createdAt: c.createdAt || '',
              url: c.url || '',
            }),
          );
        } catch {
          // Failed to get comments
        }
      }

      // Get check runs for current branch
      interface CICheck {
        name: string;
        status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'pending' | 'neutral';
        conclusion: string | null;
        startedAt: string | null;
        completedAt: string | null;
        url: string | null;
      }
      let checks: CICheck[] = [];

      try {
        const { stdout: checksOutput } = await execAsync(`gh pr checks --json name,state,link`, {
          cwd: workspacePath,
        });
        const checksData = JSON.parse(checksOutput);
        checks = checksData.map((c: { name: string; state: string; link: string }) => {
          let status: CICheck['status'] = 'pending';
          let conclusion: string | null = null;
          const state = c.state?.toUpperCase();

          if (state === 'SUCCESS' || state === 'PASS') {
            status = 'completed';
            conclusion = 'success';
          } else if (state === 'FAILURE' || state === 'FAIL' || state === 'ERROR') {
            status = 'completed';
            conclusion = 'failure';
          } else if (state === 'PENDING') {
            status = 'pending';
          } else if (state === 'SKIPPING' || state === 'SKIPPED') {
            status = 'completed';
            conclusion = 'skipped';
          } else if (state === 'CANCELLED') {
            status = 'completed';
            conclusion = 'cancelled';
          } else {
            status = 'in_progress';
          }

          return {
            name: c.name,
            status,
            conclusion,
            startedAt: null,
            completedAt: null,
            url: c.link || null,
          };
        });
      } catch {
        // gh pr checks failed — no PR or no checks
      }

      res.json({
        isGitRepo: true,
        branch,
        owner,
        repo,
        prNumber,
        prUrl,
        prState,
        prTitle,
        prBody,
        prComments,
        checks,
      });
    } catch (err) {
      logger.error('Failed to get CI status', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to get CI status' });
    }
  });

  // Update PR description
  app.patch('/api/workspaces/pr-description', async (req, res) => {
    const { workspace, body: prBody } = req.body;
    if (!workspace) {
      return res.status(400).json({ error: 'workspace is required' });
    }
    if (typeof prBody !== 'string') {
      return res.status(400).json({ error: 'body is required' });
    }
    try {
      const execAsync = (await import('util')).promisify((await import('child_process')).exec);
      const os = await import('os');
      const path = await import('path');
      const fs = await import('fs/promises');
      const tmpFile = path.join(os.tmpdir(), `pr-body-${Date.now()}.md`);
      await fs.writeFile(tmpFile, prBody, 'utf-8');
      try {
        await execAsync(`gh pr edit --body-file "${tmpFile}"`, {
          cwd: workspace,
          maxBuffer: 10 * 1024 * 1024,
        });
        res.json({ success: true });
      } finally {
        await fs.unlink(tmpFile).catch(() => {});
      }
    } catch (err) {
      logger.error('Failed to update PR description', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to update PR description' });
    }
  });

  // GitHub Issues endpoint
  app.get('/api/workspaces/github-issues', async (req, res) => {
    const workspacePath = req.query.workspace as string;
    const state = (req.query.state as string) || 'open'; // open, closed, all
    const limit = parseInt(req.query.limit as string) || 30;
    const assignee = req.query.assignee as string; // @me for current user, username, or empty

    if (!workspacePath) {
      return res.status(400).json({ error: 'workspace query parameter is required' });
    }
    if (!existsSync(workspacePath)) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    try {
      const execAsync = (await import('util')).promisify((await import('child_process')).exec);

      // Check if it's a git repo
      try {
        await execAsync('git rev-parse --git-dir', { cwd: workspacePath });
      } catch {
        return res.json({ isGitRepo: false, issues: [] });
      }

      // Get remote URL to determine owner/repo
      // Prefer public github.com remotes over GitHub Enterprise
      let owner = '';
      let repo = '';
      try {
        // Get all remotes
        const { stdout: remotesOutput } = await execAsync('git remote', { cwd: workspacePath });
        const remotes = remotesOutput
          .trim()
          .split('\n')
          .filter((r) => r.length > 0);

        // Try to find a github.com remote first
        let foundUrl = '';
        for (const remote of remotes) {
          try {
            const { stdout } = await execAsync(`git remote get-url ${remote}`, {
              cwd: workspacePath,
            });
            const url = stdout.trim();
            if (url.includes('github.com')) {
              foundUrl = url;
              break;
            }
            // Keep first GitHub URL as fallback
            if (!foundUrl && url.match(/github[^:/]*[:/]/)) {
              foundUrl = url;
            }
          } catch {
            continue;
          }
        }

        if (foundUrl) {
          // Parse GitHub URL (supports github.com and GitHub Enterprise)
          const match = foundUrl.match(/github[^:/]*[:/]([^/]+)\/([^/.]+)/);
          if (match) {
            owner = match[1];
            repo = match[2];
          }
        }
      } catch {
        return res.json({ isGitRepo: true, issues: [], error: 'No remote origin' });
      }

      if (!owner || !repo) {
        return res.json({ isGitRepo: true, issues: [], error: 'Not a GitHub repository' });
      }

      // Check if gh CLI is installed
      try {
        await execAsync('gh --version', { cwd: workspacePath });
      } catch {
        return res.json({
          isGitRepo: true,
          owner,
          repo,
          issues: [],
          error: 'gh CLI not installed. Install from https://cli.github.com',
        });
      }

      // Fetch issues using gh CLI
      interface GitHubIssue {
        number: number;
        title: string;
        state: string;
        url: string;
        createdAt: string;
        updatedAt: string;
        closedAt: string | null;
        author: { login: string };
        assignees: { login: string }[];
        labels: { name: string; color: string }[];
        comments: number;
        body: string;
      }

      // Validate state against an allowlist before passing to gh
      if (!['open', 'closed', 'all'].includes(state)) {
        return res.status(400).json({ error: 'state must be "open", "closed", or "all"' });
      }
      // Validate assignee: allow @me or a GitHub username (alphanumerics + dashes, max 39 chars)
      if (assignee && assignee !== '@me' && !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/.test(assignee)) {
        return res.status(400).json({ error: 'Invalid assignee' });
      }

      let issues: GitHubIssue[] = [];
      try {
        const { execFile } = await import('child_process');
        const execFileAsync = (await import('util')).promisify(execFile);
        const ghArgs = [
          'issue',
          'list',
          '--repo',
          `${owner}/${repo}`,
          '--state',
          state,
          '--limit',
          String(limit),
          '--json',
          'number,title,state,url,createdAt,updatedAt,closedAt,author,assignees,labels,comments,body',
        ];
        if (assignee) {
          ghArgs.push('--assignee', assignee);
        }
        const { stdout } = await execFileAsync('gh', ghArgs, { cwd: workspacePath });
        issues = JSON.parse(stdout);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        // Check if it's an auth error
        if (errorMsg.includes('authentication') || errorMsg.includes('HTTP 401')) {
          return res.json({
            isGitRepo: true,
            owner,
            repo,
            issues: [],
            error: 'GitHub authentication required. Run: gh auth login',
          });
        }
        return res.json({
          isGitRepo: true,
          owner,
          repo,
          issues: [],
          error: errorMsg.includes('Could not resolve to a Repository')
            ? 'Repository not found or no access'
            : 'Failed to fetch issues',
        });
      }

      res.json({
        isGitRepo: true,
        owner,
        repo,
        issues,
      });
    } catch (err) {
      logger.error('Failed to get GitHub issues', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to get GitHub issues' });
    }
  });

  // Create GitHub Issue endpoint
  app.post('/api/workspaces/github-issues', async (req, res) => {
    const workspacePath = req.body.workspace as string;
    const title = req.body.title as string;
    const body = (req.body.body as string) || '';

    if (!workspacePath) {
      return res.status(400).json({ error: 'workspace is required' });
    }
    if (!title || title.trim().length === 0) {
      return res.status(400).json({ error: 'title is required' });
    }
    if (!existsSync(workspacePath)) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    try {
      const execAsync = (await import('util')).promisify((await import('child_process')).exec);

      // Check if it's a git repo
      try {
        await execAsync('git rev-parse --git-dir', { cwd: workspacePath });
      } catch {
        return res.status(400).json({ error: 'Not a git repository' });
      }

      // Get remote URL to determine owner/repo
      let owner = '';
      let repo = '';
      try {
        // Get all remotes
        const { stdout: remotesOutput } = await execAsync('git remote', { cwd: workspacePath });
        const remotes = remotesOutput
          .trim()
          .split('\n')
          .filter((r) => r.length > 0);

        // Try to find a github.com remote first
        let foundUrl = '';
        for (const remote of remotes) {
          try {
            const { stdout } = await execAsync(`git remote get-url ${remote}`, {
              cwd: workspacePath,
            });
            const url = stdout.trim();
            if (url.includes('github.com')) {
              foundUrl = url;
              break;
            }
            // Keep first GitHub URL as fallback
            if (!foundUrl && url.match(/github[^:/]*[:/]/)) {
              foundUrl = url;
            }
          } catch {
            continue;
          }
        }

        if (foundUrl) {
          // Parse GitHub URL (supports github.com and GitHub Enterprise)
          const match = foundUrl.match(/github[^:/]*[:/]([^/]+)\/([^/.]+)/);
          if (match) {
            owner = match[1];
            repo = match[2];
          }
        }
      } catch {
        return res.status(400).json({ error: 'No remote origin' });
      }

      if (!owner || !repo) {
        return res.status(400).json({ error: 'Not a GitHub repository' });
      }

      // Check if gh CLI is installed
      try {
        await execAsync('gh --version', { cwd: workspacePath });
      } catch {
        return res
          .status(400)
          .json({ error: 'gh CLI not installed. Install from https://cli.github.com' });
      }

      // Create issue using gh CLI
      try {
        const { execFile } = await import('child_process');
        const execFileAsync = (await import('util')).promisify(execFile);
        // gh CLI requires --body when running non-interactively, so provide empty string if not given
        const bodyText = body || '';
        // Auto-assign to current user (@me)
        const { stdout } = await execFileAsync(
          'gh',
          [
            'issue',
            'create',
            '--repo',
            `${owner}/${repo}`,
            '--title',
            title,
            '--body',
            bodyText,
            '--assignee',
            '@me',
          ],
          { cwd: workspacePath },
        );
        // gh issue create returns the URL of the created issue
        const issueUrl = stdout.trim();
        // Extract issue number from URL (e.g., https://github.com/owner/repo/issues/123)
        const match = issueUrl.match(/\/issues\/(\d+)$/);
        const issueNumber = match ? parseInt(match[1], 10) : null;

        res.json({
          success: true,
          issue: {
            number: issueNumber,
            url: issueUrl,
          },
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        // Check if it's an auth error
        if (errorMsg.includes('authentication') || errorMsg.includes('HTTP 401')) {
          return res.status(401).json({
            error: 'GitHub authentication required. Run: gh auth login',
          });
        }
        return res.status(500).json({
          error: 'Failed to create issue: ' + errorMsg,
        });
      }
    } catch (err) {
      logger.error('Failed to create GitHub issue', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to create GitHub issue' });
    }
  });

  // Close/Reopen GitHub Issue endpoint
  app.patch('/api/workspaces/github-issues/:issueNumber', async (req, res) => {
    const workspacePath = req.body.workspace as string;
    const issueNumber = parseInt(req.params.issueNumber, 10);
    const state = req.body.state as 'open' | 'closed';

    if (!workspacePath) {
      return res.status(400).json({ error: 'workspace is required' });
    }
    if (!issueNumber || isNaN(issueNumber)) {
      return res.status(400).json({ error: 'Invalid issue number' });
    }
    if (!state || !['open', 'closed'].includes(state)) {
      return res.status(400).json({ error: 'state must be "open" or "closed"' });
    }
    if (!existsSync(workspacePath)) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    try {
      const execAsync = (await import('util')).promisify((await import('child_process')).exec);

      // Check if it's a git repo
      try {
        await execAsync('git rev-parse --git-dir', { cwd: workspacePath });
      } catch {
        return res.status(400).json({ error: 'Not a git repository' });
      }

      // Get remote URL to determine owner/repo
      let owner = '';
      let repo = '';
      try {
        const { stdout: remotesOutput } = await execAsync('git remote', { cwd: workspacePath });
        const remotes = remotesOutput
          .trim()
          .split('\n')
          .filter((r) => r.length > 0);

        let foundUrl = '';
        for (const remote of remotes) {
          try {
            const { stdout } = await execAsync(`git remote get-url ${remote}`, {
              cwd: workspacePath,
            });
            const url = stdout.trim();
            if (url.includes('github.com')) {
              foundUrl = url;
              break;
            }
            if (!foundUrl && url.match(/github[^:/]*[:/]/)) {
              foundUrl = url;
            }
          } catch {
            continue;
          }
        }

        if (foundUrl) {
          const match = foundUrl.match(/github[^:/]*[:/]([^/]+)\/([^/.]+)/);
          if (match) {
            owner = match[1];
            repo = match[2];
          }
        }
      } catch {
        return res.status(400).json({ error: 'No remote origin' });
      }

      if (!owner || !repo) {
        return res.status(400).json({ error: 'Not a GitHub repository' });
      }

      // Check if gh CLI is installed
      try {
        await execAsync('gh --version', { cwd: workspacePath });
      } catch {
        return res.status(400).json({ error: 'gh CLI not installed' });
      }

      // Close or reopen the issue using gh CLI
      try {
        const { execFile } = await import('child_process');
        const execFileAsync = (await import('util')).promisify(execFile);
        const subcommand = state === 'closed' ? 'close' : 'reopen';
        await execFileAsync(
          'gh',
          ['issue', subcommand, String(issueNumber), '--repo', `${owner}/${repo}`],
          { cwd: workspacePath },
        );

        res.json({
          success: true,
          issue: {
            number: issueNumber,
            state: state.toUpperCase(),
          },
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (errorMsg.includes('authentication') || errorMsg.includes('HTTP 401')) {
          return res.status(401).json({
            error: 'GitHub authentication required. Run: gh auth login',
          });
        }
        return res.status(500).json({
          error: 'Failed to update issue: ' + errorMsg,
        });
      }
    } catch (err) {
      logger.error('Failed to update GitHub issue', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to update GitHub issue' });
    }
  });

  // Read file contents endpoint
  app.get('/api/workspaces/read-file', async (req, res) => {
    const workspacePath = req.query.workspace as string;
    const filePath = req.query.file as string;

    if (!workspacePath) {
      return res.status(400).json({ error: 'workspace query parameter is required' });
    }
    if (!filePath) {
      return res.status(400).json({ error: 'file query parameter is required' });
    }

    // Resolve the full file path
    const fullPath = join(workspacePath, filePath);

    // Security: ensure the resolved path is within the workspace
    const resolvedPath = resolve(fullPath);
    const resolvedWorkspace = resolve(workspacePath);
    if (!resolvedPath.startsWith(resolvedWorkspace)) {
      return res.status(403).json({ error: 'Path traversal not allowed' });
    }

    if (!existsSync(resolvedPath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    try {
      const stats = statSync(resolvedPath);
      if (!stats.isFile()) {
        return res.status(400).json({ error: 'Path is not a file' });
      }

      // For binary image files, return base64-encoded content
      const imageExtensions = /\.(png|jpg|jpeg|gif|webp|bmp|ico|svg)$/i;
      if (imageExtensions.test(resolvedPath)) {
        const buffer = await readFile(resolvedPath);
        const base64 = buffer.toString('base64');
        const ext = resolvedPath.split('.').pop()!.toLowerCase();
        const mimeType =
          ext === 'svg'
            ? 'image/svg+xml'
            : ext === 'jpg' || ext === 'jpeg'
              ? 'image/jpeg'
              : `image/${ext}`;
        return res.json({
          path: filePath,
          content: `data:${mimeType};base64,${base64}`,
          isImage: true,
          size: stats.size,
        });
      }

      // Read file contents as text
      const content = await readFile(resolvedPath, 'utf-8');
      res.json({
        path: filePath,
        content,
        size: stats.size,
      });
    } catch (err) {
      logger.error('Failed to read file', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to read file' });
    }
  });

  // Save file contents endpoint
  app.post('/api/workspaces/save-file', async (req, res) => {
    const workspacePath = req.body.workspace as string;
    const filePath = req.body.file as string;
    const content = req.body.content as string;

    if (!workspacePath) {
      return res.status(400).json({ error: 'workspace parameter is required' });
    }
    if (!filePath) {
      return res.status(400).json({ error: 'file parameter is required' });
    }
    if (content === undefined) {
      return res.status(400).json({ error: 'content parameter is required' });
    }

    // Resolve the full file path
    const fullPath = join(workspacePath, filePath);

    // Security: ensure the resolved path is within the workspace
    const resolvedPath = resolve(fullPath);
    const resolvedWorkspace = resolve(workspacePath);
    if (!resolvedPath.startsWith(resolvedWorkspace)) {
      return res.status(403).json({ error: 'Path traversal not allowed' });
    }

    try {
      // Write file contents
      writeFileSync(resolvedPath, content, 'utf-8');
      const stats = statSync(resolvedPath);
      res.json({
        path: filePath,
        size: stats.size,
        success: true,
      });
    } catch (err) {
      logger.error('Failed to save file', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to save file' });
    }
  });

  // Git diff endpoint
  app.get('/api/workspaces/git-diff', async (req, res) => {
    const workspacePath = req.query.workspace as string;
    const filePath = req.query.file as string;
    const staged = req.query.staged === 'true';

    if (!workspacePath) {
      return res.status(400).json({ error: 'workspace query parameter is required' });
    }
    if (!filePath) {
      return res.status(400).json({ error: 'file query parameter is required' });
    }

    if (!existsSync(workspacePath)) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    try {
      const execAsync = (await import('util')).promisify((await import('child_process')).exec);

      // Check if it's a git repo
      try {
        await execAsync('git rev-parse --git-dir', { cwd: workspacePath });
      } catch {
        return res.status(400).json({ error: 'Not a git repository' });
      }

      // Get the diff
      let diff = '';
      try {
        const { execFile } = await import('child_process');
        const execFileAsync = (await import('util')).promisify(execFile);
        const args = staged ? ['diff', '--cached', '--', filePath] : ['diff', '--', filePath];
        const { stdout } = await execFileAsync('git', args, {
          cwd: workspacePath,
          maxBuffer: 10 * 1024 * 1024,
        });
        diff = stdout;
      } catch (err) {
        logger.error('Failed to get git diff', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      res.json({
        path: filePath,
        diff,
        staged,
      });
    } catch (err) {
      logger.error('Failed to get git diff', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to get git diff' });
    }
  });

  // Config API routes

  app.get('/api/config', async (_req, res) => {
    // If rules are empty, try to sync from CLAUDE.md files
    const config = configStore.getConfig();
    if (!config.rules) {
      const workspaces = workspaceStore.getWorkspaces();
      for (const workspace of workspaces) {
        const rules = await extractRulesFromClaudeMd(workspace.id);
        if (rules) {
          console.log(`[Server] Syncing rules from ${workspace.id}/CLAUDE.md to config`);
          configStore.updateConfig({ rules });
          const updatedConfig = configStore.getConfig();
          return res.json(updatedConfig);
        }
      }
    }
    res.json(config);
  });

  app.put('/api/config', async (req, res) => {
    try {
      // Validate the config update payload
      const validation = validateConfigUpdate(req.body);
      if (!validation.valid) {
        logger.warn('Invalid config update payload', { error: validation.error });
        return res.status(400).json({ error: validation.error });
      }

      // Check if backend is being changed
      const currentBackend = configStore.getBackend();
      const newBackend = validation.data!.backend;

      // Convert sapAiCore to aiCoreCredentials if present
      const configUpdate = { ...validation.data! };
      if (configUpdate.sapAiCore) {
        configUpdate.aiCoreCredentials = configUpdate.sapAiCore;
        delete configUpdate.sapAiCore;
      }

      // Cast is needed because ConfigUpdatePayload has optional fields but AppConfig requires them
      const updatedConfig = configStore.updateConfig(
        configUpdate as Parameters<typeof configStore.updateConfig>[0],
      );

      // If backend was changed, switch the task spawner's backend
      if (newBackend && newBackend !== currentBackend) {
        logger.info('Backend config changed, switching task spawner backend', {
          from: currentBackend,
          to: newBackend,
        });
        await taskSpawner.switchBackend(newBackend);
      }

      // If apiMode was changed, notify the relevant plugin
      if (configUpdate.apiMode !== undefined) {
        logger.info('[Config] API mode changed, notifying plugin', {
          apiMode: configUpdate.apiMode,
          previousMode: currentBackend,
        });
        try {
          await pluginManager.notifyConfigChange(configUpdate.apiMode, updatedConfig);
          logger.info('[Config] Plugin notified successfully', { apiMode: configUpdate.apiMode });
        } catch (error) {
          logger.error('[Config] Failed to notify plugin of config change', { error });
        }
      }

      // If rules were updated, sync to all workspace CLAUDE.md files
      if (validation.data!.rules !== undefined) {
        const workspaces = workspaceStore.getWorkspaces();
        for (const workspace of workspaces) {
          try {
            syncRulesToClaudeMd(workspace.id, validation.data!.rules!);
          } catch (err) {
            logger.error(`Failed to sync rules to workspace`, {
              workspaceId: workspace.id,
              error: err,
            });
          }
        }
      }

      // If MCP servers were updated, sync .mcp.json and settings.local.json to all workspaces
      // and notify running tasks of the change
      if (validation.data!.mcpServers !== undefined) {
        const workspaces = workspaceStore.getWorkspaces();
        if (workspaces.length > 0) {
          const workspaceIds = workspaces.map((w) => w.id);
          taskSpawner.syncWorkspaceMcpConfigs(workspaceIds);
          logger.info('Synced MCP config to all workspaces after config update', {
            count: workspaceIds.length,
          });
        }
        notifyTasksOfMcpChange(taskSpawner, configStore);
      }

      res.json(updatedConfig);
    } catch (error) {
      logger.error('Failed to update config', { error });
      res.status(500).json({ error: 'Failed to update config' });
    }
  });

  // MCP server config type - supports stdio, http, and streamableHttp types
  interface MCPServerConfig {
    type?: 'stdio' | 'http' | 'streamableHttp';
    command?: string; // For stdio
    args?: string[]; // For stdio
    env?: Record<string, string>; // For stdio
    url?: string; // For http/streamableHttp
    headers?: Record<string, string>; // For http/streamableHttp
    timeout?: number;
    autoApprove?: string[];
    description?: string;
    [key: string]: unknown;
  }

  interface ClaudeProjectConfig {
    mcpServers?: Record<string, MCPServerConfig>;
    [key: string]: unknown;
  }

  // Get Claude Code's global MCP servers from ~/.claude.json
  app.get('/api/claude-mcp-servers', (req, res) => {
    try {
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const claudeConfigPath = join(homeDir, '.claude.json');

      if (!existsSync(claudeConfigPath)) {
        return res.json({ global: [], project: [] });
      }

      const claudeConfig = JSON.parse(readFileSync(claudeConfigPath, 'utf-8')) as {
        mcpServers?: Record<string, MCPServerConfig>;
        projects?: Record<string, ClaudeProjectConfig>;
      };
      const workspacePath = req.query.workspace as string;

      // Helper to extract server config supporting stdio, http, and streamableHttp types
      const extractServerConfig = (name: string, config: MCPServerConfig) => {
        const serverType = config.type || 'stdio';
        if (serverType === 'streamableHttp' || serverType === 'http') {
          return {
            name,
            type: serverType as 'http' | 'streamableHttp',
            url: config.url || '',
            headers: config.headers,
            timeout: config.timeout,
            autoApprove: config.autoApprove,
            description: config.description,
          };
        } else {
          return {
            name,
            type: 'stdio' as const,
            command: config.command || '',
            args: config.args || [],
            env: config.env,
            description: config.description,
          };
        }
      };

      // Extract global MCP servers
      const globalServers: Array<ReturnType<typeof extractServerConfig> & { scope: 'global' }> = [];
      if (claudeConfig.mcpServers) {
        for (const [name, config] of Object.entries(claudeConfig.mcpServers)) {
          globalServers.push({
            ...extractServerConfig(name, config),
            scope: 'global',
          });
        }
      }

      // Extract project-specific MCP servers if workspace path provided
      const projectServers: Array<
        ReturnType<typeof extractServerConfig> & { scope: 'project'; projectPath: string }
      > = [];
      if (claudeConfig.projects) {
        for (const [projectPath, projectConfig] of Object.entries(claudeConfig.projects)) {
          if (projectConfig.mcpServers) {
            for (const [name, config] of Object.entries(projectConfig.mcpServers)) {
              // Include if no workspace filter, or if this project matches the workspace
              if (
                !workspacePath ||
                projectPath === workspacePath ||
                workspacePath.startsWith(projectPath)
              ) {
                projectServers.push({
                  ...extractServerConfig(name, config),
                  scope: 'project',
                  projectPath,
                });
              }
            }
          }
        }
      }

      res.json({ global: globalServers, project: projectServers });
    } catch (error) {
      console.error('[Server] Failed to read Claude MCP servers:', error);
      res.status(500).json({ error: 'Failed to read Claude MCP servers' });
    }
  });

  // Get mcpServers section from ~/.claude.json for direct editing
  app.get('/api/claude-config/mcp-servers', (req, res) => {
    try {
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const claudeConfigPath = join(homeDir, '.claude.json');

      if (!existsSync(claudeConfigPath)) {
        return res.json({
          mcpServers: JSON.stringify({}, null, 2),
          path: claudeConfigPath,
          exists: false,
        });
      }

      const fileContent = readFileSync(claudeConfigPath, 'utf-8');
      const config = JSON.parse(fileContent) as {
        mcpServers?: Record<string, unknown>;
      };

      res.json({
        mcpServers: JSON.stringify(config.mcpServers || {}, null, 2),
        path: claudeConfigPath,
        exists: true,
      });
    } catch (error) {
      console.error('[Server] Failed to read Claude MCP servers:', error);
      res.status(500).json({ error: 'Failed to read MCP servers config' });
    }
  });

  // Update mcpServers section in ~/.claude.json
  app.put('/api/claude-config/mcp-servers', (req, res) => {
    try {
      const { mcpServers: mcpServersContent } = req.body;

      if (typeof mcpServersContent !== 'string') {
        return res.status(400).json({ error: 'mcpServers must be a string' });
      }

      let mcpServers: Record<string, unknown>;
      try {
        mcpServers = JSON.parse(mcpServersContent);
        if (typeof mcpServers !== 'object' || Array.isArray(mcpServers)) {
          return res.status(400).json({ error: 'mcpServers must be an object' });
        }
      } catch (parseError) {
        return res.status(400).json({
          error: 'Invalid JSON syntax',
          details: parseError instanceof Error ? parseError.message : 'Parse error',
        });
      }

      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const claudeConfigPath = join(homeDir, '.claude.json');

      // Read existing config or create new one
      interface ClaudeConfig {
        mcpServers?: Record<string, unknown>;
        [key: string]: unknown;
      }
      let config: ClaudeConfig = {};
      if (existsSync(claudeConfigPath)) {
        const fileContent = readFileSync(claudeConfigPath, 'utf-8');
        config = JSON.parse(fileContent);
      }

      config.mcpServers = mcpServers;
      console.log('[Server] Updated MCP servers');

      writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2), 'utf-8');
      console.log('[Server] Saved Claude config:', claudeConfigPath);

      res.json({ success: true, path: claudeConfigPath });
    } catch (error) {
      console.error('[Server] Failed to write MCP servers config:', error);
      res.status(500).json({ error: 'Failed to write MCP servers config' });
    }
  });

  // Test MCP server connection
  app.post('/api/mcp/test', async (req, res) => {
    const { server } = req.body;

    if (!server || !server.name) {
      return res.status(400).json({ success: false, error: 'Server configuration required' });
    }

    const serverType = server.type || 'stdio';
    logger.info(`Testing MCP server connection: ${server.name} (${serverType})`);

    try {
      if (serverType === 'streamableHttp' || serverType === 'http') {
        // Test HTTP-based MCP server
        const url = server.url;
        if (!url) {
          return res.json({ success: false, error: 'URL is required for HTTP MCP server' });
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        try {
          // Send MCP initialize request
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...(server.headers || {}),
          };

          const initRequest = {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: {
                name: 'claudia-test',
                version: '1.0.0',
              },
            },
          };

          const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(initRequest),
            signal: controller.signal,
          });

          clearTimeout(timeout);

          if (response.ok) {
            const data = (await response.json()) as {
              result?: {
                serverInfo?: { name?: string; version?: string };
                capabilities?: Record<string, unknown>;
              };
              error?: { message?: string };
            };
            if (data.result) {
              const serverInfo = data.result.serverInfo;
              const capabilities = data.result.capabilities || {};
              const toolCount = capabilities.tools ? 'available' : 'not advertised';

              logger.info(
                `MCP server ${server.name} connected successfully: ${serverInfo?.name || 'unknown'} v${serverInfo?.version || 'unknown'}`,
              );
              return res.json({
                success: true,
                message: `Connected to ${serverInfo?.name || server.name}${serverInfo?.version ? ` v${serverInfo.version}` : ''}`,
                details: {
                  serverName: serverInfo?.name,
                  serverVersion: serverInfo?.version,
                  tools: toolCount,
                },
              });
            } else if (data.error) {
              return res.json({
                success: false,
                error: data.error.message || 'Server returned error',
              });
            }
            return res.json({ success: true, message: 'Server responded' });
          } else {
            return res.json({
              success: false,
              error: `HTTP ${response.status}: ${response.statusText}`,
            });
          }
        } catch (fetchError: unknown) {
          clearTimeout(timeout);
          const errorMessage =
            fetchError instanceof Error && fetchError.name === 'AbortError'
              ? 'Connection timed out'
              : fetchError instanceof Error
                ? fetchError.message
                : 'Connection failed';
          return res.json({ success: false, error: errorMessage });
        }
      } else {
        // Test stdio-based MCP server
        const command = server.command;
        const args = server.args || [];

        if (!command) {
          return res.json({ success: false, error: 'Command is required for stdio MCP server' });
        }

        // Spawn the process
        let mcpProcess: ChildProcess;
        try {
          mcpProcess = spawn(command, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...(server.env || {}) },
          });
        } catch (spawnError) {
          const errorMessage =
            spawnError instanceof Error ? spawnError.message : 'Failed to spawn process';
          return res.json({ success: false, error: `Failed to start: ${errorMessage}` });
        }

        // Set up timeout
        const timeoutMs = 10000;
        let resolved = false;
        const timeoutId = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            mcpProcess.kill();
            return res.json({
              success: false,
              error: 'Connection timed out (no response within 10s)',
            });
          }
        }, timeoutMs);

        // Collect stderr for error reporting
        let stderrOutput = '';
        mcpProcess.stderr?.on('data', (data: Buffer) => {
          stderrOutput += data.toString();
        });

        // Handle process exit
        mcpProcess.on('error', (error: Error) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            return res.json({ success: false, error: `Process error: ${error.message}` });
          }
        });

        mcpProcess.on('exit', (code: number | null, signal: string | null) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            if (code !== null && code !== 0) {
              const errorInfo = stderrOutput ? `: ${stderrOutput.trim().slice(0, 200)}` : '';
              return res.json({
                success: false,
                error: `Process exited with code ${code}${errorInfo}`,
              });
            }
            if (signal) {
              return res.json({ success: false, error: `Process killed by signal ${signal}` });
            }
          }
        });

        // Buffer for incoming data
        let buffer = '';

        mcpProcess.stdout?.on('data', (data: Buffer) => {
          buffer += data.toString();

          // Try to parse JSON-RPC response
          const lines = buffer.split('\n');
          for (const line of lines) {
            if (line.trim()) {
              try {
                const response = JSON.parse(line) as {
                  result?: {
                    serverInfo?: { name?: string; version?: string };
                    capabilities?: Record<string, unknown>;
                  };
                  error?: { message?: string };
                };
                if (response.result && !resolved) {
                  resolved = true;
                  clearTimeout(timeoutId);
                  mcpProcess.kill();

                  const serverInfo = response.result.serverInfo;
                  const capabilities = response.result.capabilities || {};
                  const toolCount = capabilities.tools ? 'available' : 'not advertised';

                  logger.info(
                    `MCP server ${server.name} connected successfully: ${serverInfo?.name || 'unknown'} v${serverInfo?.version || 'unknown'}`,
                  );
                  return res.json({
                    success: true,
                    message: `Connected to ${serverInfo?.name || server.name}${serverInfo?.version ? ` v${serverInfo.version}` : ''}`,
                    details: {
                      serverName: serverInfo?.name,
                      serverVersion: serverInfo?.version,
                      tools: toolCount,
                    },
                  });
                } else if (response.error && !resolved) {
                  resolved = true;
                  clearTimeout(timeoutId);
                  mcpProcess.kill();
                  return res.json({
                    success: false,
                    error: response.error.message || 'Server returned error',
                  });
                }
              } catch {
                // Not valid JSON yet, continue collecting
              }
            }
          }
        });

        // Send MCP initialize request
        const initRequest = {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: {
              name: 'claudia-test',
              version: '1.0.0',
            },
          },
        };

        mcpProcess.stdin?.write(JSON.stringify(initRequest) + '\n');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`MCP test failed for ${server.name}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return res.json({ success: false, error: errorMessage });
    }
  });

  // ============================================================
  // Learnings API - RAG-based learnings management
  // ============================================================

  // Get all learnings (optionally filtered by workspace)
  app.get('/api/learnings', (req, res) => {
    try {
      const { workspaceId } = req.query;
      const learnings = learningsStore.getLearnings(workspaceId as string | undefined);
      // Return without embedding vectors (they're large)
      const learningsWithoutEmbeddings = learnings.map((l) => ({
        ...l,
        embedding: undefined,
        embeddingDimensions: l.embedding?.length || 0,
      }));
      res.json({ learnings: learningsWithoutEmbeddings });
    } catch (error) {
      logger.error('Failed to get learnings', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to get learnings' });
    }
  });

  // Get a single learning
  app.get('/api/learnings/:id', (req, res) => {
    try {
      const learning = learningsStore.getLearning(req.params.id);
      if (!learning) {
        return res.status(404).json({ error: 'Learning not found' });
      }
      res.json({
        ...learning,
        embedding: undefined,
        embeddingDimensions: learning.embedding?.length || 0,
      });
    } catch (error) {
      logger.error('Failed to get learning', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to get learning' });
    }
  });

  // Add a new learning
  app.post('/api/learnings', async (req, res) => {
    try {
      const { workspaceId, title, content, sourceTaskId } = req.body;

      if (!workspaceId || !title || !content) {
        return res
          .status(400)
          .json({ error: 'Missing required fields: workspaceId, title, content' });
      }

      const learning = await learningsStore.addLearning({
        workspaceId,
        title,
        content,
        sourceTaskId,
      });

      res.json({
        ...learning,
        embedding: undefined,
        embeddingDimensions: learning.embedding?.length || 0,
      });
    } catch (error) {
      logger.error('Failed to add learning', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to add learning' });
    }
  });

  // Update a learning
  app.put('/api/learnings/:id', async (req, res) => {
    try {
      const { title, content } = req.body;
      const learning = await learningsStore.updateLearning(req.params.id, { title, content });
      if (!learning) {
        return res.status(404).json({ error: 'Learning not found' });
      }
      res.json({
        ...learning,
        embedding: undefined,
        embeddingDimensions: learning.embedding?.length || 0,
      });
    } catch (error) {
      logger.error('Failed to update learning', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to update learning' });
    }
  });

  // Delete a learning
  app.delete('/api/learnings/:id', (req, res) => {
    try {
      const success = learningsStore.deleteLearning(req.params.id);
      if (!success) {
        return res.status(404).json({ error: 'Learning not found' });
      }
      res.json({ success: true });
    } catch (error) {
      logger.error('Failed to delete learning', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to delete learning' });
    }
  });

  // Search learnings (semantic search)
  app.post('/api/learnings/search', async (req, res) => {
    try {
      const { query, workspaceId, topK, minScore } = req.body;

      if (!query) {
        return res.status(400).json({ error: 'Missing query' });
      }

      const results = await learningsStore.searchLearnings({
        query,
        workspaceId,
        topK: topK || 5,
        minScore: minScore || 0.3,
      });

      // Return without embedding vectors
      res.json({
        results: results.map((r) => ({
          learning: {
            ...r.learning,
            embedding: undefined,
            embeddingDimensions: r.learning.embedding?.length || 0,
          },
          score: r.score,
        })),
      });
    } catch (error) {
      logger.error('Failed to search learnings', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to search learnings' });
    }
  });

  // Get learnings for a task (based on task prompt)
  // Also returns which learnings were actually injected into this task's context
  app.get('/api/tasks/:taskId/learnings', async (req, res) => {
    try {
      const { taskId } = req.params;
      const task = taskSpawner.getTask(taskId) || taskSpawner.getDisconnectedTask(taskId);

      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }

      // Get the learning IDs that were actually injected into this task
      const injectedIds = taskSpawner.getTaskLearnings(taskId);

      // Search for relevant learnings based on task prompt
      const results = await learningsStore.searchLearnings({
        query: task.prompt,
        workspaceId: task.workspaceId,
        topK: 5,
        minScore: 0.3,
      });

      // Format for context injection
      const contextText = learningsStore.formatForContext(results);

      // Get the actual injected learnings
      const injectedLearnings = injectedIds
        .map((id) => learningsStore.getLearning(id))
        .filter(Boolean);

      res.json({
        results: results.map((r) => ({
          learning: {
            ...r.learning,
            embedding: undefined,
          },
          score: r.score,
        })),
        contextText,
        injected: injectedLearnings.map((l) => ({
          ...l,
          embedding: undefined,
        })),
        injectedCount: injectedIds.length,
      });
    } catch (error) {
      logger.error('Failed to get task learnings', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to get task learnings' });
    }
  });

  // Helper to sync rules to CLAUDE.md
  function syncRulesToClaudeMd(workspacePath: string, rules: string): void {
    const claudeMdPath = join(workspacePath, 'CLAUDE.md');
    const marker = '<!-- CODEUI-RULES -->';
    const endMarker = '<!-- /CODEUI-RULES -->';

    let content = '';
    if (existsSync(claudeMdPath)) {
      content = readFileSync(claudeMdPath, 'utf-8');
    }

    // Remove existing rules section if present
    const startIdx = content.indexOf(marker);
    const endIdx = content.indexOf(endMarker);
    if (startIdx !== -1 && endIdx !== -1) {
      content = content.slice(0, startIdx) + content.slice(endIdx + endMarker.length);
    }

    // Add new rules section at the end if there are rules
    if (rules.trim()) {
      const rulesSection = `\n${marker}\n## Custom Rules\n\n${rules}\n${endMarker}\n`;
      content = content.trimEnd() + rulesSection;
    }

    writeFileSync(claudeMdPath, content, 'utf-8');
    console.log(`[Server] Synced rules to ${claudeMdPath}`);
  }

  // Conversation History API
  app.get('/api/tasks/:taskId/conversation', async (req, res) => {
    try {
      const { taskId } = req.params;
      const activeTask = taskSpawner.getTask(taskId);
      const disconnectedTask = taskSpawner.getDisconnectedTask(taskId);
      const task = activeTask || disconnectedTask;

      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }

      if (!task.sessionId) {
        return res.status(404).json({ error: 'Task has no session ID' });
      }

      // Get workspace path from workspace store
      const workspace = workspaceStore.getWorkspaces().find((w) => w.id === task.workspaceId);
      if (!workspace) {
        return res.status(404).json({ error: 'Workspace not found' });
      }

      // Determine backend type: from task, or from task backends map, or auto-detect
      const backendType = 'backendType' in task && task.backendType ? task.backendType : undefined;

      logger.info('Getting conversation history', {
        taskId,
        sessionId: task.sessionId,
        backendType,
      });

      const conversation = await getConversationHistory(workspace.id, task.sessionId, backendType);
      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      res.json(conversation);
    } catch (error) {
      console.error('[Server] Failed to get conversation:', error);
      res.status(500).json({ error: 'Failed to get conversation' });
    }
  });

  // Rich ConversationEvent[] for the React conversation view. Cold-load
  // path used when the UI mounts before the live WS snapshot has arrived,
  // and on full page refreshes. Live updates flow over the WS bus via
  // `task:conversation:event` / `task:conversation:restore`.
  app.get('/api/tasks/:taskId/conversation/events', async (req, res) => {
    try {
      const { taskId } = req.params;
      const activeTask = taskSpawner.getTask(taskId);
      const disconnectedTask = taskSpawner.getDisconnectedTask(taskId);
      const task = activeTask || disconnectedTask;

      if (!task) return res.status(404).json({ error: 'Task not found' });
      if (!task.sessionId) return res.json({ events: [] });

      const workspace = workspaceStore.getWorkspaces().find((w) => w.id === task.workspaceId);
      if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

      const backendType =
        'backendType' in task && task.backendType ? task.backendType : undefined;

      // Prefer the live streamer's snapshot when available — it's already
      // parsed in memory, no disk I/O needed.
      const live = convStreamers.get(taskId)?.getSnapshot();
      if (live && live.length > 0) {
        return res.json({ events: live });
      }

      // Fall back to a fresh parse from disk.
      const events = await parseConversationEvents(
        workspace.id,
        task.sessionId,
        taskId,
        backendType,
      );
      res.json({ events });
    } catch (error) {
      console.error('[Server] Failed to get conversation events:', error);
      res.status(500).json({ error: 'Failed to get conversation events' });
    }
  });

  // Get all sessions for a workspace
  app.get('/api/workspaces/:workspaceId/sessions', async (req, res) => {
    try {
      const { workspaceId } = req.params;
      const workspace = workspaceStore.getWorkspaces().find((w) => w.id === workspaceId);

      if (!workspace) {
        return res.status(404).json({ error: 'Workspace not found' });
      }

      const sessions = await getWorkspaceSessions(workspace.id);
      res.json(sessions);
    } catch (error) {
      console.error('[Server] Failed to get sessions:', error);
      res.status(500).json({ error: 'Failed to get sessions' });
    }
  });

  // Get conversation for a specific session
  app.get('/api/sessions/:sessionId/conversation', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { workspaceId } = req.query;

      if (!workspaceId || typeof workspaceId !== 'string') {
        return res.status(400).json({ error: 'workspaceId query parameter required' });
      }

      // Look up workspace to get the path
      const workspace = workspaceStore.getWorkspaces().find((w) => w.id === workspaceId);
      if (!workspace) {
        return res.status(404).json({ error: 'Workspace not found' });
      }

      const conversation = await getConversationHistory(workspace.id, sessionId);
      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      res.json(conversation);
    } catch (error) {
      console.error('[Server] Failed to get session conversation:', error);
      res.status(500).json({ error: 'Failed to get conversation' });
    }
  });

  // Learn from conversation - analyze and suggest system prompt improvements
  app.post('/api/tasks/:taskId/learn', async (req, res) => {
    try {
      const { taskId } = req.params;
      const { currentSystemPrompt, workspaceId } = req.body;

      // Get the task to find its session ID
      const task = taskSpawner.getTask(taskId) || taskSpawner.getDisconnectedTask(taskId);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }

      if (!task.sessionId) {
        return res.status(404).json({ error: 'Task has no conversation history (no session ID)' });
      }

      // Get the conversation history
      const workspace = workspaceStore
        .getWorkspaces()
        .find((w) => w.id === (workspaceId || task.workspaceId));
      if (!workspace) {
        return res.status(404).json({ error: 'Workspace not found' });
      }

      // Determine backend type from task
      const backendType = 'backendType' in task && task.backendType ? task.backendType : undefined;

      logger.info('Learn from conversation - looking up history', {
        taskId,
        sessionId: task.sessionId,
        workspacePath: workspace.id,
        backendType,
      });

      const conversation = await getConversationHistory(workspace.id, task.sessionId, backendType);
      if (!conversation || conversation.messages.length === 0) {
        logger.warn('No conversation history found', {
          taskId,
          sessionId: task.sessionId,
          workspacePath: workspace.id,
        });
        return res.status(404).json({ error: 'No conversation history found' });
      }

      // Build the conversation summary for analysis
      const conversationText = conversation.messages
        .map(
          (m) =>
            `${m.role.toUpperCase()}: ${m.content.substring(0, 1500)}${m.content.length > 1500 ? '...' : ''}`,
        )
        .join('\n\n');

      // Use the LLM to analyze the conversation and suggest improvements
      const { generateLLMResponse } = await import('./llm-service.js');

      const analysisPrompt = `You are analyzing a conversation between a user and an AI coding assistant to improve the system prompt.

CURRENT SYSTEM PROMPT (may be empty):
${currentSystemPrompt || '(No system prompt set)'}

CONVERSATION:
${conversationText}

Analyze this conversation to identify:
1. Mistakes or misunderstandings the AI made that could be prevented with better instructions
2. Repeated lookups or questions that could be pre-answered in the system prompt
3. Project-specific knowledge that would help the AI be more effective
4. Preferences the user expressed that should be remembered

Respond in this exact JSON format:
{
  "suggestions": [
    {
      "id": "unique_id_1",
      "description": "Short description of what this suggestion improves",
      "promptAddition": "The actual text to add to the system prompt for this suggestion"
    }
  ],
  "reasoning": "A brief explanation of what you learned from this conversation"
}

Guidelines:
- Each suggestion should be independent and self-contained
- The promptAddition should be a complete instruction that can be added to the system prompt
- Keep each promptAddition concise (1-3 sentences)
- Focus on actionable instructions that prevent specific mistakes
- Generate 2-5 suggestions maximum
- Use unique IDs like "s1", "s2", etc.`;

      const response = await generateLLMResponse(
        'You are a system prompt optimization expert. Always respond with valid JSON.',
        analysisPrompt,
        { maxTokens: 2000, temperature: 0.3, timeoutMs: 90000 },
      );

      // Parse the JSON response
      let analysis;
      try {
        // Try to extract JSON from the response (in case there's extra text)
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          analysis = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error('No JSON found in response');
        }
      } catch (parseError) {
        console.error('[Server] Failed to parse LLM response as JSON:', response);
        // Return a fallback response
        analysis = {
          suggestions: [],
          reasoning: 'The analysis could not be completed. Please try again.',
        };
      }

      // Validate the response structure
      if (!analysis.suggestions || !Array.isArray(analysis.suggestions)) {
        analysis.suggestions = [];
      }
      // Validate each suggestion has required fields
      analysis.suggestions = analysis.suggestions.filter(
        (s: { id?: string; description?: string; promptAddition?: string }) =>
          s &&
          typeof s.id === 'string' &&
          typeof s.description === 'string' &&
          typeof s.promptAddition === 'string',
      );
      if (!analysis.reasoning || typeof analysis.reasoning !== 'string') {
        analysis.reasoning = 'No specific reasoning provided.';
      }

      logger.info('Learn from conversation analysis complete', {
        taskId,
        suggestionCount: analysis.suggestions.length,
      });

      res.json(analysis);
    } catch (error) {
      console.error('[Server] Failed to learn from conversation:', error);
      res.status(500).json({ error: 'Failed to analyze conversation' });
    }
  });

  // Save selected learnings from conversation analysis
  app.post('/api/tasks/:taskId/learn/save', async (req, res) => {
    try {
      const { taskId } = req.params;
      const { learnings, workspaceId } = req.body;

      if (!learnings || !Array.isArray(learnings) || learnings.length === 0) {
        return res.status(400).json({ error: 'No learnings provided' });
      }

      const task = taskSpawner.getTask(taskId) || taskSpawner.getDisconnectedTask(taskId);
      const effectiveWorkspaceId = workspaceId || task?.workspaceId;

      if (!effectiveWorkspaceId) {
        return res.status(400).json({ error: 'Workspace ID required' });
      }

      const savedLearnings = [];
      for (const learning of learnings) {
        if (!learning.title || !learning.content) {
          continue;
        }

        try {
          const saved = await learningsStore.addLearning({
            workspaceId: effectiveWorkspaceId,
            title: learning.title,
            content: learning.content,
            sourceTaskId: taskId,
          });
          savedLearnings.push({
            ...saved,
            embedding: undefined,
            embeddingDimensions: saved.embedding?.length || 0,
          });
        } catch (err) {
          logger.error('Failed to save learning', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      logger.info('Saved learnings from conversation', {
        taskId,
        count: savedLearnings.length,
      });

      res.json({ saved: savedLearnings });
    } catch (error) {
      console.error('[Server] Failed to save learnings:', error);
      res.status(500).json({ error: 'Failed to save learnings' });
    }
  });

  // ===== Token Usage / Dashboard Endpoints =====

  app.get('/api/usage/dashboard', (_req, res) => {
    try {
      const allTasks = taskSpawner.getAllTasks();
      const workspaces = workspaceStore.getWorkspaces();
      const workspaceNames: Record<string, string> = {};
      for (const ws of workspaces) {
        workspaceNames[ws.id] = ws.displayName || ws.name;
      }

      const dashboard: UsageDashboardData = {
        totalCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: 0,
        byWorkspace: {},
        byModel: {},
        taskCount: 0,
        lastUpdated: new Date().toISOString(),
      };

      for (const task of allTasks) {
        if (!task.tokenUsage) continue;
        dashboard.taskCount++;

        const usage = task.tokenUsage;
        dashboard.totalCostUsd += usage.totalCostUsd || 0;
        dashboard.totalInputTokens += usage.inputTokens || 0;
        dashboard.totalOutputTokens += usage.outputTokens || 0;
        dashboard.totalCacheCreationTokens += usage.cacheCreationTokens || 0;
        dashboard.totalCacheReadTokens += usage.cacheReadTokens || 0;

        // Group by workspace
        if (!dashboard.byWorkspace[task.workspaceId]) {
          dashboard.byWorkspace[task.workspaceId] = {
            name: workspaceNames[task.workspaceId] || task.workspaceId,
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            taskCount: 0,
          };
        }
        const wsData = dashboard.byWorkspace[task.workspaceId];
        wsData.costUsd += usage.totalCostUsd || 0;
        wsData.inputTokens += usage.inputTokens || 0;
        wsData.outputTokens += usage.outputTokens || 0;
        wsData.cacheCreationTokens += usage.cacheCreationTokens || 0;
        wsData.cacheReadTokens += usage.cacheReadTokens || 0;
        wsData.taskCount++;

        // Group by model
        for (const [model, modelUsage] of Object.entries(usage.modelBreakdown)) {
          if (!dashboard.byModel[model]) {
            dashboard.byModel[model] = {
              inputTokens: 0,
              outputTokens: 0,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              costUsd: 0,
            };
          }
          const m = dashboard.byModel[model];
          m.inputTokens += modelUsage.inputTokens || 0;
          m.outputTokens += modelUsage.outputTokens || 0;
          m.cacheCreationTokens += modelUsage.cacheCreationTokens || 0;
          m.cacheReadTokens += modelUsage.cacheReadTokens || 0;
          m.costUsd += modelUsage.costUsd || 0;
        }
      }

      res.json(dashboard);
    } catch (error) {
      logger.error('Failed to get usage dashboard', { error });
      res.status(500).json({ error: 'Failed to get usage dashboard' });
    }
  });

  app.get('/api/usage/config', (_req, res) => {
    try {
      res.json({
        pricing: configStore.getTokenPricing(),
        enabled: configStore.getTokenTrackingEnabled(),
      });
    } catch (error) {
      logger.error('Failed to get usage config', { error });
      res.status(500).json({ error: 'Failed to get usage config' });
    }
  });

  app.put('/api/usage/config', (req, res) => {
    try {
      const { pricing } = req.body;
      if (pricing) {
        configStore.setTokenPricing(pricing);
      }
      res.json({ ok: true });
    } catch (error) {
      logger.error('Failed to update usage config', { error });
      res.status(500).json({ error: 'Failed to update usage config' });
    }
  });

  // Restart server endpoint - triggers graceful shutdown, tsx watch will restart
  app.post('/api/server/restart', async (_req, res) => {
    console.log('[Server] Restart requested via API');
    res.json({ status: 'restarting' });

    // Give time for response to be sent
    setTimeout(async () => {
      // Touch a watched file to trigger tsx watch restart
      // This is more reliable than process.exit(0) which tsx may not restart
      try {
        const { utimes } = await import('fs/promises');
        const restartTriggerFile = join(__dirname, 'index.ts');
        const now = new Date();
        await utimes(restartTriggerFile, now, now);
        console.log('[Server] Touched index.ts to trigger tsx watch restart');
      } catch (error) {
        console.error(
          '[Server] Failed to touch restart trigger file, falling back to graceful shutdown:',
          error,
        );
        gracefulShutdown('RESTART');
      }
    }, 100);
  });

  // ===== Production Static Frontend Serving =====
  // When installed via npm (no Vite dev server), serve the pre-built frontend
  const __server_filename = fileURLToPath(import.meta.url);
  const __server_dirname = dirname(__server_filename);
  const frontendDistPath = join(__server_dirname, '..', '..', 'frontend', 'dist');
  if (existsSync(frontendDistPath)) {
    logger.info('Serving frontend from static dist', { path: frontendDistPath });
    app.use(express.static(frontendDistPath));
    // SPA fallback: serve index.html for any non-API route
    app.get('*', (_req, res) => {
      res.sendFile(join(frontendDistPath, 'index.html'));
    });
  }

  // Graceful shutdown handler
  function gracefulShutdown(signal: string): void {
    console.log(`[Server] Shutting down (${signal}), saving state immediately...`);

    // CRITICAL: Save all state IMMEDIATELY before anything else.
    // On Windows, tsx watch may kill the process abruptly — the 500ms
    // timeout below is NOT guaranteed to fire.
    try {
      taskSpawner.saveNow();
    } catch (err) {
      console.error('[Server] Error during immediate save on shutdown:', err);
    }

    // Clear heartbeat interval
    clearInterval(heartbeatInterval);

    // Notify all connected clients that the server is reloading
    broadcast({ type: 'server:reloading' as WSMessageType, payload: {} });

    // Give clients time to receive the message, then clean up
    setTimeout(() => {
      // Stop tunnel if active
      tunnelManager.stop().catch(() => {});

      taskSpawner.destroy();

      // Close WebSocket connections gracefully
      for (const client of clients) {
        client.close(1001, 'Server reloading');
      }

      console.log('[Server] Shutdown complete');
      process.exit(0);
    }, 500);
  }

  // Note: SIGINT/SIGTERM handlers are set up in index.ts to avoid duplicate handlers
  // The gracefulShutdown function is exported for use by the restart endpoint

  return {
    app,
    server,
    wss,
    taskSpawner,
    workspaceStore,
    gracefulShutdown,
    tunnelManager,
  };
}
