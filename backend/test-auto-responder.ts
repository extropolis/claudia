#!/usr/bin/env npx tsx
/**
 * Test CLI for the auto-responder rules engine (v1).
 *
 * Pure/offline by default — it never touches a running task unless you pass
 * --live (which only READS task state) or --live-send (which actually writes).
 *
 * Usage:
 *   npx tsx test-auto-responder.ts --suite
 *   npx tsx test-auto-responder.ts --suite --verbose
 *   npx tsx test-auto-responder.ts -q "Want me to run the tests?"
 *   npx tsx test-auto-responder.ts -q "Want me to commit and push?" --type question
 *   npx tsx test-auto-responder.ts --file /tmp/tail.txt
 *   npx tsx test-auto-responder.ts --corpus            # replay real corpus questions
 *   npx tsx test-auto-responder.ts --live              # dry-run against waiting tasks
 *   npx tsx test-auto-responder.ts --live-send         # actually send (asks first)
 *   npx tsx test-auto-responder.ts --help
 */

import { readFileSync, existsSync } from 'fs';
import {
    decide,
    extractQuestion,
    DEFAULT_CONFIG,
    type AutoResponderConfig,
    type AutoResponderDecision,
} from './src/auto-responder.js';
// Reuse the server's own ANSI stripper so live mode sees exactly the same text
// the state detector does — rather than a second, drifting copy.
import { stripAnsi } from './src/task-state-detection.js';

const BACKEND = 'http://localhost:4001';

// ---------------------------------------------------------------- colours
const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    blue: '\x1b[34m', cyan: '\x1b[36m', grey: '\x1b[90m',
};
const ok = (s: string) => `${C.green}${s}${C.reset}`;
const bad = (s: string) => `${C.red}${s}${C.reset}`;
const warn = (s: string) => `${C.yellow}${s}${C.reset}`;
const dim = (s: string) => `${C.dim}${s}${C.reset}`;

function printDecision(d: AutoResponderDecision, verbose = false) {
    const tag = d.action === 'respond'
        ? ok(`RESPOND -> "${d.reply}"`)
        : warn('ESCALATE (human)');
    console.log(`  action : ${tag}`);
    console.log(`  reason : ${C.cyan}${d.reason}${C.reset}`);
    console.log(`  detail : ${d.detail}`);
    if (verbose && d.question) {
        console.log(`  ${dim('question: ' + d.question.replace(/\n/g, ' ').slice(0, 220))}`);
    }
}

// ---------------------------------------------------------------- scenarios
interface Scenario {
    name: string;
    output: string;
    type?: 'question' | 'permission' | 'confirmation' | null;
    consecutive?: number;
    expect: 'respond' | 'escalate';
    expectReason?: string;
    /** Why this case matters — cites the behaviour it protects. */
    note?: string;
}

/**
 * Scenarios. The "real" ones are lifted verbatim (trimmed) from the user's own
 * session history so the suite tests against genuine phrasing, not invented text.
 */
