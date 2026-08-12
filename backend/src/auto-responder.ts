/**
 * Auto-Responder (rules-first v1)
 *
 * Decides whether a task that is waiting on input can be answered automatically,
 * and if so, with what text — in the user's own terse style.
 *
 * The rules here are derived from an analysis of ~1,240 real user messages across
 * 27 workspaces (Jul-Aug 2026). Key measured behaviours that shaped this design:
 *
 *   - Replies are extremely terse: median 8 words / 43 chars.
 *   - Of short replies to a Claude question: 64% specific directive,
 *     29% bare approval, 3% pushback, 2% counter-question, 2% "you choose".
 *     => The user approves ~93% of the time.
 *   - BUT 14% of all input was an interrupt: the user kills work that is
 *     thrashing (repeated failures, flaky browser/MCP loops).
 *
 * A naive "approve everything" bot would therefore be right most of the time and
 * catastrophically wrong exactly when it matters. So this module deliberately
 * does NOT mirror the 93% approval rate. It only answers questions whose blast
 * radius is small and reversible, and escalates (stays silent, leaves it for the
 * human) on anything irreversible, secret-bearing, ambiguous, or thrashing.
 *
 * This module is intentionally PURE and dependency-free: no I/O, no timers, no
 * server imports. That keeps the decision logic exhaustively testable offline via
 * `test-auto-responder.ts` without touching a running task.
 */

export type AutoResponseAction =
    /** Send `reply` to the task. */
    | 'respond'
    /** Do nothing; a human needs to decide. */
    | 'escalate';

export type AutoResponseReasonCode =
    | 'continuation'          // "want me to carry on?" -> yes
    | 'verification'          // "should I test/run it?" -> yes, always
    | 'safe_approval'         // low-risk proceed on already-approved work
    | 'defer_choice'          // narrow either/or with no stated preference
    | 'irreversible'          // commit/push/merge/deploy/release
    | 'destructive'           // rm -rf, force push, DB drop, history rewrite
    | 'secret'                // credentials/tokens/keys involved
    | 'thrash'                // repeated failures — user would interrupt here
    | 'ambiguous'             // open-ended design fork; needs real intent
    | 'permission'            // raw tool-permission dialog
    | 'not_waiting'           // task isn't actually asking anything
    | 'no_question'           // couldn't find a question to answer
    | 'budget_exhausted'      // too many consecutive auto-responses
    | 'disabled';             // feature off

export interface AutoResponderConfig {
    enabled: boolean;
    /**
     * Max consecutive auto-responses to a single task before forcing escalation.
     * Prevents the responder from driving a task in an unbounded loop with no
     * human ever looking at it. Mirrors the user's real interrupt instinct.
     */
    maxConsecutive: number;
    /**
     * If true, never answer 'permission' dialogs (tool-use allow/deny).
     * Default true: permission grants are a security boundary, not a preference.
     */
    neverAnswerPermissions: boolean;
}

export const DEFAULT_CONFIG: AutoResponderConfig = {
    enabled: true,
    maxConsecutive: 5,
    neverAnswerPermissions: true,
};

export interface AutoResponderInput {
    /** Type Claudia's state detector reported, if any. */
    waitingInputType?: 'question' | 'permission' | 'confirmation' | null;
    /** Recent ANSI-stripped terminal output (tail is what matters). */
    recentOutput: string;
    /** How many times in a row we've already auto-answered this task. */
    consecutiveCount?: number;
}

export interface AutoResponderDecision {
    action: AutoResponseAction;
    /** Text to send (no trailing newline); only set when action === 'respond'. */
    reply?: string;
    reason: AutoResponseReasonCode;
    /** Human-readable explanation for logs / test CLI. */
    detail: string;
    /** The question text the decision was based on. */
    question?: string;
}

// ---------------------------------------------------------------------------
// Pattern tables
// ---------------------------------------------------------------------------

