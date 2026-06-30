/**
 * ConversationView — top-level container that subscribes to conversationStore
 * and renders each event with a virtualized list. Designed to drop into the
 * same flex column TerminalView lives in: it occupies the middle scroll
 * region while the input bar / token stats / checkpoint timeline below it
 * stay anchored.
 *
 * Auto-scrolls to bottom when the user is already near the bottom (the
 * common case), but doesn't yank them away when they've scrolled up to read
 * older context.
 *
 * Cold load: if the store has no events for this task yet, fetches the full
 * snapshot from /api/tasks/:taskId/conversation/events. Live updates flow
 * through the WS event handlers in useWebSocket.ts.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { VList, VListHandle } from 'virtua';
import { Terminal as TerminalIcon } from 'lucide-react';
import type { ConversationEvent, Task, Workspace } from '@claudia/shared';
import {
  useConversationEvents,
  useConversationStore,
} from '../../stores/conversationStore';
import { useTaskStore } from '../../stores/taskStore';
import { getApiBaseUrl } from '../../config/api-config';
import {
  permissionModeLabel,
  permissionModeTone,
} from '../../utils/permissionModes';

/**
 * Playful "what's it doing right now" phrases, in the spirit of Claude Code's
 * terminal status line. Curated for surprise and bite — boring chores and
 * generic corporate verbs need not apply. One is picked at random when a
 * task goes busy and held for the whole turn.
 */
