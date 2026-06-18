/**
 * TaskNarrator — emits a chat message for each new assistant text block in
 * Claude Code's session JSONL.
 *
 * Claude Code writes one JSONL file per session at
 * ~/.claude/projects/<workspace-folder>/<sessionId>.jsonl. Each line is a JSON
 * object; the ones we care about are `type: 'assistant'` entries whose
 * `message.content` array contains `{ type: 'text', text: '...' }` blocks —
 * that's the conversational narration the user already sees as `⏺ ...` lines
 * in the TUI. By tailing the file we get it cleanly, without ANSI scraping,
 * without missing redrawn content.
 *
 * One narrator per task. `attach(workspaceId, sessionId)` starts watching the
 * file (creating it if needed isn't our job — Claude does that). The narrator
 * is resilient to mid-line writes (incomplete tail) and to file rotation
 * (sessionId changes via task:sessionUpdated → call attach() again).
 */
import * as fs from 'fs';
import * as path from 'path';

export interface NarrationEmit {
  text: string;
  timestamp: string; // ISO
}

interface NarratorOptions {
  taskId: string;
  /** Invoked once per accepted assistant text block. */
  onNarration: (msg: NarrationEmit) => void;
  /** Maximum length of a single narration; longer is truncated. */
  maxBlockChars?: number;
}

const DEFAULTS = {
  maxBlockChars: 2000,
};

/**
 * Convert an absolute workspace path to the folder name Claude Code uses
 * under ~/.claude/projects/. Mirrors the rule in conversation-parser.ts:
 * replace path separators and dots with dashes.
 */
function workspacePathToClaudeFolderName(workspacePath: string): string {
  return workspacePath.replace(/[/\\.]/g, '-');
}

function getSessionFilePath(workspaceId: string, sessionId: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const folder = workspacePathToClaudeFolderName(workspaceId);
  return path.join(home, '.claude', 'projects', folder, `${sessionId}.jsonl`);
}

interface AssistantEntry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?:
      | string
      | Array<{ type: string; text?: string }>;
  };
}

export class TaskNarrator {
  private readonly taskId: string;
  private readonly onNarration: (msg: NarrationEmit) => void;
  private readonly maxBlockChars: number;

  // Currently-watched session.
  private filePath: string | null = null;
  private sessionId: string | null = null;
  private workspaceId: string | null = null;

  // fs.watch handle + retry timer for files that don't exist yet.
  private watcher: fs.FSWatcher | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private rereadTimer: ReturnType<typeof setTimeout> | null = null;

  // Tail state.
  private lastSize = 0;
  private partialLine = '';
  private seenUuids = new Set<string>();
  private disposed = false;

  constructor(options: NarratorOptions) {
    this.taskId = options.taskId;
    this.onNarration = options.onNarration;
    this.maxBlockChars = options.maxBlockChars ?? DEFAULTS.maxBlockChars;
  }

  /**
   * Start (or restart) watching the session file for this task. Idempotent —
   * calling with the same args is a no-op; calling with a new sessionId
   * detaches from the old file and attaches to the new one.
   */
  attach(workspaceId: string, sessionId: string): void {
    if (this.disposed) return;
    if (this.workspaceId === workspaceId && this.sessionId === sessionId) return;

    this.detach();
    this.workspaceId = workspaceId;
    this.sessionId = sessionId;
    this.filePath = getSessionFilePath(workspaceId, sessionId);
    console.log(
      `[Narrator] ${this.taskId} attaching to ${this.filePath}`,
    );
    this.beginWatch();
  }

  dispose(): void {
    this.disposed = true;
    this.detach();
  }