/**
 * Irreversible or externally-visible actions. The user's own CLAUDE.md is
 * explicit here ("NEVER commit and push without letting the user test/validate",
 * "Always ask before committing and before pushing"), and the corpus agrees: the
 * user always issues these himself ("commit this", "push it", "merge it into
 * main"). Never auto-approve them.
 */
const IRREVERSIBLE = [
    /\bcommit\b/i,
    /\bpush\b/i,
    /\bmerge\b/i,
    /\bdeploy\b/i,
    /\brelease\b/i,
    /\bpull request\b/i,
    /\bopen a pr\b/i, /\bcreate a pr\b/i, /\braise a pr\b/i,
    /\btag\b.*\bversion\b/i,
    /\bpublish\b/i,
    /\bnpm publish\b/i,
];

/** Destructive operations — worse than irreversible; always escalate. */
const DESTRUCTIVE = [
    /\brm\s+-rf\b/i,
    /\bforce[- ]push\b/i, /\bpush\s+--force\b/i, /\b--force-with-lease\b/i,
    /\bgit\s+reset\s+--hard\b/i,
    /\bdrop\s+(the\s+)?(table|database|db|collection)\b/i,
    /\btruncate\b/i,
    /\bdelete\s+(the\s+)?(branch|repo|repository|bucket|volume|cluster)\b/i,
    /\bwipe\b/i, /\bpurge\b/i,
    /\brewrite\s+(the\s+)?history\b/i, /\bfilter-branch\b/i,
    /\brevert\b/i,
    /\boverwrite\b/i,
    /\bdestroy\b/i,
];

/**
 * Anything touching credentials. Never auto-answer.
 * Note the deliberate plural/variant coverage: real transcripts said "client
 * secrets" (plural) and named `.dev.vars` rather than `.env`, and an early
 * version of this table missed both — letting a secret-rotation question fall
 * through to a generic "do it". Keep these broad; a false escalation is free,
 * a false approval is not.
 */
const SECRET = [
    /\bsecrets?\b/i, /\bcredential/i, /\bpasswords?\b/i, /\bapi[- ]?keys?\b/i,
    /\bclient[- ]secrets?\b/i, /\bprivate keys?\b/i,
    /\bssh keys?\b/i, /\bauth\b.*\bkeys?\b/i, /\bcertificates?\b/i,
    /\brotate\b.*\b(secret|key|credential|token)/i,
    // Env/secret files, incl. wrangler's .dev.vars and .env.* variants
    /\.env\b/i, /\.env\.[a-z]+/i, /\.dev\.vars\b/i, /\bdotenv\b/i,
    /\bsecrets?\s*\.(ya?ml|json|toml)\b/i,
    /**
     * "token" ONLY in a credential sense. A bare /\btokens?\b/ was tried first and
     * over-fired on 59 corpus questions about LLM *cost* ("token dashboard",
     * "token-intensive", "spends real tokens") — blocking harmless work. These
     * variants require an auth-flavoured qualifier.
     */
    /\b(access|auth|bearer|refresh|api|personal[- ]access|oauth|session|pat)[- ]tokens?\b/i,
    /\btokens?\s+(is|are)?\s*(obtainable|available|valid|expired|leaked)\b/i,
    /\b(REST API|GitHub|GHE|npm|figma)\s+token\b/i,
];

/**
 * Continuation asks: "want me to carry on / proceed / keep going?"
 * The corpus's single most common reply is literally "continue" (63x) plus
 * "Continue from where you left off." (23x) and "keep going".
 */
const CONTINUATION = [
    /\b(shall|should|want me to|would you like me to|ok to)\b[^?]*\b(continue|carry on|keep going|proceed|go on|move on|carry that on)\b/i,
    /\b(continue|proceed|keep going)\b\s*\?/i,
    /\bcarry on\b[^?]*\?/i,
    /\bwant me to (go ahead|start|get started|begin)\b/i,
    /\bshould i (go ahead|start|begin|continue)\b/i,
    /\bready (for|to) (the )?next\b[^?]*\?/i,
    /\bmove on to\b[^?]*\?/i,
];

