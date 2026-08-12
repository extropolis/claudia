/**
 * Slash command discovery.
 *
 * The terminal view gets slash-command autocomplete for free: keystrokes go to the
 * Claude Code TUI, which draws its own menu. The chat views (ChatView.tsx) send a
 * finished line to the PTY instead, so the user never sees that menu and has to
 * remember command names. This module enumerates the same command sources Claude Code
 * reads, so the chat composer can offer the same list.
 *
 * Sources, in the order Claude Code resolves them:
 *   - project commands   <workspace>/.claude/commands/**\/*.md      → /name
 *   - user commands      ~/.claude/commands/**\/*.md                → /name
 *   - project skills     <workspace>/.claude/skills/<name>/SKILL.md → /name
 *   - user skills        ~/.claude/skills/<name>/SKILL.md           → /name
 *   - plugin commands    ~/.claude/plugins/cache/<mp>/<plugin>/<ver>/commands/**\/*.md
 *                                                                   → /plugin:name
 *   - plugin skills      .../<ver>/skills/<name>/SKILL.md           → /plugin:name
 *   - built-ins          a static list of the common Claude Code commands
 *
 * Nested directories namespace a command the way Claude Code does: a file at
 * commands/git/review.md is invoked as /git:review.
 *
 * Results are cached per workspace for a short TTL — the composer refetches on every
 * open, and walking several directory trees on each keystroke would be wasteful.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from './logger.js';

const logger = createLogger('[SlashCommands]');

export interface SlashCommand {
    /** Invocation name without the leading slash, e.g. "review" or "cloudflare:wrangler". */
    name: string;
    /** One-line description from frontmatter, used as the menu subtitle. */
    description: string;
    /** Where it came from — shown as a small tag in the menu. */
    source: 'project' | 'user' | 'plugin' | 'builtin';
    /** Frontmatter argument-hint, e.g. "[pr-number]". */
    argumentHint?: string;
}

/** Commands Claude Code ships with. Not discoverable on disk, so listed explicitly. */
const BUILTIN_COMMANDS: Array<{ name: string; description: string; argumentHint?: string }> = [
    { name: 'clear', description: 'Clear conversation history and free up context' },
    { name: 'compact', description: 'Compact the conversation to reduce context usage', argumentHint: '[instructions]' },
    { name: 'context', description: 'Show a breakdown of current context usage' },
    { name: 'cost', description: 'Show token usage and cost for this session' },
    { name: 'help', description: 'Show available commands and usage help' },
    { name: 'init', description: 'Initialize a CLAUDE.md file with codebase documentation' },
    { name: 'mcp', description: 'Manage MCP server connections and authentication' },
    { name: 'memory', description: 'Edit CLAUDE.md memory files' },
    { name: 'model', description: 'Change the model for this session', argumentHint: '[model]' },
    { name: 'output-style', description: 'Change how Claude formats its responses' },
    { name: 'permissions', description: 'View and update tool permissions' },
    { name: 'review', description: 'Review a pull request', argumentHint: '[pr-number]' },
    { name: 'status', description: 'Show version, model, account and connectivity status' },
    { name: 'todos', description: 'List the current todo items' },
];

/** Parse the leading `---` YAML block. Only the few scalar keys we care about. */
function parseFrontmatter(text: string): Record<string, string> {
    if (!text.startsWith('---')) return {};
    const end = text.indexOf('\n---', 3);
    if (end === -1) return {};

    const out: Record<string, string> = {};
    for (const line of text.slice(3, end).split('\n')) {
        const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
        if (!match) continue;
        let value = match[2].trim();
        // Strip matching surrounding quotes: argument-hint is usually quoted.
        if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
            value = value.slice(1, -1);
        }
        out[match[1].toLowerCase()] = value;
    }
    return out;
}

/** First non-empty, non-heading line of the body — fallback when there's no description. */
function firstProseLine(text: string): string {
    let body = text;
    if (body.startsWith('---')) {
        const end = body.indexOf('\n---', 3);
        if (end !== -1) body = body.slice(end + 4);
    }
    for (const raw of body.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('---')) continue;
        return line.length > 160 ? `${line.slice(0, 160)}…` : line;
    }
    return '';
}

function readCommandFile(file: string): { description: string; argumentHint?: string } | null {
    try {
        // Command bodies can be long; the metadata we need is at the top.
        const text = fs.readFileSync(file, 'utf8').slice(0, 8192);
        const fm = parseFrontmatter(text);
        return {
            description: fm.description || firstProseLine(text),
            argumentHint: fm['argument-hint'] || undefined,
        };
    } catch {
        return null;
    }
}

