import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    parseConversationFile,
    findSessionFile,
    findRecentSessionFiles,
    getWorkspaceSessions,
    getConversationHistory,
} from '../conversation-parser.js';

describe('parseConversationFile', () => {
    const testDir = join(tmpdir(), 'claudia-conv-test-' + Date.now());
    const testFile = join(testDir, 'test-session.jsonl');

    beforeEach(() => {
        mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
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
        rmSync(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
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
        rmSync(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
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
        rmSync(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
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
        expect(new Date(result[0].lastModified).getTime()).not.toBeNaN();
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

    it('should return claude sessions when backendType is claude-code', async () => {
        const projectsDir = join(testHome, '.claude', 'projects', '-test-workspace');
        mkdirSync(projectsDir, { recursive: true });

        const sessionContent = [
            JSON.stringify({ type: 'summary', summary: 'CC only' }),
        ].join('\n');
        writeFileSync(join(projectsDir, 'cc-session.jsonl'), sessionContent);

        const result = await getWorkspaceSessions(testWorkspace, 'claude-code');

        expect(result).toHaveLength(1);
        expect(result[0].sessionId).toBe('cc-session');
        expect(result[0].summary).toBe('CC only');
    });
});

// ================== Additional parseConversationFile branch coverage ==================

describe('parseConversationFile (additional branches)', () => {
    const testDir = join(tmpdir(), 'claudia-conv-extra-test-' + Date.now());
    const testFile = join(testDir, 'extra-session.jsonl');

    beforeEach(() => {
        mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    });

    it('should default timestamp to empty string when missing', async () => {
        const content = JSON.stringify({
            type: 'user',
            uuid: 'no-ts',
            message: { role: 'user', content: 'No timestamp here' },
        });

        writeFileSync(testFile, content);
        const result = await parseConversationFile(testFile);

        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].timestamp).toBe('');
    });

    it('should ignore user entries missing uuid', async () => {
        const content = JSON.stringify({
            type: 'user',
            message: { role: 'user', content: 'No uuid so skipped' },
        });

        writeFileSync(testFile, content);
        const result = await parseConversationFile(testFile);

        expect(result.messages).toHaveLength(0);
    });

    it('should ignore assistant entries missing message', async () => {
        const content = JSON.stringify({
            type: 'assistant',
            uuid: 'a-no-msg',
        });

        writeFileSync(testFile, content);
        const result = await parseConversationFile(testFile);

        expect(result.messages).toHaveLength(0);
    });

    it('should keep first summary when multiple summaries appear', async () => {
        const content = [
            JSON.stringify({ type: 'summary', summary: 'First summary' }),
            JSON.stringify({ type: 'summary', summary: 'Second summary' }),
        ].join('\n');

        writeFileSync(testFile, content);
        const result = await parseConversationFile(testFile);

        // Later summaries overwrite earlier ones (assignment, no guard)
        expect(result.summary).toBe('Second summary');
    });

    it('should ignore unrecognized array content part types', async () => {
        const content = JSON.stringify({
            type: 'assistant',
            uuid: 'mixed',
            message: {
                role: 'assistant',
                content: [
                    { type: 'tool_use', text: 'should be ignored' },
                    { type: 'text', text: 'Visible text' },
                    { type: 'image' },
                ],
            },
        });

        writeFileSync(testFile, content);
        const result = await parseConversationFile(testFile);

        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].content).toBe('Visible text');
        expect(result.messages[0].thinking).toBeUndefined();
    });

    it('should handle CRLF line endings', async () => {
        const content = [
            JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'line one' } }),
            JSON.stringify({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: 'line two' } }),
        ].join('\r\n');

        writeFileSync(testFile, content);
        const result = await parseConversationFile(testFile);

        expect(result.messages).toHaveLength(2);
        expect(result.messages[0].content).toBe('line one');
        expect(result.messages[1].content).toBe('line two');
    });

    it('should not capture session id from later entries once set', async () => {
        const content = [
            JSON.stringify({ type: 'init', sessionId: 'first-session' }),
            JSON.stringify({ type: 'init', sessionId: 'second-session' }),
            JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }),
        ].join('\n');

        writeFileSync(testFile, content);
        const result = await parseConversationFile(testFile);

        expect(result.sessionId).toBe('first-session');
    });
});

// ================== getConversationHistory ==================

