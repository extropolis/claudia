import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { BackendType, ConversationEvent } from '@claudia/shared';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  uuid: string;
  thinking?: string;
}

/**
 * Activity entry — one line in a "what is the agent doing right now"
 * timeline. Built from the Claude Code JSONL stream (text turns, tool
 * calls, thinking blocks). Cheaper than rendering raw PTY output and
 * survives TUI chrome / cursor redraws perfectly because it bypasses the
 * terminal entirely.
 */
export interface ActivityEntry {
  /** UUID of the JSONL entry this came from. */
  uuid: string;
  /** ISO timestamp from the JSONL entry. */
  timestamp: string;
  /** What kind of event this is. */
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'user';
  /**
   * For tool_use: the tool name (e.g. "Bash", "Read", "Edit",
   * "mcp__claudia__claudia_list_tasks").
   */
  tool?: string;
  /**
   * Human-readable one-liner describing the activity. Examples:
   *   "Reading src/foo.ts"
   *   "Bash: npm test"
   *   "Editing backend/server.ts"
   *   "Searching for `useState`"
   *   "Got it — let me look at the parser…"
   */
  label: string;
}

export interface ParsedConversation {
  sessionId: string;
  messages: ConversationMessage[];
  /** Flat timeline of activity entries — text, tool calls, thinking, tool results. */
  activity: ActivityEntry[];
  summary?: string;
}

// Claude Code JSONL entry format
interface ClaudeJsonlContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  // tool_use blocks
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  // tool_result blocks (appear in user-role entries)
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

interface ClaudeJsonlEntry {
  type: string;
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
  sessionId?: string;
  summary?: string;
  message?: {
    role: string;
    content: string | ClaudeJsonlContentBlock[];
  };
}

// OpenCode message file format
interface OpenCodeMessage {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  time: {
    created: number;
  };
  summary?: {
    title?: string;
    diffs?: unknown[];
  };
  agent?: string;
  model?: {
    providerID: string;
    modelID: string;
  };
  variant?: string;
}

// OpenCode part file format (contains the actual message content)
interface OpenCodePart {
  id: string;
  messageID: string;
  sessionID: string;
  type: string;
  time: {
    created: number;
  };
  text?: string;
  thinking?: string;
}

// ================== Claude Code Functions ==================

/**
 * Convert a workspace path to the Claude projects folder name format
 * e.g., /Users/I850333/projects/experiments/codeui -> -Users-I850333-projects-experiments-codeui
 */
function workspacePathToClaudeFolderName(workspacePath: string): string {
  // Claude Code replaces every non-alphanumeric character (except dashes) with a dash
  return workspacePath.replace(/[^a-zA-Z0-9-]/g, '-');
}

/**
 * Get the Claude projects directory for a workspace
 */
function getClaudeProjectsDir(workspacePath: string): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const folderName = workspacePathToClaudeFolderName(workspacePath);
  return path.join(homeDir, '.claude', 'projects', folderName);
}

/**
 * Find the Claude Code JSONL file for a given session ID
 */
async function findClaudeSessionFile(
  workspacePath: string,
  sessionId: string,
): Promise<string | null> {
  const projectDir = getClaudeProjectsDir(workspacePath);
  const sessionFile = path.join(projectDir, `${sessionId}.jsonl`);

  if (fs.existsSync(sessionFile)) {
    return sessionFile;
  }

  return null;
}

/**
 * Extract text content from a Claude Code message content field
 */
function extractClaudeTextContent(
  content: string | ClaudeJsonlContentBlock[],
): { text: string; thinking?: string } {
  if (typeof content === 'string') {
    return { text: content };
  }

  let text = '';
  let thinking: string | undefined;

  for (const part of content) {
    if (part.type === 'text' && part.text) {
      text += part.text;
    } else if (part.type === 'thinking' && part.thinking) {
      thinking = part.thinking;
    }
  }

  return { text, thinking };
}

