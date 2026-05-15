import { describe, it, expect } from 'vitest';
import { TaskState } from '@claudia/shared';

/**
 * Tests for the disconnected task state restoration logic from task-spawner.ts.
 * This logic determines what state a task should be shown in after a server restart.
 */

interface PersistedTask {
  wasInterrupted: boolean;
  lastState: TaskState;
}

/**
 * Extracted logic from task-spawner.ts getAllTasks() for testability.
 * Determines the displayed state for a disconnected task.
 */
function resolveDisconnectedState(persisted: PersistedTask): TaskState {
  if (
    persisted.wasInterrupted &&
    (persisted.lastState === 'busy' || persisted.lastState === 'starting')
  ) {
    return 'interrupted';
  }
  if (persisted.lastState === 'idle') {
    return 'idle';
  }
  return 'disconnected';
}

describe('disconnected task state resolution', () => {
  it('should show interrupted for tasks that were busy when killed', () => {
    expect(resolveDisconnectedState({ wasInterrupted: true, lastState: 'busy' })).toBe(
      'interrupted',
    );
  });

  it('should show interrupted for tasks that were starting when killed', () => {
    expect(resolveDisconnectedState({ wasInterrupted: true, lastState: 'starting' })).toBe(
      'interrupted',
    );
  });

  it('should preserve idle state (green check) for idle tasks', () => {
    expect(resolveDisconnectedState({ wasInterrupted: true, lastState: 'idle' })).toBe('idle');
    expect(resolveDisconnectedState({ wasInterrupted: false, lastState: 'idle' })).toBe('idle');
  });

  it('should show disconnected for non-busy interrupted tasks', () => {
    expect(resolveDisconnectedState({ wasInterrupted: true, lastState: 'waiting_input' })).toBe(
      'disconnected',
    );
    expect(resolveDisconnectedState({ wasInterrupted: true, lastState: 'disconnected' })).toBe(
      'disconnected',
    );
  });

  it('should show disconnected for non-interrupted non-idle tasks', () => {
    expect(resolveDisconnectedState({ wasInterrupted: false, lastState: 'busy' })).toBe(
      'disconnected',
    );
    expect(resolveDisconnectedState({ wasInterrupted: false, lastState: 'starting' })).toBe(
      'disconnected',
    );
    expect(resolveDisconnectedState({ wasInterrupted: false, lastState: 'waiting_input' })).toBe(
      'disconnected',
    );
  });

  it('should show disconnected for exited tasks', () => {
    expect(resolveDisconnectedState({ wasInterrupted: false, lastState: 'exited' })).toBe(
      'disconnected',
    );
    expect(resolveDisconnectedState({ wasInterrupted: true, lastState: 'exited' })).toBe(
      'disconnected',
    );
  });
});
