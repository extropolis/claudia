/**
 * Tests for sdk-message-normalizer — verifies SDK message shapes get
 * translated into the right ConversationEvents.
 *
 * The SDK type union is huge; we don't try to cover every variant. We cover
 * the four kinds the v1 chat UI cares about: system/init, assistant (text +
 * thinking + tool_use), user (tool_result + text), result.
 */
import { describe, it, expect } from 'vitest';
import { normalizeSdkMessage } from '../sdk-message-normalizer.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const ctx = { taskId: 'T1', sessionId: 'S1' };

// Helper: builds a minimally-typed SDK-message-shaped object. We assert the
// `as unknown as SDKMessage` cast because the actual union is enormous and
// we only need a structural subset for the normalizer to do its job.
function sdkMsg<T extends Record<string, unknown>>(o: T): SDKMessage {
  return o as unknown as SDKMessage;
}

describe('normalizeSdkMessage', () => {
  it('emits session_meta from system/init', () => {
    const events = normalizeSdkMessage(
      sdkMsg({
        type: 'system',
        subtype: 'init',
        uuid: 'sys-1',
        session_id: 'S1',
        model: 'claude-sonnet-4-5',
        cwd: '/tmp',
      }),
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('session_meta');
    expect(events[0].uuid).toBe('sys-1');
    expect(events[0].meta?.model).toBe('claude-sonnet-4-5');
    expect(events[0].meta?.cwd).toBe('/tmp');
  });

  it('drops other system subtypes', () => {
    const events = normalizeSdkMessage(
      sdkMsg({ type: 'system', subtype: 'api_retry', uuid: 'r1' }),
      ctx,
    );
    expect(events).toHaveLength(0);
  });

  it('emits assistant_message for text blocks', () => {
    const events = normalizeSdkMessage(
      sdkMsg({
        type: 'assistant',
        uuid: 'a1',
        message: {
          id: 'msg-x',
          content: [{ type: 'text', text: 'hello world' }],
        },
      }),
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('assistant_message');
    expect(events[0].text).toBe('hello world');
    expect(events[0].uuid).toBe('a1:t0');
  });

  it('splits multi-block assistant turns', () => {
    const events = normalizeSdkMessage(
      sdkMsg({
        type: 'assistant',
        uuid: 'a2',
        message: {
          id: 'msg-y',
          content: [
            { type: 'text', text: 'thinking…' },
            { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } },
            { type: 'text', text: 'done' },
          ],
        },
      }),
      ctx,
    );
    expect(events).toHaveLength(3);
    expect(events[0].uuid).toBe('a2:t0');
    expect(events[0].type).toBe('assistant_message');
    expect(events[1].uuid).toBe('a2:tu1');
    expect(events[1].type).toBe('tool_call');
    expect(events[1].tool?.name).toBe('Bash');
    expect(events[1].tool?.toolUseId).toBe('tu-1');
    expect(events[2].uuid).toBe('a2:t2');
    expect(events[2].type).toBe('assistant_message');
    expect(events[2].text).toBe('done');
  });

  it('emits thinking events', () => {
    const events = normalizeSdkMessage(
      sdkMsg({
        type: 'assistant',
        uuid: 'a3',
        message: {
          id: 'msg-z',
          content: [{ type: 'thinking', thinking: 'let me think...' }],
        },
      }),
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('thinking');
    expect(events[0].text).toBe('let me think...');
    expect(events[0].uuid).toBe('a3:th0');
  });

  it('emits tool_result for user tool_result blocks', () => {
    const events = normalizeSdkMessage(
      sdkMsg({
        type: 'user',
        uuid: 'u1',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-1',
              content: 'file1.ts\nfile2.ts',
            },
          ],
        },
      }),
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_result');
    expect(events[0].toolResult?.toolUseId).toBe('tu-1');
    expect(events[0].toolResult?.output).toContain('file1.ts');
    expect(events[0].toolResult?.isError).toBeFalsy();
  });

  it('handles tool_result content arrays', () => {
    const events = normalizeSdkMessage(
      sdkMsg({
        type: 'user',
        uuid: 'u2',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-2',
              content: [
                { type: 'text', text: 'line1' },
                { type: 'text', text: 'line2' },
              ],
              is_error: false,
            },
          ],
        },
      }),
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0].toolResult?.output).toBe('line1\nline2');
  });

  it('flags errored tool results', () => {
    const events = normalizeSdkMessage(
      sdkMsg({
        type: 'user',
        uuid: 'u3',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-3',
              content: 'permission denied',
              is_error: true,
            },
          ],
        },
      }),
      ctx,
    );
    expect(events[0].toolResult?.isError).toBe(true);
  });

  it('emits a system summary for result messages', () => {
    const events = normalizeSdkMessage(
      sdkMsg({
        type: 'result',
        subtype: 'success',
        uuid: 'r1',
        is_error: false,
        num_turns: 3,
        total_cost_usd: 0.0123,
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('system');
    expect(events[0].text).toContain('Run complete');
    expect(events[0].text).toContain('3 turns');
    expect(events[0].text).toContain('$0.0123');
    expect(events[0].meta?.kind).toBe('sdk_result');
    expect(events[0].meta?.totalCostUsd).toBe(0.0123);
  });

  it('marks errored results', () => {
    const events = normalizeSdkMessage(
      sdkMsg({
        type: 'result',
        subtype: 'error',
        uuid: 'r2',
        is_error: true,
        num_turns: 1,
      }),
      ctx,
    );
    expect(events[0].text).toContain('error');
  });

  it('drops empty/whitespace-only assistant text', () => {
    const events = normalizeSdkMessage(
      sdkMsg({
        type: 'assistant',
        uuid: 'a4',
        message: {
          id: 'msg-empty',
          content: [{ type: 'text', text: '   \n  ' }],
        },
      }),
      ctx,
    );
    expect(events).toHaveLength(0);
  });

  it('returns [] for unknown message types', () => {
    const events = normalizeSdkMessage(
      sdkMsg({ type: 'unknown_future_type', payload: 'x' }),
      ctx,
    );
    expect(events).toHaveLength(0);
  });
});