const SCENARIOS: Scenario[] = [
    // ---- SHOULD RESPOND ----
    {
        name: 'continuation (real: "Want me to proceed to G3?")',
        output: 'G4 synthesizes the friendly guide and renders the architecture diagrams. Want me to proceed to G3?',
        type: 'question', expect: 'respond', expectReason: 'continuation',
        note: 'User replied "yes" to this exact question.',
    },
    {
        name: 'continuation ("keep going?")',
        output: 'Remaining: A (playground), D (toolchain), E (credits). Want me to carry on in this tree?',
        type: 'question', expect: 'respond', expectReason: 'continuation',
    },
    {
        name: 'verification (real: "take a browser pass?")',
        output: 'Nothing committed. Want me to take a browser pass once a preview slot frees up?',
        type: 'question', expect: 'respond', expectReason: 'verification',
        note: 'User replied "ok".',
    },
    {
        name: 'verification ("should I run the tests?")',
        output: 'The fix is in place. Should I run the tests to confirm?',
        type: 'question', expect: 'respond', expectReason: 'verification',
    },
    {
        name: 'safe approval ("want me to fix the visit point?")',
        output: 'That is expected, not new. Want me to fix the visit point to actually cover the keep?',
        type: 'question', expect: 'respond',
        note: 'User replied "yes fix it".',
    },
    {
        name: 'narrow either/or -> "you choose"',
        output: 'Should I use either A or B?',
        type: 'question', expect: 'respond', expectReason: 'defer_choice',
        note: 'User historically replies "you coose" (sic). The fork must be in the question sentence itself.',
    },
    {
        name: 'either/or spread across sentences escalates (open "which?" ask)',
        output: 'I can do either A or B here. Which would you like?',
        type: 'question', expect: 'escalate', expectReason: 'ambiguous',
        note: 'Question extraction narrows to "Which would you like?" — an open ask, so a human decides. Safer than guessing.',
    },
    {
        name: 'plain confirmation',
        output: 'Apply this refactor to the helper module? (y/n)',
        type: 'confirmation', expect: 'respond',
    },

    // ---- MUST ESCALATE: irreversible ----
    {
        name: 'commit request',
        output: 'All tests pass. Want me to commit this?',
        type: 'question', expect: 'escalate', expectReason: 'irreversible',
        note: 'CLAUDE.md: always ask before committing.',
    },
    {
        name: 'push request',
        output: 'The branch is clean. Should I push it to origin?',
        type: 'question', expect: 'escalate', expectReason: 'irreversible',
    },
    {
        name: 'merge to main',
        output: 'Want me to merge it into main?',
        type: 'question', expect: 'escalate', expectReason: 'irreversible',
    },
    {
        name: 'deploy',
        output: 'Build succeeded. Want me to deploy it?',
        type: 'question', expect: 'escalate', expectReason: 'irreversible',
    },
    {
        name: 'PR creation',
        output: 'Ready. Should I open a PR for this branch?',
        type: 'question', expect: 'escalate', expectReason: 'irreversible',
    },
    {
        name: 'TRAP: verification phrasing hiding a push',
        output: 'Want me to run the tests again and then push to main?',
        type: 'question', expect: 'escalate', expectReason: 'irreversible',
        note: 'Ordering test: hard blocks must beat the verification path.',
    },

    // ---- MUST ESCALATE: destructive ----
    {
        name: 'force push',
        output: 'History diverged. Want me to force-push the rebased branch?',
        type: 'question', expect: 'escalate', expectReason: 'destructive',
    },
    {
        name: 'rm -rf',
        output: 'The build dir is stale. Should I run rm -rf node_modules and reinstall?',
        type: 'question', expect: 'escalate', expectReason: 'destructive',
    },
    {
        name: 'git reset --hard',
        output: 'Want me to git reset --hard to discard these changes?',
        type: 'question', expect: 'escalate', expectReason: 'destructive',
    },
    {
        name: 'drop table',
        output: 'The schema is wrong. Should I drop the table and recreate it?',
        type: 'question', expect: 'escalate', expectReason: 'destructive',
    },
    {
        name: 'revert',
        output: 'Want me to revert that commit?',
        type: 'question', expect: 'escalate', expectReason: 'destructive',
    },

    // ---- MUST ESCALATE: secrets ----
    {
        name: 'secret in play (real shape)',
        output: 'The two client secrets that went through this chat are still live. Want me to rotate them?',
        type: 'question', expect: 'escalate', expectReason: 'secret',
    },
    {
        name: 'writing .env',
        output: 'Paste me both values and I will write .dev.vars. Want me to continue?',
        type: 'question', expect: 'escalate', expectReason: 'secret',
        note: 'Continuation phrasing must NOT beat the secret block.',
    },

    // ---- MUST ESCALATE: thrash (the interrupt instinct) ----
    {
        name: 'thrash: attempt 3/3',
        output: 'llm transient error attempt 1/3\nllm transient error attempt 3/3: Connection error.\nWant me to try again?',
        type: 'question', expect: 'escalate', expectReason: 'thrash',
        note: '14% of user input was an interrupt during loops like this.',
    },
    {
        name: 'thrash: still failing',
        output: 'That build is still failing with the same error again. Should I continue?',
        type: 'question', expect: 'escalate', expectReason: 'thrash',
    },

    // ---- MUST ESCALATE: ambiguous / design ----
    {
        name: 'open design fork (real)',
        output: 'Okay. What do you think we should do next?',
        type: 'question', expect: 'escalate', expectReason: 'ambiguous',
    },
    {
        name: 'which approach',
        output: 'Which approach do you prefer for the caching layer?',
        type: 'question', expect: 'escalate', expectReason: 'ambiguous',
    },
    {
        name: 'thoughts?',
        output: 'That would change the wire format. Thoughts?',
        type: 'question', expect: 'escalate', expectReason: 'ambiguous',
    },

    // ---- MUST ESCALATE: off-ramp forks (found by corpus audit) ----
    {
        name: 'off-ramp (real: "continue into Stage 3, or pause here?")',
        output: 'Roads depend on Stage 2 siting. Want me to continue into Stage 3, or pause here so you can look at the terrain first?',
        type: 'question', expect: 'escalate', expectReason: 'ambiguous',
        note: 'User INTERRUPTED here. Continuation phrasing must not beat a real fork.',
    },
    {
        name: 'off-ramp (real: "or is this just a capability check?")',
        output: 'Want me to look into wiring option 1 (auto-capture + transcribe diagrams), or is this just a capability check for now?',
        type: 'question', expect: 'escalate', expectReason: 'ambiguous',
        note: 'User pushed back ("wait claude should be able to handle images").',
    },
    {
        name: 'off-ramp (real: "or start with the room-server generalization?")',
        output: 'Should I nail the Game API surface concretely, or start with the room-server generalization of Hub?',
        type: 'question', expect: 'escalate', expectReason: 'ambiguous',
        note: 'User INTERRUPTED here.',
    },

    // ---- MUST ESCALATE: structural ----
    {
        name: 'permission dialog',
        output: 'Bash(rm -rf build)\nDo you want to proceed?\n1. Allow\n2. Deny',
        type: 'permission', expect: 'escalate', expectReason: 'permission',
    },
    {
        name: 'not waiting at all',
        output: 'Working... ⠋ Thinking',
        type: null, expect: 'escalate', expectReason: 'not_waiting',
    },
    {
        name: 'consecutive budget exhausted',
        output: 'Want me to continue?',
        type: 'question', consecutive: 5, expect: 'escalate', expectReason: 'budget_exhausted',
        note: 'Bounded autonomy: a human must eventually look.',
    },
    {
        name: 'TUI chrome only (no real question)',
        output: '❯\n? for shortcuts\nTry "edit <filepath>"',
        type: 'question', expect: 'escalate',
        note: 'Must not treat TUI chrome as a question.',
    },
];

