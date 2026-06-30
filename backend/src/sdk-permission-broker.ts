/**
 * sdk-permission-broker.ts
 *
 * Tracks pending tool-approval requests for SDK-driven tasks. When the SDK
 * fires our canUseTool callback we register a pending request keyed by
 * (taskId, requestId) and return a Promise that resolves when the client
 * sends back a permission decision over WebSocket.
 *
 * Design notes:
 *   - Module-scoped singleton — there's one broker per backend process.
 *     Multiple SDK tasks can have multiple pending requests in flight.
 *   - Reconnect-safe: pending requests live in memory, so a client that
 *     disconnects and reconnects can refetch the list and keep approving.
 *     The SDK's canUseTool promise just keeps waiting.
 *   - Timeouts default to 55s for normal tools (matches CloudCLI's default
 *     to give the user time to react before the SDK gives up). Interactive
 *     tools (AskUserQuestion, ExitPlanMode) wait indefinitely.
 *   - All decisions go through resolve() so the SDK callback always returns
 *     and the task doesn't hang.
 */
import { randomUUID } from 'crypto';
import { createLogger } from './logger.js';

const logger = createLogger('[SdkPermissionBroker]');

/**
 * The shape we return to the SDK's canUseTool callback.
 * @see node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts type CanUseTool
 */
export type ToolApprovalDecision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

/**
 * Decision payload the client sends over WS to resolve a request.
 */
export interface ClientPermissionResponse {
  allow: boolean;
  /** Optional permission rule to remember for future calls (e.g. "Bash(npm test:*)"). */
  rememberRule?: string;
  /** Optional tweaked tool input the user edited before approving. */
  updatedInput?: Record<string, unknown>;
  /** Reason text shown to the model when denied. */
  message?: string;
}

/**
 * What we expose to the WS layer when listing pending requests so a
 * reconnecting client can rebuild its banner.
 */
export interface PendingRequestSummary {
  taskId: string;
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  receivedAt: string;
}

interface PendingEntry {
  taskId: string;
  toolName: string;
  input: Record<string, unknown>;
  receivedAt: Date;
  resolve: (decision: ToolApprovalDecision) => void;
  timeout: NodeJS.Timeout | null;
}

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(
  process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS || '',
  10,
) || 55_000;

/** Tools where a denial isn't recoverable — wait forever rather than timing out. */
const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

class SdkPermissionBroker {
  private readonly pending = new Map<string, PendingEntry>();

  /**
   * Register a pending approval. Returns:
   *   - { requestId } so the caller can broadcast a permission_request event
   *   - waitForDecision() — promise the SDK callback awaits
   */
  register(
    taskId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): { requestId: string; waitForDecision: () => Promise<ToolApprovalDecision> } {
    const requestId = randomUUID();
    const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);
    const timeoutMs = requiresInteraction ? 0 : TOOL_APPROVAL_TIMEOUT_MS;

    let resolve!: (d: ToolApprovalDecision) => void;
    const promise = new Promise<ToolApprovalDecision>((r) => {
      resolve = r;
    });

    const entry: PendingEntry = {
      taskId,
      toolName,
      input,
      receivedAt: new Date(),
      resolve,
      timeout: null,
    };

    if (timeoutMs > 0) {
      entry.timeout = setTimeout(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          logger.warn('SDK tool approval timed out', { taskId, requestId, toolName, timeoutMs });
          resolve({ behavior: 'deny', message: 'Permission request timed out' });
        }
      }, timeoutMs);
    }

    this.pending.set(requestId, entry);
    logger.info('SDK tool approval registered', { taskId, requestId, toolName });

    return {
      requestId,
      waitForDecision: () => promise,
    };
  }

  /** Resolve a pending approval with the client's decision. Returns false if not found. */
  resolveDecision(requestId: string, response: ClientPermissionResponse): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) {
      logger.warn('SDK permission decision for unknown request', { requestId });
      return false;
    }
    this.pending.delete(requestId);
    if (entry.timeout) clearTimeout(entry.timeout);

    if (response.allow) {
      entry.resolve({
        behavior: 'allow',
        updatedInput: response.updatedInput ?? entry.input,
      });
    } else {
      entry.resolve({
        behavior: 'deny',
        message: response.message ?? 'User denied tool use',
      });
    }
    logger.info('SDK tool approval resolved', {
      taskId: entry.taskId,
      requestId,
      toolName: entry.toolName,
      allow: response.allow,
    });
    return true;
  }

  /** Cancel pending approvals for a task — used when the task is destroyed/aborted. */
  cancelTask(taskId: string, reason = 'task aborted'): number {
    let count = 0;
    for (const [requestId, entry] of this.pending.entries()) {
      if (entry.taskId === taskId) {
        if (entry.timeout) clearTimeout(entry.timeout);
        this.pending.delete(requestId);
        entry.resolve({ behavior: 'deny', message: reason });
        count++;
      }
    }
    if (count > 0) {
      logger.info('SDK pending approvals cancelled', { taskId, count, reason });
    }
    return count;
  }

  /** List pending approvals for a task — used by reconnecting clients. */
  listForTask(taskId: string): PendingRequestSummary[] {
    const out: PendingRequestSummary[] = [];
    for (const [requestId, entry] of this.pending.entries()) {
      if (entry.taskId === taskId) {
        out.push({
          taskId,
          requestId,
          toolName: entry.toolName,
          input: entry.input,
          receivedAt: entry.receivedAt.toISOString(),
        });
      }
    }
    return out;
  }

  /** Visibility for tests / debug. */
  size(): number {
    return this.pending.size;
  }
}

// Singleton — one broker per process.
export const sdkPermissionBroker = new SdkPermissionBroker();