/**
 * Truncate a string to `max` chars, with an ellipsis if it had to be cut.
 */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Build a one-line human-readable label for a tool_use block. We pluck the
 * most useful field from the input depending on the tool — file_path,
 * command, pattern, query — so the activity feed reads like
 *   "Reading src/foo.ts"        (Read)
 *   "Bash: npm test"            (Bash)
 *   "Searching for useState"    (Grep)
 *   "Editing backend/server.ts" (Edit)
 * For tools we don't recognize we fall back to the tool name alone, which
 * is still strictly better than "✻48s" ANSI noise.
 */
function labelForToolUse(name: string, input: Record<string, unknown> | undefined): string {
  const inp = input || {};
  const get = (key: string): string | undefined => {
    const v = inp[key];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  };

  // Strip MCP server prefix for readability — "mcp__claudia__claudia_list_tasks"
  // → "claudia_list_tasks". The MCP machinery is irrelevant on a phone.
  const displayName = name.replace(/^mcp__[^_]+__/, '');

  switch (name) {
    case 'Read':
      return get('file_path') ? `Reading ${get('file_path')}` : 'Reading file';
    case 'Write':
      return get('file_path') ? `Writing ${get('file_path')}` : 'Writing file';
    case 'Edit':
    case 'NotebookEdit':
      return get('file_path') ? `Editing ${get('file_path')}` : 'Editing file';
    case 'Bash':
      return get('command') ? `Bash: ${truncate(get('command')!, 80)}` : 'Bash command';
    case 'Glob':
      return get('pattern') ? `Globbing ${get('pattern')}` : 'Globbing files';
    case 'Grep':
      return get('pattern') ? `Searching for "${truncate(get('pattern')!, 60)}"` : 'Searching';
    case 'WebFetch':
      return get('url') ? `Fetching ${get('url')}` : 'Fetching URL';
    case 'WebSearch':
      return get('query') ? `Web search: ${truncate(get('query')!, 60)}` : 'Web search';
    case 'TodoWrite':
      return 'Updating todo list';
    case 'Task':
    case 'Agent':
      return get('description') || get('subagent_type')
        ? `Spawning agent: ${get('description') || get('subagent_type')}`
        : 'Spawning agent';
    default:
      // Show whichever string-valued input field is most likely useful.
      for (const key of ['file_path', 'command', 'query', 'pattern', 'url', 'description']) {
        const v = get(key);
        if (v) return `${displayName}: ${truncate(v, 80)}`;
      }
      return displayName;
  }
}

/**
 * Walk a JSONL entry and emit zero or more ActivityEntry rows for it. The
 * order matters: text → thinking → tool_use, in the order they appear in
 * the message content array, so the feed reads chronologically.
 */
function activityFromEntry(entry: ClaudeJsonlEntry): ActivityEntry[] {
  if (!entry.message || !entry.uuid) return [];
  const out: ActivityEntry[] = [];
  const baseUuid = entry.uuid;
  const ts = entry.timestamp || '';
  const content = entry.message.content;

  if (entry.type === 'user') {
    if (typeof content === 'string') {
      const text = content.trim();
      if (text) {
        out.push({ uuid: baseUuid, timestamp: ts, kind: 'user', label: truncate(text, 200) });
      }
    } else if (Array.isArray(content)) {
      for (let i = 0; i < content.length; i++) {
        const c = content[i];
        if (c.type === 'tool_result') {
          out.push({
            uuid: `${baseUuid}:r${i}`,
            timestamp: ts,
            kind: 'tool_result',
            label: c.is_error ? 'Tool error' : 'Tool result',
          });
        }
      }
    }
    return out;
  }

  if (entry.type === 'assistant' && Array.isArray(content)) {
    for (let i = 0; i < content.length; i++) {
      const c = content[i];
      if (c.type === 'text' && c.text) {
        const text = c.text.trim();
        if (text) {
          out.push({
            uuid: `${baseUuid}:t${i}`,
            timestamp: ts,
            kind: 'text',
            label: truncate(text.replace(/\s+/g, ' '), 200),
          });
        }
      } else if (c.type === 'thinking' && c.thinking) {
        const text = c.thinking.trim();
        if (text) {
          out.push({
            uuid: `${baseUuid}:th${i}`,
            timestamp: ts,
            kind: 'thinking',
            label: truncate(text.replace(/\s+/g, ' '), 160),
          });
        }
      } else if (c.type === 'tool_use' && c.name) {
        out.push({
          uuid: `${baseUuid}:u${i}`,
          timestamp: ts,
          kind: 'tool_use',
          tool: c.name,
          label: labelForToolUse(c.name, c.input),
        });
      }
    }
  }

  return out;
}