  private detach(): void {
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* ignore */
      }
      this.watcher = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.rereadTimer) {
      clearTimeout(this.rereadTimer);
      this.rereadTimer = null;
    }
    this.lastSize = 0;
    this.partialLine = '';
    this.seenUuids.clear();
  }

  /**
   * Wait for the JSONL file to exist, then start an fs.watch tail loop.
   * Claude creates the file on the first user message, which can lag the
   * sessionCaptured event by a moment.
   */
  private beginWatch(): void {
    if (this.disposed || !this.filePath) return;

    if (!fs.existsSync(this.filePath)) {
      // Retry shortly; the file should appear once Claude writes its first turn.
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.beginWatch();
      }, 500);
      return;
    }

    // Read everything currently in the file as historical (no narration emit
    // for these — they're already past, the user has either seen them or
    // doesn't need to). This anchors `lastSize` for tail-only behavior.
    try {
      const buf = fs.readFileSync(this.filePath, 'utf8');
      this.lastSize = Buffer.byteLength(buf, 'utf8');
      // Walk through to record uuids so a future re-read doesn't double-emit.
      for (const line of buf.split('\n')) {
        this.recordUuid(line);
      }
    } catch (err) {
      console.error(`[Narrator] ${this.taskId} initial read failed:`, err);
      this.lastSize = 0;
    }

    try {
      this.watcher = fs.watch(this.filePath, { persistent: false }, () => {
        this.scheduleReread();
      });
    } catch (err) {
      console.error(`[Narrator] ${this.taskId} fs.watch failed:`, err);
      // Fall back to a slow poll.
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.scheduleReread();
        this.beginWatch();
      }, 1000);
    }
  }

  /**
   * Coalesce rapid file-change events. fs.watch fires multiple times per
   * write on macOS; we only need to re-tail once.
   */
  private scheduleReread(): void {
    if (this.disposed) return;
    if (this.rereadTimer) return;
    this.rereadTimer = setTimeout(() => {
      this.rereadTimer = null;
      this.tail();
    }, 80);
  }

  private tail(): void {
    if (this.disposed || !this.filePath) return;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      // File vanished (rotated?). Wait for it to come back.
      this.lastSize = 0;
      return;
    }

    if (stat.size < this.lastSize) {
      // Truncated. Re-anchor at the start.
      this.lastSize = 0;
      this.partialLine = '';
      this.seenUuids.clear();
    }
    if (stat.size === this.lastSize) return;

    let chunk: Buffer;
    try {
      const fd = fs.openSync(this.filePath, 'r');
      try {
        const length = stat.size - this.lastSize;
        chunk = Buffer.alloc(length);
        fs.readSync(fd, chunk, 0, length, this.lastSize);
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      console.error(`[Narrator] ${this.taskId} tail read failed:`, err);
      return;
    }

    this.lastSize = stat.size;
    this.partialLine += chunk.toString('utf8');

    let nl = this.partialLine.indexOf('\n');
    while (nl !== -1) {
      const line = this.partialLine.slice(0, nl);
      this.partialLine = this.partialLine.slice(nl + 1);
      this.handleLine(line);
      nl = this.partialLine.indexOf('\n');
    }
  }

  /** Track a uuid from a line without emitting (used during initial read). */
  private recordUuid(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const entry = JSON.parse(trimmed) as AssistantEntry;
      if (entry.uuid) this.seenUuids.add(entry.uuid);
    } catch {
      /* incomplete line during initial read — ignore */
    }
  }

  private handleLine(rawLine: string): void {
    const line = rawLine.trim();
    if (!line) return;

    let entry: AssistantEntry;
    try {
      entry = JSON.parse(line) as AssistantEntry;
    } catch {
      return; // Partial / corrupted line; skip.
    }

    if (entry.type !== 'assistant') return;
    if (!entry.uuid) return;
    if (this.seenUuids.has(entry.uuid)) return;
    this.seenUuids.add(entry.uuid);

    const content = entry.message?.content;
    if (!content) return;

    const textParts: string[] = [];
    if (typeof content === 'string') {
      textParts.push(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          textParts.push(part.text);
        }
      }
    }
    if (textParts.length === 0) return;

    let text = textParts.join('\n').trim();
    if (!text) return;
    if (text.length > this.maxBlockChars) {
      text = text.slice(0, this.maxBlockChars - 1) + '…';
    }

    try {
      this.onNarration({
        text,
        timestamp: entry.timestamp || new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[Narrator] ${this.taskId} onNarration callback threw:`, err);
    }
  }
}
