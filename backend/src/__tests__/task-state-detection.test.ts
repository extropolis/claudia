import { describe, it, expect } from 'vitest';
import {
    stripAnsi,
    isReadyForInitialInput,
    extractSessionId,
    hasProcessingIndicators,
    hasActiveTurnIndicator,
    classifyEnterOutcome,
    detectWaitingForInput,
    getRecentOutput,
} from '../task-state-detection.js';

describe('stripAnsi', () => {
    it('should remove color codes', () => {
        const input = '\x1b[31mred text\x1b[0m';
        expect(stripAnsi(input)).toBe('red text');
    });

    it('should remove cursor movement codes', () => {
        const input = '\x1b[2Amove up\x1b[10Bmove down';
        expect(stripAnsi(input)).toBe('move upmove down');
    });

    it('should remove OSC sequences', () => {
        const input = '\x1b]0;window title\x07content';
        expect(stripAnsi(input)).toBe('content');
    });

    it('should remove mode setting codes', () => {
        const input = '\x1b[?25hshow cursor\x1b[?25l';
        expect(stripAnsi(input)).toBe('show cursor');
    });

    it('should remove control characters', () => {
        const input = 'hello\x00\x01\x02world';
        expect(stripAnsi(input)).toBe('helloworld');
    });

    it('should remove carriage returns', () => {
        const input = 'line1\rline2';
        expect(stripAnsi(input)).toBe('line1line2');
    });

    it('should preserve normal text', () => {
        const input = 'Hello, world! 123 !@#$%';
        expect(stripAnsi(input)).toBe('Hello, world! 123 !@#$%');
    });

    it('should preserve unicode', () => {
        const input = 'Hello 世界 🌍';
        expect(stripAnsi(input)).toBe('Hello 世界 🌍');
    });

    it('should handle empty string', () => {
        expect(stripAnsi('')).toBe('');
    });

    it('should handle multiple ANSI codes', () => {
        const input = '\x1b[1m\x1b[31mbold red\x1b[0m \x1b[32mgreen\x1b[0m';
        expect(stripAnsi(input)).toBe('bold red green');
    });
});

describe('isReadyForInitialInput', () => {
    it('should detect "Try" hint', () => {
        expect(isReadyForInitialInput('Try "something" to get started')).toBe(true);
    });

    it('should detect shortcuts hint', () => {
        expect(isReadyForInitialInput('Press ? for shortcuts')).toBe(true);
    });

    it('should detect prompt line with separator and chevron', () => {
        expect(isReadyForInitialInput('───────────\n❯')).toBe(true);
    });

    it('should detect the "bypass permissions" footer marker', () => {
        expect(isReadyForInitialInput('⏵⏵ bypass permissions on')).toBe(true);
    });

    it('should detect the "shift+tab" footer marker', () => {
        expect(isReadyForInitialInput('shift+tab to cycle')).toBe(true);
    });

    it('should return false for unrelated text', () => {
        expect(isReadyForInitialInput('Processing your request...')).toBe(false);
    });

    it('should return false for empty string', () => {
        expect(isReadyForInitialInput('')).toBe(false);
    });
});

describe('hasActiveTurnIndicator', () => {
    it('detects the "esc to interrupt" active-turn marker', () => {
        expect(hasActiveTurnIndicator('✻ Baking… (esc to interrupt · ctrl+t to show todos)')).toBe(true);
    });

    it('is case-insensitive', () => {
        expect(hasActiveTurnIndicator('Esc To Interrupt')).toBe(true);
    });

    it('does NOT fire on the startup welcome banner (avoids false positive)', () => {
        // ✻ and "───Claude" appear at startup; they must NOT read as an active turn.
        expect(hasActiveTurnIndicator('✻ Welcome to Claude Code!')).toBe(false);
        expect(hasActiveTurnIndicator('─── Claude Code ───')).toBe(false);
    });

    it('does NOT fire on the idle input footer', () => {
        expect(hasActiveTurnIndicator('? for shortcuts   ⏵⏵ bypass permissions on')).toBe(false);
    });

    it('returns false for empty string', () => {
        expect(hasActiveTurnIndicator('')).toBe(false);
    });
});

