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
 * Check if terminal output indicates Claude is ready for initial input.
 *
 * These markers all belong to the idle input prompt / its footer hint bar
 * (rendered only when Claude Code is sitting at an empty, ready-to-accept input
 * box). They are ALSO used, inverted, as the "still idle at the input" signal
 * when confirming that a submitted Enter was actually accepted — see
 * {@link classifyEnterOutcome}.
 */
export function isReadyForInitialInput(str: string): boolean {
    return str.includes('Try "') ||
        str.includes('? for shortcuts') ||
        str.includes('bypass permissions') ||
        str.includes('shift+tab') ||
        (str.includes('───') && str.includes('❯'));
}

/**
 * Detect a genuine in-progress turn (Claude actively processing a submission).
 *
 * "esc to interrupt" is Claude Code's definitive active-turn marker: it is shown
 * for the entire duration of a turn (thinking, tool calls, streaming) and NEVER
 * at the idle input prompt nor during startup/banner rendering. We deliberately
 * do NOT reuse {@link hasProcessingIndicators} here — its spinner glyphs (✻, ✳)
 * and "───Claude" header pattern also appear in the startup "✻ Welcome to Claude
 * Code" banner, so they cannot distinguish "turn started" from "still starting
 * up". Using them would reintroduce the false-positive that this function exists
 * to avoid.
 */
export function hasActiveTurnIndicator(str: string): boolean {
    return /esc to interrupt/i.test(str);
}

/**
 * Decide whether an Enter we just sent was actually accepted (the prompt was
 * submitted and a turn began), or whether it was dropped and must be retried.
 *
 * ROOT-CAUSE NOTE: the previous heuristic treated ANY output growth (> ~10
 * bytes) as "accepted". On a fresh task create the Claude Code TUI is still
 * streaming startup output (MCP servers finishing, rotating tips, footer/token
 * counter repaints, re-layouts) when the queued prompt is typed and Enter is
 * sent. That unrelated churn crosses the growth threshold within the observation
 * window, so a DROPPED Enter looked "accepted" and the retry loop stopped — the
 * typed prompt then sat in the input box unsubmitted (the reported symptom). It
 * was intermittent because it only triggered when startup output happened to
 * still be streaming during the post-Enter window.
 *
 * The robust rule: growth only counts as acceptance when we are NOT still parked
 * at the idle input prompt. If the recent output still shows the idle input
 * footer ("? for shortcuts" / "bypass permissions" / "❯" box) and there is no
 * active-turn marker, the Enter was NOT accepted regardless of byte growth —
 * keep retrying. A positive active-turn marker ("esc to interrupt") always wins.
 */
export function classifyEnterOutcome(opts: {
    /** Bytes of output that arrived after Enter was written. */
    outputDeltaBytes: number;
    /** Stripped recent output tail observed after Enter. */
    recentOutput: string;
    /** Minimum growth (bytes) that counts as meaningful. Default 10. */
    growthThreshold?: number;
    /**
     * Veto acceptance-by-growth while the output still shows the idle input
     * prompt. Needed for the initial-prompt / reconnect delivery, where startup
     * or resume churn produces growth that must NOT be mistaken for submission.
     * For a plain follow-up (the task is already interactive, no startup churn)
     * pass false: there, growth reliably means the message was accepted, and the
     * veto would otherwise cause spurious retries on near-instant turns
     * (e.g. `/clear`, a one-line answer) that redraw back to the idle prompt
     * before we sample. Default true.
     */
    guardAgainstIdleChurn?: boolean;
}): 'accepted' | 'retry' {
    const threshold = opts.growthThreshold ?? 10;
    const guardIdle = opts.guardAgainstIdleChurn ?? true;

    // Strong positive: a real turn is underway.
    if (hasActiveTurnIndicator(opts.recentOutput)) return 'accepted';

    // Still sitting at the idle input prompt → the Enter did not submit, even if
    // the screen repainted. This is the case that kills the startup-churn false
    // positive on fresh create / reconnect.
    if (guardIdle && isReadyForInitialInput(opts.recentOutput)) return 'retry';

    // Output advanced meaningfully → the submission took.
    if (opts.outputDeltaBytes > threshold) return 'accepted';

    return 'retry';
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