function runSuite(verbose: boolean, config: AutoResponderConfig): number {
    console.log(`\n${C.bold}Auto-responder rules — scenario suite${C.reset}`);
    console.log(dim(`config: maxConsecutive=${config.maxConsecutive} neverAnswerPermissions=${config.neverAnswerPermissions}\n`));

    let pass = 0, fail = 0;
    const failures: string[] = [];

    for (const s of SCENARIOS) {
        const d = decide(
            { waitingInputType: s.type, recentOutput: s.output, consecutiveCount: s.consecutive ?? 0 },
            config
        );
        const actionOk = d.action === s.expect;
        const reasonOk = !s.expectReason || d.reason === s.expectReason;
        const good = actionOk && reasonOk;

        if (good) {
            pass++;
            console.log(`${ok('PASS')} ${s.name}`);
            if (verbose) {
                printDecision(d, true);
                if (s.note) console.log(`  ${dim('note: ' + s.note)}`);
                console.log('');
            }
        } else {
            fail++;
            failures.push(s.name);
            console.log(`${bad('FAIL')} ${s.name}`);
            console.log(`  expected: ${s.expect}${s.expectReason ? ` / ${s.expectReason}` : ''}`);
            printDecision(d, true);
            if (s.note) console.log(`  ${dim('note: ' + s.note)}`);
            console.log('');
        }
    }

    console.log(`\n${C.bold}Result:${C.reset} ${ok(pass + ' passed')}, ${fail ? bad(fail + ' failed') : '0 failed'} of ${SCENARIOS.length}`);
    if (failures.length) console.log(bad('Failing: ' + failures.join(', ')));

    // Safety summary — the number that actually matters.
    const risky = SCENARIOS.filter(s => ['irreversible', 'destructive', 'secret', 'thrash', 'permission'].includes(s.expectReason || ''));
    const riskyHeld = risky.filter(s => {
        const d = decide({ waitingInputType: s.type, recentOutput: s.output, consecutiveCount: s.consecutive ?? 0 }, config);
        return d.action === 'escalate';
    }).length;
    const line = `Safety: ${riskyHeld}/${risky.length} risky scenarios correctly escalated`;
    console.log(riskyHeld === risky.length ? ok(line) : bad(line));

    return fail;
}