/**
 * Verification asks. The user demands testing relentlessly ("did you test it",
 * "run the app", "make sure to verify visual changes") and his CLAUDE.md
 * mandates it. Answering "yes" here is always aligned with intent.
 */
const VERIFICATION = [
    /\b(want me to|should i|shall i|would you like me to)\b[^?]*\b(test|verify|run|check|screenshot|confirm|validate|try)\b/i,
    /\b(run|test|verify|check)\b[^?]*\b(it|them|the app|the tests|the suite|again)\b[^?]*\?/i,
    /\bshould i (also )?(add|write)\b[^?]*\btests?\b/i,
    /\btake a (browser|playwright) pass\b/i,
];

/**
 * Thrash signals: the user interrupts when Claude is stuck in a failure loop.
 * If the tail shows repeated errors, escalate rather than cheering it onward.
 */
const THRASH = [
    /attempt\s+[3-9]\s*\/\s*\d/i,
    /retry(ing)?\s+(attempt\s+)?[3-9]\b/i,
    /\bstill (failing|broken|not working|erroring)\b/i,
    /\b(same|identical) error (again|as before)\b/i,
    /\bi'?m (stuck|going in circles|not making progress)\b/i,
    /\bthat didn'?t work either\b/i,
    /\btried (that|this) (already|before)\b/i,
];

/**
 * Open-ended / design-fork questions. These need real product intent, which is
 * exactly where the user gives a *specific directive* (64% of replies) rather
 * than a bare yes. A bot cannot invent that intent, so escalate.
 */
const AMBIGUOUS = [
    /\bwhat (do you|would you) (think|prefer|want)\b/i,
    /\bwhat should (we|i) (do|build|work on)\b/i,
    /\bwhich (approach|option|direction|way|one)\b/i,
    /\bhow (do you )?want\b/i,
    /\bany preference\b/i,
    /\bthoughts\?/i,
    /\bor would you rather\b/i,
    /\bwhat'?s next\b/i,
    /\bdesign\b[^?]*\?/i,
    /\bscope\b[^?]*\?/i,
    /\btrade-?offs?\b/i,
];

/** A narrow either/or where the user historically says "you choose". */
const EITHER_OR = [
    /\b(a|option a)\b\s*(or|vs\.?)\s*\b(b|option b)\b/i,
    /\beither\b[^?]*\bor\b[^?]*\?/i,
];

/**
 * Questions that explicitly offer an off-ramp ("...or pause here?", "...or is
 * this just a capability check?"). Corpus audit showed these are where a
 * confident "continue"/"do it" was actually WRONG — the user took the off-ramp
 * (interrupted or redirected) in every observed case. A question offering a
 * genuine fork is a decision point, not a rubber stamp, so escalate even though
 * the leading clause looks like a plain continuation.
 */
const OFFRAMP = [
    /\bor\s+(should\s+)?(i\s+)?pause\b/i,
    /\bor\s+(would\s+you\s+rather|do\s+you\s+want)\b/i,
    /\bor\s+is\s+this\s+just\b/i,
    /\bor\s+(should\s+we|shall\s+we)\b/i,
    /\bor\s+hold\s+off\b/i,
    /\bor\s+wait\b/i,
    /\bor\s+stop\s+here\b/i,
    /\bor\s+start\s+with\b/i,
    /\bor\s+move\s+to\b/i,
    /,\s*or\s+[^?]{3,60}\?/i,   // "..., or <alternative>?" — a real fork
];

// ---------------------------------------------------------------------------
// Question extraction
// ---------------------------------------------------------------------------

/** Noise lines from the Claude Code TUI chrome that are never the question. */
const TUI_NOISE = [
    /\? for shortcuts/i,
    /^\s*Try ".*"\s*$/i,
    /\/model to try/i,
    /bypass permissions/i,
    /shift\+tab to cycle/i,
    /↑\/↓ to navigate/i,
    /Enter to select/i,
    /esc to (interrupt|cancel)/i,
    /^\s*[❯>]\s*$/,
    /^\s*─+\s*$/,
    /^\s*$/,
];

