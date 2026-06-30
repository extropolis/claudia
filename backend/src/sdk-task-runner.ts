/**
 * sdk-task-runner.ts
 *
 * Runs a Claude Code task via @anthropic-ai/claude-agent-sdk instead of
 * spawning the interactive `claude` CLI in a PTY.
 *
 * What this gives us:
 *   - No PTY → no garbling, no resize math, no encoding drift.
 *   - Structured events instead of ANSI bytes → React renders them directly.
 *   - Permission prompts as real callbacks → React modals via the broker.
 *   - First-class abort via AbortController.
 *
 * What this is NOT:
 *   - A drop-in replacement for TaskSpawner (yet). For Phase 1 it's a
 *     parallel system: the server gets a second creator path, tasks have
 *     a `kind: 'sdk'` discriminator, and the existing PTY path is untouched.
 *   - A streaming-input path. v1 supports follow-up prompts via continueQuery()
 *     which spawns a new SDK query reusing sessionId. That's good enough for
 *     a chat UX. Real streaming-input (multiple turns through one query
 *     instance) is a Phase 6 polish item.
 *
 * Event flow:
 *   1. start() → SDK query() spawns child process, starts streaming SDKMessages.
 *   2. Each SDKMessage → normalizeSdkMessage → ConversationEvent[].
 *   3. Each ConversationEvent emitted via 'event' EventEmitter event.
 *   4. canUseTool callback registers with sdkPermissionBroker, emits
 *      'permissionRequest' for the WS layer to forward, awaits decision.
 *   5. Result message ends the loop; emit 'complete'. Aborts emit 'aborted'.
 *
 * The TaskSpawner consumer (see server.ts integration) listens to these
 * EventEmitter events and translates them to existing WS message kinds —
 * `task:conversation:event` for events, `task:stateChanged` for lifecycle,
 * `task:waitingInput` for permissions.
 */
