import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    parseConversationFile,
    findSessionFile,
    findRecentSessionFiles,
    getWorkspaceSessions,
} from '../conversation-parser.js';

describe('parseConversationFile', () => {
    const testDir = join(tmpdir(), 'claudia-conv-test-' + Date.now());
    const testFile = join(testDir, 'test-session.jsonl');

    beforeEach(() => {
        mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

    it('should parse user messages', async () => {
        const content = [
            JSON.stringify({
                type: 'user',
                uuid: 'user-1',
                timestamp: '2024-01-01T00:00:00Z',
                message: { role: 'user', content: 'Hello Claude' }
            }),
        ].join('\n');

        writeFileSync(testFile, content);
        const result = await parseConversationFile(testFile);

        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].role).toBe('user');
        expect(result.messages[0].content).toBe('Hello Claude');
        expect(result.messages[0].uuid).toBe('user-1');
    });

    it('should parse assistant messages', async () => {
        const content = [
            JSON.stringify({
                type: 'assistant',
                uuid: 'assistant-1',
                timestamp: '2024-01-01T00:00:01Z',
                message: { role: 'assistant', content: 'Hello! How can I help?' }
            }),
        ].join('\n');

        writeFileSync(testFile, content);
        const result = await parseConversationFile(testFile);

        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].role).toBe('assistant');
        expect(result.messages[0].content).toBe('Hello! How can I help?');
    });

    it('should parse message content with array format', async () => {
        const content = [
            JSON.stringify({
                type: 'assistant',
                uuid: 'assistant-1',
                timestamp: '2024-01-01T00:00:00Z',
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'First part. ' },
                        { type: 'text', text: 'Second part.' }
                    ]
                }
            }),
        ].join('\n');

        writeFileSync(testFile, content);
        const result = await parseConversationFile(testFile);

        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].content).toBe('First part. Second part.');
    });

    it('should extract thinking blocks', async () => {
        const content = [
            JSON.stringify({
                type: 'assistant',
                uuid: 'assistant-1',
                timestamp: '2024-01-01T00:00:00Z',
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'thinking', thinking: 'Let me think about this...' },
                        { type: 'text', text: 'Here is my answer.' }
                    ]
                }
            }),
        ].join('\n');

        writeFileSync(testFile, content);
        const result = await parseConversationFile(testFile);

        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].content).toBe('Here is my answer.');
        expect(result.messages[0].thinking).toBe('Let me think about this...');
    });

    it('should capture session ID', async () => {
        const content = [
            JSON.stringify({
                type: 'init',
                sessionId: 'my-session-123',
            }),
            JSON.stringify({
                type: 'user',
                uuid: 'user-1',
                message: { role: 'user', content: 'Hello' }
            }),
        ].join('\n');

        writeFileSync(testFile, content);
        const result = await parseConversationFile(testFile);

        expect(result.sessionId).toBe('my-session-123');
    });

    it('should capture summary', async () => {
        const content = [
            JSON.stringify({
                type: 'summary',
                summary: 'A conversation about testing',
            }),
            JSON.stringify({
                type: 'user',
                uuid: 'user-1',
                message: { role: 'user', content: 'Hello' }
            }),
        ].join('\n');

        writeFileSync(testFile, content);
        const result = await parseConversationFile(testFile);

        expect(result.summary).toBe('A conversation about testing');
    });

    it('should skip duplicate UUIDs', async () => {
        const content = [
            JSON.stringify({
                type: 'user',
                uuid: 'user-1',
                message: { role: 'user', content: 'Hello' }
            }),
            JSON.stringify({
                type: 'user',
                uuid: 'user-1',
                message: { role: 'user', content: 'Hello duplicate' }
            }),
        ].join('\n');

        writeFileSync(testFile, content);
        const result = await parseConversationFile(testFile);

        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].content).toBe('Hello');
    });

    it('should skip malformed JSON lines', async () => {
        const content = [
            'not valid json',
            JSON.stringify({
                type: 'user',
                uuid: 'user-1',
                message: { role: 'user', content: 'Valid message' }
            }),
            '{ broken json',
        ].join('\n');

        writeFileSync(testFile, content);
        const result = await parseConversationFile(testFile);

        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].content).toBe('Valid message');
    });

    it('should use filename as session ID if not in content', async () => {
        const specificFile = join(testDir, 'my-custom-id.jsonl');
        const content = [
            JSON.stringify({
                type: 'user',
                uuid: 'user-1',
                message: { role: 'user', content: 'Hello' }
            }),
        ].join('\n');

        writeFileSync(specificFile, content);
        const result = await parseConversationFile(specificFile);

        expect(result.sessionId).toBe('my-custom-id');
    });

    it('should skip messages without text content', async () => {
        const content = [
            JSON.stringify({
                type: 'assistant',
                uuid: 'assistant-1',
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'thinking', thinking: 'Only thinking, no text' }
                    ]
                }
            }),
        ].join('\n');

        writeFileSync(testFile, content);
        const result = await parseConversationFile(testFile);

        expect(result.messages).toHaveLength(0);
    });

    it('should handle empty file', async () => {
        writeFileSync(testFile, '');
        const result = await parseConversationFile(testFile);

        expect(result.messages).toHaveLength(0);
        expect(result.sessionId).toBe('test-session');
    });

    it('should parse full conversation', async () => {
        const content = [
            JSON.stringify({
                type: 'summary',
                summary: 'Help with coding',
            }),
            JSON.stringify({
                type: 'user',
                uuid: 'user-1',
                timestamp: '2024-01-01T10:00:00Z',
                message: { role: 'user', content: 'Can you help me?' }
            }),
            JSON.stringify({
                type: 'assistant',
                uuid: 'assistant-1',
                timestamp: '2024-01-01T10:00:01Z',
                message: { role: 'assistant', content: 'Of course! What do you need?' }
            }),
            JSON.stringify({
                type: 'user',
                uuid: 'user-2',
                timestamp: '2024-01-01T10:00:02Z',
                message: { role: 'user', content: 'Write a function' }
            }),
            JSON.stringify({
                type: 'assistant',
                uuid: 'assistant-2',
                timestamp: '2024-01-01T10:00:03Z',
                message: { role: 'assistant', content: 'Here you go!' }
            }),
        ].join('\n');

        writeFileSync(testFile, content);
        const result = await parseConversationFile(testFile);

        expect(result.summary).toBe('Help with coding');
        expect(result.messages).toHaveLength(4);
        expect(result.messages[0].role).toBe('user');
        expect(result.messages[1].role).toBe('assistant');
        expect(result.messages[2].role).toBe('user');
        expect(result.messages[3].role).toBe('assistant');
    });
});