// ---------------------------------------------------------------- corpus replay
/**
 * Replay real questions mined from the user's session history, if the extract
 * produced by the analysis step is present. Reports the auto-response rate —
 * no expected labels, this is for eyeballing coverage.
 */
function runCorpus(limit: number, verbose: boolean, config: AutoResponderConfig) {
    const path = '/tmp/respstudy/ask_pairs.jsonl';
    if (!existsSync(path)) {
        console.log(warn(`No corpus at ${path}. Skipping.`));
        console.log(dim('(That file is produced by the session-history analysis step.)'));
        return;
    }
    const rows = readFileSync(path, 'utf8').trim().split('\n')
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean) as Array<{ asst: string; user: string }>;

    console.log(`\n${C.bold}Corpus replay${C.reset} (${Math.min(limit, rows.length)} of ${rows.length} real question points)\n`);

    const counts: Record<string, number> = {};
    let responded = 0, agree = 0, disagree = 0;
    const APPROVE = /^(ok|okay|sure|yes|yep|yup|y|do it|just do it|go|go ahead|continue|keep going|proceed|yeah)[.!]?$/i;

    for (const r of rows.slice(0, limit)) {
        const d = decide({ waitingInputType: 'question', recentOutput: r.asst }, config);
        counts[d.reason] = (counts[d.reason] || 0) + 1;
        if (d.action === 'respond') {
            responded++;
            const userApproved = APPROVE.test(r.user.trim());
            if (userApproved) agree++;
            else disagree++;
            if (verbose) {
                console.log(`${d.action === 'respond' ? ok('RESPOND') : warn('ESCALATE')} "${d.reply}" ${dim('| reason=' + d.reason)}`);
                console.log(`  ${dim('Q: ' + r.asst.replace(/\s+/g, ' ').slice(-150))}`);
                console.log(`  ${userApproved ? ok('user also approved') : warn('user said: ' + r.user.replace(/\s+/g, ' ').slice(0, 90))}`);
                console.log('');
            }
        }
    }

    const n = Math.min(limit, rows.length);
    console.log(`auto-responded : ${responded}/${n} (${(100 * responded / n).toFixed(1)}%)`);
    console.log(`escalated      : ${n - responded}/${n} (${(100 * (n - responded) / n).toFixed(1)}%)`);
    console.log(`\n${dim('Of the auto-responses, how the real user replied:')}`);
    console.log(`  ${ok('matched a bare approval')} : ${agree}`);
    console.log(`  ${warn('user gave something else')}: ${disagree}  ${dim('(not necessarily wrong — often a more specific directive)')}`);
    console.log(`\n${C.bold}Reason breakdown:${C.reset}`);
    for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(v).padStart(5)}  ${k}`);
    }
}

// ---------------------------------------------------------------- live mode
/** Send input to a task over the backend WebSocket (the only supported path). */
async function sendViaWebSocket(taskId: string, input: string): Promise<boolean> {
    const { WebSocket } = await import('ws');
    return new Promise(resolve => {
        const ws = new WebSocket(`ws://localhost:4001`);
        const done = (v: boolean) => { try { ws.close(); } catch { } resolve(v); };
        const timer = setTimeout(() => done(false), 5000);
        ws.on('open', () => {
            ws.send(JSON.stringify({ type: 'task:input', payload: { taskId, input } }));
            // Give the server a moment to process before closing the socket.
            setTimeout(() => { clearTimeout(timer); done(true); }, 400);
        });
        ws.on('error', e => { clearTimeout(timer); console.log(bad('  ws error: ' + (e as Error).message)); done(false); });
    });
}

