import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { Task, Workspace, stripTerminalQueries } from '@claudia/shared';
import { Copy, Check, Play, BookOpen, ArrowDown } from 'lucide-react';
import { TaskInputBar } from './TaskInputBar';
import { CheckpointTimeline } from './CheckpointTimeline';
import { TaskTokenStats } from './TaskTokenStats';
import { useEffectiveTheme } from '../hooks/useTheme';
import { DARK_TERMINAL_THEME, LIGHT_TERMINAL_THEME } from '../types/theme';
import { lastKnownTerminalSize } from '../config/terminal-size';
import '@xterm/xterm/css/xterm.css';
import './TerminalView.css';

// RESTORE MODEL: the backend maintains a headless terminal mirror per task
// (backend/src/terminal-mirror.ts) and `task:restore` delivers a SERIALIZED
// SCREEN SNAPSHOT — well-formed ANSI valid at the cols/rows in the payload.
// No stripping of clears or queries is needed: the server-side emulator
// consumed them. The old raw-byte replay (with strip hacks and byte-offset
// chunk loading) is gone — it garbled cursor-positioned TUI output whenever
// any part of history was recorded at a different width.

interface TerminalViewProps {
    task: Task;
    wsRef: React.RefObject<WebSocket | null>;
    workspace?: Workspace;
    isMobile?: boolean;
}

