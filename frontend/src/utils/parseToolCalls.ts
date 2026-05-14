/**
 * parseToolCalls.ts
 * Parses raw ANSI-stripped terminal output from Claude Code to identify
 * structured tool call blocks and text segments.
 *
 * Claude Code terminal output patterns:
 * - Tool calls appear with colored markers and structured text
 * - File paths appear in tool headers
 * - Bash commands show the command and output
 * - Edit/Write tools show file content
 */

export type ToolCallType =
  | 'bash'
  | 'read'
  | 'write'
  | 'edit'
  | 'search'
  | 'fetch'
  | 'thinking'
  | 'text'
  | 'result';

export interface ToolCall {
  id: string;
  type: ToolCallType;
  // Common fields
  filePath?: string;
  // Bash-specific
  command?: string;
  output?: string;
  exitCode?: number;
  // Edit-specific
  oldString?: string;
  newString?: string;
  // Write-specific
  content?: string;
  // Search-specific
  query?: string;
  url?: string;
  // Text/thinking content
  text?: string;
  // Whether this tool call is still streaming (partial)
  isPartial?: boolean;
  // Duration if available
  duration?: string;
}

export interface ParsedSegment {
  type: 'tool' | 'text';
  tool?: ToolCall;
  text?: string;
}

// Strip ANSI escape sequences from text
export function stripAnsi(str: string): string {
   
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '') // OSC sequences
    .replace(/\x1b[()][A-Z0-9]/g, '') // Character set selection
    .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, '') // Private mode sequences
    .replace(/\x1b[>=]/g, '') // Keypad mode
    .replace(/\r/g, ''); // Carriage returns
}

// Generate unique IDs for tool calls
let idCounter = 0;
function genId(): string {
  return `tc-${++idCounter}-${Date.now()}`;
}

/**
 * Parse raw terminal output into structured segments.
 * This handles the typical Claude Code output patterns where tool calls
 * are displayed with specific formatting.
 */
