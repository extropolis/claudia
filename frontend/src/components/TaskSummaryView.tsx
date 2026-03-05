import { useState, useEffect, useRef, useCallback } from 'react';
import { User, Bot, Loader, MessageSquareText, Send, Play, BookOpen, Bell } from 'lucide-react';
import { Task, Workspace, ChatMessage, SummaryAction } from '@claudia/shared';
import { useTaskStore } from '../stores/taskStore';
import { useWebSocket } from '../hooks/useWebSocket';
import './TaskSummaryView.css';

interface TaskSummaryViewProps {
    task: Task;
    wsRef: React.RefObject<WebSocket | null>;
    workspace?: Workspace;
    isMobile?: boolean;
}

export function TaskSummaryView({ task, wsRef, workspace, isMobile: _isMobile }: TaskSummaryViewProps) {
    const [inputValue, setInputValue] = useState('');
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const prevCountRef = useRef(0);
    const isInitialRef = useRef(true);
    const userHasScrolledRef = useRef(false); // Track if user manually scrolled up
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const lastProcessedTranscriptRef = useRef<string>('');

    const {
        summaryMessages,
        summaryTyping,
        autoSpeakResponses,
        focusedInputId,
        voiceTranscript,
        voiceInterimTranscript,
        globalVoiceEnabled,
        setFocusedInputId,
        consumeVoiceTranscript,
    } = useTaskStore();

    const { sendSummaryChat, requestSummaryHistory, executeSummaryAction } = useWebSocket();

    const taskMessages = summaryMessages.get(task.id) || [];
    const isTyping = summaryTyping.get(task.id) || false;

    // Voice input integration
    const inputId = `summary-input-${task.id}`;
    const isFocused = focusedInputId === inputId;

    // Request history on mount / task change
    useEffect(() => {
        isInitialRef.current = true;
        prevCountRef.current = 0;
        userHasScrolledRef.current = false;
        requestSummaryHistory(task.id);
    }, [task.id, requestSummaryHistory]);

    // Detect user scroll to suppress auto-scroll when user scrolls up
    useEffect(() => {
        const container = messagesContainerRef.current;
        if (!container) return;

        const handleScroll = () => {
            const { scrollTop, scrollHeight, clientHeight } = container;
            // If user is more than 80px from bottom, they've scrolled up
            const isAtBottom = scrollHeight - scrollTop - clientHeight < 80;
            if (!isAtBottom) {
                userHasScrolledRef.current = true;
            } else {
                userHasScrolledRef.current = false;
            }
        };

        container.addEventListener('scroll', handleScroll, { passive: true });
        return () => container.removeEventListener('scroll', handleScroll);
    }, []);

    // Scroll to bottom helper
    const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
        if (messagesEndRef.current) {
            messagesEndRef.current.scrollIntoView({ behavior });
        }
    }, []);

    // Auto-scroll on new messages (only if user hasn't scrolled up)
    useEffect(() => {
        const messageCount = taskMessages.length;
        if (messageCount > prevCountRef.current || isInitialRef.current) {
            prevCountRef.current = messageCount;

            // On initial load, always scroll to bottom; otherwise respect user scroll
            if (isInitialRef.current) {
                if (messageCount > 0) {
                    // Use requestAnimationFrame to ensure DOM is rendered before scrolling
                    requestAnimationFrame(() => {
                        scrollToBottom('auto');
                    });
                    isInitialRef.current = false;
                }
            } else if (!userHasScrolledRef.current) {
                scrollToBottom('smooth');
            }
        }
    }, [taskMessages.length, scrollToBottom]);

    // TTS for new AI messages
    useEffect(() => {
        if (!autoSpeakResponses) return;
        const lastMsg = taskMessages[taskMessages.length - 1];
        if (lastMsg && lastMsg.role === 'assistant' && taskMessages.length > prevCountRef.current - 1) {
            // The summary:speak event is dispatched from useWebSocket for alerts
            // For chat responses, we handle it here too
            if (!lastMsg.isAlert) {
                window.dispatchEvent(new CustomEvent('summary:speak', {
                    detail: { text: lastMsg.content, taskId: task.id }
                }));
            }
        }
    }, [taskMessages.length, autoSpeakResponses, task.id]);

    // Voice transcript consumption
    useEffect(() => {
        if (isFocused && voiceTranscript && voiceTranscript !== lastProcessedTranscriptRef.current) {
            lastProcessedTranscriptRef.current = voiceTranscript;
            setInputValue(prev => prev ? prev + ' ' + voiceTranscript : voiceTranscript);
            consumeVoiceTranscript();
        }
    }, [isFocused, voiceTranscript, consumeVoiceTranscript]);

    // Register as voice target on focus
    const handleFocus = () => {
        setFocusedInputId(inputId);
    };

    const handleSend = () => {
        const text = inputValue.trim();
        if (!text) return;
        sendSummaryChat(text, task.id);
        setInputValue('');
        // Reset scroll state so we auto-scroll to see the response
        userHasScrolledRef.current = false;
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
        }
    };

    const handleActionClick = (action: SummaryAction) => {
        executeSummaryAction(task.id, action);
    };

    const handleResume = () => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
                type: 'task:reconnect',
                payload: { taskId: task.id }
            }));
        }
    };

    const handleLearn = () => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
                type: 'task:input',
                payload: { taskId: task.id, input: '/learn\r' }
            }));
        }
    };

    const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInputValue(e.target.value);
        // Auto-resize
        e.target.style.height = 'auto';
        e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
    };

    const formatTimestamp = (ts: string) => {
        try {
            return new Date(ts).toLocaleTimeString();
        } catch {
            return '';
        }
    };

    const showResumeButton = task.state === 'interrupted' || task.state === 'disconnected';
    const stateLabel = task.state === 'interrupted' ? 'INTERRUPTED' : task.state;

    return (
        <div className="task-summary-view">
            <div className="terminal-header">
                <span className="terminal-title">{task.prompt}</span>
                {workspace && (
                    <button
                        className="learn-button"
                        onClick={handleLearn}
                        title="Send /learn command to Claude"
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

            <div className="summary-messages-container" ref={messagesContainerRef}>
                {taskMessages.length === 0 && !isTyping ? (
                    <div className="summary-empty">
                        <MessageSquareText size={48} strokeWidth={1} />
                        <h3>Summary Mode</h3>
                        <p>AI summaries and chat will appear here as the task runs.</p>
                        <p className="summary-empty-hint">Ask questions about this task or wait for automatic updates.</p>
                    </div>
                ) : (
                    <div className="summary-messages">
                        {taskMessages.map((msg: ChatMessage) => (
                            <div key={msg.id} className={`summary-message ${msg.role} ${msg.isAlert ? 'alert' : ''}`}>
                                <div className="summary-message-avatar">
                                    {msg.role === 'user' ? (
                                        <User size={16} />
                                    ) : msg.isAlert ? (
                                        <Bell size={16} />
                                    ) : (
                                        <Bot size={16} />
                                    )}
                                </div>
                                <div className="summary-message-body">
                                    <div className="summary-message-header">
                                        <span className="summary-message-role">
                                            {msg.role === 'user' ? 'You' : msg.isAlert ? 'Update' : 'AI'}
                                        </span>
                                        {msg.timestamp && (
                                            <span className="summary-message-time">
                                                {formatTimestamp(msg.timestamp)}
                                            </span>
                                        )}
                                    </div>
                                    <div className="summary-message-content">{msg.content}</div>

                                    {/* Action buttons */}
                                    {msg.actions && msg.actions.length > 0 && (
                                        <div className="summary-actions">
                                            {msg.actions.map((action: SummaryAction) => (
                                                <button
                                                    key={action.id}
                                                    className={`summary-action-btn ${action.type}`}
                                                    onClick={() => handleActionClick(action)}
                                                >
                                                    {action.label}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}

                        {isTyping && (
                            <div className="summary-typing-indicator">
                                <Loader size={14} className="summary-spinner" />
                                <span>Thinking...</span>
                            </div>
                        )}

                        <div ref={messagesEndRef} />
                    </div>
                )}
            </div>

            {/* Summary mode chat input */}
            <div className="summary-input-bar">
                <textarea
                    ref={textareaRef}
                    value={globalVoiceEnabled && isFocused && voiceInterimTranscript
                        ? inputValue + (inputValue ? ' ' : '') + voiceInterimTranscript
                        : inputValue}
                    onChange={handleTextareaChange}
                    onFocus={handleFocus}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleSend();
                        }
                    }}
                    placeholder="Ask about this task..."
                    rows={1}
                />
                <button
                    className="summary-send-btn"
                    onClick={handleSend}
                    disabled={!inputValue.trim()}
                    title="Send message"
                >
                    <Send size={18} />
                </button>
            </div>
        </div>
    );
}
