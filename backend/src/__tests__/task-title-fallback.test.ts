import { describe, it, expect } from 'vitest';
import { isGenericTitleCandidate, deriveTaskTitle, searchHistoryBlob } from '../task-spawner.js';

describe('isGenericTitleCandidate', () => {
    it('rejects the openers that made tasks unfindable', () => {
        // Real cases pulled from tasks that ended up untitled in the sidebar.
        for (const text of ['checkout head of main.', 'hi', 'continue', 'k']) {
            expect(isGenericTitleCandidate(text), text).toBe(true);
        }
    });

    it('rejects short text and slash commands', () => {
        expect(isGenericTitleCandidate('fix')).toBe(true);
        expect(isGenericTitleCandidate('/clear')).toBe(true);
        expect(isGenericTitleCandidate('   ')).toBe(true);
        expect(isGenericTitleCandidate('12345678901234')).toBe(true); // no letters
    });

    it('accepts text that actually describes work', () => {
        for (const text of [
            'analyze the following security vulnerability in shell_tools',
            'Perform a detailed code review of GitHub PR #2568',
            'scope a Jira integration for enterprise',
        ]) {
            expect(isGenericTitleCandidate(text), text).toBe(false);
        }
    });
});

describe('deriveTaskTitle', () => {
    it('titles the message that should have named the lost task', () => {
        const title = deriveTaskTitle(
            'analyze the following security vulnerability: C:\\Users\\kovtchar\\Downloads\\AMD_GAIA_ShellTools_FindExec_CWE184.pdf'
        );
        expect(title).toBe('analyze the following security vulnerability');
    });

    it('strips injected context blocks so they never become the title', () => {
        const title = deriveTaskTitle(
            '[CONTEXT UPDATE: You can update your task title using claudia_rename_task. Call it with displayName] review the auth middleware for bugs'
        );
        expect(title).not.toMatch(/CONTEXT UPDATE/i);
        expect(title).toContain('review the auth middleware');
    });

    it('strips urls, ansi and markdown noise', () => {
        expect(deriveTaskTitle('check **this** https://github.com/amd/gaia/pull/2568 rendering issue'))
            .toBe('check this rendering issue');
        expect(deriveTaskTitle('\x1b[31manalyze the crash in the parser\x1b[0m'))
            .toBe('analyze the crash in the parser');
    });

    it('truncates on a word boundary without trailing punctuation', () => {
        const title = deriveTaskTitle(
            'investigate why the websocket reconnection logic drops queued messages during suspend'
        );
        expect(title.length).toBeLessThanOrEqual(52);
        expect(title).not.toMatch(/\s$/);
        expect(title).not.toMatch(/[,;:.-]$/);
        // must not cut mid-word
        expect('investigate why the websocket reconnection logic drops queued messages during suspend')
            .toContain(title);
    });

    it('returns empty when nothing meaningful survives', () => {
        expect(deriveTaskTitle('   ')).toBe('');
        expect(deriveTaskTitle('https://example.com')).toBe('');
        expect(deriveTaskTitle('C:\\Users\\kovtchar\\Downloads\\thing.pdf')).toBe('');
    });
});

describe('searchHistoryBlob', () => {
    it('finds text inside base64-encoded history', () => {
        // Archived histories are stored base64, so a raw substring scan finds nothing.
        const plain = 'user: please triage the CWE-184 sandbox bypass before the release';
        const blob = Buffer.from(plain, 'utf-8').toString('base64');

        expect(blob.toLowerCase().includes('cwe-184')).toBe(false); // precondition
        const snippet = searchHistoryBlob(blob, 'cwe-184');
        expect(snippet).toBeDefined();
        expect(snippet!.toLowerCase()).toContain('cwe-184');
    });

    it('still searches plain-text history', () => {
        const snippet = searchHistoryBlob('nothing here but a security advisory line', 'security advisory');
        expect(snippet).toContain('security advisory');
    });

    it('strips ansi so escape codes cannot hide a match', () => {
        const plain = 'the \x1b[31mSWSPLAT-42455\x1b[0m ticket';
        const blob = Buffer.from(plain, 'utf-8').toString('base64');
        expect(searchHistoryBlob(blob, 'swsplat-42455')).toBeDefined();
    });

    it('returns undefined when absent', () => {
        const blob = Buffer.from('completely unrelated output', 'utf-8').toString('base64');
        expect(searchHistoryBlob(blob, 'cwe-184')).toBeUndefined();
    });
});