const FUN_GERUNDS = [
  // ── absurd & oddly specific ─────────────────────────────────────────
  'Tuning the kazoo',
  'Herding the photons',
  'Untangling the spaghetti',
  'Charging the flux capacitor',
  'Adjusting the rabbit ears',
  'Realigning the wibbly-wobblies',
  'Polishing the doohickeys',
  'Tinkering with the thingamajig',
  'Fiddling with the whatchamacallit',
  'Recalibrating the gizmo',
  'Deciphering the napkin doodle',
  'Constructing a Rube Goldberg machine',
  'Snapping the legos together',
  'Whittling a wooden duck',
  'Shaking the magic 8-ball',
  'Reading the tea leaves',
  'Petitioning the rubber duck',
  'Quacking with the duck',
  'Hunting wabbits',
  'Following the smell of fresh bytes',
  'Sweeping the chimney',
  'Getting the lead out',

  // ── ridiculous overconfidence ───────────────────────────────────────
  'Splitting the atom',
  'Plotting world domination',
  'Doing the impossible',
  'Threading three needles at once',
  'Juggling flaming chainsaws',
  'Patting head and rubbing belly',
  'Pulling rabbits from hats',
  'Activating beast mode',
  'Engaging giga-brain protocol',
  'Channeling 200 IQ energy',
  'Playing four-dimensional chess against myself',
  'Outsmarting a static type system',
  'Outwitting a regular expression',
  'Spinning straw into TypeScript',
  'Alchemizing caffeine into code',
  'Transmuting frustration into commits',

  // ── meta dev humor ──────────────────────────────────────────────────
  'Whispering sweet nothings to the compiler',
  'Negotiating with the linter',
  'Bargaining with the type checker',
  'Pleading with the parser',
  'Sweet-talking the runtime',
  'Bribing the cache',
  'Coaxing the daemon',
  'Cajoling the kernel',
  'Wheedling the WebSocket',
  'Reasoning with the regex',
  'Politely asking the regex to behave',
  'Arguing with the AST',
  'Debating with the debugger',
  'Bribing the garbage collector',
  'Slipping the kernel a fiver',
  'Smuggling extra cycles past the scheduler',
  'Greasing the palms of the daemon',
  'Schmoozing with the WebSocket',
  'Buttering up the build pipeline',
  'Charming the snake-case off Python',
  'Whispering secrets to the AST',
  'Conspiring with closures',
  'Plotting with promises',
  'Scheming with setTimeout',
  'Gossiping about race conditions',
  'Spilling tea about deadlocks',
  'Negotiating peace between two booleans',
  'Brokering a truce with TypeScript',
  'Persuading the JIT to be reasonable',
  'Plotting against the rate limiter',

  // ── superstition & ritual ───────────────────────────────────────────
  'Praying to the silicon gods',
  'Sacrificing a goat to the compiler',
  'Leaving an offering for the linter',
  'Lighting candles for the GitHub Actions',
  'Performing the deploy ritual',
  'Lighting the production candle',
  'Throwing salt over the shoulder',
  'Spitting three times for luck',
  'Wearing my lucky debugging socks',
  'Knocking thrice on the desk',
  'Holding a séance for the deleted code',
  'Holding a candlelight vigil for the test',
  'Erecting a small monument to the bug',
  'Eulogizing the deprecated function',
  'Pouring one out for the old API',

  // ── deploy panic ────────────────────────────────────────────────────
  'Sending it, with great confidence',
  'Sending it, with mild concern',
  'Sending it, eyes closed',
  'Yolo-ing the deploy',
  'Crossing all available fingers',
  'Crossing toes too, for safety',
  'Whispering nice things to AWS',
  'Apologizing to the load balancer',
  'Begging Cloudflare for mercy',
  'Bargaining with rate limits',
  'Pleading with the API gateway',
  'Submitting a sternly worded ping',
  'Whispering apologies to the CI runner',

  // ── chronic procrastination & avoidance ─────────────────────────────
  'Tabling the discussion till later',
  'Forming a committee about it',
  'Drafting a memo to nobody',
  'Filing a strongly worded complaint',
  'Workshopping the vibes',
  'Filing it under "future me problem"',
  'Marking it WONTFIX with conviction',
  'Tucking the technical debt under a blanket',
  'Sweeping bugs under the rug',
  'Hiding the evidence of yesterday',
  'Pretending the legacy code never happened',
  'Tiptoeing past the sleeping dragon',
  'Avoiding eye contact with the spaghetti',
  'Disturbing nothing, suspiciously',
  'Acting natural while panicking',
  'Pretending I meant to do that',
  'Maintaining a calm professional demeanor',
  'Faking confidence convincingly',
  'Pretending I didn’t notice the smell',

  // ── existential dread ───────────────────────────────────────────────
  'Reflecting on my life choices',
  'Pondering the journey that led here',
  'Considering an alternate career path',
  'Briefly considering goat farming',
  'Daydreaming of a quiet bookshop',
  'Wondering who wrote this nonsense',
  'Realizing it was me',
  'Realizing it was me, again',
  'Bullet-pointing the existential dread',
  'Eating my words with a side salad',
  'Eating crow, lightly seasoned',
  'Humbling myself before the docs',
  'Re-reading the docs sheepishly',
  'Realizing it was in the README',
  'Discovering the answer was Ctrl-F-able',

  // ── violent restraint ───────────────────────────────────────────────
  'Resisting the urge to nuke from orbit',
  'Staying my hand from `rm -rf`',
  'Resisting the lure of force-push',
  'Tabs vs spaces — choosing violence',
  'Yeeting the bug into the void',
  'Returning the parentheses to their pen',
  'Wrangling escaped semicolons',
  'Rounding up runaway brackets',
  'Shooing the bugs out the door',
  'Politely escorting errors offstage',

  // ── archaeology ─────────────────────────────────────────────────────
  'Spelunking the node_modules cave',
  'Excavating ancient TODOs',
  'Carbon-dating commented-out code',
  'Archeologically reviewing the diff',
  'Resurrecting a lost helper',
  'Channeling the original author',
  'Asking what they were thinking, gently',
  'Giving past-me a stern talking-to',
  'Forgiving past-me, mostly',
  'Apologizing on past-me’s behalf',
  'Padding the docstring with regret',
  'Drafting a passive-aggressive README',
  'Writing love notes to the next dev',
  'Setting traps for future-me',
  'Hiding Easter eggs for future-me',

  // ── bug-bestiary ────────────────────────────────────────────────────
  'Reproducing the unreproducible',
  'Documenting the heisenbug',
  'Cataloging another mystery',
  'Adding it to the bestiary',
  'Catching a bug in a butterfly net',
  'Mounting the bug in my collection',
  'Pinning the bug under glass',
  'Labeling the bug with Latin',
  'Framing a particularly fine bug',
  'Adding a bug to the wall of fame',
  'Engraving the stack trace in marble',
  'Tattooing the error message on my heart',
  'Verifying it works on my machine',
  'Failing only in production, classic',
  'Closing the issue triumphantly',
  'Reopening the issue ten minutes later',

  // ── percussive maintenance ──────────────────────────────────────────
  'Refreshing the page with feeling',
  'Hard-refreshing with extra feeling',
  'Clearing cache like a maniac',
  'Power-cycling the rubber duck',
  'Reseating the metaphorical RAM',
  'Percussive maintenance, gentle edition',
  'Percussive maintenance, deluxe edition',
  'Tapping the monitor like an old TV',
  'Wiggling the cables hopefully',
  'Trying it on a coworker’s machine',

  // ── unhinged emotional responses ────────────────────────────────────
  'Smiling through the segfault',
  'Grinning at the null pointer',
  'Cackling at the off-by-one',
  'Snorting at the autocorrect',
  'Belly-laughing at the stack overflow',
  'Cracking up at my own comments',
  'Re-reading my own comments confusedly',
  'Glaring menacingly at a semicolon',
  'Side-eyeing a suspicious comma',
  'Giving the stack trace the silent treatment',
  'Sweating bullets, but politely',

  // ── naming crises ───────────────────────────────────────────────────
  'Renaming the variable for the third time',
  'Going through a naming crisis',
  'Frantically searching for a verb',
  'Settling for "process" again',
  'Trying not to use "data"',
  'Resisting the urge to use "stuff"',
  'Avoiding "thing" with iron will',
  'Discovering "widget" feels right',
  'Embracing "thingamajig" wholeheartedly',
  'Naming things, the hard problem',
  'Cache invalidating, the other hard problem',
  'Off-by-one-ing, the third hidden problem',

  // ── tests & lies ────────────────────────────────────────────────────
  'Naming the test "it works, probably"',
  'Naming the test "please don’t break"',
  'Mocking the dependencies, lovingly',
  'Stubbing the network, ruthlessly',
  'Faking the date with great precision',
  'Time-traveling for the test fixture',
  'Hopping in the DeLorean briefly',
  'Inventing a plausible alternate history',
  'Constructing a believable lie for the mock',
  'Building a Potemkin village of fixtures',
  'Painting a fake door on the wall',
  'Pretending the database exists',
  'Hallucinating, but in a controlled way',
  'Daydreaming responsibly within scope',

  // ── easter eggs & dignity ───────────────────────────────────────────
  'Adding ASCII art for morale',
  'Drawing a cat on the loading screen',
  'Inserting a dad joke into the changelog',
  'Smuggling a pun into the docstring',
  'Sneaking alliteration into log messages',
  'Slipping a haiku into a stack trace',
  'Hiding song lyrics in test names',
  'Easter-egging the about page',
  'Konami-coding the admin panel',
  'Composing a sonnet about the segfault',
  'Writing free verse about flaky tests',

  // ── solving with more problems ──────────────────────────────────────
  'Solving a problem with another problem',
  'Adding a layer of indirection',
  'Adding another layer of indirection',
  'Inventing yet another framework',
  'Founding a new design school',
  'Starting a small reformation',
  'Posting 95 theses about the linter',
  'Convening an emergency standup with myself',
  'Holding a tiny internal hackathon',
  'Self-bikeshedding intensifies',
  'Yak shaving with great enthusiasm',
  'Deeply yak shaving the yaks',
  'Consulting an AI to ask another AI',
  'Asking the elders of Reddit',
  'Lightly heckling Stack Overflow',
  'Roasting the docs in absentia',

  // ── coffee & survival ───────────────────────────────────────────────
  'Locating my coffee mug',
  'Refilling the coffee, importantly',
  'Procuring fresh coffee with urgency',
  'Foraging in the breakroom',
  'Scavenging crumbs of insight',

  // ── dignified nonsense ──────────────────────────────────────────────
  'Confirming reality is still loaded',
  'Verifying gravity hasn’t inverted',
  'Re-establishing object permanence',
  'Re-running the numbers nervously',
  'Stress-testing the napkin math',
  'Sanity-checking the back-of-envelope',
  'Acting cryptic for fun',
  'Being deeply, deeply mysterious',
];

