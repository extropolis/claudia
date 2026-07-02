import { describe, it, expect } from 'vitest';
import { isTaskSettled } from '../subtask-wait';

describe('isTaskSettled', () => {
    it('exited/interrupted always settle', () => {
        expect(isTaskSettled('exited', false, 0)).toBe(true);
        expect(isTaskSettled('interrupted', false, 0)).toBe(true);
    });
    it('waiting_input settles (parent must decide how to answer)', () => {
        expect(isTaskSettled('waiting_input', false, 0)).toBe(true);
    });
    it('idle before ever being busy does NOT settle inside the grace window', () => {
        expect(isTaskSettled('idle', false, 5_000)).toBe(false);
    });
    it('idle after being busy settles', () => {
        expect(isTaskSettled('idle', true, 5_000)).toBe(true);
    });
    it('idle past the 30s grace settles even if busy was never seen', () => {
        expect(isTaskSettled('idle', false, 31_000)).toBe(true);
    });
    it('busy/starting never settle', () => {
        expect(isTaskSettled('busy', true, 60_000)).toBe(false);
        expect(isTaskSettled('starting', false, 60_000)).toBe(false);
    });
});
