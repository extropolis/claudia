import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Task, Workspace } from '@claudia/shared';
import { Copy, Check, Play, BookOpen } from 'lucide-react';
import { TaskInputBar } from './TaskInputBar';
import { LearnFromConversationModal } from './LearnFromConversationModal';
import '@xterm/xterm/css/xterm.css';
import './TerminalView.css';

interface TerminalViewProps {
    task: Task;
    wsRef: React.RefObject<WebSocket | null>;
    workspace?: Workspace;
}

export function TerminalView({ task, wsRef, workspace }: TerminalViewProps) {
    const terminalRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const resizeDebounceRef = useRef<number | null>(null);
    const userHasScrolledRef = useRef(false); // Track if user manually scrolled up
    const [copied, setCopied] = useState(false);
    const [showLearnModal, setShowLearnModal] = useState(false);

    // Expose scrollToBottom for external use (resets user scroll state since it's explicit)
    const scrollToBottom = (resetUserScroll = true) => {
        if (resetUserScroll) {
            userHasScrolledRef.current = false;
        }
        if (xtermRef.current) {
            xtermRef.current.scrollToBottom();
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

    const debouncedFitTerminal = () => {
        if (resizeDebounceRef.current) {
            window.clearTimeout(resizeDebounceRef.current);
        }
        resizeDebounceRef.current = window.setTimeout(() => {
            fitTerminal();
            resizeDebounceRef.current = null;
        }, 100); // 100ms debounce
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

        // Reset user scroll state when task changes (new terminal instance)
        userHasScrolledRef.current = false;

        // CRITICAL: Clear any existing terminal content from the DOM container
        // This prevents visual artifacts when switching between tasks
        // The container may have leftover canvas/elements from a previous terminal instance
        // that wasn't properly cleaned up due to React's async nature
        while (terminalRef.current.firstChild) {
            terminalRef.current.removeChild(terminalRef.current.firstChild);
        }

        // Create terminal instance
        const term = new Terminal({
            cursorBlink: true,
            fontSize: 14,
            fontFamily: '"SF Mono", "Monaco", "Inconsolata", "Fira Code", monospace',
            scrollback: 10000,  // Large scrollback to preserve history
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

        // Add addons
        const fitAddon = new FitAddon();
        const webLinksAddon = new WebLinksAddon();

        term.loadAddon(fitAddon);
        term.loadAddon(webLinksAddon);

        // Handle terminal input - send to backend
        term.onData((data) => {
            if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({
                    type: 'task:input',
                    payload: { taskId: task.id, input: data }
                }));
            }
        });

        // Handle terminal resize - notify backend (set up BEFORE fit() so initial size is sent)
        term.onResize(({ cols, rows }) => {
            if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({
                    type: 'task:resize',
                    payload: { taskId: task.id, cols, rows }
                }));
            }
        });

        // Open terminal in the DOM
        term.open(terminalRef.current);

        // Store references
        xtermRef.current = term;
        fitAddonRef.current = fitAddon;

        // CRITICAL: Fully reset the terminal state after opening
        // This clears any potential garbage data from previous instances
        // Based on xterm.js best practices for switching between terminal instances:
        // 1. reset() - reset modes, cursor, etc.
        // 2. clear() - clear buffer + scrollback
        // 3. clearTextureAtlas() - force full redraw of glyphs (canvas renderer)
        // 4. refresh() - ensure full repaint
        term.reset();
        term.clear();
        term.clearTextureAtlas();
        term.refresh(0, term.rows - 1);

        // Start initial fit sequence
        requestAnimationFrame(() => {
            attemptFit();
            // check if terminal is still valid before focusing
            if (xtermRef.current) {
                xtermRef.current.focus();
            }
        });

        // Use ResizeObserver to detect container size changes (more reliable than window resize)
        // Use debounced version to prevent excessive calls during drag resize
        const resizeObserver = new ResizeObserver(() => {
            // Immediate fit on resize to prevent visual lag
            fitTerminal();
            // And debounce for final polish
            debouncedFitTerminal();
        });
        resizeObserver.observe(terminalRef.current);

        // Also handle window resize as fallback
        const handleResize = () => {
            fitTerminal();
            debouncedFitTerminal();
        };
        window.addEventListener('resize', handleResize);

        // Track output for scroll-on-settle behavior
        let scrollSettleTimeout: number | null = null;
        let refreshTimeout: number | null = null;
        let isRestoringHistory = false;
        let hasReceivedRestore = false; // Guard against duplicate restore messages
        const SCROLL_SETTLE_DELAY = 150; // Wait 150ms after last output to scroll
        const REFRESH_DELAY = 200; // Refresh terminal after output burst settles

        // Schedule a terminal fit + refresh after output settles (fixes rendering artifacts)
        const scheduleRefresh = () => {
            if (refreshTimeout) {
                clearTimeout(refreshTimeout);
            }
            refreshTimeout = window.setTimeout(() => {
                if (fitAddonRef.current && xtermRef.current) {
                    fitAddonRef.current.fit();
                    const rows = xtermRef.current.rows;
                    xtermRef.current.refresh(0, rows - 1);
                }
                refreshTimeout = null;
            }, REFRESH_DELAY);
        };

        // Track user scroll events to detect manual scrolling
        term.onScroll(() => {
            // Only mark as user-scrolled if we're past the initial restore phase
            // and user scrolled away from bottom
            if (!isRestoringHistory && xtermRef.current) {
                const buffer = xtermRef.current.buffer.active;
                const viewportTop = buffer.viewportY;
                const maxScrollY = buffer.baseY;
                // User has scrolled up if they're not at the bottom
                userHasScrolledRef.current = viewportTop < maxScrollY;
            }
        });

        // Function to scroll after output settles
        const scheduleScrollOnSettle = () => {
            // Don't auto-scroll if user has manually scrolled up
            if (userHasScrolledRef.current) {
                console.log(`[TerminalView] Skipping auto-scroll - user has scrolled up for ${task.id}`);
                return;
            }
            if (scrollSettleTimeout) {
                clearTimeout(scrollSettleTimeout);
            }
            scrollSettleTimeout = window.setTimeout(() => {
                if (xtermRef.current && !userHasScrolledRef.current) {
                    console.log(`[TerminalView] Output settled, scrolling to bottom for ${task.id}`);
                    xtermRef.current.scrollToBottom();
                }
                scrollSettleTimeout = null;
            }, SCROLL_SETTLE_DELAY);
        };

        // WebSocket message handler for this terminal
        const handleMessage = (event: MessageEvent) => {
            try {
                const message = JSON.parse(event.data);

                if (message.type === 'task:output') {
                    const { taskId, data } = message.payload;
                    if (taskId === task.id) {
                        term.write(data);
                        // Schedule a refresh to fix any rendering artifacts
                        scheduleRefresh();
                        // After history restore, keep scrolling to bottom as output arrives
                        if (isRestoringHistory) {
                            scheduleScrollOnSettle();
                        }
                    }
                } else if (message.type === 'task:restore') {
                    const { taskId, history } = message.payload;
                    if (taskId === task.id && history) {
                        // Guard against duplicate restore messages
                        if (hasReceivedRestore) {
                            console.log(`[TerminalView] Ignoring duplicate task:restore for ${taskId}`);
                            return;
                        }
                        hasReceivedRestore = true;
                        console.log(`[TerminalView] Received task:restore for ${taskId}, history length: ${history.length}`);
                        isRestoringHistory = true;

                        // CRITICAL FIX: Fit terminal BEFORE writing history.
                        // This ensures the rows/cols are correct for the container size before
                        // we dump massive amounts of text. If we don't do this, xterm might
                        // wrap text based on default dimensions (80x24) and then try to reflow
                        // later, which causes the "messy/duplicated text" issues.
                        fitTerminal();

                        // Fully reset terminal before restoring history to prevent visual artifacts
                        // Based on xterm.js best practices:
                        // 1. reset() - reset modes, cursor, etc.
                        // 2. clear() - clear buffer + scrollback
                        // 3. clearTextureAtlas() - force full redraw of glyphs (canvas renderer)
                        // 4. refresh() - ensure full repaint
                        term.reset();
                        term.clear();
                        term.clearTextureAtlas();
                        term.refresh(0, term.rows - 1);
                        // Write history - it goes into scrollback buffer
                        // Claude's TUI will redraw the screen but history remains scrollable
                        term.write(history, () => {
                            console.log(`[TerminalView] History write complete for ${taskId}, scrolling to bottom`);
                            // Callback fires after write is fully processed
                            term.scrollToBottom();

                            // Force multiple fit + refresh cycles to fix rendering artifacts
                            // This mimics what happens when the user resizes the window
                            const fitAndRefresh = () => {
                                if (fitAddonRef.current && xtermRef.current) {
                                    fitAddonRef.current.fit();
                                    const rows = xtermRef.current.rows;
                                    xtermRef.current.refresh(0, rows - 1);
                                    xtermRef.current.scrollToBottom();
                                }
                            };

                            // Fit immediately and then again after short delays
                            fitAndRefresh();
                            setTimeout(fitAndRefresh, 50);
                            setTimeout(fitAndRefresh, 150);
                            setTimeout(fitAndRefresh, 300);

                            // Schedule additional scrolls as output continues to arrive
                            scheduleScrollOnSettle();
                            // Stop the restore scroll behavior after 3 seconds
                            setTimeout(() => {
                                isRestoringHistory = false;
                                if (scrollSettleTimeout) {
                                    clearTimeout(scrollSettleTimeout);
                                    scrollSettleTimeout = null;
                                }
                                // Final scroll only if user hasn't scrolled up
                                if (xtermRef.current && !userHasScrolledRef.current) {
                                    xtermRef.current.scrollToBottom();
                                }
                            }, 3000);
                        });
                    }
                }
            } catch (err) {
                // Ignore parse errors
            }
        };

        if (wsRef.current) {
            wsRef.current.addEventListener('message', handleMessage);
        }

        // Request session restore and activate task on server
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
                type: 'task:select',
                payload: { taskId: task.id }
            }));
        }

        // Scroll to bottom when terminal mounts (with delays to catch history loads)
        // This ensures we scroll even if the terminal:scrollToBottom event fired before mounting
        console.log(`[TerminalView] Terminal mounted for ${task.id}, scheduling scroll to bottom`);
        const scrollDelays = [50, 200, 500, 1000];
        const scrollTimeouts = scrollDelays.map(delay =>
            setTimeout(() => {
                // Only auto-scroll if user hasn't scrolled up
                if (xtermRef.current && !userHasScrolledRef.current) {
                    console.log(`[TerminalView] Scrolling to bottom after ${delay}ms for ${task.id}`);
                    xtermRef.current.scrollToBottom();
                }
            }, delay)
        );

        // Cleanup
        return () => {
            console.log(`[TerminalView] Cleaning up terminal for task ${task.id}`);
            // Clear scroll timeouts
            scrollTimeouts.forEach(t => clearTimeout(t));
            if (scrollSettleTimeout) {
                clearTimeout(scrollSettleTimeout);
            }
            if (refreshTimeout) {
                clearTimeout(refreshTimeout);
            }
            resizeObserver.disconnect();
            window.removeEventListener('resize', handleResize);
            if (wsRef.current) {
                wsRef.current.removeEventListener('message', handleMessage);
            }
            // Clear any pending resize debounce
            if (resizeDebounceRef.current) {
                window.clearTimeout(resizeDebounceRef.current);
                resizeDebounceRef.current = null;
            }
            // Clear terminal before disposal to prevent visual artifacts
            // when a new terminal is created for a different task
            // Use the full reset sequence before dispose
            term.reset();
            term.clear();
            term.clearTextureAtlas();
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
        setShowLearnModal(true);
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
                        title="Learn from this conversation - extracts learnings for future tasks"
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
                <button
                    className="debug-fit-button"
                    onClick={() => {
                        alert(`Debug Fit: Current size ${xtermRef.current?.cols}x${xtermRef.current?.rows}`);
                        console.log('[TerminalView] Manual fit requested');
                        fitTerminal();
                        if (xtermRef.current) {
                            console.log(`[TerminalView] Post-fit Dimensions: ${xtermRef.current.cols}x${xtermRef.current.rows}`);
                            // Force send resize to backend to see if it responds
                            if (wsRef.current?.readyState === WebSocket.OPEN) {
                                console.log('[TerminalView] Sending forced resize to backend');
                                wsRef.current.send(JSON.stringify({
                                    type: 'task:resize',
                                    payload: {
                                        taskId: task.id,
                                        cols: xtermRef.current.cols,
                                        rows: xtermRef.current.rows
                                    }
                                }));
                            } else {
                                alert('WebSocket not open!');
                            }
                        }
                    }}
                    style={{ marginLeft: '8px', padding: '2px 6px', fontSize: '10px', background: '#e5a00d', border: '1px solid #555', color: '#000', cursor: 'pointer', fontWeight: 'bold' }}
                    title="Debug: Force terminal fit and sync to backend"
                >
                    Debug Fit (Alert)
                </button>
                <span className={`terminal-state ${task.state}`}>{stateLabel}</span>
            </div>
            <div ref={terminalRef} className="terminal-container" />
            <TaskInputBar task={task} wsRef={wsRef} />

            {showLearnModal && workspace && (
                <LearnFromConversationModal
                    taskId={task.id}
                    workspaceId={workspace.id}
                    workspaceName={workspace.name}
                    onClose={() => setShowLearnModal(false)}
                />
            )}
        </div>
    );
}
