/**
 * Task State Detection Module
 *
 * Handles detecting task states based on terminal output analysis.
 * Includes input detection, processing indicators, and state transitions.
 */

import { WaitingInputType } from '@claudia/shared';

/**
 * Strip ANSI escape codes from a string
 */
export function stripAnsi(str: string): string {
    return str
        .replace(/\x1b\[[0-9;]*m/g, '')
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/\x1b[PX^_].*?\x1b\\/g, '')
        .replace(/\x1b\[\?[0-9;]*[hl]/g, '')
        .replace(/\x1b[>=]/g, '')
        .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '')
        .replace(/\r/g, '');
}

/**
 * Check if terminal output indicates Claude is ready for initial input
 */
export function isReadyForInitialInput(str: string): boolean {
    return str.includes('Try "') ||
        str.includes('? for shortcuts') ||
        (str.includes('───') && str.includes('❯'));
}

/**
 * Extract a session ID from terminal output
 */
export function extractSessionId(str: string): string | null {
    const patterns = [
        /session[:\s]+([a-f0-9-]{36})/i,
        /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i,
    ];
    for (const pattern of patterns) {
        const match = str.match(pattern);
        if (match) return match[1];
    }
    return null;
}

/**
 * Check if recent output indicates Claude has started processing
 * Look for spinner characters, "Thinking", "Working", etc.
 */
export function hasProcessingIndicators(str: string): boolean {
    const processingPatterns = [
        /Thinking/i,
        /Working/i,
        /Concocting/i,
        /Analyzing/i,
        /Reading/i,
        /Writing/i,
        /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,  // Spinner characters
        /✶|✳|✢|·|✻|✽|✺/,  // Claude spinner chars
        /───.*Claude/,  // Header lines
    ];
    return processingPatterns.some(pattern => pattern.test(str));
}

/**
 * Detect if Claude Code is actively asking the user a question
 * Only returns a type if Claude is genuinely asking something
 * Returns null for normal idle state (waiting for next command)
 */
export function detectWaitingForInput(str: string): WaitingInputType | null {
    // Multiple choice question (like AskUserQuestion tool)
    if (str.includes('Enter to select') && str.includes('↑/↓ to navigate')) {
        return 'question';
    }

    // Numbered selection menu (like "Exit plan mode?" dialog)
    // Looks for pattern like: "❯ 1. Yes" or "  2. No" indicating a numbered choice menu
    if (str.match(/❯\s*\d+\.\s+\w/) && str.match(/\s+\d+\.\s+\w/)) {
        console.log(`[StateDetection] Numbered selection menu detected`);
        return 'question';
    }

    // Permission dialog - "Allow" / "Deny" patterns
    if (str.includes('Allow') && str.includes('Deny')) {
        return 'permission';
    }

    // Yes/No confirmation prompts
    if (str.match(/\(y\/n\)/i) || str.match(/\[y\/N\]/i) || str.match(/\[Y\/n\]/i)) {
        return 'confirmation';
    }

    // Get the last meaningful section of output
    const sections = str.split(/(?:⏺|─{3,})/);

    // Filter out empty sections and sections that are just the input prompt
    const meaningfulSections = sections.filter(s => {
        const trimmed = s.trim();
        if (!trimmed || trimmed === '❯' || /^❯\s*$/.test(trimmed)) {
            return false;
        }
        if (/(?:\? for shortcuts|Try "|\/model to try|bypass permissions|shift\+tab to cycle)/i.test(trimmed) && trimmed.length < 100) {
            return false;
        }
        return true;
    });

    const lastSection = meaningfulSections.length > 0
        ? meaningfulSections[meaningfulSections.length - 1]
        : str;

    // Clean up the section for analysis
    const cleanSection = lastSection
        .replace(/\? for shortcuts/g, '')
        .replace(/Try "[^"]*"/g, '')
        .replace(/\/model to try/g, '')
        .replace(/bypass permissions/gi, '')
        .replace(/shift\+tab to cycle/gi, '');

    // Look for question marks that indicate real questions
    const hasQuestionMark = cleanSection.includes('?');

    if (hasQuestionMark) {
        const questionPatterns = [
            /\bwhat\b/i,
            /\bwhich\b/i,
            /\bhow\b/i,
            /\bwhere\b/i,
            /\bwhen\b/i,
            /\bwhy\b/i,
            /\bwho\b/i,
            /\bwould you\b/i,
            /\bcould you\b/i,
            /\bdo you\b/i,
            /\bshould\b/i,
            /\bcan you\b/i,
            /\blet me know\b/i,
            /\bgive me\b/i,
            /\btell me\b/i,
            /\bprefer\b/i,
            /\blike to\b/i,
            /\bwant to\b/i,
            /\bchoose\b/i,
            /\bselect\b/i,
            /\bpick\b/i,
            /\bdecide\b/i,
            /\bconfirm\b/i,
            /\bproceed\b/i,
            /\bcontinue\b/i,
            /\bapproach\b/i,
            /\boption/i,
            /\balternative/i,
        ];

        for (const pattern of questionPatterns) {
            if (pattern.test(cleanSection)) {
                console.log(`[StateDetection] Question detected: "${cleanSection.slice(0, 100)}..."`);
                return 'question';
            }
        }

        const trimmedSection = cleanSection.trim();
        if (trimmedSection.endsWith('?') && trimmedSection.length > 10) {
            console.log(`[StateDetection] Question detected (ends with ?): "${trimmedSection.slice(-80)}"`);
            return 'question';
        }

        console.log(`[StateDetection] Has '?' but no question pattern matched. Section: "${trimmedSection.slice(0, 150)}"`);
    }

    return null;
}

/**
 * Get the recent output from task output buffers
 */
export function getRecentOutput(outputHistory: Buffer[], maxBytes: number): string {
    const buffers: Buffer[] = [];
    let totalSize = 0;

    // Read from end backwards
    for (let i = outputHistory.length - 1; i >= 0 && totalSize < maxBytes; i--) {
        const buf = outputHistory[i];
        buffers.unshift(buf);
        totalSize += buf.length;
    }

    const combined = Buffer.concat(buffers);
    const str = combined.toString('utf8');
    return stripAnsi(str.slice(-maxBytes));
}
