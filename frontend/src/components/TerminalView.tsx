import { useEffect, useRef, useState } from 'react';
import { init as initGhostty, Terminal, FitAddon, OSC8LinkProvider, UrlRegexProvider } from 'ghostty-web';
import { Task, Workspace } from '@claudia/shared';
import { Copy, Check, Play, BookOpen, ArrowDown, MessageSquare } from 'lucide-react';
import { TaskInputBar } from './TaskInputBar';
import { TaskTokenStats } from './TaskTokenStats';
import { CheckpointTimeline } from './CheckpointTimeline';
import { useEffectiveTheme } from '../hooks/useTheme';
import { useTaskStore } from '../stores/taskStore';
import { DARK_TERMINAL_THEME, LIGHT_TERMINAL_THEME } from '../types/theme';
import { getApiBaseUrl } from '../config/api-config';
import './TerminalView.css';

// Ghostty WASM is initialized once per page load — subsequent calls are no-ops.
let ghosttyInitPromise: Promise<void> | null = null;
function ensureGhosttyInit(): Promise<void> {
  if (!ghosttyInitPromise) ghosttyInitPromise = initGhostty();
  return ghosttyInitPromise;
}

// Global write-lock: ghostty-web 0.4.x shares WASM linear memory across all
// Terminal instances. Concurrent writes to two instances (e.g. old terminal
// still flushing history while new one starts) corrupt the shared heap.
// This promise chain serializes all active chunked writes so only one runs
// at a time, regardless of which Terminal instance it targets.
let ghosttyWriteQueue: Promise<void> = Promise.resolve();
function enqueueGhosttyWrite(fn: () => Promise<void>): Promise<void> {
  ghosttyWriteQueue = ghosttyWriteQueue.then(() => fn()).catch(() => {});
  return ghosttyWriteQueue;
}

/**
 * Sanitize scrollback before writing to a fresh ghostty-web terminal instance.
 *
 * Ported from Nimbalyst's scrollbackSanitization.ts — three-stage pipeline:
 * 1. sanitizeScrollback: strip NUL bytes, validate Unicode code points, discard if corrupted
 * 2. stripProblematicEscapeSequences: remove cursor save/restore, scroll regions, alt screen
 * 3. cleanScrollback: strip trailing whitespace before CRs (zsh PROMPT_SP artifacts)
 *
 * Also preserves Claudia's original session-separator stripping.
 */