describe('findSessionFile', () => {
    const testHome = join(tmpdir(), 'claudia-home-test-' + Date.now());
    const testWorkspace = '/test/workspace';
    let originalHome: string | undefined;

    beforeEach(() => {
        originalHome = process.env.HOME;
        process.env.HOME = testHome;

        // Create Claude projects directory structure
        const projectsDir = join(testHome, '.claude', 'projects', '-test-workspace');
        mkdirSync(projectsDir, { recursive: true });
    });

    afterEach(() => {
        process.env.HOME = originalHome;
        rmSync(testHome, { recursive: true, force: true });
    });

    it('should find existing session file', async () => {
        const projectsDir = join(testHome, '.claude', 'projects', '-test-workspace');
        const sessionFile = join(projectsDir, 'test-session-123.jsonl');
        writeFileSync(sessionFile, '{}');

        const result = await findSessionFile(testWorkspace, 'test-session-123');
        expect(result).toBe(sessionFile);
    });

    it('should return null for non-existent session', async () => {
        const result = await findSessionFile(testWorkspace, 'non-existent');
        expect(result).toBeNull();
    });
});

describe('findRecentSessionFiles', () => {
    const testHome = join(tmpdir(), 'claudia-recent-test-' + Date.now());
    const testWorkspace = '/test/workspace';
    let originalHome: string | undefined;

    beforeEach(() => {
        originalHome = process.env.HOME;
        process.env.HOME = testHome;
    });

    afterEach(() => {
        process.env.HOME = originalHome;
        rmSync(testHome, { recursive: true, force: true });
    });

    it('should return empty array for non-existent projects dir', async () => {
        const result = await findRecentSessionFiles(testWorkspace);
        expect(result).toEqual([]);
    });

    it('should return session files sorted by modification time', async () => {
        const projectsDir = join(testHome, '.claude', 'projects', '-test-workspace');
        mkdirSync(projectsDir, { recursive: true });

        // Create files with different mtimes
        const file1 = join(projectsDir, 'session1.jsonl');
        const file2 = join(projectsDir, 'session2.jsonl');

        writeFileSync(file1, '{}');
        // Small delay to ensure different mtime
        await new Promise(resolve => setTimeout(resolve, 10));
        writeFileSync(file2, '{}');

        const result = await findRecentSessionFiles(testWorkspace, 10);

        expect(result).toHaveLength(2);
        // Most recent should be first
        expect(result[0]).toContain('session2.jsonl');
    });

    it('should respect limit parameter', async () => {
        const projectsDir = join(testHome, '.claude', 'projects', '-test-workspace');
        mkdirSync(projectsDir, { recursive: true });

        for (let i = 0; i < 5; i++) {
            writeFileSync(join(projectsDir, `session${i}.jsonl`), '{}');
        }

        const result = await findRecentSessionFiles(testWorkspace, 2);
        expect(result).toHaveLength(2);
    });

    it('should only return .jsonl files', async () => {
        const projectsDir = join(testHome, '.claude', 'projects', '-test-workspace');
        mkdirSync(projectsDir, { recursive: true });

        writeFileSync(join(projectsDir, 'session.jsonl'), '{}');
        writeFileSync(join(projectsDir, 'other.txt'), 'not jsonl');
        writeFileSync(join(projectsDir, 'config.json'), '{}');

        const result = await findRecentSessionFiles(testWorkspace, 10);
        expect(result).toHaveLength(1);
        expect(result[0]).toContain('.jsonl');
    });
});

