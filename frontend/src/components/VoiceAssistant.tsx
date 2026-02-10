/**
 * VoiceAssistant - OpenAI Realtime API voice interface component
 *
 * Provides a floating voice assistant interface for:
 * - Real-time voice conversations with AI
 * - Voice commands for task management
 * - Task completion announcements
 */

import { useState, useEffect, useCallback } from 'react';
import {
    Mic,
    MicOff,
    Volume2,
    VolumeX,
    MessageSquare,
    X,
    Loader2,
    Send,
    ChevronDown,
    ChevronUp
} from 'lucide-react';
import { useVoiceAssistant } from '../hooks/useVoiceAssistant';
import { useTaskStore } from '../stores/taskStore';
import './VoiceAssistant.css';

interface VoiceAssistantProps {
    onTaskCreated?: (taskId: string, prompt: string) => void;
}

export function VoiceAssistant({ onTaskCreated }: VoiceAssistantProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    const [textInput, setTextInput] = useState('');
    const [showTextInput, setShowTextInput] = useState(false);
    const [conversationHistory, setConversationHistory] = useState<Array<{
        role: 'user' | 'assistant';
        content: string;
        timestamp: Date;
    }>>([]);

    const tasks = useTaskStore(state => state.tasks);
    const workspaces = useTaskStore(state => state.workspaces);
    const selectedTaskId = useTaskStore(state => state.selectedTaskId);
    // Get workspace from selected task
    const selectedTask = selectedTaskId ? tasks.get(selectedTaskId) : null;
    const selectedWorkspaceId = selectedTask?.workspaceId || workspaces[0]?.id;

    const {
        isConnected,
        isConnecting,
        isListening,
        isSpeaking,
        transcript,
        response,
        error,
        connect,
        disconnect,
        startListening,
        stopListening,
        sendTextMessage,
        updateTaskContext,
        setCurrentWorkspace
    } = useVoiceAssistant({
        onCommandExecuted: (result) => {
            console.log('[VoiceAssistant] Command executed:', result);
            // Add assistant response to history
            if (result.result?.message) {
                addToHistory('assistant', result.result.message);
            }
        },
        onTaskCreated: (taskId, prompt) => {
            onTaskCreated?.(taskId, prompt);
            addToHistory('assistant', `Created task: ${prompt.slice(0, 50)}...`);
        },
        onError: (errorMsg) => {
            console.error('[VoiceAssistant] Error:', errorMsg);
        }
    });

    // Add message to conversation history
    const addToHistory = useCallback((role: 'user' | 'assistant', content: string) => {
        setConversationHistory(prev => [
            ...prev.slice(-20), // Keep last 20 messages
            { role, content, timestamp: new Date() }
        ]);
    }, []);

    // Update transcript in history
    useEffect(() => {
        if (transcript && !isListening) {
            addToHistory('user', transcript);
        }
    }, [transcript, isListening, addToHistory]);

    // Update response in history
    useEffect(() => {
        if (response) {
            addToHistory('assistant', response);
        }
    }, [response, addToHistory]);

    // Update task context when tasks change
    useEffect(() => {
        if (isConnected) {
            const taskData = Array.from(tasks.values()).map(t => ({
                id: t.id,
                prompt: t.prompt,
                state: t.state,
                workspaceId: t.workspaceId
            }));
            updateTaskContext(taskData);
        }
    }, [tasks, isConnected, updateTaskContext]);

    // Update workspace context
    useEffect(() => {
        if (isConnected && selectedWorkspaceId) {
            setCurrentWorkspace(selectedWorkspaceId);
        }
    }, [selectedWorkspaceId, isConnected, setCurrentWorkspace]);

    // Handle connect/disconnect
    const handleToggleConnection = useCallback(() => {
        if (isConnected) {
            disconnect();
        } else {
            connect();
        }
    }, [isConnected, connect, disconnect]);

    // Handle text input submit
    const handleTextSubmit = useCallback((e: React.FormEvent) => {
        e.preventDefault();
        if (!textInput.trim() || !isConnected) return;

        addToHistory('user', textInput);
        sendTextMessage(textInput);
        setTextInput('');
    }, [textInput, isConnected, sendTextMessage, addToHistory]);

    // Render connection status indicator
    const renderStatus = () => {
        if (isConnecting) {
            return <span className="voice-status connecting">Connecting...</span>;
        }
        if (isConnected) {
            return <span className="voice-status connected">Connected</span>;
        }
        return <span className="voice-status disconnected">Disconnected</span>;
    };

    return (
        <div className={`voice-assistant ${isExpanded ? 'expanded' : ''}`}>
            {/* Collapsed state - just the microphone button */}
            {!isExpanded && (
                <button
                    className={`voice-assistant-toggle ${isListening ? 'listening' : ''} ${isSpeaking ? 'speaking' : ''}`}
                    onClick={() => setIsExpanded(true)}
                    title="Open Voice Assistant"
                >
                    {isSpeaking ? (
                        <Volume2 size={24} className="pulse-animation" />
                    ) : isListening ? (
                        <Mic size={24} className="pulse-animation" />
                    ) : (
                        <MessageSquare size={24} />
                    )}
                    {isConnected && (
                        <span className="voice-indicator connected" />
                    )}
                </button>
            )}

            {/* Expanded state - full interface */}
            {isExpanded && (
                <div className="voice-assistant-panel">
                    {/* Header */}
                    <div className="voice-assistant-header">
                        <div className="voice-assistant-title">
                            <MessageSquare size={18} />
                            <span>Voice Assistant</span>
                            {renderStatus()}
                        </div>
                        <div className="voice-assistant-actions">
                            <button
                                className="voice-header-btn"
                                onClick={() => setShowTextInput(!showTextInput)}
                                title={showTextInput ? 'Hide text input' : 'Show text input'}
                            >
                                {showTextInput ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                            </button>
                            <button
                                className="voice-header-btn close"
                                onClick={() => setIsExpanded(false)}
                                title="Minimize"
                            >
                                <X size={16} />
                            </button>
                        </div>
                    </div>

                    {/* Error display */}
                    {error && (
                        <div className="voice-error">
                            {error}
                        </div>
                    )}

                    {/* Conversation history */}
                    <div className="voice-conversation">
                        {conversationHistory.length === 0 ? (
                            <div className="voice-empty-state">
                                {isConnected ? (
                                    <>
                                        <Mic size={32} />
                                        <p>Click the microphone to start talking</p>
                                        <p className="voice-hint">
                                            Try saying: "Create a task to add a login page" or "What tasks are running?"
                                        </p>
                                    </>
                                ) : (
                                    <>
                                        <MicOff size={32} />
                                        <p>Click connect to start voice assistant</p>
                                        <p className="voice-hint">
                                            Requires OPENAI_API_KEY to be set on the server
                                        </p>
                                    </>
                                )}
                            </div>
                        ) : (
                            conversationHistory.map((msg, idx) => (
                                <div
                                    key={idx}
                                    className={`voice-message ${msg.role}`}
                                >
                                    <span className="voice-message-content">{msg.content}</span>
                                    <span className="voice-message-time">
                                        {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                </div>
                            ))
                        )}

                        {/* Current transcript (while speaking) */}
                        {isListening && transcript && (
                            <div className="voice-message user interim">
                                <span className="voice-message-content">{transcript}</span>
                                <Loader2 size={12} className="spinner" />
                            </div>
                        )}
                    </div>

                    {/* Text input (optional) */}
                    {showTextInput && isConnected && (
                        <form className="voice-text-input" onSubmit={handleTextSubmit}>
                            <input
                                type="text"
                                value={textInput}
                                onChange={(e) => setTextInput(e.target.value)}
                                placeholder="Type a message..."
                                disabled={!isConnected}
                            />
                            <button type="submit" disabled={!textInput.trim() || !isConnected}>
                                <Send size={16} />
                            </button>
                        </form>
                    )}

                    {/* Controls */}
                    <div className="voice-controls">
                        {/* Connect/Disconnect button */}
                        <button
                            className={`voice-control-btn ${isConnected ? 'connected' : ''}`}
                            onClick={handleToggleConnection}
                            disabled={isConnecting}
                            title={isConnected ? 'Disconnect' : 'Connect to voice service'}
                        >
                            {isConnecting ? (
                                <Loader2 size={18} className="spinner" />
                            ) : isConnected ? (
                                <VolumeX size={18} />
                            ) : (
                                <Volume2 size={18} />
                            )}
                            <span>{isConnecting ? 'Connecting...' : isConnected ? 'Disconnect' : 'Connect'}</span>
                        </button>

                        {/* Microphone button (push-to-talk style) */}
                        <button
                            className={`voice-mic-btn ${isListening ? 'listening' : ''} ${isSpeaking ? 'speaking' : ''}`}
                            onMouseDown={isConnected ? startListening : undefined}
                            onMouseUp={isConnected ? stopListening : undefined}
                            onMouseLeave={isConnected && isListening ? stopListening : undefined}
                            onTouchStart={isConnected ? startListening : undefined}
                            onTouchEnd={isConnected ? stopListening : undefined}
                            disabled={!isConnected || isSpeaking}
                            title={isConnected ? 'Hold to talk' : 'Connect first'}
                        >
                            {isListening ? (
                                <>
                                    <Mic size={24} className="pulse-animation" />
                                    <span>Listening...</span>
                                </>
                            ) : isSpeaking ? (
                                <>
                                    <Volume2 size={24} className="pulse-animation" />
                                    <span>Speaking...</span>
                                </>
                            ) : (
                                <>
                                    <Mic size={24} />
                                    <span>Hold to Talk</span>
                                </>
                            )}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
