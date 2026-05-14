/**
 * Usage Store - Tracks token usage and API costs across tasks.
 * Parses token information from Claude Code task output and aggregates
 * costs by task, workspace, model, and time period.
 */
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadVersioned, saveVersioned } from './utils/schema-version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const USAGE_SCHEMA_VERSION = 1;

// Model pricing per 1M tokens (as of 2025)
const MODEL_PRICING: Record<
  string,
  { input: number; output: number; cacheCreation: number; cacheRead: number }
> = {
  sonnet: { input: 3, output: 15, cacheCreation: 3.75, cacheRead: 0.3 },
  opus: { input: 15, output: 75, cacheCreation: 18.75, cacheRead: 1.5 },
  haiku: { input: 0.8, output: 4, cacheCreation: 1, cacheRead: 0.08 },
};

export interface UsageEntry {
  id: string;
  taskId: string;
  workspaceId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
  timestamp: string;
}

export interface UsageSummary {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  byModel: Record<string, { cost: number; inputTokens: number; outputTokens: number }>;
  byTask: Record<string, { cost: number; totalTokens: number; taskPrompt?: string }>;
  byWorkspace: Record<string, { cost: number; totalTokens: number }>;
  entryCount: number;
  totalEntryCount: number; // Total entries across all time (for comparison)
  oldestEntryDate?: string; // ISO timestamp of oldest entry in the filtered set
  newestEntryDate?: string; // ISO timestamp of newest entry in the filtered set
}

interface UsageData {
  entries: UsageEntry[];
}

const DEFAULT_DATA: UsageData = { entries: [] };

export class UsageStore {
  private data: UsageData;
  private filePath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(basePath?: string) {
    this.filePath = basePath
      ? join(basePath, 'usage-data.json')
      : join(__dirname, '..', 'usage-data.json');

    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.data = this.loadData();
    console.log(
      `[UsageStore] Loaded ${this.data.entries.length} usage entries from ${this.filePath}`,
    );
  }

  private loadData(): UsageData {
    try {
      return loadVersioned<UsageData>(this.filePath, {
        currentVersion: USAGE_SCHEMA_VERSION,
        defaultData: { ...DEFAULT_DATA },
        legacyLoader: (raw) => (raw as UsageData) ?? { ...DEFAULT_DATA },
      });
    } catch (error) {
      console.error('[UsageStore] Error loading data:', error);
      return { ...DEFAULT_DATA };
    }
  }