/**
 * Pick a fun gerund once per "round". The word is chosen on each false→true
 * edge of `active` and held steady for the entire turn — no timer-based
 * cycling, since flipping the word mid-thought reads as twitchy. The next
 * round (next user prompt) gets a fresh word.
 */
function useFunGerund(active: boolean): string {
  const [word, setWord] = useState(
    () => FUN_GERUNDS[Math.floor(Math.random() * FUN_GERUNDS.length)],
  );
  const lastWordRef = useRef(word);
  useEffect(() => {
    if (!active) return;
    // Fresh word on every active->true edge, avoiding back-to-back repeats.
    let next = lastWordRef.current;
    for (let i = 0; i < 5 && next === lastWordRef.current; i++) {
      next = FUN_GERUNDS[Math.floor(Math.random() * FUN_GERUNDS.length)];
    }
    lastWordRef.current = next;
    setWord(next);
  }, [active]);
  return word;
}

// Strip ANSI escape sequences and parse interactive-prompt patterns into
// clickable quick-action buttons. See utils/parseQuickAnswers.ts for the
// hairy details — it's pulled out so we can unit-test the parser without
// dragging the whole conversation view through React renderers.
import {
  parseQuickAnswers,
  stripAnsi,
  type QuickAnswer,
} from '../../utils/parseQuickAnswers';

/** Banner shown when Claude is waiting for input. Renders the PTY question
 *  text (ANSI-stripped) plus quick-action buttons parsed from common
 *  prompt patterns (numbered lists, y/n, permission Allow/Deny). The
 *  existing TaskInputBar below remains available for free-text responses. */
