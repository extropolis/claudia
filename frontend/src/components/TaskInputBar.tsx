import { useRef, useEffect, useCallback, useState } from 'react';
import { Send, MessageSquare, ImagePlus, X } from 'lucide-react';
import { Task } from '@claudia/shared';
import { useTaskStore } from '../stores/taskStore';
import { getApiBaseUrl } from '../config/api-config';
import './TaskInputBar.css';

interface UploadedImage {
    filename: string;
    filePath: string;
    originalName: string;
    previewUrl: string;
}

interface TaskInputBarProps {
    task: Task;
    wsRef: React.RefObject<WebSocket | null>;
}

export function TaskInputBar({ task, wsRef }: TaskInputBarProps) {
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [images, setImages] = useState<UploadedImage[]>([]);
    const [isDragging, setIsDragging] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);

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

    // Upload image to server
    const uploadImage = async (file: File): Promise<UploadedImage | null> => {
        const formData = new FormData();
        formData.append('image', file);

        try {
            const response = await fetch(`${getApiBaseUrl()}/api/upload/image`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Upload failed');
            }

            const result = await response.json();
            return {
                filename: result.filename,
                filePath: result.filePath,
                originalName: result.originalName,
                previewUrl: URL.createObjectURL(file)
            };
        } catch (error) {
            console.error('Image upload failed:', error);
            setUploadError(error instanceof Error ? error.message : 'Upload failed');
            setTimeout(() => setUploadError(null), 3000);
            return null;
        }
    };

    // Delete image from server
    const deleteImage = async (image: UploadedImage) => {
        try {
            await fetch(`${getApiBaseUrl()}/api/upload/image/${image.filename}`, {
                method: 'DELETE'
            });
        } catch (error) {
            console.error('Failed to delete image:', error);
        }
        URL.revokeObjectURL(image.previewUrl);
        setImages(prev => prev.filter(img => img.filename !== image.filename));
    };

    // Handle file selection
    const handleFileSelect = async (files: FileList | null) => {
        if (!files) return;

        const imageFiles = Array.from(files).filter(file =>
            file.type.startsWith('image/')
        );

        for (const file of imageFiles) {
            const uploaded = await uploadImage(file);
            if (uploaded) {
                setImages(prev => [...prev, uploaded]);
            }
        }
    };

    // Drag and drop handlers
    const handleDragEnter = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(true);
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        // Only set to false if leaving the container entirely
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setIsDragging(false);
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const handleDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);

        const files = e.dataTransfer.files;
        await handleFileSelect(files);
    };

    const sendMessage = useCallback(() => {
        if (!message.trim() && images.length === 0) return;
        if (wsRef.current?.readyState !== WebSocket.OPEN) return;

        // Clear any pending voice transcript
        if (globalVoiceEnabled) {
            clearVoiceTranscript();
        }

        // Build the message with image paths
        let fullMessage = message;
        if (images.length > 0) {
            const imagePaths = images.map(img => img.filePath).join('\n');
            const imageText = images.length === 1
                ? `\n\n[Attached image: ${imagePaths}]`
                : `\n\n[Attached images:\n${imagePaths}]`;
            fullMessage = message + imageText;
        }

        // Send the message followed by Enter key to submit it to Claude
        const messageWithEnter = fullMessage + '\r';
        wsRef.current.send(JSON.stringify({
            type: 'task:input',
            payload: { taskId: task.id, input: messageWithEnter }
        }));

        clearTaskDraftInput(task.id);
        // Clear images after sending (don't delete from server - Claude may need them)
        images.forEach(img => URL.revokeObjectURL(img.previewUrl));
        setImages([]);
    }, [message, images, wsRef, task.id, globalVoiceEnabled, clearVoiceTranscript, clearTaskDraftInput]);

    // Listen for auto-send event
    useEffect(() => {
        const handleAutoSend = (e: CustomEvent<{ inputId: string }>) => {
            if (e.detail.inputId === inputId && (message.trim() || images.length > 0)) {
                sendMessage();
            }
        };

        window.addEventListener('voice:autoSend', handleAutoSend as EventListener);
        return () => {
            window.removeEventListener('voice:autoSend', handleAutoSend as EventListener);
        };
    }, [inputId, message, images, sendMessage]);

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

    // Cleanup preview URLs on unmount
    useEffect(() => {
        return () => {
            images.forEach(img => URL.revokeObjectURL(img.previewUrl));
        };
    }, []);

    const isDisabled = task.state === 'exited' || task.state === 'disconnected' || task.state === 'interrupted';

    // Show interim transcript when focused and listening
    const showInterim = globalVoiceEnabled && isFocused && voiceInterimTranscript;

    return (
        <div
            className={`task-input-bar ${isDisabled ? 'disabled' : ''} ${isFocused && globalVoiceEnabled ? 'voice-active' : ''} ${isDragging ? 'dragging' : ''}`}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
        >
            {/* Image previews */}
            {images.length > 0 && (
                <div className="task-input-images">
                    {images.map(img => (
                        <div key={img.filename} className="task-input-image-preview">
                            <img src={img.previewUrl} alt={img.originalName} />
                            <button
                                className="task-input-image-remove"
                                onClick={() => deleteImage(img)}
                                title="Remove image"
                            >
                                <X size={14} />
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {/* Upload error message */}
            {uploadError && (
                <div className="task-input-error">{uploadError}</div>
            )}

            {/* Drop zone overlay */}
            {isDragging && (
                <div className="task-input-dropzone">
                    <ImagePlus size={32} />
                    <span>Drop images here</span>
                </div>
            )}

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

                {/* Image upload button */}
                <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isDisabled}
                    className="task-input-upload"
                    title="Attach image"
                >
                    <ImagePlus size={18} />
                </button>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={(e) => handleFileSelect(e.target.files)}
                    style={{ display: 'none' }}
                />

                <button
                    onClick={() => sendMessage()}
                    disabled={isDisabled || (!message.trim() && images.length === 0)}
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
