import { useEffect, useRef, useState, useCallback } from 'react';
import { Task, Workspace } from '@claudia/shared';
import { Copy, Check, Play, BookOpen } from 'lucide-react';
import { TaskInputBar } from './TaskInputBar';
import './MobileOutputView.css';

/**
 * Strip ANSI escape codes from a string (client-side version)
 * Mirrors the backend stripAnsi from task-state-detection.ts
 */
function stripAnsi(str: string): string {
    return str
        .replace(/\x1b\[[0-9;]*m/g, '')
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/\x1b[PX^_].*?\x1b\\/g, '')
        .replace(/\x1b\[\?[0-9;]*[hl]/g, '')
        .replace(/\x1b[>=]/g, '')
        .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '')
        .replace(/\r/g, '');
}

interface MobileOutputViewProps {
    task: Task;
    wsRef: React.RefObject<WebSocket | null>;
    workspace?: Workspace;
}

export function MobileOutputView({ task, wsRef, workspace }: MobileOutputViewProps) {
    const [textContent, setTextContent] = useState('');
    const [copied, setCopied] = useState(false);
    const [isLoadingHistory, setIsLoadingHistory] = useState(true);
    const [showSpinner, setShowSpinner] = useState(false);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const userHasScrolledRef = useRef(false);
    const historyLoadedRef = useRef(false);
    const autoScrollRef = useRef(true);

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
        }, 300);

        const safetyTimeout = setTimeout(() => {
            if (!historyLoadedRef.current) {
                console.log(`[MobileOutputView] Safety timeout: hiding loading spinner for ${task.id}`);
                historyLoadedRef.current = true;
                setIsLoadingHistory(false);
            }
        }, 10000);

        return () => {
            clearTimeout(spinnerDelay);
            clearTimeout(safetyTimeout);
        };
    }, [isLoadingHistory, task.id]);

    // Auto-scroll to bottom when new content arrives (unless user scrolled up)
    const scrollToBottom = useCallback((force = false) => {
        if (!scrollContainerRef.current) return;
        if (!force && userHasScrolledRef.current) return;

        requestAnimationFrame(() => {
            if (scrollContainerRef.current) {
                scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
            }
        });
    }, []);

    // Detect user scroll-up to pause auto-scroll
    useEffect(() => {
        const container = scrollContainerRef.current;
        if (!container) return;

        const handleScroll = () => {
            const { scrollTop, scrollHeight, clientHeight } = container;
            const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
            userHasScrolledRef.current = !isAtBottom;
            autoScrollRef.current = isAtBottom;
        };

        container.addEventListener('scroll', handleScroll, { passive: true });
        return () => container.removeEventListener('scroll', handleScroll);
    }, []);

    // Listen for custom scroll-to-bottom events (user explicitly selected task)
    useEffect(() => {
        const handleScrollToBottom = (e: CustomEvent<{ taskId: string }>) => {
            if (e.detail.taskId === task.id) {
                console.log(`[MobileOutputView] Received scrollToBottom event for ${task.id}`);
                userHasScrolledRef.current = false;
                autoScrollRef.current = true;
                scrollToBottom(true);
            }
        };

        window.addEventListener('terminal:scrollToBottom', handleScrollToBottom as EventListener);
        return () => {
            window.removeEventListener('terminal:scrollToBottom', handleScrollToBottom as EventListener);
        };
    }, [task.id, scrollToBottom]);

    // WebSocket message handler for text output
    // Listens to both new task:textOutput/task:textRestore messages (backend-stripped)
    // AND falls back to task:output/task:restore with client-side ANSI stripping
    useEffect(() => {
        // Reset state when task changes
        setTextContent('');
        userHasScrolledRef.current = false;
        autoScrollRef.current = true;
        historyLoadedRef.current = false;
        setIsLoadingHistory(true);
        // Track whether we've received backend-stripped messages (prefer those)
        let receivedTextMessages = false;

        const handleMessage = (event: MessageEvent) => {
            try {
                const message = JSON.parse(event.data);
                const { type, payload } = message;
                if (payload?.taskId !== task.id) return;

                // === Preferred: backend-stripped text messages ===
                if (type === 'task:textOutput') {
                    receivedTextMessages = true;
                    setTextContent(prev => prev + payload.data);
                    if (!historyLoadedRef.current) {
                        console.log(`[MobileOutputView] First textOutput for ${task.id}`);
                        historyLoadedRef.current = true;
                        setIsLoadingHistory(false);
                    }
                    scrollToBottom();
                    return;
                }

                if (type === 'task:textRestore') {
                    receivedTextMessages = true;
                    console.log(`[MobileOutputView] textRestore for ${task.id}, size: ${payload.history?.length || 0}`);
                    if (payload.history) {
                        setTextContent(payload.history);
                    }
                    historyLoadedRef.current = true;
                    setIsLoadingHistory(false);
                    scrollToBottom(true);
                    return;
                }

                // === Fallback: strip ANSI client-side from raw terminal messages ===
                if (type === 'task:output' && !receivedTextMessages) {
                    const stripped = stripAnsi(payload.data);
                    if (stripped) {
                        setTextContent(prev => prev + stripped);
                    }
                    if (!historyLoadedRef.current) {
                        console.log(`[MobileOutputView] First output (fallback) for ${task.id}`);
                        historyLoadedRef.current = true;
                        setIsLoadingHistory(false);
                    }
                    scrollToBottom();
                    return;
                }

                if (type === 'task:restore' && !receivedTextMessages) {
                    console.log(`[MobileOutputView] restore (fallback) for ${task.id}, size: ${payload.history?.length || 0}`);
                    if (payload.history) {
                        setTextContent(stripAnsi(payload.history));
                    }
                    historyLoadedRef.current = true;
                    setIsLoadingHistory(false);
                    scrollToBottom(true);
                    return;
                }
            } catch (e) {
                console.error('[MobileOutputView] Message error:', e);
            }
        };

        if (wsRef.current) {
            wsRef.current.addEventListener('message', handleMessage);
        }

        // Activate task (same as TerminalView)
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
                type: 'task:select',
                payload: { taskId: task.id }
            }));
        }

        return () => {
            if (wsRef.current) {
                wsRef.current.removeEventListener('message', handleMessage);
            }
        };
    }, [task.id, wsRef, scrollToBottom]);

    // Scroll to bottom when textContent changes
    useEffect(() => {
        scrollToBottom();
    }, [textContent, scrollToBottom]);

    const copyToClipboard = async () => {
        try {
            await navigator.clipboard.writeText(textContent);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    const handleResume = () => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
                type: 'task:reconnect',
                payload: { taskId: task.id }
            }));
        }
    };

    const handleLearnFromConversation = () => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
                type: 'task:input',
                payload: { taskId: task.id, input: '/learn\r' }
            }));
        }
    };

    const showResumeButton = task.state === 'interrupted' || task.state === 'disconnected';
    const stateLabel = task.state === 'interrupted' ? 'INTERRUPTED' : task.state;

    return (
        <div className="mobile-output-view">
            <div className="mobile-output-header">
                <span className="mobile-output-title">{task.prompt}</span>
                <button
                    className={`mobile-output-copy ${copied ? 'copied' : ''}`}
                    onClick={copyToClipboard}
                    title="Copy output"
                >
                    {copied ? <Check size={16} /> : <Copy size={16} />}
                </button>
                {workspace && (
                    <button
                        className="mobile-output-learn"
                        onClick={handleLearnFromConversation}
                        title="Send /learn command"
                    >
                        <BookOpen size={14} />
                    </button>
                )}
                {showResumeButton && (
                    <button
                        className="mobile-output-resume"
                        onClick={handleResume}
                        title="Resume this task"
                    >
                        <Play size={14} />
                        Resume
                    </button>
                )}
                <span className={`terminal-state ${task.state}`}>{stateLabel}</span>
            </div>

            <div className="mobile-output-scroll-container" ref={scrollContainerRef}>
                {showSpinner && (
                    <div className="mobile-output-loading">
                        <div className="terminal-loading-spinner" />
                        <span>Loading session history...</span>
                    </div>
                )}
                <pre className="mobile-output-text">{textContent || (isLoadingHistory ? '' : 'Waiting for output...')}</pre>
            </div>

            {/* Scroll-to-bottom pill - show when user has scrolled up */}
            {userHasScrolledRef.current && (
                <button
                    className="mobile-output-scroll-pill"
                    onClick={() => {
                        userHasScrolledRef.current = false;
                        autoScrollRef.current = true;
                        scrollToBottom(true);
                    }}
                >
                    ↓ New output
                </button>
            )}

            <TaskInputBar task={task} wsRef={wsRef} />
        </div>
    );
}
