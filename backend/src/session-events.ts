/**
 * Session event parsing for the rich chat view.
 *
 * Claude Code writes a structured, append-only JSONL transcript of every session to
 * ~/.claude/projects/<slugified-workspace>/<sessionId>.jsonl. The terminal path in
 * task-spawner.ts only ever sees the rendered ANSI of the TUI, but that JSONL carries
 * the real structure: assistant text, thinking blocks, tool calls with their inputs,
 * and tool results. This module turns those lines into a flat, render-ready event list.
 *
 * conversation-parser.ts already reads the same files, but it keeps only text and drops
 * tool_use/tool_result. We need those to draw tool cards, so this parses independently
 * rather than widening the existing type and disturbing its callers.
 *
 * Incremental by design: parseSessionEvents() takes a byte offset and returns the new
 * offset, so polling re-reads only the bytes appended since the last call.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

/** A tool invocation plus its result, paired up across the two JSONL entries. */
export interface ToolCallEvent {
    type: 'tool';
    id: string;
    /** Tool name as Claude Code reports it, e.g. "Read", "Bash", "mcp__foo__bar". */
    name: string;
    input: Record<string, unknown>;
    /** Undefined until the matching tool_result line is parsed. */
    result?: string;
    isError?: boolean;
    timestamp: string;
}

export interface TextEvent {
    type: 'text';
    id: string;
    role: 'user' | 'assistant';
    text: string;
    timestamp: string;
}

export interface ThinkingEvent {
    type: 'thinking';
    id: string;
    text: string;
    timestamp: string;
}

export type SessionEvent = TextEvent | ThinkingEvent | ToolCallEvent;

export interface SessionEventsResult {
    sessionId: string;
    events: SessionEvent[];
    /** Byte offset to resume from on the next incremental read. */
    offset: number;
}

interface JsonlContentBlock {
    type: string;
    text?: string;
    thinking?: string;
    // tool_use
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    // tool_result
    tool_use_id?: string;
    content?: unknown;
    is_error?: boolean;
}

interface JsonlEntry {
    type?: string;
    uuid?: string;
    timestamp?: string;
    sessionId?: string;
    isSidechain?: boolean;
    isMeta?: boolean;
    message?: {
        role?: string;
        content?: string | JsonlContentBlock[];
    };
}

/**
 * Claude Code replaces every non-alphanumeric character (except dashes) with a dash.
 * Mirrors the helpers in conversation-parser.ts and token-parser.ts.
 */
function workspacePathToClaudeFolderName(workspacePath: string): string {
    return workspacePath.replace(/[^a-zA-Z0-9-]/g, '-');
}

export function getSessionFilePath(workspacePath: string, sessionId: string): string {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const folderName = workspacePathToClaudeFolderName(workspacePath);
    return path.join(homeDir, '.claude', 'projects', folderName, `${sessionId}.jsonl`);
}

/** Tool results arrive as a string, or as an array of blocks we flatten to text. */
function stringifyToolResult(content: unknown): string {
    if (content == null) return '';
    if (typeof content === 'string') return content;

    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === 'string') return part;
                if (part && typeof part === 'object') {
                    const p = part as Record<string, unknown>;
                    if (typeof p.text === 'string') return p.text;
                    // e.g. { type: 'tool_reference', tool_name: '...' } or image blocks
                    if (typeof p.tool_name === 'string') return `[${p.type}: ${p.tool_name}]`;
                    if (typeof p.type === 'string') return `[${p.type}]`;
                }
                return '';
            })
            .filter(Boolean)
            .join('\n');
    }

    try {
        return JSON.stringify(content);
    } catch {
        return String(content);
    }
}

/**
 * Claudia prepends `[CONTEXT UPDATE: ...]` blocks to user input (workspace reference
 * changes, MCP config changes, auto-title reminders). They are plumbing, not something
 * the user typed, and server.ts already strips them from terminal output via
 * filterContextUpdateFromOutput(). Do the same here.
 *
 * These entries are NOT flagged isMeta in the transcript, so they must be matched on
 * content. Returns null when the message was *only* a context update.
 */
function stripContextUpdate(text: string): string | null {
    if (!text.includes('[CONTEXT UPDATE:')) return text;
    // Non-greedy to the first closing bracket; these blocks contain no nested ']'.
    const cleaned = text.replace(/\[CONTEXT UPDATE:[^\]]*\]\s*/g, '').trim();
    return cleaned.length > 0 ? cleaned : null;
}

/** Truncate very large tool output so a single 5MB file read can't wedge the UI. */
const MAX_RESULT_CHARS = 20000;

function clampResult(text: string): string {
    if (text.length <= MAX_RESULT_CHARS) return text;
    const omitted = text.length - MAX_RESULT_CHARS;
    return `${text.slice(0, MAX_RESULT_CHARS)}\n\n… [${omitted.toLocaleString()} more characters truncated]`;
}

/**
 * Parse a session transcript into ordered events.
 *
 * @param fromOffset Byte offset to start reading at. Pass the previous result's
 *   `offset` to read only newly appended lines.
 */
