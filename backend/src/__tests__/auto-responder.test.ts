import { describe, it, expect } from 'vitest';
import { decide, extractQuestion, DEFAULT_CONFIG } from '../auto-responder.js';

const q = (recentOutput: string, extra: Partial<Parameters<typeof decide>[0]> = {}) =>
    decide({ waitingInputType: 'question', recentOutput, ...extra });

describe('extractQuestion', () => {
    it('pulls the last real question out of a terminal tail', () => {
        const out = 'Some earlier line\nWant me to run the tests?\n❯\n? for shortcuts';
        expect(extractQuestion(out)).toContain('Want me to run the tests?');
    });

    it('ignores TUI chrome', () => {
        const out = '❯\n? for shortcuts\nTry "edit <filepath>"';
        const got = extractQuestion(out);
        expect(got === null || !got.includes('shortcuts')).toBe(true);
    });

    it('returns null on empty input', () => {
        expect(extractQuestion('')).toBeNull();
    });
});

describe('auto-responder: safe approvals', () => {
    it('approves verification requests', () => {
        const d = q('The fix is in. Should I run the tests to confirm?');
        expect(d.action).toBe('respond');
        expect(d.reason).toBe('verification');
    });

    it('approves plain continuation', () => {
        const d = q('Want me to proceed to G3?');
        expect(d.action).toBe('respond');
        expect(d.reply).toBe('continue');
    });

    it('replies terse, in the user style (<= 4 words)', () => {
        for (const out of ['Want me to proceed to G3?', 'Should I run the tests?', 'Want me to fix it?']) {
            const d = q(out);
            if (d.action === 'respond') {
                expect(d.reply!.split(/\s+/).length).toBeLessThanOrEqual(4);
                expect(d.reply).toBe(d.reply!.toLowerCase());
            }
        }
    });
});

describe('auto-responder: hard blocks', () => {
    const cases: Array<[string, string, string]> = [
        ['commit', 'All tests pass. Want me to commit this?', 'irreversible'],
        ['push', 'Should I push it to origin?', 'irreversible'],
        ['merge', 'Want me to merge it into main?', 'irreversible'],
        ['deploy', 'Want me to deploy it?', 'irreversible'],
        ['force push', 'Want me to force-push the rebased branch?', 'destructive'],
        ['rm -rf', 'Should I run rm -rf node_modules?', 'destructive'],
        ['reset --hard', 'Want me to git reset --hard?', 'destructive'],
        ['secrets', 'The client secrets are still live. Want me to rotate them?', 'secret'],
        ['.dev.vars', 'I will write .dev.vars. Want me to continue?', 'secret'],
    ];

    for (const [name, output, reason] of cases) {
        it(`escalates ${name}`, () => {
            const d = q(output);
            expect(d.action).toBe('escalate');
            expect(d.reason).toBe(reason);
        });
    }

    it('lets a hard block beat verification phrasing', () => {
        const d = q('Want me to run the tests again and then push to main?');
        expect(d.action).toBe('escalate');
        expect(d.reason).toBe('irreversible');
    });
});

describe('auto-responder: the interrupt instinct', () => {
    it('escalates on repeated-failure thrash', () => {
        const d = q('error attempt 3/3: Connection error.\nWant me to try again?');
        expect(d.action).toBe('escalate');
        expect(d.reason).toBe('thrash');
    });

    it('escalates when the question offers an off-ramp', () => {
        const d = q('Want me to continue into Stage 3, or pause here so you can look first?');
        expect(d.action).toBe('escalate');
    });

    it('escalates open design forks', () => {
        expect(q('What do you think we should do next?').action).toBe('escalate');
        expect(q('Which approach do you prefer?').action).toBe('escalate');
    });
});

describe('auto-responder: structural guards', () => {
    it('never answers permission dialogs by default', () => {
        const d = decide({ waitingInputType: 'permission', recentOutput: 'Allow\nDeny' });
        expect(d.action).toBe('escalate');
        expect(d.reason).toBe('permission');
    });

    it('escalates when not waiting for input', () => {
        const d = decide({ waitingInputType: null, recentOutput: 'Thinking...' });
        expect(d.reason).toBe('not_waiting');
    });

    it('stops after the consecutive budget is spent', () => {
        const d = q('Want me to continue?', { consecutiveCount: DEFAULT_CONFIG.maxConsecutive });
        expect(d.action).toBe('escalate');
        expect(d.reason).toBe('budget_exhausted');
    });

    it('honours the disabled flag', () => {
        const d = decide(
            { waitingInputType: 'question', recentOutput: 'Want me to continue?' },
            { ...DEFAULT_CONFIG, enabled: false }
        );
        expect(d.action).toBe('escalate');
        expect(d.reason).toBe('disabled');
    });

    it('is pure — same input yields same decision', () => {
        const out = 'Want me to proceed to G3?';
        expect(decide({ waitingInputType: 'question', recentOutput: out }))
            .toEqual(decide({ waitingInputType: 'question', recentOutput: out }));
    });
});
