/**
 * sdk-message-normalizer.ts
 *
 * Translates the SDK's SDKMessage union into Claudia's ConversationEvent
 * format so the existing React conversation view can render SDK-driven
 * tasks with no UI changes.
 *
 * The SDK ships ~30 message variants in its discriminated union (assistant,
 * user, result, system, partial_assistant, status, plus task / hook events).
 * We only need the human-visible ones for v1: assistant, user, system, result.
 * Everything else is logged for telemetry and dropped.
 *
 * UUID strategy:
 *   - Each SDK message has its own `uuid` (when present) — use as the base
 *     ConversationEvent.uuid.
 *   - Multi-block assistant turns split into one event per content block,
 *     suffixed `:t0`, `:t1` etc. matching the JSONL parser convention.
 *   - This keeps dedup behavior identical to the existing JSONL pipeline.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ConversationEvent } from '@claudia/shared';
import { createLogger } from './logger.js';

const logger = createLogger('[SdkNormalizer]');

interface NormalizeContext {
  taskId: string;
  /** Filled in once we see a session_init event. */
  sessionId: string;
}

/**
 * Convert one SDKMessage into zero or more ConversationEvents.
 * Pure function; caller is responsible for dispatching the events.
 */
export function normalizeSdkMessage(
  msg: SDKMessage,
  ctx: NormalizeContext,
): ConversationEvent[] {
  const m = msg as { type: string } & Record<string, unknown>;
  const t = m.type;

  switch (t) {
    case 'system':
      return normalizeSystemMessage(m, ctx);
    case 'assistant':
      return normalizeAssistantMessage(m, ctx);
    case 'user':
      return normalizeUserMessage(m, ctx);
    case 'result':
      return normalizeResultMessage(m, ctx);
    default:
      // Telemetry only — partial_assistant, status, task lifecycle, hooks,
      // commands_changed, retries, etc. We may surface some of these later
      // (e.g. status → activity indicator) but they don't belong in the
      // ConversationEvent timeline.
      logger.debug('SDK message ignored', { taskId: ctx.taskId, type: t });
      return [];
  }
}

// ───────────────────── system ─────────────────────

function normalizeSystemMessage(
  m: { type: string } & Record<string, unknown>,
  ctx: NormalizeContext,
): ConversationEvent[] {
  const subtype = (m as { subtype?: string }).subtype;
  // We map system/init to a session_meta event so the frontend can latch the
  // session id. Other system subtypes (api_retry, plugin_install, …) we drop
  // for now; they're useful for status banners, not the transcript.
  if (subtype !== 'init') return [];

  const uuid = stringField(m, 'uuid') || `sys-init-${Date.now()}`;
  const sessionId = stringField(m, 'session_id') || stringField(m, 'sessionId') || ctx.sessionId;
  const model = stringField(m, 'model');
  const cwd = stringField(m, 'cwd');
  return [
    {
      uuid,
      taskId: ctx.taskId,
      sessionId,
      type: 'session_meta',
      timestamp: new Date().toISOString(),
      meta: {
        model,
        cwd,
        ...(m as Record<string, unknown>),
      },
    },
  ];
}

// ───────────────────── assistant ─────────────────────

interface AssistantContent {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
}

function normalizeAssistantMessage(
  m: { type: string } & Record<string, unknown>,
  ctx: NormalizeContext,
): ConversationEvent[] {
  const message = (m as { message?: { id?: string; content?: AssistantContent[] } }).message;
  if (!message?.content) return [];

  const baseUuid = stringField(m, 'uuid') || message.id || `asst-${Date.now()}`;
  const sessionId = stringField(m, 'session_id') || stringField(m, 'sessionId') || ctx.sessionId;
  const ts = new Date().toISOString();
  const out: ConversationEvent[] = [];

  for (let i = 0; i < message.content.length; i++) {
    const block = message.content[i];
    if (block.type === 'text' && block.text) {
      const text = block.text.trim();
      if (text) {
        out.push({
          uuid: `${baseUuid}:t${i}`,
          taskId: ctx.taskId,
          sessionId,
          type: 'assistant_message',
          timestamp: ts,
          text,
        });
      }
    } else if (block.type === 'thinking' && block.thinking) {
      const text = block.thinking.trim();
      if (text) {
        out.push({
          uuid: `${baseUuid}:th${i}`,
          taskId: ctx.taskId,
          sessionId,
          type: 'thinking',
          timestamp: ts,
          text,
        });
      }
    } else if (block.type === 'tool_use' && block.id && block.name) {
      out.push({
        uuid: `${baseUuid}:tu${i}`,
        taskId: ctx.taskId,
        sessionId,
        type: 'tool_call',
        timestamp: ts,
        tool: {
          name: block.name,
          input: block.input ?? {},
          toolUseId: block.id,
        },
      });
    }
  }

  return out;
}

