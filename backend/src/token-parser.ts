/**
 * Token Parser - Parses Claude Code session JSONL files to extract token usage data.
 *
 * Session JSONL files are located at ~/.claude/projects/<workspace-hash>/<session-id>.jsonl
 * Each line is a JSON object. Assistant messages contain usage data with token counts.
 *
 * IMPORTANT: There are TWO entries per assistant turn sharing the same UUID —
 * a partial (no stop_reason) and a final (with stop_reason). We only count the
 * FINAL entry to avoid double-counting. We track seen UUIDs for this purpose.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { TaskTokenUsage, ModelTokenUsage, ModelPricing } from '@claudia/shared';

// Re-use same path resolution logic as conversation-parser.ts
function workspacePathToClaudeFolderName(workspacePath: string): string {
  return workspacePath.replace(/[^a-zA-Z0-9-]/g, '-');
}

function getClaudeProjectsDir(workspacePath: string): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const folderName = workspacePathToClaudeFolderName(workspacePath);
  return path.join(homeDir, '.claude', 'projects', folderName);
}

/**
 * Resolve the path to a session's JSONL file. Useful for callers that want to
 * stat the file (e.g. for mtime-based throttling) without reparsing it.
 */
export function getSessionFilePath(workspacePath: string, sessionId: string): string {
  return path.join(getClaudeProjectsDir(workspacePath), `${sessionId}.jsonl`);
}

/** Usage fields from a Claude Code API response */
interface JsonlUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Structure of an assistant message in the JSONL */
interface JsonlAssistantEntry {
  type: string;
  uuid?: string;
  message?: {
    model?: string;
    role?: string;
    usage?: JsonlUsage;
    stop_reason?: string | null;
  };
  costUSD?: number;
}

/** Structure of a tool result entry with subagent usage */
interface JsonlToolResultEntry {
  type: string;
  uuid?: string;
  toolUseResult?: {
    usage?: JsonlUsage;
  };
}

/**
 * Calculate cost in USD from token counts and pricing.
 * Returns 0 if no pricing is provided.
 */
export function calculateCost(
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  },
  pricing?: ModelPricing,
): number {
  if (!pricing) return 0;

  // Guard against NaN from malformed token counts
  const inputTokens = usage.inputTokens || 0;
  const outputTokens = usage.outputTokens || 0;
  const cacheCreationTokens = usage.cacheCreationTokens || 0;
  const cacheReadTokens = usage.cacheReadTokens || 0;

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPer1MTokens;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1MTokens;
  const cacheCreateCost = (cacheCreationTokens / 1_000_000) * pricing.cacheCreatePer1MTokens;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * pricing.cacheReadPer1MTokens;

  return inputCost + outputCost + cacheCreateCost + cacheReadCost;
}

/**
 * Parse a Claude Code session JSONL file and extract aggregated token usage.
 * Reads the file line-by-line using readline (same pattern as conversation-parser.ts).
 *
 * Deduplication: Only counts assistant entries with a stop_reason (final entries),
 * skipping partial/streaming entries. Tracks UUIDs to avoid double-counting.
 *
 * Also includes tool result entries that contain subagent usage data.
 *
 * @param sessionFilePath - Absolute path to the .jsonl session file
 * @param pricingMap - Optional pricing map for cost calculation (model name -> pricing)
 * @returns Aggregated token usage, or null if the file doesn't exist
 */
