// Compact task summary generator for the mobile companion app.
//
// When a task transitions from busy → idle, we emit a `task:summary` WS event
// containing a short summary (a few sentences, like a chat-agent message) and
// 2-4 dynamically generated quick-action chips. The mobile app renders this
// as a chat bubble in a single-agent timeline; tapping a chip sends that
// prompt back to the task.
//
// Inspired by the Claudia MCP server design: tools like `claudia_continue_task`,
// `claudia_send_input`, etc. demonstrate that the most useful actions are
// concrete verbs ("continue", "run tests", "open PR"). We extract that pattern
// here by asking the LLM to look at recent output + the user's own past
// prompts and propose 2-4 short button labels with the prompts behind them.
//
// Strategy:
// 1. Real LLM path (preferred): call the local /v1/messages proxy with a
//    structured-JSON prompt. Returns { summary, nextActions }.
// 2. Deterministic stub: when the LLM call fails (no key / network / bad
//    JSON), build a lightweight summary from `recentOutput` and reuse a
//    static list of next actions. Keeps the mobile flow testable without
//    spending tokens.

import type { MobileTaskSummary, Task } from '@claudia/shared';

import { generateLLMResponse } from './llm-service.js';

interface SummaryInput {
  task: Task;
  workspaceName?: string;
  recentOutput?: string; // Last ~4KB of PTY output, optional
  spendUsd?: number;
  // Past user prompts (across all tasks) — used as style/intent examples so
  // the LLM proposes actions that sound like things THIS user actually says.
  pastUserPrompts?: string[];
}

const STUB_NEXT_ACTIONS: { label: string; prompt: string }[] = [
  { label: 'Continue', prompt: 'Please continue with the next step.' },
  { label: 'Run tests', prompt: 'Run the test suite and report results.' },
  { label: 'Summarize', prompt: 'Give me a concise summary of what changed.' },
];

/**
 * Build a deterministic summary from task fields and recent output.
 * No LLM call. Used as a fallback when the LLM path fails.
 */
function buildStubSummary(input: SummaryInput): MobileTaskSummary {
  const { task, recentOutput } = input;
  const taskName = task.displayName ?? task.prompt;
  const trimmed = (recentOutput ?? '').trim();
  // Pick the last non-empty line as the "last action" hint.
  const lines = trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^[-=─━]+$/.test(l));
  const lastLine = lines.length > 0 ? lines[lines.length - 1] : '';
  const hint = lastLine.length > 120 ? `${lastLine.slice(0, 117)}…` : lastLine;
  const summary = hint
    ? `${task.state === 'idle' ? 'Idle' : task.state}. ${hint}`
    : `Task is ${task.state}.`;
  return {
    taskId: task.id,
    workspaceId: task.workspaceId,
    workspaceName: input.workspaceName,
    taskName,
    state: task.state,
    summary: summary.length > 320 ? `${summary.slice(0, 317)}…` : summary,
    spendUsd: input.spendUsd ?? task.tokenUsage?.totalCostUsd,
    nextActions: STUB_NEXT_ACTIONS,
    timestamp: new Date().toISOString(),
  };
}

interface LLMSummaryShape {
  summary?: string;
  nextActions?: Array<{ label?: string; prompt?: string }>;
}

/**
 * Try to extract a JSON object from the model's text. Models sometimes wrap
 * JSON in code fences or add a trailing apology; we strip those and look for
 * the outermost {...} block.
 */
function tryParseJSON(text: string): LLMSummaryShape | null {
  if (!text) return null;
  // Strip code fences
  const cleaned = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  // Find first { and last } — covers most models' tendency to add prose.
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(slice) as LLMSummaryShape;
  } catch {
    return null;
  }
}

function clampSentence(s: string, max: number): string {
  const trimmed = s.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function sanitizeActions(
  raw: LLMSummaryShape['nextActions'],
): { label: string; prompt: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { label: string; prompt: string }[] = [];
  const seen = new Set<string>();
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue;
    const label = typeof a.label === 'string' ? a.label.trim() : '';
    const prompt = typeof a.prompt === 'string' ? a.prompt.trim() : '';
    if (!label || !prompt) continue;
    if (label.length > 28) continue; // chips need to fit on screen
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, prompt });
    if (out.length >= 4) break;
  }
  return out;
}

