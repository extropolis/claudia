import { useState, useRef, useEffect } from 'react';
import { useTaskStore } from '../stores/taskStore';
import { PlanViewer } from './PlanViewer';
import { ImageAttachment } from '@claudia/shared';
import { Send, Bot, User, Info, Loader2, Copy, Check, ImagePlus, X, Folder, Trash2, Briefcase } from 'lucide-react';
import { VoiceInput } from './VoiceInput';
import { useSpeechSynthesis } from '../hooks/useSpeechSynthesis';

interface ChatPanelProps {
    onSendMessage: (content: string, images?: ImageAttachment[]) => void;
    onClearChat: () => void;
    onApprovePlan: () => void;
    onRejectPlan: () => void;
    onSetActiveWorkspace: (workspaceId: string) => void;
}

export function ChatPanel({ onSendMessage, onClearChat, onApprovePlan, onRejectPlan, onSetActiveWorkspace }: ChatPanelProps) {
    const [input, setInput] = useState('');
    const [copied, setCopied] = useState(false);
    const [attachedImages, setAttachedImages] = useState<ImageAttachment[]>([]);
    const {
        chatMessages,
        isConnected,
        isThinking,
        currentPlan,
        setShowProjectPicker,
        currentProject,
        workspaces,
        activeWorkspaceId,
        voiceEnabled,
        autoSpeakResponses,
        selectedVoiceName,
        voiceRate,
        voicePitch,
        voiceVolume
    } = useTaskStore();
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const lastSpokenMessageIdRef = useRef<string | null>(null);

    // Speech synthesis
    const { speak, cancel, voices, setSelectedVoice } = useSpeechSynthesis({
        rate: voiceRate,
        pitch: voicePitch,
        volume: voiceVolume
    });

    // Auto-scroll to bottom on new messages
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [chatMessages, isThinking]);

    // Update selected voice when voice name changes
    useEffect(() => {
        if (selectedVoiceName && voices.length > 0) {
            const voice = voices.find(v => v.name === selectedVoiceName);
            if (voice) {
                setSelectedVoice(voice);
            }
        }
    }, [selectedVoiceName, voices, setSelectedVoice]);

    // Auto-speak assistant responses
    useEffect(() => {
        if (!autoSpeakResponses || !voiceEnabled) return;

        const lastMessage = chatMessages[chatMessages.length - 1];
        if (lastMessage && lastMessage.role === 'assistant' && lastMessage.id !== lastSpokenMessageIdRef.current) {
            lastSpokenMessageIdRef.current = lastMessage.id;
            speak(lastMessage.content);
        }
    }, [chatMessages, autoSpeakResponses, voiceEnabled, speak]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            cancel();
        };
    }, [cancel]);

    const copyConversation = async () => {
        const conversationText = chatMessages
            .map(msg => `[${msg.role.toUpperCase()}]\n${msg.content}`)
            .join('\n\n---\n\n');

        try {
            await navigator.clipboard.writeText(conversationText);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files) return;

        const newImages: ImageAttachment[] = [];

        for (let i = 0; i < files.length; i++) {
            const file = files[i];

            // Only accept images
            if (!file.type.startsWith('image/')) continue;

            try {
                const base64 = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => {
                        const result = reader.result as string;
                        // Extract base64 data without the data URL prefix
                        const base64Data = result.split(',')[1];
                        resolve(base64Data);
                    };
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });

                newImages.push({
                    name: file.name,
                    data: base64,
                    mimeType: file.type
                });
            } catch (err) {
                console.error('Failed to read file:', err);
            }
        }

        setAttachedImages(prev => [...prev, ...newImages]);

        // Reset the file input so the same file can be selected again
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    };

    const removeImage = (index: number) => {
        setAttachedImages(prev => prev.filter((_, i) => i !== index));
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim() && attachedImages.length === 0) return;

        onSendMessage(input.trim(), attachedImages.length > 0 ? attachedImages : undefined);
        setInput('');
        setAttachedImages([]);
        // Refocus the input after sending
        setTimeout(() => inputRef.current?.focus(), 0);
    };

    const handleVoiceTranscript = (transcript: string, isFinal: boolean) => {
        if (isFinal) {
            // Append to input on final result
            setInput(prev => (prev ? prev + ' ' + transcript : transcript));
            // Focus input for user to see the result
            inputRef.current?.focus();
        }
    };

    const getRoleIcon = (role: 'user' | 'assistant' | 'system') => {
        switch (role) {
            case 'user':
                return <User size={18} />;
            case 'assistant':
                return <Bot size={18} />;
            case 'system':
                return <Info size={18} />;
        }
    };

    const activeWorkspace = workspaces.find(w => w.id === activeWorkspaceId);

    return (
        <div className="chat-panel">
            <div className="chat-header">
                <h2>💬 Chat with Orchestrator</h2>
                <div className="header-actions">
                    {workspaces.length > 0 && (
                        <div className="workspace-selector">
                            <Briefcase size={14} />
                            <select
                                value={activeWorkspaceId || ''}
                                onChange={(e) => onSetActiveWorkspace(e.target.value)}
                                disabled={!isConnected}
                                title="Active workspace for orchestrator"
                            >
                                {!activeWorkspaceId && <option value="">Select workspace</option>}
                                {workspaces.map(ws => (
                                    <option key={ws.id} value={ws.id}>{ws.name}</option>
                                ))}
                            </select>
                        </div>
                    )}
                    <button
                        className={`copy-button ${copied ? 'copied' : ''}`}
                        onClick={copyConversation}
                        disabled={chatMessages.length === 0}
                        title="Copy conversation to clipboard"
                    >
                        {copied ? <Check size={16} /> : <Copy size={16} />}
                        {copied ? 'Copied!' : 'Copy'}
                    </button>
                    <button
                        className="copy-button"
                        onClick={onClearChat}
                        disabled={chatMessages.length === 0}
                        title="Clear conversation"
                    >
                        <Trash2 size={16} />
                        Clear
                    </button>
                    <div className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
                        {isConnected ? '● Connected' : '○ Disconnected'}
                    </div>
                </div>
            </div>

            <div className="chat-messages">
                {chatMessages.length === 0 && !isThinking ? (
                    <div className="empty-state">
                        <Bot size={48} />
                        <p>Send a message to start a task.</p>
                        <p className="hint">Try: "Create a simple Node.js hello world script"</p>
                    </div>
                ) : (
                    <>
                        {chatMessages.map((msg) => (
                            <div key={msg.id} className={`chat-message ${msg.role}`}>
                                <div className="message-icon">
                                    {getRoleIcon(msg.role)}
                                </div>
                                <div className="message-wrapper">
                                    {msg.images && msg.images.length > 0 && (
                                        <div className="message-images">
                                            {msg.images.map((img, idx) => (
                                                <div key={idx} className="message-image">
                                                    <img
                                                        src={`data:${img.mimeType};base64,${img.data}`}
                                                        alt={img.name}
                                                        title={img.name}
                                                    />
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    <pre className="message-content">
                                        {msg.content}
                                    </pre>
                                    {msg.suggestedActions && msg.suggestedActions.length > 0 && (
                                        <div className="suggested-actions">
                                            {msg.suggestedActions.map((action, index) => (
                                                <button
                                                    key={index}
                                                    className="action-button"
                                                    onClick={() => onSendMessage(action.action)}
                                                    disabled={!isConnected || isThinking}
                                                >
                                                    {action.label}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                        {isThinking && (
                            <div className="chat-message assistant thinking">
                                <div className="message-icon">
                                    <Loader2 size={18} className="thinking-spinner" />
                                </div>
                                <div className="message-content thinking-indicator">
                                    <span className="thinking-dots">
                                        <span>●</span>
                                        <span>●</span>
                                        <span>●</span>
                                    </span>
                                    <span className="thinking-text">Thinking...</span>
                                </div>
                            </div>
                        )}
                    </>
                )}
                <div ref={messagesEndRef} />
            </div>

            {/* Plan Viewer - shown when there's a pending plan */}
            {currentPlan && currentPlan.status === 'pending' && (
                <PlanViewer onApprove={onApprovePlan} onReject={onRejectPlan} />
            )}

            <div className="chat-input-container">
                {attachedImages.length > 0 && (
                    <div className="image-preview-container">
                        {attachedImages.map((img, idx) => (
                            <div key={idx} className="image-preview">
                                <img
                                    src={`data:${img.mimeType};base64,${img.data}`}
                                    alt={img.name}
                                    title={img.name}
                                />
                                <button
                                    type="button"
                                    className="image-remove"
                                    onClick={() => removeImage(idx)}
                                    title="Remove image"
                                >
                                    <X size={16} />
                                </button>
                            </div>
                        ))}
                    </div>
                )}

                <form className="chat-input-form" onSubmit={handleSubmit}>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        multiple
                        onChange={handleImageSelect}
                        style={{ display: 'none' }}
                    />
                    <button
                        type="button"
                        className="project-select-button"
                        onClick={() => setShowProjectPicker(true)}
                        disabled={!isConnected || isThinking}
                        title={currentProject ? `Current: ${currentProject}` : "Select project directory"}
                    >
                        <Folder size={18} />
                        {currentProject && (
                            <span className="project-indicator"></span>
                        )}
                    </button>
                    <button
                        type="button"
                        className="image-attach-button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={!isConnected || isThinking}
                        title="Attach image"
                    >
                        <ImagePlus size={20} />
                    </button>
                    {voiceEnabled && (
                        <VoiceInput
                            onTranscript={handleVoiceTranscript}
                            disabled={!isConnected || isThinking}
                        />
                    )}
                    <input
                        ref={inputRef}
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder="Type a task for the orchestrator..."
                        disabled={!isConnected || isThinking}
                    />
                    <button
                        type="submit"
                        disabled={!isConnected || (!input.trim() && attachedImages.length === 0) || isThinking}
                    >
                        <Send size={20} />
                    </button>
                </form>
            </div>
        </div>
    );
}