import { EventEmitter } from 'events';
import {
  query,
  type Options as SdkOptions,
  type Query,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { ConversationEvent, Task, TaskState, TaskTokenUsage } from '@claudia/shared';
import { createLogger } from './logger.js';

const logger = createLogger('[SdkRunner]');
import { normalizeSdkMessage } from './sdk-message-normalizer.js';
import { sdkPermissionBroker, type PendingRequestSummary } from './sdk-permission-broker.js';

export interface SdkTaskOptions {
  taskId: string;
  workspaceId: string;
  cwd: string;
  prompt: string;
  systemPrompt?: string;
  /** 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'. */
  permissionMode?: SdkOptions['permissionMode'];
  /** Pre-approved tool names or patterns (e.g. ["Read", "Bash(git diff*)"]). */
  allowedTools?: string[];
  /** Disallowed tool names. */
  disallowedTools?: string[];
  /** Optional model override. */
  model?: string;
  /** Resume an existing session if provided. */
  resumeSessionId?: string;
}

export type SdkRunnerEvent =
  | 'event' // (event: ConversationEvent)
  | 'permissionRequest' // (summary: PendingRequestSummary)
  | 'permissionResolved' // (requestId: string)
  | 'stateChanged' // (state: TaskState)
  | 'sessionCaptured' // (sessionId: string)
  | 'complete' // (summary: { isError; numTurns; totalCostUsd; usage })
  | 'aborted' // ()
  | 'error'; // (error: Error)

export interface SdkRunResultSummary {
  isError: boolean;
  numTurns?: number;
  totalCostUsd?: number;
  durationMs?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/**
 * One running SDK task. Roughly mirrors TaskSpawner's per-task object but
 * without PTY plumbing.
 */
export class SdkTaskRunner extends EventEmitter {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly createdAt: Date;
  private readonly opts: SdkTaskOptions;

  private state: TaskState = 'starting';
  private sessionId: string | null = null;
  private abortCtl: AbortController | null = null;
  private sdkQuery: Query | null = null;
  private destroyed = false;

  /** All ConversationEvents emitted so far — used to seed reconnecting clients. */
  private readonly snapshot: ConversationEvent[] = [];
  private static readonly MAX_SNAPSHOT = 5000;

  /** Accumulated token usage across every SDK turn this runner has driven. */
  private tokenUsage: TaskTokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalCostUsd: 0,
    modelBreakdown: {},
    lastUpdated: new Date().toISOString(),
  };

  constructor(opts: SdkTaskOptions) {
    super();
    this.taskId = opts.taskId;
    this.workspaceId = opts.workspaceId;
    this.cwd = opts.cwd;
    this.createdAt = new Date();
    this.opts = opts;
    if (opts.resumeSessionId) this.sessionId = opts.resumeSessionId;
  }

  getState(): TaskState {
    return this.state;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getSnapshot(): ConversationEvent[] {
    return this.snapshot.slice();
  }

  /** Accumulated token usage across all turns this runner has driven. */
  getTokenUsage(): TaskTokenUsage {
    return { ...this.tokenUsage };
  }

  /** Kick off the SDK query. Resolves once start has been initiated, NOT once complete. */
  async start(): Promise<void> {
    this.setState('busy');
    this.abortCtl = new AbortController();

    const sdkOptions: SdkOptions = {
      cwd: this.cwd,
      permissionMode: this.opts.permissionMode ?? 'default',
      allowedTools: this.opts.allowedTools,
      disallowedTools: this.opts.disallowedTools,
      model: this.opts.model,
      resume: this.opts.resumeSessionId,
      abortController: this.abortCtl,
      // Custom system prompt — append to keep Claude Code's defaults working.
      // Caller can pass a full replacement via opts if needed (Phase 6).
      ...(this.opts.systemPrompt
        ? { customSystemPrompt: this.opts.systemPrompt }
        : {}),
      canUseTool: this.handleCanUseTool.bind(this),
    };

    logger.info('SDK task starting', {
      taskId: this.taskId,
      cwd: this.cwd,
      permissionMode: sdkOptions.permissionMode,
      hasResume: !!this.opts.resumeSessionId,
    });

    try {
      this.sdkQuery = query({ prompt: this.opts.prompt, options: sdkOptions });
    } catch (err) {
      this.fail(err);
      return;
    }

    // Drive the loop in the background — start() returns once spawning is
    // initiated so the caller can attach listeners and respond to events.
    this.runLoop().catch((err) => {
      logger.error('SDK runner loop crashed', {
        taskId: this.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.fail(err);
    });
  }

  /** Send a follow-up turn. Spawns a new query reusing sessionId. */
  async continueWith(prompt: string): Promise<void> {
    if (this.state === 'busy') {
      throw new Error('Task is already running — abort first');
    }
    if (this.destroyed) {
      throw new Error('Task has been destroyed');
    }
    if (!this.sessionId) {
      throw new Error('Cannot continue: no session id captured yet');
    }

    // Reuse the runner's identity but spawn a new SDK query bound to the
    // captured sessionId. resume option tells the SDK to load that session.
    this.opts.prompt = prompt;
    this.opts.resumeSessionId = this.sessionId;
    await this.start();
  }

  /** Abort an in-progress run. */
  async abort(): Promise<void> {
    if (this.state !== 'busy' && this.state !== 'starting') return;
    logger.info('SDK task aborting', { taskId: this.taskId });
    this.abortCtl?.abort();
    sdkPermissionBroker.cancelTask(this.taskId, 'task aborted');
  }

  /** Permanently destroy the runner — caller no longer wants this task. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    void this.abort();
    this.removeAllListeners();
  }

  // ───────────────────── private ─────────────────────

  private async handleCanUseTool(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }> {
    if (this.destroyed) {
      return { behavior: 'deny', message: 'Task destroyed' };
    }
    const { requestId, waitForDecision } = sdkPermissionBroker.register(
      this.taskId,
      toolName,
      input,
    );
    const summary: PendingRequestSummary = {
      taskId: this.taskId,
      requestId,
      toolName,
      input,
      receivedAt: new Date().toISOString(),
    };
    // Mark task as waiting for input so the UI can show the right state.
    this.setState('waiting_input');
    this.emit('permissionRequest', summary);
    try {
      const decision = await waitForDecision();
      this.emit('permissionResolved', requestId);
      // Whatever the decision, we go back to busy — the SDK will continue.
      this.setState('busy');
      return decision;
    } catch (err) {
      logger.error('canUseTool wait failed', {
        taskId: this.taskId,
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.setState('busy');
      return { behavior: 'deny', message: 'Permission resolver failed' };
    }
  }

  private async runLoop(): Promise<void> {
    if (!this.sdkQuery) return;
    let lastResult: SdkRunResultSummary | null = null;

    try {
      for await (const msg of this.sdkQuery) {
        if (this.destroyed) break;
        this.handleSdkMessage(msg);
        // Capture result summary from the terminal `result` message.
        const m = msg as { type: string };
        if (m.type === 'result') {
          const r = msg as unknown as {
            is_error?: boolean;
            num_turns?: number;
            total_cost_usd?: number;
            duration_ms?: number;
            usage?: SdkRunResultSummary['usage'];
          };
          lastResult = {
            isError: r.is_error === true,
            numTurns: r.num_turns,
            totalCostUsd: r.total_cost_usd,
            durationMs: r.duration_ms,
            usage: r.usage,
          };
          // Accumulate cumulative usage across multi-turn runs.
          if (r.usage) {
            this.tokenUsage.inputTokens += r.usage.input_tokens ?? 0;
            this.tokenUsage.outputTokens += r.usage.output_tokens ?? 0;
            this.tokenUsage.cacheCreationTokens += r.usage.cache_creation_input_tokens ?? 0;
            this.tokenUsage.cacheReadTokens += r.usage.cache_read_input_tokens ?? 0;
          }
          if (typeof r.total_cost_usd === 'number') {
            this.tokenUsage.totalCostUsd += r.total_cost_usd;
          }
          this.tokenUsage.lastUpdated = new Date().toISOString();
        }
      }
    } catch (err) {
      const e = err as Error;
      // The SDK throws "Claude Code process aborted by user" on abort —
      // treat that as a clean abort, not an error.
      if (e?.message?.includes('aborted by user')) {
        this.setState('interrupted');
        this.emit('aborted');
        return;
      }
      this.fail(err);
      return;
    }

    if (this.destroyed) return;
    this.setState('idle');
    this.emit('complete', lastResult ?? { isError: false });
  }

  private handleSdkMessage(msg: SDKMessage): void {
    // Capture sessionId on first system/init.
    const m = msg as { type: string; subtype?: string; session_id?: string; sessionId?: string };
    if (m.type === 'system' && m.subtype === 'init') {
      const sid = m.session_id || m.sessionId;
      if (sid && sid !== this.sessionId) {
        this.sessionId = sid;
        this.emit('sessionCaptured', sid);
      }
    }

    const events = normalizeSdkMessage(msg, {
      taskId: this.taskId,
      sessionId: this.sessionId ?? '',
    });
    for (const ev of events) {
      this.snapshot.push(ev);
      if (this.snapshot.length > SdkTaskRunner.MAX_SNAPSHOT) this.snapshot.shift();
      this.emit('event', ev);
    }
  }

  private setState(state: TaskState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('stateChanged', state);
  }

  private fail(err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    logger.error('SDK task failed', { taskId: this.taskId, error: e.message });
    this.setState('exited');
    this.emit('error', e);
  }
}

/**
 * Registry of running SDK tasks, indexed by taskId. Mirrors TaskSpawner's
 * tasks Map so the server can look up a runner by id when WS messages arrive.
 */
class SdkTaskRegistry {
  private readonly runners = new Map<string, SdkTaskRunner>();

  register(runner: SdkTaskRunner): void {
    this.runners.set(runner.taskId, runner);
    runner.once('error', () => this.runners.delete(runner.taskId));
  }

  get(taskId: string): SdkTaskRunner | undefined {
    return this.runners.get(taskId);
  }

  has(taskId: string): boolean {
    return this.runners.has(taskId);
  }

  remove(taskId: string): void {
    const r = this.runners.get(taskId);
    if (r) {
      r.destroy();
      this.runners.delete(taskId);
    }
  }

  list(): SdkTaskRunner[] {
    return Array.from(this.runners.values());
  }

  size(): number {
    return this.runners.size;
  }

  /**
   * Build a public Task representation for an SDK runner — used by code paths
   * that previously assumed PTY-only tasks. We share the same Task type so
   * the frontend treats SDK and PTY tasks uniformly.
   */
  toPublicTask(runner: SdkTaskRunner, prompt: string, displayName?: string): Task {
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
    };
  }
}

export const sdkTaskRegistry = new SdkTaskRegistry();