/**
 * Parse a Claude Code JSONL conversation file
 */
async function parseClaudeConversationFile(filePath: string): Promise<ParsedConversation> {
  return new Promise((resolve, reject) => {
    const messages: ConversationMessage[] = [];
    const activity: ActivityEntry[] = [];
    let sessionId = '';
    let summary: string | undefined;
    const seenUuids = new Set<string>();

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      try {
        const entry: ClaudeJsonlEntry = JSON.parse(line);

        // Capture session ID
        if (entry.sessionId && !sessionId) {
          sessionId = entry.sessionId;
        }

        // Capture summary
        if (entry.type === 'summary' && entry.summary) {
          summary = entry.summary;
        }

        // Activity timeline — fine-grained "what's happening right now" view.
        // Built from EVERY user/assistant entry, including tool calls and
        // thinking blocks that the bubble list (`messages`) deliberately
        // skips. Mobile uses this to drive the live activity panel.
        for (const a of activityFromEntry(entry)) {
          activity.push(a);
        }

        // Process user messages
        if (entry.type === 'user' && entry.message && entry.uuid) {
          // Skip if we've already seen this UUID (avoid duplicates)
          if (seenUuids.has(entry.uuid)) return;
          seenUuids.add(entry.uuid);

          const { text } = extractClaudeTextContent(entry.message.content);
          if (text) {
            messages.push({
              role: 'user',
              content: text,
              timestamp: entry.timestamp || '',
              uuid: entry.uuid,
            });
          }
        }

        // Process assistant messages
        if (entry.type === 'assistant' && entry.message && entry.uuid) {
          // Skip if we've already seen this UUID
          if (seenUuids.has(entry.uuid)) return;
          seenUuids.add(entry.uuid);

          const { text, thinking } = extractClaudeTextContent(entry.message.content);
          // Only add if there's actual text content (skip pure thinking blocks)
          if (text) {
            messages.push({
              role: 'assistant',
              content: text,
              timestamp: entry.timestamp || '',
              uuid: entry.uuid,
              thinking,
            });
          }
        }
      } catch (e) {
        // Skip malformed lines
      }
    });

    rl.on('close', () => {
      resolve({
        sessionId: sessionId || path.basename(filePath, '.jsonl'),
        messages,
        activity,
        summary,
      });
    });

    rl.on('error', reject);
  });
}

/**
 * Get Claude Code conversation history
 */
async function getClaudeConversationHistory(
  workspacePath: string,
  sessionId: string,
): Promise<ParsedConversation | null> {
  const filePath = await findClaudeSessionFile(workspacePath, sessionId);
  if (!filePath) {
    console.log(
      `[ConversationParser] No Claude Code session file found for ${sessionId} in ${workspacePath}`,
    );
    return null;
  }

  console.log(`[ConversationParser] Parsing Claude Code session file: ${filePath}`);
  return parseClaudeConversationFile(filePath);
}

/**
 * Get Claude Code sessions for a workspace
 */
async function getClaudeWorkspaceSessions(
  workspacePath: string,
): Promise<Array<{ sessionId: string; summary?: string; lastModified: Date }>> {
  const projectDir = getClaudeProjectsDir(workspacePath);

  if (!fs.existsSync(projectDir)) {
    return [];
  }

  const files = fs
    .readdirSync(projectDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({
      sessionId: path.basename(f, '.jsonl'),
      path: path.join(projectDir, f),
      lastModified: fs.statSync(path.join(projectDir, f)).mtime,
    }))
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

  // Get summaries from each file (just read first line which usually has summary)
  const results: Array<{ sessionId: string; summary?: string; lastModified: Date }> = [];

  for (const file of files.slice(0, 50)) {
    // Limit to 50 most recent
    try {
      const firstLines = fs.readFileSync(file.path, 'utf8').split('\n').slice(0, 5);
      let summary: string | undefined;

      for (const line of firstLines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'summary' && entry.summary) {
            summary = entry.summary;
            break;
          }
        } catch {
          /* skip */
        }
      }

      results.push({
        sessionId: file.sessionId,
        summary,
        lastModified: file.lastModified,
      });
    } catch {
      /* skip */
    }
  }

  return results;
}