describe('classifyEnterOutcome (Enter accepted vs. dropped)', () => {
    const idleFooter = '───────────\n❯ my queued prompt text\n? for shortcuts   ⏵⏵ bypass permissions on';
    const activeTurn = '✻ Thinking… (esc to interrupt)';

    it('ROOT CAUSE: growth while still parked at the idle input prompt is NOT acceptance', () => {
        // Startup churn (MCP load, rotating tips, footer repaints) crosses the byte
        // threshold, but the TUI is still at the idle input box — the Enter was
        // dropped and must be retried. This is the exact case the old
        // "any output grew" heuristic mis-classified as success.
        expect(classifyEnterOutcome({ outputDeltaBytes: 5000, recentOutput: idleFooter })).toBe('retry');
    });

    it('accepts when a genuine active-turn marker appears, regardless of byte delta', () => {
        expect(classifyEnterOutcome({ outputDeltaBytes: 0, recentOutput: activeTurn })).toBe('accepted');
    });

    it('accepts meaningful growth once we are no longer at the idle input prompt', () => {
        expect(classifyEnterOutcome({ outputDeltaBytes: 200, recentOutput: 'Here is the answer to your question…' })).toBe('accepted');
    });

    it('retries when nothing advanced and we are still idle at input', () => {
        expect(classifyEnterOutcome({ outputDeltaBytes: 0, recentOutput: idleFooter })).toBe('retry');
    });

    it('retries on sub-threshold growth (e.g. cursor blink) away from the input prompt', () => {
        expect(classifyEnterOutcome({ outputDeltaBytes: 3, recentOutput: 'some quiet output' })).toBe('retry');
    });

    it('honours a custom growth threshold', () => {
        expect(classifyEnterOutcome({ outputDeltaBytes: 50, recentOutput: 'x', growthThreshold: 100 })).toBe('retry');
        expect(classifyEnterOutcome({ outputDeltaBytes: 150, recentOutput: 'x', growthThreshold: 100 })).toBe('accepted');
    });

    it('follow-up path (guard off): growth back at the idle prompt still counts as accepted', () => {
        // A near-instant follow-up (e.g. /clear or a one-line answer) redraws to the
        // idle prompt before we sample. With no startup churn to defend against, that
        // growth reliably means the message was accepted — do NOT spuriously retry.
        expect(classifyEnterOutcome({
            outputDeltaBytes: 5000,
            recentOutput: idleFooter,
            guardAgainstIdleChurn: false,
        })).toBe('accepted');
    });

    it('follow-up path (guard off): no growth at idle prompt still retries', () => {
        expect(classifyEnterOutcome({
            outputDeltaBytes: 0,
            recentOutput: idleFooter,
            guardAgainstIdleChurn: false,
        })).toBe('retry');
    });
});

describe('extractSessionId', () => {
    it('should extract UUID from session: prefix', () => {
        const input = 'session: 12345678-1234-1234-1234-123456789abc';
        expect(extractSessionId(input)).toBe('12345678-1234-1234-1234-123456789abc');
    });

    it('should extract UUID from session without colon', () => {
        const input = 'session 12345678-1234-1234-1234-123456789abc';
        expect(extractSessionId(input)).toBe('12345678-1234-1234-1234-123456789abc');
    });

    it('should extract standalone UUID', () => {
        const input = 'Some text before 12345678-1234-1234-1234-123456789abc and after';
        expect(extractSessionId(input)).toBe('12345678-1234-1234-1234-123456789abc');
    });

    it('should return null when no UUID found', () => {
        expect(extractSessionId('no uuid here')).toBeNull();
    });

    it('should return null for empty string', () => {
        expect(extractSessionId('')).toBeNull();
    });

    it('should return first UUID if multiple present', () => {
        const input = 'session: 11111111-1111-1111-1111-111111111111 other 22222222-2222-2222-2222-222222222222';
        expect(extractSessionId(input)).toBe('11111111-1111-1111-1111-111111111111');
    });
});

describe('hasProcessingIndicators', () => {
    it('should detect "Thinking"', () => {
        expect(hasProcessingIndicators('Thinking...')).toBe(true);
    });

    it('should detect "Working"', () => {
        expect(hasProcessingIndicators('Working on it...')).toBe(true);
    });

    it('should detect "Analyzing"', () => {
        expect(hasProcessingIndicators('Analyzing the code...')).toBe(true);
    });

    it('should detect "Reading"', () => {
        expect(hasProcessingIndicators('Reading file.ts...')).toBe(true);
    });

    it('should detect "Writing"', () => {
        expect(hasProcessingIndicators('Writing output...')).toBe(true);
    });

    it('should detect spinner characters', () => {
        expect(hasProcessingIndicators('⠋ Loading')).toBe(true);
        expect(hasProcessingIndicators('⠙')).toBe(true);
        expect(hasProcessingIndicators('⠹')).toBe(true);
    });

    it('should detect Claude spinner chars', () => {
        expect(hasProcessingIndicators('✶ Processing')).toBe(true);
        expect(hasProcessingIndicators('✳')).toBe(true);
    });

    it('should detect Claude header line', () => {
        expect(hasProcessingIndicators('───Claude')).toBe(true);
    });

    it('should return false for normal text', () => {
        expect(hasProcessingIndicators('Hello world')).toBe(false);
    });

    it('should return false for empty string', () => {
        expect(hasProcessingIndicators('')).toBe(false);
    });

    it('should be case-insensitive', () => {
        expect(hasProcessingIndicators('THINKING')).toBe(true);
        expect(hasProcessingIndicators('thinking')).toBe(true);
        expect(hasProcessingIndicators('ThInKiNg')).toBe(true);
    });
});

