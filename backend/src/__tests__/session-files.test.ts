/**
 * Session-file location seam.
 *
 * Where a runtime keeps its session transcripts is runtime-specific knowledge
 * that used to be duplicated across four modules. It now lives behind
 * `CodeBackend.sessionDir()` / `CodeBackend.sessionFiles()`, with pure helpers
 * exported for standalone modules (token-parser, conversation-parser) that have
 * no backend instance to reach for.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import {
    ClaudeCodeBackend,
    claudeSessionDir,
    claudeSessionFiles,
} from '../backends/claude-code-backend.js';
import { OpenCodeBackend } from '../backends/opencode-backend.js';

const home = () => process.env.HOME || process.env.USERPROFILE || '';

describe('claudeSessionDir', () => {
    it('mangles every non-alphanumeric character (except dashes) into a dash', () => {
        expect(claudeSessionDir('/Users/x/Work/my repo')).toBe(
            join(home(), '.claude', 'projects', '-Users-x-Work-my-repo')
        );
    });

    it('preserves existing dashes and digits', () => {
        expect(claudeSessionDir('/Users/x/proj-2/sub')).toBe(
            join(home(), '.claude', 'projects', '-Users-x-proj-2-sub')
        );
    });

    it('mangles dots, underscores and other punctuation', () => {
        expect(claudeSessionDir('/a/b.c_d/e@f')).toBe(
            join(home(), '.claude', 'projects', '-a-b-c-d-e-f')
        );
    });

    it('mangles Windows-style separators and drive colons', () => {
        expect(claudeSessionDir('C:\\Users\\x\\repo')).toBe(
            join(home(), '.claude', 'projects', 'C--Users-x-repo')
        );
    });
});

describe('claudeSessionFiles', () => {
    it('returns the single <sessionId>.jsonl inside the session dir', () => {
        const ws = '/Users/x/Work/my repo';
        expect(claudeSessionFiles(ws, 'abc-123')).toEqual([
            join(claudeSessionDir(ws), 'abc-123.jsonl'),
        ]);
    });

    it('returns [] when no session id is given', () => {
        expect(claudeSessionFiles('/Users/x/Work/my repo', '')).toEqual([]);
    });
});

describe('ClaudeCodeBackend session-file seam', () => {
    const backend = new ClaudeCodeBackend();

    it('sessionDir matches the standalone helper', () => {
        const ws = '/Users/x/Work/my repo';
        expect(backend.sessionDir(ws)).toBe(claudeSessionDir(ws));
    });

    it('sessionFiles matches the standalone helper', () => {
        const ws = '/Users/x/Work/my repo';
        expect(backend.sessionFiles(ws, 'sess-1')).toEqual(claudeSessionFiles(ws, 'sess-1'));
    });
});

describe('OpenCodeBackend session-file seam', () => {
    const backend = new OpenCodeBackend();

    it('has no on-disk session dir (sessions are server-side)', () => {
        expect(backend.sessionDir('/Users/x/Work/my repo')).toBeNull();
    });

    it('exposes no session files', () => {
        expect(backend.sessionFiles('/Users/x/Work/my repo', 'ses_abc')).toEqual([]);
    });
});