// ================== OpenCode Functions ==================

/**
 * Get the OpenCode storage directory
 */
function getOpenCodeStorageDir(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(homeDir, '.local', 'share', 'opencode', 'storage');
}

/**
 * Get OpenCode conversation history for a session
 */
async function getOpenCodeConversationHistory(
  sessionId: string,
): Promise<ParsedConversation | null> {
  const storageDir = getOpenCodeStorageDir();
  const messageDir = path.join(storageDir, 'message', sessionId);
  const partDir = path.join(storageDir, 'part');

  console.log(`[ConversationParser] Looking for OpenCode session ${sessionId}`);
  console.log(`[ConversationParser] Message dir: ${messageDir}`);

  if (!fs.existsSync(messageDir)) {
    console.log(`[ConversationParser] No OpenCode message directory found for ${sessionId}`);
    return null;
  }

  // Read all message files for this session
  const messageFiles = fs
    .readdirSync(messageDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const content = fs.readFileSync(path.join(messageDir, f), 'utf-8');
        return JSON.parse(content) as OpenCodeMessage;
      } catch {
        return null;
      }
    })
    .filter((m): m is OpenCodeMessage => m !== null)
    .sort((a, b) => a.time.created - b.time.created);

  console.log(`[ConversationParser] Found ${messageFiles.length} messages`);

  // For each message, find its parts (content)
  const messages: ConversationMessage[] = [];

  for (const msg of messageFiles) {
    // Look for parts that belong to this message
    // Parts are stored in part/{sessionId}/ directory
    const sessionPartDir = path.join(partDir, sessionId);

    if (!fs.existsSync(sessionPartDir)) {
      // Try the global session
      const globalPartDir = path.join(partDir, 'global');
      if (!fs.existsSync(globalPartDir)) {
        continue;
      }
    }

    // Find parts for this message ID
    const partDirToSearch = fs.existsSync(path.join(partDir, sessionId))
      ? path.join(partDir, sessionId)
      : path.join(partDir);

    let content = '';
    let thinking: string | undefined;

    // Search for parts that match this message
    try {
      const searchDirs = [path.join(partDir, sessionId), path.join(partDir, 'global')];

      for (const dir of searchDirs) {
        if (!fs.existsSync(dir)) continue;

        const partFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
        for (const partFile of partFiles) {
          try {
            const partContent = fs.readFileSync(path.join(dir, partFile), 'utf-8');
            const part = JSON.parse(partContent) as OpenCodePart;

            if (part.messageID === msg.id) {
              if (part.type === 'text' && part.text) {
                content += part.text;
              } else if (part.type === 'thinking' && part.thinking) {
                thinking = part.thinking;
              }
            }
          } catch {
            /* skip */
          }
        }
      }
    } catch {
      /* skip */
    }

    // If we didn't find parts, use the message summary as a fallback
    if (!content && msg.summary?.title) {
      content = msg.summary.title;
    }

    if (content || msg.role === 'user') {
      messages.push({
        role: msg.role,
        content: content || '(no content)',
        timestamp: new Date(msg.time.created).toISOString(),
        uuid: msg.id,
        thinking,
      });
    }
  }

  // Get session info for summary
  let summary: string | undefined;
  try {
    // Try to find session file to get title
    const sessionDirs = [
      path.join(storageDir, 'session', 'global'),
      ...fs
        .readdirSync(path.join(storageDir, 'session'))
        .filter((d) => d !== 'global')
        .map((d) => path.join(storageDir, 'session', d)),
    ];

    for (const dir of sessionDirs) {
      if (!fs.existsSync(dir)) continue;
      const sessionFile = path.join(dir, `${sessionId}.json`);
      if (fs.existsSync(sessionFile)) {
        const sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
        summary = sessionData.title || sessionData.slug;
        break;
      }
    }
  } catch {
    /* skip */
  }

  return {
    sessionId,
    messages,
    activity: [],
    summary,
  };
}

