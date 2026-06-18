/**
 * Mobile Agent — the per-workspace AI agent that powers the companion app's
 * chat experience.
 *
 * Two entry points:
 *
 *   • runAgentTurn(workspaceId, userInput) — user typed/spoke a message in
 *     the chat; run an Anthropic tool-use loop where the model can call
 *     workspace-scoped tools (list tasks, send input, spawn task, etc.) and
 *     ultimately produce a chat reply.
 *
 *   • summarizeIdleTask(task) — a task just transitioned to idle. Generate
 *     a chat-style summary (2-4 sentences) plus 2-4 dynamic quick-action
 *     chips, modelled on the user's own past prompts so the suggestions
 *     sound like things THIS user actually says.
 *
 * Both paths share:
 *   • The `gatherPastUserPrompts` helper that mines `Task.prompt` + JSONL
 *     follow-up turns from `conversation-parser.ts`.
 *   • The same JSON-output style used by the original task-summary.ts.
 *   • Fallbacks when the LLM call fails (so the chat is never empty).
 *
 * Inspired by claudia-mcp-server.ts: the tool surface mirrors a useful
 * subset of the MCP tools, but invoked directly in-process — no MCP stdio
 * round-trip needed when the backend talks to itself.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import type { MobileChatMessage, MobileChatQuickAction, Task } from '@claudia/shared';

import { generateLLMResponse, resolveLlmEndpoint } from './llm-service.js';
import type { TaskSpawner } from './task-spawner.js';
import type { WorkspaceStore } from './workspace-store.js';
import type { MobileChatStore } from './mobile-chat-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface TextBlock {
  type: 'text';
  text: string;
}

type ContentBlock = ToolUseBlock | TextBlock;

interface AnthropicMessageContent {
  role: 'user' | 'assistant';
  content: ContentBlock[] | string;
}

interface AnthropicResponseShape {
  id: string;
  role: 'assistant';
  content: ContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOOL_LOOP_ITERATIONS = 6;
const MAX_PAST_PROMPTS = 12;
const MAX_RECENT_OUTPUT_BYTES = 3500;

function getModel(): string {
  return process.env.LLM_MODEL ?? DEFAULT_MODEL;
}

// ---------------------------------------------------------------------------
// MobileAgent class
// ---------------------------------------------------------------------------

export interface MobileAgentDeps {
  taskSpawner: TaskSpawner;
  workspaceStore: WorkspaceStore;
  chatStore: MobileChatStore;
}

export class MobileAgent {
  private deps: MobileAgentDeps;
  // Serialize agent turns per workspace so two quick user messages don't race.
  private inflightByWorkspace = new Map<string, Promise<MobileChatMessage[]>>();

  constructor(deps: MobileAgentDeps) {
    this.deps = deps;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Run one turn of the agent for the given workspace. Appends the user
   * message to the transcript first (caller may also do this — but we make
   * the agent loop self-contained), then runs the tool-use loop, appending
   * tool-result and final agent messages. Returns ALL new messages produced
   * during this turn (excluding the initial user message, which the caller
   * already has the id for).
   */
  async runAgentTurn(
    workspaceId: string,
    userInput: string,
  ): Promise<MobileChatMessage[]> {
    // Serialize per-workspace
    const prev = this.inflightByWorkspace.get(workspaceId);
    const next: Promise<MobileChatMessage[]> = (async () => {
      if (prev) {
        try {
          await prev;
        } catch {
          /* prior turn errored; we still proceed */
        }
      }
      return this.runAgentTurnInner(workspaceId, userInput);
    })();
    this.inflightByWorkspace.set(workspaceId, next);
    try {
      return await next;
    } finally {
      // Only clear if still the latest
      if (this.inflightByWorkspace.get(workspaceId) === next) {
        this.inflightByWorkspace.delete(workspaceId);
      }
    }
  }

  /**
   * Generate a chat-style summary message for a task that just settled to
   * idle. Appends it to the workspace transcript and returns the new
   * message. Quick actions are dynamically generated from the user's past
   * prompts when an LLM is reachable, falling back to a static set.
   */
  async summarizeIdleTask(task: Task): Promise<MobileChatMessage> {
    const workspaceName = this.getWorkspaceName(task.workspaceId);
    const recentOutput = this.deps.taskSpawner.getRecentOutputForDebug(
      task.id,
      MAX_RECENT_OUTPUT_BYTES,
    );
    const pastPrompts = this.gatherPastUserPrompts(task.workspaceId, MAX_PAST_PROMPTS);

    let text: string;
    let actions: MobileChatQuickAction[];
    try {
      const result = await this.callJsonLLM(
        SUMMARY_SYSTEM_PROMPT,
        buildSummaryUserMessage({
          task,
          workspaceName,
          recentOutput,
          pastPrompts,
        }),
        500,
      );
      text = clamp(result.summary ?? '', 320) || fallbackSummary(task, recentOutput);
      actions = sanitizeActions(result.nextActions) || [];
      if (actions.length === 0) actions = STUB_ACTIONS;
    } catch (err) {
      console.warn(
        `[MobileAgent] summary LLM failed for task ${task.id}, using stub:`,
        err instanceof Error ? err.message : err,
      );
      text = fallbackSummary(task, recentOutput);
      actions = STUB_ACTIONS;
    }

    return this.deps.chatStore.appendMessage({
      workspaceId: task.workspaceId,
      role: 'agent',
      text,
      taskId: task.id,
      quickActions: actions,
    });
  }

  // -------------------------------------------------------------------------
  // Tool-use loop
  // -------------------------------------------------------------------------

  private async runAgentTurnInner(
    workspaceId: string,
    userInput: string,
  ): Promise<MobileChatMessage[]> {
    console.log(
      `[MobileAgent] turn start ws=${workspaceId} input=${JSON.stringify(userInput.slice(0, 120))}`,
    );

    // 1. Append the user message first so it is durable and visible to clients.
    this.deps.chatStore.appendMessage({
      workspaceId,
      role: 'user',
      text: userInput,
    });

    // 2. Build context for the model.
    const workspaceName = this.getWorkspaceName(workspaceId);
    const taskList = this.listWorkspaceTasksSummary(workspaceId);
    const pastPrompts = this.gatherPastUserPrompts(workspaceId, MAX_PAST_PROMPTS);
    const transcript = this.deps.chatStore.getRecentMessages(workspaceId, 20);

    const system = buildAgentSystemPrompt({
      workspaceName,
      workspaceId,
      taskList,
      pastPrompts,
    });

    // Convert transcript to Anthropic message format. We treat user/agent as
    // alternating user/assistant turns. System messages are folded into a
    // user prefix.
    const messages: AnthropicMessageContent[] = transcriptToAnthropicMessages(transcript);

    const newMessages: MobileChatMessage[] = [];

    for (let iter = 0; iter < MAX_TOOL_LOOP_ITERATIONS; iter++) {
      const response = await this.callAnthropicWithTools(system, messages, AGENT_TOOLS);

      // Save the assistant turn into the running message list so the next
      // round (if any) sees it.
      messages.push({ role: 'assistant', content: response.content });

      const toolUses = response.content.filter(
        (c): c is ToolUseBlock => c.type === 'tool_use',
      );
      const textBlocks = response.content.filter(
        (c): c is TextBlock => c.type === 'text',
      );

      if (toolUses.length === 0 || response.stop_reason === 'end_turn') {
        // Final reply — emit a single agent chat message with text + actions.
        const text = textBlocks
          .map((t) => t.text.trim())
          .filter(Boolean)
          .join('\n\n')
          .trim();
        if (text) {
          // Ask the model in a tiny follow-up call for quick actions tailored
          // to its own reply. We do this as a separate strict-JSON call to
          // keep the tool-loop cheap and predictable.
          const actions = await this.maybeGenerateActionsForReply({
            workspaceId,
            replyText: text,
            taskList,
            pastPrompts,
          });
          const stored = this.deps.chatStore.appendMessage({
            workspaceId,
            role: 'agent',
            text,
            quickActions: actions,
          });
          newMessages.push(stored);
        }
        return newMessages;
      }

      // Execute each tool call and accumulate tool_result blocks for the
      // next turn.
      const toolResultBlocks: Array<{
        type: 'tool_result';
        tool_use_id: string;
        content: string;
        is_error?: boolean;
      }> = [];

      for (const tu of toolUses) {
        const result = await this.executeTool(workspaceId, tu);
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: result.content,
          is_error: result.isError,
        });
        // Also surface a brief system message in the chat so the user sees
        // the agent is working ("Spawned task X", "Sent input to task Y").
        if (result.userVisibleNote) {
          const note = this.deps.chatStore.appendMessage({
            workspaceId,
            role: 'system',
            text: result.userVisibleNote,
            taskId: result.taskId,
          });
          newMessages.push(note);
        }
      }

      messages.push({ role: 'user', content: toolResultBlocks as unknown as ContentBlock[] });
    }

    // Loop ran past the cap — produce a fallback message so the user isn't
    // left wondering.
    console.warn(`[MobileAgent] tool loop hit cap of ${MAX_TOOL_LOOP_ITERATIONS} iterations`);
    const fallback = this.deps.chatStore.appendMessage({
      workspaceId,
      role: 'agent',
      text:
        "I'm taking longer than expected to figure this out — try asking again or open a task directly to inspect it.",
    });
    newMessages.push(fallback);
    return newMessages;
  }

  // -------------------------------------------------------------------------
  // LLM calls
  // -------------------------------------------------------------------------

  private async callAnthropicWithTools(
    system: string,
    messages: AnthropicMessageContent[],
    tools: AnthropicTool[],
  ): Promise<AnthropicResponseShape> {
    const body = {
      model: getModel(),
      system,
      messages,
      tools,
      max_tokens: 1024,
    };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 45_000);
    try {
      // Route through resolveLlmEndpoint() so we hit the same upstream as
      // every other server-side LLM caller (Anthropic API directly, the
      // hyperspace proxy, or the custom-anthropic endpoint depending on
      // the user's apiMode). Previously this hardcoded a non-existent
      // localhost:4001/v1/messages route which 404'd every chat turn.
      const endpoint = resolveLlmEndpoint();
      console.log(`[MobileAgent] LLM endpoint resolved: mode=${endpoint.apiMode} url=${endpoint.url} headerKeys=${Object.keys(endpoint.headers).join(',')}`);
      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers: endpoint.headers,
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (!res.ok) {
        const errTxt = await res.text();
        throw new Error(`LLM ${res.status}: ${errTxt.slice(0, 300)}`);
      }
      const data = (await res.json()) as AnthropicResponseShape;
      console.log(
        `[MobileAgent] LLM stop_reason=${data.stop_reason} tools=${data.content.filter((c) => c.type === 'tool_use').length} text=${data.content.filter((c) => c.type === 'text').length}`,
      );
      return data;
    } finally {
      clearTimeout(t);
    }
  }

  private async callJsonLLM(
    system: string,
    user: string,
    maxTokens: number,
  ): Promise<{ summary?: string; nextActions?: unknown }> {
    const text = await generateLLMResponse(system, user, {
      maxTokens,
      temperature: 0.4,
      timeoutMs: 30_000,
    });
    return tryParseJsonObject(text) ?? {};
  }

  private async maybeGenerateActionsForReply(input: {
    workspaceId: string;
    replyText: string;
    taskList: string;
    pastPrompts: string[];
  }): Promise<MobileChatQuickAction[] | undefined> {
    try {
      const userMsg = [
        `Workspace: ${this.getWorkspaceName(input.workspaceId) ?? input.workspaceId}`,
        '',
        'Active tasks:',
        input.taskList || '  (none)',
        '',
        input.pastPrompts.length
          ? `User’s past phrasing (mimic tone/voice):\n${input.pastPrompts.map((p) => `  - ${p}`).join('\n')}`
          : '',
        '',
        'Your last reply was:',
        '"""',
        input.replyText,
        '"""',
        '',
        'Now produce JSON only (no prose, no markdown):',
        '{ "nextActions": [ { "label": "≤24 chars verb", "prompt": "full follow-up message" }, ... ] }',
        '',
        'Rules: 2-4 actions, concrete to the reply, in the user’s voice. Never destructive.',
      ].join('\n');

      const result = await this.callJsonLLM(REPLY_ACTIONS_SYSTEM_PROMPT, userMsg, 250);
      const actions = sanitizeActions(result.nextActions);
      return actions.length ? actions : undefined;
    } catch (err) {
      console.warn(
        '[MobileAgent] reply-actions LLM failed:',
        err instanceof Error ? err.message : err,
      );
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Tool implementations (in-process — no MCP transport)
  // -------------------------------------------------------------------------

  private async executeTool(
    workspaceId: string,
    tu: ToolUseBlock,
  ): Promise<{
    content: string;
    isError?: boolean;
    userVisibleNote?: string;
    taskId?: string;
  }> {
    console.log(
      `[MobileAgent] tool=${tu.name} input=${JSON.stringify(tu.input).slice(0, 200)}`,
    );
    try {
      switch (tu.name) {
        case 'list_tasks':
          return this.toolListTasks(workspaceId);
        case 'get_task_output':
          return this.toolGetTaskOutput(workspaceId, tu.input as { taskId?: string; maxBytes?: number });
        case 'send_input_to_task':
          return await this.toolSendInputToTask(
            workspaceId,
            tu.input as { taskId?: string; input?: string },
          );
        case 'create_task':
          return await this.toolCreateTask(
            workspaceId,
            tu.input as { prompt?: string; displayName?: string },
          );
        case 'continue_task':
          return await this.toolContinueTask(
            workspaceId,
            tu.input as { taskId?: string; prompt?: string },
          );
        case 'stop_task':
          return await this.toolStopTask(workspaceId, tu.input as { taskId?: string });
        default:
          return {
            content: `Error: Unknown tool '${tu.name}'.`,
            isError: true,
          };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[MobileAgent] tool ${tu.name} threw:`, msg);
      return { content: `Error: ${msg}`, isError: true };
    }
  }

  private toolListTasks(workspaceId: string): { content: string } {
    const tasks = this.deps.taskSpawner
      .getAllTasks()
      .filter((t) => t.workspaceId === workspaceId)
      .map((t) => ({
        id: t.id,
        state: t.state,
        prompt: (t.displayName ?? t.prompt ?? '').slice(0, 140),
        lastActivity: t.lastActivity,
      }));
    return { content: JSON.stringify(tasks, null, 2) };
  }

  private toolGetTaskOutput(
    workspaceId: string,
    input: { taskId?: string; maxBytes?: number },
  ): { content: string; isError?: boolean } {
    const taskId = input.taskId;
    if (!taskId) return { content: 'Error: taskId is required.', isError: true };
    const task = this.deps.taskSpawner.getTask(taskId);
    if (!task) return { content: `Error: Task '${taskId}' not found.`, isError: true };
    if (task.workspaceId !== workspaceId) {
      return {
        content: `Error: Task '${taskId}' is in a different workspace.`,
        isError: true,
      };
    }
    const max = Math.min(input.maxBytes ?? 4096, 16384);
    const out = this.deps.taskSpawner.getRecentOutputForDebug(taskId, max);
    return {
      content: JSON.stringify(
        { taskId, state: task.state, output: out },
        null,
        2,
      ),
    };
  }

  private async toolSendInputToTask(
    workspaceId: string,
    input: { taskId?: string; input?: string },
  ): Promise<{ content: string; isError?: boolean; userVisibleNote?: string; taskId?: string }> {
    if (!input.taskId || !input.input) {
      return { content: 'Error: taskId and input are required.', isError: true };
    }
    const task = this.deps.taskSpawner.getTask(input.taskId);
    if (!task) return { content: `Error: Task '${input.taskId}' not found.`, isError: true };
    if (task.workspaceId !== workspaceId) {
      return {
        content: `Error: Task '${input.taskId}' is in a different workspace.`,
        isError: true,
      };
    }
    this.deps.taskSpawner.writeToTask(input.taskId, input.input + '\r');
    return {
      content: `Sent input to task ${input.taskId}.`,
      userVisibleNote: `Sent input to task: ${truncate(input.input, 80)}`,
      taskId: input.taskId,
    };
  }

  private async toolCreateTask(
    workspaceId: string,
    input: { prompt?: string; displayName?: string },
  ): Promise<{ content: string; isError?: boolean; userVisibleNote?: string; taskId?: string }> {
    if (!input.prompt) return { content: 'Error: prompt is required.', isError: true };
    const ws = this.deps.workspaceStore.getWorkspaces().find((w) => w.id === workspaceId);
    if (!ws) return { content: `Error: Workspace ${workspaceId} not found.`, isError: true };
    const task = await this.deps.taskSpawner.createTask(input.prompt, workspaceId);
    if (input.displayName) {
      try {
        this.deps.taskSpawner.renameTask(task.id, input.displayName, 'agent');
      } catch (err) {
        console.warn('[MobileAgent] renameTask failed (non-fatal):', err);
      }
    }
    return {
      content: JSON.stringify({ taskId: task.id, state: task.state }, null, 2),
      userVisibleNote: `Spawned new task: ${input.displayName ?? truncate(input.prompt, 60)}`,
      taskId: task.id,
    };
  }

  private async toolContinueTask(
    workspaceId: string,
    input: { taskId?: string; prompt?: string },
  ): Promise<{ content: string; isError?: boolean; userVisibleNote?: string; taskId?: string }> {
    if (!input.taskId || !input.prompt) {
      return { content: 'Error: taskId and prompt are required.', isError: true };
    }
    const task = this.deps.taskSpawner.getTask(input.taskId);
    if (!task) return { content: `Error: Task '${input.taskId}' not found.`, isError: true };
    if (task.workspaceId !== workspaceId) {
      return {
        content: `Error: Task '${input.taskId}' is in a different workspace.`,
        isError: true,
      };
    }
    if (task.state === 'busy' || task.state === 'starting') {
      return {
        content: `Task '${input.taskId}' is currently ${task.state}; cannot send a follow-up. Stop it first or wait.`,
        isError: true,
      };
    }
    this.deps.taskSpawner.writeToTask(input.taskId, input.prompt + '\r');
    return {
      content: `Continued task ${input.taskId}.`,
      userVisibleNote: `Continued task: ${truncate(input.prompt, 80)}`,
      taskId: input.taskId,
    };
  }

  private async toolStopTask(
    workspaceId: string,
    input: { taskId?: string },
  ): Promise<{ content: string; isError?: boolean; userVisibleNote?: string; taskId?: string }> {
    if (!input.taskId) return { content: 'Error: taskId is required.', isError: true };
    const task = this.deps.taskSpawner.getTask(input.taskId);
    if (!task) return { content: `Error: Task '${input.taskId}' not found.`, isError: true };
    if (task.workspaceId !== workspaceId) {
      return {
        content: `Error: Task '${input.taskId}' is in a different workspace.`,
        isError: true,
      };
    }
    const stopped = this.deps.taskSpawner.stopTask(input.taskId);
    return {
      content: stopped ? `Stopped task ${input.taskId}.` : `Could not stop task ${input.taskId}.`,
      userVisibleNote: stopped ? `Stopped task ${input.taskId}` : undefined,
      taskId: input.taskId,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private getWorkspaceName(workspaceId: string): string | undefined {
    const ws = this.deps.workspaceStore.getWorkspaces().find((w) => w.id === workspaceId);
    return ws?.displayName ?? ws?.name;
  }

  private listWorkspaceTasksSummary(workspaceId: string): string {
    const tasks = this.deps.taskSpawner
      .getAllTasks()
      .filter((t) => t.workspaceId === workspaceId);
    if (!tasks.length) return '';
    return tasks
      .slice(0, 20)
      .map(
        (t) =>
          `  - id=${t.id} state=${t.state} name=${JSON.stringify(t.displayName ?? t.prompt?.slice(0, 80) ?? '')}`,
      )
      .join('\n');
  }

  /**
   * Mine past user prompts for the workspace from two sources:
   *   1. `Task.prompt` for every task in the workspace (fast, in-memory).
   *   2. JSONL follow-up turns from the workspace's recent Claude Code
   *      sessions (durable, captures conversational tone).
   * Returns up to `limit` deduplicated, trimmed prompts, newest first.
   *
   * Best-effort: if anything throws (workspace path missing, JSONL malformed)
   * we fall back to whatever we got from Tasks alone.
   */
  private gatherPastUserPrompts(workspaceId: string, limit: number): string[] {
    const seen = new Set<string>();
    const out: string[] = [];

    const push = (raw: string) => {
      const t = raw.trim();
      if (!t) return;
      const key = t.toLowerCase().slice(0, 100);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(t.length > 240 ? `${t.slice(0, 237)}…` : t);
    };

    // 1. Task prompts (newest first by lastActivity)
    try {
      const tasks = this.deps.taskSpawner
        .getAllTasks()
        .filter((t) => t.workspaceId === workspaceId)
        .sort(
          (a, b) =>
            new Date(b.lastActivity ?? 0).getTime() - new Date(a.lastActivity ?? 0).getTime(),
        );
      for (const t of tasks) {
        if (out.length >= limit) break;
        if (t.prompt) push(t.prompt);
      }
    } catch (err) {
      console.warn('[MobileAgent] gatherPastUserPrompts task scan failed:', err);
    }

    // 2. JSONL follow-up user turns (most recent sessions)
    if (out.length < limit) {
      const ws = this.deps.workspaceStore.getWorkspaces().find((w) => w.id === workspaceId);
      // For Claudia workspaces, `id` IS the path on disk.
      if (ws?.id) {
        try {
          const jsonlPrompts = readRecentUserTurnsFromJsonl(ws.id, limit - out.length, 4);
          for (const p of jsonlPrompts) {
            if (out.length >= limit) break;
            push(p);
          }
        } catch (err) {
          console.warn('[MobileAgent] gatherPastUserPrompts JSONL scan failed:', err);
        }
      }
    }

    return out;
  }
}

// ---------------------------------------------------------------------------
// JSONL parsing — synchronous subset just for past-prompt mining.
// We deliberately don't import conversation-parser.ts here because that
// module is async and parses much more than we need; for perf we read the
// last few KB of each session file ourselves.
// ---------------------------------------------------------------------------

function getClaudeProjectsDirSync(workspacePath: string): string {
  // Mirrors conversation-parser's path mapping: ~/.claude/projects/<encoded>
  const encoded = workspacePath.replace(/[\/.]/g, '-');
  return join(homedir(), '.claude', 'projects', encoded);
}

function readRecentUserTurnsFromJsonl(
  workspacePath: string,
  limit: number,
  maxFiles: number,
): string[] {
  const dir = getClaudeProjectsDirSync(workspacePath);
  if (!existsSync(dir)) return [];

  let files: { path: string; mtime: number }[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const p = join(dir, f);
        return { path: p, mtime: statSync(p).mtime.getTime() };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, maxFiles);
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const f of files) {
    if (out.length >= limit) break;
    try {
      const stat = statSync(f.path);
      // Read at most 64KB tail of each JSONL — recent turns sit at the end
      const tailBytes = Math.min(stat.size, 64 * 1024);
      const fd = openSync(f.path, 'r');
      const buf = Buffer.alloc(tailBytes);
      try {
        readSync(fd, buf, 0, tailBytes, Math.max(0, stat.size - tailBytes));
      } finally {
        closeSync(fd);
      }
      const text = buf.toString('utf8');
      // Drop a partial first line (we likely started mid-line)
      const firstNl = text.indexOf('\n');
      const usable = firstNl >= 0 ? text.slice(firstNl + 1) : text;
      const lines = usable.split('\n').reverse();
      for (const line of lines) {
        if (!line.trim()) continue;
        if (out.length >= limit) break;
        try {
          const entry = JSON.parse(line);
          if (entry?.type !== 'user') continue;
          const msg = entry.message;
          if (!msg) continue;
          let content = '';
          if (typeof msg.content === 'string') content = msg.content;
          else if (Array.isArray(msg.content)) {
            for (const c of msg.content) {
              if (c?.type === 'text' && typeof c.text === 'string') content += c.text;
            }
          }
          content = content.trim();
          // Skip tool-result echoes (start with "[Tool ...]") and obviously
          // non-user content.
          if (!content || content.startsWith('[') || content.startsWith('<')) continue;
          out.push(content);
        } catch {
          /* skip bad line */
        }
      }
    } catch {
      /* skip bad file */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SUMMARY_SYSTEM_PROMPT = `You are an assistant inside Claudia, a multi-agent coding tool. A coding task just finished. Write a SHORT chat-style status update for the user, who is reading it on a phone.

Return STRICT JSON only, with this exact shape and nothing else:
{
  "summary": "2-4 short sentences in plain prose, past tense. Be specific about what happened (files touched, tests passed/failed, PR opened, error hit). No code blocks, no markdown. ≤ 320 chars.",
  "nextActions": [
    { "label": "≤24 chars chip text", "prompt": "Full natural-language follow-up prompt to send back to Claude Code" }
  ]
}

Rules for nextActions:
- 2-4 actions. Each is a chip the user can tap to send a follow-up.
- Labels are short imperative verbs ("Run tests", "Open PR", "Show diff").
- Prompts are full sentences in the user's own voice — when "Past user prompts" are supplied, mimic their tone, vocabulary, brevity (lowercase, terse, conversational if that's their style).
- Make actions CONCRETE to what just happened. Not generic.
- Always include something like "Continue" so the user can let it keep going.
- Never propose destructive actions (force push, drop database, delete branch).`;

const REPLY_ACTIONS_SYSTEM_PROMPT = `You are an assistant inside a mobile chat app. Given an agent reply that was just shown to the user, propose 2-4 quick-action chips. Return STRICT JSON only:
{ "nextActions": [ { "label": "...", "prompt": "..." } ] }
Labels are short imperative verbs (≤24 chars). Prompts are full follow-up messages in the user's voice. Concrete to the reply. Never destructive.`;

function buildSummaryUserMessage(input: {
  task: Task;
  workspaceName?: string;
  recentOutput: string;
  pastPrompts: string[];
}): string {
  const { task, workspaceName, recentOutput, pastPrompts } = input;
  const parts: string[] = [];
  parts.push(`Task name: ${task.displayName ?? task.prompt}`);
  if (workspaceName) parts.push(`Workspace: ${workspaceName}`);
  parts.push(`Final state: ${task.state}`);
  if (typeof task.tokenUsage?.totalCostUsd === 'number') {
    parts.push(`Spend so far: $${task.tokenUsage.totalCostUsd.toFixed(2)}`);
  }
  if (pastPrompts.length) {
    parts.push('');
    parts.push("Past user prompts (use to mimic the user's voice):");
    for (const p of pastPrompts) parts.push(`  - ${p}`);
  }
  parts.push('');
  parts.push('Recent terminal output (most recent at the bottom):');
  parts.push('---');
  parts.push(recentOutput || '(no output captured)');
  parts.push('---');
  parts.push('');
  parts.push('Now produce the JSON.');
  return parts.join('\n');
}

function buildAgentSystemPrompt(input: {
  workspaceName?: string;
  workspaceId: string;
  taskList: string;
  pastPrompts: string[];
}): string {
  const { workspaceName, workspaceId, taskList, pastPrompts } = input;
  return [
    `You are Claudia's mobile agent for workspace "${workspaceName ?? workspaceId}".`,
    `The user is on a phone, talking to you in a single chat thread. Be brief, conversational, and action-oriented.`,
    ``,
    `You can call tools to manage the user's coding tasks: list_tasks, get_task_output, send_input_to_task, create_task, continue_task, stop_task. All tools are scoped to this workspace automatically.`,
    ``,
    `When the user asks something:`,
    `  1. If they're asking for status, call list_tasks and/or get_task_output, then reply.`,
    `  2. If they want a new task, call create_task with a clear prompt + a short displayName.`,
    `  3. If they want to send a follow-up to a running or idle task, call send_input_to_task or continue_task.`,
    `  4. If you don't need a tool, just reply directly.`,
    ``,
    `Always reply with at most 2-4 sentences. No markdown, no code blocks unless quoting code. Match the user's vocabulary if you've seen their past phrasing.`,
    ``,
    taskList ? `Active tasks in this workspace:\n${taskList}` : 'No active tasks in this workspace yet.',
    ``,
    pastPrompts.length
      ? `User's past phrasing (mimic tone/voice):\n${pastPrompts.map((p) => `  - ${p}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const AGENT_TOOLS: AnthropicTool[] = [
  {
    name: 'list_tasks',
    description:
      'List all tasks in the current workspace with id, state, and short prompt. Use this to find the right taskId before sending input.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_task_output',
    description:
      "Fetch recent terminal output of a task (default 4KB). Use to check progress or read a task's results.",
    input_schema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task id.' },
        maxBytes: {
          type: 'number',
          description: 'Bytes of output to return (max 16384).',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'send_input_to_task',
    description:
      'Send a line of input to a task that is running or waiting for input. Useful for answering Claude Code prompts.',
    input_schema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        input: { type: 'string', description: 'Text to send (no trailing newline needed).' },
      },
      required: ['taskId', 'input'],
    },
  },
  {
    name: 'create_task',
    description:
      "Spawn a new Claude Code task in this workspace. Use when the user asks for something new to be done.",
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Full prompt for Claude Code.' },
        displayName: {
          type: 'string',
          description: 'Optional short display name for the sidebar (3-6 words).',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'continue_task',
    description:
      'Send a follow-up prompt to an idle task to resume it. Fails if the task is busy.',
    input_schema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        prompt: { type: 'string', description: 'The follow-up prompt to send.' },
      },
      required: ['taskId', 'prompt'],
    },
  },
  {
    name: 'stop_task',
    description: 'Gracefully interrupt a running task. The task transitions to idle.',
    input_schema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
    },
  },
];

// ---------------------------------------------------------------------------
// Plain helpers
// ---------------------------------------------------------------------------

function transcriptToAnthropicMessages(
  msgs: MobileChatMessage[],
): AnthropicMessageContent[] {
  // Convert chat-store messages into Anthropic message format.
  // 'user' → user, 'agent' → assistant, 'system' → folded into the next user
  // turn as a plain text annotation. We always return at least one user msg.
  const out: AnthropicMessageContent[] = [];
  let pendingSystemText: string[] = [];

  for (const m of msgs) {
    if (m.role === 'system') {
      pendingSystemText.push(`[note: ${m.text}]`);
      continue;
    }
    const text = pendingSystemText.length
      ? `${pendingSystemText.join('\n')}\n${m.text}`
      : m.text;
    pendingSystemText = [];
    out.push({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: [{ type: 'text', text }] as ContentBlock[],
    });
  }

  // Anthropic requires the first message to be 'user' and last to be 'user'
  // before a fresh assistant turn. If the last message was an assistant
  // (e.g. we rerun for some reason), the caller should add a follow-up user
  // turn — runAgentTurnInner always appends the user message first.
  return out;
}

function tryParseJsonObject(text: string): { summary?: string; nextActions?: unknown } | null {
  if (!text) return null;
  const cleaned = text
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function sanitizeActions(raw: unknown): MobileChatQuickAction[] {
  if (!Array.isArray(raw)) return [];
  const out: MobileChatQuickAction[] = [];
  const seen = new Set<string>();
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue;
    const obj = a as Record<string, unknown>;
    const label = typeof obj.label === 'string' ? obj.label.trim() : '';
    const prompt = typeof obj.prompt === 'string' ? obj.prompt.trim() : '';
    if (!label || !prompt) continue;
    if (label.length > 28) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, prompt });
    if (out.length >= 4) break;
  }
  return out;
}

function clamp(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

const STUB_ACTIONS: MobileChatQuickAction[] = [
  { label: 'Continue', prompt: 'Please continue with the next step.' },
  { label: 'Run tests', prompt: 'Run the test suite and report results.' },
  { label: 'Summarize', prompt: 'Give me a concise summary of what changed.' },
];

function fallbackSummary(task: Task, recentOutput: string): string {
  const trimmed = (recentOutput ?? '').trim();
  const lines = trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^[-=─━]+$/.test(l));
  const lastLine = lines.length ? lines[lines.length - 1] : '';
  const hint = lastLine.length > 120 ? `${lastLine.slice(0, 117)}…` : lastLine;
  return hint
    ? `${task.state === 'idle' ? 'Idle' : task.state}. ${hint}`
    : `Task is ${task.state}.`;
}
