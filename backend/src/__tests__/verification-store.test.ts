import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { VerificationStore, type CreateCardInput } from '../verification-store.js';

/**
 * Integration-flavoured tests: the store writes real JSON + PNG bytes to disk.
 *
 * Temp dirs live under homedir() rather than os.tmpdir() - on macOS /tmp
 * resolves under /var, which validateWorkspacePath blocklists as a system path.
 */
describe('VerificationStore', () => {
    let testBaseDir: string;
    let store: VerificationStore;

    /** A 1x1 PNG-ish buffer. The store never decodes it, so bytes are arbitrary. */
    const pngBytes = () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    function cardInput(overrides: Partial<CreateCardInput> = {}): CreateCardInput {
        return {
            taskId: 'task-1',
            workspaceId: 'workspace-1',
            claim: 'the coin pickup plays its animation',
            verdict: 'needs-human-eyes',
            capturer: 'playwright-web',
            images: [{ buffer: pngBytes(), label: 'after' }],
            ...overrides,
        };
    }

    beforeEach(() => {
        const uniqueId = Date.now() + '-' + Math.random().toString(36).substring(7);
        testBaseDir = join(homedir(), '.claudia-verification-test-' + uniqueId);
        mkdirSync(testBaseDir, { recursive: true });
        store = new VerificationStore(testBaseDir);
    });

    afterEach(() => {
        try {
            if (existsSync(testBaseDir)) {
                rmSync(testBaseDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            }
        } catch {
            // Ignore cleanup errors
        }
    });

    describe('judgeCard', () => {
        it('should persist both reason and note when rejecting', () => {
            const card = store.createCard(cardInput());

            const judged = store.judgeCard(card.id, 'looks-wrong', {
                reason: 'wrong-layout',
                note: 'the coin is behind the HUD',
            });

            expect(judged).toBeDefined();
            expect(judged?.humanVerdict).toBe('looks-wrong');
            expect(judged?.humanVerdictAt).toBeDefined();
            expect(judged?.rejectionReason).toBe('wrong-layout');
            expect(judged?.rejectionNote).toBe('the coin is behind the HUD');
        });

        it('should accept a reason without a note', () => {
            const card = store.createCard(cardInput());

            const judged = store.judgeCard(card.id, 'looks-wrong', { reason: 'nothing-rendered' });

            expect(judged?.rejectionReason).toBe('nothing-rendered');
            expect(judged?.rejectionNote).toBeUndefined();
        });

        it('should accept a free-text note without a reason', () => {
            const card = store.createCard(cardInput());

            const judged = store.judgeCard(card.id, 'looks-wrong', { note: 'hard to describe' });

            expect(judged?.rejectionReason).toBeUndefined();
            expect(judged?.rejectionNote).toBe('hard to describe');
        });

        it('should leave reason and note undefined when rejecting with no rejection arg', () => {
            const card = store.createCard(cardInput());

            const judged = store.judgeCard(card.id, 'looks-wrong');

            expect(judged?.humanVerdict).toBe('looks-wrong');
            expect(judged?.rejectionReason).toBeUndefined();
            expect(judged?.rejectionNote).toBeUndefined();
        });

        it('should leave reason and note undefined when approving', () => {
            const card = store.createCard(cardInput());

            const judged = store.judgeCard(card.id, 'looks-right');

            expect(judged?.humanVerdict).toBe('looks-right');
            expect(judged?.rejectionReason).toBeUndefined();
            expect(judged?.rejectionNote).toBeUndefined();
        });

        it('should clear a previously-set reason and note when re-judged as looks-right', () => {
            const card = store.createCard(cardInput());

            store.judgeCard(card.id, 'looks-wrong', {
                reason: 'visual-glitch',
                note: 'colours are inverted',
            });
            const rejudged = store.judgeCard(card.id, 'looks-right');

            expect(rejudged?.humanVerdict).toBe('looks-right');
            expect(rejudged?.rejectionReason).toBeUndefined();
            expect(rejudged?.rejectionNote).toBeUndefined();
            // Not merely undefined-valued - the keys are removed entirely, so a
            // stale reason cannot survive a JSON round-trip.
            expect('rejectionReason' in rejudged!).toBe(false);
            expect('rejectionNote' in rejudged!).toBe(false);
        });

        it('should ignore a rejection payload passed alongside looks-right', () => {
            const card = store.createCard(cardInput());

            const judged = store.judgeCard(card.id, 'looks-right', {
                reason: 'other',
                note: 'should not stick',
            });

            expect(judged?.rejectionReason).toBeUndefined();
            expect(judged?.rejectionNote).toBeUndefined();
        });

        it('should replace an earlier reason when re-rejected with a different one', () => {
            const card = store.createCard(cardInput());

            store.judgeCard(card.id, 'looks-wrong', { reason: 'wrong-layout', note: 'first pass' });
            const rejudged = store.judgeCard(card.id, 'looks-wrong', {
                reason: 'not-what-i-asked',
            });

            expect(rejudged?.rejectionReason).toBe('not-what-i-asked');
            expect(rejudged?.rejectionNote).toBeUndefined();
        });

        it('should return undefined for an unknown cardId', () => {
            expect(store.judgeCard('nonexistent', 'looks-wrong', { reason: 'other' })).toBeUndefined();
        });

        it('should mutate the stored card, not a copy', () => {
            const card = store.createCard(cardInput());

            store.judgeCard(card.id, 'looks-wrong', { reason: 'visual-glitch', note: 'tearing' });
            const fetched = store.getCard(card.id);

            expect(fetched?.humanVerdict).toBe('looks-wrong');
            expect(fetched?.rejectionReason).toBe('visual-glitch');
            expect(fetched?.rejectionNote).toBe('tearing');
        });
    });

    describe('markNotified', () => {
        it('should return true the first time and false the second time', () => {
            const card = store.createCard(cardInput());
            store.judgeCard(card.id, 'looks-wrong', { reason: 'other' });

            expect(store.markNotified(card.id)).toBe(true);
            expect(store.markNotified(card.id)).toBe(false);
        });

        it('should set notifiedAt on the first call', () => {
            const card = store.createCard(cardInput());

            expect(store.getCard(card.id)?.notifiedAt).toBeUndefined();
            store.markNotified(card.id);

            const notifiedAt = store.getCard(card.id)?.notifiedAt;
            expect(notifiedAt).toBeDefined();
            expect(Number.isNaN(Date.parse(notifiedAt!))).toBe(false);
        });

        it('should not overwrite the original notifiedAt on a repeat call', () => {
            const card = store.createCard(cardInput());

            store.markNotified(card.id);
            const first = store.getCard(card.id)?.notifiedAt;

            store.markNotified(card.id);
            expect(store.getCard(card.id)?.notifiedAt).toBe(first);
        });

        it('should return false for an unknown cardId', () => {
            expect(store.markNotified('nonexistent')).toBe(false);
        });

        it('should stay false after a re-judge, so a re-judged card is not notified twice', () => {
            const card = store.createCard(cardInput());

            store.judgeCard(card.id, 'looks-wrong', { reason: 'wrong-layout' });
            expect(store.markNotified(card.id)).toBe(true);

            store.judgeCard(card.id, 'looks-right');
            expect(store.markNotified(card.id)).toBe(false);
        });
    });

    describe('persistence', () => {
        it('should persist a rejection across store instances', () => {
            const card = store.createCard(cardInput());
            store.judgeCard(card.id, 'looks-wrong', {
                reason: 'not-what-i-asked',
                note: 'this is the menu, not the HUD',
            });
            store.markNotified(card.id);

            const reloaded = new VerificationStore(testBaseDir);
            const fetched = reloaded.getCard(card.id);

            expect(fetched).toBeDefined();
            expect(fetched?.humanVerdict).toBe('looks-wrong');
            expect(fetched?.rejectionReason).toBe('not-what-i-asked');
            expect(fetched?.rejectionNote).toBe('this is the menu, not the HUD');
            expect(fetched?.notifiedAt).toBeDefined();
        });

        it('should not resurrect a cleared reason after a reload', () => {
            const card = store.createCard(cardInput());
            store.judgeCard(card.id, 'looks-wrong', { reason: 'visual-glitch', note: 'artifacts' });
            store.judgeCard(card.id, 'looks-right');

            const reloaded = new VerificationStore(testBaseDir);
            const fetched = reloaded.getCard(card.id);

            expect(fetched?.humanVerdict).toBe('looks-right');
            expect(fetched?.rejectionReason).toBeUndefined();
            expect(fetched?.rejectionNote).toBeUndefined();
        });

        it('should keep markNotified idempotent across store instances', () => {
            const card = store.createCard(cardInput());
            expect(store.markNotified(card.id)).toBe(true);

            const reloaded = new VerificationStore(testBaseDir);
            expect(reloaded.markNotified(card.id)).toBe(false);
        });
    });

    describe('getPending', () => {
        it('should include an unjudged needs-human-eyes card', () => {
            const card = store.createCard(cardInput());

            const pending = store.getPending('workspace-1');
            expect(pending.map((c) => c.id)).toEqual([card.id]);
        });

        it('should exclude a card once it has been judged', () => {
            const card = store.createCard(cardInput());
            store.judgeCard(card.id, 'looks-right');

            expect(store.getPending('workspace-1')).toEqual([]);
        });

        it('should exclude a rejected card too - any verdict resolves it', () => {
            const card = store.createCard(cardInput());
            store.judgeCard(card.id, 'looks-wrong', { reason: 'nothing-rendered' });

            expect(store.getPending('workspace-1')).toEqual([]);
        });

        it('should exclude cards the agent already decided on', () => {
            store.createCard(cardInput({ verdict: 'pass' }));
            store.createCard(cardInput({ verdict: 'fail' }));

            expect(store.getPending('workspace-1')).toEqual([]);
        });

        it('should only return cards from the requested workspace', () => {
            const mine = store.createCard(cardInput());
            store.createCard(cardInput({ workspaceId: 'workspace-2' }));

            const pending = store.getPending('workspace-1');
            expect(pending.map((c) => c.id)).toEqual([mine.id]);
        });

        it('should return every workspace when no workspaceId is given', () => {
            store.createCard(cardInput());
            store.createCard(cardInput({ workspaceId: 'workspace-2' }));

            expect(store.getPending()).toHaveLength(2);
        });

        it('should exclude judged cards after a reload', () => {
            const judged = store.createCard(cardInput());
            const untouched = store.createCard(cardInput());
            store.judgeCard(judged.id, 'looks-wrong', { reason: 'other', note: 'nope' });

            const reloaded = new VerificationStore(testBaseDir);
            const pending = reloaded.getPending('workspace-1');

            expect(pending.map((c) => c.id)).toEqual([untouched.id]);
        });
    });
});
