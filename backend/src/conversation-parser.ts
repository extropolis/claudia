import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { BackendType } from '@claudia/shared';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  uuid: string;
  thinking?: string;
}

export interface ParsedConversation {
  sessionId: string;
  messages: ConversationMessage[];
  summary?: string;
}

// Claude Code JSONL entry format
interface ClaudeJsonlEntry {
  type: string;
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
  sessionId?: string;
  summary?: string;
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string; thinking?: string }>;
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
  content: string | Array<{ type: string; text?: string; thinking?: string }>,
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
 * Parse a Claude Code JSONL conversation file
 */
async function parseClaudeConversationFile(filePath: string): Promise<ParsedConversation> {
  return new Promise((resolve, reject) => {
    const messages: ConversationMessage[] = [];
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