/**
 * Get all OpenCode sessions
 */
async function getOpenCodeWorkspaceSessions(): Promise<
  Array<{ sessionId: string; summary?: string; lastModified: Date }>
> {
  const storageDir = getOpenCodeStorageDir();
  const sessionDir = path.join(storageDir, 'session');

  if (!fs.existsSync(sessionDir)) {
    return [];
  }

  const results: Array<{ sessionId: string; summary?: string; lastModified: Date }> = [];

  // Scan all session subdirectories
  const subdirs = fs.readdirSync(sessionDir).filter((d) => {
    const stat = fs.statSync(path.join(sessionDir, d));
    return stat.isDirectory();
  });

  for (const subdir of subdirs) {
    const subdirPath = path.join(sessionDir, subdir);
    const sessionFiles = fs
      .readdirSync(subdirPath)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(subdirPath, f));

    for (const sessionFile of sessionFiles) {
      try {
        const stat = fs.statSync(sessionFile);
        const sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));

        results.push({
          sessionId: sessionData.id || path.basename(sessionFile, '.json'),
          summary: sessionData.title || sessionData.slug,
          lastModified: stat.mtime,
        });
      } catch {
        /* skip */
      }
    }
  }

  // Sort by last modified descending
  results.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

  return results.slice(0, 50); // Limit to 50 most recent
}

// ================== Public API ==================

/**
 * Find the session file for a given session ID (legacy - Claude Code only)
 * @deprecated Use getConversationHistory with backendType instead
 */
export async function findSessionFile(
  workspacePath: string,
  sessionId: string,
): Promise<string | null> {
  return findClaudeSessionFile(workspacePath, sessionId);
}

/**
 * Find the most recent JSONL files in a workspace (legacy - Claude Code only)
 * @deprecated Use getWorkspaceSessions with backendType instead
 */