export function TerminalView({ task, wsRef, workspace, isMobile }: TerminalViewProps) {
    const effectiveTheme = useEffectiveTheme();
    const terminalRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const userHasScrolledRef = useRef(false); // Track if user manually scrolled up
    const programmaticScrollRef = useRef(false); // Track programmatic scrolls to ignore in scroll handler
    const [copied, setCopied] = useState(false);
    const [isLoadingHistory, setIsLoadingHistory] = useState(true);
    const [showSpinner, setShowSpinner] = useState(false);
    const historyLoadedRef = useRef(false);

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

        if (terminalRef.current && (terminalRef.current.clientWidth > 0 && terminalRef.current.clientHeight > 0)) {
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
            const isPaste = (modKey && event.key === 'v') ||
                (!isMac && event.ctrlKey && event.shiftKey && event.key === 'V');
            if (isPaste) {
                // Prevent the browser's native paste event from also firing
                // (which would cause xterm to paste a second time)
                event.preventDefault();
                if (window.electronAPI?.readClipboard) {
                    const text = window.electronAPI.readClipboard();
                    if (text) term.paste(text);
                } else if (navigator.clipboard?.readText) {
                    navigator.clipboard.readText().then((text) => {
                        if (text) term.paste(text);
                    }).catch((err) => {
                        console.warn('[TerminalView] Clipboard paste failed:', err);
                    });
                }
                return false; // Prevent xterm from also handling the key
            }

            // Copy: Ctrl+C (Win/Linux), Cmd+C (Mac), or Ctrl+Shift+C (Linux terminal style)
            const isCopy = (modKey && event.key === 'c') ||
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
                wsRef.current.send(JSON.stringify({
                    type: 'task:input',
                    payload: { taskId: task.id, input: data }
                }));
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
        // Incremented per restore; write callbacks from a superseded restore
        // (a newer task:restore arrived mid-write) must not flush or scroll.
        let restoreGeneration = 0;

        const flushRestoreBuffer = () => {
            restoreInProgress = false;
            if (restoreOutputBuffer.length > 0) {
                const combined = restoreOutputBuffer.join('');
                restoreOutputBuffer = [];
                term.write(combined);
            }
        };


        // Self-heal repaint: after a resize settles, request a fresh snapshot
        // from the server-side mirror. A TUI redraw racing SIGWINCH can leave
        // transient garbled frames on screen; repainting from the mirror
        // restores a known-good screen. Skipped while the user is scrolled up
        // (a repaint would yank them to the bottom).
        let resyncTimer: number | undefined;
        const scheduleSnapshotResync = () => {
            if (resyncTimer) window.clearTimeout(resyncTimer);
            resyncTimer = window.setTimeout(() => {
                if (userHasScrolledRef.current) return;
                if (wsRef.current?.readyState === WebSocket.OPEN) {
                    console.log(`[TerminalView] Post-resize snapshot resync for ${task.id}`);
                    wsRef.current.send(JSON.stringify({
                        type: 'task:restore',
                        payload: { taskId: task.id }
                    }));
                }
            }, 600);
        };

        // Handle resize - sync to backend
        term.onResize(({ cols, rows }) => {
            if (initPhase) return; // Skip during init — we send one resize after fit
            if (restoreInProgress) return; // Skip transient resizes during snapshot restore
            // Suppress small col changes (scrollbar oscillation)
            if (Math.abs(cols - lastSentCols) <= 2 && rows === lastSentRows) return;
            lastSentCols = cols;
            lastSentRows = rows;
            lastKnownTerminalSize.cols = cols;
            lastKnownTerminalSize.rows = rows;

            // Start buffering output during the resize transition
            if (resizeBufferTimer) window.clearTimeout(resizeBufferTimer);
            resizeBuffering = true;
            resizeBuffer = [];
            resizeBufferTimer = window.setTimeout(flushResizeBuffer, RESIZE_BUFFER_MS);

            if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({
                    type: 'task:resize',
                    payload: { taskId: task.id, cols, rows }
                }));
            }

            scheduleSnapshotResync();
        });

        // Open terminal
        term.open(terminalRef.current);
        xtermRef.current = term;
        fitAddonRef.current = fitAddon;

        // WebGL renderer — GPU-accelerated, significantly faster for high-throughput
        // TUI output. Falls back to the DOM renderer on context loss or if WebGL2
        // is unavailable (headless, older hardware, certain VMs).
        try {
            const webglAddon = new WebglAddon();
            webglAddon.onContextLoss(() => {
                console.warn('[TerminalView] WebGL context lost — falling back to DOM renderer');
                webglAddon.dispose();
            });
            term.loadAddon(webglAddon);
        } catch (e) {
            console.warn('[TerminalView] WebGL unavailable, using DOM renderer:', e);
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

        const handleViewportScroll = () => {
            if (!viewport) return;
            const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 50;
            userHasScrolledRef.current = !atBottom;
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
                    navigator.clipboard.readText().then((text) => {
                        if (text) term.paste(text);
                    }).catch((err) => {
                        console.warn('[TerminalView] Right-click paste failed:', err);
                    });
                }
            }
        });

        // Fit the terminal BEFORE requesting the restore snapshot so the
        // task:resize sent below carries the real container size — for live
        // tasks the server resizes the PTY + mirror to it, so the snapshot
        // arrives already at our width (no client-side reflow needed).
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
                // Store so future task creations start with the right PTY size
                lastKnownTerminalSize.cols = cols;
                lastKnownTerminalSize.rows = rows;
                if (wsRef.current?.readyState === WebSocket.OPEN) {
                    wsRef.current.send(JSON.stringify({
                        type: 'task:resize',
                        payload: { taskId: task.id, cols, rows }
                    }));
                }

                // NOW request history — terminal is properly sized, so history
                // will render correctly without reflow.
                if (wsRef.current?.readyState === WebSocket.OPEN) {
                    wsRef.current.send(JSON.stringify({
                        type: 'task:select',
                        payload: { taskId: task.id }
                    }));
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

                    // Buffer output during resize transitions and snapshot restores
                    // to prevent garbled text from interleaving.
                    if (resizeBuffering || restoreInProgress) {
                        if (resizeBuffering) resizeBuffer.push(data);
                        if (restoreInProgress) restoreOutputBuffer.push(data);
                        return;
                    }

                    // Check if user is at bottom BEFORE writing
                    const viewport = term.buffer.active.viewportY;
                    const totalRows = term.buffer.active.length;
                    const wasAtBottom = viewport + term.rows >= totalRows - 2;

                    // Update userHasScrolledRef based on current position
                    if (!wasAtBottom && !userHasScrolledRef.current) {
                        console.log(`[TerminalView] User has scrolled up, disabling auto-scroll for ${task.id}`);
                        userHasScrolledRef.current = true;
                    }

                    console.log(`[TerminalView] Writing output, wasAtBottom: ${wasAtBottom}, userHasScrolled: ${userHasScrolledRef.current}, viewport: ${viewport}`);

                    term.write(data);

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
                    } else if (Number.isInteger(viewport)) {
                        // User was scrolled up - maintain their position.
                        // Guard against a non-finite viewportY (xterm's scrollToLine
                        // throws "This API only accepts integers" on NaN).
                        programmaticScrollRef.current = true;
                        term.scrollToLine(viewport);
                        setTimeout(() => {
                            programmaticScrollRef.current = false;
                        }, 100);
                    }

                    // Clear loading state on first output (task is live)
                    if (!historyLoadedRef.current) {
                        console.log(`[TerminalView] First output received, clearing loading state for ${task.id}`);
                        historyLoadedRef.current = true;
                        setIsLoadingHistory(false);
                    }
                } else if (message.type === 'task:restore' && message.payload.taskId === task.id) {
                    const { history, cols: snapCols, rows: snapRows } = message.payload as {
                        history?: string; cols?: number; rows?: number;
                    };
                    // cols/rows present => `history` is a serialized screen snapshot
                    // from the server-side terminal mirror, valid at that size.
                    const isSnapshot = typeof snapCols === 'number' && typeof snapRows === 'number';
                    console.log(`[TerminalView] task:restore received for ${task.id}, size: ${history?.length || 0}, snapshot: ${isSnapshot} (${snapCols}x${snapRows}), alreadyLoaded: ${historyLoadedRef.current}`);
                    if (history && history.length > 0) {
                        // Block task:output writes until the restore write completes.
                        // Without this, live output arriving between reset() and write()
                        // completion gets interleaved with the restore, garbling text.
                        // restoreInProgress also suppresses onResize forwarding, so the
                        // temporary resize to snapshot dimensions below never reaches
                        // the PTY (which must stay at the CLIENT's size).
                        restoreInProgress = true;
                        restoreOutputBuffer = [];
                        const generation = ++restoreGeneration;
                        // Discard any resize-buffered output: everything received
                        // before this task:restore is already IN the snapshot
                        // (the server serializes after all prior writes), so
                        // flushing it later would duplicate content.
                        if (resizeBufferTimer) window.clearTimeout(resizeBufferTimer);
                        resizeBuffering = false;
                        resizeBuffer = [];
                        programmaticScrollRef.current = true;
                        term.reset();
                        if (isSnapshot && (term.cols !== snapCols! || term.rows !== snapRows!)) {
                            // Write the snapshot at the size it was serialized at,
                            // then reflow to the container via fit() below —
                            // deterministic, same as resizing a native terminal.
                            try {
                                term.resize(snapCols!, snapRows!);
                            } catch (e) {
                                console.warn('[TerminalView] Failed to resize for snapshot restore:', e);
                            }
                        }
                        // Legacy raw fallback (no mirror/snapshot on the server):
                        // strip device queries so xterm can't answer replayed
                        // queries into the live PTY. Snapshots never contain them.
                        const text = isSnapshot ? history : stripTerminalQueries(history);
                        term.write(text, () => {
                            // A newer restore superseded this one mid-write —
                            // let its own callback do the fit/flush/scroll.
                            if (generation !== restoreGeneration) return;
                            // Reflow back to the container size (no-op when the
                            // snapshot size already matches).
                            try {
                                fitAddon.fit();
                            } catch { /* container may be hidden */ }
                            // Flush any output that arrived during the restore
                            flushRestoreBuffer();
                            term.scrollToBottom();
                            setTimeout(() => {
                                programmaticScrollRef.current = false;
                            }, 50);
                        });
                    } else {
                        term.reset();
                        term.write('\x1b[90m── Session history not available ──\x1b[0m\r\n');
                        console.log(`[TerminalView] Empty history for ${task.id}`);
                    }
                    // Clear loading state - the screen has been restored
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
            if (resyncTimer) window.clearTimeout(resyncTimer);
            resizeObserver.disconnect();
            window.removeEventListener('resize', handleWindowResize);
            if (viewport) {
                viewport.removeEventListener('scroll', handleViewportScroll);
            }
            if (wsRef.current) {
                wsRef.current.removeEventListener('message', handleMessage);
            }
            term.dispose();
            xtermRef.current = null;
            fitAddonRef.current = null;
        };
    }, [task.id, wsRef]);

    // Update terminal theme when app theme changes
    useEffect(() => {
        if (!xtermRef.current) return;
        xtermRef.current.options.theme = effectiveTheme === 'light' ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME;
    }, [effectiveTheme]);

    // Handle Resume button click - sends task:reconnect message to spawn new Claude process
    const handleResume = () => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
                type: 'task:reconnect',
                payload: { taskId: task.id }
            }));
        }
    };

    const showResumeButton = task.state === 'interrupted' || task.state === 'disconnected';
    const stateLabel = task.state === 'interrupted' ? 'INTERRUPTED' : task.state;

    const handleLearnFromConversation = () => {
        // Send /learn command to the active Claude Code terminal session
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
                type: 'task:input',
                payload: { taskId: task.id, input: '/learn\r' }
            }));
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
                                wsRef.current.send(JSON.stringify({
                                    type: 'task:input',
                                    payload: { taskId: task.id, input: '\x1b' }
                                }));
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
            <TaskTokenStats taskId={task.id} />
            {workspace && (
                <CheckpointTimeline taskId={task.id} workspaceId={workspace.id} wsRef={wsRef} />
            )}

        </div>
    );
}