/**
 * Trailing terminal cruft that arrives AFTER the question in real captures and
 * would otherwise be glued onto it: leftover CSI device-status queries the
 * stripper misses (`[?6n`), the spinner/status line, plugin notices, and the
 * echo of the prompt line. Observed live on a real waiting task.
 */
const TRAILING_CRUFT = [
    /\[\?\d+[a-z]/gi,                       // [?6n device-status reports
    /✻[^\n]*/g,                             // "✻ Baked for 3m 59s"
    /Plugin updated:[^\n]*/gi,
    /Run \/reload-plugins[^\n]*/gi,
    /←\s*for agents?/gi,
    /\(B(?=\[|\s|$)/g,                      // stray charset-select remnants
    / /g,                              // non-breaking space from the prompt row
];

function scrubCruft(s: string): string {
    let out = s;
    for (const p of TRAILING_CRUFT) out = out.replace(p, ' ');
    return out.replace(/[ \t]{2,}/g, ' ').trim();
}

function isNoise(line: string): boolean {
    return TUI_NOISE.some(p => p.test(line));
}

/**
 * Pull the operative question out of a terminal tail.
 *
 * Strategy: walk backwards for the last non-noise line containing '?'. If none,
 * fall back to the last meaningful line (covers menus/confirmations that pose
 * the choice without a literal question mark).
 */
export function extractQuestion(recentOutput: string): string | null {
    if (!recentOutput) return null;

    const cleaned = scrubCruft(recentOutput);
    const lines = cleaned
        .split('\n')
        .map(l => l.replace(/\s+$/, ''))
        .filter(l => !isNoise(l));

    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line.includes('?')) continue;

        // Real TUI output often puts the question mid-line with prose (and cruft)
        // around it. Take the sentence that actually ends in '?' rather than the
        // whole line, so trailing status text can't dilute the match.
        const upToLastQ = line.slice(0, line.lastIndexOf('?') + 1);
        const sentences = upToLastQ.split(/(?<=[.!?])\s+/);
        const questionSentence = sentences[sentences.length - 1].trim();

        // Keep a little lead-in for risk scanning (e.g. "…then push to main?").
        const lead = lines.slice(Math.max(0, i - 2), i).join(' ').trim();
        const combined = (lead ? lead + ' ' : '') + questionSentence;
        const result = questionSentence.length >= 12 ? combined : (lead + ' ' + upToLastQ).trim();
        return result.length > 400 ? result.slice(-400) : result;
    }

    const tail = lines.slice(-3).join(' ').trim();
    return tail || null;
}

function matchesAny(text: string, patterns: RegExp[]): RegExp | null {
    for (const p of patterns) if (p.test(text)) return p;
    return null;
}

// ---------------------------------------------------------------------------
// Decision engine
// ---------------------------------------------------------------------------

/**
 * Decide how to respond to a waiting task. Pure function — safe to call in tests.
 *
 * Order matters: hard blocks (destructive/secret/irreversible/thrash) are checked
 * BEFORE any approval path, so a question like "tests pass — want me to run them
 * again and then push?" escalates on `push` rather than matching verification.
 */
export function decide(
    input: AutoResponderInput,
    config: AutoResponderConfig = DEFAULT_CONFIG
): AutoResponderDecision {
    if (!config.enabled) {
        return { action: 'escalate', reason: 'disabled', detail: 'Auto-responder is disabled.' };
    }

    const { waitingInputType, recentOutput, consecutiveCount = 0 } = input;

    if (!waitingInputType) {
        return {
            action: 'escalate',
            reason: 'not_waiting',
            detail: 'Task is not waiting for input.',
        };
    }

    if (waitingInputType === 'permission' && config.neverAnswerPermissions) {
        return {
            action: 'escalate',
            reason: 'permission',
            detail: 'Tool-permission dialogs are a security boundary — always left to the human.',
        };
    }

    if (consecutiveCount >= config.maxConsecutive) {
        return {
            action: 'escalate',
            reason: 'budget_exhausted',
            detail: `Already auto-responded ${consecutiveCount}x in a row (max ${config.maxConsecutive}); handing back to the human.`,
        };
    }

    const question = extractQuestion(recentOutput);
    if (!question) {
        return {
            action: 'escalate',
            reason: 'no_question',
            detail: 'Could not extract a question from recent output.',
        };
    }

    // --- Hard blocks first. Scan the wider tail, not just the question line,
    // because the risky verb often sits in the preceding explanation.
    const riskScope = `${question}\n${recentOutput.slice(-1500)}`;

    const destructive = matchesAny(riskScope, DESTRUCTIVE);
    if (destructive) {
        return {
            action: 'escalate', reason: 'destructive', question,
            detail: `Destructive operation mentioned (${destructive.source}) — never auto-approved.`,
        };
    }

    const secret = matchesAny(riskScope, SECRET);
    if (secret) {
        return {
            action: 'escalate', reason: 'secret', question,
            detail: `Credentials/secrets involved (${secret.source}) — never auto-approved.`,
        };
    }

    const irreversible = matchesAny(riskScope, IRREVERSIBLE);
    if (irreversible) {
        return {
            action: 'escalate', reason: 'irreversible', question,
            detail: `Irreversible/externally-visible action (${irreversible.source}) — project rules require explicit human approval.`,
        };
    }

    const thrash = matchesAny(recentOutput.slice(-2000), THRASH);
    if (thrash) {
        return {
            action: 'escalate', reason: 'thrash', question,
            detail: `Repeated-failure signal (${thrash.source}) — this is where the user interrupts, not approves.`,
        };
    }

    // A question that offers a real alternative is a decision point. This must be
    // checked BEFORE the approval paths, because such questions usually open with
    // continuation/verification phrasing ("Want me to continue into Stage 3, or
    // pause here...?") and would otherwise be rubber-stamped.
    const offramp = matchesAny(question, OFFRAMP);
    if (offramp) {
        return {
            action: 'escalate', reason: 'ambiguous', question,
            detail: `Question offers an explicit alternative (${offramp.source}) — a real fork, not a rubber stamp.`,
        };
    }

    // --- Approval paths (question line only, to avoid false hits from history).
    if (matchesAny(question, VERIFICATION)) {
        return {
            action: 'respond', reply: 'yes', reason: 'verification', question,
            detail: 'Verification/testing request — user consistently demands testing.',
        };
    }

    if (matchesAny(question, CONTINUATION)) {
        return {
            action: 'respond', reply: 'continue', reason: 'continuation', question,
            detail: 'Continuation request — matches the user\'s most frequent reply ("continue").',
        };
    }

    // Ambiguity check comes before generic approval: an open design fork must not
    // be swept up by a permissive "should I..." reading.
    const ambiguous = matchesAny(question, AMBIGUOUS);
    if (ambiguous) {
        return {
            action: 'escalate', reason: 'ambiguous', question,
            detail: `Open-ended/design question (${ambiguous.source}) — needs real product intent.`,
        };
    }

    if (matchesAny(question, EITHER_OR)) {
        return {
            action: 'respond', reply: 'you choose', reason: 'defer_choice', question,
            detail: 'Narrow either/or with no stated preference — user says "you choose" here.',
        };
    }

    // Generic low-risk "want me to <verb>?" on work already in flight.
    if (/\b(want me to|should i|shall i|ok to|shall we)\b/i.test(question) && question.includes('?')) {
        return {
            action: 'respond', reply: 'do it', reason: 'safe_approval', question,
            detail: 'Low-risk proceed request with no irreversible/ambiguous markers.',
        };
    }

    // Plain yes/no confirmation with nothing risky in scope.
    if (waitingInputType === 'confirmation') {
        return {
            action: 'respond', reply: 'yes', reason: 'safe_approval', question,
            detail: 'Simple confirmation with no risky markers in scope.',
        };
    }

    return {
        action: 'escalate',
        reason: 'ambiguous',
        question,
        detail: 'No rule matched confidently — defaulting to human.',
    };
}
