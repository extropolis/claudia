/**
 * Terminal-protocol helpers shared by backend (history persistence) and
 * frontend (history replay).
 *
 * QUERY sequences are requests a TUI sends expecting the terminal to answer
 * (cursor position, device attributes...). They are only meaningful to a live
 * terminal at the moment they're emitted. Persisting or replaying them is
 * harmful: xterm.js dutifully ANSWERS every stale query it replays, and those
 * answers reach the live PTY as typed input — injecting garbage like
 * ";1;1R?1;2c" into the session. One canonical strip implementation lives here
 * so the backend and frontend lists cannot drift.
 */

const QUERY_PATTERNS: RegExp[] = [
    /\x1b\[\??[56]n/g,                          // DSR/CPR/DECXCPR cursor & status queries
    /\x1b\[[>=]?0?c/g,                          // DA1/DA2/DA3 device-attribute queries
    /\x1b\[>0?q/g,                              // XTVERSION query
    /\x1b\[\?\d+\$p/g,                          // DECRQM mode queries
    /\x1b\](?:1[0-2]|4;\d+);\?(?:\x07|\x1b\\)/g, // OSC color queries
];

/** Strip terminal QUERY escape sequences from history/replay data. */
export function stripTerminalQueries(data: string): string {
    // Fast path: the overwhelming majority of chunks contain no escapes at all.
    if (!data.includes('\x1b')) return data;
    let out = data;
    for (const re of QUERY_PATTERNS) out = out.replace(re, '');
    return out;
}

/**
 * If `data` ends with an INCOMPLETE escape sequence prefix (e.g. a chunk cut
 * mid-`\x1b[?6n`), return the index where that trailing partial starts, else
 * -1. Lets append-time strippers hold back the partial and prepend it to the
 * next chunk, so a query split across two writes cannot reassemble intact in
 * the persisted file and defeat stripping.
 */
export function incompleteEscapeSuffixStart(data: string): number {
    // Longest possible query here is ~12 bytes; scan a small tail only.
    const tail = data.slice(-16);
    const m = tail.match(/\x1b(?:\[[\d;?>=$]*|\](?:[\d;]*(?:\x1b)?)?)?$/);
    if (!m || m.index === undefined) return -1;
    return data.length - tail.length + m.index;
}
