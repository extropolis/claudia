import { describe, it, expect } from 'vitest';
import { shouldEmitIdleSummary } from '../task-summary.js';

// The mobile companion fires exactly one task:summary / chat message when a
// task settles from an active state to idle (see queueTaskStateChange in
// server.ts). These tests pin down that transition table.

describe('shouldEmitIdleSummary', () => {
    it('fires on busy → idle', () => {
        expect(shouldEmitIdleSummary('busy', 'idle')).toBe(true);
    });

    it('fires on starting → idle', () => {
        expect(shouldEmitIdleSummary('starting', 'idle')).toBe(true);
    });

    it('fires on waiting_input → idle', () => {
        expect(shouldEmitIdleSummary('waiting_input', 'idle')).toBe(true);
    });

    it('does not fire when the task was already idle (idle → idle)', () => {
        expect(shouldEmitIdleSummary('idle', 'idle')).toBe(false);
    });

    it('does not fire on first sight of a task (undefined → idle)', () => {
        expect(shouldEmitIdleSummary(undefined, 'idle')).toBe(false);
    });

    it('does not fire from terminal states (exited/archived → idle)', () => {
        expect(shouldEmitIdleSummary('exited', 'idle')).toBe(false);
        expect(shouldEmitIdleSummary('archived', 'idle')).toBe(false);
    });

    it('does not fire when the new state is not idle', () => {
        expect(shouldEmitIdleSummary('busy', 'exited')).toBe(false);
        expect(shouldEmitIdleSummary('busy', 'waiting_input')).toBe(false);
        expect(shouldEmitIdleSummary('busy', 'busy')).toBe(false);
        expect(shouldEmitIdleSummary('starting', 'busy')).toBe(false);
    });

    it('does not fire on disconnected/interrupted → idle (reconnects are not completions)', () => {
        expect(shouldEmitIdleSummary('disconnected', 'idle')).toBe(false);
        expect(shouldEmitIdleSummary('interrupted', 'idle')).toBe(false);
    });
});