export function parseToolCalls(rawOutput: string): ParsedSegment[] {
  const stripped = stripAnsi(rawOutput);
  const lines = stripped.split('\n');
  const segments: ParsedSegment[] = [];

  let i = 0;
  let textBuffer = '';

  const flushText = () => {
    if (textBuffer.trim()) {
      segments.push({ type: 'text', text: textBuffer.trim() });
    }
    textBuffer = '';
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect Bash/command tool calls
    // Patterns: "$ command", "❯ command", "> command" after a tool marker
    // Or explicit markers like "⏺ Bash(command)" or similar
    const bashExplicitMatch = trimmed.match(
      /^[⏺●◉○▶►]?\s*(?:Bash|bash|Run|Execute)\s*[:(]\s*(.+?)\s*\)?$/i,
    );
    if (bashExplicitMatch) {
      flushText();
      const command = bashExplicitMatch[1];
      // Collect output lines until next tool or end
      const outputLines: string[] = [];
      i++;
      while (i < lines.length) {
        const nextLine = lines[i];
        const nextTrimmed = nextLine.trim();
        // Stop at next tool marker or section divider
        if (isToolMarker(nextTrimmed) || isSectionDivider(nextTrimmed)) break;
        outputLines.push(nextLine);
        i++;
      }
      segments.push({
        type: 'tool',
        tool: {
          id: genId(),
          type: 'bash',
          command,
          output: outputLines.join('\n').trim() || undefined,
        },
      });
      continue;
    }

    // Detect "$ command" pattern (common in Claude Code output)
    const shellPromptMatch = trimmed.match(/^\$\s+(.+)$/);
    if (shellPromptMatch && !trimmed.startsWith('$HOME') && !trimmed.startsWith('${')) {
      flushText();
      const command = shellPromptMatch[1];
      const outputLines: string[] = [];
      i++;
      while (i < lines.length) {
        const nextLine = lines[i];
        const nextTrimmed = nextLine.trim();
        if (isToolMarker(nextTrimmed) || isSectionDivider(nextTrimmed)) break;
        if (nextTrimmed.match(/^\$\s+/)) break; // Next command
        outputLines.push(nextLine);
        i++;
      }
      segments.push({
        type: 'tool',
        tool: {
          id: genId(),
          type: 'bash',
          command,
          output: outputLines.join('\n').trim() || undefined,
        },
      });
      continue;
    }

    // Detect Read tool
    const readMatch = trimmed.match(/^[⏺●◉○▶►]?\s*(?:Read|read|Reading)\s*[:(]\s*(.+?)\s*\)?$/i);
    if (readMatch) {
      flushText();
      segments.push({
        type: 'tool',
        tool: {
          id: genId(),
          type: 'read',
          filePath: readMatch[1],
        },
      });
      i++;
      // Skip content lines until next tool
      while (
        i < lines.length &&
        !isToolMarker(lines[i].trim()) &&
        !isSectionDivider(lines[i].trim())
      ) {
        i++;
      }
      continue;
    }

    // Detect Write tool
    const writeMatch = trimmed.match(
      /^[⏺●◉○▶►]?\s*(?:Write|write|Writing|Wrote)\s*[:(]\s*(.+?)\s*\)?$/i,
    );
    if (writeMatch) {
      flushText();
      const filePath = writeMatch[1];
      const contentLines: string[] = [];
      i++;
      while (i < lines.length) {
        const nextTrimmed = lines[i].trim();
        if (isToolMarker(nextTrimmed) || isSectionDivider(nextTrimmed)) break;
        contentLines.push(lines[i]);
        i++;
      }
      segments.push({
        type: 'tool',
        tool: {
          id: genId(),
          type: 'write',
          filePath,
          content: contentLines.join('\n').trim() || undefined,
        },
      });
      continue;
    }

    // Detect Edit tool
    const editMatch = trimmed.match(
      /^[⏺●◉○▶►]?\s*(?:Edit|edit|Editing|Edited)\s*[:(]\s*(.+?)\s*\)?$/i,
    );
    if (editMatch) {
      flushText();
      const filePath = editMatch[1];
      const diffLines: string[] = [];
      i++;
      while (i < lines.length) {
        const nextTrimmed = lines[i].trim();
        if (isToolMarker(nextTrimmed) || isSectionDivider(nextTrimmed)) break;
        diffLines.push(lines[i]);
        i++;
      }
      // Parse diff content for old/new strings
      const { oldString, newString } = parseDiffContent(diffLines);
      segments.push({
        type: 'tool',
        tool: {
          id: genId(),
          type: 'edit',
          filePath,
          oldString,
          newString,
          content: diffLines.join('\n').trim() || undefined,
        },
      });
      continue;
    }

    // Detect WebSearch/WebFetch
    const searchMatch = trimmed.match(
      /^[⏺●◉○▶►]?\s*(?:WebSearch|Search|Searching|WebFetch|Fetch|Fetching)\s*[:(]\s*(.+?)\s*\)?$/i,
    );
    if (searchMatch) {
      flushText();
      const queryOrUrl = searchMatch[1];
      const isUrl = queryOrUrl.startsWith('http');
      const resultLines: string[] = [];
      i++;
      while (i < lines.length) {
        const nextTrimmed = lines[i].trim();
        if (isToolMarker(nextTrimmed) || isSectionDivider(nextTrimmed)) break;
        resultLines.push(lines[i]);
        i++;
      }
      segments.push({
        type: 'tool',
        tool: {
          id: genId(),
          type: isUrl ? 'fetch' : 'search',
          query: isUrl ? undefined : queryOrUrl,
          url: isUrl ? queryOrUrl : undefined,
          output: resultLines.join('\n').trim() || undefined,
        },
      });
      continue;
    }

    // Detect thinking blocks
    const thinkingMatch = trimmed.match(/^[⏺●◉○▶►]?\s*(?:Thinking|thinking|💭)\s*\.{0,3}$/i);
    if (thinkingMatch) {
      flushText();
      const thinkingLines: string[] = [];
      i++;
      while (i < lines.length) {
        const nextTrimmed = lines[i].trim();
        if (isToolMarker(nextTrimmed) || isSectionDivider(nextTrimmed)) break;
        thinkingLines.push(lines[i]);
        i++;
      }
      segments.push({
        type: 'tool',
        tool: {
          id: genId(),
          type: 'thinking',
          text: thinkingLines.join('\n').trim() || undefined,
        },
      });
      continue;
    }

    // Detect result/output markers
    const resultMatch = trimmed.match(/^[⏺●◉○▶►]?\s*(?:Result|Output|✓|✔|⚡)\s*[:(]?\s*(.*)$/i);
    if (resultMatch && resultMatch[1]) {
      flushText();
      const resultLines: string[] = [resultMatch[1]];
      i++;
      while (i < lines.length) {
        const nextTrimmed = lines[i].trim();
        if (isToolMarker(nextTrimmed) || isSectionDivider(nextTrimmed)) break;
        resultLines.push(lines[i]);
        i++;
      }
      segments.push({
        type: 'tool',
        tool: {
          id: genId(),
          type: 'result',
          text: resultLines.join('\n').trim(),
        },
      });
      continue;
    }

    // Not a tool call - accumulate as text
    textBuffer += line + '\n';
    i++;
  }

  flushText();
  return segments;
}

/**
 * Check if a line looks like a tool call marker
 */
function isToolMarker(line: string): boolean {
  if (!line) return false;
  return (
    /^[⏺●◉○▶►]?\s*(?:Bash|Read|Write|Edit|WebSearch|Search|WebFetch|Fetch|Thinking|Result|Output|Run|Execute|Reading|Writing|Editing|Searching|Fetching|Wrote|Edited)\s*[:(]/i.test(
      line,
    ) || /^\$\s+\S/.test(line)
  );
}

/**
 * Check if a line is a section divider (horizontal rules, separators)
 */
function isSectionDivider(line: string): boolean {
  if (!line) return false;
  // Lines of dashes, equals, or unicode box-drawing
  return /^[-=─━═]{3,}$/.test(line.trim()) || /^[╌┄┈]{3,}$/.test(line.trim());
}

/**
 * Parse diff-style content to extract old and new strings
 */
function parseDiffContent(lines: string[]): { oldString?: string; newString?: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let inOld = false;
  let inNew = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('---') || trimmed.startsWith('- ') || trimmed.startsWith('-\t')) {
      inOld = true;
      inNew = false;
      oldLines.push(
        trimmed.startsWith('- ')
          ? trimmed.slice(2)
          : trimmed.startsWith('-\t')
            ? trimmed.slice(2)
            : '',
      );
    } else if (trimmed.startsWith('+++') || trimmed.startsWith('+ ') || trimmed.startsWith('+\t')) {
      inNew = true;
      inOld = false;
      newLines.push(
        trimmed.startsWith('+ ')
          ? trimmed.slice(2)
          : trimmed.startsWith('+\t')
            ? trimmed.slice(2)
            : '',
      );
    } else if (trimmed.startsWith('-')) {
      if (inOld || !inNew) {
        oldLines.push(trimmed.slice(1));
        inOld = true;
      }
    } else if (trimmed.startsWith('+')) {
      if (inNew || !inOld) {
        newLines.push(trimmed.slice(1));
        inNew = true;
      }
    }
  }

  return {
    oldString: oldLines.length > 0 ? oldLines.join('\n') : undefined,
    newString: newLines.length > 0 ? newLines.join('\n') : undefined,
  };
}

/**
 * Incrementally parse output - useful for streaming.
 * Returns segments from new content appended to existing parsed state.
 */
export function parseIncremental(
  _existingSegments: ParsedSegment[],
  _newRawChunk: string,
  fullBuffer: string,
): ParsedSegment[] {
  // For simplicity, re-parse the full buffer each time.
  // This is acceptable because we limit the buffer size and
  // the parsing is fast (string matching, no regex backtracking).
  return parseToolCalls(fullBuffer);
}