const WaitingInputBanner: React.FC<{
  inputType: string;
  recentOutput: string;
  wsRef: React.RefObject<WebSocket | null>;
  taskId: string;
}> = ({ inputType, recentOutput, wsRef, taskId }) => {
  const cleaned = stripAnsi(recentOutput)
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    // drop pure box-drawing / separator lines
    .filter((l) => !/^[\s─━═╌┄·⠀▸▹•◆◇○●]+$/.test(l))
    .slice(-20)
    .join('\n');

  const label =
    inputType === 'permission'
      ? '🔐 Permission required'
      : inputType === 'question'
        ? '❓ Claude has a question'
        : '⏳ Waiting for input';

  const quickAnswers = useMemo(
    () => parseQuickAnswers(cleaned, inputType),
    [cleaned, inputType],
  );

  // When we successfully parsed clickable options, the raw PTY dump below is
  // usually mangled (collapsed whitespace, options smushed together) and
  // duplicates the buttons. Split the cleaned text at the first "<digit>."
  // marker and show only the lead-in question text — that's the part the
  // user actually wants to read. If we couldn't parse options, fall back to
  // the full dump so the user can still answer manually in the input bar.
  const hasQuickAnswers = quickAnswers.length > 0;
  const promptText = useMemo(() => {
    if (!hasQuickAnswers) return cleaned;
    const split = cleaned.match(/^([\s\S]*?)(?=(?:^|[\s❯>•(])\d[.)])/m);
    const head = split ? split[1] : cleaned;
    return head.trim();
  }, [cleaned, hasQuickAnswers]);

  const sendAnswer = (a: QuickAnswer) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Match what TaskInputBar does: send the keystroke followed by a
    // carriage-return so Claude's prompt accepts the answer.
    ws.send(
      JSON.stringify({
        type: 'task:input',
        payload: { taskId, data: a.send + '\r' },
      }),
    );
  };

  return (
    <div className="conv-waiting-banner">
      <div className="conv-waiting-label">{label}</div>
      {promptText && (
        <pre className="conv-waiting-output">{promptText}</pre>
      )}
      {hasQuickAnswers ? (
        <div className="conv-waiting-actions">
          {quickAnswers.map((a, i) => (
            <button
              key={i}
              className={`conv-waiting-btn conv-waiting-btn-${a.variant ?? 'neutral'}`}
              onClick={() => sendAnswer(a)}
              type="button"
              title={a.label}
            >
              {a.label}
            </button>
          ))}
          <span className="conv-waiting-hint conv-waiting-hint-inline">
            …or type a custom response below
          </span>
        </div>
      ) : (
        <div className="conv-waiting-hint">Type your response in the input bar below ↓</div>
      )}
    </div>
  );
};
import { TaskInputBar } from '../TaskInputBar';
import { CheckpointTimeline } from '../CheckpointTimeline';
import { TaskTokenStats, formatTokenCount, formatCost } from '../TaskTokenStats';
import { MessageRouter } from './MessageRouter';
import { ConversationSettings } from './ConversationSettings';
import './ConversationView.css';

/** Persistent bottom-of-pane status strip — mirrors the live status line
 *  Claude Code prints in the terminal (e.g. "Tomfoolering… (1m 52s)").
 *  Shows current state + elapsed seconds while busy/starting plus running
 *  token totals. We can't borrow the cute verbs Claude prints into the PTY,
 *  but a steady spinner + elapsed counter + token count gives users the
 *  same "yes, it's still working" cue they get in TerminalView.
 *
 *  The elapsed counter anchors to `task.processStartedAt` (set on the
 *  server when the PTY launches/relaunches), NOT a local `startedAt` —
 *  that way switching to another task and back doesn't reset the timer
 *  to zero on remount. */
