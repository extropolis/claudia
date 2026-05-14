import { describe, it, expect } from 'vitest';
import { buildClaudeCodeSwitchArgs } from '../task-spawner.js';
import type { ClaudeCodeSwitches } from '../config-store.js';

const BASE: ClaudeCodeSwitches = {
  verbose: false,
  maxTurns: null,
  maxBudgetUsd: null,
  permissionMode: null,
  allowedTools: '',
  disallowedTools: '',
  appendSystemPrompt: '',
  effortLevel: 'high',
  defaultModel: '',
};

describe('buildClaudeCodeSwitchArgs', () => {
  it('returns empty array for all-default switches', () => {
    expect(buildClaudeCodeSwitchArgs(BASE)).toEqual([]);
  });

  describe('--verbose', () => {
    it('adds --verbose when true', () => {
      const args = buildClaudeCodeSwitchArgs({ ...BASE, verbose: true });
      expect(args).toContain('--verbose');
    });

    it('omits --verbose when false', () => {
      const args = buildClaudeCodeSwitchArgs({ ...BASE, verbose: false });
      expect(args).not.toContain('--verbose');
    });
  });

  describe('--max-turns', () => {
    it('adds --max-turns with value when set', () => {
      const args = buildClaudeCodeSwitchArgs({ ...BASE, maxTurns: 10 });
      expect(args).toContain('--max-turns');
      expect(args[args.indexOf('--max-turns') + 1]).toBe('10');
    });

    it('omits --max-turns when null', () => {
      const args = buildClaudeCodeSwitchArgs({ ...BASE, maxTurns: null });
      expect(args).not.toContain('--max-turns');
    });

    it('omits --max-turns when 0', () => {
      const args = buildClaudeCodeSwitchArgs({ ...BASE, maxTurns: 0 });
      expect(args).not.toContain('--max-turns');
    });

    it('omits --max-turns when negative', () => {
      const args = buildClaudeCodeSwitchArgs({ ...BASE, maxTurns: -5 });
      expect(args).not.toContain('--max-turns');
    });
  });

  describe('--max-budget-usd', () => {
    it('adds --max-budget-usd with value when set', () => {
      const args = buildClaudeCodeSwitchArgs({ ...BASE, maxBudgetUsd: 5.5 });
      expect(args).toContain('--max-budget-usd');
      expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('5.5');
    });

    it('omits --max-budget-usd when null', () => {
      const args = buildClaudeCodeSwitchArgs({ ...BASE, maxBudgetUsd: null });
      expect(args).not.toContain('--max-budget-usd');
    });

    it('omits --max-budget-usd when 0', () => {
      const args = buildClaudeCodeSwitchArgs({ ...BASE, maxBudgetUsd: 0 });
      expect(args).not.toContain('--max-budget-usd');
    });
  });

  describe('--permission-mode', () => {
    it('adds --permission-mode for known mode', () => {
      const args = buildClaudeCodeSwitchArgs({ ...BASE, permissionMode: 'auto' });
      expect(args).toContain('--permission-mode');
    });

    it('omits --permission-mode when null', () => {
      const args = buildClaudeCodeSwitchArgs({ ...BASE, permissionMode: null });
      expect(args).not.toContain('--permission-mode');
    });

    it('omits --permission-mode for empty string', () => {
      const args = buildClaudeCodeSwitchArgs({ ...BASE, permissionMode: '' });
      expect(args).not.toContain('--permission-mode');
    });
  });

  describe('--allowedTools', () => {
    it('adds --allowedTools when set', () => {
      const args = buildClaudeCodeSwitchArgs({ ...BASE, allowedTools: 'Bash,Write' });
      expect(args).toContain('--allowedTools');
      expect(args[args.indexOf('--allowedTools') + 1]).toBe('Bash,Write');
    });

    it('omits --allowedTools when empty string', () => {
      const args = buildClaudeCodeSwitchArgs({ ...BASE, allowedTools: '' });
      expect(args).not.toContain('--allowedTools');
    });

    it('omits --allowedTools for whitespace-only string', () => {
      const args = buildClaudeCodeSwitchArgs({ ...BASE, allowedTools: '   ' });
      expect(args).not.toContain('--allowedTools');
    });

    it('trims whitespace from allowedTools value', () => {
      const args = buildClaudeCodeSwitchArgs({ ...BASE, allowedTools: '  Bash  ' });
      const idx = args.indexOf('--allowedTools');
      expect(args[idx + 1]).toBe('Bash');
    });
  });

  describe('--disallowedTools', () => {
    it('adds --disallowedTools when set', () => {
      const args = buildClaudeCodeSwitchArgs({ ...BASE, disallowedTools: 'Write' });
      expect(args).toContain('--disallowedTools');
      expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Write');
    });

    it('omits --disallowedTools when empty', () => {
      const args = buildClaudeCodeSwitchArgs({ ...BASE, disallowedTools: '' });
      expect(args).not.toContain('--disallowedTools');
    });
  });

  describe('--append-system-prompt', () => {
    it('adds --append-system-prompt when set', () => {
      const args = buildClaudeCodeSwitchArgs({ ...BASE, appendSystemPrompt: 'Be concise.' });
      expect(args).toContain('--append-system-prompt');
      expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('Be concise.');
    });

    it('omits --append-system-prompt when empty', () => {
      const args = buildClaudeCodeSwitchArgs({ ...BASE, appendSystemPrompt: '' });
      expect(args).not.toContain('--append-system-prompt');
    });

    it('omits --append-system-prompt for whitespace-only', () => {
      const args = buildClaudeCodeSwitchArgs({ ...BASE, appendSystemPrompt: '   ' });
      expect(args).not.toContain('--append-system-prompt');
    });
  });

  describe('--model (defaultModel)', () => {
    it('adds --model when defaultModel is set', () => {
      const args = buildClaudeCodeSwitchArgs({ ...BASE, defaultModel: 'claude-opus-latest' });
      expect(args).toContain('--model');
      expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-latest');
    });

    it('omits --model when defaultModel is empty string', () => {
      const args = buildClaudeCodeSwitchArgs({ ...BASE, defaultModel: '' });
      expect(args).not.toContain('--model');
    });

    it('omits --model for whitespace-only defaultModel', () => {
      const args = buildClaudeCodeSwitchArgs({ ...BASE, defaultModel: '   ' });
      expect(args).not.toContain('--model');
    });

    it('trims whitespace from defaultModel', () => {
      const args = buildClaudeCodeSwitchArgs({ ...BASE, defaultModel: '  claude-sonnet-4-6  ' });
      const idx = args.indexOf('--model');
      expect(args[idx + 1]).toBe('claude-sonnet-4-6');
    });

    it('passes custom model IDs through unchanged', () => {
      // Custom model IDs like Claude-Opus-4.6[1m] used on Vertex/SAP AI Core
      const customModel = 'Claude-Opus-4.6[1m]';
      const args = buildClaudeCodeSwitchArgs({ ...BASE, defaultModel: customModel });
      expect(args[args.indexOf('--model') + 1]).toBe(customModel);
    });
  });

  describe('argument order and combinations', () => {
    it('produces correct arg pairs for multiple flags', () => {
      const args = buildClaudeCodeSwitchArgs({
        ...BASE,
        verbose: true,
        maxTurns: 5,
        defaultModel: 'claude-sonnet-4-6',
      });

      expect(args).toContain('--verbose');
      expect(args).toContain('--max-turns');
      expect(args).toContain('--model');

      // Values must follow their flags
      expect(args[args.indexOf('--max-turns') + 1]).toBe('5');
      expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-4-6');
    });

    it('does not add any flag for all-null/empty switches', () => {
      const args = buildClaudeCodeSwitchArgs({
        verbose: false,
        maxTurns: null,
        maxBudgetUsd: null,
        permissionMode: null,
        allowedTools: '',
        disallowedTools: '',
        appendSystemPrompt: '',
        effortLevel: 'high',
        defaultModel: '',
      });
      expect(args).toHaveLength(0);
    });
  });
});