export async function parseSessionEvents(
    workspacePath: string,
    sessionId: string,
    fromOffset = 0
): Promise<SessionEventsResult | null> {
    const filePath = getSessionFilePath(workspacePath, sessionId);

    let stat: fs.Stats;
    try {
        stat = await fs.promises.stat(filePath);
    } catch {
        return null;
    }

    // File shrank (session reset / compaction rewrote it) — start over rather than
    // reading from a stale offset that now points into the middle of a line.
    let start = fromOffset;
    if (start > stat.size) start = 0;
    if (start === stat.size) {
        return { sessionId, events: [], offset: start };
    }

    const events: SessionEvent[] = [];
    /** Index into `events` for each tool_use id, so results can be attached in place. */
    const toolIndexById = new Map<string, number>();
    const seenUuids = new Set<string>();
    let resolvedSessionId = sessionId;

    // Claude Code appends to this file while we read it, so the last line may be torn
    // mid-write. We must not advance the offset past it, or that entry is skipped
    // forever once it is completed. Track bytes through the last complete line only.
    let consumedBytes = 0;

    await new Promise<void>((resolve, reject) => {
        const stream = fs.createReadStream(filePath, { start, encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

        rl.on('line', (rawLine) => {
            // readline strips the delimiter; readSoFar counts the bytes it consumed.
            // A trailing torn line never reaches us with its newline, but readline
            // still emits it at EOF — so only count lines we can fully parse below.
            const lineBytes = Buffer.byteLength(rawLine, 'utf8') + 1; // +1 for '\n'
            const line = rawLine;

            const commit = () => {
                consumedBytes += lineBytes;
            };

            if (!line.trim()) {
                commit();
                return;
            }

            let entry: JsonlEntry;
            try {
                entry = JSON.parse(line);
            } catch {
                // Either genuinely malformed, or a partially-flushed final line while
                // Claude Code is mid-write. We cannot tell them apart, so leave the
                // offset before it: a torn line is re-read (and parsed) on the next
                // poll, and a truly corrupt line costs one re-parse per poll until
                // more data is appended after it.
                return;
            }
            commit();

            if (entry.sessionId) resolvedSessionId = entry.sessionId;

            // Only user/assistant carry renderable content. Everything else in the file
            // (queue-operation, attachment, ai-title, custom-title, mode, system, summary)
            // is bookkeeping we deliberately ignore.
            if (entry.type !== 'user' && entry.type !== 'assistant') return;

            // Subagent branches would interleave confusingly with the main thread.
            if (entry.isSidechain) return;
            if (entry.isMeta) return;

            const content = entry.message?.content;
            if (content === undefined) return;

            // Assistant turns are written twice under one uuid (partial, then final).
            // Dedupe so text isn't emitted twice; tool_result lines have no uuid reuse.
            if (entry.uuid) {
                if (seenUuids.has(entry.uuid)) return;
                seenUuids.add(entry.uuid);
            }

            const timestamp = entry.timestamp || '';
            const baseId = entry.uuid || `${events.length}`;

            if (typeof content === 'string') {
                if (content.trim() && entry.type === 'user') {
                    const cleaned = stripContextUpdate(content);
                    if (cleaned) {
                        events.push({ type: 'text', id: baseId, role: 'user', text: cleaned, timestamp });
                    }
                }
                return;
            }

            if (!Array.isArray(content)) return;

            content.forEach((block, i) => {
                if (!block || typeof block !== 'object') return;

                if (block.type === 'text' && block.text?.trim()) {
                    const isUser = entry.type === 'user';
                    const text = isUser ? stripContextUpdate(block.text) : block.text;
                    if (text) {
                        events.push({
                            type: 'text',
                            id: `${baseId}-${i}`,
                            role: isUser ? 'user' : 'assistant',
                            text,
                            timestamp,
                        });
                    }
                } else if (block.type === 'thinking' && block.thinking?.trim()) {
                    events.push({ type: 'thinking', id: `${baseId}-${i}`, text: block.thinking, timestamp });
                } else if (block.type === 'tool_use' && block.id) {
                    toolIndexById.set(block.id, events.length);
                    events.push({
                        type: 'tool',
                        id: block.id,
                        name: block.name || 'tool',
                        input: block.input || {},
                        timestamp,
                    });
                } else if (block.type === 'tool_result' && block.tool_use_id) {
                    const idx = toolIndexById.get(block.tool_use_id);
                    const text = clampResult(stringifyToolResult(block.content));
                    if (idx !== undefined) {
                        const target = events[idx] as ToolCallEvent;
                        target.result = text;
                        target.isError = block.is_error === true;
                    } else {
                        // Result for a call made before `fromOffset`. The caller merges
                        // by id, so emit a result-only stub to patch the existing card.
                        events.push({
                            type: 'tool',
                            id: block.tool_use_id,
                            name: '',
                            input: {},
                            result: text,
                            isError: block.is_error === true,
                            timestamp,
                        });
                    }
                }
            });
        });

        rl.on('close', () => resolve());
        rl.on('error', reject);
        stream.on('error', reject);
    });

    return { sessionId: resolvedSessionId, events, offset: start + consumedBytes };
}
