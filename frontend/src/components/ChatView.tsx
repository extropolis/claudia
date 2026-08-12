/**
 * ChatView — a rich, Claude-app-style rendering of a task's conversation.
 *
 * An alternative to TerminalView. Where TerminalView renders the raw ANSI of the
 * Claude Code TUI through xterm.js, this renders the *structured* transcript that
 * Claude Code writes to ~/.claude/projects/<slug>/<session>.jsonl: assistant text as
 * markdown, thinking as a collapsible block, and each tool call as a card with its
 * input and result.
 *
 * Data flow: an initial HTTP fetch of /api/tasks/:id/session-events seeds the list,
 * then a `task:sessionEvents:subscribe` WS message asks the backend to tail the file
 * and push appended events. Events are merged by id so a tool card created by an
 * earlier poll is patched in place when its result lands.
 *
 * Input still goes through `task:input` to the PTY — this view is a read-side
 * replacement only, so permission prompts and other TUI interactions continue to
 * work exactly as before (the user can flip back to the terminal for those).
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
// GFM gives us tables, strikethrough and task lists — Claude's replies use tables
// heavily, and without this plugin they render as raw pipe characters.
import remarkGfm from 'remark-gfm';
import {
    ChevronRight, Terminal as TerminalIcon, FileText, Pencil, Search, Globe,
    Wrench, Brain, AlertTriangle, Send, ArrowDown, Loader2,
} from 'lucide-react';
import type { Task, SessionEvent, SessionToolEvent, SessionSummary, SlashCommand } from '@claudia/shared';
import { getApiBaseUrl } from '../config/api-config';
import { sendWsMessage } from '../hooks/useWebSocket';
import './ChatView.css';

interface ChatViewProps {
    task: Task;
    /** Workspace root, used only for display. */
    workspaceName?: string;
    /** 'detailed' renders every event; 'minimal' renders quiet status lines. */
    mode?: 'detailed' | 'minimal';
}

/** Map a tool name to an icon. MCP tools are namespaced mcp__server__tool. */
function toolIcon(name: string) {
    const n = name.toLowerCase();
    if (n.startsWith('mcp__')) return <Globe size={14} />;
    if (n.includes('bash') || n.includes('shell')) return <TerminalIcon size={14} />;
    if (n.includes('read') || n.includes('notebook')) return <FileText size={14} />;
    if (n.includes('edit') || n.includes('write')) return <Pencil size={14} />;
    if (n.includes('grep') || n.includes('glob') || n.includes('search')) return <Search size={14} />;
    return <Wrench size={14} />;
}

/** "mcp__chrome-devtools__take_screenshot" → "chrome-devtools: take screenshot" */
function prettyToolName(name: string): string {
    if (!name.startsWith('mcp__')) return name;
    const parts = name.slice(5).split('__');
    if (parts.length < 2) return name;
    return `${parts[0]}: ${parts.slice(1).join(' ').replace(/_/g, ' ')}`;
}

/**
 * A one-line summary of what a tool call is doing, shown next to the tool name so
 * the transcript is scannable without expanding every card.
 */
