/**
 * Session summarizer for the minimal chat view.
 *
 * The detailed chat view renders every event. That's still busy: long assistant
 * messages, code blocks, tool inputs and outputs. The minimal view instead shows a
 * short line of prose every so often — "Claude is refactoring the upload client and
 * fixing a failing test" — so you can follow along without reading anything.
 *
 * Design notes:
 * - Summaries are generated per *batch* of events, not per event. A batch closes when
 *   enough events accumulate or enough time passes, so we make few LLM calls.
 * - Results are cached per task and keyed by the batch's last event id, so reconnecting
 *   or re-opening the view never re-summarizes (and never re-bills) the same events.
 * - Generation is best-effort. If the LLM is unconfigured, slow, or errors, we fall back
 *   to a deterministic description built from the event types. The view must never be
 *   blocked on a network call.
 * - Tool inputs/outputs are aggressively truncated before being sent. We only need the
 *   gist, and transcripts can contain very large file contents.
 */

import { spawn } from 'child_process';
import { generateLLMResponse } from './llm-service.js';
import type { SessionEvent, ToolCallEvent } from './session-events.js';

/**
 * Generate text with the local `claude` CLI in headless mode.
 *
 * llm-service.ts posts to a local /v1/messages proxy, but that route does not exist
 * in this server and `apiMode` defaults to no API key — so it fails on a stock setup.
 * The CLI is already authenticated (it's what runs every task), which makes it the
 * dependable path. We still try the proxy first so a configured API key wins.
 */
const claudeExe = process.platform === 'win32' ? 'claude.exe' : 'claude';

function generateViaClaudeCli(prompt: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(claudeExe, ['--print', '--output-format', 'text', '-p', prompt], {
            env: process.env as { [key: string]: string },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        const timer = setTimeout(() => {
            child.kill();
            reject(new Error('claude CLI timeout'));
        }, timeoutMs);

        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d) => { stdout += String(d); });
        child.stderr?.on('data', (d) => { stderr += String(d); });
        child.stdin?.end();

        child.on('error', (err) => { clearTimeout(timer); reject(err); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0 && stdout.trim()) resolve(stdout.trim());
            else reject(new Error(`claude CLI exited ${code}: ${stderr.slice(0, 200)}`));
        });
    });
}

export interface SessionSummary {
    id: string;
    /** One or two sentences of plain prose. Never contains code or markdown. */
    text: string;
    /** Number of source events this summary covers. */
    eventCount: number;
    timestamp: string;
    /** True when this came from the deterministic fallback rather than the LLM. */
    isFallback?: boolean;
}

/** Close a batch once this many events accumulate. */
const BATCH_SIZE = 12;
/** ...or once the oldest pending event is this old, so slow sessions still report. */
const BATCH_MAX_AGE_MS = 20000;

/** Keep prompts small — we want the gist, not the file contents. */
const MAX_TOOL_CHARS = 200;
const MAX_TEXT_CHARS = 600;

function truncate(s: string, n: number): string {
    const t = s.trim();
    return t.length <= n ? t : `${t.slice(0, n)}…`;
}

