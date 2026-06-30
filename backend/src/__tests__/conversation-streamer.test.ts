/**
 * Streamer tests — drive the fs.watch tail loop by mutating a temp JSONL
 * file and asserting the right events are emitted in the right order.
 *
 * NB: vitest's default `vmThreads` pool doesn't reliably deliver fs.watch
 * callbacks (the worker isolate is torn down before the kernel event makes
 * it back to JS land). We trigger `tail()` manually after each file mutation
 * via the test-only `tickForTesting()` helper to keep these tests
 * deterministic. Production uses fs.watch as designed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConversationStreamer } from '../conversation-streamer.js';
import type { ConversationEvent } from '@claudia/shared';

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

describe('ConversationStreamer', () => {
  const testHome = join(tmpdir(), 'claudia-streamer-test-' + Date.now());
  const workspaceId = '/test/workspace';
  const sessionId = 'streamer-session';
  // Folder rule mirrors conversation-parser.ts: non-alphanumeric → '-'.
  const folder = workspaceId.replace(/[^a-zA-Z0-9-]/g, '-');
  const sessionDir = join(testHome, '.claude', 'projects', folder);
  const sessionFile = join(sessionDir, `${sessionId}.jsonl`);
  let originalHome: string | undefined;
  let streamer: ConversationStreamer | null = null;

  beforeEach(() => {
    originalHome = process.env.HOME;
    process.env.HOME = testHome;
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    streamer?.dispose();
    streamer = null;
    process.env.HOME = originalHome;
    rmSync(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('backfills existing events on attach', async () => {
    writeFileSync(
      sessionFile,
      jsonl([
        {
          type: 'assistant',
          uuid: 'a1',
          sessionId,
          timestamp: '2024-01-01T00:00:00Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        },
        {
          type: 'assistant',
          uuid: 'a2',
          sessionId,
          timestamp: '2024-01-01T00:00:01Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'x' } },
            ],
          },
        },
      ]),
    );

    const events: ConversationEvent[] = [];
    streamer = new ConversationStreamer({
      taskId: 't1',
      onEvent: (e) => events.push(e),
    });
    await streamer.attach(workspaceId, sessionId);

    expect(events.map((e) => e.type)).toEqual(['assistant_message', 'tool_call']);
    expect(events[0].text).toBe('hello');
    expect(events[1].tool?.name).toBe('Read');
    expect(streamer.getSnapshot()).toHaveLength(2);
  });

  it('emits new events appended after attach', async () => {
    // Start with one assistant message on disk.
    writeFileSync(
      sessionFile,
      jsonl([
        {
          type: 'assistant',
          uuid: 'a1',
          sessionId,
          timestamp: '2024-01-01T00:00:00Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        },
      ]),
    );

    const events: ConversationEvent[] = [];
    streamer = new ConversationStreamer({
      taskId: 't1',
      onEvent: (e) => events.push(e),
    });
    await streamer.attach(workspaceId, sessionId);
    expect(events).toHaveLength(1);

    // Append a new turn.
    appendFileSync(
      sessionFile,
      jsonl([
        {
          type: 'user',
          uuid: 'u1',
          sessionId,
          timestamp: '2024-01-01T00:00:01Z',
          message: { role: 'user', content: 'go' },
        },
      ]),
    );

    streamer.tickForTesting();
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe('user_message');
    expect(events[1].text).toBe('go');
  });

  it('skips backfill when emitExisting=false but tails new appends', async () => {
    writeFileSync(
      sessionFile,
      jsonl([
        {
          type: 'assistant',
          uuid: 'a1',
          sessionId,
          timestamp: '2024-01-01T00:00:00Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'old' }] },
        },
      ]),
    );

    const events: ConversationEvent[] = [];
    streamer = new ConversationStreamer({
      taskId: 't1',
      onEvent: (e) => events.push(e),
      emitExisting: false,
    });
    await streamer.attach(workspaceId, sessionId);
    expect(events).toHaveLength(0);

    appendFileSync(
      sessionFile,
      jsonl([
        {
          type: 'assistant',
          uuid: 'a2',
          sessionId,
          timestamp: '2024-01-01T00:00:01Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'new' }] },
        },
      ]),
    );

    streamer.tickForTesting();
    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('new');
  });

  it('dedupes by uuid across tail re-reads', async () => {
    writeFileSync(
      sessionFile,
      jsonl([
        {
          type: 'user',
          uuid: 'u1',
          sessionId,
          timestamp: '2024-01-01T00:00:00Z',
          message: { role: 'user', content: 'hi' },
        },
      ]),
    );

    const events: ConversationEvent[] = [];
    streamer = new ConversationStreamer({
      taskId: 't1',
      onEvent: (e) => events.push(e),
    });
    await streamer.attach(workspaceId, sessionId);
    expect(events).toHaveLength(1);

    // Append a fresh entry — should appear once.
    appendFileSync(
      sessionFile,
      jsonl([
        {
          type: 'assistant',
          uuid: 'a1',
          sessionId,
          timestamp: '2024-01-01T00:00:01Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'ack' }] },
        },
      ]),
    );

    streamer.tickForTesting();
    expect(events).toHaveLength(2);

    // Second tick on unchanged file should be a no-op.
    streamer.tickForTesting();
    expect(events).toHaveLength(2);
  });

  it('reattaching to a new sessionId resets tail state', async () => {
    writeFileSync(
      sessionFile,
      jsonl([
        {
          type: 'user',
          uuid: 'u1',
          sessionId,
          timestamp: '2024-01-01T00:00:00Z',
          message: { role: 'user', content: 'old session' },
        },
      ]),
    );
    const newSessionId = 'session-2';
    const newFile = join(sessionDir, `${newSessionId}.jsonl`);
    writeFileSync(
      newFile,
      jsonl([
        {
          type: 'user',
          uuid: 'u2',
          sessionId: newSessionId,
          timestamp: '2024-01-01T00:00:02Z',
          message: { role: 'user', content: 'new session' },
        },
      ]),
    );

    const events: ConversationEvent[] = [];
    streamer = new ConversationStreamer({
      taskId: 't1',
      onEvent: (e) => events.push(e),
    });
    await streamer.attach(workspaceId, sessionId);
    expect(events.map((e) => e.text)).toEqual(['old session']);

    await streamer.attach(workspaceId, newSessionId);
    expect(events.map((e) => e.text)).toEqual(['old session', 'new session']);
  });
});