const ConversationStatusBar: React.FC<{ task: Task }> = ({ task }) => {
  const tokenCostEnabled = useTaskStore((s) => s.tokenCostEnabled);
  const showStatusBar = useTaskStore((s) => s.conversationFilters.statusBar);
  const showTokens = useTaskStore((s) => s.conversationFilters.tokenStats);
  const showCost = useTaskStore((s) => s.conversationFilters.cost);
  const permissionMode =
    useTaskStore((s) => s.permissionModeByTask.get(task.id)) ?? 'default';
  // Active question indicator: when the task is parked at a CLI prompt, show
  // a chip in the status bar so users notice immediately that Claude is
  // waiting on them — even if they're scrolled up reading older context and
  // can't see the WaitingInputBanner pinned to the bottom.
  const waitingInfo = useTaskStore((s) =>
    s.waitingInputNotifications.get(task.id),
  );
  const isActive =
    task.state === 'busy' ||
    task.state === 'starting' ||
    task.state === 'waiting_input';
  // While generating, the inline typing indicator above the input bar
  // already shows an animated phrase + elapsed counter. Suppress the
  // duplicate down here.
  const isGenerating = task.state === 'busy' || task.state === 'starting';

  // Tick once per second while active to refresh the elapsed display.
  // (The actual "start" timestamp lives on the task itself, so this only
  //  drives the re-render cadence.)
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [isActive]);

  const label =
    task.state === 'busy'
      ? 'Working…'
      : task.state === 'starting'
        ? 'Starting…'
        : task.state === 'waiting_input'
          ? 'Waiting for input…'
          : task.state === 'interrupted'
            ? 'Interrupted'
            : task.state === 'disconnected'
              ? 'Disconnected'
              : task.state === 'exited'
                ? 'Exited'
                : 'Idle';

  // Anchor to the server-provided processStartedAt so the timer survives
  // remounts (tab-switching away and back). Date instances arrive as
  // strings off the wire, so coerce defensively.
  let elapsedText = '';
  if (isActive && task.processStartedAt) {
    const startMs =
      task.processStartedAt instanceof Date
        ? task.processStartedAt.getTime()
        : new Date(task.processStartedAt as unknown as string).getTime();
    if (Number.isFinite(startMs)) {
      const secs = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
      if (secs >= 60) {
        const m = Math.floor(secs / 60);
        const s = secs % 60;
        elapsedText = `${m}m ${s}s`;
      } else {
        elapsedText = `${secs}s`;
      }
    }
  }

  // Compact token summary: "120.4k in · 4.1k out" with optional cost.
  // We treat "in" as the *effective* context fed to the model — fresh
  // input + cache reads + cache writes — because for Claude Code the
  // raw `inputTokens` field excludes cached tokens and is usually tiny
  // (a few hundred). That made the old "1.2k in" chip look broken next
  // to the much larger numbers in the TaskTokenStats panel below.
  // Hidden until we've actually accumulated something, so idle/new tasks
  // don't show "0 in · 0 out" noise.
  let tokenText = '';
  let costText = '';
  if (task.tokenUsage) {
    const {
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      totalCostUsd,
    } = task.tokenUsage;
    const effectiveIn =
      (inputTokens || 0) + (cacheCreationTokens || 0) + (cacheReadTokens || 0);
    if (showTokens && (effectiveIn > 0 || outputTokens > 0)) {
      tokenText = `${formatTokenCount(effectiveIn)} in · ${formatTokenCount(outputTokens)} out`;
    }
    if (showCost && tokenCostEnabled && totalCostUsd > 0) {
      costText = formatCost(totalCostUsd);
    }
  }

  // Whole-strip kill switch — when the user hides the status bar, render
  // nothing at all so the input bar slots flush against the message list.
  if (!showStatusBar) return null;

  return (
    <div className={`conv-status-bar conv-status-${task.state}`}>
      {/* While busy/starting the inline typing indicator above already
       *  shows an animated phrase + elapsed timer, so we hide the
       *  redundant label/spinner/elapsed here. Other states (waiting_input,
       *  interrupted, disconnected, exited, idle) have no inline indicator,
       *  so they still need a label down here. */}
      {!isGenerating && isActive && (
        <span className="conv-status-spinner" aria-hidden="true" />
      )}
      {!isGenerating && (
        <span className="conv-status-label">{label}</span>
      )}
      {!isGenerating && elapsedText && (
        <span className="conv-status-elapsed">({elapsedText})</span>
      )}
      {/* Question pending — a pulsing chip that screams "Claude needs you"
       *  even when the user has scrolled up and can't see the inline banner
       *  pinned just above. Mirrors the inputType detected from PTY: a
       *  permission gate gets the lock glyph, a free-form question gets the
       *  question mark. */}
      {waitingInfo && task.state === 'waiting_input' && (
        <span
          className={`conv-status-question conv-status-question-${waitingInfo.inputType}`}
          title="Claude is waiting on a response — pick an option below or type a reply"
        >
          <span className="conv-status-question-dot" aria-hidden="true" />
          {waitingInfo.inputType === 'permission'
            ? '🔐 Permission needed'
            : waitingInfo.inputType === 'confirmation'
              ? '✓ Confirm to continue'
              : '❓ Question pending'}
        </span>
      )}
      {tokenText && (
        <>
          {!isGenerating && (
            <span className="conv-status-sep" aria-hidden="true">·</span>
          )}
          <span className="conv-status-tokens">{tokenText}</span>
        </>
      )}
      {costText && (
        <>
          <span className="conv-status-sep" aria-hidden="true">·</span>
          <span className="conv-status-cost">{costText}</span>
        </>
      )}
      {/* Permission-mode chip — mirrors the footer Claude Code prints in
       *  the terminal ("⏵⏵ accept edits on (shift+tab to cycle)") so users
       *  in conversation view can see the current mode and know they can
       *  press Shift+Tab in the input bar to cycle. */}
      <span className="conv-status-spacer" />
      <span
        className={`conv-status-mode conv-status-mode-${permissionModeTone(
          permissionMode,
        )}`}
        title="Press Shift+Tab in the input below to cycle permission modes"
      >
        <span className="conv-status-mode-label">
          {permissionModeLabel(permissionMode)}
        </span>
        <span className="conv-status-mode-hint">
          (<kbd>shift</kbd>+<kbd>tab</kbd> to cycle)
        </span>
      </span>
    </div>
  );
};