function toolSummary(tool: SessionToolEvent): string {
    const input = tool.input || {};
    const pick = (...keys: string[]): string | undefined => {
        for (const k of keys) {
            const v = input[k];
            if (typeof v === 'string' && v.trim()) return v;
        }
        return undefined;
    };

    const direct = pick('command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'description');
    if (direct) return direct.length > 140 ? `${direct.slice(0, 140)}…` : direct;

    const keys = Object.keys(input);
    if (keys.length === 0) return '';
    try {
        const s = JSON.stringify(input);
        return s.length > 140 ? `${s.slice(0, 140)}…` : s;
    } catch {
        return keys.join(', ');
    }
}

/**
 * Past-tense verb for the quiet one-line tool row in minimal mode, e.g.
 * "Read src/foo.ts", "Ran npm test", "Searched for TODO".
 */
function toolVerb(name: string): string {
    const n = name.toLowerCase();
    if (n.startsWith('mcp__')) return prettyToolName(name);
    if (n.includes('bash') || n.includes('shell')) return 'Ran';
    if (n === 'read' || n.includes('notebookread')) return 'Read';
    if (n.includes('write')) return 'Created';
    if (n.includes('edit')) return 'Edited';
    if (n.includes('grep') || n.includes('search')) return 'Searched';
    if (n.includes('glob')) return 'Listed';
    if (n.includes('webfetch') || n.includes('fetch')) return 'Fetched';
    if (n.includes('task') || n.includes('agent')) return 'Delegated';
    return name;
}

/** Show the basename for paths so rows stay short; keep other targets as-is. */
function shortTarget(tool: SessionToolEvent): string {
    const input = tool.input || {};
    const path = input.file_path ?? input.path;
    if (typeof path === 'string' && path.trim()) {
        const parts = path.split('/').filter(Boolean);
        return parts.length > 2 ? parts.slice(-2).join('/') : path;
    }
    // Commands are code — minimal mode names the program, never the full invocation.
    const command = input.command;
    if (typeof command === 'string' && command.trim()) {
        const first = command.trim().split(/\s+/)[0].split('/').pop() || '';
        // `git commit -m "..."` reads better as "git commit" than bare "git".
        const second = command.trim().split(/\s+/)[1];
        const isSubcommand = second && /^[a-z][a-z-]*$/.test(second);
        return isSubcommand ? `${first} ${second}` : first;
    }

    for (const k of ['pattern', 'query', 'url', 'description']) {
        const v = input[k];
        if (typeof v === 'string' && v.trim()) {
            return v.length > 48 ? `${v.slice(0, 48)}…` : v;
        }
    }
    return '';
}

/**
 * Strip markdown to plain prose and keep the first sentence or two.
 * Minimal mode shows the lead-in, not the whole explanation.
 */
function leadSentences(md: string, max = 2): string {
    const plain = md
        // Tool-call envelopes and notification blocks sometimes land in assistant text.
        // They are machine payloads, not prose — drop them before summarizing.
        .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, ' ')
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
        .replace(/<\/?[a-z][a-z0-9-]*>/gi, ' ')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/^\s*\|.*\|\s*$/gm, ' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
    if (!plain) return '';

    // Split on sentence-ending punctuation followed by whitespace + a capital/quote.
    // A bare /[.!?]/ split breaks on filenames (settings.local.json), version numbers
    // (v1.2.3) and abbreviations, which silently truncates the first sentence.
    const sentences: string[] = [];
    let start = 0;
    for (let i = 0; i < plain.length; i++) {
        const ch = plain[i];
        if (ch !== '.' && ch !== '!' && ch !== '?') continue;
        // Consume runs like "?!" or "..."
        let end = i;
        while (end + 1 < plain.length && '.!?'.includes(plain[end + 1])) end++;
        const next = plain[end + 1];
        const after = plain[end + 2];
        // Sentence break only when followed by a space and then a capital letter,
        // digit, or opening quote — i.e. the start of a new sentence.
        if (next === undefined) {
            sentences.push(plain.slice(start));
            start = plain.length;
            break;
        }
        if (/\s/.test(next) && after !== undefined && /[A-Z0-9"'“‘(]/.test(after)) {
            sentences.push(plain.slice(start, end + 1));
            start = end + 2;
            i = end + 1;
        } else {
            i = end;
        }
    }
    if (start < plain.length) sentences.push(plain.slice(start));

    const picked = sentences.map((x) => x.trim()).filter(Boolean).slice(0, max).join(' ').trim();
    return picked || plain;
}

/**
 * Extract the slash-command query being typed, or null if the caret isn't in one.
 *
 * The menu should open on a slash that starts a command — at the very beginning of the
 * input, or at the start of a line — but not on a slash inside prose or a path
 * ("see src/foo.ts"). Only the text before the caret matters, so editing a command
 * mid-message still filters correctly.
 */
export function slashQueryAt(text: string, caret: number): string | null {
    const before = text.slice(0, caret);
    const lineStart = before.lastIndexOf('\n') + 1;
    const line = before.slice(lineStart);
    if (!line.startsWith('/')) return null;

    const query = line.slice(1);
    // A space ends the command name — past that the user is typing arguments.
    if (/\s/.test(query)) return null;
    return query;
}

/**
 * Rank commands against a query. Prefix matches come first so typing "a" lists the
 * commands starting with "a" before ones that merely contain it; an empty query lists
 * everything. Matching is case-insensitive and ignores the namespace separator so
 * "wrangler" still finds "cloudflare:wrangler".
 */
export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
    const q = query.toLowerCase();
    if (!q) return commands;

    const scored: Array<{ cmd: SlashCommand; rank: number }> = [];
    for (const cmd of commands) {
        const name = cmd.name.toLowerCase();
        if (name.startsWith(q)) {
            scored.push({ cmd, rank: 0 });
            continue;
        }
        // "wrangler" should match "cloudflare:wrangler" — try the un-namespaced tail.
        const tail = name.slice(name.indexOf(':') + 1);
        if (name.includes(':') && tail.startsWith(q)) {
            scored.push({ cmd, rank: 1 });
            continue;
        }
        // Substring matches only at a word boundary. A bare `includes` makes a
        // one-letter query like "/a" match half the list ("cloudflare", "compact"),
        // which buries the commands that actually start with "a".
        if (name.split(/[-:_]/).some((word) => word.startsWith(q))) {
            scored.push({ cmd, rank: 2 });
        }
    }

    return scored
        .sort((a, b) => a.rank - b.rank || a.cmd.name.localeCompare(b.cmd.name))
        .map((s) => s.cmd);
}