describe('getWorkspaceSessions', () => {
    const testHome = join(tmpdir(), 'claudia-sessions-test-' + Date.now());
    const testWorkspace = '/test/workspace';
    let originalHome: string | undefined;

    beforeEach(() => {
        originalHome = process.env.HOME;
        process.env.HOME = testHome;
    });

    afterEach(() => {
        process.env.HOME = originalHome;
        rmSync(testHome, { recursive: true, force: true });
    });

    it('should return empty array for non-existent projects dir', async () => {
        const result = await getWorkspaceSessions(testWorkspace);
        expect(result).toEqual([]);
    });

    it('should return session info with summaries', async () => {
        const projectsDir = join(testHome, '.claude', 'projects', '-test-workspace');
        mkdirSync(projectsDir, { recursive: true });

        const sessionContent = [
            JSON.stringify({ type: 'summary', summary: 'Test conversation' }),
            JSON.stringify({ type: 'user', uuid: '1', message: { content: 'hello' } }),
        ].join('\n');

        writeFileSync(join(projectsDir, 'test-session.jsonl'), sessionContent);

        const result = await getWorkspaceSessions(testWorkspace);

        expect(result).toHaveLength(1);
        expect(result[0].sessionId).toBe('test-session');
        expect(result[0].summary).toBe('Test conversation');
        expect(result[0].lastModified).toBeInstanceOf(Date);
    });

    it('should handle sessions without summaries', async () => {
        const projectsDir = join(testHome, '.claude', 'projects', '-test-workspace');
        mkdirSync(projectsDir, { recursive: true });

        const sessionContent = [
            JSON.stringify({ type: 'user', uuid: '1', message: { content: 'hello' } }),
        ].join('\n');

        writeFileSync(join(projectsDir, 'no-summary-session.jsonl'), sessionContent);

        const result = await getWorkspaceSessions(testWorkspace);

        expect(result).toHaveLength(1);
        expect(result[0].sessionId).toBe('no-summary-session');
        expect(result[0].summary).toBeUndefined();
    });
});