interface Props {
  task: Task;
  wsRef: React.RefObject<WebSocket | null>;
  workspace?: Workspace | null;
}

/** "Claude is working..." indicator shown while the task is actively
 *  generating but no new events have arrived yet. Claude Code only flushes
 *  its JSONL writes at turn boundaries, so without this indicator there's
 *  a several-second window where the user sees nothing happening even
 *  though the agent is hard at work.
 *
 *  Displayed when: task is busy/starting AND the most recent event is
 *  either a user_message (we just submitted) or there's an unfinished
 *  assistant turn (last assistant_message is older than the last
 *  user_message).
 *
 *  The elapsed counter anchors to a STABLE timestamp the caller provides
 *  (latest user_message timestamp, falling back to task.processStartedAt)
 *  so the seconds don't reset to zero when the user switches to another
 *  task and back — remounting this component mid-turn must not lose the
 *  counter the way a local Date.now() ref would. */
const WorkingIndicator: React.FC<{ startedAtMs: number }> = ({ startedAtMs }) => {
  const word = useFunGerund(true);
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsedSecs = Math.max(
    0,
    Math.floor((Date.now() - startedAtMs) / 1000),
  );
  const elapsedText =
    elapsedSecs >= 60
      ? `${Math.floor(elapsedSecs / 60)}m ${elapsedSecs % 60}s`
      : `${elapsedSecs}s`;
  return (
    <div className="conv-msg-row conv-msg-row-assistant conv-typing-row">
      <div className="conv-typing-bubble" aria-label={`${word}… (${elapsedText})`}>
        <span className="conv-typing-dots">
          <span></span>
          <span></span>
          <span></span>
        </span>
      </div>
      <div className="conv-msg-timestamp conv-msg-timestamp-assistant conv-typing-label">
        {word}… <span className="conv-typing-elapsed">({elapsedText})</span>
      </div>
    </div>
  );
};