// ───────────────────── user (tool results) ─────────────────────

interface UserContent {
  type: string;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function normalizeUserMessage(
  m: { type: string } & Record<string, unknown>,
  ctx: NormalizeContext,
): ConversationEvent[] {
  const message = (m as { message?: { content?: UserContent[] | string } }).message;
  if (!message?.content) return [];

  const baseUuid = stringField(m, 'uuid') || `user-${Date.now()}`;
  const sessionId = stringField(m, 'session_id') || stringField(m, 'sessionId') || ctx.sessionId;
  const ts = new Date().toISOString();
  const out: ConversationEvent[] = [];

  // Plain text user message (rare in SDK flow — user prompts go in via query()
  // params, not as user-typed messages here. But we handle it for safety.)
  if (typeof message.content === 'string') {
    const text = message.content.trim();
    if (text) {
      out.push({
        uuid: baseUuid,
        taskId: ctx.taskId,
        sessionId,
        type: 'user_message',
        timestamp: ts,
        text,
      });
    }
    return out;
  }

  for (let i = 0; i < message.content.length; i++) {
    const c = message.content[i];
    if (c.type === 'tool_result' && c.tool_use_id) {
      out.push({
        uuid: `${baseUuid}:r${i}`,
        taskId: ctx.taskId,
        sessionId,
        type: 'tool_result',
        timestamp: ts,
        toolResult: {
          toolUseId: c.tool_use_id,
          output: stringifyToolResultContent(c.content),
          isError: c.is_error === true,
        },
      });
    } else if (c.type === 'text' && c.text) {
      const text = c.text.trim();
      if (text) {
        out.push({
          uuid: `${baseUuid}:t${i}`,
          taskId: ctx.taskId,
          sessionId,
          type: 'user_message',
          timestamp: ts,
          text,
        });
      }
    }
  }

  return out;
}

// ───────────────────── result (final summary) ─────────────────────

function normalizeResultMessage(
  m: { type: string } & Record<string, unknown>,
  ctx: NormalizeContext,
): ConversationEvent[] {
  // The SDK's terminal "result" message carries totals (cost, tokens, turns)
  // and any error state. We surface it as a summary system event so the UI
  // can show "Completed in 3 turns • $0.12 • 1.2k tokens" without inventing
  // a new event type.
  const r = m as {
    subtype?: string;
    is_error?: boolean;
    num_turns?: number;
    total_cost_usd?: number;
    duration_ms?: number;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  const uuid = stringField(m, 'uuid') || `result-${Date.now()}`;
  const sessionId = stringField(m, 'session_id') || stringField(m, 'sessionId') || ctx.sessionId;

  return [
    {
      uuid,
      taskId: ctx.taskId,
      sessionId,
      type: 'system',
      timestamp: new Date().toISOString(),
      text: formatResultSummary(r),
      meta: {
        kind: 'sdk_result',
        subtype: r.subtype,
        isError: r.is_error,
        numTurns: r.num_turns,
        totalCostUsd: r.total_cost_usd,
        durationMs: r.duration_ms,
        usage: r.usage,
      },
    },
  ];
}

function formatResultSummary(r: {
  subtype?: string;
  is_error?: boolean;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}): string {
  const parts: string[] = [];
  if (r.is_error) parts.push('⚠️ Run ended with error');
  else parts.push('✅ Run complete');
  if (typeof r.num_turns === 'number') parts.push(`${r.num_turns} turn${r.num_turns === 1 ? '' : 's'}`);
  if (typeof r.total_cost_usd === 'number') parts.push(`$${r.total_cost_usd.toFixed(4)}`);
  if (r.usage) {
    const inT = r.usage.input_tokens ?? 0;
    const outT = r.usage.output_tokens ?? 0;
    parts.push(`${inT}↑ / ${outT}↓ tokens`);
  }
  return parts.join(' · ');
}

// ───────────────────── helpers ─────────────────────

function stringField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === 'string' ? v : '';
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (c && typeof c === 'object' && 'type' in c) {
          const block = c as { type: string; text?: string };
          if (block.type === 'text' && block.text) return block.text;
        }
        try {
          return JSON.stringify(c);
        } catch {
          return String(c);
        }
      })
      .join('\n');
  }
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}
