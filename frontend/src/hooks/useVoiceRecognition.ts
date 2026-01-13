import { useState, useEffect, useRef, useCallback } from 'react';

interface VoiceRecognitionOptions {
    continuous?: boolean;
    interimResults?: boolean;
    language?: string;
    onResult?: (transcript: string, isFinal: boolean) => void;
    onError?: (error: string) => void;
}

export function useVoiceRecognition(options: VoiceRecognitionOptions = {}) {
    const {
        continuous = false,
        interimResults = true,
        language = 'en-US',
        onResult,
        onError
    } = options;

    const [isListening, setIsListening] = useState(false);
    const [isSupported, setIsSupported] = useState(false);
    const [transcript, setTranscript] = useState('');
    const [interimTranscript, setInterimTranscript] = useState('');

    const recognitionRef = useRef<any>(null);

    // Check for browser support
    useEffect(() => {
        const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (SpeechRecognition) {
            setIsSupported(true);
            recognitionRef.current = new SpeechRecognition();

            // Configure recognition
            recognitionRef.current.continuous = continuous;
            recognitionRef.current.interimResults = interimResults;
            recognitionRef.current.lang = language;
            recognitionRef.current.maxAlternatives = 1;

            // Handle results
            recognitionRef.current.onresult = (event: any) => {
                let interimText = '';
                let finalText = '';

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
                    setTranscript(prev => prev + finalText);
                    setInterimTranscript('');
                    onResult?.(finalText, true);
                } else if (interimText) {
                    setInterimTranscript(interimText);
                    onResult?.(interimText, false);
                }
            };

            // Handle errors
            recognitionRef.current.onerror = (event: any) => {
                console.error('Speech recognition error:', event.error);
                const errorMessage = getErrorMessage(event.error);
                onError?.(errorMessage);
                setIsListening(false);
            };

            // Handle end
            recognitionRef.current.onend = () => {
                setIsListening(false);
                setInterimTranscript('');
            };
        } else {
            setIsSupported(false);
        }

        return () => {
            if (recognitionRef.current) {
                try {
                    recognitionRef.current.stop();
                } catch (e) {
                    // Ignore errors on cleanup
                }
            }
        };
    }, [continuous, interimResults, language, onResult, onError]);

    const startListening = useCallback(() => {
        if (!recognitionRef.current || isListening) return;

        try {
            setTranscript('');
            setInterimTranscript('');
            recognitionRef.current.start();
            setIsListening(true);
        } catch (error) {
            console.error('Failed to start recognition:', error);
            onError?.('Failed to start voice recognition');
        }
    }, [isListening, onError]);

    const stopListening = useCallback(() => {
        if (!recognitionRef.current || !isListening) return;

        try {
            recognitionRef.current.stop();
            setIsListening(false);
        } catch (error) {
            console.error('Failed to stop recognition:', error);
        }
    }, [isListening]);

    const resetTranscript = useCallback(() => {
        setTranscript('');
        setInterimTranscript('');
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