function sanitizeHistoryForRestore(raw: string): string | null {
  // Stage 1: NUL bytes and Unicode validation
  let s = raw;
  if (s.includes('\x00')) {
    const nullCount = (s.match(/\x00/g) || []).length;
    s = s.replace(/\x00/g, '');
    console.warn(`[TerminalView] Stripped ${nullCount} NUL byte(s) from scrollback`);
  }

  // Check for excessive suspicious control characters (binary corruption indicator)
  let suspicious = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x01 && c <= 0x06) || (c >= 0x0E && c <= 0x1A)) suspicious++;
  }
  if (s.length > 0 && suspicious / s.length > 0.005) {
    console.warn(`[TerminalView] Scrollback likely corrupted (${suspicious} suspicious control chars), discarding`);
    return null;
  }

  // Replace invalid Unicode code points
  let validated = '';
  let invalidCount = 0;
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i);
    if (cp === undefined || cp < 0 || cp > 0x10FFFF) {
      invalidCount++;
      validated += '?';
    } else if (cp > 0xFFFF) {
      validated += String.fromCodePoint(cp);
      i++;
    } else {
      validated += s[i];
    }
  }
  if (s.length > 0 && invalidCount / s.length > 0.01) {
    console.warn(`[TerminalView] Scrollback severely corrupted (${invalidCount} invalid code points), discarding`);
    return null;
  }

  // Stage 2: Strip escape sequences that corrupt state when replayed into a fresh terminal
  let r = validated;
  r = r.replace(/\x1b[78]/g, '');           // ESC 7/8 cursor save/restore (DEC)
  r = r.replace(/\x1b\[s/g, '');            // CSI s cursor save
  r = r.replace(/\x1b\[u/g, '');            // CSI u cursor restore
  r = r.replace(/\x1b\[\d*;?\d*r/g, '');   // CSI r scroll region
  r = r.replace(/\x1b\[\d*;?\d*[Hf]/g, ''); // CSI H/f absolute cursor position
  r = r.replace(/\x1b\[\?(1049|47|1047)[hl]/g, ''); // alt screen buffer
  r = r.replace(/\x1b\[\?7[hl]/g, '');     // autowrap mode
  r = r.replace(/\x1bc/g, '');             // RIS (full terminal reset)
  r = r.replace(/\x1b\[2J/g, '');          // clear screen
  r = r.replace(/\x1b\[3J/g, '');          // clear screen + scrollback

  // Stage 3: Clean zsh PROMPT_SP artifacts (spaces before CR, not before \r\n)
  r = r.replace(/[ \t]+\r(?!\n)/g, '\r');

  // Strip Claude Code's startup TUI banner — it's drawn with box characters at
  // a specific terminal width and garbles badly when replayed at a different width.
  // The banner starts with the Claude Code logo/header (contains ╭ or │ box chars)
  // and ends at the first prompt line (▶▶ bypass permissions).
  // We strip runs of lines that are predominantly box-drawing or pipe characters.
  r = r.replace(
    /(\r?\n[ \t]*[│╭╰╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬├┤┬┴┼─═║╔╗╚╝╠╣╦╩╬]+[^\r\n]*)+/g,
    '',
  );

  // Strip full-width horizontal separator lines (─ U+2500, - repeated, ═ U+2550)
  // These are drawn at a specific terminal width and overflow/garble at different widths.
  r = r.replace(/\r?\n?[ \t]*[-─═━]{10,}[ \t]*\r?\n?/g, '\n');

  // Strip accumulated session-reconnect separator lines
  r = r.replace(
    /\r?\n?\x1b\[90m─── (Resuming session [a-f0-9-]+|Session reconnected) ───\x1b\[0m\r?\n?\r?\n?/g,
    '',
  );

  return r;
}

interface TerminalViewProps {
  task: Task;
  wsRef: React.RefObject<WebSocket | null>;
  workspace?: Workspace;
  isMobile?: boolean;
}

export function TerminalView({ task, wsRef, workspace, isMobile }: TerminalViewProps) {
  const effectiveTheme = useEffectiveTheme();
  const setTaskViewMode = useTaskStore((s) => s.setTaskViewMode);
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const userHasScrolledRef = useRef(false); // Track if user manually scrolled up
  const programmaticScrollRef = useRef(false); // Track programmatic scrolls to ignore in scroll handler
  const [copied, setCopied] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [showSpinner, setShowSpinner] = useState(false);
  const historyLoadedRef = useRef(false);

  // Chunked history scrollback: we keep the loaded portion of the on-disk
  // history file as a string and lazy-load earlier chunks when the user
  // scrolls within ~100px of the top. `topOffsetRef` is the byte offset
  // where the currently-loaded content starts in the full history file.
  // When `topOffsetRef.current === 0` we've loaded everything.
  const loadedHistoryRef = useRef<string>('');
  const topOffsetRef = useRef<number>(0);
  const totalSizeRef = useRef<number>(0);
  const isLoadingChunkRef = useRef<boolean>(false);
  const historyChunkUnavailableRef = useRef<boolean>(false); // true for legacy base64 histories

  // Show spinner after a short delay to avoid flash for fast loads
  useEffect(() => {
    if (!isLoadingHistory) {
      setShowSpinner(false);
      return;
    }
    const spinnerDelay = setTimeout(() => {
      if (!historyLoadedRef.current) {
        setShowSpinner(true);
      }
    }, 300); // 300ms delay before showing spinner

    // Safety timeout - hide spinner after 5s even if no restore received
    const safetyTimeout = setTimeout(() => {
      if (!historyLoadedRef.current) {
        console.log(`[TerminalView] Safety timeout: hiding loading spinner for ${task.id}`);
        historyLoadedRef.current = true;
        setIsLoadingHistory(false);
      }
    }, 5000);

    return () => {
      clearTimeout(spinnerDelay);
      clearTimeout(safetyTimeout);
    };
  }, [isLoadingHistory, task.id]);

  // Expose scrollToBottom for external use (resets user scroll state since it's explicit)
  const scrollToBottom = (resetUserScroll = true) => {
    if (resetUserScroll) {
      userHasScrolledRef.current = false;
    }
    if (xtermRef.current) {
      // Mark as programmatic scroll
      programmaticScrollRef.current = true;
      xtermRef.current.scrollToBottom();
      // Reset flag after a short delay
      setTimeout(() => {
        programmaticScrollRef.current = false;
      }, 50);
    }
  };

  // Listen for custom scroll-to-bottom events (user explicitly selected task)
  useEffect(() => {
    const handleScrollToBottom = (e: CustomEvent<{ taskId: string }>) => {
      if (e.detail.taskId === task.id) {
        console.log(`[TerminalView] Received scrollToBottom event for ${task.id}`);
        // Reset user scroll state since user explicitly selected this task
        userHasScrolledRef.current = false;
        scrollToBottom();
      }
    };

    window.addEventListener('terminal:scrollToBottom', handleScrollToBottom as EventListener);
    return () => {
      window.removeEventListener('terminal:scrollToBottom', handleScrollToBottom as EventListener);
    };
  }, [task.id]);

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(task.prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const fitTerminal = () => {
    if (!fitAddonRef.current || !terminalRef.current || !xtermRef.current) return;

    // Check if container has valid dimensions
    if (terminalRef.current.clientWidth === 0 || terminalRef.current.clientHeight === 0) {
      return;
    }

    try {
      fitAddonRef.current.fit();
    } catch (err) {
      console.warn('Failed to fit terminal:', err);
    }
  };

  // Initial fit sequence - try multiple times to ensure we catch layout updates
  // This is critical for fixing the "text wrapping" issue on load
  const attemptFit = (attempts = 0) => {
    if (attempts > 10) return; // Give up after ~1s (10 * 100ms)

    if (
      terminalRef.current &&
      terminalRef.current.clientWidth > 0 &&
      terminalRef.current.clientHeight > 0
    ) {
      fitTerminal();
      // Retry a few times to catch font-metrics not yet loaded on first fit
      if (attempts < 3) {
        setTimeout(() => attemptFit(attempts + 1), 100);
      }
    } else {
      // Retry if no dimensions yet
      setTimeout(() => attemptFit(attempts + 1), 100);
    }
  };

  useEffect(() => {
    if (!terminalRef.current) return;

    // Reset user scroll state and loading state when task changes
    userHasScrolledRef.current = false;
    historyLoadedRef.current = false;
    setIsLoadingHistory(true);

    // Clear container
    while (terminalRef.current.firstChild) {
      terminalRef.current.removeChild(terminalRef.current.firstChild);
    }

    let destroyed = false;
    let cleanup: (() => void) | null = null;
    let termDisposed = false;

    // Wait for the container to have real pixel dimensions before creating
    // the terminal. If we open() at 0x0 or at the wrong size, ghostty-web
    // creates its canvas too small and history written immediately after
    // renders garbled. Mirrors Nimbalyst's waitForVisibleTerminalDimensions().
    const waitForDimensions = async (): Promise<void> => {
      const start = Date.now();
      while (Date.now() - start < 1500) {
        if (destroyed || !terminalRef.current) return;
        const rect = terminalRef.current.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return;
        await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
      }
    };

    // ghostty-web requires WASM to be initialized before Terminal construction.
    // We await it before creating the instance; subsequent calls are instant no-ops.
    void ensureGhosttyInit()
      .then(() => waitForDimensions())
      .then(async () => {
    if (destroyed || !terminalRef.current) return;

    // Create terminal
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"SF Mono", "Monaco", "Inconsolata", "Fira Code", monospace',
      scrollback: 10000,
      scrollOnUserInput: false, // Disable automatic scroll on user input - we'll control it manually
      theme: effectiveTheme === 'light' ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    // Clipboard integration: Ctrl+V / Cmd+V paste and Ctrl+C / Cmd+C copy
    // Works in both Electron and browser environments
    const isMac = /Mac|iPhone|iPod|iPad/.test(navigator.userAgent);
    term.attachCustomKeyEventHandler((event) => {
      // ghostty-web semantics: return true = "I handled it, skip default processing"
      //                        return false = "let ghostty handle it normally"
      if (event.type !== 'keydown') return false;

      const modKey = isMac ? event.metaKey : event.ctrlKey;

      // Paste: Ctrl+V (Win/Linux), Cmd+V (Mac), or Ctrl+Shift+V (Linux terminal style)
      const isPaste =
        (modKey && event.key === 'v') ||
        (!isMac && event.ctrlKey && event.shiftKey && event.key === 'V');
      if (isPaste) {
        event.preventDefault();
        if (window.electronAPI?.readClipboard) {
          const text = window.electronAPI.readClipboard();
          if (text) term.paste(text);
        } else if (navigator.clipboard?.readText) {
          navigator.clipboard
            .readText()
            .then((text) => {
              if (text) term.paste(text);
            })
            .catch((err) => {
              console.warn('[TerminalView] Clipboard paste failed:', err);
            });
        }
        return true; // handled — skip ghostty default
      }

      // Copy: Ctrl+C (Win/Linux), Cmd+C (Mac), or Ctrl+Shift+C (Linux terminal style)
      const isCopy =
        (modKey && event.key === 'c') ||
        (!isMac && event.ctrlKey && event.shiftKey && event.key === 'C');
      if (isCopy) {
        const selection = term.getSelection();
        if (selection) {
          if (window.electronAPI?.writeClipboard) {
            window.electronAPI.writeClipboard(selection);
          } else if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(selection).catch((err) => {
              console.warn('[TerminalView] Clipboard copy failed:', err);
            });
          }
          return true; // handled — skip ghostty default
        }
        // No selection: let Ctrl+C pass through as SIGINT (but not Cmd+C on Mac)
        if (isMac) return true;
      }

      return false; // pass-through — let ghostty handle normally
    });

    // Handle input BEFORE open
    term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: 'task:input',
            payload: { taskId: task.id, input: data },
          }),
        );
      }
    });

    // Suppress resize events during init to prevent multiple PTY resizes
    // that trigger Claude TUI redraws interleaving with history output.
    let initPhase = true;

    // Track last sent dimensions to prevent resize oscillation.
    // When a scrollbar appears/disappears, the container width changes by ~15px
    // which flips cols by 1-2. This causes Claude Code's TUI to re-render at
    // alternating widths, producing garbled overlapping text. We suppress resizes
    // that change cols by <= 2 to break this feedback loop.
    let lastSentCols = 0;
    let lastSentRows = 0;

    // Resize output buffer: after sending a resize to the backend, buffer all
    // incoming PTY output for RESIZE_BUFFER_MS. This gives the PTY time to
    // process SIGWINCH and start rendering at the new width. Without this,
    // output rendered at the OLD width arrives at xterm which is already at
    // the NEW width, causing ANSI cursor positioning to misalign.
    const RESIZE_BUFFER_MS = 250;
    let resizeBuffering = false;
    let resizeBuffer: string[] = [];
    let resizeBufferTimer: number | undefined;

    const flushResizeBuffer = () => {
      resizeBuffering = false;
      if (resizeBuffer.length > 0) {
        const combined = resizeBuffer.join('');
        resizeBuffer = [];
        term.write(combined);
      }
    };

    // Guard: suppress task:output writes during task:restore processing.
    // Between term.reset() and the completion of term.write(history),
    // any live output written would be interleaved/overwritten by the
    // history replay, causing garbled text. Buffer output during restore
    // and flush after the history write completes.
    let restoreInProgress = false;
    let restoreOutputBuffer: string[] = [];

    const flushRestoreBuffer = () => {
      restoreInProgress = false;
      if (restoreOutputBuffer.length > 0) {
        const combined = restoreOutputBuffer.join('');
        restoreOutputBuffer = [];
        term.write(combined);
      }
    };

    // Handle resize - sync to backend
    term.onResize(({ cols, rows }) => {
      if (initPhase) return; // Skip during init — we send one resize after fit
      // Suppress small col changes (scrollbar oscillation)
      if (Math.abs(cols - lastSentCols) <= 2 && rows === lastSentRows) return;
      lastSentCols = cols;
      lastSentRows = rows;

      // Start buffering output during the resize transition
      if (resizeBufferTimer) window.clearTimeout(resizeBufferTimer);
      resizeBuffering = true;
      resizeBuffer = [];
      resizeBufferTimer = window.setTimeout(flushResizeBuffer, RESIZE_BUFFER_MS);

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: 'task:resize',
            payload: { taskId: task.id, cols, rows },
          }),
        );
      }
    });

    // Open terminal — container already has real dimensions (waitForDimensions above)
    if (destroyed || !terminalRef.current) return;
    term.open(terminalRef.current);
    // Wait for fonts to load so ghostty-web's getMetrics() returns accurate
    // character dimensions. Without this, fit() may run before the monospace
    // font is ready and compute far too few cols (e.g. 60 instead of 120).
    try { await document.fonts.ready; } catch { /* ignore */ }
    // Yield one microtask so the browser can finish layout after open()
    await new Promise(resolve => setTimeout(resolve, 0));
    if (destroyed || !terminalRef.current) return;

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Fit to container. Retry once after a short delay in case font metrics
    // weren't ready yet (ghostty-web measures "M" at open() time; if the
    // monospace font loads slightly late, fit() computes too few cols).
    const doFit = () => {
      try {
        fitAddon.fit();
        return fitAddon.proposeDimensions();
      } catch { return undefined; }
    };

    let dims = doFit();
    // If cols look unreasonably low (< 60 for a full-width terminal), the
    // font metrics were stale — wait for fonts and retry once.
    if (!dims || dims.cols < 60) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (destroyed || !terminalRef.current) return;
      dims = doFit();
    }

    let initialCols = dims?.cols ?? term.cols;
    let initialRows = dims?.rows ?? term.rows;

    // Register OSC8 hyperlinks and URL detection
    term.registerLinkProvider(new OSC8LinkProvider(term));
    term.registerLinkProvider(new UrlRegexProvider(term));

    // End init phase and send definitive resize to backend
    initPhase = false;
    lastSentCols = initialCols;
    lastSentRows = initialRows;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'task:resize',
        payload: { taskId: task.id, cols: initialCols, rows: initialRows },
      }));
    }

    // Request history now that terminal is correctly sized
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'task:select',
        payload: { taskId: task.id },
      }));
    }

    // Track user scroll position to prevent auto-scroll when user has scrolled up
    // We need to distinguish between programmatic scrolls and user scrolls
    const isAtBottom = () => {
      if (!term) return true;
      const bufViewport = term.buffer.active.viewportY;
      const totalRows = term.buffer.active.length;
      // Consider "at bottom" if within 2 rows of the bottom
      return bufViewport + term.rows >= totalRows - 2;
    };

    const handleScroll = () => {
      // Ignore programmatic scrolls (ones we triggered)
      if (programmaticScrollRef.current) {
        return;
      }

      // This is a user-initiated scroll - check if they scrolled back to bottom
      const atBottom = isAtBottom();

      if (atBottom && userHasScrolledRef.current) {
        // User scrolled back to bottom, re-enable auto-scroll
        console.log(`[TerminalView] User scrolled to bottom, enabling auto-scroll for ${task.id}`);
        userHasScrolledRef.current = false;
      }
    };

    // Attach xterm scroll listener
    term.onScroll(handleScroll);

    // Track whether user has scrolled up (away from bottom) via DOM viewport
    // xterm native auto-scroll only works when viewport is exactly at bottom;
    // fitAddon.fit() can shift scrollTop slightly and break it.
    const viewport = terminalRef.current.querySelector('.xterm-viewport') as HTMLElement | null;

    // Lazy-load earlier history when the user scrolls within 200px of the top.
    // Re-entrancy guard: `isLoadingChunkRef` plus a no-op when we've already
    // loaded everything (topOffsetRef === 0) or the on-disk file is legacy base64.
    const loadEarlierChunkIfNeeded = async () => {
      if (programmaticScrollRef.current) return;
      if (isLoadingChunkRef.current) return;
      if (historyChunkUnavailableRef.current) return;
      if (topOffsetRef.current <= 0) return;
      if (!viewport || viewport.scrollTop > 200) return;

      const requestEndBefore = topOffsetRef.current;
      const CHUNK_SIZE = 256 * 1024;
      isLoadingChunkRef.current = true;
      try {
        const r = await fetch(
          `${getApiBaseUrl()}/api/task/${task.id}/history?endBefore=${requestEndBefore}&maxBytes=${CHUNK_SIZE}`,
        );
        if (!r.ok) {
          console.warn('[TerminalView] history chunk fetch failed', r.status);
          return;
        }
        const { data, startOffset, totalSize, isBase64Legacy } = (await r.json()) as {
          data: string;
          startOffset: number;
          totalSize: number;
          isBase64Legacy: boolean;
        };
        if (isBase64Legacy) {
          historyChunkUnavailableRef.current = true;
          return;
        }
        if (!data) {
          // Reached the beginning of the file
          topOffsetRef.current = 0;
          return;
        }
        // Prepend the new chunk to the loaded buffer, then rewrite.
        const cleanedChunk = sanitizeHistoryForRestore(data) ?? data;
        loadedHistoryRef.current = cleanedChunk + loadedHistoryRef.current;
        topOffsetRef.current = startOffset;
        totalSizeRef.current = totalSize;

        // Capture viewport position relative to the bottom so we can restore
        // it after rewrite (user expects to keep looking at the same content).
        const oldTotalLines = term.buffer.active.length;
        const oldViewportY = term.buffer.active.viewportY;
        const linesFromBottom = oldTotalLines - oldViewportY;

        // Block live output during rewrite to prevent interleaving.
        // Do NOT call term.reset() — it corrupts ghostty-web's state.
        restoreInProgress = true;
        restoreOutputBuffer = [];
        programmaticScrollRef.current = true;
        const fullHistory = loadedHistoryRef.current;
        const CHUNK_SIZE = 8192;
        // Write in chunks, then restore scroll position
        const writeAllChunks = async () => {
          for (let i = 0; i < fullHistory.length; i += CHUNK_SIZE) {
            if (termDisposed) return;
            term.write(fullHistory.slice(i, i + CHUNK_SIZE));
            if ((i / CHUNK_SIZE) % 4 === 3) await new Promise(r => setTimeout(r, 0));
          }
          if (!termDisposed) {
            term.write('\x1b[r'); // reset scroll region
            flushRestoreBuffer();
            const newTotal = term.buffer.active.length;
            const targetViewportY = Math.max(0, newTotal - linesFromBottom);
            if (Number.isInteger(targetViewportY)) term.scrollToLine(targetViewportY);
            setTimeout(() => { programmaticScrollRef.current = false; }, 50);
          }
        };
        void enqueueGhosttyWrite(writeAllChunks);
      } catch (err) {
        console.warn('[TerminalView] history chunk fetch error', err);
      } finally {
        isLoadingChunkRef.current = false;
      }
    };

    const handleViewportScroll = () => {
      if (!viewport) return;
      const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 50;
      userHasScrolledRef.current = !atBottom;
      // Fire-and-forget; loadEarlierChunkIfNeeded guards re-entrancy itself.
      loadEarlierChunkIfNeeded();
    };
    if (viewport) {
      viewport.addEventListener('scroll', handleViewportScroll, { passive: true });
    }

    // Right-click: copy selection or paste (works in both Electron and browser)
    term.element?.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const selection = term.getSelection();
      if (selection) {
        // Text selected: copy to clipboard
        if (window.electronAPI?.writeClipboard) {
          window.electronAPI.writeClipboard(selection);
        } else if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(selection).catch((err) => {
            console.warn('[TerminalView] Right-click copy failed:', err);
          });
        }
        term.clearSelection();
      } else {
        // No selection: paste from clipboard
        if (window.electronAPI?.readClipboard) {
          const text = window.electronAPI.readClipboard();
          if (text) term.paste(text);
        } else if (navigator.clipboard?.readText) {
          navigator.clipboard
            .readText()
            .then((text) => {
              if (text) term.paste(text);
            })
            .catch((err) => {
              console.warn('[TerminalView] Right-click paste failed:', err);
            });
        }
      }
    });

    // ResizeObserver: 120ms debounce matches Nimbalyst — collapses resize bursts
    // (sidebar animate, window drag) into a single PTY SIGWINCH.
    let resizeTimeout: number;
    const applyResize = () => {
      if (!fitAddonRef.current || !xtermRef.current || !terminalRef.current) return;
      if (terminalRef.current.clientWidth === 0 || terminalRef.current.clientHeight === 0) return;
      try {
        fitAddonRef.current.fit();
        const dims = fitAddonRef.current.proposeDimensions();
        if (dims && dims.cols > 0 && dims.rows > 0) {
          const cols = dims.cols;
          const rows = dims.rows;
          if (Math.abs(cols - lastSentCols) > 2 || rows !== lastSentRows) {
            lastSentCols = cols;
            lastSentRows = rows;
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({
                type: 'task:resize',
                payload: { taskId: task.id, cols, rows },
              }));
            }
          }
        }
      } catch { /* ignore during cleanup */ }
    };
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeout) window.clearTimeout(resizeTimeout);
      resizeTimeout = window.setTimeout(applyResize, 120);
    });
    resizeObserver.observe(terminalRef.current);
    const handleWindowResize = () => {
      if (resizeTimeout) window.clearTimeout(resizeTimeout);
      resizeTimeout = window.setTimeout(applyResize, 120);
    };
    window.addEventListener('resize', handleWindowResize);

    // Message handler
    const handleMessage = (event: MessageEvent) => {
      if (termDisposed) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'task:output' && message.payload.taskId === task.id) {
          const data = message.payload.data;

          // Buffer output during resize transitions and history restores
          // to prevent garbled text from interleaving.
          if (resizeBuffering || restoreInProgress) {
            if (resizeBuffering) resizeBuffer.push(data);
            if (restoreInProgress) restoreOutputBuffer.push(data);
            // Still track history so scroll-up loading stays current
            if (loadedHistoryRef.current !== '') {
              loadedHistoryRef.current += data;
            }
            if (totalSizeRef.current > 0) {
              totalSizeRef.current += data.length;
            }
            return;
          }

          // Check if user is at bottom BEFORE writing
          const viewport = term.buffer.active.viewportY;
          const totalRows = term.buffer.active.length;
          const wasAtBottom = viewport + term.rows >= totalRows - 2;

          // Update userHasScrolledRef based on current position
          if (!wasAtBottom && !userHasScrolledRef.current) {
            console.log(
              `[TerminalView] User has scrolled up, disabling auto-scroll for ${task.id}`,
            );
            userHasScrolledRef.current = true;
          }

          console.log(
            `[TerminalView] Writing output, wasAtBottom: ${wasAtBottom}, userHasScrolled: ${userHasScrolledRef.current}, viewport: ${viewport}`,
          );

          term.write(data);
          // Keep our loaded-history snapshot current so a later
          // scroll-up rewrite (loadEarlierChunkIfNeeded) doesn't lose
          // live output that arrived after the initial restore.
          if (loadedHistoryRef.current !== '') {
            loadedHistoryRef.current += message.payload.data;
          }
          if (totalSizeRef.current > 0) {
            // Match the byte count the backend file is growing by so
            // future chunk requests use the right end-of-file anchor.
            const bytes =
              typeof message.payload.data === 'string'
                ? new TextEncoder().encode(message.payload.data).length
                : 0;
            totalSizeRef.current += bytes;
          }

          // Only auto-scroll if user was at bottom
          if (wasAtBottom) {
            programmaticScrollRef.current = true;
            requestAnimationFrame(() => {
              if (xtermRef.current) {
                xtermRef.current.scrollToBottom();
              }
              setTimeout(() => {
                programmaticScrollRef.current = false;
              }, 100);
            });
          } else {
            // User was scrolled up - maintain their position
            programmaticScrollRef.current = true;
            term.scrollToLine(viewport);
            setTimeout(() => {
              programmaticScrollRef.current = false;
            }, 100);
          }

          // Clear loading state on first output (task is live)
          if (!historyLoadedRef.current) {
            console.log(
              `[TerminalView] First output received, clearing loading state for ${task.id}`,
            );
            historyLoadedRef.current = true;
            setIsLoadingHistory(false);
          }
        } else if (message.type === 'task:restore' && message.payload.taskId === task.id) {
          const { history } = message.payload;
          console.log(
            `[TerminalView] task:restore received for ${task.id}, history size: ${history?.length || 0}, alreadyLoaded: ${historyLoadedRef.current}`,
          );
          // Guard: only process the first restore per terminal mount
          if (historyLoadedRef.current) return;
          if (history && history.length > 0) {
            restoreInProgress = true;
            restoreOutputBuffer = [];
            // Clear any content written before history arrives (e.g. stale output)
            if (!termDisposed) term.clear();

            // Sanitize before writing — strips NUL bytes, invalid Unicode,
            // cursor save/restore, scroll regions, and other sequences that
            // corrupt ghostty-web's state when replayed into a fresh terminal.
            // Do NOT call term.reset() — it corrupts ghostty-web's internal
            // state machine when history is written immediately after.
            const cleaned = sanitizeHistoryForRestore(history);

            if (!cleaned) {
              // Corrupted — skip restore, let live output continue
              console.warn(`[TerminalView] History corrupted for ${task.id}, skipping restore`);
              flushRestoreBuffer();
              historyLoadedRef.current = true;
              setIsLoadingHistory(false);
            } else {
              // Write in 8KB chunks to avoid WASM memory issues with large histories
              const CHUNK_SIZE = 8192;
              const MAX_RESTORE_MS = 2000;
              const startTime = Date.now();
              programmaticScrollRef.current = true;

              const writeChunks = async () => {
                for (let i = 0; i < cleaned.length; i += CHUNK_SIZE) {
                  if (termDisposed) return;
                  if (Date.now() - startTime > MAX_RESTORE_MS) {
                    console.warn('[TerminalView] Scrollback restore timed out, skipping remainder');
                    break;
                  }
                  try {
                    if (termDisposed) return; // re-check after async yield
                    term.write(cleaned.slice(i, i + CHUNK_SIZE));
                  } catch (err) {
                    if (!termDisposed) console.warn('[TerminalView] Scrollback write error:', err);
                    return;
                  }
                  // Yield every 4 chunks to keep UI responsive
                  if ((i / CHUNK_SIZE) % 4 === 3) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                  }
                }
                if (!termDisposed) {
                  // Reset scroll region to full screen, then scroll to bottom
                  term.write('\x1b[r');
                  term.scrollToBottom();
                  setTimeout(() => { programmaticScrollRef.current = false; }, 50);
                  flushRestoreBuffer();
                }
              };

              void enqueueGhosttyWrite(writeChunks).then(() => {
                loadedHistoryRef.current = cleaned;
                fetch(`${getApiBaseUrl()}/api/task/${task.id}/history?endBefore=0&maxBytes=0`)
                  .then((r) => r.json())
                  .then((meta: { totalSize: number; isBase64Legacy: boolean }) => {
                    totalSizeRef.current = meta.totalSize;
                    topOffsetRef.current = Math.max(0, meta.totalSize - history.length);
                    historyChunkUnavailableRef.current = !!meta.isBase64Legacy;
                    console.log(
                      `[TerminalView] history metadata: total=${meta.totalSize} topOffset=${topOffsetRef.current} legacy=${meta.isBase64Legacy}`,
                    );
                  })
                  .catch((err) => {
                    console.warn('[TerminalView] failed to fetch history metadata', err);
                    historyChunkUnavailableRef.current = true;
                  });
                console.log(
                  `[TerminalView] History written for ${task.id} (original: ${history.length}, cleaned: ${cleaned.length})`,
                );
                historyLoadedRef.current = true;
                setIsLoadingHistory(false);
              });
            }
          } else {
            term.write('\x1b[90m── Session history not available ──\x1b[0m\r\n');
            console.log(`[TerminalView] Empty history for ${task.id}`);
            historyLoadedRef.current = true;
            setIsLoadingHistory(false);
          }
        }
      } catch (e) {
        console.error('[TerminalView] Message error:', e);
      }
    };

    if (wsRef.current) {
      wsRef.current.addEventListener('message', handleMessage);
    }

    // NOTE: task:select is sent inside the requestAnimationFrame above
    // (after fitAddon.fit()) so that history arrives at the correct terminal size.

    cleanup = () => {
      if (resizeTimeout) window.clearTimeout(resizeTimeout);
      if (resizeBufferTimer) window.clearTimeout(resizeBufferTimer);
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleWindowResize);
      if (viewport) {
        viewport.removeEventListener('scroll', handleViewportScroll);
      }
      if (wsRef.current) {
        wsRef.current.removeEventListener('message', handleMessage);
      }
      term.dispose();
      termDisposed = true;
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
    }); // end ensureGhosttyInit().then(...).then()

    return () => {
      destroyed = true;
      if (cleanup) cleanup();
    };
  }, [task.id, wsRef]);

  // Update terminal theme when app theme changes
  useEffect(() => {
    if (!xtermRef.current) return;
    xtermRef.current.options.theme =
      effectiveTheme === 'light' ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME;
  }, [effectiveTheme]);

  // Handle Resume button click - sends task:reconnect message to spawn new Claude process
  const handleResume = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: 'task:reconnect',
          payload: { taskId: task.id },
        }),
      );
    }
  };

  const showResumeButton = task.state === 'interrupted' || task.state === 'disconnected';
  const stateLabel = task.state === 'interrupted' ? 'INTERRUPTED' : task.state;

  const handleLearnFromConversation = () => {
    // Send /learn command to the active Claude Code terminal session
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: 'task:input',
          payload: { taskId: task.id, input: '/learn\r' },
        }),
      );
    }
  };

  return (
    <div className="terminal-view">
      <div className="terminal-header">
        <span className="terminal-title">{task.prompt}</span>
        <button
          className={`copy-button ${copied ? 'copied' : ''}`}
          onClick={copyToClipboard}
          title="Copy prompt to clipboard"
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
        <button
          className="view-toggle-button"
          onClick={() => setTaskViewMode(task.id, 'chat')}
          title="Switch to minimal chat view"
        >
          <MessageSquare size={14} />
          <span>Chat</span>
        </button>
        {workspace && (
          <button
            className="learn-button"
            onClick={handleLearnFromConversation}
            title="Send /learn command to Claude - rates performance and saves learnings to .claude/skills/"
          >
            <BookOpen size={14} />
            Learn
          </button>
        )}
        {showResumeButton && (
          <button
            className="terminal-resume-button"
            onClick={handleResume}
            title="Resume this task"
          >
            <Play size={14} />
            Resume
          </button>
        )}
        <span className={`terminal-state ${task.state}`}>{stateLabel}</span>
      </div>
      <div className="terminal-container-wrapper">
        <div ref={terminalRef} className="terminal-container" />
        {showSpinner && (
          <div className="terminal-loading-overlay">
            <div className="terminal-loading-spinner" />
            <span className="terminal-loading-text">Loading session history…</span>
          </div>
        )}
        {isMobile && (
          <button
            className="mobile-interrupt-btn"
            onClick={() => {
              if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(
                  JSON.stringify({
                    type: 'task:input',
                    payload: { taskId: task.id, input: '\x1b' },
                  }),
                );
              }
            }}
            title="Send Escape"
          >
            <span style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '-0.5px' }}>ESC</span>
          </button>
        )}
        {isMobile && (
          <button
            className="mobile-scroll-bottom-btn"
            onClick={() => scrollToBottom(true)}
            title="Scroll to bottom"
          >
            <ArrowDown size={20} />
          </button>
        )}
      </div>
      <TaskInputBar task={task} wsRef={wsRef} />
      {workspace && (
        <CheckpointTimeline taskId={task.id} workspaceId={workspace.id} wsRef={wsRef} />
      )}
      <TaskTokenStats taskId={task.id} />
    </div>
  );
}
