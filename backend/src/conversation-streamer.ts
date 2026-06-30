/**
 * ConversationStreamer — emits a stream of canonical ConversationEvents for
 * a Claude Code (or OpenCode) session by tailing its on-disk JSONL file.
 *
 * The streamer is the rich, fully-typed event channel that the React
 * conversation view consumes — every assistant text block, every tool_use,
 * every tool_result, every thinking block.
 *
 * Why JSONL instead of PTY? Because rendering Claude Code's TUI through
 * xterm.js is brittle — terminal width drift causes glyph corruption that
 * only a manual resize fixes. The JSONL is the source of truth Claude Code
 * already writes; tailing it means a) no garbling, b) structured tool data
 * we can render with React widgets instead of scraping ANSI.
 *
 * Design: fs.watch + UUID dedup. On attach we read the file's existing
 * contents to anchor `lastSize` and prime the dedup set, THEN emit any events
 * the caller asked us to emit historically (used so reconnecting tasks can
 * replay full history on first attach). After that, fs.watch drives
 * incremental tailing of newly-appended bytes.
 */
import * as fs from 'fs';
import * as readline from 'readline';
import { ConversationEvent } from '@claudia/shared';
import {
  eventsFromClaudeEntry,
  getClaudeSessionFilePath,
  parseConversationEvents,
} from './conversation-parser.js';

interface StreamerOptions {
  taskId: string;
  /** Invoked once per accepted ConversationEvent. Called on history backfill
   *  AND on live tail. Caller is responsible for broadcast/throttle. */
  onEvent: (ev: ConversationEvent) => void;
  /** If true, replay the JSONL contents that already exist when we first
   *  attach (so the in-memory event cache is populated). If false, only
   *  events appended after attach are emitted. Default: true. */
  emitExisting?: boolean;
}

const DEFAULT_REREAD_DEBOUNCE_MS = 80;
const RETRY_FILE_MS = 500;

export class ConversationStreamer {
  private readonly taskId: string;
  private readonly onEvent: (ev: ConversationEvent) => void;
  private readonly emitExisting: boolean;

  // Currently-watched session.
  private filePath: string | null = null;
  private sessionId: string | null = null;
  private workspaceId: string | null = null;

  // fs.watch handle + retry/debounce timers.
  private watcher: fs.FSWatcher | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private rereadTimer: ReturnType<typeof setTimeout> | null = null;

  // Tail state.
  private lastSize = 0;
  private partialLine = '';
  private seenUuids = new Set<string>();
  private disposed = false;

  // In-memory snapshot for reconnecting clients. We cache up to MAX_CACHE
  // events; older ones are dropped from the snapshot (the JSONL on disk is
  // authoritative for cold loads via the REST endpoint).
  private snapshot: ConversationEvent[] = [];
  private static readonly MAX_CACHE = 5000;

  constructor(options: StreamerOptions) {
    this.taskId = options.taskId;
    this.onEvent = options.onEvent;
    this.emitExisting = options.emitExisting ?? true;
  }

  /** Most recent N events — used to seed reconnecting WS clients. */
  getSnapshot(): ConversationEvent[] {
    return this.snapshot.slice();
  }

  /** Test-only: synchronously read any newly-appended bytes and emit events.
   *  Production code paths drive this via fs.watch; tests use it because the
   *  vmThreads vitest pool doesn't deliver fs.watch callbacks reliably. */
  tickForTesting(): void {
    this.tail();
  }

  /**
   * Start (or restart) watching the session file for this task. Idempotent:
   * calling with the same args is a no-op; calling with a new sessionId
   * detaches from the old file and attaches to the new one (used after
   * /compact, which forks a new sessionId mid-task).
   */
  async attach(workspaceId: string, sessionId: string): Promise<void> {
    if (this.disposed) return;
    if (this.workspaceId === workspaceId && this.sessionId === sessionId) return;

    this.detach();
    this.workspaceId = workspaceId;
    this.sessionId = sessionId;
    this.filePath = getClaudeSessionFilePath(workspaceId, sessionId);
    console.log(`[ConvStreamer] ${this.taskId} attaching to ${this.filePath}`);

    // Backfill: parse whatever's already on disk and emit it. This populates
    // the snapshot AND lets newly-mounted React clients see history without
    // making a separate REST call. Done BEFORE we start fs.watch so the
    // ordering is: history → live tail.
    if (this.emitExisting && fs.existsSync(this.filePath)) {
      try {
        const existing = await parseConversationEvents(
          workspaceId,
          sessionId,
          this.taskId,
          'claude-code',
        );
        for (const ev of existing) {
          if (this.seenUuids.has(ev.uuid)) continue;
          this.seenUuids.add(ev.uuid);
          this.pushSnapshot(ev);
          try {
            this.onEvent(ev);
          } catch (err) {
            console.error(`[ConvStreamer] ${this.taskId} backfill onEvent threw:`, err);
          }
        }
        // Anchor `lastSize` to current file size so the first tail() doesn't
        // re-emit what we just backfilled.
        try {
          this.lastSize = fs.statSync(this.filePath).size;
        } catch {
          this.lastSize = 0;
        }
      } catch (err) {
        console.error(`[ConvStreamer] ${this.taskId} backfill failed:`, err);
      }
    }

    this.beginWatch();
  }