/** One quiet, borderless line describing a tool call. Mirrors the Claude app. */
function MinimalToolRow({ tool }: { tool: SessionToolEvent }) {
    const target = shortTarget(tool);
    const running = tool.result === undefined;
    return (
        <div className={`cv-min-tool ${tool.isError ? 'is-error' : ''}`}>
            <span className="cv-min-verb">{toolVerb(tool.name || 'tool')}</span>
            {target && <span className="cv-min-target">{target}</span>}
            {running && <Loader2 size={11} className="cv-spin cv-min-spin" />}
            {tool.isError && <span className="cv-min-failed">failed</span>}
        </div>
    );
}

function ToolCard({ tool }: { tool: SessionToolEvent }) {
    const [expanded, setExpanded] = useState(false);
    const running = tool.result === undefined;
    const summary = toolSummary(tool);

    const inputText = useMemo(() => {
        try {
            return JSON.stringify(tool.input, null, 2);
        } catch {
            return String(tool.input);
        }
    }, [tool.input]);

    return (
        <div className={`cv-tool ${tool.isError ? 'is-error' : ''} ${running ? 'is-running' : ''}`}>
            <button
                className="cv-tool-header"
                onClick={() => setExpanded((e) => !e)}
                aria-expanded={expanded}
            >
                <ChevronRight size={14} className={`cv-chevron ${expanded ? 'open' : ''}`} />
                <span className="cv-tool-icon">{toolIcon(tool.name)}</span>
                <span className="cv-tool-name">{prettyToolName(tool.name) || 'tool'}</span>
                {summary && <span className="cv-tool-summary">{summary}</span>}
                {running && <Loader2 size={13} className="cv-spin cv-tool-status" />}
                {tool.isError && <AlertTriangle size={13} className="cv-tool-status cv-error-icon" />}
            </button>

            {expanded && (
                <div className="cv-tool-body">
                    {Object.keys(tool.input || {}).length > 0 && (
                        <>
                            <div className="cv-tool-label">Input</div>
                            <pre className="cv-code">{inputText}</pre>
                        </>
                    )}
                    <div className="cv-tool-label">{tool.isError ? 'Error' : 'Result'}</div>
                    <pre className="cv-code">{running ? 'Running…' : (tool.result || '(no output)')}</pre>
                </div>
            )}
        </div>
    );
}

function ThinkingBlock({ text }: { text: string }) {
    const [expanded, setExpanded] = useState(false);
    return (
        <div className="cv-thinking">
            <button className="cv-thinking-header" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
                <ChevronRight size={14} className={`cv-chevron ${expanded ? 'open' : ''}`} />
                <Brain size={14} />
                <span>Thinking</span>
            </button>
            {expanded && <div className="cv-thinking-body">{text}</div>}
        </div>
    );
}