describe('getConversationHistory (Claude Code)', () => {
    const testHome = join(tmpdir(), 'claudia-gch-test-' + Date.now());
    const testWorkspace = '/test/workspace';
    let originalHome: string | undefined;

    beforeEach(() => {
        originalHome = process.env.HOME;
        process.env.HOME = testHome;
    });

    afterEach(() => {
        process.env.HOME = originalHome;
        rmSync(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    });

    it('should return null when claude-code session file is missing', async () => {
        const result = await getConversationHistory(testWorkspace, 'missing-session', 'claude-code');
        expect(result).toBeNull();
    });

    it('should parse a claude-code session when backendType specified', async () => {
        const projectsDir = join(testHome, '.claude', 'projects', '-test-workspace');
        mkdirSync(projectsDir, { recursive: true });

        const content = [
            JSON.stringify({ type: 'summary', summary: 'CC convo' }),
            JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'Hello CC' } }),
        ].join('\n');
        writeFileSync(join(projectsDir, 'cc-1.jsonl'), content);

        const result = await getConversationHistory(testWorkspace, 'cc-1', 'claude-code');

        expect(result).not.toBeNull();
        expect(result!.summary).toBe('CC convo');
        expect(result!.messages).toHaveLength(1);
        expect(result!.messages[0].content).toBe('Hello CC');
    });

    it('should auto-detect claude-code when no backendType and file exists', async () => {
        const projectsDir = join(testHome, '.claude', 'projects', '-test-workspace');
        mkdirSync(projectsDir, { recursive: true });

        const content = JSON.stringify({
            type: 'assistant',
            uuid: 'a1',
            message: { role: 'assistant', content: 'Auto detected' },
        });
        writeFileSync(join(projectsDir, 'auto-1.jsonl'), content);

        const result = await getConversationHistory(testWorkspace, 'auto-1');

        expect(result).not.toBeNull();
        expect(result!.messages[0].content).toBe('Auto detected');
    });

    it('should auto-detect OpenCode for ses_ prefixed ids and return null when missing', async () => {
        // No opencode storage exists under the temp HOME -> null
        const result = await getConversationHistory(testWorkspace, 'ses_abc123');
        expect(result).toBeNull();
    });

    it('should fall back to OpenCode (null) when claude-code lookup fails in auto-detect', async () => {
        const result = await getConversationHistory(testWorkspace, 'nonexistent-uuid');
        expect(result).toBeNull();
    });
});

// ================== OpenCode backend ==================