export async function findRecentSessionFiles(
  workspacePath: string,
  limit: number = 10,
): Promise<string[]> {
  const projectDir = getClaudeProjectsDir(workspacePath);

  if (!fs.existsSync(projectDir)) {
    return [];
  }

  const files = fs
    .readdirSync(projectDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({
      name: f,
      path: path.join(projectDir, f),
      mtime: fs.statSync(path.join(projectDir, f)).mtime.getTime(),
    }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);

  return files.map((f) => f.path);
}

/**
 * Parse a JSONL conversation file (legacy - Claude Code only)
 * @deprecated Use getConversationHistory with backendType instead
 */
export async function parseConversationFile(filePath: string): Promise<ParsedConversation> {
  return parseClaudeConversationFile(filePath);
}

/**
 * Get conversation history for a task by session ID
 * Supports both Claude Code and OpenCode backends
 */
export async function getConversationHistory(
  workspacePath: string,
  sessionId: string,
  backendType?: BackendType,
): Promise<ParsedConversation | null> {
  console.log(
    `[ConversationParser] Getting conversation for session ${sessionId}, backend: ${backendType || 'auto-detect'}`,
  );

  // If backend type is specified, use that
  if (backendType === 'opencode') {
    return getOpenCodeConversationHistory(sessionId);
  } else if (backendType === 'claude-code') {
    return getClaudeConversationHistory(workspacePath, sessionId);
  }

  // Auto-detect: Try Claude Code first, then OpenCode
  // Claude Code session IDs are UUIDs, OpenCode session IDs start with "ses_"
  if (sessionId.startsWith('ses_')) {
    console.log(`[ConversationParser] Auto-detected OpenCode session (ses_ prefix)`);
    return getOpenCodeConversationHistory(sessionId);
  }

  // Try Claude Code
  const claudeResult = await getClaudeConversationHistory(workspacePath, sessionId);
  if (claudeResult) {
    return claudeResult;
  }

  // Fall back to OpenCode
  console.log(`[ConversationParser] Claude Code lookup failed, trying OpenCode`);
  return getOpenCodeConversationHistory(sessionId);
}

/**
 * Get all session summaries for a workspace
 * Supports both Claude Code and OpenCode backends
 */
export async function getWorkspaceSessions(
  workspacePath: string,
  backendType?: BackendType,
): Promise<Array<{ sessionId: string; summary?: string; lastModified: Date }>> {
  console.log(
    `[ConversationParser] Getting sessions for workspace ${workspacePath}, backend: ${backendType || 'all'}`,
  );

  if (backendType === 'opencode') {
    return getOpenCodeWorkspaceSessions();
  } else if (backendType === 'claude-code') {
    return getClaudeWorkspaceSessions(workspacePath);
  }

  // Return sessions from both backends, sorted by lastModified
  const [claudeSessions, opencodeSessions] = await Promise.all([
    getClaudeWorkspaceSessions(workspacePath),
    getOpenCodeWorkspaceSessions(),
  ]);

  const allSessions = [...claudeSessions, ...opencodeSessions];
  allSessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

  return allSessions.slice(0, 50);
}

// ================== ConversationEvent emitters ==================
// Rich event timeline used by the React conversation view. Unlike
// `messages` (which collapses tool calls into nothing) and `activity`
// (which keeps only one-line labels), these events carry the FULL
// payload — markdown text, tool input objects, tool result content —
// so the UI can render per-tool widgets, syntax-highlighted code blocks,
// diffs, and ANSI bash output.

/** Stringify a tool_result content block (Claude returns it as either a
 *  bare string or an array of `{type: 'text', text}` parts). */
function stringifyToolResultContent(
  content: string | Array<{ type: string; text?: string }> | undefined,
): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content
    .map((p) => (p.type === 'text' && typeof p.text === 'string' ? p.text : ''))
    .join('');
}

/**
 * Walk one JSONL entry and emit zero or more `ConversationEvent`s. Mirrors
 * the order blocks appear in the message content array so the timeline is
 * chronological (text → thinking → tool_use within an assistant turn,
 * tool_result → text within a user turn). Designed to be invoked
 * line-by-line so the streamer can reuse it.
 */
