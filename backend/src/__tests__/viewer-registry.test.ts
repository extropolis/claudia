/**
 * ViewerRegistry — the ownership rules the WS layer enforces on `task:resize`.
 *
 * Tested here as a pure unit because every branch is a policy decision (who may
 * resize, what a disconnect releases, how many viewers a task has) and none of
 * it needs a socket. `ws-viewer-model.test.ts` then proves the real server
 * actually applies these rules end to end.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ViewerRegistry } from '../viewer-registry.js';

const A = 'web:127.0.0.1#1';
const B = 'web:127.0.0.1#2';
const C = 'mobile:10.0.0.5#3';

describe('ViewerRegistry — ownership', () => {
    let reg: ViewerRegistry;
    beforeEach(() => { reg = new ViewerRegistry(); });

    it('has no owner and no viewers for an untouched task', () => {
        expect(reg.owner('t1')).toBeNull();
        expect(reg.count('t1')).toBe(0);
        expect(reg.snapshot('t1')).toEqual({ taskId: 't1', count: 0, ownerClientId: null });
    });

    it('makes the focusing client the owner', () => {
        expect(reg.focus('t1', A)).toEqual(['t1']);
        expect(reg.owner('t1')).toBe(A);
        expect(reg.isOwner('t1', A)).toBe(true);
        expect(reg.isOwner('t1', B)).toBe(false);
    });

    it('hands ownership to the most recent client to focus', () => {
        reg.focus('t1', A);
        reg.focus('t1', B);
        expect(reg.owner('t1')).toBe(B);
        expect(reg.isOwner('t1', A)).toBe(false);
    });

    it('reports a repeat focus as no change so it does not spam broadcasts', () => {
        reg.focus('t1', A);
        expect(reg.focus('t1', A)).toEqual([]);
    });

    it('re-broadcasts a repeat focus when the client had lost ownership', () => {
        reg.focus('t1', A);
        reg.focus('t1', B);          // B steals the terminal
        expect(reg.focus('t1', A)).toEqual(['t1']); // A takes it back
        expect(reg.owner('t1')).toBe(A);
    });

    it('releases the previously focused task when a client looks elsewhere', () => {
        reg.focus('t1', A);
        expect(reg.focus('t2', A)).toEqual(['t1', 't2']);
        expect(reg.owner('t1')).toBeNull();
        expect(reg.count('t1')).toBe(0);
        expect(reg.owner('t2')).toBe(A);
    });

    it('leaves another client as owner of the task it moved away from', () => {
        reg.focus('t1', A);
        reg.focus('t1', B);          // B owns t1, both viewing
        reg.focus('t2', B);          // B leaves; A is still viewing t1
        expect(reg.owner('t1')).toBeNull(); // released, ready for A's next resize
        expect(reg.count('t1')).toBe(1);
    });
});

describe('ViewerRegistry — claim (the resize gate)', () => {
    let reg: ViewerRegistry;
    beforeEach(() => { reg = new ViewerRegistry(); });

    it('lets the first resize on an unowned task claim it', () => {
        expect(reg.claim('t1', A)).toBe(true);
        expect(reg.owner('t1')).toBe(A);
    });

    it('refuses a non-owner and does not steal ownership', () => {
        reg.focus('t1', A);
        expect(reg.claim('t1', B)).toBe(false);
        expect(reg.owner('t1')).toBe(A);
    });

    it('lets the owner resize repeatedly', () => {
        reg.focus('t1', A);
        expect(reg.claim('t1', A)).toBe(true);
        expect(reg.claim('t1', A)).toBe(true);
    });

    it('does not count a claim as a viewer — claiming is not focusing', () => {
        reg.claim('t1', A);
        expect(reg.count('t1')).toBe(0);
        expect(reg.owner('t1')).toBe(A);
    });
});

describe('ViewerRegistry — viewer count', () => {
    let reg: ViewerRegistry;
    beforeEach(() => { reg = new ViewerRegistry(); });

    it('counts every client currently focused on the task', () => {
        reg.focus('t1', A);
        reg.focus('t1', B);
        reg.focus('t1', C);
        expect(reg.count('t1')).toBe(3);
        expect(reg.snapshot('t1')).toEqual({ taskId: 't1', count: 3, ownerClientId: C });
    });

    it('counts a client against exactly one task at a time', () => {
        reg.focus('t1', A);
        reg.focus('t2', A);
        expect(reg.count('t1')).toBe(0);
        expect(reg.count('t2')).toBe(1);
    });
});

describe('ViewerRegistry — disconnect', () => {
    let reg: ViewerRegistry;
    beforeEach(() => { reg = new ViewerRegistry(); });

    it('releases ownership so a surviving viewer can claim it', () => {
        reg.focus('t1', A);
        reg.focus('t1', B);
        reg.focus('t1', A);          // A is owner, B still viewing

        expect(reg.dropClient(A)).toEqual(['t1']);

        expect(reg.owner('t1')).toBeNull();
        expect(reg.count('t1')).toBe(1);
        expect(reg.claim('t1', B)).toBe(true);
    });

    it('releases every task the client owned, not just the focused one', () => {
        reg.claim('t1', A);          // owned via a bare resize, never focused
        reg.focus('t2', A);

        expect(reg.dropClient(A).sort()).toEqual(['t1', 't2']);
        expect(reg.owner('t1')).toBeNull();
        expect(reg.owner('t2')).toBeNull();
    });

    it('is a no-op for a client that never viewed anything', () => {
        expect(reg.dropClient(A)).toEqual([]);
    });

    it('does not disturb other clients', () => {
        reg.focus('t1', A);
        reg.focus('t1', B);
        reg.dropClient(A);
        expect(reg.count('t1')).toBe(1);
        expect(reg.claim('t1', B)).toBe(true);
    });
});

describe('ViewerRegistry — dropTask', () => {
    it('forgets a destroyed task so the maps cannot grow without bound', () => {
        const reg = new ViewerRegistry();
        reg.focus('t1', A);
        reg.focus('t1', B);

        reg.dropTask('t1');

        expect(reg.owner('t1')).toBeNull();
        expect(reg.count('t1')).toBe(0);
        // The clients are free again: focusing another task must still work.
        expect(reg.focus('t2', A)).toEqual(['t2']);
    });
});
