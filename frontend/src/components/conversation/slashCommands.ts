/**
 * Built-in Claude Code slash commands. Hardcoded for the MVP — Nimbalyst
 * scans `~/.claude/commands/` and `<workspace>/.claude/commands/` too, but
 * we'll add that in a follow-up. The current set covers everything Claude
 * Code's TUI shows when YOU type "/" inside it.
 */

export interface SlashCommand {
  /** Command name without the leading "/". */
  name: string;
  /** Short one-liner shown in the menu. */
  description: string;
  /** Optional argument hint, e.g. "[message]" — shown after the name. */
  argHint?: string;
  /** Source label for grouping (built-in for now). */
  section: 'Built-in';
}

export const BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
  { name: 'help',           description: 'Show help and available commands',                section: 'Built-in' },
  { name: 'clear',          description: 'Clear conversation history',                       section: 'Built-in' },
  { name: 'compact',        description: 'Summarize and clear older context',                section: 'Built-in', argHint: '[focus]' },
  { name: 'context',        description: 'Show current context window usage',                section: 'Built-in' },
  { name: 'cost',           description: 'Show session token cost',                          section: 'Built-in' },
  { name: 'init',           description: 'Generate a CLAUDE.md for this codebase',           section: 'Built-in' },
  { name: 'memory',         description: 'Edit Claude memory files',                         section: 'Built-in' },
  { name: 'model',          description: 'Switch the active model',                          section: 'Built-in', argHint: '[model]' },
  { name: 'review',         description: 'Code-review recent changes',                       section: 'Built-in' },
  { name: 'security-review',description: 'Security audit of recent changes',                 section: 'Built-in' },
  { name: 'pr-comments',    description: 'Address comments on the current PR',               section: 'Built-in' },
  { name: 'release-notes',  description: 'Generate release notes',                           section: 'Built-in' },
  { name: 'todos',          description: 'Show the current TodoWrite list',                  section: 'Built-in' },
  { name: 'diff',           description: 'Show working-tree diff',                           section: 'Built-in' },
  { name: 'status',         description: 'Show repo + session status',                       section: 'Built-in' },
  { name: 'mcp',            description: 'Manage MCP servers and authentication',            section: 'Built-in' },
  { name: 'resume',         description: 'Resume a recent session',                          section: 'Built-in' },
  { name: 'logout',         description: 'Sign out of Anthropic',                            section: 'Built-in' },
  { name: 'login',          description: 'Sign in to Anthropic',                             section: 'Built-in' },
];

/** Score a command against a query for fuzzy ranking. Higher = better. */
function scoreMatch(name: string, query: string): number {
  if (!query) return 1;
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  if (n === q) return 1000;
  if (n.startsWith(q)) return 500;
  // Word-boundary match (e.g. "sec" → "security-review").
  if (n.split(/[-_]/).some((part) => part.startsWith(q))) return 200;
  if (n.includes(q)) return 100;
  return 0;
}

/** Filter + rank the command list against a query. */
export function filterSlashCommands(
  query: string,
  commands: SlashCommand[] = BUILTIN_SLASH_COMMANDS,
): SlashCommand[] {
  if (!query) return commands.slice();
  const scored = commands
    .map((c) => ({ c, score: scoreMatch(c.name, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name));
  return scored.map((x) => x.c);
}
