/**
 * claude-summarize.ts — invoke `claude -p --resume <sessionId>` to produce
 * a clean, mobile-friendly summary of what a task accomplished.
 *
 * Rationale: the original mobile summary path passed a snippet of recent
 * PTY output to the Anthropic SDK and asked it to summarise. That snippet
 * is dominated by Claude Code's TUI chrome (spinners, status bars, screen
 * redraws) which both wastes tokens and confuses the summariser.
 *
 * Resuming the actual session via the CLI gives the summariser the full
 * structured conversation context — the same context the worker model
 * had — so the resulting summary is grounded in what was really done.
 *
 * Tradeoffs vs the SDK path:
 *   • Slower (~5-30s for cold session resume)
 *   • Costs real LLM tokens per summary
 *   • But: vastly higher quality output, no PTY parsing needed
 *
 * This module fires the CLI as a child process, captures stdout, applies
 * a hard timeout, and returns null on any failure so the caller can fall
 * back to the existing path.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const isWindows = process.platform === 'win32';

/** Hard cap on summary wall-time. Past this we abandon and fall back. */
const SUMMARY_TIMEOUT_MS = 45_000;

/**
 * Resolve the Claude CLI invocation. Mirrors `resolveClaudeSpawn` in
 * task-spawner.ts so we hit the same binary the user runs interactively.
 */
function resolveClaudeSpawn(): { command: string; prefixArgs: string[] } {
  if (!isWindows) return { command: 'claude', prefixArgs: [] };
  const appData = process.env['APPDATA'];
  if (appData) {
    const cliPath = join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (existsSync(cliPath)) {
      return { command: process.execPath, prefixArgs: [cliPath] };
    }
  }
  return { command: 'cmd.exe', prefixArgs: ['/c', 'claude.cmd'] };
}

const SUMMARY_PROMPT = `Write a short status update for a phone notification about what we just did. \
Aim for 1-2 sentences, ~30 words. Plain prose only. No code blocks, no quotes, no preamble like "Here's a summary". \
The user is reading this on a lock screen — be specific and skim-friendly. \
Lead with the verb (e.g. "Fixed…", "Built…", "Diagnosed…"). \
Do NOT use bullet points or markdown headings.`;

export interface ClaudeSummaryInput {
  /** Path of the Claude Code workspace the session ran in. */
  workspacePath: string;
  /** Claude session id (the JSONL filename without `.jsonl`). */
  sessionId: string;
  /** Optional override for the summary prompt. */
  prompt?: string;
  /** Optional override for the timeout. Defaults to SUMMARY_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface ClaudeSummaryResult {
  /** Trimmed summary text. */
  text: string;
  /** Wall-time the call took, in ms. */
  durationMs: number;
}

/**
 * Run `claude -p --resume <sessionId> "<prompt>"` in the workspace
 * directory and return the resulting text. Returns null on:
 *   • CLI not on PATH / invocation throws
 *   • timeout fires before the CLI finishes
 *   • CLI exits non-zero
 *   • CLI returns empty stdout
 *
 * The caller should treat null as "fall back to the older summariser".
 */
export async function summarizeViaClaudeP(
  input: ClaudeSummaryInput,
): Promise<ClaudeSummaryResult | null> {
  const { workspacePath, sessionId } = input;
  const timeoutMs = input.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const prompt = input.prompt ?? SUMMARY_PROMPT;

  if (!sessionId) {
    console.warn('[claude-summarize] no sessionId provided');
    return null;
  }
  if (!existsSync(workspacePath)) {
    console.warn(`[claude-summarize] workspacePath does not exist: ${workspacePath}`);
    return null;
  }

  const { command, prefixArgs } = resolveClaudeSpawn();
  const args = [...prefixArgs, '-p', '--resume', sessionId, prompt];

  const startedAt = Date.now();
  return new Promise<ClaudeSummaryResult | null>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(command, args, {
      cwd: workspacePath,
      // Inherit env so the user's auth (~/.claude credentials) is available.
      env: process.env,
      // No interactive stdin — we want -p mode to act non-interactively.
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.warn(
        `[claude-summarize] timeout after ${timeoutMs}ms for session ${sessionId}, killing`,
      );
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve(null);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.warn(`[claude-summarize] spawn error: ${err.message}`);
      resolve(null);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      const text = stdout.trim();

      if (code !== 0) {
        console.warn(
          `[claude-summarize] non-zero exit (${code}) after ${durationMs}ms; stderr=${stderr.slice(0, 200)}`,
        );
        resolve(null);
        return;
      }
      if (!text) {
        console.warn(`[claude-summarize] empty stdout after ${durationMs}ms`);
        resolve(null);
        return;
      }
      console.log(
        `[claude-summarize] session=${sessionId} ${durationMs}ms ${text.length}ch`,
      );
      resolve({ text, durationMs });
    });
  });
}
