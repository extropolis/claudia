import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { calculateCost, parseSessionTokenUsage, getTaskTokenUsage } from '../token-parser.js';
import type { ModelPricing } from '@claudia/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PRICING: ModelPricing = {
  inputPer1MTokens: 3.0,
  outputPer1MTokens: 15.0,
  cacheCreatePer1MTokens: 3.75,
  cacheReadPer1MTokens: 0.3,
};

function makeAssistant(opts: {
  uuid: string;
  model?: string;
  stopReason?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreation?: number;
  cacheRead?: number;
  costUSD?: number;
}) {
  return JSON.stringify({
    type: 'assistant',
    uuid: opts.uuid,
    message: {
      model: opts.model ?? 'claude-sonnet-4-6',
      role: 'assistant',
      stop_reason: opts.stopReason !== undefined ? opts.stopReason : 'end_turn',
      usage: {
        input_tokens: opts.inputTokens ?? 100,
        output_tokens: opts.outputTokens ?? 50,
        cache_creation_input_tokens: opts.cacheCreation ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
      },
    },
    ...(opts.costUSD !== undefined ? { costUSD: opts.costUSD } : {}),
  });
}

function makeToolResult(opts: { uuid: string; inputTokens?: number; outputTokens?: number }) {
  return JSON.stringify({
    type: 'user',
    uuid: opts.uuid,
    toolUseResult: {
      usage: {
        input_tokens: opts.inputTokens ?? 200,
        output_tokens: opts.outputTokens ?? 100,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// calculateCost
// ---------------------------------------------------------------------------

describe('calculateCost', () => {
  it('returns 0 when no pricing provided', () => {
    const result = calculateCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      undefined,
    );
    expect(result).toBe(0);
  });

  it('computes input token cost', () => {
    const result = calculateCost(
      { inputTokens: 1_000_000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      PRICING,
    );
    expect(result).toBeCloseTo(3.0);
  });

  it('computes output token cost', () => {
    const result = calculateCost(
      { inputTokens: 0, outputTokens: 1_000_000, cacheCreationTokens: 0, cacheReadTokens: 0 },
      PRICING,
    );
    expect(result).toBeCloseTo(15.0);
  });

  it('computes cache creation token cost', () => {
    const result = calculateCost(
      { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 1_000_000, cacheReadTokens: 0 },
      PRICING,
    );
    expect(result).toBeCloseTo(3.75);
  });

  it('computes cache read token cost', () => {
    const result = calculateCost(
      { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 1_000_000 },
      PRICING,
    );
    expect(result).toBeCloseTo(0.3);
  });

  it('sums all cost components', () => {
    const result = calculateCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreationTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
      },
      PRICING,
    );
    expect(result).toBeCloseTo(3.0 + 15.0 + 3.75 + 0.3);
  });

  it('handles zero tokens without NaN', () => {
    const result = calculateCost(
      { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      PRICING,
    );
    expect(result).toBe(0);
    expect(Number.isNaN(result)).toBe(false);
  });

  it('guards against NaN token inputs', () => {
    // NaN token counts should not propagate to cost
    const result = calculateCost(
      { inputTokens: NaN, outputTokens: NaN, cacheCreationTokens: NaN, cacheReadTokens: NaN },
      PRICING,
    );
    expect(Number.isNaN(result)).toBe(false);
    expect(result).toBe(0);
  });

  it('scales correctly for small token counts', () => {
    const result = calculateCost(
      { inputTokens: 1000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      PRICING,
    );
    expect(result).toBeCloseTo(0.003);
  });
});

// ---------------------------------------------------------------------------
// parseSessionTokenUsage
// ---------------------------------------------------------------------------

describe('parseSessionTokenUsage', () => {
  const testDir = join(tmpdir(), 'claudia-token-parser-test-' + Date.now());
  const testFile = join(testDir, 'session.jsonl');

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('returns null for non-existent file', async () => {
    const result = await parseSessionTokenUsage('/nonexistent/path.jsonl');
    expect(result).toBeNull();
  });

  it('returns zero totals for empty file', async () => {
    writeFileSync(testFile, '');
    const result = await parseSessionTokenUsage(testFile);
    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(0);
    expect(result!.outputTokens).toBe(0);
    expect(result!.totalCostUsd).toBe(0);
  });

  it('aggregates tokens from a single assistant entry', async () => {
    writeFileSync(
      testFile,
      makeAssistant({
        uuid: 'a1',
        inputTokens: 500,
        outputTokens: 200,
      }),
    );

    const result = await parseSessionTokenUsage(testFile);
    expect(result!.inputTokens).toBe(500);
    expect(result!.outputTokens).toBe(200);
  });

  it('deduplicates by UUID — only counts final entry with stop_reason', async () => {
    // Partial entry (no stop_reason) followed by final entry (with stop_reason)
    const partial = JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      message: {
        model: 'claude-sonnet-4-6',
        role: 'assistant',
        stop_reason: null, // partial — no stop_reason
        usage: { input_tokens: 9999, output_tokens: 9999 },
      },
    });
    const final = makeAssistant({ uuid: 'a1', inputTokens: 100, outputTokens: 50 });

    writeFileSync(testFile, [partial, final].join('\n'));
    const result = await parseSessionTokenUsage(testFile);

    // Should count only the final entry, not partial + final
    expect(result!.inputTokens).toBe(100);
    expect(result!.outputTokens).toBe(50);
  });

  it('skips assistant entries without stop_reason entirely', async () => {
    const partial = JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      message: {
        model: 'claude-sonnet-4-6',
        stop_reason: null,
        usage: { input_tokens: 999, output_tokens: 999 },
      },
    });
    writeFileSync(testFile, partial);

    const result = await parseSessionTokenUsage(testFile);
    expect(result!.inputTokens).toBe(0);
    expect(result!.outputTokens).toBe(0);
  });

  it('aggregates across multiple assistant turns', async () => {
    const lines = [
      makeAssistant({ uuid: 'a1', inputTokens: 100, outputTokens: 50 }),
      makeAssistant({ uuid: 'a2', inputTokens: 200, outputTokens: 80 }),
      makeAssistant({ uuid: 'a3', inputTokens: 300, outputTokens: 120 }),
    ].join('\n');

    writeFileSync(testFile, lines);
    const result = await parseSessionTokenUsage(testFile);

    expect(result!.inputTokens).toBe(600);
    expect(result!.outputTokens).toBe(250);
  });

  it('builds per-model breakdown', async () => {
    const lines = [
      makeAssistant({ uuid: 'a1', model: 'claude-sonnet-4-6', inputTokens: 100, outputTokens: 50 }),
      makeAssistant({ uuid: 'a2', model: 'claude-opus-4-6', inputTokens: 200, outputTokens: 80 }),
    ].join('\n');

    writeFileSync(testFile, lines);
    const result = await parseSessionTokenUsage(testFile);

    expect(result!.modelBreakdown['claude-sonnet-4-6']).toBeDefined();
    expect(result!.modelBreakdown['claude-sonnet-4-6'].inputTokens).toBe(100);
    expect(result!.modelBreakdown['claude-opus-4-6']).toBeDefined();
    expect(result!.modelBreakdown['claude-opus-4-6'].inputTokens).toBe(200);
  });

  it('accumulates same-model entries in breakdown', async () => {
    const lines = [
      makeAssistant({ uuid: 'a1', model: 'claude-sonnet-4-6', inputTokens: 100, outputTokens: 50 }),
      makeAssistant({ uuid: 'a2', model: 'claude-sonnet-4-6', inputTokens: 200, outputTokens: 80 }),
    ].join('\n');

    writeFileSync(testFile, lines);
    const result = await parseSessionTokenUsage(testFile);

    expect(result!.modelBreakdown['claude-sonnet-4-6'].inputTokens).toBe(300);
    expect(result!.modelBreakdown['claude-sonnet-4-6'].outputTokens).toBe(130);
  });

  it('aggregates cache tokens', async () => {
    writeFileSync(
      testFile,
      makeAssistant({
        uuid: 'a1',
        inputTokens: 100,
        outputTokens: 50,
        cacheCreation: 400,
        cacheRead: 800,
      }),
    );

    const result = await parseSessionTokenUsage(testFile);
    expect(result!.cacheCreationTokens).toBe(400);
    expect(result!.cacheReadTokens).toBe(800);
  });

  it('calculates cost when pricingMap provided', async () => {
    writeFileSync(
      testFile,
      makeAssistant({
        uuid: 'a1',
        model: 'claude-sonnet-4-6',
        inputTokens: 1_000_000,
        outputTokens: 0,
      }),
    );

    const pricingMap = { 'claude-sonnet-4-6': PRICING };
    const result = await parseSessionTokenUsage(testFile, pricingMap);

    expect(result!.totalCostUsd).toBeCloseTo(3.0);
    expect(result!.modelBreakdown['claude-sonnet-4-6'].costUsd).toBeCloseTo(3.0);
  });

  it('overrides any accumulated costUSD when pricingMap provided', async () => {
    // Entry has a costUSD field, but pricingMap should recalculate from tokens
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      costUSD: 99.99, // would be a large wrong value
      message: {
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    writeFileSync(testFile, line);

    const pricingMap = { 'claude-sonnet-4-6': PRICING };
    const result = await parseSessionTokenUsage(testFile, pricingMap);

    // pricingMap recalculates from 0 tokens → $0
    expect(result!.totalCostUsd).toBeCloseTo(0);
  });

  it('sets cost to 0 for unknown model when pricingMap provided', async () => {
    writeFileSync(
      testFile,
      makeAssistant({
        uuid: 'a1',
        model: 'some-unknown-model',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    );

    const pricingMap = { 'claude-sonnet-4-6': PRICING };
    const result = await parseSessionTokenUsage(testFile, pricingMap);

    expect(result!.totalCostUsd).toBe(0);
  });

  it('aggregates tool result (subagent) usage', async () => {
    const lines = [makeToolResult({ uuid: 'tr1', inputTokens: 500, outputTokens: 300 })].join('\n');

    writeFileSync(testFile, lines);
    const result = await parseSessionTokenUsage(testFile);

    expect(result!.inputTokens).toBe(500);
    expect(result!.outputTokens).toBe(300);
    expect(result!.modelBreakdown['subagent']).toBeDefined();
    expect(result!.modelBreakdown['subagent'].inputTokens).toBe(500);
  });

  it('deduplicates tool result entries by UUID', async () => {
    const lines = [
      makeToolResult({ uuid: 'tr1', inputTokens: 500, outputTokens: 300 }),
      makeToolResult({ uuid: 'tr1', inputTokens: 500, outputTokens: 300 }), // duplicate
    ].join('\n');

    writeFileSync(testFile, lines);
    const result = await parseSessionTokenUsage(testFile);

    // Should only count once
    expect(result!.inputTokens).toBe(500);
  });

  it('combines assistant and tool result tokens', async () => {
    const lines = [
      makeAssistant({ uuid: 'a1', inputTokens: 100, outputTokens: 50 }),
      makeToolResult({ uuid: 'tr1', inputTokens: 200, outputTokens: 80 }),
    ].join('\n');

    writeFileSync(testFile, lines);
    const result = await parseSessionTokenUsage(testFile);

    expect(result!.inputTokens).toBe(300);
    expect(result!.outputTokens).toBe(130);
  });

  it('skips malformed JSON lines without throwing', async () => {
    const lines = [
      'not valid json at all }{',
      makeAssistant({ uuid: 'a1', inputTokens: 100, outputTokens: 50 }),
      '{ "broken":',
    ].join('\n');

    writeFileSync(testFile, lines);
    const result = await parseSessionTokenUsage(testFile);

    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(100);
  });

  it('includes lastUpdated ISO timestamp', async () => {
    writeFileSync(testFile, makeAssistant({ uuid: 'a1' }));
    const result = await parseSessionTokenUsage(testFile);

    expect(result!.lastUpdated).toBeTruthy();
    expect(new Date(result!.lastUpdated).getTime()).not.toBeNaN();
  });

  it('does not produce NaN totals from valid entries', async () => {
    const lines = [
      makeAssistant({ uuid: 'a1', inputTokens: 100, outputTokens: 50 }),
      makeAssistant({ uuid: 'a2', inputTokens: 200, outputTokens: 80 }),
    ].join('\n');

    writeFileSync(testFile, lines);
    const result = await parseSessionTokenUsage(testFile, { 'claude-sonnet-4-6': PRICING });

    expect(Number.isNaN(result!.totalCostUsd)).toBe(false);
    expect(Number.isNaN(result!.inputTokens)).toBe(false);
    expect(Number.isNaN(result!.outputTokens)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getTaskTokenUsage — path resolution
// ---------------------------------------------------------------------------

describe('getTaskTokenUsage', () => {
  const testHome = join(tmpdir(), 'claudia-token-home-' + Date.now());
  const testWorkspace = '/test/my-workspace';
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = testHome;
    process.env.USERPROFILE = testHome;

    // Replicate Claude Code's path: ~/.claude/projects/<workspace-hash>/
    const folderName = testWorkspace.replace(/[^a-zA-Z0-9-]/g, '-');
    const projectDir = join(testHome, '.claude', 'projects', folderName);
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    rmSync(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('returns null for non-existent session', async () => {
    const result = await getTaskTokenUsage(testWorkspace, 'no-such-session');
    expect(result).toBeNull();
  });

  it('resolves workspace path to correct .claude/projects folder and parses it', async () => {
    const folderName = testWorkspace.replace(/[^a-zA-Z0-9-]/g, '-');
    const projectDir = join(testHome, '.claude', 'projects', folderName);
    const sessionId = 'test-session-abc';
    const sessionFile = join(projectDir, `${sessionId}.jsonl`);

    writeFileSync(sessionFile, makeAssistant({ uuid: 'a1', inputTokens: 123, outputTokens: 45 }));

    const result = await getTaskTokenUsage(testWorkspace, sessionId);
    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(123);
    expect(result!.outputTokens).toBe(45);
  });

  it('passes pricingMap through to parser', async () => {
    const folderName = testWorkspace.replace(/[^a-zA-Z0-9-]/g, '-');
    const projectDir = join(testHome, '.claude', 'projects', folderName);
    const sessionId = 'priced-session';
    const sessionFile = join(projectDir, `${sessionId}.jsonl`);

    writeFileSync(
      sessionFile,
      makeAssistant({
        uuid: 'a1',
        model: 'claude-sonnet-4-6',
        inputTokens: 1_000_000,
        outputTokens: 0,
      }),
    );

    const result = await getTaskTokenUsage(testWorkspace, sessionId, {
      'claude-sonnet-4-6': PRICING,
    });
    expect(result!.totalCostUsd).toBeCloseTo(3.0);
  });
});