/** Strip markdown so the model sees prose and can't be tempted to echo code back. */
function toPlainText(md: string): string {
    return md
        .replace(/```[\s\S]*?```/g, ' ')      // fenced code
        .replace(/`([^`]+)`/g, '$1')          // inline code
        .replace(/^#{1,6}\s+/gm, '')          // headings
        .replace(/\*\*([^*]+)\*\*/g, '$1')    // bold
        .replace(/\*([^*]+)\*/g, '$1')        // italic
        .replace(/^\s*[-*+]\s+/gm, '')        // bullets
        .replace(/^\s*\|.*\|\s*$/gm, ' ')     // table rows
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links
        .replace(/\s+/g, ' ')
        .trim();
}

/** A tool's most meaningful argument, for both the prompt and the fallback text. */
function toolTarget(tool: ToolCallEvent): string {
    const input = tool.input || {};
    for (const k of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description']) {
        const v = input[k];
        if (typeof v === 'string' && v.trim()) return truncate(v, 100);
    }
    return '';
}

/** Human-friendly tool label; MCP tools are namespaced mcp__server__tool. */
function toolLabel(name: string): string {
    if (!name.startsWith('mcp__')) return name;
    const parts = name.slice(5).split('__');
    return parts.length < 2 ? name : `${parts[0]} ${parts.slice(1).join(' ').replace(/_/g, ' ')}`;
}

/**
 * Deterministic summary used when the LLM is unavailable. Not as nice to read as
 * generated prose, but it always says something true about what happened.
 */
export function buildFallbackSummary(events: SessionEvent[]): string {
    const tools = events.filter((e): e is ToolCallEvent => e.type === 'tool');
    const assistantTexts = events.filter((e) => e.type === 'text' && e.role === 'assistant');
    const failed = tools.filter((t) => t.isError).length;

    const parts: string[] = [];

    if (tools.length > 0) {
        // Group by tool so "Read" x3 reads as one clause instead of three.
        const byName = new Map<string, number>();
        for (const t of tools) {
            const label = toolLabel(t.name || 'tool');
            byName.set(label, (byName.get(label) || 0) + 1);
        }
        const clauses = Array.from(byName.entries())
            .slice(0, 3)
            .map(([name, n]) => (n > 1 ? `${name} (${n}×)` : name));
        parts.push(`Used ${clauses.join(', ')}`);
    }

    if (assistantTexts.length > 0 && tools.length === 0) {
        const first = assistantTexts[0];
        if (first.type === 'text') {
            const plain = toPlainText(first.text);
            if (plain) parts.push(truncate(plain.split(/(?<=[.!?])\s/)[0] || plain, 160));
        }
    }

    if (failed > 0) parts.push(`${failed} failed`);

    return parts.length > 0 ? parts.join(' · ') : 'Working…';
}

/** Render a batch of events into a compact transcript for the model. */
function renderForPrompt(events: SessionEvent[]): string {
    const lines: string[] = [];
    for (const e of events) {
        if (e.type === 'text') {
            const plain = toPlainText(e.text);
            if (plain) lines.push(`${e.role === 'user' ? 'User' : 'Claude'}: ${truncate(plain, MAX_TEXT_CHARS)}`);
        } else if (e.type === 'thinking') {
            // Thinking is intentionally omitted — it's long and rarely adds to the gist.
            continue;
        } else {
            const target = toolTarget(e);
            const status = e.isError ? ' (failed)' : '';
            const result = e.result ? ` → ${truncate(e.result.replace(/\s+/g, ' '), MAX_TOOL_CHARS)}` : '';
            lines.push(`Tool ${toolLabel(e.name || 'tool')}${target ? ` ${target}` : ''}${status}${result}`);
        }
    }
    return lines.join('\n');
}

const SYSTEM_PROMPT = `You narrate what an AI coding agent is doing, for a user watching a calm status feed.

