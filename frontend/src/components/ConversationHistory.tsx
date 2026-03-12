import { useState, useEffect, useRef } from 'react';
import { User, Bot, History, X, Copy, Check } from 'lucide-react';
import { getApiBaseUrl } from '../config/api-config';
import './ConversationHistory.css';

interface ConversationMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    uuid: string;
    thinking?: string;
}

interface ParsedConversation {
    sessionId: string;
    messages: ConversationMessage[];
    summary?: string;
}

interface ConversationHistoryProps {
    taskId: string;
    workspaceId: string;
    onClose: () => void;
}

export function ConversationHistory({ taskId, workspaceId, onClose }: ConversationHistoryProps) {
    const [conversation, setConversation] = useState<ParsedConversation | null>(null);
    const [sessions, setSessions] = useState<Array<{ sessionId: string; summary?: string; lastModified: string }>>([]);
    const [selectedSession, setSelectedSession] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showSessionPicker, setShowSessionPicker] = useState(false);
    const [copied, setCopied] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // Copy conversation to clipboard
    const copyToClipboard = async () => {
        if (!conversation) return;

        const text = conversation.messages
            .map(msg => `${msg.role === 'user' ? 'You' : 'Claude'}: ${msg.content}`)
            .join('\n\n');

        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    // First try to get conversation for the task's session
    useEffect(() => {
        const fetchTaskConversation = async () => {
            try {
                setLoading(true);
                setError(null);

                const response = await fetch(`${getApiBaseUrl()}/api/tasks/${taskId}/conversation`);

                if (response.ok) {
                    const data = await response.json();
                    setConversation(data);
                    setSelectedSession(data.sessionId);
                } else if (response.status === 404) {
                    // No session for this task, load session list
                    const sessionResp = await fetch(
                        `${getApiBaseUrl()}/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`
                    );
                    if (sessionResp.ok) {
                        const sessionData = await sessionResp.json();
                        setSessions(sessionData);
                        if (sessionData.length > 0) {
                            setShowSessionPicker(true);
                        } else {
                            setError('No conversation history found for this workspace');
                        }
                    }
                }
            } catch (err) {
                console.error('Failed to fetch conversation:', err);
                setError('Failed to load conversation history');
            } finally {
                setLoading(false);
            }
        };

        fetchTaskConversation();
    }, [taskId, workspaceId]);

    // Load a specific session
    const loadSession = async (sessionId: string) => {
        try {
            setLoading(true);
            setError(null);
            setShowSessionPicker(false);

            // We need to directly parse the session file
            // For now, we'll use the workspace sessions endpoint and fetch each message
            const response = await fetch(
                `${getApiBaseUrl()}/api/sessions/${sessionId}/conversation?workspaceId=${encodeURIComponent(workspaceId)}`
            );

            if (response.ok) {
                const data = await response.json();
                setConversation(data);
                setSelectedSession(sessionId);
            } else {
                setError('Failed to load session');
            }
        } catch (err) {
            console.error('Failed to load session:', err);
            setError('Failed to load session');
        } finally {
            setLoading(false);
        }
    };

    // Scroll to bottom when conversation loads
    useEffect(() => {
        if (messagesEndRef.current) {
            messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [conversation]);

    const formatTimestamp = (ts: string) => {
        try {
            return new Date(ts).toLocaleTimeString();
        } catch {
            return '';
        }
    };

    if (loading) {
        return (
            <div className="conversation-history">
                <div className="conversation-header">
                    <History size={18} />
                    <span>Conversation History</span>
                    <button className="close-button" onClick={onClose}>
                        <X size={18} />
                    </button>
                </div>
                <div className="conversation-loading">Loading conversation...</div>
            </div>
        );
    }

    if (showSessionPicker) {
        return (
            <div className="conversation-history">
                <div className="conversation-header">
                    <History size={18} />
                    <span>Select Session</span>
                    <button className="close-button" onClick={onClose}>
                        <X size={18} />
                    </button>
                </div>
                <div className="session-picker">
                    <p>This task doesn't have a linked session. Select a previous session:</p>
                    <div className="session-list">
                        {sessions.slice(0, 20).map((session) => (
                            <button
                                key={session.sessionId}
                                className="session-item"
                                onClick={() => loadSession(session.sessionId)}
                            >
                                <div className="session-summary">
                                    {session.summary || session.sessionId.substring(0, 8) + '...'}
                                </div>
                                <div className="session-date">
                                    {new Date(session.lastModified).toLocaleString()}
                                </div>
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="conversation-history">
                <div className="conversation-header">
                    <History size={18} />
                    <span>Conversation History</span>
                    <button className="close-button" onClick={onClose}>
                        <X size={18} />
                    </button>
                </div>
                <div className="conversation-error">{error}</div>
            </div>
        );
    }

    if (!conversation || conversation.messages.length === 0) {
        return (
            <div className="conversation-history">
                <div className="conversation-header">
                    <History size={18} />
                    <span>Conversation History</span>
                    <button className="close-button" onClick={onClose}>
                        <X size={18} />
                    </button>
                </div>
                <div className="conversation-empty">No messages in this conversation</div>
            </div>
        );
    }

    return (
        <div className="conversation-history">
            <div className="conversation-header">
                <History size={18} />
                <span>
                    {conversation.summary || `Session ${selectedSession?.substring(0, 8)}...`}
                </span>
                <button
                    className={`copy-button ${copied ? 'copied' : ''}`}
                    onClick={copyToClipboard}
                    title="Copy conversation to clipboard"
                >
                    {copied ? <Check size={16} /> : <Copy size={16} />}
                </button>
                <button className="close-button" onClick={onClose}>
                    <X size={18} />
                </button>
            </div>
            <div className="conversation-messages">
                {conversation.messages.map((msg) => (
                    <div key={msg.uuid} className={`message ${msg.role}`}>
                        <div className="message-header">
                            {msg.role === 'user' ? (
                                <User size={14} className="message-icon user" />
                            ) : (
                                <Bot size={14} className="message-icon assistant" />
                            )}
                            <span className="message-role">{msg.role === 'user' ? 'You' : 'Claude'}</span>
                            {msg.timestamp && (
                                <span className="message-time">{formatTimestamp(msg.timestamp)}</span>
                            )}
                        </div>
                        <div className="message-content">{msg.content}</div>
                    </div>
                ))}
                <div ref={messagesEndRef} />
            </div>
        </div>
    );
}