  dispose(): void {
    this.disposed = true;
    this.detach();
    this.snapshot = [];
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

  /** Wait for the JSONL file to exist, then start fs.watch tailing.
   *  Claude creates the file on the first user message, so we may need to
   *  retry briefly. */
  private beginWatch(): void {
    if (this.disposed || !this.filePath) return;

    if (!fs.existsSync(this.filePath)) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.beginWatch();
      }, RETRY_FILE_MS);
      return;
    }

    // If we DIDN'T backfill (emitExisting === false), still anchor lastSize
    // and prime the dedup set so we don't replay history on the first tail.
    if (this.lastSize === 0) {
      try {
        const buf = fs.readFileSync(this.filePath, 'utf8');
        this.lastSize = Buffer.byteLength(buf, 'utf8');
        for (const line of buf.split('\n')) {
          this.recordUuids(line);
        }
      } catch (err) {
        console.error(`[ConvStreamer] ${this.taskId} initial read failed:`, err);
        this.lastSize = 0;
      }
    }

    try {
      // persistent: true so vitest vmThreads workers don't tear down the
      // watcher before fs.watch callbacks fire. We always dispose() on task
      // teardown so this doesn't leak.
      this.watcher = fs.watch(this.filePath, { persistent: true }, () => {
        this.scheduleReread();
      });
    } catch (err) {
      console.error(`[ConvStreamer] ${this.taskId} fs.watch failed:`, err);
      // Slow-poll fallback.
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.scheduleReread();
        this.beginWatch();
      }, 1000);
    }
  }

  /** Coalesce rapid file-change events (macOS fires fs.watch multiple times
   *  per write). */
  private scheduleReread(): void {
    if (this.disposed) return;
    if (this.rereadTimer) return;
    this.rereadTimer = setTimeout(() => {
      this.rereadTimer = null;
      this.tail();
    }, DEFAULT_REREAD_DEBOUNCE_MS);
  }

  private tail(): void {
    if (this.disposed || !this.filePath) return;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      // File rotated/deleted — wait for it to come back.
      this.lastSize = 0;
      return;
    }

    if (stat.size < this.lastSize) {
      // Truncated.
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
      console.error(`[ConvStreamer] ${this.taskId} tail read failed:`, err);
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

  /** Track every uuid a line might emit, without firing onEvent. Used during
   *  the no-backfill bootstrap so the first tail isn't a full replay. */
  private recordUuids(rawLine: string): void {
    const line = rawLine.trim();
    if (!line) return;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    for (const ev of eventsFromClaudeEntry(entry, this.taskId)) {
      this.seenUuids.add(ev.uuid);
    }
  }

  private handleLine(rawLine: string): void {
    const line = rawLine.trim();
    if (!line) return;

    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      return; // partial / corrupt
    }

    for (const ev of eventsFromClaudeEntry(entry, this.taskId)) {
      if (this.seenUuids.has(ev.uuid)) continue;
      this.seenUuids.add(ev.uuid);
      this.pushSnapshot(ev);
      try {
        this.onEvent(ev);
      } catch (err) {
        console.error(`[ConvStreamer] ${this.taskId} onEvent threw:`, err);
      }
    }
  }

  private pushSnapshot(ev: ConversationEvent): void {
    this.snapshot.push(ev);
    if (this.snapshot.length > ConversationStreamer.MAX_CACHE) {
      // Drop oldest 10% in one shot — cheaper than shift() on every push.
      const drop = Math.floor(ConversationStreamer.MAX_CACHE * 0.1);
      this.snapshot.splice(0, drop);
    }
  }
}