const SYSTEM_PROMPT = `You are an assistant inside Claudia, a multi-agent coding tool. A coding task has just finished. Write a short status update (the user is reading it on a phone in a chat-style timeline) and propose quick-action chips.

Return STRICT JSON only, with this shape and nothing else:
{
  "summary": "2-4 short sentences in plain prose describing what just happened, in past tense. Be specific about what was done, what files/components were touched if mentioned, and any outcomes (tests passed/failed, PR opened, error hit). No code blocks. No markdown. ≤ 320 chars.",
  "nextActions": [
    { "label": "≤24 chars chip text", "prompt": "Full natural-language follow-up prompt to send back to Claude Code" },
    ...
  ]
}

Rules for nextActions:
- Return 2-4 actions. Each is a button the user can tap to send a follow-up to the same task.
- Labels are short imperative verbs ("Run tests", "Open PR", "Show diff", "Fix lint", "Deploy").
- Prompts are full sentences in the user's own voice — when "Past user prompts" are supplied, mimic their tone, vocabulary, and brevity (e.g. lowercase, terse, conversational).
- Make actions CONCRETE to what just happened. Not generic. If the task wrote tests, suggest "Run tests". If a build failed, suggest "Fix the failure". If a PR was just opened, suggest "Address review comments".
- Always include a "Continue" or equivalent so the user can let it keep going.
- Never propose destructive actions (delete branch, force push, drop database) — keep it safe.`;

function buildUserMessage(input: SummaryInput): string {
  const { task, recentOutput, pastUserPrompts, workspaceName } = input;
  const past = (pastUserPrompts ?? [])
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .slice(0, 12);
  const recent = (recentOutput ?? '').slice(-3500); // keep prompt small
  const parts: string[] = [];
  parts.push(`Task name: ${task.displayName ?? task.prompt}`);
  if (workspaceName) parts.push(`Workspace: ${workspaceName}`);
  parts.push(`Final state: ${task.state}`);
  if (typeof task.tokenUsage?.totalCostUsd === 'number') {
    parts.push(`Spend so far: $${task.tokenUsage.totalCostUsd.toFixed(2)}`);
  }
  if (past.length) {
    parts.push('');
    parts.push('Past user prompts (use to mimic the user\'s voice):');
    for (const p of past) {
      parts.push(`  - ${p.length > 200 ? `${p.slice(0, 197)}…` : p}`);
    }
  }
  parts.push('');
  parts.push('Recent terminal output (most recent at the bottom):');
  parts.push('---');
  parts.push(recent || '(no output captured)');
  parts.push('---');
  parts.push('');
  parts.push('Now produce the JSON.');
  return parts.join('\n');
}

/**
 * Generate a mobile-friendly task summary using the LLM. Falls back to the
 * stub on any failure.
 */
export async function generateMobileSummary(
  input: SummaryInput,
): Promise<MobileTaskSummary> {
  const stub = buildStubSummary(input);
  try {
    const userMsg = buildUserMessage(input);
    console.log(
      `[task-summary] Generating LLM summary for task ${input.task.id} (output=${(input.recentOutput ?? '').length}B, pastPrompts=${input.pastUserPrompts?.length ?? 0})`,
    );
    const text = await generateLLMResponse(SYSTEM_PROMPT, userMsg, {
      maxTokens: 500,
      temperature: 0.4,
      timeoutMs: 30_000,
    });
    const parsed = tryParseJSON(text);
    if (!parsed) {
      console.warn('[task-summary] LLM returned non-JSON, falling back to stub');
      return stub;
    }
    const summaryText =
      typeof parsed.summary === 'string' && parsed.summary.trim()
        ? clampSentence(parsed.summary, 320)
        : stub.summary;
    const actions = sanitizeActions(parsed.nextActions);
    if (actions.length === 0) {
      console.warn('[task-summary] LLM returned no usable actions, using stub set');
    }
    return {
      ...stub,
      summary: summaryText,
      nextActions: actions.length ? actions : stub.nextActions,
    };
  } catch (err) {
    console.warn(
      '[task-summary] LLM summary failed, falling back to stub:',
      err instanceof Error ? err.message : err,
    );
    return stub;
  }
}

export function buildSimulatedSummary(taskId = 'sim-task'): MobileTaskSummary {
  return {
    taskId,
    workspaceId: 'sim-workspace',
    workspaceName: 'simulated',
    taskName: 'Simulated mobile event',
    state: 'idle',
    summary:
      'Done — verified ✅. 3 iterations, $0.84. Tests passed; ready for review.',
    spendUsd: 0.84,
    iterations: 3,
    nextActions: [
      { label: 'Open PR', prompt: 'Open a pull request with the changes.' },
      { label: 'Add tests', prompt: 'Add edge-case tests for this change.' },
      { label: 'Deploy', prompt: 'Deploy to staging and report back.' },
    ],
    timestamp: new Date().toISOString(),
  };
}
