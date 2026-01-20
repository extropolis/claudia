import { useRef, useEffect, useCallback } from 'react';
import { Send, MessageSquare } from 'lucide-react';
import { Task } from '@claudia/shared';
import { useTaskStore } from '../stores/taskStore';
import './TaskInputBar.css';

interface TaskInputBarProps {
    task: Task;
    wsRef: React.RefObject<WebSocket | null>;
}

export function TaskInputBar({ task, wsRef }: TaskInputBarProps) {
    const inputRef = useRef<HTMLTextAreaElement>(null);

    const {
        globalVoiceEnabled,
        focusedInputId,
        voiceTranscript,
        voiceInterimTranscript,
        setFocusedInputId,
        consumeVoiceTranscript,
        clearVoiceTranscript,
        setTaskDraftInput,
        getTaskDraftInput,
        clearTaskDraftInput
    } = useTaskStore();

    // Get the draft message from the store (preserved when switching tasks)
    const message = getTaskDraftInput(task.id);
    const setMessage = (value: string) => setTaskDraftInput(task.id, value);

    const inputId = `task-${task.id}`;
    const isFocused = focusedInputId === inputId;

    // Auto-resize textarea based on content
    useEffect(() => {
        if (inputRef.current) {
            inputRef.current.style.height = 'auto';
            inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 120) + 'px';
        }
    }, [message]);

    // Listen for focus request events (when task is selected)
    useEffect(() => {
        const handleFocusRequest = (e: CustomEvent<{ taskId: string }>) => {
            if (e.detail.taskId === task.id && inputRef.current) {
                inputRef.current.focus();
            }
        };

        window.addEventListener('taskInput:focus', handleFocusRequest as EventListener);
        return () => {
            window.removeEventListener('taskInput:focus', handleFocusRequest as EventListener);
        };
    }, [task.id]);

    // Append voice transcript to message when this input is focused
    useEffect(() => {
        if (isFocused && voiceTranscript) {
            setMessage(message ? message + ' ' + voiceTranscript : voiceTranscript);
            // Clear the transcript after consuming
            consumeVoiceTranscript();
        }
    }, [isFocused, voiceTranscript, consumeVoiceTranscript, message, setMessage]);

    const sendMessage = useCallback(() => {
        if (!message.trim()) return;
        if (wsRef.current?.readyState !== WebSocket.OPEN) return;

        // Clear any pending voice transcript
        if (globalVoiceEnabled) {
            clearVoiceTranscript();
        }

        // Send the message followed by Enter key to submit it to Claude
        const messageWithEnter = message + '\r';
        wsRef.current.send(JSON.stringify({
            type: 'task:input',
            payload: { taskId: task.id, input: messageWithEnter }
        }));

        clearTaskDraftInput(task.id);
    }, [message, wsRef, task.id, globalVoiceEnabled, clearVoiceTranscript, clearTaskDraftInput]);

    // Listen for auto-send event
    useEffect(() => {
        const handleAutoSend = (e: CustomEvent<{ inputId: string }>) => {
            if (e.detail.inputId === inputId && message.trim()) {
                sendMessage();
            }
        };

        window.addEventListener('voice:autoSend', handleAutoSend as EventListener);
        return () => {
            window.removeEventListener('voice:autoSend', handleAutoSend as EventListener);
        };
    }, [inputId, message, sendMessage]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // Send on Enter (without Shift)
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    const handleFocus = () => {
        setFocusedInputId(inputId);
    };

    const handleBlur = () => {
        // Only clear if this input is still the focused one
        // Use setTimeout to allow click events to fire first
        setTimeout(() => {
            const currentFocused = useTaskStore.getState().focusedInputId;
            if (currentFocused === inputId) {
                setFocusedInputId(null);
            }
        }, 100);
    };

    const isDisabled = task.state === 'exited' || task.state === 'disconnected' || task.state === 'interrupted';

    // Show interim transcript when focused and listening
    const showInterim = globalVoiceEnabled && isFocused && voiceInterimTranscript;

    return (
        <div className={`task-input-bar ${isDisabled ? 'disabled' : ''} ${isFocused && globalVoiceEnabled ? 'voice-active' : ''}`}>
            <div className="task-input-container">
                <MessageSquare size={18} className="task-input-icon" />
                <div className="task-input-textarea-wrapper">
                    <textarea
                        ref={inputRef}
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        onKeyDown={handleKeyDown}
                        onFocus={handleFocus}
                        onBlur={handleBlur}
                        placeholder={isDisabled ? 'Task is not running...' : 'Type a message to Claude...'}
                        disabled={isDisabled}
                        rows={1}
                        className="task-input-textarea"
                    />
                    {showInterim && (
                        <span className="interim-indicator">{voiceInterimTranscript}</span>
                    )}
                </div>
                <button
                    onClick={() => sendMessage()}
                    disabled={isDisabled || !message.trim()}
                    className="task-input-send"
                    title="Send message (Enter)"
                >
                    <Send size={18} />
                </button>
            </div>
            <div className="task-input-hint">
                Press Enter to send, Shift+Enter for new line
                {globalVoiceEnabled && isFocused && <span className="voice-hint"> | Voice active</span>}
            </div>
        </div>
    );
}