export const ConversationView: React.FC<Props> = ({ task, wsRef, workspace }) => {
  const taskId = task.id;
  const events = useConversationEvents(taskId);
  const setEventsForTask = useConversationStore((s) => s.setEventsForTask);
  const setTaskViewMode = useTaskStore((s) => s.setTaskViewMode);
  const waitingInfo = useTaskStore((s) => s.waitingInputNotifications.get(taskId));
  const filters = useTaskStore((s) => s.conversationFilters);
  const vlistRef = useRef<VListHandle>(null);
  const [autoFollow, setAutoFollow] = useState(true);
  const [coldLoading, setColdLoading] = useState(false);

  // Cold-load on first mount if the store has nothing yet. This handles the
  // page-refresh case where the WS restore hasn't arrived yet (or never
  // will, because the task settled idle before our subscriber attached).
  //
  // Strategy:
  // 1. Try the rich /conversation/events endpoint (backend reload required).
  //    Detect SPA fallback by checking Content-Type — if we get text/html the
  //    new route isn't registered yet and we skip it silently.
  // 2. Fall back to the legacy /conversation endpoint (always available), and
  //    synthesize ConversationEvents from its messages[] + activity[] arrays.
  //    This gives real history immediately, even before the backend reloads.
  useEffect(() => {
    if (events.length > 0) return;
    let cancelled = false;
    setColdLoading(true);

    const base = getApiBaseUrl();
    const tid = encodeURIComponent(taskId);

    const loadFromLegacy = () =>
      fetch(`${base}/api/tasks/${tid}/conversation`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: any) => {
          if (cancelled || !data) return;
          // Convert legacy ParsedConversation → ConversationEvent[]
          const evs: ConversationEvent[] = [];
          const sessionId: string = data.sessionId ?? '';
          for (const msg of data.messages ?? []) {
            // Legacy `content` is normalized by the parser to a string, but
            // be defensive against array-of-blocks shape just in case.
            let text = '';
            if (typeof msg.content === 'string') {
              text = msg.content;
            } else if (Array.isArray(msg.content)) {
              text = msg.content
                .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
                .join('');
            }
            evs.push({
              uuid: msg.uuid ?? `legacy-${evs.length}`,
              taskId,
              sessionId,
              type: msg.role === 'user' ? 'user_message' : 'assistant_message',
              timestamp: msg.timestamp ?? '',
              text,
            });
            if (msg.thinking) {
              evs.push({
                uuid: `${msg.uuid}-thinking`,
                taskId,
                sessionId,
                type: 'thinking',
                timestamp: msg.timestamp ?? '',
                text: msg.thinking,
              });
            }
          }
          console.log(
            `[ConversationView] legacy fallback loaded ${evs.length} events for ${taskId}`,
          );
          if (evs.length > 0) setEventsForTask(taskId, evs);
        })
        .catch(() => {});

    fetch(`${base}/api/tasks/${tid}/conversation/events`)
      .then((r) => {
        // If the backend returned the SPA HTML (new route not yet registered),
        // Content-Type will be text/html — fall back to legacy endpoint.
        const ct = r.headers.get('content-type') ?? '';
        if (!r.ok || !ct.includes('application/json')) {
          return loadFromLegacy();
        }
        return r.json().then((data: any) => {
          if (cancelled) return;
          if (Array.isArray(data?.events) && data.events.length > 0) {
            setEventsForTask(taskId, data.events);
          } else {
            // New endpoint returned empty — maybe session hasn't started yet.
            // Still try legacy in case it has something.
            return loadFromLegacy();
          }
        });
      })
      .catch(() => loadFromLegacy())
      .finally(() => {
        if (!cancelled) setColdLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // intentionally only run on taskId change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // Build a tool_use_id → tool_result map so ToolCall widgets can pair their
  // results without scanning the whole list themselves. Recomputed on each
  // event-list change but the work is O(n) and the array is bounded.
  const resultsByToolUseId = useMemo(() => {
    const map = new Map<string, ConversationEvent>();
    for (const ev of events) {
      if (ev.type === 'tool_result' && ev.toolResult?.toolUseId) {
        map.set(ev.toolResult.toolUseId, ev);
      }
    }
    return map;
  }, [events]);

  // Filter out tool_result rows from the rendered list — they're shown
  // inline inside their paired ToolCall. Then apply the user's
  // visibility filters (each ConversationEventType has its own checkbox
  // in the settings popover).
  const visibleEvents = useMemo(
    () =>
      events.filter((e) => {
        if (e.type === 'tool_result') return false;
        switch (e.type) {
          case 'user_message':
            return filters.userMessages;
          case 'assistant_message':
            return filters.assistantMessages;
          case 'thinking':
            return filters.thinking;
          case 'tool_call':
            return filters.toolCalls;
          case 'system':
            return filters.system;
          case 'summary':
            return filters.summary;
          case 'session_meta':
            return filters.sessionMeta;
          default:
            return true;
        }
      }),
    [events, filters],
  );

  // Show the inline typing indicator (animated dots + fun phrase + elapsed
  // time) the entire time the task is busy/starting. We used to hide it as
  // soon as ANY assistant_message or tool_call arrived, but Claude streams
  // multiple events per turn — that made the indicator flash off between
  // chunks even though generation was still ongoing. Trusting `task.state`
  // is simpler and matches what users actually see in TerminalView.
  const showWorking = useMemo(() => {
    return task.state === 'busy' || task.state === 'starting';
  }, [task.state]);

  // Stable anchor for the working-indicator's elapsed counter. We want
  // "time since this turn started", and we want it to survive switching
  // tabs away and back (which remounts WorkingIndicator). The latest
  // user_message timestamp is the natural turn-start. If somehow there
  // isn't one (cold reload, agent-initiated turn), fall back to the
  // server-provided processStartedAt so we still show *something*
  // sensible instead of bouncing back to 0s on every remount.
  const workingStartedAtMs = useMemo(() => {
    if (!showWorking) return 0;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.type === 'user_message' && ev.timestamp) {
        const ms = new Date(ev.timestamp).getTime();
        if (Number.isFinite(ms)) return ms;
      }
    }
    if (task.processStartedAt) {
      const ms =
        task.processStartedAt instanceof Date
          ? task.processStartedAt.getTime()
          : new Date(task.processStartedAt as unknown as string).getTime();
      if (Number.isFinite(ms)) return ms;
    }
    return Date.now();
  }, [showWorking, events, task.processStartedAt]);

  // Auto-scroll to bottom on new events, BUT only when the user is already
  // near the bottom (so we don't yank them out of historical context).
  useEffect(() => {
    if (!autoFollow) return;
    if (visibleEvents.length === 0) return;
    const handle = vlistRef.current;
    if (!handle) return;
    handle.scrollToIndex(visibleEvents.length - 1, { align: 'end' });
  }, [visibleEvents.length, autoFollow]);

  if (visibleEvents.length === 0) {
    return (
      <div className="terminal-view conv-view-wrap">
        <div className="terminal-header conv-header">
          <span className="terminal-title">Conversation</span>
          <ConversationSettings />
          {!taskId.startsWith('sdk-') && (
            <button
              className="view-toggle-button"
              onClick={() => setTaskViewMode(taskId, 'terminal')}
              title="Switch to terminal view"
            >
              <TerminalIcon size={14} />
              <span>Terminal</span>
            </button>
          )}
        </div>
        <div className="conv-view conv-view-empty">
          <div className="conv-empty-msg">
            {coldLoading ? 'Loading conversation…' : 'No messages yet — send a prompt to start.'}
          </div>
          {showWorking && <WorkingIndicator startedAtMs={workingStartedAtMs} />}
        </div>
        {waitingInfo && (
          <WaitingInputBanner
            inputType={waitingInfo.inputType}
            recentOutput={waitingInfo.recentOutput}
            wsRef={wsRef}
            taskId={taskId}
          />
        )}
        <ConversationStatusBar task={task} />
        <TaskInputBar task={task} wsRef={wsRef} />
        {workspace && (
          <CheckpointTimeline taskId={taskId} workspaceId={workspace.id} wsRef={wsRef} />
        )}
        {filters.tokenStats && <TaskTokenStats taskId={taskId} />}
      </div>
    );
  }

  return (
    <div className="terminal-view conv-view-wrap">
      <div className="terminal-header conv-header">
        <span className="terminal-title">Conversation</span>
        <ConversationSettings />
        {!taskId.startsWith('sdk-') && (
          <button
            className="view-toggle-button"
            onClick={() => setTaskViewMode(taskId, 'terminal')}
            title="Switch to terminal view"
          >
            <TerminalIcon size={14} />
            <span>Terminal</span>
          </button>
        )}
      </div>
      <div className="conv-view">
        <VList
          ref={vlistRef}
          className="conv-list"
          onScroll={() => {
            const handle = vlistRef.current;
            if (!handle) return;
            // virtua exposes scrollOffset + scrollSize; we approximate
            // "near bottom" as within 200px.
            const remaining =
              handle.scrollSize - handle.scrollOffset - handle.viewportSize;
            setAutoFollow(remaining < 200);
          }}
        >
          {visibleEvents.map((ev, i) => {
            // Show a timestamp footer on the last message of each "run"
            // (consecutive messages from the same sender). Mirrors how
            // iMessage / Messenger only stamps the latest in a burst, so
            // the thread doesn't get visually noisy.
            const next = visibleEvents[i + 1];
            const isLastInRun =
              !next ||
              (ev.type === 'user_message' && next.type !== 'user_message') ||
              (ev.type === 'assistant_message' &&
                next.type !== 'assistant_message');
            // Suppress the user's "delivered" stamp while the assistant
            // is still composing — the typing bubble + its label below
            // are the live status, and the static timestamp would compete
            // with them.
            const isLastVisibleEvent = i === visibleEvents.length - 1;
            const showTimestamp =
              isLastInRun &&
              !(showWorking && ev.type === 'user_message' && isLastVisibleEvent);
            return (
              <div key={ev.uuid} className="conv-row">
                <MessageRouter
                  event={ev}
                  resultsByToolUseId={resultsByToolUseId}
                  showTimestamp={showTimestamp}
                  wsRef={wsRef}
                  taskId={taskId}
                />
              </div>
            );
          })}
        </VList>
        {showWorking && <WorkingIndicator startedAtMs={workingStartedAtMs} />}
        {!autoFollow && (
          <button
            className="conv-jump-bottom"
            onClick={() => {
              setAutoFollow(true);
              vlistRef.current?.scrollToIndex(visibleEvents.length - 1, { align: 'end' });
            }}
            type="button"
          >
            ↓ Jump to latest
          </button>
        )}
      </div>
      {waitingInfo && (
        <WaitingInputBanner
          inputType={waitingInfo.inputType}
          recentOutput={waitingInfo.recentOutput}
          wsRef={wsRef}
          taskId={taskId}
        />
      )}
      <ConversationStatusBar task={task} />
      <TaskInputBar task={task} wsRef={wsRef} />
      {workspace && (
        <CheckpointTimeline taskId={taskId} workspaceId={workspace.id} wsRef={wsRef} />
      )}
      {filters.tokenStats && <TaskTokenStats taskId={taskId} />}
    </div>
  );
};
