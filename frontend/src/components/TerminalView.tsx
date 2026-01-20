import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Task } from '@claudia/shared';
import { Copy, Check, Play } from 'lucide-react';
import { TaskInputBar } from './TaskInputBar';
import '@xterm/xterm/css/xterm.css';
import './TerminalView.css';

interface TerminalViewProps {
    task: Task;
    wsRef: React.RefObject<WebSocket | null>;
}

export function TerminalView({ task, wsRef }: TerminalViewProps) {
    const terminalRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const resizeDebounceRef = useRef<number | null>(null);
    const [copied, setCopied] = useState(false);

    // Expose scrollToBottom for external use
    const scrollToBottom = () => {
        if (xtermRef.current) {
            xtermRef.current.scrollToBottom();
        }
    };

    // Listen for custom scroll-to-bottom events
    useEffect(() => {
        const handleScrollToBottom = (e: CustomEvent<{ taskId: string }>) => {
            if (e.detail.taskId === task.id) {
                console.log(`[TerminalView] Received scrollToBottom event for ${task.id}`);
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

    useEffect(() => {
        if (!terminalRef.current) return;

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

        // Helper to safely fit terminal (with debouncing for resize events)
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

        // Debounced version for resize events (prevents excessive calls during drag resize)
        const debouncedFitTerminal = () => {
            if (resizeDebounceRef.current) {
                window.clearTimeout(resizeDebounceRef.current);
            }
            resizeDebounceRef.current = window.setTimeout(() => {
                fitTerminal();
                resizeDebounceRef.current = null;
            }, 100); // 100ms debounce
        };

        // Initial fit with a small delay to ensure container has dimensions
        requestAnimationFrame(() => {
            fitTerminal();
            // check if terminal is still valid before focusing
            if (xtermRef.current) {
                xtermRef.current.focus();
            }
        });

        // Use ResizeObserver to detect container size changes (more reliable than window resize)
        // Use debounced version to prevent excessive calls during drag resize
        const resizeObserver = new ResizeObserver(() => {
            debouncedFitTerminal();
        });
        resizeObserver.observe(terminalRef.current);

        // Also handle window resize as fallback
        const handleResize = () => {
            debouncedFitTerminal();
        };
        window.addEventListener('resize', handleResize);

        // WebSocket message handler for this terminal
        const handleMessage = (event: MessageEvent) => {
            try {
                const message = JSON.parse(event.data);

                if (message.type === 'task:output') {
                    const { taskId, data } = message.payload;
                    if (taskId === task.id) {
                        term.write(data);
                    }
                } else if (message.type === 'task:restore') {
                    const { taskId, history } = message.payload;
                    if (taskId === task.id && history) {
                        console.log(`[TerminalView] Received task:restore for ${taskId}, history length: ${history.length}`);
                        // Write history - it goes into scrollback buffer
                        // Claude's TUI will redraw the screen but history remains scrollable
                        term.write(history, () => {
                            console.log(`[TerminalView] History write complete for ${taskId}, scrolling to bottom`);
                            // Callback fires after write is fully processed
                            // Use multiple scroll attempts to ensure we catch the final position
                            term.scrollToBottom();
                            requestAnimationFrame(() => {
                                term.scrollToBottom();
                            });
                            // Extra scroll after a short delay for large histories
                            setTimeout(() => {
                                term.scrollToBottom();
                            }, 100);
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
                if (xtermRef.current) {
                    console.log(`[TerminalView] Scrolling to bottom after ${delay}ms for ${task.id}`);
                    xtermRef.current.scrollToBottom();
                }
            }, delay)
        );

        // Cleanup
        return () => {
            // Clear scroll timeouts
            scrollTimeouts.forEach(t => clearTimeout(t));
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
            term.dispose();
            xtermRef.current = null;
            fitAddonRef.current = null;
        };
    }, [task.id, wsRef]);

    // Refit on task ID change (when switching between tasks)
    useEffect(() => {
        if (fitAddonRef.current && terminalRef.current) {
            // Check if container has valid dimensions
            if (terminalRef.current.clientWidth > 0 && terminalRef.current.clientHeight > 0) {
                // Use a small timeout to let layout settle after task switch
                const timeoutId = setTimeout(() => {
                    try {
                        fitAddonRef.current?.fit();
                    } catch (e) {
                        // Ignore fit errors during task switch
                    }
                }, 0);
                return () => clearTimeout(timeoutId);
            }
        }
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
            <div ref={terminalRef} className="terminal-container" />
            <TaskInputBar task={task} wsRef={wsRef} />
        </div>
    );
}
