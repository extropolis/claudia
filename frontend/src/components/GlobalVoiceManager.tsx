import { useEffect, useRef, useCallback } from 'react';
import { useVoiceRecognition } from '../hooks/useVoiceRecognition';
import { useTaskStore } from '../stores/taskStore';

/**
 * GlobalVoiceManager - A logic-only component that manages global voice recognition.
 * This component should be rendered at the App root level.
 * It listens for voice input when globalVoiceEnabled is true and routes
 * transcripts to the store for consumption by focused input components.
 */
export function GlobalVoiceManager() {
    const {
        globalVoiceEnabled,
        autoSendEnabled,
        autoSendDelayMs,
        focusedInputId,
        appendVoiceTranscript,
        setVoiceInterimTranscript
    } = useTaskStore();

    const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);
    const lastTranscriptTimeRef = useRef<number>(0);

    // Clear silence timer
    const clearSilenceTimer = useCallback(() => {
        if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
        }
    }, []);

    // Handle auto-send on silence
    const scheduleAutoSend = useCallback(() => {
        if (!autoSendEnabled || !focusedInputId) return;

        clearSilenceTimer();
        silenceTimerRef.current = setTimeout(() => {
            // Dispatch custom event for auto-send
            window.dispatchEvent(new CustomEvent('voice:autoSend', {
                detail: { inputId: focusedInputId }
            }));
        }, autoSendDelayMs);
    }, [autoSendEnabled, autoSendDelayMs, focusedInputId, clearSilenceTimer]);

    // Handle voice recognition results
    const handleResult = useCallback((transcript: string, isFinal: boolean) => {
        lastTranscriptTimeRef.current = Date.now();

        if (isFinal) {
            appendVoiceTranscript(transcript);
            setVoiceInterimTranscript('');
            // Schedule auto-send after final transcript
            scheduleAutoSend();
        } else {
            setVoiceInterimTranscript(transcript);
            // Clear timer while still receiving interim results
            clearSilenceTimer();
        }
    }, [appendVoiceTranscript, setVoiceInterimTranscript, scheduleAutoSend, clearSilenceTimer]);

    const {
        isSupported,
        isListening,
        startListening,
        stopListening
    } = useVoiceRecognition({
        continuous: true,
        interimResults: true,
        onResult: handleResult,
        onError: (error) => {
            console.warn('GlobalVoiceManager error:', error);
        }
    });

    // Start/stop listening based on globalVoiceEnabled
    useEffect(() => {
        if (!isSupported) return;

        if (globalVoiceEnabled && !isListening) {
            startListening();
        } else if (!globalVoiceEnabled && isListening) {
            stopListening();
            clearSilenceTimer();
        }
    }, [globalVoiceEnabled, isListening, isSupported, startListening, stopListening, clearSilenceTimer]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            clearSilenceTimer();
        };
    }, [clearSilenceTimer]);

    // This is a logic-only component, no UI
    return null;
}