export function eventsFromClaudeEntry(
  entry: ClaudeJsonlEntry,
  taskId: string,
): ConversationEvent[] {
  if (!entry.uuid) return [];
  const out: ConversationEvent[] = [];
  const baseUuid = entry.uuid;
  const ts = entry.timestamp || '';
  const sessionId = entry.sessionId || '';
  const parentUuid = entry.parentUuid;

  // Session summary lines (e.g. /compact result, file headers).
  if (entry.type === 'summary' && entry.summary) {
    out.push({
      uuid: baseUuid,
      taskId,
      sessionId,
      type: 'summary',
      timestamp: ts,
      parentUuid,
      text: entry.summary,
    });
    return out;
  }

  if (!entry.message) return out;
  const content = entry.message.content;

  // ── User turns: plain text OR tool_result blocks ──
  if (entry.type === 'user') {
    if (typeof content === 'string') {
      const text = content.trim();
      if (text) {
        out.push({
          uuid: baseUuid,
          taskId,
          sessionId,
          type: 'user_message',
          timestamp: ts,
          parentUuid,
          text,
        });
      }
      return out;
    }
    if (Array.isArray(content)) {
      for (let i = 0; i < content.length; i++) {
        const c = content[i];
        if (c.type === 'tool_result' && c.tool_use_id) {
          out.push({
            uuid: `${baseUuid}:r${i}`,
            taskId,
            sessionId,
            type: 'tool_result',
            timestamp: ts,
            parentUuid,
            toolResult: {
              toolUseId: c.tool_use_id,
              output: stringifyToolResultContent(c.content),
              isError: c.is_error === true,
            },
          });
        } else if (c.type === 'text' && c.text) {
          // Some user entries (e.g. local-command output, system reminders)
          // arrive as text blocks. Render them as user_message so the UI
          // shows them in the thread.
          const text = c.text.trim();
          if (text) {
            out.push({
              uuid: `${baseUuid}:t${i}`,
              taskId,
              sessionId,
              type: 'user_message',
              timestamp: ts,
              parentUuid,
              text,
            });
          }
        }
      }
    }
    return out;
  }

  // ── Assistant turns: text, thinking, tool_use blocks ──
  if (entry.type === 'assistant' && Array.isArray(content)) {
    for (let i = 0; i < content.length; i++) {
      const c = content[i];
      if (c.type === 'text' && c.text) {
        const text = c.text.trim();
        if (text) {
          out.push({
            uuid: `${baseUuid}:t${i}`,
            taskId,
            sessionId,
            type: 'assistant_message',
            timestamp: ts,
            parentUuid,
            text,
          });
        }
      } else if (c.type === 'thinking' && c.thinking) {
        const text = c.thinking.trim();
        if (text) {
          out.push({
            uuid: `${baseUuid}:th${i}`,
            taskId,
            sessionId,
            type: 'thinking',
            timestamp: ts,
            parentUuid,
            text,
          });
        }
      } else if (c.type === 'tool_use' && c.name && c.id) {
        out.push({
          uuid: `${baseUuid}:u${i}`,
          taskId,
          sessionId,
          type: 'tool_call',
          timestamp: ts,
          parentUuid,
          tool: {
            name: c.name,
            input: (c.input as Record<string, unknown>) || {},
            toolUseId: c.id,
          },
        });
      }
    }
  }

  // ── System / session_meta entries (forward-compat) ──
  // Claude Code sometimes emits non-message rows (e.g. file-history,
  // system). We don't want to lose them — pass through as 'system'.
  if (
    entry.type !== 'user' &&
    entry.type !== 'assistant' &&
    entry.type !== 'summary' &&
    entry.type
  ) {
    // Try to lift any string-ish payload onto `text` for display.
    const raw =
      typeof entry.message?.content === 'string' ? entry.message.content : undefined;
    out.push({
      uuid: baseUuid,
      taskId,
      sessionId,
      type: entry.type === 'session_meta' ? 'session_meta' : 'system',
      timestamp: ts,
      parentUuid,
      text: raw,
      meta: { rawType: entry.type },
    });
  }

  return out;
}

/**
 * Batch-parse a Claude Code JSONL file into ConversationEvents.
 * Used by REST cold-load + the streamer's initial snapshot read.
 */
async function parseClaudeEventsFromFile(
  filePath: string,
  taskId: string,
): Promise<ConversationEvent[]> {
  return new Promise((resolve, reject) => {
    const events: ConversationEvent[] = [];
    const seen = new Set<string>();
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let entry: ClaudeJsonlEntry;
      try {
        entry = JSON.parse(trimmed) as ClaudeJsonlEntry;
      } catch {
        return;
      }
      for (const ev of eventsFromClaudeEntry(entry, taskId)) {
        if (seen.has(ev.uuid)) continue;
        seen.add(ev.uuid);
        events.push(ev);
      }
    });

    rl.on('close', () => resolve(events));
    rl.on('error', reject);
  });
}

/** OpenCode → ConversationEvent[] adapter. We map message+part files
 *  into our canonical event shape. Tool-related parts are emitted as
 *  tool_call / tool_result so the same React widgets render. */
