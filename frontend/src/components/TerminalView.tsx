import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Task, Workspace } from '@claudia/shared';
import { Copy, Check, Play, BookOpen, ArrowDown } from 'lucide-react';
import { TaskInputBar } from './TaskInputBar';
import '@xterm/xterm/css/xterm.css';
import './TerminalView.css';

interface TerminalViewProps {
    task: Task;
    wsRef: React.RefObject<WebSocket | null>;
    workspace?: Workspace;
    isMobile?: boolean;
}

export function TerminalView({ task, wsRef, workspace, isMobile }: TerminalViewProps) {
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

        // Safety timeout - hide spinner after 10s even if no restore received
        const safetyTimeout = setTimeout(() => {
            if (!historyLoadedRef.current) {
                console.log(`[TerminalView] Safety timeout: hiding loading spinner for ${task.id}`);
                historyLoadedRef.current = true;
                setIsLoadingHistory(false);
            }
        }, 10000);

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
        if (!xtermRef.current) return;

        // Get all text from the terminal buffer
        const buffer = xtermRef.current.buffer.active;
        const lines: string[] = [];
        for (let i = 0; i < buffer.length; i++) {
            const line = buffer.getLine(i);
            if (line) {
                lines.push(line.translateToString(true));
            }
        }

        // Trim empty lines from end
        while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
            lines.pop();
        }

        const text = lines.join('\n');

        try {
            await navigator.clipboard.writeText(text);
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
            // Even if successful, try again shortly to ensure font metrics are loaded
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
            scrollOnInput: false, // Disable automatic scroll on data write - we'll control it manually
            theme: {
                background: '#0a0a0a',
                foreground: '#d4d4d4',
                cursor: '#d4d4d4',
                black: '#0a0a0a',
                red: '#cd3131',
                green: '#0dbc79',
                yellow: '#e5e510',
                blue: '#2472c8',
                magenta: '#bc3fbc',
                cyan: '#11a8cd',
                white: '#e5e5e5',
                brightBlack: '#666666',
                brightRed: '#f14c4c',
                brightGreen: '#23d18b',
                brightYellow: '#f5f543',
                brightBlue: '#3b8eea',
                brightMagenta: '#d670d6',
                brightCyan: '#29b8db',
                brightWhite: '#e5e5e5',
            },
        });

        const fitAddon = new FitAddon();
        const webLinksAddon = new WebLinksAddon();

        term.loadAddon(fitAddon);
        term.loadAddon(webLinksAddon);

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

        // Handle resize - sync to backend
        term.onResize(({ cols, rows }) => {
            if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({
                    type: 'task:resize',
                    payload: { taskId: task.id, cols, rows }
                }));
            }
        });

        // Open terminal
        term.open(terminalRef.current);
        xtermRef.current = term;
        fitAddonRef.current = fitAddon;

        // Track user scroll position to prevent auto-scroll when user has scrolled up
        // We need to distinguish between programmatic scrolls and user scrolls
        const isAtBottom = () => {
            if (!term) return true;
            const viewport = term.buffer.active.viewportY;
            const totalRows = term.buffer.active.length;
            // Consider "at bottom" if within 2 rows of the bottom
            return viewport + term.rows >= totalRows - 2;
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

        // Attach scroll listener
        term.onScroll(handleScroll);

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

        // Initial fit - Delayed to ensure DOM is ready
        requestAnimationFrame(() => {
            try {
                fitAddon.fit();
                // Force a resize event to ensure backend is synced even if size didn't "change" from default
                const { cols, rows } = term;
                if (wsRef.current?.readyState === WebSocket.OPEN) {
                    wsRef.current.send(JSON.stringify({
                        type: 'task:resize',
                        payload: { taskId: task.id, cols, rows }
                    }));
                }
            } catch (e) {
                console.error('[TerminalView] Initial fit failed:', e);
            }
        });

        // ResizeObserver for container changes
        let resizeTimeout: number;
        const resizeObserver = new ResizeObserver(() => {
            // Debounce resize
            if (resizeTimeout) window.clearTimeout(resizeTimeout);
            resizeTimeout = window.setTimeout(() => {
                if (fitAddonRef.current) {
                    try {
                        fitAddonRef.current.fit();
                    } catch (e) {
                        console.warn('[TerminalView] Resize fit failed:', e);
                    }
                }
            }, 50);
        });

        resizeObserver.observe(terminalRef.current);

        // Window resize fallback
        const handleWindowResize = () => {
            if (resizeTimeout) window.clearTimeout(resizeTimeout);
            resizeTimeout = window.setTimeout(() => {
                fitAddonRef.current?.fit();
            }, 50);
        };
        window.addEventListener('resize', handleWindowResize);

        // Message handler
        const handleMessage = (event: MessageEvent) => {
            try {
                const message = JSON.parse(event.data);
                if (message.type === 'task:output' && message.payload.taskId === task.id) {
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

                    term.write(message.payload.data);

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
                        console.log(`[TerminalView] First output received, clearing loading state for ${task.id}`);
                        historyLoadedRef.current = true;
                        setIsLoadingHistory(false);
                    }
                } else if (message.type === 'task:restore' && message.payload.taskId === task.id) {
                    const { history } = message.payload;
                    console.log(`[TerminalView] task:restore received for ${task.id}, history size: ${history?.length || 0}`);
                    if (history) {
                        term.reset();
                        term.write(history);
                        console.log(`[TerminalView] History written to terminal for ${task.id}`);
                        // Scroll to bottom after history is restored (programmatic scroll)
                        programmaticScrollRef.current = true;
                        requestAnimationFrame(() => {
                            term.scrollToBottom();
                            setTimeout(() => {
                                programmaticScrollRef.current = false;
                            }, 50);
                        });
                    } else {
                        console.warn(`[TerminalView] task:restore received but history is empty for ${task.id}`);
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

        // Activate task
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
                type: 'task:select',
                payload: { taskId: task.id }
            }));
        }

        return () => {
            if (resizeTimeout) window.clearTimeout(resizeTimeout);
            resizeObserver.disconnect();
            window.removeEventListener('resize', handleWindowResize);
            if (wsRef.current) {
                wsRef.current.removeEventListener('message', handleMessage);
            }
            term.dispose();
            xtermRef.current = null;
            fitAddonRef.current = null;
        };
    }, [task.id, wsRef]);

    // Refit on task ID change (when switching between tasks)
    // Refit on task ID change (when switching between tasks)
    useEffect(() => {
        // Use a small timeout to let layout settle after task switch
        const timeoutId = setTimeout(() => {
            fitTerminal();
        }, 0);
        return () => clearTimeout(timeoutId);
    }, [task.id]);

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
                    title="Copy terminal content to clipboard"
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
                        className="mobile-scroll-bottom-btn"
                        onClick={() => scrollToBottom(true)}
                        title="Scroll to bottom"
                    >
                        <ArrowDown size={20} />
                    </button>
                )}
            </div>
            <TaskInputBar task={task} wsRef={wsRef} />

        </div>
    );
}