export function ChatView({ task, workspaceName, mode = 'detailed' }: ChatViewProps) {
    const minimal = mode === 'minimal';
    const [events, setEvents] = useState<SessionEvent[]>([]);
    const [summaries, setSummaries] = useState<SessionSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [pending, setPending] = useState(false);
    const [input, setInput] = useState('');
    const [atBottom, setAtBottom] = useState(true);

    // Slash-command autocomplete. The terminal view gets this from the Claude Code TUI;
    // here the composer has to draw its own menu.
    const [commands, setCommands] = useState<SlashCommand[]>([]);
    const [slashQuery, setSlashQuery] = useState<string | null>(null);
    const [slashIndex, setSlashIndex] = useState(0);

    const scrollRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const offsetRef = useRef(0);
    const taskIdRef = useRef(task.id);
    // Mirrors `atBottom` for the scroll effect. Reading state there would make the
    // effect re-run on every toggle and yank the user back down mid-scroll.
    const atBottomRef = useRef(true);

    /**
     * Merge appended events into the list. Tool results arrive as a separate event
     * carrying the same id as the original tool_use, so patch in place rather than
     * appending a duplicate card.
     */
    const mergeEvents = useCallback((incoming: SessionEvent[]) => {
        if (incoming.length === 0) return;
        setEvents((prev) => {
            const next = prev.slice();
            const indexById = new Map<string, number>();
            next.forEach((e, i) => indexById.set(e.id, i));

            for (const ev of incoming) {
                const existingIdx = indexById.get(ev.id);
                if (existingIdx !== undefined && ev.type === 'tool' && next[existingIdx].type === 'tool') {
                    const prevTool = next[existingIdx] as SessionToolEvent;
                    next[existingIdx] = {
                        ...prevTool,
                        // A result-only stub carries an empty name; keep the original.
                        name: ev.name || prevTool.name,
                        input: Object.keys(ev.input || {}).length ? ev.input : prevTool.input,
                        result: ev.result !== undefined ? ev.result : prevTool.result,
                        isError: ev.isError ?? prevTool.isError,
                    };
                } else if (existingIdx === undefined) {
                    indexById.set(ev.id, next.length);
                    next.push(ev);
                }
            }
            return next;
        });
    }, []);

    // Initial load + live subscription. Re-runs when the task changes.
    useEffect(() => {
        let cancelled = false;
        taskIdRef.current = task.id;
        offsetRef.current = 0;
        atBottomRef.current = true;
        setAtBottom(true);
        setEvents([]);
        setSummaries([]);
        setLoading(true);
        setPending(false);

        (async () => {
            try {
                const res = await fetch(`${getApiBaseUrl()}/api/tasks/${task.id}/session-events`);
                if (cancelled) return;
                if (!res.ok) {
                    setLoading(false);
                    return;
                }
                const data = await res.json();
                if (cancelled) return;

                offsetRef.current = data.offset || 0;
                setPending(Boolean(data.pending));
                setEvents(data.events || []);
                setLoading(false);

                sendWsMessage('task:sessionEvents:subscribe', { taskId: task.id, offset: offsetRef.current, summarize: minimal });
            } catch {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
            sendWsMessage('task:sessionEvents:unsubscribe', { taskId: task.id });
        };
    }, [task.id, minimal]);

    // Live events pushed by the backend tailer.
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail as {
                taskId: string; events: SessionEvent[]; offset: number;
            };
            if (detail.taskId !== taskIdRef.current) return;
            offsetRef.current = detail.offset;
            if (detail.events?.length) {
                setPending(false);
                mergeEvents(detail.events);
            }
        };
        window.addEventListener('claudia:sessionEvents', handler);
        return () => window.removeEventListener('claudia:sessionEvents', handler);
    }, [mergeEvents]);

    // Batched LLM status lines for the minimal view. Merged by id so a reconnect that
    // re-seeds existing summaries can't duplicate them.
    useEffect(() => {
        if (!minimal) return;
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail as { taskId: string; summaries: SessionSummary[] };
            if (detail.taskId !== taskIdRef.current || !detail.summaries?.length) return;
            setSummaries((prev) => {
                const seen = new Set(prev.map((x) => x.id));
                const added = detail.summaries.filter((x) => !seen.has(x.id));
                return added.length ? [...prev, ...added] : prev;
            });
        };
        window.addEventListener('claudia:sessionSummary', handler);
        return () => window.removeEventListener('claudia:sessionSummary', handler);
    }, [minimal]);

    // The session id is captured asynchronously after spawn, so a brand-new task has
    // no transcript yet. Retry until the file appears.
    useEffect(() => {
        if (!pending) return;
        const timer = setInterval(async () => {
            try {
                const res = await fetch(`${getApiBaseUrl()}/api/tasks/${task.id}/session-events`);
                if (!res.ok) return;
                const data = await res.json();
                if (data.pending) return;
                offsetRef.current = data.offset || 0;
                setPending(false);
                setEvents(data.events || []);
                sendWsMessage('task:sessionEvents:subscribe', { taskId: task.id, offset: offsetRef.current, summarize: minimal });
            } catch {
                /* keep retrying */
            }
        }, 1500);
        return () => clearInterval(timer);
    }, [pending, task.id]);

    // Follow the tail unless the user has scrolled up to read history. Depends only on
    // `events` — including `atBottom` would re-fire this when the user scrolls away.
    useEffect(() => {
        if (!atBottomRef.current) return;
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [events]);

    const handleScroll = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
        const nowAtBottom = distance < 80;
        atBottomRef.current = nowAtBottom;
        setAtBottom((prev) => (prev === nowAtBottom ? prev : nowAtBottom));
    }, []);

    const jumpToBottom = useCallback(() => {
        atBottomRef.current = true;
        setAtBottom(true);
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, []);

    // Load the command list once per task. Cheap and cached server-side, so this can
    // run on mount rather than on the first '/' — the menu then opens with no latency.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`${getApiBaseUrl()}/api/slash-commands?taskId=${encodeURIComponent(task.id)}`);
                if (!res.ok || cancelled) return;
                const data = await res.json();
                if (!cancelled) setCommands(data.commands || []);
            } catch {
                /* autocomplete is a convenience — a failure just means no menu */
            }
        })();
        return () => { cancelled = true; };
    }, [task.id]);

    const matches = useMemo(
        () => (slashQuery === null ? [] : filterSlashCommands(commands, slashQuery)),
        [commands, slashQuery]
    );
    const menuOpen = slashQuery !== null && matches.length > 0;

    /** Recompute the open/closed state of the menu from the caret position. */
    const syncSlashState = useCallback((text: string, caret: number) => {
        const query = slashQueryAt(text, caret);
        setSlashQuery(query);
        setSlashIndex(0);
    }, []);

    // Keep the highlighted row scrolled into view when arrowing past the visible window.
    useEffect(() => {
        if (!menuOpen) return;
        const el = menuRef.current?.querySelector<HTMLElement>('.cv-slash-item.is-active');
        el?.scrollIntoView({ block: 'nearest' });
    }, [menuOpen, slashIndex]);

    /** Replace the partial command under the caret with the chosen one. */
    const applyCommand = useCallback((cmd: SlashCommand) => {
        const el = inputRef.current;
        const caret = el ? el.selectionStart : input.length;
        const before = input.slice(0, caret);
        const lineStart = before.lastIndexOf('\n') + 1;
        // Trailing space so the user can type arguments straight away.
        const next = `${input.slice(0, lineStart)}/${cmd.name} ${input.slice(caret)}`;
        const nextCaret = lineStart + cmd.name.length + 2;

        setInput(next);
        setSlashQuery(null);
        setSlashIndex(0);
        // Restore focus and put the caret after the inserted command, not at the end.
        requestAnimationFrame(() => {
            const node = inputRef.current;
            if (!node) return;
            node.focus();
            node.setSelectionRange(nextCaret, nextCaret);
        });
    }, [input]);

    const send = useCallback(() => {
        const text = input.trim();
        if (!text) return;
        // Route through the PTY exactly as the terminal does, so all the existing
        // delivery logic (bracketed paste, ready-detection, reconnect) applies.
        sendWsMessage('task:input', { taskId: task.id, input: `${text}\r` });
        setInput('');
        setSlashQuery(null);
        atBottomRef.current = true;
        setAtBottom(true);
    }, [input, task.id]);

    const isBusy = task.state === 'busy' || task.state === 'starting';

    /**
     * Summaries are keyed `sum-<lastEventIdOfBatch>` so they can render inline after the
     * events they describe. An anchor only resolves if that event is actually rendered;
     * anything left over is shown at the end of the thread rather than dropped.
     */
    const { anchoredSummaries, anchoredIds } = useMemo(() => {
        const byEventId = new Map<string, SessionSummary>();
        const ids = new Set<string>();
        if (minimal) {
            const eventIds = new Set(events.map((e) => e.id));
            for (const sm of summaries) {
                const eventId = sm.id.startsWith('sum-') ? sm.id.slice(4) : '';
                if (eventId && eventIds.has(eventId)) {
                    byEventId.set(eventId, sm);
                    ids.add(sm.id);
                }
            }
        }
        return { anchoredSummaries: byEventId, anchoredIds: ids };
    }, [minimal, events, summaries]);

    return (
        <div className={`cv-root${minimal ? ' minimal' : ''}`}>
            <div className={`cv-header${minimal ? ' minimal' : ''}`}>
                <div className="cv-header-title">{task.displayName || task.prompt}</div>
                {/* The workspace is already obvious from the sidebar; in minimal mode
                    the extra line is just height. */}
                {workspaceName && !minimal && <div className="cv-header-sub">{workspaceName}</div>}
            </div>

            <div className="cv-scroll" ref={scrollRef} onScroll={handleScroll}>
                <div className="cv-thread">
                    {loading && <div className="cv-empty">Loading conversation…</div>}

                    {!loading && pending && events.length === 0 && (
                        <div className="cv-empty">
                            <Loader2 size={18} className="cv-spin" />
                            <span>Waiting for the session to start…</span>
                        </div>
                    )}

                    {!loading && !pending && events.length === 0 && (
                        <div className="cv-empty">
                            No messages yet. Send a message below to get started.
                        </div>
                    )}

                    {!loading && minimal && events.map((ev) => {
                        // Minimal: quiet lines only. No cards, no code, no expanders.
                        if (ev.type === 'thinking') return null;

                        if (ev.type === 'text' && ev.role === 'user') {
                            // Harness payloads (task notifications, system reminders) get
                            // echoed into the transcript as user turns. They aren't
                            // something the user typed, so strip them here too.
                            const asked = leadSentences(ev.text, 4);
                            if (!asked) return null;
                            return (
                                <div key={ev.id} className="cv-row cv-row-user">
                                    <div className="cv-user-bubble">{asked}</div>
                                </div>
                            );
                        }

                        if (ev.type === 'text') {
                            const lead = leadSentences(ev.text);
                            const anchored = anchoredSummaries.get(ev.id);
                            if (!lead && !anchored) return null;
                            return (
                                <div key={ev.id} className="cv-row cv-row-assistant">
                                    {lead && <div className="cv-min-text">{lead}</div>}
                                    {anchored && (
                                        <div className="cv-min-summary" title={anchored.isFallback ? 'Generated locally (LLM unavailable)' : undefined}>
                                            {anchored.text}
                                        </div>
                                    )}
                                </div>
                            );
                        }

                        return (
                            <div key={ev.id} className="cv-row cv-row-assistant">
                                <MinimalToolRow tool={ev} />
                                {anchoredSummaries.get(ev.id) && (
                                    <div
                                        className="cv-min-summary"
                                        title={anchoredSummaries.get(ev.id)!.isFallback ? 'Generated locally (LLM unavailable)' : undefined}
                                    >
                                        {anchoredSummaries.get(ev.id)!.text}
                                    </div>
                                )}
                            </div>
                        );
                    })}

                    {!loading && !minimal && events.map((ev) => {
                        if (ev.type === 'text' && ev.role === 'user') {
                            return (
                                <div key={ev.id} className="cv-row cv-row-user">
                                    <div className="cv-user-bubble">{ev.text}</div>
                                </div>
                            );
                        }
                        if (ev.type === 'text') {
                            return (
                                <div key={ev.id} className="cv-row cv-row-assistant">
                                    <div className="cv-markdown">
                                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{ev.text}</ReactMarkdown>
                                    </div>
                                </div>
                            );
                        }
                        if (ev.type === 'thinking') {
                            return (
                                <div key={ev.id} className="cv-row cv-row-assistant">
                                    <ThinkingBlock text={ev.text} />
                                </div>
                            );
                        }
                        return (
                            <div key={ev.id} className="cv-row cv-row-assistant">
                                <ToolCard tool={ev} />
                            </div>
                        );
                    })}

                    {minimal && summaries
                        .filter((sm) => !anchoredIds.has(sm.id))
                        .map((sm) => (
                            <div key={sm.id} className="cv-row cv-row-assistant">
                                <div className="cv-min-summary">{sm.text}</div>
                            </div>
                        ))}

                    {isBusy && (
                        <div className="cv-row cv-row-assistant">
                            <div className="cv-working">
                                <Loader2 size={14} className="cv-spin" />
                                <span>Working…</span>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {!atBottom && (
                <button className="cv-jump" onClick={jumpToBottom} title="Jump to latest">
                    <ArrowDown size={16} />
                </button>
            )}

            <div className="cv-composer-wrap">
                {menuOpen && (
                    <div className="cv-slash-menu" ref={menuRef} role="listbox" aria-label="Slash commands">
                        {matches.map((cmd, i) => (
                            <button
                                key={`${cmd.source}-${cmd.name}`}
                                type="button"
                                role="option"
                                aria-selected={i === slashIndex}
                                className={`cv-slash-item ${i === slashIndex ? 'is-active' : ''}`}
                                // Mouse-down rather than click: click fires after blur, which
                                // would close the menu before the selection lands.
                                onMouseDown={(e) => { e.preventDefault(); applyCommand(cmd); }}
                                onMouseEnter={() => setSlashIndex(i)}
                            >
                                <span className="cv-slash-name">/{cmd.name}</span>
                                {cmd.argumentHint && <span className="cv-slash-args">{cmd.argumentHint}</span>}
                                <span className={`cv-slash-source cv-slash-${cmd.source}`}>{cmd.source}</span>
                                {cmd.description && <span className="cv-slash-desc">{cmd.description}</span>}
                            </button>
                        ))}
                    </div>
                )}

                <div className="cv-composer">
                    <textarea
                        ref={inputRef}
                        className="cv-input"
                        value={input}
                        placeholder="Reply to Claude…  (/ for commands)"
                        rows={1}
                        onChange={(e) => {
                            setInput(e.target.value);
                            syncSlashState(e.target.value, e.target.selectionStart);
                        }}
                        // Arrow keys and clicks move the caret without changing the text,
                        // so the menu state has to follow the caret too.
                        onSelect={(e) => {
                            const el = e.currentTarget;
                            syncSlashState(el.value, el.selectionStart);
                        }}
                        onBlur={() => setSlashQuery(null)}
                        onKeyDown={(e) => {
                            if (menuOpen) {
                                if (e.key === 'ArrowDown') {
                                    e.preventDefault();
                                    setSlashIndex((i) => (i + 1) % matches.length);
                                    return;
                                }
                                if (e.key === 'ArrowUp') {
                                    e.preventDefault();
                                    setSlashIndex((i) => (i - 1 + matches.length) % matches.length);
                                    return;
                                }
                                if (e.key === 'Enter' || e.key === 'Tab') {
                                    e.preventDefault();
                                    applyCommand(matches[slashIndex]);
                                    return;
                                }
                                if (e.key === 'Escape') {
                                    e.preventDefault();
                                    setSlashQuery(null);
                                    return;
                                }
                            }
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                send();
                            }
                        }}
                    />
                    <button className="cv-send" onClick={send} disabled={!input.trim()} title="Send">
                        <Send size={16} />
                    </button>
                </div>
                <div className="cv-composer-hint">
                    {minimal ? 'Minimal view' : 'Rich view'} — switch to the terminal for permission prompts and full TUI control.
                </div>
            </div>
        </div>
    );
}

export default ChatView;