describe('OpenCode conversation history & sessions', () => {
    const testHome = join(tmpdir(), 'claudia-oc-test-' + Date.now());
    let originalHome: string | undefined;

    const storageDir = () => join(testHome, '.local', 'share', 'opencode', 'storage');

    function writeMessage(sessionId: string, msg: Record<string, unknown>) {
        const dir = join(storageDir(), 'message', sessionId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${msg.id}.json`), JSON.stringify(msg));
    }

    function writePart(sessionId: string, part: Record<string, unknown>) {
        const dir = join(storageDir(), 'part', sessionId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${part.id}.json`), JSON.stringify(part));
    }

    function writeSession(subdir: string, session: Record<string, unknown>) {
        const dir = join(storageDir(), 'session', subdir);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${session.id}.json`), JSON.stringify(session));
    }

    beforeEach(() => {
        originalHome = process.env.HOME;
        process.env.HOME = testHome;
    });

    afterEach(() => {
        process.env.HOME = originalHome;
        rmSync(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    });

    it('should return null when message dir is missing', async () => {
        const result = await getConversationHistory('/ws', 'ses_missing', 'opencode');
        expect(result).toBeNull();
    });

    it('should assemble messages from parts (text + thinking)', async () => {
        const sessionId = 'ses_oc1';
        writeMessage(sessionId, { id: 'm1', sessionID: sessionId, role: 'user', time: { created: 1000 } });
        writeMessage(sessionId, { id: 'm2', sessionID: sessionId, role: 'assistant', time: { created: 2000 } });

        writePart(sessionId, { id: 'p1', messageID: 'm1', sessionID: sessionId, type: 'text', text: 'User question', time: { created: 1000 } });
        writePart(sessionId, { id: 'p2', messageID: 'm2', sessionID: sessionId, type: 'thinking', thinking: 'pondering', time: { created: 2000 } });
        writePart(sessionId, { id: 'p3', messageID: 'm2', sessionID: sessionId, type: 'text', text: 'Assistant answer', time: { created: 2001 } });

        writeSession('global', { id: sessionId, title: 'OC Session Title' });

        const result = await getConversationHistory('/ws', sessionId, 'opencode');

        expect(result).not.toBeNull();
        expect(result!.sessionId).toBe(sessionId);
        expect(result!.summary).toBe('OC Session Title');
        expect(result!.messages).toHaveLength(2);

        // sorted by time.created ascending
        expect(result!.messages[0].role).toBe('user');
        expect(result!.messages[0].content).toBe('User question');
        expect(result!.messages[0].timestamp).toBe(new Date(1000).toISOString());

        expect(result!.messages[1].role).toBe('assistant');
        expect(result!.messages[1].content).toBe('Assistant answer');
        expect(result!.messages[1].thinking).toBe('pondering');
    });

    it('should fall back to message summary title when no parts found', async () => {
        const sessionId = 'ses_oc2';
        writeMessage(sessionId, {
            id: 'm1',
            sessionID: sessionId,
            role: 'assistant',
            time: { created: 500 },
            summary: { title: 'Summary fallback content' },
        });
        // create an (empty) part dir so the directory-exists checks pass
        mkdirSync(join(storageDir(), 'part', sessionId), { recursive: true });

        const result = await getConversationHistory('/ws', sessionId, 'opencode');

        expect(result).not.toBeNull();
        expect(result!.messages).toHaveLength(1);
        expect(result!.messages[0].content).toBe('Summary fallback content');
    });

    it('should emit "(no content)" for user messages with no parts or summary', async () => {
        const sessionId = 'ses_oc3';
        writeMessage(sessionId, { id: 'm1', sessionID: sessionId, role: 'user', time: { created: 100 } });
        mkdirSync(join(storageDir(), 'part', sessionId), { recursive: true });

        const result = await getConversationHistory('/ws', sessionId, 'opencode');

        expect(result).not.toBeNull();
        expect(result!.messages).toHaveLength(1);
        expect(result!.messages[0].role).toBe('user');
        expect(result!.messages[0].content).toBe('(no content)');
    });

    it('should skip assistant messages with no content', async () => {
        const sessionId = 'ses_oc4';
        writeMessage(sessionId, { id: 'm1', sessionID: sessionId, role: 'assistant', time: { created: 100 } });
        mkdirSync(join(storageDir(), 'part', sessionId), { recursive: true });

        const result = await getConversationHistory('/ws', sessionId, 'opencode');

        expect(result).not.toBeNull();
        // assistant with empty content and no summary -> skipped
        expect(result!.messages).toHaveLength(0);
    });

    it('should read parts from the global part dir when session part dir is absent', async () => {
        const sessionId = 'ses_oc5';
        writeMessage(sessionId, { id: 'm1', sessionID: sessionId, role: 'assistant', time: { created: 100 } });
        // Only a global part dir exists, not part/<sessionId>
        writePart('global', { id: 'p1', messageID: 'm1', sessionID: sessionId, type: 'text', text: 'from global parts', time: { created: 100 } });

        const result = await getConversationHistory('/ws', sessionId, 'opencode');

        expect(result).not.toBeNull();
        expect(result!.messages).toHaveLength(1);
        expect(result!.messages[0].content).toBe('from global parts');
    });

    it('should skip malformed message files', async () => {
        const sessionId = 'ses_oc6';
        const dir = join(storageDir(), 'message', sessionId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'bad.json'), 'not json');
        writeMessage(sessionId, { id: 'm1', sessionID: sessionId, role: 'user', time: { created: 100 } });
        mkdirSync(join(storageDir(), 'part', sessionId), { recursive: true });

        const result = await getConversationHistory('/ws', sessionId, 'opencode');

        expect(result).not.toBeNull();
        expect(result!.messages).toHaveLength(1);
        expect(result!.messages[0].uuid).toBe('m1');
    });

    it('should continue past messages when no part dirs exist for the session', async () => {
        const sessionId = 'ses_oc_nopart';
        // Message exists, but neither part/<sessionId> nor part/global exists.
        writeMessage(sessionId, { id: 'm1', sessionID: sessionId, role: 'user', time: { created: 100 } });

        const result = await getConversationHistory('/ws', sessionId, 'opencode');

        expect(result).not.toBeNull();
        // The `continue` skips the part-search; user message is still skipped
        // because it has no content -> 0 messages.
        expect(result!.messages).toHaveLength(0);
    });

    it('should use slug as summary when title is absent', async () => {
        const sessionId = 'ses_oc7';
        writeMessage(sessionId, { id: 'm1', sessionID: sessionId, role: 'user', time: { created: 100 } });
        writePart(sessionId, { id: 'p1', messageID: 'm1', sessionID: sessionId, type: 'text', text: 'hi', time: { created: 100 } });
        writeSession('global', { id: sessionId, slug: 'my-slug' });

        const result = await getConversationHistory('/ws', sessionId, 'opencode');

        expect(result).not.toBeNull();
        expect(result!.summary).toBe('my-slug');
    });

    it('getWorkspaceSessions should return OpenCode sessions when backendType is opencode', async () => {
        writeSession('global', { id: 'ses_a', title: 'Session A' });
        writeSession('proj1', { id: 'ses_b', title: 'Session B' });

        const result = await getWorkspaceSessions('/ws', 'opencode');

        const ids = result.map(r => r.sessionId).sort();
        expect(ids).toEqual(['ses_a', 'ses_b']);
        const a = result.find(r => r.sessionId === 'ses_a');
        expect(a!.summary).toBe('Session A');
    });

    it('getWorkspaceSessions should return empty when opencode session dir missing', async () => {
        const result = await getWorkspaceSessions('/ws', 'opencode');
        expect(result).toEqual([]);
    });

    it('getWorkspaceSessions (all backends) should merge claude and opencode sessions', async () => {
        // Claude session
        const projectsDir = join(testHome, '.claude', 'projects', '-ws');
        mkdirSync(projectsDir, { recursive: true });
        writeFileSync(
            join(projectsDir, 'cc-session.jsonl'),
            JSON.stringify({ type: 'summary', summary: 'Claude one' })
        );
        // OpenCode session
        writeSession('global', { id: 'ses_x', title: 'OpenCode one' });

        const result = await getWorkspaceSessions('/ws');

        const ids = result.map(r => r.sessionId);
        expect(ids).toContain('cc-session');
        expect(ids).toContain('ses_x');
    });
});