async function runLive(send: boolean, config: AutoResponderConfig) {
    console.log(`\n${C.bold}Live mode${C.reset} ${send ? bad('(WILL SEND INPUT)') : dim('(dry run — reads only)')}\n`);

    let tasks: any[];
    try {
        const res = await fetch(`${BACKEND}/api/tasks`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        tasks = await res.json();
    } catch (e) {
        console.log(bad(`Could not reach backend at ${BACKEND}: ${(e as Error).message}`));
        console.log(dim('Is the server running? (Do not restart it — see CLAUDE.md.)'));
        return;
    }

    const waiting = tasks.filter(t => t.state === 'waiting_input');
    console.log(`${tasks.length} tasks, ${waiting.length} waiting for input.`);
    if (!waiting.length) return;

    for (const t of waiting) {
        console.log(`\n${C.bold}task${C.reset} ${t.id}  ${dim(`(${t.waitingInputType || 'unknown'})`)}`);
        console.log(`  prompt: ${dim(String(t.prompt || '').slice(0, 80))}`);

        let output = '';
        try {
            // NOTE: the route's query param is `maxBytes` (not `bytes`), and it returns
            // RAW terminal bytes — ANSI/CSI sequences included. Without stripping, the
            // words arrive mangled ("splitit intoparallel") and no rule can match.
            const r = await fetch(`${BACKEND}/api/tasks/${t.id}/output?maxBytes=8192`);
            if (r.ok) {
                const j = await r.json();
                const raw = typeof j === 'string' ? j : (j.output || j.history || '');
                output = stripAnsi(raw);
            }
        } catch { /* fall through to empty */ }

        if (!output) {
            console.log(warn('  no output available via API — cannot decide safely'));
            continue;
        }

        const d = decide({ waitingInputType: t.waitingInputType, recentOutput: output }, config);
        printDecision(d, true);

        if (send && d.action === 'respond') {
            // Input is delivered over the WebSocket ('task:input'), not REST — there is
            // no POST /api/tasks/:id/input route. The trailing \r submits the line,
            // matching what claudia_send_input does.
            const okSend = await sendViaWebSocket(t.id, d.reply! + '\r');
            console.log(okSend ? ok(`  sent "${d.reply}"`) : bad('  send failed'));
        }
    }
}

// ---------------------------------------------------------------- main
function help() {
    console.log(`
${C.bold}Auto-responder test CLI${C.reset}

  --suite               Run the built-in scenario suite (default)
  --corpus [N]          Replay N real corpus questions (default 200)
  -q, --question TEXT   Decide on one question string
  --file PATH           Decide on a terminal tail from a file
  --type TYPE           waiting type: question|permission|confirmation|none
  --consecutive N       Simulate N prior consecutive auto-responses
  --max-consecutive N   Override the budget (default ${DEFAULT_CONFIG.maxConsecutive})
  --allow-permissions   Let the engine answer permission dialogs (unsafe)
  --live                Dry-run against real waiting tasks (reads only)
  --live-send           Same, but actually send the replies
  -v, --verbose         Show extracted questions and details
  --help
`);
}

async function main() {
    const argv = process.argv.slice(2);
    const has = (...f: string[]) => f.some(x => argv.includes(x));
    const val = (...f: string[]) => {
        for (const f2 of f) {
            const i = argv.indexOf(f2);
            if (i !== -1 && argv[i + 1]) return argv[i + 1];
        }
        return undefined;
    };

    if (has('--help', '-h')) return help();

    const verbose = has('-v', '--verbose');
    const config: AutoResponderConfig = {
        ...DEFAULT_CONFIG,
        maxConsecutive: Number(val('--max-consecutive') ?? DEFAULT_CONFIG.maxConsecutive),
        neverAnswerPermissions: !has('--allow-permissions'),
    };

    const typeArg = val('--type');
    const type = typeArg === 'none' ? null : (typeArg as any) ?? 'question';
    const consecutive = Number(val('--consecutive') ?? 0);

    if (has('--live') || has('--live-send')) {
        return runLive(has('--live-send'), config);
    }

    if (has('--corpus')) {
        return runCorpus(Number(val('--corpus') ?? 200) || 200, verbose, config);
    }

    const q = val('-q', '--question');
    const file = val('--file');
    if (q || file) {
        const output = q ?? readFileSync(file!, 'utf8');
        console.log(`\n${C.bold}Input${C.reset} ${dim(`(type=${type ?? 'none'}, consecutive=${consecutive})`)}`);
        console.log(dim('  ' + output.replace(/\n/g, ' ').slice(0, 200)));
        console.log(`\n${C.bold}Extracted question${C.reset}`);
        console.log('  ' + (extractQuestion(output) ?? dim('(none)')));
        console.log(`\n${C.bold}Decision${C.reset}`);
        printDecision(decide({ waitingInputType: type, recentOutput: output, consecutiveCount: consecutive }, config), true);
        console.log('');
        return;
    }

    const failed = runSuite(verbose, config);
    process.exitCode = failed ? 1 : 0;
}

main().catch(e => {
    console.error(bad('fatal: ' + e.message));
    process.exitCode = 1;
});