  private debouncedSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        saveVersioned(this.filePath, this.data, USAGE_SCHEMA_VERSION);
      } catch (error) {
        console.error('[UsageStore] Error saving data:', error);
      }
    }, 2000);
  }

  /**
   * Record a usage entry from parsed task output.
   */
  recordUsage(
    taskId: string,
    workspaceId: string,
    model: string,
    tokens: {
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens?: number;
      cacheReadTokens?: number;
    },
  ): UsageEntry {
    const normalizedModel = this.normalizeModel(model);
    const cost = this.calculateCost(normalizedModel, tokens);

    const entry: UsageEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      taskId,
      workspaceId,
      model: normalizedModel,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      cacheCreationTokens: tokens.cacheCreationTokens || 0,
      cacheReadTokens: tokens.cacheReadTokens || 0,
      cost,
      timestamp: new Date().toISOString(),
    };

    this.data.entries.push(entry);
    this.debouncedSave();
    return entry;
  }

  /**
   * Parse token usage from Claude Code task output.
   * Claude Code outputs patterns like:
   * "Total tokens: 12345 (input: 8000, output: 4345)"
   * "Cost: $0.12 | Tokens: 15,234 input, 3,456 output"
   * "Input: 8,234 tokens | Output: 2,100 tokens | Cache read: 5,000"
   */
  parseAndRecord(taskId: string, workspaceId: string, outputLine: string): UsageEntry | null {
    const stripped = outputLine.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();

    // Pattern 1: "Total cost: $X.XX" or "Cost: $X.XX"
    // Pattern 2: "NNk input tokens" / "NNk output tokens"
    // Pattern 3: "Input tokens: N, Output tokens: N"
    // Pattern 4: Claude Code end-of-session summary with token counts

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;
    let model = 'sonnet';

    // Try to detect model from output
    if (/opus/i.test(stripped)) model = 'opus';
    else if (/haiku/i.test(stripped)) model = 'haiku';

    // Match patterns like "12,345 input" or "input: 12345" or "Input tokens: 12,345"
    const inputMatch =
      stripped.match(/(\d[\d,]*)\s*(?:input|in)\b/i) || stripped.match(/input[:\s]+(\d[\d,]*)/i);
    if (inputMatch) {
      inputTokens = parseInt(inputMatch[1].replace(/,/g, ''), 10);
    }

    const outputMatch =
      stripped.match(/(\d[\d,]*)\s*(?:output|out)\b/i) || stripped.match(/output[:\s]+(\d[\d,]*)/i);
    if (outputMatch) {
      outputTokens = parseInt(outputMatch[1].replace(/,/g, ''), 10);
    }

    // Cache tokens
    const cacheCreateMatch = stripped.match(/cache.?(?:creat|write)[:\s]+(\d[\d,]*)/i);
    if (cacheCreateMatch) {
      cacheCreationTokens = parseInt(cacheCreateMatch[1].replace(/,/g, ''), 10);
    }

    const cacheReadMatch = stripped.match(/cache.?read[:\s]+(\d[\d,]*)/i);
    if (cacheReadMatch) {
      cacheReadTokens = parseInt(cacheReadMatch[1].replace(/,/g, ''), 10);
    }

    // Only record if we found meaningful token data
    if (inputTokens === 0 && outputTokens === 0) return null;

    return this.recordUsage(taskId, workspaceId, model, {
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
    });
  }

  /**
   * Get usage summary filtered by time period.
   */
  getSummary(period: 'today' | '7d' | '30d' | 'all' = 'all', workspaceId?: string): UsageSummary {
    const now = Date.now();
    const cutoff =
      period === 'today'
        ? now - 86400000
        : period === '7d'
          ? now - 7 * 86400000
          : period === '30d'
            ? now - 30 * 86400000
            : 0;

    let entries = this.data.entries.filter((e) => new Date(e.timestamp).getTime() >= cutoff);
    if (workspaceId) {
      entries = entries.filter((e) => e.workspaceId === workspaceId);
    }

    const totalEntryCount = this.data.entries.length;

    const summary: UsageSummary = {
      totalCost: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      byModel: {},
      byTask: {},
      byWorkspace: {},
      entryCount: entries.length,
      totalEntryCount,
      oldestEntryDate: entries.length > 0 ? entries[0].timestamp : undefined,
      newestEntryDate: entries.length > 0 ? entries[entries.length - 1].timestamp : undefined,
    };

    for (const entry of entries) {
      summary.totalCost += entry.cost;
      summary.totalInputTokens += entry.inputTokens;
      summary.totalOutputTokens += entry.outputTokens;
      summary.totalCacheCreationTokens += entry.cacheCreationTokens;
      summary.totalCacheReadTokens += entry.cacheReadTokens;

      // By model
      if (!summary.byModel[entry.model]) {
        summary.byModel[entry.model] = { cost: 0, inputTokens: 0, outputTokens: 0 };
      }
      summary.byModel[entry.model].cost += entry.cost;
      summary.byModel[entry.model].inputTokens += entry.inputTokens;
      summary.byModel[entry.model].outputTokens += entry.outputTokens;

      // By task
      if (!summary.byTask[entry.taskId]) {
        summary.byTask[entry.taskId] = { cost: 0, totalTokens: 0 };
      }
      summary.byTask[entry.taskId].cost += entry.cost;
      summary.byTask[entry.taskId].totalTokens += entry.inputTokens + entry.outputTokens;

      // By workspace
      if (!summary.byWorkspace[entry.workspaceId]) {
        summary.byWorkspace[entry.workspaceId] = { cost: 0, totalTokens: 0 };
      }
      summary.byWorkspace[entry.workspaceId].cost += entry.cost;
      summary.byWorkspace[entry.workspaceId].totalTokens += entry.inputTokens + entry.outputTokens;
    }

    return summary;
  }

  /**
   * Get all entries for a specific task.
   */
  getTaskUsage(taskId: string): UsageEntry[] {
    return this.data.entries.filter((e) => e.taskId === taskId);
  }

  /**
   * Clear all usage data.
   */
  clearAll(): void {
    this.data.entries = [];
    this.debouncedSave();
  }

  private normalizeModel(model: string): string {
    const lower = model.toLowerCase();
    if (lower.includes('opus')) return 'opus';
    if (lower.includes('haiku')) return 'haiku';
    return 'sonnet';
  }

  private calculateCost(
    model: string,
    tokens: {
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens?: number;
      cacheReadTokens?: number;
    },
  ): number {
    const pricing = MODEL_PRICING[model] || MODEL_PRICING['sonnet'];
    return (
      (tokens.inputTokens / 1_000_000) * pricing.input +
      (tokens.outputTokens / 1_000_000) * pricing.output +
      ((tokens.cacheCreationTokens || 0) / 1_000_000) * pricing.cacheCreation +
      ((tokens.cacheReadTokens || 0) / 1_000_000) * pricing.cacheRead
    );
  }
}
