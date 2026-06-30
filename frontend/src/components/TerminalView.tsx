import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { Task, Workspace } from '@claudia/shared';
import { Copy, Check, Play, BookOpen, ArrowDown, MessageSquare } from 'lucide-react';
import { TaskInputBar } from './TaskInputBar';
import { TaskTokenStats } from './TaskTokenStats';
import { CheckpointTimeline } from './CheckpointTimeline';
import { useEffectiveTheme } from '../hooks/useTheme';
import { useTaskStore } from '../stores/taskStore';
import { DARK_TERMINAL_THEME, LIGHT_TERMINAL_THEME } from '../types/theme';
import { getApiBaseUrl } from '../config/api-config';
import '@xterm/xterm/css/xterm.css';
import './TerminalView.css';

/**
 * Strip screen-clearing escape sequences from restored history.
 * When Claude Code goes idle, it sends cleanup sequences (clear screen, cursor home, etc.)
 * that wipe all visible content. When replaying history, we strip these so the actual
 * task output remains visible instead of showing a blank screen.
 */
function stripScreenClears(history: string): string {
  return (
    history
      // \x1bc - RIS (Reset to Initial State) — causes a full terminal reset
      // that blacks out the screen if no content follows immediately
      .replace(/\x1bc/g, '')
      // \x1b[2J\x1b[H - Clear screen + cursor home (common cleanup pattern)
      // Strip as a pair so standalone \x1b[H used for TUI drawing is preserved
      .replace(/\x1b\[2J\x1b\[H/g, '')
      // \x1b[2J - Clear entire screen (standalone)
      .replace(/\x1b\[2J/g, '')
      // \x1b[3J - Clear entire screen + scrollback
      .replace(/\x1b\[3J/g, '')
      // \x1b[?1049h / \x1b[?1049l - Alt screen buffer enter/exit
      .replace(/\x1b\[\?1049[hl]/g, '')
      // Strip accumulated "Resuming session" / "Session reconnected" separator lines.
      // These accumulate across server restarts and fill the terminal with noise,
      // hiding the actual conversation content.
      .replace(
        /\r?\n?\x1b\[90m─── (Resuming session [a-f0-9-]+|Session reconnected) ───\x1b\[0m\r?\n?\r?\n?/g,
        '',
      )
  );
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

  // SDK tasks have no PTY — immediately redirect to conversation view instead
  // of showing an empty terminal with a "no terminal output" notice.
  useEffect(() => {
    if (task.id.startsWith('sdk-')) {
      setTaskViewMode(task.id, 'conversation');
    }
  }, [task.id, setTaskViewMode]);

  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
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
      // Force a full refresh to fix any rendering artifacts
      const rows = xtermRef.current.rows;
      xtermRef.current.refresh(0, rows - 1);
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

    // Create terminal
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"SF Mono", "Monaco", "Inconsolata", "Fira Code", monospace',
      scrollback: 10000,
      allowProposedApi: true,
      scrollOnUserInput: false, // Disable automatic scroll on user input - we'll control it manually
      theme: effectiveTheme === 'light' ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const unicode11Addon = new Unicode11Addon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(unicode11Addon);
    term.unicode.activeVersion = '11';

    // Clipboard integration: Ctrl+V / Cmd+V paste and Ctrl+C / Cmd+C copy
    // Works in both Electron and browser environments
    const isMac = /Mac|iPhone|iPod|iPad/.test(navigator.userAgent);
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;

      const modKey = isMac ? event.metaKey : event.ctrlKey;

      // Paste: Ctrl+V (Win/Linux), Cmd+V (Mac), or Ctrl+Shift+V (Linux terminal style)
      const isPaste =
        (modKey && event.key === 'v') ||
        (!isMac && event.ctrlKey && event.shiftKey && event.key === 'V');
      if (isPaste) {
        // Prevent the browser's native paste event from also firing
        // (which would cause xterm to paste a second time)
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
        return false; // Prevent xterm from also handling the key
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
          return false;
        }
        // No selection: let Ctrl+C pass through as SIGINT (but not Cmd+C on Mac)
        if (isMac) return false;
      }

      return true;
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

    // Open terminal
    term.open(terminalRef.current);
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // WebGL renderer — GPU-accelerated, significantly faster for high-throughput
    // TUI output. Falls back to the DOM renderer on context loss or if WebGL2
    // is unavailable (headless Chromium, older hardware, certain VMs). We probe
    // for WebGL2 before instantiating because WebglAddon's constructor succeeds
    // even when WebGL2 is unsupported, then crashes during dispose with
    // "Cannot read properties of undefined (reading '_isDisposed')".
    const probeCanvas = document.createElement('canvas');
    const hasWebgl2 = !!probeCanvas.getContext('webgl2');
    if (hasWebgl2) {
      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          console.warn('[TerminalView] WebGL context lost — falling back to DOM renderer');
          try { webglAddon.dispose(); } catch { /* already disposed */ }
          webglAddonRef.current = null;
        });
        term.loadAddon(webglAddon);
        webglAddonRef.current = webglAddon;
      } catch (e) {
        console.warn('[TerminalView] WebGL addon failed to load, using DOM renderer:', e);
      }
    } else {
      console.info('[TerminalView] WebGL2 unavailable, using DOM renderer');
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
        // Prepend the new chunk to the loaded buffer, then reset + rewrite.
        // We must reset because xterm.write only appends — there's no insert API.
        const cleanedChunk = stripScreenClears(data);
        loadedHistoryRef.current = cleanedChunk + loadedHistoryRef.current;
        topOffsetRef.current = startOffset;
        totalSizeRef.current = totalSize;

        // Capture viewport position relative to the bottom so we can restore
        // it after rewrite (user expects to keep looking at the same content).
        const oldTotalLines = term.buffer.active.length;
        const oldViewportY = term.buffer.active.viewportY;
        const linesFromBottom = oldTotalLines - oldViewportY;

        // Block live output during the reset+rewrite to prevent interleaving
        restoreInProgress = true;
        restoreOutputBuffer = [];
        programmaticScrollRef.current = true;
        term.reset();
        term.write(loadedHistoryRef.current, () => {
          flushRestoreBuffer();
          const newTotal = term.buffer.active.length;
          const targetViewportY = Math.max(0, newTotal - linesFromBottom);
          term.scrollToLine(targetViewportY);
          setTimeout(() => {
            programmaticScrollRef.current = false;
          }, 50);
        });
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

    // CRITICAL: Fit the terminal BEFORE requesting history.
    // History is raw PTY output captured at the original terminal size. If we
    // write it at default 80x24 and then fit to the actual size, xterm reflows
    // the content which garbles Claude Code's cursor-positioned TUI output.
    //
    // Double-rAF: the first rAF fires before the browser paints; the second
    // fires after layout + paint have completed, so container dimensions are
    // final. A single rAF is NOT enough — flexbox/grid sizing may still be
    // in-progress during the first frame.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          fitAddon.fit();
        } catch (e) {
          console.error('[TerminalView] Initial fit failed:', e);
        }

        // End init phase — subsequent resizes (window resize, etc.) will
        // be forwarded to the backend normally.
        initPhase = false;

        // Send ONE definitive resize to the backend with the correct dimensions
        const { cols, rows } = term;
        lastSentCols = cols;
        lastSentRows = rows;
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({
              type: 'task:resize',
              payload: { taskId: task.id, cols, rows },
            }),
          );
        }

        // NOW request history — terminal is properly sized, so history
        // will render correctly without reflow.
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({
              type: 'task:select',
              payload: { taskId: task.id },
            }),
          );
        }
      });
    });

    // ResizeObserver for container changes — use fitTerminal() which does
    // fit() + refresh() to clear rendering artifacts from the previous width.
    // 150ms debounce prevents rapid-fire resizes during layout transitions.
    let resizeTimeout: number;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeout) window.clearTimeout(resizeTimeout);
      resizeTimeout = window.setTimeout(fitTerminal, 150);
    });

    resizeObserver.observe(terminalRef.current);

    // Window resize fallback
    const handleWindowResize = () => {
      if (resizeTimeout) window.clearTimeout(resizeTimeout);
      resizeTimeout = window.setTimeout(fitTerminal, 150);
    };
    window.addEventListener('resize', handleWindowResize);

    // Message handler
    const handleMessage = (event: MessageEvent) => {
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
          if (history && history.length > 0) {
            // Block task:output writes until the history replay completes.
            // Without this, live output arriving between reset() and write()
            // completion gets interleaved with history, causing garbled text.
            restoreInProgress = true;
            restoreOutputBuffer = [];
            term.reset();
            const cleaned = stripScreenClears(history);
            programmaticScrollRef.current = true;
            term.write(cleaned, () => {
              // History fully written — flush any output that arrived during restore
              flushRestoreBuffer();
              term.scrollToBottom();
              setTimeout(() => {
                programmaticScrollRef.current = false;
              }, 50);
            });
            // Seed the chunked-scrollback buffer with the cleaned tail we
            // just wrote. We can't fully reconstruct the original byte
            // offset (cleaned !== raw history due to stripScreenClears),
            // so we ask the backend for metadata and assume the
            // restored tail starts at `totalSize - rawHistory.length`.
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
          } else {
            term.reset();
            term.write('\x1b[90m── Session history not available ──\x1b[0m\r\n');
            console.log(`[TerminalView] Empty history for ${task.id}`);
          }
          // Clear loading state - history has been restored
          historyLoadedRef.current = true;
          setIsLoadingHistory(false);
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

    return () => {
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
      // Dispose WebGL addon explicitly before term.dispose() to avoid
      // "Cannot read properties of undefined (reading '_isDisposed')" crash
      // that occurs when the AddonManager tries to dispose a partially-initialized
      // WebGL renderer during component unmount (e.g. switching tasks).
      if (webglAddonRef.current) {
        try { webglAddonRef.current.dispose(); } catch { /* ignore */ }
        webglAddonRef.current = null;
      }
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
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
          onClick={() => setTaskViewMode(task.id, 'conversation')}
          title="Switch to conversation view"
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
        {/* SDK tasks don't run a PTY — there's no terminal history to show.
            Surface that explicitly with a one-click jump to the chat view
            instead of leaving the user staring at an empty terminal. */}
        {task.id.startsWith('sdk-') && (
          <div className="terminal-sdk-notice">
            <div className="terminal-sdk-notice-icon">💬</div>
            <div className="terminal-sdk-notice-title">No terminal output for SDK tasks</div>
            <div className="terminal-sdk-notice-msg">
              This task runs through the Claude Agent SDK, which streams structured
              events directly to the chat view — there's no PTY producing terminal
              bytes. Switch to Chat to see the conversation.
            </div>
            <button
              type="button"
              className="terminal-sdk-notice-btn"
              onClick={() => setTaskViewMode(task.id, 'conversation')}
            >
              Switch to Chat
            </button>
          </div>
        )}
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