/**
 * Walk a commands/ tree collecting *.md. Subdirectories namespace with ':' the way
 * Claude Code does, so commands/git/review.md becomes "git:review".
 */
function collectCommandDir(
    dir: string,
    source: SlashCommand['source'],
    prefix: string,
    out: SlashCommand[],
    depth = 0
): void {
    if (depth > 4) return;

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectCommandDir(full, source, `${prefix}${entry.name}:`, out, depth + 1);
            continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

        const meta = readCommandFile(full);
        if (!meta) continue;
        out.push({
            name: `${prefix}${entry.name.slice(0, -3)}`,
            description: meta.description,
            source,
            argumentHint: meta.argumentHint,
        });
    }
}

/** Collect skills/<name>/SKILL.md — each skill is invocable as /<name>. */
function collectSkillDir(dir: string, source: SlashCommand['source'], prefix: string, out: SlashCommand[]): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillFile = path.join(dir, entry.name, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;

        const meta = readCommandFile(skillFile);
        if (!meta) continue;
        out.push({
            name: `${prefix}${entry.name}`,
            description: meta.description,
            source,
            argumentHint: meta.argumentHint,
        });
    }
}

/**
 * Plugin commands live under the plugin cache as
 * ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/{commands,skills}.
 * They are invoked namespaced by plugin name: /cloudflare:wrangler.
 */
function collectPlugins(out: SlashCommand[]): void {
    const cacheRoot = path.join(os.homedir(), '.claude', 'plugins', 'cache');

    let marketplaces: fs.Dirent[];
    try {
        marketplaces = fs.readdirSync(cacheRoot, { withFileTypes: true });
    } catch {
        return;
    }

    for (const marketplace of marketplaces) {
        if (!marketplace.isDirectory()) continue;
        const mpDir = path.join(cacheRoot, marketplace.name);

        let plugins: fs.Dirent[];
        try {
            plugins = fs.readdirSync(mpDir, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const plugin of plugins) {
            if (!plugin.isDirectory()) continue;
            const pluginDir = path.join(mpDir, plugin.name);

            // One more level for the version directory ("1.0.0", "unknown", ...).
            let versions: fs.Dirent[];
            try {
                versions = fs.readdirSync(pluginDir, { withFileTypes: true });
            } catch {
                continue;
            }

            for (const version of versions) {
                if (!version.isDirectory()) continue;
                const root = path.join(pluginDir, version.name);
                collectCommandDir(path.join(root, 'commands'), 'plugin', `${plugin.name}:`, out);
                collectSkillDir(path.join(root, 'skills'), 'plugin', `${plugin.name}:`, out);
            }
        }
    }
}

interface CacheEntry {
    at: number;
    commands: SlashCommand[];
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

/**
 * Enumerate every slash command available to a task in `workspacePath`.
 *
 * Later sources never displace earlier ones: a project command shadows a user command
 * of the same name, matching Claude Code's own precedence.
 */
export function listSlashCommands(workspacePath?: string): SlashCommand[] {
    const key = workspacePath || '';
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.commands;

    const collected: SlashCommand[] = [];
    const home = os.homedir();

    if (workspacePath) {
        collectCommandDir(path.join(workspacePath, '.claude', 'commands'), 'project', '', collected);
        collectSkillDir(path.join(workspacePath, '.claude', 'skills'), 'project', '', collected);
    }
    collectCommandDir(path.join(home, '.claude', 'commands'), 'user', '', collected);
    collectSkillDir(path.join(home, '.claude', 'skills'), 'user', '', collected);
    collectPlugins(collected);

    for (const builtin of BUILTIN_COMMANDS) {
        collected.push({ ...builtin, source: 'builtin' });
    }

    // First writer wins, so project beats user beats plugin beats builtin.
    const byName = new Map<string, SlashCommand>();
    for (const cmd of collected) {
        if (!byName.has(cmd.name)) byName.set(cmd.name, cmd);
    }

    const commands = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
    cache.set(key, { at: Date.now(), commands });
    logger.debug('Discovered slash commands', { workspacePath: key || '(none)', count: commands.length });
    return commands;
}

/** Drop cached results — used by tests and after a command file is written. */
export function clearSlashCommandCache(): void {
    cache.clear();
}
