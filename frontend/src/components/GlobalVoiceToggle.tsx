import { useMemo } from 'react';
import { Mic, MicOff } from 'lucide-react';
import { useTaskStore } from '../stores/taskStore';
import './GlobalVoiceToggle.css';

/**
 * GlobalVoiceToggle - Header button for enabling/disabling always-listening voice mode.
 * Shows:
 * - Gray mic when OFF
 * - Red pulsing mic when ON
 * - Tooltip showing which input is focused
 */
export function GlobalVoiceToggle() {
    const {
        globalVoiceEnabled,
        focusedInputId,
        setGlobalVoiceEnabled,
        clearVoiceTranscript
    } = useTaskStore();

    // Check if Web Speech API is supported
    const isSupported = useMemo(() => {
        return !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
    }, []);

    // Determine the target description for the tooltip
    const targetDescription = useMemo(() => {
        if (!focusedInputId) return 'None';
        if (focusedInputId.startsWith('task-')) return 'Task Input';
        if (focusedInputId.startsWith('new-task-')) return 'New Task';
        if (focusedInputId.startsWith('chat-')) return 'Chat';
        return 'Input';
    }, [focusedInputId]);

    const handleToggle = () => {
        if (globalVoiceEnabled) {
            // Turning off - clear any pending transcript
            clearVoiceTranscript();
        }
        setGlobalVoiceEnabled(!globalVoiceEnabled);
    };

    if (!isSupported) {
        return (
            <button
                className="global-voice-toggle unsupported"
                disabled
                title="Voice input not supported in this browser"
            >
                <MicOff size={18} />
                <span>Voice</span>
            </button>
        );
    }

    return (
        <button
            className={`global-voice-toggle ${globalVoiceEnabled ? 'active' : ''}`}
            onClick={handleToggle}
            title={globalVoiceEnabled ? `Voice Mode ON - Speaking to: ${targetDescription}` : 'Enable Voice Mode'}
        >
            {globalVoiceEnabled ? (
                <Mic size={18} className="mic-active" />
            ) : (
                <Mic size={18} />
            )}
            <span>Voice</span>
            {globalVoiceEnabled && (
                <span className="voice-target-indicator">
                    {targetDescription}
                </span>
            )}
        </button>
    );
}
