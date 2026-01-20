import { useState, useEffect, useRef, useCallback } from 'react';

// Type definitions for Web Speech API
interface SpeechRecognitionEvent extends Event {
    results: SpeechRecognitionResultList;
    resultIndex: number;
}

interface SpeechRecognitionErrorEvent extends Event {
    error: string;
    message?: string;
}

interface SpeechRecognition extends EventTarget {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    onresult: ((event: SpeechRecognitionEvent) => void) | null;
    onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
    onend: (() => void) | null;
    onstart: (() => void) | null;
    start(): void;
    stop(): void;
    abort(): void;
}

interface VoiceRecognitionOptions {
    continuous?: boolean;
    interimResults?: boolean;
    language?: string;
    onResult?: (transcript: string, isFinal: boolean) => void;
    onError?: (error: string) => void;
    onListeningChange?: (isListening: boolean) => void;
}

export function useVoiceRecognition(options: VoiceRecognitionOptions = {}) {
    const {
        continuous = false,
        interimResults = true,
        language = 'en-US',
        onResult,
        onError,
        onListeningChange
    } = options;

    const [isListening, setIsListening] = useState(false);
    const [isSupported, setIsSupported] = useState(false);
    const [transcript, setTranscript] = useState('');
    const [interimTranscript, setInterimTranscript] = useState('');

    const recognitionRef = useRef<SpeechRecognition | null>(null);
    const shouldBeListeningRef = useRef(false);
    // Accumulate final transcript across recognition restarts in continuous mode
    const accumulatedTranscriptRef = useRef('');

    // Use refs for callbacks to avoid recreating recognition when callbacks change
    const onResultRef = useRef(onResult);
    const onErrorRef = useRef(onError);
    const onListeningChangeRef = useRef(onListeningChange);

    // Keep refs up to date
    useEffect(() => {
        onResultRef.current = onResult;
        onErrorRef.current = onError;
        onListeningChangeRef.current = onListeningChange;
    }, [onResult, onError, onListeningChange]);

    // Check for browser support and initialize
    useEffect(() => {
        const SpeechRecognitionAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

        if (!SpeechRecognitionAPI) {
            setIsSupported(false);
            return;
        }

        setIsSupported(true);
        const recognition = new SpeechRecognitionAPI();
        recognitionRef.current = recognition;

        // Configure recognition - MDN recommended settings
        recognition.continuous = continuous;
        recognition.interimResults = interimResults;
        recognition.lang = language;
        recognition.maxAlternatives = 1;

        // Handle results - based on MDN example
        recognition.onresult = (event: SpeechRecognitionEvent) => {
            let finalText = '';
            let interimText = '';

            // Process results starting from resultIndex (new results since last event)
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const result = event.results[i];
                const text = result[0].transcript;

                if (result.isFinal) {
                    finalText += text;
                } else {
                    interimText += text;
                }
            }

            if (finalText) {
                // In continuous mode, accumulate the transcript
                if (continuous) {
                    accumulatedTranscriptRef.current += finalText;
                    setTranscript(accumulatedTranscriptRef.current);
                } else {
                    setTranscript(finalText);
                }
                setInterimTranscript('');
                onResultRef.current?.(finalText, true);
            }

            if (interimText) {
                setInterimTranscript(interimText);
                onResultRef.current?.(interimText, false);
            }
        };

        // Handle errors
        recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
            console.log('[VoiceRecognition] Error:', event.error, '| shouldBeListening:', shouldBeListeningRef.current);

            // 'no-speech' is normal in continuous mode - just means silence
            if (event.error === 'no-speech') {
                // Don't report as error, let onend handle restart
                return;
            }

            // 'aborted' is expected when we stop manually
            if (event.error === 'aborted') {
                return;
            }

            const errorMessage = getErrorMessage(event.error);
            onErrorRef.current?.(errorMessage);

            // Fatal errors - stop completely
            if (event.error === 'not-allowed' || event.error === 'audio-capture') {
                console.warn('[VoiceRecognition] Fatal error, stopping completely:', event.error);
                setIsListening(false);
                shouldBeListeningRef.current = false;
                onListeningChangeRef.current?.(false);
            }
        };

        // Track restart attempts to prevent infinite retry loops
        let restartAttempts = 0;
        const maxRestartAttempts = 3;

        // Handle end - this is key for continuous mode
        // The Web Speech API stops after detecting silence, even with continuous=true
        // We need to restart it to keep listening
        recognition.onend = () => {
            console.log('[VoiceRecognition] onend fired | shouldBeListening:', shouldBeListeningRef.current, '| continuous:', continuous);
            setInterimTranscript('');

            if (shouldBeListeningRef.current && continuous) {
                // Reset attempts counter on successful listening session
                // (if we get here via normal end, not error)

                // Immediately restart for seamless continuous listening
                try {
                    console.log('[VoiceRecognition] Restarting... attempt:', restartAttempts + 1);
                    recognition.start();
                    restartAttempts = 0; // Reset on successful start
                } catch (e) {
                    restartAttempts++;
                    console.warn('[VoiceRecognition] Restart failed, attempt:', restartAttempts, '| error:', e);

                    if (restartAttempts >= maxRestartAttempts) {
                        console.error('[VoiceRecognition] Max restart attempts reached, giving up');
                        setIsListening(false);
                        shouldBeListeningRef.current = false;
                        onListeningChangeRef.current?.(false);
                        return;
                    }

                    // Already started or other error - try again shortly
                    setTimeout(() => {
                        if (shouldBeListeningRef.current && recognitionRef.current) {
                            try {
                                console.log('[VoiceRecognition] Delayed restart attempt:', restartAttempts + 1);
                                recognitionRef.current.start();
                                restartAttempts = 0; // Reset on successful start
                            } catch (retryError) {
                                restartAttempts++;
                                console.error('[VoiceRecognition] Delayed restart failed, attempt:', restartAttempts, '| error:', retryError);
                                if (restartAttempts >= maxRestartAttempts) {
                                    // Give up and notify user
                                    console.error('[VoiceRecognition] Max restart attempts reached after delay, giving up');
                                    setIsListening(false);
                                    shouldBeListeningRef.current = false;
                                    onListeningChangeRef.current?.(false);
                                }
                            }
                        }
                    }, 100);
                }
            } else {
                console.log('[VoiceRecognition] Not restarting (shouldBeListening:', shouldBeListeningRef.current, ', continuous:', continuous, ')');
                setIsListening(false);
                onListeningChangeRef.current?.(false);
            }
        };

        // Cleanup
        return () => {
            if (recognitionRef.current) {
                shouldBeListeningRef.current = false;
                try {
                    recognitionRef.current.stop();
                } catch {
                    // Ignore cleanup errors
                }
            }
        };
    // Only recreate recognition when these config options change, NOT when callbacks change
    }, [continuous, interimResults, language]);

    const startListening = useCallback(() => {
        console.log('[VoiceRecognition] startListening called | isListening:', isListening, '| shouldBeListening:', shouldBeListeningRef.current, '| hasRecognition:', !!recognitionRef.current);
        // Use ref as primary guard since state updates are async and can cause race conditions
        if (!recognitionRef.current || shouldBeListeningRef.current) {
            console.log('[VoiceRecognition] Skipping start - already listening or no recognition');
            return;
        }

        // Reset state
        setTranscript('');
        setInterimTranscript('');
        accumulatedTranscriptRef.current = '';
        shouldBeListeningRef.current = true;

        try {
            recognitionRef.current.start();
            setIsListening(true);
            onListeningChangeRef.current?.(true);
            console.log('[VoiceRecognition] Started successfully');
        } catch (error) {
            console.error('[VoiceRecognition] Failed to start:', error);
            shouldBeListeningRef.current = false;
            onErrorRef.current?.('Failed to start voice recognition');
        }
    }, [isListening]);

    const stopListening = useCallback(() => {
        console.log('[VoiceRecognition] stopListening called | hasRecognition:', !!recognitionRef.current);
        if (!recognitionRef.current) return;

        shouldBeListeningRef.current = false;
        try {
            recognitionRef.current.stop();
            console.log('[VoiceRecognition] Stopped successfully');
        } catch (e) {
            console.warn('[VoiceRecognition] Stop error (usually harmless):', e);
        }
        setIsListening(false);
        onListeningChangeRef.current?.(false);
    }, []);

    const resetTranscript = useCallback(() => {
        setTranscript('');
        setInterimTranscript('');
        accumulatedTranscriptRef.current = '';
    }, []);

    return {
        isSupported,
        isListening,
        transcript,
        interimTranscript,
        startListening,
        stopListening,
        resetTranscript
    };
}

function getErrorMessage(error: string): string {
    switch (error) {
        case 'no-speech':
            return 'No speech detected. Please try again.';
        case 'audio-capture':
            return 'Microphone not found or not accessible.';
        case 'not-allowed':
            return 'Microphone access denied. Please allow microphone access.';
        case 'network':
            return 'Network error occurred.';
        case 'aborted':
            return 'Speech recognition aborted.';
        default:
            return `Speech recognition error: ${error}`;
    }
}