async function parseOpenCodeEvents(
  sessionId: string,
  taskId: string,
): Promise<ConversationEvent[]> {
  const storageDir = getOpenCodeStorageDir();
  const messageDir = path.join(storageDir, 'message', sessionId);
  if (!fs.existsSync(messageDir)) return [];

  const partDirCandidates = [
    path.join(storageDir, 'part', sessionId),
    path.join(storageDir, 'part', 'global'),
  ].filter((d) => fs.existsSync(d));

  type AnyPart = OpenCodePart & {
    tool?: string;
    state?: { input?: Record<string, unknown>; output?: string; status?: string };
    callID?: string;
    error?: string;
  };

  // Map messageId → parts (sorted by created time).
  const partsByMessage = new Map<string, AnyPart[]>();
  for (const dir of partDirCandidates) {
    for (const fname of fs.readdirSync(dir)) {
      if (!fname.endsWith('.json')) continue;
      try {
        const raw = fs.readFileSync(path.join(dir, fname), 'utf-8');
        const part = JSON.parse(raw) as AnyPart;
        if (!part?.messageID) continue;
        const arr = partsByMessage.get(part.messageID) ?? [];
        arr.push(part);
        partsByMessage.set(part.messageID, arr);
      } catch {
        /* skip */
      }
    }
  }

  const messages = fs
    .readdirSync(messageDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(messageDir, f), 'utf-8')) as OpenCodeMessage;
      } catch {
        return null;
      }
    })
    .filter((m): m is OpenCodeMessage => m !== null)
    .sort((a, b) => a.time.created - b.time.created);

  const events: ConversationEvent[] = [];
  for (const msg of messages) {
    const ts = new Date(msg.time.created).toISOString();
    const parts = (partsByMessage.get(msg.id) ?? []).sort(
      (a, b) => a.time.created - b.time.created,
    );

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const baseUuid = `${msg.id}:${i}`;
      switch (part.type) {
        case 'text':
          if (part.text) {
            events.push({
              uuid: baseUuid,
              taskId,
              sessionId,
              type: msg.role === 'user' ? 'user_message' : 'assistant_message',
              timestamp: ts,
              text: part.text,
            });
          }
          break;
        case 'thinking':
          if (part.thinking) {
            events.push({
              uuid: baseUuid,
              taskId,
              sessionId,
              type: 'thinking',
              timestamp: ts,
              text: part.thinking,
            });
          }
          break;
        case 'tool':
        case 'tool_invocation':
        case 'tool-invocation': {
          const toolUseId = part.callID || part.id;
          if (part.tool && toolUseId) {
            events.push({
              uuid: baseUuid,
              taskId,
              sessionId,
              type: 'tool_call',
              timestamp: ts,
              tool: {
                name: part.tool,
                input: part.state?.input ?? {},
                toolUseId,
              },
            });
            // OpenCode bundles result + input on the same part.
            if (part.state?.output != null || part.state?.status === 'completed') {
              events.push({
                uuid: `${baseUuid}:res`,
                taskId,
                sessionId,
                type: 'tool_result',
                timestamp: ts,
                toolResult: {
                  toolUseId,
                  output: part.state?.output ?? '',
                  isError: !!part.error,
                },
              });
            }
          }
          break;
        }
        default:
          // Forward-compat: unknown part types pass through as system.
          events.push({
            uuid: baseUuid,
            taskId,
            sessionId,
            type: 'system',
            timestamp: ts,
            text: part.text ?? '',
            meta: { rawType: part.type },
          });
      }
    }
  }
  return events;
}

/**
 * Public API: get the rich event stream for a session.
 *
 * Used by the conversation REST endpoint (cold load) and by the
 * `ConversationStreamer`'s initial snapshot before it begins tailing.
 */
export async function parseConversationEvents(
  workspacePath: string,
  sessionId: string,
  taskId: string,
  backendType?: BackendType,
): Promise<ConversationEvent[]> {
  if (backendType === 'opencode' || sessionId.startsWith('ses_')) {
    return parseOpenCodeEvents(sessionId, taskId);
  }
  const filePath = await findClaudeSessionFile(workspacePath, sessionId);
  if (!filePath) {
    // Fall back to OpenCode if the Claude file isn't there (matches
    // existing auto-detect behavior in getConversationHistory).
    if (!backendType) return parseOpenCodeEvents(sessionId, taskId);
    return [];
  }
  return parseClaudeEventsFromFile(filePath, taskId);
}

/** Resolve the Claude Code JSONL session file path for a workspace.
 *  Exported so the streamer can use the same resolution logic. */
export function getClaudeSessionFilePath(
  workspacePath: string,
  sessionId: string,
): string {
  return path.join(getClaudeProjectsDir(workspacePath), `${sessionId}.jsonl`);
}
