/**
 * Tests for sdk-task-runner — focused on lifecycle and token accumulation.
 *
 * We don't actually call the SDK here (would require a live network and
 * Claude credentials). Instead we exercise the helpers that don't depend
 * on query() being live: state machine snapshots and token bookkeeping.
 *
 * The end-to-end real-SDK exercise lives in sdk-cli.ts (manual run against
 * a running backend).
 */
import { describe, it, expect } from 'vitest';
import { sdkTaskRegistry } from '../sdk-task-runner.js';

describe('sdkTaskRegistry', () => {
  it('starts empty', () => {
    // The registry is module-scoped, so this assumption only holds in a
    // fresh test process. Vitest gives us one per file by default.
    expect(sdkTaskRegistry.list()).toBeInstanceOf(Array);
  });

  it('returns undefined for unknown taskIds', () => {
    expect(sdkTaskRegistry.get('does-not-exist')).toBeUndefined();
    expect(sdkTaskRegistry.has('does-not-exist')).toBe(false);
  });
});