Rules:
- Reply with ONE or TWO short sentences of plain prose. Nothing else.
- Describe what the agent is DOING and WHY, at a high level.
- Absolutely NO code, no file contents, no command syntax, no markdown, no bullet points, no backticks.
- Filenames are fine in plain prose. Do not quote code.
- Present tense, e.g. "Claude is adding retry logic to the upload client and re-running the tests."
- If something failed, say so plainly.
- Do not add pleasantries, preambles, or offers to help.`;

/**
 * Summarize one batch of events. Falls back to a deterministic description when the
 * LLM is unavailable — callers always get a usable string.
 */
export async function summarizeEvents(events: SessionEvent[]): Promise<{ text: string; isFallback: boolean }> {
    const transcript = renderForPrompt(events);
    if (!transcript.trim()) {
        return { text: buildFallbackSummary(events), isFallback: true };
    }

    const userMessage = `Here is what the agent just did:\n\n${transcript}\n\nSummarize in one or two sentences.`;

    // Prefer the configured API proxy; fall back to the authenticated CLI. Either way
    // a failure degrades to the deterministic summary rather than showing nothing.
    let raw: string | null = null;
    try {
        raw = await generateLLMResponse(SYSTEM_PROMPT, userMessage, { maxTokens: 120, timeoutMs: 20000 });
    } catch {
        try {
            raw = await generateViaClaudeCli(`${SYSTEM_PROMPT}\n\n${userMessage}`, 30000);
        } catch {
            raw = null;
        }
    }

    if (!raw) return { text: buildFallbackSummary(events), isFallback: true };

    // Defend against a model that ignores the no-markdown instruction.
    const clean = toPlainText(raw);
    if (!clean) return { text: buildFallbackSummary(events), isFallback: true };
    return { text: clean, isFallback: false };
}

/**
 * Accumulates events per task and emits summaries as batches close.
 *
 * The caller feeds every event it sees via `add()`, then calls `drain()` on a timer.
 * `drain()` returns any summaries that became ready, so the transport layer stays
 * simple and this module owns all the batching policy.
 */
export class SessionSummarizer {
    /** Pending, not-yet-summarized events per task. */
    private pending = new Map<string, SessionEvent[]>();
    /** When the oldest pending event for a task arrived. */
    private oldestAt = new Map<string, number>();
    /** Completed summaries per task, in order. */
    private summaries = new Map<string, SessionSummary[]>();
    /** Guards against overlapping LLM calls for the same task. */
    private inFlight = new Set<string>();

    add(taskId: string, events: SessionEvent[], now: number): void {
        if (events.length === 0) return;
        const list = this.pending.get(taskId) || [];
        if (list.length === 0) this.oldestAt.set(taskId, now);
        list.push(...events);
        this.pending.set(taskId, list);
    }

    /** Summaries generated so far for a task (for seeding a newly-opened view). */
    getSummaries(taskId: string): SessionSummary[] {
        return this.summaries.get(taskId) || [];
    }

    /** True when a batch is ready to summarize. */
    private isReady(taskId: string, now: number): boolean {
        const list = this.pending.get(taskId);
        if (!list || list.length === 0) return false;
        if (this.inFlight.has(taskId)) return false;
        if (list.length >= BATCH_SIZE) return true;
        const since = now - (this.oldestAt.get(taskId) ?? now);
        return since >= BATCH_MAX_AGE_MS;
    }

    /**
     * Close and summarize any ready batches. Returns only the newly-created summaries,
     * keyed by task, so the caller can push just the delta.
     */
    async drain(now: number, taskIds?: string[]): Promise<Map<string, SessionSummary[]>> {
        const out = new Map<string, SessionSummary[]>();
        const ids = taskIds ?? Array.from(this.pending.keys());

        await Promise.all(
            ids.map(async (taskId) => {
                if (!this.isReady(taskId, now)) return;

                const batch = this.pending.get(taskId) || [];
                // Claim the batch before awaiting so concurrent drains can't double-send.
                this.pending.set(taskId, []);
                this.oldestAt.delete(taskId);
                this.inFlight.add(taskId);

                try {
                    const { text, isFallback } = await summarizeEvents(batch);
                    const summary: SessionSummary = {
                        // Keyed by the batch's last event so re-delivery is idempotent.
                        id: `sum-${batch[batch.length - 1]?.id ?? String(now)}`,
                        text,
                        eventCount: batch.length,
                        timestamp: new Date(now).toISOString(),
                        isFallback,
                    };
                    const existing = this.summaries.get(taskId) || [];
                    existing.push(summary);
                    this.summaries.set(taskId, existing);
                    out.set(taskId, [summary]);
                } finally {
                    this.inFlight.delete(taskId);
                }
            })
        );

        return out;
    }

    /** Drop all state for a task (destroyed, or no longer being watched). */
    clear(taskId: string): void {
        this.pending.delete(taskId);
        this.oldestAt.delete(taskId);
        this.summaries.delete(taskId);
        this.inFlight.delete(taskId);
    }
}
