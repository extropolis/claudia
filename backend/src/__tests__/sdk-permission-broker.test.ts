/**
 * Tests for sdk-permission-broker — verifies the request/resolve loop,
 * timeouts, and per-task cancellation.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { sdkPermissionBroker } from '../sdk-permission-broker.js';

describe('sdkPermissionBroker', () => {
  beforeEach(() => {
    // Cancel any leftover requests between tests so the singleton stays clean.
    sdkPermissionBroker.cancelTask('task-1');
    sdkPermissionBroker.cancelTask('task-2');
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with allow when client approves', async () => {
    const { requestId, waitForDecision } = sdkPermissionBroker.register(
      'task-1',
      'Bash',
      { command: 'ls' },
    );

    const promise = waitForDecision();
    const ok = sdkPermissionBroker.resolveDecision(requestId, { allow: true });
    expect(ok).toBe(true);

    const decision = await promise;
    expect(decision.behavior).toBe('allow');
    if (decision.behavior === 'allow') {
      expect(decision.updatedInput).toEqual({ command: 'ls' });
    }
  });

  it('resolves with deny when client rejects', async () => {
    const { requestId, waitForDecision } = sdkPermissionBroker.register(
      'task-1',
      'Write',
      { file_path: '/tmp/x', content: 'hi' },
    );

    const promise = waitForDecision();
    sdkPermissionBroker.resolveDecision(requestId, {
      allow: false,
      message: 'no thanks',
    });

    const decision = await promise;
    expect(decision.behavior).toBe('deny');
    if (decision.behavior === 'deny') {
      expect(decision.message).toBe('no thanks');
    }
  });

  it('returns false for unknown requestId', () => {
    const ok = sdkPermissionBroker.resolveDecision('nonexistent', {
      allow: true,
    });
    expect(ok).toBe(false);
  });

  it('cancels all pending requests for a task', async () => {
    const { requestId: r1, waitForDecision: w1 } = sdkPermissionBroker.register(
      'task-1',
      'Bash',
      {},
    );
    const { requestId: r2, waitForDecision: w2 } = sdkPermissionBroker.register(
      'task-1',
      'Read',
      {},
    );
    const { requestId: r3, waitForDecision: w3 } = sdkPermissionBroker.register(
      'task-2',
      'Bash',
      {},
    );

    const cancelled = sdkPermissionBroker.cancelTask('task-1', 'aborted');
    expect(cancelled).toBe(2);

    const [d1, d2] = await Promise.all([w1(), w2()]);
    expect(d1.behavior).toBe('deny');
    expect(d2.behavior).toBe('deny');

    // task-2's request should be untouched.
    expect(sdkPermissionBroker.listForTask('task-2')).toHaveLength(1);
    sdkPermissionBroker.resolveDecision(r3, { allow: true });
    const d3 = await w3();
    expect(d3.behavior).toBe('allow');

    // r1, r2 should have been removed
    expect(r1).not.toBe(r2);
  });

  it('lists pending requests for reconnecting clients', () => {
    sdkPermissionBroker.register('task-1', 'Bash', { command: 'ls' });
    sdkPermissionBroker.register('task-1', 'Read', { file_path: '/x' });
    sdkPermissionBroker.register('task-2', 'Bash', { command: 'pwd' });

    const t1 = sdkPermissionBroker.listForTask('task-1');
    expect(t1).toHaveLength(2);
    expect(t1.map((r) => r.toolName).sort()).toEqual(['Bash', 'Read']);

    const t2 = sdkPermissionBroker.listForTask('task-2');
    expect(t2).toHaveLength(1);
    expect(t2[0].toolName).toBe('Bash');
  });

  it('times out non-interactive requests after default window', async () => {
    const { waitForDecision } = sdkPermissionBroker.register(
      'task-1',
      'Bash',
      { command: 'sleep 999' },
    );

    const promise = waitForDecision();
    // 55s default + a bit
    vi.advanceTimersByTime(60_000);
    const decision = await promise;
    expect(decision.behavior).toBe('deny');
    if (decision.behavior === 'deny') {
      expect(decision.message).toMatch(/timed out/);
    }
  });

  it('does NOT time out interactive tools', async () => {
    const { requestId, waitForDecision } = sdkPermissionBroker.register(
      'task-1',
      'AskUserQuestion',
      { question: 'pick' },
    );

    const promise = waitForDecision();
    vi.advanceTimersByTime(120_000);
    // Should still be pending — resolve manually to clean up.
    expect(sdkPermissionBroker.listForTask('task-1')).toHaveLength(1);
    sdkPermissionBroker.resolveDecision(requestId, { allow: true });
    const d = await promise;
    expect(d.behavior).toBe('allow');
  });
});