export async function parseSessionTokenUsage(
  sessionFilePath: string,
  pricingMap?: Record<string, ModelPricing>,
): Promise<TaskTokenUsage | null> {
  if (!fs.existsSync(sessionFilePath)) {
    console.log(`[TokenParser] Session file not found: ${sessionFilePath}`);
    return null;
  }

  return new Promise((resolve, reject) => {
    // Aggregated totals
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheCreationTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCostUsd = 0;
    let hasCostUsdFromEntries = false;

    // Per-model breakdown
    const modelBreakdown: Record<string, ModelTokenUsage> = {};

    // Track seen UUIDs for deduplication
    // For assistant entries: we overwrite on each UUID, keeping only the latest (final) values
    const assistantUsageByUuid = new Map<
      string,
      { model: string; usage: JsonlUsage; costUSD?: number }
    >();

    // Tool result entries (subagent usage) — also deduplicate by UUID
    const toolResultUsageByUuid = new Map<string, JsonlUsage>();

    let lineCount = 0;
    let parseErrorCount = 0;

    const fileStream = fs.createReadStream(sessionFilePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      lineCount++;
      try {
        const entry = JSON.parse(line);

        // Process assistant messages
        if (entry.type === 'assistant' && entry.message?.usage && entry.uuid) {
          const msg = entry as JsonlAssistantEntry;
          const usage = msg.message!.usage!;
          const rawModel = msg.message!.model;
          if (!rawModel) {
            console.warn(`[TokenParser] Assistant entry ${entry.uuid} missing model field`);
          }
          const model = rawModel || 'unknown';
          const stopReason = msg.message!.stop_reason;

          // Only count entries with a stop_reason (final entries, not partials)
          if (stopReason) {
            assistantUsageByUuid.set(entry.uuid, {
              model,
              usage,
              costUSD: msg.costUSD,
            });
          }
        }

        // Process tool result entries (subagent usage)
        if (entry.type === 'user' && entry.toolUseResult?.usage && entry.uuid) {
          const toolEntry = entry as JsonlToolResultEntry;
          const usage = toolEntry.toolUseResult!.usage!;
          toolResultUsageByUuid.set(entry.uuid, usage);
        }
      } catch (e) {
        parseErrorCount++;
        // Skip malformed lines — file may be actively written to
      }
    });

    rl.on('close', () => {
      if (parseErrorCount > 0) {
        console.log(
          `[TokenParser] Skipped ${parseErrorCount}/${lineCount} malformed lines in ${sessionFilePath}`,
        );
      }

      // Aggregate assistant usage (deduplicated by UUID)
      for (const [, data] of assistantUsageByUuid) {
        const { model, usage, costUSD } = data;
        const inputTokens = usage.input_tokens || 0;
        const outputTokens = usage.output_tokens || 0;
        const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
        const cacheReadTokens = usage.cache_read_input_tokens || 0;

        totalInputTokens += inputTokens;
        totalOutputTokens += outputTokens;
        totalCacheCreationTokens += cacheCreationTokens;
        totalCacheReadTokens += cacheReadTokens;

        // Use costUSD from entry if available
        if (costUSD !== undefined && costUSD !== null) {
          totalCostUsd += costUSD;
          hasCostUsdFromEntries = true;
        }

        // Per-model breakdown
        if (!modelBreakdown[model]) {
          modelBreakdown[model] = {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            costUsd: 0,
          };
        }
        modelBreakdown[model].inputTokens += inputTokens;
        modelBreakdown[model].outputTokens += outputTokens;
        modelBreakdown[model].cacheCreationTokens += cacheCreationTokens;
        modelBreakdown[model].cacheReadTokens += cacheReadTokens;

        if (costUSD !== undefined && costUSD !== null) {
          modelBreakdown[model].costUsd += costUSD;
        }
      }

      // Aggregate tool result usage (subagent calls — deduplicated by UUID)
      for (const [, usage] of toolResultUsageByUuid) {
        const inputTokens = usage.input_tokens || 0;
        const outputTokens = usage.output_tokens || 0;
        const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
        const cacheReadTokens = usage.cache_read_input_tokens || 0;

        totalInputTokens += inputTokens;
        totalOutputTokens += outputTokens;
        totalCacheCreationTokens += cacheCreationTokens;
        totalCacheReadTokens += cacheReadTokens;

        // Tool results don't have per-model info, aggregate under 'subagent'
        const subagentKey = 'subagent';
        if (!modelBreakdown[subagentKey]) {
          modelBreakdown[subagentKey] = {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            costUsd: 0,
          };
        }
        modelBreakdown[subagentKey].inputTokens += inputTokens;
        modelBreakdown[subagentKey].outputTokens += outputTokens;
        modelBreakdown[subagentKey].cacheCreationTokens += cacheCreationTokens;
        modelBreakdown[subagentKey].cacheReadTokens += cacheReadTokens;
      }

      // Always calculate cost from token counts using pricing.
      // Note: costUSD is NOT present in JSONL session files — only in
      // `--output-format json` final output. So we always compute it.
      if (pricingMap) {
        totalCostUsd = 0;
        for (const [model, modelUsage] of Object.entries(modelBreakdown)) {
          const pricing = pricingMap[model];
          if (!pricing && model !== 'subagent' && model !== 'unknown') {
            console.warn(`[TokenParser] No pricing found for model "${model}", cost will be $0`);
          }
          const cost = calculateCost(modelUsage, pricing);
          modelUsage.costUsd = cost;
          totalCostUsd += cost;
        }
      }

      const result: TaskTokenUsage = {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheCreationTokens: totalCacheCreationTokens,
        cacheReadTokens: totalCacheReadTokens,
        totalCostUsd,
        modelBreakdown,
        lastUpdated: new Date().toISOString(),
      };

      console.log(
        `[TokenParser] Parsed ${sessionFilePath}: ${assistantUsageByUuid.size} assistant turns, ${toolResultUsageByUuid.size} tool results, ${totalInputTokens} in / ${totalOutputTokens} out, cost $${totalCostUsd.toFixed(4)}`,
      );

      resolve(result);
    });

    rl.on('error', (err) => {
      console.error(`[TokenParser] Error reading session file ${sessionFilePath}:`, err.message);
      reject(err);
    });
  });
}

/**
 * Convenience function: resolve session file path from workspace + session ID, then parse.
 * Uses same path resolution as conversation-parser.ts.
 *
 * @param workspacePath - Absolute path to the workspace directory
 * @param sessionId - Claude Code session UUID
 * @param pricingMap - Optional pricing map for cost calculation
 * @returns Aggregated token usage, or null if file not found
 */
export async function getTaskTokenUsage(
  workspacePath: string,
  sessionId: string,
  pricingMap?: Record<string, ModelPricing>,
): Promise<TaskTokenUsage | null> {
  const projectDir = getClaudeProjectsDir(workspacePath);
  const sessionFilePath = path.join(projectDir, `${sessionId}.jsonl`);

  console.log(
    `[TokenParser] Getting token usage for session ${sessionId} in workspace ${workspacePath}`,
  );
  console.log(`[TokenParser] Session file path: ${sessionFilePath}`);

  return parseSessionTokenUsage(sessionFilePath, pricingMap);
}