describe('detectWaitingForInput', () => {
    describe('multiple choice detection', () => {
        it('should detect multiple choice question', () => {
            const input = 'Select an option:\nEnter to select\n↑/↓ to navigate';
            expect(detectWaitingForInput(input)).toBe('question');
        });

        it('should detect numbered selection menu (Exit plan mode dialog)', () => {
            const input = 'Exit plan mode?\n\n  Claude wants to exit plan mode\n\n  ❯ 1. Yes\n    2. No';
            expect(detectWaitingForInput(input)).toBe('question');
        });

        it('should detect numbered selection menu with multiple options', () => {
            const input = 'Choose an option:\n  ❯ 1. Option A\n    2. Option B\n    3. Option C';
            expect(detectWaitingForInput(input)).toBe('question');
        });
    });

    describe('permission detection', () => {
        it('should detect permission dialog', () => {
            const input = 'Run this command?\n[Allow] [Deny]';
            expect(detectWaitingForInput(input)).toBe('permission');
        });

        it('should detect Allow/Deny buttons', () => {
            const input = 'Allow this action?\nAllow  Deny';
            expect(detectWaitingForInput(input)).toBe('permission');
        });
    });

    describe('confirmation detection', () => {
        it('should detect (y/n) prompt', () => {
            expect(detectWaitingForInput('Continue? (y/n)')).toBe('confirmation');
        });

        it('should detect [Y/n] prompt', () => {
            expect(detectWaitingForInput('Proceed? [Y/n]')).toBe('confirmation');
        });

        it('should detect [y/N] prompt', () => {
            expect(detectWaitingForInput('Save changes? [y/N]')).toBe('confirmation');
        });
    });

    describe('question detection', () => {
        it('should detect "what" questions', () => {
            const input = '⏺ What file do you want to edit?';
            expect(detectWaitingForInput(input)).toBe('question');
        });

        it('should detect "which" questions', () => {
            const input = 'Which option would you prefer?';
            expect(detectWaitingForInput(input)).toBe('question');
        });

        it('should detect "how" questions', () => {
            const input = 'How should I proceed?';
            expect(detectWaitingForInput(input)).toBe('question');
        });

        it('should detect "would you" questions', () => {
            const input = 'Would you like me to continue?';
            expect(detectWaitingForInput(input)).toBe('question');
        });

        it('should detect "could you" questions', () => {
            const input = 'Could you provide more details?';
            expect(detectWaitingForInput(input)).toBe('question');
        });

        it('should detect "prefer" questions', () => {
            const input = 'Do you prefer option A or B?';
            expect(detectWaitingForInput(input)).toBe('question');
        });

        it('should detect generic question ending with ?', () => {
            const input = '⏺ Please confirm your selection?';
            expect(detectWaitingForInput(input)).toBe('question');
        });
    });

    describe('non-questions', () => {
        it('should return null for idle state', () => {
            const input = '❯';
            expect(detectWaitingForInput(input)).toBeNull();
        });

        it('should return null for shortcuts hint', () => {
            const input = '? for shortcuts';
            expect(detectWaitingForInput(input)).toBeNull();
        });

        it('should return null for Try hint', () => {
            const input = 'Try "something" to get started';
            expect(detectWaitingForInput(input)).toBeNull();
        });

        it('should return null for empty string', () => {
            expect(detectWaitingForInput('')).toBeNull();
        });

        it('should return null for normal output', () => {
            const input = 'Completed the task successfully.';
            expect(detectWaitingForInput(input)).toBeNull();
        });
    });
});

describe('getRecentOutput', () => {
    it('should return last N bytes from buffer array', () => {
        const buffers = [
            Buffer.from('hello '),
            Buffer.from('world'),
        ];
        const result = getRecentOutput(buffers, 100);
        // stripAnsi is applied, so result should be clean
        expect(result).toBe('hello world');
    });

    it('should truncate to maxBytes', () => {
        const buffers = [Buffer.from('hello world')];
        const result = getRecentOutput(buffers, 5);
        expect(result).toBe('world');
    });

    it('should handle empty buffer array', () => {
        const result = getRecentOutput([], 100);
        expect(result).toBe('');
    });

    it('should collect from multiple buffers backwards', () => {
        const buffers = [
            Buffer.from('1111'), // oldest
            Buffer.from('2222'),
            Buffer.from('3333'), // newest
        ];
        const result = getRecentOutput(buffers, 8);
        // Should get from the last buffers
        expect(result.length).toBeLessThanOrEqual(8);
    });

    it('should strip ANSI codes', () => {
        const buffers = [Buffer.from('\x1b[31mred text\x1b[0m')];
        const result = getRecentOutput(buffers, 100);
        expect(result).toBe('red text');
    });
});
