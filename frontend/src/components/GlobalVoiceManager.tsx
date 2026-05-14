import { useEffect, useRef, useCallback } from 'react';
import { useDeepgramRecognition } from '../hooks/useDeepgramRecognition';
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
    deepgramApiKey,
    appendVoiceTranscript,
    setVoiceInterimTranscript,
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
      window.dispatchEvent(
        new CustomEvent('voice:autoSend', {
          detail: { inputId: focusedInputId },
        }),
      );
    }, autoSendDelayMs);
  }, [autoSendEnabled, autoSendDelayMs, focusedInputId, clearSilenceTimer]);

  // Handle voice recognition results
  const handleResult = useCallback(
    (transcript: string, isFinal: boolean) => {
      lastTranscriptTimeRef.current = Date.now();

      // Auto-focus logic: if no input is focused and we receive voice input,
      // automatically focus the most appropriate input field
      if (!focusedInputId && transcript.trim()) {
        // Try to focus the selected task's input, or fall back to new task input
        const selectedTaskInput = document.querySelector(
          '[data-input-type="task-input"]',
        ) as HTMLElement;
        const newTaskInput = document.querySelector(
          '[data-input-type="new-task-input"]',
        ) as HTMLElement;

        if (selectedTaskInput) {
          selectedTaskInput.focus();
        } else if (newTaskInput) {
          newTaskInput.focus();
        }
      }

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
    },
    [
      appendVoiceTranscript,
      setVoiceInterimTranscript,
      scheduleAutoSend,
      clearSilenceTimer,
      focusedInputId,
    ],
  );

  // Handle listening state changes - just for logging
  // We intentionally do NOT auto-disable globalVoiceEnabled here because:
  // 1. In continuous mode, recognition naturally stops/restarts on silence
  // 2. The hook handles its own restart logic
  // 3. If there's a fatal error, the user will notice and can toggle manually
  const handleListeningChange = useCallback((listening: boolean) => {
    console.log('[GlobalVoiceManager] Listening state changed:', listening);
  }, []);

  const { isSupported, isListening, startListening, stopListening } = useDeepgramRecognition({
    continuous: true,
    interimResults: true,
    deepgramApiKey,
    onResult: handleResult,
    onError: (error) => {
      console.warn('[GlobalVoiceManager] Voice recognition error:', error);
    },
    onListeningChange: handleListeningChange,
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
  }, [
    globalVoiceEnabled,
    isListening,
    isSupported,
    startListening,
    stopListening,
    clearSilenceTimer,
  ]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearSilenceTimer();
    };
  }, [clearSilenceTimer]);

  // This is a logic-only component, no UI
  return null;
}
