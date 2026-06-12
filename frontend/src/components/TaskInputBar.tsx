import { useRef, useEffect, useCallback, useState } from 'react';
import { Send, MessageSquare, ImagePlus, X, Clipboard, Clock } from 'lucide-react';
import { Task } from '@claudia/shared';
import { useTaskStore } from '../stores/taskStore';
import { getApiBaseUrl } from '../config/api-config';
import { ScheduledTasksModal } from './ScheduledTasksModal';
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
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const scheduledTaskCount = useTaskStore(
    (state) => Array.from(state.scheduledTasks.values()).filter((s) => s.taskId === task.id).length,
  );

  const globalVoiceEnabled = useTaskStore((s) => s.globalVoiceEnabled);
  const focusedInputId = useTaskStore((s) => s.focusedInputId);
  const voiceTranscript = useTaskStore((s) => s.voiceTranscript);
  const voiceInterimTranscript = useTaskStore((s) => s.voiceInterimTranscript);
  const setFocusedInputId = useTaskStore((s) => s.setFocusedInputId);
  const consumeVoiceTranscript = useTaskStore((s) => s.consumeVoiceTranscript);
  const clearVoiceTranscript = useTaskStore((s) => s.clearVoiceTranscript);
  const setTaskDraftInput = useTaskStore((s) => s.setTaskDraftInput);
  const getTaskDraftInput = useTaskStore((s) => s.getTaskDraftInput);
  const clearTaskDraftInput = useTaskStore((s) => s.clearTaskDraftInput);

  // Local state drives the textarea so typing doesn't update the global store
  // on every keystroke (which causes app-wide re-renders and visible input lag).
  // The store is used only as backing storage so drafts survive task switches.
  const [message, setMessageState] = useState<string>(() => getTaskDraftInput(task.id));

  // When the active task changes, swap to that task's persisted draft.
  useEffect(() => {
    setMessageState(getTaskDraftInput(task.id));
  }, [task.id, getTaskDraftInput]);

  const messageRef = useRef(message);
  messageRef.current = message;

  // Persist the draft to the store when leaving the field or unmounting.
  const persistDraft = useCallback(() => {
    setTaskDraftInput(task.id, messageRef.current);
  }, [setTaskDraftInput, task.id]);

  useEffect(() => {
    return () => {
      setTaskDraftInput(task.id, messageRef.current);
    };
  }, [task.id, setTaskDraftInput]);

  const setMessage = setMessageState;

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

  // Allow input for disconnected/exited/interrupted tasks — the backend auto-reconnects
  // with --resume when input is sent, preserving the session context.
  // Previously these states disabled the input bar, but writeToTask/reconnectTask handle them.
  const isDisabled = false; // All states accept input; backend handles reconnection as needed

  // Re-focus the textarea when the browser window regains focus.
  // Without this, focus can land on the xterm terminal and the first
  // keypress goes to the PTY instead of the input bar.
  useEffect(() => {
    const handleWindowFocus = () => {
      if (inputRef.current && !isDisabled) {
        inputRef.current.focus();
      }
    };
    window.addEventListener('focus', handleWindowFocus);
    return () => window.removeEventListener('focus', handleWindowFocus);
  }, [isDisabled]);

  // Append voice transcript to message when this input is focused
  // We use a ref to track processed transcripts to prevent duplicate appending
  const lastProcessedTranscriptRef = useRef<string>('');
  useEffect(() => {
    if (isFocused && voiceTranscript && voiceTranscript !== lastProcessedTranscriptRef.current) {
      lastProcessedTranscriptRef.current = voiceTranscript;
      setMessage((prev) => (prev ? prev + ' ' + voiceTranscript : voiceTranscript));
      consumeVoiceTranscript();
    }
  }, [isFocused, voiceTranscript, consumeVoiceTranscript, setMessage]);

  // Upload image to server
  const uploadImage = async (file: File): Promise<UploadedImage | null> => {
    const formData = new FormData();
    formData.append('image', file);

    try {
      const response = await fetch(`${getApiBaseUrl()}/api/upload/image`, {
        method: 'POST',
        body: formData,
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
        previewUrl: URL.createObjectURL(file),
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
        method: 'DELETE',
      });
    } catch (error) {
      console.error('Failed to delete image:', error);
    }
    URL.revokeObjectURL(image.previewUrl);
    setImages((prev) => prev.filter((img) => img.filename !== image.filename));
  };

  // Handle file selection
  const handleFileSelect = async (files: FileList | null) => {
    if (!files) return;

    const imageFiles = Array.from(files).filter((file) => file.type.startsWith('image/'));

    for (const file of imageFiles) {
      const uploaded = await uploadImage(file);
      if (uploaded) {
        setImages((prev) => [...prev, uploaded]);
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

  // Handle clipboard paste - intercept pasted images (e.g. from Print Screen, Snipping Tool)
  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const clipboardItems = e.clipboardData?.items;
    if (!clipboardItems) return;

    const imageItems: DataTransferItem[] = [];
    for (let i = 0; i < clipboardItems.length; i++) {
      const item = clipboardItems[i];
      if (item.type.startsWith('image/')) {
        imageItems.push(item);
      }
    }

    // If no images in clipboard, let the default paste behavior handle text
    if (imageItems.length === 0) return;

    // Prevent the default paste behavior so image data doesn't get inserted as text
    e.preventDefault();

    console.log(`[TaskInputBar] Pasting ${imageItems.length} image(s) from clipboard`);
    setIsUploading(true);

    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) {
        console.warn('[TaskInputBar] Failed to get file from clipboard item');
        continue;
      }

      // Give pasted images a meaningful name with timestamp
      const extension = file.type.split('/')[1] || 'png';
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const namedFile = new File([file], `clipboard-${timestamp}.${extension}`, {
        type: file.type,
      });

      console.log(
        `[TaskInputBar] Uploading pasted image: ${namedFile.name} (${namedFile.size} bytes, ${namedFile.type})`,
      );
      const uploaded = await uploadImage(namedFile);
      if (uploaded) {
        setImages((prev) => [...prev, uploaded]);
        console.log(`[TaskInputBar] Successfully uploaded pasted image: ${uploaded.filename}`);
      }
    }

    setIsUploading(false);
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
      const imagePaths = images.map((img) => img.filePath).join('\n');
      const imageText =
        images.length === 1
          ? `\n\n[Attached image: ${imagePaths}]`
          : `\n\n[Attached images:\n${imagePaths}]`;
      fullMessage = message + imageText;
    }

    // Send the message followed by Enter key to submit it to Claude
    const messageWithEnter = fullMessage + '\r';
    wsRef.current.send(
      JSON.stringify({
        type: 'task:input',
        payload: { taskId: task.id, input: messageWithEnter },
      }),
    );

    // Scroll terminal to bottom so user sees latest output
    window.dispatchEvent(
      new CustomEvent('terminal:scrollToBottom', {
        detail: { taskId: task.id },
      }),
    );

    clearTaskDraftInput(task.id);
    setMessageState('');
    // Clear images after sending (don't delete from server - Claude may need them)
    images.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    setImages([]);
  }, [
    message,
    images,
    wsRef,
    task.id,
    globalVoiceEnabled,
    clearVoiceTranscript,
    clearTaskDraftInput,
  ]);

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
    persistDraft();
    // Only clear if this input is still the focused one
    // Use setTimeout to allow click events to fire first
    setTimeout(() => {
      const currentFocused = useTaskStore.getState().focusedInputId;
      if (currentFocused === inputId) {
        setFocusedInputId(null);
      }
    }, 100);
  };

  // Track images in a ref so cleanup always has the latest list
  const imagesRef = useRef<UploadedImage[]>([]);
  imagesRef.current = images;

  // Cleanup preview URLs on unmount
  useEffect(() => {
    return () => {
      imagesRef.current.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    };
  }, []);

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
          {images.map((img) => (
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

      {/* Upload status messages */}
      {isUploading && (
        <div className="task-input-uploading">
          <Clipboard size={14} />
          <span>Uploading pasted image...</span>
        </div>
      )}
      {uploadError && <div className="task-input-error">{uploadError}</div>}

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
            onPaste={handlePaste}
            onFocus={handleFocus}
            onBlur={handleBlur}
            placeholder={isDisabled ? 'Task is not running...' : 'Type a message to Claude...'}
            disabled={isDisabled}
            rows={1}
            className="task-input-textarea"
            data-input-type="task-input"
          />
          {showInterim && <span className="interim-indicator">{voiceInterimTranscript}</span>}
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

        {/* Schedule button */}
        <button
          onClick={() => setShowScheduleModal(true)}
          disabled={isDisabled}
          className={`task-input-schedule ${scheduledTaskCount > 0 ? 'has-schedules' : ''}`}
          title={
            scheduledTaskCount > 0
              ? `${scheduledTaskCount} scheduled task${scheduledTaskCount > 1 ? 's' : ''} - click to manage`
              : 'Schedule recurring prompts'
          }
        >
          <Clock size={18} />
          {scheduledTaskCount > 0 && (
            <span className="task-input-schedule-count">{scheduledTaskCount}</span>
          )}
        </button>

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
        Enter to send, Shift+Enter for new line, Ctrl+V to paste screenshots
        {globalVoiceEnabled && isFocused && <span className="voice-hint"> | Voice active</span>}
      </div>

      {showScheduleModal && (
        <ScheduledTasksModal
          taskId={task.id}
          taskName={task.displayName || task.prompt?.substring(0, 60) || task.id}
          initialPrompt={message.trim()}
          onClose={() => setShowScheduleModal(false)}
        />
      )}
    </div>
  );
}
